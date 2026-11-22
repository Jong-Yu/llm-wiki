"""공유 템플릿의 원본·지침 판본을 보존하고 CAS와 멱등 요청으로 공개한다."""

from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import os
import re
import stat
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.sources import files
from core.modules.sources.contracts import SourceCorruptError

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_TEMPLATES = 1000
MAX_VERSIONS = 100
MAX_SCAN_ENTRIES = 220000
_ID = re.compile(r"[0-9a-f]{32}")
_REVISION = re.compile(r"[0-9a-f]{64}")


class TemplateError(ValueError):
    """민감한 경로나 원문을 포함하지 않는 공개 템플릿 오류다."""

    def __init__(self, code, message, status=422, retry="none"):
        self.code, self.message, self.status, self.retry = code, message, status, retry
        super().__init__(message)


def _corrupt():
    return TemplateError("template_corrupt", "보관된 템플릿을 확인할 수 없습니다. 기존 파일과 이력은 유지됩니다.", 500)


def _identifier(value):
    if type(value) is not str or not _ID.fullmatch(value):
        raise TemplateError("invalid_template", "템플릿 식별자를 확인해 주세요.")
    return value


def _revision(value):
    if type(value) is not str or not _REVISION.fullmatch(value):
        raise TemplateError("invalid_template", "템플릿 판본을 확인해 주세요.")
    return value


def _text(value, maximum, *, nonempty=False):
    if type(value) is not str or len(value) > maximum or (nonempty and not value.strip()):
        raise TemplateError("invalid_template", "템플릿 이름과 지침의 길이를 확인해 주세요.")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise TemplateError("invalid_template", "템플릿 내용은 올바른 UTF-8이어야 합니다.") from None
    if "\x00" in value:
        raise TemplateError("invalid_template", "템플릿 내용에 허용되지 않는 문자가 있습니다.")
    return value


def validate_filename(value):
    """클라이언트 파일명은 표시값이며 저장 경로를 결정하지 않는다."""
    _text(value, 255, nonempty=True)
    if value in {".", ".."} or any(c in value for c in ("/", "\\", ":")) or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise TemplateError("invalid_filename", "경로 문자가 없는 파일 이름을 사용해 주세요.")
    return value


class TemplateStore:
    """인가된 워크스페이스의 템플릿만 저장하며 위키·원본 등록에는 쓰지 않는다."""

    def __init__(self, scope):
        self.scope, self.store = scope, scope.store
        self.root = self.store.data_dir / "_templates"

    @contextmanager
    def _lock(self, *, create=False):
        """공통 조정 잠금을 재사용하고 기존 자료의 잠금 누락은 닫힌 실패로 처리한다."""
        files.checked(self.store, self.root)
        if self.root.exists() and not (self.store.data_dir / ".registration.lock").exists():
            raise _corrupt()
        try:
            with files.coordination(self.store, create=create):
                yield
        except SourceCorruptError as error:
            raise _corrupt() from error

    def _directory(self, template_id):
        return files.checked(self.store, self.root / _identifier(template_id))

    def _catalog(self, template_id):
        value = files.read_json(self.store, self._directory(template_id) / "catalog.json")
        if (set(value) != {"schema_version", "id", "tenant", "current_revision", "versions", "requests"}
                or value["schema_version"] != 1 or value["id"] != template_id
                or value["tenant"] != self.scope.tenant or type(value["versions"]) is not list
                or not 1 <= len(value["versions"]) <= MAX_VERSIONS
                or type(value["requests"]) is not dict or len(value["requests"]) != len(value["versions"])):
            raise _corrupt()
        if any(type(rev) is not str or not _REVISION.fullmatch(rev) for rev in value["versions"]):
            raise _corrupt()
        if len(set(value["versions"])) != len(value["versions"]) or value["current_revision"] != value["versions"][-1]:
            raise _corrupt()
        for key, receipt in value["requests"].items():
            if (not _REVISION.fullmatch(key) or type(receipt) is not dict
                    or set(receipt) != {"input_sha256", "revision"}
                    or not isinstance(receipt["input_sha256"], str) or not _REVISION.fullmatch(receipt["input_sha256"])
                    or receipt["revision"] not in value["versions"]):
                raise _corrupt()
        if {receipt["revision"] for receipt in value["requests"].values()} != set(value["versions"]):
            raise _corrupt()
        return value

    def _metadata(self, template_id, revision):
        """불변 메타의 전체 지문·소속·필수값을 다시 확인한다."""
        value = files.read_json(self.store, self._directory(template_id) / "versions" / (_revision(revision) + ".json"))
        expected = {"id", "revision", "name", "instructions", "filename", "size_bytes", "sha256", "created_at", "updated_at", "archived"}
        if (set(value) != expected or value["id"] != template_id or value["revision"] != revision
                or canonical_json_hash({k: v for k, v in value.items() if k != "revision"}) != revision
                or type(value["size_bytes"]) is not int or not 0 < value["size_bytes"] <= MAX_FILE_BYTES
                or type(value["archived"]) is not bool):
            raise _corrupt()
        try:
            _text(value["name"], 200, nonempty=True)
            _text(value["instructions"], 12000)
            validate_filename(value["filename"])
            _revision(value["sha256"])
            for key in ("created_at", "updated_at"):
                if type(value[key]) is not str or datetime.fromisoformat(value[key]).tzinfo is None:
                    raise ValueError()
        except (ValueError, TypeError, OverflowError):
            raise _corrupt() from None
        return value

    def _bytes(self, metadata):
        """파일 전체를 크기·SHA-256과 대조한 뒤에만 생성/다운로드에 전달한다."""
        path = self._directory(metadata["id"]) / "files" / (metadata["sha256"] + ".bin")
        with files.open_regular(self.store, path) as stream:
            content = stream.read(MAX_FILE_BYTES + 1)
        if len(content) != metadata["size_bytes"] or sha256(content).hexdigest() != metadata["sha256"]:
            raise _corrupt()
        return content

    def _names(self):
        names = files.entries(self.store, self.root, maximum=MAX_TEMPLATES)
        if any(not _ID.fullmatch(name) for name in names):
            raise _corrupt()
        return names

    def list(self):
        """목록에는 전체 지침을 반복하지 않고 모든 활성 템플릿의 요약을 반환한다."""
        with self._lock():
            items = []
            for template_id in self._names():
                # 공개 전 실패로 남은 파일은 보존하되 사용자 목록에는 공개하지 않는다.
                if not files.checked(self.store, self._directory(template_id) / "catalog.json").exists():
                    continue
                catalog = self._catalog(template_id)
                value = self._metadata(template_id, catalog["current_revision"])
                if not value["archived"]:
                    items.append({k: v for k, v in value.items() if k != "instructions"})
            items.sort(key=lambda item: (item["updated_at"], item["id"]), reverse=True)
            return {"items": items, "complete": True, "truncated": False}

    def read(self, template_id, revision=None):
        """최신 또는 명시한 공개 판본을 읽으며 보관된 옛 판본도 그대로 반환한다."""
        with self._lock():
            catalog = self._catalog(template_id)
            target = _revision(revision) if revision is not None else catalog["current_revision"]
            if target not in catalog["versions"]:
                raise FileNotFoundError()
            metadata = self._metadata(template_id, target)
            return metadata, self._bytes(metadata)

    def _usage(self):
        """공개 실패 뒤 남은 바이트도 포함하여 누적 용량과 탐색량을 제한한다."""
        total = count = 0
        stack = [(self.root, 0)]
        while stack:
            directory, depth = stack.pop()
            if depth > 2:
                raise _corrupt()
            for name in files.entries(self.store, directory, maximum=MAX_SCAN_ENTRIES):
                count += 1
                if count > MAX_SCAN_ENTRIES:
                    raise TemplateError("template_limit", "템플릿 보관 한도에 도달했습니다.", 413)
                path = files.checked(self.store, directory / name)
                info = path.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    stack.append((path, depth + 1))
                elif stat.S_ISREG(info.st_mode):
                    total += info.st_size
                else:
                    raise _corrupt()
        return total

    def _write_blob(self, directory, digest, content):
        """새 바이트만 배타적으로 공개하고 동일 지문 원본이 있으면 무결성을 확인한다."""
        target = files.checked(self.store, directory / "files" / (digest + ".bin"))
        if target.exists():
            with files.open_regular(self.store, target) as stream:
                if stream.read(MAX_FILE_BYTES + 1) != content:
                    raise _corrupt()
            return
        files.mkdir(self.store, target.parent)
        temporary = target.parent / (".template-" + uuid4().hex)
        primary = None
        try:
            descriptor = os.open(files.checked(self.store, temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(temporary, files.checked(self.store, target), follow_symlinks=False)
        except BaseException as error:
            primary = error
            raise
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError as error:
                if primary is None:
                    raise
                primary.cleanup_failures = [{"path": temporary.relative_to(self.store.data_dir).as_posix(), "error_type": type(error).__name__, "errno": error.errno}]

    def save(self, *, request_id, name, instructions, filename=None, content=None, template_id=None,
             expected_revision=None, before_commit=None):
        """등록/수정 요청은 동일 입력일 때만 재생하며 CAS 실패 시 기존 판본을 보존한다."""
        _identifier(request_id)
        _text(name, 200, nonempty=True)
        _text(instructions, 12000)
        if any(ord(c) < 32 for c in name):
            raise TemplateError("invalid_template", "템플릿 이름은 한 줄로 입력해 주세요.")
        creating = template_id is None
        if creating:
            if expected_revision is not None or content is None:
                raise TemplateError("invalid_template", "새 템플릿에는 양식 파일이 필요합니다.")
            template_id = canonical_json_hash([self.scope.tenant, self.scope.user_id, request_id])[:32]
        else:
            _identifier(template_id)
            _revision(expected_revision)
        if content is not None:
            validate_filename(filename)
            if type(content) is not bytes or not 0 < len(content) <= MAX_FILE_BYTES:
                raise TemplateError("template_file_limit", "빈 파일이 아닌 20 MiB 이하의 파일을 선택해 주세요.", 413)
        elif filename is not None:
            raise TemplateError("invalid_template", "파일을 바꿀 때에는 파일 내용도 필요합니다.")
        payload = {"operation": "create" if creating else "update", "name": name, "instructions": instructions,
                   "expected_revision": expected_revision, "filename": filename,
                   "sha256": sha256(content).hexdigest() if content is not None else None}
        return self._commit(template_id, request_id, payload, content, before_commit, creating)

    def archive(self, template_id, *, request_id, expected_revision, before_commit=None):
        """목록에서 제외할 새 판본만 만들고 원본·지침·이전 참조는 삭제하지 않는다."""
        _identifier(template_id)
        _identifier(request_id)
        _revision(expected_revision)
        payload = {"operation": "archive", "expected_revision": expected_revision}
        return self._commit(template_id, request_id, payload, None, before_commit, False)

    def _commit(self, template_id, request_id, payload, content, before_commit, creating):
        """불변 파일과 메타를 완성한 뒤 단일 catalog 교체로 판본·영수증을 함께 공개한다."""
        key = canonical_json_hash([self.scope.user_id, request_id])
        digest = canonical_json_hash(payload)
        with self._lock(create=True):
            directory = self._directory(template_id)
            path = directory / "catalog.json"
            if files.checked(self.store, path).exists():
                catalog = self._catalog(template_id)
                receipt = catalog["requests"].get(key)
                if receipt is not None:
                    if receipt["input_sha256"] != digest:
                        raise TemplateError("request_conflict", "같은 요청 번호의 내용이 달라졌습니다. 저장 결과를 먼저 확인해 주세요.", 409, "reconcile")
                    metadata = self._metadata(template_id, receipt["revision"])
                    return {"template": metadata, "replayed": True}
                if creating:
                    raise TemplateError("request_conflict", "등록 요청 번호가 이미 사용되었습니다.", 409, "reconcile")
                previous = self._metadata(template_id, catalog["current_revision"])
                if payload["expected_revision"] != previous["revision"]:
                    raise TemplateError("conflict", "템플릿이 변경되었습니다. 입력을 보존하고 최신 내용을 확인해 주세요.", 409, "reconcile")
                if previous["archived"]:
                    raise TemplateError("template_archived", "보관된 템플릿은 수정할 수 없습니다.", 409)
                if len(catalog["versions"]) >= MAX_VERSIONS:
                    raise TemplateError("template_limit", "템플릿의 판본 보관 한도에 도달했습니다.", 413)
            else:
                if not creating:
                    raise FileNotFoundError()
                names = self._names()
                if template_id not in names and len(names) >= MAX_TEMPLATES:
                    raise TemplateError("template_limit", "템플릿 등록 한도에 도달했습니다.", 413)
                previous = None
                catalog = {"schema_version": 1, "tenant": self.scope.tenant, "id": template_id,
                           "current_revision": None, "versions": [], "requests": {}}
            if content is None:
                content = self._bytes(previous)
            now = datetime.now(timezone.utc).isoformat()
            archived = payload["operation"] == "archive"
            metadata = {"id": template_id, "name": previous["name"] if archived else payload["name"],
                        "instructions": previous["instructions"] if archived else payload["instructions"],
                        "filename": payload.get("filename") or previous["filename"],
                        "sha256": sha256(content).hexdigest(), "size_bytes": len(content),
                        "created_at": previous["created_at"] if previous else now, "updated_at": now,
                        "archived": archived}
            revision = canonical_json_hash(metadata)
            metadata["revision"] = revision
            blob_path = files.checked(self.store, directory / "files" / (metadata["sha256"] + ".bin"))
            new_blob_bytes = 0 if blob_path.exists() else len(content)
            updated = {**catalog, "current_revision": revision, "versions": [*catalog["versions"], revision],
                       "requests": {**catalog["requests"], key: {"input_sha256": digest, "revision": revision}}}
            # 같은 원본을 공유하는 지침 편집에는 이미 보관된 바이트를 중복 계산하지 않는다.
            catalog_bytes = len(canonical_json_bytes(updated))
            old_catalog_bytes = path.stat(follow_symlinks=False).st_size if path.exists() else 0
            if self._usage() + new_blob_bytes + len(canonical_json_bytes(metadata)) + catalog_bytes - old_catalog_bytes > MAX_TOTAL_BYTES:
                raise TemplateError("template_limit", "워크스페이스의 템플릿 보관 용량에 도달했습니다.", 413)
            if before_commit is not None:
                before_commit()
            self._write_blob(directory, metadata["sha256"], content)
            version_path = directory / "versions" / (revision + ".json")
            if files.checked(self.store, version_path).exists():
                raise _corrupt()
            files.write_json(self.store, version_path, metadata)
            if before_commit is not None:
                before_commit()
            files.write_json(self.store, path, updated)
            return {"template": metadata, "replayed": False}
