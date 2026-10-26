"""명시된 전문가 판단과 되돌림을 해당 actor 관점의 정책 이벤트로 저장한다.

원문 인용을 만들지 않고 실제 Action log 출처와 전체 한정어를 유지한다.
공개 전 전체 원장 replay와 다른 관점의 유효성도 같은 잠금에서 검사한다.
"""

# policy는 원문 인용 없이 요청한 전문가 업무 판단을 기록하는 입구다.
# 정책의 근거는 실제 이벤트(Action log)이며 원문에 없던 인용을 만들지 않는다. 현재 관점과 이전/이후 상태를 함께 남긴다.
from copy import deepcopy
from hashlib import sha256
from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_bytes as _encode, canonical_json_hash as _hash
from . import contracts, events
from .contracts import ReviewConflictError, ReviewValidationError, ReviewLimitError
from .values import _token, _reason, _actor, _target_entities
from .state import _scope, _epoch, _is_policy, _inactive_policy, _policy_visible


def _policy_mutate(self, document, *, claim_id, event_id, expected_state_revision,
                   replacement, entities, reason, actor, before_commit=None):
    """인용 없는 업무 판단을 인증 주체의 관점과 Action log에 연결해 새 이벤트로 기록한다."""
    # 최신 원문/그래프/검토 기준과 정확한 actor 관점을 확인한 뒤 정책 이벤트를 추가한다.
    _token(expected_state_revision, "expected_state_revision")
    _reason(reason)
    _actor(actor)
    self._path(document)
    scope = _scope(actor)
    cleanup_failures = []
    try:
        with self.store._write_lock():
            source, graph_raw, ledger, tokens = self._snapshot_locked(document)
            if tokens["state_revision"] != expected_state_revision:
                raise ReviewConflictError(document, expected_state_revision, tokens["state_revision"])
            baseline = self._render(source, graph_raw, ledger, tokens, policies=False)
            snapshot = self._render(source, graph_raw, ledger, tokens, actor["domain"], actor["viewpoint"])
            if baseline["status"] != "ready" or baseline["machine_graph"].get("schema_version") not in (3, 4, 5, 6):
                raise ReviewValidationError("Policy changes require a current v3, v4 or v5 extraction")
            undone = None
            if event_id is not None:
                undone = next((event for event in ledger["events"] if event["id"] == event_id), None)
                if (undone is None or not _is_policy(undone) or undone["scope"] != scope
                        or _epoch(undone) != _epoch(tokens)):
                    raise ReviewValidationError("Policy undo requires an event in this scope and current source generation")
                claim_id = undone["claim_id"]
            claim = next((item for item in baseline["claims"] if item["claim_id"] == claim_id), None)
            if claim is None or claim["ambiguous"] or claim["collection"] not in {"relations", "attributes"}:
                raise ReviewValidationError("Policy target must be an unambiguous source relation or attribute")
            previous = next((event for event in reversed(ledger["events"])
                             if _is_policy(event) and event["claim_id"] == claim_id
                             and event["scope"] == scope and _epoch(event) == _epoch(tokens)), None)
            if undone is not None and previous is not undone:
                raise ReviewValidationError("Undo only the latest policy event for this claim and scope")
            identifier = events.uuid4().hex
            before = _inactive_policy() if previous is None else deepcopy(previous["after"])
            after = (deepcopy(undone["before"]) if undone is not None
                     else self._normalize_policy(replacement, entities, snapshot, claim["collection"], scope, identifier))
            source_state = {"decision": claim["decision"], "value": deepcopy(claim["reviewed_value"])}
            target_entities = _target_entities(claim["value"], baseline["machine_graph"]["entities"])
            for state in (before, after):
                if state["value"] is not None:
                    for entity in _target_entities(state["value"], baseline["machine_graph"]["entities"]):
                        if entity["id"] not in {item["id"] for item in target_entities}:
                            target_entities.append(entity)
            event = {"id": identifier, "action": "policy_undo" if undone is not None else "policy",
                     "claim_id": claim_id, "collection": claim["collection"],
                     "target": {"claim": deepcopy(claim["value"]), "entities": target_entities},
                     "before": before, "after": after,
                     "before_effective": _policy_visible(before, source_state),
                     "after_effective": _policy_visible(after, source_state),
                     "reason": reason, "actor": deepcopy(actor), "scope": scope,
                     "timestamp": events.datetime.now(events.timezone.utc).isoformat(),
                     **{name: tokens[name] for name in ("source_revision", "graph_revision", "history_revision")},
                     "base_state_revision": tokens["state_revision"],
                     "undo_of": None if undone is None else undone["id"],
                     "previous_hash": None if not ledger["events"] else ledger["events"][-1]["hash"]}
            event["hash"] = _hash(event)
            ledger["version"] = 2
            ledger["events"].append(event)
            # Reuse the disk reader's complete ledger validation before commit.
            if len(ledger["events"]) > contracts.MAX_REVIEW_EVENTS:
                raise ReviewLimitError("Review history reached its event limit; nothing was discarded")
            self._ledger(_encode(ledger), document)
            result = self._render(source, graph_raw, ledger, tokens, actor["domain"], actor["viewpoint"])
            self._validate_all_layers(source, graph_raw, ledger, tokens)
            # 이미 검증한 전체 원장을 공개하기 직전에 현재 권한·관점이 같은지 확인한다.
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


def policy(self, document, *, claim_id, replacement, expected_state_revision, reason, actor, entities=None, before_commit=None):
    """Apply an authorized expert decision in its exact business scope.

    Caller authorization must require ontology_policy, not ordinary review.
    Time/condition text is retained for the reader, never evaluated as true.
    """
    # 원문 인용 없는 업무 판단을 저장한다. 실제 요청된 판단인지와 ontology_policy 권한 확인은 호출하는 서버가 맡는다.
    _token(claim_id, "claim_id")
    return self._policy_mutate(document, claim_id=claim_id, event_id=None,
                               expected_state_revision=expected_state_revision,
                               replacement=replacement, entities=entities, reason=reason, actor=actor, before_commit=before_commit)


def policy_undo(self, document, *, event_id, expected_state_revision, reason, actor, before_commit=None):
    # 이 관점/현재 세대의 마지막 정책을 역이벤트로 되돌린다. 원문 근거 검토와 정책의 권한은 서로 대체하지 않는다.
    if not isinstance(event_id, str) or not contracts._UUID.fullmatch(event_id):
        raise ReviewValidationError("event_id must identify an existing expert policy event")
    return self._policy_mutate(document, claim_id=None, event_id=event_id,
                               expected_state_revision=expected_state_revision,
                               replacement=None, entities=None, reason=reason, actor=actor, before_commit=before_commit)

