"""한 잠금의 제한된 스냅샷에서 문서 링크와 공통 이름 후보를 계산한다.

Markdown 링크는 명시 연결이며 이름/유형 일치는 미확정 후보다. 탐색·읽기·
처리·출력 한도를 구분해 불완전한 조회를 전체 연결 없음으로 오해하지 않게 한다."""

# connections_snapshot_locked가 이미 잡힌 저장 잠금 안에서 연결 후보를 계산한다.
# explicit_links는 원문 Markdown에 있는 링크, candidates는 이름·유형이 겹치는 개념 후보다.
# 두 문서의 이름이 같아도 같은 대상이라고 병합하지 않으며 문서/개체/버전 근거를 함께 반환한다.

import os
from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
import posixpath
import stat
import unicodedata
from urllib.parse import unquote, urlsplit

from markdown_it import MarkdownIt

from core.common.json_codec import canonical_json_bytes
from core.modules.documents.store import DocumentSnapshot
from core.modules.documents.metadata import parse_document
from . import constants
from .errors import (
    OntologyValidationError, OntologyCorruptError, _ContextBudgetError, _connection_error,
)
from .snapshots import _query_snapshot


@dataclass(frozen=True)
class _ValidatedGraph:
    """Immutable proof of one successful, request-local machine validation."""

    root: str
    document: str
    source_revision: str
    source_content: str
    raw: object
    encoded: bytes
    digest: str

    @classmethod
    def capture(cls, store, document, source, raw, snapshot):
        try:
            encoded = canonical_json_bytes(snapshot)
        except (TypeError, ValueError, UnicodeError, RecursionError):
            return None
        return cls(str(store.data_dir), document, source.revision, source.content, raw,
                   encoded, sha256(encoded).hexdigest())

    def read(self, store, document, source, raw):
        """Return an isolated snapshot only for the exact captured inputs."""
        try:
            if ((self.root, self.document, self.source_revision, self.source_content, self.raw)
                    != (str(store.data_dir), document, source.revision, source.content, raw)
                    or sha256(self.encoded).hexdigest() != self.digest):
                return None
            value = json.loads(self.encoded)
            if (type(value) is not dict or value.get("document") != document
                    or value.get("source_revision") != source.revision
                    or value.get("status") not in {"ready", "stale", "missing"}
                    or any(type(value.get(name)) is not list for name in
                           ("entities", "relations", "relation_candidates", "attributes"))):
                return None
            return value
        except (AttributeError, TypeError, ValueError, UnicodeError, RecursionError):
            return None


def _link_target(document: str, href: str):
    """Decode a relative Markdown destination once, never a URL or wiki escape."""
    if not isinstance(href, str) or len(href) > constants.MAX_LINK_HREF_CHARACTERS:
        return None
    if any(ord(char) < 32 for char in href) or "\\" in href:
        return None
    try:
        parts = urlsplit(href)
        if parts.scheme or parts.netloc or "?" in href.split("#", 1)[0]:
            return None
        path = unquote(parts.path, encoding="utf-8", errors="strict")
        if not path or path.startswith("/") or "\\" in path or "\x00" in path:
            return None
        if urlsplit(path).scheme or not path.endswith(".md"):
            return None
        target = posixpath.normpath(posixpath.join(posixpath.dirname(document), path))
        if target == ".." or target.startswith("../") or target.startswith("/"):
            return None
        return target, parts.fragment
    except (ValueError, UnicodeError):
        return None


def _normalized_label(label: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", label).casefold().split())


def _source_links(content, *, parsed=None):
    """Yield Markdown links, excluding images, code and raw HTML/comments."""
    # 본문을 Markdown으로 해석해 실제 링크만 모은다. 코드 블록/이미지의 비슷한 문자열을 문서 연결로 삼지 않는다.
    parsed = parse_document(content) if parsed is None else parsed
    offset = parsed.body_start_line - 1
    for block in MarkdownIt("commonmark").parse(parsed.body):
        if block.type == "inline" and block.map is not None:
            for token in block.children or ():
                if token.type == "link_open":
                    yield token.attrGet("href"), {"start_line": block.map[0] + 1 + offset,
                                                  "end_line": block.map[1] + offset, "scope": "block"}


def connection_documents(ontology, skipped: list) -> tuple:
    """Walk at most the entry budget, without following symlink directories."""
    pending = [ontology.store.wiki_dir]
    documents = set()
    entries = 0
    complete = True
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as iterator:
                for entry in iterator:
                    if entries >= constants.MAX_CONNECTION_SCAN_ENTRIES:
                        return sorted(documents), False, entries
                    entries += 1
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False) and entry.name.endswith(".md"):
                            documents.add(Path(entry.path).relative_to(ontology.store.wiki_dir).as_posix())
                    except OSError as error:
                        complete = False
                        if len(skipped) < constants.MAX_CONNECTION_DOCUMENTS:
                            skipped.append({"document": Path(entry.path).relative_to(ontology.store.wiki_dir).as_posix(),
                                            "code": _connection_error(error)})
        except OSError as error:
            complete = False
            if len(skipped) < constants.MAX_CONNECTION_DOCUMENTS:
                skipped.append({"document": directory.relative_to(ontology.store.wiki_dir).as_posix(),
                                "code": _connection_error(error)})
    return sorted(documents), complete, entries


def connections_snapshot_locked(ontology, document: str, limit: int = 20, *, capture_validated=False) -> tuple:
    """Derive explicit links and unmerged concept candidates from one snapshot.

    The limit applies separately to links and candidates. Missing/stale
    ontology is a normal state; skipped inputs and every processing/output
    limit make truncated true. No derived files or source files are written.
    """
    # 원문과 그래프를 같은 잠금 아래 캡처한 뒤 명시 연결과 이름/유형 후보를 구분해 반환한다.
    if type(limit) is not int or not 1 <= limit <= constants.MAX_CONNECTION_LIMIT:
        raise ValueError(f"limit must be an integer from 1 to {constants.MAX_CONNECTION_LIMIT}")
    ontology.store._document_path(ontology.store.wiki_dir, document)
    skipped = []
    truncated = False

    def skip(name, code):
        nonlocal truncated
        truncated = True
        if len(skipped) < constants.MAX_CONNECTION_DOCUMENTS:
            skipped.append({"document": name, "code": code})

    snapshots = {}
    raw_graphs = {}
    graph_errors = {}
    source_errors = {}
    identities = {}
    explicit = []
    # The requested source is mandatory and is always captured first.
    remaining = [constants.MAX_CONNECTION_BYTES]
    focus = ontology._read_source(document)
    remaining[0] -= len(focus.content.encode("utf-8"))
    snapshots[document] = focus
    scanned_bytes = len(focus.content.encode("utf-8"))
    names, scan_complete, scan_entries = ontology._connection_documents(skipped)
    truncated = bool(skipped) or not scan_complete
    names = [document] + [name for name in names if name != document]
    scanned = 0
    for name in names:
        if scanned >= constants.MAX_CONNECTION_DOCUMENTS:
            truncated = True
            scan_complete = False
            break
        try:
            path = ontology.store._document_path(ontology.store.wiki_dir, name)
            info = path.stat()
            identity = (info.st_dev, info.st_ino)
            # Filesystem aliases (case/Unicode on macOS) remain one
            # source identity, with the focus spelling taking priority.
            if identity in identities:
                continue
            if not stat.S_ISREG(info.st_mode):
                raise OntologyValidationError("source must be a regular file")
            scanned += 1
            identities[identity] = name
            if name != document:
                if info.st_size > constants.MAX_CONNECTION_BYTES - scanned_bytes:
                    source_errors[name] = "byte_budget"
                    skip(name, "byte_budget")
                    scan_complete = False
                    continue
                source_raw = ontology._context_bytes(path, remaining, name, "source")
                source = DocumentSnapshot(source_raw.decode("utf-8"), ontology.store._revision(source_raw))
                size = len(source.content.encode("utf-8"))
                if size > constants.MAX_CONNECTION_BYTES - scanned_bytes:
                    source_errors[name] = "byte_budget"
                    skip(name, "byte_budget")
                    scan_complete = False
                    continue
                snapshots[name] = source
                scanned_bytes = constants.MAX_CONNECTION_BYTES - remaining[0]
        except (OSError, ValueError, TypeError) as error:
            if name == document:
                raise
            # Count failed documents too, so failures cannot evade the
            # document processing budget.
            if name not in source_errors and name not in identities.values():
                scanned += 1
            source_errors[name] = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
            skip(name, source_errors[name])
            scan_complete = False
            continue
        try:
            cache = ontology._path(name)
            try:
                cache_size = cache.stat().st_size
            except FileNotFoundError:
                cache_size = 0
            if cache_size > constants.MAX_ONTOLOGY_BYTES:
                raise OntologyCorruptError("Stored ontology exceeds the 1 MiB byte limit")
            if cache_size > constants.MAX_CONNECTION_BYTES - scanned_bytes:
                graph_errors[name] = "byte_budget"
                skip(name, "byte_budget")
                continue
            raw = ontology._context_bytes(cache, remaining, name, "ontology")
            if raw is not None:
                if len(raw) > constants.MAX_CONNECTION_BYTES - scanned_bytes:
                    graph_errors[name] = "byte_budget"
                    skip(name, "byte_budget")
                    continue
                scanned_bytes = constants.MAX_CONNECTION_BYTES - remaining[0]
            raw_graphs[name] = raw
        except (OSError, ValueError, TypeError) as error:
            graph_errors[name] = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
            skip(name, graph_errors[name])

    # Resolve target identity while the same writer lock is held. The
    # bounded parser also excludes images, code and raw HTML/comments.
    link_count = 0
    seen = set()
    links_done = False
    for name, source in snapshots.items():
        if links_done:
            break
        try:
            parsed = parse_document(source.content)
        except ValueError:
            skip(name, "invalid_document_metadata")
            continue
        for href, evidence in _source_links(source.content, parsed=parsed):
            if link_count >= constants.MAX_CONNECTION_LINKS:
                truncated = True
                links_done = True
                break
            link_count += 1
            if isinstance(href, str) and len(href) > constants.MAX_LINK_HREF_CHARACTERS:
                skip(name, "link_href_too_long")
                continue
            destination = _link_target(name, href)
            if destination is None:
                continue
            target, fragment = destination
            try:
                target_path = ontology.store._document_path(ontology.store.wiki_dir, target)
            except (ValueError, TypeError):
                # Includes symlinks and paths outside the wiki.
                continue
            try:
                target_info = target_path.stat()
                target = identities.get((target_info.st_dev, target_info.st_ino), target)
                status = "unavailable" if not stat.S_ISREG(target_info.st_mode) else None
                target_error = "invalid_argument" if status is not None else None
            except FileNotFoundError:
                status = None
                target_error = None
            except OSError as error:
                status = "unavailable"
                target_error = _connection_error(error)
            if target == name or document not in (name, target) or (name, target) in seen:
                continue
            if target_error is not None:
                skip(target, target_error)
            seen.add((name, target))
            target_source = snapshots.get(target)
            if target_source is not None:
                status = "resolved"
            elif target in source_errors:
                status = "unscanned" if source_errors[target] == "byte_budget" else "unavailable"
            elif status is None:
                status = "missing" if scan_complete else "unscanned"
            if len(explicit) >= limit:
                truncated = True
                links_done = True
                break
            explicit.append({
                "source_document": name, "source_revision": source.revision,
                "target_document": target,
                "target_revision": None if target_source is None else target_source.revision,
                "target_status": status,
                "direction": "outgoing" if name == document else "incoming",
                "href": href, "fragment": fragment,
                "evidence": evidence,
            })

    states = []
    ready = {}
    validated = {}
    for name, source in snapshots.items():
        if name in graph_errors:
            status = "corrupt" if graph_errors[name] == "ontology_corrupt" else "unavailable"
            states.append({"document": name, "source_revision": source.revision, "status": status})
            continue
        try:
            graph = _query_snapshot(name, source, raw_graphs[name])
        except OntologyCorruptError:
            skip(name, "ontology_corrupt")
            states.append({"document": name, "source_revision": source.revision, "status": "corrupt"})
            continue
        states.append({key: graph[key] for key in (
            "document", "source_revision", "status", "indexed_revision", "needs_reextraction",
        ) if key in graph})
        if capture_validated:
            proof = _ValidatedGraph.capture(ontology.store, name, source, raw_graphs[name], graph)
            if proof is not None:
                validated[name] = proof
        if graph["status"] == "ready":
            ready[name] = graph
    states.extend({"document": name, "source_revision": None, "status": "unavailable"} for name in source_errors)
    candidates = []
    focus_graph = ready.get(document)
    if focus_graph is not None:
        focus_entities = {}
        for entity in focus_graph["entities"]:
            focus_entities.setdefault((entity["type"], _normalized_label(entity["label"])), []).append(entity)
        for name, graph in ready.items():
            if name == document:
                continue
            for other in graph["entities"]:
                for entity in focus_entities.get((other["type"], _normalized_label(other["label"])), ()):
                    if len(candidates) >= limit:
                        truncated = True
                        break
                    candidates.append({
                        "status": "candidate", "reason": "same_type_and_normalized_label",
                        "source_entity": {"document": document, "source_revision": focus_graph["source_revision"], **entity},
                        "target_entity": {"document": name, "source_revision": graph["source_revision"], **other},
                    })
                if len(candidates) >= limit and truncated:
                    break
            if len(candidates) >= limit and truncated:
                break
    result = {
        "document": document, "source_revision": focus.revision,
        "layer": "machine", "review_tool": "ontology_review_query",
        "explicit_links": explicit, "candidates": candidates,
        "ontology_states": states, "skipped": skipped,
        "truncated": truncated, "scanned": scanned,
    }
    captured = {"sources": snapshots, "raw_graphs": raw_graphs, "graphs": ready,
                    "graph_errors": graph_errors, "source_errors": source_errors,
                    "identities": identities, "scan_complete": scan_complete,
                    "scan_entries": scan_entries,
                    "captured_bytes": constants.MAX_CONNECTION_BYTES - remaining[0]}
    if capture_validated:
        captured["validated_graphs"] = validated
    return result, captured
