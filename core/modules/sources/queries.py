"""원본 카탈로그·소유 요청·불변 파일을 변경 없이 조회한다."""

# 조회는 카탈로그와 실제 원본의 근거를 대조하지만 저장·복구를 실행하지 않는다.
# *_locked 함수는 SourceStore가 이미 조정 잠금을 잡은 상태에서 호출하는 내부 함수다.

import base64
from hashlib import sha256
import json
import stat

from core.common.json_codec import canonical_json_hash
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from . import contracts as limits, files, validation
from .commands import result
from .contracts import SourceCorruptError, SourceLimitError


def get_source_locked(self, source_id):
    # 특정 등록의 전체 판본을 검증해 반환한다. 파일명은 사용자 표시 제목으로 만들지 않는다.
    limits.identifier(source_id)
    path = self.registrations_dir / (source_id + ".json")
    value = validation.catalog(files.read_json(self.store, path), source_id)
    if len(value["versions"]) > limits.MAX_VERSIONS:
        raise SourceLimitError("The source version count exceeds its limit.")
    return value


def capture_catalog_locked(self):
    # 등록 JSON 전체를 한 기준으로 읽는다. 요청 영수증 폴더는 목록 항목으로 취급하지 않는다.
    values, size = [], 0
    for name in files.entries(self.store, self.registrations_dir, maximum=limits.MAX_SOURCES + 2):
        if name == "_requests":
            continue
        if not name.endswith(".json") or not limits.ID.fullmatch(name[:-5]):
            raise SourceCorruptError("The registration catalog contains an unexpected entry.")
        path = self.registrations_dir / name
        with files.open_regular(self.store, path) as stream:
            size += stream.seek(0, 2)
        if size > limits.MAX_CATALOG_BYTES:
            raise SourceLimitError("The total catalog metadata limit was reached.")
        if len(values) >= limits.MAX_SOURCES:
            raise SourceLimitError("The registration count exceeds its limit.")
        values.append(get_source_locked(self, name[:-5]))
    return values


def summary(catalog):
    # 전체 판본 기록에서 목록 화면에 필요한 최신 판본 정보만 추려 새 dict로 만든다.
    current = catalog["versions"][-1]
    return {"source_id": catalog["source_id"], "title": catalog["title"],
        "current_version": catalog["current_version"], "source_sha256": current["source_sha256"],
        "size_bytes": current["size_bytes"], "kind": current["kind"], "format": current["format"],
        "version_count": len(catalog["versions"]), "documents": catalog["documents"],
        "registration_revision": catalog["registration_revision"], "analysis_status": "not_started"}


def list_sources(self, *, tenant, scope_key, limit=20, cursor=None):
    # cursor는 '어느 권한/카탈로그의 어느 항목 뒤인가'를 담는다. 단순한 페이지 숫자가 아니다.
    if type(limit) is not int or not 1 <= limit <= limits.MAX_PAGE_SIZE:
        raise limits.SourceValidationError("limit must be an integer from 1 to 50.")
    if type(scope_key) is not str or not scope_key or len(scope_key) > 4096:
        raise limits.SourceValidationError("A current authorization scope is required.")
    scope = canonical_json_hash({"tenant": tenant, "scope": scope_key, "sort": "source_id"})
    previous = None
    if cursor is not None:
        try:
            if type(cursor) is not str or len(cursor) > 4096:
                raise ValueError()
            previous = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True))
            if type(previous) is not dict or set(previous) != {"scope", "catalog", "after"} or previous["scope"] != scope:
                raise ValueError()
            limits.identifier(previous["after"])
        except (ValueError, TypeError, RecursionError):
            raise InvalidCursorError("Invalid source cursor.") from None
    with self._coordination_lock():
        catalog = self._capture_catalog_locked()
        revision = canonical_json_hash(catalog)
        offset = 0
        if previous is not None:
            if previous["catalog"] != revision:
                # 페이지 사이에 등록이 바뀌었다면 처음부터 다시 조회하게 하여 누락/중복을 막는다.
                raise CatalogChangedError("The source listing basis changed.")
            try:
                offset = [item["source_id"] for item in catalog].index(previous["after"]) + 1
            except ValueError:
                raise InvalidCursorError("Invalid source cursor position.") from None
        page = catalog[offset:offset + limit]
        more = offset + len(page) < len(catalog)
        next_cursor = None
        if more:
            value = {"scope": scope, "catalog": revision, "after": page[-1]["source_id"]}
            next_cursor = base64.urlsafe_b64encode(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).rstrip(b"=").decode()
        return {"items": [summary(item) for item in page], "scope": {"tenant": tenant, "kind": "registered_sources"},
            "catalog_revision": revision, "next_cursor": next_cursor, "complete": not more,
            "truncated": False, "skipped": [], "scanned": len(catalog), "requires_refresh": False}


def request_receipt(self, *, tenant, user_id, request_id):
    # 통신이 끊겨 응답을 못 받은 요청의 근거를 읽는다. 이 함수가 원본을 다시 저장하지는 않는다.
    with self._coordination_lock():
        record = self._request_locked(tenant, user_id, request_id)
        if record["state"] == "complete":
            return result(record, replayed=True)
        # 원본과 현재 카탈로그 양쪽이 같은 영구 intent의 결과인 경우에만 읽기 증거로 확정한다.
        try:
            catalog = self._get_source_locked(record["source_id"])
            expected = record["manifest"]
            actual = files.read_json(self.store, self.sources_dir / record["source_id"] / record["source_version"] / "manifest.json")
            if actual != expected or expected not in catalog["versions"]:
                return result(record, replayed=True)
            with files.verify_original(self.store, self.sources_dir / record["source_id"] / record["source_version"] / "original", actual):
                pass
            evidence = {"request_id": request_id, "source_id": record["source_id"], "source_version": record["source_version"],
                "source_sha256": actual["source_sha256"], "size_bytes": actual["size_bytes"],
                "registration_revision": record["registration_revision"], "actor": actual["actor"],
                "created_at": actual["created_at"], "storage_status": "stored", "analysis_status": "not_started",
                "confirmation": "intent_manifest_catalog"}
            return result(record, replayed=True, state="complete", evidence=evidence)
        except FileNotFoundError:
            return result(record, replayed=True)


def open_original(self, source_id, source_version):
    # 선택 판본이 목록·설명서·실제 바이트에서 모두 일치하면 열린 스트림과 설명서를 반환한다.
    limits.identifier(source_id)
    limits.identifier(source_version)
    with self._coordination_lock():
        catalog = self._get_source_locked(source_id)
        expected = next((item for item in catalog["versions"] if item["source_version"] == source_version), None)
        if expected is None:
            raise FileNotFoundError()
        directory = self.sources_dir / source_id / source_version
        actual = validation.manifest(files.read_json(self.store, directory / "manifest.json"), source_id, source_version)
        if actual != expected:
            raise SourceCorruptError("The original manifest differs from its catalog.")
        return files.verify_original(self.store, directory / "original", actual), actual
