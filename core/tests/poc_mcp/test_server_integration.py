"""Actual API/MCP modules against isolated policies, original files and journals."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import os
import asyncio
from pathlib import Path
import selectors
import socket
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4
from unittest.mock import patch

from fastapi.testclient import TestClient

from core.api.dependencies import access_value, scope_key
from core.modules.access.policy import AccessPolicy, PolicyError
from core.modules.documents.metadata import parse_document
from core.runtime.application import create_application
from tools.initialize_server import initialize_new_server


class ServerFixture(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.enterContext(patch.dict(os.environ))
        os.environ.pop("LLM_WIKI_CREDENTIAL_KEY_FILE", None)
        self.paths = initialize_new_server(self.base / "server")
        self.config = Path(self.paths["access_config"])
        self.root = Path(self.paths["tenant_root"])
        self.policy = AccessPolicy(self.config, self.root)
        self.app = create_application(self.policy)
        self.client = self.enterContext(TestClient(self.app, base_url="http://127.0.0.1:8766"))
        self.user = self.signup("첫 사용자")
        self.token = self.user["token"]
        self.tenant = self.user["default_tenant"]

    def signup(self, name):
        response = self.client.post("/api/v1/auth/signup", json={"name": name})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        return response.json()["data"]

    def headers(self, token=None):
        return {"Authorization": "Bearer " + (token or self.token)}

    def mcp(self, name, arguments, token=None):
        response = self.client.post("/mcp", headers={**self.headers(token), "Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
        self.assertEqual(response.status_code, 200)
        result = response.json()["result"]
        payload = result["structuredContent"]
        self.assertEqual(json.loads(result["content"][0]["text"]), payload)
        self.assertEqual(result["isError"], not payload["ok"])
        return payload

    def read(self, document="example.md"):
        result = self.mcp("wiki_read", {"tenant": self.tenant, "document": document})
        self.assertTrue(result["ok"], result)
        return result

    def write(self, content, revision=None, **kwargs):
        return self.mcp("wiki_write", {"tenant": self.tenant, "document": "example.md", "content": content,
            "expected_revision": revision, **kwargs})

    def change_policy(self, operation):
        value = json.loads(self.config.read_text())
        operation(value)
        self.config.write_text(json.dumps(value, ensure_ascii=False))


class AuthenticationIntegration(ServerFixture):
    def test_same_token_user_permissions_and_access_revision_across_api_mcp(self):
        login = self.client.post("/api/v1/auth/login", json={"name": "첫 사용자"}).json()["data"]
        self.assertEqual(login, self.user)
        api = self.client.get("/api/v1/access-context", headers=self.headers()).json()["data"]
        mcp = self.mcp("access_context", {})
        self.assertEqual(api, {key: value for key, value in mcp.items() if key != "ok"})
        before = self.policy.authorize(self.token, self.tenant, "read")
        self.signup("둘째 사용자")
        after = self.policy.authorize(self.token, self.tenant, "read")
        self.assertNotEqual(before.policy_revision, after.policy_revision)
        self.assertEqual(before.access_revision, after.access_revision)
        self.assertEqual(scope_key(before), scope_key(after))
        self.assertEqual(access_value(after)["access_revision"], after.access_revision)
        self.assertNotIn(self.token, json.dumps(mcp))

    def test_exact_public_paths_host_origin_and_body_limits(self):
        for method, path in [("GET", "/api/v1/auth/login"), ("POST", "/api/v1/auth/login/"),
                             ("POST", "/api/v1/auth/%6cogin"), ("POST", "/mcp"),
                             ("GET", "/api/v1/access-context")]:
            response = self.client.request(method, path, json={"name": "첫 사용자"})
            self.assertEqual(response.status_code, 401, (method, path))
        for headers, status in [({"Host": "attacker.example"}, 421), ({"Origin": "https://attacker.example"}, 403)]:
            response = self.client.post("/api/v1/auth/login", json={"name": "첫 사용자"}, headers=headers)
            self.assertEqual(response.status_code, status)
        response = self.client.post("/api/v1/auth/login", content=b" " * 4097,
                                    headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)

    def test_revocation_applies_to_warm_api_mcp_and_missing_policy_fails_closed(self):
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        result = self.write("forbidden")
        self.assertEqual(result["error"]["code"], "access_denied")
        response = self.client.put(f"/api/v1/tenants/{self.tenant}/documents/content", headers=self.headers(),
            json={"document": "example.md", "content": "forbidden", "expected_revision": None})
        self.assertEqual(response.status_code, 403)
        self.change_policy(lambda value: value["users"][self.user["user_id"]].update(token_sha256="a" * 64))
        self.assertEqual(self.client.get("/api/v1/access-context", headers=self.headers()).status_code, 401)
        self.assertEqual(self.client.post("/mcp", headers=self.headers()).status_code, 401)
        self.config.rename(self.config.with_suffix(".preserved"))
        self.assertEqual(self.client.get("/api/v1/access-context", headers=self.headers()).status_code, 503)
        with self.assertRaises(PolicyError):
            create_application(self.policy)
        self.assertFalse(self.config.exists())

    def test_legacy_policy_boot_and_existing_token_remain_usable(self):
        legacy_token = "isolated_legacy_token_" + "x" * 32
        self.change_policy(lambda value: value["users"].update(legacy={
            "token_sha256": sha256(legacy_token.encode()).hexdigest(),
            "memberships": {self.tenant: {"permissions": ["read"], "profiles": ["default"], "default_profile": "default"}}}))
        with TestClient(create_application(self.policy), base_url="http://127.0.0.1:8766") as restarted:
            response = restarted.get("/api/v1/access-context", headers=self.headers(legacy_token))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["data"]["user_id"], "legacy")
            self.assertEqual(restarted.post("/api/v1/auth/login", json={"name": "legacy"}).status_code, 503)
        self.assertEqual(self.mcp("access_context", {}, legacy_token)["user_id"], "legacy")

    def test_new_server_init_refuses_existing_files_and_missing_root_is_not_repaired(self):
        before = {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*") if p.is_file()}
        with self.assertRaises(FileExistsError):
            initialize_new_server(self.base / "server")
        self.assertEqual(before, {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*") if p.is_file()})
        with self.assertRaises(PolicyError):
            AccessPolicy(self.config, self.base / "absent-data")
        self.assertFalse((self.base / "absent-data").exists())

    def test_legacy_plaintext_credentials_do_not_prevent_authenticated_boot(self):
        legacy = self.base / "legacy"
        legacy.mkdir(mode=0o700)
        credentials = legacy / "credentials"
        credentials.mkdir(mode=0o700)
        token_file = credentials / "user.token"
        token_file.write_text(self.token)
        token_file.chmod(0o600)
        config = legacy / "access.json"
        config.write_bytes(self.config.read_bytes())
        original_policy = config.read_bytes()
        policy = AccessPolicy(config, self.root)
        with TestClient(create_application(policy), base_url="http://127.0.0.1:8766") as client:
            self.assertEqual(client.get("/api/v1/access-context", headers=self.headers()).status_code, 200)
        key_path = legacy / "credential.key"
        original_key = key_path.read_bytes()
        self.assertEqual(key_path.stat().st_mode & 0o777, 0o600)
        with TestClient(create_application(policy), base_url="http://127.0.0.1:8766") as client:
            self.assertEqual(client.get("/api/v1/access-context", headers=self.headers()).status_code, 200)
        self.assertEqual(key_path.read_bytes(), original_key)
        self.assertEqual(config.read_bytes(), original_policy)
        self.assertEqual(token_file.read_text(), self.token)
        self.assertEqual(list(credentials.glob("*.enc")), [])

    def test_live_http_sdk_and_api_use_one_address(self):
        import httpx2
        from mcp import Client
        from mcp.client.streamable_http import streamable_http_client
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        address = f"http://127.0.0.1:{port}"
        process = subprocess.Popen([sys.executable, "-B", "-m", "core.runtime.http_cli",
            "--access-config", str(self.config), "--tenant-root", str(self.root), "--port", str(port)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 15
            with httpx2.Client(timeout=1, trust_env=False) as http:
                while True:
                    try:
                        response = http.get(address + "/api/v1/access-context", headers=self.headers())
                        self.assertEqual(response.status_code, 200)
                        api = response.json()["data"]
                        break
                    except httpx2.TransportError:
                        if process.poll() is not None or time.monotonic() > deadline:
                            self.fail("isolated HTTP server did not start")
                        time.sleep(0.05)
                self.assertEqual(http.post(address + "/mcp", json={}).status_code, 401)
            async def check_mcp():
                async with httpx2.AsyncClient(headers=self.headers(), trust_env=False, timeout=10) as http:
                    async with Client(streamable_http_client(address + "/mcp", http_client=http), mode="legacy") as client:
                        names = {tool.name for tool in (await client.list_tools()).tools}
                        self.assertIn("analysis_registration_create", names)
                        result = await client.call_tool("access_context", {})
                        return result.structured_content
            mcp = asyncio.run(check_mcp())
            self.assertEqual(api, {key: value for key, value in mcp.items() if key != "ok"})
        finally:
            process.terminate()
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(stdout, "")
            self.assertNotIn(self.token, stderr)

    def test_stdio_frames_and_startup_errors_never_expose_credentials(self):
        args = [sys.executable, "-B", "-m", "core.runtime.mcp_cli", "--access-config", str(self.config),
                "--tenant-root", str(self.root)]
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={**os.environ, "LLM_WIKI_TOKEN": self.token})
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            def exchange(value):
                process.stdin.write(json.dumps(value) + "\n"); process.stdin.flush()
                self.assertTrue(selector.select(15), "stdio response timed out")
                line = process.stdout.readline()
                self.assertNotIn(self.token, line)
                return json.loads(line)
            initialized = exchange({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "isolated-test", "version": "1"}}})
            self.assertIn("result", initialized)
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
            result = exchange({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "access_context", "arguments": {}}})
            self.assertEqual(result["result"]["structuredContent"]["user_id"], self.user["user_id"])
            process.stdin.close()
            process.wait(timeout=15)
            self.assertNotIn(self.token, process.stderr.read())
            process.stdout.close(); process.stderr.close()
        denied = subprocess.run(args, env={**os.environ, "LLM_WIKI_TOKEN": self.token + "invalid"},
                                capture_output=True, text=True, timeout=15)
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(denied.stdout, "")
        self.assertNotIn(self.token, denied.stderr)


class DocumentIntegration(ServerFixture):
    def test_metadata_full_revision_authorship_history_and_conflict(self):
        result = self.write("# Example\nA includes B.\n", origin="ai", reason="explicit AI draft")
        self.assertTrue(result["ok"], result)
        first = self.read()
        self.assertEqual(first["body"], "# Example\nA includes B.\n")
        self.assertEqual(sha256(first["content"].encode()).hexdigest(), first["revision"])
        self.assertGreater(first["body_start_line"], 1)
        self.assertEqual(first["authorship"]["created"]["origin"]["kind"], "ai")
        self.assertEqual(first["authorship"]["created"]["actor"]["user_id"], self.user["user_id"])
        api = self.client.get(f"/api/v1/tenants/{self.tenant}/documents/content", headers=self.headers(),
                             params={"document": "example.md"})
        self.assertEqual(api.status_code, 200)
        self.assertEqual(api.json()["data"], {k: v for k, v in first.items() if k != "ok"})
        second = self.write(first["content"] + "Human edit.\n", first["revision"], origin="human")
        self.assertTrue(second["ok"], second)
        self.assertEqual((self.root / self.tenant / second["history_path"]).read_text(), first["content"])
        conflict = self.write(first["content"] + "Stale edit.\n", first["revision"], origin="human")
        self.assertEqual(conflict["error"]["code"], "conflict")
        current = self.read()
        self.assertEqual(current["revision"], second["revision"])
        self.assertEqual(current["document_id"], first["document_id"])
        self.assertEqual(current["authorship"]["updated"]["origin"]["kind"], "human")
        forged = current["content"].replace(current["document_id"], "a" * 32)
        self.assertFalse(self.write(forged, current["revision"])["ok"])

    def test_concurrent_writers_keep_one_full_base_and_reject_loser(self):
        self.assertTrue(self.write("Original\n")["ok"])
        base = self.read()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda suffix: self.write(base["content"] + suffix, base["revision"]), ["A", "B"]))
        self.assertEqual(sum(value["ok"] for value in results), 1)
        self.assertEqual([value["error"]["code"] for value in results if not value["ok"]], ["conflict"])
        history = self.root / self.tenant / "_history" / "example.md"
        self.assertEqual([p.read_text() for p in history.glob("*.md")], [base["content"]])

    def test_legacy_read_does_not_rewrite_and_graph_stales_after_body_edit(self):
        store = self.policy.authorize(self.token, self.tenant, "write").store
        store._mkdir(store.wiki_dir)
        path = store.wiki_dir / "example.md"
        path.write_text("Old source.\n")
        before = path.read_bytes()
        old = self.read()
        self.assertEqual(old["body_start_line"], 1)
        self.assertEqual(old["authorship"]["status"], "unknown")
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(self.write("New body.\n", old["revision"], origin="human")["ok"])
        base = self.read()
        graph = self.mcp("ontology_generate", {"tenant": self.tenant, "document": "example.md",
            "expected_revision": base["revision"], "entities": [], "relations": []})
        self.assertTrue(graph["ok"], graph)
        self.assertEqual(self.mcp("ontology_query", {"tenant": self.tenant, "document": "example.md"})["status"], "ready")
        self.assertTrue(self.write(base["content"] + "Changed.\n", base["revision"])["ok"])
        self.assertEqual(self.mcp("ontology_query", {"tenant": self.tenant, "document": "example.md"})["status"], "stale")
        self.assertTrue((self.root / self.tenant / "_knowledge" / "graphs").is_dir())

    def test_audit_finalization_failure_is_saved_and_not_retried(self):
        with patch("core.modules.documents.changes.finish", side_effect=OSError("isolated failure")):
            result = self.write("Retain this document.\n", origin="ai")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["audit_status"], "pending_reconcile")
        current = self.read()
        self.assertEqual(current["revision"], result["revision"])
        self.assertEqual(current["authorship"]["status"], "pending_reconcile")
        self.assertEqual(list((self.root / self.tenant / "_history" / "example.md").glob("*.md")), [])

    def test_corrupt_authorship_blocks_write_without_overwriting_document(self):
        self.assertTrue(self.write("Before corruption.\n")["ok"])
        current = self.read()
        ledger = self.root / self.tenant / "_history" / "example.md" / "changes.json"
        ledger.write_text("invalid")
        failed = self.write(current["content"] + "must not save", current["revision"])
        self.assertEqual(failed["error"]["code"], "authorship_corrupt")
        self.assertEqual((self.root / self.tenant / "wiki" / "example.md").read_text(), current["content"])
        self.assertEqual(ledger.read_text(), "invalid")

    def test_graph_evidence_uses_body_and_full_file_line_coordinates(self):
        self.assertTrue(self.write("A uses B.\n")["ok"])
        current = self.read()
        args = {"tenant": self.tenant, "document": "example.md", "expected_revision": current["revision"],
            "entities": [{"id": "a", "type": "system", "label": "A", "evidence": "A uses B."},
                         {"id": "b", "type": "system", "label": "B", "evidence": "A uses B."}],
            "relations": [{"subject": "a", "predicate": "uses", "object": "b", "evidence": "A uses B."}]}
        self.assertTrue(self.mcp("ontology_generate", args)["ok"])
        graph = self.mcp("ontology_query", {"tenant": self.tenant, "document": "example.md"})
        self.assertTrue(graph["ok"], graph)
        self.assertEqual(graph["relations"][0]["evidence"]["start_line"], current["body_start_line"])
        self.assertEqual(graph["relations"][0]["evidence"]["end_line"], current["body_start_line"])


class RegistrationIntegration(ServerFixture):
    def setUp(self):
        super().setUp()
        from core.modules.extraction_rules.publish import publish
        from core.modules.extraction_rules.store import RulesetRegistry
        from core.runtime.extraction_schema import build_submission_schema
        schema = build_submission_schema()
        rules_root = self.base / "rules"
        publish(rules_root, tenant_root=self.root, ruleset_id="integration", ruleset_version="v1",
                reason="isolated transport contract test", schema=schema, expected_schema=schema)
        rules_policy = self.base / "rules.json"
        reference = {"ruleset_id": "integration", "ruleset_version": "v1"}
        rules_policy.write_text(json.dumps({"version": 1, "tenants": {self.tenant: {
            "default": reference, "allowed": [reference], "revoked": []}}}))
        self.rulesets = RulesetRegistry(rules_root, rules_policy, self.root, expected_schema=schema)
        self.client = self.enterContext(TestClient(create_application(self.policy, rulesets=self.rulesets),
                                                   base_url="http://127.0.0.1:8766"))

    def register(self):
        original = "# Preserved source\nA includes B.\n"
        response = self.client.post(f"/api/v1/tenants/{self.tenant}/sources", headers=self.headers(), json={
            "request_id": uuid4().hex, "title": "Source", "format": "txt", "content": original})
        self.assertEqual(response.status_code, 201, response.text)
        source = response.json()["data"]
        arguments = {"tenant": self.tenant, "request_id": uuid4().hex,
            "source_ref": {key: source[key] for key in ("source_id", "source_version", "source_sha256", "registration_revision")},
            "document": "registered.md", "title": "Registered"}
        job = self.mcp("analysis_registration_create", arguments)
        self.assertTrue(job["ok"], job)
        return original, source, arguments, job

    def test_registration_replay_api_and_mcp_ownership_and_strict_input(self):
        original, source, arguments, job = self.register()
        replay = self.mcp("analysis_registration_create", arguments)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["job_id"], job["job_id"])
        query = self.mcp("analysis_job_query", {"tenant": self.tenant, "job_id": job["job_id"]})
        self.assertTrue(query["ok"], query)
        self.assertEqual(query["registration"]["mode"], "preserve")
        api = self.client.get(f"/api/v1/tenants/{self.tenant}/analysis-jobs/{job['job_id']}", headers=self.headers())
        self.assertEqual(api.status_code, 200, api.text)
        self.assertEqual(api.json()["data"]["registration"], query["registration"])
        other = self.signup("다른 소유자")
        hidden = self.mcp("analysis_job_query", {"tenant": self.tenant, "job_id": job["job_id"]}, other["token"])
        self.assertFalse(hidden["ok"])
        malformed = self.mcp("analysis_registration_create", {**arguments, "source_ref": json.dumps(arguments["source_ref"])})
        self.assertEqual(malformed["error"]["code"], "invalid_argument")
        api_replay = self.client.post(f"/api/v1/tenants/{self.tenant}/analysis-jobs/registrations", headers=self.headers(),
                                      json={key: value for key, value in arguments.items() if key != "tenant"})
        self.assertEqual(api_replay.status_code, 200, api_replay.text)
        self.assertEqual(api_replay.json()["data"]["job_id"], job["job_id"])

    def test_original_to_single_markdown_and_graph_receipts_with_partial_failure(self):
        original, source, arguments, created = self.register()
        job_id = created["job_id"]
        claim = self.mcp("analysis_job_claim", {"tenant": self.tenant, "job_id": job_id,
            "expected_job_revision": created["job_revision"]})
        self.assertTrue(claim["ok"], claim)
        run_id = claim["run_id"]
        common = {"tenant": self.tenant, "job_id": job_id, "run_id": run_id}
        prepared = self.mcp("analysis_job_input_prepare", {**common, "expected_job_revision": claim["job_revision"],
            "stage": "prepare_wiki", "target_document": "registered.md"})
        self.assertTrue(prepared["ok"], prepared)
        bundle = {key: prepared[key] for key in ("bundle_id", "bundle_revision")}
        source_input = self.mcp("analysis_job_input_read", {**common, **bundle, "component": "data/registration.md"})
        self.assertTrue(source_input["ok"], source_input)
        self.assertEqual(parse_document(source_input["content"]).body, original)
        # Another account joining must not invalidate this user's frozen input.
        self.signup("작업 중 가입")
        wiki = self.mcp("analysis_job_wiki_write", {**common, **bundle, "request_id": uuid4().hex,
            "expected_job_revision": prepared["job_revision"], "document": "registered.md",
            "expected_revision": None, "content": source_input["content"]})
        self.assertTrue(wiki["ok"], wiki)
        self.assertTrue(wiki["saved"], wiki)
        saved = self.read("registered.md")
        self.assertEqual(saved["revision"], wiki["receipt"]["source_revision"])
        prepared_graph = self.mcp("analysis_job_input_prepare", {**common, "expected_job_revision": wiki["job_revision"],
            "stage": "extract_ontology", "target_document": "registered.md"})
        self.assertTrue(prepared_graph["ok"], prepared_graph)
        graph_args = {**common, **{key: prepared_graph[key] for key in ("bundle_id", "bundle_revision")},
            "expected_job_revision": prepared_graph["job_revision"], "document": "registered.md",
            "expected_revision": saved["revision"]}
        invalid = self.mcp("analysis_job_ontology_generate", {**graph_args, "request_id": uuid4().hex,
            "submission": {"schema_version": 3, "entities": [{"id": "invented"}], "relations": [],
                           "relation_candidates": [], "attributes": []}})
        self.assertFalse(invalid["ok"])
        self.assertEqual(self.read("registered.md")["revision"], saved["revision"])
        graph = self.mcp("analysis_job_ontology_generate", {**graph_args, "request_id": uuid4().hex,
            "submission": {"schema_version": 3, "entities": [], "relations": [], "relation_candidates": [], "attributes": []}})
        self.assertTrue(graph["ok"], graph)
        self.assertTrue(graph["saved"], graph)
        receipt = self.mcp("analysis_job_result_query", {"tenant": self.tenant, "job_id": job_id,
            "request_id": graph["request_id"]})
        self.assertEqual(receipt["receipt"], graph["receipt"])
        tenant_root = self.root / self.tenant
        self.assertEqual(len(list((tenant_root / "wiki").rglob("*.md"))), 1)
        self.assertEqual(len(list((tenant_root / "_sources").glob("*/catalog.json"))), 1)
        self.assertEqual(list((tenant_root / "_history" / "registered.md").glob("*.md")), [])
        job_root = tenant_root / "_personal" / self.user["user_id"] / "analysis" / job_id
        conversion = json.loads((job_root / "conversion.json").read_text())
        self.assertEqual(conversion["first_markdown"]["revision"], saved["revision"])


if __name__ == "__main__":
    unittest.main()
