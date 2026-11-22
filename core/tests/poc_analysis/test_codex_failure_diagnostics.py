"""A failed CLI keeps useful fixed observations, never provider error text."""
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.client.ai.codex import CodexAdapter
from core.client.ai.codex_diagnostics import failure_observation
from core.client.ai.contracts import AIAdapterError
from core.common.json_codec import canonical_json_bytes

SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}},
          "required": ["answer"], "additionalProperties": False}
SECRET = "sk-private-example-only"


def events(*items):
    return b"\n".join(json.dumps(item).encode() for item in items)


class FailureObservationTests(unittest.TestCase):
    def test_error_labels_and_status_without_error_text_or_identifiers(self):
        raw = events({"type": "error", "message":
            "stream disconnected before completion: unexpected status 503; " + SECRET},
            {"type": "turn.failed", "error": {"code": "invalid_json_schema", "message":
                "Invalid schema for response_format; https://private.invalid/" + SECRET}})
        value = failure_observation(raw, b"Authorization: Bearer " + SECRET.encode())
        self.assertEqual(value["error_count"], 2)
        self.assertEqual(value["errors"][0]["http_statuses"], [503])
        self.assertIn("stream_disconnected", value["errors"][0]["signals"])
        self.assertIn("invalid_schema", value["errors"][1]["signals"])
        self.assertEqual(value["errors"][1]["provider_code"], "invalid_json_schema")
        self.assertNotIn(SECRET, json.dumps(value))
        self.assertNotIn("private.invalid", json.dumps(value))
        self.assertFalse(value["raw_error_text_stored"])

    def test_unknown_and_malformed_events_do_not_mask_original_failure(self):
        raw = b"\xff\nnull\n[]\n" + events({"type": []}, {"type": "error", "message": "\ud800",
                "code": SECRET}, {"type": SECRET})
        value = failure_observation(raw, b"")
        self.assertEqual(value["invalid_lines"], 5)
        self.assertEqual(value["errors"][0]["signals"], ["unclassified"])
        self.assertIsNone(value["errors"][0]["provider_code"])
        self.assertNotIn(SECRET, json.dumps(value))
        self.assertEqual(value["usage_reports"], [])

    def test_bounded_errors_and_usage_only_when_provider_reports_counts(self):
        raw = events(*([{"type": "error", "message": "rate limit exceeded"}] * 20),
            {"type": "turn.failed", "error": {"message": "failed"},
             "usage": {"input_tokens": 9, "output_tokens": 2, "cached_input_tokens": True,
                       "other": SECRET}})
        value = failure_observation(raw, b"")
        self.assertEqual(value["error_count"], 21)
        self.assertEqual(len(value["errors"]), 16)
        self.assertTrue(value["truncated"])
        self.assertEqual(value["usage_reports"], [{"event": "turn.failed", "origin": "provider_reported",
                                                  "tokens": {"input_tokens": 9, "output_tokens": 2}}])

    def test_agent_message_text_never_classifies_the_failure(self):
        value = failure_observation(events({"type": "item.completed", "item": {
            "type": "agent_message", "text": "Authentication error " + SECRET}}), b"")
        self.assertEqual(value["errors"], [])
        self.assertNotIn(SECRET, json.dumps(value))


class FailedAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, root, *, returncode=1, session_id=None, raw=None, result=b""):
        raw = raw if raw is not None else events(
            {"type": "error", "message": "stream disconnected before completion " + SECRET},
            {"type": "turn.failed", "error": {"message": "request timeout"},
             "usage": {"input_tokens": 11, "output_tokens": 3}})
        async def execute(arguments, **kwargs):
            self.assertEqual(kwargs["prompt"], b"unaltered input")
            Path(kwargs["result_path"]).write_bytes(result)
            return returncode, raw, b"Bearer " + SECRET.encode()
        adapter = CodexAdapter()
        adapter._capabilities = (["codex"], "isolated-fixture")
        directory = Path(root).resolve() / "invocation"
        with patch("core.client.ai.codex._execute", execute):
            try:
                output = await adapter.run(prompt="unaltered input", schema=SCHEMA,
                                           directory=directory, session_id=session_id)
            except AIAdapterError as error:
                output = error.code
        receipt = json.loads((directory / "execution.json").read_text())
        self.assertEqual(receipt["prompt_sha256"], sha256(b"unaltered input").hexdigest())
        self.assertEqual((directory / "source-schema.json").read_bytes(), canonical_json_bytes(SCHEMA))
        self.assertEqual((directory / "result.json").read_bytes(), result)
        self.assertNotIn(SECRET, json.dumps(receipt))
        return output, receipt

    async def test_nonzero_exit_preserves_failure_receipt_and_reported_usage(self):
        with TemporaryDirectory() as root:
            output, receipt = await self.invoke(root)
        self.assertEqual(output, "ai_login_or_execution_failed")
        self.assertEqual(receipt["returncode"], 1)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["failure_observation"]["error_count"], 2)
        self.assertEqual(receipt["token_usage"]["reports"][0]["tokens"],
                         {"input_tokens": 11, "output_tokens": 3})

    async def test_zero_exit_error_event_still_rejects_output(self):
        with TemporaryDirectory() as root:
            output, receipt = await self.invoke(root, returncode=0, result=b'{"answer":"not accepted"}')
        self.assertEqual(output, "ai_execution_failed")
        self.assertEqual(receipt["failure_observation"]["error_count"], 2)
        self.assertEqual(receipt["status"], "failed")

    async def test_failure_session_usage_is_not_miscounted_as_incremental(self):
        with TemporaryDirectory() as root:
            _, receipt = await self.invoke(root, session_id=str(uuid4()))
        self.assertNotIn("token_usage", receipt)
        self.assertEqual(receipt["failure_observation"]["usage_reports"][0]["tokens"]["input_tokens"], 11)

    async def test_success_contract_and_usage_unchanged(self):
        with TemporaryDirectory() as root:
            output, receipt = await self.invoke(root, returncode=0,
                raw=events({"type": "turn.completed", "usage": {"input_tokens": 7, "output_tokens": 1}}),
                result=b'{"answer":"accepted"}')
        self.assertEqual(output["value"], {"answer": "accepted"})
        self.assertEqual(receipt["status"], "completed")
        self.assertNotIn("failure_observation", receipt)
        self.assertEqual(receipt["token_usage"]["reports"][0]["tokens"],
                         {"input_tokens": 7, "output_tokens": 1})

    async def test_timeout_without_returned_stream_preserves_timeout_and_unknown_usage(self):
        async def execute(arguments, **kwargs):
            raise TimeoutError(SECRET)
        adapter = CodexAdapter()
        adapter._capabilities = (["codex"], "isolated-fixture")
        with TemporaryDirectory() as root, patch("core.client.ai.codex._execute", execute):
            directory = Path(root).resolve() / "timeout"
            with self.assertRaises(AIAdapterError) as caught:
                await adapter.run(prompt="unaltered", schema=SCHEMA, directory=directory)
            receipt = json.loads((directory / "execution.json").read_text())
        self.assertEqual(caught.exception.code, "ai_timeout")
        self.assertEqual(receipt["error_code"], "ai_timeout")
        self.assertNotIn("failure_observation", receipt)
        self.assertNotIn("token_usage", receipt)
        self.assertNotIn(SECRET, json.dumps(receipt))


if __name__ == "__main__":
    unittest.main()
