"""영구 intent 이후 불변 원본·카탈로그·완료 영수증을 차례로 공개한다."""

# 저장 흐름의 중심이다. intent는 '이 요청에 어떤 ID를 배정했는지'를 먼저 남기는 기록이다.
# 원본 공개 뒤 다른 기록이 실패해도 같은 요청을 새 원본으로 반복하지 않기 위해 필요하다.

from datetime import datetime, timezone
import os
from uuid import uuid4

from core.common.json_codec import canonical_json_hash
from core.common.storage_layout import analysis_request_root
from . import contracts as limits, files, validation
from .contracts import SourceConflictError, SourceCorruptError, SourceLimitError


def result(record, *, replayed=False, state=None, evidence=None):
    # 내부 요청 기록에서 응답용 dict를 만든다. replayed는 기존 요청을 다시 확인한 경우다.
    value = {"request_id": record["request_id"], "state": state or record["state"],
             "source_id": record["source_id"], "source_version": record["source_version"],
             "source_sha256": record["manifest"]["source_sha256"], "size_bytes": record["manifest"]["size_bytes"],
             "registration_revision": record["registration_revision"] if (state or record["state"]) == "complete" else None,
             "receipt": record["receipt"], "cleanup_failures": list(record["cleanup_failures"]), "replayed": replayed}
    if evidence is not None:
        value["receipt"] = evidence
    return value


def commit(self, staged, *, tenant, user_id, request_id, source_id=None,
           expected_registration_revision=None, authorize):
    """공개 이후 실패는 pending으로 반환하고 재전송으로 원본을 재공개하지 않는다."""
    output = None
    try:
        with self._coordination_lock(create=True):
            # 업로드 수신 후 권한이 취소됐을 수 있으므로 실제 공개 직전에 다시 확인한다.
            actor = validation.actor(authorize(), tenant, user_id)
            limits.identifier(request_id)
            if source_id is None:
                if expected_registration_revision is not None:
                    raise limits.SourceValidationError("Create does not accept a registration basis.")
            else:
                limits.identifier(source_id)
                if (type(expected_registration_revision) is not str
                        or not limits.HEX.fullmatch(expected_registration_revision)):
                    raise limits.SourceValidationError("A registration basis is required for a new version.")
            limits.metadata(**staged.metadata)
            metadata = {**staged.metadata, "source_sha256": staged.source_sha256, "size_bytes": staged.size_bytes}
            payload_hash = canonical_json_hash({"tenant": tenant, "user_id": user_id, "source_id": source_id,
                "expected_registration_revision": expected_registration_revision, **metadata})
            request_path = self._request_path(tenant, user_id, request_id)
            try:
                prior = self._request_locked(tenant, user_id, request_id)
            except FileNotFoundError:
                prior = None
            if prior is not None:
                # 같은 request_id와 다른 내용은 충돌이다. 같은 내용이면 기존 결과만 돌려준다.
                if prior["payload_hash"] != payload_hash:
                    raise SourceConflictError("request_conflict", request_id=request_id)
                output = result(prior, replayed=True)
            else:
                # 두 등록 동작은 같은 조정 잠금과 사용자 request_id 공간을 사용한다.
                for job_request in (analysis_request_root(self.store.data_dir, user_id) / request_path.name,
                                    self.store.data_dir / "_jobs" / "_requests" / request_path.name):
                    files.checked(self.store, job_request)
                    if job_request.exists():
                        raise SourceConflictError("request_conflict", request_id=request_id)
                output = _new_request(self, staged, tenant, user_id, request_id, source_id,
                                      expected_registration_revision, actor, payload_hash, request_path)
    except BaseException as error:
        failures = self.discard(staged)
        if failures:
            error.cleanup_failures = [*getattr(error, "cleanup_failures", []), *failures]
        raise
    output["cleanup_failures"].extend(self.discard(staged))
    return output


def _new_request(self, staged, tenant, user_id, request_id, source_id, expected, actor, payload_hash, request_path):
    # 이 함수에 들어올 때 호출자가 조정 잠금을 보유한다. 새 등록 또는 새 판본 하나만 만든다.
    if staged.consumed or staged.directory.parent != self.store.data_dir / "_incoming":
        raise SourceCorruptError("The staged upload is unavailable.")
    files.checked(self.store, staged.directory)
    with files.verify_original(self.store, staged.directory / "original", {
        "source_sha256": staged.source_sha256, "size_bytes": staged.size_bytes}):
        pass
    if files.original_usage(self.store, incoming=False) + staged.size_bytes > limits.MAX_TENANT_SOURCE_BYTES:
        raise SourceLimitError("The tenant original-byte quota was reached.")
    if self._request_count() >= limits.MAX_REQUESTS:
        raise SourceLimitError("The request receipt limit was reached.")
    operation = "create" if source_id is None else "version"
    if source_id is None:
        if len(files.entries(self.store, self.sources_dir, maximum=limits.MAX_SOURCES + 1)) >= limits.MAX_SOURCES:
            raise SourceLimitError("The source registration limit was reached.")
        source_id = uuid4().hex
        old_versions = []
    else:
        old = self._get_source_locked(source_id)
        if expected != old["registration_revision"]:
            # 작성자가 보았던 카탈로그 버전과 달라지면 현재 판본 위에 조용히 덮어쓰지 않는다.
            raise SourceConflictError("conflict", source_id=source_id, expected_registration_revision=expected,
                                      current_registration_revision=old["registration_revision"])
        old_versions = old["versions"]
        if self._version_count(source_id) >= limits.MAX_VERSIONS:
            raise SourceLimitError("The original version limit was reached.")
    source_version = uuid4().hex
    manifest = {"source_id": source_id, "source_version": source_version, **staged.metadata,
        "source_sha256": staged.source_sha256, "size_bytes": staged.size_bytes, "actor": actor,
        "created_at": datetime.now(timezone.utc).isoformat(), "request_id": request_id, "payload_hash": payload_hash}
    catalog = {"source_id": source_id, "title": manifest["title"], "current_version": source_version,
               "versions": [*old_versions, manifest], "documents": []}
    revision = canonical_json_hash(catalog)
    record = {"tenant": tenant, "user_id": user_id, "request_id": request_id, "payload_hash": payload_hash,
        "operation": operation, "source_id": source_id, "source_version": source_version, "manifest": manifest,
        "registration_revision": revision, "state": "pending_reconcile", "receipt": None, "cleanup_failures": []}
    # 이 intent가 없으면 원본을 공개하지 않는다. 이후 같은 요청에 새 ID를 발급하지 않는다.
    self._write_request(request_path, record)
    try:
        files.write_json(self.store, staged.directory / "manifest.json", manifest)
        destination = self._version_path(source_id, source_version, create=True)
        files.mkdir(self.store, destination.parent)
        if destination.exists():
            raise SourceCorruptError("An immutable original destination already exists.")
        os.rename(staged.directory, destination)
        staged.consumed = True
        # 공개 원본 → 카탈로그 → 최종 영수증 순서다. 이 뒤 오류는 이미 공개한 자료를 보존한다.
        self._write_catalog(self._catalog_path(source_id), catalog)
        receipt = {"request_id": request_id, "source_id": source_id, "source_version": source_version,
            "source_sha256": staged.source_sha256, "size_bytes": staged.size_bytes,
            "registration_revision": revision, "actor": actor, "created_at": manifest["created_at"],
            "storage_status": "stored", "analysis_status": "not_started"}
        complete = {**record, "state": "complete", "receipt": receipt}
        self._write_request(request_path, complete)
        return result(complete)
    except (OSError, ValueError, SourceCorruptError) as error:
        # 의도·실제 공개 근거는 그대로 두고 조회에서 확인한다. 자료 쓰기를 재시도하지 않는다.
        pending = result(record)
        pending["cleanup_failures"].extend(getattr(error, "cleanup_failures", []))
        return pending
