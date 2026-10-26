"""MCP protocol and storage integration tests using isolated temporary data."""

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import httpx2
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

from core.mcp.http import MAX_HTTP_REQUEST_BYTES
from core.mcp_server import create_http_app, create_server
from core.modules.documents.store import MAX_DOCUMENT_BYTES, WikiStore
from core.tests.modules.test_ontology import ontology_v2_fixture, ontology_v3_fixture


from core.paths import PROJECT_DIR
TOOL_NAMES = {"wiki_read", "wiki_write", "wiki_search", "ontology_generate", "ontology_query", "ontology_connections", "ontology_context"}


class MCPTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-mcp-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.data = self.root / "data"
        self.data.mkdir()
        self.store = WikiStore(self.data)

    def stdio_client(self, *, mode="legacy"):
        return Client(
            StdioServerParameters(
                command=sys.executable,
                args=["-B", "-m", "core.mcp_server", "--data-dir", str(self.data),
                      "--lock-timeout", "0.1"],
                cwd=PROJECT_DIR,
            ),
            mode=mode,
            read_timeout_seconds=10,
        )

    def in_process_client(self):
        return Client(create_server(self.store), mode="legacy", read_timeout_seconds=10)

    def payload(self, result, *, code=None):
        value = result.structured_content
        self.assertIsInstance(value, dict)
        self.assertEqual(result.is_error, code is not None)
        self.assertEqual(value["ok"], code is None)
        self.assertEqual(len(result.content), 1)
        self.assertEqual(json.loads(result.content[0].text), value)
        if code is not None:
            self.assertEqual(value["error"]["code"], code)
            self.assertIsInstance(value["error"]["retryable"], bool)
        return value

    def histories(self):
        return sorted(path for path in self.store.history_dir.rglob("*.md")
                      if path.is_file())

    async def write(self, client, content, *, revision=None, document="Guide.md"):
        return await client.call_tool("wiki_write", {
            "document": document,
            "content": content,
            "expected_revision": revision,
        })

    async def ontology_v2_flow(self, client):
        """Run the same V2 contract through each real transport."""
        source, entities, relations, candidates = ontology_v2_fixture()
        first = self.payload(await self.write(client, source))
        request = {
            "document": "Guide.md", "expected_revision": first["revision"],
            "entities": entities, "relations": relations, "relation_candidates": candidates,
        }
        tools = await client.list_tools()
        self.assertEqual({tool.name for tool in tools.tools}, TOOL_NAMES)
        definition = next(tool for tool in tools.tools if tool.name == "ontology_generate")
        self.assertIn("relation_candidates", definition.input_schema["properties"])
        self.assertNotIn("relation_candidates", definition.input_schema.get("required", []))
        generated = self.payload(await client.call_tool("ontology_generate", request))
        self.assertEqual((generated["relation_count"], generated["candidate_count"]), (8, 2))
        graph = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
        self.assertEqual(graph["schema_version"], 3)
        self.assertFalse(graph["needs_reextraction"])
        self.assertEqual([r["qualifiers"] for r in graph["relations"][-2:]],
                         [r["qualifiers"] for r in relations[-2:]])
        self.assertEqual([c["status"] for c in graph["relation_candidates"]], ["needs_review"] * 2)
        self.assertIsNone(graph["relation_candidates"][0]["evidence"])
        before = {p.relative_to(self.data).as_posix(): p.read_bytes()
                  for p in self.data.rglob("*") if p.is_file()}

        bad_condition = deepcopy(request)
        bad_condition["relations"][-2]["qualifiers"]["condition"] = "습도가 낮으면"
        bad_endpoint = deepcopy(request)
        bad_endpoint["relation_candidates"][0]["object"] = "absent"
        bad_quote = deepcopy(request)
        bad_quote["relation_candidates"][0]["evidence"] = "존재하지 않는 인용"
        for invalid in (bad_condition, bad_endpoint, bad_quote):
            self.payload(await client.call_tool("ontology_generate", invalid), code="invalid_ontology")
        for field, value in (("status", "approved"), ("approved", True), ("confidence", 1.0)):
            invalid = deepcopy(request)
            invalid["relation_candidates"][0][field] = value
            self.assertTrue((await client.call_tool("ontology_generate", invalid)).is_error)
        invalid = deepcopy(request)
        invalid["relation_candidates"] = json.dumps(candidates)
        self.payload(await client.call_tool("ontology_generate", invalid), code="invalid_argument")
        for collection in ("relations", "relation_candidates"):
            for qualifiers in (None, "null", '{"polarity":"negative"}'):
                invalid = deepcopy(request)
                invalid[collection][0]["qualifiers"] = qualifiers
                self.payload(await client.call_tool("ontology_generate", invalid), code="invalid_argument")
        self.assertEqual({p.relative_to(self.data).as_posix(): p.read_bytes()
                          for p in self.data.rglob("*") if p.is_file()}, before)

        second_source = source + "원문 첫 수정\n"
        second = self.payload(await self.write(client, second_source, revision=first["revision"]))
        stale = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
        self.assertEqual((stale["status"], stale["relations"], stale["relation_candidates"]), ("stale", [], []))
        self.payload(await client.call_tool("ontology_generate", request), code="conflict")
        self.payload(await self.write(client, "오래된 원문", revision=first["revision"]), code="conflict")
        request["expected_revision"] = second["revision"]
        self.payload(await client.call_tool("ontology_generate", request))
        third_source = second_source + "원문 두 번째 수정\n"
        third = self.payload(await self.write(client, third_source, revision=second["revision"]))
        request["expected_revision"] = third["revision"]
        request["relation_candidates"] = []
        self.payload(await client.call_tool("ontology_generate", request))
        ready = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
        self.assertEqual((ready["status"], ready["relation_candidates"]), ("ready", []))
        self.assertEqual((self.data / second["history_path"]).read_bytes(), source.encode())
        self.assertEqual((self.data / third["history_path"]).read_bytes(), second_source.encode())
        self.assertEqual(len(self.histories()), 2)
        self.assertEqual(self.store.read("Guide.md").content, third_source)
        self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [])

    async def ontology_v3_flow(self, client):
        """Exercise scoped claims and preservation over an actual transport."""
        source, entities, relations, candidates, attributes = ontology_v3_fixture()
        first = self.payload(await self.write(client, source))
        request = {"document": "Guide.md", "expected_revision": first["revision"],
                   "entities": entities, "relations": relations,
                   "relation_candidates": candidates, "attributes": attributes}
        tools = await client.list_tools()
        generate_schema = next(t.input_schema for t in tools.tools if t.name == "ontology_generate")
        query_schema = next(t.input_schema for t in tools.tools if t.name == "ontology_query")
        self.assertIn("attributes", generate_schema["properties"])
        self.assertTrue({"domain", "viewpoint"} <= set(query_schema["properties"]))
        saved = self.payload(await client.call_tool("ontology_generate", request))
        self.assertEqual(saved["attribute_count"], 4)
        graph = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
        self.assertEqual((graph["schema_version"], graph["needs_reextraction"]), (3, False))
        self.assertEqual(len(graph["entities"]), 10)
        self.assertEqual([x["value"] for x in graph["attributes"]], [x["value"] for x in attributes])
        self.assertEqual(graph["attributes"][0]["provenance"], attributes[0]["provenance"])
        self.assertEqual(graph["entities"][0]["identifiers"][0]["namespace"],
                         entities[0]["identifiers"][0]["namespace"])
        self.assertEqual(graph["relation_candidates"][0]["status"], "needs_review")
        context = self.payload(await client.call_tool("ontology_context", {
            "documents": ["Guide.md"], "viewpoint": "business",
        }))
        self.assertTrue(context["complete"])
        self.assertFalse(context["truncated"])
        entry = context["documents"][0]
        self.assertEqual(entry["document"], "Guide.md")
        self.assertEqual(entry["source"]["content"], source)
        self.assertEqual(entry["source"]["revision"], first["revision"])
        self.assertEqual(entry["source"]["revision"], hashlib.sha256(source.encode()).hexdigest())
        self.assertEqual(entry["source"]["line_start"], 1)
        self.assertEqual(entry["source"]["line_end"], len(source.splitlines()))
        self.assertRegex(entry["ontology"]["graph_revision"], r"^[0-9a-f]{64}$")
        for collection in ("entities", "relations", "relation_candidates", "attributes"):
            self.assertEqual(entry["ontology"][collection], graph[collection])
        self.assertEqual(entry["selection"]["attributes"], {
            "focus": [0, 1], "other_context": [2], "unclassified": [3],
        })
        self.assertEqual(entry["selection"]["relations"]["unclassified"], list(range(6)))
        self.assertEqual(entry["selection"]["relation_candidates"]["unclassified"], [0])
        filtered = self.payload(await client.call_tool("ontology_query", {
            "document": "Guide.md", "domain": attributes[0]["context"]["domain"], "viewpoint": "developer",
        }))
        self.assertEqual([a["id"] for a in filtered["attributes"]], ["price"])
        self.assertEqual(filtered["entities"], graph["entities"])
        self.assertEqual(filtered["filtered"]["viewpoint"], "developer")
        before = {p.relative_to(self.data).as_posix(): p.read_bytes()
                  for p in self.data.rglob("*") if p.is_file()}
        invalid = deepcopy(request)
        invalid["attributes"] = json.dumps(attributes)
        self.payload(await client.call_tool("ontology_generate", invalid), code="invalid_argument")
        for mutation in ({"value": 1.5}, {"provenance": {"source_entity": "catalog"}},
                         {"context": {"viewpoints": ["business", "business"]}},
                         {"provenance": {"approved_by_user": True}}):
            invalid = deepcopy(request)
            invalid["attributes"][0].update(mutation)
            self.assertTrue((await client.call_tool("ontology_generate", invalid)).is_error)
        self.assertEqual({p.relative_to(self.data).as_posix(): p.read_bytes()
                          for p in self.data.rglob("*") if p.is_file()}, before)

        second_source = source.replace("+001.50", "+002.50")
        second = self.payload(await self.write(client, second_source, revision=first["revision"]))
        changed_context = self.payload(await client.call_tool("ontology_context", {
            "documents": ["Guide.md"], "viewpoint": "developer",
        }))
        changed_entry = changed_context["documents"][0]
        self.assertEqual(changed_entry["source"]["content"], second_source)
        self.assertEqual(changed_entry["source"]["revision"], second["revision"])
        self.assertEqual(changed_entry["ontology"]["status"], "stale")
        self.assertEqual(changed_entry["ontology"]["indexed_revision"], first["revision"])
        for collection in ("entities", "relations", "relation_candidates", "attributes"):
            self.assertEqual(changed_entry["ontology"][collection], [])
        stale = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
        self.assertEqual(stale["status"], "stale")
        for collection in ("entities", "relations", "relation_candidates", "attributes"):
            self.assertEqual(stale[collection], [])
        self.payload(await client.call_tool("ontology_generate", request), code="conflict")
        self.payload(await self.write(client, source, revision=first["revision"]), code="conflict")
        fresh = self.payload(await client.call_tool("wiki_read", {"document": "Guide.md"}))
        self.assertEqual(fresh["content"], second_source)
        # This synthetic fixture has one deliberately changed literal. Update
        # the value AND its source quotations, not merely the source revision.
        changed = json.loads(json.dumps(request).replace("+001.50", "+002.50"))
        changed["expected_revision"] = fresh["revision"]
        self.payload(await client.call_tool("ontology_generate", changed))
        ready = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
        self.assertEqual(ready["attributes"][0]["value"], "+002.50")
        self.assertEqual(ready["source_revision"], second["revision"])
        self.assertEqual(self.store.read("Guide.md").content, second_source)
        self.assertEqual([p.read_bytes() for p in self.histories()], [source.encode()])
        self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [])

    async def connections_flow(self, client):
        originals = {"A.md": "MCP는 프로토콜이다.\n\n[다음 문서](B.md)\n", "B.md": "MCP를 설명한다.\n"}
        revisions = {}
        for document, content in originals.items():
            saved = self.payload(await self.write(client, content, document=document))
            revisions[document] = saved["revision"]
            self.payload(await client.call_tool("ontology_generate", {
                "document": document, "expected_revision": saved["revision"],
                "entities": [{"id": "mcp", "type": "concept", "label": "MCP", "evidence": "MCP"}],
                "relations": [],
            }))
        connected = self.payload(await client.call_tool("ontology_connections", {"document": "A.md"}))
        self.assertEqual(len(connected["explicit_links"]), 1)
        self.assertEqual(connected["explicit_links"][0]["target_document"], "B.md")
        self.assertEqual(connected["explicit_links"][0]["direction"], "outgoing")
        self.assertEqual(connected["explicit_links"][0]["target_status"], "resolved")
        self.assertEqual(len(connected["candidates"]), 1)
        candidate = connected["candidates"][0]
        self.assertEqual(candidate["status"], "candidate")
        self.assertEqual(candidate["source_entity"]["document"], "A.md")
        self.assertEqual(candidate["target_entity"]["document"], "B.md")
        self.assertFalse(connected["truncated"])
        incoming = self.payload(await client.call_tool("ontology_connections", {"document": "B.md"}))
        self.assertEqual(incoming["explicit_links"][0]["direction"], "incoming")

        updated = self.payload(await self.write(client, "HTTP를 설명한다.\n", document="A.md", revision=revisions["A.md"]))
        after = self.payload(await client.call_tool("ontology_connections", {"document": "B.md"}))
        self.assertEqual(after["explicit_links"], [])
        self.assertEqual(after["candidates"], [])
        states = {item["document"]: item["status"] for item in after["ontology_states"]}
        self.assertEqual(states["A.md"], "stale")
        self.payload(await client.call_tool("ontology_generate", {
            "document": "A.md", "expected_revision": updated["revision"],
            "entities": [{"id": "http", "type": "concept", "label": "HTTP", "evidence": "HTTP"}], "relations": [],
        }))
        fresh = self.payload(await client.call_tool("ontology_connections", {"document": "A.md"}))
        self.assertEqual(fresh["candidates"], [])
        self.assertEqual(fresh["explicit_links"], [])
        self.assertEqual([path.read_bytes() for path in self.histories()], [originals["A.md"].encode()])
        graph = self.payload(await client.call_tool("ontology_query", {"document": "B.md"}))
        self.assertEqual(graph["entities"][0]["id"], "mcp")
        self.assertEqual(self.store.read("B.md").content, originals["B.md"])
        self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [])


class MCPStdioTests(MCPTestCase):
    async def test_initialize_list_tools_and_repeated_full_file_versions(self):
        async with self.stdio_client() as client:
            self.assertIsNotNone(client.protocol_version)
            listed = await client.list_tools()
            self.assertEqual({tool.name for tool in listed.tools},
                             TOOL_NAMES)
            write_tool = next(tool for tool in listed.tools if tool.name == "wiki_write")
            self.assertIn("expected_revision", write_tool.input_schema["required"])

            contents = ["# 안내\r\n첫 내용 🌱\n", "", "셋째 내용"]
            saved = self.payload(await self.write(client, contents[0]))
            self.assertTrue(saved["changed"])
            self.assertIsNone(saved["history_path"])
            self.assertEqual(saved["cleanup_failures"], [])
            versions = []
            for previous, content in zip(contents, contents[1:]):
                read = self.payload(await client.call_tool("wiki_read", {"document": "Guide.md"}))
                self.assertEqual(read["content"], previous)
                self.assertEqual(read["revision"], saved["revision"])
                saved = self.payload(await self.write(client, content, revision=read["revision"]))
                history = Path(saved["history_path"])
                self.assertFalse(history.is_absolute())
                self.assertEqual(history.parts[0], "_history")
                self.assertEqual((self.data / history).read_bytes(), previous.encode("utf-8"))
                versions.append(self.data / history)

            noop = self.payload(await self.write(client, contents[-1], revision=saved["revision"]))
            self.assertFalse(noop["changed"])
            self.assertIsNone(noop["history_path"])
            self.assertEqual(noop["revision"], saved["revision"])
            self.assertEqual(set(self.histories()), set(versions))
            self.assertEqual(self.store.read("Guide.md").content, contents[-1])
            self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [])

    async def test_concurrent_edits_and_new_creates_reject_stale_requests(self):
        async with self.stdio_client() as client:
            original = self.payload(await self.write(client, "original"))
            results = await asyncio.gather(
                self.write(client, "A edit", revision=original["revision"]),
                self.write(client, "B edit", revision=original["revision"]),
            )
            winners = [result for result in results if not result.is_error]
            losers = [result for result in results if result.is_error]
            self.assertEqual((len(winners), len(losers)), (1, 1))
            winner = self.payload(winners[0])
            conflict = self.payload(losers[0], code="conflict")["error"]
            self.assertFalse(conflict["retryable"])
            self.assertEqual(conflict["current_revision"], winner["revision"])
            self.assertEqual([path.read_bytes() for path in self.histories()], [b"original"])
            snapshot = self.store.read("Guide.md")
            self.payload(await self.write(client, snapshot.content,
                                          revision=original["revision"]), code="conflict")
            self.assertEqual(self.store.read("Guide.md"), snapshot)
            self.assertEqual(len(self.histories()), 1)

            creates = await asyncio.gather(
                self.write(client, "new A", document="new.md"),
                self.write(client, "new B", document="new.md"),
            )
            self.assertEqual(sum(not result.is_error for result in creates), 1)
            for result in creates:
                self.payload(result, code="conflict" if result.is_error else None)
            self.assertEqual(len(self.histories()), 1)

    async def test_revision_input_preserves_json_types_before_sdk_preprocessing(self):
        invalid_revisions = (
            "null", " null ", True, False, 0, 1.5, {}, "", "not-a-hash",
            "g" * 64, "A" * 64, "a" * 63, "a" * 65, "a" * 64 + "\n",
        )
        for mode in ("legacy", "auto"):
            with self.subTest(mode=mode):
                document = f"revision-{mode}.md"
                target = self.store.wiki_dir / document
                previous_histories = self.histories()
                async with self.stdio_client(mode=mode) as client:
                    for revision in invalid_revisions:
                        with self.subTest(revision=revision):
                            error = self.payload(await self.write(
                                client, "must not be created", document=document, revision=revision
                            ), code="invalid_argument")["error"]
                            self.assertFalse(error["retryable"])
                            self.assertFalse(target.exists())
                            self.assertEqual(self.histories(), previous_histories)

                    created = self.payload(await self.write(
                        client, "created with JSON null", document=document, revision=None
                    ))
                    snapshot = self.payload(await client.call_tool("wiki_read", {"document": document}))
                    self.assertEqual(snapshot["revision"], created["revision"])
                    updated = self.payload(await self.write(
                        client, "updated with read revision", document=document, revision=snapshot["revision"]
                    ))
                    self.assertEqual(target.read_text(encoding="utf-8"), "updated with read revision")
                    self.assertEqual((self.data / updated["history_path"]).read_text(encoding="utf-8"),
                                     "created with JSON null")
                    self.assertEqual(len(self.histories()), len(previous_histories) + 1)

    async def test_not_found_path_size_and_required_revision_errors(self):
        async with self.stdio_client() as client:
            self.payload(await client.call_tool("wiki_read", {"document": "missing.md"}),
                         code="not_found")
            for document in ("../outside.md", "/absolute.md", "bad.txt"):
                self.payload(await client.call_tool("wiki_read", {"document": document}),
                             code="invalid_argument")
                self.payload(await self.write(client, "unsafe", document=document),
                             code="invalid_argument")
            missing_revision = await client.call_tool("wiki_write", {
                "document": "Guide.md", "content": "no revision",
            })
            self.assertTrue(missing_revision.is_error)
            self.assertFalse((self.store.wiki_dir / "Guide.md").exists())

            original = self.payload(await self.write(client, "original"))
            oversized = self.payload(await self.write(
                client, "가" * (MAX_DOCUMENT_BYTES // 3 + 1), revision=original["revision"]
            ), code="document_too_large")["error"]
            self.assertFalse(oversized["retryable"])
            self.assertEqual(oversized["limit_bytes"], MAX_DOCUMENT_BYTES)
            self.assertEqual(self.store.read("Guide.md").content, "original")
            self.assertEqual(self.histories(), [])

    async def test_lock_timeout_is_retryable_and_preserves_revision_and_history(self):
        original = self.store.save("Guide.md", "original", expected_revision=None)
        async with self.stdio_client() as client:
            with (self.data / ".storage.lock").open("r+b") as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                before = time.monotonic()
                busy = self.payload(await self.write(client, "updated", revision=original.revision),
                                    code="storage_busy")["error"]
                elapsed = time.monotonic() - before
                self.assertTrue(busy["retryable"])
                self.assertGreaterEqual(elapsed, 0.08)
                self.assertLess(elapsed, 3)
                self.assertEqual(self.store.read("Guide.md").content, "original")
                self.assertEqual(self.histories(), [])
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            saved = self.payload(await self.write(client, "updated", revision=original.revision))
            self.assertEqual(self.store.read("Guide.md").revision, saved["revision"])
            self.assertEqual([path.read_bytes() for path in self.histories()], [b"original"])

    async def test_search_current_documents_paths_unicode_and_exclusions(self):
        initial = self.store.save("Guide.md", "history-only-token", expected_revision=None)
        self.store.save("Guide.md", "Current Straße 와 한글 🌱", expected_revision=initial.revision)
        self.store.save("nested/Needle.md", "filename match", expected_revision=None)
        outside = self.root / "outside.md"
        outside.write_text("outside-only-token", encoding="utf-8")
        (self.store.wiki_dir / "external.md").symlink_to(outside)
        (self.store.wiki_dir / "linked-dir").symlink_to(self.root, target_is_directory=True)
        (self.store.wiki_dir / ".wiki-probe.tmp").write_text("temporary-only-token", encoding="utf-8")

        async with self.stdio_client() as client:
            for query, expected in (("STRASSE", "Guide.md"), ("한글", "Guide.md"),
                                    ("needle", "nested/Needle.md")):
                result = self.payload(await client.call_tool("wiki_search", {"query": query}))
                self.assertEqual([match["document"] for match in result["matches"]], [expected])
                match = result["matches"][0]
                self.assertEqual(match["revision"], self.store.read(expected).revision)
                self.assertLessEqual(len(match["snippet"]), 200)
            for query in ("history-only-token", "outside-only-token", "temporary-only-token"):
                result = self.payload(await client.call_tool("wiki_search", {"query": query}))
                self.assertEqual(result["matches"], [])
            self.payload(await client.call_tool("wiki_read", {"document": "external.md"}),
                         code="invalid_argument")

    async def test_auto_negotiation_can_list_and_call_tools(self):
        async with self.stdio_client(mode="auto") as client:
            self.assertIsNotNone(client.protocol_version)
            self.assertEqual({tool.name for tool in (await client.list_tools()).tools}, TOOL_NAMES)
            self.payload(await self.write(client, "auto mode"))
            read = self.payload(await client.call_tool("wiki_read", {"document": "Guide.md"}))
            self.assertEqual(read["content"], "auto mode")


class MCPOntologyTests(MCPTestCase):
    async def test_query_filters_preserve_json_looking_strings_before_sdk_preprocessing(self):
        domains = ["null", "true", "123", "[]", "{}"]
        lines = [f"{domain}: Service uses Policy." for domain in domains]
        source = "\n".join(lines)
        entities = [{"id": label.lower(), "type": "system", "label": label, "evidence": lines[0]}
                    for label in ("Service", "Policy")]
        relations = [{"subject": "service", "predicate": "uses", "object": "policy", "evidence": line,
                      "context": {"domain": domain, "viewpoints": ["developer"]}}
                     for domain, line in zip(domains, lines)]
        async with self.stdio_client() as client:
            saved = self.payload(await self.write(client, source))
            self.payload(await client.call_tool("ontology_generate", {
                "document": "Guide.md", "expected_revision": saved["revision"],
                "entities": entities, "relations": relations,
            }))
            for domain in domains:
                with self.subTest(domain=domain):
                    graph = self.payload(await client.call_tool("ontology_query", {
                        "document": "Guide.md", "domain": domain,
                    }))
                    self.assertEqual(len(graph["relations"]), 1)
                    self.assertEqual(graph["relations"][0]["context"]["domain"], domain)
                    bundle = self.payload(await client.call_tool("ontology_context", {
                        "documents": ["Guide.md"], "domain": domain,
                    }))
                    entry = bundle["documents"][0]
                    self.assertEqual(entry["selection"]["relations"]["focus"], [domains.index(domain)])
                    self.assertEqual(len(entry["ontology"]["relations"]), len(domains))
                    self.assertEqual(entry["source"]["content"], source)
            for filters in ({}, {"domain": "", "viewpoint": ""}):
                graph = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md", **filters}))
                self.assertEqual(len(graph["relations"]), len(domains))
            for field in ("domain", "viewpoint"):
                for value in (None, True, 123, [], {}):
                    self.payload(await client.call_tool("ontology_query", {
                        "document": "Guide.md", field: value,
                    }), code="invalid_argument")
            self.assertTrue((await client.call_tool("ontology_query", {
                "document": "Guide.md", "viewpoint": "null",
            })).is_error)
        self.assertEqual(self.store.read("Guide.md").content, source)
        self.assertEqual(self.histories(), [])

    async def test_stdio_v3_context_attributes_provenance_and_versions(self):
        async with self.stdio_client() as client:
            await self.ontology_v3_flow(client)

    async def test_auto_stdio_context_preserves_source_graph_and_stale_revision(self):
        async with self.stdio_client(mode="auto") as client:
            await self.ontology_v3_flow(client)

    async def test_context_document_list_has_strict_json_types_and_no_implicit_expansion(self):
        async with self.in_process_client() as client:
            source = "공통 정의\n조건은 명시한다. 예외: 승인 취소 시 적용하지 않는다.\n[관련](Other.md)\n"
            saved = self.payload(await self.write(client, source))
            self.payload(await self.write(client, "not requested", document="Other.md"))
            schema = next(tool.input_schema for tool in (await client.list_tools()).tools
                          if tool.name == "ontology_context")
            self.assertEqual(schema["properties"]["documents"]["minItems"], 1)
            self.assertEqual(schema["properties"]["documents"]["maxItems"], 8)
            self.assertTrue({"domain", "viewpoint"} <= set(schema["properties"]))
            before = {path.relative_to(self.data).as_posix(): path.read_bytes()
                      for path in self.data.rglob("*") if path.is_file()}
            for documents in (None, "Guide.md", '["Guide.md"]', {}, [None], [1], [True], [[]]):
                with self.subTest(documents=documents):
                    self.payload(await client.call_tool("ontology_context", {
                        "documents": documents,
                    }), code="invalid_argument")
            for documents in ([], [f"{number}.md" for number in range(9)]):
                self.assertTrue((await client.call_tool("ontology_context", {
                    "documents": documents,
                })).is_error)
            for field in ("domain", "viewpoint"):
                for value in (None, True, 123, [], {}):
                    self.payload(await client.call_tool("ontology_context", {
                        "documents": ["Guide.md"], field: value,
                    }), code="invalid_argument")
            bundle = self.payload(await client.call_tool("ontology_context", {
                "documents": ["Guide.md"],
            }))
            self.assertEqual(bundle["requested_documents"], ["Guide.md"])
            self.assertEqual(bundle["scope"], {"kind": "explicit_documents", "auto_expanded": False})
            self.assertEqual(len(bundle["documents"]), 1)
            self.assertEqual(bundle["documents"][0]["source"]["content"], source)
            self.assertEqual(bundle["documents"][0]["source"]["revision"], saved["revision"])
            self.assertEqual(bundle["documents"][0]["ontology"]["status"], "missing")
            self.assertFalse(bundle["complete"])
            self.assertNotIn("not requested", json.dumps(bundle))
            self.assertEqual({path.relative_to(self.data).as_posix(): path.read_bytes()
                              for path in self.data.rglob("*") if path.is_file()}, before)

    async def test_stdio_v2_qualified_claims_unapproved_candidates_and_preservation(self):
        async with self.stdio_client() as client:
            await self.ontology_v2_flow(client)

    async def test_stdio_document_connections_refresh_without_entity_merging(self):
        async with self.stdio_client() as client:
            await self.connections_flow(client)
            self.payload(await client.call_tool("ontology_connections", {"document": "absent.md"}), code="not_found")
            self.payload(await client.call_tool("ontology_connections", {"document": "../A.md"}), code="invalid_argument")
            for limit in (0, 101, True, "2"):
                self.assertTrue((await client.call_tool("ontology_connections", {"document": "A.md", "limit": limit})).is_error)

    @staticmethod
    def extraction(revision, dependency="MCP"):
        evidence = f"Codex는 {dependency}를 사용한다."
        return {
            "document": "Guide.md", "expected_revision": revision,
            "entities": [
                {"id": "codex", "type": "system", "label": "Codex", "evidence": evidence},
                {"id": "dependency", "type": "concept", "label": dependency, "evidence": evidence},
            ],
            "relations": [{"subject": "codex", "predicate": "uses", "object": "dependency",
                           "evidence": evidence}],
        }

    async def test_stdio_generate_query_source_update_and_regenerate(self):
        async with self.stdio_client() as client:
            first = "# 안내\r\nCodex는 MCP를 사용한다.\r\n"
            saved = self.payload(await self.write(client, first))
            missing = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
            self.assertEqual(missing["status"], "missing")
            generated = self.payload(await client.call_tool("ontology_generate", self.extraction(saved["revision"])))
            self.assertEqual((generated["entity_count"], generated["relation_count"]), (2, 1))
            graph = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
            self.assertEqual(graph["status"], "ready")
            self.assertEqual(graph["source_revision"], saved["revision"])
            self.assertEqual(graph["relations"][0]["evidence"], {
                "quote": "Codex는 MCP를 사용한다.", "start_line": 2, "end_line": 2,
            })
            self.assertEqual(self.histories(), [])

            second = "# 안내\nCodex는 HTTP를 사용한다.\n"
            updated = self.payload(await self.write(client, second, revision=saved["revision"]))
            stale = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
            self.assertEqual(stale["status"], "stale")
            self.assertEqual(stale["entities"], [])
            self.assertEqual(stale["relations"], [])
            self.assertEqual(stale["source_revision"], updated["revision"])
            self.payload(await client.call_tool("ontology_generate", self.extraction(saved["revision"])), code="conflict")
            self.payload(await self.write(client, "stale write", revision=saved["revision"]), code="conflict")
            fresh_read = self.payload(await client.call_tool("wiki_read", {"document": "Guide.md"}))
            self.assertEqual(fresh_read["content"], second)
            self.payload(await client.call_tool("ontology_generate", self.extraction(fresh_read["revision"], "HTTP")))
            graph = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
            self.assertEqual(graph["status"], "ready")
            self.assertEqual([item["label"] for item in graph["entities"]], ["Codex", "HTTP"])
            self.assertEqual([path.read_bytes() for path in self.histories()], [first.encode("utf-8")])
            self.assertEqual(self.store.read("Guide.md").content, second)
            self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [])

    async def test_raw_schema_and_evidence_fail_without_derived_writes(self):
        async with self.stdio_client() as client:
            saved = self.payload(await self.write(client, "Codex는 MCP를 사용한다.\n"))
            for revision in (None, "null", 7, True, "bad"):
                self.payload(await client.call_tool("ontology_generate", self.extraction(revision)), code="invalid_argument")
            invalid = self.extraction(saved["revision"])
            invalid["entities"] = json.dumps(invalid["entities"])
            self.payload(await client.call_tool("ontology_generate", invalid), code="invalid_argument")
            invalid = self.extraction(saved["revision"])
            invalid["relations"][0]["evidence"] = "존재하지 않는 근거"
            self.payload(await client.call_tool("ontology_generate", invalid), code="invalid_ontology")
            invalid = self.extraction(saved["revision"])
            invalid["entities"][0]["unexpected"] = "field"
            self.assertTrue((await client.call_tool("ontology_generate", invalid)).is_error)
            invalid = self.extraction(saved["revision"])
            invalid["relations"][0]["object"] = "missing"
            self.payload(await client.call_tool("ontology_generate", invalid), code="invalid_ontology")
            self.assertFalse((self.data / "_ontology").exists())
            self.assertEqual(self.histories(), [])
            self.payload(await client.call_tool("ontology_query", {"document": "Missing.md"}), code="not_found")
            self.payload(await client.call_tool("ontology_query", {"document": "../Guide.md"}), code="invalid_argument")


class MCPFailureAndSearchTests(MCPTestCase):
    async def test_completed_create_reports_cleanup_failure_as_success(self):
        real_unlink = Path.unlink

        def fail_temporary_unlink(path, *args, **kwargs):
            if path.parent == self.store.wiki_dir and path.name.startswith(".wiki-"):
                raise PermissionError(errno.EACCES, "injected cleanup failure")
            return real_unlink(path, *args, **kwargs)

        async with self.in_process_client() as client:
            with patch.object(Path, "unlink", fail_temporary_unlink):
                saved = self.payload(await self.write(client, "committed"))
            self.assertEqual(self.store.read("Guide.md").revision, saved["revision"])
            self.assertEqual(self.store.read("Guide.md").content, "committed")
            self.assertEqual(len(saved["cleanup_failures"]), 1)
            failure = saved["cleanup_failures"][0]
            self.assertFalse(Path(failure["path"]).is_absolute())
            self.assertTrue((self.data / failure["path"]).exists())
            self.assertEqual(failure["errno"], errno.EACCES)
            self.assertEqual(failure["error_type"], "PermissionError")
            self.payload(await self.write(client, "committed"), code="conflict")

    async def test_completed_history_cleanup_failure_still_commits_update(self):
        original = self.store.save("Guide.md", "original", expected_revision=None)
        real_unlink = Path.unlink

        def fail_history_unlink(path, *args, **kwargs):
            if self.store.history_dir in path.parents and path.name.startswith(".wiki-"):
                raise PermissionError(errno.EACCES, "injected history cleanup failure")
            return real_unlink(path, *args, **kwargs)

        async with self.in_process_client() as client:
            with patch.object(Path, "unlink", fail_history_unlink):
                saved = self.payload(await self.write(client, "updated", revision=original.revision))
            self.assertEqual(self.store.read("Guide.md").content, "updated")
            self.assertEqual((self.data / saved["history_path"]).read_bytes(), b"original")
            self.assertEqual(len(saved["cleanup_failures"]), 1)

    async def test_history_publication_failure_keeps_original(self):
        original = self.store.save("Guide.md", "original", expected_revision=None)
        real_link = os.link

        def fail_history_link(source, target, *args, **kwargs):
            if self.store.history_dir in Path(target).parents:
                raise OSError(errno.ENOSPC, "injected full history device")
            return real_link(source, target, *args, **kwargs)

        async with self.in_process_client() as client:
            with self.assertLogs("core.mcp.results", level="ERROR"), patch(
                "core.modules.documents.store.os.link", side_effect=fail_history_link
            ):
                error = self.payload(await self.write(client, "updated", revision=original.revision),
                                     code="storage_error")["error"]
            self.assertFalse(error["retryable"])
            self.assertEqual(self.store.read("Guide.md").content, "original")
            self.assertEqual(self.store.read("Guide.md").revision, original.revision)
            self.assertEqual(self.histories(), [])
            self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [])

    async def test_save_failure_retains_primary_error_and_cleanup_details(self):
        original = self.store.save("Guide.md", "original", expected_revision=None)
        real_unlink = Path.unlink

        def fail_temporary_unlink(path, *args, **kwargs):
            if self.data in path.parents and path.name.startswith(".wiki-"):
                raise PermissionError(errno.EACCES, "injected cleanup failure")
            return real_unlink(path, *args, **kwargs)

        async with self.in_process_client() as client:
            with self.assertLogs("core.mcp.results", level="ERROR"), \
                patch.object(Path, "unlink", fail_temporary_unlink), patch(
                "core.modules.documents.store.os.replace", side_effect=OSError(errno.ENOSPC, "injected replace failure")
            ):
                error = self.payload(await self.write(client, "updated", revision=original.revision),
                                     code="storage_error")["error"]
            self.assertEqual(error["errno"], errno.ENOSPC)
            self.assertEqual(len(error["cleanup_failures"]), 2)
            self.assertTrue(all(item["errno"] == errno.EACCES for item in error["cleanup_failures"]))
            self.assertEqual(self.store.read("Guide.md").revision, original.revision)
            self.assertEqual([path.read_bytes() for path in self.histories()], [b"original"])

    async def test_search_limit_validation_truncation_and_literal_matching(self):
        for index in range(3):
            self.store.save(f"{index}.md", "literal a.*b", expected_revision=None)
        async with self.in_process_client() as client:
            result = self.payload(await client.call_tool("wiki_search", {"query": "a.*b", "limit": 2}))
            self.assertEqual(len(result["matches"]), 2)
            self.assertTrue(result["truncated"])
            result = self.payload(await client.call_tool("wiki_search", {"query": "a.*b", "limit": 3}))
            self.assertEqual(len(result["matches"]), 3)
            self.assertFalse(result["truncated"])
            self.payload(await client.call_tool("wiki_search", {"query": "   "}),
                         code="invalid_argument")
            for arguments in ({"query": ""}, {"query": "x" * 201},
                              {"query": "x", "limit": 0}, {"query": "x", "limit": 51}):
                self.assertTrue((await client.call_tool("wiki_search", arguments)).is_error)
            # Type errors may be rejected by the SDK's schema before the tool body.
            for value in (True, "2", 1.5):
                result = await client.call_tool("wiki_search", {"query": "x", "limit": value})
                self.assertTrue(result.is_error)

    async def test_oversized_and_invalid_utf8_documents_are_preserved_and_skipped(self):
        large = self.store.wiki_dir / "large.md"
        invalid = self.store.wiki_dir / "invalid.md"
        # Direct fixtures model out-of-band files; application changes use save().
        large.write_bytes(b"x" * (MAX_DOCUMENT_BYTES + 1))
        invalid.write_bytes(b"\xffbad utf8")
        self.store.save("valid.md", "find me", expected_revision=None)
        async with self.in_process_client() as client:
            self.payload(await client.call_tool("wiki_read", {"document": "large.md"}),
                         code="document_too_large")
            self.payload(await self.write(client, "replacement", document="large.md"),
                         code="document_too_large")
            result = self.payload(await client.call_tool("wiki_search", {"query": "find"}))
            self.assertEqual([match["document"] for match in result["matches"]], ["valid.md"])
            skipped = {item["document"]: item["code"] for item in result["skipped"]}
            self.assertEqual(skipped["large.md"], "document_too_large")
            self.assertEqual(skipped["invalid.md"], "invalid_encoding")
            self.assertEqual(large.stat().st_size, MAX_DOCUMENT_BYTES + 1)
            self.assertEqual(invalid.read_bytes(), b"\xffbad utf8")
            self.assertEqual(self.histories(), [])

    async def test_search_scan_file_and_byte_budgets_report_partial_results(self):
        for index in range(3):
            self.store.save(f"{index}.md", "four", expected_revision=None)
        async with self.in_process_client() as client:
            for constant, bound in (("MAX_SEARCH_FILES", 1), ("MAX_SEARCH_BYTES", 4)):
                with self.subTest(constant=constant), patch(f"core.modules.documents.search.{constant}", bound):
                    result = self.payload(await client.call_tool("wiki_search", {"query": "absent"}))
                    self.assertTrue(result["truncated"])
                    self.assertEqual(result["scanned"], 1)
                    self.assertEqual(result["matches"], [])

    async def test_search_skip_budget_stops_after_unreadable_document(self):
        (self.store.wiki_dir / "0.md").write_bytes(b"\xff")
        self.store.save("1.md", "match", expected_revision=None)
        async with self.in_process_client() as client:
            with patch("core.modules.documents.search.MAX_SKIPPED_FILES", 1):
                result = self.payload(await client.call_tool("wiki_search", {"query": "match"}))
            self.assertTrue(result["truncated"])
            self.assertEqual(result["scanned"], 1)
            self.assertEqual(result["skipped"], [{"document": "0.md", "code": "invalid_encoding"}])
            self.assertEqual(result["matches"], [])

    async def test_invalid_utf8_input_reports_error_without_creating_document(self):
        async with self.in_process_client() as client:
            self.payload(await self.write(client, "unpaired surrogate \ud800"), code="invalid_encoding")
            self.assertFalse((self.store.wiki_dir / "Guide.md").exists())
            self.assertEqual(self.histories(), [])


class MCPHTTPTests(MCPTestCase):
    async def test_http_v3_context_attributes_provenance_and_versions(self):
        async with self.http_server() as url:
            async with self.http_client(url, mode="auto") as client:
                await self.ontology_v3_flow(client)

    async def test_http_v2_qualified_claims_unapproved_candidates_and_preservation(self):
        async with self.http_server() as url:
            async with self.http_client(url, mode="auto") as client:
                await self.ontology_v2_flow(client)

    async def test_http_document_connections_refresh_without_entity_merging(self):
        async with self.http_server() as url:
            async with self.http_client(url, mode="auto") as client:
                await self.connections_flow(client)

    def setUp(self):
        super().setUp()
        self.token = secrets.token_urlsafe(32)
        self.auth = {"Authorization": f"Bearer {self.token}"}

    async def test_http_ontology_generation_and_refresh(self):
        async with self.http_server() as url:
            async with self.http_client(url, mode="auto") as client:
                first = self.payload(await self.write(client, "Codex는 MCP를 사용한다.\n"))
                self.payload(await client.call_tool("ontology_generate", MCPOntologyTests.extraction(first["revision"])))
                graph = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
                self.assertEqual(graph["status"], "ready")
                second = self.payload(await self.write(client, "Codex는 HTTP를 사용한다.\n", revision=first["revision"]))
                graph = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
                self.assertEqual((graph["status"], graph["relations"]), ("stale", []))
                self.payload(await client.call_tool("ontology_generate", MCPOntologyTests.extraction(second["revision"], "HTTP")))
                graph = self.payload(await client.call_tool("ontology_query", {"document": "Guide.md"}))
                self.assertEqual(graph["entities"][1]["label"], "HTTP")
                self.assertEqual([path.read_bytes() for path in self.histories()], ["Codex는 MCP를 사용한다.\n".encode()])

    @asynccontextmanager
    async def http_client(self, url, *, transport=None, mode="legacy"):
        async with httpx2.AsyncClient(
            headers=self.auth, transport=transport, timeout=10, trust_env=False
        ) as http:
            async with Client(
                streamable_http_client(url, http_client=http),
                mode=mode, read_timeout_seconds=10,
            ) as client:
                yield client

    @asynccontextmanager
    async def http_server(self):
        # Use an ephemeral loopback port and temporary data, never the user's server.
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        environment = dict(os.environ, LLM_WIKI_TEST_TOKEN=self.token)
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-B", "-m", "core.mcp_server",
            "--data-dir", str(self.data), "--transport", "streamable-http",
            "--port", str(port), "--token-env", "LLM_WIKI_TEST_TOKEN",
            cwd=PROJECT_DIR, env=environment,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        url = f"http://127.0.0.1:{port}/mcp"
        try:
            deadline = time.monotonic() + 10
            async with httpx2.AsyncClient(timeout=0.5, trust_env=False) as http:
                while True:
                    if process.returncode is not None:
                        self.fail(f"HTTP test server exited before readiness: {process.returncode}")
                    try:
                        response = await http.get(url)
                        if response.status_code == 401:
                            break
                    except httpx2.TransportError:
                        pass
                    if time.monotonic() >= deadline:
                        self.fail("HTTP test server did not become ready within 10 seconds")
                    await asyncio.sleep(0.05)
            yield url
        finally:
            if process.returncode is None:
                process.terminate()
            try:
                _, stderr = await asyncio.wait_for(process.communicate(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                _, stderr = await process.communicate()
            self.assertNotIn(self.token.encode(), stderr)

    def file_snapshot(self):
        return {path.relative_to(self.data).as_posix(): path.read_bytes()
                for path in self.data.rglob("*") if path.is_file()}

    def write_request(self):
        return {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "wiki_write", "arguments": {
                "document": "Guide.md", "content": "unauthorized replacement",
                "expected_revision": self.store.read("Guide.md").revision,
            },
        }}

    async def test_real_http_two_clients_conflict_search_and_full_versions(self):
        original = "# 원격 검증\r\n소개: 기본 🌱\n설치: 기본\n"
        async with self.http_server() as url:
            async with httpx2.AsyncClient(headers=self.auth, timeout=2, trust_env=False) as http:
                for method in ("GET", "HEAD", "DELETE", "OPTIONS"):
                    response = await http.request(method, url)
                    self.assertEqual(response.status_code, 405)
                    self.assertEqual(response.headers["allow"], "POST")
                    self.assertNotEqual(response.headers.get("content-type"), "text/event-stream")
            async with self.http_client(url) as a, self.http_client(url, mode="auto") as b:
                listed = await a.list_tools()
                self.assertEqual({tool.name for tool in listed.tools},
                                 TOOL_NAMES)
                created = self.payload(await self.write(a, original))
                self.assertIsNone(created["history_path"])
                bases = await asyncio.gather(
                    a.call_tool("wiki_read", {"document": "Guide.md"}),
                    b.call_tool("wiki_read", {"document": "Guide.md"}),
                )
                for base in bases:
                    self.assertEqual(self.payload(base)["content"], original)
                    self.assertEqual(self.payload(base)["revision"], created["revision"])
                edits = [original.replace("소개: 기본", "소개: A 수정"),
                         original.replace("설치: 기본", "설치: B 수정")]
                results = await asyncio.gather(
                    self.write(a, edits[0], revision=created["revision"]),
                    self.write(b, edits[1], revision=created["revision"]),
                )
                winners = [index for index, result in enumerate(results) if not result.is_error]
                self.assertEqual(len(winners), 1)
                winner_index = winners[0]
                winner = self.payload(results[winner_index])
                conflict = self.payload(results[1 - winner_index], code="conflict")["error"]
                self.assertEqual(conflict["current_revision"], winner["revision"])
                self.assertEqual([path.read_bytes() for path in self.histories()],
                                 [original.encode("utf-8")])
                latest = self.payload(await b.call_tool("wiki_read", {"document": "Guide.md"}))
                self.assertEqual(latest["content"], edits[winner_index])
                merged = latest["content"].replace("소개: 기본", "소개: A 수정").replace(
                    "설치: 기본", "설치: B 수정"
                )
                saved = self.payload(await self.write(b, merged, revision=latest["revision"]))
                self.assertEqual(saved["cleanup_failures"], [])
                read = self.payload(await a.call_tool("wiki_read", {"document": "Guide.md"}))
                self.assertEqual(read["content"], merged)
                self.assertEqual(read["revision"], saved["revision"])
                searched = self.payload(await b.call_tool("wiki_search", {"query": "A 수정"}))
                self.assertEqual([entry["document"] for entry in searched["matches"]], ["Guide.md"])
                self.assertEqual(searched["matches"][0]["revision"], saved["revision"])
                self.assertFalse(searched["truncated"])
                self.assertEqual(searched["skipped"], [])
                paths = [self.data / winner["history_path"], self.data / saved["history_path"]]
                self.assertEqual([path.read_bytes() for path in paths],
                                 [original.encode("utf-8"), edits[winner_index].encode("utf-8")])
                self.assertEqual(set(self.histories()), set(paths))
                self.assertEqual((self.store.wiki_dir / "Guide.md").read_bytes(), merged.encode("utf-8"))
                self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [])

    async def test_missing_wrong_and_duplicate_auth_cannot_change_data(self):
        original = self.store.save("Guide.md", "original", expected_revision=None)
        self.store.save("Guide.md", "current", expected_revision=original.revision)
        before = self.file_snapshot()
        app = create_http_app(self.store, self.token)
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="http://127.0.0.1:8765"
        ) as http:
            invalid_headers = [
                [], [("Authorization", "Bearer " + "x" * 43)],
                [("Authorization", f"Basic {self.token}")],
                [("Authorization", f"Bearer {self.token}"),
                 ("Authorization", f"Bearer {self.token}")],
            ]
            for headers in invalid_headers:
                response = await http.post("/mcp", headers=headers, json=self.write_request())
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.headers["www-authenticate"], "Bearer")
                self.assertNotIn(self.token, response.text)
                self.assertEqual(self.file_snapshot(), before)
            for method, path in (("GET", "/mcp"), ("DELETE", "/mcp"), ("GET", "/")):
                response = await http.request(method, path)
                self.assertEqual(response.status_code, 401)
            # Authentication precedes both SDK validation and the early 405 path.
            for method in ("POST", "GET", "DELETE"):
                for headers in ({"Host": "attacker.example"},
                                {"Origin": "https://attacker.example"}):
                    response = await http.request(method, "/mcp", headers=headers,
                                                  json=self.write_request())
                    self.assertEqual(response.status_code, 401)
        self.assertEqual(self.file_snapshot(), before)

    async def test_valid_token_does_not_bypass_host_or_origin_checks(self):
        self.store.save("Guide.md", "original", expected_revision=None)
        before = self.file_snapshot()
        app = create_http_app(self.store, self.token)
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
                headers=self.auth,
            ) as http:
                for method in ("POST", "GET", "DELETE"):
                    for headers, status in (({"Host": "attacker.example"}, 421),
                                            ({"Origin": "https://attacker.example"}, 403)):
                        with self.assertLogs("mcp.server.transport_security", level="WARNING"):
                            response = await http.request(method, "/mcp", headers=headers,
                                                          json=self.write_request())
                        self.assertEqual(response.status_code, status)
                        self.assertEqual(self.file_snapshot(), before)

    async def test_body_limit_rejects_declared_and_streamed_oversize_without_writes(self):
        self.store.save("Guide.md", "original", expected_revision=None)
        before = self.file_snapshot()
        app = create_http_app(self.store, self.token)
        async with app.router.lifespan_context(app):
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
                headers=self.auth,
            ) as http:
                declared = await http.post("/mcp", content=b"", headers={
                    "Content-Length": str(MAX_HTTP_REQUEST_BYTES + 1),
                    "Content-Type": "application/json",
                })
                self.assertEqual(declared.status_code, 413)

                async def chunks():
                    for _ in range(MAX_HTTP_REQUEST_BYTES // (1024 * 1024) + 1):
                        yield b" " * (1024 * 1024)

                streamed = await http.post("/mcp", content=chunks(),
                                           headers={"Content-Type": "application/json"})
                self.assertEqual(streamed.status_code, 413)
        self.assertEqual(self.file_snapshot(), before)

    async def test_document_byte_limit_accepts_json_escaping_and_rejects_oversize(self):
        app = create_http_app(self.store, self.token)
        async with app.router.lifespan_context(app):
            async with self.http_client("http://127.0.0.1:8765/mcp",
                                        transport=httpx2.ASGITransport(app=app)) as client:
                # Each one-byte control character occupies six bytes in JSON.
                content = "\x01" * MAX_DOCUMENT_BYTES
                saved = self.payload(await self.write(client, content))
                before = self.file_snapshot()
                self.payload(await self.write(client, content + "x", revision=saved["revision"]),
                             code="document_too_large")
                self.assertEqual(self.file_snapshot(), before)
                self.assertEqual((self.store.wiki_dir / "Guide.md").read_bytes(), content.encode())
                self.assertEqual(self.histories(), [])

    async def test_invalid_token_stops_startup_before_creating_store_and_never_echoes_value(self):
        for value in (None, "", "short-secret-test-value", "contains whitespace " * 3):
            with self.subTest(kind="missing" if value is None else "invalid"):
                data = self.root / "startup-data"
                data.mkdir(exist_ok=True)
                environment = dict(os.environ)
                environment.pop("LLM_WIKI_TEST_TOKEN", None)
                if value is not None:
                    environment["LLM_WIKI_TEST_TOKEN"] = value
                process = await asyncio.create_subprocess_exec(
                    sys.executable, "-B", "-m", "core.mcp_server", "--transport", "streamable-http",
                    "--data-dir", str(data), "--token-env", "LLM_WIKI_TEST_TOKEN",
                    cwd=PROJECT_DIR, env=environment,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                try:
                    stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                self.assertEqual(process.returncode, 2)
                self.assertIn(b"HTTP token", stderr)
                self.assertEqual(stdout, b"")
                if value:
                    self.assertNotIn(value.encode(), stderr)
                self.assertEqual(list(data.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
