# 서버 전환 전에 명시한 자료 경로/복사본/정책/설정을 읽고 보존 조건을 확인하는 수동 도구다.
# 출력 보고서는 전환 승인이나 자동 복구 명령이 아니다. 실제 운영 중단·설정 적용·사용자 승인은 따로 확인해야 한다.

"""자료·원장·연결의 전환 조건을 읽기 전용으로 점검하는 도구.

복사본의 무결성·기준을 비교하며 명시 요청한 새 비공개 보고서만 기록한다.
원문·정책을 변경하거나 tenant/잠금을 생성하지 않으며 실제 서버 설정 적용이나
사람이 확인해야 하는 운영 조건을 자동 승인하지 않는다.
"""
import argparse
from collections import Counter
from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import secrets
import stat
import sys
try:
    import tomllib
except ImportError:  # Python 3.10 remains usable for data/ledger inspection.
    tomllib = None

from core.modules.access.policy import AccessPolicy, PolicyError, _id
from core.modules.documents.store import WikiStore, DocumentSnapshot, MAX_DOCUMENT_BYTES
from core.modules.ontology.constants import MAX_ONTOLOGY_BYTES
from core.modules.ontology.snapshots import _stored_graph, _unique_object, _reject_constant
from core.common.json_codec import canonical_json_hash as _hash
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.contracts import MAX_REVIEW_BYTES, MAX_HISTORY_ENTRIES
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.correspondences.capture import _Capture
from core.modules.correspondences.contracts import MAX_CORRESPONDENCE_BYTES


DEFAULT_LIMITS = {"capture_bytes": 128 * 1024 * 1024, "entries": 20000,
                  "files": 10000, "directories": 10000, "history_entries": 10000,
                  "report_bytes": 32 * 1024 * 1024, "external_bytes": 1024 * 1024}
_REPORT_KIND = "d041_transition_report"
_MANUAL_GATES = ("source_owner_and_selection", "all_writers_frozen",
                 "in_flight_writes_finished", "legacy_sessions_and_restart_paths_closed",
                 "remote_and_global_exposure_inventory", "single_authoritative_dataset",
                 "private_rollback_configuration", "current_revocation_and_membership",
                 "actual_authentication_and_profiles", "actual_client_readback")


class TransitionCheckError(ValueError):
    """Safe exception text; source filenames and file contents are never included."""


def _json(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                      parse_constant=_reject_constant)


def _checked_path(value, *, directory=False):
    path = Path(value).absolute()
    # Reject aliases in every existing component, including the root argument.
    for part in (path, *path.parents):
        if part.is_symlink():
            raise TransitionCheckError("symbolic_link")
    resolved = path.resolve(strict=True)
    if directory and not resolved.is_dir():
        raise TransitionCheckError("not_directory")
    return resolved


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            stat.S_IFMT(info.st_mode))


def _open_directory(path):
    """Anchor every component without following a replaced parent symlink."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    absolute = Path(path).absolute()
    descriptor = os.open(absolute.anchor, flags)
    try:
        for name in absolute.parts[1:]:
            if name in {".", ".."}:
                raise TransitionCheckError("aliased_directory")
            child = os.open(name, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        result, descriptor = descriptor, None
        return result
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_regular(path, maximum, *, directory_fd=None):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise TransitionCheckError("not_regular_file")
        if before.st_size > maximum:
            raise TransitionCheckError("byte_limit")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            raw = stream.read(maximum + 1)
            after = os.fstat(stream.fileno())
        if len(raw) > maximum:
            raise TransitionCheckError("byte_limit")
        current = os.stat(path, dir_fd=directory_fd, follow_symlinks=False)
        if _identity(before) != _identity(after) or _identity(after) != _identity(current):
            raise TransitionCheckError("changed_during_check")
        return raw, after
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _kind(name):
    parts = Path(name).parts
    if name == ".storage.lock":
        return "operational_lock"
    if parts[0] == "wiki" and name.endswith(".md"):
        return "source"
    if parts[0] == "_history":
        return "history"
    if len(parts) == 2 and parts[0] == "_ontology" and name.endswith(".json"):
        return "graph"
    if len(parts) == 2 and parts[0] == "_reviews" and name.endswith(".json"):
        return "review"
    if len(parts) == 3 and parts[:2] == ("_reviews", "correspondences") and name.endswith(".json"):
        return "correspondence"
    return "unknown"


class _Tree:
    def __init__(self, path, limits):
        self.root = _checked_path(path, directory=True)
        self.limits = limits
        self.rows, self.raw, self.stamps, self.errors = {}, {}, {}, []
        self.bytes = 0
        self._scan()

    def issue(self, code, key=None):
        row = {"code": code}
        if key is not None:
            row["key"] = key
        if row not in self.errors:
            self.errors.append(row)

    def _scan(self):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
        root_fd = _open_directory(self.root)
        pending, entries, files, directories = [(self.root, root_fd)], 0, 0, 0
        self.stamps[""] = _identity(os.fstat(root_fd))
        try:
            while pending:
                directory, directory_fd = pending.pop()
                relative = directory.relative_to(self.root).as_posix()
                relative = "" if relative == "." else relative
                try:
                    # Do not materialize an unbounded directory before checking its cap.
                    names = []
                    with os.scandir(directory_fd) as stream:
                        for item in stream:
                            if entries >= self.limits["entries"]:
                                raise TransitionCheckError("entry_limit")
                            entries += 1
                            names.append(item.name)
                    self.rows[relative] = {"path": relative, "type": "directory", "empty": not names}
                    self.stamps[relative] = _identity(os.fstat(directory_fd))
                    for name in sorted(names):
                        path = directory / name
                        key = path.relative_to(self.root).as_posix()
                        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                        self.stamps[key] = _identity(info)
                        if stat.S_ISLNK(info.st_mode):
                            self.rows[key] = {"path": key, "type": "symlink"}
                            self.issue("symbolic_link", key)
                        elif stat.S_ISDIR(info.st_mode):
                            directories += 1
                            if directories > self.limits["directories"]:
                                raise TransitionCheckError("directory_limit")
                            child_fd = os.open(name, flags, dir_fd=directory_fd)
                            if _identity(os.fstat(child_fd)) != _identity(info):
                                os.close(child_fd)
                                raise TransitionCheckError("changed_during_check")
                            pending.append((path, child_fd))
                        elif stat.S_ISREG(info.st_mode):
                            files += 1
                            if files > self.limits["files"]:
                                raise TransitionCheckError("file_limit")
                            kind = _kind(key)
                            maximum = {"source": MAX_DOCUMENT_BYTES, "history": MAX_DOCUMENT_BYTES,
                                       "graph": MAX_ONTOLOGY_BYTES, "review": MAX_REVIEW_BYTES,
                                       "correspondence": MAX_CORRESPONDENCE_BYTES}.get(kind, MAX_REVIEW_BYTES)
                            raw, info = _read_regular(name, min(maximum, self.limits["capture_bytes"] - self.bytes), directory_fd=directory_fd)
                            self.bytes += len(raw)
                            self.raw[key] = raw
                            self.stamps[key] = _identity(info)
                            self.rows[key] = {"path": key, "type": "file", "kind": kind,
                                              "size": len(raw), "sha256": sha256(raw).hexdigest(),
                                              "device": info.st_dev, "inode": info.st_ino}
                        else:
                            self.rows[key] = {"path": key, "type": "special"}
                            self.issue("not_regular_file", key)
                except (OSError, ValueError, TypeError, RuntimeError) as error:
                    code = str(error) if isinstance(error, TransitionCheckError) else "inventory_error"
                    self.issue(code, relative)
                    # Limits never turn a partial inventory into a passing result.
                    if code.endswith("_limit"):
                        break
                finally:
                    os.close(directory_fd)
        finally:
            for _, descriptor in pending:
                os.close(descriptor)

    def unchanged(self):
        """Check observed inode/size/time and directory membership, without locks."""
        pending = []
        try:
            children = {}
            for name in self.stamps:
                if name:
                    parent = "" if Path(name).parent == Path(".") else Path(name).parent.as_posix()
                    children.setdefault(parent, set()).add(Path(name).name)
            pending.append(("", _open_directory(self.root)))
            entries = 0
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
            while pending:
                key, descriptor = pending.pop()
                try:
                    if _identity(os.fstat(descriptor)) != self.stamps.get(key):
                        return False
                    actual = set()
                    with os.scandir(descriptor) as stream:
                        for item in stream:
                            if entries >= self.limits["entries"]:
                                return False
                            entries += 1
                            actual.add(item.name)
                    if actual != children.get(key, set()):
                        return False
                    for name in actual:
                        child = name if not key else key + "/" + name
                        info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                        if _identity(info) != self.stamps.get(child):
                            return False
                        if stat.S_ISDIR(info.st_mode):
                            pending.append((child, os.open(name, flags, dir_fd=descriptor)))
                finally:
                    os.close(descriptor)
            return True
        except (OSError, ValueError, RuntimeError):
            return False
        finally:
            for _, descriptor in pending:
                os.close(descriptor)

    @property
    def manifest(self):
        return [deepcopy(self.rows[name]) for name in sorted(self.rows)]

    def signature(self):
        rows = [{key: value for key, value in row.items() if key not in {"device", "inode"}}
                for row in self.manifest if row.get("kind") != "operational_lock"]
        nonempty = {"" if Path(row["path"]).parent == Path(".") else Path(row["path"]).parent.as_posix()
                    for row in rows if row["path"]}
        for row in rows:
            if row["type"] == "directory":
                row["empty"] = row["path"] not in nonempty
        return rows


class _FrozenStore(WikiStore):
    """Reuse path/revision contracts without WikiStore.__init__ or any disk read."""
    def __init__(self, tree):
        self.tree = tree
        self.data_dir = tree.root
        self.wiki_dir = tree.root / "wiki"
        self.history_dir = tree.root / "_history"
        self.lock_timeout_seconds = 0
        self.children = {}
        for name, row in tree.rows.items():
            self.children.setdefault(Path(name).parent.as_posix(), []).append(row)

    def _check_path(self, path):
        key = path.relative_to(self.data_dir).as_posix()
        for parent in (Path(key), *Path(key).parents):
            row = self.tree.rows.get(parent.as_posix())
            if row is not None and row["type"] in {"symlink", "special"}:
                raise TransitionCheckError("symbolic_link")

    def read(self, document):
        path = self._document_path(self.wiki_dir, document)
        raw = self.tree.raw.get(path.relative_to(self.data_dir).as_posix())
        if raw is None:
            raise FileNotFoundError("Captured source unavailable")
        return DocumentSnapshot(raw.decode("utf-8"), sha256(raw).hexdigest())

    def _write_lock(self):
        raise TransitionCheckError("read_only_check")

    def save(self, *args, **kwargs):
        raise TransitionCheckError("read_only_check")


class _FrozenReviews(ReviewStore):
    def _history_revision(self, document):
        path = self.store._document_path(self.store.history_dir, document)
        key = path.relative_to(self.store.data_dir).as_posix()
        rows = self.store.children.get(key, [])
        if len(rows) > min(MAX_HISTORY_ENTRIES, self.store.tree.limits["history_entries"]):
            raise TransitionCheckError("history_limit")
        if any(row["type"] != "file" for row in rows):
            raise TransitionCheckError("invalid_history_entry")
        return _hash(sorted(Path(row["path"]).name for row in rows))


class _FrozenCapture(_Capture):
    def read(self, path, limit, *, corrupt=ValueError):
        key = path.relative_to(self.owner.store.data_dir).as_posix()
        if key in self.raw:
            return self.raw[key]
        self.owner.store._check_path(path)
        raw = self.owner.store.tree.raw.get(key)
        if raw is not None:
            if len(raw) > limit:
                raise corrupt("Captured component exceeds byte limit")
            if self.total_bytes + len(raw) > self.byte_limit:
                raise TransitionCheckError("closure_byte_limit")
            self.total_bytes += len(raw)
        self.raw[key] = raw
        return raw


# 읽어 둔 자료 묶음을 기존 원문/그래프/검토/대응 검증기에 전달한다. 저장용 경로는 열지 않는다.
def _inspect(tree, tenant):
    store = _FrozenStore(tree)
    reviews = _FrozenReviews(store)
    actor = {"user_id": "transition_checker", "tenant": tenant,
             "profile_id": "transition_check", "domain": None, "viewpoint": None,
             "policy_revision": "0" * 64}
    correspondences = CorrespondenceStore(store, actor)
    correspondences.reviews = reviews
    documents, actor_tenants, ledger_tenants = set(), Counter(), Counter()
    states = Counter()
    counts = Counter(row.get("kind") for row in tree.rows.values() if row["type"] == "file")
    for key, raw in sorted(tree.raw.items()):
        kind = _kind(key)
        try:
            if kind == "source":
                document = key[len("wiki/"):]
                store._document_path(store.wiki_dir, document)
                raw.decode("utf-8")
                documents.add(document)
            elif kind == "history":
                # The history document is a directory ending in .md, followed by
                # one full-file version name.  No nested or orphan special entry.
                parts = Path(key).parts
                document = "/".join(parts[1:-1])
                store._document_path(store.history_dir, document)
                raw.decode("utf-8")
                documents.add(document)
            elif kind in {"graph", "review"}:
                envelope = _json(raw)
                document = envelope["document"]
                expected = sha256(document.encode("utf-8")).hexdigest() + ".json"
                if Path(key).name != expected:
                    raise TransitionCheckError("storage_identity_mismatch")
                store._document_path(store.wiki_dir, document)
                documents.add(document)
                if kind == "graph":
                    _stored_graph(raw, document)
                else:
                    ledger = reviews._ledger(raw, document)
                    actor_tenants.update(event["actor"]["tenant"] for event in ledger["events"])
            elif kind == "correspondence":
                # Distribution remains visible in the private report even if the
                # strict current-tenant reader correctly rejects this ledger.
                envelope = _json(raw)
                if isinstance(envelope.get("tenant"), str):
                    ledger_tenants.update([envelope["tenant"]])
                for event in envelope.get("events", []):
                    value = event.get("actor", {}).get("tenant") if isinstance(event, dict) else None
                    if isinstance(value, str):
                        actor_tenants.update([value])
                cid = Path(key).stem
                ledger = correspondences._ledger(raw, cid)
                ctx = _FrozenCapture(correspondences)
                result = correspondences._result(cid, raw, ledger, ctx)
                if not result["complete"]:
                    raise TransitionCheckError("missing_dependency")
                states.update([result["source_proposal"]["applicability"]])
                states.update(policy["applicability"] for policy in result["policies"])
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
            code = str(error) if isinstance(error, TransitionCheckError) else kind + "_reader_invalid"
            tree.issue(code, key)
    for document in sorted(documents):
        try:
            source = store.read(document)
            graph_raw = tree.raw.get("_ontology/" + sha256(document.encode()).hexdigest() + ".json")
            review_raw = tree.raw.get("_reviews/" + sha256(document.encode()).hexdigest() + ".json")
            history = reviews._history_revision(document)
            snapshot = reviews._query_captured(document, source, graph_raw, review_raw, history)
            states.update(["document_" + snapshot["status"]])
            ledger, tokens = reviews._captured_state(document, source, graph_raw, review_raw, history)
            if snapshot["status"] == "ready" and snapshot["machine_graph"].get("schema_version") in (3, 4, 5, 6):
                reviews._validate_all_layers(source, graph_raw, ledger, tokens)
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError) as error:
            tree.issue(str(error) if isinstance(error, TransitionCheckError) else "document_reader_invalid", document)
    mismatch = any(name != tenant for name in actor_tenants) or any(name != tenant for name in ledger_tenants)
    if mismatch:
        tree.issue("tenant_mismatch")
    return {"files": sum(row["type"] == "file" for row in tree.rows.values()),
            "directories": sum(row["type"] == "directory" for row in tree.rows.values()),
            "bytes": tree.bytes, "documents": counts["source"], "history_files": counts["history"],
            "graphs": counts["graph"], "reviews": counts["review"],
            "correspondences": counts["correspondence"], "unknown_files": counts["unknown"],
            "reader_valid": not tree.errors, "tenant_match": not mismatch,
            "actor_events": sum(actor_tenants.values()), "tenant_variants": len(set(actor_tenants) | set(ledger_tenants)),
            "reader_states": dict(sorted(states.items()))}, {
                "actor_tenants": dict(sorted(actor_tenants.items())),
                "ledger_tenants": dict(sorted(ledger_tenants.items()))}


# 내용 지문뿐 아니라 복사본의 inode도 달라야 독립 복사로 인정한다. 같은 파일의 다른 경로를 복사본으로 세지 않는다.
def _comparison(source, target):
    if target is None:
        return {"status": "not_requested", "content_equal": None, "independent_inodes": None}
    identities = {(row["device"], row["inode"]) for row in source.rows.values() if row["type"] == "file"}
    independent = not any((row["device"], row["inode"]) in identities
                          for row in target.rows.values() if row["type"] == "file")
    equal = source.signature() == target.signature()
    return {"status": "matched" if equal and independent else "blocked",
            "content_equal": equal, "independent_inodes": independent}


def _external(path, limit):
    checked = _checked_path(path)
    directory_fd = _open_directory(checked.parent)
    try:
        raw, info = _read_regular(checked.name, limit, directory_fd=directory_fd)
    finally:
        os.close(directory_fd)
    return checked, raw, _identity(info)


# 명시한 새 비공개 보고서만 만든다. 자료 폴더 안과 기존 보고서 덮어쓰기는 거부한다.
def _private_report(path, details, maximum, protected):
    output = Path(path).absolute()
    parent = _checked_path(output.parent, directory=True)
    output = parent / output.name
    if any(output.is_relative_to(root) for root in protected):
        raise TransitionCheckError("report_inside_dataset")
    raw = (json.dumps(details, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if len(raw) > maximum:
        raise TransitionCheckError("report_byte_limit")
    directory_fd = _open_directory(parent)
    descriptor, temporary = None, None
    published = cleanup_failed = False
    try:
        try:
            os.stat(output.name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise TransitionCheckError("report_exists")
        for _ in range(5):
            temporary = ".transition-report-" + secrets.token_hex(16)
            try:
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=directory_fd)
                break
            except FileExistsError:
                temporary = None
        if descriptor is None:
            raise TransitionCheckError("report_staging_unavailable")
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        # Atomic no-clobber publication; existing reports are never replaced.
        os.link(temporary, output.name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
        published = True
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            if temporary is not None:
                os.unlink(temporary, dir_fd=directory_fd)
        except OSError:
            if not published:
                raise TransitionCheckError("report_cleanup_failed") from None
            cleanup_failed = True
        finally:
            os.close(directory_fd)
    return published, cleanup_failed


# 검사 결과를 요약하지만 실제 전환/원장 수정/권한 복구를 실행하지 않는다.
def check_transition(source, *, tenant, target=None, baseline=None, policy=None,
                     tenant_root=None, config=None, report=None, write_state="unknown", limits=None):
    """Return only a safe public summary; detailed manifests require ``report``.

    ``write_state`` is an operator declaration, never independently verified by
    this file inspection.  Every rollback classification forbids overwriting
    data, restoring old authorization, and returning to a legacy shared server.
    """
    effective = dict(DEFAULT_LIMITS)
    try:
        _id(tenant)
        for name, path in (("source", source), ("target", target), ("baseline", baseline),
                           ("policy", policy), ("tenant_root", tenant_root),
                           ("config", config), ("report", report)):
            if path is None and name != "source":
                continue
            if not isinstance(path, (str, os.PathLike)) or not os.fspath(path):
                raise TransitionCheckError("invalid_explicit_path")
        if write_state not in {"unknown", "none_confirmed", "succeeded"}:
            raise TransitionCheckError("invalid_write_state")
        if limits is not None:
            if not isinstance(limits, dict) or any(key not in effective or type(value) is not int or value < 0 for key, value in limits.items()):
                raise TransitionCheckError("invalid_limits")
            effective.update(limits)
    except (ValueError, TypeError):
        raise TransitionCheckError("Invalid transition-check input") from None
    summary = {"ok": False, "complete": False, "inspection_passed": False,
               "ready_for_cutover": False, "data_reuse_verified": "unverified",
               "source": None, "target": None,
               "comparison": {"status": "not_requested", "content_equal": None, "independent_inodes": None},
               "baseline": {"status": "not_requested", "unchanged": None},
               "policy": {"status": "not_requested", "tenant_present": None},
               "config": {"status": "not_requested"}, "blockers": [],
               "manual_gates": {gate: "unverified" for gate in _MANUAL_GATES},
               "rollback": {"write_state": write_state, "evidence": "operator_declared",
                   "classification": "maintenance_or_verified_private_configuration" if write_state == "none_confirmed" else "freeze_and_preserve_latest_authoritative_dataset",
                   "restore_old_copy_allowed": False, "legacy_fallback_allowed": False,
                   "restore_old_authorization_allowed": False}, "report_written": False,
               "report_cleanup_warning": False}
    details = {"kind": _REPORT_KIND, "version": 1, "tenant": tenant,
               "trees": {}, "inputs": {}, "limits": effective}
    trees, external_stamps = {}, {}
    protected_roots = []
    for path in (source, target):
        if path is not None:
            try:
                lexical = Path(path).absolute()
                protected_roots.extend((lexical, lexical.resolve(strict=False)))
            except (OSError, ValueError, TypeError, RuntimeError):
                pass
    for label, path in (("source", source), ("target", target)):
        if path is None:
            continue
        try:
            tree = _Tree(path, effective)
            trees[label] = tree
            inspected, tenants = _inspect(tree, tenant)
            summary[label] = inspected
            details["trees"][label] = {"root": str(tree.root), "manifest": tree.manifest,
                "signature": tree.signature(), **tenants, "errors": tree.errors}
            if tree.errors:
                summary["blockers"].extend(label + ":" + code for code in sorted({row["code"] for row in tree.errors}))
        except (OSError, ValueError, TypeError, RuntimeError, RecursionError):
            summary["blockers"].append(label + ":inventory_unavailable")
    if "source" in trees and (target is None or "target" in trees):
        if "target" in trees:
            a, b = trees["source"].root, trees["target"].root
            if a.is_relative_to(b) or b.is_relative_to(a):
                summary["blockers"].append("overlapping_datasets")
        summary["comparison"] = _comparison(trees["source"], trees.get("target"))
        if summary["comparison"]["status"] == "blocked":
            summary["blockers"].append("copy_preservation_failed")
    for label, path in (("policy", policy), ("config", config)):
        if path is None:
            continue
        try:
            checked, raw, stamp = _external(path, effective["external_bytes"])
            external_stamps[label] = checked, stamp
            details["inputs"][label] = {"path": str(checked), "sha256": sha256(raw).hexdigest()}
            if label == "policy":
                if tenant_root is None:
                    raise TransitionCheckError("tenant_root_required")
                access = AccessPolicy(checked, tenant_root)
                # Reuse strict AccessPolicy validation without reading it again or
                # authorizing/constructing a mutating WikiStore.
                if checked.is_relative_to(access._root):
                    raise TransitionCheckError("policy_inside_tenant_root")
                value = _json(raw)
                access._validate_policy(value)
                if tenant not in value["tenants"]:
                    raise TransitionCheckError("policy_tenant_missing")
                selected = access._root / tenant
                selected_tree = trees.get("target", trees.get("source"))
                if selected_tree is None or selected != selected_tree.root:
                    raise TransitionCheckError("policy_target_mismatch")
                summary[label] = {"status": "validated", "tenant_present": True}
            else:
                if tomllib is None:
                    summary[label] = {"status": "parser_unavailable"}
                    summary["blockers"].append("config:parser_unavailable")
                    continue
                value = tomllib.loads(raw.decode("utf-8"))
                if not isinstance(value, dict):
                    raise TransitionCheckError("invalid_config")
                summary[label] = {"status": "parsed_only"}
        except (OSError, ValueError, TypeError, KeyError, RuntimeError, RecursionError, PolicyError):
            # AccessPolicy deliberately hides sensitive details, as do all public
            # checker failures.  A parsed config never certifies running exposure.
            summary[label] = {"status": "blocked", **({"tenant_present": None} if label == "policy" else {})}
            summary["blockers"].append(label + ":validation_failed")
    if tenant_root is not None and policy is None:
        summary["blockers"].append("policy:explicit_policy_required")
    if baseline is not None:
        try:
            checked, raw, stamp = _external(baseline, effective["report_bytes"])
            if stat.S_IMODE(checked.stat().st_mode) & 0o077:
                raise TransitionCheckError("baseline_not_private")
            previous = _json(raw)
            if (previous.get("kind") != _REPORT_KIND or previous.get("version") != 1
                    or previous.get("tenant") != tenant
                    or previous.get("summary", {}).get("inspection_passed") is not True
                    or previous.get("summary", {}).get("complete") is not True):
                raise TransitionCheckError("baseline_invalid")
            # Baseline is data, never a source of paths to open or automatic
            # authorization. Compare only explicitly selected current inputs.
            unchanged = previous.get("inputs") == details["inputs"] and set(previous.get("trees", {})) <= set(details["trees"])
            for name, old in previous.get("trees", {}).items():
                current = details["trees"].get(name, {})
                unchanged = unchanged and old.get("root") == current.get("root") and old.get("signature") == current.get("signature")
            unchanged = bool(unchanged and "source" in previous.get("trees", {}))
            summary["baseline"] = {"status": "matched" if unchanged else "changed", "unchanged": unchanged}
            external_stamps["baseline"] = checked, stamp
            if not unchanged:
                summary["blockers"].append("baseline_changed")
        except (OSError, ValueError, TypeError, AttributeError, RecursionError):
            summary["baseline"] = {"status": "blocked", "unchanged": None}
            summary["blockers"].append("baseline_unavailable")
    for label, tree in trees.items():
        unchanged = tree.unchanged()
        summary[label]["observed_unchanged"] = unchanged
        if not unchanged:
            summary["blockers"].append(label + ":changed_during_check")
    for label, (path, stamp) in external_stamps.items():
        try:
            if _identity(path.lstat()) != stamp:
                raise TransitionCheckError("changed")
        except (OSError, ValueError):
            summary["blockers"].append(label + ":changed_during_check")
    if not summary["blockers"] and summary["source"] is not None:
        summary.update(ok=True, complete=True, inspection_passed=True)
        summary["data_reuse_verified"] = "not_applicable_empty" if summary["source"]["documents"] == 0 and summary["source"]["history_files"] == 0 and summary["source"]["reviews"] == 0 and summary["source"]["graphs"] == 0 and summary["source"]["correspondences"] == 0 else "verified_copy" if target is not None else "source_only"
    if any(item and item["unknown_files"] for item in (summary["source"], summary["target"])):
        summary["manual_gates"]["unclassified_files_preservation_and_purpose"] = "unverified"
    summary["blockers"] = sorted(set(summary["blockers"]))
    details["summary"] = deepcopy(summary)
    if report is not None:
        try:
            summary["report_written"], summary["report_cleanup_warning"] = _private_report(report, details, effective["report_bytes"], protected_roots)
        except (OSError, ValueError, TypeError, RuntimeError):
            summary.update(ok=False, complete=False, inspection_passed=False)
            summary["blockers"] = sorted(set([*summary["blockers"], "report_not_written"]))
    return summary


class _SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default error includes unknown argv values, which can be
        # accidentally supplied credentials, source filenames, or endpoints.
        raise TransitionCheckError("Invalid transition-check arguments")


# 명령줄 경로를 읽어 검사한 뒤 공개 가능한 요약만 출력한다. 상세 경로는 비공개 보고서에 둔다.
def main(argv=None):
    parser = _SafeParser(description="Read-only D-041 transition inspection; never performs cutover.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--tenant", required=True)
    for name in ("target", "baseline", "policy", "tenant-root", "config", "report"):
        parser.add_argument("--" + name)
    parser.add_argument("--write-state", choices=("unknown", "none_confirmed", "succeeded"), default="unknown")
    try:
        args = parser.parse_args(argv)
        result = check_transition(**vars(args))
    except (ValueError, TypeError, OSError):
        result = {"ok": False, "complete": False, "ready_for_cutover": False,
                  "blockers": ["invalid_check_input"]}
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
