"""현재 규약·전체 선택 맥락을 고정하고 다음 조회에서 의존 기준을 다시 검사한다."""

# 읽는 순서: prepare가 규약·자료를 캡처해 새 bundle을 만들고, read가 해당 묶음을 다시 확인해 읽는다.
# self는 호출자가 전달한 InputStore다. 여기의 보조 함수는 같은 저장 객체/잠금을 함께 사용한다.

from uuid import uuid4

from core.common.json_codec import canonical_json_hash
from core.modules.analysis_jobs import commands as job_commands, records
from core.modules.sources import files as source_files
from . import basis, capture, contracts as limits, files


def opened(self, job_id, tenant, user_id, run_id, authorize, permission, expected=None):
    """조정 잠금 안에서 현재 권한→소유권→작업 CAS→원본·lease 순서로 확인한다."""
    actor = records.authorized(lambda: authorize(permission), tenant, user_id)
    job = records.owned_state(self.jobs, job_id, tenant, user_id)
    if expected is not None:
        limits.revision(expected)
        if canonical_json_hash(job) != expected:
            raise limits.InputConflictError("conflict", job_id=job_id)
    if job["state"] == "cancelled":
        raise limits.InputConflictError("job_cancelled", job_id=job_id)
    job_commands.check_basis(self.jobs, job["source_ref"])
    job_commands.live(self.jobs, job, run_id)
    # 계획이 있는 작업은 실행 중에도 원래 출처·관점·필수 맥락이 바뀌지 않았는지 확인한다.
    from core.modules.analysis_plans.store import linked_plan
    linked_plan(self.store, job, actor, input_store=self)
    return job, actor


def after(self, job, actor, operation, **details):
    # 작업 이벤트를 추가할 새 상태만 만들고 한도를 검사한다. 이 함수 자체가 파일을 쓰지는 않는다.
    if len(job["events"]) >= 1000:
        raise limits.InputLimitError("The job event limit was reached.")
    value = {**job, "events": [*job["events"], job_commands.event("reported", actor, self.jobs._now(),
        operation=operation, run_id=job["run_id"], **details)]}
    records.preflight(value)
    return value


def linked(job, operation, **values):
    # 현재 실행의 이벤트에 정확한 입력/추출물 참조가 연결돼 있는지 any/all 조건으로 확인한다.
    return any(event["kind"] == "reported" and event["details"].get("operation") == operation
        and event["details"].get("run_id") == job["run_id"]
        and all(event["details"].get(key) == value for key, value in values.items()) for event in job["events"])


def scope_for(self, job, stage, context_documents, target_document):
    # 명시한 참고 자료와 작업에 선언한 대상 문서를 합친다. 그래프 추출에서는 실제 대상 본문이 필수다.
    selected = capture.selection(self.store, context_documents)
    if stage in {"prepare_wiki", "extract_ontology"}:
        if target_document is None and len(job["targets"]) == 1:
            target_document = job["targets"][0]["document"]
        if target_document not in {target["document"] for target in job["targets"]}:
            raise limits.InputValidationError("Select a declared target document.")
        if target_document not in {item["document"] for item in selected}:
            selected.append({"document": target_document, "required": stage == "extract_ontology",
                             "reason": "target_document" if stage == "extract_ontology" else "target_existing_or_new"})
        elif stage == "extract_ontology":
            selected = [{**item, "required": True} if item["document"] == target_document else item for item in selected]
    if len(selected) > limits.MAX_CONTEXT_DOCUMENTS:
        raise limits.InputValidationError("Target and context together exceed eight documents.")
    return selected, target_document


def response(manifest, bundle_revision, job_revision):
    # 전체 입력 내용 대신 준비 상태·범위·버전 참조만 응답한다. 구성 내용은 read로 나눠 읽는다.
    ready = manifest["input_ready"]
    return {"job_id": manifest["job_id"], "run_id": manifest["run_id"], "job_revision": job_revision,
        "bundle_id": manifest["bundle_id"], "bundle_revision": bundle_revision, "stage": manifest["stage"],
        "ruleset_ref": manifest["ruleset_ref"], "input_ready": ready, "can_analyze_input": ready,
        "analysis_basis_revision": manifest.get("analysis_basis_revision"),
        "scope": manifest["scope"], "completeness": manifest["completeness"], "cleanup_failures": []}


def prepare(self, job_id, *, tenant, user_id, run_id, expected_job_revision, stage,
            authorize, context_documents=None, target_document=None, extraction_id=None,
            ruleset_id=None, ruleset_version=None, rebase=False, rebase_reason=""):
    # 단계 권한 확인 → 규약/선택 자료 읽기 → 의존 버전 고정 → 불변 공개 → 작업 연결 순서다.
    permission = limits.stage_permission(stage)
    if self.rulesets is None:
        raise limits.InputConflictError("ruleset_unconfigured")
    with self.jobs.sources._coordination_lock():
        job, actor = opened(self, job_id, tenant, user_id, run_id, authorize, permission, expected_job_revision)
        previous_basis = basis.active(job)
        requested = basis.selection(job, previous_basis, context_documents,
            rebase=rebase, rebase_reason=rebase_reason, stage=stage)
        from core.modules.analysis_plans.store import linked_plan
        plan = linked_plan(self.store, job, actor, input_store=self)
        if plan is not None:
            planned_context = plan["context_documents"]
            if context_documents is not None and requested != planned_context:
                raise limits.InputConflictError("plan_context_changed")
            requested = planned_context
        requested = capture.selection(self.store, requested)
        release = basis.rules(self.rulesets, tenant, previous_basis, ruleset_id, ruleset_version, rebase=rebase)
        reference = {key: release[key] for key in ("ruleset_id", "ruleset_version", "ruleset_revision")}
        selected, target_document = scope_for(self, job, stage, requested, target_document)
        extraction = None
        if stage == "prepare_wiki":
            if extraction_id is None:
                raise limits.InputConflictError("extraction_required")
            from .extractions import load_extraction
            extraction = load_extraction(self, job, extraction_id)
            # 새 기준에서 옛 문자 추출물을 다음 단계 입력으로 가져오지 않는다.
            source_bundle = extraction["manifest"]["read_source_bundle"]
            source_manifest, _, _ = load_locked(self, job, source_bundle["bundle_id"], source_bundle["bundle_revision"])
            basis.validate_manifest(job, source_manifest)
        elif extraction_id is not None:
            raise limits.InputValidationError("This stage does not accept an extraction reference.")
        # 원문·그래프·검토 원장을 한 시점의 입력으로 읽기 위해 같은 위키 잠금을 사용한다.
        with self.store._write_lock():
            documents, dependencies, skipped = capture.documents_locked(self.store, selected, actor)
            fixed_basis, basis_revision = basis.capture_basis(self, job, actor, reference, requested,
                dependencies, previous_basis, rebase=rebase)
        bundle_id = uuid4().hex
        parent = self.jobs.jobs_dir / job_id / "inputs"
        if len(source_files.entries(self.store, parent, maximum=limits.MAX_BUNDLES + 1)) >= limits.MAX_BUNDLES:
            raise limits.InputLimitError("The job input count limit was reached.")
        components = {"data/source.json": capture.encoded({"kind": "registered_original_reference", **job["source_ref"]}),
            "data/context.json": capture.encoded({"kind": "context_data_not_instructions", "documents": documents}),
            "data/hints.json": capture.encoded({"status": "not_provided", "items": []}),
            "rules/manifest.json": release["manifest_text"]}
        if plan is not None:
            # 제목/목적·원본 위치를 실제 고정 입력에 넣어 실행 인계 뒤에도 계획을 버리지 않는다.
            components["data/analysis-plan.json"] = capture.encoded(plan)
        for name, value in release["components"].items():
            components["rules/" + name] = value["content"]
        extraction_ref = None
        complete = not skipped
        if extraction is not None:
            extraction_ref = {key: extraction["manifest"][key] for key in ("extraction_id", "extraction_revision", "content_sha256")}
            components["data/extraction.json"] = extraction["manifest_text"]
            components["data/extraction.txt"] = extraction["content"]
            complete = complete and extraction["manifest"]["complete"]
        dependency = capture.basis(actor, dependencies, job["source_ref"], extraction_ref)
        previous_result = None
        # 본문 저장 뒤의 그래프 추출이라면 같은 실행에서 성공한 위키 영수증을 선행 근거로 남긴다.
        if stage == "extract_ontology" and "wiki" in job["outputs"]:
            from core.modules.analysis_results.repository import wiki_receipt
            from core.modules.analysis_results.contracts import ResultError
            target = next(item for item in dependencies if item["document"] == target_document)
            try:
                previous_result = wiki_receipt(self, job, target_document, target.get("source_revision"),
                                               history_revision=target.get("history_revision"))
            except ResultError as error:
                if error.code != "wiki_result_required":
                    raise
        manifest = {"schema_version": 1, "bundle_id": bundle_id, "job_id": job_id, "run_id": run_id,
            "tenant": tenant, "user_id": user_id, "stage": stage, "actor": actor,
            "created_at": self.jobs._now().isoformat(), "base_job_revision": canonical_json_hash(job),
            "ruleset_ref": reference, "ruleset_policy_revision": release["policy_revision"],
            "analysis_basis_revision": basis_revision,
            "previous_result": previous_result,
            "selection": selected, "target_document": target_document, "dependency": dependency,
            "dependency_revision": capture.dependency_revision(dependency),
            "scope": {"requested": selected, "included": [item["document"] for item in documents],
                      "source": "whole_original_reference", "automatic_context_expansion": False},
            "completeness": {"complete": complete, "truncated": False, "skipped": skipped},
            "input_ready": not any(item.get("required") for item in skipped)
                and (extraction is None or extraction["manifest"]["complete"]),
            "components": files.descriptors(components)}
        revision = files.digest(capture.encoded(manifest).encode("utf-8"))
        basis_details = {"analysis_basis_revision": basis_revision}
        if previous_basis is None or rebase:
            basis_details.update(analysis_basis=fixed_basis, rebase_reason=rebase_reason,
                                 previous_basis_revision=None if previous_basis is None else previous_basis["revision"])
        candidate = after(self, job, actor, "input_prepared", bundle_id=bundle_id,
                          bundle_revision=revision, stage=stage, **basis_details)
        # 상태 한도를 먼저 확인한 뒤 공개한다. 연결 실패 시 이미 공개한 입력은 보존한다.
        files.publish(self.store, parent / bundle_id, manifest, components)
        try:
            self.jobs._write(records.state_path(self.jobs, job_id), candidate)
        except OSError as error:
            raise limits.InputConflictError("input_pending_reconcile", bundle_id=bundle_id,
                                            bundle_revision=revision) from error
        return response(manifest, revision, canonical_json_hash(candidate))


def load_locked(self, job, bundle_id, bundle_revision):
    # 호출자는 조정 잠금을 이미 보유한다. 묶음 내용과 job/run/이벤트 연결을 함께 확인한다.
    limits.identifier(bundle_id); limits.revision(bundle_revision)
    manifest, text, components = files.load(self.store,
        self.jobs.jobs_dir / job["job_id"] / "inputs" / bundle_id, expected_revision=bundle_revision)
    try:
        if any(manifest[key] != expected for key, expected in (("job_id", job["job_id"]),
            ("run_id", job["run_id"]), ("tenant", job["tenant"]), ("user_id", job["user_id"]), ("bundle_id", bundle_id))):
            raise ValueError()
        limits.stage_permission(manifest["stage"])
        if not linked(job, "input_prepared", bundle_id=bundle_id, bundle_revision=bundle_revision):
            raise limits.InputConflictError("input_pending_reconcile", bundle_id=bundle_id)
        if capture.dependency_revision(manifest["dependency"]) != manifest["dependency_revision"]:
            raise ValueError()
    except (ValueError, TypeError, KeyError) as error:
        raise limits.InputCorruptError("The input manifest belongs to a different job or run.") from error
    return manifest, text, components


def validate_current(self, job, manifest, actor):
    """고정 사본의 무결성과 별개로, 지금도 같은 기준으로 사용할 수 있는지 검사한다."""
    with self.store._write_lock():
        validate_current_locked(self, job, manifest, actor)


def validate_current_locked(self, job, manifest, actor):
    """저장 모듈이 이미 보유한 위키 잠금에서 재사용한다. 중첩 잠금을 잡지 않는다."""
    # manifest는 분석에 쓴 옛 입력의 설명서다. 지금 읽은 의존 문서/판단의 지문과 비교한다.
    # 잠금을 이미 가진 호출자를 위한 함수이므로 여기서 다시 with _write_lock()을 쓰지 않는다.
    self.rulesets.validate_reference(job["tenant"], manifest["ruleset_ref"])
    _, dependencies, _ = capture.documents_locked(self.store, manifest["selection"], actor)
    # 이력 revision도 비교하므로 본문이 A→B→A로 돌아와도 과거 입력을 재사용하지 않는다.
    current = capture.basis(actor, dependencies, job["source_ref"], manifest["dependency"]["extraction"])
    # 달라졌다면 예외로 중단한다. 새 revision만 끼워 넣어 오래된 분석 결과를 저장하지 않는다.
    if capture.dependency_revision(current) != manifest["dependency_revision"]:
        raise limits.InputConflictError("input_basis_changed", bundle_id=manifest["bundle_id"])
    basis.validate_current_locked(self, job, manifest, actor)
    if manifest["dependency"]["extraction"] is not None:
        from .extractions import load_extraction
        load_extraction(self, job, manifest["dependency"]["extraction"]["extraction_id"])


def read(self, job_id, *, tenant, user_id, run_id, bundle_id, bundle_revision, authorize,
         component=None, offset=0, limit=65536):
    # component가 없으면 설명서를, 있으면 지정 구성의 문자 페이지를 반환한다.
    # 페이지마다 현재 입력 기준을 재확인하므로 오래된 묶음을 이어 읽으며 조용히 재사용하지 않는다.
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= limits.MAX_PAGE_CHARACTERS:
        raise limits.InputValidationError("Use a bounded character page.")
    if self.rulesets is None:
        raise limits.InputConflictError("ruleset_unconfigured")
    with self.jobs.sources._coordination_lock():
        job, actor = opened(self, job_id, tenant, user_id, run_id, authorize, "read")
        manifest, text, components = load_locked(self, job, bundle_id, bundle_revision)
        validate_current(self, job, manifest, actor)
        value = response(manifest, bundle_revision, canonical_json_hash(job))
        if component is None:
            return {**value, "manifest": manifest, "manifest_text": text,
                "components": {name: {key: item[key] for key in ("sha256", "size_bytes")}
                               for name, item in manifest["components"].items()}, "complete": True}
        if component not in components or offset > len(components[component]):
            raise limits.InputValidationError("Select an existing fixed component and character page.")
        full = components[component]
        # offset은 문자 단위다. hash/size는 전체 UTF-8 바이트 기준이므로 서로 구분한다.
        end = min(offset + limit, len(full))
        return {**value, "component": component, "content": full[offset:end], "offset": offset,
            "next_offset": end if end < len(full) else None, "complete": end == len(full),
            "component_sha256": manifest["components"][component]["sha256"],
            "component_size_bytes": manifest["components"][component]["size_bytes"], "page_unit": "unicode_characters"}
