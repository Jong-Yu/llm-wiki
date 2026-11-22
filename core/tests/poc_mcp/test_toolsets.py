"""역할별 도구 묶음이 노출·호출·안내만 좁히고 권한·저장 계약은 바꾸지 않는지 확인한다."""

import asyncio
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from mcp.shared.exceptions import MCPError

from core.mcp.guidance import GUIDANCE_TOOL, catalog
from core.mcp.tenant import create_tenant_server
from core.mcp import toolsets
from core.mcp.tools.documents import MAX_READ_LINES
from core.runtime.personal_launcher import LauncherError, prepare_launch
from core.tests.poc_mcp.test_server_integration import ServerFixture


class ToolsetHTTP(ServerFixture):
    def rpc(self, method, params, toolset=None):
        url = "/mcp" + (f"?toolset={toolset}" if toolset else "")
        response = self.client.post(url, headers={**self.headers(), "Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def call(self, name, arguments, toolset=None):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments}, toolset)["result"]
        payload = result["structuredContent"]
        self.assertEqual(json.loads(result["content"][0]["text"]), payload)
        return payload

    def initialize(self, toolset=None):
        return self.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                       "clientInfo": {"name": "toolset-test", "version": "1"}}, toolset)

    def test_default_connection_is_unchanged(self):
        default_tools = self.rpc("tools/list", {})["result"]["tools"]
        explicit_all = self.rpc("tools/list", {}, "all")["result"]["tools"]
        self.assertEqual(default_tools, explicit_all)
        self.assertEqual(len(default_tools), 58)  # 57 + knowledge_lookup
        self.assertEqual(self.initialize()["result"]["instructions"], self.initialize("all")["result"]["instructions"])
        self.assertEqual({item["name"] for item in self.rpc("prompts/list", {})["result"]["prompts"]},
                         {"wiki_" + name for name in catalog(True)})

    def test_each_role_lists_only_its_tools_prompts_and_guidance(self):
        full = self.rpc("tools/list", {})["result"]["tools"]
        full_bytes = len(json.dumps(full, ensure_ascii=False).encode())
        for name, toolset in toolsets.TOOLSETS.items():
            with self.subTest(toolset=name):
                tools = self.rpc("tools/list", {}, name)["result"]["tools"]
                names = {tool["name"] for tool in tools}
                self.assertEqual(names, toolsets.tool_names(name, tenant=True))
                self.assertLess(len(json.dumps(tools, ensure_ascii=False).encode()), full_bytes * 0.55)
                guide = next(tool for tool in tools if tool["name"] == GUIDANCE_TOOL)
                self.assertEqual(guide["inputSchema"]["properties"]["task"]["enum"], ["catalog", *toolset.tasks])
                prompts = {item["name"] for item in self.rpc("prompts/list", {}, name)["result"]["prompts"]}
                self.assertEqual(prompts, {"wiki_" + task for task in toolset.tasks})
                text = self.initialize(name)["result"]["instructions"]
                self.assertIn(f"'{name}' toolset", text)
                self.assertIn("Token economy:", text)
                for task in toolset.tasks:
                    self.assertIn(catalog(True)[task].instructions, text)
                # 다른 역할 도구의 정의는 같은 연결의 목록에 남지 않는다.
                for tool in full:
                    if tool["name"] not in names:
                        self.assertNotIn(tool["name"], {item["name"] for item in tools})
        ask = {tool["name"] for tool in self.rpc("tools/list", {}, "ask")["result"]["tools"]}
        self.assertFalse(ask & {"wiki_write", "wiki_restore", "ontology_review", "ontology_policy", "analysis_job_claim",
                                "ontology_generate", "ontology_cleanup_apply"})

    def test_out_of_role_call_is_rejected_without_saving(self):
        result = self.call("wiki_write", {"tenant": self.tenant, "document": "blocked.md", "content": "x\n",
                                          "expected_revision": None}, "ask")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "invalid_argument")
        self.assertIn("'ask' toolset", result["error"]["message"])
        listed = self.call("wiki_list", {"tenant": self.tenant})
        self.assertNotIn("blocked.md", json.dumps(listed, ensure_ascii=False))
        # 묶음 안의 쓰기는 기존 권한 경로를 그대로 사용한다.
        self.assertTrue(self.call("wiki_write", {"tenant": self.tenant, "document": "allowed.md", "content": "y\n",
                                                 "expected_revision": None}, "write")["ok"])

    def test_ask_review_queue_is_available_without_mutation_or_permission_expansion(self):
        tools = self.rpc("tools/list", {}, "ask")["result"]["tools"]
        with self.subTest(check="discovery"):
            self.assertIn("ontology_review_queue", {tool["name"] for tool in tools})
        self.assertTrue(all(tool["annotations"]["readOnlyHint"] for tool in tools))
        self.assertTrue(self.write("검토 대기 문서\n")["ok"])
        for coverage in ("tenant", "selected"):
            with self.subTest(check="call", coverage=coverage):
                arguments = {"tenant": self.tenant, "coverage": coverage}
                if coverage == "selected":
                    arguments["documents"] = ["example.md"]
                expected = self.call("ontology_review_queue", arguments)
                self.assertTrue(expected["ok"], expected)
                self.assertTrue(expected["items"])
                self.assertEqual(self.call("ontology_review_queue", arguments, "ask"), expected)
        # 도구 노출을 복원해도 각 호출은 변경된 현재 권한을 검사한다.
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(
            permissions=[]))
        denied = self.call("ontology_review_queue", {"tenant": self.tenant, "coverage": "tenant"}, "ask")
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["error"]["code"], "access_denied")

    def test_out_of_role_call_still_requires_authentication(self):
        response = self.client.post("/mcp?toolset=ask", headers={"Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": "wiki_write", "arguments": {}}})
        self.assertEqual(response.status_code, 401)

    def test_ask_reads_body_view_without_duplicate_full_copy(self):
        # 서버가 Front Matter를 붙이므로 전체 파일(content)과 본문(body)이 실제로 다르다.
        written = self.write("# 제목\n\n본문 첫 줄\n")
        self.assertTrue(written["ok"], written)
        full = self.call("wiki_read", {"tenant": self.tenant, "document": "example.md"})
        content = full["content"]
        self.assertTrue(content.endswith(full["body"]))
        self.assertNotIn("view", full)
        self.assertGreater(full["body_start_line"], 1)
        body = self.call("wiki_read", {"tenant": self.tenant, "document": "example.md"}, "ask")
        self.assertNotIn("content", body)
        self.assertEqual(body["view"], "body")
        for key in ("revision", "body", "body_start_line", "metadata", "document_id", "body_revision"):
            self.assertEqual(body[key], full[key], key)
        self.assertLess(len(json.dumps(body, ensure_ascii=False)), len(json.dumps(full, ensure_ascii=False)))
        explicit = self.call("wiki_read", {"tenant": self.tenant, "document": "example.md", "view": "full"}, "ask")
        self.assertEqual(explicit["content"], content)
        self.assertEqual(self.call("wiki_read", {"tenant": self.tenant, "document": "example.md", "view": "body"}),
                         body)

    def test_lookup_passage_lines_read_the_same_text_with_unicode_separators(self):
        # FF·Unicode 구분자는 원문의 글자이며 지식 조회의 CR/LF 좌표를 바꾸지 않는다.
        written = self.write("소개\f중간\u2028같은 줄\u0085내용\n\nTarget marker contains answer 42.\n")
        self.assertTrue(written["ok"], written)
        found = self.call("knowledge_lookup", {"tenant": self.tenant,
            "question": "Target marker answer", "documents": ["example.md"]}, "ask")
        self.assertTrue(found["ok"], found)
        passage = next(item for item in found["evidence"]["passages"] if "answer 42" in item["text"])
        self.assertEqual(passage["text"], "Target marker contains answer 42.")
        read = self.call("wiki_read", {"tenant": self.tenant, "document": passage["document"],
            "view": "lines", "start_line": passage["start_line"], "end_line": passage["end_line"]}, "ask")
        self.assertTrue(read["ok"], read)
        self.assertEqual(read["text"], "Target marker contains answer 42.\n")
        self.assertEqual(read["line_count"], found["documents"][0]["line_count"])
        self.assertEqual(read["revision"], found["documents"][0]["source_revision"])

    def test_lines_view_returns_exact_full_file_lines(self):
        written = self.write("".join(f"line {n}\n" for n in range(1, 451)))
        self.assertTrue(written["ok"], written)
        full = self.call("wiki_read", {"tenant": self.tenant, "document": "example.md"})
        lines = full["content"].splitlines(keepends=True)
        start = full["body_start_line"] + 9
        part = self.call("wiki_read", {"tenant": self.tenant, "document": "example.md", "view": "lines",
                                       "start_line": start, "end_line": start + 4}, "ask")
        self.assertTrue(part["ok"], part)
        self.assertEqual(part["text"], "".join(lines[start - 1:start + 4]))
        self.assertEqual((part["start_line"], part["end_line"]), (start, start + 4))
        self.assertEqual(part["revision"], full["revision"])
        self.assertEqual(part["line_count"], len(lines))
        self.assertEqual(part["next_start_line"], start + 5)
        for key in ("content", "body", "metadata"):
            self.assertNotIn(key, part)
        # view를 빼고 줄 번호만 주면 ask 묶음에서도 줄 범위 보기다. 한 번에 최대 MAX_READ_LINES줄이다.
        inferred = self.call("wiki_read", {"tenant": self.tenant, "document": "example.md", "start_line": 1}, "ask")
        self.assertEqual(inferred["view"], "lines")
        self.assertEqual(inferred["end_line"], MAX_READ_LINES)
        self.assertEqual(inferred["text"], "".join(lines[:MAX_READ_LINES]))
        tail = self.call("wiki_read", {"tenant": self.tenant, "document": "example.md", "view": "lines",
                                       "start_line": len(lines) - 1, "end_line": len(lines) + 50})
        self.assertEqual(tail["end_line"], len(lines))
        self.assertIsNone(tail["next_start_line"])
        for invalid in ({"view": "lines"}, {"view": "lines", "start_line": 5, "end_line": 4},
                        {"view": "lines", "start_line": len(lines) + 1}, {"view": "body", "start_line": 2},
                        {"view": "lines", "start_line": 0}):
            with self.subTest(arguments=invalid):
                result = self.call("wiki_read", {"tenant": self.tenant, "document": "example.md", **invalid})
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], "invalid_argument")

    def test_guidance_catalog_and_tasks_follow_role(self):
        listed = self.call(GUIDANCE_TOOL, {"task": "catalog"}, "write")
        self.assertEqual(listed["toolset"], "write")
        self.assertEqual([row["task"] for row in listed["tasks"]], list(toolsets.TOOLSETS["write"].tasks))
        self.assertTrue(self.call(GUIDANCE_TOOL, {"task": "edit"}, "write")["ok"])
        blocked = self.call(GUIDANCE_TOOL, {"task": "review"}, "write")
        self.assertFalse(blocked["ok"])
        self.assertIn("'write' toolset", blocked["error"]["message"])
        self.assertEqual(len(self.call(GUIDANCE_TOOL, {"task": "catalog"})["tasks"]), len(catalog(True)))

    def test_prompt_outside_role_and_unknown_toolset_are_errors(self):
        rendered = self.rpc("prompts/get", {"name": "wiki_edit", "arguments": {"request": "고쳐 줘"}}, "write")
        self.assertIn("result", rendered)
        blocked = self.rpc("prompts/get", {"name": "wiki_review", "arguments": {}}, "write")
        self.assertIn("'write' toolset", blocked["error"]["message"])
        for value in ("bogus", "ask&toolset=write"):
            with self.subTest(toolset=value):
                error = self.rpc("tools/list", {}, value)["error"]
                self.assertEqual(error["code"], -32602)
                self.assertIn("Unknown toolset", error["message"])


class FixedToolsetServer(ServerFixture):
    def test_stdio_style_fixed_toolset_cannot_be_widened(self):
        server = create_tenant_server(self.policy, self.token, toolset="write")
        tools = {tool.name for tool in asyncio.run(server.list_tools())}
        # 목록 축소는 연결 미들웨어가 맡고, 직접 호출 거부는 서버가 맡는다.
        self.assertIn("ontology_review", tools)
        result = asyncio.run(server.call_tool("ontology_review_query", {"tenant": self.tenant, "document": "x.md"}))
        self.assertFalse(result.structured_content["ok"])
        self.assertIn("'write' toolset", result.structured_content["error"]["message"])
        with self.assertRaises(MCPError):
            asyncio.run(server.get_prompt("wiki_review", {}))
        self.assertEqual(toolsets.selected("write", None), "write")
        with self.assertRaises(toolsets.ToolsetError):
            toolsets.selected("write", type("Request", (), {"query_params": _Query({"toolset": ["ask"]})})())
        self.assertEqual(toolsets.selected("all", type("Request", (), {"query_params": _Query({"toolset": ["ask"]})})()),
                         "ask")
        with self.assertRaises(ValueError):
            create_tenant_server(self.policy, self.token, toolset="admin")

    def test_personal_launcher_adds_toolset_only_when_selected(self):
        # A clean worktree can use the existing project interpreter without its own .venv.
        self.enterContext(patch("core.runtime.personal_launcher.PROJECT_PYTHON", Path(sys.executable)))
        with TemporaryDirectory() as directory:
            private = Path(directory).resolve() / "credentials"
            private.mkdir(mode=0o700)
            token_file = private / "user.token"
            token_file.write_text(self.token + "\n")
            os.chmod(token_file, 0o600)
            config = private / "access.json"
            config.write_bytes(self.config.read_bytes())
            os.chmod(config, 0o600)
            arguments = dict(token_file=token_file, access_config=config, tenant_root=self.root, environment={})
            default = prepare_launch(**arguments)
            self.assertNotIn("--toolset", default.argv)
            selected = prepare_launch(**arguments, toolset="ask")
            self.assertEqual(selected.argv[:len(default.argv)], default.argv)
            self.assertEqual(selected.argv[len(default.argv):], ("--toolset", "ask"))
            with self.assertRaises(LauncherError):
                prepare_launch(**arguments, toolset="everything")


class _Query:
    def __init__(self, values):
        self.values = values

    def getlist(self, key):
        return self.values.get(key, [])
