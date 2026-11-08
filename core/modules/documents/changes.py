"""Write-ahead authorship journal. Reads observe pending writes without repair."""

from copy import deepcopy
from datetime import datetime, timezone
import json
import os
import re
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.common.read_changes import before_change
from core.common.read_metrics import increment, span

MAX_LEDGER_BYTES = 8 * 1024 * 1024
_HEX = re.compile(r"[0-9a-f]{64}")
_ID = re.compile(r"[0-9a-f]{32}")
_ACTOR = {"user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision"}


class AuthorshipCorruptError(ValueError):
    """An authorship journal is inconsistent; preserve it and stop writes."""


def provenance(actor=None, origin=None, reason=None):
    if actor is not None:
        if (type(actor) is not dict or not _ACTOR <= set(actor)
                or set(actor) - (_ACTOR | {"access_revision", "display_name"})
                or any((value is not None or key not in {"domain", "viewpoint"})
                       and (type(value) is not str or not value or len(value) > 256)
                       for key, value in actor.items())
                or not _HEX.fullmatch(actor["policy_revision"])
                or ("access_revision" in actor and not _HEX.fullmatch(actor["access_revision"]))):
            raise ValueError("A verified server actor is required")
        actor = deepcopy(actor)
    if origin is None:
        origin = {"kind": "unknown"}
    elif type(origin) is str:
        origin = {"kind": origin}
    if (type(origin) is not dict or origin.get("kind") not in {"human", "ai", "unknown"}
            or set(origin) - {"kind", "provider", "model", "tool", "job_id", "run_id"}
            or any(type(value) is not str or not value or len(value) > 256 for value in origin.values())):
        raise ValueError("Invalid generation origin")
    if reason is not None and (type(reason) is not str or len(reason) > 2000):
        raise ValueError("Invalid change reason")
    return actor, deepcopy(origin), reason


def _path(store, document):
    directory = store._document_path(store.history_dir, document)
    path = directory / "changes.json"
    store._check_path(path)
    return path


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise AuthorshipCorruptError("Duplicate authorship key")
        value[key] = item
    return value


def load(store, document):
    from core.modules.sources.files import open_regular
    try:
        increment("canonical_reads")
        with span("canonical_read"), open_regular(store, _path(store, document)) as stream:
            raw = stream.read(MAX_LEDGER_BYTES + 1)
    except FileNotFoundError:
        return {"schema_version": 1, "document": document, "entries": []}
    try:
        if len(raw) > MAX_LEDGER_BYTES:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=_pairs)
        if (type(value) is not dict or set(value) != {"schema_version", "document", "entries"}
                or type(value["schema_version"]) is not int or value["schema_version"] != 1
                or value["document"] != document or type(value["entries"]) is not list):
            raise ValueError()
        previous, ids = None, set()
        for index, entry in enumerate(value["entries"]):
            if (type(entry) is not dict or set(entry) != {"change_id", "actor", "origin", "reason", "recorded_at",
                    "before_revision", "after_revision", "history_id", "status", "previous_hash", "hash"}
                    or not _ID.fullmatch(entry["change_id"]) or entry["change_id"] in ids
                    or entry["status"] not in {"pending", "committed", "aborted"}
                    or entry["previous_hash"] != previous
                    or entry["hash"] != canonical_json_hash({key: item for key, item in entry.items() if key != "hash"})
                    or not _HEX.fullmatch(entry["after_revision"])
                    or (entry["before_revision"] is not None and not _HEX.fullmatch(entry["before_revision"]))
                    or (entry["status"] == "pending" and index != len(value["entries"]) - 1)):
                raise ValueError()
            provenance(entry["actor"], entry["origin"], entry["reason"])
            if datetime.fromisoformat(entry["recorded_at"]).tzinfo is None:
                raise ValueError()
            if entry["before_revision"] is None:
                if entry["history_id"] is not None:
                    raise ValueError()
            else:
                from .history import validate_history_id
                validate_history_id(entry["history_id"])
            ids.add(entry["change_id"])
            previous = entry["hash"]
        return value
    except (ValueError, TypeError, KeyError, RecursionError) as error:
        raise AuthorshipCorruptError("Invalid authorship journal") from error


def _write(store, document, ledger, cleanup_failures):
    raw = canonical_json_bytes(ledger)
    if len(raw) > MAX_LEDGER_BYTES:
        raise AuthorshipCorruptError("Authorship journal exceeds its limit")
    path = _path(store, document)
    before_change(store, "wiki", path.relative_to(store.data_dir).as_posix())
    store._mkdir(path.parent)
    with store._staged_file(path.parent, raw, cleanup_failures) as staged:
        store._check_path(path)
        os.replace(staged.path, path)
        staged.consumed = True


def _status(store, document, entry, revision):
    if entry["status"] != "pending":
        return entry["status"]
    if revision == entry["before_revision"]:
        return "aborted"
    if revision == entry["after_revision"]:
        if entry["history_id"] is not None:
            from .history import _directory, _read
            try:
                with _directory(store, document) as descriptor:
                    old = _read(descriptor, entry["history_id"], document)
                if old["revision"] != entry["before_revision"]:
                    raise ValueError()
            except (OSError, ValueError) as error:
                raise AuthorshipCorruptError("Pending authorship has no matching full history") from error
        return "committed"
    raise AuthorshipCorruptError("Pending authorship does not match the current document")


def _set_status(entry, status):
    entry["status"] = status
    entry["hash"] = canonical_json_hash({key: item for key, item in entry.items() if key != "hash"})


def reconcile(store, document, revision, cleanup_failures):
    """Only a writer holding the WikiStore lock may persist recovery."""
    ledger = load(store, document)
    if ledger["entries"] and ledger["entries"][-1]["status"] == "pending":
        entry = ledger["entries"][-1]
        _set_status(entry, _status(store, document, entry, revision))
        _write(store, document, ledger, cleanup_failures)
    return ledger


def begin(store, document, ledger, before, after, history_path, actor, origin, reason, cleanup_failures):
    entry = {"change_id": uuid4().hex, "actor": actor, "origin": origin, "reason": reason,
             "recorded_at": datetime.now(timezone.utc).isoformat(), "before_revision": before,
             "after_revision": after, "history_id": history_path.name if history_path else None,
             "status": "pending", "previous_hash": ledger["entries"][-1]["hash"] if ledger["entries"] else None}
    _set_status(entry, "pending")
    ledger["entries"].append(entry)
    _write(store, document, ledger, cleanup_failures)


def finish(store, document, ledger, cleanup_failures):
    _set_status(ledger["entries"][-1], "committed")
    _write(store, document, ledger, cleanup_failures)


def authorship(store, document, revision):
    """Read-only projection; absent historic author information stays unknown."""
    ledger = load(store, document)
    committed = []
    pending = bool(ledger["entries"] and ledger["entries"][-1]["status"] == "pending")
    for entry in ledger["entries"]:
        if _status(store, document, entry, revision) == "committed":
            committed.append({key: item for key, item in entry.items() if key not in {"hash", "previous_hash"}})
    latest = committed[-1] if committed else None
    updated = latest if latest and latest["after_revision"] == revision else None
    created = next((entry for entry in committed if entry["before_revision"] is None), None)
    return {"status": "pending_reconcile" if pending else "recorded" if updated else "unknown",
            "created": created, "updated": updated}


def document_fields(store, document, snapshot, *, include_body=False):
    from .metadata import parse_document
    parsed = parse_document(snapshot.content)
    value = {"metadata": parsed.metadata, "document_id": parsed.document_id, "body_revision": parsed.body_revision,
             "authorship": authorship(store, document, snapshot.revision)}
    if include_body:
        value.update(body=parsed.body, body_start_line=parsed.body_start_line)
    return value
