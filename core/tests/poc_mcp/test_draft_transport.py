"""Draft MCP diagnostics keep tenant/profile authorization and do not save."""

from unittest.mock import patch

from core.modules.documents.store import WikiStore
from core.tests.poc_knowledge.test_draft_validation import BODY, submission
from core.tests.poc_mcp.test_server_integration import ServerFixture


class DraftTransportTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.assertTrue(self.write(BODY)["ok"])
        self.scope = self.policy.authorize(self.token, self.tenant, "read")
        self.source = self.scope.store.read("example.md")

    def arguments(self):
        return {"tenant": self.tenant, "document": "example.md", "expected_revision": self.source.revision,
                "submission": submission()}

    def tree(self):
        return {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}

    def test_published_tool_is_read_only_and_accepts_raw_json_for_diagnostics(self):
        response = self.client.post("/mcp", headers={**self.headers(), "Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        self.assertEqual(response.status_code, 200, response.text)
        tools = response.json()["result"]["tools"]
        definition = next(tool for tool in tools if tool["name"] == "ontology_validate_draft")
        self.assertTrue(definition["annotations"]["readOnlyHint"])
        self.assertFalse(definition["annotations"]["destructiveHint"])
        self.assertIn("profile", definition["inputSchema"]["properties"])
        args = self.arguments()
        args["submission"] = {"schema_version": "wrong", "entities": [42]}
        result = self.mcp("ontology_validate_draft", args)
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["passed"])
        self.assertTrue(any(error["code"] == "submission_schema" for error in result["errors"]))

    def test_read_permission_passes_and_pass_failure_leave_all_bytes_unchanged(self):
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        before = self.tree()
        with patch.object(WikiStore, "_write_lock", side_effect=AssertionError("draft must not create locks")):
            result = self.mcp("ontology_validate_draft", self.arguments())
            self.assertTrue(result["ok"], result)
            self.assertTrue(result["passed"], result)
            self.assertFalse(result["save_authorized"])
            args = self.arguments()
            args["submission"]["entities"][0]["evidence"] = "A missing."
            failure = self.mcp("ontology_validate_draft", args)
            self.assertTrue(failure["ok"], failure)
            self.assertFalse(failure["passed"])
        self.assertEqual(self.tree(), before)

    def test_profile_does_not_filter_claims_and_denied_profile_is_rejected(self):
        def select_business(value):
            value["tenants"][self.tenant]["profiles"]["business_only"] = {"domain": "Restricted", "viewpoint": "business"}
            value["users"][self.user["user_id"]]["memberships"][self.tenant]["profiles"].append("business_only")
        self.change_policy(select_business)
        args = self.arguments()
        args["profile"] = "business_only"
        args["submission"]["relations"][0]["object"] = "missing"
        result = self.mcp("ontology_validate_draft", args)
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["passed"])
        self.assertEqual(result["access"]["profile_id"], "business_only")
        self.assertTrue(any(error["path"] == "/relations/0" for error in result["errors"]))
        denied = self.mcp("ontology_validate_draft", {**self.arguments(), "profile": "forbidden"})
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "access_denied")

    def test_tenant_and_revoked_read_denials_preserve_existing_data(self):
        before = self.tree()
        denied = self.mcp("ontology_validate_draft", {**self.arguments(), "tenant": "forbidden"})
        self.assertEqual(denied["error"]["code"], "access_denied")
        self.assertTrue(self.mcp("ontology_validate_draft", self.arguments())["passed"])
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        denied = self.mcp("ontology_validate_draft", self.arguments())
        self.assertEqual(denied["error"]["code"], "access_denied")
        self.assertEqual(self.tree(), before)

    def test_success_does_not_grant_write_permission(self):
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        self.assertTrue(self.mcp("ontology_validate_draft", self.arguments())["passed"])
        args = self.arguments()
        value = args.pop("submission")
        result = self.mcp("ontology_generate", {**args, **value})
        self.assertEqual(result["error"]["code"], "access_denied")
