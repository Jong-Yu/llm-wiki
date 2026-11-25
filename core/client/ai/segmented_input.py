"""전체 판본을 보존하는 결정적 문자 범위와 제한된 모델 입력을 만든다."""

from bisect import bisect_right
from array import array
from copy import deepcopy
from hashlib import sha256
import json
import re

from core.client.inputs import MAX_INPUT_BYTES
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.documents.metadata import parse_document
from .assembly import (_stage_schema, _envelope, DIAGNOSTIC_GUIDANCE,
                       SOURCE_LINE_REFERENCE_GUIDANCE)
from .rule_selection import COMMON_INSTRUCTIONS, STAGE_INSTRUCTIONS, select_rules, SELECTION_GUIDANCE


POLICY = "whole_source_cumulative_windows_and_retained_limits_v6"
ENABLED = False  # 새 원문의 구간 경계 근거 재검토가 끝나지 않아 비활성을 유지한다.
WINDOW_BYTES = 256 * 1024
OVERLAP_BYTES = 8 * 1024
MAX_SEGMENTS = 128
MAX_CACHE_GENERATIONS = 8
MAX_SOURCE_LINES = 1024 * 1024
MAX_WINDOW_LINES = 16384


def configuration():
    """재개 시 처리 정책과 바이트 경계를 실행 설정에 함께 고정한다."""
    return {"policy": POLICY, "window_bytes": WINDOW_BYTES, "overlap_bytes": OVERLAP_BYTES,
            "max_segments": MAX_SEGMENTS, "max_cache_generations": MAX_CACHE_GENERATIONS,
            "max_source_lines": MAX_SOURCE_LINES, "max_window_lines": MAX_WINDOW_LINES,
            "prompt_bytes": MAX_INPUT_BYTES,
            "publication": "single_complete_graph", "reconciliation": "all_windows_append_only"}


def _prefix_end(text, start, maximum):
    """문자 경계에서 UTF-8 한도에 맞는 가장 긴 접두 범위를 찾는다."""
    low, high = start, min(len(text), start + maximum)
    while low < high:
        middle = (low + high + 1) // 2
        if len(text[start:middle].encode("utf-8")) <= maximum:
            low = middle
        else:
            high = middle - 1
    return low


def plan(source, *, window_bytes=WINDOW_BYTES, overlap_bytes=OVERLAP_BYTES, coordinates=None):
    """본문을 빠짐없이 덮고 문단·줄 경계를 우선하는 겹친 범위를 반환한다."""
    if (type(source) is not str or type(window_bytes) is not int or type(overlap_bytes) is not int
            or not 4 <= window_bytes or not 0 <= overlap_bytes < window_bytes // 2):
        raise AnalysisClientError("segmented_coverage_invalid")
    coordinates = coordinates or source_coordinates(source)
    start = len(source) - len(parse_document(source).body)
    if start == len(source):
        raise AnalysisClientError("segmented_source_empty")
    ranges = []
    while start < len(source):
        end = _prefix_end(source, start, window_bytes)
        line_limit = bisect_right(coordinates["diagnostics"], start) - 1 + MAX_WINDOW_LINES
        if line_limit < len(coordinates["diagnostics"]):
            end = min(end, coordinates["diagnostics"][line_limit])
        if end <= start:
            raise AnalysisClientError("segmented_coverage_invalid")
        if end < len(source):
            minimum = start + (end - start) // 2
            paragraph = source.rfind("\n\n", minimum, end)
            newline = source.rfind("\n", minimum, end)
            if paragraph >= minimum:
                end = paragraph + 2
            elif newline >= minimum:
                end = newline + 1
        content = source[start:end]
        effective_overlap = min(overlap_bytes, len(content.encode("utf-8")) // 4)
        ranges.append({"index": len(ranges), "start": start, "end": end,
                       "sha256": sha256(content.encode("utf-8")).hexdigest()})
        if len(ranges) > MAX_SEGMENTS:
            raise AnalysisClientError("segmented_source_limit")
        if end == len(source):
            break
        # 뒤에서 한 글자씩 세지 않고 바이트 예산에 맞는 다음 시작점을 이분 탐색한다.
        low, high = start + 1, end
        while low < high:
            middle = (low + high) // 2
            if len(source[middle:end].encode("utf-8")) <= effective_overlap:
                high = middle
            else:
                low = middle + 1
        start = low
    return ranges


def cache_binding(manifest, *, source_revision, execution_config_sha256, input_view, rules_view):
    """실행 ID를 제외한 전체 의존 판본·권한·규약·설정을 캐시에 고정한다."""
    return {"policy": configuration(), "job_id": manifest["job_id"], "tenant": manifest["tenant"],
        "actor": manifest["actor"], "source_revision": source_revision,
        "target_document": manifest["target_document"], "selection": manifest["selection"],
        "dependency": manifest["dependency"], "dependency_revision": manifest["dependency_revision"],
        "analysis_basis_revision": manifest.get("analysis_basis_revision"),
        "ruleset_ref": manifest["ruleset_ref"], "ruleset_policy_revision": manifest.get("ruleset_policy_revision"),
        "execution_config_sha256": execution_config_sha256, "input_view": input_view, "rules_view": rules_view}


def source_coordinates(source):
    """큰 원문의 줄 시작 위치를 실행당 한 번 계산한다."""
    if len(source) > 0xffffffff:
        raise AnalysisClientError("segmented_source_limit")
    diagnostic, anchors = array("I", [0]), array("I", [0])
    for match in re.finditer(r"\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]", source):
        # 마지막 줄바꿈 뒤의 빈 줄은 splitlines의 실제 행 수에 포함되지 않는다.
        if len(diagnostic) >= MAX_SOURCE_LINES and match.end() < len(source):
            raise AnalysisClientError("segmented_source_limit")
        diagnostic.append(match.end())
        if match.group() in {"\r", "\n", "\r\n"}:
            anchors.append(match.end())
    return {"diagnostics": diagnostic, "anchors": anchors}


def _line_view(source, segment, coordinates=None):
    """부분 줄도 원래 파일의 두 좌표 계약에 그대로 대응시킨다."""
    coordinates = coordinates or source_coordinates(source)
    diagnostic_starts, anchors = coordinates["diagnostics"], coordinates["anchors"]
    if bisect_right(diagnostic_starts, segment["end"] - 1) - bisect_right(diagnostic_starts, segment["start"]) + 1 > MAX_WINDOW_LINES:
        raise AnalysisClientError("segmented_source_limit")
    lines, at = [], segment["start"]
    for line in source[segment["start"]:segment["end"]].splitlines(keepends=True):
        lines.append({"number": bisect_right(diagnostic_starts, at),
                      "source_anchor_line": bisect_right(anchors, at), "text": line,
                      "full_file_character_offset": at})
        at += len(line)
    return lines


def assemble(captured, fixed, *, document, segment, input_view, rules_view, graph=None, coordinates=None, phase=None,
             initial_report=None):
    """자료에는 전체 판본 참조와 실제 부분 범위를 구분하고 규약은 고정 사본을 쓴다."""
    manifest, components, release = captured["manifest"], captured["components"], captured["ruleset"]
    value_schema, _, revision = _stage_schema(manifest, components, "extract_ontology", document)
    context = json.loads(components["data/context.json"])
    target = next(row for row in context["documents"] if row["document"] == document)
    source = target["source"]["content"]
    content = source[segment["start"]:segment["end"]]
    if sha256(content.encode("utf-8")).hexdigest() != segment["sha256"]:
        raise AnalysisClientError("segmented_source_mismatch")
    identity = {"index": segment["index"], "sha256": segment["sha256"], "source_revision": revision}
    schema = _envelope(value_schema, json.loads(components["rules/diagnostics.schema.json"]), "extract_ontology")
    schema["properties"]["segment"] = {"type": "object", "additionalProperties": False,
        "properties": {key: {"type": "integer" if type(value) is int else "string", "const": value}
                       for key, value in identity.items()}, "required": list(identity)}
    schema["required"].append("segment")
    from .segmented_diagnostics import concerns
    unresolved = concerns(initial_report)
    resolution = {"type": "object", "additionalProperties": False, "properties": {
        "concern_id": {"type": "string", "enum": [item["id"] for item in unresolved]},
        "finding_index": {"type": "integer", "minimum": 0},
        "reason": {"type": "string", "minLength": 1, "maxLength": 2000}},
        "required": ["concern_id", "finding_index", "reason"]}
    schema["properties"]["resolutions"] = {"type": "array", "minItems": 0, "maxItems": len(unresolved),
        "items": resolution if unresolved else {"type": "object", "additionalProperties": False,
                                                "properties": {}, "required": []}}
    schema["required"].append("resolutions")
    schema["properties"]["unresolved_concerns"] = {"type": "array", "maxItems": len(unresolved),
        "uniqueItems": True, "items": {"type": "string", **({"enum": [item["id"] for item in unresolved]}
                                                               if unresolved else {})}}
    schema["required"].append("unresolved_concerns")
    trusted = {"rules/manifest.json": release["manifest_text"],
               **{"rules/" + name: value["content"] for name, value in release["components"].items()}}
    data = {name: value for name, value in components.items() if name not in trusted}
    from .input_view import project, REVIEW_HISTORY_REPORTING_INSTRUCTIONS
    view_manifest, view_data, view_audit = project(manifest, data, input_view,
                                                  bundle_revision=fixed["bundle_revision"])
    view_manifest, view_data = deepcopy(view_manifest), dict(view_data)
    # 저장용 참조/descriptor는 전체 바이트를 가리킨다. 부분 자료의 hash로 오인하지 않게 분리한다.
    view_manifest.pop("component_references", None)
    if "components" in view_manifest:
        view_manifest["original_component_descriptors"] = view_manifest.pop("components")
    context = json.loads(view_data["data/context.json"])
    row = next(row for row in context["documents"] if row["document"] == document)
    row["source"].pop("content")
    row["source"].update(full_content_included=False, window={**segment, "content": content,
        "coordinates": "full_file_unicode_character_offsets", "lines": _line_view(source, segment, coordinates)})
    view_data["data/context.json"] = canonical_json_bytes(context).decode("utf-8")
    phase = phase or ("extract" if graph is None else "reconcile")
    if phase not in {"extract", "reconcile"}:
        raise AnalysisClientError("segmented_phase_invalid")
    if graph is not None:
        view_data["data/segmented-graph.json"] = canonical_json_bytes(graph).decode("utf-8")
    if initial_report is not None:
        view_data["data/initial-diagnostics.json"] = canonical_json_bytes({
            "report": initial_report, "concerns": unresolved}).decode("utf-8")
    view_manifest["segmented_input"] = {"policy": POLICY, "phase": phase,
        "source_revision": revision, "segment": segment, "full_source_retained_locally": True,
        "partial_result_will_not_be_published": True}
    trusted, audit = select_rules(trusted, stage="extract_ontology", view=rules_view, output_schema=schema)
    instruction = (COMMON_INSTRUCTIONS + STAGE_INSTRUCTIONS["extract_ontology"] + "\n" + DIAGNOSTIC_GUIDANCE
        + "\n" + SOURCE_LINE_REFERENCE_GUIDANCE + "\nSEGMENTED_SOURCE_POLICY\n"
        "대상 원문의 전체 판본은 source.revision이며 window.sha256는 제공된 문자 범위만의 지문이다. "
        "window 밖의 원문을 읽었다고 주장하지 않는다. 이번 응답은 전체 문서의 완성 그래프가 아닌 중간 결과다. "
        "근거 인용은 이번 window.content에서 그대로 가져오며 모든 줄 번호는 표시된 전체 파일 좌표다. "
        "window 밖이라는 이유만으로 unread_ranges에 기록하지 않되 이번 범위의 실제 누락·애매함은 숨기지 않는다. "
        "diagnostics.reviewed_ranges는 이번 범위에서 실제 확인한 줄만 포함한다. "
        "segment에는 제공된 index·sha256·source_revision을 정확히 반환한다. "
        "1차 추출의 미해결 문맥은 diagnostics에 남긴다. 1차 추출의 resolutions와 unresolved_concerns는 빈 배열이다. "
        "근거는 전체 원문에서 실제 발생 위치를 구별할 수 있는 충분한 연속 인용으로 선택한다. "
        "원문의 실제 의미를 텍스트 속성이나 다른 실제 주장으로 보존했지만 전용 관계·정량 연산이 없는 표현 한계는 "
        "schema_limit finding으로 남긴다. 이 finding에는 실제 원문 인용과 보존한 그래프 항목의 target이 있어야 한다. "
        "omissions에 표현 한계를 기록하면 해당 문자열을 schema_limit finding.reason과 정확히 동일하게 보존한다. "
        "단순 개체 이름이나 근거 인용만 추가해 내용이 보존되었다고 간주하지 않는다. "
        "실제 미확인·내용 누락·해석 불명은 표현 한계로 바꾸지 않는다. "
        "발행 진단 스키마가 v1을 허용하면 이러한 표현 한계는 v1 보고로 보존할 수 있다. "
        "v2의 실패한 규칙 판정을 통과로 바꾸지 않는다. "
        "같은 이름만으로 서로 다른 실체를 합치지 않는다. 경계에서 문맥이 부족하면 진단에 남긴다.\n")
    if graph is not None:
        instruction += (("앞선 구간까지 보존한 " if phase == "extract" else "모든 구간의 추출을 모은 ")
            + "data/segmented-graph.json이 있다. 이 그래프는 검토할 자료다. "
            "각 컬렉션의 기존 항목·순서·ID·한정어·근거는 모두 정확히 보존하고 새 항목만 끝에 추가한다. "
            "앞선 개체와 같은 실체라는 원문 근거가 있으면 그 ID를 사용하고, 이름만 같으면 동일하다고 추정하지 않는다. "
            "전체 개체 목록과 이번 원문 범위를 대조하여 다른 구간의 개체와 연결되는 명시적 관계, "
            "대명사·표 머리글·조건·예외·상호 참조가 빠졌는지 확인한다. 새 항목의 근거는 이번 범위 안에 있어야 한다. "
            "기존 항목에 수정·삭제·동일 실체 통합이 필요하면 임의로 바꾸지 말고 diagnostics.omissions에 이유를 남긴다. "
            "submission에는 기존 항목을 포함한 전체 그래프를 반환한다. 새로운 추정 관계로 빈 곳을 메우지 않는다.\n")
    if initial_report is not None:
        instruction += ("data/initial-diagnostics.json은 이 범위의 첫 추출 때 남긴 원래 의견이다. "
            "전체 누적 그래프와 원문을 보고 각 concern을 반드시 다시 확인한다. "
            "해결한 항목마다 resolutions에 concern_id, 해결 이유 reason, 이번 diagnostics.findings의 finding_index를 반환한다. "
            "연결한 finding은 supported이며 실제 원문 quote와 정확한 줄 범위를 포함해야 한다. "
            "초기 omission 또는 finding concern은 실제 주장을 그래프에 보존한 schema_limit finding으로도 연결할 수 있다. "
            "이때 실제 원문 인용과 보존한 항목의 target, 동일한 omissions 문자열과 finding.reason을 남긴다. "
            "이는 표현 한계의 보존이며 의미를 완전히 표현했다는 승인이 아니다. unread 또는 rule concern은 supported 근거가 필요하다. "
            "단지 해결했다고 선언하거나 초기 의견을 지워서는 안 된다. 해결하지 못했으면 그 concern_id를 "
            "unresolved_concerns에 넣고 diagnostics에도 미해결 이유를 남긴다. 해결할 수 없는데 해결된 근거나 관계를 발명하지 않는다. "
            "모든 초기 concern_id는 resolutions 또는 unresolved_concerns 중 정확히 한 곳에 있어야 한다. "
            "초기 concerns가 없으면 두 배열 모두 비운다. 이번 diagnostics는 ai_self_check로 이번 원문 범위의 "
            "모든 줄을 실제 검토한 reviewed_ranges를 보고하며 확인하지 못한 범위는 숨기지 않는다.\n")
    if audit is not None:
        instruction += SELECTION_GUIDANCE
    if view_audit is not None:
        instruction += REVIEW_HISTORY_REPORTING_INSTRUCTIONS
    prompt = (instruction + "\nPUBLISHED_RULES\n" + canonical_json_bytes(trusted).decode("utf-8")
              + "\nFIXED_INPUT_DATA\n" + canonical_json_bytes({"manifest": view_manifest,
                                                               "components": view_data}).decode("utf-8"))
    if len(prompt.encode("utf-8")) > MAX_INPUT_BYTES:
        raise AnalysisClientError("segmented_context_limit")
    return {"prompt": prompt, "schema": schema, "cli_schema": deepcopy(schema), "identity": identity,
            "assembly": {"policy": POLICY, "phase": phase, "segment": segment, "source_revision": revision,
                "prompt_sha256": sha256(prompt.encode("utf-8")).hexdigest(),
                "schema_sha256": canonical_json_hash(schema),
                "published_schema_sha256": sha256(components["rules/submission.schema.json"].encode()).hexdigest(),
                "initial_diagnostics_sha256": None if initial_report is None else canonical_json_hash(initial_report),
                "input_graph_sha256": None if graph is None else canonical_json_hash(graph)}}
