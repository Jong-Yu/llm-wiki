"""실제 격리 HTTP/MCP 저장에 합성 어댑터를 연결해 수정 한도와 중단 경계를 검사한다."""

import asyncio
from contextlib import AsyncExitStack
from functools import wraps
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx2
from core.client.analysis import prepare
from core.client.ai import draft_validation, workflow
from core.client.ai.observations import reported_usage
from core.client.transport import AnalysisClientError, client_error_code
from core.common.json_codec import canonical_json_bytes
from core.modules.access.auth import initialize_auth
from core.modules.access.policy import AccessPolicy
from core.modules.analysis_results.diagnostics import empty_report
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.modules.ontology.store import OntologyStore
from core.runtime.application import create_application
from core.runtime.client_platform import private_directory, write_new
from core.runtime.extraction_schema import build_submission_schema


class DraftAdapter:
    """의미 정확도 평가용 모델이 아닌 저장 경계/원시 산출물 보존용 합성 어댑터."""
    def __init__(self, outcomes=("valid",)):
        self.outcomes, self.calls, self.values, self.prompts, self.after_call = outcomes, 0, [], [], None

    async def preflight(self):
        return {"provider": "codex", "cli_version": "synthetic-draft-test"}

    async def run(self, *, prompt, schema, output_schema, directory):
        self.calls += 1
        self.prompts.append(prompt)
        private_directory(directory, exist_ok=False)
        write_new(directory / "prompt.txt", prompt.encode())
        write_new(directory / "schema.json", canonical_json_bytes(output_schema))
        write_new(directory / "source-schema.json", canonical_json_bytes(schema))
        outcome = self.outcomes[min(self.calls - 1, len(self.outcomes) - 1)]
        if isinstance(outcome, BaseException):
            write_new(directory / "failure.json", canonical_json_bytes({"error_type": type(outcome).__name__}))
            raise outcome
        data = json.loads(prompt.split("\nFIXED_INPUT_DATA\n", 1)[1].split("\nDRAFT_REPAIR\n", 1)[0])
        source = json.loads(data["components"]["data/context.json"])["documents"][0]["source"]
        assert sha256(source["content"].encode()).hexdigest() == source["revision"]
        report = empty_report()
        if outcome == "unread":
            report["unread_ranges"] = ["대상 원문 확인 미완료"]
        evidence = "A pump moves water." if outcome == "valid" else "A pump moves oil."
        value = {"submission": {"schema_version": 3,
            "entities": [{"id": "pump", "type": "physical_object", "label": "pump", "evidence": evidence}],
            "relations": [], "relation_candidates": [], "attributes": []}, "diagnostics": report}
        execution = {"provider": "codex", "cli_version": "synthetic-draft-test",
            "prompt_sha256": sha256(prompt.encode()).hexdigest(),
            "schema_sha256": sha256(canonical_json_bytes(schema)).hexdigest(),
            "output_sha256": sha256(canonical_json_bytes(value)).hexdigest(),
            "token_usage": {"origin": "provider_reported", "reports": [
                reported_usage({"input_tokens": 10 * self.calls, "output_tokens": self.calls})]}}
        write_new(directory / "result.json", canonical_json_bytes(value))
        write_new(directory / "execution.json", canonical_json_bytes(execution))
        self.values.append(value)
        if self.after_call:
            self.after_call(self.calls)
        return {"value": value, "execution": execution}


def isolated_server(method):
    @wraps(method)
    async def run(self):
        # AnyIO의 lifespan cancel scope를 같은 asyncio task에서 열고 닫는다.
        async with AsyncExitStack() as self.stack:
            await self.setup_server()
            return await method(self)
    return run


class DraftWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def setup_server(self):
        self.root = Path(self.stack.enter_context(TemporaryDirectory())).resolve()
        (self.root / "data").mkdir()
        (self.root / "tenancy").mkdir()
        config = self.root / "tenancy/policy.json"
        config.write_text(json.dumps({"version": 1, "tenants": {}, "users": {}}))
        self.policy = AccessPolicy(config, self.root / "data")
        auth = initialize_auth(self.policy)
        self.user = auth.signup("수정 검증 사용자")
        self.tenant = self.user["default_tenant"]
        schema = build_submission_schema()
        publish(self.root / "rules", tenant_root=self.root / "data", ruleset_id="common", ruleset_version="v1",
                reason="isolated draft workflow contract", schema=schema, expected_schema=schema)
        ref = {"ruleset_id": "common", "ruleset_version": "v1"}
        rule_policy = self.root / "rules-policy.json"
        self.rule_policy = rule_policy
        rule_policy.write_text(json.dumps({"version": 1, "tenants": {self.tenant:
            {"default": ref, "allowed": [ref], "revoked": []}}}))
        rules = RulesetRegistry(self.root / "rules", rule_policy, self.root / "data", expected_schema=schema)
        app = create_application(self.policy, auth=auth, rulesets=rules)
        await self.stack.enter_async_context(app.router.lifespan_context(app))
        original_client = httpx2.AsyncClient
        transport = httpx2.ASGITransport(app=app)
        self.base = "http://127.0.0.1:8766"
        http = await self.stack.enter_async_context(original_client(transport=transport, base_url=self.base,
            headers={"Authorization": "Bearer " + self.user["token"]}))
        response = await http.post(f"/api/v1/tenants/{self.tenant}/sources", json={
            "request_id": uuid4().hex, "title": "Pump", "format": "txt", "content": "A pump moves water.\n"})
        self.assertEqual(response.status_code, 201, response.text)
        source = response.json()["data"]
        response = await http.post(f"/api/v1/tenants/{self.tenant}/analysis-jobs/registrations", json={
            "request_id": uuid4().hex, "title": "Pump", "document": "pump.md",
            "source_ref": {key: source[key] for key in ("source_id", "source_version", "source_sha256", "registration_revision")}})
        self.assertEqual(response.status_code, 201, response.text)
        self.job_id = response.json()["data"]["job_id"]
        self.stack.enter_context(patch("core.client.analysis.httpx2.AsyncClient",
            side_effect=lambda *args, **kwargs: original_client(*args, transport=transport, **kwargs)))
        self.writes, self.tool_calls, self.lose_graph_response = [], [], False
        actual_tool = workflow.tool_call

        async def observe(client, tool, arguments):
            self.tool_calls.append(tool)
            if tool in {"analysis_job_wiki_write", "analysis_job_ontology_generate"}:
                self.writes.append((tool, arguments))
            result = await actual_tool(client, tool, arguments)
            if tool == "analysis_job_ontology_generate" and arguments.get("save") and self.lose_graph_response:
                raise OSError("simulated response loss after commit")
            return result
        self.stack.enter_context(patch.object(workflow, "tool_call", side_effect=observe))

    async def execute(self, adapter, **kwargs):
        return await prepare(base_url=self.base, tenant=self.tenant, job_id=self.job_id, token=self.user["token"],
                             work_dir=self.root / "work", adapter=adapter, **kwargs)

    def graph_writes(self):
        return [args for tool, args in self.writes if tool == "analysis_job_ontology_generate"]

    def failures(self):
        return [json.loads(path.read_text()) for path in (self.root / "work").rglob("ai-failure.json")]

    def assert_no_graph(self):
        scope = self.policy.authorize(self.user["token"], self.tenant, "read")
        self.assertFalse(OntologyStore(scope.store)._path("pump.md").exists())

    @isolated_server
    async def test_valid_once_then_reuse_and_policy_change_refusal(self):
        adapter = DraftAdapter()
        result = await self.execute(adapter)
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(len(self.graph_writes()), 1)
        self.assertEqual(result["ai_execution"]["execution_configuration"]["draft_validation"]["max_repairs"], 2)
        repeated = await self.execute(adapter)
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(repeated["ai_execution"]["usage_observations"]["adapter_call_count"], 0)
        with patch.object(draft_validation, "DRAFT_REPAIR_POLICY", "changed-policy"):
            with self.assertRaises(Exception) as stopped:
                await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "analysis_execution_settings_changed")
        self.assertEqual(adapter.calls, 1)
        from core.modules.ontology import draft
        with patch.object(draft, "MAX_SOURCE_SCAN_WORK", draft.MAX_SOURCE_SCAN_WORK + 1):
            with self.assertRaises(Exception) as limit_changed:
                await self.execute(adapter)
        self.assertEqual(client_error_code(limit_changed.exception), "analysis_execution_settings_changed")
        self.assertEqual(adapter.calls, 1)

    @isolated_server
    async def test_repair_preserves_raw_attempts_counts_tokens_and_stores_final_hash(self):
        adapter = DraftAdapter(("invalid", "valid"))
        result = (await self.execute(adapter))["ai_execution"]
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(len(self.graph_writes()), 1)
        self.assertEqual(self.graph_writes()[0]["submission"], adapter.values[-1]["submission"])
        self.assertEqual(self.graph_writes()[0]["execution"]["output_sha256"],
                         sha256(canonical_json_bytes(adapter.values[-1])).hexdigest())
        self.assertEqual(result["usage_observations"]["token_usage_totals"]["tokens"],
                         {"input_tokens": 30, "output_tokens": 3})
        reports = list((self.root / "work").rglob("draft-validation.json"))
        self.assertEqual(len(reports), 2)
        self.assertEqual(sorted(json.loads(path.read_text())["passed"] for path in reports), [False, True])
        for path in reports:
            for name in ("prompt.txt", "schema.json", "source-schema.json", "result.json", "execution.json"):
                self.assertTrue((path.parent / name).is_file(), name)
        repair = adapter.prompts[1]
        self.assertTrue(repair.startswith(adapter.prompts[0]))
        self.assertIn('"previous_output"', repair)
        self.assertIn("삭제하거나 빈 그래프로 만들지 마라", repair)

    @isolated_server
    async def test_two_repairs_exhausted_preserves_wiki_receipt_and_writes_no_graph(self):
        adapter = DraftAdapter(("invalid",))
        with self.assertRaises(Exception) as stopped:
            await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "analysis_draft_repair_exhausted")
        self.assertEqual(adapter.calls, 3)
        self.assertEqual(self.graph_writes(), [])
        self.assert_no_graph()
        failure = self.failures()[0]
        self.assertEqual(len(failure["receipts"]), 1)
        self.assertTrue(failure["receipts"][0]["saved"])
        self.assertEqual(failure["usage_observations"]["adapter_call_count"], 3)
        self.assertEqual(len(list((self.root / "work").rglob("draft-validation.json"))), 3)

    @isolated_server
    async def test_adapter_failure_is_not_a_repair(self):
        adapter = DraftAdapter(("invalid", AnalysisClientError("ai_invalid_result")))
        with self.assertRaises(Exception) as stopped:
            await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "ai_invalid_result")
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(self.graph_writes(), [])
        self.assertEqual(self.failures()[0]["usage_observations"]["calls"][-1]["status"], "interrupted")

    @isolated_server
    async def test_network_failure_has_one_call_and_no_graph_write(self):
        adapter = DraftAdapter((OSError("synthetic provider connection failed"),))
        with self.assertRaises(Exception):
            await self.execute(adapter)
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.graph_writes(), [])
        self.assertEqual(self.failures()[0]["usage_observations"]["calls"][0]["status"], "interrupted")

    @isolated_server
    async def test_cancellation_stops_without_another_call_or_graph_write(self):
        adapter = DraftAdapter(("invalid", asyncio.CancelledError()))
        with self.assertRaises(asyncio.CancelledError):
            await self.execute(adapter)
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(self.graph_writes(), [])
        self.assertEqual(self.failures()[0]["error_code"], "ai_cancelled")

    @isolated_server
    async def test_unread_is_preserved_as_draft_without_repair_or_semantic_check(self):
        adapter = DraftAdapter(("unread",))
        with patch("core.client.semantic_check.run_semantic_check") as checker:
            with self.assertRaises(Exception) as stopped:
                await self.execute(adapter, semantic_check=True)
        self.assertEqual(client_error_code(stopped.exception), "analysis_input_incomplete")
        checker.assert_not_called()
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(len(self.graph_writes()), 1)
        self.assertFalse(self.graph_writes()[0]["save"])
        self.assertEqual(self.failures()[0]["receipts"][-1]["state"], "draft")
        self.assert_no_graph()

    @isolated_server
    async def test_changed_source_after_generation_stops_before_repair(self):
        adapter = DraftAdapter(("invalid", "valid"))
        def change_source(_):
            store = self.policy.authorize(self.user["token"], self.tenant, "write").store
            current = store.read("pump.md")
            store.save("pump.md", current.content + "New revision.\n", expected_revision=current.revision)
        adapter.after_call = change_source
        with self.assertRaises(Exception) as stopped:
            await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "mcp_request_failed")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.graph_writes(), [])

    @isolated_server
    async def test_revoked_rules_after_generation_stops_before_repair(self):
        adapter = DraftAdapter(("invalid", "valid"))
        def revoke(_):
            policy = json.loads(self.rule_policy.read_text())
            policy["tenants"][self.tenant]["revoked"] = [{"ruleset_id": "common", "ruleset_version": "v1"}]
            self.rule_policy.write_text(json.dumps(policy))
        adapter.after_call = revoke
        with self.assertRaises(Exception) as stopped:
            await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "mcp_request_failed")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.graph_writes(), [])

    @isolated_server
    async def test_lease_loss_after_corrective_call_stops_before_validation_or_save(self):
        adapter = DraftAdapter(("invalid", "valid"))
        original_check = workflow.LeaseKeeper.check
        def lose_lease(lease):
            if adapter.calls == 2:
                raise AnalysisClientError("analysis_lease_lost")
            original_check(lease)
        with patch.object(workflow.LeaseKeeper, "check", lose_lease):
            with self.assertRaises(Exception) as stopped:
                await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "analysis_lease_lost")
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(self.graph_writes(), [])
        self.assertEqual(len(list((self.root / "work").rglob("draft-validation.json"))), 1)

    @isolated_server
    async def test_nonrepairable_validation_failure_stops_after_one_call(self):
        adapter = DraftAdapter()
        blocked = {"passed": False, "repairable": False, "errors": [{"code": "input_limit"}],
                   "semantic_validation": "not_performed", "save_authorized": False}
        with patch.object(draft_validation, "inspect", return_value=blocked):
            with self.assertRaises(Exception) as stopped:
                await self.execute(adapter)
        self.assertEqual(client_error_code(stopped.exception), "analysis_draft_invalid")
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(self.graph_writes(), [])

    @isolated_server
    async def test_semantic_check_receives_only_final_valid_submission(self):
        adapter = DraftAdapter(("invalid", "valid"))
        with patch("core.client.semantic_check.run_semantic_check", return_value=empty_report()) as checker:
            await self.execute(adapter, semantic_check=True)
        checker.assert_awaited_once()
        self.assertEqual(checker.call_args.kwargs["submission"], adapter.values[-1]["submission"])
        self.assertEqual([args["save"] for args in self.graph_writes()], [False, True])

    @isolated_server
    async def test_lost_final_save_response_only_queries_receipt(self):
        self.lose_graph_response = True
        adapter = DraftAdapter(("invalid", "valid"))
        result = await self.execute(adapter)
        self.assertEqual(result["ai_execution"]["status"], "stored")
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(len(self.graph_writes()), 1)
        index = self.tool_calls.index("analysis_job_ontology_generate")
        self.assertEqual(self.tool_calls[index + 1], "analysis_job_result_query")
