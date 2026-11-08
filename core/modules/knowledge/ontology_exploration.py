"""Search and bounded map pages over current, document-local identities.

SQLite contains rebuildable display summaries, never source bodies or evidence.
Canonical capture and projection replacement share the existing WikiStore lock.
Every page/count is SQL bounded; normal requests never decode all graph rows.
"""

from collections import Counter, defaultdict
from copy import deepcopy
import unicodedata

from core.common.json_codec import canonical_json_hash
from core.common.read_index import read_index, CanonicalIndexUnavailable
from core.common.read_changes import lock_stamp
from core.modules.documents.listing import (CatalogChangedError, InvalidCursorError,
                                           _decode_cursor, _encode_cursor)
from core.modules.knowledge.schema import ConceptValidationError
from core.modules.knowledge.schema import token as revision_token
from core.modules.ontology.anchors import normalize_anchor
from core.modules.reviews.values import actor_basis, _actor
from .ontology_exploration_index import NAMESPACE, observations, signature
from .values import _display_collection


_RETRY_CAPTURE_CODES = frozenset({"read_error", "permission_denied", "not_found", "observation_failed"})


def _normalized(value):
    return unicodedata.normalize("NFKC", value).casefold()


def _row(key, document, state, item, *, title="", subject=None, object_id=None):
    # Within this namespace the normalized source_id/revision columns are
    # endpoint lookup keys; actual document revisions live in item.ref.
    return key, {"owner": document, "state": state, "title": _normalized(title),
                 "source_id": subject, "revision": object_id, "item": item}


def _ref(entry):
    status = entry["machine_graph"]["status"]
    if status == "ready" and entry["machine_graph"].get("needs_reextraction"):
        status = "needs_reextraction"
    if status == "ready" and entry.get("effective_graph") is None:
        status = "unavailable"
    return {"kind": "document", "reference": entry["document"], "document": entry["document"],
            **{name: entry.get(name) for name in ("source_revision", "graph_revision", "review_revision",
                                                 "history_revision", "state_revision")}, "status": status}


def _endpoint(value, document, ref, concepts):
    """원문은 복사하지 않고 검증된 앵커의 위치와 별도 식별자만 투영한다."""
    if isinstance(value, str):
        return ({"document": document, "entity_id": value}, None) if value in concepts else (None, None)
    try:
        anchor = normalize_anchor(value, document=document, source_revision=ref["source_revision"])
    except (ValueError, UnicodeError):
        return None, None
    identifier = canonical_json_hash(anchor)
    summary = {"document": document, "anchor_id": identifier,
               **{name: anchor[name] for name in ("source_revision", "start_line", "end_line", "occurrence")},
               "ref": ref}
    return {"document": document, "anchor_id": identifier}, summary


def _endpoint_lookup(endpoint):
    """실제 개체 ID가 앵커 ID와 같아도 SQL 이웃을 섞지 않는다."""
    return ("e:" + endpoint["entity_id"] if "entity_id" in endpoint
            else "a:" + endpoint["anchor_id"])


def _anchor_label(anchor):
    """검색 미리보기에는 전체 인용 대신 판본에 연결된 원문 위치를 쓴다."""
    start, end = anchor["start_line"], anchor["end_line"]
    position = str(start) if start == end else f"{start}–{end}"
    return f"원문 근거 · {position}행"


def _project(owner, document, stamp):
    # A separate bounded capture per document avoids a permanent tenant cap.
    capture = owner._capture("query", None, None, None)
    entry = capture.document(document, purpose="map_projection", required_by=["exploration"], full=True)
    ref = _ref(entry)
    source = entry.get("source") or {}
    metadata = source.get("metadata") or {}
    title = metadata.get("title") or document
    graph = entry.get("effective_graph") or {}
    entities = graph.get("entities", [])
    attributes = Counter(item["subject"] for item in graph.get("attributes", []))
    concepts = {entity["id"]: {"document": document, "entity_id": entity["id"],
        "name": entity["label"], "type": entity["type"], "attribute_count": attributes[entity["id"]],
        "ref": ref} for entity in entities}
    claims = defaultdict(list)
    for claim in entry.get("claims", []):
        value = claim.get("reviewed_value")
        if value is not None and claim.get("decision") not in {"reject", "defer"}:
            claims[(_display_collection(claim), canonical_json_hash(value))].append(claim)
    edges, anchors, occurrences = [], {}, Counter()
    skipped = [{"document": document, "code": item["reason"]} for item in capture.skipped]
    for collection in ("relations", "relation_candidates"):
        for position, value in enumerate(graph.get(collection, [])):
            subject, subject_anchor = _endpoint(value.get("subject"), document, ref, concepts)
            object_id, object_anchor = _endpoint(value.get("object"), document, ref, concepts)
            if subject is None or object_id is None:
                skipped.append({"document": document, "code": "unavailable_relation_endpoint"})
                continue
            for anchor in (subject_anchor, object_anchor):
                if anchor is not None:
                    anchors[anchor["anchor_id"]] = anchor
            matched = claims.get((collection, canonical_json_hash(value)), [])
            claim = matched.pop(0) if matched else {}
            original = claim.get("original_collection", claim.get("collection", collection))
            claim_id = claim.get("claim_id")
            identity = (original, claim_id or canonical_json_hash(value))
            occurrence = occurrences[identity]
            occurrences[identity] += 1
            key = canonical_json_hash([document, *identity, occurrence])
            origin = ("policy" if claim.get("authored_kind") == "policy" or claim.get("policy_event_id")
                      or claim.get("latest_policy_event_id") else "independent" if claim.get("authored_event_id")
                      else "reviewed" if claim.get("review_event_id") else "machine")
            qualifiers = value.get("qualifiers") or {}
            edges.append({"key": key, "document": document,
                "subject": subject, "object": object_id,
                "label": value["predicate"], "origin": origin, "collection": collection,
                "original_collection": original, "claim_id": claim_id, "collection_index": position,
                "ref": ref, "polarity": qualifiers.get("polarity"), "modality": qualifiers.get("modality"),
                "conditional": qualifiers.get("condition") is not None})
    recent = f"{10**20 - min(stamp, 10**20 - 1):021d}:"
    rows = [_row(recent + "d:" + document, document, "document",
                 {"kind": "document", "ref": ref, "title": title,
                  "concept_count": len(concepts), "relation_count": len(edges)}, title=title + " " + document)]
    for identifier, concept in concepts.items():
        rows.append(_row(recent + "n:" + document + ":" + identifier, document, "concept",
            {"kind": "concept", "concept": concept, "concept_count": len(concepts)},
            title=concept["name"] + " " + concept["type"] + " " + title, subject=identifier))
    for edge in edges:
        rows.append(_row("e:" + edge["key"], document, "edge", edge,
                         subject=_endpoint_lookup(edge["subject"]), object_id=_endpoint_lookup(edge["object"])))
    for identifier, anchor in anchors.items():
        rows.append(_row("a:" + document + ":" + identifier, document, "anchor", anchor, subject=identifier))
    return rows, {"owner": document, "state": "manifest", "document_id": source.get("document_id"),
        "ref": ref, "skipped": skipped, "truncated": capture.truncated,
        "concept_count": len(concepts), "relation_count": len(edges), "anchor_count": len(anchors)}


class IndexPreparationStopped(Exception):
    """종료 시 완성된 파생 행은 보존하고 다음 준비에서 나머지를 계속한다."""


def _ensure(owner, index, scope, should_stop=None):
    observed = observations(owner.store)
    files = observed["files"]
    history = defaultdict(list)
    for path, value in sorted(files.items()):
        if path.startswith("_history/"):
            history[path[len("_history/"):].rpartition("/")[0]].append((path, value))
    documents = sorted(path[5:] for path in files if path.startswith("wiki/") and path.endswith(".md"))
    manifests = index.lookup(NAMESPACE, scope, filters={"state": "manifest"})
    active = set(documents)
    for key, (_, manifest) in list(manifests.items()):
        if manifest["owner"] not in active:
            index.replace_owner(NAMESPACE, scope, manifest["owner"], [])
            del manifests[key]
    for document in documents:
        if should_stop is not None and should_stop():
            raise IndexPreparationStopped()
        key = "m:" + document
        previous = manifests.get(key)
        previous_value = previous[1] if previous else {}
        current = signature(files, document, previous_value.get("document_id"), history=history[document])
        # File metadata cannot prove that a transient read/permission failure
        # persists. Keep the failed projection visible for this response, but
        # retry its canonical capture on the next request without requiring a
        # source write. Deterministic stale/missing/corrupt states still reuse
        # their observed signature until the underlying files change.
        retry_capture = any(item["code"] in _RETRY_CAPTURE_CODES for item in previous_value.get("skipped", []))
        if previous and previous[0] == current and not retry_capture:
            continue
        rows, manifest = _project(owner, document, files["wiki/" + document][3])
        current = signature(files, document, manifest.get("document_id"), history=history[document])
        index.replace_owner(NAMESPACE, scope, document,
            [(row_key, current, payload) for row_key, payload in [*rows, (key, manifest)]])
        manifests[key] = current, manifest
    expected_rows = sum(2 + value["concept_count"] + value["relation_count"] + value["anchor_count"]
                        for _, value in manifests.values())
    if index.count(NAMESPACE, scope) != expected_rows:
        raise CanonicalIndexUnavailable("Ontology projection rows are incomplete", reason="corrupt")
    skipped = [*observed["skipped"], *(item for _, value in manifests.values() for item in value["skipped"])]
    unique = {(item["document"], item["code"]): item for item in skipped}
    coverage = {"complete": not unique, "skipped": [unique[key] for key in sorted(unique)],
                "truncated": any(value["truncated"] for _, value in manifests.values())}
    revision = canonical_json_hash({"version": 2, "scope": scope,
        "documents": [(key, sig) for key, (sig, _) in sorted(manifests.items())], "coverage": coverage})
    return revision, coverage, manifests


def prepare_index(owner, *, should_stop=None):
    """같은 캡처·잠금으로 파생 색인만 준비하며 본문·그래프·원장을 저장하지 않는다."""
    scope = _arguments(owner, 5)
    with owner.store._write_lock(), read_index(owner.store) as index:
        if should_stop is not None and should_stop():
            raise IndexPreparationStopped()
        _ensure(owner, index, scope, should_stop)
        # 두 투영의 기준은 같은 잠금 안에서 고정해야 준비 직후 쓰기를 놓치지 않는다.
        from .question_index import ensure_locked
        ensure_locked(owner.store, owner.actor, index, should_stop=should_stop)
        # 잠금 안의 변경 기준을 반환해야 종료 직후의 새 저장을 놓치지 않는다.
        return lock_stamp(owner.store, "wiki")


def _arguments(owner, limit, document=None):
    _actor(owner.actor)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ConceptValidationError("limit must be an integer from 1 to 100")
    if document is not None:
        owner.store._document_path(owner.store.wiki_dir, document)
    return canonical_json_hash({"actor": actor_basis(owner.actor), "version": 2})


def _position(owner, cursor, scope, revision):
    if cursor is None:
        return None
    previous = _decode_cursor(cursor, owner.actor["tenant"], scope)
    if previous["catalog"] != revision:
        raise CatalogChangedError()
    return previous["after"]


def _page(owner, index, scope, revision, cursor_scope, cursor, limit, **options):
    after = _position(owner, cursor, cursor_scope, revision)
    total = index.count(NAMESPACE, scope, **options)
    rows = index.page(NAMESPACE, scope, after=after, limit=limit + 1, **options)
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = (_encode_cursor({"version": 1, "tenant": owner.actor["tenant"], "scope": cursor_scope,
        "catalog": revision, "after": rows[-1][0]}) if more else None)
    return rows, total, next_cursor


def _edge_options(document, entity_id=None):
    lookup = "e:" + entity_id if entity_id is not None else None
    return {"filters": {"owner": document, "state": "edge"},
            "any_filters": {"source_id": lookup, "revision": lookup} if lookup is not None else None}


def _previews(index, scope, document, entity_id=None):
    previews = []
    for _, payload in index.page(NAMESPACE, scope, limit=2, **_edge_options(document, entity_id)):
        edge = payload["item"]
        incoming = entity_id is not None and edge["subject"].get("entity_id") != entity_id
        other = edge["subject" if incoming else "object"]
        is_concept = "entity_id" in other
        identifier = other["entity_id" if is_concept else "anchor_id"]
        endpoint = index.page(NAMESPACE, scope, limit=1,
            filters={"owner": document, "state": "concept" if is_concept else "anchor", "source_id": identifier})
        if not endpoint:
            other_name = identifier
        elif is_concept:
            other_name = endpoint[0][1]["item"]["concept"]["name"]
        else:
            other_name = _anchor_label(endpoint[0][1]["item"])
        previews.append({"label": edge["label"], "other_name": other_name,
            "direction": "incoming" if incoming else "outgoing", "origin": edge["origin"],
            **{name: edge[name] for name in ("polarity", "modality", "conditional")}})
    return previews


def explore_search(owner, text="", *, kind="all", document=None, cursor=None, limit=20):
    scope = _arguments(owner, limit, document)
    if type(text) is not str or len(text) > 4000 or kind not in {"all", "concept", "document"}:
        raise ConceptValidationError("Invalid ontology exploration search")
    needle = _normalized(text.strip())
    cursor_scope = canonical_json_hash({"scope": scope, "text": needle, "kind": kind, "document": document})
    with owner.store._write_lock(), read_index(owner.store) as index:
        revision, coverage, _ = _ensure(owner, index, scope)
        filters = {"state": ["document", "concept"] if kind == "all" else kind}
        if document is not None:
            filters["owner"] = document
        rows, total, next_cursor = _page(owner, index, scope, revision, cursor_scope, cursor, limit,
                                        filters=filters, search=needle or None)
        items = []
        for _, payload in rows:
            item = deepcopy(payload["item"])
            doc = payload["owner"]
            entity = item["concept"]["entity_id"] if item["kind"] == "concept" else None
            item["previews"] = _previews(index, scope, doc, entity)
            if entity is not None:
                item["relation_count"] = index.count(NAMESPACE, scope, **_edge_options(doc, entity))
            else:
                item["concepts"] = [row[1]["item"]["concept"] for row in index.page(
                    NAMESPACE, scope, limit=5, filters={"state": "concept", "owner": doc})]
            items.append(item)
        return {"items": items, "index_revision": revision, "next_cursor": next_cursor,
                "total": total, "coverage": coverage}


def explore_neighbors(owner, document, entity_id, expected_state_revision, *, cursor=None, limit=20):
    scope = _arguments(owner, limit, document)
    if type(entity_id) is not str or not entity_id or type(expected_state_revision) is not str:
        raise ConceptValidationError("An entity and its current state revision are required")
    revision_token(expected_state_revision, "expected_state_revision")
    cursor_scope = canonical_json_hash({"scope": scope, "document": document, "entity_id": entity_id,
                                       "expected_state_revision": expected_state_revision})
    with owner.store._write_lock(), read_index(owner.store) as index:
        _, _, manifests = _ensure(owner, index, scope)
        observed = manifests.get("m:" + document)
        if observed is None:
            raise FileNotFoundError(document)
        ref = observed[1]["ref"]
        if ref["state_revision"] != expected_state_revision or ref["status"] != "ready":
            raise CatalogChangedError()
        manifest = observed[1]
        coverage = {"complete": not manifest["skipped"], "skipped": manifest["skipped"],
                    "truncated": manifest["truncated"]}
        revision = canonical_json_hash({"scope": scope, "document": document,
                                        "signature": observed[0], "coverage": coverage})
        selected = index.page(NAMESPACE, scope, limit=1,
                             filters={"owner": document, "state": "concept", "source_id": entity_id})
        if not selected:
            raise InvalidCursorError("The selected ontology entity is unavailable; search again")
        rows, total, next_cursor = _page(owner, index, scope, revision, cursor_scope, cursor, limit,
                                        **_edge_options(document, entity_id))
        edges = [payload["item"] for _, payload in rows]
        endpoints = [edge[side] for edge in edges for side in ("subject", "object")]
        identifiers = {entity_id, *(item["entity_id"] for item in endpoints if "entity_id" in item)}
        anchor_ids = {item["anchor_id"] for item in endpoints if "anchor_id" in item}
        concepts = [payload["item"]["concept"] for _, payload in index.page(NAMESPACE, scope,
            limit=len(identifiers), filters={"owner": document, "state": "concept", "source_id": sorted(identifiers)})]
        anchors = []
        if anchor_ids:
            anchors = [payload["item"] for _, payload in index.page(NAMESPACE, scope,
                limit=len(anchor_ids), filters={"owner": document, "state": "anchor", "source_id": sorted(anchor_ids)})]
        return {"document": ref, "entity_id": entity_id, "concepts": concepts, "anchors": anchors, "edges": edges,
                "index_revision": revision, "next_cursor": next_cursor, "total": total, "coverage": coverage}
