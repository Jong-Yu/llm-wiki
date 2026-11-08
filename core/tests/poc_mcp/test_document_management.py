"""격리 tenant의 HTTP/MCP 문서 목록·전체 이력·복원 계약을 비교한다."""

import asyncio
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from core.api.dependencies import access_value
from core.mcp.server import create_server
from core.mcp.tools.document_management import DOCUMENT_MANAGEMENT_TOOLS, validate_arguments
from core.modules.documents import changes
from core.modules.documents.history import read_version
from core.modules.documents.metadata import parse_document, render_document
from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.sources.store import SourceStore
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class DocumentManagementTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.scope = self.policy.authorize(self.token, self.tenant, "write")
        self.store = self.scope.store
        self.actor = access_value(self.scope)
        self.prefix = f"/api/v1/tenants/{self.tenant}/documents"
        first = render_document("A uses B.\r\n", title="Original title", tags=["original"])
        self.first = self.store.save("example.md", first, expected_revision=None, actor=self.actor, origin="human")
        self.original = first
        self.current = first.replace("Original title", "Current title").replace("A uses B.", "A still uses B.")
        self.second = self.store.save("example.md", self.current, expected_revision=self.first.revision,
                                     actor=self.actor, origin="human")
        self.history_id = self.second.history_path.name

    def call(self, name, **fields):
        return self.mcp(name, {"tenant": self.tenant, **fields})

    def get(self, path="", **params):
        response = self.client.get(self.prefix + path, headers=self.headers(), params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["data"]

    def tree(self, root=None):
        root = root or self.store.data_dir
        return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*")
                if path.is_file() and path.relative_to(root).parts[0] != "_index"}

    def restore_payload(self, **fields):
        return {"document": "example.md", "history_id": self.history_id,
                "expected_revision": self.second.revision, **fields}

    def test_http_mcp_reads_and_restore_receipt_are_equivalent(self):
        before = self.tree()
        for name, path, params in [
            ("wiki_list", "", {}),
            ("wiki_versions", "/versions", {"document": "example.md"}),
            ("wiki_version_read", "/versions/" + self.history_id, {"document": "example.md"}),
        ]:
            args = {**params, **({"history_id": self.history_id} if name == "wiki_version_read" else {})}
            actual = self.call(name, **args)
            self.assertTrue(actual["ok"], actual)
            self.assertEqual(self.get(path, **params), {key: value for key, value in actual.items() if key != "ok"})
        self.assertEqual(before, self.tree())
        restored = self.call("wiki_restore", **self.restore_payload(reason="Restore selected version"))
        self.assertTrue(restored["ok"], restored)
        self.assertEqual(self.store.read("example.md").content, self.original)
        self.assertEqual(read_version(self.store, "example.md", restored["history_id"])["content"], self.current)
        self.assertEqual((self.store.history_dir / "example.md" / self.history_id).read_bytes(), self.original.encode())
        self.assertEqual(restored["restored_from"], self.history_id)
        self.assertEqual(restored["retry_policy"], "read_and_reconcile")
        self.assertEqual(restored["audit_status"], "recorded")
        self.assertIsNone(restored["mutation_receipt"])
        # 이미 현재인 판본의 두 전송 no-op은 같은 저장 영수증을 제공한다.
        payload = self.restore_payload(expected_revision=restored["revision"])
        http = self.client.post(self.prefix + "/restorations", headers=self.headers(), json=payload)
        self.assertEqual(http.status_code, 200, http.text)
        mcp = self.call("wiki_restore", **payload)
        self.assertFalse(mcp["changed"])
        self.assertEqual(http.json()["data"], {key: value for key, value in mcp.items() if key != "ok"})

    def test_restore_preserves_source_versions_full_metadata_and_server_identity(self):
        sources = SourceStore(self.store)

        def register(raw, **fields):
            staged = sources.stage(BytesIO(raw), kind="text", title="Original", format="txt")
            return sources.commit(staged, tenant=self.tenant, user_id=self.user["user_id"], request_id=uuid4().hex,
                                  authorize=lambda: self.actor, **fields)

        one = register(b"fixed original\r\n")
        two = register(b"new original\r\n", source_id=one["source_id"],
                       expected_registration_revision=one["registration_revision"])
        old = render_document("original body\r\n", title="Old source", tags=["old"],
                              source={"id": one["source_id"], "version": one["source_version"]})
        first = self.store.save("linked.md", old, expected_revision=None, actor=self.actor)
        new = render_document("new body\r\n", title="New source", tags=["new"],
                              document_id=parse_document(old).document_id,
                              source={"id": two["source_id"], "version": two["source_version"]})
        second = self.store.save("linked.md", new, expected_revision=first.revision, actor=self.actor)
        originals = self.tree(sources.sources_dir)
        self.assertEqual(self.get(), {key: value for key, value in self.call("wiki_list").items() if key != "ok"})
        result = self.call("wiki_restore", document="linked.md", history_id=second.history_path.name,
                           expected_revision=second.revision)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.store.read("linked.md").content, old)
        self.assertEqual(parse_document(old).document_id, parse_document(new).document_id)
        self.assertEqual(read_version(self.store, "linked.md", result["history_id"])["content"], new)
        self.assertEqual(self.tree(sources.sources_dir), originals)

    def test_legacy_restore_keeps_current_metadata_and_never_rewrites_graph_or_reviews(self):
        old = self.store.save("legacy.md", "A uses B.\r\n", expected_revision=None)
        ontology = OntologyStore(self.store)
        ontology.generate("legacy.md", old.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        reviews = ReviewStore(self.store)
        snapshot = reviews.query("legacy.md")
        reviews.review("legacy.md", action="defer", claim_id=snapshot["claims"][0]["claim_id"],
                       expected_state_revision=snapshot["state_revision"], reason="simulation", actor=self.actor)
        current = render_document("Current body\r\n", title="Current metadata", tags=["preserved"])
        saved = self.store.save("legacy.md", current, expected_revision=old.revision, actor=self.actor)
        knowledge = self.tree(self.store.data_dir / "_knowledge")
        result = self.call("wiki_restore", document="legacy.md", history_id=saved.history_path.name,
                           expected_revision=saved.revision)
        self.assertTrue(result["ok"], result)
        restored = parse_document(self.store.read("legacy.md").content)
        self.assertEqual(restored.body, "A uses B.\r\n")
        self.assertEqual(restored.metadata, parse_document(current).metadata)
        self.assertEqual(saved.history_path.read_bytes(), b"A uses B.\r\n")
        self.assertEqual(knowledge, self.tree(self.store.data_dir / "_knowledge"))

    def test_cas_conflict_and_missing_versions_preserve_files(self):
        before = self.tree()
        stale = self.restore_payload(expected_revision=self.first.revision)
        self.assertEqual(self.call("wiki_restore", **stale)["error"]["code"], "conflict")
        response = self.client.post(self.prefix + "/restorations", headers=self.headers(), json=stale)
        self.assertEqual(response.status_code, 409)
        for name in ("wiki_version_read", "wiki_restore"):
            fields = {"document": "example.md", "history_id": "missing.md"}
            if name == "wiki_restore":
                fields["expected_revision"] = self.second.revision
            self.assertEqual(self.call(name, **fields)["error"]["code"], "not_found")
        self.assertEqual(self.call("wiki_versions", document="missing.md")["error"]["code"], "not_found")
        self.assertEqual(before, self.tree())

    def test_before_commit_rechecks_permission_and_exact_scope(self):
        original = WikiStore.save
        for change in ("permission", "scope"):
            with self.subTest(change=change):
                before = self.tree()
                def revoke(store, *args, **kwargs):
                    if change == "permission":
                        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
                    else:
                        self.change_policy(lambda value: value["tenants"][self.tenant]["profiles"]["default"].update(domain="changed"))
                    return original(store, *args, **kwargs)
                with patch.object(WikiStore, "save", revoke):
                    result = self.call("wiki_restore", **self.restore_payload())
                self.assertEqual(result["error"]["code"], "access_denied")
                self.assertEqual(self.tree(), before)
                self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read", "write"]))
                self.change_policy(lambda value: value["tenants"][self.tenant]["profiles"]["default"].update(domain=None))
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        self.assertEqual(self.call("wiki_restore", **self.restore_payload())["error"]["code"], "access_denied")
        self.assertTrue(self.call("wiki_versions", document="example.md")["ok"])

    def test_pagination_cross_scope_and_changed_catalogue(self):
        self.store.save("z.md", "extra", expected_revision=None)
        third = self.store.save("example.md", self.current + "Third\n", expected_revision=self.second.revision)
        def add_profile(value):
            value["tenants"][self.tenant]["profiles"]["other"] = {"domain": None, "viewpoint": None}
            value["users"][self.user["user_id"]]["memberships"][self.tenant]["profiles"].append("other")
        self.change_policy(add_profile)
        stranger = self.signup("다른 사용자")
        for name, params in [("wiki_list", {}), ("wiki_versions", {"document": "example.md"})]:
            page = self.call(name, limit=1, **params)
            cursor = page["next_cursor"]
            self.assertIsNotNone(cursor)
            self.assertFalse(page["complete"])
            self.assertTrue(self.call(name, limit=1, cursor=cursor, **params)["ok"])
            self.assertEqual(self.call(name, limit=1, cursor=cursor, profile="other", **params)["error"]["code"], "invalid_cursor")
            other = self.mcp(name, {"tenant": self.tenant, "limit": 1, "cursor": cursor, **params}, stranger["token"])
            self.assertEqual(other["error"]["code"], "invalid_cursor")
            self.assertEqual(self.call(name, profile="forbidden", **params)["error"]["code"], "access_denied")
            self.assertEqual(self.mcp(name, {"tenant": "forbidden", **params})["error"]["code"], "access_denied")
        page = self.call("wiki_versions", document="example.md", limit=1)
        self.store.save("example.md", self.current + "Fourth\n", expected_revision=third.revision)
        self.assertEqual(self.call("wiki_versions", document="example.md", cursor=page["next_cursor"])["error"]["code"], "catalog_changed")
        page = self.call("wiki_list", limit=1)
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        self.assertEqual(self.call("wiki_list", cursor=page["next_cursor"])["error"]["code"], "invalid_cursor")

    def test_incomplete_history_and_catalogue_keep_explicit_diagnostics(self):
        (self.store.history_dir / "example.md" / "invalid.txt").write_text("retained fixture")
        page = self.call("wiki_versions", document="example.md")
        self.assertFalse(page["complete"])
        self.assertEqual(page["skipped"], [{"history_id": "invalid.txt", "code": "invalid_history"}])
        self.assertEqual(self.get("/versions", document="example.md"), {key: value for key, value in page.items() if key != "ok"})
        with patch("core.modules.documents.history.MAX_HISTORY_ENTRIES", 1):
            partial = self.call("wiki_versions", document="example.md")
        self.assertFalse(partial["complete"])
        self.assertTrue(partial["truncated"])
        (self.store.wiki_dir / "blocked.md").symlink_to(self.base / "outside.md")
        page = self.call("wiki_list")
        self.assertFalse(page["complete"])
        self.assertTrue(page["skipped"])
        self.assertEqual(self.get(), {key: value for key, value in page.items() if key != "ok"})

    def test_strict_raw_types_extra_identity_fields_and_literal_null(self):
        cases = [("wiki_list", {"limit": value}) for value in (True, "1", 1.5, None, 0, 51)]
        cases += [("wiki_list", {"cursor": value}) for value in (None, [], {}, 1)]
        cases += [("wiki_restore", self.restore_payload(**fields)) for fields in
                  ({"expected_revision": None}, {"expected_revision": "null"}, {"reason": None},
                   {"history_id": "../other.md"}, {"actor": self.actor})]
        cases += [("wiki_versions", {"document": "example.md", "actor": self.actor}),
                  ("wiki_list", {"profile": None}), ("wiki_version_read", {"document": "example.md"})]
        before = self.tree()
        for name, arguments in cases:
            with self.subTest(name=name, arguments=arguments):
                self.assertEqual(self.call(name, **arguments)["error"]["code"], "invalid_argument")
        self.assertFalse(validate_arguments("wiki_list", {"profile": "default"}))
        self.assertEqual(self.call("wiki_list", cursor="null")["error"]["code"], "invalid_cursor")
        self.assertTrue(self.call("wiki_list", cursor="")["ok"])
        self.assertEqual(before, self.tree())
        saved = self.call("wiki_restore", **self.restore_payload(reason="null"))
        self.assertTrue(saved["ok"], saved)
        auth = self.read()["authorship"]["updated"]
        self.assertEqual(auth["reason"], "null")
        self.assertEqual(auth["actor"], self.actor)

    def test_cleanup_and_audit_pending_are_saved_without_automatic_retry(self):
        original_unlink = Path.unlink
        def fail_temporary(path, *args, **kwargs):
            if path.suffix == ".tmp":
                raise OSError("simulated cleanup failure")
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_temporary), patch.object(changes, "finish", side_effect=OSError("simulated audit failure")):
            saved = self.call("wiki_restore", **self.restore_payload())
        self.assertTrue(saved["ok"], saved)
        self.assertEqual(saved["audit_status"], "pending_reconcile")
        self.assertTrue(saved["cleanup_failures"])
        self.assertEqual(self.store.read("example.md").content, self.original)
        self.assertEqual(len(list((self.store.history_dir / "example.md").glob("*.md"))), 2)
        # 응답을 잃은 뒤 읽는 경로도 원장을 재기록하거나 저장을 반복하지 않는다.
        before = self.tree()
        self.assertEqual(self.read()["revision"], saved["revision"])
        self.assertTrue(self.call("wiki_versions", document="example.md")["ok"])
        self.assertEqual(self.tree(), before)

    def test_new_tools_are_tenant_only_and_restore_schema_requires_revision(self):
        response = self.client.post("/mcp", headers={**self.headers(), "Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        definitions = {tool["name"]: tool for tool in response.json()["result"]["tools"]}
        self.assertTrue(DOCUMENT_MANAGEMENT_TOOLS <= definitions.keys())
        for name in DOCUMENT_MANAGEMENT_TOOLS:
            schema = definitions[name]["inputSchema"]
            self.assertIn("tenant", schema["required"])
            self.assertIn("profile", schema["properties"])
            self.assertNotIn("actor", schema["properties"])
            self.assertFalse(schema["additionalProperties"])
        schema = definitions["wiki_restore"]["inputSchema"]
        self.assertIn("expected_revision", schema["required"])
        self.assertEqual(schema["properties"]["expected_revision"]["type"], "string")
        legacy = asyncio.run(create_server(self.store).list_tools())
        self.assertEqual(len(legacy), 8)
        self.assertFalse(DOCUMENT_MANAGEMENT_TOOLS & {tool.name for tool in legacy})
