"""D-038 tenant tool and real-transport regression with isolated synthetic data.

All review and expert actions below are scripted simulations, not human approval
or an independent evaluation of source meaning.
"""

import asyncio
from copy import deepcopy
import errno
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import httpx2
from mcp import Client

from core.mcp.http import MAX_HTTP_REQUEST_BYTES
from core.mcp.schemas import CORRESPONDENCE_TOOLS
from core.mcp_server import create_server
from core.tests.modules.test_correspondences import correspondence_fixture
import core.tests.mcp.test_tenant_mcp as tenant_helpers


PREFIX = "ontology_correspondence_"
REASON = "isolated scripted simulation: inspect the complete evidence and scope"
VALID_ID = "00000000000040008000000000000000"


class CorrespondenceMCPTests(unittest.IsolatedAsyncioTestCase):
    save_policy = tenant_helpers.TenantMCPTests.save_policy
    client = tenant_helpers.TenantMCPTests.client
    payload = tenant_helpers.TenantMCPTests.payload
    snapshot = tenant_helpers.TenantMCPTests.snapshot
    write = tenant_helpers.TenantMCPTests.write
    seed_graph = tenant_helpers.TenantMCPTests.seed_graph
    stdio_client = tenant_helpers.TenantMCPTests.stdio_client
    http_client = tenant_helpers.TenantMCPTests.http_client
    http_server = tenant_helpers.TenantMCPTests.http_server

    def setUp(self):
        tenant_helpers.TenantMCPTests.setUp(self)
        for user, tenant in (("alice", "acme"), ("eve", "beta")):
            self.config["users"][user]["memberships"][tenant]["permissions"].extend(
                ["ontology_review", "ontology_policy"]
            )
        self.save_policy()

    def requests(self, tenant="acme"):
        common = {"tenant": tenant, "correspondence_id": VALID_ID}
        mutation = {**common, "expected_state_revision": "a" * 64, "reason": REASON}
        return {
            "query": common,
            "prepare": {**common, "operation": "review", "change": {"action": "reject", "reason": REASON}},
            "find": {"tenant": tenant, "documents": ["a.md"]},
            "propose": {**mutation, "draft": {}},
            "review": {**mutation, "action": "reject"},
            "review_undo": {**mutation, "event_id": VALID_ID},
            "policy": {**mutation, "replacement": {}},
            "policy_undo": {**mutation, "event_id": VALID_ID},
        }

    async def call(self, client, suffix, arguments, *, code=None):
        return self.payload(await client.call_tool(PREFIX + suffix, arguments), code=code)

    async def detail(self, client, correspondence_id, **extra):
        return await self.call(client, "query", {
            "tenant": "acme", "correspondence_id": correspondence_id, **extra,
        })

    async def propose(self, client, draft, **extra):
        prepared = await self.call(client, "query", {"tenant": "acme", "draft": draft, **extra})
        request = {"tenant": "acme", "correspondence_id": prepared["correspondence_id"],
                   "draft": draft, "expected_state_revision": prepared["state_revision"],
                   "reason": REASON, **extra}
        result = await self.call(client, "propose", request)
        return result, request

    async def prepared_change(self, client, correspondence_id, operation, change, **extra):
        prepared = await self.call(client, "prepare", {
            "tenant": "acme", "correspondence_id": correspondence_id,
            "operation": operation, "change": change, **extra,
        })
        self.assertTrue(prepared["complete"])
        return {"tenant": "acme", "correspondence_id": correspondence_id, **change,
                "expected_state_revision": prepared["state_revision"], **extra}

    async def test_eight_tools_tenant_only_contract_and_read_only_annotations(self):
        async with self.client() as client:
            definitions = {tool.name: tool for tool in (await client.list_tools()).tools}
            self.assertTrue(CORRESPONDENCE_TOOLS <= definitions.keys())
            for name in CORRESPONDENCE_TOOLS:
                schema = definitions[name].input_schema
                self.assertEqual(schema["required"].count("tenant"), 1)
                self.assertIn("profile", schema["properties"])
                self.assertFalse(schema["additionalProperties"])
                for forbidden in ("actor", "user_id", "approved_by_user", "domain", "viewpoint", "permissions"):
                    self.assertNotIn(forbidden, schema["properties"])
                self.assertEqual(definitions[name].annotations.read_only_hint,
                                 name.removeprefix(PREFIX) in {"query", "prepare", "find"})
            for suffix, field in (("query", "draft"), ("propose", "draft"), ("review", "replacement"),
                                  ("policy", "replacement"), ("prepare", "change")):
                guide = definitions[PREFIX + suffix].input_schema["properties"][field]["description"]
                for required_shape in ("condition:anchor", "concept:anchor", "source_revision", "start_line",
                                       "lower_inclusive", "conditions/exceptions", "business_scope", "link_evidence",
                                       "graph_ref", "related_to", "state_revision"):
                    self.assertIn(required_shape, guide)
            repeated = {tool.name: tool.model_dump() for tool in (await client.list_tools()).tools}
            self.assertEqual(repeated, {name: tool.model_dump() for name, tool in definitions.items()})
        async with Client(create_server(self.stores["acme"]), mode="legacy") as legacy:
            names = {tool.name for tool in (await legacy.list_tools()).tools}
            self.assertTrue(CORRESPONDENCE_TOOLS.isdisjoint(names))
            self.assertEqual(len(names), 7)

    async def test_all_eight_tools_hide_other_and_missing_tenants_before_storage_access(self):
        correspondence_fixture(self.stores["beta"])
        before = self.snapshot()
        async with self.client() as client:
            with patch("core.modules.access.policy.WikiStore", side_effect=AssertionError("unauthorized store creation")):
                for suffix in self.requests():
                    with self.subTest(tool=suffix):
                        present = await self.call(client, suffix, self.requests("beta")[suffix], code="access_denied")
                        absent = await self.call(client, suffix, self.requests("absent")[suffix], code="access_denied")
                        self.assertEqual(present, absent)
                        for private in ("beta", "a.md", str(self.tenant_root)):
                            self.assertNotIn(private, json.dumps(present))
        self.assertEqual(self.snapshot(), before)

    async def test_permission_separation_and_warm_revocation(self):
        draft = correspondence_fixture(self.stores["acme"])
        async with self.client() as alice, self.client("bob") as reader, self.client("bridge") as writer:
            proposal, _ = await self.propose(alice, draft)
            correspondence_id = proposal["correspondence_id"]
            before = self.snapshot()
            for client in (reader, writer):
                await self.detail(client, correspondence_id)
                await self.call(client, "find", {"tenant": "acme", "documents": ["a.md"]})
                await self.prepared_change(client, correspondence_id, "review", {"action": "reject", "reason": REASON})
                for suffix in ("review", "review_undo", "policy", "policy_undo"):
                    await self.call(client, suffix, self.requests()[suffix], code="access_denied")
            await self.call(reader, "propose", self.requests()["propose"], code="access_denied")
            self.assertEqual(self.snapshot(), before)
            self.config["users"]["bob"]["memberships"]["acme"]["permissions"] = ["read", "ontology_review"]
            self.save_policy()
            state = await self.detail(reader, correspondence_id)
            accepted = await self.call(reader, "review", {
                "tenant": "acme", "correspondence_id": correspondence_id, "action": "accept",
                "expected_state_revision": state["state_revision"], "reason": REASON,
            })
            self.assertEqual(accepted["access"]["user_id"], "bob")
            await self.call(reader, "policy", self.requests()["policy"], code="access_denied")
            before = self.snapshot()
            self.config["users"]["bob"]["memberships"]["acme"]["permissions"] = ["read"]
            self.save_policy()
            await self.call(reader, "review", self.requests()["review"], code="access_denied")
            self.assertEqual(self.snapshot(), before)

    async def test_raw_arguments_and_forged_audit_fields_are_structured_errors(self):
        draft = correspondence_fixture(self.stores["acme"])
        async with self.client() as client:
            proposal, _ = await self.propose(client, draft)
            correspondence_id = proposal["correspondence_id"]
            base = {**self.requests()["review"], "correspondence_id": correspondence_id}
            before = self.snapshot()
            for field, values in {
                "action": [[], {}, None, True, 1],
                "decision": [[], {}, True, 1, "null"],
                "expected_state_revision": [None, True, 1, [], {}, "null", "not-a-token"],
                "reason": [None, True, [], {}, "", " "],
                "replacement": ["{}", "null", [], True],
            }.items():
                for value in values:
                    with self.subTest(field=field, value=value):
                        await self.call(client, "review", {**base, field: value}, code="invalid_argument")
            for field in ("actor", "approved_by_user", "user_id", "tenant_scope", "domain", "viewpoint", "event_hash"):
                await self.call(client, "review", {**base, field: "forged"}, code="invalid_argument")
            for value in ([], {}, None, True, "invalid"):
                await self.call(client, "prepare", {
                    **self.requests()["prepare"], "operation": value,
                }, code="invalid_argument")
            for field in ("draft", "application_context"):
                await self.call(client, "query", {"tenant": "acme", "draft": draft, field: "{}"}, code="invalid_argument")
            for value in ([], {}, True, 0, 101):
                await self.call(client, "find", {"tenant": "acme", "documents": ["a.md"], "limit": value}, code="invalid_argument")
            for value in (None, "null", "[\"a.md\"]", [1], [], ["a.md"] * 9):
                await self.call(client, "find", {"tenant": "acme", "documents": value}, code="invalid_argument")
            await self.call(client, "query", {"tenant": "acme", "draft": draft, "correspondence_id": correspondence_id}, code="invalid_argument")
            await self.call(client, "query", {"tenant": "acme"}, code="invalid_argument")
            invalid = deepcopy(draft)
            invalid["actor"] = {"user_id": "forged"}
            await self.call(client, "query", {"tenant": "acme", "draft": invalid}, code="invalid_correspondence")
            self.assertEqual(self.snapshot(), before)

    async def test_profile_and_policy_revision_are_part_of_prepared_cas(self):
        draft = correspondence_fixture(self.stores["acme"])
        async with self.client() as client:
            prepared = await self.call(client, "query", {"tenant": "acme", "draft": draft, "profile": "business"})
            request = {"tenant": "acme", "correspondence_id": prepared["correspondence_id"], "draft": draft,
                       "expected_state_revision": prepared["state_revision"], "reason": REASON}
            before = self.snapshot()
            await self.call(client, "propose", {**request, "profile": "developer"}, code="conflict")
            self.config["tenants"]["acme"]["profiles"]["business"]["domain"] = "changed-policy-domain"
            self.save_policy()
            await self.call(client, "propose", request, code="conflict")
            self.assertEqual(self.snapshot(), before)

    async def test_candidate_acceptance_and_expert_scope_are_separate(self):
        draft = correspondence_fixture(self.stores["acme"], basis="candidate")
        async with self.client() as client:
            proposal, _ = await self.propose(client, draft)
            correspondence_id = proposal["correspondence_id"]
            state = await self.detail(client, correspondence_id)
            before = self.snapshot()
            await self.call(client, "review", {
                "tenant": "acme", "correspondence_id": correspondence_id, "action": "accept",
                "expected_state_revision": state["state_revision"], "reason": REASON,
            }, code="invalid_correspondence")
            self.assertEqual(self.snapshot(), before)
            expert = deepcopy(draft)
            expert["basis"] = {"kind": "expert", "reason": REASON, "link_evidence": []}
            expert["questions"] = []
            policy = await self.prepared_change(client, correspondence_id, "policy", {"replacement": expert, "reason": REASON})
            result = await self.call(client, "policy", policy)
            current = await self.detail(client, correspondence_id)
            event = current["history"][-1]
            self.assertEqual(event["lane"], "expert")
            self.assertEqual(event["actor"], result["access"])
            self.assertEqual(event["actor"]["profile_id"], "business")
            undo = await self.prepared_change(client, correspondence_id, "policy_undo", {
                "event_id": event["id"], "reason": REASON,
            })
            await self.call(client, "policy_undo", {**undo, "profile": "developer"}, code="conflict")
            await self.call(client, "policy_undo", undo)
            final = await self.detail(client, correspondence_id)
            self.assertEqual([item["lane"] for item in final["history"]], ["source", "expert", "expert"])

    async def test_storage_failure_and_corrupt_ledger_keep_all_existing_bytes(self):
        draft = correspondence_fixture(self.stores["acme"])
        async with self.client() as client:
            proposal, _ = await self.propose(client, draft)
            correspondence_id = proposal["correspondence_id"]
            state = await self.detail(client, correspondence_id)
            before = self.snapshot()
            with patch("core.modules.correspondences.store.CorrespondenceStore._publish", side_effect=OSError(errno.ENOSPC, "injected isolated failure")):
                with self.assertLogs("core.mcp.results", level="ERROR"):
                    await self.call(client, "review", {
                        "tenant": "acme", "correspondence_id": correspondence_id, "action": "reject",
                        "expected_state_revision": state["state_revision"], "reason": REASON,
                    }, code="storage_error")
            self.assertEqual(self.snapshot(), before)
            with patch("core.modules.correspondences.contracts.MAX_CORRESPONDENCE_EVENTS", 1):
                await self.call(client, "review", {
                    "tenant": "acme", "correspondence_id": correspondence_id, "action": "reject",
                    "expected_state_revision": state["state_revision"], "reason": REASON,
                }, code="correspondence_limit")
            self.assertEqual(self.snapshot(), before)
            ledger = self.stores["acme"].data_dir / "_reviews" / "correspondences" / (correspondence_id + ".json")
            ledger.write_text("{isolated corrupt fixture", encoding="utf-8")
            before = self.snapshot()
            await self.detail_error(client, correspondence_id, "correspondence_corrupt")
            self.assertEqual(self.snapshot(), before)

    async def test_successful_cleanup_warning_is_saved_without_duplicate_publication(self):
        draft = correspondence_fixture(self.stores["acme"])
        original_unlink = os.unlink

        def fail_correspondence_staging_cleanup(path, *args, **kwargs):
            path = Path(path)
            if path.parent.name == "correspondences" and path.name.startswith(".wiki-"):
                raise PermissionError(errno.EACCES, "injected isolated cleanup warning")
            return original_unlink(path, *args, **kwargs)

        async with self.client() as client:
            prepared = await self.call(client, "query", {"tenant": "acme", "draft": draft})
            request = {"tenant": "acme", "correspondence_id": prepared["correspondence_id"], "draft": draft,
                       "expected_state_revision": prepared["state_revision"], "reason": REASON}
            with patch("core.modules.documents.store.os.unlink", side_effect=fail_correspondence_staging_cleanup):
                saved = await self.call(client, "propose", request)
            self.assertTrue(saved["changed"])
            self.assertEqual(len(saved["cleanup_failures"]), 1)
            state = await self.detail(client, saved["correspondence_id"])
            self.assertEqual(len(state["history"]), 1)
            self.assertEqual(state["history"][0]["id"], saved["event_id"])
            await self.call(client, "propose", request, code="conflict")
            for failure in saved["cleanup_failures"]:
                (self.stores["acme"].data_dir / failure["path"]).unlink()

    async def detail_error(self, client, correspondence_id, code):
        return await self.call(client, "query", {"tenant": "acme", "correspondence_id": correspondence_id}, code=code)

    async def protocol_flow(self, client):
        context = self.payload(await client.call_tool("access_context", {}))
        self.assertEqual(context["user_id"], "alice")
        definitions = {tool.name for tool in (await client.list_tools()).tools}
        self.assertTrue(CORRESPONDENCE_TOOLS <= definitions)
        draft = correspondence_fixture(self.stores["acme"])
        before = self.snapshot()
        prepared = await self.call(client, "query", {"tenant": "acme", "draft": draft})
        self.assertIsNone(prepared["correspondence_revision"])
        self.assertEqual(before, self.snapshot())
        request = {"tenant": "acme", "correspondence_id": prepared["correspondence_id"], "draft": draft,
                   "expected_state_revision": prepared["state_revision"], "reason": REASON}
        replies = await asyncio.gather(*(client.call_tool(PREFIX + "propose", request) for _ in range(2)))
        self.assertEqual(sum(not reply.is_error for reply in replies), 1)
        created = self.payload(next(reply for reply in replies if not reply.is_error))
        self.payload(next(reply for reply in replies if reply.is_error), code="conflict")
        correspondence_id = created["correspondence_id"]
        await self.call(client, "propose", request, code="conflict")
        state = await self.detail(client, correspondence_id)
        before = self.snapshot()
        for field, value in (("actor", {"user_id": "eve"}), ("expected_state_revision", "null")):
            await self.call(client, "review", {
                "tenant": "acme", "correspondence_id": correspondence_id, "action": "accept",
                "expected_state_revision": state["state_revision"], "reason": REASON, field: value,
            }, code="invalid_argument")
        self.assertEqual(before, self.snapshot())
        await self.call(client, "review", {
            "tenant": "acme", "correspondence_id": correspondence_id, "action": "accept",
            "expected_state_revision": state["state_revision"], "reason": REASON,
        })
        rejection = await self.prepared_change(client, correspondence_id, "review", {"action": "reject", "reason": REASON})
        rejected = await self.call(client, "review", rejection)
        await self.call(client, "review", {**rejection, "action": "accept"}, code="conflict")
        undo = await self.prepared_change(client, correspondence_id, "review_undo", {
            "event_id": rejected["event_id"], "reason": REASON,
        })
        restored = await self.call(client, "review_undo", undo)
        expert = deepcopy(draft)
        expert["basis"] = {"kind": "expert", "reason": REASON, "link_evidence": []}
        policy = await self.prepared_change(client, correspondence_id, "policy", {
            "replacement": expert, "reason": REASON, "supersedes_event_id": restored["event_id"],
        })
        policy_result = await self.call(client, "policy", policy)
        policy_undo = await self.prepared_change(client, correspondence_id, "policy_undo", {
            "event_id": policy_result["event_id"], "reason": REASON,
        })
        await self.call(client, "policy_undo", policy_undo)
        state = await self.detail(client, correspondence_id, application_context={"service": "catalog"})
        self.assertEqual(len(state["history"]), 6)
        self.assertEqual(state["history"][0]["actor"]["user_id"], "alice")
        found = await self.call(client, "find", {"tenant": "acme", "documents": ["d.md"], "text": "매진"})
        self.assertIn(correspondence_id, json.dumps(found["results"]))
        self.assertNotIn("state_revision", found)
        await self.propose(client, draft)
        partial = await self.call(client, "find", {"tenant": "acme", "documents": ["a.md"], "limit": 1})
        self.assertTrue(partial["truncated"])
        self.assertFalse(partial["complete"])
        definition = self.payload(await client.call_tool("wiki_read", {"tenant": "acme", "document": "d.md"}))
        changed = self.payload(await self.write(client, definition["content"] + "정의 검토 필요.\n",
                                               revision=definition["revision"], document="d.md"))
        stale = await self.detail(client, correspondence_id)
        self.assertIn("needs_review", json.dumps(stale))
        await self.call(client, "review", {
            "tenant": "acme", "correspondence_id": correspondence_id, "action": "accept",
            "expected_state_revision": state["state_revision"], "reason": REASON,
        }, code="conflict")
        self.assertEqual((self.stores["acme"].data_dir / changed["history_path"]).read_text(), definition["content"])
        source, saved, graph_request = await self.seed_graph(client)
        self.payload(await client.call_tool("ontology_connections", {"tenant": "acme", "document": "Guide.md"}))
        searched = self.payload(await client.call_tool("wiki_search", {"tenant": "acme", "query": "private-marker"}))
        self.assertTrue(searched["matches"])
        await self.write(client, source + "transport graph change\n", revision=saved["revision"])
        graph = self.payload(await client.call_tool("ontology_query", {"tenant": "acme", "document": "Guide.md"}))
        self.assertEqual(graph["status"], "stale")
        self.payload(await client.call_tool("ontology_generate", graph_request), code="conflict")
        self.assertEqual(self.stores["acme"].read("a.md").content.strip(), draft["condition"]["quote"])
        before = self.snapshot()
        self.config["users"]["alice"]["memberships"]["acme"]["permissions"].remove("ontology_review")
        self.save_policy()
        await self.call(client, "review", self.requests()["review"], code="access_denied")
        self.assertEqual(self.snapshot(), before)

    async def test_actual_stdio_eight_tools_conflicts_stale_partial_and_history(self):
        async with self.stdio_client() as client:
            await self.protocol_flow(client)

    async def test_actual_http_eight_tools_conflicts_stale_partial_and_history(self):
        async with self.http_server() as url:
            async with self.http_client(url) as client:
                await self.protocol_flow(client)
            async with self.http_client(url, "bob") as reader:
                before = self.snapshot()
                found = await self.call(reader, "find", {"tenant": "acme", "documents": ["a.md"]})
                await self.detail(reader, found["results"][0]["correspondence_id"])
                for suffix in ("propose", "review", "review_undo", "policy", "policy_undo"):
                    await self.call(reader, suffix, self.requests()[suffix], code="access_denied")
                for suffix in self.requests():
                    present = await self.call(reader, suffix, self.requests("beta")[suffix], code="access_denied")
                    absent = await self.call(reader, suffix, self.requests("absent")[suffix], code="access_denied")
                    self.assertEqual(present, absent)
                self.assertEqual(self.snapshot(), before)

    async def test_actual_http_auth_host_origin_and_eight_mib_request_budget(self):
        before = self.snapshot()
        async with self.http_server() as url:
            async with httpx2.AsyncClient(timeout=10, trust_env=False) as http:
                for headers in ({}, {"Authorization": "Bearer invalid"}):
                    response = await http.post(url, headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                    self.assertEqual(response.status_code, 401)
                auth = {"Authorization": "Bearer " + self.tokens["alice"]}
                for headers, status in (({"Host": "attacker.invalid"}, 421), ({"Origin": "https://attacker.invalid"}, 403)):
                    response = await http.post(url, headers={**auth, **headers}, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                    self.assertEqual(response.status_code, status)
                response = await http.post(url, content=b" " * (MAX_HTTP_REQUEST_BYTES + 1), headers={**auth, "Content-Type": "application/json"})
                self.assertEqual(response.status_code, 413)

                async def chunks():
                    for _ in range(MAX_HTTP_REQUEST_BYTES // (1024 * 1024) + 1):
                        yield b" " * (1024 * 1024)

                response = await http.post(url, content=chunks(), headers={**auth, "Content-Type": "application/json"})
                self.assertEqual(response.status_code, 413)
                for token in self.tokens.values():
                    self.assertNotIn(token, response.text)
        self.assertEqual(self.snapshot(), before)

    async def test_actual_raw_stdio_emits_only_jsonrpc_lines(self):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-B", "-m", "core.mcp_server", "--access-config", str(self.config_path),
            "--tenant-root", str(self.tenant_root), "--token-env", "LLM_WIKI_TEST_TOKEN",
            cwd=tenant_helpers.PROJECT_DIR, env={**os.environ, "LLM_WIKI_TEST_TOKEN": self.tokens["alice"]},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=2 * 1024 * 1024,
        )
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "isolated-stdio-check", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        ]
        try:
            for request in requests:
                process.stdin.write((json.dumps(request) + "\n").encode())
                await process.stdin.drain()
                if "id" in request:
                    line = await asyncio.wait_for(process.stdout.readline(), timeout=10)
                    response = json.loads(line)
                    self.assertEqual(response["jsonrpc"], "2.0")
                    self.assertEqual(response["id"], request["id"])
                    if request["id"] == 2:
                        self.assertTrue(CORRESPONDENCE_TOOLS <= {tool["name"] for tool in response["result"]["tools"]})
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
