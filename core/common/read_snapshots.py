"""Bounded process-local observations backed by the canonical write journal.

Callers hold the matching canonical lock. Strict readers retain their existing
full checks. Tracked readers reconcile on first use, journal gaps and periodically;
successful deltas never extend the periodic reconciliation deadline.
"""

from collections import OrderedDict
from copy import deepcopy
from threading import Lock
import time

from core.common.read_changes import EMPTY_TOKEN, changes_since, lock_stamp
from core.common.read_metrics import increment, span


RECONCILE_SECONDS = 30.0
MAX_SNAPSHOTS = 32
_snapshots = OrderedDict()
_guard = Lock()


def observation(store, kind, scope, load, *, update=None, cacheable=None):
    """Return an isolated observation; ``update(value, paths)`` may return None.

    None from update requests a full scan. Cache only metadata/thin summaries,
    never original bodies or authorization decisions. A new process has no trusted
    observations, even when the persistent SQLite database already exists.
    """
    if not getattr(store, "tracked_reads", False):
        return load()
    info = store.data_dir.stat()
    key = (str(store.data_dir), info.st_dev, info.st_ino, kind, scope)
    now = time.monotonic()
    with _guard:
        previous = _snapshots.get(key)
        if previous is not None:
            _snapshots.move_to_end(key)
            previous = deepcopy(previous)
    old_token = previous[0] if previous is not None else None
    try:
        increment("journal_reads")
        current, paths = changes_since(store, kind, old_token)
        stamp = lock_stamp(store, kind)
    except (OSError, ValueError, RuntimeError):
        current, paths, stamp = None, None, None
    value = None
    full_at = now
    if previous is not None and now - previous[1] < RECONCILE_SECONDS and current is not None:
        full_at = previous[1]
        same_inode = stamp is not None and previous[3] is not None and stamp[:2] == previous[3][:2]
        same_baseline = current != EMPTY_TOKEN or stamp == previous[3]
        if paths == [] and same_inode and same_baseline:
            increment("snapshot_hits")
            return previous[2]
        if paths and same_inode and same_baseline and update is not None:
            increment("changed", len(paths))
            value = update(previous[2], paths)
    if value is None:
        increment("reconciliations")
        with span("scan"):
            value = load()
        full_at = now
    if current is not None and (cacheable is None or cacheable(value)):
        with _guard:
            _snapshots[key] = (current, full_at, deepcopy(value), stamp)
            _snapshots.move_to_end(key)
            while len(_snapshots) > MAX_SNAPSHOTS:
                _snapshots.popitem(last=False)
    else:
        with _guard:
            _snapshots.pop(key, None)
    return value
