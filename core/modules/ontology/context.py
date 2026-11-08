"""선택한 문서들의 전체 원문·그래프와 관점별 참조 그룹을 조합한다.

선택 관점은 접근 권한이나 삭제 필터가 아니다. 캡처 후에도 원문·다른 관점·
미분류 주장을 유지하고, 입력/출력 예산과 불완전한 결과를 별도로 보고한다."""

# selected_context는 사용자가 명시한 문서들의 전체 원문과 그래프를 묶는 입구다.
# focus/other_context/unclassified는 우선 읽을 주장 그룹이다. 다른 그룹의 조건이나 예외를 버리는 권한 필터가 아니다.
# 배열 위치는 그 그래프 버전에서만 의미가 있으므로 문서·원문·그래프 버전과 함께 사용한다.

from .storage import source_fields
from hashlib import sha256
import json
import re

from core.modules.documents.store import DocumentSnapshot
from . import constants
from .errors import OntologyValidationError, _ContextBudgetError, _connection_error
from .snapshots import _query_snapshot
from .values import _text


def _filter_snapshot(graph, domain, viewpoint) -> dict:
    """Filter claim metadata only; retain all entities for reference resolution."""
    # 단일 관점 조회의 주장 목록만 고른다. 끝점 참조에 필요한 개체 목록은 전체를 유지한다.
    if domain is None and viewpoint is None:
        return graph

    def matches(item):
        context = item.get("context", {})
        return ((domain is None or context.get("domain") == domain)
                and (viewpoint is None or viewpoint in context.get("viewpoints", [])))

    return {**graph, "filtered": {"domain": domain, "viewpoint": viewpoint},
            **{name: [item for item in graph[name] if matches(item)]
               for name in ("relations", "relation_candidates", "attributes")}}


def _context_selection(graph: dict, domain, viewpoint) -> dict:
    """Partition references without dropping claims or inventing shared context."""
    # 주장을 제거하는 대신 각 배열 위치를 focus/다른 관점/미분류 그룹으로 나눈다.
    selected = {}
    for collection in ("relations", "attributes", "relation_candidates"):
        groups = {"focus": [], "other_context": [], "unclassified": []}
        for index, item in enumerate(graph[collection]):
            context = item.get("context", {})
            item_domain = context.get("domain")
            viewpoints = context.get("viewpoints", [])
            if ((domain is not None and item_domain is None)
                    or (viewpoint is not None and not viewpoints)
                    or (domain is None and viewpoint is None
                        and item_domain is None and not viewpoints)):
                group = "unclassified"
            elif ((domain is None or domain == item_domain)
                  and (viewpoint is None or viewpoint in viewpoints)):
                group = "focus"
            else:
                group = "other_context"
            groups[group].append(index)
        selected[collection] = groups
    return selected


def selected_context(ontology, documents: list[str], *, domain=None, viewpoint=None) -> dict:
    """Return full source text and graphs from one explicitly bounded snapshot.

    View selection only groups claim-array indices; it neither establishes
    permission nor removes other views, unclassified claims, or prose. Each
    index is meaningful only with its document/source/graph revisions.
    """
    # documents는 명시한 문서 경로 목록이다. 반환 원문/그래프 전체와 incomplete/skip 상태를 함께 확인해야 한다.
    if (not isinstance(documents, list)
            or not 1 <= len(documents) <= constants.MAX_CONTEXT_DOCUMENTS):
        raise ValueError(f"documents must contain 1 to {constants.MAX_CONTEXT_DOCUMENTS} paths")
    if domain is not None:
        _text(domain, constants.MAX_EVIDENCE_CHARACTERS, "domain filter")
    if viewpoint is not None and (not isinstance(viewpoint, str) or viewpoint not in constants.VIEWPOINTS):
        raise OntologyValidationError("viewpoint filter must be a supported tag")
    # Validate every selector before opening any source. Reject aliases
    # instead of silently charging/returning one document under two names.
    for document in documents:
        ontology.store._document_path(ontology.store.wiki_dir, document)
    if len(set(documents)) != len(documents):
        raise ValueError("documents must not contain duplicate paths")

    skipped = []
    truncated = False
    captured = []
    remaining = [constants.MAX_CONTEXT_BYTES]

    def skip(document, code, component, *, omitted=True):
        nonlocal truncated
        skipped.append({"document": document, "code": code, "component": component})
        truncated = truncated or omitted

    with ontology.store._write_lock():
        identities = set()
        for document in documents:
            path = ontology.store._document_path(ontology.store.wiki_dir, document)
            try:
                info = path.stat()
            except OSError:
                continue  # Report a bounded source error in the capture loop.
            identity = (info.st_dev, info.st_ino)
            if identity in identities:
                raise ValueError("documents must not name the same file through aliases")
            identities.add(identity)
        for document in documents:
            path = ontology.store._document_path(ontology.store.wiki_dir, document)
            try:
                raw_source = ontology._context_bytes(path, remaining, document, "source")
                source = DocumentSnapshot(raw_source.decode("utf-8"), ontology.store._revision(raw_source))
            except (OSError, ValueError, TypeError) as error:
                code = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
                skip(document, code, "source")
                continue
            raw = None
            graph_error = None
            try:
                raw = ontology._context_bytes(ontology._path(document), remaining, document, "ontology")
            except (OSError, ValueError, TypeError) as error:
                graph_error = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
                skip(document, graph_error, "ontology")
            captured.append((document, source, raw, graph_error))

    entries = []
    # This budget covers the complete JSON document array, including its
    # brackets and commas. The small, bounded response metadata is separate.
    output_bytes = 2
    complete = len(captured) == len(documents)
    for document, source, raw, graph_error in captured:
        if graph_error is None:
            try:
                graph = _query_snapshot(document, source, raw)
            except (OSError, ValueError, TypeError) as error:
                graph_error = _connection_error(error)
                skip(document, graph_error, "ontology")
        if graph_error is not None:
            graph = {"document": document, "source_revision": source.revision,
                     "status": "unavailable", "error": {"code": graph_error},
                     "entities": [], "relations": [], "relation_candidates": [], "attributes": []}
        graph["graph_revision"] = sha256(raw).hexdigest() if raw is not None else None
        graph["needs_reextraction"] = graph.get("needs_reextraction", graph["status"] != "ready")
        if graph["status"] != "ready" or graph["needs_reextraction"]:
            complete = False
            if graph_error is None:
                code = ("needs_reextraction" if graph["status"] == "ready"
                        else "ontology_" + graph["status"])
                skip(document, code, "ontology", omitted=False)
        entry = {"document": document,
                 "source": {"content": source.content, "revision": source.revision,
                            **source_fields(source.content, include_body=True),
                            "line_start": 1 if source.content else 0,
                            "line_end": (len(re.findall(r"\r\n|\r|\n", source.content))
                                         + (not source.content.endswith(("\r", "\n")))) if source.content else 0},
                 "ontology": graph, "selection": _context_selection(graph, domain, viewpoint)}
        size = len(json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        size += bool(entries)
        if size > constants.MAX_CONTEXT_OUTPUT_BYTES - output_bytes:
            skip(document, "output_budget", "source")
            complete = False
            continue
        entries.append(entry)
        output_bytes += size
    return {"documents": entries, "requested_documents": list(documents),
            "layer": "machine", "review_tool": "ontology_review_query",
            "scope": {"kind": "explicit_documents", "auto_expanded": False},
            "selection": {"domain": domain, "viewpoint": viewpoint},
            "skipped": skipped, "truncated": truncated, "complete": complete,
            "captured_bytes": constants.MAX_CONTEXT_BYTES - remaining[0], "output_bytes": output_bytes,
            "limits": {"max_documents": constants.MAX_CONTEXT_DOCUMENTS,
                       "max_capture_bytes": constants.MAX_CONTEXT_BYTES,
                       "max_output_bytes": constants.MAX_CONTEXT_OUTPUT_BYTES}}
