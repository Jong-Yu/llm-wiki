"""작업 접수와 수명주기를 서버 시각·현재 권한·source/job/lease 기준에 묶는다."""

# 처리 순서: create로 작업 접수 → claim으로 이번 실행 확보 → heartbeat/update → 필요 시 cancel.
# 모두 원본과 같은 조정 잠금 아래 수행한다. 상태 보고 자체로 AI 실행/저장 성공을 만들지 않는다.

from datetime import timedelta
from uuid import uuid4

from core.common.json_codec import canonical_json_hash
from core.common.storage_layout import analysis_job_root, analysis_request_root, personal_root
from core.modules.reviews.store import ReviewStore
from core.modules.sources import files
from . import contracts as limits, queries, records
from .contracts import JobConflictError, JobLimitError, JobValidationError


def event(kind, actor, now, **details):
    # 작업 이력 한 건을 만든다. **details는 이름 있는 세부 인자를 하나의 dict로 모은다.
    return {"event_id": uuid4().hex, "kind": kind, "actor": actor, "timestamp": now.isoformat(), "details": details}


def check_basis(self, source):
    # 작업을 시작할 때 선택한 원본 판본이 지금도 같은지 비교한다. 새 판본으로 조용히 바꾸지 않는다.
    catalog = self.sources._get_source_locked(source["source_id"])
    current = catalog["versions"][-1]
    if (catalog["registration_revision"] != source["registration_revision"]
            or catalog["current_version"] != source["source_version"]
            or current["source_sha256"] != source["source_sha256"]
            or current["size_bytes"] != source["size_bytes"]):
        raise JobConflictError("source_basis_changed", source_id=source["source_id"])
    return current


def result(record, *, replayed=False, confirmed=False):
    # 작업 생성 요청의 응답을 만든다. 작업 접수 완료는 분석 결과 저장 완료와 다르다.
    complete = record["state"] == "complete" or confirmed
    receipt = {"operation": "analysis_job_create", "job_id": record["job_id"],
               "job_revision": record["job_revision"], "request_id": record["request_id"],
               "actor": record["job"]["actor"], "created_at": record["job"]["created_at"],
               "storage_status": "stored", "analysis_status": "not_started"} if complete else None
    if confirmed:
        receipt["confirmation"] = "intent_owner_state"
    return {"request_id": record["request_id"], "state": "complete" if complete else "pending_reconcile",
            "job_id": record["job_id"], "job_revision": record["job_revision"] if complete else None,
            "receipt": receipt, "replayed": replayed, "cleanup_failures": []}


def create(self, *, tenant, user_id, request_id, source_id, source_version, source_sha256,
           expected_registration_revision, targets, outputs, authorize, plan_ref=None, registration=None):
    # 요청을 원본·대상 문서 기준에 묶어 접수한다. 이미 같은 요청이 있으면 기존 결과를 돌려준다.
    for identifier in (request_id, source_id, source_version):
        limits.identifier(identifier)
    limits.revision(source_sha256); limits.revision(expected_registration_revision)
    records.validate_targets(self, targets, outputs)
    payload = {"source_id": source_id, "source_version": source_version, "source_sha256": source_sha256,
               "expected_registration_revision": expected_registration_revision, "targets": targets, "outputs": outputs}
    if registration is not None:
        from .registration import validate
        validate(registration)
        if plan_ref is not None or len(targets) != 1 or outputs != ["wiki", "ontology"]:
            raise JobValidationError("A registration creates exactly one Markdown and its ontology.")
        payload["registration"] = registration
    # 옛 호출은 기존 지문을 그대로 유지하고, 계획 인계만 정확한 계획/목표를 요청에 결합한다.
    if plan_ref is not None:
        if type(plan_ref) is not dict or set(plan_ref) != {"plan_id", "plan_revision", "document"}:
            raise JobValidationError("A complete analysis plan reference is required")
        limits.identifier(plan_ref["plan_id"]); limits.revision(plan_ref["plan_revision"])
        if targets != [plan_ref["document"]]:
            raise JobValidationError("A planned job must use its exact output target")
        payload["analysis_plan"] = plan_ref
    digest = canonical_json_hash({"tenant": tenant, "user_id": user_id, **payload})
    with self.sources._coordination_lock(create=True):
        actor = records.authorized(authorize, tenant, user_id)
        path = records.request_path(self, tenant, user_id, request_id)
        try:
            prior = queries.request_record(self, tenant, user_id, request_id)
        except FileNotFoundError:
            prior = None
        if prior is not None:
            if prior["payload_hash"] != digest:
                raise JobConflictError("request_conflict", request_id=request_id)
            return result(prior, replayed=True)
        if plan_ref is not None:
            from core.modules.analysis_plans.store import PlanStore
            plan, _, plan_components = PlanStore(self.store, actor, rulesets=self.rulesets).validate_locked(
                plan_ref["plan_id"], plan_ref["plan_revision"])
            output = next((item for item in plan["plan"]["outputs"] if item["document"] == plan_ref["document"]), None)
            if output is None or output["outputs"] != outputs:
                raise JobValidationError("The job outputs do not match the fixed analysis plan")
            selected_text = plan_components[plan["text_components"][plan_ref["document"]]]
            from hashlib import sha256
            if sha256(selected_text.encode()).hexdigest() != source_sha256:
                raise JobValidationError("The execution source must equal the fixed selected text")
        source_request = self.sources._request_path(tenant, user_id, request_id)
        if files.checked(self.store, source_request).exists():
            raise JobConflictError("request_conflict", request_id=request_id)
        jobs = files.entries(self.store, personal_root(self.store.data_dir, user_id) / "analysis", maximum=limits.MAX_JOBS + 1)
        if any(not limits.ID.fullmatch(name) for name in jobs):
            raise limits.JobCorruptError("The job registry contains an unexpected entry.")
        old_jobs = files.entries(self.store, self.jobs_dir / "_owners" / records.owner_key(tenant, user_id), maximum=limits.MAX_JOBS + 1)
        if len(jobs) + len(old_jobs) >= limits.MAX_JOBS:
            raise JobLimitError("The job count limit was reached.")
        requests = files.entries(self.store, analysis_request_root(self.store.data_dir, user_id), maximum=limits.MAX_JOBS + 1)
        if len(requests) >= limits.MAX_JOBS:
            raise JobLimitError("The job request count limit was reached.")
        catalog = self.sources._get_source_locked(source_id)
        current = catalog["versions"][-1]
        source = {"source_id": source_id, "source_version": source_version, "source_sha256": source_sha256,
                  "size_bytes": current["size_bytes"], "registration_revision": expected_registration_revision}
        check_basis(self, source)
        if current["format"] not in {"md", "txt"} and registration is None:
            raise JobValidationError("Binary originals require a fixed conversion and analysis-plan handoff")
        from .registration import original_path
        with files.verify_original(self.store, original_path(self.sources, source_id, source_version), current):
            pass
        captured = []
        # 기존 대상은 본문/검토 상태를, 신규 대상은 부재(None)를 시작 기준으로 남긴다.
        for document in targets:
            try:
                snapshot = ReviewStore(self.store).query(document)
                captured.append({"document": document, "source_revision": snapshot["source_revision"],
                                 "state_revision": snapshot["state_revision"]})
            except FileNotFoundError:
                captured.append({"document": document, "source_revision": None, "state_revision": None})
        if registration is not None and any(target["source_revision"] is not None for target in captured):
            raise JobConflictError("document_exists")
        now, job_id = self._now(), uuid4().hex
        self._job_paths[job_id] = analysis_job_root(self.store.data_dir, user_id, job_id)
        job = {"schema_version": 1, "job_id": job_id, "tenant": tenant, "user_id": user_id,
               "request_id": request_id, "payload_hash": digest, "actor": actor, "created_at": now.isoformat(),
               "source_ref": source, "targets": captured, "outputs": list(outputs), "state": "awaiting_cli",
               "run_id": None, "reported_status": None, "message": "", "events": [event("created", actor, now,
                   **({"analysis_plan": plan_ref} if plan_ref is not None else {}),
                   **({"registration": registration} if registration is not None else {}))]}
        conversion = None
        if registration is not None:
            from .registration import materialize
            _, conversion = materialize(self, job, actor)
        record = {"operation": "analysis_job_create", "tenant": tenant, "user_id": user_id,
                  "request_id": request_id, "payload_hash": digest, "job_id": job_id,
                  "job_revision": canonical_json_hash(job), "state": "pending_reconcile", "job": job}
        self._write_request(path, record)
        try:
            # 접수 근거 → 소유 인덱스 → 작업 상태 → 완료 영수증 순서로 쓴다.
            self._write(records.owner_path(self, tenant, user_id, job_id), {"job_id": job_id, "tenant": tenant, "user_id": user_id})
            if conversion is not None:
                self._write(self.job_root(job_id) / "conversion.json", conversion)
            self._write(records.state_path(self, job_id), job)
            complete = {**record, "state": "complete"}
            self._write_request(path, complete)
            return result(complete)
        except OSError as error:
            output = result(record)
            output["cleanup_failures"] = list(getattr(error, "cleanup_failures", ()))
            return output


def opened(self, job_id, tenant, user_id, authorize, expected=None, *, check_source_basis=True):
    # 다른 변경 함수가 공통으로 사용하는 확인 단계다. 이미 잠금을 잡은 호출자가 사용한다.
    actor = records.authorized(authorize, tenant, user_id)
    job = records.owned_state(self, job_id, tenant, user_id)
    if check_source_basis:
        records.check_access(job["actor"], actor)
    if expected is not None:
        limits.revision(expected)
        if canonical_json_hash(job) != expected:
            raise JobConflictError("conflict", job_id=job_id, current_job_revision=canonical_json_hash(job))
    if job["state"] == "cancelled":
        raise JobConflictError("job_cancelled", job_id=job_id)
    if check_source_basis:
        check_basis(self, job["source_ref"])
    return job, actor


def live(self, job, run_id):
    # 현재 실행 ID가 맞고 lease가 아직 유효한지 확인한다. 만료됐다고 기존 실행을 몰래 인계하지 않는다.
    limits.identifier(run_id)
    if job["state"] != "claimed" or job["run_id"] != run_id:
        raise JobConflictError("run_conflict", job_id=job["job_id"])
    lease = records.lease(self, job)
    if limits.instant(lease["expires_at"]) <= self._now():
        raise JobConflictError("lease_expired", job_id=job["job_id"])
    return lease


def prepare_state(self, job, kind, actor, **details):
    # 기존 상태를 수정하지 않고 이벤트를 추가한 새 dict를 만든 뒤 크기를 미리 검사한다.
    if len(job["events"]) >= limits.MAX_EVENTS:
        raise JobLimitError("The job event limit was reached.")
    value = {**job, "events": [*job["events"], event(kind, actor, self._now(), **details)]}
    records.preflight(value)
    return value


def save_state(self, job, kind, actor, **details):
    # 검증한 후보 상태 하나를 저장하고, 조회용 부가 상태를 덧붙여 반환한다.
    value = prepare_state(self, job, kind, actor, **details)
    self._write(records.state_path(self, job["job_id"]), value)
    return queries.project(self, value)


def claim(self, job_id, *, tenant, user_id, expected_job_revision, authorize, reclaim=False):
    # 이번 run에 실행권을 발급한다. reclaim=True는 만료/중단 후 새 실행을 받겠다는 명시적 요청이다.
    limits.revision(expected_job_revision)
    if type(reclaim) is not bool:
        raise JobValidationError("reclaim must be explicit boolean.")
    with self.sources._coordination_lock():
        job, actor = opened(self, job_id, tenant, user_id, authorize)
        current = canonical_json_hash(job)
        lease = records.lease(self, job)
        active = lease is not None and limits.instant(lease["expires_at"]) > self._now()
        if job["state"] == "claimed" and active and not reclaim and job["reported_status"] not in {"stopped", "failed"}:
            claimed = next((item for item in reversed(job["events"]) if item["kind"] == "claimed"), None)
            if claimed and claimed["details"].get("expected_job_revision") == expected_job_revision:
                return queries.project(self, job)
            raise JobConflictError("already_claimed", job_id=job_id)
        if current != expected_job_revision:
            raise JobConflictError("conflict", job_id=job_id, current_job_revision=current)
        if job["state"] == "claimed" and (not reclaim or (active and job["reported_status"] not in {"stopped", "failed"})):
            raise JobConflictError("reclaim_required" if not reclaim else "already_claimed", job_id=job_id)
        if job["state"] == "awaiting_cli" and reclaim:
            raise JobValidationError("An unclaimed job does not require reclaim.")
        if len(job["events"]) >= limits.MAX_EVENTS:
            raise JobLimitError("The job event limit was reached.")
        leases = files.entries(self.store, self.job_root(job_id) / "leases", maximum=limits.MAX_RUNS + 1)
        if len(leases) >= limits.MAX_RUNS:
            raise JobLimitError("The job run count limit was reached.")
        if any(not name.endswith(".json") or not limits.ID.fullmatch(name[:-5]) for name in leases):
            raise limits.JobCorruptError("The job lease registry contains an invalid entry.")
        now, run_id = self._now(), uuid4().hex
        expiry = (now + timedelta(seconds=limits.LEASE_SECONDS)).isoformat()
        lease = {"job_id": job_id, "run_id": run_id, "expires_at": expiry,
                 "events": [{"event_id": uuid4().hex, "actor": actor, "timestamp": now.isoformat(), "expires_at": expiry}]}
        candidate = prepare_state(self, {**job, "state": "claimed", "run_id": run_id, "reported_status": None, "message": ""},
                                  "claimed", actor, expected_job_revision=expected_job_revision, reclaim=reclaim,
                                  run_id=run_id, previous_run_id=job["run_id"])
        records.preflight(lease)
        # 두 파일의 한도를 모두 먼저 검사해 실패한 claim마다 불필요한 lease가 쌓이지 않게 한다.
        self._write(self.job_root(job_id) / "leases" / (run_id + ".json"), lease)
        self._write(records.state_path(self, job_id), candidate)
        return queries.project(self, candidate)


def heartbeat(self, job_id, *, tenant, user_id, run_id, expected_lease_revision, authorize):
    # 생존 보고는 lease만 갱신한다. 본문 편집 기준인 job_revision은 불필요하게 바꾸지 않는다.
    limits.revision(expected_lease_revision)
    with self.sources._coordination_lock():
        job, actor = opened(self, job_id, tenant, user_id, authorize)
        lease = live(self, job, run_id)
        if canonical_json_hash(lease) != expected_lease_revision:
            raise JobConflictError("lease_conflict", job_id=job_id)
        if len(lease["events"]) >= limits.MAX_EVENTS:
            raise JobLimitError("The lease event limit was reached.")
        now = self._now(); expiry = (now + timedelta(seconds=limits.LEASE_SECONDS)).isoformat()
        value = {**lease, "expires_at": expiry, "events": [*lease["events"],
            {"event_id": uuid4().hex, "actor": actor, "timestamp": now.isoformat(), "expires_at": expiry}]}
        self._write(self.job_root(job_id) / "leases" / (run_id + ".json"), value)
        return queries.project(self, job)


def update(self, job_id, *, tenant, user_id, run_id, expected_job_revision, reported_status, message="", authorize):
    # CLI가 신고한 진행 상태를 기록한다. complete 같은 임의의 저장 성공 선언은 허용하지 않는다.
    if reported_status not in limits.REPORTED_STATUSES or type(message) is not str or len(message) > 1000:
        raise JobValidationError("Only bounded CLI progress or failure reports are accepted.")
    with self.sources._coordination_lock():
        job, actor = opened(self, job_id, tenant, user_id, authorize, expected_job_revision)
        live(self, job, run_id)
        return save_state(self, {**job, "reported_status": reported_status, "message": message},
                          "reported", actor, reported_status=reported_status, message=message,
                          run_id=run_id, expected_job_revision=expected_job_revision)


def cancel(self, job_id, *, tenant, user_id, expected_job_revision, reason="", authorize):
    # 원본이 바뀌었거나 lease가 만료됐어도 현재 작업 기준·권한으로 후속 실행을 취소할 수 있다.
    if type(reason) is not str or len(reason) > 1000:
        raise JobValidationError("The cancellation reason is too long.")
    with self.sources._coordination_lock():
        job, actor = opened(self, job_id, tenant, user_id, authorize, expected_job_revision, check_source_basis=False)
        return save_state(self, {**job, "state": "cancelled", "message": reason}, "cancelled", actor,
                          reason=reason, run_id=job["run_id"], expected_job_revision=expected_job_revision)


def source_input(self, job_id, *, tenant, user_id, run_id, authorize, expected_job_revision=None):
    # 유효한 실행에 고정 원본 참조를 전달한다. 실제 바이트 수신은 클라이언트의 다운로드가 담당한다.
    with self.sources._coordination_lock():
        job, _ = opened(self, job_id, tenant, user_id, authorize, expected_job_revision)
        live(self, job, run_id)
        return {"job_id": job_id, "run_id": run_id, "job_revision": canonical_json_hash(job),
                "source_ref": dict(job["source_ref"]),
                "execution_ready": False, "blockers": list(limits.BLOCKERS)}
