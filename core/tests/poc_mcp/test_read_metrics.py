"""Opt-in timings stay private and never change isolated HTTP work or errors."""

import asyncio
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import logging
import unittest
from unittest.mock import patch

import anyio
from fastapi import FastAPI, HTTPException
import httpx2 as httpx

from core.common import read_metrics as metrics
from core.runtime import http_cli, http_metrics
from core.tests.poc_mcp.test_server_integration import ServerFixture


class ReadMetricsTests(unittest.TestCase):
    def test_nested_spans_counts_and_unknown_labels_never_store_private_values(self):
        secret = "PRIVATE /tenant/user/document?token=hidden\nbody"
        failure = ValueError(secret)
        with metrics.collect() as recorder:
            with patch.object(metrics, "perf_counter", side_effect=[1.0, 2.0, 3.0, 4.0]):
                with metrics.span("scan"):
                    with metrics.span("canonical_read"):
                        metrics.increment("scanned", 7)
            with self.assertRaises(ValueError) as caught, metrics.span(secret):
                metrics.increment(secret, 2)
                metrics.cache_event("hit")
                metrics.cache_event("miss")
                metrics.cache_event("fallback", "busy")
                metrics.cache_event("fallback", secret)
                raise failure
            for invalid in (-1, True, 1.5, float("nan"), 1_000_000_001):
                metrics.increment("scanned", invalid)
            value = recorder.finish()
        self.assertIs(caught.exception, failure)
        self.assertEqual(value["stages_ms"]["scan"], 3000.0)
        self.assertEqual(value["stages_ms"]["canonical_read"], 1000.0)
        self.assertEqual(value["stage_calls"], {"canonical_read": 1, "other": 1, "scan": 1})
        self.assertEqual(value["counters"], {"cache_fallbacks": 2, "cache_hits": 1, "cache_misses": 1,
                                               "other": 2, "scanned": 7})
        self.assertEqual(value["cache_fallbacks"], {"busy": 1, "unknown": 1})
        self.assertNotIn(secret, json.dumps(value))
        self.assertIsNone(metrics._CURRENT.get())

    def test_nested_request_context_restores_outer_and_closed_collection_ignores_late_work(self):
        metrics.increment("scanned", 99)
        with metrics.collect() as outer:
            metrics.increment("scanned", 1)
            with metrics.collect() as inner:
                metrics.increment("scanned", 7)
                inside = inner.finish()
            metrics.increment("scanned", 2)
            outside = outer.finish()
            metrics.increment("scanned", 100)
            with metrics.span("scan"):
                pass
            metrics.cache_event("fallback", "io")
            self.assertEqual(outer.finish(), outside)
        self.assertEqual(inside["counters"], {"scanned": 7})
        self.assertEqual(outside["counters"], {"scanned": 3})
        self.assertNotEqual(inside["request_id"], outside["request_id"])
        self.assertIsNone(metrics._CURRENT.get())

    def test_clock_counter_and_cache_measurement_failures_preserve_original_exception(self):
        failure = OSError("original private failure")
        with metrics.collect() as recorder:
            with patch.object(metrics, "perf_counter", side_effect=RuntimeError("clock failed")):
                with self.assertRaises(OSError) as caught, metrics.span("scan"):
                    raise failure
            with patch.object(recorder, "increment", side_effect=RuntimeError("counter failed")):
                metrics.increment("scanned")
            with patch.object(recorder, "cache_event", side_effect=RuntimeError("cache metric failed")):
                metrics.cache_event("hit")
            self.assertEqual(recorder.finish()["counters"], {})
        self.assertIs(caught.exception, failure)

    def test_cli_switch_enables_only_explicit_metrics_and_keeps_server_arguments(self):
        for enabled in (False, True):
            arguments = ["http_cli", "--access-config", "/isolated/access.json", "--tenant-root", "/isolated/data"]
            if enabled:
                arguments.append("--read-metrics")
            with self.subTest(enabled=enabled), patch("sys.argv", arguments), \
                    patch.object(http_cli, "AccessPolicy"), patch.object(http_cli, "create_application") as application, \
                    patch.object(http_cli, "configured_ruleset_paths", return_value=(None, None)), \
                    patch.object(http_cli, "configured_rulesets", return_value=None), \
                    patch.object(http_cli, "enable_logging") as enable, patch.object(http_cli.uvicorn, "run") as run:
                http_cli.main()
            self.assertEqual(enable.call_count, int(enabled))
            self.assertIs(run.call_args.args[0], application.return_value)
            self.assertFalse(run.call_args.kwargs["access_log"])
            self.assertFalse(run.call_args.kwargs["proxy_headers"])

    def test_opt_in_logger_emits_one_json_line_to_stderr_without_changing_root_logger(self):
        logger = http_metrics.LOGGER
        original = (logger.level, list(logger.handlers), logger.propagate)
        root = logging.getLogger()
        root_state = (root.level, list(root.handlers))
        stderr, stdout = io.StringIO(), io.StringIO()
        try:
            logger.handlers = []
            with redirect_stderr(stderr), redirect_stdout(stdout):
                http_metrics.enable_logging()
                http_metrics.enable_logging()
                logger.info('{"event":"test"}')
            self.assertEqual(stderr.getvalue(), '{"event":"test"}\n')
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual((root.level, root.handlers), root_state)
        finally:
            for handler in logger.handlers:
                if handler not in original[1]:
                    handler.close()
            logger.level, logger.handlers, logger.propagate = original


class ReadMetricsAsyncTests(unittest.IsolatedAsyncioTestCase):
    def application(self, endpoint):
        app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        app.post("/read/{private}")(endpoint)
        app.add_middleware(http_metrics.HttpMetricsMiddleware, route_templates=lambda: ("/read/{private}",))
        return app

    async def test_concurrent_requests_and_worker_threads_have_independent_safe_summaries(self):
        serial = iter(range(1, 9))
        async def endpoint(private: str):
            amount = next(serial)
            with metrics.span("scan"):
                metrics.increment("scanned", amount)
                await anyio.to_thread.run_sync(lambda: metrics.increment("journal_reads", amount * 10))
                await asyncio.sleep(0)
            metrics.cache_event("hit")
            return {"ok": True}
        messages = []
        transport = httpx.ASGITransport(app=self.application(endpoint))
        with patch.object(http_metrics.LOGGER, "isEnabledFor", return_value=True), \
                patch.object(http_metrics.LOGGER, "info", side_effect=messages.append):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                responses = await asyncio.gather(*(client.post(f"/read/PRIVATE_PATH_{number}",
                    params={"document": "PRIVATE_DOCUMENT"}, json={"body": "PRIVATE_BODY"},
                    headers={"Authorization": "Bearer PRIVATE_TOKEN", "X-User": "PRIVATE_USER"}) for number in range(8)))
        self.assertTrue(all(response.json() == {"ok": True} for response in responses))
        events = [json.loads(message) for message in messages]
        self.assertEqual(len(events), 8)
        self.assertEqual(len({event["request_id"] for event in events}), 8)
        self.assertEqual({event["counters"]["scanned"] for event in events}, set(range(1, 9)))
        for event in events:
            self.assertEqual(event["counters"]["journal_reads"], event["counters"]["scanned"] * 10)
            self.assertEqual(event["counters"]["cache_hits"], 1)
            self.assertEqual((event["route"], event["method"], event["status"], event["failed"]),
                             ("/read/{private}", "POST", 200, False))
            self.assertGreaterEqual(event["duration_ms"], event["stages_ms"]["scan"] - 0.001)
        for secret in ("PRIVATE_PATH", "PRIVATE_TOKEN", "PRIVATE_USER", "PRIVATE_DOCUMENT", "PRIVATE_BODY"):
            self.assertNotIn(secret, "\n".join(messages))
        self.assertIsNone(metrics._CURRENT.get())

    async def test_handled_and_unhandled_errors_keep_status_and_original_exception(self):
        failure = ValueError("PRIVATE_EXCEPTION_MESSAGE")
        async def endpoint(private: str):
            with metrics.span("canonical_read"):
                if private == "handled":
                    raise HTTPException(409, "PRIVATE_HANDLED_DETAIL")
                raise failure
        messages = []
        transport = httpx.ASGITransport(app=self.application(endpoint))
        with patch.object(http_metrics.LOGGER, "isEnabledFor", return_value=True), \
                patch.object(http_metrics.LOGGER, "info", side_effect=messages.append):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                handled = await client.post("/read/handled")
                with self.assertRaises(ValueError) as caught:
                    await client.post("/read/unhandled")
        self.assertEqual(handled.status_code, 409)
        self.assertEqual(handled.json(), {"detail": "PRIVATE_HANDLED_DETAIL"})
        self.assertIs(caught.exception, failure)
        events = [json.loads(message) for message in messages]
        self.assertEqual([(event["status"], event["failed"]) for event in events], [(409, False), (500, True)])
        self.assertNotIn("PRIVATE_", "\n".join(messages))
        self.assertIsNone(metrics._CURRENT.get())

    async def test_metrics_failures_never_replace_normal_response_or_original_error(self):
        failure = ValueError("original error")
        async def endpoint(private: str):
            metrics.increment("scanned")
            if private == "error":
                raise failure
            return {"ok": True}
        for target in ("logger", "clock", "collector", "snapshot", "route"):
            app = self.application(endpoint)
            operation = {
                "logger": lambda: patch.object(http_metrics.LOGGER, "info", side_effect=RuntimeError("log failed")),
                "clock": lambda: patch.object(http_metrics, "perf_counter", side_effect=RuntimeError("clock failed")),
                "collector": lambda: patch.object(metrics, "RequestMetrics", side_effect=RuntimeError("collector failed")),
                "snapshot": lambda: patch.object(metrics.RequestMetrics, "finish", side_effect=RuntimeError("snapshot failed")),
                "route": lambda: patch.object(http_metrics.HttpMetricsMiddleware, "_template", side_effect=RuntimeError("route failed")),
            }[target]
            with self.subTest(target=target), patch.object(http_metrics.LOGGER, "isEnabledFor", return_value=True), \
                    patch.object(http_metrics.LOGGER, "info"), operation():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                    self.assertEqual((await client.post("/read/normal")).json(), {"ok": True})
                    with self.assertRaises(ValueError) as caught:
                        await client.post("/read/error")
                self.assertIs(caught.exception, failure)
            self.assertIsNone(metrics._CURRENT.get())

    async def test_disabled_metrics_do_not_create_a_collector_or_emit_logs(self):
        async def endpoint(private: str):
            metrics.increment("scanned")
            return {"ok": True}
        with patch.object(http_metrics.LOGGER, "isEnabledFor", return_value=False), \
                patch.object(metrics, "RequestMetrics", side_effect=AssertionError("disabled collector created")), \
                patch.object(http_metrics.LOGGER, "info") as logged:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.application(endpoint)), base_url="http://test") as client:
                self.assertEqual((await client.post("/read/private")).json(), {"ok": True})
        logged.assert_not_called()

    async def test_cancellation_keeps_original_exception_and_resets_request_context(self):
        failure = asyncio.CancelledError("PRIVATE_CANCEL_REASON")
        async def endpoint(private: str):
            with metrics.span("canonical_read"):
                raise failure
        messages = []
        with patch.object(http_metrics.LOGGER, "isEnabledFor", return_value=True), \
                patch.object(http_metrics.LOGGER, "info", side_effect=messages.append):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.application(endpoint)), base_url="http://test") as client:
                with self.assertRaises(asyncio.CancelledError) as caught:
                    await client.post("/read/private")
        self.assertIs(caught.exception, failure)
        event = json.loads(messages[0])
        self.assertEqual((event["status"], event["failed"]), (500, True))
        self.assertNotIn("PRIVATE_CANCEL_REASON", messages[0])
        self.assertIsNone(metrics._CURRENT.get())

    async def test_streaming_messages_are_unchanged_and_only_log_after_full_app_call(self):
        messages, sent = [], []
        original = [{"type": "http.response.start", "status": 200, "headers": [(b"x-private", b"PRIVATE_HEADER")]},
            {"type": "http.response.body", "body": b"PRIVATE_BODY", "more_body": True},
            {"type": "http.response.body", "body": b"final", "more_body": False}]
        async def receive():
            self.fail("metrics consumed the request body")
        async def send(message):
            sent.append(message)
        async def application(scope, forwarded_receive, forwarded_send):
            self.assertIs(forwarded_receive, receive)
            for message in original:
                await forwarded_send(message)
                self.assertEqual(messages, [])
            with metrics.span("projection"):
                await asyncio.sleep(0)
        middleware = http_metrics.HttpMetricsMiddleware(application, route_templates=lambda: ("/stream/{private}",))
        with patch.object(http_metrics.LOGGER, "isEnabledFor", return_value=True), \
                patch.object(http_metrics.LOGGER, "info", side_effect=messages.append):
            await middleware({"type": "http", "method": "GET", "path": "/stream/PRIVATE_PATH"}, receive, send)
        self.assertEqual(sent, original)
        self.assertTrue(all(actual is expected for actual, expected in zip(sent, original)))
        event = json.loads(messages[0])
        self.assertEqual(event["stage_calls"], {"projection": 1})
        self.assertEqual(event["route"], "/stream/{private}")
        self.assertNotIn("PRIVATE_", messages[0])


class ReadMetricsHttpIntegration(ServerFixture):
    def test_actual_api_mcp_auth_rejections_and_unknown_routes_log_only_templates(self):
        messages = []
        with patch.object(http_metrics.LOGGER, "isEnabledFor", return_value=True), \
                patch.object(http_metrics.LOGGER, "info", side_effect=messages.append):
            path = f"/api/v1/tenants/{self.tenant}/documents"
            self.assertEqual(self.client.get(path, headers=self.headers()).status_code, 200)
            self.assertEqual(self.client.get(path).status_code, 401)
            self.assertEqual(self.client.get("/api/PRIVATE_UNKNOWN", headers=self.headers()).status_code, 404)
            self.assertTrue(self.mcp("access_context", {})["ok"])
        events = [json.loads(message) for message in messages]
        self.assertEqual([event["route"] for event in events], [
            "/api/v1/tenants/{tenant}/documents", "/api/v1/tenants/{tenant}/documents", "/api/{path:path}", "/mcp"])
        self.assertEqual([event["status"] for event in events], [200, 401, 404, 200])
        for secret in (self.token, self.user["user_id"], self.tenant, "PRIVATE_UNKNOWN", "Bearer"):
            self.assertNotIn(secret, "\n".join(messages))
        self.assertIsNone(metrics._CURRENT.get())


if __name__ == "__main__":
    unittest.main()
