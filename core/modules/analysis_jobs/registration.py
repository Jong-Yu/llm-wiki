"""기본 등록: 기존 원본/변환 참조로 보존형 Markdown 한 개를 만든다.

독립 계획이나 파생 TXT 원본을 만들지 않는다. 변환 보고는 인용 위치와
미독/경고를 보존하며 실제 저장 판본은 결과 영수증이 확인된 뒤 연결한다.
"""
from hashlib import sha256

from core.common.storage_layout import source_version_root
from core.modules.sources import files
from .contracts import JobValidationError, JobCorruptError, identifier, revision


def registration(job):
    value = job["events"][0]["details"].get("registration")
    if value is not None:
        validate(value)
    return value


def validate(value):
    if (type(value) is not dict or set(value) != {"mode", "title", "conversion_ref"}
            or value["mode"] != "preserve" or type(value["title"]) is not str
            or not value["title"].strip() or len(value["title"]) > 200):
        raise JobValidationError("A preservation registration needs a bounded title.")
    ref = value["conversion_ref"]
    if ref is not None:
        if type(ref) is not dict or set(ref) != {"conversion_id", "conversion_revision"}:
            raise JobValidationError("A complete conversion reference is required.")
        identifier(ref["conversion_id"]); revision(ref["conversion_revision"])


def original_path(sources, source_id, source_version):
    """기존/새 판본 둘 중 하나만 읽는다. 겹치는 자료는 자동 선택하지 않는다."""
    new = source_version_root(sources.store.data_dir, source_id, source_version)
    old = sources.sources_dir / source_id / source_version
    if files.checked(sources.store, new).exists():
        if files.checked(sources.store, old).exists():
            raise JobCorruptError("Both legacy and current source versions exist.")
        return new / "original"
    return old / "original"


def create(jobs, *, tenant, user_id, request_id, source_ref, document, title, authorize, conversion_ref=None):
    if type(source_ref) is not dict or set(source_ref) != {
            "source_id", "source_version", "source_sha256", "registration_revision"}:
        raise JobValidationError("A complete original source reference is required.")
    return jobs.create(tenant=tenant, user_id=user_id, request_id=request_id,
        source_id=source_ref["source_id"], source_version=source_ref["source_version"],
        source_sha256=source_ref["source_sha256"], expected_registration_revision=source_ref["registration_revision"],
        targets=[document], outputs=["wiki", "ontology"], authorize=authorize,
        registration={"mode": "preserve", "title": title, "conversion_ref": conversion_ref})


def materialize(jobs, job, actor):
    """호출자가 조정 잠금을 보유한다. 고정 원본/변환을 읽되 사본을 저장하지 않는다."""
    from core.modules.documents.metadata import render_document
    value = registration(job)
    if value is None:
        raise JobValidationError("The job is not a preservation registration.")
    source = job["source_ref"]
    reference = {key: source[key] for key in ("source_id", "source_version", "source_sha256", "registration_revision")}
    catalog = jobs.sources._get_source_locked(source["source_id"])
    original = next(item for item in catalog["versions"] if item["source_version"] == source["source_version"])
    if value["conversion_ref"] is None:
        if original["format"] not in {"txt", "md"}:
            raise JobValidationError("A binary original needs its immutable conversion reference.")
        with files.verify_original(jobs.store, original_path(jobs.sources, source["source_id"], source["source_version"]), original) as stream:
            body = stream.read().decode("utf-8")
        report = {"method": "verbatim", "complete": True, "unread_ranges": [], "warnings": [],
            "coverage": "whole_original", "original_coverage": "byte_verified",
            "units": [{"unit_id": "original", "location": {"kind": "whole"}}]}
    else:
        from core.modules.analysis_plans.store import PlanStore
        ref = value["conversion_ref"]
        manifest, _, parts = PlanStore(jobs.store, actor)._load_locked("conversions", ref["conversion_id"], ref["conversion_revision"])
        if manifest["source_ref"] != reference:
            raise JobValidationError("The conversion belongs to a different original version.")
        body = "\n\n".join(parts[unit["unit_id"]] for unit in manifest["units"])
        report = {key: manifest[key] for key in ("method", "complete", "unread_ranges", "warnings",
                    "coverage", "original_coverage", "units")}
    content = render_document(body, title=value["title"], document_id=job["job_id"],
                              source={"id": source["source_id"], "version": source["source_version"]})
    if len(content.encode("utf-8")) > 1024 * 1024:
        raise JobValidationError("The preserved Markdown exceeds the document byte limit; it was not truncated.")
    return content, {"schema_version": 1, "mode": "preserve", "source_ref": reference,
        "conversion_ref": value["conversion_ref"], "author": "AI", "actor": job["actor"],
        "semantic_validation": "not_run", "body_sha256": sha256(body.encode()).hexdigest(),
        "planned_document_revision": sha256(content.encode()).hexdigest(), "first_markdown": None, **report}


def confirm(jobs, job, receipt):
    """저장 함수의 성공 증거에서만 최초 MD 판본을 연결한다. 본문을 다시 저장하지 않는다."""
    from . import records
    path = jobs.job_root(job["job_id"]) / "conversion.json"
    report = records.read(jobs, path)
    reference = {"document": receipt["document"], "revision": receipt["source_revision"],
                 "body_revision": report["body_sha256"], "document_id": job["job_id"]}
    if report["first_markdown"] is not None and report["first_markdown"] != reference:
        raise JobCorruptError("The first converted Markdown must not be replaced.")
    if report["planned_document_revision"] != reference["revision"]:
        raise JobCorruptError("The saved Markdown differs from the preservation input.")
    if report["first_markdown"] is None:
        jobs._write(path, {**report, "first_markdown": reference})
