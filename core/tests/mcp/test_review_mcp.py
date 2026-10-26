"""Authenticated review contracts using isolated synthetic data and real transports.

These scripted decisions exercise persistence and authorization, not human
approval of real documents or a new LLM extraction accuracy evaluation.
"""

import asyncio
from copy import deepcopy
import errno
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from mcp import Client

from core.mcp_server import create_server
from core.tests.modules.test_context import context_fixture
import core.tests.mcp.test_tenant_mcp as tenant_helpers


REVIEW_TOOLS = {"ontology_review_query", "ontology_review", "ontology_review_undo"}
POLICY_TOOLS = {"ontology_policy", "ontology_policy_undo"}


class ReviewMCPTests(unittest.IsolatedAsyncioTestCase):
    # Reuse the established isolated policy and transport setup without inheriting
    # its test methods (which would run the existing regression suite twice).
    save_policy = tenant_helpers.TenantMCPTests.save_policy
    client = tenant_helpers.TenantMCPTests.client
    payload = tenant_helpers.TenantMCPTests.payload
    snapshot = tenant_helpers.TenantMCPTests.snapshot
    write = tenant_helpers.TenantMCPTests.write
    stdio_client = tenant_helpers.TenantMCPTests.stdio_client
    http_client = tenant_helpers.TenantMCPTests.http_client
    http_server = tenant_helpers.TenantMCPTests.http_server

    def setUp(self):
        tenant_helpers.TenantMCPTests.setUp(self)
        for user, tenant in (("alice", "acme"), ("eve", "beta")):
            self.config["users"][user]["memberships"][tenant]["permissions"].append("ontology_review")
        self.save_policy()

    async def seed(self, client, *, tenant="acme"):
        source, entities, relations, candidates, attributes = context_fixture()
        source = f"{tenant}-review-private-marker\n" + source
        # Deliberately wrong AI typing, corrected later by a scripted reviewer.
        attributes[0].update(datatype="text", value="20 리터", unit=None)
        relations[2]["predicate"] = "same_as"
        saved = self.payload(await self.write(client, source, tenant=tenant))
        request = {
            "tenant": tenant, "document": "Guide.md", "expected_revision": saved["revision"],
            "entities": entities, "relations": relations,
            "relation_candidates": candidates, "attributes": attributes,
        }
        self.payload(await client.call_tool("ontology_generate", request))
        return source, saved, request

    async def query(self, client, *, tenant="acme", profile=None):
        arguments = {"tenant": tenant, "document": "Guide.md"}
        if profile is not None:
            arguments["profile"] = profile
        return self.payload(await client.call_tool("ontology_review_query", arguments))

    def claim(self, result, collection, index=0):
        return [item for item in result["claims"] if item["collection"] == collection][index]

    def review_request(self, state, *, action="accept", collection="relations", index=0,
                       tenant="acme", profile=None, replacement=None):
        result = {
            "tenant": tenant, "document": "Guide.md", "action": action,
            "claim_id": self.claim(state, collection, index)["claim_id"],
            "expected_state_revision": state["state_revision"],
            "reason": "isolated test simulation: inspect original evidence",
        }
        if profile is not None:
            result["profile"] = profile
        if replacement is not None:
            result["replacement"] = replacement
        return result

    async def decide(self, client, state, **kwargs):
        return self.payload(await client.call_tool("ontology_review", self.review_request(state, **kwargs)))

    def denied_requests(self, tenant):
        return {
            "ontology_review_query": {"tenant": tenant, "document": "Guide.md"},
            "ontology_review": {
                "tenant": tenant, "document": "Guide.md", "action": "accept",
                "claim_id": "a" * 64, "expected_state_revision": "b" * 64, "reason": "simulation",
            },
            "ontology_review_undo": {
                "tenant": tenant, "document": "Guide.md", "event_id": "unknown",
                "expected_state_revision": "b" * 64, "reason": "simulation",
            },
        }

    async def test_review_tools_are_authenticated_only_and_actor_is_not_an_argument(self):
        async with self.client() as client:
            definitions = {tool.name: tool for tool in (await client.list_tools()).tools}
            self.assertTrue(REVIEW_TOOLS | POLICY_TOOLS <= definitions.keys())
            for name in REVIEW_TOOLS | POLICY_TOOLS:
                schema = definitions[name].input_schema
                self.assertIn("tenant", schema["required"])
                self.assertIn("profile", schema["properties"])
                self.assertFalse(schema["additionalProperties"])
                for forbidden in ("actor", "user_id", "permissions", "domain", "viewpoint"):
                    self.assertNotIn(forbidden, schema["properties"])
            self.assertTrue(definitions["ontology_review_query"].annotations.read_only_hint)
            for name in (REVIEW_TOOLS | POLICY_TOOLS) - {"ontology_review_query"}:
                self.assertFalse(definitions[name].annotations.read_only_hint)
        async with Client(create_server(self.stores["acme"]), mode="legacy") as legacy:
            self.assertTrue((REVIEW_TOOLS | POLICY_TOOLS).isdisjoint({tool.name for tool in (await legacy.list_tools()).tools}))

    async def test_readers_and_writers_need_separate_review_permission(self):
        async with self.client() as reviewer, self.client("bob") as reader, self.client("bridge") as writer:
            await self.seed(reviewer)
            state = await self.query(reviewer)
            before = self.snapshot()
            for client in (reader, writer):
                viewed = await self.query(client)
                self.assertEqual(viewed["state_revision"], state["state_revision"])
                self.payload(await client.call_tool("ontology_review", self.review_request(state)), code="access_denied")
                self.payload(await client.call_tool("ontology_review_undo", self.denied_requests("acme")["ontology_review_undo"]), code="access_denied")
            self.assertEqual(before, self.snapshot())
            # Review authority alone does not grant source or graph generation rights.
            self.config["users"]["bob"]["memberships"]["acme"]["permissions"] = ["read", "ontology_review"]
            self.save_policy()
            await self.decide(reader, state)
            self.payload(await self.write(reader, "unauthorized"), code="access_denied")
            self.payload(await reader.call_tool("ontology_generate", {
                "tenant": "acme", "document": "Guide.md", "expected_revision": state["source_revision"],
                "entities": [], "relations": [],
            }), code="access_denied")

    async def test_other_tenant_and_absent_tenant_are_denied_before_store_access(self):
        async with self.client() as alice, self.client("eve") as eve:
            await self.seed(eve, tenant="beta")
            before = self.snapshot()
            with patch("core.modules.access.policy.WikiStore", side_effect=AssertionError("unauthorized data access")):
                for name in REVIEW_TOOLS:
                    present = self.payload(await alice.call_tool(name, self.denied_requests("beta")[name]), code="access_denied")
                    absent = self.payload(await alice.call_tool(name, self.denied_requests("absent")[name]), code="access_denied")
                    self.assertEqual(present, absent)
                    for hidden in ("beta", "Guide.md", "private-marker", str(self.tenant_root)):
                        self.assertNotIn(hidden, json.dumps(present))
            self.assertEqual(self.snapshot(), before)

    async def test_forged_actor_profile_fields_and_untyped_tokens_never_mutate(self):
        async with self.client() as client:
            await self.seed(client)
            state = await self.query(client)
            before = self.snapshot()
            for field, value in (("actor", {"user_id": "eve"}), ("user_id", "eve"),
                                 ("permissions", ["ontology_review"]), ("domain", "secret"),
                                 ("viewpoint", "business")):
                self.payload(await client.call_tool("ontology_review", {
                    **self.review_request(state), field: value,
                }), code="invalid_argument")
            for value in (None, 123, True, ["a" * 64], "not-a-revision"):
                self.payload(await client.call_tool("ontology_review", {
                    **self.review_request(state), "expected_state_revision": value,
                }), code="invalid_argument")
            self.payload(await client.call_tool("ontology_review", {
                **self.review_request(state), "profile": "unlisted",
            }), code="access_denied")
            self.assertEqual(self.snapshot(), before)

    async def test_revoked_review_permission_and_changed_policy_apply_to_warm_client(self):
        async with self.client() as client:
            await self.seed(client)
            state = await self.query(client)
            decision_result = await self.decide(client, state, profile="developer")
            self.assertEqual(decision_result["selection"]["viewpoint"], "developer")
            self.assertEqual(decision_result["access"]["viewpoint"], "developer")
            reviewed = await self.query(client)
            event = reviewed["history"][-1]
            actor = event["actor"]
            self.assertEqual(actor["user_id"], "alice")
            self.assertEqual(actor["tenant"], "acme")
            self.assertEqual(actor["profile_id"], "developer")
            self.assertEqual(actor["viewpoint"], "developer")
            self.assertEqual(actor["policy_revision"], hashlib.sha256(self.config_path.read_bytes()).hexdigest())
            original_event = deepcopy(event)
            membership = self.config["users"]["alice"]["memberships"]["acme"]
            membership["permissions"].remove("ontology_review")
            self.config["tenants"]["acme"]["profiles"]["developer"]["domain"] = "changed-domain"
            self.save_policy()
            before = self.snapshot()
            self.payload(await client.call_tool("ontology_review", self.review_request(reviewed)), code="access_denied")
            self.payload(await client.call_tool("ontology_review_undo", {
                **self.denied_requests("acme")["ontology_review_undo"],
                "expected_state_revision": reviewed["state_revision"],
            }), code="access_denied")
            latest = await self.query(client, profile="developer")
            self.assertEqual(latest["history"][-1], original_event)
            self.assertEqual(latest["access"]["domain"], "changed-domain")
            self.assertNotEqual(latest["access"]["policy_revision"], actor["policy_revision"])
            self.assertEqual(self.snapshot(), before)

    async def test_two_clients_compete_on_review_state_and_only_one_commits(self):
        self.config["users"]["bob"]["memberships"]["acme"]["permissions"].append("ontology_review")
        self.save_policy()
        async with self.client() as first, self.client("bob") as second:
            await self.seed(first)
            state = await self.query(first)
            replies = await asyncio.gather(
                first.call_tool("ontology_review", self.review_request(state, action="accept")),
                second.call_tool("ontology_review", self.review_request(state, action="reject")),
            )
            successes = [reply for reply in replies if not reply.is_error]
            failures = [reply for reply in replies if reply.is_error]
            self.assertEqual(len(successes), 1)
            self.assertEqual(len(failures), 1)
            self.payload(successes[0])
            self.payload(failures[0], code="conflict")
            current = await self.query(first)
            self.assertEqual(len(current["history"]), 1)
            winner = "alice" if not replies[0].is_error else "bob"
            self.assertEqual(current["history"][0]["actor"]["user_id"], winner)
            self.assertEqual(current["source_revision"], state["source_revision"])
            self.assertEqual(current["graph_revision"], state["graph_revision"])
            self.assertNotEqual(current["state_revision"], state["state_revision"])

    async def test_competing_machine_generation_and_review_share_state_cas(self):
        async with self.client() as editor, self.client() as generator:
            _, _, request = await self.seed(editor)
            state = await self.query(editor)
            regenerated = {**request, "relations": list(reversed(request["relations"])),
                           "expected_state_revision": state["state_revision"]}
            replies = await asyncio.gather(
                editor.call_tool("ontology_review", self.review_request(state, action="reject")),
                generator.call_tool("ontology_generate", regenerated),
            )
            self.assertEqual(sum(not reply.is_error for reply in replies), 1)
            for reply in replies:
                self.payload(reply, code="conflict" if reply.is_error else None)
            current = await self.query(editor)
            self.assertNotEqual(current["state_revision"], state["state_revision"])
            if replies[0].is_error:
                self.assertEqual(current["history"], [])
                self.assertNotEqual(current["graph_revision"], state["graph_revision"])
            else:
                self.assertEqual(len(current["history"]), 1)
                self.assertEqual(current["graph_revision"], state["graph_revision"])

    async def test_relation_correction_keeps_source_qualifiers_and_supports_audited_undo(self):
        async with self.client() as client:
            source, _, _ = await self.seed(client)
            state = await self.query(client)
            replacement = deepcopy(self.claim(state, "relations", 2)["value"])
            replacement["evidence"] = replacement["evidence"]["quote"]
            replacement["predicate"] = "view_of"
            await self.decide(client, state, action="edit", index=2, replacement=replacement)
            edited = await self.query(client)
            self.assertEqual(edited["machine_graph"]["relations"][2]["predicate"], "same_as")
            effective = edited["effective_graph"]["relations"]
            self.assertEqual(effective[2]["predicate"], "view_of")
            self.assertEqual(effective[2]["qualifiers"]["scope"], "읽기 전용")
            self.assertEqual(effective[1]["qualifiers"]["condition"], "재고가 10개 이상일 때")
            self.assertEqual(effective[1]["qualifiers"]["scope"], "단 예약상품은 제외한다")
            self.assertEqual(self.stores["acme"].read("Guide.md").content, source)
            switched = await self.query(client, profile="developer")
            self.assertEqual(switched["effective_graph"], edited["effective_graph"])
            self.assertEqual(switched["history"], edited["history"])
            undo_result = self.payload(await client.call_tool("ontology_review_undo", {
                "tenant": "acme", "document": "Guide.md", "event_id": edited["history"][-1]["id"],
                "profile": "developer",
                "expected_state_revision": edited["state_revision"], "reason": "simulation: restore prior extraction",
            }))
            self.assertEqual(undo_result["selection"]["viewpoint"], "developer")
            undone = await self.query(client)
            self.assertEqual(undone["effective_graph"]["relations"][2]["predicate"], "same_as")
            self.assertEqual([event["action"] for event in undone["history"]], ["edit", "undo"])

    async def test_review_failure_and_source_history_failure_keep_all_prior_bytes(self):
        async with self.client() as alice, self.client("eve") as eve:
            source, saved, _ = await self.seed(alice)
            _, beta_saved, _ = await self.seed(eve, tenant="beta")
            state = await self.query(alice)
            await self.decide(alice, state)
            reviewed = await self.query(alice)
            before = self.snapshot("acme")
            with patch("core.modules.reviews.store.ReviewStore._commit_locked",
                       side_effect=OSError(errno.ENOSPC, "injected review history storage full")):
                with self.assertLogs("core.mcp.results", level="ERROR"):
                    self.payload(await alice.call_tool("ontology_review", self.review_request(
                        reviewed, action="reject", index=1,
                    )), code="storage_error")
            self.assertEqual(self.snapshot("acme"), before)
            real_link = os.link

            def fail_acme_history(source_path, target, *args, **kwargs):
                if self.stores["acme"].history_dir in Path(target).parents:
                    raise OSError(errno.ENOSPC, "injected source history storage full")
                return real_link(source_path, target, *args, **kwargs)

            with patch("core.modules.documents.store.os.link", side_effect=fail_acme_history):
                with self.assertLogs("core.mcp.results", level="ERROR"):
                    self.payload(await self.write(alice, source + "failed write", revision=saved["revision"]),
                                 code="storage_error")
                beta = self.payload(await self.write(eve, "other tenant still writable", tenant="beta",
                                                     revision=beta_saved["revision"]))
            self.assertIsNotNone(beta["history_path"])
            self.assertEqual(self.snapshot("acme"), before)
            final = await self.query(alice)
            self.assertEqual(final["history"], reviewed["history"])
            self.assertEqual(final["effective_graph"], reviewed["effective_graph"])
            self.assertEqual(final["state_revision"], reviewed["state_revision"])
            self.assertEqual(list(self.tenant_root.rglob(".wiki-*.tmp")), [])

    async def test_missing_read_permission_invalidates_review_policy_without_fallback(self):
        async with self.client() as client:
            await self.seed(client)
            self.config["users"]["alice"]["memberships"]["acme"]["permissions"] = ["ontology_review"]
            self.save_policy()
            before = self.snapshot()
            for name, arguments in self.denied_requests("acme").items():
                self.payload(await client.call_tool(name, arguments), code="access_unavailable")
            self.assertEqual(self.snapshot(), before)

    async def review_flow(self, client):
        """All actions, undo, source histories and re-extraction via MCP tools."""
        source, saved, request = await self.seed(client)
        initial = await self.query(client)
        for key in ("source_revision", "graph_revision", "state_revision"):
            self.assertRegex(initial[key], r"^[0-9a-f]{64}$")
        await self.decide(client, initial, action="accept", profile="developer")
        accepted = await self.query(client)
        self.assertEqual(self.claim(accepted, "relations")["decision"], "accept")
        attribute = deepcopy(self.claim(accepted, "attributes")["value"])
        attribute["evidence"] = attribute["evidence"]["quote"]
        attribute.update(datatype="number", value="20", unit="리터")
        await self.decide(client, accepted, action="edit", collection="attributes", replacement=attribute)
        edited = await self.query(client)
        self.assertEqual(edited["machine_graph"]["attributes"][0]["datatype"], "text")
        self.assertEqual(edited["effective_graph"]["attributes"][0]["datatype"], "number")
        self.assertEqual(edited["effective_graph"]["attributes"][0]["value"], "20")
        self.assertEqual(edited["effective_graph"]["attributes"][0]["unit"], "리터")
        await self.decide(client, edited, action="reject", index=1)
        rejected = await self.query(client)
        rejected_event = rejected["history"][-1]["id"]
        self.assertEqual(len(rejected["effective_graph"]["relations"]), 3)
        self.assertEqual(len(rejected["machine_graph"]["relations"]), 4)
        await self.decide(client, rejected, action="defer", collection="relation_candidates")
        deferred = await self.query(client)
        self.assertEqual(self.claim(deferred, "relation_candidates")["decision"], "defer")
        self.payload(await client.call_tool("ontology_review_undo", {
            "tenant": "acme", "document": "Guide.md", "event_id": rejected_event,
            "expected_state_revision": deferred["state_revision"], "reason": "simulation: withdraw this rejection",
        }))
        undone = await self.query(client)
        self.assertEqual(len(undone["effective_graph"]["relations"]), 4)
        self.assertEqual([event["action"] for event in undone["history"]],
                         ["accept", "edit", "reject", "defer", "undo"])
        self.assertEqual(undone["history"][-1]["undo_of"], rejected_event)
        self.assertEqual(self.claim(undone, "relations", 1)["decision"], "unreviewed")
        for event in undone["history"]:
            self.assertTrue(event["reason"])
            self.assertTrue(event["timestamp"])
            self.assertEqual(event["actor"]["user_id"], "alice")
            self.assertEqual(event["actor"]["tenant"], "acme")
            self.assertIn("decision", event["before"])
            self.assertIn("decision", event["after"])
        preserved_history = deepcopy(undone["history"])
        # Human decisions cannot be silently overwritten by a legacy generation call.
        self.payload(await client.call_tool("ontology_generate", request), code="conflict")
        self.assertEqual((await self.query(client))["history"], preserved_history)
        second_text = source + "검토 후 원문 추가 1\n"
        second = self.payload(await self.write(client, second_text, revision=saved["revision"]))
        third_text = second_text + "검토 후 원문 추가 2\n"
        third = self.payload(await self.write(client, third_text, revision=second["revision"]))
        root = self.stores["acme"].data_dir
        self.assertEqual((root / second["history_path"]).read_bytes(), source.encode())
        self.assertEqual((root / third["history_path"]).read_bytes(), second_text.encode())
        self.payload(await self.write(client, "outdated source", revision=saved["revision"]), code="conflict")
        stale = await self.query(client)
        self.assertEqual(stale["machine_graph"]["status"], "stale")
        self.assertEqual(stale["history"], preserved_history)
        self.assertTrue(stale["needs_review"])
        self.payload(await client.call_tool("ontology_review", self.review_request(undone)), code="conflict")
        self.payload(await client.call_tool("ontology_generate", {
            **request, "expected_revision": third["revision"],
            "expected_state_revision": stale["state_revision"],
        }))
        refreshed = await self.query(client)
        self.assertEqual(refreshed["source_revision"], third["revision"])
        self.assertEqual(refreshed["history"], preserved_history)
        self.assertTrue(refreshed["needs_review"])
        self.assertEqual(self.claim(refreshed, "attributes")["decision"], "unreviewed")
        self.assertEqual(refreshed["effective_graph"]["attributes"][0]["datatype"], "text")
        read = self.payload(await client.call_tool("wiki_read", {"tenant": "acme", "document": "Guide.md"}))
        self.assertEqual(read["content"], third_text)
        search = self.payload(await client.call_tool("wiki_search", {"tenant": "acme", "query": "검토 후 원문"}))
        self.assertEqual([item["document"] for item in search["matches"]], ["Guide.md"])
        self.assertEqual(list(self.tenant_root.rglob(".wiki-*.tmp")), [])

    async def test_review_actions_undo_and_reextraction_in_process(self):
        async with self.client() as client:
            await self.review_flow(client)

    async def test_actual_stdio_review_undo_reextraction_and_full_source_versions(self):
        async with self.stdio_client(mode="auto") as client:
            await self.review_flow(client)

    async def test_actual_http_review_undo_and_tenant_isolation(self):
        async with self.http_server() as url:
            async with self.http_client(url, mode="auto") as client, self.http_client(url, "eve") as eve:
                await self.review_flow(client)
                await self.seed(eve, tenant="beta")
                for name in REVIEW_TOOLS:
                    self.payload(await eve.call_tool(name, self.denied_requests("acme")[name]), code="access_denied")
                beta = await self.query(eve, tenant="beta")
                await self.decide(eve, beta, tenant="beta")
                self.assertEqual((await self.query(eve, tenant="beta"))["history"][-1]["actor"]["user_id"], "eve")

    def grant_policy(self, user="alice", tenant="acme"):
        member = self.config["users"][user]["memberships"][tenant]
        if "ontology_policy" not in member["permissions"]:
            member["permissions"].append("ontology_policy")
        self.save_policy()

    def policy_request(self, state, *, collection="relations", index=0, profile="business",
                       tenant="acme", new_entity=False):
        claim = self.claim(state, collection, index)
        replacement = deepcopy(claim["value"])
        replacement.pop("evidence", None)
        replacement.pop("provenance", None)
        replacement["context"] = {"domain": None, "viewpoints": [profile] if profile != "all" else []}
        replacement["qualifiers"] = {
            "polarity": "positive", "modality": "asserted", "condition": "계약 검토 완료 시",
            "scope": "isolated simulation: 프로젝트 정책", "time": "2026년 PoC",
        }
        result = {
            "tenant": tenant, "document": "Guide.md", "profile": profile,
            "claim_id": claim["claim_id"], "expected_state_revision": state["state_revision"],
            "reason": "isolated simulation: authorized expert business decision without a source quote",
            "replacement": replacement,
        }
        if collection == "attributes":
            replacement.update(datatype="number", value="35", unit="리터")
        elif new_entity:
            replacement["object"] = "expert_class"
            result["entities"] = [{"id": "expert_class", "type": "concept", "label": "전문가 정책 분류"}]
        else:
            replacement["predicate"] = "related_to"
        return result

    def undo_policy_request(self, state, event_id, *, profile="business", tenant="acme"):
        return {
            "tenant": tenant, "document": "Guide.md", "profile": profile,
            "event_id": event_id, "expected_state_revision": state["state_revision"],
            "reason": "isolated simulation: withdraw expert policy",
        }

    async def impact_from(self, client, state):
        baseline = tenant_helpers.TenantMCPTests.impact_baseline(state)
        return self.payload(await client.call_tool("ontology_impact", {
            "tenant": "acme", "document": "Guide.md", "profile": "business", "baseline": baseline,
        }))

    async def test_expert_authority_is_independent_and_revocation_rechecks_warm_client(self):
        async with self.client() as reviewer, self.client("bob") as reader, self.client("bridge") as writer:
            await self.seed(reviewer)
            initial = await self.query(reviewer)
            before = self.snapshot()
            for client in (reviewer, reader, writer):
                self.payload(await client.call_tool("ontology_policy", self.policy_request(initial)), code="access_denied")
                self.payload(await client.call_tool("ontology_policy_undo", self.undo_policy_request(initial, "a" * 32)), code="access_denied")
            self.assertEqual(before, self.snapshot())
            self.grant_policy("bob")
            applied = self.payload(await reader.call_tool("ontology_policy", self.policy_request(initial)))
            self.assertEqual(applied["history"][-1]["actor"]["user_id"], "bob")
            self.payload(await reader.call_tool("ontology_review", self.review_request(applied)), code="access_denied")
            self.payload(await self.write(reader, "forbidden"), code="access_denied")
            self.config["users"]["bob"]["memberships"]["acme"]["permissions"].remove("ontology_policy")
            self.save_policy()
            before = self.snapshot()
            self.payload(await reader.call_tool("ontology_policy", self.policy_request(applied)), code="access_denied")
            self.payload(await reader.call_tool("ontology_policy_undo", self.undo_policy_request(applied, applied["event_id"])), code="access_denied")
            self.assertEqual(before, self.snapshot())

    async def test_expert_scope_actor_and_json_forgery_fail_without_writes(self):
        self.grant_policy()
        async with self.client() as client:
            await self.seed(client)
            state = await self.query(client)
            request = self.policy_request(state, new_entity=True)
            before = self.snapshot()
            for field, value in (("actor", {"user_id": "eve"}), ("user_id", "eve"),
                                 ("permissions", ["ontology_policy"]), ("domain", "secret"),
                                 ("viewpoint", "architecture"), ("timestamp", "forged")):
                self.payload(await client.call_tool("ontology_policy", {**request, field: value}), code="invalid_argument")
            for field, values in (("expected_state_revision", [None, 1, True, "null"]),
                                  ("replacement", [None, "{}", []]),
                                  ("entities", ["[]", {}, ["{}"]])):
                for value in values:
                    self.payload(await client.call_tool("ontology_policy", {**request, field: value}), code="invalid_argument")
            for context in ({"domain": "forged-domain", "viewpoints": ["business"]},
                            {"domain": None, "viewpoints": ["developer"]}):
                forged = deepcopy(request)
                forged["replacement"]["context"] = context
                self.payload(await client.call_tool("ontology_policy", forged), code="invalid_review")
            for field, value in (("evidence", "invented quote"), ("provenance", {"kind": "expert_policy"})):
                forged = deepcopy(request)
                forged["replacement"][field] = value
                self.payload(await client.call_tool("ontology_policy", forged), code="invalid_review")
            self.payload(await client.call_tool("ontology_policy", {**request, "profile": "unlisted"}), code="access_denied")
            with patch("core.modules.access.policy.WikiStore", side_effect=AssertionError("unauthorized data access")):
                for name, arguments in (
                    ("ontology_policy", request),
                    ("ontology_policy_undo", self.undo_policy_request(state, "a" * 32)),
                ):
                    foreign = self.payload(await client.call_tool(name, {**arguments, "tenant": "beta"}), code="access_denied")
                    absent = self.payload(await client.call_tool(name, {**arguments, "tenant": "absent"}), code="access_denied")
                    self.assertEqual(foreign, absent)
            self.assertEqual(before, self.snapshot())

    async def test_expert_updates_compete_on_same_state_and_preserve_failed_undo(self):
        self.grant_policy()
        self.grant_policy("bob")
        async with self.client() as alice, self.client("bob") as bob:
            await self.seed(alice)
            state = await self.query(alice)
            replies = await asyncio.gather(
                alice.call_tool("ontology_policy", self.policy_request(state, new_entity=True)),
                bob.call_tool("ontology_policy", self.policy_request(state)),
            )
            payloads = [item.structured_content for item in replies]
            self.assertEqual(sum(item["ok"] for item in payloads), 1)
            self.assertEqual([item["error"]["code"] for item in payloads if not item["ok"]], ["conflict"])
            applied = await self.query(alice)
            self.assertEqual(len(applied["history"]), 1)
            event_id = applied["history"][-1]["id"]
            before = self.snapshot()
            self.payload(await alice.call_tool("ontology_policy_undo", self.undo_policy_request(state, event_id)), code="conflict")
            with patch("core.modules.reviews.store.ReviewStore._commit_locked", side_effect=OSError(errno.ENOSPC, "injected policy ledger failure")):
                with self.assertLogs("core.mcp.results", level="ERROR"):
                    self.payload(await alice.call_tool("ontology_policy", self.policy_request(applied, collection="attributes")), code="storage_error")
                with self.assertLogs("core.mcp.results", level="ERROR"):
                    self.payload(await alice.call_tool("ontology_policy_undo", self.undo_policy_request(applied, event_id)), code="storage_error")
            self.assertEqual(before, self.snapshot())
            self.assertEqual((await self.query(alice))["state_revision"], applied["state_revision"])

    async def expert_flow(self, client):
        """Transport-level policy lifecycle; decisions are scripted simulations."""
        source, saved, generation = await self.seed(client)
        initial = await self.query(client)
        relation_request = self.policy_request(initial, new_entity=True)
        relation = self.payload(await client.call_tool("ontology_policy", relation_request))
        after_policy_bytes = self.snapshot()
        impact = await self.impact_from(client, initial)
        self.assertEqual(impact["changes"], {"source": False, "graph": False, "review": True, "history": False})
        self.assertEqual(after_policy_bytes, self.snapshot())
        effective = relation["effective_graph"]["relations"][0]
        self.assertEqual(effective["provenance"]["kind"], "expert_policy")
        self.assertEqual(effective["provenance"]["event_id"], relation["event_id"])
        self.assertEqual(effective["qualifiers"], relation_request["replacement"]["qualifiers"])
        self.assertIsNone(effective["evidence"])
        self.assertEqual(relation["machine_graph"], initial["machine_graph"])
        labels = {item["id"]: item["label"] for item in relation["effective_graph"]["entities"]}
        self.assertEqual(labels[effective["object"]], "전문가 정책 분류")
        actor = relation["history"][-1]["actor"]
        self.assertEqual((actor["user_id"], actor["tenant"], actor["profile_id"]), ("alice", "acme", "business"))
        self.assertEqual(actor["policy_revision"], hashlib.sha256(self.config_path.read_bytes()).hexdigest())
        for field in ("before", "after", "reason", "timestamp", "source_revision", "graph_revision"):
            self.assertIn(field, relation["history"][-1])
        # An ordinary source-grounded reviewer cannot override/undo expert decisions.
        self.payload(await client.call_tool("ontology_review_undo", self.undo_policy_request(relation, relation["event_id"])), code="invalid_review")
        self.payload(await client.call_tool("ontology_policy_undo", self.undo_policy_request(relation, relation["event_id"], profile="developer")), code="invalid_review")
        attribute = self.payload(await client.call_tool("ontology_policy", self.policy_request(relation, collection="attributes")))
        self.assertEqual(attribute["effective_graph"]["attributes"][0]["value"], "35")
        self.assertEqual(attribute["machine_graph"]["attributes"][0]["value"], "20 리터")
        other = await self.query(client, profile="developer")
        self.assertEqual(other["effective_graph"]["relations"][0], initial["machine_graph"]["relations"][0])
        self.assertEqual(other["effective_graph"]["attributes"][0], initial["machine_graph"]["attributes"][0])
        self.assertEqual(other["history"], attribute["history"])
        # A new authenticated client can discover and read current policy without prior memory.
        async with self.client("bob") as fresh:
            found = self.payload(await fresh.call_tool("wiki_search", {"tenant": "acme", "query": "상품"}))
            self.assertIn("Guide.md", [item["document"] for item in found["matches"]])
            current = await self.query(fresh, profile="business")
            self.assertEqual(current["effective_graph"], attribute["effective_graph"])
        self.payload(await client.call_tool("ontology_generate", generation), code="conflict")
        undone = self.payload(await client.call_tool("ontology_policy_undo", self.undo_policy_request(attribute, attribute["event_id"])))
        after_undo_bytes = self.snapshot()
        undo_impact = await self.impact_from(client, attribute)
        self.assertEqual(undo_impact["changes"], {"source": False, "graph": False, "review": True, "history": False})
        self.assertEqual(after_undo_bytes, self.snapshot())
        self.assertEqual(undone["effective_graph"]["attributes"][0], initial["machine_graph"]["attributes"][0])
        self.assertEqual(undone["effective_graph"]["relations"][0], effective)
        self.assertEqual(undone["history"][-1]["undo_of"], attribute["event_id"])
        self.assertEqual(len(undone["history"]), 3)
        new_source = source + "새 원문 버전\n"
        saved2 = self.payload(await self.write(client, new_source, revision=saved["revision"]))
        self.assertEqual((self.stores["acme"].data_dir / saved2["history_path"]).read_bytes(), source.encode())
        stale = await self.query(client)
        self.assertTrue(stale["needs_review"])
        self.assertTrue(stale["pending_history"])
        self.assertEqual(stale["history"], undone["history"])
        self.payload(await client.call_tool("ontology_generate", {**generation, "expected_revision": saved2["revision"],
                          "expected_state_revision": stale["state_revision"]}))
        regenerated = await self.query(client)
        self.assertEqual(regenerated["history"], undone["history"])
        self.assertTrue(regenerated["pending_history"])
        self.assertEqual(regenerated["effective_graph"]["relations"][0]["object"], initial["machine_graph"]["relations"][0]["object"])
        self.assertEqual(list(self.tenant_root.rglob(".wiki-*.tmp")), [])

    async def test_source_review_and_undo_cannot_override_expert_policy(self):
        self.grant_policy()
        async with self.client() as client:
            await self.seed(client)
            state = await self.query(client)
            state = self.payload(await client.call_tool("ontology_policy", self.policy_request(state, new_entity=True)))
            policy_relation = deepcopy(state["effective_graph"]["relations"][0])
            for action in ("accept", "reject", "defer"):
                state = await self.decide(client, state, action=action)
                self.assertEqual(state["effective_graph"]["relations"][0], policy_relation)
                self.assertEqual(self.claim(state, "relations")["source_decision"], action)
                self.assertEqual(self.claim(state, "relations")["decision"], "policy")
            state = self.payload(await client.call_tool("ontology_review_undo", self.undo_policy_request(state, state["event_id"])))
            self.assertEqual(state["effective_graph"]["relations"][0], policy_relation)
            self.assertEqual(self.claim(state, "relations")["source_decision"], "reject")

    async def test_impact_relation_regeneration_and_source_review_are_independent_changes(self):
        async with self.client() as client:
            _, _, generation = await self.seed(client)
            initial = await self.query(client)
            changed_graph = deepcopy(generation)
            changed_graph["relations"][0]["predicate"] = "related_to"
            changed_graph["expected_state_revision"] = initial["state_revision"]
            self.payload(await client.call_tool("ontology_generate", changed_graph))
            graph_state = await self.query(client)
            before = self.snapshot()
            graph_impact = await self.impact_from(client, initial)
            self.assertEqual(graph_impact["changes"], {"source": False, "graph": True, "review": False, "history": False})
            self.assertEqual(before, self.snapshot())
            await self.decide(client, graph_state, action="reject")
            reviewed = await self.query(client)
            before = self.snapshot()
            review_impact = await self.impact_from(client, graph_state)
            self.assertEqual(review_impact["changes"], {"source": False, "graph": False, "review": True, "history": False})
            self.assertEqual(before, self.snapshot())
            self.assertEqual(review_impact["review_revision"], reviewed["review_revision"])

    async def test_impact_policy_candidates_keep_profile_scope_and_event_provenance(self):
        self.grant_policy()
        async with self.client() as client:
            await self.seed(client)
            peer = self.payload(await self.write(client, "전문가 정책 분류를 설명한다.\n", document="Peer.md"))
            self.payload(await client.call_tool("ontology_generate", {
                "tenant": "acme", "document": "Peer.md", "expected_revision": peer["revision"],
                "entities": [{"id": "peer_class", "type": "concept", "label": "전문가 정책 분류", "evidence": "전문가 정책 분류"}],
                "relations": [],
            }))
            initial = await self.query(client)
            applied = self.payload(await client.call_tool("ontology_policy", self.policy_request(initial, new_entity=True)))
            before = self.snapshot()
            business = await self.impact_from(client, initial)
            developer = self.payload(await client.call_tool("ontology_impact", {
                "tenant": "acme", "document": "Guide.md", "profile": "developer",
                "baseline": tenant_helpers.TenantMCPTests.impact_baseline(initial),
            }))
            matched = [item for item in business["candidates"] if "전문가 정책 분류" in json.dumps(item, ensure_ascii=False)]
            self.assertTrue(matched)
            self.assertTrue(all(item["status"] == "candidate" for item in matched))
            self.assertIn(applied["event_id"], json.dumps(matched))
            self.assertNotIn("전문가 정책 분류", json.dumps(developer["candidates"], ensure_ascii=False))
            self.assertEqual(business["changes"], developer["changes"])
            self.assertEqual(before, self.snapshot())

    async def test_expert_profiles_keep_independent_latest_decisions(self):
        self.grant_policy()
        async with self.client() as client:
            await self.seed(client)
            initial = await self.query(client)
            business = self.payload(await client.call_tool("ontology_policy", self.policy_request(initial, new_entity=True)))
            developer_request = self.policy_request(business, new_entity=True, profile="developer")
            developer_request["entities"][0]["label"] = "개발 관점 정책 분류"
            developer = self.payload(await client.call_tool("ontology_policy", developer_request))
            current_business = await self.query(client, profile="business")
            current_developer = await self.query(client, profile="developer")
            self.assertEqual(current_business["effective_graph"]["relations"][0], business["effective_graph"]["relations"][0])
            self.assertEqual(current_developer["effective_graph"]["relations"][0], developer["effective_graph"]["relations"][0])
            self.assertNotEqual(current_business["effective_graph"]["relations"][0]["object"], current_developer["effective_graph"]["relations"][0]["object"])
            all_scope = await self.query(client, profile="all")
            self.assertEqual(all_scope["effective_graph"]["relations"], initial["machine_graph"]["relations"])
            self.assertEqual(current_business["history"], current_developer["history"])
            self.assertEqual(len(all_scope["history"]), 2)

    async def test_expert_policy_lifecycle_in_process(self):
        self.grant_policy()
        async with self.client() as client:
            await self.expert_flow(client)

    async def test_actual_stdio_expert_policy_lifecycle(self):
        self.grant_policy()
        async with self.stdio_client(mode="auto") as client:
            await self.expert_flow(client)

    async def test_actual_http_expert_policy_lifecycle_and_tenant_isolation(self):
        self.grant_policy()
        async with self.http_server() as url:
            async with self.http_client(url, mode="auto") as client, self.http_client(url, "eve") as eve:
                await self.expert_flow(client)
                current = await self.query(client)
                for name, arguments in (("ontology_policy", self.policy_request(current)),
                                        ("ontology_policy_undo", self.undo_policy_request(current, "a" * 32))):
                    self.payload(await eve.call_tool(name, arguments), code="access_denied")


if __name__ == "__main__":
    unittest.main()
