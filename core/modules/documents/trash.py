"""현재 문서만 휴지통으로 옮긴다. 전체 이력과 파생 지식 기록은 그대로 둔다."""

from datetime import datetime, timezone
from hashlib import sha256
import os
import re

from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_bytes
from core.common.read_changes import before_change
from . import changes
from .metadata import parse_document
from .store import RevisionConflictError

MAX_TRASH_ITEMS = 1000
_HEX = re.compile(r"[0-9a-f]{64}")


def directory(store, document):
    """검증된 논리 문서 이름을 충돌 없는 휴지통 위치에 연결한다."""
    store._document_path(store.wiki_dir, document)
    path = store.data_dir / "_trash" / "documents" / sha256(document.encode("utf-8")).hexdigest()
    store._check_path(path / "content.md")
    store._check_path(path / "record.json")
    return path


def is_trashed(store, document):
    return (directory(store, document) / "content.md").exists()


def write_record(store, path, value, failures):
    """메타정보 공개 뒤 임시 정리 실패를 성공 결과와 구분한다."""
    store._mkdir(path.parent)
    store._check_path(path)
    with store._staged_file(path.parent, canonical_json_bytes(value), failures) as staged:
        os.replace(staged.path, path)
        staged.consumed = True


def _record(store, location):
    from core.modules.sources.files import read_json, open_regular
    from core.modules.sources.contracts import SourceCorruptError
    from .history import validate_history_id
    record = read_json(store, location / "record.json")
    try:
        if (set(record) != {"kind", "document", "title", "revision", "deleted_at", "actor", "history_id"}
                or record["kind"] != "wiki"
                or any(type(record[key]) is not str for key in ("document", "title", "revision", "deleted_at", "history_id"))
                or not _HEX.fullmatch(record["revision"])
                or directory(store, record["document"]) != location
                or datetime.fromisoformat(record["deleted_at"]).tzinfo is None):
            raise ValueError()
        validate_history_id(record["history_id"])
        changes.provenance(record["actor"], "human", None)
    except (ValueError, TypeError, KeyError) as error:
        raise SourceCorruptError("Invalid document trash record") from error
    with open_regular(store, location / "content.md") as stream:
        raw = stream.read()
    if store._revision(raw) != record["revision"]:
        raise SourceCorruptError("Trashed document differs from its recorded revision")
    raw.decode("utf-8")
    return record, raw


def move_to_trash(store, document, expected_revision, *, actor=None, before_commit=None):
    """CAS·권한·전체 이력을 확보한 뒤 현재 파일의 이름만 원자 이동한다."""
    location = directory(store, document)
    failures = []
    actor, _, _ = changes.provenance(actor, "human", None)
    try:
        with store._write_lock():
            snapshot = store.read(document)
            if expected_revision != snapshot.revision:
                raise RevisionConflictError(document, expected_revision, snapshot.revision)
            if is_trashed(store, document):
                raise RevisionConflictError(document, expected_revision, None)
            if before_commit is not None:
                before_commit()
            changes.reconcile(store, document, snapshot.revision, failures)
            before_change(store, "wiki", "wiki/" + document)
            history = store._archive(document, snapshot.content.encode("utf-8"), failures)
            parsed = parse_document(snapshot.content)
            record = {"kind": "wiki", "document": document,
                "title": parsed.metadata.get("title") or document,
                "revision": snapshot.revision, "deleted_at": datetime.now(timezone.utc).isoformat(),
                "actor": actor, "history_id": history.name}
            write_record(store, location / "record.json", record, failures)
            # 큰 전체 이력의 보존 중에도 권한이 회수될 수 있다. 실제 이동 바로 전에 다시 확인한다.
            if before_commit is not None:
                before_commit()
            os.rename(store._document_path(store.wiki_dir, document), location / "content.md")
    except Exception as error:
        if failures:
            error.cleanup_failures = cleanup_details(store.data_dir, failures)
        raise
    return {**record, "state": "trashed", "cleanup_failures": cleanup_details(store.data_dir, failures)}


def restore(store, document, expected_revision, *, before_commit=None):
    """휴지통에서 읽은 기준의 바이트를 비어 있는 원래 경로로 복원한다."""
    location = directory(store, document)
    with store._write_lock():
        record, raw = _record(store, location)
        target = store._document_path(store.wiki_dir, document)
        if expected_revision != record["revision"]:
            raise RevisionConflictError(document, expected_revision, record["revision"])
        if target.exists():
            raise RevisionConflictError(document, None, store.read(document).revision)
        if before_commit is not None:
            before_commit()
        store._validate_metadata(document, raw.decode("utf-8"), None)
        before_change(store, "wiki", "wiki/" + document)
        store._mkdir(target.parent)
        # 본문·중복 ID 검사와 디렉터리 준비 이후의 최신 권한으로만 공개한다.
        if before_commit is not None:
            before_commit()
        # 모든 협력 쓰기는 같은 잠금 아래에 있고 외부 직접 편집은 저장 계약 밖이다.
        os.rename(location / "content.md", target)
    return {**record, "state": "restored", "cleanup_failures": []}


def list_trash(store):
    """삭제된 현재 파일만 읽는다. 실패한 이동의 준비 메타정보는 삭제로 표시하지 않는다."""
    root = store.data_dir / "_trash" / "documents"
    items, skipped, scanned, truncated = [], [], 0, False
    with store._write_lock():
        store._check_path(root)
        if root.exists():
            with os.scandir(root) as entries:
                for entry in entries:
                    scanned += 1
                    if scanned > 50000 or len(items) >= MAX_TRASH_ITEMS:
                        truncated = True
                        break
                    try:
                        if entry.is_symlink() or not _HEX.fullmatch(entry.name) or not entry.is_dir():
                            raise ValueError("Invalid trash entry")
                        location = root / entry.name
                        store._check_path(location / "content.md")
                        if not (location / "content.md").exists():
                            continue
                        record, _ = _record(store, location)
                        items.append(record)
                    except (OSError, ValueError):
                        skipped.append({"code": "unreadable_trash_entry"})
    items.sort(key=lambda item: (item["deleted_at"], item["document"]), reverse=True)
    return {"items": items, "complete": not (truncated or skipped), "truncated": truncated,
            "skipped": skipped, "scanned": scanned, "next_cursor": None}
