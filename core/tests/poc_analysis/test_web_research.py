"""공개 웹 조회 경계·실제 읽은 텍스트·기본 도구 차단을 격리 자료로 검사한다."""

import asyncio
from email.message import Message
from hashlib import sha256
import json
from pathlib import Path
import socket
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from core.client.ai.codex import CodexAdapter, _events
from core.client.ai.claude import ClaudeAdapter, _Events
from core.client.ai.contracts import AIAdapterError
from core.client.web_research import (
    MAX_CONTENT, MAX_PAGE_BYTES, PageReadError, _PinnedConnection, _public_addresses, _text, public_url, read_page, research,
)


def codex_events(item_type="web_search"):
    return b"\n".join(json.dumps(event).encode() for event in [
        {"type": "item.started", "item": {"type": item_type}},
        {"type": "item.completed", "item": {"type": item_type, "status": "completed"}},
        {"type": "turn.completed"}])


class WebEventTests(unittest.IsolatedAsyncioTestCase):
    def test_codex_web_search_requires_opt_in_and_still_blocks_other_tools(self):
        with self.assertRaises(AIAdapterError):
            _events(codex_events(), [])
        trace, _ = _events(codex_events(), [], web_search=True)
        self.assertEqual(sum(bool(item.get("web_search_completed")) for item in trace), 1)
        with self.assertRaises(AIAdapterError):
            _events(codex_events("command_execution"), [], web_search=True)

    def test_claude_web_result_requires_matching_search_and_opt_in(self):
        search = json.dumps({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "search-1", "name": "WebSearch", "input": {"query": "public topic"}}]}})
        result = json.dumps({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "search-1", "content": "public results"}]}})
        with self.assertRaises(AIAdapterError):
            _Events()(search, lambda _: None)
        events = _Events(web_search=True)
        events(search, lambda _: None)
        self.assertFalse(events.web_completed_ids)
        events(result, lambda _: None)
        self.assertEqual(events.web_completed_ids, {"search-1"})
        with self.assertRaises(AIAdapterError):
            _Events(web_search=True)(result, lambda _: None)
        with self.assertRaises(AIAdapterError):
            _Events(web_search=True)(search.replace('"WebSearch"', '"WebFetch"'), lambda _: None)

    async def test_codex_flags_and_completed_search_requirement(self):
        calls = []
        async def execute(arguments, **kwargs):
            calls.append(arguments)
            Path(kwargs["result_path"]).write_text('{"urls":[]}', encoding="utf-8")
            return 0, codex_events() if len(calls) == 1 else b'{"type":"turn.completed"}', b""
        adapter = CodexAdapter()
        adapter._capabilities = (["codex"], "isolated-fixture")
        schema = {"type": "object", "properties": {"urls": {"type": "array", "items": {"type": "string"}}},
            "required": ["urls"], "additionalProperties": False}
        with TemporaryDirectory() as root, patch("core.client.ai.codex._execute", execute):
            first = await adapter.run(prompt="public query", schema=schema, directory=Path(root).resolve()/"first", web_search=True)
            self.assertEqual(first["execution"]["web_search_completed"], 1)
            self.assertIn('web_search="live"', calls[0])
            self.assertIn("shell_tool", calls[0])
            self.assertIn("--ephemeral", calls[0])
            with self.assertRaises(AIAdapterError) as caught:
                await adapter.run(prompt="public query", schema=schema, directory=Path(root).resolve()/"second", web_search=True)
            self.assertEqual(caught.exception.code, "ai_web_search_not_used")

    async def test_search_cannot_resume_a_conversation(self):
        for adapter in (CodexAdapter(), ClaudeAdapter()):
            adapter.persist_session = True
            with self.assertRaises(AIAdapterError) as caught:
                await adapter.run(prompt="public", schema={}, directory="unused", web_search=True)
            self.assertEqual(caught.exception.code, "ai_invalid_input")

    async def test_claude_flags_keep_only_websearch_and_require_a_successful_tool_result(self):
        calls = []
        async def execute(arguments, **kwargs):
            calls.append(arguments)
            events = [
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "s1", "name": "WebSearch", "input": {"query": "public"}}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "s1", "content": "result"}]}},
                {"type": "result", "subtype": "success", "is_error": False, "structured_output": {"urls": []}},
            ]
            for event in events if len(calls) == 1 else events[-1:]:
                kwargs["event_parser"](json.dumps(event), kwargs["on_event"])
            return 0, b"", b""
        adapter = ClaudeAdapter()
        adapter._capabilities = (["claude"], "isolated-fixture")
        schema = {"type": "object", "properties": {"urls": {"type": "array", "items": {"type": "string"}}},
            "required": ["urls"], "additionalProperties": False}
        with TemporaryDirectory() as root, patch("core.client.ai.claude._execute", execute):
            first = await adapter.run(prompt="public", schema=schema, directory=Path(root).resolve()/"first", web_search=True)
            self.assertEqual(first["execution"]["web_search_completed"], 1)
            self.assertEqual(calls[0][calls[0].index("--tools") + 1], "WebSearch")
            self.assertEqual(calls[0][calls[0].index("--allowedTools") + 1], "WebSearch")
            self.assertIn("mcp__*", calls[0])
            self.assertIn("--no-session-persistence", calls[0])
            with self.assertRaises(AIAdapterError) as caught:
                await adapter.run(prompt="public", schema=schema, directory=Path(root).resolve()/"second", web_search=True)
            self.assertEqual(caught.exception.code, "ai_web_search_not_used")


class PublicReadTests(unittest.TestCase):
    def test_url_rejects_credentials_ips_local_names_ports_and_controls(self):
        for url in ("file:///etc/passwd", "https://127.0.0.1/", "http://[::1]/", "http://localhost/",
                "https://public.example:444/", "https://user:pass@public.example/", "https://a.local/",
                "https://public.example/\nsecret", "https://public.example\\@127.0.0.1/"):
            with self.subTest(url=url), self.assertRaises(PageReadError):
                public_url(url)
        self.assertEqual(public_url("https://PUBLIC.EXAMPLE/path#fragment"), "https://public.example/path")

    def test_dns_rejects_any_private_or_mixed_address(self):
        for addresses in (["127.0.0.1"], ["10.0.0.1"], ["169.254.169.254"], ["::1"], ["8.8.8.8", "192.168.0.1"]):
            rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses]
            with self.subTest(addresses=addresses), patch("socket.getaddrinfo", return_value=rows), self.assertRaises(PageReadError):
                _public_addresses("public.example", 443)
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch("socket.getaddrinfo", return_value=rows):
            self.assertEqual(_public_addresses("public.example", 443), ["8.8.8.8"])

    def test_tls_connects_to_the_checked_ip_and_verifies_the_original_host(self):
        connection = _PinnedConnection("public.example", 443, ["8.8.8.8"], secure=True, timeout=5)
        with patch("socket.create_connection") as connect, patch("ssl.create_default_context") as context:
            connection.connect()
        connect.assert_called_once_with(("8.8.8.8", 443), 5)
        context.return_value.wrap_socket.assert_called_once_with(connect.return_value, server_hostname="public.example")

    def test_html_discards_executable_and_hidden_text_preserves_original_excerpt(self):
        raw = b'<title> Public &amp; title </title><script>steal()</script><style>bad</style><p>First <b>sentence</b>.</p><div hidden>secret<br>also hidden</div><input hidden><p>Second sentence.</p>'
        title, content, truncated = _text(raw, "text/html", "utf-8", "public.example")
        self.assertEqual(title, "Public & title")
        self.assertEqual(content, "First sentence.\nSecond sentence.")
        self.assertFalse(truncated)

    def fake_connection(self, responses):
        owner = self
        class Connection:
            def __init__(self, host, port, addresses, **kwargs):
                owner.connections.append((host, port, addresses, kwargs))
                self.response = responses.pop(0)
                self.sock = None
            def request(self, method, path, headers):
                owner.requests.append((method, path, headers))
            def getresponse(self):
                return self.response
            def close(self):
                pass
        return Connection

    def response(self, body=b"plain public text", status=200, **headers):
        class Response:
            def __init__(self):
                self.status, self.body = status, body
                self.headers = Message()
                self.headers["Content-Type"] = headers.pop("content_type", "text/plain; charset=utf-8")
                for key, value in headers.items():
                    self.headers[key] = value
            def getheader(self, name, default=None):
                return self.headers.get(name, default)
            def read1(self, size):
                block, self.body = self.body[:size], self.body[size:]
                return block
        return Response()

    def setUp(self):
        self.connections, self.requests = [], []

    def test_reads_pinned_dns_address_and_records_text_hash(self):
        connection = self.fake_connection([self.response()])
        with patch("core.client.web_research._public_addresses", return_value=["8.8.8.8"]) as resolve, patch(
                "core.client.web_research._PinnedConnection", connection):
            source, truncated = read_page("https://public.example/article")
        resolve.assert_called_once_with("public.example", 443)
        self.assertEqual(self.connections[0][2], ["8.8.8.8"])
        self.assertEqual(source["content_sha256"], sha256(b"plain public text").hexdigest())
        self.assertTrue(source["retrieved_at"].endswith("+00:00"))
        self.assertFalse(truncated)
        self.assertNotIn("Authorization", self.requests[0][2])
        self.assertNotIn("Cookie", self.requests[0][2])

    def test_redirect_to_private_url_is_rejected_before_connecting(self):
        connection = self.fake_connection([self.response(status=302, Location="http://127.0.0.1/private")])
        with patch("core.client.web_research._public_addresses", return_value=["8.8.8.8"]), patch(
                "core.client.web_research._PinnedConnection", connection), self.assertRaises(PageReadError):
            read_page("https://public.example/article")
        self.assertEqual(len(self.connections), 1)

    def test_redirect_dns_is_rechecked_and_rebinding_cannot_change_pinned_ip(self):
        connection = self.fake_connection([self.response(status=302, Location="https://next.example/final"), self.response()])
        with patch("core.client.web_research._public_addresses", side_effect=[["8.8.8.8"], ["1.1.1.1"]]) as resolve, patch(
                "core.client.web_research._PinnedConnection", connection):
            source, _ = read_page("https://public.example/article")
        self.assertEqual(resolve.call_count, 2)
        self.assertEqual(self.connections[1][2], ["1.1.1.1"])
        self.assertEqual(source["url"], "https://next.example/final")

    def test_bounded_body_is_explicitly_partial_and_binary_is_refused(self):
        connection = self.fake_connection([self.response(body=b"a" * (MAX_PAGE_BYTES + 100))])
        with patch("core.client.web_research._public_addresses", return_value=["8.8.8.8"]), patch(
                "core.client.web_research._PinnedConnection", connection):
            source, truncated = read_page("https://public.example/article")
        self.assertEqual(len(source["content"]), MAX_CONTENT)
        self.assertTrue(truncated)
        connection = self.fake_connection([self.response(content_type="application/pdf")])
        with patch("core.client.web_research._public_addresses", return_value=["8.8.8.8"]), patch(
                "core.client.web_research._PinnedConnection", connection), self.assertRaises(PageReadError):
            read_page("https://public.example/file.pdf")


class ResearchTests(unittest.IsolatedAsyncioTestCase):
    def adapter(self, urls, completed=1):
        owner = self
        class Adapter:
            async def run(self, **kwargs):
                owner.invocation = kwargs
                return {"value": {"urls": urls}, "execution": {"web_search_completed": completed}}
        return Adapter()

    def reader(self, url):
        if "bad" in url:
            raise PageReadError("page_timeout")
        text = "An actual public statement."
        return {"url": url, "title": "Public source", "content": text,
            "content_sha256": sha256(text.encode()).hexdigest(), "retrieved_at": "2026-11-05T00:00:00+00:00"}, False

    async def test_only_public_query_goes_to_separate_search_and_actual_text_returns(self):
        result = await research("public topic", directory="unused", adapter=self.adapter(["https://public.example/a"]), reader=self.reader)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["sources"][0]["content"], "An actual public statement.")
        self.assertTrue(self.invocation["web_search"])
        self.assertTrue(self.invocation["prompt"].endswith('"public topic"'))
        self.assertNotIn("session_id", self.invocation)

    async def test_partial_failure_retains_read_source_and_warning(self):
        result = await research("public topic", directory="unused", adapter=self.adapter([
            "https://public.example/a", "https://bad.example/a"]), reader=self.reader)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(result["warnings"], ["page_timeout"])

    async def test_no_search_event_and_no_results_are_different(self):
        result = await research("public topic", directory="unused", adapter=self.adapter([], completed=0), reader=self.reader)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["warnings"], ["search_not_performed"])
        result = await research("public topic", directory="unused", adapter=self.adapter([]), reader=self.reader)
        self.assertEqual(result, {"query": "public topic", "status": "empty", "sources": [], "warnings": []})

    async def test_cancel_is_propagated_instead_of_becoming_empty_results(self):
        class Adapter:
            async def run(self, **kwargs):
                raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await research("public topic", directory="unused", adapter=Adapter())


if __name__ == "__main__":
    unittest.main()
