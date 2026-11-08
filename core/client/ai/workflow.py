"""고정 입력 → 개인 AI → 서버 저장 영수증을 한 작업에 연결한다.

호출 입구는 run_analysis다. 실제 모델 실행은 adapter.run에, 입력 확인은
inputs/assembly에, 저장은 서버의 기존 결과 도구에 맡긴다. 토큰은 AI에 넘기지 않는다.
이번 어댑터는 UTF-8 원본과 대상 문서 한 개를 처리하며 원문을 임의로 분할하지 않는다.
"""

import asyncio
from hashlib import sha256
import os
import stat
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import open_new, is_windows, read_private, private_directory
from core.client.inputs import receive_input, load_input
from core.client.transport import AnalysisClientError, tool_call
from .assembly import assemble_input
from .lease import LeaseKeeper
from .contracts import MAX_LITERAL_SOURCE_BYTES


_EXECUTION_FIELDS = ("provider", "cli_version", "requested_model", "reported_model",
                     "prompt_sha256", "schema_sha256", "output_sha256")


def _record(path, value):
    # x 모드처럼 O_EXCL로 기존 초안/증거를 덮어쓰지 않는다. JSON은 같은 공통 인코더를 쓴다.
    descriptor = open_new(path)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(canonical_json_bytes(value))


def _original_text(path, source_ref):
    if is_windows():
        read_private(path, MAX_LITERAL_SOURCE_BYTES)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise AnalysisClientError("unsafe_original_file")
        raw = stream.read(MAX_LITERAL_SOURCE_BYTES + 1)
    if len(raw) > MAX_LITERAL_SOURCE_BYTES:
        raise AnalysisClientError("analysis_source_limit")
    if len(raw) != source_ref["size_bytes"] or sha256(raw).hexdigest() != source_ref["source_sha256"]:
        raise AnalysisClientError("source_hash_mismatch")
    # 현재 지원 형식은 이미 UTF-8이다. 변환하지 않은 실제 문자 그대로 제출해 AI 전사와 구분한다.
    return raw.decode("utf-8")


async def _current(client, common, expected_revision):
    job = await tool_call(client, "analysis_job_query", {"tenant": common["tenant"], "job_id": common["job_id"]})
    if (job["job_revision"] != expected_revision or job["run_id"] != common["run_id"]
            or job["state"] != "claimed" or job["lease_status"] != "active" or job["basis_status"] != "current"):
        raise AnalysisClientError("analysis_job_changed")
    return job


async def _current_input(client, common, selected, fixed, expected_revision):
    # job 조회의 basis_status는 원본 등록만 본다. 기존 bundle read가 관점·규약·
    # 원문·명시 맥락·검토/전체 이력의 현재 기준을 다시 대조하며 쓰기는 하지 않는다.
    bundle = await tool_call(client, "analysis_job_input_read", {**common, **selected,
        "bundle_id": fixed["bundle_id"], "bundle_revision": fixed["bundle_revision"]})
    if (bundle.get("job_revision") != expected_revision or bundle.get("complete") is not True
            or any(bundle.get(key) != fixed[key] for key in ("bundle_id", "bundle_revision", "ruleset_ref"))):
        raise AnalysisClientError("analysis_job_changed")


async def _store_result(client, tool, arguments, directory):
    """송신 전 요청을 보관한다. 응답을 잃으면 조회만 하며 저장을 자동 재전송하지 않는다."""
    _record(directory / "request.json", {"tool": tool, "arguments": arguments})
    try:
        result = await tool_call(client, tool, arguments)
    except asyncio.CancelledError:
        raise
    except Exception:
        try:
            result = await tool_call(client, "analysis_job_result_query", {
                key: arguments[key] for key in ("tenant", "job_id", "request_id", "profile") if key in arguments})
        except Exception as error:
            raise AnalysisClientError("analysis_result_unconfirmed") from error
    _record(directory / "receipt.json", result)
    if arguments.get("save") is False and result.get("state") == "draft" and result.get("saved") is False:
        return result
    if result.get("state") == "rejected" and result.get("saved") is False:
        raise AnalysisClientError("analysis_result_rejected")
    if result.get("saved") is not True or result.get("state") != "complete":
        raise AnalysisClientError("analysis_result_unconfirmed")
    return result


async def run_analysis(http, client, *, tenant, job_id, run_id, directory, original, source_ref,
                       job_revision, lease_revision, fixed_input, adapter, profile=None, context_documents=None,
                       completed_stages=None, prior_receipts=None, semantic_check=False, input_view="full",
                       execution_configuration=None, execution_config_sha256=None, session_registry=None):
    """한 문서를 저장한다. 수정 가능한 초안 검사만 두 번까지 고치며 저장은 재시도하지 않는다."""
    common = {"tenant": tenant, "job_id": job_id, "run_id": run_id}
    receipts, executions = list(prior_receipts or []), []
    completed_stages = completed_stages or set()
    semantic_reports = []
    continuation = None
    comparison = None
    session_ref_error = None
    underlying_adapter = adapter
    from .observations import ObservedAdapter
    adapter = ObservedAdapter(adapter)
    revision = job_revision
    try:
        async with LeaseKeeper(http, **common, lease_revision=lease_revision) as lease:
            job = await _current(client, common, revision)
            if len(job["targets"]) != 1:
                raise AnalysisClientError("analysis_target_scope_required")
            document = job["targets"][0]["document"]
            rules = fixed_input["ruleset_ref"]
            # 이름만으로 원본을 추정하지 않고 이미 받은 고정 입력의 지문을 다시 확인한다.
            initial = load_input(fixed_input, directory)
            # 기본 관점이 바뀌어도 이번 작업은 처음 관측한 관점과 같은 정의를 사용한다.
            initial_profile = {key: initial["manifest"]["actor"][key] for key in ("profile_id", "domain", "viewpoint")}
            profile = initial_profile["profile_id"]
            selected = {"profile": profile}
            extraction = None
            if not job.get("registration") and "wiki" in job["outputs"] and (document, "prepare_wiki") not in completed_stages:
                content = _original_text(original, source_ref)
                request = {**common, **selected, "expected_job_revision": revision,
                    "bundle_id": fixed_input["bundle_id"], "bundle_revision": fixed_input["bundle_revision"],
                    "request_id": uuid4().hex, "content": content, "method": "verbatim",
                    "warnings": [], "omissions": [], "scope": {"selection": "whole_original", "unread_ranges": []}}
                _record(directory / "reading-request.json", {"tool": "source_extraction_submit", "arguments": request})
                extraction = await tool_call(client, "source_extraction_submit", request)
                _record(directory / "reading-receipt.json", extraction)
                if extraction.get("state") != "complete" or extraction.get("complete") is not True:
                    raise AnalysisClientError("analysis_reading_unconfirmed")
                revision = extraction["job_revision"]

            stages = (["prepare_wiki"] if "wiki" in job["outputs"] else []) + (
                ["extract_ontology"] if "ontology" in job["outputs"] else [])
            for stage in stages:
                if (document, stage) in completed_stages:
                    continue
                lease.check()
                await _current(client, common, revision)
                stage_directory = directory / stage
                private_directory(stage_directory, exist_ok=False)
                fixed = await receive_input(client, **common, expected_job_revision=revision,
                    directory=stage_directory, stage=stage, target_document=document,
                    extraction_id=extraction["extraction_id"] if stage == "prepare_wiki" and extraction is not None else None,
                    context_documents=context_documents, profile=profile, ruleset_ref=rules)
                revision = fixed["job_revision"]
                if stage == "prepare_wiki" and job.get("registration"):
                    # 기본 변환은 고정된 전체 문자를 보존한다. 모델 요약/재작성과 구분한다.
                    captured = load_input(fixed, stage_directory)
                    target = next(item for item in captured["manifest"]["dependency"]["documents"]
                                  if item["document"] == document)
                    arguments = {**common, **selected, "expected_job_revision": revision,
                        "bundle_id": fixed["bundle_id"], "bundle_revision": fixed["bundle_revision"],
                        "request_id": uuid4().hex, "document": document,
                        "expected_revision": target.get("source_revision"),
                        "content": captured["components"]["data/registration.md"]}
                    await _current(client, common, revision)
                    lease.check()
                    receipt = await _store_result(client, "analysis_job_wiki_write", arguments, stage_directory)
                    receipts.append(receipt)
                    revision = receipt["job_revision"]
                    continue
                assembled = assemble_input(fixed, stage_directory, stage=stage, target_document=document, input_view=input_view)
                if any(assembled["manifest"]["actor"][key] != value for key, value in initial_profile.items()):
                    raise AnalysisClientError("analysis_profile_changed")
                _record(stage_directory / "assembly.json", assembled["assembly"])
                _record(stage_directory / "pending.json", {"status": "running", "stage": stage,
                                                           "bundle_id": fixed["bundle_id"]})
                from .draft_validation import MAX_DRAFT_REPAIRS, fixed_basis, inspect, repair_prompt
                basis = fixed_basis(fixed, stage_directory, document) if stage == "extract_ontology" else None
                prompt = assembled["prompt"]
                if hasattr(underlying_adapter, "persist_session"):
                    underlying_adapter.persist_session = stage == "extract_ontology"
                for repair_number in range(MAX_DRAFT_REPAIRS + 1):
                    # 각 수정은 같은 고정 원문·job·lease 아래 새 호출이며 기존 초안을 덮어쓰지 않는다.
                    await _current(client, common, revision)
                    await _current_input(client, common, selected, fixed, revision)
                    lease.check()
                    attempt_directory = (stage_directory if repair_number == 0 else
                        private_directory(stage_directory / f"repair-{repair_number}", exist_ok=False))
                    invocation = attempt_directory / "invocation"
                    result = await lease.guard(adapter.run(prompt=prompt, schema=assembled["schema"],
                        output_schema=assembled["cli_schema"], directory=invocation))
                    execution = {key: result["execution"].get(key) for key in _EXECUTION_FIELDS}
                    if execution_config_sha256 is not None:
                        execution["execution_config_sha256"] = execution_config_sha256
                    if stage == "extract_ontology":
                        execution["published_schema_sha256"] = assembled["assembly"]["published_schema_sha256"]
                    executions.append(execution)
                    # 모델 실행 중 바뀐 작업 버전으로 숫자만 교체해 오래된 결과를 저장하지 않는다.
                    await _current(client, common, revision)
                    await _current_input(client, common, selected, fixed, revision)
                    lease.check()
                    payload = result["value"]
                    diagnostics = payload["diagnostics"]
                    incomplete = bool(diagnostics["unread_ranges"] or stage == "prepare_wiki" and diagnostics["omissions"])
                    if stage != "extract_ontology" or incomplete:
                        # 미독은 원래 save=false 진단 보존 경로로 보낸다. 재생성으로 숨기지 않는다.
                        break
                    validation = inspect(payload["submission"], basis)
                    private_directory(invocation, exist_ok=True)
                    _record(invocation / "draft-validation.json", validation)
                    if validation["passed"]:
                        break
                    if not validation["repairable"]:
                        raise AnalysisClientError("analysis_draft_invalid")
                    if repair_number == MAX_DRAFT_REPAIRS:
                        raise AnalysisClientError("analysis_draft_repair_exhausted")
                    prompt = repair_prompt(assembled["prompt"], payload, validation, repair_number + 1)
                target = next(item for item in assembled["manifest"]["dependency"]["documents"]
                              if item["document"] == document)
                stage_session = result["execution"] if stage == "extract_ontology" else None
                arguments = {**common, **selected, "expected_job_revision": revision,
                    "bundle_id": fixed["bundle_id"], "bundle_revision": fixed["bundle_revision"],
                    "request_id": uuid4().hex, "document": document,
                    "expected_revision": target.get("source_revision"), "execution": execution,
                    "diagnostics": diagnostics, "save": not incomplete}
                if stage == "prepare_wiki":
                    arguments["content"] = payload["content"]
                    tool = "analysis_job_wiki_write"
                else:
                    arguments.update(submission=payload["submission"], expected_state_revision=target["state_revision"])
                    tool = "analysis_job_ontology_generate"
                if stage == "extract_ontology" and semantic_check and not incomplete:
                    if hasattr(underlying_adapter, "persist_session"):
                        underlying_adapter.persist_session = False
                    from core.client.semantic_check import run_semantic_check
                    _record(stage_directory / "generation-diagnostics.json", diagnostics)
                    report = await lease.guard(run_semantic_check(fixed_input=fixed, directory=stage_directory,
                        target_document=document, submission=payload["submission"], adapter=adapter,
                        output_directory=stage_directory / "semantic-check"))
                    await _current(client, common, revision)
                    report_dir = private_directory(stage_directory / "semantic-report", exist_ok=False)
                    check_arguments = {**arguments, "request_id": uuid4().hex, "diagnostics": report, "save": False}
                    report_receipt = await _store_result(client, tool, check_arguments, report_dir)
                    semantic_reports.append(report_receipt)
                    revision = report_receipt["job_revision"]
                    arguments["expected_job_revision"] = revision
                    await _current(client, common, revision)
                    lease.check()
                receipt = await _store_result(client, tool, arguments, stage_directory)
                receipts.append(receipt)
                revision = receipt["job_revision"]
                if incomplete:
                    # 초안/미독 진단의 서버 보존을 먼저 확인하고 다음 단계의 저장을 중단한다.
                    raise AnalysisClientError("analysis_input_incomplete")
                _record(stage_directory / "finished.json", {"status": "stored", "request_id": arguments["request_id"]})
                if stage == "extract_ontology" and hasattr(underlying_adapter, "persist_session"):
                    continuation = (receipt["receipt"], stage_session)
                    from core.client.session_refs import SessionRefs, binding, registry_path
                    try:
                        SessionRefs(registry_path(directory, session_registry)).remember(
                            scope=binding(server=str(http.base_url), tenant=tenant,
                                user_id=initial["manifest"]["actor"]["user_id"], profile=profile,
                                document=document, job_id=job_id), execution=stage_session, invocation=invocation)
                    except (AnalysisClientError, OSError) as error:
                        # 그래프 저장은 이미 확인됐다. 로컬 세션을 보존하지 못해도 다시 추출하지 않는다.
                        session_ref_error = (error.code if isinstance(error, AnalysisClientError)
                                             else "comparison_session_ref_write_failed")
            job = await _current(client, common, revision)
            if job["result_summary"]["status"] != "complete":
                raise AnalysisClientError("analysis_result_unconfirmed")
            if continuation is not None:
                from core.client.post_extraction import compare_stored_extraction
                comparison = await lease.guard(compare_stored_extraction(http, adapter, tenant=tenant,
                    profile=profile, job_id=job_id, receipt=continuation[0], session=continuation[1], directory=directory))
                if session_ref_error is not None:
                    comparison["session_ref_error"] = session_ref_error
            # CLI 종료 보고와 서버의 저장 증거는 별개다. complete라는 자기보고는 보내지 않는다.
            stopped = await tool_call(client, "analysis_job_update", {**common, "expected_job_revision": revision,
                "reported_status": "stopped", "message": "Personal AI adapter finished; inspect the server storage receipts."})
            value = {"status": "stored", "job_revision": stopped["job_revision"], "receipts": receipts,
                     "lease_revision": stopped["lease_revision"],
                     "executions": executions, "semantic_validation": "client_reported" if semantic_reports else "not_run",
                     "semantic_reports": semantic_reports, "resumed_stages": [list(item) for item in sorted(completed_stages)],
                     "execution_configuration": execution_configuration, "usage_observations": adapter.summary(),
                     "comparison": comparison,
                     "human_approval": False}
            _record(directory / "ai-result.json", value)
            return value
    except BaseException as error:
        code = error.code if isinstance(error, AnalysisClientError) else "ai_cancelled" if isinstance(
            error, asyncio.CancelledError) else "analysis_execution_failed"
        _record(directory / "ai-failure.json", {"status": "stopped", "error_code": code,
                "receipts": receipts, "executions": executions, "automatic_retry": False,
                "execution_configuration": execution_configuration,
                "usage_observations": adapter.summary()})
        # 상태 보고에 실패해도 이미 성공한 위키·그래프를 취소하거나 재실행하지 않는다.
        if not isinstance(error, asyncio.CancelledError):
            try:
                await tool_call(client, "analysis_job_update", {**common, "expected_job_revision": revision,
                    "reported_status": "failed", "message": "Personal AI adapter stopped; preserved drafts and receipts require inspection."})
            except Exception:
                pass
        raise
