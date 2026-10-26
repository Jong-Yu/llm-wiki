"""전체 검토 원장을 검증하고 이미 보유한 잠금 안에서 새 파일을 공개한다.

원장 체인·이전/이후 상태·역이벤트를 처음부터 대조한다. 일부 이벤트만 읽거나
손상/한도를 초기화로 우회하지 않으며 저장 성공 뒤 정리 경고는 호출자가 보존한다.
"""

# ledger는 검토와 정책 이벤트를 순서대로 보존하는 원장이다. _ledger는 그 전체 연결을 검증한다.
# _commit_locked는 호출자가 가진 잠금 안에서 완성한 원장 전체를 공개한다. 성공 후 임시 파일 정리 문제는 별도 경고다.
from copy import deepcopy
import json
import os
from core.common.json_codec import canonical_json_bytes as _encode, canonical_json_hash as _hash
from core.modules.ontology.snapshots import _unique_object, _reject_constant
from . import contracts, events, values
from .contracts import ReviewValidationError, ReviewCorruptError, ReviewLimitError
from .values import _token, _reason, _actor
from .state import _is_policy, _scope, _policy_key, _epoch, _inactive_policy, _policy_visible


def _ledger(self, raw, document):
    # raw가 없으면 신규 빈 원장을 만들 값만 반환한다. 기존 raw가 있으면 처음부터 모든 이벤트/연결 지문을 검사한다.
    if raw is None:
        return {"version": 1, "document": document, "events": []}
    try:
        ledger = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                            parse_constant=_reject_constant)
        if (not isinstance(ledger, dict) or set(ledger) != {"version", "document", "events"}
                or type(ledger["version"]) is not int or ledger["version"] not in (1, 2)
                or ledger["document"] != document or not isinstance(ledger["events"], list)
                or not 1 <= len(ledger["events"]) <= contracts.MAX_REVIEW_EVENTS):
            raise ReviewValidationError("invalid review ledger")
        previous_hash, seen, latest = None, {}, {}
        for event in ledger["events"]:
            if not isinstance(event, dict):
                raise ReviewValidationError("invalid review event fields")
            policy = _is_policy(event)
            if set(event) != (contracts._POLICY_EVENT_FIELDS if policy else contracts._EVENT_FIELDS) or (policy and ledger["version"] != 2):
                raise ReviewValidationError("invalid review event fields")
            if (not isinstance(event["id"], str) or not contracts._UUID.fullmatch(event["id"])
                    or event["id"] in seen or event["action"] not in contracts._ACTIONS | {"undo"} | contracts._POLICY_ACTIONS
                    or event["collection"] not in contracts._COLLECTIONS):
                raise ReviewValidationError("invalid review event identity")
            for name in ("claim_id", "source_revision", "graph_revision", "history_revision", "hash"):
                _token(event[name], name)
            _reason(event["reason"])
            _actor(event["actor"])
            timestamp = events.datetime.fromisoformat(event["timestamp"])
            if timestamp.tzinfo is None or timestamp.utcoffset().total_seconds() != 0:
                raise ReviewValidationError("event timestamp must be UTC")
            if event["previous_hash"] != previous_hash:
                raise ReviewValidationError("broken review event chain")
            if _hash({key: value for key, value in event.items() if key != "hash"}) != event["hash"]:
                raise ReviewValidationError("review event hash mismatch")
            target = event["target"]
            if not isinstance(target, dict) or set(target) != {"claim", "entities"}:
                raise ReviewValidationError("invalid review target")
            self._check_saved_value(document, target["claim"], event["collection"], target["entities"], event["source_revision"])
            if values._claim_id(event["collection"], target["claim"], target["entities"]) != event["claim_id"]:
                raise ReviewValidationError("review target identity mismatch")
            if policy:
                if event["scope"] != _scope(event["actor"]) or event["collection"] not in {"relations", "attributes"}:
                    raise ReviewValidationError("Policy scope must match its authenticated actor")
                _token(event["base_state_revision"], "base_state_revision")
                known = {**seen, event["id"]: event}
                self._policy_state(event["before"], event, known)
                self._policy_state(event["after"], event, known)
                key = ("policy", _policy_key(event), _epoch(event))
                previous = latest.get(key)
                if event["before"] != (_inactive_policy() if previous is None else previous["after"]):
                    raise ReviewValidationError("Policy before state does not match its scoped history")
                if event["action"] == "policy_undo":
                    undone = seen.get(event["undo_of"])
                    if undone is None or previous is not undone or event["after"] != undone["before"]:
                        raise ReviewValidationError("Invalid inverse policy event")
                elif (event["undo_of"] is not None or event["after"]["decision"] != "active"
                      or event["after"]["value"]["provenance"]["event_id"] != event["id"]):
                    raise ReviewValidationError("Policy action and state differ")
                source_event = latest.get((event["claim_id"], _epoch(event)))
                source_state = ({"decision": "unreviewed", "value": target["claim"]}
                                if source_event is None else source_event["after"])
                if (event["before_effective"] != _policy_visible(event["before"], source_state)
                        or event["after_effective"] != _policy_visible(event["after"], source_state)):
                    raise ReviewValidationError("Policy visible before/after values differ from event history")
                latest[key] = event
                seen[event["id"]] = event
                previous_hash = event["hash"]
                continue
            for name in ("before", "after"):
                state = event[name]
                if not isinstance(state, dict) or set(state) != {"decision", "value"} or state["decision"] not in contracts._DECISIONS:
                    raise ReviewValidationError("invalid review state")
                self._check_saved_value(document, state["value"], event["collection"], target["entities"], event["source_revision"])
            key = (event["claim_id"], _epoch(event))
            previous = latest.get(key)
            expected_before = ({"decision": "unreviewed", "value": target["claim"]}
                               if previous is None else previous["after"])
            if event["before"] != expected_before:
                raise ReviewValidationError("review before state does not match event history")
            if event["action"] == "undo":
                undone = seen.get(event["undo_of"])
                if undone is None or previous is not undone or event["after"] != undone["before"]:
                    raise ReviewValidationError("invalid inverse review event")
            elif event["undo_of"] is not None or event["after"]["decision"] != event["action"]:
                raise ReviewValidationError("review action/state mismatch")
            elif event["action"] != "edit":
                expected_value = deepcopy(event["before"]["value"])
                if event["action"] == "accept" and event["collection"] == "relation_candidates":
                    expected_value = {key: value for key, value in expected_value.items()
                                      if key not in {"id", "reason", "question", "status"}}
                if event["after"]["value"] != expected_value:
                    raise ReviewValidationError("Only edit may change an assertion value")
            seen[event["id"]] = event
            latest[key] = event
            previous_hash = event["hash"]
        return ledger
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError, UnicodeError) as error:
        raise ReviewCorruptError("Stored review history is malformed; no history was replaced") from error


def _commit_locked(self, document, ledger, cleanup_failures):
    """호출자가 잡은 잠금 안에서 전체 원장을 보존한 새 파일로 조건부 작업을 마무리한다."""
    # 완성된 전체 원장을 한도 확인 후 공개한다. cleanup_failures 목록은 이미 성공한 공개와 임시 정리 문제를 구분한다.
    if len(ledger["events"]) > contracts.MAX_REVIEW_EVENTS:
        raise ReviewLimitError("Review history reached its event limit; nothing was discarded")
    encoded = _encode(ledger)
    if len(encoded) > contracts.MAX_REVIEW_BYTES:
        raise ReviewLimitError("Review history reached its byte limit; nothing was discarded")
    self.store._mkdir(self.review_dir)
    with self.store._staged_file(self.review_dir, encoded, cleanup_failures) as staged:
        os.replace(staged.path, self._path(document))
        staged.consumed = True
    return encoded

