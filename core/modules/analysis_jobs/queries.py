"""작업/lease를 읽기만 투영하며 완료된 AI 결과를 추정하지 않는다."""

# 조회 결과는 저장된 작업, 현재 lease, 원본 기준, 실제 결과 영수증을 함께 보여 준다.
# 조회로 작업을 고치거나 만료된 실행을 자동 재접수하지 않는다.

import base64
import json

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.sources import files
from . import contracts as limits, records
from .contracts import JobConflictError, JobCorruptError, JobLimitError


def basis_status(self, job):
    # 작업에 고정한 원본과 현재 등록의 최신 판본이 같은지 current/changed/missing으로 구분한다.
    try:
        catalog = self.sources._get_source_locked(job["source_ref"]["source_id"])
    except FileNotFoundError:
        return "missing"
    source, current = job["source_ref"], catalog["versions"][-1]
    return "current" if (source["registration_revision"] == catalog["registration_revision"]
        and source["source_version"] == catalog["current_version"]
        and source["source_sha256"] == current["source_sha256"]
        and source["size_bytes"] == current["size_bytes"]) else "changed"


def project(self, job):
    # 저장된 job에 조회 시점의 상태를 덧붙인 새 dict를 만든다. 원래 job 파일을 수정하지 않는다.
    # lease는 이번 실행의 임시 사용권이다. 결과가 저장됐는지와 실행이 살아 있는지는 별도다.
    from core.modules.analysis_inputs.readiness import project as input_readiness
    from core.modules.analysis_results.repository import summary as result_summary
    lease = records.lease(self, job)
    # **job으로 기존 항목을 펼치고 조회 항목을 추가한다. 실행 가능 여부는 execution_ready,
    # 실제 자료 저장의 부분/전체 완료는 result_summary에서 각각 확인한다.
    return {**job, "job_revision": canonical_json_hash(job),
        "lease_status": "none" if lease is None else "expired" if limits.instant(lease["expires_at"]) <= self._now() else "active",
        "lease_revision": None if lease is None else canonical_json_hash(lease),
        "lease_expires_at": None if lease is None else lease["expires_at"],
        "basis_status": basis_status(self, job), "execution_ready": False,
        "result_summary": result_summary(self, job), **input_readiness(self, job)}


def query(self, job_id, *, tenant, user_id):
    # 소유 인덱스를 확인한 작업만 읽고, 같은 잠금 안에서 표시용 상태를 계산한다.
    with self.sources._coordination_lock():
        return project(self, records.owned_state(self, job_id, tenant, user_id))


def request_record(self, tenant, user_id, request_id):
    # 작업 생성 요청의 영구 접수 근거가 처음의 작업 상태와 연결되는지 확인한다.
    value = records.read(self, records.request_path(self, tenant, user_id, request_id))
    try:
        if type(value) is not dict or set(value) != {"operation", "tenant", "user_id", "request_id", "payload_hash",
                "job_id", "job_revision", "state", "job"}:
            raise ValueError()
        if any(value[key] != expected for key, expected in (("operation", "analysis_job_create"), ("tenant", tenant),
                ("user_id", user_id), ("request_id", request_id))):
            raise ValueError()
        limits.identifier(value["job_id"]); limits.revision(value["payload_hash"]); limits.revision(value["job_revision"])
        if value["state"] not in {"complete", "pending_reconcile"}:
            raise ValueError()
        initial = records.validate_state(self, value["job"], value["job_id"], tenant, user_id)
        if (initial["request_id"] != request_id or initial["payload_hash"] != value["payload_hash"]
                or canonical_json_hash(initial) != value["job_revision"] or initial["state"] != "awaiting_cli"
                or initial["run_id"] is not None or len(initial["events"]) != 1):
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError) as error:
        raise JobCorruptError("The job creation intent is invalid.") from error


def request_receipt(self, *, tenant, user_id, request_id):
    # 마지막 영수증 기록에 실패해도 같은 intent·소유 인덱스·상태의 증거를 조회할 수 있다.
    from .commands import result
    with self.sources._coordination_lock():
        record = request_record(self, tenant, user_id, request_id)
        if record["state"] == "complete":
            return result(record, replayed=True)
        try:
            job = records.owned_state(self, record["job_id"], tenant, user_id)
        except FileNotFoundError:
            return result(record, replayed=True)
        immutable = {"job_id", "tenant", "user_id", "request_id", "payload_hash", "actor", "created_at", "source_ref", "targets", "outputs"}
        confirmed = (all(job[name] == record["job"][name] for name in immutable)
                     and job["events"][0] == record["job"]["events"][0])
        return result(record, replayed=True, confirmed=confirmed)


def list_jobs(self, *, tenant, user_id, scope_key, limit=20, cursor=None):
    # 본인 인덱스에서만 작업을 모아 페이지로 돌려준다. cursor는 목록과 권한의 지문에도 묶인다.
    if type(limit) is not int or not 1 <= limit <= 50 or type(scope_key) is not str or not scope_key:
        raise limits.JobValidationError("A valid job listing scope and page size are required.")
    scope = canonical_json_hash({"tenant": tenant, "user_id": user_id, "scope_key": scope_key})
    previous = None
    if cursor is not None:
        try:
            if type(cursor) is not str or len(cursor) > 4096:
                raise ValueError()
            previous = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True))
            if type(previous) is not dict or set(previous) != {"scope", "basis", "after"} or previous["scope"] != scope:
                raise ValueError()
            limits.identifier(previous["after"]); limits.revision(previous["basis"])
        except (ValueError, TypeError, RecursionError):
            raise InvalidCursorError() from None
    with self.sources._coordination_lock():
        directory = self.jobs_dir / "_owners" / records.owner_key(tenant, user_id)
        names = files.entries(self.store, directory, maximum=limits.MAX_JOBS + 1)
        if len(names) > limits.MAX_JOBS:
            raise JobLimitError("The owner job count limit was reached.")
        values, size = [], 0
        for name in names:
            if not name.endswith(".json") or not limits.ID.fullmatch(name[:-5]):
                raise JobCorruptError("The job owner index contains an invalid entry.")
            job = records.owned_state(self, name[:-5], tenant, user_id)
            size += len(canonical_json_bytes(job))
            if size > limits.MAX_TOTAL_METADATA_BYTES:
                raise JobLimitError("The owner job metadata limit was reached.")
            values.append(project(self, job))
        basis = canonical_json_hash([{key: value[key] for key in ("job_id", "job_revision", "lease_revision", "lease_status", "basis_status")}
                                    for value in values])
        offset = 0
        if previous is not None:
            if previous["basis"] != basis:
                # 페이지 사이 작업/lease 상태가 달라졌으면 이전 위치를 새 목록에 그대로 적용하지 않는다.
                raise CatalogChangedError()
            try:
                offset = [value["job_id"] for value in values].index(previous["after"]) + 1
            except ValueError:
                raise InvalidCursorError() from None
        page = values[offset:offset + limit]
        more = offset + len(page) < len(values)
        next_cursor = None
        if more:
            encoded = json.dumps({"scope": scope, "basis": basis, "after": page[-1]["job_id"]}, separators=(",", ":")).encode()
            next_cursor = base64.urlsafe_b64encode(encoded).rstrip(b"=").decode()
        return {"items": page, "scope": {"tenant": tenant, "user_id": user_id, "kind": "analysis_jobs"},
                "catalog_revision": basis, "next_cursor": next_cursor, "complete": not more,
                "truncated": False, "skipped": [], "scanned": len(values), "requires_refresh": False}
