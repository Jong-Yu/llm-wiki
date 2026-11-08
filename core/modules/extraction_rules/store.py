"""매 요청의 관리자 정책과 현재 검증기에서 불변 규약 바이트를 확인한다."""

# RulesetRegistry.read가 요청의 시작점이다. 현재 정책(허용/철회)과 발행 파일의 내용 지문을 함께 확인한다.
# 설정/규약이 잘못됐을 때 이전 버전을 자동 선택하면 철회 정책을 우회할 수 있어 명시 오류를 낸다.

from hashlib import sha256
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from datetime import datetime
import json
import os
from threading import Lock
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_results.diagnostics import legacy_schema as legacy_diagnostics_schema
from core.modules.analysis_results import diagnostics as diagnostic_reports
from . import contracts as limits, content, files
from .contracts import (
    RulesetCompatibilityError, RulesetConfigurationError, RulesetCorruptError,
    RulesetUnavailableError,
)


_DIAGNOSTICS_CACHE_ENTRIES = 8
_DIAGNOSTICS_CACHE_ENTRY_BYTES = 3 * limits.MAX_COMPONENT_BYTES
_diagnostics_bytes = OrderedDict()
_diagnostics_guard = Lock()


def _expected_diagnostics_bytes():
    """Memoize only immutable bytes generated from the running Python models.

    Keep builder identities in the key, including the module-level schema
    helper used by legacy_schema. Patched/replaced builders must run again.
    Policy, release files and their validation are never cached here.
    """
    builders = (content.diagnostics_schema, legacy_diagnostics_schema, diagnostic_reports.schema)
    with _diagnostics_guard:
        cached = _diagnostics_bytes.get(builders)
        if cached is not None:
            _diagnostics_bytes.move_to_end(builders)
            return cached
    # Preserve the original eager order and exceptions for all three supported
    # forms. A failed builder never publishes a partial or negative cache entry.
    values = (canonical_json_bytes(builders[0]()), canonical_json_bytes(builders[0](1)),
              canonical_json_bytes(builders[1]()))
    if sum(map(len, values)) <= _DIAGNOSTICS_CACHE_ENTRY_BYTES:
        with _diagnostics_guard:
            _diagnostics_bytes[builders] = values
            _diagnostics_bytes.move_to_end(builders)
            while len(_diagnostics_bytes) > _DIAGNOSTICS_CACHE_ENTRIES:
                _diagnostics_bytes.popitem(last=False)
    return values


@lru_cache(maxsize=8)
def _check_schema(raw):
    """같은 스키마 바이트의 순수 구조 검사만 재사용한다. 정책·릴리스 검사는 매번 수행한다."""
    Draft202012Validator.check_schema(json.loads(raw))


def schema_bytes(schema):
    # 출력 스키마는 JSON의 필드/자료형 규칙이다. 현재 서버가 지원하는 형태인지 검사해 저장 바이트로 만든다.
    try:
        if (type(schema) is not dict or schema.get("type") != "object"
                or schema["properties"]["schema_version"]["enum"] != [3, 4, 5, 6]
                or schema["anyOf"] != [{"$ref": f"#/$defs/SubmissionV{version}"} for version in (3, 4, 5, 6)]
                or set(schema["$defs"]["QualifiersInput"]["required"]) != {
                    "polarity", "modality", "condition", "scope", "time"}):
            raise ValueError()
        for version in (3, 4, 5, 6):
            branch = schema["$defs"][f"SubmissionV{version}"]
            if (branch["properties"]["schema_version"] != {"type": "integer", "enum": [version]}
                    or branch["properties"]["relations"]["items"] != {"$ref": f"#/$defs/RelationV{version}"}
                    or f"RelationV{version}" not in schema["$defs"]):
                raise ValueError()
        raw = canonical_json_bytes(schema)
        if len(raw) > limits.MAX_COMPONENT_BYTES:
            raise ValueError()
        _check_schema(raw)
        return raw
    except (ValueError, TypeError, KeyError, UnicodeError, SchemaError) as error:
        raise RulesetCompatibilityError("The current submission schema is unavailable or incompatible.") from error


def reference(release):
    # 규약 전체 내용 대신 작업/입력에 연결할 최소 참조(ID, 표시 버전, 내용 지문)를 추려 반환한다.
    return {name: release[name] for name in ("ruleset_id", "ruleset_version", "ruleset_revision")}


def read_release(root, ruleset_id, ruleset_version, *, expected_schema, validator_revision):
    # 배포 폴더의 파일 목록 → manifest 구조 → 구성별 크기/hash → 현재 스키마/어휘 순으로 검사한다.
    limits.release_key({"ruleset_id": ruleset_id, "ruleset_version": ruleset_version})
    directory = files.safe(Path(root) / ruleset_id / ruleset_version)
    names = []
    with os.scandir(directory) as entries:
        for entry in entries:
            if len(names) >= len(limits.COMPONENTS) + 1 or entry.is_symlink():
                raise RulesetCorruptError("The release directory is invalid.")
            names.append(entry.name)
    if set(names) == (limits.COMPONENTS - {"diagnostics.schema.json"}) | {"manifest.json"}:
        # 옛 불변 릴리스를 덮어써 새 계약처럼 보이게 하지 않는다. 관리자가 새 버전으로 발행한다.
        raise RulesetCompatibilityError("The legacy release requires a new version with versioned schemas and diagnostics.")
    if set(names) != limits.COMPONENTS | {"manifest.json"}:
        raise RulesetCorruptError("The release has missing or unknown components.")
    raw = files.raw_file(directory / "manifest.json", limits.MAX_MANIFEST_BYTES)
    manifest = files.json_bytes(raw)
    try:
        fields = {"format_version", "ruleset_id", "ruleset_version", "publication", "supported_schema_versions",
                  "default_schema_version", "validator_revision", "schema_sha256", "components"}
        if (set(manifest) != fields or type(manifest["format_version"]) is not int or manifest["format_version"] != 1
                or manifest["ruleset_id"] != ruleset_id or manifest["ruleset_version"] != ruleset_version
                or manifest["supported_schema_versions"] != [3, 4, 5, 6]
                or type(manifest["default_schema_version"]) is not int or manifest["default_schema_version"] != 3
                or set(manifest["components"]) != limits.COMPONENTS):
            raise ValueError()
        publication = manifest["publication"]
        if (type(publication) is not dict or set(publication) != {"event_id", "issued_at", "reason"}
                or type(publication["event_id"]) is not str or len(publication["event_id"]) != 32
                or any(c not in "0123456789abcdef" for c in publication["event_id"])
                or type(publication["reason"]) is not str or not publication["reason"].strip()
                or len(publication["reason"]) > 1000 or datetime.fromisoformat(publication["issued_at"]).tzinfo is None):
            raise ValueError()
        if (manifest["validator_revision"] != validator_revision
                or manifest["schema_sha256"] != sha256(schema_bytes(expected_schema)).hexdigest()):
            raise RulesetCompatibilityError("The release does not match the running validator/schema.")
        components, total = {}, len(raw)
        # 누적 예산에는 설명서도 포함한다. 각 파일이 작아도 합계가 너무 크면 받지 않는다.
        for filename in sorted(limits.COMPONENTS):
            entry = manifest["components"][filename]
            if (type(entry) is not dict or set(entry) != {"sha256", "size_bytes"}
                    or type(entry["sha256"]) is not str or not limits.HEX.fullmatch(entry["sha256"])
                    or type(entry["size_bytes"]) is not int or not 0 <= entry["size_bytes"] <= limits.MAX_COMPONENT_BYTES):
                raise ValueError()
            component = files.raw_file(directory / filename, limits.MAX_COMPONENT_BYTES)
            total += len(component)
            if (total > limits.MAX_RELEASE_BYTES or len(component) != entry["size_bytes"]
                    or sha256(component).hexdigest() != entry["sha256"]):
                raise ValueError()
            components[filename] = {"sha256": entry["sha256"], "content": component.decode("utf-8")}
        if components["submission.schema.json"]["content"].encode() != schema_bytes(expected_schema):
            raise RulesetCompatibilityError("The release submission schema differs from the server.")
        if components["diagnostics.schema.json"]["content"].encode() not in _expected_diagnostics_bytes():
            raise RulesetCompatibilityError("The release diagnostics schema differs from the server.")
        if components["definitions.json"]["content"].encode() != canonical_json_bytes(content.definitions()):
            raise RulesetCompatibilityError("The release vocabulary differs from the server.")
        return {"ruleset_id": ruleset_id, "ruleset_version": ruleset_version,
                "ruleset_revision": sha256(raw).hexdigest(), "manifest": manifest,
                "manifest_text": raw.decode("utf-8"), "components": components}
    except RulesetCompatibilityError:
        raise
    except (ValueError, TypeError, KeyError, UnicodeError, AttributeError, OverflowError) as error:
        raise RulesetCorruptError("The ruleset release is invalid.") from error


def validate_policy(policy):
    """Reader and administrator share the exact policy shape and limits."""
    if (set(policy) != {"version", "tenants"} or type(policy["version"]) is not int or policy["version"] != 1
            or type(policy["tenants"]) is not dict or len(policy["tenants"]) > limits.MAX_POLICY_TENANTS):
        raise ValueError()
    for tenant, entry in policy["tenants"].items():
        if type(tenant) is not str or not limits.ID.fullmatch(tenant) or type(entry) is not dict:
            raise ValueError()
        if set(entry) != {"default", "allowed", "revoked"}:
            raise ValueError()
        default = limits.release_key(entry["default"])
        for field in ("allowed", "revoked"):
            if type(entry[field]) is not list or len(entry[field]) > limits.MAX_POLICY_RELEASES:
                raise ValueError()
            keys = [limits.release_key(value) for value in entry[field]]
            if len(keys) != len(set(keys)):
                raise ValueError()
        if default not in [limits.release_key(value) for value in entry["allowed"]]:
            raise ValueError()
    return policy


class RulesetRegistry:
    """조회는 디렉터리를 만들지 않으며 과거 정책/릴리스로 자동 우회하지 않는다."""

    def __init__(self, root, policy_path, tenant_root, *, expected_schema=None):
        # 경로와 현재 검증기 기준을 보관한다. 실제 tenant별 허용 결정은 read 호출마다 다시 읽는다.
        self.expected_schema = expected_schema
        schema_bytes(expected_schema)
        self.root_anchor = Path(root).absolute()
        self.policy_anchor = Path(policy_path).absolute()
        if self.root_anchor.is_symlink() or self.policy_anchor.is_symlink():
            raise RulesetConfigurationError("Ruleset administration paths are unsafe.")
        self.root = files.disjoint(self.root_anchor, tenant_root)
        self.policy_path = files.disjoint(self.policy_anchor, tenant_root)
        self.tenant_root = Path(tenant_root).absolute().resolve(strict=True)
        self.validator_revision = content.validator_fingerprint()

    def _policy(self):
        # 관리자 정책을 읽어 (정책 dict, 정책의 지문)으로 반환한다. 경로가 다른 파일로 바뀌었어도 중단한다.
        try:
            if (self.root_anchor.is_symlink() or self.root_anchor.resolve(strict=True) != self.root
                    or not self.root.is_dir() or self.policy_anchor.is_symlink()
                    or self.policy_anchor.resolve(strict=True) != self.policy_path):
                raise ValueError()
            raw = files.raw_file(self.policy_path, limits.MAX_POLICY_BYTES)
            policy = files.json_bytes(raw)
            validate_policy(policy)
            return policy, sha256(raw).hexdigest()
        except (OSError, ValueError, TypeError, RuntimeError, RecursionError) as error:
            raise RulesetConfigurationError("The current ruleset policy is unavailable.") from error

    def read(self, tenant, ruleset_id=None, ruleset_version=None):
        """매번 현재 허용·철회 정책과 릴리스 바이트를 확인한다. 저장된 옛 허가는 쓰지 않는다."""
        policy, revision = self._policy()
        if type(tenant) is not str or tenant not in policy["tenants"]:
            raise RulesetUnavailableError("No ruleset is available for this tenant.")
        entry = policy["tenants"][tenant]
        if ruleset_id is None and ruleset_version is None:
            chosen = limits.release_key(entry["default"])
        else:
            chosen = limits.release_key({"ruleset_id": ruleset_id, "ruleset_version": ruleset_version})
        if (chosen not in [limits.release_key(value) for value in entry["allowed"]]
                or chosen in [limits.release_key(value) for value in entry["revoked"]]):
            # allowed에 있어도 revoked에 들어가면 사용하지 못한다. 기본 규약이라고 예외로 허용하지 않는다.
            raise RulesetUnavailableError("The ruleset is not currently allowed.")
        if content.validator_fingerprint() != self.validator_revision:
            # 서버 실행 중 검증기 파일이 바뀌면 같은 서버 기준이라고 계속 처리하지 않는다.
            raise RulesetCompatibilityError("The running validator files changed; restart and reconcile.")
        try:
            release = read_release(self.root, *chosen, expected_schema=self.expected_schema,
                                   validator_revision=self.validator_revision)
        except FileNotFoundError as error:
            raise RulesetUnavailableError("The allowed ruleset release is unavailable.") from error
        return {**release, "status": "allowed", "policy_revision": revision}

    def validate_reference(self, tenant, reference):
        """이미 고정한 규약을 현재 정책에서도 사용할 수 있는지 같은 내용 hash로 확인한다."""
        if type(reference) is not dict or set(reference) != {"ruleset_id", "ruleset_version", "ruleset_revision"}:
            raise RulesetCompatibilityError("A complete immutable ruleset reference is required.")
        release = self.read(tenant, reference["ruleset_id"], reference["ruleset_version"])
        if release["ruleset_revision"] != reference["ruleset_revision"]:
            raise RulesetCompatibilityError("The ruleset reference changed; prepare a new input.")
        return release
