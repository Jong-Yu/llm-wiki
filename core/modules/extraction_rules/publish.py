"""관리자 명시 실행으로만 구성 바이트와 발행 기록을 한 불변 버전에 공개한다."""

# 관리자 발행 절차: 경로/스키마 확인 → 발행 잠금 → 임시 폴더에 구성 쓰기 → 완성 폴더 공개.
# 발행과 tenant별 사용 허용은 별도다. 이 함수는 정책의 allowed/revoked 목록을 변경하지 않는다.

from datetime import datetime, timezone
import fcntl
from hashlib import sha256
import os
from pathlib import Path
import stat
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from . import content, contracts as limits, files
from .contracts import RulesetCompatibilityError, RulesetConfigurationError, RulesetConflictError
from .store import read_release, schema_bytes


def publish(root, *, tenant_root, ruleset_id, ruleset_version, reason, schema, expected_schema):
    """관리자 영역에 완성한 릴리스를 한 번 공개한다. 기존 ID/버전과 허용 정책은 바꾸지 않는다."""
    limits.release_key({"ruleset_id": ruleset_id, "ruleset_version": ruleset_version})
    if type(reason) is not str or not reason.strip() or len(reason) > 1000:
        raise RulesetConfigurationError("A bounded publication reason is required.")
    if schema_bytes(schema) != schema_bytes(expected_schema):
        raise RulesetCompatibilityError("Publication schema differs from the running contract.")
    anchor = Path(root).absolute()
    if anchor.is_symlink():
        raise RulesetConfigurationError("The ruleset root must not be a symbolic link.")
    root = files.disjoint(anchor, tenant_root)
    root.mkdir(mode=0o700, exist_ok=True)
    files.safe(root)
    descriptor = os.open(root / ".publication.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    staged, consumed = root / (".ruleset-" + uuid4().hex), False
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RulesetConfigurationError("The publication lock must be regular.")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        # 같은 규약 ID/버전으로 동시에 발행하는 작업이 서로를 덮어쓰지 않게 단독 잠금을 잡는다.
        parent = files.safe(root / ruleset_id)
        parent.mkdir(mode=0o700, exist_ok=True)
        destination = files.safe(parent / ruleset_version)
        if destination.exists():
            raise RulesetConflictError("An immutable ruleset ID/version already exists.")
        values = content.components(schema)
        if set(values) != limits.COMPONENTS or any(len(value) > limits.MAX_COMPONENT_BYTES for value in values.values()):
            raise RulesetConfigurationError("Ruleset component limits were exceeded.")
        fingerprint = content.validator_fingerprint()
        # manifest는 발행 기록과 각 파일의 크기/hash를 담는 설명서다. 표시 버전과 내용 hash는 다르다.
        manifest = {"format_version": 1, "ruleset_id": ruleset_id, "ruleset_version": ruleset_version,
            "publication": {"event_id": uuid4().hex, "issued_at": datetime.now(timezone.utc).isoformat(), "reason": reason},
            "supported_schema_versions": [3, 4, 5, 6], "default_schema_version": 3,
            "validator_revision": fingerprint, "schema_sha256": sha256(schema_bytes(schema)).hexdigest(),
            "components": {name: {"sha256": sha256(value).hexdigest(), "size_bytes": len(value)} for name, value in values.items()}}
        raw = canonical_json_bytes(manifest)
        if len(raw) > limits.MAX_MANIFEST_BYTES or len(raw) + sum(map(len, values.values())) > limits.MAX_RELEASE_BYTES:
            raise RulesetConfigurationError("The release byte limit was exceeded.")
        staged.mkdir(mode=0o700)
        for name, value in {**values, "manifest.json": raw}.items():
            file_descriptor = os.open(staged / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(file_descriptor, "wb") as stream:
                stream.write(value); stream.flush(); os.fsync(stream.fileno())
        # 모든 구성을 쓴 뒤 디렉터리째 공개해 미완성 릴리스를 조회하지 않게 한다.
        os.rename(staged, destination)
        consumed = True
        return read_release(root, ruleset_id, ruleset_version, expected_schema=expected_schema,
                            validator_revision=fingerprint)
    except BaseException as error:
        # 이번 발행의 임시 파일만 정리한다. 이미 공개한 릴리스나 옛 버전은 지우지 않는다.
        failures = []
        if not consumed and staged.exists():
            for name in (*limits.COMPONENTS, "manifest.json"):
                try:
                    (staged / name).unlink(missing_ok=True)
                except OSError as cleanup_error:
                    failures.append({"path": str(Path(staged.name) / name), "error_type": type(cleanup_error).__name__, "errno": cleanup_error.errno})
            try:
                staged.rmdir()
            except OSError as cleanup_error:
                failures.append({"path": staged.name, "error_type": type(cleanup_error).__name__, "errno": cleanup_error.errno})
        if failures:
            error.cleanup_failures = [*getattr(error, "cleanup_failures", []), *failures]
        raise
    finally:
        os.close(descriptor)
