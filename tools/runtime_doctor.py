"""설치·CLI 로그인·인증된 API/MCP를 각각 읽기 전용으로 진단한다.

모델·분석·쓰기·로그인·설정 편집은 실행하지 않는다. 원시 CLI/전송 오류나 토큰을
출력하지 않으며 주체/권한 대조를 안정된 backend identity 증명으로 표시하지 않는다.
"""

import argparse
import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys

from core.paths import PROJECT_DIR
from core.runtime.client_platform import project_python


def dependencies():
    rows = []
    for line in (PROJECT_DIR / "requirements.lock").read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        match = re.fullmatch(r'([\w.-]+)==([^; ]+)(?:;\s*sys_platform == "win32")?', line)
        if match is None:
            rows.append({"status": "error", "code": "unsupported_lock_line"})
            continue
        if ";" in line and os.name != "nt":
            continue
        name, expected = match.groups()
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            actual = None
        rows.append({"name": name, "expected": expected, "installed": actual,
                     "status": "ok" if actual == expected else "error"})
    return rows


def access_match(api, mcp, tenant=None, profile=None):
    if any(api.get(key) != mcp.get(key) for key in ("user_id", "policy_revision", "memberships")):
        return {"status": "error", "code": "api_mcp_access_mismatch"}
    if not isinstance(api.get("user_id"), str) or not isinstance(api.get("memberships"), dict):
        return {"status": "error", "code": "invalid_access_context"}
    selected = api["memberships"].get(tenant) if tenant else None
    if tenant and not selected:
        return {"status": "error", "code": "tenant_denied"}
    if profile and (not selected or profile not in selected.get("profiles", {})):
        return {"status": "error", "code": "profile_denied"}
    return {"status": "ok", "level": "authenticated_user_policy_memberships_match",
            "backend_identity": "not_available", "write_test": "not_run",
            "selected_tenant": tenant, "selected_profile": profile,
            "permissions": selected.get("permissions", []) if selected else []}


async def connection(base_url, token_file, tenant, profile):
    from core.client.analysis import read_token, server_url
    from core.client.transport import api_call, tool_call
    import httpx2
    from mcp import Client
    from mcp.client.streamable_http import streamable_http_client
    # 주소와 토큰 원문은 결과에 포함하지 않는다.
    base, token = server_url(base_url), read_token(token_file)
    result = {"api": {"status": "not_run"}, "mcp": {"status": "not_run"},
              "comparison": {"status": "not_run", "backend_identity": "not_available"}}
    async with httpx2.AsyncClient(base_url=base + "/", headers={"Authorization": "Bearer " + token},
            timeout=10, trust_env=False, follow_redirects=False) as http:
        api = mcp_access = None
        try:
            api = await api_call(http, "GET", base + "/api/v1/access-context")
            result["api"] = {"status": "ok", "authentication": "accepted"}
        except Exception:
            result["api"] = {"status": "error", "code": "api_access_check_failed"}
        try:
            async with Client(streamable_http_client(base + "/mcp", http_client=http), mode="legacy") as client:
                mcp_access = await tool_call(client, "access_context", {})
                names = {tool.name for tool in (await client.list_tools()).tools}
                result["mcp"] = {"status": "ok", "initialized": True, "authentication": "accepted",
                    "access_context_available": "access_context" in names, "tool_count": len(names)}
        except Exception:
            result["mcp"] = {"status": "error", "code": "mcp_initialize_or_access_failed"}
        if api is not None and mcp_access is not None:
            result["comparison"] = access_match(api, mcp_access, tenant, profile)
    return result


async def diagnose(args):
    result = {"schema_version": 1, "platform": sys.platform, "python": str(Path(sys.executable)),
              "configured_python": str(project_python(PROJECT_DIR)), "python_supported": sys.version_info >= (3, 12),
              "dependencies": dependencies(), "ai": {"status": "not_run"},
              "connection": {"status": "not_run"}, "model_execution": "not_run", "settings_changed": False}
    from core.runtime.desktop_bridge import capabilities
    result["native_capabilities"] = capabilities()
    # Optional conversion readiness is separate from server/AI readiness.
    # Diagnostics do not install OCR or run recognition on user documents.
    try:
        from core.client.source_conversion_formats import diagnostics
        result["conversion"] = diagnostics(language=getattr(args, "ocr_language", "eng"))
    except Exception:
        result["conversion"] = {"status": "unavailable", "code": "conversion_diagnostic_unavailable"}
    if not args.skip_ai:
        try:
            from core.client.ai import create_adapter
            from core.client.ai.codex import _execute, _ENVIRONMENT
            from core.runtime.client_process import cli_command
            provider = getattr(args, "ai_provider", "codex")
            adapter = create_adapter(provider, cli=args.ai_cli)
            capability = await adapter.preflight()
            environment = {key: os.environ[key] for key in _ENVIRONMENT if key in os.environ}
            auth_arguments = ["login", "status"]
            if provider == "claude":
                from core.client.ai.claude import environment as claude_environment, _ISOLATION
                environment = claude_environment()
                auth_arguments = [*_ISOLATION, "auth", "status"]
            code, auth_output, _ = await _execute([*cli_command(adapter.cli), *auth_arguments], directory=None,
                                        environment=environment, timeout=15)
            if provider == "claude":
                from core.client.ai.claude import _json
                from core.client.ai.contracts import AIAdapterError
                try:
                    logged_in = _json(auth_output)["loggedIn"]
                    if type(logged_in) is not bool or code not in (0, 1) or logged_in != (code == 0):
                        raise ValueError()
                except (ValueError, KeyError, TypeError, UnicodeError):
                    raise AIAdapterError("ai_login_check_failed") from None
            result["ai"] = {"status": "ok" if code == 0 else "error", **capability,
                "login_checked": True, "login": "credentials_present" if code == 0 else "not_logged_in",
                "login_live_validity": "not_verified", "action": None if code == 0 else "run_" + provider + "_login_yourself"}
        except Exception as error:
            from core.client.transport import client_error_code
            result["ai"] = {"status": "error", "code": client_error_code(error) or "ai_runtime_unavailable"}
    if args.server:
        try:
            result["connection"] = await asyncio.wait_for(connection(args.server, args.token_file, args.tenant, args.profile), 30)
        except Exception:
            result["connection"] = {"status": "error", "code": "connection_check_failed"}
    result["ok"] = (result["python_supported"] and all(row["status"] == "ok" for row in result["dependencies"])
        and result["ai"]["status"] != "error" and result["connection"].get("status") != "error"
        and all(row.get("status") == "ok" for row in result["connection"].values() if isinstance(row, dict)))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--ai-provider", choices=("codex", "claude"), default="codex")
    parser.add_argument("--ai-cli", help="Selected provider's executable; defaults to its name.")
    parser.add_argument("--skip-ai", action="store_true")
    parser.add_argument("--ocr-language", default="eng")
    parser.add_argument("--server")
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--tenant")
    parser.add_argument("--profile")
    args = parser.parse_args(argv)
    if bool(args.server) != bool(args.token_file) or args.profile and not args.tenant:
        print(json.dumps({"ok": False, "error": {"code": "invalid_diagnostic_arguments"}}))
        return 2
    result = asyncio.run(diagnose(args))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
