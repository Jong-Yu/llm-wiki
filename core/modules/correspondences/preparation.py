"""변경 내용을 정규화하고 실제 의존 버전에 묶인 읽기 전용 준비 token을 만든다.

owner는 공용 Store의 저장소·actor·같은 잠금 안의 협력 메서드만 전달한다.
파일 I/O와 잠금의 경계는 기존 호출 순서를 유지한다.
"""

# prepare는 아직 원장을 쓰지 않고 요청한 변경과 현재 근거에 연결된 state_revision을 발급한다.
# _plan은 적용 전/후 상태를 계산하고 _prepared는 실제 의존 버전과 함께 token을 만든다. 준비 성공 자체가 저장 성공은 아니다.

from . import contracts as limits
from . import schema
from .capture import _Capture
from .contracts import CorrespondenceLimitError
from .contracts import CorrespondenceValidationError
from .state import _scope
from .state import _states
from .state import _values
from copy import deepcopy
from core.common.json_codec import canonical_json_bytes as _encode
from core.common.json_codec import canonical_json_hash as _hash
from hashlib import sha256


def _change(owner, operation, change):
    if operation not in {"review", "review_undo", "policy", "policy_undo"}:
        raise CorrespondenceValidationError("unsupported prepare operation")
    if operation == "review":
        schema.fields(change, {"action", "reason"}, {"replacement", "decision"}, "review change")
        change = {"replacement": None, "decision": None, **deepcopy(change)}
        if change["action"] not in {"accept", "reject", "defer", "edit"}:
            raise CorrespondenceValidationError("unsupported review action")
        if change["action"] == "edit":
            if change["replacement"] is None or change["decision"] not in {"accepted", "deferred"}:
                raise CorrespondenceValidationError("edit requires full replacement and accepted/deferred decision")
        elif change["replacement"] is not None or change["decision"] is not None:
            raise CorrespondenceValidationError("only edit accepts replacement/decision")
    elif operation == "policy":
        schema.fields(change, {"replacement", "reason"}, {"judgment_id", "supersedes_event_id"}, "policy change")
        change = {"judgment_id": None, "supersedes_event_id": None, **deepcopy(change)}
        for name in ("judgment_id", "supersedes_event_id"):
            if change[name] is not None:
                schema.identifier(change[name], name)
    else:
        schema.fields(change, {"event_id", "reason"}, name="undo change")
        change = deepcopy(change)
        schema.identifier(change["event_id"], "event_id")
    schema.text(change["reason"], "reason")
    return change


def _plan(owner, cid, ledger, operation, change, *, validate_actor=True):
    # 요청한 변경을 적용하기 전/후의 상태와 되돌림 대상을 계산한다. 아직 파일을 저장하지 않는다.
    states = _states(ledger)
    target, undo = None, None
    if operation == "review":
        lane, judgment = "source", None
        previous = states[(lane, judgment)]
        before = deepcopy(previous["after"])
        after = deepcopy(before)
        after["decision"] = {"accept": "accepted", "reject": "rejected", "defer": "deferred"}.get(change["action"], change["decision"])
        if change["replacement"] is not None:
            after["value"] = schema.value_schema(change["replacement"], owner.store, ledger["documents"])
        if after["value"]["basis"]["kind"] == "expert" or (after["decision"] == "accepted" and after["value"]["basis"]["kind"] != "source"):
            raise CorrespondenceValidationError("source acceptance requires actual linking evidence; experts use policy")
    elif operation == "policy":
        lane, judgment = "expert", change["judgment_id"]
        replacement = schema.value_schema(change["replacement"], owner.store, ledger["documents"])
        if replacement["basis"]["kind"] != "expert":
            raise CorrespondenceValidationError("policy replacement requires basis expert without link evidence")
        previous = None if judgment is None else states.get((lane, judgment))
        if judgment is not None and previous is None:
            raise CorrespondenceValidationError("judgment_id does not exist")
        before = owner._inactive(_scope(owner.actor)) if previous is None else deepcopy(previous["after"])
        if validate_actor and before["policy_scope"] != _scope(owner.actor):
            raise CorrespondenceValidationError("policy belongs to another exact domain/viewpoint")
        if previous is not None:
            first = next(item for item in ledger["events"] if item["lane"] == "expert" and item["judgment_id"] == judgment)
            if replacement["business_scope"] != first["after"]["value"]["business_scope"] or change["supersedes_event_id"] != previous["id"]:
                raise CorrespondenceValidationError("existing judgment requires fixed scope and latest explicit supersedes_event_id")
        supersedes = change["supersedes_event_id"]
        if supersedes is not None:
            target = next((event for event in states.values() if event["id"] == supersedes), None)
            if target is None or target["after"]["value"] is None or target["after"]["value"]["business_scope"] != replacement["business_scope"]:
                raise CorrespondenceValidationError("supersession requires latest judgment and exact business scope")
            if validate_actor and target["lane"] == "expert" and target["after"]["policy_scope"] != _scope(owner.actor):
                raise CorrespondenceValidationError("cannot supersede another exact policy scope")
        source = states[("source", None)]
        if source["after"]["decision"] == "accepted" and source["after"]["value"]["business_scope"] == replacement["business_scope"] and previous is None and supersedes != source["id"]:
            raise CorrespondenceValidationError("replacing accepted source requires its latest explicit event")
        after = {"value": replacement, "decision": "active", "basis_dependencies": deepcopy(limits._EMPTY), "policy_scope": _scope(owner.actor), "supersedes_event_id": supersedes, "origin_event_id": None}
    else:
        undo = next((event for event in ledger["events"] if event["id"] == change["event_id"]), None)
        if undo is None or undo["action"] == "propose":
            raise CorrespondenceValidationError("undo requires an existing review/policy event")
        lane, judgment = undo["lane"], undo["judgment_id"]
        if (operation == "review_undo") != (lane == "source"):
            raise CorrespondenceValidationError("review and policy undo permissions cannot substitute")
        if states[(lane, judgment)] is not undo:
            raise CorrespondenceValidationError("undo only the latest event in this lane/judgment")
        before, after = deepcopy(undo["after"]), deepcopy(undo["before"])
        if validate_actor and lane == "expert" and before["policy_scope"] != _scope(owner.actor):
            raise CorrespondenceValidationError("undo requires the same exact policy scope")
    return lane, judgment, before, after, undo


def _prepared(owner, cid, raw, ledger, operation, change, ctx, *, validate=True):
    # 변경 내용과 모든 참조 자료의 현재 버전을 token에 함께 묶는다. 같은 문서라도 다른 변경의 token은 쓸 수 없다.
    plan = owner._plan(cid, ledger, operation, change, validate_actor=validate)
    values = [*_values(_states(ledger)), plan[2]["value"], plan[3]["value"]]
    deps = ctx.collect(values, cid)
    allow_missing = operation in {"review_undo", "policy_undo"} or (operation == "review" and change["action"] in {"reject", "defer"})
    complete = owner._complete(deps)
    if not complete and not allow_missing:
        return plan, deps, None
    if validate and (operation == "policy" or (operation == "review" and change["action"] in {"accept", "edit"})):
        owner._validate_value(plan[3]["value"], ctx, cid)
    token = owner._token(cid, sha256(raw).hexdigest(), deps, "change", {"operation": operation, "change": change})
    return plan, deps, token


def prepare(owner, correspondence_id, operation, change):
    """정확한 변경 내용과 현재 의존 버전에 연결된 token을 만들며 원장을 저장하지 않는다."""
    # operation/change를 받아 실제 의존 버전을 읽고 state_revision을 반환한다. 이 단계는 저장 승인이나 판단 완료를 뜻하지 않는다.
    change = owner._change(operation, change)
    with owner.store._write_lock():
        ctx = _Capture(owner)
        raw, ledger = ctx.ledger(correspondence_id)
        if ledger is None:
            raise FileNotFoundError("Correspondence not found")
        _, deps, token = owner._prepared(correspondence_id, raw, ledger, operation, change, ctx)
        complete = token is not None
        result = {"ok": True, "correspondence_id": correspondence_id, "correspondence_revision": sha256(raw).hexdigest(), "prepared_change": {"operation": operation, "change": change}, "payload_digest": _hash({"kind": "change", "payload": {"operation": operation, "change": change}}), "dependencies": deps, "access": deepcopy(owner.actor), "complete": complete, "truncated": False, "skipped": [] if complete else [{"reason": "missing_dependency"}]}
        if token is not None:
            result["state_revision"] = token
        if len(_encode(result)) > limits.MAX_DETAIL_BYTES:
            raise CorrespondenceLimitError("Prepared change exceeds detail response limit")
        return result
