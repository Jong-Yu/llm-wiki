"""Metadata observations for the rebuildable ontology map projection.

The first request inventories canonical files. Managed writes invalidate only
their paths; strict readers inventory metadata on every request. No source body,
effective graph or authorization decision lives in the process-local snapshot.
"""

from hashlib import sha256
import os
import stat

from core.common.json_codec import canonical_json_hash
from core.common.read_metrics import increment
from core.common.read_snapshots import observation


ROOTS = ("wiki", "_history", "_knowledge/graphs", "_knowledge/reviews", "_ontology", "_reviews")
NAMESPACE = "ontology_exploration_v2"


def _fingerprint(store, path):
    target = store.data_dir / path
    store._check_path(target)
    info = target.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Projection observations require regular files")
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def _scan(store):
    files, skipped = {}, []

    def walk(directory, prefix):
        store._check_path(directory)
        try:
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return
        try:
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    increment("scanned")
                    path = prefix + "/" + entry.name
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode):
                            walk(store.data_dir / path, path)
                        elif stat.S_ISREG(info.st_mode):
                            files[path] = [info.st_dev, info.st_ino, info.st_size,
                                           info.st_mtime_ns, info.st_ctime_ns]
                        else:
                            skipped.append({"document": path, "code": "unsafe_path"})
                    except (OSError, ValueError):
                        skipped.append({"document": path, "code": "observation_failed"})
        finally:
            os.close(descriptor)

    for root in ROOTS:
        try:
            walk(store.data_dir / root, root)
        except (OSError, ValueError, RecursionError):
            skipped.append({"document": root, "code": "observation_failed"})
    return {"files": files, "skipped": sorted(skipped, key=lambda item: (item["document"], item["code"]))}


def observations(store):
    def update(previous, paths):
        if previous["skipped"]:
            return None
        for path in paths:
            if not any(path.startswith(root + "/") for root in ROOTS):
                continue
            try:
                previous["files"][path] = _fingerprint(store, path)
            except FileNotFoundError:
                previous["files"].pop(path, None)
            except (OSError, ValueError):
                return None
            if path.startswith("wiki/"):
                # A source write can publish a full archive before the source
                # replace fails. Its write-ahead source intent covers that
                # history change even when source metadata stays identical.
                prefix = "_history/" + path[len("wiki/"):] + "/"
                for old in [item for item in previous["files"] if item.startswith(prefix)]:
                    del previous["files"][old]
                directory = store.data_dir / prefix.rstrip("/")
                try:
                    store._check_path(directory)
                    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        with os.scandir(descriptor) as entries:
                            for entry in entries:
                                increment("scanned")
                                previous["files"][prefix + entry.name] = _fingerprint(store, prefix + entry.name)
                    finally:
                        os.close(descriptor)
                except FileNotFoundError:
                    pass
                except (OSError, ValueError):
                    return None
        return previous

    return observation(store, "wiki", NAMESPACE, lambda: _scan(store), update=update,
                       cacheable=lambda value: not value["skipped"])


def component_paths(document, document_id=None):
    key = sha256(document.encode("utf-8")).hexdigest()
    result = ["_ontology/" + key + ".json", "_reviews/" + key + ".json"]
    for kind in ("graphs", "reviews"):
        result.append("_knowledge/" + kind + "/legacy-" + key + ".json")
        if document_id:
            result.append("_knowledge/" + kind + "/" + document_id + ".json")
    return result


def signature(files, document, document_id=None, *, history=()):
    paths = ["wiki/" + document, *component_paths(document, document_id)]
    return canonical_json_hash({"files": [(path, files.get(path)) for path in paths],
                                "history": history})
