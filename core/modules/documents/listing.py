"""허용 저장소의 제한된 문서 목록과 관측 기준에 묶인 페이지를 읽는다.

목록 기준은 저장 CAS가 아니다. WikiStore 쓰기와 같은 잠금 안에서 파일 경로와
메타데이터를 관측하며, 현재 페이지의 본문만 읽어 내용 revision을 확보한다.
외부 편집기의 저장·파일 메타데이터 위조는 WikiStore의 보존 계약 밖이다.
"""

# 목록은 list_documents에서 시작한다. cursor는 다음 페이지를 이어 읽을 위치와 목록 지문을 담는다.
# 목록이 바뀌면 옛 페이지 위치를 억지로 재사용하지 않고 처음부터 새로 읽게 한다.
# skipped는 읽지 못한 항목, truncated는 한도 때문에 탐색을 멈춘 상태로 빈 목록과 구분한다.

import base64
from hashlib import sha256
import json
import os
import re
import stat

from core.modules.documents.store import DocumentTooLargeError, WikiStore


DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 50
MAX_LIST_FILES = 1000
MAX_LIST_ENTRIES = 10000
MAX_LIST_DEPTH = 100
MAX_LIST_SKIPPED = 50
MAX_CURSOR_CHARACTERS = 16384
_HEX = re.compile(r"[0-9a-f]{64}")
_TENANT = re.compile(r"[a-z][a-z0-9_-]{0,63}")


class InvalidCursorError(ValueError):
    """형식이나 현재 인가 범위가 다른 페이지 기준."""


class CatalogChangedError(Exception):
    """첫 페이지부터 최신 목록을 다시 읽어야 하는 관측 기준 변경."""

    requires_refresh = True


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")


def _encode_cursor(value):
    return base64.urlsafe_b64encode(_json_bytes(value)).rstrip(b"=").decode("ascii")


def _decode_cursor(cursor, tenant, scope_key):
    # cursor를 단순 위치로 믿지 않고 형식·tenant·선택 범위 지문을 확인한다. 다른 조회의 이어읽기 위치를 섞지 않는다.
    try:
        if type(cursor) is not str or not cursor or len(cursor) > MAX_CURSOR_CHARACTERS:
            raise ValueError()
        raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        value = json.loads(raw)
        if type(value) is not dict or set(value) != {"version", "tenant", "scope", "catalog", "after"}:
            raise ValueError()
        if type(value["version"]) is not int or value["version"] != 1:
            raise ValueError()
        if value["tenant"] != tenant or value["scope"] != scope_key:
            raise ValueError()
        if type(value["catalog"]) is not str or not _HEX.fullmatch(value["catalog"]):
            raise ValueError()
        if type(value["after"]) is not str or not value["after"]:
            raise ValueError()
        if _encode_cursor(value) != cursor:
            raise ValueError()
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise InvalidCursorError("Invalid document cursor; read the first page again.") from None


def _error_code(error):
    if isinstance(error, DocumentTooLargeError):
        return "document_too_large"
    if isinstance(error, FileNotFoundError):
        return "not_found"
    if isinstance(error, ValueError):
        return "invalid_document"
    return "read_failed"


def _scan(store):
    """디렉터리 descriptor를 기준으로 링크를 따라가지 않고 제한 탐색한다."""
    # 호출자가 잡은 잠금 안에서 파일 목록과 메타데이터를 읽는다. 내용을 전부 읽는 검색과는 다르다.
    records = []
    skipped = []
    entries_seen = 0
    truncated = False

    def skip(document, code):
        nonlocal truncated
        skipped.append({"document": document, "code": code})
        if len(skipped) >= MAX_LIST_SKIPPED:
            truncated = True

    def walk(descriptor, prefix, depth):
        nonlocal entries_seen, truncated
        if depth > MAX_LIST_DEPTH:
            skip(prefix, "depth_limit")
            truncated = True
            return
        try:
            names = []
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    if entries_seen >= MAX_LIST_ENTRIES:
                        truncated = True
                        return
                    entries_seen += 1
                    names.append(entry.name)
            for name in sorted(names):
                document = f"{prefix}/{name}" if prefix else name
                try:
                    info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        skip(document, "invalid_document")
                    elif stat.S_ISDIR(info.st_mode):
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                        try:
                            walk(child, document, depth + 1)
                        finally:
                            os.close(child)
                    elif name.endswith(".md"):
                        if not stat.S_ISREG(info.st_mode):
                            skip(document, "invalid_document")
                            if truncated:
                                return
                            continue
                        if len(records) >= MAX_LIST_FILES:
                            truncated = True
                            return
                        records.append([document, info.st_dev, info.st_ino, info.st_size,
                                        info.st_mtime_ns, info.st_ctime_ns])
                except (OSError, ValueError) as error:
                    skip(document, _error_code(error))
                if truncated:
                    return
        except OSError as error:
            skip(prefix, _error_code(error))

    # root 자체의 링크 치환도 거부한다. 경로를 문자열로 이어 재귀 접근하지 않는다.
    descriptor = os.open(store.wiki_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        walk(descriptor, "", 0)
    finally:
        os.close(descriptor)
    records.sort(key=lambda record: record[0])
    skipped.sort(key=lambda item: (item["document"], item["code"]))
    return records, skipped, entries_seen, truncated


def list_documents(store: WikiStore, *, tenant: str, scope_key: str,
                   limit: int = DEFAULT_PAGE_SIZE, cursor: str | None = None) -> dict:
    """원문을 변경하지 않고 현재 페이지·불완전성과 새로고침 필요를 반환한다.

    호출자가 자료 접근 전에 tenant/read 인가를 완료해야 한다. scope_key에는
    현재 사용자·정책·적용 profile을 식별하는 값을 넣으며 이 함수는 그 hash만
    cursor에 넣는다. 탐색 상한으로 전 범위를 확보하지 못하면 cursor를 발급하지
    않는다. 일반 페이지의 complete는 선택한 페이지가 아니라 목록 끝까지의 완료다.
    """
    # limit은 페이지 크기, cursor는 이전 응답에서 받은 이어읽기 값이다. 목록·현재 페이지 revision·누락 상태를 반환한다.
    if type(tenant) is not str or not _TENANT.fullmatch(tenant):
        raise ValueError("Invalid tenant.")
    if type(scope_key) is not str or not scope_key or len(scope_key) > 4096:
        raise ValueError("Invalid scope key.")
    if type(limit) is not int or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError("limit must be an integer from 1 to 50.")
    scope_hash = sha256(scope_key.encode("utf-8")).hexdigest()
    previous = None if cursor is None else _decode_cursor(cursor, tenant, scope_hash)
    with store._write_lock():
        records, skipped, scanned, truncated = _scan(store)
        catalog = sha256(_json_bytes({"records": records, "skipped": skipped,
                                     "truncated": truncated})).hexdigest()
        paths = [record[0] for record in records]
        offset = 0
        if previous is not None:
            if previous["catalog"] != catalog:
                raise CatalogChangedError("Document listing changed; read the first page again.")
            try:
                offset = paths.index(previous["after"]) + 1
            except ValueError:
                raise InvalidCursorError("Invalid document cursor; read the first page again.") from None
        page = paths[offset:offset + limit]
        items = []
        for document in page:
            try:
                snapshot = store.read(document)
            except (OSError, ValueError) as error:
                skipped.append({"document": document, "code": _error_code(error)})
                continue
            items.append({"document": document, "revision": snapshot.revision,
                          "source_status": "unlinked"})
        more = offset + len(page) < len(paths)
        next_cursor = None
        if more and not truncated:
            next_cursor = _encode_cursor({"version": 1, "tenant": tenant, "scope": scope_hash,
                                          "catalog": catalog, "after": page[-1]})
        return {"items": items, "scope": {"tenant": tenant, "kind": "wiki_documents"},
                "catalog_revision": catalog, "next_cursor": next_cursor,
                "complete": not (more or truncated or skipped), "truncated": truncated,
                "skipped": skipped, "scanned": scanned, "requires_refresh": False}
