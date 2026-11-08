"""Explicit preview → atomic selected archive → receipt/undo, using the review ledger."""
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from uuid import uuid4

from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_hash as digest
from core.modules.documents.listing import _encode_cursor, _decode_cursor
from core.modules.documents.history import _offset
from .store import ReviewStore
from .values import _actor, _reason, _token, actor_basis
from .state import _scope
from .contracts import ReviewConflictError, ReviewLimitError
from . import contracts
from .cleanup_state import identifier, eligible, active_items, validate


class CleanupStore:
    def __init__(self, store, actor):
        _actor(actor)
        self.store, self.actor = store, deepcopy(actor)
        self.reviews = ReviewStore(store)
        self.scope = _scope(actor)

    def _snapshot(self, document):
        source, raw, ledger, tokens = self.reviews._snapshot_locked(document)
        snapshot = self.reviews._render(source, raw, ledger, tokens, **self.scope)
        # Same full validation as review queries; cleanup must not conceal corrupt layers.
        if snapshot["status"] == "ready" and snapshot["machine_graph"].get("schema_version") in (3, 4, 5, 6):
            self.reviews._validate_all_layers(source, raw, ledger, tokens)
        return ledger, snapshot

    def _revision(self, snapshot):
        return digest({"kind": "cleanup_preview", "state_revision": snapshot["state_revision"],
                       "actor": actor_basis(self.actor)})

    def _page(self, document, items, revision, kind, limit, cursor):
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError("Page size must be 1 to 50")
        scope = digest({"kind": kind, "document": document, "actor": actor_basis(self.actor)})
        previous = None if cursor is None else _decode_cursor(cursor, self.actor["tenant"], scope)
        names = [item["item_id"] if kind == "preview" else item["id"] for item in items]
        start = _offset(previous, revision, names)
        selected = items[start:start + limit]
        more = start + len(selected) < len(items)
        next_cursor = _encode_cursor({"version": 1, "tenant": self.actor["tenant"], "scope": scope,
            "catalog": revision, "after": names[start + len(selected) - 1]}) if more else None
        return {"items": selected, "total_items": len(items), "next_cursor": next_cursor,
                "complete": not more, "truncated": False, "skipped": [], "requires_refresh": False}

    def preview(self, document, *, limit=20, cursor=None):
        with self.store._write_lock():
            ledger, snapshot = self._snapshot(document)
            hidden = active_items(ledger, self.scope)
            items = sorted((item for item in eligible(snapshot, self.scope) if item["item_id"] not in hidden),
                           key=lambda item: item["item_id"])
            revision = self._revision(snapshot)
            capabilities = [{"kind": kind, "available": any(item["kind"] == kind for item in items),
                "reason": "eligible_items" if any(item["kind"] == kind for item in items) else "no_eligible_items",
                "count": sum(item["kind"] == kind for item in items)}
                for kind in ("archive_rejected", "archive_pending_review")]
            capabilities += [
                {"kind": "exact_duplicates", "available": False, "reason": "duplicate_claims_prevented_by_validation", "count": 0},
                {"kind": "deferred_or_uncertain", "available": False, "reason": "requires_explicit_review", "count": 0}]
            return {"document": document, "scope": deepcopy(self.scope), "status": snapshot["status"],
                    "state_revision": snapshot["state_revision"], "preview_revision": revision,
                    "capabilities": capabilities, **self._page(document, items, revision, "preview", limit, cursor)}

    def history(self, document, *, limit=20, cursor=None):
        with self.store._write_lock():
            ledger, snapshot = self._snapshot(document)
            return {"document": document, "state_revision": snapshot["state_revision"],
                    **self._page(document, list(reversed(ledger.get("cleanup_events", []))),
                                 snapshot["state_revision"], "history", limit, cursor)}

    def _find_request(self, ledger, request_id):
        return next((event for event in ledger.get("cleanup_events", []) if event["request_id"] == request_id
                     and event["actor"]["user_id"] == self.actor["user_id"]), None)

    def _receipt(self, document, event, revision, *, replayed=True, failures=()):
        return {"document": document, "request_id": event["request_id"], "event_id": event["id"],
                "event": deepcopy(event), "saved": True, "changed": not replayed, "replayed": replayed,
                "state_revision": revision, "cleanup_failures": cleanup_details(self.store.data_dir, failures),
                "retry_policy": "read_receipt"}

    def request(self, document, *, request_id):
        identifier(request_id)
        with self.store._write_lock():
            ledger, snapshot = self._snapshot(document)
            event = self._find_request(ledger, request_id)
            if event is None or event["scope"] != self.scope:
                raise FileNotFoundError("No cleanup receipt in this user and scope")
            return self._receipt(document, event, snapshot["state_revision"])

    def apply(self, document, *, request_id, preview_revision, item_ids, reason, before_commit=None):
        _token(preview_revision, "preview_revision")
        if not isinstance(item_ids, list) or not 1 <= len(item_ids) <= 50:
            raise ValueError("Select 1 to 50 explicit cleanup items")
        for item in item_ids:
            _token(item, "item_id")
        if len(set(item_ids)) != len(item_ids):
            raise ValueError("Select unique items")
        return self._mutate(document, request_id, reason, "cleanup_apply",
            {"preview_revision": preview_revision, "item_ids": sorted(item_ids)}, before_commit)

    def undo(self, document, *, request_id, event_id, expected_state_revision, reason, before_commit=None):
        identifier(event_id)
        _token(expected_state_revision, "expected_state_revision")
        return self._mutate(document, request_id, reason, "cleanup_undo",
            {"event_id": event_id, "expected_state_revision": expected_state_revision}, before_commit)

    def _mutate(self, document, request_id, reason, action, fields, before_commit):
        identifier(request_id)
        _reason(reason)
        request_hash = digest({"action": action, "document": document, "scope": self.scope, "reason": reason, **fields})
        failures = []
        try:
            with self.store._write_lock():
                ledger, snapshot = self._snapshot(document)
                previous = self._find_request(ledger, request_id)
                if previous is not None:
                    if previous["request_hash"] != request_hash:
                        raise ReviewConflictError(document, request_hash, previous["request_hash"])
                    if before_commit is not None:
                        before_commit()
                    return self._receipt(document, previous, snapshot["state_revision"])
                if action == "cleanup_apply":
                    current = self._revision(snapshot)
                    if fields["preview_revision"] != current:
                        raise ReviewConflictError(document, fields["preview_revision"], current)
                    hidden = active_items(ledger, self.scope)
                    available = {item["item_id"]: item for item in eligible(snapshot, self.scope) if item["item_id"] not in hidden}
                    if any(item not in available for item in fields["item_ids"]):
                        raise ValueError("A selected cleanup item is unavailable")
                    items = [available[item] for item in fields["item_ids"]]
                    undo_of = None
                else:
                    if fields["expected_state_revision"] != snapshot["state_revision"]:
                        raise ReviewConflictError(document, fields["expected_state_revision"], snapshot["state_revision"])
                    events = ledger.get("cleanup_events", [])
                    original = next((event for event in events if event["id"] == fields["event_id"]), None)
                    if (original is None or original["action"] != "cleanup_apply" or original["scope"] != self.scope
                            or any(event["undo_of"] == original["id"] for event in events)):
                        raise ValueError("Select an applied, not yet undone event in the exact scope")
                    items, undo_of = deepcopy(original["items"]), original["id"]
                entries = ledger.setdefault("cleanup_events", [])
                if len(entries) + len(ledger["events"]) >= contracts.MAX_REVIEW_EVENTS:
                    raise ReviewLimitError("Review history limit reached; nothing was discarded")
                event = {"id": uuid4().hex, "action": action, "request_id": request_id, "request_hash": request_hash,
                         "actor": deepcopy(self.actor), "scope": deepcopy(self.scope), "timestamp": datetime.now(timezone.utc).isoformat(),
                         "reason": reason, "base_state_revision": snapshot["state_revision"],
                         **{key: snapshot[key] for key in ("source_revision", "graph_revision", "history_revision")},
                         "items": items, "undo_of": undo_of, "previous_hash": entries[-1]["hash"] if entries else None}
                event["hash"] = digest(event)
                entries.append(event)
                validate(ledger)
                if before_commit is not None:
                    before_commit()
                encoded = self.reviews._commit_locked(document, ledger, failures)
                tokens = {key: snapshot[key] for key in ("document", "source_revision", "graph_revision", "review_revision", "history_revision")}
                tokens["review_revision"] = sha256(encoded).hexdigest()
                revision = digest(tokens)
        except Exception as error:
            if failures:
                error.cleanup_failures = tuple(failures)
            raise
        return self._receipt(document, event, revision, replayed=False, failures=failures)
