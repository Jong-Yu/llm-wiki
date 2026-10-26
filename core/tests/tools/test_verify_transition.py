"""No-quota tests of the fresh transition CLI verifier and synthetic setup isolation."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from tools.verify_codex import _files_digest
from tools.verify_transition import (
    AS_OF, PREPARE_CHANGE, READ_TOOLS, transition_fixture, expected_transition,
    transition_command, check_transition_transcript,
)


class TransitionCLIVerifierTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.fixture = transition_fixture(self.root)
        self.before = _files_digest(self.fixture["tenant_root"])
        self.expected = expected_transition(self.fixture)
        self.assertEqual(self.before, _files_digest(self.fixture["tenant_root"]))
        f, e = self.fixture, self.expected
        common = {"tenant": "acme", "profile": "business"}
        context = {"application_context": {"service": "catalog"}, "as_of": AS_OF}
        review = f["reviews"].query(f["document"], domain="검증 업무", viewpoint="business")
        self.events = [
            {"type": "thread.started", "thread_id": "fresh-transition-session"},
            self.call("access_context", {}, {"user_id": "reader", "policy_revision": f["reader"]["policy_revision"]}),
            self.call("wiki_search", {**common, "query": f["marker"]}, {
                "matches": [{"document": f["document"]}, {"document": "a.md"}], "truncated": False, "skipped": []}),
            self.call("ontology_review_query", {**common, "document": f["document"]}, review),
            self.call("ontology_concept_find", {**common, "text": f["expert_term"],
                      "documents": [f["document"]], "as_of": AS_OF}, {"matches": [{"target_ref": e["target"]}]}),
            self.call("ontology_concept_query", {**common, "target": e["target"], "as_of": AS_OF}, e["queries"]["business"]),
            self.call("ontology_concept_query", {**common, "profile": "developer", "target": e["target"], "as_of": AS_OF},
                      e["queries"]["developer"], profile="developer"),
            self.call("ontology_correspondence_find", {**common, **context, "documents": ["a.md"]}, {
                "complete": True, "skipped": [], "results": [{"correspondence_id": f["correspondence_id"]}]}),
            self.call("ontology_correspondence_query", {**common, **context, "correspondence_id": f["correspondence_id"]},
                      e["correspondence"]),
            self.call("ontology_correspondence_prepare", {**common, "correspondence_id": f["correspondence_id"],
                      "operation": "review", "change": deepcopy(PREPARE_CHANGE)}, e["prepare"]),
            {"type": "turn.completed", "usage": {"output_tokens": 20}},
        ]

    def call(self, tool, args, payload, *, profile="business"):
        payload = {"ok": True, **deepcopy(payload)}
        if tool != "access_context":
            payload["access"] = {**self.fixture["reader"], "profile_id": profile, "viewpoint": profile}
        return {"type": "item.completed", "item": {
            "type": "mcp_tool_call", "server": "llm_wiki", "tool": tool,
            "arguments": deepcopy(args), "error": None,
            "result": {"structured_content": payload, "content": [{"type": "text", "text": json.dumps(payload)}]},
        }}

    def check(self, events=None):
        return check_transition_transcript("\n".join(json.dumps(e) for e in (events or self.events)),
                                           self.fixture, self.expected)

    @staticmethod
    def change_payload(event, change):
        result = event["item"]["result"]
        change(result["structured_content"])
        result["content"][0]["text"] = json.dumps(result["structured_content"])

    def test_observed_launcher_read_flow_preserves_versions_scope_and_files(self):
        result = self.check()
        self.assertEqual(result["mcp_calls"], 9)
        self.assertEqual(self.before, _files_digest(self.fixture["tenant_root"]))
        self.assertTrue(list((self.fixture["tenant_root"] / "acme/_history").rglob("*.md")))

    def test_command_uses_launcher_read_allowlist_and_no_saved_settings_or_token(self):
        command, work = transition_command("codex", self.root, self.fixture)
        joined = " ".join(command)
        self.assertIn("core.personal_launcher", joined)
        self.assertIn("--ignore-user-config", command)
        self.assertIn("--ephemeral", command)
        self.assertEqual(work.parent, self.root)
        self.assertEqual(len(READ_TOOLS), 13)
        for forbidden in (self.fixture["reader_token"], 'approval_mode="approve"', "--data-dir"):
            self.assertNotIn(forbidden, joined)
        prompt = command[-1]
        for hidden in (self.fixture["correspondence_id"], self.fixture["classification_event"],
                       self.fixture["document"], self.expected["target"]["state_revision"]):
            self.assertNotIn(hidden, prompt)

    def test_missing_identity_or_wrong_access_is_rejected(self):
        for index, field, value in ((1, "user_id", "other"), (2, "tenant", "other"),
                                    (4, "policy_revision", "0" * 64)):
            events = deepcopy(self.events)
            def change(p):
                (p if index == 1 else p["access"])[field] = value
            self.change_payload(events[index], change)
            with self.subTest(index=index), self.assertRaises(RuntimeError): self.check(events)

    def test_missing_any_required_discovery_or_query_is_rejected(self):
        for index in range(1, 10):
            events = deepcopy(self.events); del events[index]
            with self.subTest(index=index), self.assertRaises(RuntimeError): self.check(events)

    def test_supporting_source_review_is_allowed_but_cannot_replace_expert_review(self):
        extra = self.call("ontology_review_query", {"tenant": "acme", "profile": "business", "document": "a.md"}, {})
        events = self.events[:3] + [extra] + self.events[3:]
        self.assertEqual(self.check(events)["mcp_calls"], 10)
        events = self.events[:3] + [extra] + self.events[4:]
        with self.assertRaises(RuntimeError): self.check(events)

    def test_unobserved_or_mutated_target_is_rejected(self):
        events = deepcopy(self.events)
        events[5]["item"]["arguments"]["target"]["state_revision"] = "f" * 64
        with self.assertRaisesRegex(RuntimeError, "Target"): self.check(events)

    def test_changed_integration_source_event_version_scope_or_completeness_is_rejected(self):
        for field in ("snapshot_revision", "view_revision", "documents", "resource_manifest", "completeness", "scope"):
            events = deepcopy(self.events)
            self.change_payload(events[5], lambda p: p.update({field: "lost"}))
            with self.subTest(field=field), self.assertRaises(RuntimeError): self.check(events)

    def test_correspondence_old_state_and_missing_history_are_rejected(self):
        for field in ("state_revision", "correspondence_revision", "source_proposal", "history", "dependencies"):
            events = deepcopy(self.events)
            self.change_payload(events[8], lambda p: p.update({field: None}))
            with self.subTest(field=field), self.assertRaises(RuntimeError): self.check(events)

    def test_prepare_wrong_payload_or_basis_is_rejected(self):
        for side in ("argument", "response"):
            events = deepcopy(self.events)
            if side == "argument": events[9]["item"]["arguments"]["change"]["action"] = "accept"
            else: self.change_payload(events[9], lambda p: p.update(state_revision="f" * 64))
            with self.subTest(side=side), self.assertRaises(RuntimeError): self.check(events)

    def test_partial_search_is_not_promoted_to_complete(self):
        events = deepcopy(self.events)
        self.change_payload(events[7], lambda p: p.update(complete=False, skipped=[{"reason": "limit"}]))
        with self.assertRaisesRegex(RuntimeError, "Incomplete"): self.check(events)

    def test_wrong_scope_time_or_broadened_expansion_is_rejected(self):
        for index, key, value in ((5, "as_of", "2020-01-01T00:00:00Z"),
                                   (5, "expansion", "direct_confirmed"),
                                   (8, "application_context", {})):
            events = deepcopy(self.events); events[index]["item"]["arguments"][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.check(events)

    def test_mutation_wrong_server_and_shell_are_rejected(self):
        for field, value in (("tool", "wiki_write"), ("server", "other"), ("type", "command_execution")):
            events = deepcopy(self.events); events[2]["item"][field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError): self.check(events)

    def test_transport_error_and_disagreeing_representations_are_rejected(self):
        for failure in ("error", "text"):
            events = deepcopy(self.events)
            if failure == "error": events[5]["item"]["error"] = "failed"
            else: events[5]["item"]["result"]["content"][0]["text"] = "{}"
            with self.subTest(failure=failure), self.assertRaises(RuntimeError): self.check(events)

    def test_incomplete_turn_or_answer_without_tools_cannot_pass(self):
        for events in (self.events[:-1], [self.events[0], {"type": "item.completed", "item": {
                "type": "agent_message", "text": "Everything passed"}}, self.events[-1]]):
            with self.assertRaises(RuntimeError): self.check(events)


if __name__ == "__main__":
    unittest.main()
