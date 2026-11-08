# 일반 API와 MCP를 하나의 ASGI 서버로 조립한다. 둘은 같은 현재 정책과 업무 저장 모듈을 사용한다.
# create_application은 앱을 만들고, lifespan은 서버가 켜지고 꺼질 때 필요한 자원을 관리한다.

"""일반 API와 MCP를 같은 정책·저장 모듈의 단일 ASGI 앱으로 조립한다."""

from contextlib import asynccontextmanager
from anyio import CapacityLimiter
from fastapi import FastAPI, Request
from starlette.routing import compile_path

from core.api.errors import error_response, register_errors
from core.api.limits import ReadApiLimits
from core.api.router import router
from core.api.operations import install_body_schemas
from core.mcp.tenant import create_tenant_server
from core.modules.access.policy import AccessPolicy
from core.runtime.http_security import HTTP_HOST, HttpAccessMiddleware, transport_security_settings
from core.runtime.http_metrics import HttpMetricsMiddleware
from core.runtime.ontology_index import OntologyIndexPreparer


def create_application(policy: AccessPolicy, *, rulesets=None, auth=None, credential_key_path=None) -> FastAPI:
    """import 시 저장소를 열지 않으며 기동 시 현재 정책을 검증한다."""
    server = create_tenant_server(policy, rulesets=rulesets)
    # 정책 검증 이후에만 키·암호화 자격 증명 준비를 담당 서비스에 위임한다.
    # 없는 자료 루트나 손상된 정책을 빈 서버로 대체하지 않는다.
    if auth is None:
        from core.modules.access.auth import initialize_auth
        auth = initialize_auth(policy, key_path=credential_key_path)
    mcp_app = server.streamable_http_app(
        json_response=True, stateless_http=True, host=HTTP_HOST,
        max_request_body_size=8 * 1024 * 1024, transport_security=transport_security_settings())
    mcp_app.router.redirect_slashes = False
    index_preparer = OntologyIndexPreparer(policy) if policy.tracked_reads else None

    # asynccontextmanager의 yield 앞은 기동 준비, 뒤는 종료 정리 구간이다. MCP 자원도 이 부모 앱이 관리한다.
    @asynccontextmanager
    async def lifespan(app):
        from anyio import to_thread
        await to_thread.run_sync(policy.validate)
        # Mount된 앱의 lifespan은 자동 실행되지 않는다. 이 부모가 정확히 한 번 소유한다.
        async with mcp_app.router.lifespan_context(mcp_app):
            if index_preparer is not None:
                index_preparer.start()
            try:
                if index_preparer is not None:
                    await to_thread.run_sync(index_preparer.wait_initial)
                yield
            finally:
                if index_preparer is not None:
                    await to_thread.run_sync(index_preparer.close)

    app = FastAPI(title="LLM Wiki API", version="1.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, redirect_slashes=False)
    app.state.policy = policy
    app.state.auth = auth
    app.state.rulesets = rulesets
    app.state.ontology_index_preparer = index_preparer
    # multipart spool·직접 JSON 수신의 동시 자원 사용도 단일 worker에서 제한한다.
    app.state.upload_limiter = CapacityLimiter(4)
    app.state.mcp_app = mcp_app
    app.include_router(router)
    install_body_schemas(app)
    register_errors(app)
    # 알 수 없는 API도 MCP mount의 응답으로 흘려보내지 않는다.
    # 정의된 URL인데 메서드만 틀리면 405, 없는 URL이면 404로 구별한다.
    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
                   include_in_schema=False)
    def unknown(request: Request, path: str):
        for template, operations in app.openapi()["paths"].items():
            if compile_path(template)[0].fullmatch(request.url.path):
                methods = sorted(method.upper() for method in operations
                                 if method.lower() in {"get", "post", "put", "patch", "delete", "head", "options"})
                return error_response(405, "method_not_allowed", "Method not allowed.",
                                      {"Allow": ", ".join(methods)})
        return error_response(404, "not_found", "Endpoint not found.")

    app.mount("/", mcp_app)
    app.add_middleware(ReadApiLimits)
    app.add_middleware(HttpAccessMiddleware, policy=policy, error_response=error_response)
    app.add_middleware(HttpMetricsMiddleware,
                       route_templates=lambda: (*app.openapi()["paths"], "/api/{path:path}", "/mcp"))
    return app
