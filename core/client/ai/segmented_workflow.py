"""모든 구간의 추출과 전체 그래프 대조가 끝난 뒤에만 하나의 제출을 돌려준다."""

from copy import deepcopy
import json
import re

from jsonschema import Draft202012Validator

from core.client.inputs import load_input, _local_bytes
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.runtime.client_platform import private_directory, write_new
from . import segmented_input, segmented_diagnostics
from .draft_validation import fixed_basis, inspect, repair_prompt, MAX_DRAFT_REPAIRS


COLLECTIONS = ("entities", "relations", "relation_candidates", "attributes")
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
_EXECUTION_FIELDS = ("provider", "cli_version", "requested_model", "reported_model",
                     "prompt_sha256", "schema_sha256", "output_sha256")
_REJECT_CACHE = frozenset({"analysis_draft_invalid", "analysis_draft_repair_exhausted",
    "segmented_review_incomplete", "segmented_graph_rewrite", "segmented_output_mismatch",
    "segmented_evidence_outside_window", "segmented_evidence_ambiguous", "segmented_diagnostic_mismatch",
    "segmented_concern_unresolved", "segmented_cache_mismatch", "segmented_diagnostic_limit"})


def _write(path, value):
    """새 증거만 추가하고 기존 중간 결과를 덮어쓰지 않는다."""
    raw = canonical_json_bytes(value)
    if len(raw) > MAX_ARTIFACT_BYTES:
        raise AnalysisClientError("segmented_artifact_limit")
    write_new(path, raw)


def _generation(parent, binding):
    """실패한 의미 초안은 남기고 다음 명시 실행에서 새 불변 세대를 고른다."""
    basis = private_directory(parent / canonical_json_hash(binding))
    found = []
    for path in basis.iterdir():
        match = re.fullmatch(r"generation-([0-9]{3})", path.name)
        if match is None or not path.is_dir() or path.is_symlink():
            raise AnalysisClientError("segmented_cache_mismatch")
        private_directory(path)
        found.append((int(match.group(1)), path))
    found.sort()
    if found and not (found[-1][1] / "rejected").exists():
        return found[-1][1]
    number = found[-1][0] + 1 if found else 0
    if number >= segmented_input.MAX_CACHE_GENERATIONS:
        raise AnalysisClientError("segmented_retry_limit")
    return private_directory(basis / f"generation-{number:03}", exist_ok=False)


def _new_items(submission, graph):
    """전체 그래프 재검토는 기존 항목을 정확히 보존하고 끝에만 추가한다."""
    if graph is None:
        return submission
    if submission.get("schema_version") != graph["schema_version"]:
        raise AnalysisClientError("segmented_graph_rewrite")
    additions = {"schema_version": submission["schema_version"]}
    for name in COLLECTIONS:
        original = graph[name]
        if submission.get(name, [])[:len(original)] != original:
            raise AnalysisClientError("segmented_graph_rewrite")
        additions[name] = submission[name][len(original):]
    return additions


def _evidence_in_window(items, content, source, source_offset):
    """새 주장의 모든 근거는 실제로 제공한 원문 범위에서 가져와야 한다."""
    pending = [items]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            evidence = value.get("evidence")
            if evidence is not None and (type(evidence) is not str or evidence not in content):
                raise AnalysisClientError("segmented_evidence_outside_window")
            if evidence is not None:
                at = source.find(evidence, source_offset)
                if source.find(evidence, at + 1) >= 0:
                    raise AnalysisClientError("segmented_evidence_ambiguous")
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)


def _inspect(payload, assembled, basis, segment, graph, initial_report=None):
    """전체 판본 검사와 부분 범위 검사를 모두 통과해야 재사용 가능한 결과가 된다."""
    failure = next(Draft202012Validator(assembled["schema"]).iter_errors(payload), None)
    if failure is not None or payload.get("segment") != assembled["identity"]:
        raise AnalysisClientError("segmented_output_mismatch")
    additions = _new_items(payload["submission"], graph)
    _evidence_in_window(additions, basis["source"][segment["start"]:segment["end"]], basis["source"],
                        basis.get("segmented_body_start", 0))
    # 진단 인용이 다른 범위로 빠져나가 전체 문서를 이미 읽은 것처럼 보고하지 못한다.
    lines = segmented_input._line_view(basis["source"], segment, basis.get("segmented_coordinates"))
    first, last = lines[0]["number"], lines[-1]["number"]
    for item in payload["diagnostics"]["reviewed_ranges"]:
        if not first <= item["start_line"] <= item["end_line"] <= last:
            raise AnalysisClientError("segmented_diagnostic_mismatch")
    for finding in payload["diagnostics"]["findings"]:
        quote = finding["source"]
        if quote is not None and (quote["quote"] not in basis["source"][segment["start"]:segment["end"]]
                or not first <= quote["start_line"] <= quote["end_line"] <= last):
            raise AnalysisClientError("segmented_diagnostic_mismatch")
    concerns = segmented_diagnostics.concerns(initial_report)
    original_concerns = {item["id"]: item["value"] for item in concerns}
    resolutions = payload["resolutions"]
    handled = [item["concern_id"] for item in resolutions] + payload["unresolved_concerns"]
    if (sorted(handled) != sorted(item["id"] for item in concerns)
            or any(not item["reason"].strip() for item in resolutions)):
        raise AnalysisClientError("segmented_concern_unresolved")
    for item in resolutions:
        findings = payload["diagnostics"]["findings"]
        if item["finding_index"] >= len(findings):
            raise AnalysisClientError("segmented_concern_unresolved")
        finding = findings[item["finding_index"]]
        kind = item["concern_id"].split(":", 1)[0]
        original = original_concerns[item["concern_id"]]
        # 명시된 모순·근거 부족·조건 손실을 표현 한계로 이름만 바꿔 해결할 수 없다.
        limit_eligible = (kind == "omission" or kind == "finding" and type(original) is dict
                          and original.get("verdict") == "schema_limit")
        retained_limit = (limit_eligible
                          and segmented_diagnostics.retained_schema_limit(finding, payload["submission"]))
        if (finding["verdict"] != "supported" and not retained_limit) or finding["source"] is None:
            raise AnalysisClientError("segmented_concern_unresolved")
        if kind in {"omission", "finding"} and finding["target"] is None:
            raise AnalysisClientError("segmented_concern_unresolved")
    return inspect({**payload, "document": basis["document"]}, basis)


def _final_review(payload, basis, segment):
    """최종 구간은 실제 자기검사·전체 줄 검토·미해결 없음이 모두 필요하다."""
    report = payload["diagnostics"]
    segmented_diagnostics.require_complete(report, unresolved=payload["unresolved_concerns"], submission=payload["submission"])
    if report["reviewer_kind"] != "ai_self_check" or not report["reviewed_ranges"]:
        raise AnalysisClientError("segmented_review_incomplete")
    lines = segmented_input._line_view(basis["source"], segment, basis.get("segmented_coordinates"))
    expected, last = lines[0]["number"], lines[-1]["number"]
    for item in sorted(report["reviewed_ranges"], key=lambda item: (item["start_line"], item["end_line"])):
        if item["start_line"] > expected:
            raise AnalysisClientError("segmented_review_incomplete")
        expected = max(expected, item["end_line"] + 1)
    if expected <= last:
        raise AnalysisClientError("segmented_review_incomplete")


def _cache(cache, filename, *, binding, segment, assembled, graph, basis, initial_report):
    """캐시도 매번 같은 원문·스키마·실행 설정으로 검사한다. 옛 검증 표시는 믿지 않는다."""
    path = cache / filename
    if not path.exists():
        return None
    try:
        value = json.loads(_local_bytes(cache, filename, MAX_ARTIFACT_BYTES))
        if (value["binding"] != binding or value["segment"] != segment
                or value["input_graph_sha256"] != assembled["assembly"]["input_graph_sha256"]
                or value["initial_diagnostics_sha256"] != assembled["assembly"]["initial_diagnostics_sha256"]
                or value["payload_sha256"] != canonical_json_hash(value["payload"])):
            raise ValueError()
        report = _inspect(value["payload"], assembled, basis, segment, graph, initial_report)
        if not report["passed"]:
            raise ValueError()
        if assembled["assembly"]["phase"] == "reconcile":
            _final_review(value["payload"], basis, segment)
        return value
    except (KeyError, ValueError, TypeError, RecursionError, UnicodeError):
        raise AnalysisClientError("segmented_cache_mismatch") from None


async def run(**arguments):
    """의미/초안 거부는 캐시 세대를 폐기 표시하고 일시 실행 오류는 재개용으로 보존한다."""
    state = {}
    try:
        return await _run(**arguments, state=state)
    except AnalysisClientError as error:
        cache = state.get("cache")
        if cache is not None and error.code in _REJECT_CACHE:
            # 디렉터리 생성 자체가 원자적인 폐기 표시다. 세부 기록이 실패해도 재사용하지 않는다.
            marker = private_directory(cache / "rejected")
            if not (marker / "reason.json").exists():
                _write(marker / "reason.json", {"code": error.code, "automatic_retry": False,
                                               "original_artifacts_retained": True})
        raise


async def _run(*, fixed, directory, job_directory, document, adapter, lease, current,
              executions, execution_config_sha256, input_view, rules_view, semantic_check, timings, state):
    """부분 결과는 서버 결과 원장에 보내지 않고 최종 전체 산출물만 호출자에게 반환한다."""
    if semantic_check:
        raise AnalysisClientError("segmented_semantic_check_unavailable")
    captured = load_input(fixed, directory)
    basis = fixed_basis(fixed, directory, document)
    basis["segmented_coordinates"] = segmented_input.source_coordinates(basis["source"])
    segments = segmented_input.plan(basis["source"], coordinates=basis["segmented_coordinates"])
    basis["segmented_body_start"] = segments[0]["start"]
    binding = segmented_input.cache_binding(captured["manifest"], source_revision=basis["expected_revision"],
        execution_config_sha256=execution_config_sha256, input_view=input_view, rules_view=rules_view)
    parent = private_directory(job_directory / "segmented")
    await current()
    lease.check()
    cache = _generation(parent, binding)
    state["cache"] = cache
    manifest = {"binding": binding, "segments": segments}
    if (cache / "plan.json").exists():
        try:
            previous_plan = json.loads(_local_bytes(cache, "plan.json", MAX_ARTIFACT_BYTES))
        except (ValueError, TypeError, UnicodeError):
            raise AnalysisClientError("segmented_cache_mismatch") from None
        if previous_plan != manifest:
            raise AnalysisClientError("segmented_cache_mismatch")
    else:
        _write(cache / "plan.json", manifest)
    _write(directory / "segmented-plan.json", {"policy": segmented_input.POLICY, "segments": segments,
        "binding_sha256": canonical_json_hash(binding), "phase_count": 2,
        "publication": "only_after_all_segments_and_reconciliation"})
    reports, initial_reports, reused = [], [], []
    last_execution = None

    async def one(segment, graph, phase, initial_report=None):
        nonlocal last_execution
        assembled = segmented_input.assemble(captured, fixed, document=document, segment=segment,
            input_view=input_view, rules_view=rules_view, graph=graph, coordinates=basis["segmented_coordinates"], phase=phase,
            initial_report=initial_report)
        filename = f"{phase}-{segment['index']:03}.json"
        await current()
        lease.check()
        saved = _cache(cache, filename, binding=binding, segment=segment,
                       assembled=assembled, graph=graph, basis=basis, initial_report=initial_report)
        if saved is not None:
            reused.append({"phase": phase, "index": segment["index"]})
            last_execution = saved["execution"]
            await current()
            lease.check()
            return deepcopy(saved["payload"])
        attempt_root = private_directory(directory / f"{phase}-{segment['index']:03}", exist_ok=False)
        _write(attempt_root / "assembly.json", assembled["assembly"])
        prompt = assembled["prompt"]
        for repair in range(MAX_DRAFT_REPAIRS + 1):
            await current()
            lease.check()
            attempt = private_directory(attempt_root / f"attempt-{repair}", exist_ok=False)
            result = await timings.wait("ai_initial" if repair == 0 else "ai_repair",
                lease.guard(adapter.run(prompt=prompt, schema=assembled["schema"],
                    output_schema=assembled["cli_schema"], directory=attempt / "invocation")),
                stage="extract_ontology", segment_phase=phase, segment=segment["index"], attempt=repair)
            execution = {key: result["execution"].get(key) for key in _EXECUTION_FIELDS}
            execution.update(published_schema_sha256=assembled["assembly"]["published_schema_sha256"])
            if execution_config_sha256 is not None:
                execution["execution_config_sha256"] = execution_config_sha256
            executions.append(execution)
            await current()
            lease.check()
            payload = result["value"]
            _write(attempt / "output.json", payload)
            try:
                validation = _inspect(payload, assembled, basis, segment, graph, initial_report)
            except AnalysisClientError as error:
                # 변경/범위 오류도 같은 입력으로 제한된 수정 기회를 준다. 임의 정규화는 하지 않는다.
                validation = {"passed": False, "repairable": True,
                    "errors": [{"path": "/", "code": error.code,
                        "message": "Preserve prior items exactly; use literal evidence within this window. "
                                   "For ambiguous evidence, quote enough adjacent source text to identify one full-file occurrence."}]}
            _write(attempt / "validation.json", validation)
            if validation["passed"]:
                if phase == "reconcile":
                    _final_review(payload, basis, segment)
                cached = {"binding": binding, "segment": segment,
                    "input_graph_sha256": assembled["assembly"]["input_graph_sha256"],
                    "initial_diagnostics_sha256": assembled["assembly"]["initial_diagnostics_sha256"],
                    "payload": payload, "payload_sha256": canonical_json_hash(payload), "execution": execution}
                _write(cache / filename, cached)
                last_execution = execution
                return deepcopy(payload)
            if not validation["repairable"]:
                raise AnalysisClientError("analysis_draft_invalid")
            if repair == MAX_DRAFT_REPAIRS:
                raise AnalysisClientError("analysis_draft_repair_exhausted")
            prompt = repair_prompt(assembled["prompt"], payload, validation, repair + 1)
        raise AnalysisClientError("analysis_draft_invalid")

    graph = None
    for segment in segments:
        payload = await one(segment, graph, "extract")
        graph = payload["submission"]
        initial_reports.append(payload["diagnostics"])
    for segment in segments:
        payload = await one(segment, graph, "reconcile", initial_reports[segment["index"]])
        graph = payload["submission"]
        reports.append(payload["diagnostics"])
    payload = {"submission": graph, "diagnostics": segmented_diagnostics.merge(reports, submission=graph,
        initial_warnings=[warning for report in initial_reports for warning in report["warnings"]])}
    validation = inspect({**payload, "document": document}, basis)
    if not validation["passed"]:
        raise AnalysisClientError("analysis_draft_invalid")
    await current()
    lease.check()
    _write(directory / "segmented-complete.json", {"policy": segmented_input.POLICY,
        "source_revision": basis["expected_revision"], "segment_count": len(segments),
        "reconciled_count": len(segments), "reused": reused, "payload_sha256": canonical_json_hash(payload),
        "initial_concern_count": sum(len(segmented_diagnostics.concerns(report)) for report in initial_reports),
        "rechecked_count": len(initial_reports),
        "schema_limit_count": sum(item["verdict"] == "schema_limit" for item in payload["diagnostics"]["findings"]),
        "semantic_completeness": "not_certified",
        "semantic_validation": "ai_self_check", "human_approval": False})
    return {"payload": payload, "execution": last_execution}
