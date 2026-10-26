"""기존 MCP factory import와 ``python -m core.mcp_server``의 호환 진입점.

실제 전송·도구 구현은 core.mcp, 실행 조립은 core.runtime에 둔다.
"""

from core.mcp.http import create_http_app, create_tenant_http_app
from core.mcp.server import create_server
from core.mcp.tenant import create_tenant_server
from core.runtime.mcp_cli import main


__all__ = [
    "create_server", "create_tenant_server", "create_http_app", "create_tenant_http_app", "main",
]


# 예전 실행 명령과 import 경로를 유지한다. 실제 서버는 mcp/, 실행 옵션은 runtime/을 읽으면 된다.
# __name__이 __main__일 때만 실행하므로 import한 것만으로 서버가 시작되지는 않는다.
if __name__ == "__main__":
    main()
