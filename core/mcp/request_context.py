"""공유 서버에서 요청별 권한 문맥과 HTTP 자격 증명 읽기를 분리한다."""

from contextvars import ContextVar

from core.runtime.http_security import bearer as _bearer


# 서버 인스턴스를 공유하는 동시 요청의 사용자·tenant가 섞이지 않도록 호출 문맥에 둔다.
# ContextVar의 get/set은 현재 비동기 호출의 값을 사용한다. 일반 전역 변수에 사용자 하나를
# 덮어쓰는 방식과 다르며, tenant.py가 호출 후 reset해 다음 요청에 값을 남기지 않는다.
_authorized_scope = ContextVar("wiki_authorized_scope", default=None)


