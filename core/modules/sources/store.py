"""원본 보관 업무의 공용 진입과 같은 tenant의 협력 함수를 조립한다."""

# 읽는 순서: stage(임시 수신) → commit(등록 공개) → get_source/open_original(조회).
# 이 클래스는 호출 창구이며 실제 처리 함수는 같은 폴더의 역할별 파일에 둔다.

from . import files, validation, staging, commands, queries
from core.common.storage_layout import personal_root, source_root, source_version_root
from .contracts import SourceCorruptError, identifier


class SourceStore:
    """생성자와 조회는 저장 폴더를 만들거나 자료를 복구하지 않는다."""

    def __init__(self, store):
        # self는 현재 SourceStore 객체다. 기존 WikiStore와 자료 루트를 함께 사용한다.
        # pathlib.Path의 / 연산은 경로를 이어 붙인다. 이 계산만으로 폴더가 생성되지는 않는다.
        self.store = store
        self.sources_dir = store.data_dir / "_sources"
        self.registrations_dir = store.data_dir / "_registrations"
        self.requests_dir = self.registrations_dir / "_requests"

    def _coordination_lock(self, *, create=False):
        # 원본/작업 상태가 서로 엇갈리지 않도록 같은 잠금을 사용한다. _는 내부용이라는 이름 관례다.
        return files.coordination(self.store, create=create)

    def stage(self, stream, *, kind, title, format, filename=None):
        """수신 원본을 임시 보관한다. 공개 판본·카탈로그는 commit에서만 만든다."""
        return staging.stage(self, stream, kind=kind, title=title, format=format, filename=filename)

    def discard(self, staged):
        """이번 수신의 임시 파일만 정리하고 정리 경고를 성공/실패와 별도로 반환한다."""
        return staging.discard(self, staged)

    def commit(self, staged, *, tenant, user_id, request_id, source_id=None,
               expected_registration_revision=None, authorize):
        """현재 권한·기준 버전·재전송을 확인한 뒤 원본과 등록 영수증을 연결한다."""
        return commands.commit(self, staged, tenant=tenant, user_id=user_id, request_id=request_id,
            source_id=source_id, expected_registration_revision=expected_registration_revision, authorize=authorize)

    def _request_path(self, tenant, user_id, request_id):
        # 같은 요청 ID라도 다른 사용자/tenant의 기록을 읽지 않도록 세 값을 함께 지문화한다.
        name = validation.request_key(tenant, user_id, request_id) + ".json"
        return self._select_path(personal_root(self.store.data_dir, user_id) / "_requests" / "sources" / name,
                                 self.requests_dir / name)

    def _select_path(self, current, legacy):
        files.checked(self.store, current)
        files.checked(self.store, legacy)
        if current.exists() and legacy.exists():
            raise SourceCorruptError("The same source record exists in both storage layouts.")
        return legacy if legacy.exists() else current

    def _catalog_path(self, source_id):
        identifier(source_id)
        return self._select_path(source_root(self.store.data_dir, source_id) / "catalog.json",
                                 self.registrations_dir / (source_id + ".json"))

    def _version_path(self, source_id, source_version, *, create=False):
        identifier(source_id); identifier(source_version)
        current = source_version_root(self.store.data_dir, source_id, source_version)
        legacy = self.sources_dir / source_id / source_version
        selected = self._select_path(current, legacy)
        # Keep existing sources in their original layout on explicit version writes.
        if create and self._catalog_path(source_id).parent == self.registrations_dir:
            if current.exists():
                raise SourceCorruptError("The source has conflicting version layouts.")
            return legacy
        return selected

    def _request_count(self):
        """Keep the tenant-wide receipt bound across both layouts."""
        from .contracts import MAX_REQUESTS, MAX_SCAN_ENTRIES, SourceLimitError
        count = len(files.entries(self.store, self.requests_dir, maximum=MAX_REQUESTS + 1))
        root = self.store.data_dir / "_personal"
        for owner in files.entries(self.store, root, maximum=MAX_SCAN_ENTRIES):
            count += len(files.entries(self.store, root / owner / "_requests" / "sources", maximum=MAX_REQUESTS + 1))
            if count >= MAX_REQUESTS:
                raise SourceLimitError("The request receipt limit was reached.")
        return count

    def _version_count(self, source_id):
        """Also count published originals left by interrupted catalog writes."""
        from .contracts import MAX_VERSIONS, ID
        root = source_root(self.store.data_dir, source_id)
        legacy = files.entries(self.store, root, maximum=MAX_VERSIONS + 3)
        legacy = [name for name in legacy if name not in {"catalog.json", "versions"}]
        current = files.entries(self.store, root / "versions", maximum=MAX_VERSIONS + 1)
        if any(not ID.fullmatch(name) for name in [*legacy, *current]) or set(legacy) & set(current):
            raise SourceCorruptError("The original version layout is inconsistent.")
        return len(legacy) + len(current)

    def _request_locked(self, tenant, user_id, request_id):
        raw = files.read_json(self.store, self._request_path(tenant, user_id, request_id))
        return validation.request_record(raw, tenant=tenant, user_id=user_id, request_id=request_id)

    def _write_request(self, path, value):
        files.write_json(self.store, path, value)

    def _write_catalog(self, path, value):
        files.write_json(self.store, path, value)

    def _get_source_locked(self, source_id):
        return queries.get_source_locked(self, source_id)

    def _capture_catalog_locked(self):
        return queries.capture_catalog_locked(self)

    def _capture_summaries_locked(self):
        return queries.capture_summaries_locked(self)

    def get_source(self, source_id):
        # with 블록이 끝나거나 오류가 나면 잠금이 해제된다. 조회 중 카탈로그가 바뀌는 것을 막는다.
        with self._coordination_lock():
            return self._get_source_locked(source_id)

    def search_titles(self, query, limit=20):
        """등록 원본 제목 검색(내용은 읽지 않음)."""
        return queries.search_titles(self, query, limit)

    def list_sources(self, *, tenant, scope_key, limit=20, cursor=None):
        # cursor는 이전 페이지의 끝 위치다. 조회 권한과 목록 기준이 달라졌다면 이어 읽지 않는다.
        return queries.list_sources(self, tenant=tenant, scope_key=scope_key, limit=limit, cursor=cursor)

    def request_receipt(self, *, tenant, user_id, request_id):
        return queries.request_receipt(self, tenant=tenant, user_id=user_id, request_id=request_id)

    def open_original(self, source_id, source_version):
        # 파일 전체를 응답 dict에 담지 않고, 검증한 열린 스트림과 설명서를 반환한다.
        return queries.open_original(self, source_id, source_version)
