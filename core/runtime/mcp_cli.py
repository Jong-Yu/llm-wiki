# 명령줄 옵션으로 MCP의 저장소 모드와 전송 방법을 고른다.
# stdio는 표준 입출력으로 클라이언트와 통신하고, streamable-http는 loopback 주소에서 HTTP 요청을 받는다.

"""기존 CLI 인수·환경을 해석해 명시적으로 stdio 또는 HTTP MCP를 시작한다."""

import argparse
import logging
import os
from pathlib import Path

import uvicorn

from core.modules.access.policy import AccessDenied, AccessPolicy, PolicyError
from core.mcp.http import HTTP_HOST, _validate_http_token, create_http_app, create_tenant_http_app
from core.mcp.server import create_server
from core.mcp.tenant import create_tenant_server
from core.modules.documents.store import DEFAULT_DATA_DIR, DEFAULT_LOCK_TIMEOUT_SECONDS, WikiStore
from core.runtime.rulesets import configured_rulesets


# 명령줄 문자열을 제한된 포트 번호로 바꾼다. 파싱 실패는 사용자 입력 오류로 알린다.
def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("port must be an integer from 1 to 65535") from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be an integer from 1 to 65535")
    return port


# 개인 정책 모드와 기존 단일 저장소 모드는 서로 다른 분기다. 인증 실패를 다른 모드로 되돌려 실행하지 않는다.
def main() -> None:
    parser = argparse.ArgumentParser(description="LLM Wiki MCP server over stdio or authenticated loopback HTTP.")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--data-dir", type=Path,
                        help="Existing data root containing wiki/ and _history/.")
    source.add_argument("--access-config", type=Path,
                        help="Admin-owned user/membership/profile policy JSON for multi-tenant mode.")
    parser.add_argument("--tenant-root", type=Path,
                        help="Existing parent of isolated tenant directories; requires --access-config.")
    parser.add_argument("--lock-timeout", type=float, default=DEFAULT_LOCK_TIMEOUT_SECONDS,
                        help="Writer-lock wait limit in seconds (default: 5; 0: try once).")
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio",
                        help="MCP transport (default: stdio). HTTP listens only on 127.0.0.1.")
    parser.add_argument("--port", type=_port, default=8765,
                        help="Loopback HTTP port, from 1 to 65535 (default: 8765).")
    parser.add_argument("--token-env", default="LLM_WIKI_TOKEN",
                        help="Legacy HTTP shared token or multi-tenant stdio personal token (default: LLM_WIKI_TOKEN).")
    parser.add_argument("--ruleset-root", type=Path)
    parser.add_argument("--ruleset-policy", type=Path)
    args = parser.parse_args()
    if bool(args.access_config) != bool(args.tenant_root):
        parser.error("--access-config and --tenant-root must be specified together.")
    if (args.ruleset_root is not None or args.ruleset_policy is not None) and not args.access_config:
        parser.error("Rulesets require authenticated tenant mode.")
    # stdio의 stdout은 MCP 프레임 전용이므로 로그는 기본 stderr로 보낸다.
    logging.basicConfig(level=logging.WARNING)
    if args.access_config:
        try:
            policy = AccessPolicy(args.access_config, args.tenant_root, lock_timeout_seconds=args.lock_timeout)
            rulesets = configured_rulesets(args.ruleset_root, args.ruleset_policy, policy)
            if args.transport == "streamable-http":
                app = create_tenant_http_app(policy, rulesets=rulesets)
            else:
                token = os.environ.get(args.token_env)
                policy.authenticate(token)  # No implicit unauthenticated stdio fallback.
                server = create_tenant_server(policy, token, rulesets=rulesets)
        except (PolicyError, AccessDenied, OSError, ValueError, TypeError):
            parser.error("Multi-tenant policy or credentials are invalid.")
        if args.transport == "streamable-http":
            uvicorn.run(app, host=HTTP_HOST, port=args.port, log_level="warning", access_log=False)
        else:
            server.run(transport="stdio")
        return
    token = None
    if args.transport == "streamable-http":
        token = os.environ.get(args.token_env)
        try:
            _validate_http_token(token)
        except ValueError as error:
            parser.error(str(error))
    try:
        store = WikiStore(args.data_dir or DEFAULT_DATA_DIR, lock_timeout_seconds=args.lock_timeout)
    except (OSError, ValueError, TypeError) as error:
        parser.error(str(error))
    if args.transport == "streamable-http":
        uvicorn.run(create_http_app(store, token), host=HTTP_HOST, port=args.port,
                    log_level="warning", access_log=False)
    else:
        create_server(store).run(transport="stdio")


if __name__ == "__main__":
    main()
