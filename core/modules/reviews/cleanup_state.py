"""원시 주장/판단을 보존하는 정확한 관점·세대별 정리 투영과 원장 검증."""
from datetime import datetime

from core.common.json_codec import canonical_json_hash as digest
from . import contracts
from .values import _actor, _reason, _token, _copy_value
from .state import _epoch, _scope, _is_policy

KINDS = {"archive_rejected", "archive_pending_review"}
COLLECTIONS = {"relations", "relation_candidates"}
EVENT_FIELDS = {"id", "action", "request_id", "request_hash", "actor", "scope", "timestamp", "reason",
                "base_state_revision", "source_revision", "graph_revision", "history_revision", "items",
                "undo_of", "previous_hash", "hash"}
ITEM_FIELDS = {"item_id", "kind", "available", "reason", "claim_id", "event_id", "collection", "decision", "target"}


def identifier(value):
    if not isinstance(value, str) or not contracts._UUID.fullmatch(value):
        raise ValueError("Expected a 32-character lowercase hexadecimal ID")


def item_for(event, kind, basis, scope):
    value = {"kind": kind, "available": True,
             "reason": "explicitly_rejected" if kind == "archive_rejected" else "previous_source_generation",
             "claim_id": event["claim_id"], "event_id": event["id"], "collection": event["collection"],
             "decision": event["after"]["decision"], "target": _copy_value(event["target"])}
    return {"item_id": digest({"item": value, "epoch": _epoch(basis), "scope": scope}), **value}


def eligible(snapshot, scope):
    events = {event["id"]: event for event in snapshot["history"]}
    items = []
    if snapshot["status"] == "ready":
        for claim in snapshot["claims"]:
            if claim["collection"] in COLLECTIONS and claim["decision"] == "reject" and not claim["ambiguous"]:
                items.append(item_for(events[claim["review_event_id"]], "archive_rejected", snapshot, scope))
    for event_id in snapshot["pending_history"]:
        event = events[event_id]
        if not _is_policy(event) and event["collection"] in COLLECTIONS:
            items.append(item_for(event, "archive_pending_review", snapshot, scope))
    return items


def active_items(ledger, scope):
    undone = {event["undo_of"] for event in ledger.get("cleanup_events", []) if event["action"] == "cleanup_undo"}
    return {item["item_id"] for event in ledger.get("cleanup_events", [])
            if event["action"] == "cleanup_apply" and event["id"] not in undone and event["scope"] == scope
            for item in event["items"]}


def project(snapshot, ledger, domain, viewpoint):
    scope = {"domain": domain, "viewpoint": viewpoint}
    active = active_items(ledger, scope)
    archived = [item for item in eligible(snapshot, scope) if item["item_id"] in active]
    claims = {item["claim_id"] for item in archived if item["kind"] == "archive_rejected"}
    events = {item["event_id"] for item in archived if item["kind"] == "archive_pending_review"}
    snapshot["current_claims"] = [_copy_value(claim) for claim in snapshot["claims"] if claim["claim_id"] not in claims]
    snapshot["current_pending_history"] = [event for event in snapshot["pending_history"] if event not in events]
    snapshot["cleanup"] = {"archived_item_ids": sorted(item["item_id"] for item in archived),
                           "archived_claim_ids": sorted(claims), "archived_event_ids": sorted(events)}


def validate(ledger):
    """Check the entire cleanup chain and references before projection or append."""
    entries = ledger.get("cleanup_events", [])
    if not isinstance(entries, list) or ("cleanup_events" in ledger and not entries):
        raise ValueError("Invalid cleanup journal")
    if len(entries) + len(ledger["events"]) > contracts.MAX_REVIEW_EVENTS:
        raise ValueError("Combined review event limit exceeded")
    reviews = {event["id"]: event for event in ledger["events"]}
    seen, requests, undone, previous = {}, set(), set(), None
    for event in entries:
        if not isinstance(event, dict) or set(event) != EVENT_FIELDS:
            raise ValueError("Invalid cleanup event fields")
        identifier(event["id"])
        identifier(event["request_id"])
        for name in ("request_hash", "base_state_revision", "source_revision", "history_revision", "hash"):
            _token(event[name], name)
        if event["graph_revision"] is not None:
            _token(event["graph_revision"], "graph_revision")
        _actor(event["actor"])
        _reason(event["reason"])
        stamp = datetime.fromisoformat(event["timestamp"])
        if stamp.tzinfo is None or stamp.utcoffset().total_seconds() != 0:
            raise ValueError("Cleanup timestamp must be UTC")
        request = (event["actor"]["user_id"], event["request_id"])
        if (event["id"] in seen or event["id"] in reviews or request in requests
                or event["scope"] != _scope(event["actor"]) or event["previous_hash"] != previous
                or digest({key: value for key, value in event.items() if key != "hash"}) != event["hash"]):
            raise ValueError("Invalid cleanup identity, scope or chain")
        items = event["items"]
        if not isinstance(items, list) or not 1 <= len(items) <= 50:
            raise ValueError("Invalid cleanup selection")
        if event["action"] == "cleanup_apply":
            if event["undo_of"] is not None:
                raise ValueError("Apply cannot undo an event")
            ids = set()
            for item in items:
                if not isinstance(item, dict) or set(item) != ITEM_FIELDS or item["kind"] not in KINDS:
                    raise ValueError("Invalid cleanup item")
                target = reviews.get(item["event_id"])
                if target is None or _is_policy(target) or target["collection"] not in COLLECTIONS:
                    raise ValueError("Cleanup cannot target policies or missing judgments")
                same_epoch = _epoch(event) == _epoch(target)
                if ((item["kind"] == "archive_rejected" and (not same_epoch or target["after"]["decision"] != "reject"))
                        or (item["kind"] == "archive_pending_review" and same_epoch)
                        or item != item_for(target, item["kind"], event, event["scope"])
                        or item["item_id"] in ids):
                    raise ValueError("Cleanup target or epoch differs")
                ids.add(item["item_id"])
        elif event["action"] == "cleanup_undo":
            target = seen.get(event["undo_of"])
            if (target is None or target["action"] != "cleanup_apply" or target["id"] in undone
                    or target["scope"] != event["scope"] or items != target["items"]):
                raise ValueError("Invalid cleanup inverse")
            undone.add(target["id"])
        else:
            raise ValueError("Unknown cleanup action")
        seen[event["id"]] = event
        requests.add(request)
        previous = event["hash"]
