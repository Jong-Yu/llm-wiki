"""등록 원본과 기존 위키를 같은 목록 기준에서 발견하는 읽기 조합.

원본과 위키 사이의 계보를 추측하지 않는다. 조정 잠금→저장 잠금 안에서 목록의
기준을 확보하며 실제 본문 revision은 현재 페이지의 문서에 한해 읽는다.
"""

# list_catalogue는 등록 원본과 계보가 없는 기존 위키를 한 목록으로 보여 주는 입구다.
# 같은 제목이어도 어떤 원본에서 위키가 나왔는지 추정하지 않는다. cursor에는 관측한 목록 기준이 함께 묶인다.

import base64
from hashlib import sha256
import json

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.documents.listing import (
    CatalogChangedError, InvalidCursorError, MAX_CURSOR_CHARACTERS, MAX_PAGE_SIZE,
    _decode_cursor, _error_code, _scan, list_documents,
)
from core.modules.sources.store import SourceStore


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


def list_catalogue(store, *, tenant, scope_key, limit=20, cursor=None):
    """원본만 있는 등록 항목과 계보 없는 기존 문서를 모두 보존한다."""
    # tenant/scope와 페이지 기준에서 등록 원본 및 위키를 모은다. 원본 계보가 확인되지 않은 위키는 unlinked로 남긴다.
    if type(limit) is not int or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError("Invalid page size.")
    sources = SourceStore(store)
    scope_hash = sha256(scope_key.encode("utf-8")).hexdigest()
    with sources._coordination_lock():
        catalogs = sources._capture_catalog_locked()
        if not catalogs:
            if isinstance(cursor, str) and cursor.startswith("sc1_"):
                raise CatalogChangedError()
            # 기존 저장소는 응답·cursor·조회 부작용도 기존 목록 계약을 유지한다.
            return list_documents(store, tenant=tenant, scope_key=scope_key, limit=limit, cursor=cursor)
        with store._write_lock():
            records, skipped, scanned, truncated = _scan(store)
            basis = canonical_json_hash({"sources": [[c["source_id"], c["registration_revision"]] for c in catalogs],
                "wiki": records, "skipped": skipped, "truncated": truncated})
            entries = []
            for catalog in catalogs:
                current = next(v for v in catalog["versions"] if v["source_version"] == catalog["current_version"])
                entries.append(("source:" + catalog["source_id"], {"kind": "source", "source_id": catalog["source_id"],
                    "title": catalog["title"], "source_version": current["source_version"],
                    "source_sha256": current["source_sha256"], "size_bytes": current["size_bytes"],
                    "format": current["format"], "registration_revision": catalog["registration_revision"],
                    "documents": catalog["documents"], "analysis_status": "not_started"}))
            entries.extend(("wiki:" + record[0], None) for record in records)
            entries.sort(key=lambda entry: entry[0])
            keys = [key for key, _ in entries]
            offset = 0
            if cursor is not None:
                after = _position(cursor, tenant=tenant, scope_hash=scope_hash, basis=basis)
                try:
                    offset = keys.index(after) + 1
                except ValueError:
                    raise InvalidCursorError() from None
            page = entries[offset:offset + limit]
            items = []
            for key, source in page:
                if source is not None:
                    items.append(source)
                    continue
                document = key[len("wiki:"):]
                try:
                    snapshot = store.read(document)
                    items.append({"document": document, "revision": snapshot.revision, "source_status": "unlinked"})
                except (OSError, ValueError) as error:
                    skipped.append({"document": document, "code": _error_code(error)})
            more = offset + len(page) < len(entries)
            next_cursor = (_cursor({"tenant": tenant, "scope": scope_hash, "basis": basis, "after": page[-1][0]})
                           if more and not truncated else None)
            return {"items": items, "scope": {"tenant": tenant, "kind": "source_documents"},
                    "catalog_revision": basis, "next_cursor": next_cursor, "complete": not (more or truncated or skipped),
                    "truncated": truncated, "skipped": skipped, "scanned": scanned + len(catalogs),
                    "requires_refresh": False}
