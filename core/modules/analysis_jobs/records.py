"""같은 tenant 조정 잠금 아래의 작업 파일·소유자 인덱스·입력 검증."""

# 작업 JSON의 공통 입출력과 구조 검증이다. 저장 위치는 사용자에게 받은 경로 대신 서버가 정한다.
# owner 인덱스 → 작업 본문 순으로 읽어 권한 없는 자료를 먼저 읽고 숨기는 방식이 되지 않게 한다.

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.sources import contracts as source_limits, files
from core.modules.sources.contracts import SourceCorruptError, SourceLimitError
from core.modules.sources.validation import actor as checked_actor, request_key
from . import contracts as limits
from .contracts import JobCorruptError, JobLimitError, JobValidationError
from core.common.storage_layout import analysis_job_root, analysis_request_root


def owner_key(tenant, user_id):
    # 두 소유 범위를 함께 지문화해 다른 tenant/사용자의 인덱스와 분리한다.
    return canonical_json_hash({"tenant": tenant, "user_id": user_id})


def read(self, path):
    # 원본 저장의 안전한 JSON 읽기를 재사용하고, 오류는 작업 기록 오류로 바꿔 전달한다.
    try:
        return files.read_json(self.store, path)
    except SourceCorruptError as error:
        raise JobCorruptError("The job record is invalid.") from error


def preflight(value):
    """여러 파일을 공개하는 작업은 정확한 후보 바이트를 먼저 검사한다."""
    if len(canonical_json_bytes(value)) > source_limits.MAX_JSON_BYTES:
        raise JobLimitError("The job metadata limit was reached.")


def write(self, path, value):
    # 직렬화한 실제 바이트 크기를 먼저 검사하고 기존 원자적 JSON 쓰기를 사용한다.
    preflight(value)
    try:
        files.write_json(self.store, path, value)
    except SourceLimitError as error:
        raise JobLimitError("The job metadata limit was reached.") from error
    except SourceCorruptError as error:
        raise JobCorruptError("The job storage path is invalid.") from error


def authorized(authorize, tenant, user_id):
    # authorize는 나중에 호출할 권한 확인 함수다. 반환한 주체가 이번 소유 범위와 맞는지도 검사한다.
    try:
        return checked_actor(authorize(), tenant, user_id)
    except SourceCorruptError as error:
        raise JobCorruptError("The server authorization scope is invalid.") from error


def check_access(previous, current):
    """새 기록은 본인 접근 기준만 비교한다. 불변 구 기록에는 새 필드를 주입하지 않는다."""
    if previous.get("access_revision") is not None and previous["access_revision"] != current.get("access_revision"):
        from .contracts import JobConflictError
        raise JobConflictError("access_basis_changed")


def state_path(self, job_id):
    # pathlib.Path의 /는 경로 결합이다. ID를 먼저 검증해 임의 경로가 들어오지 않게 한다.
    root = self.job_root(limits.identifier(job_id))
    return root / ("state.json" if root.parent == self.jobs_dir else "job.json")


def owner_path(self, tenant, user_id, job_id):
    return self.job_root(job_id) / "owner.json" if job_id in self._job_paths else legacy_owner_path(self, tenant, user_id, job_id)


def legacy_owner_path(self, tenant, user_id, job_id):
    return self.jobs_dir / "_owners" / owner_key(tenant, user_id) / (limits.identifier(job_id) + ".json")


def request_path(self, tenant, user_id, request_id):
    limits.identifier(request_id)
    name = request_key(tenant, user_id, request_id) + ".json"
    old = self.jobs_dir / "_requests" / name
    new = analysis_request_root(self.store.data_dir, user_id) / name
    if files.checked(self.store, old).exists():
        if files.checked(self.store, new).exists():
            raise JobCorruptError("Both legacy and personal request records exist.")
        return old
    return new


def owned_state(self, job_id, tenant, user_id):
    # 인증 사용자의 인덱스가 없으면 다른 사용자의 state 파일을 먼저 읽지 않는다.
    new = analysis_job_root(self.store.data_dir, user_id, job_id)
    old_owner = legacy_owner_path(self, tenant, user_id, job_id)
    if files.checked(self.store, new).exists():
        if files.checked(self.store, old_owner).exists():
            raise JobCorruptError("Both legacy and personal job records exist.")
        marker = read(self, new / "owner.json")
        self._job_paths[job_id] = new
    else:
        marker = read(self, old_owner)
        self._job_paths.pop(job_id, None)
    if marker != {"job_id": job_id, "tenant": tenant, "user_id": user_id}:
        raise JobCorruptError("The job owner index is invalid.")
    value = read(self, state_path(self, job_id))
    return validate_state(self, value, job_id, tenant, user_id)


def validate_state(self, value, job_id, tenant, user_id):
    # 파일이 JSON으로 읽혔더라도 상태·원본 참조·대상·이벤트 구조가 모두 맞아야 사용한다.
    # set(dict)는 키들의 집합이다. 아래 비교는 필수 키 누락과 허용하지 않은 추가 키를 함께 잡는다.
    fields = {"schema_version", "job_id", "tenant", "user_id", "request_id", "payload_hash", "actor", "created_at",
              "source_ref", "targets", "outputs", "state", "run_id", "reported_status", "message", "events"}
    try:
        if type(value) is not dict or set(value) != fields or type(value["schema_version"]) is not int or value["schema_version"] != 1:
            raise ValueError()
        if any(value[key] != expected for key, expected in (("job_id", job_id), ("tenant", tenant), ("user_id", user_id))):
            raise ValueError()
        limits.identifier(value["request_id"])
        limits.revision(value["payload_hash"])
        checked_actor(value["actor"], tenant, user_id)
        limits.instant(value["created_at"])
        if value["state"] not in {"awaiting_cli", "claimed", "cancelled"}:
            raise ValueError()
        if value["run_id"] is not None:
            limits.identifier(value["run_id"])
        if value["state"] == "claimed" and value["run_id"] is None:
            raise ValueError()
        if value["reported_status"] is not None and value["reported_status"] not in limits.REPORTED_STATUSES:
            raise ValueError()
        if type(value["message"]) is not str or len(value["message"]) > 1000:
            raise ValueError()
        if type(value["events"]) is not list or not value["events"] or len(value["events"]) > limits.MAX_EVENTS:
            raise ValueError()
        source = value["source_ref"]
        if type(source) is not dict or set(source) != {"source_id", "source_version", "source_sha256", "size_bytes", "registration_revision"}:
            raise ValueError()
        limits.identifier(source["source_id"]); limits.identifier(source["source_version"])
        limits.revision(source["source_sha256"]); limits.revision(source["registration_revision"])
        if type(source["size_bytes"]) is not int or not 0 <= source["size_bytes"] <= 20 * 1024 * 1024:
            raise ValueError()
        validate_targets(self, [target["document"] for target in value["targets"]], value["outputs"])
        for target in value["targets"]:
            if set(target) != {"document", "source_revision", "state_revision"}:
                raise ValueError()
            for name in ("source_revision", "state_revision"):
                if target[name] is not None:
                    limits.revision(target[name])
        for event in value["events"]:
            if type(event) is not dict or set(event) != {"event_id", "kind", "actor", "timestamp", "details"}:
                raise ValueError()
            limits.identifier(event["event_id"]); limits.instant(event["timestamp"])
            checked_actor(event["actor"], tenant, user_id)
            if event["kind"] not in {"created", "claimed", "reported", "cancelled"} or type(event["details"]) is not dict:
                raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, SourceCorruptError) as error:
        raise JobCorruptError("The job state is inconsistent.") from error


def validate_targets(self, targets, outputs):
    # 대상 문서/산출물은 명시적이고 중복 없어야 한다. 파일명 유사도로 대상을 추측하지 않는다.
    if (type(targets) is not list or not 1 <= len(targets) <= limits.MAX_TARGETS
            or any(type(target) is not str for target in targets) or len(set(targets)) != len(targets)):
        raise JobValidationError("Select one to eight distinct target documents.")
    for document in targets:
        self.store._document_path(self.store.wiki_dir, document)
    if (type(outputs) is not list or not outputs or len(set(outputs)) != len(outputs)
            or any(type(item) is not str or item not in {"wiki", "ontology"} for item in outputs)):
        raise JobValidationError("Select supported analysis outputs explicitly.")


def lease(self, job):
    # 아직 실행이 없으면 None, 있으면 그 run의 임시 실행권 기록을 검증해 반환한다.
    if job["run_id"] is None:
        return None
    value = read(self, self.job_root(job["job_id"]) / "leases" / (job["run_id"] + ".json"))
    try:
        if type(value) is not dict or set(value) != {"job_id", "run_id", "expires_at", "events"}:
            raise ValueError()
        if value["job_id"] != job["job_id"] or value["run_id"] != job["run_id"]:
            raise ValueError()
        limits.instant(value["expires_at"])
        if type(value["events"]) is not list or not 1 <= len(value["events"]) <= limits.MAX_EVENTS:
            raise ValueError()
        for event in value["events"]:
            if type(event) is not dict or set(event) != {"event_id", "actor", "timestamp", "expires_at"}:
                raise ValueError()
            limits.identifier(event["event_id"]); limits.instant(event["timestamp"]); limits.instant(event["expires_at"])
            checked_actor(event["actor"], job["tenant"], job["user_id"])
        if value["expires_at"] != value["events"][-1]["expires_at"]:
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, SourceCorruptError) as error:
        raise JobCorruptError("The lease is inconsistent.") from error
