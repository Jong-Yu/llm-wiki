"""D-040 read tools over isolated tenant clients and actual local transports.

Fixtures and expert actions are scripted simulations, not source-meaning or
human-approval evaluations. No configured server or user data is touched.
"""

import asyncio
from copy import deepcopy
import json
import os
import sys
import unittest
from unittest.mock import patch

import httpx2
from mcp import Client

from core.mcp.schemas import CONCEPT_TOOLS
from core.mcp_server import create_server
from core.tests.modules.test_context import context_fixture
import core.tests.mcp.test_review_mcp as review_helpers
import core.tests.mcp.test_tenant_mcp as tenant_helpers


EXPERT_TERM = "전문가 정책 분류"


class ConceptMCPTests(unittest.IsolatedAsyncioTestCase):
    save_policy = tenant_helpers.TenantMCPTests.save_policy
    client = tenant_helpers.TenantMCPTests.client
    payload = tenant_helpers.TenantMCPTests.payload
    snapshot = tenant_helpers.TenantMCPTests.snapshot
    write = tenant_helpers.TenantMCPTests.write
    stdio_client = tenant_helpers.TenantMCPTests.stdio_client
    http_client = tenant_helpers.TenantMCPTests.http_client
    http_server = tenant_helpers.TenantMCPTests.http_server
    claim = review_helpers.ReviewMCPTests.claim
    policy_request = review_helpers.ReviewMCPTests.policy_request

    def setUp(self):
        tenant_helpers.TenantMCPTests.setUp(self)
        self.config["users"]["alice"]["memberships"]["acme"]["permissions"].append("ontology_policy")
        self.save_policy()

    async def seed(self, client):
        source, entities, relations, candidates, attributes = context_fixture()
        saved = self.payload(await self.write(client, source))
        self.payload(await client.call_tool("ontology_generate", {
            "tenant": "acme", "document": "Guide.md", "expected_revision": saved["revision"],
            "entities": entities, "relations": relations, "relation_candidates": candidates, "attributes": attributes,
        }))
        state = self.payload(await client.call_tool("ontology_review_query", {"tenant": "acme", "document": "Guide.md"}))
        policy = self.payload(await client.call_tool("ontology_policy", self.policy_request(state, new_entity=True)))
        return source, saved, policy

    async def find(self, client, text="상품", *, code=None, **arguments):
        return self.payload(await client.call_tool("ontology_concept_find", {"tenant": "acme", "text": text, **arguments}), code=code)

    async def query(self, client, target, *, code=None, **arguments):
        return self.payload(await client.call_tool("ontology_concept_query", {"tenant": "acme", "target": target, **arguments}), code=code)

    def target(self, found, *, kind=None):
        matches = [item["target_ref"] for item in found["matches"] if item.get("target_ref") is not None]
        if kind is not None:
            matches = [item for item in matches if item["kind"] == kind]
        self.assertTrue(matches)
        return deepcopy(matches[0])

    @staticmethod
    def missing_target():
        return {"kind": "anchor", "anchor": {
            "document": "missing.md", "source_revision": "a" * 64, "quote": "missing source",
            "start_line": 1, "end_line": 1,
        }, "observation": {"source_revision": "a" * 64, "history_revision": "b" * 64}}

    async def test_contract_is_tenant_read_only_and_target_schema_is_discoverable(self):
        async with self.client() as client:
            tools = {tool.name: tool for tool in (await client.list_tools()).tools}
            self.assertTrue(CONCEPT_TOOLS <= tools.keys())
            for name in CONCEPT_TOOLS:
                schema = tools[name].input_schema
                self.assertEqual(schema["required"].count("tenant"), 1)
                self.assertFalse(schema["additionalProperties"])
                self.assertIn("profile", schema["properties"])
                self.assertTrue(tools[name].annotations.read_only_hint)
                self.assertFalse(tools[name].annotations.destructive_hint)
                self.assertFalse(tools[name].annotations.open_world_hint)
                for forbidden in ("actor", "domain", "viewpoint", "user_id", "policy_revision", "expected_state_revision"):
                    self.assertNotIn(forbidden, schema["properties"])
            guide = tools["ontology_concept_query"].input_schema["properties"]["target"]["description"]
            for field in ("observation", "history_revision", "document_claim", "correspondence_endpoint", "origin_ref",
                          "selected_event_id", "selector", "snapshot", "exact_scope", "CAS"):
                self.assertIn(field, guide)
            repeated = {tool.name: tool.model_dump() for tool in (await client.list_tools()).tools}
            self.assertEqual(repeated, {name: tool.model_dump() for name, tool in tools.items()})
        async with Client(create_server(self.stores["acme"]), mode="legacy") as legacy:
            names = {tool.name for tool in (await legacy.list_tools()).tools}
            self.assertTrue(CONCEPT_TOOLS.isdisjoint(names))
            self.assertEqual(len(names), 7)

    async def test_other_and_missing_tenants_are_denied_before_store_creation(self):
        before = self.snapshot()
        async with self.client() as client:
            with patch("core.modules.access.policy.WikiStore", side_effect=AssertionError("unauthorized storage read")):
                for name, extra in (("ontology_concept_find", {"text": "private"}),
                                    ("ontology_concept_query", {"target": self.missing_target()})):
                    denied = []
                    for tenant in ("beta", "absent"):
                        denied.append(self.payload(await client.call_tool(name, {"tenant": tenant, **extra}), code="access_denied"))
                    self.assertEqual(*denied)
                    for private in ("beta", "missing.md", str(self.tenant_root)):
                        self.assertNotIn(private, json.dumps(denied))
        self.assertEqual(self.snapshot(), before)

    async def test_read_permission_profile_and_business_context_preserve_all_bytes(self):
        async with self.client() as writer, self.client("bob") as reader:
            await self.seed(writer)
            before = self.snapshot()
            business = await self.find(reader, EXPERT_TERM, profile="business", application_context={"service": "catalog"})
            developer = await self.find(reader, EXPERT_TERM, profile="developer")
            self.assertTrue(business["matches"])
            self.assertTrue(developer["matches"])
            self.assertEqual(business["access"]["profile_id"], "business")
            self.assertEqual(developer["access"]["profile_id"], "developer")
            self.assertIn("other_scope", json.dumps(developer))
            await self.query(reader, self.target(business), profile="business")
            await self.find(reader, "상품", profile="all", code="access_denied")
            self.assertEqual(self.snapshot(), before)

    async def test_raw_json_types_and_forged_fields_return_structured_invalid_arguments(self):
        async with self.client() as client:
            await self.seed(client)
            target = self.target(await self.find(client), kind="anchor")
            before = self.snapshot()
            for field, values in {
                "text": [None, 1, True, [], {}, "", " ", "x" * 201],
                "include_history": [None, 0, 1, "false", "null", [], {}],
                "documents": ["[]", "null", {}, [], [1], ["Guide.md"] * 9],
                "application_context": ["{}", "null", [], True],
                "as_of": [None, 1, [], {}, True, "2026-10-23T00:00:00"],
                "limit": [None, True, "20", [], {}, 0, 101],
            }.items():
                for value in values:
                    with self.subTest(field=field, value=value):
                        await self.find(client, **({field: value} if field == "text" else {"text": "상품", field: value}), code="invalid_argument")
            for value in (None, "{}", "null", [], True, "상품"):
                await self.query(client, value, code="invalid_argument")
            for value in ([], {}, None, True, "all"):
                await self.query(client, target, expansion=value, code="invalid_argument")
            for value in ("[]", {}, [True], ["x"], ["a" * 32] * 9):
                await self.query(client, target, correspondence_ids=value, code="invalid_argument")
            for field in ("actor", "user_id", "domain", "viewpoint", "policy_revision", "approved_by_user", "expected_state_revision"):
                await self.query(client, target, **{field: "forged"}, code="invalid_argument")
            for field, value in (("actor", {"user_id": "eve"}), ("tenant", "beta")):
                await self.query(client, {**target, field: value}, code="invalid_argument")
            nested = deepcopy(target)
            nested["observation"]["source_revision"] = "f" * 64
            await self.query(client, nested, code="invalid_argument")
            for value in (True, "1", [], None):
                nested = deepcopy(target)
                nested["anchor"]["start_line"] = value
                await self.query(client, nested, code="invalid_argument")
            for value in ([], {}, None, True):
                await self.query(client, {**target, "kind": value}, code="invalid_argument")
            self.assertEqual(self.snapshot(), before)

    async def test_warm_membership_revocation_and_policy_error_never_fall_back(self):
        async with self.client() as writer, self.client("bob") as reader:
            await self.seed(writer)
            target = self.target(await self.find(reader))
            before = self.snapshot()
            del self.config["users"]["bob"]["memberships"]["acme"]
            self.save_policy()
            await self.find(reader, code="access_denied")
            await self.query(reader, target, code="access_denied")
            self.config_path.write_text("{isolated malformed policy", encoding="utf-8")
            await self.find(writer, code="access_unavailable")
            await self.query(writer, target, code="access_unavailable")
            self.assertEqual(self.snapshot(), before)

    async def test_root_not_found_and_storage_busy_are_typed_without_writes(self):
        async with self.client() as client:
            await self.seed(client)
            target = self.target(await self.find(client))
            before = self.snapshot()
            await self.query(client, self.missing_target(), code="not_found")
            with self.stores["acme"]._write_lock():
                busy = await self.find(client, code="storage_busy")
                self.assertTrue(busy["error"]["retryable"])
                await self.query(client, target, code="storage_busy")
            self.assertEqual(self.snapshot(), before)
            await self.query(client, target)

    async def protocol_flow(self, client):
        context = self.payload(await client.call_tool("access_context", {}))
        self.assertEqual(context["user_id"], "alice")
        names = {tool.name for tool in (await client.list_tools()).tools}
        self.assertTrue(CONCEPT_TOOLS <= names)
        source, saved, policy = await self.seed(client)
        before = self.snapshot()
        source_search = self.payload(await client.call_tool("wiki_search", {"tenant": "acme", "query": EXPERT_TERM}))
        self.assertEqual(source_search["matches"], [])
        found = await self.find(client, EXPERT_TERM, documents=["Guide.md"])
        target = self.target(found, kind="entity")
        self.assertIn("origin_ref", target)
        assembled = await self.query(client, target)
        for key in ("snapshot_revision", "view_revision"):
            self.assertRegex(assembled[key], r"^[0-9a-f]{64}$")
        self.assertNotIn("expected_state_revision", assembled)
        self.assertIn("resource_manifest", assembled)
        self.assertIn("completeness", assembled)
        self.assertEqual(assembled["documents"][0]["source"]["content"], source)
        self.assertIn(EXPERT_TERM, json.dumps(assembled, ensure_ascii=False))
        self.assertIn("not_evaluated", json.dumps(assembled))
        developer = await self.query(client, target, profile="developer")
        self.assertIn("other_scope", json.dumps(developer))
        partial = await self.find(client, "상품", limit=1)
        self.assertTrue(partial["truncated"])
        self.assertFalse(partial["complete"])
        await self.query(client, {**target, "actor": "forged"}, code="invalid_argument")
        await self.find(client, include_history="false", code="invalid_argument")
        for name, arguments in (("ontology_concept_find", {"text": "private"}),
                                ("ontology_concept_query", {"target": target})):
            self.payload(await client.call_tool(name, {"tenant": "beta", **arguments}), code="access_denied")
        self.assertEqual(self.snapshot(), before)
        changed = self.payload(await self.write(client, source + "原文修改。\n", revision=saved["revision"]))
        stale = await self.query(client, target)
        self.assertIn("version_changed", json.dumps(stale))
        self.assertEqual((self.stores["acme"].data_dir / changed["history_path"]).read_bytes(), source.encode())
        self.assertNotEqual(stale["snapshot_revision"], assembled["snapshot_revision"])
        self.assertEqual(len(policy["history"]), 1)

    async def test_actual_stdio_expert_only_discovery_assembly_partial_stale_and_history(self):
        async with self.stdio_client() as client:
            await self.protocol_flow(client)

    async def test_actual_http_expert_only_discovery_assembly_and_read_permission(self):
        async with self.http_server() as url:
            async with self.http_client(url) as client:
                await self.protocol_flow(client)
            async with self.http_client(url, "bob") as reader:
                before = self.snapshot()
                found = await self.find(reader, "상품")
                await self.query(reader, self.target(found, kind="anchor"))
                self.assertEqual(self.snapshot(), before)
            async with httpx2.AsyncClient(timeout=5, trust_env=False) as http:
                response = await http.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                self.assertEqual(response.status_code, 401)

    async def test_actual_raw_stdio_stdout_contains_only_protocol_lines(self):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-B", "-m", "core.mcp_server", "--access-config", str(self.config_path),
            "--tenant-root", str(self.tenant_root), "--token-env", "LLM_WIKI_TEST_TOKEN",
            cwd=tenant_helpers.PROJECT_DIR, env={**os.environ, "LLM_WIKI_TEST_TOKEN": self.tokens["alice"]},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=2 * 1024 * 1024,
        )
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "isolated-concept-client", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
                "name": "ontology_concept_find", "arguments": {"tenant": "acme", "text": "unmatched"}}},
        ]
        try:
            for request in requests:
                process.stdin.write((json.dumps(request) + "\n").encode())
                await process.stdin.drain()
                if "id" not in request:
                    continue
                response = json.loads(await asyncio.wait_for(process.stdout.readline(), timeout=10))
                self.assertEqual(response["jsonrpc"], "2.0")
                self.assertEqual(response["id"], request["id"])
                if request["id"] == 2:
                    self.assertTrue(CONCEPT_TOOLS <= {tool["name"] for tool in response["result"]["tools"]})
                if request["id"] == 3:
                    result = response["result"]
                    self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
                    self.assertTrue(result["structuredContent"]["ok"])
            process.stdin.close()
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
            self.assertEqual(stdout, b"")
            self.assertEqual(process.returncode, 0)
            for token in self.tokens.values():
                self.assertNotIn(token.encode(), stderr)
        finally:
            if process.returncode is None:
                process.terminate()
                await process.wait()


if __name__ == "__main__":
    unittest.main()
