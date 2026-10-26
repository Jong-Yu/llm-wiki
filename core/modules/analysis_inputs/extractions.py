"""원본문자 읽기 결과를 고정 입력의 실제 후속 자료로 불변 보관한다."""

# read_source 입력을 읽어 만든 문자를 원본/실행/입력 hash에 연결해 보관한다.
# 이 추출물은 prepare_wiki의 입력이다. 문자 제출 성공이 위키·그래프 생성이나 의미 승인은 아니다.

from uuid import uuid4

from core.common.json_codec import canonical_json_hash
from core.modules.analysis_jobs import records
from core.modules.sources import files as source_files
from core.modules.sources.validation import request_key
from . import bundles, capture, contracts as limits, files


def load_extraction(self, job, extraction_id):
    """현재 run에 연결된 불변 문자 추출물만 읽고 원본·입력 계보를 대조한다."""
    limits.identifier(extraction_id)
    if not bundles.linked(job, "extraction_submitted", extraction_id=extraction_id):
        raise limits.InputConflictError("extraction_unavailable", extraction_id=extraction_id)
    manifest, text, components = files.load(self.store, self.store.data_dir / "_extractions" / extraction_id,
                                            maximum=16 * 1024 * 1024)
    try:
        if (manifest["job_id"] != job["job_id"] or manifest["run_id"] != job["run_id"]
                or manifest["tenant"] != job["tenant"] or manifest["user_id"] != job["user_id"]
                or manifest["source_ref"] != job["source_ref"] or manifest["extraction_id"] != extraction_id
                or files.digest(components["content"].encode()) != manifest["content_sha256"]):
            raise ValueError()
    except (ValueError, TypeError, KeyError) as error:
        raise limits.InputCorruptError("The extraction belongs to a different source or run.") from error
    return {"manifest": {**manifest, "extraction_revision": files.digest(text.encode())},
            "manifest_text": text, "content": components["content"]}


def result(record, *, replayed=False):
    # 저장된 결과에 요청 상태와 재전송 여부만 덧붙여 새 응답 dict를 만든다.
    value = record["result"]
    return {**value, "state": record["state"], "replayed": replayed, "cleanup_failures": []}


def checked_request(self, record, job, request_id, payload_hash):
    # 같은 요청의 재전송을 처리하기 전에 소속·지문·실제 추출물·작업 이벤트까지 대조한다.
    try:
        if (type(record) is not dict or set(record) != {"operation", "tenant", "user_id", "job_id", "run_id",
                "request_id", "payload_hash", "state", "result"}
                or record["operation"] != "source_extraction_submit" or record["request_id"] != request_id
                or record["state"] not in {"complete", "pending_reconcile"}
                or any(record[key] != job[key] for key in ("tenant", "user_id", "job_id", "run_id"))):
            raise ValueError()
        limits.revision(record["payload_hash"])
        value = record["result"]
        expected = {"job_id", "run_id", "job_revision", "extraction_id", "extraction_revision", "content_sha256",
                    "content_size_bytes", "complete", "warnings", "omissions"}
        if type(value) is not dict or set(value) != expected or type(value["complete"]) is not bool:
            raise ValueError()
        limits.identifier(value["extraction_id"])
        for name in ("job_revision", "extraction_revision", "content_sha256"):
            limits.revision(value[name])
        if (value["job_id"] != job["job_id"] or value["run_id"] != job["run_id"]
                or type(value["content_size_bytes"]) is not int
                or not 0 <= value["content_size_bytes"] <= limits.MAX_EXTRACTION_BYTES):
            raise ValueError()
        limits.text_list(value["warnings"]); limits.text_list(value["omissions"])
    except (ValueError, TypeError, KeyError) as error:
        raise limits.InputCorruptError("The extraction request record is inconsistent.") from error
    if record["payload_hash"] != payload_hash:
        # 같은 request_id로 내용을 바꿔 보낸 것은 재조회가 아니라 충돌이다.
        raise limits.InputConflictError("request_conflict", request_id=request_id)
    has_event = bundles.linked(job, "extraction_submitted", extraction_id=value["extraction_id"])
    # 영수증만 놓친 경우 실제 추출물/연결 근거로 읽기 결과를 확인하되 파일은 다시 쓰지 않는다.
    if has_event:
        loaded = load_extraction(self, job, value["extraction_id"])["manifest"]
        if any(loaded[key] != value[key] for key in ("extraction_id", "extraction_revision", "content_sha256",
                                                    "content_size_bytes", "complete", "warnings", "omissions")):
            raise limits.InputCorruptError("The extraction receipt differs from its immutable result.")
        return {**record, "state": "complete"}
    if record["state"] == "complete":
        raise limits.InputCorruptError("The completed extraction receipt has no job event.")
    return record


def submit(self, job_id, *, tenant, user_id, run_id, expected_job_revision, bundle_id, bundle_revision,
           request_id, content, method, authorize, warnings=None, omissions=None, scope=None):
    """같은 요청의 재전송은 기존 결과로 응답하고, 새 제출만 작업 이력에 연결한다."""
    limits.identifier(request_id)
    if type(content) is not str or method not in {"verbatim", "ai_reconstruction"}:
        raise limits.InputValidationError("Use UTF-8 text and an explicit extraction method.")
    try:
        raw_content = content.encode("utf-8")
    except UnicodeError as error:
        raise limits.InputValidationError("The extraction must be valid UTF-8.") from error
    if len(raw_content) > limits.MAX_EXTRACTION_BYTES:
        raise limits.InputLimitError("The extraction text exceeds four MiB.")
    warnings, omissions = limits.text_list(warnings or []), limits.text_list(omissions or [])
    scope = scope or {"selection": "whole_original", "unread_ranges": []}
    if (type(scope) is not dict or set(scope) != {"selection", "unread_ranges"}
            or scope["selection"] != "whole_original"):
        raise limits.InputValidationError("This extraction must report its whole-original scope.")
    unread = limits.text_list(scope["unread_ranges"])
    payload = {"job_id": job_id, "run_id": run_id, "bundle_id": bundle_id, "bundle_revision": bundle_revision,
        "request_id": request_id, "content": content, "method": method, "scope": scope,
        "warnings": warnings, "omissions": omissions}
    if len(capture.encoded(payload).encode("utf-8")) > limits.MAX_BUNDLE_BYTES:
        raise limits.InputLimitError("The logical extraction submission exceeds eight MiB.")
    payload_hash = canonical_json_hash(payload)
    directory = self.jobs.jobs_dir / job_id / "extraction_requests"
    path = directory / (request_key(tenant, user_id, request_id) + ".json")
    with self.jobs.sources._coordination_lock():
        # 재전송은 현재 권한/실행 범위를 먼저 확인하되 자신의 성공한 job advance를 허용한다.
        job, actor = bundles.opened(self, job_id, tenant, user_id, run_id, authorize, "source_write")
        try:
            prior = records.read(self.jobs, path)
        except FileNotFoundError:
            prior = None
        if prior is not None:
            return result(checked_request(self, prior, job, request_id, payload_hash), replayed=True)
        if canonical_json_hash(job) != expected_job_revision:
            raise limits.InputConflictError("conflict", job_id=job_id)
        manifest, _, _ = bundles.load_locked(self, job, bundle_id, bundle_revision)
        if manifest["stage"] != "read_source":
            raise limits.InputValidationError("Submit source text only from a read_source input.")
        bundles.validate_current(self, job, manifest, actor)
        if not manifest["input_ready"]:
            raise limits.InputConflictError("input_incomplete")
        names = source_files.entries(self.store, directory, maximum=limits.MAX_EXTRACTIONS + 1)
        if len(names) >= limits.MAX_EXTRACTIONS:
            raise limits.InputLimitError("The job extraction count limit was reached.")
        used = 0
        for name in names:
            prior_record = records.read(self.jobs, directory / name)
            used += prior_record["result"]["content_size_bytes"]
        if used + len(raw_content) > 64 * 1024 * 1024:
            raise limits.InputLimitError("The job extraction total exceeds sixty-four MiB.")
        extraction_id = uuid4().hex
        complete = not (warnings or omissions or unread)
        components = {"content": content, "submission": capture.encoded(payload)}
        extraction_manifest = {"schema_version": 1, "extraction_id": extraction_id, "job_id": job_id,
            "run_id": run_id, "tenant": tenant, "user_id": user_id, "actor": actor,
            "created_at": self.jobs._now().isoformat(), "source_ref": job["source_ref"],
            "read_source_bundle": {"bundle_id": bundle_id, "bundle_revision": bundle_revision},
            "request_id": request_id, "payload_hash": payload_hash, "content_sha256": files.digest(raw_content),
            "content_size_bytes": len(raw_content), "method": method, "scope": scope,
            "warnings": warnings, "omissions": omissions, "complete": complete,
            "components": files.descriptors(components)}
        revision = files.digest(capture.encoded(extraction_manifest).encode())
        candidate = bundles.after(self, job, actor, "extraction_submitted", extraction_id=extraction_id,
                                  extraction_revision=revision)
        submitted = {"job_id": job_id, "run_id": run_id, "job_revision": canonical_json_hash(candidate),
            "extraction_id": extraction_id, "extraction_revision": revision,
            "content_sha256": files.digest(raw_content), "content_size_bytes": len(raw_content),
            "complete": complete, "warnings": warnings, "omissions": omissions}
        record = {"operation": "source_extraction_submit", "tenant": tenant, "user_id": user_id,
            "job_id": job_id, "run_id": run_id, "request_id": request_id, "payload_hash": payload_hash,
            "state": "pending_reconcile", "result": submitted}
        # 접수 근거→불변 추출물→작업 연결→완료 영수증 순서다. 중간 실패도 근거를 남긴다.
        self.jobs._write(path, record)
        try:
            files.publish(self.store, self.store.data_dir / "_extractions" / extraction_id,
                          extraction_manifest, components, maximum=16 * 1024 * 1024)
            self.jobs._write(records.state_path(self.jobs, job_id), candidate)
            finished = {**record, "state": "complete"}
            self.jobs._write(path, finished)
            return result(finished)
        except OSError:
            # 공개한 자료를 지우거나 다시 제출하지 않고 기존 요청의 확인 대상으로 돌려준다.
            return result(record)
