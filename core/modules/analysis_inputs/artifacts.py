"""추출물에 명시 연결한 파일을 기존 불변 묶음·작업 잠금으로 보관한다.

바이너리는 base64 텍스트 구성 파일로 보관해 기존 원자 공개·경로·해시 검사를
재사용한다. 내려줄 때 원래 바이트로 되돌리고 SHA-256을 다시 대조한다.
기존 추출물 manifest나 본문을 수정하지 않고 별도 artifact와 job 이벤트를 만든다.
"""

import base64
from io import BytesIO
from uuid import uuid4
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.analysis_jobs import records
from core.modules.sources import files as source_files
from core.modules.sources.validation import request_key
from . import bundles, files, contracts as limits

MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
MAX_ARTIFACTS = 32
MAX_ARTIFACT_TOTAL = 128 * 1024 * 1024
MAX_STORED_BYTES = 32 * 1024 * 1024


def blob_path(store, job_id, artifact_id):
    """새 파일은 작업별 폴더에 두고, 이미 알려진 옛 ID는 이전 위치에서도 읽는다."""
    path = source_files.checked(store, store.data_dir / "_artifacts" / job_id / artifact_id)
    if path.exists():
        return path
    return source_files.checked(store, store.data_dir / "_artifacts" / artifact_id)


def load_blob(store, job, artifact_id, *, path=None):
    """공개 연결 여부와 별도로 파일 자체의 소유 범위·실제 바이트를 검사한다.

    이 함수의 결과만으로 저장 성공을 판단하지 않는다. 미연결 파일도 용량에서는
    빠뜨리지 않기 위해 사용하며, 공개 성공은 별도의 작업 이벤트로 확인한다.
    """
    manifest, text, parts = files.load(store, path or blob_path(store, job["job_id"], artifact_id),
                                       maximum=MAX_STORED_BYTES)
    try:
        raw = base64.b64decode(parts["base64"], validate=True)
        if (manifest["artifact_id"] != artifact_id
                or any(manifest[key] != job[key] for key in ("tenant", "user_id", "job_id"))
                or type(manifest["size_bytes"]) is not int or not 0 <= manifest["size_bytes"] <= MAX_ARTIFACT_BYTES
                or len(raw) != manifest["size_bytes"] or files.digest(raw) != manifest["sha256"]):
            raise ValueError()
    except (ValueError, KeyError, TypeError) as error:
        raise limits.InputCorruptError("The artifact metadata or bytes are inconsistent.") from error
    return manifest, text, raw


def checked_receipt(record, job, *, request_id=None):
    """완료·미확인 요청 모두의 소유자와 예약 바이트를 검사하고 손상을 건너뛰지 않는다."""
    try:
        if (record["operation"] != "artifact_upload"
                or any(record[key] != job[key] for key in ("tenant", "user_id", "job_id"))
                or record["state"] not in {"complete", "pending_reconcile"}):
            raise ValueError()
        limits.revision(record["payload_hash"])
        value = record["result"]
        for key in ("job_id", "run_id", "request_id", "artifact_id", "extraction_id"):
            limits.identifier(value[key])
        for key in ("job_revision", "artifact_revision", "sha256"):
            limits.revision(value[key])
        if (value["job_id"] != job["job_id"] or (request_id is not None and value["request_id"] != request_id)
                or type(value["size_bytes"]) is not int or not 0 <= value["size_bytes"] <= MAX_ARTIFACT_BYTES):
            raise ValueError()
        submitted = record.get("request")
        if submitted is not None and (type(submitted) is not dict
                or canonical_json_hash(submitted) != record["payload_hash"]
                or any(submitted[key] != value[key] for key in (
                    "job_id", "run_id", "request_id", "extraction_id", "sha256", "size_bytes"))):
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError) as error:
        raise limits.InputCorruptError("The artifact request receipt is inconsistent.") from error


def reserved_capacity(store, jobs, job):
    """완료·미확인 영수증과 미연결 파일도 예약량에 포함해 실패로 한도를 우회하지 못하게 한다."""
    reserved = {}
    directory = jobs.job_root(job["job_id"]) / "artifact_requests"
    for name in source_files.entries(store, directory, maximum=MAX_ARTIFACTS + 1):
        record = records.read(jobs, directory / name)
        value = checked_receipt(record, job)
        if name != request_key(job["tenant"], job["user_id"], value["request_id"]) + ".json":
            raise limits.InputCorruptError("The artifact request index is inconsistent.")
        if value["artifact_id"] in reserved:
            raise limits.InputCorruptError("Artifact requests must reserve distinct IDs.")
        reserved[value["artifact_id"]] = value["size_bytes"]
    # 새 구조에서는 본인 작업의 폴더만 살핀다. 다른 사용자의 파일을 먼저 읽고 숨기지 않는다.
    own = store.data_dir / "_artifacts" / job["job_id"]
    for name in source_files.entries(store, own, maximum=MAX_ARTIFACTS + 1):
        try:
            limits.identifier(name)
            manifest, _, _ = load_blob(store, job, name, path=own / name)
        except (ValueError, FileNotFoundError) as error:
            # 중간 파일/손상 파일의 크기를 모르면 새 쓰기를 멈추며 원래 파일을 지우지 않는다.
            raise limits.InputCorruptError("An incomplete artifact reservation requires inspection.") from error
        if name in reserved and reserved[name] != manifest["size_bytes"]:
            raise limits.InputCorruptError("The reserved artifact size differs from its file.")
        reserved[name] = manifest["size_bytes"]
    for event in job["events"]:
        value = event["details"]
        if event["kind"] != "reported" or value.get("operation") != "artifact_uploaded":
            continue
        aid, size = value.get("artifact_id"), value.get("size_bytes")
        limits.identifier(aid)
        if type(size) is not int or not 0 <= size <= MAX_ARTIFACT_BYTES:
            raise limits.InputCorruptError("The published artifact size is inconsistent.")
        if aid in reserved and reserved[aid] != size:
            raise limits.InputCorruptError("The published artifact differs from its reservation.")
        # 이전 구조의 알려진 공개 ID도 같은 예약 집합에 포함한다.
        reserved[aid] = size
    return len(reserved), sum(reserved.values())


def request_receipt(store, jobs, *, tenant, user_id, job_id, request_id):
    """쓰기 권한·현재 run·lease 없이 본인의 정확한 업로드 영수증만 다시 읽는다."""
    limits.identifier(request_id)
    with jobs.sources._coordination_lock():
        job = records.owned_state(jobs, job_id, tenant, user_id)
        path = jobs.job_root(job_id) / "artifact_requests" / (request_key(tenant, user_id, request_id) + ".json")
        record = records.read(jobs, path)
        value = checked_receipt(record, job, request_id=request_id)
        published = any(ref["artifact_id"] == value["artifact_id"]
                        for ref in artifact_refs(job, value["extraction_id"]))
        if published:
            manifest, stream = artifact(store, job, value["extraction_id"], value["artifact_id"])
            stream.close()
            if (manifest["artifact_revision"] != value["artifact_revision"]
                    or any(manifest[key] != value[key] for key in ("request_id", "sha256", "size_bytes"))):
                raise limits.InputCorruptError("The artifact receipt differs from its published file.")
        elif record["state"] == "complete":
            raise limits.InputCorruptError("The completed artifact has no published extraction link.")
        return {**value, "state": "complete" if published else "pending_reconcile", "published": published,
            "payload_hash": record["payload_hash"], "request": record.get("request"),
            "replayed": True, "cleanup_failures": []}


def extraction(store, jobs, *, tenant, user_id, job_id, extraction_id):
    """작업 소유권을 먼저 확인한 뒤 당시 실행에 연결된 불변 추출물을 읽는다.

    읽기는 현재 lease를 요구하지 않는다. 작업이 취소되거나 새 run으로 넘어가도
    이미 공개된 자기 추출물과 당시 원본/실행 계보를 다시 확인할 수 있다.
    """
    limits.identifier(extraction_id)
    job = records.owned_state(jobs, job_id, tenant, user_id)
    linked = [event["details"] for event in job["events"]
        if event["kind"] == "reported" and event["details"].get("operation") == "extraction_submitted"
        and event["details"].get("extraction_id") == extraction_id]
    if not linked:
        raise FileNotFoundError()
    manifest, text, parts = files.load(store, store.data_dir / "_extractions" / extraction_id,
                                       maximum=16 * 1024 * 1024)
    try:
        if (manifest["extraction_id"] != extraction_id or manifest["job_id"] != job_id
                or manifest["tenant"] != tenant or manifest["user_id"] != user_id
                or manifest["source_ref"] != job["source_ref"]
                or not any(value.get("run_id") == manifest["run_id"]
                    and value.get("extraction_revision") == files.digest(text.encode()) for value in linked)
                or files.digest(parts["content"].encode()) != manifest["content_sha256"]
                or len(parts["content"].encode()) != manifest["content_size_bytes"]):
            raise ValueError()
    except (ValueError, KeyError, TypeError) as error:
        raise limits.InputCorruptError("The extraction source, owner or hash is inconsistent.") from error
    return job, {**manifest, "extraction_revision": files.digest(text.encode())}, parts["content"]


def artifact(store, job, extraction_id, artifact_id):
    """공개 추출물에 연결된 파일만 읽는다. staging 파일이나 다른 추출물은 내보내지 않는다."""
    limits.identifier(artifact_id)
    linked = [event["details"] for event in job["events"]
        if event["kind"] == "reported" and event["details"].get("operation") == "artifact_uploaded"
        and event["details"].get("artifact_id") == artifact_id
        and event["details"].get("extraction_id") == extraction_id]
    if not linked:
        raise FileNotFoundError()
    manifest, text, raw = load_blob(store, job, artifact_id)
    try:
        if (manifest["artifact_id"] != artifact_id or manifest["extraction_id"] != extraction_id
                or any(manifest[key] != job[key] for key in ("tenant", "user_id", "job_id"))
                or len(raw) != manifest["size_bytes"] or len(raw) > MAX_ARTIFACT_BYTES
                or files.digest(raw) != manifest["sha256"]
                or not any(value.get("artifact_revision") == files.digest(text.encode())
                           and value.get("run_id") == manifest["run_id"] for value in linked)):
            raise ValueError()
    except (ValueError, KeyError, TypeError) as error:
        raise limits.InputCorruptError("The artifact metadata or bytes are inconsistent.") from error
    return {**manifest, "artifact_revision": files.digest(text.encode())}, BytesIO(raw)


def artifact_refs(job, extraction_id):
    """본문 manifest와 별도로, 이 작업이 명시 연결한 산출물의 참조만 반환한다."""
    return [{key: event["details"][key] for key in ("artifact_id", "artifact_revision", "sha256", "size_bytes")}
        for event in job["events"] if event["kind"] == "reported"
        and event["details"].get("operation") == "artifact_uploaded"
        and event["details"].get("extraction_id") == extraction_id]


def submit(inputs, job_id, *, tenant, user_id, run_id, expected_job_revision, bundle_id,
           bundle_revision, extraction_id, extraction_revision, request_id, filename,
           media_type, content_sha256, stream, authorize):
    """파일을 한도 안에서 읽고 같은 job/run/입력/추출 기준에서 한 번만 공개한다."""
    for value in (job_id, run_id, bundle_id, extraction_id, request_id):
        limits.identifier(value)
    for value in (expected_job_revision, bundle_revision, extraction_revision, content_sha256):
        limits.revision(value)
    if (not filename or len(filename) > 255 or any(c in filename for c in ("/", "\\", ":"))
            or any(ord(c) < 32 for c in filename) or len(media_type) > 100):
        raise limits.InputValidationError("Use a display basename and bounded media type.")
    raw = stream.read(MAX_ARTIFACT_BYTES + 1)
    if len(raw) > MAX_ARTIFACT_BYTES:
        raise limits.InputLimitError("An artifact exceeds twenty MiB.")
    if files.digest(raw) != content_sha256:
        raise limits.InputValidationError("The artifact bytes differ from their SHA-256.")
    metadata = {"job_id": job_id, "run_id": run_id, "expected_job_revision": expected_job_revision,
        "bundle_id": bundle_id, "bundle_revision": bundle_revision,
        "extraction_id": extraction_id, "extraction_revision": extraction_revision, "filename": filename,
        "media_type": media_type, "sha256": content_sha256, "size_bytes": len(raw), "request_id": request_id}
    fingerprint = canonical_json_hash(metadata)
    jobs, store = inputs.jobs, inputs.store
    with jobs.sources._coordination_lock():
        # 조회 재시도와 달리 새 공개는 살아 있는 실행·취소·원본 기준까지 검사한다.
        job, actor = bundles.opened(inputs, job_id, tenant, user_id, run_id, authorize, "source_write")
        directory = jobs.job_root(job_id) / "artifact_requests"
        receipt_path = directory / (request_key(tenant, user_id, request_id) + ".json")
        try:
            prior = records.read(jobs, receipt_path)
        except FileNotFoundError:
            prior = None
        if prior is not None:
            if any(prior.get(key) != expected for key, expected in (
                    ("operation", "artifact_upload"), ("tenant", tenant), ("user_id", user_id), ("job_id", job_id))):
                raise limits.InputCorruptError("The artifact receipt owner or operation is inconsistent.")
            if prior.get("state") not in {"complete", "pending_reconcile"} or type(prior.get("result")) is not dict:
                raise limits.InputCorruptError("The artifact receipt state or result is inconsistent.")
            if prior.get("payload_hash") != fingerprint:
                raise limits.InputConflictError("request_conflict", request_id=request_id)
            result = prior["result"]
            if any(value.get("artifact_id") == result["artifact_id"] for value in artifact_refs(job, extraction_id)):
                manifest, opened = artifact(store, job, extraction_id, result["artifact_id"])
                opened.close()
                if any(manifest.get(key) != expected for key, expected in metadata.items()):
                    raise limits.InputCorruptError("The artifact receipt differs from its immutable file.")
                if any(result.get(key) != manifest.get(key) for key in (
                        "job_id", "run_id", "request_id", "artifact_id", "extraction_id", "sha256", "size_bytes")):
                    raise limits.InputCorruptError("The artifact receipt differs from its immutable metadata.")
                return {**result, "state": "complete", "replayed": True, "cleanup_failures": []}
            if prior["state"] == "complete":
                raise limits.InputCorruptError("The completed artifact has no published extraction link.")
            return {**result, "state": "pending_reconcile", "replayed": True, "cleanup_failures": []}
        if canonical_json_hash(job) != expected_job_revision:
            raise limits.InputConflictError("conflict", job_id=job_id)
        source_manifest, _, _ = bundles.load_locked(inputs, job, bundle_id, bundle_revision)
        if source_manifest["stage"] != "read_source":
            raise limits.InputValidationError("Artifacts use the read_source input basis.")
        bundles.validate_current(inputs, job, source_manifest, actor)
        _, extracted, _ = extraction(store, jobs, tenant=tenant, user_id=user_id,
                                    job_id=job_id, extraction_id=extraction_id)
        if extracted["run_id"] != run_id or extracted["extraction_revision"] != extraction_revision:
            raise limits.InputConflictError("extraction_basis_changed")
        reserved_count, reserved_bytes = reserved_capacity(store, jobs, job)
        if reserved_count >= MAX_ARTIFACTS or reserved_bytes + len(raw) > MAX_ARTIFACT_TOTAL:
            raise limits.InputLimitError("The job artifact count or total byte limit was reached.")
        artifact_id = uuid4().hex
        parts = {"base64": base64.b64encode(raw).decode("ascii")}
        manifest = {"schema_version": 1, **metadata, "artifact_id": artifact_id, "tenant": tenant,
            "user_id": user_id, "actor": actor, "created_at": jobs._now().isoformat(),
            "components": files.descriptors(parts)}
        revision = files.digest(canonical_json_bytes(manifest))
        candidate = bundles.after(inputs, job, actor, "artifact_uploaded", artifact_id=artifact_id,
            artifact_revision=revision, extraction_id=extraction_id, sha256=content_sha256, size_bytes=len(raw))
        result = {"job_id": job_id, "run_id": run_id, "request_id": request_id,
            "job_revision": canonical_json_hash(candidate), "artifact_id": artifact_id,
            "artifact_revision": revision, "extraction_id": extraction_id,
            "sha256": content_sha256, "size_bytes": len(raw)}
        record = {"operation": "artifact_upload", "tenant": tenant, "user_id": user_id,
            "job_id": job_id, "payload_hash": fingerprint, "request": metadata,
            "state": "pending_reconcile", "result": result}
        # 영수증·새 폴더·job 연결·완료 순서다. 중간 실패는 보존 미확인으로 남긴다.
        jobs._write(receipt_path, record)
        try:
            records.authorized(lambda: authorize("source_write"), tenant, user_id)
            files.publish(store, store.data_dir / "_artifacts" / job_id / artifact_id,
                          manifest, parts, maximum=MAX_STORED_BYTES)
            records.authorized(lambda: authorize("source_write"), tenant, user_id)
            jobs._write(records.state_path(jobs, job_id), candidate)
            jobs._write(receipt_path, {**record, "state": "complete"})
            return {**result, "state": "complete", "replayed": False, "cleanup_failures": []}
        except OSError:
            return {**result, "state": "pending_reconcile", "replayed": False, "cleanup_failures": []}
