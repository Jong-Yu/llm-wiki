"""원본 보관 업무의 공용 진입과 같은 tenant의 협력 함수를 조립한다."""

# 읽는 순서: stage(임시 수신) → commit(등록 공개) → get_source/open_original(조회).
# 이 클래스는 호출 창구이며 실제 처리 함수는 같은 폴더의 역할별 파일에 둔다.

from . import files, validation, staging, commands, queries


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
        return self.requests_dir / (validation.request_key(tenant, user_id, request_id) + ".json")

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

    def get_source(self, source_id):
        # with 블록이 끝나거나 오류가 나면 잠금이 해제된다. 조회 중 카탈로그가 바뀌는 것을 막는다.
        with self._coordination_lock():
            return self._get_source_locked(source_id)

    def list_sources(self, *, tenant, scope_key, limit=20, cursor=None):
        # cursor는 이전 페이지의 끝 위치다. 조회 권한과 목록 기준이 달라졌다면 이어 읽지 않는다.
        return queries.list_sources(self, tenant=tenant, scope_key=scope_key, limit=limit, cursor=cursor)

    def request_receipt(self, *, tenant, user_id, request_id):
        return queries.request_receipt(self, tenant=tenant, user_id=user_id, request_id=request_id)

    def open_original(self, source_id, source_version):
        # 파일 전체를 응답 dict에 담지 않고, 검증한 열린 스트림과 설명서를 반환한다.
        return queries.open_original(self, source_id, source_version)
