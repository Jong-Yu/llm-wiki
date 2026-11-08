# 모든 HTTP 요청이 업무 함수에 도착하기 전에 인증과 Host/Origin을 확인하는 공통 보안 통로다.
# 토큰 인증은 누구인지 확인하는 단계이고, read/write 같은 행동 권한은 뒤의 API/MCP에서 현재 정책으로 다시 검사한다.

"""일반 API와 MCP HTTP 입구의 인증·Host/Origin 보호를 함께 구성한다.

업무 권한은 각 어댑터가 현재 정책으로 다시 확인한다. 이 계층은 MCP의 JSON
형식이나 요청 크기를 일반 API에 적용하지 않고 전송별 핸들러에 남긴다.
"""

import secrets
from collections.abc import Callable

import anyio
from mcp.server.transport_security import TransportSecurityMiddleware, TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from core.common.read_metrics import span
from core.modules.access.policy import AccessDenied, AccessPolicy, PolicyError


HTTP_HOST = "127.0.0.1"
PUBLIC_AUTH_PATHS = frozenset({"/api/v1/auth/signup", "/api/v1/auth/login"})


def _public_auth(scope):
    """디코딩·후행 slash·다른 메서드 별칭을 공개 예외로 넓히지 않는다."""
    path = scope.get("path", "")
    raw = scope.get("raw_path", path.encode("utf-8"))
    return (scope.get("method") == "POST" and path in PUBLIC_AUTH_PATHS
            and raw == path.encode("ascii"))


def transport_security_settings() -> TransportSecuritySettings:
    """로컬 수신과 HTTPS 프록시의 loopback Host 계약을 유지한다."""
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*"],
        allowed_origins=["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"],
    )


# Authorization 헤더가 정확히 하나이고 Bearer 형식일 때만 토큰을 읽는다.
def bearer(scope: Scope) -> str | None:
    """중복·비ASCII Authorization을 거부하고 한 요청의 자격 증명만 읽는다."""
    headers = [value for key, value in scope.get("headers", []) if key.lower() == b"authorization"]
    if len(headers) != 1:
        return None
    scheme, separator, credential = headers[0].partition(b" ")
    if scheme.lower() != b"bearer" or not separator:
        return None
    try:
        return credential.decode("ascii")
    except UnicodeDecodeError:
        return None


def _api_path(path: str) -> bool:
    return (path == "/api" or path.startswith("/api/") or path == "/docs"
            or path.startswith("/docs/") or path in {"/openapi.json", "/redoc"})


class HttpAccessMiddleware:
    """모든 HTTP 진입을 보호하고 정책 파일 I/O는 제한된 스레드에서 실행한다.

    error_response는 일반 API/스키마 문서의 HTTP 오류를 해당 envelope로 변환한다.
    MCP의 기존 plain-text 전송 오류와 정확한 /mcp POST 계약은 유지한다.
    """

    def __init__(
        self, app: ASGIApp, *, policy: AccessPolicy | None = None,
        token: str | None = None,
        transport_security: TransportSecuritySettings | None = None,
        enforce_mcp_post: bool = True,
        error_response: Callable[..., Response] | None = None,
    ):
        if (token is None) == (policy is None):
            raise ValueError("Select exactly one authentication mode.")
        self.app = app
        self.policy = policy
        self.token = token.encode("ascii") if token is not None else None
        self.security = TransportSecurityMiddleware(transport_security or transport_security_settings())
        self.enforce_mcp_post = enforce_mcp_post
        self.error_response = error_response

    def _error(self, scope, status, code, message, headers=None):
        if self.error_response is not None and _api_path(scope["path"]):
            return self.error_response(status, code, message, headers=headers)
        return PlainTextResponse(message, status_code=status, headers=headers)

    # 인증 → Host/Origin 확인 → MCP 메서드 확인 → 실제 앱 호출 순서다. 중간에 거부되면 아래 업무는 실행되지 않는다.
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        credential = bearer(scope)
        valid = self.policy is not None and _public_auth(scope)
        if self.policy is not None and not valid:
            try:
                with span("authorization"):
                    await anyio.to_thread.run_sync(self.policy.authenticate, credential)
                valid = True
            except AccessDenied:
                pass
            except PolicyError:
                await self._error(scope, 503, "policy_unavailable", "Access policy is unavailable")(
                    scope, receive, send
                )
                return
        elif self.policy is None and credential is not None:
            valid = secrets.compare_digest(credential.encode("ascii"), self.token)
        if not valid:
            await self._error(scope, 401, "unauthenticated", "Unauthorized",
                              {"WWW-Authenticate": "Bearer"})(scope, receive, send)
            return

        # Content-Type 검사는 MCP POST 핸들러에 남겨 일반 API까지 전파하지 않는다.
        response = await self.security.validate_request(Request(scope, receive))
        if response is None:
            for name, status, code, message in (
                (b"host", 421, "invalid_host", "Invalid Host header"),
                (b"origin", 403, "invalid_origin", "Invalid Origin header"),
            ):
                values = [value for key, value in scope.get("headers", []) if key.lower() == name]
                if len(values) > 1:
                    response = self._error(scope, status, code, message)
                    break
        elif _api_path(scope["path"]):
            code = "invalid_host" if response.status_code == 421 else "invalid_origin"
            message = "Invalid Host header" if response.status_code == 421 else "Invalid Origin header"
            response = self._error(scope, response.status_code, code, message)
        if response is not None:
            await response(scope, receive, send)
            return
        if self.enforce_mcp_post and scope["path"] == "/mcp" and scope["method"] != "POST":
            await PlainTextResponse("Method Not Allowed", status_code=405,
                                    headers={"Allow": "POST"})(scope, receive, send)
            return
        await self.app(scope, receive, send)
