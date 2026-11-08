"""질문의 전체 근거는 불변 보관하고 개인 대화에는 작은 판본 참조를 남긴다."""

from copy import deepcopy
from hashlib import sha256
import json
import os
import re

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.analysis_inputs import files as immutable_files
from core.modules.analysis_inputs.contracts import InputCorruptError, InputLimitError
from core.modules.documents.metadata import parse_document, DocumentMetadataError
from core.modules.sources import files
from core.modules.sources.contracts import SourceCorruptError, SourceLimitError
from .store import PersonalStore, PersonalCorruptError, PersonalLimitError


REFERENCE_KIND = "question_basis_ref_v1"
MAX_BASIS_BYTES = 16 * 1024 * 1024
MAX_REFERENCE_BYTES = 128 * 1024
MAX_BUNDLES = 200
MAX_SCOPE_BYTES = 256 * 1024 * 1024
_PART_CHARACTERS = 128 * 1024
_MAX_PART_BYTES = 512 * 1024
_MAX_MANIFEST_BYTES = 1024 * 1024
_MAX_STORED_BYTES = MAX_BASIS_BYTES + _MAX_MANIFEST_BYTES
_HEX = re.compile(r"[0-9a-f]{64}")
_BINDING_FIELDS = ("tenant", "user_id", "profile_id", "domain", "viewpoint")
_IDENTITY_FIELDS = ("tenant", "user_id", "profile_id")


def is_basis_reference(value):
    """보관 참조인지 판별하며 원본 question_context를 참조로 오해하지 않는다."""
    return type(value) is dict and value.get("kind") == REFERENCE_KIND


def _basis(value):
    """정규 JSON 지문과 작은 목록을 만들 수 있는 전체 근거 형태를 확인한다."""
    if (type(value) is not dict or value.get("kind") != "question_context"
            or type(value.get("scope")) is not dict
            or type(value["scope"].get("profile")) is not dict
            or type(value.get("documents")) is not list or len(value["documents"]) > 8
            or type(value.get("originals")) is not list or len(value["originals"]) > 4
            or type(value.get("snapshot_revision")) is not str
            or not _HEX.fullmatch(value["snapshot_revision"])):
        raise PersonalCorruptError("The complete question basis is invalid")
    if canonical_json_hash({key: item for key, item in value.items() if key != "snapshot_revision"}) != value["snapshot_revision"]:
        raise PersonalCorruptError("The question basis snapshot fingerprint is invalid")
    return value


def _title(document):
    """제목은 조회 안내에만 쓰며 원래 본문을 수정하거나 자르지 않는다."""
    try:
        parsed = parse_document(document["content"])
        title = parsed.metadata.get("title")
        if title:
            return title
        heading = next((line.lstrip("# ").strip() for line in parsed.body.splitlines()
                        if line.startswith("#") and line.lstrip("# ").strip()), None)
        return (heading or document["document"])[:200]
    except DocumentMetadataError:
        return document["document"]


def _line_count(content):
    """원문 좌표와 같이 CR/LF만 줄 경계로 센다. Unicode 구분자는 본문 그대로다."""
    return len(re.findall(r"\r\n|\r|\n", content)) + (1 if content and not content.endswith(("\r", "\n")) else 0)


def describe_basis(full_basis):
    """저장/AI 호출 없이 범위·준비 상태와 자료별 작은 안내만 만든다."""
    basis = _basis(full_basis)
    try:
        documents = []
        for index, row in enumerate(basis["documents"], 1):
            knowledge = row["knowledge"]
            documents.append({"id": f"d{index}", "document": row["document"],
                "title": _title(row), "source_revision": row["source_revision"],
                "state_revision": knowledge["state_revision"], "graph_revision": knowledge["graph_revision"],
                "history_revision": knowledge["history_revision"], "status": knowledge["status"],
                "line_count": _line_count(row["content"])})
        originals = [{"id": f"o{index}", "source_ref": deepcopy(row["source_ref"]),
            "title": row["manifest"]["title"], "line_count": _line_count(row["content"]),
            "reported_conversion": "conversion" in row}
            for index, row in enumerate(basis["originals"], 1)]
        result = {key: deepcopy(basis[key]) for key in (
            "snapshot_revision", "scope", "can_prepare", "complete", "truncated", "skipped")}
        result.update(documents=documents, originals=originals)
        if "retrieval" in basis:
            result["retrieval"] = {k: deepcopy(v) for k, v in basis["retrieval"].items()
                                   if k != "selected_documents"}
        if "web" in basis:
            web = basis["web"]
            result["web"] = {**{key: deepcopy(web[key]) for key in ("query", "status", "warnings")},
                "sources": [{"id": f"w{index}", **{key: row[key] for key in (
                    "url", "title", "content_sha256", "retrieved_at")},
                    "line_count": _line_count(row["content"])}
                    for index, row in enumerate(web["sources"], 1)]}
        if len(canonical_json_bytes(result)) > MAX_REFERENCE_BYTES:
            raise PersonalLimitError("The question basis reference exceeds its byte limit")
        return result
    except (KeyError, TypeError, AttributeError) as error:
        raise PersonalCorruptError("The question basis material metadata is invalid") from error


def _mapped(error, target, message):
    """정리 실패 부가정보는 원래 실패와 구별한 채 보존한다."""
    result = target(message)
    if getattr(error, "cleanup_failures", None):
        result.cleanup_failures = deepcopy(error.cleanup_failures)
    return result


class QuestionBasisStore:
    """사용자·tenant·관점에 결합한 원래 전체 근거를 정확히 복원한다."""

    def __init__(self, scope):
        self.scope, self.store = scope, scope.store
        self.personal = PersonalStore(scope)
        self.binding = {key: getattr(scope, key, None) for key in _BINDING_FIELDS}
        # 같은 관점 이름의 정의가 바뀌어도 소유자의 과거 근거는 읽을 수 있어야 한다.
        # 현재 적용 가능 여부는 호출자가 observe_basis로 별도 확인한다.
        self.identity = {key: self.binding[key] for key in _IDENTITY_FIELDS}
        self.root = self.personal.root / "question-bases" / canonical_json_hash(self.identity)

    def _path(self, basis_id):
        if type(basis_id) is not str or not _HEX.fullmatch(basis_id):
            raise PersonalCorruptError("A question basis ID must be a complete fingerprint")
        return files.checked(self.store, self.root / basis_id)

    def _bound(self, basis, *, historical=False):
        profile = basis["scope"]["profile"]
        fields = _IDENTITY_FIELDS if historical else _BINDING_FIELDS
        if any(profile.get(key) != self.binding[key] for key in fields):
            raise PersonalCorruptError("The question basis belongs to another user or scope")

    def _reference(self, basis, *, historical=False):
        self._bound(basis, historical=historical)
        reference = {"kind": REFERENCE_KIND, "basis_id": canonical_json_hash(basis), **describe_basis(basis)}
        if len(canonical_json_bytes(reference)) > MAX_REFERENCE_BYTES:
            raise PersonalLimitError("The question basis reference exceeds its byte limit")
        return reference

    def _manifest(self, path):
        value = files.read_json(self.store, path / "manifest.json")
        if (set(value) != {"schema_version", "kind", "basis_id", "snapshot_revision", "binding",
                          "raw_size_bytes", "reference_revision", "components"}
                or type(value["schema_version"]) is not int or value["schema_version"] != 1
                or value["kind"] != REFERENCE_KIND
                or type(value["binding"]) is not dict or set(value["binding"]) != set(_BINDING_FIELDS)
                or any(value["binding"].get(key) != self.identity[key] for key in _IDENTITY_FIELDS)
                or value["basis_id"] != path.name
                or type(value["snapshot_revision"]) is not str or not _HEX.fullmatch(value["snapshot_revision"])
                or type(value["reference_revision"]) is not str or not _HEX.fullmatch(value["reference_revision"])
                or type(value["raw_size_bytes"]) is not int
                or not 0 < value["raw_size_bytes"] <= MAX_BASIS_BYTES
                or type(value["components"]) is not dict
                or not 1 <= len(value["components"]) <= MAX_BASIS_BYTES // _PART_CHARACTERS + 1):
            raise PersonalCorruptError("The immutable question basis manifest is invalid")
        for index, (name, descriptor) in enumerate(value["components"].items()):
            if (name != f"part-{index:04d}" or type(descriptor) is not dict
                    or set(descriptor) != {"file", "sha256", "size_bytes"}
                    or descriptor["file"] != f"component-{index}.txt"
                    or type(descriptor["sha256"]) is not str or not _HEX.fullmatch(descriptor["sha256"])
                    or type(descriptor.get("size_bytes")) is not int
                    or not 0 < descriptor["size_bytes"] <= _MAX_PART_BYTES):
                raise PersonalCorruptError("A question basis component descriptor is invalid")
        return value

    def _file_size(self, path, maximum):
        """각 구성 파일의 실제 크기도 읽기 전에 확인한다."""
        with files.open_regular(self.store, path) as stream:
            size = os.fstat(stream.fileno()).st_size
        if size > maximum:
            raise PersonalCorruptError("An immutable question basis file exceeds its size limit")
        return size

    def _usage(self):
        """현재 사용자·조회 범위의 공개 묶음 수와 실제 파일 크기를 제한한다."""
        count, total = 0, 0
        for name in files.entries(self.store, self.root, maximum=MAX_BUNDLES + 1):
            if not _HEX.fullmatch(name):
                raise PersonalCorruptError("Unexpected entries remain in question basis storage")
            path = self._path(name)
            manifest = self._manifest(path)
            expected = {"manifest.json", *(row["file"] for row in manifest["components"].values())}
            if set(files.entries(self.store, path, maximum=len(expected) + 1)) != expected:
                raise PersonalCorruptError("A question basis has missing or unexpected components")
            for filename in expected:
                maximum = _MAX_MANIFEST_BYTES if filename == "manifest.json" else _MAX_PART_BYTES
                total += self._file_size(path / filename, maximum)
            count += 1
        return count, total

    def freeze(self, full_basis):
        """전체 준비 완료 근거를 한 번 공개한다. 기존 묶음과 사용자 자료는 덮어쓰지 않는다."""
        basis = _basis(deepcopy(full_basis))
        if basis.get("can_prepare") is not True or basis.get("complete") is not True or basis.get("truncated") or basis.get("skipped"):
            raise ValueError("Only a complete ready question basis can be frozen")
        raw = canonical_json_bytes(basis)
        if len(raw) > MAX_BASIS_BYTES:
            raise PersonalLimitError("The complete question basis exceeds its byte limit")
        reference = self._reference(basis)
        text = raw.decode("utf-8")
        components = {f"part-{index:04d}": text[start:start + _PART_CHARACTERS]
            for index, start in enumerate(range(0, len(text), _PART_CHARACTERS))}
        manifest = {"schema_version": 1, "kind": REFERENCE_KIND, "basis_id": reference["basis_id"],
            "snapshot_revision": basis["snapshot_revision"], "binding": self.binding,
            "raw_size_bytes": len(raw), "reference_revision": canonical_json_hash(reference),
            "components": immutable_files.descriptors(components)}
        manifest_size = len(canonical_json_bytes(manifest))
        if manifest_size > _MAX_MANIFEST_BYTES:
            raise PersonalLimitError("The question basis manifest exceeds its byte limit")
        try:
            with self.personal._coordination(create=True):
                destination = self._path(reference["basis_id"])
                if destination.exists():
                    if self.load(reference) != basis:
                        raise PersonalCorruptError("The existing immutable question basis differs")
                    return reference
                count, used = self._usage()
                if count >= MAX_BUNDLES or used + len(raw) + manifest_size > MAX_SCOPE_BYTES:
                    raise PersonalLimitError("The retained question basis quota is exhausted")
                immutable_files.publish(self.store, destination, manifest, components, maximum=_MAX_STORED_BYTES)
            return reference
        except (InputLimitError, SourceLimitError) as error:
            raise _mapped(error, PersonalLimitError, "The question basis storage limit was reached") from error
        except (InputCorruptError, SourceCorruptError) as error:
            raise _mapped(error, PersonalCorruptError, "The immutable question basis could not be stored") from error

    def load(self, reference):
        """불변 공개 경로를 읽어 원래 근거를 복원한다. 부모 조정 잠금 안에서도 중첩 잠금을 잡지 않는다."""
        if not is_basis_reference(reference) or len(canonical_json_bytes(reference)) > MAX_REFERENCE_BYTES:
            raise PersonalCorruptError("Select a bounded immutable question basis reference")
        path = self._path(reference.get("basis_id"))
        try:
            manifest = self._manifest(path)
        except SourceCorruptError as error:
            raise PersonalCorruptError("The immutable question basis manifest is invalid") from error
        try:
            if canonical_json_hash(reference) != manifest["reference_revision"]:
                raise PersonalCorruptError("The question basis reference changed")
            for descriptor in manifest["components"].values():
                self._file_size(path / descriptor["file"], _MAX_PART_BYTES)
            actual, _, parts = immutable_files.load(self.store, path,
                expected_revision=canonical_json_hash(manifest), maximum=_MAX_STORED_BYTES)
            if actual != manifest:
                raise PersonalCorruptError("The question basis manifest changed while reading")
            raw = "".join(parts.values()).encode("utf-8")
            if len(raw) != manifest["raw_size_bytes"] or sha256(raw).hexdigest() != reference["basis_id"]:
                raise PersonalCorruptError("The complete question basis fingerprint changed")
            basis = json.loads(raw, object_pairs_hook=files._object,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if (canonical_json_bytes(basis) != raw or self._reference(_basis(basis), historical=True) != reference
                    or manifest["binding"] != {key: basis["scope"]["profile"].get(key) for key in _BINDING_FIELDS}):
                raise PersonalCorruptError("The original question basis metadata changed")
            return basis
        except (InputCorruptError, InputLimitError, SourceCorruptError, FileNotFoundError,
                ValueError, TypeError, KeyError, UnicodeError, RecursionError) as error:
            if isinstance(error, PersonalCorruptError):
                raise
            raise _mapped(error, PersonalCorruptError, "The immutable question basis is incomplete or corrupt") from error
