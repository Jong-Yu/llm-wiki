"""실제 자료 대신 임시 정책·WikiStore로 R1 첫 읽기 계약을 검사한다."""

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from core.api.limits import MAX_QUERY_BYTES
from core.modules.access.policy import AccessPolicy
from core.modules.documents.store import WikiStore, StorageBusyError
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.mcp.tenant import create_tenant_server
from core.paths import PROJECT_DIR
from core.runtime.application import create_application
from core.tests.modules.test_ontology import ontology_v3_fixture


class ReadApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-read-api-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.tenant_root = self.root / "data"
        self.tokens = {user: secrets.token_urlsafe(32) for user in ("alice", "bob")}
        profiles = {"all": {"domain": None, "viewpoint": None},
                    "business": {"domain": None, "viewpoint": "business"}}
        self.stores = {}
        for tenant in ("alpha", "beta"):
            directory = self.tenant_root / tenant
            directory.mkdir(parents=True)
            self.stores[tenant] = WikiStore(directory, lock_timeout_seconds=0)
        self.config = {"version": 1, "tenants": {tenant: {"profiles": deepcopy(profiles)}
                         for tenant in self.stores}, "users": {}}
        for user, tenant in (("alice", "alpha"), ("bob", "beta")):
            self.config["users"][user] = {"token_sha256": sha256(self.tokens[user].encode()).hexdigest(),
                "memberships": {tenant: {"permissions": ["read"], "profiles": list(profiles),
                                          "default_profile": "all"}}}
        self.config_path = self.root / "access.json"
        self.save_policy()
        self.policy = AccessPolicy(self.config_path, self.tenant_root, lock_timeout_seconds=0)
        self.app = create_application(self.policy)

    def save_policy(self):
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")

    def snapshot(self):
        return {p.relative_to(self.tenant_root).as_posix(): p.read_bytes()
                for p in self.tenant_root.rglob("*") if p.is_file()}

    def seed(self, tenant="alpha", *, graph=True):
        source, entities, relations, candidates, attributes = ontology_v3_fixture()
        store = self.stores[tenant]
        saved = store.save("Guide.md", source, expected_revision=None)
        if graph:
            OntologyStore(store).generate("Guide.md", expected_revision=saved.revision,
                entities=entities, relations=relations, relation_candidates=candidates, attributes=attributes)
        return source, saved

    def headers(self, user="alice"):
        return {"Authorization": "Bearer " + self.tokens[user]}

    @asynccontextmanager
    async def client(self, *, lifespan=True):
        async with self.app.router.lifespan_context(self.app) if lifespan else self.nothing():
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=self.app),
                    base_url="http://127.0.0.1:8766", headers=self.headers()) as client:
                yield client

    @asynccontextmanager
    async def nothing(self):
        yield

    def data(self, response, status=200):
        self.assertEqual(response.status_code, status, response.text[:1000])
        value = response.json()
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertEqual(len(value["meta"]["trace_id"]), 32)
        for token in self.tokens.values():
            self.assertNotIn(token, response.text)
        self.assertNotIn(str(self.root), response.text)
        return value["data"] if status == 200 else value["error"]

    async def test_four_endpoints_without_cli_match_mcp_and_preserve_bytes(self):
        source, saved = self.seed()
        before = self.snapshot()
        async with self.client() as http, Client(create_tenant_server(self.policy, self.tokens["alice"]),
                                                 mode="legacy") as mcp:
            access = self.data(await http.get("/api/v1/access-context"))
            self.assertEqual(access, self.policy.describe(self.tokens["alice"]))
            listing = self.data(await http.get("/api/v1/tenants/alpha/documents"))
            self.assertEqual(listing["items"], [{"document": "Guide.md", "revision": saved.revision,
                                                "source_status": "unlinked"}])
            content = self.data(await http.get("/api/v1/tenants/alpha/documents/content", params={"document": "Guide.md"}))
            original = (await mcp.call_tool("wiki_read", {"tenant": "alpha", "document": "Guide.md"})).structured_content
            self.assertEqual(content, {k: v for k, v in original.items() if k != "ok"})
            self.assertEqual(content["content"], source)
            knowledge = self.data(await http.get("/api/v1/tenants/alpha/documents/knowledge", params={"document": "Guide.md"}))
            original = (await mcp.call_tool("ontology_review_query", {"tenant": "alpha", "document": "Guide.md"})).structured_content
            self.assertEqual(knowledge, {k: v for k, v in original.items() if k != "ok"})
            self.assertTrue(knowledge["needs_review"])
            self.assertTrue(all(claim["decision"] == "unreviewed" for claim in knowledge["claims"]))
        self.assertEqual(self.snapshot(), before)

    async def test_missing_stale_corrupt_graph_and_corrupt_ledger_remain_distinct(self):
        source, saved = self.seed(graph=False)
        async with self.client() as http:
            url = "/api/v1/tenants/alpha/documents/knowledge"
            query = {"document": "Guide.md"}
            missing = self.data(await http.get(url, params=query))
            self.assertEqual(missing["status"], "missing")
            self.seed_other_graph(saved)
            store = self.stores["alpha"]
            store.save("Guide.md", source + "\n변경", expected_revision=saved.revision)
            self.assertEqual(self.data(await http.get(url, params=query))["status"], "stale")
            graph_path = OntologyStore(store)._path("Guide.md")
            graph_path.write_bytes(b"invalid")
            unavailable = self.data(await http.get(url, params=query))
            self.assertEqual(unavailable["status"], "unavailable")
            self.assertEqual(unavailable["machine_graph"]["error"], "ontology_corrupt")
            ledger_path = ReviewStore(store)._path("Guide.md")
            ledger_path.parent.mkdir(exist_ok=True)
            ledger_path.write_bytes(b"invalid")
            before = self.snapshot()
            self.assertEqual(self.data(await http.get(url, params=query), 500)["code"], "review_corrupt")
            self.assertEqual(self.snapshot(), before)

    def seed_other_graph(self, saved):
        source, entities, relations, candidates, attributes = ontology_v3_fixture()
        OntologyStore(self.stores["alpha"]).generate("Guide.md", expected_revision=saved.revision,
            entities=entities, relations=relations, relation_candidates=candidates, attributes=attributes)

    async def test_authentication_duplicate_bearer_host_origin_and_schema_are_protected(self):
        self.seed()
        async with self.client() as http:
            for path in ("/api/v1/access-context", "/openapi.json", "/docs"):
                for headers in ({"Authorization": "bad"}, {"Authorization": "Bearer short"},
                                [("Authorization", "Bearer " + self.tokens["alice"])] * 2):
                    self.data(await http.get(path, headers=headers), 401)
            response = await http.get("/api/v1/access-context", headers={"Host": "attacker.invalid"})
            self.data(response, 421)
            self.data(await http.get("/api/v1/access-context", headers={"Origin": "https://attacker.invalid"}), 403)
            response = await http.get("/openapi.json")
            self.assertEqual(response.status_code, 200)
            schema = response.json()
            read_paths = {"/api/v1/access-context", "/api/v1/tenants/{tenant}/documents",
                "/api/v1/tenants/{tenant}/documents/content", "/api/v1/tenants/{tenant}/documents/knowledge"}
            self.assertTrue(read_paths <= set(schema["paths"]))
            self.assertIn("securitySchemes", schema["components"])
            for key in read_paths:
                path = schema["paths"][key]
                self.assertEqual(set(path), {"get", "put"} if key.endswith("/content") else {"get"})
                self.assertIn("security", path["get"])

    async def test_review_policy_states_and_pending_history_match_mcp_without_loss(self):
        source, saved = self.seed()
        reviews = ReviewStore(self.stores["alpha"])
        actor = {"user_id": "alice", "tenant": "alpha", "profile_id": "business",
                 "domain": None, "viewpoint": "business", "policy_revision": "a" * 64}
        async with self.client() as http, Client(create_tenant_server(self.policy, self.tokens["alice"]), mode="legacy") as mcp:
            async def compare(profile="business"):
                query = {"document": "Guide.md", "profile": profile}
                before = self.snapshot()
                value = self.data(await http.get("/api/v1/tenants/alpha/documents/knowledge", params=query))
                original = (await mcp.call_tool("ontology_review_query", {"tenant": "alpha", **query})).structured_content
                self.assertEqual(value, {key: item for key, item in original.items() if key != "ok"})
                self.assertEqual(self.snapshot(), before)
                return value
            for decision in ("accept", "defer"):
                snapshot = reviews.query("Guide.md", viewpoint="business")
                claim = next(c for c in snapshot["claims"] if c["collection"] == "relations")
                reviews.review("Guide.md", action=decision, claim_id=claim["claim_id"],
                    expected_state_revision=snapshot["state_revision"], reason="simulation: 고정 자료 검토", actor=actor)
                value = await compare()
                self.assertEqual(next(c for c in value["claims"] if c["claim_id"] == claim["claim_id"])["decision"], decision)
            snapshot = reviews.query("Guide.md", viewpoint="business")
            claim = next(c for c in snapshot["claims"] if c["collection"] == "relations")
            replacement = {k: v for k, v in _input(claim["value"]).items() if k not in {"evidence", "provenance"}}
            replacement["context"] = {"domain": None, "viewpoints": ["business"]}
            replacement["qualifiers"]["condition"] = "simulation: 명시 조건에서만"
            changed = reviews.policy("Guide.md", claim_id=claim["claim_id"], replacement=replacement,
                expected_state_revision=snapshot["state_revision"], reason="simulation: 정책 판단", actor=actor)
            active = await compare()
            self.assertEqual(active["policies"][0]["status"], "active")
            self.assertEqual((await compare("all"))["policies"][0]["status"], "other_scope")
            reviews.policy_undo("Guide.md", event_id=changed["event_id"], expected_state_revision=active["state_revision"],
                                reason="simulation: 판단 되돌림", actor=actor)
            inactive = await compare()
            self.assertEqual(inactive["policies"][0]["status"], "inactive")
            reviews.policy("Guide.md", claim_id=claim["claim_id"], replacement=replacement,
                expected_state_revision=inactive["state_revision"], reason="simulation: 새 판단", actor=actor)
            self.stores["alpha"].save("Guide.md", source + "\n변경", expected_revision=saved.revision)
            pending = await compare()
            self.assertEqual(pending["policies"][0]["status"], "pending")
            self.assertTrue(pending["pending_history"])

    async def test_input_types_extra_fields_duplicates_methods_and_byte_limits(self):
        self.seed()
        base = "/api/v1/tenants/alpha/documents"
        async with self.client() as http:
            for query in ({"limit": "1.5"}, {"limit": "1.0"}, {"limit": "true"}, {"limit": "0"}, {"limit": "51"},
                          {"user_id": "bob"}, {"cursor": ""}, {"limit": "x"}):
                self.data(await http.get(base, params=query), 422)
            for suffix in ("/content", "/knowledge"):
                for query in ({}, {"document": "Guide.md", "actor": "bob"}, {"document": "../secret.md"}):
                    self.data(await http.get(base + suffix, params=query), 422)
            for document in ("/Guide.md", "notes//Guide.md", "./Guide.md", "Guide.txt", "notes\\Guide.md"):
                self.data(await http.get(base + "/content", params={"document": document, "profile": "business"}), 422)
            self.data(await http.get(base + "?limit=1&limit=2"), 422)
            self.data(await http.get("/api/v1/access-context?user_id=bob"), 422)
            self.data(await http.post(base + "/content", json={"document": "Guide.md"}), 405)
            self.data(await http.request("GET", base, content=b"{}"), 413)
            self.data(await http.get(base + "?x=" + "a" * MAX_QUERY_BYTES), 413)
            self.data(await http.get(base + "/absent"), 404)
            self.assertEqual((await http.get("/mcp")).status_code, 405)
            for path in ("/mcp/", "/mcp/mcp"):
                self.assertNotIn((await http.post(path, content=b"{}")).status_code, (200, 307, 308))

    async def test_cross_tenant_and_profile_denial_happens_before_store_construction(self):
        self.seed()
        async with self.client() as http:
            with patch.object(WikiStore, "__init__", side_effect=AssertionError("must not open denied storage")):
                self.data(await http.get("/api/v1/tenants/beta/documents"), 403)
                self.data(await http.get("/api/v1/tenants/alpha/documents", params={"profile": "forbidden"}), 403)
                self.data(await http.get("/api/v1/tenants/alpha/documents/content", params={"document": "Guide.md", "profile": "forbidden"}), 403)
                self.data(await http.get("/api/v1/tenants/alpha/documents/knowledge", params={"document": "Guide.md", "profile": "forbidden"}), 403)

    async def test_document_listing_uses_allowed_profile_and_binds_cursor_to_it(self):
        self.seed(graph=False)
        self.stores["alpha"].save("Other.md", "source", expected_revision=None)
        before = self.snapshot()
        url = "/api/v1/tenants/alpha/documents"
        async with self.client() as http:
            first = self.data(await http.get(url, params={"profile": "all", "limit": "1"}))
            self.assertEqual(first["access"]["profile_id"], "all")
            self.assertIsNotNone(first["next_cursor"])
            business = self.data(await http.get(url, params={"profile": "business", "limit": "1"}))
            self.assertEqual(business["access"]["profile_id"], "business")
            self.assertEqual(business["access"]["viewpoint"], "business")
            self.assertEqual(self.data(await http.get(url, params={"profile": "business", "cursor": first["next_cursor"]}), 422)["code"], "invalid_cursor")
            second = self.data(await http.get(url, params={"profile": "all", "cursor": first["next_cursor"]}))
            self.assertTrue(second["complete"])
        self.assertEqual(self.snapshot(), before)

    async def test_document_content_profile_preserves_full_bytes_and_actual_revision(self):
        store = self.stores["alpha"]
        contents = {"notes/Whitespace.md": " \r\n한글\t\n\n", "Empty.md": "",
                    "Maximum.md": "\x01" * (1024 * 1024)}
        revisions = {document: store.save(document, content, expected_revision=None).revision
                     for document, content in contents.items()}
        before = self.snapshot()
        url = "/api/v1/tenants/alpha/documents/content"
        async with self.client() as http:
            for document, content in contents.items():
                value = self.data(await http.get(url, params={"document": document, "profile": "business"}))
                self.assertEqual((value["document"], value["content"], value["revision"]),
                                 (document, content, revisions[document]))
                self.assertEqual(value["access"]["profile_id"], "business")
                self.assertEqual(value["access"]["viewpoint"], "business")
            self.assertEqual(self.data(await http.get(url, params={"document": "Missing.md", "profile": "business"}), 404)["code"], "not_found")
        self.assertEqual(self.snapshot(), before)

    async def test_current_policy_revocation_and_damage_affect_existing_http_and_mcp(self):
        self.seed()
        async with self.client() as http, Client(create_tenant_server(self.policy, self.tokens["alice"]), mode="legacy") as mcp:
            url = "/api/v1/tenants/alpha/documents/knowledge"
            query = {"document": "Guide.md", "profile": "business"}
            request = {"tenant": "alpha", **query}
            self.data(await http.get(url, params=query))
            self.config["users"]["alice"]["memberships"]["alpha"]["profiles"] = ["all"]
            self.save_policy()
            self.data(await http.get(url, params=query), 403)
            self.assertTrue((await mcp.call_tool("ontology_review_query", request)).is_error)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = []
            self.save_policy()
            self.data(await http.get("/api/v1/tenants/alpha/documents"), 403)
            self.config["users"]["alice"]["memberships"] = {}
            self.save_policy()
            self.data(await http.get("/api/v1/tenants/alpha/documents"), 403)
            self.config["users"]["alice"]["token_sha256"] = "0" * 64
            self.save_policy()
            self.data(await http.get("/api/v1/access-context"), 401)
            self.config_path.write_text("broken", encoding="utf-8")
            self.data(await http.get("/api/v1/access-context"), 503)
            self.assertTrue((await mcp.call_tool("ontology_review_query", request)).is_error)
            self.config_path.unlink()
            self.data(await http.get("/api/v1/access-context"), 503)

    async def test_concurrent_users_and_tenants_do_not_mix(self):
        self.stores["alpha"].save("Guide.md", "alice-private", expected_revision=None)
        self.stores["beta"].save("Guide.md", "bob-private", expected_revision=None)
        async with self.client() as http:
            async def call(user, tenant):
                value = self.data(await http.get(f"/api/v1/tenants/{tenant}/documents/content",
                    params={"document": "Guide.md"}, headers=self.headers(user)))
                self.assertEqual(value["content"], user + "-private")
                self.assertEqual(value["access"]["user_id"], user)
                self.assertEqual(value["access"]["tenant"], tenant)
            await asyncio.gather(*(call(user, tenant) for _ in range(8)
                                 for user, tenant in (("alice", "alpha"), ("bob", "beta"))))

    async def test_http_listing_cursor_change_scope_and_partial_results(self):
        store = self.stores["alpha"]
        for i in range(53):
            store.save(f"{i:03}.md", "source", expected_revision=None)
        url = "/api/v1/tenants/alpha/documents"
        async with self.client() as http:
            first = self.data(await http.get(url, params={"limit": "50"}))
            second = self.data(await http.get(url, params={"cursor": first["next_cursor"]}))
            self.assertEqual(len(first["items"]) + len(second["items"]), 53)
            self.assertTrue(second["complete"])
            store.save("new.md", "new", expected_revision=None)
            error = self.data(await http.get(url, params={"cursor": first["next_cursor"]}), 409)
            self.assertTrue(error["details"]["requires_refresh"])
            fresh = self.data(await http.get(url))
            self.config["users"]["alice"]["memberships"]["alpha"]["default_profile"] = "business"
            self.save_policy()
            self.data(await http.get(url, params={"cursor": fresh["next_cursor"]}), 422)
            with patch("core.modules.documents.listing.MAX_LIST_FILES", 2):
                partial = self.data(await http.get(url))
                self.assertTrue(partial["truncated"])
                self.assertFalse(partial["complete"])
                self.assertIsNone(partial["next_cursor"])

    async def test_storage_busy_not_found_read_failure_response_limit_keep_existing_bytes(self):
        self.seed()
        before = self.snapshot()
        async with self.client() as http:
            self.data(await http.get("/api/v1/tenants/alpha/documents/content", params={"document": "absent.md"}), 404)
            with patch.object(ReviewStore, "query", side_effect=StorageBusyError(0)):
                error = self.data(await http.get("/api/v1/tenants/alpha/documents/knowledge", params={"document": "Guide.md"}), 503)
                self.assertEqual((error["code"], error["retry"]), ("storage_busy", "same_basis"))
            with patch.object(WikiStore, "read", side_effect=PermissionError(str(self.root))):
                self.assertEqual(self.data(await http.get("/api/v1/tenants/alpha/documents/content", params={"document": "Guide.md"}), 500)["code"], "storage_error")
            with patch("core.api.limits.MAX_RESPONSE_BYTES", 64):
                self.assertEqual(self.data(await http.get("/api/v1/tenants/alpha/documents/knowledge", params={"document": "Guide.md"}), 500)["code"], "response_limit")
        self.assertEqual(self.snapshot(), before)

    async def test_sync_io_does_not_block_event_loop_and_lifespan_runs_once(self):
        self.seed()
        counts = []
        original = self.app.state.mcp_app.router.lifespan_context
        @asynccontextmanager
        async def counted(app):
            counts.append("start")
            async with original(app):
                yield
            counts.append("stop")
        self.app.state.mcp_app.router.lifespan_context = counted
        active = threading.Event()
        release = threading.Event()
        actual_read = WikiStore.read
        def slow_read(store, document):
            active.set()
            release.wait(2)
            return actual_read(store, document)
        async with self.client() as http:
            with patch.object(WikiStore, "read", slow_read):
                task = asyncio.create_task(http.get("/api/v1/tenants/alpha/documents/content", params={"document": "Guide.md"}))
                try:
                    for _ in range(100):
                        if active.is_set():
                            break
                        await asyncio.sleep(0.005)
                    self.assertTrue(active.is_set())
                    self.data(await asyncio.wait_for(http.get("/api/v1/access-context"), timeout=1))
                finally:
                    release.set()
                self.data(await task)
        self.assertEqual(counts, ["start", "stop"])

    async def test_actual_loopback_process_serves_general_api_and_stateless_json_mcp(self):
        self.seed()
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        process = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "core.runtime.http_cli",
            "--access-config", str(self.config_path), "--tenant-root", str(self.tenant_root), "--port", str(port),
            cwd=PROJECT_DIR, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            async with httpx2.AsyncClient(base_url=f"http://127.0.0.1:{port}", headers=self.headers(),
                    trust_env=False, timeout=10) as http:
                deadline = time.monotonic() + 10
                while True:
                    if process.returncode is not None:
                        self.fail("The isolated HTTP process exited before startup.")
                    try:
                        response = await http.get("/api/v1/access-context")
                        if response.status_code == 200:
                            break
                    except httpx2.TransportError:
                        pass
                    if time.monotonic() >= deadline:
                        self.fail("The isolated HTTP process did not start.")
                    await asyncio.sleep(0.05)
                self.data(response)
                for path in ("/documents", "/documents/content?document=Guide.md", "/documents/knowledge?document=Guide.md"):
                    self.data(await http.get("/api/v1/tenants/alpha" + path))
                async with Client(streamable_http_client(f"http://127.0.0.1:{port}/mcp", http_client=http), mode="legacy") as mcp:
                    result = await mcp.call_tool("wiki_read", {"tenant": "alpha", "document": "Guide.md"})
                    self.assertFalse(result.is_error)
                    self.assertEqual(result.structured_content["revision"], self.stores["alpha"].read("Guide.md").revision)
                response = await http.post("/mcp", headers={"Accept": "application/json, text/event-stream"}, json={
                    "jsonrpc": "2.0", "id": 7, "method": "initialize", "params": {
                        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}})
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.headers["content-type"].startswith("application/json"))
                self.assertNotIn("mcp-session-id", response.headers)
                self.assertEqual((await http.post("/mcp", content=b"x" * (8 * 1024 * 1024 + 1),
                    headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})).status_code, 413)
        finally:
            if process.returncode is None:
                process.terminate()
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
            self.assertEqual(stdout, b"")
            for token in self.tokens.values():
                self.assertNotIn(token.encode(), stderr)


if __name__ == "__main__":
    unittest.main()
