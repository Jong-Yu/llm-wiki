"""MCP 전용 인증·Host/Origin·POST 제한과 stateless JSON ASGI 앱 조립."""

# 서버 도구를 HTTP 요청으로 사용할 수 있게 감싼다. 사용자의 자료를 저장하는 계층은 아니다.
# ASGI 앱은 웹 서버가 실행할 요청 처리 객체이며, 인증/Host 보호는 공통 runtime 모듈을 사용한다.
import re

from mcp.server import MCPServer
from starlette.applications import Starlette

from core.modules.access.policy import AccessPolicy
from core.runtime.http_security import HTTP_HOST, HttpAccessMiddleware, transport_security_settings
from core.mcp.server import create_server
from core.mcp.tenant import create_tenant_server
from core.modules.documents.store import WikiStore


MAX_HTTP_REQUEST_BYTES = 8 * 1024 * 1024


def _validate_http_token(token: str) -> None:
    # 정규식 fullmatch는 토큰 전체가 허용 문자로만 구성됐는지 검사한다. 실제 값은 오류에 넣지 않는다.
    if not isinstance(token, str) or re.fullmatch(r"[A-Za-z0-9_-]{32,}", token) is None:
        # Never include the supplied value in exceptions or logs.
        raise ValueError("HTTP token must contain at least 32 URL-safe letters, digits, '-' or '_'.")


def create_http_app(store: WikiStore, token: str) -> Starlette:
    """토큰 인증과 SDK Host/Origin 검사를 적용한 POST/JSON MCP 앱을 만든다.

    실행 시 loopback에만 바인딩하고 HTTPS 프록시는 loopback Host를 전달해야 한다.
    인증을 이유로 DNS rebinding 검사를 끄지 않는다. 요청 한도에는 JSON 이스케이프
    여유가 포함되며, WikiStore의 문서당 1 MiB 한도는 별도로 적용된다.
    """
    _validate_http_token(token)
    return _http_app(create_server(store), token=token)


def create_tenant_http_app(policy: AccessPolicy, *, rulesets=None) -> Starlette:
    # policy가 인증 사용자의 소속·권한을 판단한다. rulesets는 공통 추출 규약이 설정됐을 때 전달한다.
    return _http_app(create_tenant_server(policy, rulesets=rulesets), policy=policy)


def _http_app(server: MCPServer, *, token: str | None = None,
              policy: AccessPolicy | None = None) -> Starlette:
    # token/tenant policy 중 구성한 인증 방식을 middleware가 각 요청에 적용한다.
    # stateless_http는 통신 세션 방식이며 파일 저장소의 상태를 없앤다는 뜻은 아니다.
    # 정상 POST와 조기 405 응답이 같은 loopback Host/Origin 정책을 사용한다.
    transport_security = transport_security_settings()
    app = server.streamable_http_app(
        json_response=True,
        stateless_http=True,
        host=HTTP_HOST,
        max_request_body_size=MAX_HTTP_REQUEST_BYTES,
        transport_security=transport_security,
    )
    app.add_middleware(HttpAccessMiddleware, token=token, policy=policy, transport_security=transport_security)
    return app
