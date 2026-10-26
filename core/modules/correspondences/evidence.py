"""대응 양끝점과 명시 참조의 실제 인용·현재 그래프·검토 근거를 확인한다.

owner는 공용 Store의 저장소·actor·같은 잠금 안의 협력 메서드만 전달한다.
파일 I/O와 잠금의 경계는 기존 호출 순서를 유지한다.
"""

# anchor는 문서·원문 버전·연속 인용·줄 위치를 가진 근거 참조다.
# _validate_value는 양 끝점과 인용뿐 아니라 참조한 그래프/검토/정책의 정확한 의미 사본도 현재와 대조한다.

from . import schema
from .contracts import CorrespondenceValidationError
from .state import _scope
from .state import _states
from hashlib import sha256


def _validate_anchor(owner, anchor, ctx):
    # 인용이 지정 원문 revision의 실제 줄/발생 위치에 있는지 검사한다. 같은 문구의 다른 발생 위치와 섞지 않는다.
    captured = ctx.document(anchor["document"], "graph_ref" in anchor)
    if captured["row"]["source_revision"] != anchor["source_revision"]:
        raise CorrespondenceValidationError("Anchor source changed; re-read and reconcile its full meaning")
    content = captured["content"]
    if content is None:
        raise CorrespondenceValidationError("Anchor source is missing")
    lines = content.splitlines(keepends=True)
    start, end = anchor["start_line"], anchor["end_line"]
    if end > len(lines):
        raise CorrespondenceValidationError("Anchor line range is outside source")
    section = "".join(lines[start - 1:end])
    quote = anchor["quote"]
    offsets, position = [], 0
    while True:
        position = section.find(quote, position)
        if position < 0:
            break
        # The quote must actually start/end on the stated lines.
        if section[:position].count("\n") == 0 and section[:position + len(quote)].rstrip("\r\n").count("\n") == end - start:
            offsets.append(position)
        position += 1
    occurrence = anchor.get("occurrence", 0)
    if not offsets or occurrence >= len(offsets) or (len(offsets) > 1 and "occurrence" not in anchor):
        raise CorrespondenceValidationError("Anchor quote/line/occurrence does not match the current source")
    if "graph_ref" in anchor:
        owner._validate_graph(anchor["document"], anchor["graph_ref"], ctx)


def _validate_graph(owner, document, ref, ctx):
    captured = ctx.document(document, True)
    row, snap = captured["full"], captured["snapshot"]
    if row["graph_revision"] != ref["graph_revision"] or row["state_revision"] != ref["state_revision"] or snap is None or snap["status"] != "ready":
        raise CorrespondenceValidationError("Referenced graph/state is no longer current")
    if ref["collection"] == "entities":
        graph = snap["machine_graph" if ref["layer"] == "machine" else "effective_graph"]
        matches = [entity for entity in graph["entities"] if entity["id"] == ref["entity_id"]]
    else:
        claims = [claim for claim in snap["claims"] if claim["collection"] == ref["collection"] and claim["claim_id"] == ref["claim_id"] and not claim["ambiguous"]]
        matches = [claim["value"] if ref["layer"] == "machine" else claim["reviewed_value"] for claim in claims if ref["layer"] == "machine" or claim["decision"] not in {"reject", "defer"}]
    if len(matches) != 1 or matches[0] != ref["snapshot"]:
        raise CorrespondenceValidationError("Referenced graph meaning snapshot differs")


def _validate_value(owner, value, ctx, cid):
    # 끝점·연결 근거·참조한 판단의 의미 사본이 현재와 같은지 확인한다. 단순히 참조 ID가 존재하는지만 보지 않는다.
    for anchor in [value["condition"], value["concept"], *value["basis"]["link_evidence"]]:
        owner._validate_anchor(anchor, ctx)
    for ref in value["references"]:
        if ref["kind"] == "graph":
            owner._validate_graph(ref["document"], ref["graph_ref"], ctx)
        elif ref["kind"] in {"review", "policy"}:
            captured = ctx.document(ref["document"], True)
            snap = captured["snapshot"]
            if snap is None or snap["state_revision"] != ref["state_revision"] or snap["status"] != "ready":
                raise CorrespondenceValidationError("Referenced document judgment is not current")
            event = next((event for event in snap["history"] if event["id"] == ref["event_id"]), None)
            if event is None or event["after"] != ref["snapshot"]:
                raise CorrespondenceValidationError("Document action snapshot differs")
            if ref["kind"] == "policy":
                policy = next((policy for policy in snap["policies"] if policy["event_id"] == ref["event_id"]), None)
                if policy is None or policy["status"] != "active" or policy["scope"] != ref["scope"] or ref["scope"] != _scope(owner.actor):
                    raise CorrespondenceValidationError("Referenced policy is inactive or outside its exact scope")
            elif event["action"] in {"policy", "policy_undo"} or not any(claim["review_event_id"] == event["id"] and claim["decision"] in {"accept", "edit"} for claim in snap["claims"]):
                raise CorrespondenceValidationError("Referenced source review is not the current accepted judgment")
        else:
            raw, ledger = ctx.ledger(ref["correspondence_id"])
            if ledger is None or sha256(raw).hexdigest() != ref["correspondence_revision"]:
                raise CorrespondenceValidationError("Referenced correspondence revision differs")
            event = next((event for event in ledger["events"] if event["id"] == ref["event_id"]), None)
            if event is None or _states(ledger).get((event["lane"], event["judgment_id"])) is not event or event["after"] != ref["snapshot"] or event["after"]["policy_scope"] != ref["scope"]:
                raise CorrespondenceValidationError("Referenced correspondence judgment snapshot differs")
            owner._preserve_reference_scope(value, event["after"]["value"])
            previous_context = ctx.application_context
            # Writes have no caller query context: explicit judgment scope is
            # the only supported basis for applying a referenced precedent.
            ctx.application_context = {axis["name"]: axis["value"] for axis in value["business_scope"]["axes"] if axis["status"] == "specified"}
            try:
                applicable = next(item for item in owner._judgments(ledger, ctx, ref["correspondence_id"], stack=[cid, ref["correspondence_id"]]) if item["event_id"] == event["id"])
            finally:
                ctx.application_context = previous_context
            if applicable["applicability"] != "applicable":
                raise CorrespondenceValidationError("Referenced correspondence is not currently applicable within the explicit judgment scope")


def _preserve_reference_scope(parent, child):
    # 참조한 정책/대응의 적용 범위를 새 주장으로 옮길 때 조용히 넓히거나 잃지 않도록 검사한다.
    axes = {axis["name"]: axis for axis in parent["business_scope"]["axes"]}
    for axis in child["business_scope"]["axes"]:
        if axis["status"] == "unknown":
            raise CorrespondenceValidationError("Referenced judgment has an unresolved business scope")
        if axis["status"] == "specified" and (axis["name"] not in axes or axes[axis["name"]]["status"] != "specified" or axes[axis["name"]]["value"] != axis["value"]):
            raise CorrespondenceValidationError("Reference business scope must remain an explicit restriction")
    for name in ("conditions", "exceptions"):
        child_conditions, parent_conditions = child["qualifiers"][name], parent["qualifiers"][name]
        if child_conditions["status"] == "unknown" or (child_conditions["status"] == "specified" and (parent_conditions["status"] != "specified" or not set(child_conditions["items"]) <= set(parent_conditions["items"]))):
            raise CorrespondenceValidationError("Referenced conditions/exceptions must remain explicit")
    child_period, parent_period = child["business_scope"]["validity"], parent["business_scope"]["validity"]
    if child_period["status"] == "unknown":
        raise CorrespondenceValidationError("Referenced validity is unresolved")
    if child_period["status"] == "specified":
        if parent_period["status"] != "specified":
            raise CorrespondenceValidationError("Referenced period cannot be broadened")
        for boundary, sign in (("start", 1), ("end", -1)):
            difference = (schema.instant(parent_period[boundary]) - schema.instant(child_period[boundary])).total_seconds() * sign
            if difference < 0 or (difference == 0 and parent_period[boundary + "_inclusive"] and not child_period[boundary + "_inclusive"]):
                raise CorrespondenceValidationError("Referenced period boundaries cannot be broadened")
