"""등록 원본과 기존 위키를 같은 목록 기준에서 발견하는 읽기 조합.

원본과 위키 사이의 계보를 추측하지 않는다. 조정 잠금→저장 잠금 안에서 목록의
기준을 확보한다. 계보 묶기는 명시적으로 요청한 목록에서만 적용한다.
"""

# list_catalogue는 등록 원본과 계보가 없는 기존 위키를 한 목록으로 보여 주는 입구다.
# 같은 제목이어도 어떤 원본에서 위키가 나왔는지 추정하지 않는다. cursor에는 관측한 목록 기준이 함께 묶인다.

import base64
from hashlib import sha256
import json

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.common.read_index import CanonicalIndexUnavailable, read_index
from core.common.read_metrics import cache_event
from core.modules.documents.listing import (
    CatalogChangedError, InvalidCursorError, MAX_CURSOR_CHARACTERS, MAX_PAGE_SIZE, MAX_LIST_SKIPPED,
    _decode_cursor, _error_code, _scan, _indexed_keys, list_documents,
)
from core.modules.sources.store import SourceStore
from core.modules.documents.changes import document_fields
from core.modules.documents.metadata import parse_document
from core.modules.documents.search import fold, search_documents


def _wiki_item(store, document):
    snapshot = store.read(document)
    fields = document_fields(store, document, snapshot)
    return {"document": document, "revision": snapshot.revision,
            "source_status": "linked" if fields["metadata"].get("source") else "unlinked", **fields}


def _lineages(store, records, scope_hash, skipped):
    """본문의 실제 계보만 파생 캐시에 보관한다. 일시적인 읽기 실패는 캐시하지 않는다."""
    def load(document):
        metadata = parse_document(store.read(document).content).metadata
        source = metadata.get("source")
        return {"source": {"id": source["id"], "version": source["version"]} if source else None}

    try:
        with read_index(store) as index:
            index.sync("catalogue.lineage", scope_hash,
                       [(record[0], canonical_json_hash(record)) for record in records], load)
            values = dict(index.values("catalogue.lineage", scope_hash))
            for value in values.values():
                source = value.get("source")
                if (set(value) != {"source"} or source is not None and
                        (type(source) is not dict or set(source) != {"id", "version"}
                         or any(type(part) is not str for part in source.values()))):
                    raise CanonicalIndexUnavailable("Invalid cached source lineage.", reason="corrupt")
            return {document: value["source"] for document, value in values.items()}
    except CanonicalIndexUnavailable as error:
        cache_event("fallback", error.reason)
    except (OSError, ValueError):
        # 실패한 자료를 개별적으로 다시 확인하고 기존 skipped 계약으로 알린다.
        pass
    values = {}
    for record in records:
        try:
            values[record[0]] = load(record[0])["source"]
        except (OSError, ValueError) as error:
            skipped.append({"document": record[0], "code": _error_code(error)})
    return values


def _source_documents(store, catalogs, records, scope_hash, skipped):
    """현재 원본 판본과 정확히 일치한 Wiki만 묶는다. 이전 판본 결과는 독립 행이다."""
    current = {(catalog["source_id"], catalog["item"]["source_version"]): catalog["source_id"]
               for catalog in catalogs}
    linked = {catalog["source_id"]: [] for catalog in catalogs}
    grouped = set()
    for document, source in _lineages(store, records, scope_hash, skipped).items():
        source_id = current.get((source["id"], source["version"])) if source else None
        if source_id is not None:
            linked[source_id].append(document)
            grouped.add(document)
    return linked, grouped


def _with_documents(store, item, documents, skipped, matches=None):
    """여러 Wiki 결과를 모두 열 수 있도록 문서 경로·현재 판본과 출처를 보존한다."""
    results = []
    for document in documents:
        try:
            wiki = _wiki_item(store, document)
            if matches and document in matches:
                match = matches[document]
                if match["revision"] != wiki["revision"]:
                    raise ValueError("The searched document changed.")
                wiki["snippet"] = match["snippet"]
            results.append(wiki)
        except (OSError, ValueError) as error:
            failure = {"document": document, "code": _error_code(error)}
            if failure not in skipped:
                skipped.append(failure)
    return {**item, "documents": results}


def _cursor(value):
    return "sc1_" + base64.urlsafe_b64encode(canonical_json_bytes(value)).rstrip(b"=").decode("ascii")


def _position(cursor, *, tenant, scope_hash, basis):
    try:
        if type(cursor) is not str or not cursor or len(cursor) > MAX_CURSOR_CHARACTERS:
            raise InvalidCursorError()
        if not cursor.startswith("sc1_"):
            # 원본 등록 전의 유효한 위키 cursor는 잘못된 입력과 목록 변경을 구분한다.
            _decode_cursor(cursor, tenant, scope_hash)
            raise CatalogChangedError()
        encoded = cursor[4:]
        value = json.loads(base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
        if (type(value) is not dict or set(value) != {"tenant", "scope", "basis", "after"}
                or value["tenant"] != tenant or value["scope"] != scope_hash
                or type(value["after"]) is not str or _cursor(value) != cursor):
            raise InvalidCursorError()
        if value["basis"] != basis:
            raise CatalogChangedError()
        return value["after"]
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise InvalidCursorError() from None


def list_catalogue(store, *, tenant, scope_key, limit=20, cursor=None, group_sources=False):
    """원본만 있는 등록 항목과 계보 없는 기존 문서를 모두 보존한다."""
    # tenant/scope와 페이지 기준에서 등록 원본 및 위키를 모은다. 원본 계보가 확인되지 않은 위키는 unlinked로 남긴다.
    if type(limit) is not int or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError("Invalid page size.")
    if type(group_sources) is not bool:
        raise ValueError("group_sources must be a boolean.")
    sources = SourceStore(store)
    scope_hash = sha256(scope_key.encode("utf-8")).hexdigest()
    with sources._coordination_lock():
        catalogs = sources._capture_summaries_locked()
        if not catalogs:
            if isinstance(cursor, str) and cursor.startswith("sc1_"):
                raise CatalogChangedError()
            # 기존 저장소는 응답·cursor·조회 부작용도 기존 목록 계약을 유지한다.
            return list_documents(store, tenant=tenant, scope_key=scope_key, limit=limit, cursor=cursor)
        with store._write_lock():
            records, skipped, scanned, truncated = _scan(store)
            skipped = list(skipped)
            linked, grouped = ({}, set())
            if group_sources:
                linked, grouped = _source_documents(store, catalogs, records, scope_hash, skipped)
            basis_value = {"sources": [[c["source_id"], c["registration_revision"]] for c in catalogs],
                           "wiki": records, "skipped": skipped, "truncated": truncated}
            if group_sources:
                basis_value["group_sources"] = True
            basis = canonical_json_hash(basis_value)
            entries = []
            for catalog in catalogs:
                entries.append(("source:" + catalog["source_id"], catalog["item"]))
            entries.extend(("wiki:" + record[0], None) for record in records if record[0] not in grouped)
            entries.sort(key=lambda entry: entry[0])
            keys = [key for key, _ in entries]
            offset = 0
            after = None
            if cursor is not None:
                after = _position(cursor, tenant=tenant, scope_hash=scope_hash, basis=basis)
                try:
                    offset = keys.index(after) + 1
                except ValueError:
                    raise InvalidCursorError() from None
            wiki_signatures = {record[0]: canonical_json_hash(record) for record in records}
            namespace = "catalogue.grouped" if group_sources else "catalogue"
            page_keys = _indexed_keys(store, namespace, scope_hash,
                [(key, canonical_json_hash(source) if source is not None else
                  wiki_signatures[key[len("wiki:"):]])
                 for key, source in entries],
                after=after, limit=limit)
            by_key = dict(entries)
            page = ([(key, by_key[key]) for key in page_keys] if page_keys is not None
                    else entries[offset:offset + limit])
            items = []
            for key, source in page:
                if source is not None:
                    items.append(_with_documents(store, source, linked[source["source_id"]], skipped)
                                 if group_sources else source)
                    continue
                document = key[len("wiki:"):]
                try:
                    items.append(_wiki_item(store, document))
                except (OSError, ValueError) as error:
                    failure = {"document": document, "code": _error_code(error)}
                    if failure not in skipped:
                        skipped.append(failure)
            more = offset + len(page) < len(entries)
            next_cursor = (_cursor({"tenant": tenant, "scope": scope_hash, "basis": basis, "after": page[-1][0]})
                           if more and not truncated else None)
            if len(skipped) > MAX_LIST_SKIPPED:
                skipped = skipped[:MAX_LIST_SKIPPED]
                truncated = True
                next_cursor = None
            return {"items": items, "scope": {"tenant": tenant, "kind": "source_documents"},
                    "catalog_revision": basis, "next_cursor": next_cursor, "complete": not (more or truncated or skipped),
                    "truncated": truncated, "skipped": skipped, "scanned": scanned + len(catalogs),
                    "requires_refresh": False}


def search_catalogue(store, query, limit, *, scope_key):
    """기존 검색 한도·부분 표시를 유지하고 정확한 현재 원본 계보별 결과를 묶는다."""
    if type(limit) is not int or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError("Invalid page size.")
    sources = SourceStore(store)
    scope_hash = sha256(scope_key.encode("utf-8")).hexdigest()
    with sources._coordination_lock():
        catalogs = sources._capture_summaries_locked()
        with store._write_lock():
            value = search_documents(store, query, limit, read_error_code=_error_code)
            records, scan_skipped, _, scan_truncated = _scan(store)
            skipped = list(value["skipped"])
            skipped.extend(item for item in scan_skipped if item not in skipped)
            linked, _ = _source_documents(store, catalogs, records, scope_hash, skipped)
            matches = {item["document"]: item for item in value["matches"]}
            needle = fold(query.strip())
            title_matches = [catalog for catalog in catalogs if needle in fold(catalog["item"]["title"])]
            selected = {catalog["source_id"] for catalog in title_matches[:limit]}
            selected.update(source_id for source_id, documents in linked.items()
                            if any(document in matches for document in documents))
            source_matches = [_with_documents(store, catalog["item"], linked[catalog["source_id"]],
                                               skipped, matches)
                              for catalog in catalogs if catalog["source_id"] in selected]
            grouped = {item["document"] for source in source_matches for item in source["documents"]}
            return {**value, "matches": [item for item in value["matches"] if item["document"] not in grouped],
                    "skipped": skipped[:MAX_LIST_SKIPPED],
                    "truncated": value["truncated"] or scan_truncated or len(skipped) > MAX_LIST_SKIPPED,
                    "sources": {"matches": source_matches, "truncated": len(title_matches) > limit,
                                "scanned": len(catalogs)}}
