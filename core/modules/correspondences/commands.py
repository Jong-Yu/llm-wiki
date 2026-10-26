"""같은 잠금에서 준비 기준을 재확인하고 제안·검토·업무 판단을 새 이벤트로 저장한다.

owner는 공용 Store의 저장소·actor·같은 잠금 안의 협력 메서드만 전달한다.
파일 I/O와 잠금의 경계는 기존 호출 순서를 유지한다.
"""

# propose는 새 대응 제안을 만들고 review/policy 계열은 기존 제안의 판단을 새 이벤트로 기록한다.
# prepare 때 받은 token과 실제 저장 직전의 변경·근거 버전을 다시 비교하므로 옛 입력의 token만 바꿔 재전송할 수 없다.

from . import identifiers
from . import schema
from .capture import _Capture
from .contracts import CorrespondenceConflictError
from .contracts import CorrespondenceValidationError
from .state import _states
from .state import _values
from copy import deepcopy
from hashlib import sha256


def propose(owner, correspondence_id, draft, expected_state_revision, reason):
    # 아직 확정되지 않은 새 대응을 제안 상태로 저장한다. 현재 사용자가 선택한 준비 근거를 다시 확인한다.
    schema.token(expected_state_revision, "expected_state_revision")
    schema.text(reason, "reason")
    draft = schema.value_schema(draft, owner.store)
    if draft["basis"]["kind"] == "expert":
        raise CorrespondenceValidationError("proposal cannot create expert policy")
    cleanup = []
    try:
        with owner.store._write_lock():
            ctx = _Capture(owner)
            raw, existing = ctx.ledger(correspondence_id)
            deps = ctx.collect([draft], correspondence_id)
            current = owner._token(correspondence_id, None if raw is None else sha256(raw).hexdigest(), deps, "draft", draft)
            if existing is not None or current != expected_state_revision:
                raise CorrespondenceConflictError(correspondence_id, expected_state_revision, current)
            if not owner._complete(deps):
                raise CorrespondenceValidationError("All proposal dependencies must be available")
            owner._validate_value(draft, ctx, correspondence_id)
            event_id = identifiers.new_id()
            after = {"value": draft, "decision": "unreviewed", "basis_dependencies": deepcopy(deps), "policy_scope": None, "supersedes_event_id": None, "origin_event_id": event_id}
            event = owner._event(event_id, 1, "propose", "source", None, None, after, reason, deps, expected_state_revision, None, None)
            ledger = {"version": 1, "tenant": owner.actor["tenant"], "correspondence_id": correspondence_id, "documents": {name: draft[name]["document"] for name in ("condition", "concept")}, "events": [event]}
            result = owner._finish(correspondence_id, ledger, event, ctx, False, cleanup)
    except Exception as error:
        if cleanup:
            error.cleanup_failures = tuple(cleanup)
        raise
    return owner._cleanup(result, cleanup, owner.store)


def _mutate(owner, cid, operation, change, expected):
    """같은 잠금에서 의존 상태와 변경 token을 재검사하고 검토/판단의 새 이벤트를 공개한다."""
    # 준비 때의 정확한 변경/의존 token을 최신 관측과 대조한 뒤 새 판단 이벤트를 추가한다.
    schema.token(expected, "expected_state_revision")
    change = owner._change(operation, change)
    cleanup = []
    try:
        with owner.store._write_lock():
            ctx = _Capture(owner)
            raw, ledger = ctx.ledger(cid)
            if ledger is None:
                raise FileNotFoundError("Correspondence not found")
            # Recompute both permitted token forms; never guess token kind from a hash.
            plan, deps, prepared = owner._prepared(cid, raw, ledger, operation, change, ctx, validate=False)
            allowed = [prepared] if prepared is not None else []
            if operation == "review" and change["action"] in {"accept", "reject", "defer"}:
                snapshot_deps = ctx.collect(_values(_states(ledger)), cid)
                if owner._complete(snapshot_deps):
                    allowed.append(owner._token(cid, sha256(raw).hexdigest(), snapshot_deps, "snapshot", {"states": [event["after"] for event in _states(ledger).values()]}))
            if expected not in allowed:
                raise CorrespondenceConflictError(cid, expected, prepared)
            lane, judgment, before, after, undo = owner._plan(cid, ledger, operation, change)
            if operation == "policy" or (operation == "review" and change["action"] in {"accept", "edit"}):
                owner._validate_value(after["value"], ctx, cid)
            eid = identifiers.new_id()
            if undo is None:
                after["basis_dependencies"] = ctx.collect([after["value"]], cid)
                after["origin_event_id"] = eid
            # Undo deliberately preserves the old basis and provenance.
            if lane == "expert" and judgment is None:
                judgment = identifiers.new_id()
            event = owner._event(eid, len(ledger["events"]) + 1, operation, lane, judgment, before, after, change["reason"], deps, expected, undo, ledger["events"][-1]["hash"])
            ledger["events"].append(event)
            result = owner._finish(cid, ledger, event, ctx, True, cleanup)
    except Exception as error:
        if cleanup:
            error.cleanup_failures = tuple(cleanup)
        raise
    return owner._cleanup(result, cleanup, owner.store)


def review(owner, correspondence_id, action, expected_state_revision, reason, replacement=None, decision=None):
    return owner._mutate(correspondence_id, "review", {"action": action, "reason": reason, "replacement": replacement, "decision": decision}, expected_state_revision)


def review_undo(owner, correspondence_id, event_id, expected_state_revision, reason):
    return owner._mutate(correspondence_id, "review_undo", {"event_id": event_id, "reason": reason}, expected_state_revision)


def policy(owner, correspondence_id, replacement, expected_state_revision, reason, judgment_id=None, supersedes_event_id=None):
    return owner._mutate(correspondence_id, "policy", {"replacement": replacement, "reason": reason, "judgment_id": judgment_id, "supersedes_event_id": supersedes_event_id}, expected_state_revision)


def policy_undo(owner, correspondence_id, event_id, expected_state_revision, reason):
    return owner._mutate(correspondence_id, "policy_undo", {"event_id": event_id, "reason": reason}, expected_state_revision)
