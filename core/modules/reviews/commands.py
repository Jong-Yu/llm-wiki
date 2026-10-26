"""원문 근거 검토와 역이벤트를 같은 tenant 잠금 안에서 기록한다.

최신 복합 CAS·실제 인용·모든 유효 층을 검사한 뒤 원장 전체를 공개한다.
성공한 저장의 정리 경고를 쓰기 실패나 자동 재시도로 바꾸지 않는다.
"""

# review는 인용에 근거한 수용/수정/거절/보류의 입구이고 실제 기록은 _mutate가 맡는다.
# undo는 옛 이벤트를 지우지 않고 되돌림 이벤트를 더한다. reason은 판단 이유, actor는 서버가 확인한 실행 주체다.
from copy import deepcopy
from hashlib import sha256
from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_hash as _hash
from . import contracts, events
from .contracts import ReviewConflictError, ReviewValidationError
from .values import _token, _reason, _actor, _input, _target_entities
from .state import _is_policy, _epoch


def _mutate(self, document, *, action, claim_id, event_id, expected_state_revision,
            reason, actor, replacement, before_commit=None):
    """최신 복합 상태와 실제 인용을 확인한 뒤 원문 근거 검토를 새 이벤트로 기록한다."""
    # 입력/최신 상태를 확인하고 전후 상태를 복사해 새 이벤트를 만든 뒤 원장을 저장한다. 실패하면 기존 파일을 임의 초기화하지 않는다.
    _token(expected_state_revision, "expected_state_revision")
    _reason(reason)
    _actor(actor)
    self._path(document)
    cleanup_failures = []
    try:
        with self.store._write_lock():
            source, graph_raw, ledger, tokens = self._snapshot_locked(document)
            if tokens["state_revision"] != expected_state_revision:
                raise ReviewConflictError(document, expected_state_revision, tokens["state_revision"])
            snapshot = self._render(source, graph_raw, ledger, tokens, policies=False)
            if snapshot["status"] != "ready" or snapshot["machine_graph"].get("schema_version") not in (3, 4, 5, 6):
                raise ReviewValidationError("Review requires a current v3, v4 or v5 extraction")
            undone = None
            if action == "undo":
                undone = next((event for event in ledger["events"] if event["id"] == event_id), None)
                if undone is None or _is_policy(undone) or _epoch(undone) != _epoch(tokens):
                    raise ReviewValidationError("Undo requires an event in the current source/generation")
                claim_id = undone["claim_id"]
            claim = next((claim for claim in snapshot["claims"] if claim["claim_id"] == claim_id), None)
            if claim is None or claim["ambiguous"]:
                raise ReviewValidationError("Review target is missing or ambiguous")
            if undone is not None and claim["review_event_id"] != undone["id"]:
                raise ReviewValidationError("Undo only the latest event for this claim")
            before = {"decision": claim["decision"], "value": deepcopy(claim["reviewed_value"])}
            after = deepcopy(before)
            if action == "undo":
                after = deepcopy(undone["before"])
            else:
                after["decision"] = action
                if action in {"accept", "edit"}:
                    value = deepcopy(replacement) if action == "edit" else _input(before["value"])
                    if action == "accept" and claim["collection"] == "relation_candidates":
                        value = {key: item for key, item in value.items() if key not in {"id", "reason", "question"}}
                    after["value"] = self._normalize(source, snapshot["machine_graph"], claim["collection"], value)
            entities = _target_entities(claim["value"], snapshot["machine_graph"]["entities"])
            # A correction may refer to another existing source entity. Its
            # snapshot is retained too, so history remains readable after IDs change.
            for entity in _target_entities(before["value"], snapshot["machine_graph"]["entities"]) + _target_entities(after["value"], snapshot["machine_graph"]["entities"]):
                if entity["id"] not in {item["id"] for item in entities}:
                    entities.append(entity)
            event = {"id": events.uuid4().hex, "action": action, "claim_id": claim_id,
                     "collection": claim["collection"], "target": {"claim": deepcopy(claim["value"]), "entities": entities},
                     "before": before, "after": after, "reason": reason, "actor": deepcopy(actor),
                     "timestamp": events.datetime.now(events.timezone.utc).isoformat(),
                     **{name: tokens[name] for name in ("source_revision", "graph_revision", "history_revision")},
                     "undo_of": None if undone is None else undone["id"],
                     "previous_hash": None if not ledger["events"] else ledger["events"][-1]["hash"]}
            event["hash"] = _hash(event)
            ledger["events"].append(event)
            result = self._render(source, graph_raw, ledger, tokens, actor["domain"], actor["viewpoint"])
            self._validate_all_layers(source, graph_raw, ledger, tokens)
            # 긴 검증이나 잠금 대기 사이에 바뀐 권한도 실제 파일 공개 직전에 다시 확인한다.
            if before_commit is not None:
                before_commit()
            encoded = self._commit_locked(document, ledger, cleanup_failures)
            tokens["review_revision"] = sha256(encoded).hexdigest()
            tokens["state_revision"] = _hash({key: value for key, value in tokens.items() if key != "state_revision"})
            result = self._render(source, graph_raw, ledger, tokens, actor["domain"], actor["viewpoint"])
    except Exception as error:
        if cleanup_failures:
            error.cleanup_failures = tuple(cleanup_failures)
        raise
    return {**result, "event_id": event["id"], "changed": True,
            "cleanup_failures": cleanup_details(self.store.data_dir, cleanup_failures)}


def review(self, document, *, action, claim_id, expected_state_revision, reason, actor, replacement=None, before_commit=None):
    # action에 따라 수용/수정/거절/보류를 기록한다. edit만 교체값 replacement를 요구한다.
    if not isinstance(action, str) or action not in contracts._ACTIONS:
        raise ReviewValidationError("action must be accept, edit, reject, or defer")
    _token(claim_id, "claim_id")
    if (action == "edit") != (replacement is not None):
        raise ReviewValidationError("Only edit requires a replacement")
    return self._mutate(document, action=action, claim_id=claim_id, event_id=None,
                        expected_state_revision=expected_state_revision, reason=reason,
                        actor=actor, replacement=replacement, before_commit=before_commit)


def undo(self, document, *, event_id, expected_state_revision, reason, actor, before_commit=None):
    # event_id로 현재 주장의 마지막 판단을 골라 역이벤트를 추가한다. 옛 이벤트 파일을 삭제하는 동작이 아니다.
    if not isinstance(event_id, str) or not contracts._UUID.fullmatch(event_id):
        raise ReviewValidationError("event_id must identify an existing review event")
    return self._mutate(document, action="undo", claim_id=None, event_id=event_id,
                        expected_state_revision=expected_state_revision, reason=reason,
                        actor=actor, replacement=None, before_commit=before_commit)

