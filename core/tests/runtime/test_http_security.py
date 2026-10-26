"""공통 HTTP 입구가 API와 MCP를 같은 인증·호스트 경계로 보호하는지 확인한다."""

import asyncio
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

import httpx2
from starlette.responses import JSONResponse

from core.modules.access.policy import AccessDenied, AccessScope, PolicyError
from core.modules.documents.store import WikiStore
from core.mcp.request_context import _authorized_scope
from core.mcp.tenant import TenantMCPServer
from core.runtime.http_security import HttpAccessMiddleware, bearer


class HttpSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.policy = Mock()
        self.calls = []

        async def endpoint(scope, receive, send):
            self.calls.append(scope["path"])
            await JSONResponse({"read": True})(scope, receive, send)

        def error_response(status_code, code, message, headers=None):
            return JSONResponse({"error": {"code": code, "message": message}},
                                status_code=status_code, headers=headers)

        self.app = HttpAccessMiddleware(endpoint, policy=self.policy, error_response=error_response)

    def client(self):
        return httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=self.app), base_url="http://127.0.0.1:8765",
            headers={"Authorization": "Bearer " + "x" * 43},
        )

    async def test_all_paths_authenticate_before_routing_or_host_validation(self):
        self.policy.authenticate.side_effect = AccessDenied()
        async with self.client() as client:
            for path in ("/api/v1/access-context", "/docs", "/openapi.json", "/redoc", "/mcp", "/"):
                response = await client.get(path, headers={"Host": "attacker.example"})
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.headers["www-authenticate"], "Bearer")
                if path.startswith("/api") or path in {"/docs", "/openapi.json", "/redoc"}:
                    self.assertEqual(response.json()["error"]["code"], "unauthenticated")
                else:
                    self.assertEqual(response.text, "Unauthorized")
        self.assertEqual(self.calls, [])

    async def test_policy_unavailable_is_not_cached_or_fallback_authenticated(self):
        async with self.client() as client:
            self.assertEqual((await client.get("/api/v1/access-context")).status_code, 200)
            self.policy.authenticate.side_effect = PolicyError()
            for path in ("/api/v1/access-context", "/mcp"):
                response = await client.get(path)
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("x" * 43, response.text)
            self.policy.authenticate.side_effect = None
            self.assertEqual((await client.get("/api/v1/access-context")).status_code, 200)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.policy.authenticate.call_count, 4)

    async def test_api_get_does_not_require_mcp_json_content_type(self):
        async with self.client() as client:
            response = await client.get("/api/v1/access-context")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"read": True})
            for method in ("GET", "HEAD", "DELETE", "OPTIONS"):
                response = await client.request(method, "/mcp")
                self.assertEqual(response.status_code, 405)
                self.assertEqual(response.headers["allow"], "POST")
            # MCP JSON/body 검증은 하위 SDK 핸들러에서 수행한다.
            self.assertEqual((await client.post("/mcp")).status_code, 200)

    async def test_api_host_origin_and_duplicates_fail_before_endpoint(self):
        async with self.client() as client:
            for headers, status, code in (
                ({"Host": "attacker.example"}, 421, "invalid_host"),
                ({"Origin": "https://attacker.example"}, 403, "invalid_origin"),
                ([("Host", "127.0.0.1:8765"), ("Host", "attacker.example")], 421, "invalid_host"),
                ([("Origin", "http://127.0.0.1:8765"), ("Origin", "https://attacker.example")], 403,
                 "invalid_origin"),
            ):
                response = await client.get("/api/v1/access-context", headers=headers)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["error"]["code"], code)
        self.assertEqual(self.calls, [])

    async def test_policy_io_runs_outside_event_loop_thread(self):
        loop_thread = threading.get_ident()
        seen = []
        self.policy.authenticate.side_effect = lambda credential: seen.append(threading.get_ident())
        async with self.client() as client:
            await asyncio.gather(*(client.get("/api/v1/access-context") for _ in range(4)))
        self.assertEqual(len(seen), 4)
        self.assertNotIn(loop_thread, seen)

    async def test_bearer_rejects_duplicate_nonascii_wrong_scheme(self):
        valid = b"Bearer " + b"x" * 43
        for headers in (
            [], [(b"authorization", valid)] * 2,
            [(b"authorization", b"Basic value")],
            [(b"authorization", b"Bearer \xff")],
            [(b"authorization", b"Bearer\tvalue")],
        ):
            self.assertIsNone(bearer({"headers": headers}))
        self.assertEqual(bearer({"headers": [(b"Authorization", valid)]}), "x" * 43)

    async def test_lifespan_passes_through_and_auth_modes_are_explicit(self):
        events = []

        async def lifespan_app(scope, receive, send):
            events.append(scope["type"])

        middleware = HttpAccessMiddleware(lifespan_app, policy=self.policy)
        await middleware({"type": "lifespan"}, None, None)
        self.assertEqual(events, ["lifespan"])
        for kwargs in ({}, {"token": "x" * 43, "policy": self.policy}):
            with self.assertRaises(ValueError):
                HttpAccessMiddleware(lifespan_app, **kwargs)


class TenantPolicyThreadTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_mcp_policy_path_runs_in_thread_without_retaining_scope(self):
        with TemporaryDirectory() as temporary:
            store = WikiStore(Path(temporary))
            store.save("Guide.md", "thread boundary\n", expected_revision=None)
            scope = AccessScope("test-user", "test", "all", None, None, "a" * 64, store)
            policy = Mock()
            seen = []
            loop_thread = threading.get_ident()

            def capture(value):
                def call(*args):
                    seen.append(threading.get_ident())
                    return value
                return call

            policy.describe.side_effect = capture({"user_id": "test-user", "memberships": {},
                                                   "policy_revision": "a" * 64})
            policy.authenticate.side_effect = capture("test-user")
            policy.authorize.side_effect = capture(scope)
            server = TenantMCPServer(policy, "x" * 43)
            self.assertTrue((await server.call_tool("access_context", {})).structured_content["ok"])
            for name, arguments in (
                ("unknown_tool", {}),
                ("wiki_read", {}),
                ("wiki_read", {"tenant": "test", "profile": 7}),
            ):
                result = await server.call_tool(name, arguments)
                self.assertEqual(result.structured_content["error"]["code"], "invalid_argument")
            read = await server.call_tool("wiki_read", {"tenant": "test", "document": "Guide.md"})
            self.assertEqual(read.structured_content["content"], "thread boundary\n")
            self.assertEqual(read.structured_content["access"]["user_id"], "test-user")
            self.assertEqual(len(seen), 5)
            self.assertNotIn(loop_thread, seen)
            self.assertIsNone(_authorized_scope.get())
            policy.authorize.side_effect = AccessDenied()
            denied = await server.call_tool("wiki_read", {"tenant": "test", "document": "Guide.md"})
            self.assertEqual(denied.structured_content["error"]["code"], "access_denied")
            self.assertIsNone(_authorized_scope.get())

    async def test_blocked_mcp_policy_read_leaves_async_loop_available(self):
        policy = Mock()
        entered = threading.Event()
        release = threading.Event()
        waited = []

        def slow_describe(credential):
            entered.set()
            waited.append(release.wait(2))
            return {"user_id": "test-user", "memberships": {}, "policy_revision": "a" * 64}

        policy.describe.side_effect = slow_describe
        server = TenantMCPServer(policy, "x" * 43)
        task = asyncio.create_task(server.call_tool("access_context", {}))
        try:
            self.assertTrue(await asyncio.wait_for(asyncio.to_thread(entered.wait, 1), timeout=1.5))
            self.assertFalse(task.done())
        finally:
            release.set()
            await task
        self.assertEqual(waited, [True])


if __name__ == "__main__":
    unittest.main()
