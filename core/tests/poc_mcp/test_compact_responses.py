"""Opt-in response views over real isolated HTTP/MCP writes; no model execution."""
from copy import deepcopy
import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.runtime.extraction_schema import build_submission_schema
from core.runtime.application import create_application
from core.mcp.response_views import project
from core.tests.poc_mcp.test_server_integration import ServerFixture
from fastapi.testclient import TestClient


class CompactReviewTransport(ServerFixture):
    def setUp(self):
        super().setUp()
        lines = [f"If ready, A{i} uses B{i} except on Sunday." for i in range(30)]
        self.write("\n".join(lines) + "\n")
        self.store = self.policy.authorize(self.token, self.tenant, "read").store
        self.reviews = ReviewStore(self.store)
        self.entities = [dict(id=f"{letter}{i}", label=f"{letter.upper()}{i}", type="system", evidence=line)
                         for i, line in enumerate(lines) for letter in ("a", "b")]
        self.qualifiers = dict(polarity="positive", modality="asserted", condition="If ready",
                               scope="except on Sunday", time=None)
        self.relations = [dict(subject=f"a{i}", predicate="uses", object=f"b{i}", evidence=line,
                               qualifiers=deepcopy(self.qualifiers)) for i, line in enumerate(lines)]
        OntologyStore(self.store).generate("example.md", self.store.read("example.md").revision,
                                            self.entities, self.relations)

    def call(self, tool, **arguments):
        return self.mcp(tool, dict(tenant=self.tenant, document="example.md", **arguments))

    def decide(self, action, **arguments):
        state = self.call("ontology_review_query")
        return self.call("ontology_review", action=action, claim_id=state["claims"][0]["claim_id"],
                         expected_state_revision=state["state_revision"], reason="simulation: preserve exception", **arguments)

    def test_default_full_and_compact_are_same_saved_event_and_state(self):
        default = self.decide("accept")
        self.assertTrue(default["ok"], default)
        self.assertNotIn("response_view", default)
        self.assertIn("machine_graph", default)
        compact = self.decide("defer", response_mode="compact")
        self.assertTrue(compact["ok"], compact)
        detail = self.call("ontology_review_query")
        for key in ("source_revision", "graph_revision", "review_revision", "history_revision", "state_revision",
                    "needs_review", "pending_history", "current_pending_history", "cleanup", "access"):
            self.assertEqual(compact[key], detail[key], key)
        event = next(item for item in detail["history"] if item["id"] == compact["event_id"])
        self.assertEqual(compact["event"], event)
        self.assertEqual(compact["claim"], detail["claims"][0])
        self.assertEqual(compact["event"]["after"]["value"]["qualifiers"], self.qualifiers)
        self.assertEqual(compact["summary"]["claim_decisions"], {"defer": 1, "unreviewed": 29})
        self.assertFalse(compact["response_view"]["full_snapshot"])
        self.assertNotIn("history", compact)
        self.assertNotIn("effective_graph", compact)
        query = compact["response_view"]["detail_query"]
        self.assertEqual(self.mcp(query["tool"], query["arguments"]), detail)
        full = {**detail, "changed": True, "event_id": compact["event_id"], "cleanup_failures": []}
        self.assertEqual(project("ontology_review", full, "compact"), compact)
        full_bytes, compact_bytes = len(canonical_json_bytes(full)), len(canonical_json_bytes(compact))
        self.assertLess(compact_bytes, full_bytes // 4)
        print(f"compact-review measurement: full_json_utf8={full_bytes}, compact_json_utf8={compact_bytes}, model_calls=0")
        self.assertEqual(len(detail["machine_graph"]["relations"]), 30)
        self.assertEqual(len(detail["effective_graph"]["relations"]), 29)

    def test_review_undo_policy_and_policy_undo_keep_reasons_scope_and_qualifiers(self):
        decision = self.decide("reject", response_mode="compact")
        undo = self.call("ontology_review_undo", event_id=decision["event_id"],
                         expected_state_revision=decision["state_revision"], reason="simulation undo", response_mode="compact")
        self.assertTrue(undo["ok"], undo)
        self.assertEqual(undo["event"]["undo_of"], decision["event_id"])
        self.assertEqual(undo["claim"]["decision"], "unreviewed")
        policy = self.call("ontology_policy", claim_id=undo["claim"]["claim_id"],
            expected_state_revision=undo["state_revision"], reason="simulation policy condition",
            replacement=dict(subject="a0", predicate="uses", object="b0", qualifiers=self.qualifiers,
                             context=dict(domain=None, viewpoints=[])), response_mode="compact")
        self.assertTrue(policy["ok"], policy)
        self.assertEqual(policy["event"]["scope"], dict(domain=None, viewpoint=None))
        self.assertEqual(policy["claim"]["reviewed_value"]["qualifiers"], self.qualifiers)
        self.assertEqual(policy["policies"][0]["status"], "active")
        self.assertEqual(policy["event"]["reason"], "simulation policy condition")
        undone = self.call("ontology_policy_undo", event_id=policy["event_id"],
            expected_state_revision=policy["state_revision"], reason="simulation policy undo", response_mode="compact")
        self.assertTrue(undone["ok"], undone)
        self.assertEqual(undone["event"]["undo_of"], policy["event_id"])
        self.assertEqual(undone["policies"][0]["status"], "inactive")
        self.assertEqual(len(self.call("ontology_review_query")["history"]), 4)

    def test_errors_strict_types_tenant_and_permission_are_not_projected(self):
        state = self.call("ontology_review_query")
        arguments = dict(tenant=self.tenant, document="example.md", action="accept",
            claim_id=state["claims"][0]["claim_id"], expected_state_revision=state["state_revision"], reason="simulation")
        for mode in (None, True, 3, [], {}, "short", '"compact"'):
            invalid = self.mcp("ontology_review", {**arguments, "response_mode": mode})
            self.assertEqual(invalid["error"]["code"], "invalid_argument", invalid)
        self.assertEqual(self.call("ontology_review_query")["state_revision"], state["state_revision"])
        saved = self.mcp("ontology_review", {**arguments, "response_mode": "compact"})
        self.assertTrue(saved["ok"], saved)
        stale_full = self.mcp("ontology_review", arguments)
        stale_compact = self.mcp("ontology_review", {**arguments, "response_mode": "compact"})
        self.assertEqual(stale_full, stale_compact)
        self.assertEqual(stale_compact["error"]["code"], "conflict")
        denied = self.mcp("ontology_review", {**arguments, "tenant": "forbidden", "response_mode": "compact"})
        self.assertEqual(denied["error"]["code"], "access_denied")
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        self.assertEqual(self.mcp("ontology_review", {**arguments, "response_mode": "compact"})["error"]["code"], "access_denied")
        self.assertEqual(len(self.call("ontology_review_query")["history"]), 1)

    def test_cleanup_warning_does_not_repeat_the_write_and_detail_recovers_lost_response(self):
        original = ReviewStore._commit_locked
        commits = []
        def warn(service, document, ledger, warnings):
            result = original(service, document, ledger, warnings)
            commits.append(document)
            warnings.append(SimpleNamespace(path=service.store.data_dir / "temporary", error=OSError(5, "fixture")))
            return result
        with patch.object(ReviewStore, "_commit_locked", warn):
            compact = self.decide("accept", response_mode="compact")
        self.assertTrue(compact["ok"], compact)
        self.assertEqual(compact["cleanup_failures"], [dict(path="temporary", error_type="OSError", errno=5)])
        self.assertEqual(commits, ["example.md"])
        detail = self.call("ontology_review_query")
        self.assertEqual(len(detail["history"]), 1)
        self.assertEqual(detail["history"][0], compact["event"])
        self.assertEqual(detail["state_revision"], compact["state_revision"])

    def test_current_permission_is_checked_before_commit(self):
        original = ReviewStore._validate_all_layers
        def revoke(service, *args):
            result = original(service, *args)
            self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
            return result
        with patch.object(ReviewStore, "_validate_all_layers", revoke):
            denied = self.decide("accept", response_mode="compact")
        self.assertEqual(denied["error"]["code"], "access_denied", denied)
        self.assertEqual(self.call("ontology_review_query")["history"], [])


class CompactAnalysisTransport(ServerFixture):
    def setUp(self):
        super().setUp()
        schema = build_submission_schema()
        publish(self.base / "rules", tenant_root=self.root, ruleset_id="common", ruleset_version="v1",
                reason="isolated compact transport", schema=schema, expected_schema=schema)
        reference = dict(ruleset_id="common", ruleset_version="v1")
        policy_path = self.base / "rules-policy.json"
        policy_path.write_text(json.dumps(dict(version=1, tenants={self.tenant: dict(default=reference, allowed=[reference], revoked=[])})))
        self.rules = RulesetRegistry(self.base / "rules", policy_path, self.root, expected_schema=schema)
        self.app = create_application(self.policy, rulesets=self.rules)
        self.client = self.enterContext(TestClient(self.app, base_url="http://127.0.0.1:8766"))
        source = self.client.post(f"/api/v1/tenants/{self.tenant}/sources", headers=self.headers(), json=dict(
            request_id=uuid4().hex, title="Example", format="txt", content="A uses B.\n")).json()["data"]
        created = self.mcp("analysis_registration_create", dict(tenant=self.tenant, request_id=uuid4().hex,
            document="example.md", title="Example", source_ref={key: source[key] for key in (
                "source_id", "source_version", "source_sha256", "registration_revision")}))
        self.assertTrue(created["ok"], created)
        self.job_id = created["job_id"]
        claimed = self.call("analysis_job_claim", expected_job_revision=created["job_revision"])
        self.run_id = claimed["run_id"]

    def call(self, tool, **arguments):
        return self.mcp(tool, dict(tenant=self.tenant, job_id=self.job_id, **arguments))

    def input(self, stage):
        job = self.call("analysis_job_query")
        prepared = self.call("analysis_job_input_prepare", run_id=self.run_id,
                             expected_job_revision=job["job_revision"], stage=stage)
        self.assertTrue(prepared["ok"], prepared)
        common = dict(run_id=self.run_id, bundle_id=prepared["bundle_id"], bundle_revision=prepared["bundle_revision"])
        fixed = self.call("analysis_job_input_read", **common)
        return dict(**common, expected_job_revision=prepared["job_revision"], request_id=uuid4().hex, document="example.md"), fixed["manifest"]

    def wiki(self):
        arguments, _ = self.input("prepare_wiki")
        read_args = {key: arguments[key] for key in ("run_id", "bundle_id", "bundle_revision")}
        content = self.call("analysis_job_input_read", **read_args, component="data/registration.md")["content"]
        arguments.update(expected_revision=None, content=content)
        return arguments, self.call("analysis_job_wiki_write", **arguments, response_mode="compact")

    def test_saved_full_compact_replay_query_preserve_receipts_and_diagnostics(self):
        arguments, compact = self.wiki()
        self.assertTrue(compact["ok"], compact)
        self.assertTrue(compact["saved"])
        full = self.call("analysis_job_result_query", request_id=arguments["request_id"])
        short_query = self.call("analysis_job_result_query", request_id=arguments["request_id"], response_mode="compact")
        self.assertNotIn("response_view", full)
        for key in ("receipt", "cleanup_failures", "diagnostics", "submission_ref", "current_output", "reuse_basis"):
            self.assertEqual(short_query.get(key), full.get(key), key)
        self.assertEqual(project("analysis_job_result_query", full, "compact"), short_query)
        replay = self.call("analysis_job_wiki_write", **arguments)
        self.assertTrue(replay["ok"], replay)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["receipt"], compact["receipt"])
        self.assertEqual(replay["submission_ref"], compact["submission_ref"])
        self.assertEqual(replay["job_revision"], compact["job_revision"])
        self.assertEqual(short_query["validation_report"]["semantic"], full["validation_report"]["semantic"])
        self.assertLess(len(canonical_json_bytes(short_query)), len(canonical_json_bytes(full)))
        print(f"compact-result measurement: full_json_utf8={len(canonical_json_bytes(full))}, compact_json_utf8={len(canonical_json_bytes(short_query))}, model_calls=0")
        other = self.signup("Second owner")
        denied = self.mcp("analysis_job_result_query", dict(tenant=self.tenant, job_id=self.job_id,
            request_id=arguments["request_id"], response_mode="compact"), other["token"])
        self.assertEqual(denied["error"]["code"], "not_found")

    def test_graph_submission_compact_and_rejected_detail_keep_checks(self):
        self.wiki()
        arguments, manifest = self.input("extract_ontology")
        target = manifest["dependency"]["documents"][0]
        arguments.update(expected_revision=target["source_revision"], expected_state_revision=target["state_revision"],
            submission=dict(schema_version=3, entities=[dict(id="a", type="system", label="A", evidence="A uses B.")],
                            relations=[], relation_candidates=[], attributes=[]))
        saved = self.call("analysis_job_ontology_generate", **arguments, response_mode="compact")
        self.assertTrue(saved["ok"], saved)
        full = self.call("analysis_job_result_query", request_id=arguments["request_id"])
        short = self.call("analysis_job_result_query", request_id=arguments["request_id"], response_mode="compact")
        self.assertEqual(saved["receipt"], full["receipt"])
        full_checks = full["validation_report"]["rule_results"]
        short_checks = short["validation_report"]["rule_results"]
        for original, reduced in zip(full_checks, short_checks):
            self.assertEqual(original["status"], reduced["status"])
            self.assertEqual(original["rule_id"], reduced["rule_id"])
            if original["status"] != "pass":
                self.assertEqual(original, reduced)
        bad = {**arguments, "request_id": uuid4().hex, "submission": {}}
        failed = self.call("analysis_job_ontology_generate", **bad, response_mode="compact")
        self.assertFalse(failed["ok"], failed)
        self.assertNotIn("response_view", failed)
        detail = self.call("analysis_job_result_query", request_id=bad["request_id"])
        reduced = self.call("analysis_job_result_query", request_id=bad["request_id"], response_mode="compact")
        self.assertEqual(detail["state"], reduced["state"])
        self.assertFalse(reduced["saved"])
        self.assertEqual(detail["validation_report"]["error_code"], reduced["validation_report"]["error_code"])
        for row in detail["validation_report"]["rule_results"]:
            if row["status"] != "pass":
                self.assertIn(row, reduced["validation_report"]["rule_results"])

    def test_diagnostic_findings_and_pending_receipt_are_never_shortened(self):
        # Projection-only contract fixture covers a large report without claiming
        # that these synthetic opinions came from a real model or human reviewer.
        value = dict(job_id=self.job_id, request_id=uuid4().hex, state="pending_reconcile", saved=None,
            receipt=None, cleanup_failures=[dict(path="temporary", error_type="OSError", errno=5)],
            validation_report=dict(error_code="storage_error", rule_results=[
                dict(rule_id="R-A03", status="error", reason="storage_error", checker="fixture")]),
            diagnostics=dict(report=dict(omissions=["Unrepresented exception"], unread_ranges=["page 2"],
                warnings=["Missing context"], findings=[dict(status="unsupported", quote="If ready")]), human_approval=False))
        before = deepcopy(value)
        compact = project("analysis_job_result_query", value, "compact")
        self.assertEqual(value, before)
        for field in ("state", "saved", "receipt", "cleanup_failures", "validation_report", "diagnostics"):
            self.assertEqual(compact[field], value[field])
