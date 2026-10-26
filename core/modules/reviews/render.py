"""기계 추출과 현재 세대의 원문 검토·선택 관점의 정책을 조회 결과로 조립한다.

기계층·현재 적용 정책·다른 관점·pending 이력을 함께 보존한다. 이미 캡처된
조회에서 쓰는 조립 함수와 공개 잠금 조회의 경계를 유지한다.
"""

# _render는 기계 그래프에 같은 원문/생성 세대의 검토 결과를 겹쳐 보여 준다.
# _apply_policies는 선택한 정확한 업무 관점에 해당하는 정책을 따로 반영한다. 옛 판단은 pending 이력으로 남긴다.
from copy import deepcopy
from core.modules.ontology.errors import OntologyCorruptError
from core.modules.ontology.constants import VIEWPOINTS
from core.modules.ontology.snapshots import _query_snapshot
from core.modules.ontology.context import _context_selection
from . import contracts, values
from .contracts import ReviewCorruptError, ReviewValidationError
from .state import _is_policy, _policy_key, _epoch


def _render(self, source, graph_raw, ledger, tokens, domain=None, viewpoint=None, *, policies=True):
    """기계층과 같은 세대의 검토를 조합하고 정확한 관점의 정책을 별도로 적용한다."""
    # machine_graph는 그대로 보존하고, 같은 세대의 검토를 합쳐 effective_graph와 주장별 판단을 만든다.
    try:
        machine = _query_snapshot(tokens["document"], source, graph_raw)
    except OntologyCorruptError:
        # Derived graph repair still needs the current composite CAS token.
        # Review corruption itself remains fail-closed in _ledger().
        machine = {"document": tokens["document"], "source_revision": source.revision,
                   "status": "unavailable", "error": "ontology_corrupt", "needs_reextraction": True,
                   "entities": [], "relations": [], "attributes": [], "relation_candidates": []}
    effective = deepcopy(machine)
    claims, latest, ids = [], {}, {}
    for event in ledger["events"]:
        if _is_policy(event):
            continue
        if machine["status"] == "ready" and _epoch(event) == _epoch(tokens):
            self._validate_active_event(source, machine, event)
            latest[event["claim_id"]] = event
    for collection in contracts._COLLECTIONS:
        for value in machine[collection]:
            identifier = values._claim_id(collection, value, machine["entities"])
            ids[identifier] = ids.get(identifier, 0) + 1
            event = latest.get(identifier)
            state = {"decision": "unreviewed", "value": value} if event is None else event["after"]
            claims.append({"claim_id": identifier, "collection": collection, "value": deepcopy(value),
                           "decision": state["decision"], "reviewed_value": deepcopy(state["value"]),
                           "review_event_id": None if event is None else event["id"]})
    for collection in contracts._COLLECTIONS:
        effective[collection] = []
    for claim in claims:
        claim["ambiguous"] = ids[claim["claim_id"]] != 1
        if claim["ambiguous"] and claim["review_event_id"] is not None:
            raise ReviewCorruptError("A reviewed claim has ambiguous semantic identity")
        claim["needs_review"] = claim["ambiguous"] or claim["decision"] in {"unreviewed", "defer"}
        if claim["decision"] in {"reject", "defer"}:
            continue
        collection = claim["collection"]
        if collection == "relation_candidates" and claim["decision"] in {"accept", "edit"}:
            collection = "relations"
        effective[collection].append(deepcopy(claim["reviewed_value"]))
    pending = [event["id"] for event in ledger["events"]
               if not _is_policy(event) and (machine["status"] != "ready" or _epoch(event) != _epoch(tokens))
               and event["claim_id"] not in latest]
    result = {**tokens, "status": machine["status"], "machine_graph": machine,
            "effective_graph": effective, "claims": claims, "history": deepcopy(ledger["events"]),
            "pending_history": pending,
            "needs_review": machine["status"] != "ready" or machine.get("needs_reextraction", False) or bool(pending)
                or any(claim["needs_review"] for claim in claims),
            "selection": {"domain": domain, "viewpoint": viewpoint,
                          "machine": _context_selection(machine, domain, viewpoint),
                          "effective": _context_selection(effective, domain, viewpoint)}}
    if policies:
        self._apply_policies(result, ledger, domain, viewpoint)
    return result


def _apply_policies(self, result, ledger, domain, viewpoint):
    # 정확히 선택한 관점의 현재 정책만 적용한다. 다른 관점/옛 세대의 판단은 따로 표시한다.
    latest = {}
    for event in ledger["events"]:
        if not _is_policy(event):
            continue
        latest[_policy_key(event)] = event
        if result["status"] == "ready" and _epoch(event) == _epoch(result):
            machine = result["machine_graph"]
            entities = {entity["id"]: entity for entity in machine["entities"]}
            if (event["target"]["claim"] not in machine[event["collection"]]
                    or any(entities.get(entity["id"]) != entity for entity in event["target"]["entities"])):
                raise ReviewCorruptError("Current policy target differs from its source generation")
    summaries, selected = [], {}
    requested = {"domain": domain, "viewpoint": viewpoint}
    for event in latest.values():
        current = result["status"] == "ready" and _epoch(event) == _epoch(result)
        active = event["after"]["decision"] == "active"
        status = ("inactive" if not active else "pending" if not current
                  else "active" if event["scope"] == requested else "other_scope")
        summaries.append({"event_id": event["id"], "claim_id": event["claim_id"],
                          "collection": event["collection"], "scope": deepcopy(event["scope"]),
                          "status": status, "decision_event_id": None if not active else event["after"]["value"]["provenance"]["event_id"],
                          "source_revision": event["source_revision"], "graph_revision": event["graph_revision"],
                          "history_revision": event["history_revision"],
                          "value": deepcopy(event["after"]["value"]),
                          "entities": deepcopy(event["after"]["entities"])})
        if status == "pending":
            result["pending_history"].append(event["id"])
        elif status == "active":
            selected[event["claim_id"]] = event
    effective = result["effective_graph"]
    for collection in contracts._COLLECTIONS:
        effective[collection] = []
    expert_entities = {}
    for claim in result["claims"]:
        event = selected.get(claim["claim_id"])
        if event is not None:
            if claim["ambiguous"]:
                raise ReviewCorruptError("A policy target has ambiguous semantic identity")
            claim["source_decision"] = claim["decision"]
            claim["source_reviewed_value"] = deepcopy(claim["reviewed_value"])
            claim.update(decision="policy", reviewed_value=deepcopy(event["after"]["value"]), needs_review=False,
                         policy_event_id=event["after"]["value"]["provenance"]["event_id"],
                         latest_policy_event_id=event["id"])
            for entity in event["after"]["entities"]:
                existing = expert_entities.get(entity["id"])
                if existing is not None and existing != entity:
                    raise ReviewCorruptError("Conflicting expert entity identities")
                expert_entities[entity["id"]] = deepcopy(entity)
        if claim["decision"] in {"reject", "defer"}:
            continue
        collection = claim["collection"]
        if collection == "relation_candidates" and claim["decision"] in {"accept", "edit"}:
            collection = "relations"
        effective[collection].append(deepcopy(claim["reviewed_value"]))
    if any(entity["id"] in expert_entities for entity in effective["entities"]):
        raise ReviewCorruptError("Expert entity identity collides with a source entity")
    effective["entities"].extend(expert_entities.values())
    result["policies"] = summaries
    result["needs_review"] = (result["status"] != "ready" or result["machine_graph"].get("needs_reextraction", False)
                              or bool(result["pending_history"]) or any(claim["needs_review"] for claim in result["claims"]))
    result["selection"]["effective"] = _context_selection(effective, domain, viewpoint)


def query(self, document, *, domain=None, viewpoint=None):
    """같은 잠금에서 원문·그래프·전체 원장을 읽어 현재 유효값과 보류 이력을 함께 반환한다."""
    # 외부에서 부르는 조회 입구다. 같은 잠금에서 캡처하고 유효 그래프를 검증해 반환하며 파일을 저장하지 않는다.
    if domain is not None and (not isinstance(domain, str) or not domain.strip() or len(domain) > 4000):
        raise ReviewValidationError("domain filter is invalid")
    if viewpoint is not None and (not isinstance(viewpoint, str) or viewpoint not in VIEWPOINTS):
        raise ReviewValidationError("viewpoint filter is invalid")
    self._path(document)
    with self.store._write_lock():
        source, graph_raw, ledger, tokens = self._snapshot_locked(document)
        result = self._render(source, graph_raw, ledger, tokens, domain, viewpoint)
        if result["status"] == "ready" and result["machine_graph"].get("schema_version") in (3, 4, 5, 6):
            try:
                self._validate_effective(source, self._render(source, graph_raw, ledger, tokens, policies=False))
                self._validate_effective(source, result)
            except (ValueError, TypeError) as error:
                raise ReviewCorruptError("Current reviewed graph is inconsistent") from error
        return result

