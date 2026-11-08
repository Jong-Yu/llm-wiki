"""개인 기록의 원자 저장·소유권·버전 충돌·같은 요청 확인을 공통 처리한다.

기존 원본 저장의 잠금·안전한 파일 접근·정규 JSON 기록을 재사용한다. 사용자
ID는 검증된 서버 ID를 쓰며 기존 hash 경로를 호환 조회한다. 한 JSON 안에 추가 이력을 보존하므로
파일 교체는 한 번이며 대화 내용을 덮어 고치거나 옛 이벤트를 삭제하지 않는다.
"""

from copy import deepcopy
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
from core.common.json_codec import canonical_json_hash
from core.common.storage_layout import personal_root
from core.modules.sources import files
from core.modules.sources.contracts import identifier, SourceLimitError
from core.modules.documents.listing import _decode_cursor, _encode_cursor, CatalogChangedError


KINDS = {"conversations", "saved-results", "comparisons", "result-drafts", "question-runs", "knowledge-comparisons"}
MAX_RECORDS = 200
MAX_EVENTS = 100


class PersonalConflictError(Exception):
    """현재 기록이나 같은 요청의 입력이 달라 명시 대조가 필요하다."""


class PersonalCorruptError(ValueError):
    """기존 기록이 손상되면 초기화하지 않고 그대로 보존한다."""


class PersonalLimitError(ValueError):
    """전체 기록이 한도를 넘으면 기존 내용을 자르지 않고 저장을 거부한다."""


def timestamp():
    """기록 시각은 클라이언트의 주장 대신 서버의 UTC 시각으로 남긴다."""
    return datetime.now(timezone.utc).isoformat()


class PersonalStore:
    """인가된 scope의 사용자 폴더에서만 기록을 읽고 추가한다."""

    def __init__(self, scope):
        self.scope, self.store = scope, scope.store
        owner = sha256(scope.user_id.encode("utf-8")).hexdigest()
        self.root = personal_root(self.store.data_dir, scope.user_id)
        self.legacy_root = self.store.data_dir / "_personal" / owner

    @contextmanager
    def _coordination(self, *, create=False):
        """기존 공통 잠금을 사용하되 개인 기록이 있는데 잠금이 사라졌으면 중단한다."""
        files.checked(self.store, self.root)
        files.checked(self.store, self.legacy_root)
        if (self.store.data_dir / "_personal").exists() and not (self.store.data_dir / ".registration.lock").exists():
            raise PersonalCorruptError("Personal coordination lock is unavailable")
        with files.coordination(self.store, create=create):
            yield

    def _path(self, kind, record_id):
        """허용한 자원 이름과 서버 형식 ID만 파일 경로로 사용한다."""
        if kind not in KINDS:
            raise ValueError("Unknown personal resource")
        identifier(record_id)
        return self._select_path(self.root / kind / f"{record_id}.json",
                                 self.legacy_root / kind / f"{record_id}.json")

    def _select_path(self, *paths):
        present = [path for path in paths if files.checked(self.store, path).exists()]
        if len(present) > 1:
            raise PersonalCorruptError("The same personal record exists in both layouts")
        return present[0] if present else paths[0]

    def _names(self, kind):
        current = files.entries(self.store, self.root / kind, maximum=MAX_RECORDS)
        legacy = files.entries(self.store, self.legacy_root / kind, maximum=MAX_RECORDS)
        if set(current) & set(legacy):
            raise PersonalCorruptError("Duplicate personal records in both layouts")
        if len(current) + len(legacy) > MAX_RECORDS:
            raise PersonalLimitError("Personal record count limit reached")
        return sorted([*current, *legacy])

    def _publish(self, kind, record_id, value):
        """공통 원자 기록의 바이트 한도 오류를 개인 기록의 오류로 구분한다."""
        try:
            files.write_json(self.store, self._path(kind, record_id), value)
        except SourceLimitError as error:
            raise PersonalLimitError("The complete personal record exceeds its byte limit") from error

    def _read(self, kind, record_id):
        """파일 안의 소유권도 대조해 다른 사용자의 기록을 섞지 않는다."""
        value = files.read_json(self.store, self._path(kind, record_id))
        if (value.get("schema_version") != 1 or value.get("kind") != kind or value.get("id") != record_id
                or value.get("tenant") != self.scope.tenant or value.get("user_id") != self.scope.user_id
                or type(value.get("events")) is not list or type(value.get("requests")) is not dict
                or len(value["events"]) > MAX_EVENTS or len(value["requests"]) > MAX_EVENTS + 1
                or type(value.get("data")) is not dict):
            raise PersonalCorruptError("Personal record is inconsistent")
        previous = None
        for event in value["events"]:
            if type(event) is not dict or event.get("previous_hash") != previous or event.get("hash") != canonical_json_hash({k: v for k, v in event.items() if k != "hash"}):
                raise PersonalCorruptError("Personal event history is inconsistent")
            previous = event["hash"]
        return value

    def read(self, kind, record_id):
        """명시한 개인 기록 전체와 CAS 기준 revision을 함께 반환한다."""
        with self._coordination():
            value = self._read(kind, record_id)
            return {"record": value, "revision": canonical_json_hash(value), "sharing": "personal"}

    def list(self, kind, *, scope_key, limit=20, cursor=None):
        """자기 폴더만 탐색하고 페이지를 사용자·관점·현재 목록 기준에 묶는다."""
        if kind not in KINDS or not 1 <= limit <= 50:
            raise ValueError("Invalid personal listing")
        with self._coordination():
            names = self._names(kind)
            values = []
            for name in names:
                if not name.endswith(".json"):
                    raise PersonalCorruptError("Unexpected personal record")
                value = self._read(kind, name[:-5])
                values.append({"id": value["id"], "title": value["data"].get("title", ""),
                    "created_at": value["created_at"], "revision": canonical_json_hash(value), "kind": kind})
            basis = canonical_json_hash(values)
            scope = canonical_json_hash([scope_key, kind, self.scope.user_id])
            after = ""
            if cursor:
                decoded = _decode_cursor(cursor, self.scope.tenant, scope)
                if decoded["catalog"] != basis:
                    raise CatalogChangedError()
                after = decoded["after"]
            remaining = [item for item in values if item["id"] > after]
            page = remaining[:limit]
            next_cursor = None
            if len(remaining) > limit:
                next_cursor = _encode_cursor({"version": 1, "tenant": self.scope.tenant, "scope": scope,
                    "catalog": basis, "after": page[-1]["id"]})
            return {"items": page, "next_cursor": next_cursor, "complete": True,
                    "truncated": False, "skipped": [], "scope": "current_user_only", "catalog_revision": basis}

    def create(self, kind, request_id, payload, data, actor, *, before_commit):
        """같은 요청 ID의 결과를 확인하도록 생성 ID를 요청에서 안정적으로 계산한다."""
        identifier(request_id)
        record_id = sha256(f"{kind}:{self.scope.tenant}:{self.scope.user_id}:{request_id}".encode()).hexdigest()[:32]
        with self._coordination(create=True):
            before_commit()
            try:
                old = self._read(kind, record_id)
            except FileNotFoundError:
                old = None
            fingerprint = canonical_json_hash(payload)
            if old is not None:
                if old["requests"].get(request_id) != fingerprint:
                    raise PersonalConflictError()
                return {"record": old, "revision": canonical_json_hash(old), "replayed": True, "changed": False}
            if len(self._names(kind)) >= MAX_RECORDS:
                raise PersonalLimitError("Personal record count limit reached")
            value = {"schema_version": 1, "id": record_id, "kind": kind, "tenant": self.scope.tenant,
                "user_id": self.scope.user_id, "created_at": timestamp(), "actor": actor, "data": deepcopy(data),
                "events": [], "requests": {request_id: fingerprint}}
            # 목록 탐색 중 정책이 바뀔 수 있으므로 실제 원자 교체 직전에 다시 확인한다.
            before_commit()
            self._publish(kind, record_id, value)
            return {"record": value, "revision": canonical_json_hash(value), "changed": True, "replayed": False}

    def receipt(self, kind, request_id, *, record_id=None, payload=None):
        """응답 유실 후 같은 요청이 실제 기록됐는지 읽기만으로 확인한다.

        추가 요청은 대상 record_id도 필요하다. 현재 내용이 같다는 추측 대신
        보존한 요청 ID와 입력 지문을 사용하며 새 이벤트를 만들지 않는다.
        """
        identifier(request_id)
        if record_id is None:
            record_id = sha256(f"{kind}:{self.scope.tenant}:{self.scope.user_id}:{request_id}".encode()).hexdigest()[:32]
        with self._coordination():
            value = self._read(kind, record_id)
            fingerprint = value["requests"].get(request_id)
            if fingerprint is None:
                raise FileNotFoundError()
            if payload is not None and fingerprint != canonical_json_hash(payload):
                raise PersonalConflictError()
            return {"record": value, "revision": canonical_json_hash(value), "request_id": request_id,
                    "request_confirmed": True, "replayed": True, "changed": False}

    def append(self, kind, record_id, request_id, expected_revision, payload, event, actor, *, before_commit):
        """같은 파일에 새 이벤트를 추가하며 오래된 revision으로 기록을 덮지 않는다."""
        identifier(request_id)
        with self._coordination(create=True):
            return self.append_locked(kind, record_id, request_id, expected_revision, payload, event, actor,
                                      before_commit=before_commit)

    def append_locked(self, kind, record_id, request_id, expected_revision, payload, event, actor, *, before_commit):
        """이미 공통 조정 잠금을 가진 복합 작업에서 같은 추가 절차를 재사용한다.

        공개 append와 달리 잠금을 다시 얻지 않는다. 위키 반영/답변 제출처럼
        여러 기록을 묶는 호출자는 _coordination을 먼저 보유해야 한다.
        """
        identifier(request_id)
        value = self._read(kind, record_id)
        before_commit()
        fingerprint = canonical_json_hash(payload)
        if request_id in value["requests"]:
            if value["requests"][request_id] != fingerprint:
                raise PersonalConflictError()
            return {"record": value, "revision": canonical_json_hash(value), "changed": False, "replayed": True}
        if canonical_json_hash(value) != expected_revision:
            raise PersonalConflictError()
        if len(value["events"]) >= MAX_EVENTS:
            raise PersonalLimitError("Personal event count limit reached")
        previous = value["events"][-1]["hash"] if value["events"] else None
        added = {**deepcopy(event), "id": request_id, "recorded_at": timestamp(), "actor": actor, "previous_hash": previous}
        added["hash"] = canonical_json_hash(added)
        value["events"].append(added)
        value["requests"][request_id] = fingerprint
        before_commit()
        self._publish(kind, record_id, value)
        return {"record": value, "revision": canonical_json_hash(value), "changed": True, "replayed": False}
