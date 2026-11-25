"""누적 그래프의 안정된 대상 번호와 원문 좌표를 유지하며 최종 진단을 합친다."""

from copy import deepcopy

from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_results.diagnostics import MAX_DIAGNOSTIC_BYTES, SEMANTIC_RULES


def retained_schema_limit(finding, submission=None):
    """표현 한계는 실제 원문과 보존한 그래프 항목을 함께 가리킬 때만 구분한다."""
    source, target = finding.get("source"), finding.get("target")
    if (finding.get("verdict") != "schema_limit" or type(source) is not dict
            or type(source.get("quote")) is not str or not source["quote"].strip() or type(target) is not dict
            or target.get("collection") not in {"entities", "relations", "attributes", "relation_candidates"}
            or type(target.get("index")) is not int or target["index"] < 0):
        return False
    if type(submission) is not dict:
        return False
    items = submission.get(target["collection"])
    if (type(items) is not list or target["index"] >= len(items)
            or type(items[target["index"]]) is not dict):
        return False
    evidence = items[target["index"]].get("evidence")
    # 한계의 실제 인용 전체가 보존한 주장 근거에 있어야 한다. 반대 방향으로
    # 짧은 이름만 포함된다고 인정하면 서로 무관한 개체에 누락을 붙일 수 있다.
    return type(evidence) is str and source["quote"] in evidence


def require_complete(report, *, unresolved=(), submission=None):
    """실제 누락은 막고, 이미 보존한 주장의 명시적 표현 한계는 그대로 남긴다."""
    limits = [item for item in report["findings"] if retained_schema_limit(item, submission)]
    reasons = {item["reason"] for item in limits}
    if (unresolved or report["unread_ranges"] or any(text not in reasons for text in report["omissions"])
            or any(item["verdict"] != "supported" and item not in limits for item in report["findings"])
            or any(item["status"] in {"fail", "error"} for item in report.get("rule_results", []))):
        raise AnalysisClientError("segmented_review_incomplete")


def concerns(report):
    """초기 미해결 의견의 안정된 번호를 원래 진단 값과 함께 반환한다."""
    if report is None:
        return []
    result = [{"id": f"omission:{index}", "value": value} for index, value in enumerate(report["omissions"])]
    result += [{"id": f"unread:{index}", "value": value} for index, value in enumerate(report["unread_ranges"])]
    result += [{"id": f"finding:{index}", "value": value} for index, value in enumerate(report["findings"])
               if value["verdict"] != "supported"]
    result += [{"id": f"rule:{value['rule_id']}", "value": value} for value in report.get("rule_results", [])
               if value["status"] in {"fail", "error"}]
    return result


def merge(reports, *, initial_warnings=(), submission=None):
    """기존 배열 접두부를 보존한 보고만 합치며 한도를 넘으면 진단을 잘라내지 않는다."""
    result = {"schema_version": 1, "reviewer_kind": "ai_self_check", "warnings": [],
              "omissions": [], "unread_ranges": [], "reviewed_ranges": [], "findings": []}
    result["warnings"] = list(dict.fromkeys(initial_warnings))
    rules = {name: [] for name in SEMANTIC_RULES}
    has_v2 = False
    ranges = []
    for report in reports:
        require_complete(report, submission=submission)
        if report["reviewer_kind"] != "ai_self_check" or not report["reviewed_ranges"]:
            raise AnalysisClientError("segmented_review_incomplete")
        finding_map = {}
        for key in ("warnings", "omissions", "unread_ranges"):
            for text in report[key]:
                if text not in result[key]:
                    result[key].append(text)
        ranges.extend((item["start_line"], item["end_line"]) for item in report["reviewed_ranges"])
        for index, item in enumerate(report["findings"]):
            finding = deepcopy(item)
            if finding not in result["findings"]:
                result["findings"].append(finding)
            finding_map[index] = result["findings"].index(finding)
        if report["schema_version"] == 2:
            has_v2 = True
            if report["semantic_check"] is not None:
                raise AnalysisClientError("segmented_diagnostic_mismatch")
            for item in report["rule_results"]:
                rules[item["rule_id"]].append({**item,
                    "finding_indices": [finding_map[index] for index in item["finding_indices"]]})
    combined = []
    for start, end in sorted(ranges):
        if combined and start <= combined[-1][1] + 1:
            combined[-1][1] = max(combined[-1][1], end)
        else:
            combined.append([start, end])
    result["reviewed_ranges"] = [{"start_line": start, "end_line": end} for start, end in combined]
    if has_v2:
        result.update(schema_version=2, semantic_check=None, rule_results=[])
        for name in SEMANTIC_RULES:
            values = rules[name]
            if len(values) != len(reports):
                # v1 보고에는 규칙별 판정이 없다. 일부 판정을 전체 통과로 승격하지 않는다.
                result["rule_results"].append({"rule_id": name, "status": "not_run",
                    "reason": "일부 구간에는 규칙별 판정이 없어 전체 문서 판정을 확정하지 않았습니다.",
                    "finding_indices": sorted({index for value in values for index in value["finding_indices"]})})
                continue
            statuses = {value["status"] for value in values}
            status = next((candidate for candidate in ("fail", "error", "not_run", "pass")
                           if candidate in statuses), "not_applicable")
            reasons = list(dict.fromkeys(value["reason"] for value in values))
            reason = "\n".join(reasons)
            if len(reason) > 2000:
                raise AnalysisClientError("segmented_diagnostic_limit")
            result["rule_results"].append({"rule_id": name, "status": status, "reason": reason,
                "finding_indices": sorted({index for value in values for index in value["finding_indices"]})})
    if (any(len(result[key]) > 100 for key in ("warnings", "omissions", "unread_ranges", "reviewed_ranges", "findings"))
            or len(canonical_json_bytes(result)) > MAX_DIAGNOSTIC_BYTES):
        raise AnalysisClientError("segmented_diagnostic_limit")
    return result
