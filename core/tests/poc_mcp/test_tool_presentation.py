"""클라이언트에 보이는 도구 이름·동작 표시·스키마 분량과 입력 오류 안내를 실제 HTTP MCP로 검사한다."""

import asyncio
import json
import unittest

from core.mcp.guidance import PROMPT_DESCRIPTIONS, _messages, catalog, compact_instructions
from core.mcp.presentation import TOOL_TITLES, without_schema_titles
from core.mcp.server import create_server
from core.mcp.tenant import create_tenant_server
from core.modules.documents.store import WikiStore
from core.tests.poc_mcp.test_server_integration import ServerFixture


ADDITIVE = {"analysis_registration_create", "analysis_job_claim", "analysis_job_heartbeat", "analysis_job_input_prepare",
            "source_extraction_submit", "ontology_relation_create", "ontology_correspondence_propose"}
REPLAYABLE = {"analysis_registration_create", "source_extraction_submit", "ontology_relation_create",
              "ontology_relation_undo", "ontology_cleanup_apply", "ontology_cleanup_undo"}
ACCESS_SENTENCE = "Each data result's access field shows the applied user, tenant, profile and policy revision"


def schema_titles(node):
    """스키마 키워드 title만 센다. properties 맵의 'title' 속성 이름은 세지 않는다."""
    if isinstance(node, list):
        return sum(schema_titles(item) for item in node)
    if not isinstance(node, dict):
        return 0
    count = 0
    for key, value in node.items():
        if key == "title" and isinstance(value, str):
            count += 1
        elif key in {"properties", "$defs"} and isinstance(value, dict):
            count += sum(schema_titles(child) for child in value.values())
        else:
            count += schema_titles(value)
    return count


class ToolPresentationIntegration(ServerFixture):
    def rpc(self, method, params):
        response = self.client.post("/mcp", headers={**self.headers(), "Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]

    def error(self, name, arguments):
        result = self.mcp(name, arguments)
        self.assertFalse(result["ok"])
        return result["error"]

    def test_every_tool_has_korean_title_and_no_generated_schema_titles(self):
        tools = self.rpc("tools/list", {})["tools"]
        self.assertEqual({tool["name"] for tool in tools}, set(TOOL_TITLES))
        for tool in tools:
            with self.subTest(tool=tool["name"]):
                self.assertEqual(tool["title"], TOOL_TITLES[tool["name"]])
                self.assertEqual(schema_titles(tool["inputSchema"]), 0)
        registration = next(tool for tool in tools if tool["name"] == "analysis_registration_create")
        # 실제 매개변수 이름 'title'은 스키마 키워드가 아니므로 남는다.
        self.assertIn("title", registration["inputSchema"]["properties"])

    def test_legacy_tools_also_have_titles(self):
        directory = self.base / "legacy"
        directory.mkdir(mode=0o700)
        tools = asyncio.run(create_server(WikiStore(directory)).list_tools())
        self.assertTrue(tools)
        for tool in tools:
            self.assertEqual(tool.title, TOOL_TITLES[tool.name])
            self.assertEqual(schema_titles(tool.input_schema), 0)

    def test_profile_guidance_is_stated_once_in_instructions_not_per_tool(self):
        tools = self.rpc("tools/list", {})["tools"]
        for tool in tools:
            # 예전에 40개 도구 끝에 반복해 붙이던 세 문장이다. 도구 고유 설명의 비슷한 문구는 유지한다.
            self.assertNotIn("Profiles prioritize claims; they do not restrict tenant-wide read permission.", tool["description"])
            self.assertNotIn("In tenant mode use an allowed profile", tool["description"])
            self.assertNotIn("Inspect access for the applied user, tenant, profile and policy revision.", tool["description"])
        for mode in ("full", "compact"):
            with self.subTest(mode=mode):
                self.assertIn(ACCESS_SENTENCE, create_tenant_server(self.policy, self.token, guidance_mode=mode).instructions)
        self.assertIn(ACCESS_SENTENCE, compact_instructions(True))
        for name in ("wiki_write", "ontology_generate", "ontology_review", "ontology_policy"):
            description = next(tool for tool in tools if tool["name"] == name)["description"]
            self.assertIn("four revision fields before changing data", description)
            self.assertIn("never retry the saved write", description)

    def test_annotations_distinguish_additive_and_replayable_writes(self):
        tools = {tool["name"]: tool["annotations"] for tool in self.rpc("tools/list", {})["tools"]}
        for name, annotations in tools.items():
            with self.subTest(tool=name):
                if annotations["readOnlyHint"]:
                    self.assertFalse(annotations["destructiveHint"])
                    continue
                self.assertEqual(annotations["destructiveHint"], name not in ADDITIVE)
                self.assertEqual(annotations.get("idempotentHint", False), name in REPLAYABLE)

    def test_argument_errors_name_the_field_and_reason(self):
        cases = [
            ("wiki_read", {"document": "a.md"}, "tenant is required"),
            ("wiki_read", {"tenant": "Bad Tenant", "document": "a.md"}, "tenant must be a tenant ID"),
            ("wiki_read", {"tenant": self.tenant, "document": "a.md", "path": "x"}, "Unexpected field(s) for wiki_read: path."),
            ("wiki_read", {"tenant": self.tenant, "document": "a.md", "profile": "default"}, "wiki_read does not accept profile"),
            ("ontology_query", {"tenant": self.tenant, "document": "a.md", "domain": "x"}, "Use profile instead of domain/viewpoint"),
            ("wiki_read", {"tenant": self.tenant}, "document: Field required"),
            ("wiki_read", {"tenant": self.tenant, "document": 3}, "document: Input should be a valid string"),
            ("analysis_job_list", {"tenant": self.tenant, "limit": -1}, "limit: Input should be greater than or equal to 1"),
            ("wiki_delete", {"tenant": self.tenant}, "Unknown tool: wiki_delete."),
            ("access_context", {"x": 1}, "access_context takes no arguments."),
            ("wiki_guidance", {"task": "nope"}, "task must be 'catalog'"),
        ]
        for name, arguments, expected in cases:
            with self.subTest(tool=name, arguments=sorted(arguments)):
                error = self.error(name, arguments)
                self.assertEqual(error["code"], "invalid_argument")
                self.assertIn(expected, error["message"])
                self.assertNotIn("pydantic.dev", error["message"])
                self.assertNotIn("input_value", error["message"])

    def test_access_denial_stays_uniform_and_hides_tenant_existence(self):
        for tenant in ("someone_else", "unknown_tenant"):
            error = self.error("wiki_read", {"tenant": tenant, "document": "a.md"})
            self.assertEqual(error, {"code": "access_denied", "message": "Access denied.", "retryable": False})


class PromptPresentationTests(unittest.TestCase):
    """프롬프트 메뉴의 한국어 표시와 빈 입력 처리를 검사한다."""

    def test_every_prompt_has_korean_description_and_confirmed_terms(self):
        for tenant in (True, False):
            for name, task in catalog(tenant).items():
                with self.subTest(task=name, tenant=tenant):
                    self.assertTrue(PROMPT_DESCRIPTIONS[name])
                    for retired in ("판본", "영수증", "기계 그래프", "독립 관계"):
                        self.assertNotIn(retired, task.title + PROMPT_DESCRIPTIONS[name])

    def test_empty_prompt_fields_are_omitted_and_empty_request_asks_first(self):
        empty = _messages("answer", True, {"request": "", "document": "", "tenant": "", "profile": " "})
        self.assertEqual(empty[1]["content"]["text"], "{}")
        self.assertIn("No request was provided: ask the user", empty[0]["content"]["text"])
        filled = _messages("answer", True, {"request": "현재 조건은?", "document": "", "tenant": "personal", "profile": ""})
        self.assertEqual(json.loads(filled[1]["content"]["text"]), {"request": "현재 조건은?", "tenant": "personal"})
        self.assertNotIn("No request was provided", filled[0]["content"]["text"])


class SchemaTitleStripTests(unittest.TestCase):
    def test_strip_keeps_property_names_and_data_values_without_mutating_input(self):
        schema = {"title": "XArguments", "type": "object",
                  "properties": {"title": {"title": "Title", "type": "string", "default": {"title": "kept"}}},
                  "$defs": {"Item": {"title": "Item", "type": "object", "examples": [{"title": "kept"}]}}}
        stripped = without_schema_titles(schema)
        self.assertEqual(stripped, {"type": "object",
            "properties": {"title": {"type": "string", "default": {"title": "kept"}}},
            "$defs": {"Item": {"type": "object", "examples": [{"title": "kept"}]}}})
        self.assertEqual(schema["title"], "XArguments")
        self.assertEqual(schema["properties"]["title"]["title"], "Title")
