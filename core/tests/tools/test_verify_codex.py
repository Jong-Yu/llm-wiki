"""No-quota checks that the live CLI verifier cannot pass on a stale/self-reported answer."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from jsonschema.exceptions import ValidationError

from tools.verify_codex import (
    _expert_command, _expert_fixture, _expected_answer, _fixture_expected, _failure_details, _SETUP_WARNING,
    check_expert_transcript,
)


class ExpertCLIVerifierTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.fixture = _expert_fixture(self.root)
        self.snapshot = self.fixture["reviews"].query(
            self.fixture["document"], domain="검증 업무", viewpoint="business")
        self.expected = {"business": _expected_answer(self.snapshot, "business")}
        self.answer = {"profiles": [deepcopy(self.expected["business"])]}
        self.events = [
            {"type": "thread.started", "thread_id": "fresh-test-session"},
            self.call("wiki_search", {"tenant": "acme", "query": self.fixture["marker"]},
                      {"ok": True, "matches": [{"document": self.fixture["document"]}],
                       "truncated": False, "skipped": []}),
            self.call("ontology_review_query", {"tenant": "acme", "document": self.fixture["document"],
                                                 "profile": "business"},
                      {"ok": True, **self.snapshot, "access": {"profile_id": "business"}}),
            {"type": "turn.completed", "usage": {"output_tokens": 100}},
        ]

    @staticmethod
    def call(tool, arguments, payload):
        return {"type": "item.completed", "item": {
            "type": "mcp_tool_call", "server": "llm_wiki", "tool": tool, "arguments": arguments,
            "error": None, "result": {"structured_content": payload,
                                       "content": [{"type": "text", "text": json.dumps(payload)}]},
        }}

    def check(self, events=None, answer=None, expected=None):
        return check_expert_transcript(
            "\n".join(json.dumps(event) for event in (self.events if events is None else events)),
            self.answer if answer is None else answer, marker=self.fixture["marker"],
            expected=self.expected if expected is None else expected)

    def test_current_expert_value_and_provenance_pass(self):
        result = self.check()
        self.assertEqual(result["tools"], ["wiki_search", "ontology_review_query"])
        self.assertEqual(result["answer"]["profiles"][0]["classification"]["value"], "동물")

    def test_semantic_oracle_rejects_server_ignoring_policy_or_returning_old_amount(self):
        expected = _fixture_expected(self.fixture, "business", self.snapshot, undone=False)
        self.assertEqual(expected["amount"]["value"], self.fixture["latest_amount"])
        for failure in ("classification", "amount"):
            snapshot = deepcopy(self.snapshot)
            if failure == "classification":
                snapshot["effective_graph"] = deepcopy(snapshot["machine_graph"])
            else:
                snapshot["effective_graph"]["attributes"][0]["value"] = "20"
            with self.subTest(failure=failure), self.assertRaisesRegex(RuntimeError, "independently specified"):
                _fixture_expected(self.fixture, "business", snapshot, undone=False)

    def test_failure_diagnostics_redact_token(self):
        token = self.fixture["reader_token"]
        for stdout, stderr in ((json.dumps({"type": "error", "message": token}), ""), ("", token)):
            detail = _failure_details(subprocess.CompletedProcess([], 1, stdout, stderr), token)
            self.assertNotIn(token, detail)
            self.assertIn("<redacted>", detail)

    def test_source_answer_instead_of_latest_policy_is_rejected(self):
        self.answer["profiles"][0]["classification"] = {
            "value": "사람", "basis": "source_unreviewed", "event_id": None}
        with self.assertRaisesRegex(RuntimeError, "latest judgment"):
            self.check()

    def test_old_policy_event_or_state_token_is_rejected(self):
        for field in ("event_id", "state_revision"):
            answer = deepcopy(self.answer)
            target = answer["profiles"][0]
            if field == "event_id":
                target = target["amount"]
            target[field] = "old-version"
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.check(answer=answer)

    def test_answer_alone_without_authoritative_query_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "authoritative query"):
            self.check(events=self.events[:2] + self.events[3:])

    def test_impact_is_allowed_but_cannot_replace_current_judgment_query(self):
        impact = self.call("ontology_impact", {"tenant": "acme", "document": self.fixture["document"]},
                           {"ok": True, "complete": False, "documents": [], "candidates": []})
        events = self.events[:2] + [impact] + self.events[2:]
        self.assertIn("ontology_impact", self.check(events=events)["tools"])
        with self.assertRaisesRegex(RuntimeError, "authoritative query"):
            self.check(events=self.events[:2] + [impact] + self.events[3:])

    def test_query_before_search_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "discovery"):
            self.check(events=[self.events[0], self.events[2], self.events[1], self.events[3]])

    def test_mutation_shell_other_server_and_tenant_are_rejected(self):
        for change in ("mutation", "shell", "server", "tenant"):
            events = deepcopy(self.events)
            item = events[1]["item"]
            if change == "mutation":
                item["tool"] = "ontology_policy"
            elif change == "shell":
                item["type"] = "command_execution"
            elif change == "server":
                item["server"] = "other"
            else:
                item["arguments"]["tenant"] = "other"
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                self.check(events=events)

    def test_structured_text_disagreement_is_rejected(self):
        self.events[2]["item"]["result"]["content"][0]["text"] = '{"ok":true}'
        with self.assertRaisesRegex(RuntimeError, "results differ"):
            self.check()

    def test_stale_or_pending_result_is_rejected(self):
        for field, value in (("status", "stale"), ("pending_history", ["event"])):
            events = deepcopy(self.events)
            result = events[2]["item"]["result"]
            result["structured_content"][field] = value
            result["content"][0]["text"] = json.dumps(result["structured_content"])
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, "current knowledge"):
                self.check(events=events)

    def test_missing_or_duplicate_profile_is_rejected(self):
        with self.assertRaises((RuntimeError, ValidationError)):
            self.check(answer={"profiles": []})
        with self.assertRaises(RuntimeError):
            self.check(answer={"profiles": self.answer["profiles"] * 2})

    def test_malformed_answer_schema_is_rejected(self):
        for field in ("event_id", "basis"):
            answer = deepcopy(self.answer)
            del answer["profiles"][0]["amount"][field]
            with self.subTest(field=field), self.assertRaises(ValidationError):
                self.check(answer=answer)

    def test_only_specific_startup_notice_is_tolerated(self):
        warning = {"type": "item.completed", "item": {"type": "error", "message": _SETUP_WARNING}}
        result = self.check(events=[warning, *self.events])
        self.assertEqual(result["setup_notices"], 1)
        warning["item"]["message"] = "MCP startup failed"
        with self.assertRaises(RuntimeError):
            self.check(events=[warning, *self.events])

    def test_failure_and_incomplete_turn_are_rejected(self):
        for events in (self.events[:-1], [*self.events, {"type": "turn.failed"}]):
            with self.assertRaises(RuntimeError):
                self.check(events=events)

    def test_fresh_prompt_contains_no_answer_document_or_credential(self):
        command, _ = _expert_command("codex", self.root, self.fixture, ["business"], 1)
        # A random marker can coincidentally contain the generated four digits.
        prompt = command[-1].replace(self.fixture["marker"], "<marker>")
        for forbidden in (self.fixture["document"], self.fixture["reader_token"], "동물",
                          self.expected["business"]["amount"]["value"],
                          self.expected["business"]["amount"]["event_id"]):
            self.assertNotIn(forbidden, prompt)
        self.assertNotIn(self.fixture["reader_token"], " ".join(command))
        self.assertIn("--ignore-user-config", command)
        self.assertIn("--ephemeral", command)

    def test_undo_and_other_profile_keep_exact_authority(self):
        self.fixture["reviews"].policy_undo(
            self.fixture["document"], event_id=self.fixture["classification_event"],
            expected_state_revision=self.snapshot["state_revision"],
            reason="simulation undo", actor=self.fixture["actor"])
        expected, events = {}, self.events[:2]
        for profile in ("business", "developer"):
            snapshot = self.fixture["reviews"].query(self.fixture["document"], domain="검증 업무", viewpoint=profile)
            expected[profile] = _expected_answer(snapshot, profile)
            events.append(self.call("ontology_review_query", {
                "tenant": "acme", "document": self.fixture["document"], "profile": profile},
                {"ok": True, **snapshot, "access": {"profile_id": profile}}))
        events.append(self.events[-1])
        self.check(events=events, expected=expected, answer={"profiles": list(expected.values())})
        self.assertEqual(expected["business"]["classification"]["value"], "사람")
        self.assertEqual(expected["business"]["amount"]["basis"], "expert_policy")
        self.assertEqual(expected["developer"]["amount"]["value"], "20")


if __name__ == "__main__":
    unittest.main()
