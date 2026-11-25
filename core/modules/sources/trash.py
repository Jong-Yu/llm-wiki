"""불변 원본과 판본을 보존하는 등록 원본의 휴지통 상태."""

from datetime import datetime, timezone

from core.common.cleanup import cleanup_details
from core.common.read_changes import before_change
from core.modules.documents.trash import write_record
from . import files, queries, validation
from .contracts import SourceConflictError, SourceCorruptError, identifier, HEX, MAX_SOURCES


def path(self, source_id):
    identifier(source_id)
    return files.checked(self.store, self.store.data_dir / "_trash" / "sources" / (source_id + ".json"))


def state(self, source_id):
    """등록 메타정보를 바꾸지 않고 별도 상태를 엄격하게 읽는다."""
    try:
        value = files.read_json(self.store, path(self, source_id))
    except FileNotFoundError:
        return None
    if (set(value) != {"source_id", "registration_revision", "state", "deleted_at", "actor"}
            or value["source_id"] != source_id or type(value["state"]) is not str
            or value["state"] not in {"trashed", "restored"}
            or type(value["registration_revision"]) is not str or not HEX.fullmatch(value["registration_revision"])
            or type(value["deleted_at"]) is not str or type(value["actor"]) is not dict):
        raise SourceCorruptError("Invalid source trash record")
    try:
        if datetime.fromisoformat(value["deleted_at"]).tzinfo is None:
            raise ValueError()
        validation.actor(value["actor"], value["actor"]["tenant"], value["actor"]["user_id"])
    except (ValueError, TypeError, KeyError) as error:
        raise SourceCorruptError("Invalid source trash provenance") from error
    return value


def is_trashed(self, source_id):
    value = state(self, source_id)
    return value is not None and value["state"] == "trashed"


def _project(catalog, record):
    return {"kind": "source", "source_id": catalog["source_id"], "title": catalog["title"],
            "registration_revision": catalog["registration_revision"], "deleted_at": record["deleted_at"],
            "documents": catalog["documents"], "state": record["state"]}


def set_state(self, source_id, expected_registration_revision, *, restore=False, authorize):
    """기준 판본과 현재 권한을 같은 조정 잠금에서 검사한 뒤 표식만 교체한다."""
    if type(expected_registration_revision) is not str or not HEX.fullmatch(expected_registration_revision):
        raise ValueError("A registration revision is required")
    failures = []
    try:
        with self._coordination_lock():
            catalog = queries.get_source_locked(self, source_id, include_deleted=True)
            previous = state(self, source_id)
            if expected_registration_revision != catalog["registration_revision"]:
                raise SourceConflictError("conflict", source_id=source_id)
            if restore and (previous is None or previous["state"] != "trashed"):
                raise SourceConflictError("conflict", source_id=source_id)
            access = authorize()
            actor = validation.actor(access, access["tenant"], access["user_id"])
            if not restore and previous is not None and previous["state"] == "trashed":
                return {**_project(catalog, previous), "cleanup_failures": []}
            record = {"source_id": source_id, "registration_revision": catalog["registration_revision"],
                      "state": "restored" if restore else "trashed",
                      "deleted_at": previous["deleted_at"] if restore else datetime.now(timezone.utc).isoformat(),
                      "actor": actor}
            before_change(self.store, "registration", path(self, source_id).relative_to(self.store.data_dir).as_posix())
            # 원본 기준을 투영하는 기존 작업 목록의 관측도 무효화한다.
            before_change(self.store, "registration", self._catalog_path(source_id).relative_to(self.store.data_dir).as_posix())
            write_record(self.store, path(self, source_id), record, failures)
    except Exception as error:
        if failures:
            error.cleanup_failures = cleanup_details(self.store.data_dir, failures)
        raise
    return {**_project(catalog, record), "cleanup_failures": cleanup_details(self.store.data_dir, failures)}


def list_trash(self):
    """원본 본문·판본을 건드리지 않고 휴지통의 현재 등록 항목만 반환한다."""
    items, skipped, scanned = [], [], 0
    with self._coordination_lock():
        root = self.store.data_dir / "_trash" / "sources"
        for name in files.entries(self.store, root, maximum=MAX_SOURCES + 1):
            scanned += 1
            try:
                if not name.endswith(".json"):
                    raise SourceCorruptError("Unexpected trash entry")
                source_id = identifier(name[:-5])
                record = state(self, source_id)
                if record["state"] == "trashed":
                    catalog = queries.get_source_locked(self, source_id, include_deleted=True)
                    items.append(_project(catalog, record))
            except (OSError, ValueError, TypeError):
                skipped.append({"code": "unreadable_trash_entry"})
    items.sort(key=lambda item: (item["deleted_at"], item["source_id"]), reverse=True)
    return {"items": items, "complete": not skipped, "truncated": False, "skipped": skipped,
            "scanned": scanned, "next_cursor": None}
