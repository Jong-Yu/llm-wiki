"""명시 선택한 모델 입력 보기. 서버의 불변 입력·전체 원장은 수정하지 않는다."""
from copy import deepcopy
import json

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.client.transport import AnalysisClientError

INPUT_VIEWS = ("full", "current-review-v1")


REVIEW_HISTORY_REPORTING_POLICY = "review-history-reporting-v1"
REVIEW_HISTORY_REPORTING_INSTRUCTIONS = (
    "이 실행은 current-review-v1 입력 보기를 명시적으로 사용한다. "
    "manifest.model_input_view와 아래 조립 경고는 검증된 입력 보기의 선택 기록이다. "
    "omitted_history_event_ids에 열거된 과거 검토 이벤트의 본문 제외만으로 "
    "대상 원문이나 현재 판단 근거를 읽지 못했다고 보고하지 않는다. "
    "이 제외가 있으면 diagnostics.warnings에 과거 이력의 일부가 제공되지 않았다는 보기 한계를 남긴다. "
    "과거 이력을 모두 읽었다고 주장하거나 제외된 판단을 현재 판단으로 승계하지 않는다. "
    "대상 원문·선택 맥락·현재 판단의 필수 근거를 실제로 읽지 못한 경우에는 "
    "보기 경고와 별개로 해당 범위와 이유를 diagnostics.unread_ranges에 반드시 남긴다. "
    "원문의 내용 누락·표현 한계도 기존 진단 규약대로 별도로 보고한다. "
    "입력 보기는 실제 미독이나 의미 누락을 숨기는 근거가 아니다."
)
REVIEW_HISTORY_WARNING = (
    "current-review-v1 입력 보기에서 현재 판단에 필요하지 않은 과거 검토 이벤트 "
    "{count}개의 본문을 제외했다. 이벤트 ID와 판본은 view_audit에 보존하며 전체 이력을 읽은 것으로 표시하지 않는다."
)


def reporting_configuration(view):
    """조립 전 재사용 판정에서도 동일한 보고 지침 버전/바이트를 비교한다."""
    if view == "full":
        return None
    if view != "current-review-v1":
        raise AnalysisClientError("invalid_input_view")
    return {"version": REVIEW_HISTORY_REPORTING_POLICY,
            "template_sha256": canonical_json_hash({"instructions": REVIEW_HISTORY_REPORTING_INSTRUCTIONS,
                                                    "warning": REVIEW_HISTORY_WARNING})}


def reporting_warnings(audit):
    """조립기가 확인한 제외 이력만 경고한다. 모델의 unread 보고는 변경하지 않는다."""
    count = sum(len(row["omitted_history_event_ids"]) for row in audit["documents"])
    return [REVIEW_HISTORY_WARNING.format(count=count)] if count else []


def project(manifest, data, view, *, bundle_revision):
    """전체 본문/유효 그래프/모든 관점의 최신 정책과 현재 판단 근거를 보존한다.

    과거 이벤트 본문은 명시적으로 제외한다. pending ID/정책값/누락 목록은
    남기며 현재 판단으로 승계하지 않는다. 문자열 절단이나 의미 요약은 없다.
    """
    if view not in INPUT_VIEWS:
        raise AnalysisClientError("invalid_input_view")
    if view == "full":
        return manifest, data, None
    projected, projected_data = deepcopy(manifest), dict(data)
    # 등록 입력의 저장용 참조에도 같은 review가 들어 있다. 모델에는 한 번만 보낸다.
    projected.pop("component_references", None)
    # 원본 구성 hash를 투영한 자료의 hash처럼 표시하지 않는다.
    if "components" in projected:
        projected["original_component_descriptors"] = projected.pop("components")
    selections = []
    try:
        context = json.loads(data["data/context.json"])
        for row in context["documents"]:
            current = row.get("review")
            if current is None:
                continue
            events = {event["id"]: event for event in current["history"]}
            needed = {claim["review_event_id"] for claim in current["claims"]
                      if claim["review_event_id"] is not None}
            for policy in current["policies"]:
                # 최신 다른 관점/보류 정책도 조건을 잃지 않게 유지한다.
                needed.update(value for value in (policy["event_id"], policy["decision_event_id"])
                              if value is not None)
            if not needed <= events.keys():
                raise AnalysisClientError("invalid_review_input")
            for event_id in list(needed):
                event = events[event_id]
                if event["action"] == "undo":
                    # 되돌림으로 복구된 판단의 원래 이유도 읽을 수 있게 해당 주장/세대의
                    # 이력을 보수적으로 포함한다. 다른 세대의 승인을 가져오지는 않는다.
                    needed.update(prior["id"] for prior in current["history"]
                                  if prior["claim_id"] == event["claim_id"] and all(
                                      prior[key] == event[key] for key in
                                      ("source_revision", "graph_revision", "history_revision")))
            claims = []
            for claim in current["claims"]:
                value = deepcopy(claim)
                if claim["decision"] == "unreviewed" and claim["review_event_id"] is None:
                    # 이 값은 effective_graph에 전체 한정어·근거와 함께 이미 포함된다.
                    value.pop("value", None)
                    value.pop("reviewed_value", None)
                claims.append(value)
            omitted = [event["id"] for event in current["history"] if event["id"] not in needed]
            review = {key: deepcopy(value) for key, value in current.items()
                      if key not in {"machine_graph", "claims", "current_claims", "history"}}
            review.update(claims=claims, history=[event for event in current["history"] if event["id"] in needed],
                          machine_status={key: current["machine_graph"][key] for key in
                                          ("status", "needs_reextraction", "schema_version", "error")
                                          if key in current["machine_graph"]},
                          input_view={"version": view, "omitted_history_event_ids": omitted,
                                      "history_complete": not omitted,
                                      "automatic_decision_transfer": False})
            row["review"] = review
            selections.append({"document": row["document"], "reason": row["reason"],
                               "state_revision": current["state_revision"],
                               "included_event_ids": sorted(needed), "omitted_history_event_ids": omitted})
        projected_data["data/context.json"] = canonical_json_bytes(context).decode("utf-8")
    except (KeyError, TypeError, ValueError) as error:
        raise AnalysisClientError("invalid_review_input") from error
    selection = {"version": view, "documents": selections,
                 "source_text": "complete_selected_documents", "rules": "complete_published_release",
                 "graph": "complete_effective_graph_and_current_review_decisions",
                 "automatic_context_expansion": False, "related_documents_exhaustive": False,
                 "historical_decisions_are_current": False,
                 "full_input_retained": True, "bundle_revision": bundle_revision}
    from hashlib import sha256
    selection["component_descriptors"] = {
        name: {"sha256": sha256(value.encode("utf-8")).hexdigest(), "size_bytes": len(value.encode("utf-8"))}
        for name, value in projected_data.items()}
    # 이 manifest는 원본 manifest가 아닌 명시 투영이다. 원본 hash로 이를 검증하지 않는다.
    projected["model_input_view"] = selection
    audit = {**selection, "view_sha256": canonical_json_hash({"manifest": projected, "components": projected_data})}
    return projected, projected_data, audit
