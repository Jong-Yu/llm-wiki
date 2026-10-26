"""Isolated v4 opt-in over actual stdio/HTTP; synthetic tenants only."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from mcp import Client, StdioServerParameters

import core.tests.mcp.test_tenant_mcp as tenant_helpers


SOURCE = "워크스페이스에서 육상 앱을 실행·테스트할 수 있다.\n"
DOCUMENT = "Guide.md"


def anchor(revision, quote, *, document=DOCUMENT):
    return {"kind": "source_anchor", "document": document,
            "source_revision": revision, "quote": quote,
            "start_line": 1, "end_line": 1, "occurrence": 0}


def graph_request(revision):
    return {"tenant": "acme", "document": DOCUMENT, "expected_revision": revision,
            "schema_version": 4,
            "entities": [{"id": "app", "type": "system", "label": "육상 앱", "evidence": SOURCE.strip()}],
            "relations": [{"subject": anchor(revision, "워크스페이스"), "predicate": "enables",
                           "object": anchor(revision, "실행·테스트"), "evidence": SOURCE.strip(),
                           "qualifiers": {"modality": "capability", "scope": "육상 앱"}}]}


class AnchorStdioTests(unittest.IsolatedAsyncioTestCase):
    setUp = tenant_helpers.TenantMCPTests.setUp
    save_policy = tenant_helpers.TenantMCPTests.save_policy
    payload = tenant_helpers.TenantMCPTests.payload
    snapshot = tenant_helpers.TenantMCPTests.snapshot
    write = tenant_helpers.TenantMCPTests.write
    http_server = tenant_helpers.TenantMCPTests.http_server
    http_client = tenant_helpers.TenantMCPTests.http_client

    def client(self, user="alice"):
        return Client(StdioServerParameters(
            command=sys.executable,
            args=["-B", "-m", "core.mcp_server", "--access-config", str(self.config_path),
                  "--tenant-root", str(self.tenant_root), "--token-env", "LLM_WIKI_TEST_TOKEN"],
            env={"LLM_WIKI_TEST_TOKEN": self.tokens[user]},
            cwd=Path(__file__).resolve().parents[3],
        ), mode="auto", read_timeout_seconds=10)

    async def seed(self, client):
        saved = self.payload(await self.write(client, SOURCE))
        request = graph_request(saved["revision"])
        return saved, request

    async def test_actual_stdio_optin_roundtrip_all_read_consumers_and_no_approval(self):
        async with self.client() as client:
            tools = (await client.list_tools()).tools
            tool = next(tool for tool in tools if tool.name == "ontology_generate")
            self.assertEqual(tool.input_schema["properties"]["schema_version"]["default"], 3)
            self.assertEqual(tool.input_schema["properties"]["schema_version"]["enum"], [3, 4, 5, 6])
            saved, request = await self.seed(client)
            omitted = deepcopy(request)
            del omitted["schema_version"]
            before = self.snapshot()
            self.payload(await client.call_tool("ontology_generate", omitted), code="invalid_ontology")
            self.assertEqual(self.snapshot(), before)
            self.payload(await client.call_tool("ontology_generate", request))
            generated = self.payload(await client.call_tool("ontology_query", {
                "tenant": "acme", "document": DOCUMENT, "profile": "all"}))
            self.assertEqual(generated["schema_version"], 4)
            self.assertEqual(generated["relations"][0]["subject"], request["relations"][0]["subject"])
            self.assertEqual(generated["relations"][0]["object"], request["relations"][0]["object"])
            self.assertFalse(self.payload(await client.call_tool("ontology_generate", request))["changed"])
            query = self.payload(await client.call_tool("ontology_query", {
                "tenant": "acme", "document": DOCUMENT, "profile": "all"}))
            self.assertEqual(query["relations"], generated["relations"])
            context = self.payload(await client.call_tool("ontology_context", {
                "tenant": "acme", "documents": [DOCUMENT], "profile": "all"}))
            self.assertTrue(context["complete"])
            self.assertEqual(context["documents"][0]["ontology"]["relations"], generated["relations"])
            review = self.payload(await client.call_tool("ontology_review_query", {
                "tenant": "acme", "document": DOCUMENT, "profile": "all"}))
            self.assertEqual(len(review["claims"]), 1)
            self.assertEqual(review["claims"][0]["decision"], "unreviewed")
            self.assertEqual(review["history"], [])
            self.assertEqual(review["effective_graph"]["relations"], generated["relations"])
            found = self.payload(await client.call_tool("ontology_concept_find", {
                "tenant": "acme", "text": "워크스페이스", "documents": [DOCUMENT], "limit": 100}))
            targets = [match["target_ref"] for match in found["matches"]
                       if match["target_ref"].get("kind") == "document_claim"
                       and match["target_ref"].get("selector") == "subject"]
            self.assertTrue(targets)
            detail = self.payload(await client.call_tool("ontology_concept_query", {
                "tenant": "acme", "target": targets[0], "documents": [DOCUMENT]}))
            self.assertTrue(detail["complete"])
            self.assertEqual(detail["documents"][0]["machine_graph"]["relations"], generated["relations"])
            for name in ("ontology_connections", "ontology_impact"):
                result = self.payload(await client.call_tool(name, {"tenant": "acme", "document": DOCUMENT}))
                self.assertFalse(result["truncated"])
                self.assertEqual(result["skipped"], [])
            source = self.payload(await client.call_tool("wiki_read", {"tenant": "acme", "document": DOCUMENT}))
            self.assertEqual(source["content"], SOURCE)
            self.assertEqual(source["revision"], saved["revision"])
            self.assertEqual(list(self.stores["acme"].history_dir.rglob("*.md")), [])

    async def test_actual_stdio_strict_versions_anchor_validation_and_entity_only_fields(self):
        async with self.client() as client:
            _, request = await self.seed(client)
            self.payload(await client.call_tool("ontology_generate", request))
            before = self.snapshot()
            for version in (True, "4", 4.0, 2, None):
                changed = deepcopy(request)
                changed["schema_version"] = version
                self.payload(await client.call_tool("ontology_generate", changed), code="invalid_argument")
            for changes in ({"source_revision": "a" * 64}, {"document": "other.md"},
                            {"quote": "없는 구절"}, {"start_line": 2, "end_line": 2}, {"occurrence": 1}):
                changed = deepcopy(request)
                changed["relations"][0]["subject"].update(changes)
                self.payload(await client.call_tool("ontology_generate", changed), code="invalid_ontology")
            for field in ("subject", "object"):
                changed = deepcopy(request)
                changed["relations"][0][field]["start_line"] = True
                result = await client.call_tool("ontology_generate", changed)
                self.assertTrue(result.is_error)
            candidate = {"id": "proposal", "subject": request["relations"][0]["subject"],
                         "predicate": "enables", "object": "app", "reason": "simulation", "question": "확인 필요"}
            invalid = deepcopy(request)
            invalid["relation_candidates"] = [candidate]
            self.assertTrue((await client.call_tool("ontology_generate", invalid)).is_error)
            invalid = deepcopy(request)
            invalid["attributes"] = [{"id": "a", "subject": request["relations"][0]["subject"],
                "property": "정의", "datatype": "text", "value": "육상 앱", "evidence": SOURCE.strip()}]
            self.assertTrue((await client.call_tool("ontology_generate", invalid)).is_error)
            invalid = deepcopy(request)
            invalid["relations"][0]["provenance"] = {"source_entity": request["relations"][0]["subject"]}
            self.assertTrue((await client.call_tool("ontology_generate", invalid)).is_error)
            self.assertEqual(self.snapshot(), before)

    async def test_actual_stdio_read_only_denial_conflict_stale_and_full_history(self):
        policy_before = self.config_path.read_bytes()
        async with self.client() as alice, self.client("bob") as bob:
            first, request = await self.seed(alice)
            self.payload(await alice.call_tool("ontology_generate", request))
            before = self.snapshot()
            self.payload(await bob.call_tool("ontology_generate", request), code="access_denied")
            self.payload(await self.write(bob, "denied", revision=first["revision"]), code="access_denied")
            self.assertEqual(self.snapshot(), before)
            changed = self.payload(await self.write(alice, SOURCE + "추가 근거 대기.\n", revision=first["revision"]))
            stale = self.payload(await alice.call_tool("ontology_query", {"tenant": "acme", "document": DOCUMENT}))
            self.assertEqual(stale["status"], "stale")
            for name in ("entities", "relations", "attributes", "relation_candidates"):
                self.assertEqual(stale[name], [])
            self.payload(await alice.call_tool("ontology_generate", request), code="conflict")
            request["expected_revision"] = changed["revision"]
            self.payload(await alice.call_tool("ontology_generate", request), code="invalid_ontology")
            self.assertEqual((self.stores["acme"].data_dir / changed["history_path"]).read_bytes(), SOURCE.encode())
            self.assertEqual(len([path for path in self.stores["acme"].history_dir.rglob("*.md") if path.is_file()]), 1)
        self.assertEqual(self.config_path.read_bytes(), policy_before)

    async def test_actual_http_v4_roundtrip_preserves_anchors_unreviewed_source_and_policy(self):
        policy_before = self.config_path.read_bytes()
        async with self.http_server() as url:
            async with self.http_client(url, mode="auto") as client:
                context = self.payload(await client.call_tool("access_context", {}))
                self.assertEqual(context["user_id"], "alice")
                saved, request = await self.seed(client)
                self.payload(await client.call_tool("ontology_generate", request))
                query = self.payload(await client.call_tool("ontology_query", {
                    "tenant": "acme", "document": DOCUMENT, "profile": "all"}))
                self.assertEqual(query["schema_version"], 4)
                self.assertEqual(len(query["relations"]), 1)
                for endpoint in ("subject", "object"):
                    self.assertEqual(query["relations"][0][endpoint], request["relations"][0][endpoint])
                self.assertEqual(query["relations"][0]["qualifiers"]["modality"], "capability")
                self.assertEqual(query["relations"][0]["qualifiers"]["scope"], "육상 앱")
                review = self.payload(await client.call_tool("ontology_review_query", {
                    "tenant": "acme", "document": DOCUMENT, "profile": "all"}))
                self.assertEqual(review["machine_graph"]["relations"], query["relations"])
                self.assertEqual(review["effective_graph"]["relations"], query["relations"])
                self.assertEqual(len(review["claims"]), 1)
                self.assertTrue(review["needs_review"])
                self.assertEqual(review["claims"][0]["decision"], "unreviewed")
                self.assertEqual(review["history"], [])
                source = self.payload(await client.call_tool("wiki_read", {
                    "tenant": "acme", "document": DOCUMENT}))
                self.assertEqual(source["content"], SOURCE)
                self.assertEqual(source["revision"], saved["revision"])
        self.assertEqual(self.stores["acme"].read(DOCUMENT).content.encode(), SOURCE.encode())
        self.assertEqual([path for path in self.stores["acme"].history_dir.rglob("*") if path.is_file()], [])
        self.assertEqual(self.config_path.read_bytes(), policy_before)


if __name__ == "__main__":
    unittest.main()
