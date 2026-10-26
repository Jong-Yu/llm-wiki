"""수정 전 전체 파일을 안전하게 조회하고 기존 저장 절차로 복원한다.

history_id는 보관 파일의 이름이다. 내용의 revision과 달리 같은 본문을 여러 번
보관해도 서로 다른 파일을 가리킨다. 이 모듈은 기존 파일을 삭제하지 않는다.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import os
import re
import stat

from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_hash
from core.modules.documents.listing import (
    CatalogChangedError, InvalidCursorError, _decode_cursor, _encode_cursor,
)
from core.modules.documents.store import DocumentTooLargeError, MAX_DOCUMENT_BYTES

MAX_HISTORY_ENTRIES = 10000
MAX_SKIPPED = 50
_HISTORY_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,250}\.md")


def validate_history_id(history_id):
    """파일명 한 조각만 허용해 다른 문서·상위 폴더의 이력을 선택하지 못하게 한다."""
    if type(history_id) is not str or not _HISTORY_ID.fullmatch(history_id):
        raise ValueError("A single history filename is required")
    return history_id


@contextmanager
def _directory(store, document):
    """각 폴더를 링크를 따라가지 않는 descriptor로 연다. 끝나면 모두 닫는다."""
    store._document_path(store.history_dir, document)
    descriptor = os.open(store.history_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in document.split("/"):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def _read(descriptor, history_id, document):
    """정규 파일 하나를 제한 크기까지 읽어 본문과 hash를 같은 바이트에서 계산한다."""
    validate_history_id(history_id)
    fd = os.open(history_id, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("History entries must be regular files")
        raw = stream.read(MAX_DOCUMENT_BYTES + 1)
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise DocumentTooLargeError(document, len(raw))
    return {"history_id": history_id, "content": raw.decode("utf-8"),
            "revision": sha256(raw).hexdigest(), "size_bytes": len(raw),
            "archived_at": _archive_time(history_id), "author": None, "reason": None}


def _archive_time(history_id):
    """기존 저장기가 파일명에 남긴 보관 시각만 해석한다. 본문 작성 시각은 추정하지 않는다."""
    try:
        stamp = history_id.split("-", 1)[0]
        return datetime.strptime(stamp, "%Y%m%dT%H%M%S.%fZ").replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        return None


def read_version(store, document, history_id):
    """지정 문서의 과거 전체 본문을 읽는다. 조회는 현재 본문을 변경하지 않는다."""
    validate_history_id(history_id)
    with store._write_lock():
        # 삭제된 문서의 이력을 별도 자료처럼 노출하지 않고 현재 문서 소속부터 확인한다.
        store.read(document)
        with _directory(store, document) as descriptor:
            return {"document": document, **_read(descriptor, history_id, document)}


def list_versions(store, document, *, tenant, scope_key, limit=20, cursor=None):
    """현재 본문과 보관 이력의 참조를 분리하고 조회 범위·목록 판본에 묶어 페이지를 읽는다."""
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("Invalid page size")
    scope = canonical_json_hash({"kind": "document_versions", "document": document, "scope": scope_key})
    previous = None if cursor is None else _decode_cursor(cursor, tenant, scope)
    with store._write_lock():
        current = store.read(document)
        records, skipped, truncated = [], [], False
        try:
            with _directory(store, document) as descriptor:
                with os.scandir(descriptor) as entries:
                    for entry in entries:
                        if len(records) + len(skipped) >= MAX_HISTORY_ENTRIES:
                            truncated = True
                            break
                        try:
                            validate_history_id(entry.name)
                            info = entry.stat(follow_symlinks=False)
                            if not stat.S_ISREG(info.st_mode):
                                raise ValueError("History entries must be regular files")
                            records.append([entry.name, info.st_size, info.st_mtime_ns, info.st_ino])
                        except (OSError, ValueError):
                            skipped.append({"history_id": entry.name, "code": "invalid_history"})
                            if len(skipped) >= MAX_SKIPPED:
                                truncated = True
                                break
                records.sort(reverse=True)
                catalog = canonical_json_hash({"current": current.revision, "records": records,
                                               "skipped": skipped, "truncated": truncated})
                names = [value[0] for value in records]
                offset = _offset(previous, catalog, names)
                selected = names[offset:offset + limit]
                items = []
                for name in selected:
                    try:
                        item = _read(descriptor, name, document)
                        items.append({key: value for key, value in item.items() if key != "content"})
                    except (OSError, ValueError):
                        skipped.append({"history_id": name, "code": "read_failed"})
        except FileNotFoundError:
            # 보관 이력이 아직 없다는 정상 상태와 원본 문서 부재는 위 read에서 구분한다.
            catalog = canonical_json_hash({"current": current.revision, "records": []})
            _offset(previous, catalog, [])
            names, selected, items, offset = [], [], [], 0
        more = offset + len(selected) < len(names)
        next_cursor = _encode_cursor({"version": 1, "tenant": tenant, "scope": scope,
            "catalog": catalog, "after": selected[-1]}) if more and selected else None
        return {"document": document, "current": {"revision": current.revision}, "items": items,
                "catalog_revision": catalog, "next_cursor": next_cursor,
                "complete": not more and not truncated and not skipped, "truncated": truncated,
                "skipped": skipped, "requires_refresh": False}


def _offset(previous, catalog, names):
    """오래된 페이지 위치를 새 목록에 그대로 적용하지 않는다."""
    if previous is None:
        return 0
    if previous["catalog"] != catalog:
        raise CatalogChangedError("History changed; read its first page again")
    try:
        return names.index(previous["after"]) + 1
    except ValueError:
        raise InvalidCursorError("Unknown history cursor") from None


def save_content(store, document, content, expected_revision, *, before_commit=None):
    """직접 파일을 덮지 않고 공통 저장기로 수정 전 전체 파일과 CAS를 보존한다."""
    saved = store.save(document, content, expected_revision=expected_revision, before_commit=before_commit)
    return {"document": document, "revision": saved.revision, "changed": saved.changed,
            "history_id": None if saved.history_path is None else saved.history_path.name,
            "cleanup_failures": cleanup_details(store.data_dir, saved.cleanup_failures),
            "mutation_receipt": None, "retry_policy": "read_and_reconcile"}


def restore_version(store, document, history_id, expected_revision, *, before_commit=None):
    """과거 본문을 새 저장으로 적용한다. 현재 본문 역시 이력에 남고 옛 그래프·승인은 복원하지 않는다."""
    old = read_version(store, document, history_id)
    return {**save_content(store, document, old["content"], expected_revision,
                          before_commit=before_commit), "restored_from": history_id}
