"""수신 중단·크기 초과·취소가 multipart spool을 남기지 않는지 확인한다."""

import asyncio
import tempfile
import unittest
from unittest.mock import patch

from starlette.requests import Request

from core.api.v1.sources.ingress import SourceHttpError, upload_input


class SourceIngressTests(unittest.IsolatedAsyncioTestCase):
    async def test_multipart_spool_closes_on_overflow_disconnect_and_cancel(self):
        first = (b"--BOUND\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\n"
                 b"Content-Type: text/plain\r\n\r\n" + b"x" * (1024 * 1024 + 1))
        for outcome in ("overflow", "disconnect", "cancel"):
            with self.subTest(outcome=outcome):
                opened = []
                def spool(*args, **kwargs):
                    stream = tempfile.SpooledTemporaryFile(*args, **kwargs)
                    opened.append(stream)
                    return stream
                messages = 0
                async def receive():
                    nonlocal messages
                    messages += 1
                    if messages == 1:
                        return {"type": "http.request", "body": first, "more_body": True}
                    if outcome == "cancel":
                        raise asyncio.CancelledError()
                    if outcome == "disconnect":
                        return {"type": "http.disconnect"}
                    return {"type": "http.request", "body": b"x" * 8, "more_body": False}
                request = Request({"type": "http", "method": "POST", "path": "/", "headers": [
                    (b"content-type", b"multipart/form-data; boundary=BOUND")]}, receive)
                expected = asyncio.CancelledError if outcome == "cancel" else SourceHttpError
                with patch("starlette.formparsers.SpooledTemporaryFile", spool), \
                        patch("core.api.v1.sources.ingress.MAX_UPLOAD_REQUEST_BYTES", len(first) + 4), \
                        self.assertRaises(expected):
                    async with upload_input(request, version=False):
                        self.fail("An interrupted multipart body cannot yield a source.")
                self.assertEqual(len(opened), 1)
                self.assertTrue(all(stream.closed for stream in opened))


if __name__ == "__main__":
    unittest.main()
