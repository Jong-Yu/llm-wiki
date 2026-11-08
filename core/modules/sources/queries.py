"""원본 카탈로그·소유 요청·불변 파일을 변경 없이 조회한다."""

# 조회는 카탈로그와 실제 원본의 근거를 대조하지만 저장·복구를 실행하지 않는다.
# *_locked 함수는 SourceStore가 이미 조정 잠금을 잡은 상태에서 호출하는 내부 함수다.

import base64
import json
import os
import unicodedata

from core.common.json_codec import canonical_json_hash
from core.common.read_index import CanonicalIndexUnavailable, read_index
from core.common.read_metrics import cache_event
from core.common.read_snapshots import observation
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from . import contracts as limits, files, validation
from .commands import result
from .contracts import SourceCorruptError, SourceLimitError


def get_source_locked(self, source_id):
    # 특정 등록의 전체 판본을 검증해 반환한다. 파일명은 사용자 표시 제목으로 만들지 않는다.
    limits.identifier(source_id)
    path = self._catalog_path(source_id)
    value = validation.catalog(files.read_json(self.store, path), source_id)
    if len(value["versions"]) > limits.MAX_VERSIONS:
        raise SourceLimitError("The source version count exceeds its limit.")
    return value


def _catalog_ids_locked(self):
    # 새/옛 카탈로그 이름을 함께 수집하며 요청 영수증은 목록 항목으로 취급하지 않는다.
    ids = set()
    for name in files.entries(self.store, self.registrations_dir, maximum=limits.MAX_SOURCES + 2):
        if name == "_requests":
            continue
        if not name.endswith(".json") or not limits.ID.fullmatch(name[:-5]):
            raise SourceCorruptError("The registration catalog contains an unexpected entry.")
        ids.add(name[:-5])
    for name in files.entries(self.store, self.sources_dir, maximum=limits.MAX_SOURCES + 1):
        if not limits.ID.fullmatch(name):
            raise SourceCorruptError("Source storage contains an unexpected entry.")
        path = files.checked(self.store, self.sources_dir / name / "catalog.json")
        if path.exists():
            ids.add(name)
    return sorted(ids)


def capture_catalog_locked(self):
    # 등록 JSON 전체를 한 기준으로 읽는다. 다른 업무의 권위 조회는 캐시를 사용하지 않는다.
    values, size = [], 0
    for source_id in _catalog_ids_locked(self):
        path = self._catalog_path(source_id)
        with files.open_regular(self.store, path) as stream:
            size += stream.seek(0, 2)
        if size > limits.MAX_CATALOG_BYTES:
            raise SourceLimitError("The total catalog metadata limit was reached.")
        if len(values) >= limits.MAX_SOURCES:
            raise SourceLimitError("The registration count exceeds its limit.")
        values.append(get_source_locked(self, source_id))
    return values


def _catalog_entry_locked(self, source_id):
    path = self._catalog_path(source_id)
    with files.open_regular(self.store, path) as stream:
        info = os.fstat(stream.fileno())
        size = stream.seek(0, 2)
    relative = path.relative_to(self.store.data_dir).as_posix()
    signature = canonical_json_hash([relative, info.st_dev, info.st_ino, info.st_size,
                                     info.st_mtime_ns, info.st_ctime_ns])
    return signature, size


def _scan_catalog_entries_locked(self):
    """본문을 열람하지 않고 기존 범위·경로·누적 크기를 같은 순서로 검사한다."""
    entries, sizes, size, failure = [], {}, 0, None
    for source_id in _catalog_ids_locked(self):
        try:
            signature, source_size = _catalog_entry_locked(self, source_id)
            size += source_size
            if size > limits.MAX_CATALOG_BYTES:
                raise SourceLimitError("The total catalog metadata limit was reached.")
            if len(entries) >= limits.MAX_SOURCES:
                raise SourceLimitError("The registration count exceeds its limit.")
            entries.append((source_id, signature))
            sizes[source_id] = source_size
        except (OSError, ValueError, RuntimeError) as error:
            # 앞선 ID의 JSON 손상이 뒤 ID의 크기/경로 오류보다 먼저였던 계약을 유지한다.
            failure = error
            break
    return {"entries": entries, "sizes": sizes, "failure": failure}


def _update_catalog_entries_locked(self, previous, paths):
    """관리 쓰기가 알려 준 기존 카탈로그만 다시 관측한다. 새 범위는 전체 검사한다."""
    changed = set()
    for path in paths:
        parts = path.split("/")
        if len(parts) == 3 and parts[0] == "_sources" and parts[2] == "catalog.json":
            source_id = parts[1]
        elif len(parts) == 2 and parts[0] == "_registrations" and parts[1].endswith(".json"):
            # 구형 registry는 임시 파일도 발견 범위다. 실패 후 잔존 항목까지 다시 검사한다.
            return None
        else:
            continue
        if not limits.ID.fullmatch(source_id) or source_id not in previous["sizes"]:
            return None
        changed.add(source_id)
    if not changed:
        return previous
    signatures = dict(previous["entries"])
    try:
        for source_id in sorted(changed):
            signature, size = _catalog_entry_locked(self, source_id)
            signatures[source_id] = signature
            previous["sizes"][source_id] = size
    except (OSError, ValueError, RuntimeError):
        return None
    if (len(signatures) > limits.MAX_SOURCES
            or sum(previous["sizes"].values()) > limits.MAX_CATALOG_BYTES):
        return None
    previous["entries"] = [(source_id, signatures[source_id]) for source_id, _ in previous["entries"]]
    return previous


def _catalog_entries_locked(self):
    """엄격 조회는 전체 검사하고 관리 조회는 같은 잠금의 메타데이터만 재사용한다."""
    value = observation(self.store, "registration", "source_catalog_entries",
        lambda: _scan_catalog_entries_locked(self),
        update=lambda previous, paths: _update_catalog_entries_locked(self, previous, paths),
        cacheable=lambda current: current["failure"] is None)
    return value["entries"], value["failure"]


def _summary_record(catalog):
    return {"source_id": catalog["source_id"], "registration_revision": catalog["registration_revision"],
            "item": list_item(catalog), "summary": summary(catalog),
            "catalog_hash": canonical_json_hash(catalog)}


def _cached_summary(source_id, value):
    if (set(value) != {"source_id", "registration_revision", "item", "summary", "catalog_hash"}
            or value["source_id"] != source_id
            or any(type(value[field]) is not str or not limits.HEX.fullmatch(value[field])
                   for field in ("registration_revision", "catalog_hash"))
            or any(type(value[field]) is not dict or value[field].get("source_id") != source_id
                   or value[field].get("registration_revision") != value["registration_revision"]
                   for field in ("item", "summary"))):
        raise CanonicalIndexUnavailable("The cached source summary is invalid.", reason="corrupt")
    return value


def _sync_summaries_locked(self, index, scope, entries, failure):
    loaded = {}

    def load(source_id):
        catalog = self._get_source_locked(source_id)
        loaded[source_id] = catalog
        return _summary_record(catalog)

    index.sync("sources.summaries", scope, entries, load)
    if failure is not None:
        raise failure
    return loaded


def capture_summaries_locked(self):
    """전체 판본을 복제하지 않고 통합 목록용 최신 요약만 증분 검증한다."""
    entries, failure = _catalog_entries_locked(self)
    if not entries and failure is None:
        return []
    try:
        with read_index(self.store) as index:
            _sync_summaries_locked(self, index, "catalog", entries, failure)
            return [_cached_summary(key, value) for key, value in index.values("sources.summaries", "catalog")]
    except CanonicalIndexUnavailable as error:
        cache_event("fallback", getattr(error, "reason", "unknown"))
        return [_summary_record(catalog) for catalog in self._capture_catalog_locked()]


def summary(catalog):
    # 전체 판본 기록에서 목록 화면에 필요한 최신 판본 정보만 추려 새 dict로 만든다.
    current = catalog["versions"][-1]
    return {"source_id": catalog["source_id"], "title": catalog["title"],
        "current_version": catalog["current_version"], "source_sha256": current["source_sha256"],
        "size_bytes": current["size_bytes"], "kind": current["kind"], "format": current["format"],
        "version_count": len(catalog["versions"]), "documents": catalog["documents"],
        "registration_revision": catalog["registration_revision"], "analysis_status": "not_started"}


def search_titles(self, query, limit):
    # 등록 원본 제목에 검색어가 든 항목을 목록과 같은 요약 모양으로 찾는다. 원본 내용은 읽지 않는다.
    if type(limit) is not int or not 1 <= limit <= limits.MAX_PAGE_SIZE:
        raise limits.SourceValidationError("limit must be an integer from 1 to 50.")
    needle = unicodedata.normalize("NFC", query).strip().casefold()
    if not needle:
        raise limits.SourceValidationError("query must not be blank")
    with self._coordination_lock():
        catalog = self._capture_catalog_locked()
    # 제목은 사용자가 정한 이름이라 한글 조합 방식이 달라도 같은 글자로 비교한다.
    matches = [item for item in catalog
               if needle in unicodedata.normalize("NFC", item["title"]).casefold()]
    return {"matches": [list_item(item) for item in matches[:limit]],
            "truncated": len(matches) > limit, "scanned": len(catalog)}


def list_item(catalog):
    # 문서 목록의 등록 원본 항목과 같은 모양이라 화면이 목록과 검색 결과를 같은 부품으로 그린다.
    current = next(v for v in catalog["versions"] if v["source_version"] == catalog["current_version"])
    return {"kind": "source", "source_id": catalog["source_id"], "title": catalog["title"],
            "source_version": current["source_version"], "source_sha256": current["source_sha256"],
            "size_bytes": current["size_bytes"], "format": current["format"],
            "registration_revision": catalog["registration_revision"],
            "documents": catalog["documents"], "analysis_status": "not_started"}


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
        entries, failure = _catalog_entries_locked(self)
        scanned = len(entries)
        try:
            if not entries and failure is None:
                revision, page, more = canonical_json_hash([]), [], False
                _check_position(previous, revision, [])
            else:
                with read_index(self.store) as index:
                    loaded = _sync_summaries_locked(self, index, scope, entries, failure)

                    def listing_basis():
                        # 이 공개 hash는 전체 카탈로그 배열의 기존 정규 바이트를 그대로 사용한다.
                        # 변경/초기 구축 때만 나머지 원문을 읽고 warm 조회는 header를 재사용한다.
                        catalogs = [loaded[source_id] if source_id in loaded else self._get_source_locked(source_id)
                                    for source_id, _ in entries]
                        return {"catalog_revision": canonical_json_hash(catalogs)}

                    basis = index.get("sources.list_basis", scope, "basis", canonical_json_hash(entries), listing_basis)
                    if (set(basis) != {"catalog_revision"} or type(basis["catalog_revision"]) is not str
                            or not limits.HEX.fullmatch(basis["catalog_revision"])):
                        raise CanonicalIndexUnavailable("The cached source listing basis is invalid.", reason="corrupt")
                    revision = basis["catalog_revision"]
                    _check_position(previous, revision, [source_id for source_id, _ in entries])
                    selected = index.page("sources.summaries", scope,
                        after=previous["after"] if previous is not None else None, limit=limit + 1)
                    page = [_cached_summary(key, value)["summary"] for key, value in selected[:limit]]
                    more = len(selected) > limit
        except CanonicalIndexUnavailable as error:
            cache_event("fallback", getattr(error, "reason", "unknown"))
            catalog = self._capture_catalog_locked()
            scanned = len(catalog)
            revision = canonical_json_hash(catalog)
            ids = [item["source_id"] for item in catalog]
            _check_position(previous, revision, ids)
            offset = ids.index(previous["after"]) + 1 if previous is not None else 0
            page = [summary(item) for item in catalog[offset:offset + limit]]
            more = offset + len(page) < len(catalog)
        next_cursor = None
        if more:
            value = {"scope": scope, "catalog": revision, "after": page[-1]["source_id"]}
            next_cursor = base64.urlsafe_b64encode(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).rstrip(b"=").decode()
        return {"items": page, "scope": {"tenant": tenant, "kind": "registered_sources"},
            "catalog_revision": revision, "next_cursor": next_cursor, "complete": not more,
            "truncated": False, "skipped": [], "scanned": scanned, "requires_refresh": False}


def _check_position(previous, revision, ids):
    if previous is not None:
        if previous["catalog"] != revision:
            # 페이지 사이에 등록이 바뀌었다면 처음부터 다시 조회하게 하여 누락/중복을 막는다.
            raise CatalogChangedError("The source listing basis changed.")
        if previous["after"] not in ids:
            raise InvalidCursorError("Invalid source cursor position.")


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
            directory = self._version_path(record["source_id"], record["source_version"])
            actual = files.read_json(self.store, directory / "manifest.json")
            if actual != expected or expected not in catalog["versions"]:
                return result(record, replayed=True)
            with files.verify_original(self.store, directory / "original", actual):
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
        directory = self._version_path(source_id, source_version)
        actual = validation.manifest(files.read_json(self.store, directory / "manifest.json"), source_id, source_version)
        if actual != expected:
            raise SourceCorruptError("The original manifest differs from its catalog.")
        return files.verify_original(self.store, directory / "original", actual), actual
