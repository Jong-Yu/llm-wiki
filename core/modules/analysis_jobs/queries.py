"""작업/lease를 읽기만 투영하며 완료된 AI 결과를 추정하지 않는다."""

# 조회 결과는 저장된 작업, 현재 lease, 원본 기준, 실제 결과 영수증을 함께 보여 준다.
# 조회로 작업을 고치거나 만료된 실행을 자동 재접수하지 않는다.

import base64
import json
import stat

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.common.read_index import CanonicalIndexUnavailable, read_index
from core.common.read_metrics import cache_event, increment, span
from core.common.read_snapshots import observation
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.sources import files
from core.modules.sources.contracts import SourceCorruptError
from . import contracts as limits, records
from .contracts import JobCorruptError, JobLimitError
from core.common.storage_layout import personal_root


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


def listing_state(self, job):
    """전체 목록의 변경 감지에 필요한 작업·lease·원본 기준만 읽는다."""
    lease = records.lease(self, job)
    return {"job_revision": canonical_json_hash(job),
        "lease_status": "none" if lease is None else "expired" if limits.instant(lease["expires_at"]) <= self._now() else "active",
        "lease_revision": None if lease is None else canonical_json_hash(lease),
        "lease_expires_at": None if lease is None else lease["expires_at"],
        "basis_status": basis_status(self, job)}


def project(self, job, *, state=None):
    # 저장된 job에 조회 시점의 상태를 덧붙인 새 dict를 만든다. 원래 job 파일을 수정하지 않는다.
    # lease는 이번 실행의 임시 사용권이다. 결과가 저장됐는지와 실행이 살아 있는지는 별도다.
    from core.modules.analysis_inputs.readiness import project as input_readiness
    from core.modules.analysis_results.repository import summary as result_summary
    from .registration import registration
    # **job으로 기존 항목을 펼치고 조회 항목을 추가한다. 실행 가능 여부는 execution_ready,
    # 실제 자료 저장의 부분/전체 완료는 result_summary에서 각각 확인한다.
    return {**job, **(listing_state(self, job) if state is None else state), "execution_ready": False,
        "result_summary": result_summary(self, job), "registration": registration(job),
        "conversion": records.read(self, self.job_root(job["job_id"]) / "conversion.json") if registration(job) else None,
        **input_readiness(self, job)}


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


def _owner_jobs(self, tenant, user_id):
    directory = self.jobs_dir / "_owners" / records.owner_key(tenant, user_id)
    old_names = files.entries(self.store, directory, maximum=limits.MAX_JOBS + 1)
    personal = personal_root(self.store.data_dir, user_id) / "analysis"
    personal_names = files.entries(self.store, personal, maximum=limits.MAX_JOBS + 1)
    if any(not limits.ID.fullmatch(name) for name in personal_names):
        raise JobCorruptError("The personal job registry contains an invalid entry.")
    names = sorted([*old_names, *(name + ".json" for name in personal_names)])
    if len(set(names)) != len(names):
        raise JobCorruptError("Both legacy and personal job records exist.")
    if len(names) > limits.MAX_JOBS:
        raise JobLimitError("The owner job count limit was reached.")
    personal_ids = set(personal_names)
    jobs = []
    for name in names:
        job_id = name[:-5]
        marker, state = ((personal / job_id / "owner.json", personal / job_id / "job.json")
                         if job_id in personal_ids else (directory / name, self.jobs_dir / job_id / "state.json"))
        jobs.append((name, marker, state))
    return jobs


def _job_id(name):
    # 구 owner 파일명 검사는 앞선 작업의 상태·lease·원본 검사 뒤, 그 항목 차례에 수행한다.
    if not name.endswith(".json") or not limits.ID.fullmatch(name[:-5]):
        raise JobCorruptError("The job owner index contains an invalid entry.")
    return name[:-5]


def _fingerprint(self, path, *, missing=False):
    # stat 실패와 위험한 경로는 캐시 장애가 아니다. 원본 조회와 같은 오류로 중단한다.
    files.checked(self.store, path)
    try:
        info = path.stat(follow_symlinks=False)
    except FileNotFoundError:
        if missing:
            return {"path": path.relative_to(self.store.data_dir).as_posix(), "missing": True}
        raise
    if not stat.S_ISREG(info.st_mode):
        raise SourceCorruptError("A stored file must be regular.")
    return {"path": path.relative_to(self.store.data_dir).as_posix(), "size": info.st_size,
            "mtime": info.st_mtime_ns, "ctime": info.st_ctime_ns, "inode": info.st_ino, "device": info.st_dev}


def _record_fingerprint(self, path):
    try:
        return _fingerprint(self, path)
    except SourceCorruptError as error:
        # owner/state/lease 경로 오류도 records.read와 같은 작업 오류로 전달한다.
        raise JobCorruptError("The job record is invalid.") from error


def _owner_marker(self, path, expected):
    marker = records.read(self, path)
    if marker != expected:
        raise JobCorruptError("The job owner index is invalid.")
    return marker


def _source_basis(self, source_id):
    try:
        catalog = self.sources._get_source_locked(source_id)
    except FileNotFoundError:
        return {"missing": True}
    current = catalog["versions"][-1]
    return {"missing": False, "registration_revision": catalog["registration_revision"],
            "source_version": catalog["current_version"], "source_sha256": current["source_sha256"],
            "size_bytes": current["size_bytes"]}


def _lease_basis(self, job):
    lease = records.lease(self, job)
    return {"lease_revision": None if lease is None else canonical_json_hash(lease),
            "lease_expires_at": None if lease is None else lease["expires_at"]}


def _cached_job(job_id, job, tenant, user_id):
    """캐시의 얇은 형식이 다르면 원본 경로로 돌아간다. 원본 loader 오류와 구분한다."""
    try:
        if (set(job) != {"job_id", "tenant", "user_id", "source_ref", "run_id", "job_revision", "metadata_bytes"}
                or (job["job_id"], job["tenant"], job["user_id"]) != (job_id, tenant, user_id)
                or type(job["metadata_bytes"]) is not int or job["metadata_bytes"] < 1):
            raise ValueError()
        limits.revision(job["job_revision"])
        if job["run_id"] is not None:
            limits.identifier(job["run_id"])
        source = job["source_ref"]
        if (type(source) is not dict or set(source) != {"source_id", "source_version", "source_sha256", "size_bytes", "registration_revision"}
                or type(source["size_bytes"]) is not int or not 0 <= source["size_bytes"] <= 20 * 1024 * 1024):
            raise ValueError()
        limits.identifier(source["source_id"]); limits.identifier(source["source_version"])
        limits.revision(source["source_sha256"]); limits.revision(source["registration_revision"])
    except (ValueError, TypeError, KeyError) as error:
        raise CanonicalIndexUnavailable("The cached job summary is invalid.", reason="corrupt") from error


def _cached_source(source):
    try:
        if type(source.get("missing")) is not bool:
            raise ValueError()
        fields = {"missing"} if source["missing"] else {
            "missing", "registration_revision", "source_version", "source_sha256", "size_bytes"}
        if set(source) != fields:
            raise ValueError()
        if not source["missing"]:
            limits.identifier(source["source_version"])
            limits.revision(source["registration_revision"]); limits.revision(source["source_sha256"])
            if type(source["size_bytes"]) is not int or not 0 <= source["size_bytes"] <= 20 * 1024 * 1024:
                raise ValueError()
    except (ValueError, TypeError, KeyError) as error:
        raise CanonicalIndexUnavailable("The cached source observation is invalid.", reason="corrupt") from error


def _cached_lease(lease):
    try:
        if set(lease) != {"lease_revision", "lease_expires_at"}:
            raise ValueError()
        if lease["lease_revision"] is None:
            if lease["lease_expires_at"] is not None:
                raise ValueError()
        else:
            limits.revision(lease["lease_revision"]); limits.instant(lease["lease_expires_at"])
    except (ValueError, TypeError, KeyError) as error:
        raise CanonicalIndexUnavailable("The cached lease observation is invalid.", reason="corrupt") from error


def _indexed_values(self, index, jobs, tenant, user_id, scope, *, fingerprints=None, source_paths=None):
    if len(jobs) > limits.MAX_JOBS:
        raise JobLimitError("The owner job count limit was reached.")
    observed = {name: {} for name in (
        "analysis_job_owners", "analysis_jobs", "analysis_job_leases", "analysis_job_sources")}
    def fingerprint(path, *, record=False, missing=False):
        key = path.relative_to(self.store.data_dir).as_posix()
        if fingerprints is not None and key in fingerprints:
            return fingerprints[key]
        with span("fingerprint"):
            value = _record_fingerprint(self, path) if record else _fingerprint(self, path, missing=missing)
        if fingerprints is not None:
            fingerprints[key] = value
        return value
    # 요청 안에서만 재사용한다. 작업마다 get의 SQL·캐시 경로 검사를 반복하지 않는다.
    prefetched = {namespace: index.lookup(namespace, scope) for namespace in observed}
    def cached(namespace, key, signature, loader):
        previous = prefetched[namespace].get(key)
        if previous is not None and previous[0] == signature:
            value = previous[1]
        else:
            value = index.get(namespace, scope, key, signature, loader)
            prefetched[namespace][key] = (signature, value)
        observed[namespace][key] = (signature, value)
        return value
    def load_job(job_id):
        # owner marker 검증을 통과한 상태만 캐시에 넣는다. events·본문은 저장하지 않는다.
        job = records.owned_state(self, job_id, tenant, user_id)
        return {key: job[key] for key in ("job_id", "tenant", "user_id", "source_ref", "run_id")} | {
            "job_revision": canonical_json_hash(job), "metadata_bytes": len(canonical_json_bytes(job))}
    states, size = {}, 0
    for name, marker_path, path in jobs:
        job_id = _job_id(name)
        expected = {"job_id": job_id, "tenant": tenant, "user_id": user_id}
        marker_signature = canonical_json_hash(fingerprint(marker_path, record=True))
        marker = cached("analysis_job_owners", job_id, marker_signature,
                        lambda: _owner_marker(self, marker_path, expected))
        if marker != expected:
            raise CanonicalIndexUnavailable("The cached job owner is invalid.", reason="corrupt")
        # marker가 손상됐으면 state의 stat/본문에 접근하기 전에 기존 owner 오류로 중단한다.
        signature = canonical_json_hash([marker_signature, fingerprint(path, record=True)])
        job = cached("analysis_jobs", job_id, signature, lambda: load_job(job_id))
        _cached_job(job_id, job, tenant, user_id)
        size += job["metadata_bytes"]
        if size > limits.MAX_TOTAL_METADATA_BYTES:
            raise JobLimitError("The owner job metadata limit was reached.")
        if path.name == "job.json":
            self._job_paths[job_id] = path.parent
        else:
            self._job_paths.pop(job_id, None)
        # 작업마다 원래 순서인 용량 → lease/현재 시각 → 원본 기준을 지킨다.
        lease_signature = canonical_json_hash(None if job["run_id"] is None else fingerprint(
            self.job_root(job_id) / "leases" / (job["run_id"] + ".json"), record=True))
        lease = cached("analysis_job_leases", job_id, lease_signature, lambda: _lease_basis(self, job))
        _cached_lease(lease)
        expires = lease["lease_expires_at"]
        lease_status = "none" if expires is None else "expired" if limits.instant(expires) <= self._now() else "active"
        source_id = job["source_ref"]["source_id"]
        source_observation = observed["analysis_job_sources"].get(source_id)
        if source_observation is None:
            # 같은 조정 잠금 안에서 첫 참조를 검사한 원본은 이 요청 동안 다시 stat하지 않는다.
            if source_paths is not None and source_id in source_paths:
                source_path = self.store.data_dir / source_paths[source_id]
            else:
                source_path = self.sources._catalog_path(source_id)
                if source_paths is not None:
                    source_paths[source_id] = source_path.relative_to(self.store.data_dir).as_posix()
            source_signature = canonical_json_hash(fingerprint(source_path, missing=True))
            source = cached("analysis_job_sources", source_id, source_signature, lambda: _source_basis(self, source_id))
            _cached_source(source)
        else:
            source = source_observation[1]
        states[job_id] = {"job_revision": job["job_revision"], **lease,
            "lease_status": lease_status,
            "basis_status": "missing" if source["missing"] else "current" if all(
                job["source_ref"][key] == source[key] for key in
                ("registration_revision", "source_version", "source_sha256", "size_bytes")) else "changed"}
    # 전체 기준을 확인한 뒤에만 SQL 페이지의 membership을 공개한다. loader는 검증한 요약만 재사용한다.
    for namespace, values in observed.items():
        index.sync(namespace, scope, [(key, signature) for key, (signature, _) in values.items()],
                   lambda key: values[key][1])
    return states


def _observed_values(self, index, tenant, user_id, scope):
    """Reuse tracked metadata while retaining SQL validation on every request."""
    refreshed = False

    def load():
        nonlocal refreshed
        jobs = _owner_jobs(self, tenant, user_id)
        increment("scanned", len(jobs))
        fingerprints, source_paths = {}, {}
        states = _indexed_values(self, index, jobs, tenant, user_id, scope,
                                 fingerprints=fingerprints, source_paths=source_paths)
        refreshed = True
        return {"jobs": jobs, "states": states, "fingerprints": fingerprints, "source_paths": source_paths}

    def update(value, paths):
        nonlocal refreshed
        jobs = value["jobs"]
        owners = {marker.relative_to(self.store.data_dir).as_posix() for _, marker, _ in jobs}
        personal_ids = {name[:-5] for name, _, state in jobs if state.name == "job.json"}
        personal = (personal_root(self.store.data_dir, user_id) / "analysis").relative_to(self.store.data_dir).as_posix() + "/"
        legacy = (self.jobs_dir / "_owners" / records.owner_key(tenant, user_id)).relative_to(self.store.data_dir).as_posix() + "/"
        for path in paths:
            parts = path.split("/")
            if path in owners:
                # Removing a legacy owner changes membership; a full scan also
                # preserves directory/name errors before individual job errors.
                try:
                    if not (self.store.data_dir / path).exists():
                        return None
                except (OSError, ValueError):
                    return None
            elif path.startswith(legacy) or (path.startswith(personal)
                    and (len(parts) < 5 or parts[3] not in personal_ids or parts[4] == "owner.json")):
                return None
            value["fingerprints"].pop(path, None)
            source_id = (parts[1] if len(parts) == 3 and parts[0] == "_sources" and parts[2] == "catalog.json" else
                         parts[1][:-5] if len(parts) == 2 and parts[0] == "_registrations" and parts[1].endswith(".json") else None)
            if source_id in value["source_paths"]:
                # Re-select old/new layout in the original per-job order. This
                # catches a newly introduced duplicate catalog as well.
                value["source_paths"].pop(source_id)
        value["states"] = _indexed_values(self, index, jobs, tenant, user_id, scope,
            fingerprints=value["fingerprints"], source_paths=value["source_paths"])
        refreshed = True
        return value

    value = observation(self.store, "registration", "analysis_job_entries:" + scope, load, update=update)
    if refreshed:
        return value["states"]
    # Keep thin SQL payload, membership and current limits checked even when the
    # database was rebuilt in this process. Only canonical file metadata is reused.
    return _indexed_values(self, index, value["jobs"], tenant, user_id, scope,
        fingerprints=value["fingerprints"], source_paths=value["source_paths"])


def _listing_basis(states, previous):
    basis = canonical_json_hash([{"job_id": job_id,
        **{key: state[key] for key in ("job_revision", "lease_revision", "lease_status", "basis_status")}}
        for job_id, state in states.items()])
    if previous is not None:
        if previous["basis"] != basis:
            raise CatalogChangedError()
        if previous["after"] not in states:
            raise InvalidCursorError()
    return basis


def _listing_result(page, *, tenant, user_id, scope, basis, more, scanned):
    next_cursor = None
    if more:
        encoded = json.dumps({"scope": scope, "basis": basis, "after": page[-1]["job_id"]}, separators=(",", ":")).encode()
        next_cursor = base64.urlsafe_b64encode(encoded).rstrip(b"=").decode()
    return {"items": page, "scope": {"tenant": tenant, "user_id": user_id, "kind": "analysis_jobs"},
            "catalog_revision": basis, "next_cursor": next_cursor, "complete": not more,
            "truncated": False, "skipped": [], "scanned": scanned, "requires_refresh": False}


def _uncached_list(self, jobs, *, tenant, user_id, scope, limit, previous):
    values, states, size = {}, {}, 0
    for name, _, _ in jobs:
        job_id = _job_id(name)
        job = records.owned_state(self, job_id, tenant, user_id)
        size += len(canonical_json_bytes(job))
        if size > limits.MAX_TOTAL_METADATA_BYTES:
            raise JobLimitError("The owner job metadata limit was reached.")
        values[job_id] = job
        states[job_id] = listing_state(self, job)
    basis = _listing_basis(states, previous)
    keys = list(values)
    offset = 0 if previous is None else keys.index(previous["after"]) + 1
    selected = keys[offset:offset + limit]
    page = [project(self, values[job_id], state=states[job_id]) for job_id in selected]
    return _listing_result(page, tenant=tenant, user_id=user_id, scope=scope, basis=basis,
                           more=offset + len(selected) < len(keys), scanned=len(keys))


def list_jobs(self, *, tenant, user_id, scope_key, limit=20, cursor=None):
    # 캐시를 열기 전에 원시 입력과 현재 권한 범위에 묶인 cursor부터 검사한다.
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
        try:
            with read_index(self.store) as index:
                states = _observed_values(self, index, tenant, user_id, scope)
                basis = _listing_basis(states, previous)
                selected = index.page("analysis_jobs", scope,
                    after=None if previous is None else previous["after"], limit=limit + 1)
                # SQL은 위치만 고른다. 반환 작업·고정 입력·결과는 원래 검증 경로를 사용한다.
                with span("projection"):
                    page = [project(self, records.owned_state(self, key, tenant, user_id), state=states[key])
                            for key, _ in selected[:limit]]
                return _listing_result(page, tenant=tenant, user_id=user_id, scope=scope, basis=basis,
                                       more=len(selected) > limit, scanned=len(states))
        except CanonicalIndexUnavailable as error:
            # SQLite만 고장 난 경우 원본 전체 조회로 돌아간다. 업무 오류는 숨기지 않는다.
            cache_event("fallback", getattr(error, "reason", "unknown"))
            jobs = _owner_jobs(self, tenant, user_id)
            return _uncached_list(self, jobs, tenant=tenant, user_id=user_id, scope=scope,
                                  limit=limit, previous=previous)


def _history_record(self, job, *, state=None):
    """Validate current job observations without claiming result/input validity."""
    from .registration import registration
    state = listing_state(self, job) if state is None else state
    registration(job)
    return {key: job[key] for key in ("job_id", "tenant", "user_id", "state", "events")} | {
        "job_revision": state["job_revision"]}


def history(self, job_id, *, tenant, user_id):
    """Read owned canonical events; result, conversion and input files are separate."""
    with self.sources._coordination_lock():
        return _history_record(self, records.owned_state(self, job_id, tenant, user_id))


def _uncached_history_ids(self, jobs, *, tenant, user_id, scope, limit, previous):
    values, states, size = {}, {}, 0
    for name, _, _ in jobs:
        job_id = _job_id(name)
        job = records.owned_state(self, job_id, tenant, user_id)
        size += len(canonical_json_bytes(job))
        if size > limits.MAX_TOTAL_METADATA_BYTES:
            raise JobLimitError("The owner job metadata limit was reached.")
        values[job_id] = job
        states[job_id] = listing_state(self, job)
    basis = _listing_basis(states, previous)
    keys = list(values)
    offset = 0 if previous is None else keys.index(previous["after"]) + 1
    selected = keys[offset:offset + limit]
    page = [{"job_id": _history_record(self, values[key], state=states[key])["job_id"]}
            for key in selected]
    return _listing_result(page, tenant=tenant, user_id=user_id, scope=scope, basis=basis,
                           more=offset + len(page) < len(keys), scanned=len(keys))


def list_history_ids(self, *, tenant, user_id, scope_key, limit=20, cursor=None):
    """Keep owner, metadata, lease/source and cursor checks while omitting details."""
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
        try:
            with read_index(self.store) as index:
                states = _observed_values(self, index, tenant, user_id, scope)
                basis = _listing_basis(states, previous)
                selected = index.page("analysis_jobs", scope,
                    after=None if previous is None else previous["after"], limit=limit + 1)
                page = [{"job_id": _history_record(self,
                    records.owned_state(self, key, tenant, user_id), state=states[key])["job_id"]}
                    for key, _ in selected[:limit]]
                return _listing_result(page, tenant=tenant, user_id=user_id, scope=scope, basis=basis,
                                       more=len(selected) > limit, scanned=len(states))
        except CanonicalIndexUnavailable as error:
            cache_event("fallback", getattr(error, "reason", "unknown"))
            jobs = _owner_jobs(self, tenant, user_id)
            return _uncached_history_ids(self, jobs, tenant=tenant, user_id=user_id, scope=scope,
                                         limit=limit, previous=previous)
