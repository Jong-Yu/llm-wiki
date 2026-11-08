"""Bounded write-ahead invalidations in the existing canonical lock inode.

Writers affecting tracked document/source/job observations, including strict
readers' writers, call before_change under the relevant exclusive lock before
publishing the affected data.
The journal is independent of SQLite. Its failure aborts before canonical
changes; a later index failure cannot turn a completed canonical write into a
failed write. Intents record possible changes, including interrupted writes.

Readers hold the same lock. A missing, damaged or expired journal chain means
full reconciliation. An empty legacy lock is a stable, read-only baseline.
This does not detect writers which bypass these hooks or promise power-loss
durability for the canonical files themselves.
"""

from contextlib import contextmanager
from contextvars import ContextVar
import errno
import json
import os
from pathlib import Path
import re
import stat
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes, canonical_json_hash


EMPTY_TOKEN = "0" * 32
MAX_CHANGE_RECORDS = 256
MAX_JOURNAL_BYTES = 1024 * 1024
_TOKEN = re.compile(r"[0-9a-f]{32}")
_LOCK_NAMES = {"wiki": ".storage.lock", "registration": ".registration.lock"}
_BINDINGS = ContextVar("canonical_read_change_locks", default=None)


def _location(store, kind):
    if kind not in _LOCK_NAMES:
        raise ValueError("Unknown canonical change lock kind")
    root = Path(store.data_dir)
    return (str(root), kind), root / _LOCK_NAMES[kind]


def _key(key):
    if (type(key) is not str or not key or "\\" in key or "\x00" in key
            or any(part in ("", ".", "..") for part in key.split("/"))):
        raise ValueError("A canonical change key must be a relative path without '.' or '..'")
    return key


def _checked_fd(store, path, fd, identity=None):
    store._check_path(path)
    observed, opened = path.lstat(), os.fstat(fd)
    if not stat.S_ISREG(observed.st_mode) or not stat.S_ISREG(opened.st_mode):
        raise ValueError("Canonical change lock must be a regular file")
    current = (opened.st_dev, opened.st_ino)
    if current != (observed.st_dev, observed.st_ino) or (identity is not None and current != identity):
        raise ValueError("Canonical change lock inode does not match")
    return current


@contextmanager
def bind_lock(store, kind, fd):
    """Bind an already-held exclusive canonical lock; never acquire it again.

    Bindings are local to the execution context and keyed by root/kind, rather
    than a WikiStore instance. Registration may enclose wiki in the existing
    lock order. The caller keeps ownership of the descriptor and its flock.
    """
    if type(fd) is not int or fd < 0:
        raise TypeError("A canonical lock descriptor is required")
    location, path = _location(store, kind)
    identity = _checked_fd(store, path, fd)
    bindings = dict(_BINDINGS.get() or {})
    bindings[location] = (fd, identity)
    token = _BINDINGS.set(bindings)
    try:
        yield
    finally:
        _BINDINGS.reset(token)


def _bound(store, kind):
    location, path = _location(store, kind)
    binding = (_BINDINGS.get() or {}).get(location)
    if binding is None:
        return None
    fd, identity = binding
    _checked_fd(store, path, fd, identity)
    return fd


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError("Duplicate change journal field")
        value[key] = item
    return value


def _read(fd):
    raw = os.pread(fd, MAX_JOURNAL_BYTES + 1, 0)
    if not raw:
        return {"schema_version": 1, "base": EMPTY_TOKEN, "changes": []}
    try:
        if len(raw) > MAX_JOURNAL_BYTES:
            return None
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
        if type(value) is not dict or set(value) != {"schema_version", "base", "changes", "hash"}:
            return None
        payload = {key: item for key, item in value.items() if key != "hash"}
        if (type(value["schema_version"]) is not int or value["schema_version"] != 1
                or type(value["base"]) is not str or not _TOKEN.fullmatch(value["base"])
                or type(value["changes"]) is not list or len(value["changes"]) > MAX_CHANGE_RECORDS
                or value["hash"] != canonical_json_hash(payload)):
            return None
        seen = {value["base"], EMPTY_TOKEN}
        for change in value["changes"]:
            if (type(change) is not dict or set(change) != {"token", "key"}
                    or type(change["token"]) is not str or not _TOKEN.fullmatch(change["token"])
                    or change["token"] in seen):
                return None
            _key(change["key"])
            seen.add(change["token"])
        return payload
    except (UnicodeError, TypeError, ValueError, RecursionError):
        return None


def _current(journal):
    return journal["changes"][-1]["token"] if journal["changes"] else journal["base"]


def _encode(journal):
    return canonical_json_bytes({**journal, "hash": canonical_json_hash(journal)})


def before_change(store, kind, key):
    """Persist and fsync an intent before any canonical file effect.

    No binding is a caller error, rather than permission to bypass tracking.
    OSError and path/input errors propagate before the caller changes a file.
    A damaged chain is replaced in the same lock inode with a fresh base token;
    readers holding any earlier token must then perform full reconciliation.
    """
    _key(key)
    fd = _bound(store, kind)
    if fd is None:
        raise RuntimeError("Canonical changes require an already-bound exclusive lock")
    if os.fstat(fd).st_mode & 0o077:
        raise ValueError("Canonical change writes require a private lock file")
    journal = _read(fd)
    if journal is None:
        journal = {"schema_version": 1, "base": uuid4().hex, "changes": []}
    used = {journal["base"], EMPTY_TOKEN, *(change["token"] for change in journal["changes"])}
    token = uuid4().hex
    while token in used:
        token = uuid4().hex
    journal["changes"].append({"token": token, "key": key})
    while len(journal["changes"]) > MAX_CHANGE_RECORDS:
        journal["base"] = journal["changes"].pop(0)["token"]
    raw = _encode(journal)
    while len(raw) > MAX_JOURNAL_BYTES and journal["changes"]:
        journal["base"] = journal["changes"].pop(0)["token"]
        raw = _encode(journal)
    if len(raw) > MAX_JOURNAL_BYTES:
        raise ValueError("Canonical change journal byte bound is too small")
    position = 0
    while position < len(raw):
        written = os.pwrite(fd, raw[position:], position)
        if written <= 0:
            raise OSError(errno.EIO, "Canonical change journal write made no progress")
        position += written
    os.ftruncate(fd, len(raw))
    os.fsync(fd)
    return token


def changes_since(store, kind, token):
    """Return (current token, changed keys), or None keys for a full scan.

    An unbound/unsafe/unreadable lock or damaged record returns (None, None).
    A token outside the bounded retained chain also requires a full scan.
    Empty keys mean no observed intent since that token, including the stable
    empty-lock baseline. This function never repairs or writes a journal.
    """
    try:
        fd = _bound(store, kind)
        if fd is None:
            return None, None
        if os.fstat(fd).st_mode & 0o077:
            return None, None
        journal = _read(fd)
    except (OSError, ValueError):
        return None, None
    if journal is None:
        return None, None
    current = _current(journal)
    if token == current:
        return current, []
    if token == journal["base"]:
        offset = 0
    else:
        offset = next((index + 1 for index, change in enumerate(journal["changes"])
                       if change["token"] == token), None)
        if offset is None:
            return current, None
    return current, list(dict.fromkeys(change["key"] for change in journal["changes"][offset:]))


def lock_stamp(store, kind):
    """Identify the bound inode and detect loss back to an empty legacy file."""
    fd = _bound(store, kind)
    if fd is None:
        return None
    info = os.fstat(fd)
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns
