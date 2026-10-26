"""Tenant authorization and profile tests with isolated MCP clients and data."""

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import errno
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

from core.modules.access.policy import AccessDenied, AccessPolicy
from core.mcp.schemas import CONCEPT_TOOLS, CORRESPONDENCE_TOOLS
from core.mcp_server import create_tenant_http_app, create_tenant_server
from core.modules.ontology.store import OntologyStore
from core.modules.knowledge.impact import ImpactStore
from core.modules.documents.store import WikiStore
from core.tests.modules.test_context import context_fixture
from core.tests.modules.test_ontology import ontology_v3_fixture


from core.paths import PROJECT_DIR
DATA_TOOLS = {
    "wiki_read", "wiki_write", "wiki_search", "ontology_generate",
    "ontology_query", "ontology_connections", "ontology_context",
    "ontology_review_query", "ontology_review", "ontology_review_undo",
    "ontology_policy", "ontology_policy_undo", "ontology_impact",
}


class TenantMCPTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-tenant-mcp-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.tenant_root = self.root / "tenants"
        self.tenant_root.mkdir()
        self.tokens = {user: secrets.token_urlsafe(32)
                       for user in ("alice", "bob", "eve", "bridge")}
        profiles = {
            "business": {"domain": None, "viewpoint": "business"},
            "developer": {"domain": None, "viewpoint": "developer"},
            "all": {"domain": None, "viewpoint": None},
        }
        full = {"permissions": ["read", "write", "ontology_write"],
                "profiles": list(profiles), "default_profile": "business"}
        self.config = {
            "version": 1,
            "tenants": {tenant: {"profiles": deepcopy(profiles)}
                        for tenant in ("acme", "beta")},
            "users": {
                user: {"token_sha256": hashlib.sha256(token.encode()).hexdigest(),
                       "memberships": {}}
                for user, token in self.tokens.items()
            },
        }
        self.config["users"]["alice"]["memberships"] = {"acme": deepcopy(full)}
        self.config["users"]["bob"]["memberships"] = {
            "acme": {"permissions": ["read"], "profiles": ["business", "developer"],
                     "default_profile": "developer"},
        }
        self.config["users"]["eve"]["memberships"] = {"beta": deepcopy(full)}
        self.config["users"]["bridge"]["memberships"] = {
            tenant: deepcopy(full) for tenant in ("acme", "beta")
        }
        self.config_path = self.root / "access.json"
        self.save_policy()
        self.stores = {}
        for tenant in ("acme", "beta"):
            (self.tenant_root / tenant).mkdir()
            self.stores[tenant] = WikiStore(self.tenant_root / tenant)
        self.policy = AccessPolicy(self.config_path, self.tenant_root,
                                   lock_timeout_seconds=0.1)

    def save_policy(self):
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")

    def client(self, user="alice", *, token=None):
        credential = self.tokens[user] if token is None else token
        return Client(create_tenant_server(self.policy, token=credential),
                      mode="legacy", read_timeout_seconds=10)

    def payload(self, result, *, code=None):
        value = result.structured_content
        self.assertIsInstance(value, dict)
        self.assertEqual(result.is_error, code is not None)
        self.assertEqual(value["ok"], code is None)
        self.assertEqual(len(result.content), 1)
        self.assertEqual(json.loads(result.content[0].text), value)
        if code is not None:
            self.assertEqual(value["error"]["code"], code)
        for token in self.tokens.values():
            self.assertNotIn(token, json.dumps(value))
        return value

    def snapshot(self, tenant=None):
        root = self.tenant_root if tenant is None else self.stores[tenant].data_dir
        return {path.relative_to(root).as_posix(): path.read_bytes()
                for path in root.rglob("*") if path.is_file()}

    async def write(self, client, content, *, tenant="acme", revision=None,
                    document="Guide.md"):
        return await client.call_tool("wiki_write", {
            "tenant": tenant, "document": document, "content": content,
            "expected_revision": revision,
        })

    async def seed_graph(self, client, *, tenant="acme", document="Guide.md"):
        # Reuse the v3 contract fixture; this tests selection, not extraction accuracy.
        source, entities, relations, candidates, attributes = ontology_v3_fixture()
        source = f"{tenant}-private-marker\n" + source
        saved = self.payload(await self.write(client, source, tenant=tenant, document=document))
        request = {
            "tenant": tenant, "document": document, "expected_revision": saved["revision"],
            "entities": entities, "relations": relations,
            "relation_candidates": candidates, "attributes": attributes,
        }
        self.payload(await client.call_tool("ontology_generate", request))
        return source, saved, request

    def requests(self, tenant="acme", document="Guide.md"):
        return {
            "wiki_read": {"tenant": tenant, "document": document},
            "wiki_write": {"tenant": tenant, "document": document,
                           "content": "unauthorized", "expected_revision": None},
            "wiki_search": {"tenant": tenant, "query": "private-marker"},
            "ontology_generate": {"tenant": tenant, "document": document,
                                  "expected_revision": "a" * 64,
                                  "entities": [], "relations": []},
            "ontology_query": {"tenant": tenant, "document": document},
            "ontology_connections": {"tenant": tenant, "document": document},
            "ontology_context": {"tenant": tenant, "documents": [document]},
            "ontology_impact": {"tenant": tenant, "document": document},
            "ontology_review_query": {"tenant": tenant, "document": document},
            "ontology_review": {"tenant": tenant, "document": document,
                                "action": "accept", "claim_id": "a" * 64,
                                "expected_state_revision": "a" * 64, "reason": "test simulation"},
            "ontology_review_undo": {"tenant": tenant, "document": document,
                                     "event_id": "missing", "expected_state_revision": "a" * 64,
                                     "reason": "test simulation"},
            "ontology_policy": {"tenant": tenant, "document": document,
                                "claim_id": "a" * 64, "expected_state_revision": "a" * 64,
                                "reason": "test simulation", "replacement": {}},
            "ontology_policy_undo": {"tenant": tenant, "document": document,
                                     "event_id": "missing", "expected_state_revision": "a" * 64,
                                     "reason": "test simulation"},
        }

    async def test_tool_contract_and_access_context_only_disclose_own_memberships(self):
        async with self.client() as client:
            tools = (await client.list_tools()).tools
            self.assertEqual({tool.name for tool in tools}, DATA_TOOLS | CORRESPONDENCE_TOOLS | CONCEPT_TOOLS | {
                "access_context", "source_read", "analysis_job_query", "analysis_job_claim", "analysis_job_update",
                "extraction_rules_read", "analysis_job_input_prepare", "analysis_job_input_read", "source_extraction_submit",
                "analysis_job_wiki_write", "analysis_job_ontology_generate", "analysis_job_result_query"})
            repeated = (await client.list_tools()).tools
            self.assertEqual([tool.model_dump() for tool in repeated], [tool.model_dump() for tool in tools])
            for tool in tools:
                if tool.name in DATA_TOOLS:
                    self.assertIn("tenant", tool.input_schema["required"])
                    self.assertEqual(tool.input_schema["required"].count("tenant"), 1)
                if tool.name in ("ontology_query", "ontology_context", "ontology_impact"):
                    self.assertIn("profile", tool.input_schema["properties"])
                    self.assertNotIn("domain", tool.input_schema["properties"])
                    self.assertNotIn("viewpoint", tool.input_schema["properties"])
            context = self.payload(await client.call_tool("access_context", {}))
            self.assertEqual(context["user_id"], "alice")
            self.assertRegex(context["policy_revision"], r"^[0-9a-f]{64}$")
            self.assertIn("acme", json.dumps(context["memberships"]))
            for forbidden in ('"beta"', '"eve"', "token_sha256", str(self.tenant_root)):
                self.assertNotIn(forbidden, json.dumps(context))

    async def test_same_tenant_default_and_switch_profiles_do_not_modify_graph(self):
        async with self.client() as alice, self.client("bob") as bob:
            source, _, _ = await self.seed_graph(alice)
            before = self.snapshot()
            business = self.payload(await alice.call_tool("ontology_query", {
                "tenant": "acme", "document": "Guide.md",
            }))
            developer = self.payload(await bob.call_tool("ontology_query", {
                "tenant": "acme", "document": "Guide.md",
            }))
            self.assertEqual(business["access"]["profile_id"], "business")
            self.assertEqual(developer["access"]["profile_id"], "developer")
            self.assertEqual({item["id"] for item in business["attributes"]},
                             {"price", "estimated_price"})
            self.assertEqual({item["id"] for item in developer["attributes"]}, {"price", "volume"})
            for client, profile, expected in ((alice, "developer", developer), (bob, "business", business)):
                selected = self.payload(await client.call_tool("ontology_query", {
                    "tenant": "acme", "document": "Guide.md", "profile": profile,
                }))
                self.assertEqual(selected["attributes"], expected["attributes"])
                self.assertEqual(selected["entities"], business["entities"])
            whole = self.payload(await alice.call_tool("ontology_query", {
                "tenant": "acme", "document": "Guide.md", "profile": "all",
            }))
            self.assertEqual(len(whole["attributes"]), 4)
            self.assertEqual(len(whole["relations"]), 6)
            self.assertEqual(len(whole["entities"]), 10)
            self.assertEqual(self.payload(await bob.call_tool("wiki_read", {
                "tenant": "acme", "document": "Guide.md",
            }))["content"], source)
            for profile in ("all", "unknown"):
                self.payload(await bob.call_tool("ontology_query", {
                    "tenant": "acme", "document": "Guide.md", "profile": profile,
                }), code="access_denied")
            self.assertEqual(self.snapshot(), before)

    async def test_other_tenant_and_absent_tenant_are_indistinguishable_for_all_tools(self):
        async with self.client() as alice, self.client("eve") as eve:
            await self.seed_graph(eve, tenant="beta")
            before = self.snapshot()
            for name in DATA_TOOLS:
                present = self.payload(await alice.call_tool(name, self.requests("beta")[name]),
                                       code="access_denied")
                absent = self.payload(await alice.call_tool(name, self.requests("absent")[name]),
                                      code="access_denied")
                self.assertEqual(present, absent)
                for forbidden in ("beta", "private-marker", "Guide.md", str(self.tenant_root)):
                    self.assertNotIn(forbidden, json.dumps(present))
            self.assertEqual(self.snapshot(), before)

    async def test_context_profile_switch_keeps_all_source_definitions_and_graph_claims(self):
        async with self.client() as alice, self.client("bob") as bob:
            source, saved, _ = await self.seed_graph(alice)
            before = self.snapshot()
            bundles = []
            for client, profile, expected_focus in (
                (alice, None, [0, 1]), (bob, None, [0, 2]),
                (alice, "developer", [0, 2]), (bob, "business", [0, 1]),
            ):
                arguments = self.requests()["ontology_context"]
                if profile is not None:
                    arguments["profile"] = profile
                bundle = self.payload(await client.call_tool("ontology_context", arguments))
                self.assertTrue(bundle["complete"])
                self.assertFalse(bundle["truncated"])
                entry = bundle["documents"][0]
                self.assertEqual(entry["source"]["content"], source)
                self.assertEqual(entry["source"]["revision"], saved["revision"])
                self.assertEqual(entry["ontology"]["source_revision"], saved["revision"])
                self.assertEqual(entry["selection"]["attributes"]["focus"], expected_focus)
                self.assertEqual(entry["selection"]["attributes"]["unclassified"], [3])
                self.assertEqual(entry["selection"]["relations"]["unclassified"], list(range(6)))
                self.assertEqual(len(entry["ontology"]["entities"]), 10)
                self.assertEqual(len(entry["ontology"]["attributes"]), 4)
                self.assertEqual(bundle["access"]["viewpoint"], bundle["selection"]["viewpoint"])
                bundles.append(bundle)
            self.assertEqual(bundles[0]["access"]["profile_id"], "business")
            self.assertEqual(bundles[1]["access"]["profile_id"], "developer")
            for bundle in bundles[1:]:
                self.assertEqual(bundle["documents"][0]["ontology"], bundles[0]["documents"][0]["ontology"])
            self.assertEqual(self.snapshot(), before)

    async def test_context_authorizes_before_store_read_and_rejects_forged_selectors(self):
        async with self.client() as alice, self.client("bob") as bob:
            await self.seed_graph(alice)
            before = self.snapshot()
            with patch.object(WikiStore, "read", side_effect=AssertionError("unauthorized source read")), \
                    patch.object(OntologyStore, "context", side_effect=AssertionError("unauthorized context read")):
                foreign = self.payload(await alice.call_tool("ontology_context", {
                    "tenant": "beta", "documents": ["Guide.md"],
                }), code="access_denied")
                absent = self.payload(await alice.call_tool("ontology_context", {
                    "tenant": "absent", "documents": ["Guide.md"],
                }), code="access_denied")
                self.assertEqual(foreign, absent)
                for profile in ("all", "unknown"):
                    self.payload(await bob.call_tool("ontology_context", {
                        "tenant": "acme", "documents": ["Guide.md"], "profile": profile,
                    }), code="access_denied")
                for field, value in (("user_id", "eve"), ("permissions", ["read"]),
                                     ("domain", "배송"), ("viewpoint", "developer")):
                    self.payload(await alice.call_tool("ontology_context", {
                        "tenant": "acme", "documents": ["Guide.md"], field: value,
                    }), code="invalid_argument")
                for profile in (None, 1, {}, ["business"]):
                    self.payload(await alice.call_tool("ontology_context", {
                        "tenant": "acme", "documents": ["Guide.md"], "profile": profile,
                    }), code="invalid_argument")
                self.payload(await alice.call_tool("ontology_context", {
                    "documents": ["Guide.md"],
                }), code="invalid_argument")
            self.assertEqual(self.snapshot(), before)

    async def test_context_warm_client_reloads_profile_and_revoked_read_permission(self):
        async with self.client() as client:
            await self.seed_graph(client)
            old = self.payload(await client.call_tool("ontology_context", self.requests()["ontology_context"]))
            before = self.snapshot()
            self.config["tenants"]["acme"]["profiles"]["business"] = {
                "domain": "배송", "viewpoint": "developer",
            }
            self.save_policy()
            changed = self.payload(await client.call_tool("ontology_context", self.requests()["ontology_context"]))
            self.assertEqual(changed["access"]["profile_id"], "business")
            self.assertNotEqual(old["access"]["policy_revision"], changed["access"]["policy_revision"])
            self.assertEqual(changed["selection"], {"domain": "배송", "viewpoint": "developer"})
            self.assertEqual(changed["documents"][0]["selection"]["attributes"]["focus"], [2])
            self.assertEqual(old["documents"][0]["ontology"], changed["documents"][0]["ontology"])
            membership = self.config["users"]["alice"]["memberships"]["acme"]
            membership.update(permissions=[], profiles=["developer"], default_profile="developer")
            self.save_policy()
            with patch.object(OntologyStore, "context", side_effect=AssertionError("revoked data read")):
                self.payload(await client.call_tool("ontology_context", self.requests()["ontology_context"]),
                             code="access_denied")
            self.assertEqual(self.snapshot(), before)

    async def test_context_concurrent_tenant_profiles_do_not_share_source_or_selection(self):
        async with self.client("bridge") as client:
            await self.seed_graph(client)
            await self.seed_graph(client, tenant="beta")
            before = self.snapshot()
            requests = [(tenant, profile) for _ in range(2)
                        for tenant in ("acme", "beta") for profile in ("business", "developer")]
            results = await asyncio.gather(*(client.call_tool("ontology_context", {
                "tenant": tenant, "documents": ["Guide.md"], "profile": profile,
            }) for tenant, profile in requests))
            for (tenant, profile), result in zip(requests, results):
                bundle = self.payload(result)
                self.assertEqual(bundle["access"]["tenant"], tenant)
                self.assertEqual(bundle["access"]["profile_id"], profile)
                entry = bundle["documents"][0]
                self.assertEqual(entry["source"]["revision"], self.stores[tenant].read("Guide.md").revision)
                self.assertIn(f"{tenant}-private-marker", entry["source"]["content"])
                self.assertNotIn("beta" if tenant == "acme" else "acme", json.dumps(bundle))
                self.assertEqual(entry["selection"]["attributes"]["focus"],
                                 [0, 1] if profile == "business" else [0, 2])
            self.assertEqual(self.snapshot(), before)

    async def test_document_names_entities_search_and_connection_metadata_stay_in_tenant(self):
        async with self.client() as alice, self.client("eve") as eve:
            for tenant, client in (("acme", alice), ("beta", eve)):
                source, saved, request = await self.seed_graph(client, tenant=tenant)
                self.payload(await self.write(client, f"{tenant}-peer-secret\n", tenant=tenant,
                                              document=f"{tenant}-peer.md"))
                updated = self.payload(await self.write(client, source + f"[{tenant}]({tenant}-peer.md)\n",
                                                        tenant=tenant, revision=saved["revision"]))
                request["expected_revision"] = updated["revision"]
                self.payload(await client.call_tool("ontology_generate", request))
            before = self.snapshot()
            for tenant, foreign, client in (("acme", "beta", alice), ("beta", "acme", eve)):
                read = self.payload(await client.call_tool("wiki_read", {
                    "tenant": tenant, "document": "Guide.md",
                }))
                self.assertIn(f"{tenant}-private-marker", read["content"])
                for name in ("wiki_search", "ontology_query", "ontology_connections", "ontology_context"):
                    result = self.payload(await client.call_tool(name, self.requests(tenant)[name]))
                    self.assertNotIn(foreign, json.dumps(result))
                    if name == "ontology_query":
                        self.assertEqual(result["source_revision"], read["revision"])
                        self.assertEqual(len(result["entities"]), 10)
                self.payload(await client.call_tool("wiki_read", {
                    "tenant": tenant, "document": f"{foreign}-peer.md",
                }), code="not_found")
                results = self.payload(await client.call_tool("wiki_search", {
                    "tenant": tenant, "query": f"{foreign}-private-marker",
                }))
                self.assertEqual(results["matches"], [])
            self.assertEqual(self.snapshot(), before)

    async def test_foreign_document_links_and_path_traversal_do_not_reveal_existence(self):
        async with self.client() as alice, self.client("eve") as eve:
            self.payload(await self.write(eve, "beta secret evidence", tenant="beta", document="Secret.md"))
            self.payload(await self.write(alice, "[local name](Secret.md)\n[escape](../../beta/wiki/Secret.md)\n"))
            before = self.snapshot()
            connections = self.payload(await alice.call_tool("ontology_connections", self.requests()["ontology_connections"]))
            self.assertEqual(len(connections["explicit_links"]), 1)
            link = connections["explicit_links"][0]
            self.assertEqual(link["target_document"], "Secret.md")
            self.assertEqual(link["target_status"], "missing")
            self.assertIsNone(link["target_revision"])
            self.assertNotIn("beta secret evidence", json.dumps(connections))
            for path in ("../../beta/wiki/Secret.md", str(self.stores["beta"].wiki_dir / "Secret.md")):
                self.payload(await alice.call_tool("wiki_read", {
                    "tenant": "acme", "document": path,
                }), code="invalid_argument")
                self.payload(await self.write(alice, "escape", document=path), code="invalid_argument")
            self.assertEqual(self.snapshot(), before)

    async def test_read_only_user_cannot_write_source_or_graph(self):
        async with self.client() as alice, self.client("bob") as bob:
            _, saved, request = await self.seed_graph(alice)
            before = self.snapshot()
            for name in ("wiki_read", "wiki_search", "ontology_query", "ontology_connections", "ontology_context"):
                self.payload(await bob.call_tool(name, self.requests()[name]))
            self.payload(await self.write(bob, "replacement", revision=saved["revision"]),
                         code="access_denied")
            self.payload(await bob.call_tool("ontology_generate", request), code="access_denied")
            self.assertEqual(self.snapshot(), before)

    async def test_identity_permission_and_filter_arguments_cannot_override_policy(self):
        async with self.client() as client:
            await self.seed_graph(client)
            before = self.snapshot()
            for field, value in (("user_id", "eve"), ("user", "eve"),
                                 ("permissions", ["read", "write"]), ("domain", "배송"),
                                 ("viewpoint", "architecture")):
                arguments = {"tenant": "acme", "document": "Guide.md", field: value}
                self.payload(await client.call_tool("ontology_query", arguments), code="invalid_argument")
            self.payload(await client.call_tool("access_context", {"user_id": "eve"}),
                         code="invalid_argument")
            for tenant in (None, 1, {}, ["acme"]):
                self.payload(await client.call_tool("wiki_read", {
                    "tenant": tenant, "document": "Guide.md",
                }), code="invalid_argument")
            self.payload(await client.call_tool("wiki_read", {"document": "Guide.md"}),
                         code="invalid_argument")
            for profile in (None, 1, {}, ["business"]):
                self.payload(await client.call_tool("ontology_query", {
                    "tenant": "acme", "document": "Guide.md", "profile": profile,
                }), code="invalid_argument")
            # A valid ID resembling JSON remains a string, never a null/default view.
            self.config["tenants"]["acme"]["profiles"]["null"] = {
                "domain": None, "viewpoint": "developer",
            }
            self.config["users"]["alice"]["memberships"]["acme"]["profiles"].append("null")
            self.save_policy()
            selected = self.payload(await client.call_tool("ontology_query", {
                "tenant": "acme", "document": "Guide.md", "profile": "null",
            }))
            self.assertEqual(selected["access"]["profile_id"], "null")
            self.assertEqual({item["id"] for item in selected["attributes"]}, {"price", "volume"})
            self.assertEqual(self.snapshot(), before)

    async def test_no_http_context_or_invalid_token_cannot_access_in_process_data(self):
        with self.assertRaises(AccessDenied):
            create_tenant_server(self.policy, token=secrets.token_urlsafe(32))
        async with Client(create_tenant_server(self.policy), mode="legacy") as client:
            self.payload(await client.call_tool("access_context", {}), code="access_denied")
            self.payload(await client.call_tool("wiki_read", self.requests()["wiki_read"]),
                         code="access_denied")

    async def test_warm_client_membership_revocation_denies_all_old_tenant_tools(self):
        async with self.client("bridge") as client:
            await self.seed_graph(client)
            await self.seed_graph(client, tenant="beta")
            prior = self.payload(await client.call_tool("access_context", {}))["policy_revision"]
            for name in ("wiki_read", "wiki_search", "ontology_query", "ontology_connections", "ontology_context"):
                self.payload(await client.call_tool(name, self.requests()[name]))
            del self.config["users"]["bridge"]["memberships"]["acme"]
            self.save_policy()
            before = self.snapshot()
            for name, arguments in self.requests().items():
                self.payload(await client.call_tool(name, arguments), code="access_denied")
            current = self.payload(await client.call_tool("access_context", {}))
            self.assertNotEqual(current["policy_revision"], prior)
            self.assertNotIn("acme", json.dumps(current))
            beta = self.payload(await client.call_tool("wiki_read", self.requests("beta")["wiki_read"]))
            self.assertIn("beta-private-marker", beta["content"])
            self.assertEqual(self.snapshot(), before)

    async def test_permission_profile_and_token_changes_apply_to_next_call(self):
        async with self.client() as client:
            _, saved, request = await self.seed_graph(client)
            membership = self.config["users"]["alice"]["memberships"]["acme"]
            membership.update(permissions=["read"], profiles=["developer"], default_profile="developer")
            self.save_policy()
            before = self.snapshot()
            self.payload(await self.write(client, "denied", revision=saved["revision"]), code="access_denied")
            self.payload(await client.call_tool("ontology_generate", request), code="access_denied")
            self.payload(await client.call_tool("ontology_query", {
                "tenant": "acme", "document": "Guide.md", "profile": "business",
            }), code="access_denied")
            current = self.payload(await client.call_tool("ontology_query", self.requests()["ontology_query"]))
            self.assertEqual(current["access"]["profile_id"], "developer")
            new_token = secrets.token_urlsafe(32)
            self.config["users"]["alice"]["token_sha256"] = hashlib.sha256(new_token.encode()).hexdigest()
            self.save_policy()
            self.payload(await client.call_tool("access_context", {}), code="access_denied")
            async with self.client(token=new_token) as replacement:
                self.assertEqual(self.payload(await replacement.call_tool("access_context", {}))["user_id"], "alice")
            self.assertEqual(self.snapshot(), before)

    async def test_corrupt_or_missing_policy_fails_closed_without_cached_authority(self):
        async with self.client() as client:
            await self.seed_graph(client)
            before = self.snapshot()
            self.config_path.write_text("{invalid", encoding="utf-8")
            for name, arguments in self.requests().items():
                self.payload(await client.call_tool(name, arguments), code="access_unavailable")
            self.config_path.unlink()
            self.payload(await client.call_tool("access_context", {}), code="access_unavailable")
            self.assertEqual(self.snapshot(), before)
            self.save_policy()
            self.payload(await client.call_tool("wiki_read", self.requests()["wiki_read"]))

    async def test_concurrent_profiles_and_tenants_do_not_share_request_state(self):
        async with self.client("bridge") as client:
            await self.seed_graph(client)
            await self.seed_graph(client, tenant="beta")
            requests = [(tenant, profile) for _ in range(3)
                        for tenant in ("acme", "beta") for profile in ("business", "developer", "all")]
            results = await asyncio.gather(*(client.call_tool("ontology_query", {
                "tenant": tenant, "document": "Guide.md", "profile": profile,
            }) for tenant, profile in requests))
            for (tenant, profile), result in zip(requests, results):
                graph = self.payload(result)
                self.assertEqual(graph["access"]["tenant"], tenant)
                self.assertEqual(graph["access"]["profile_id"], profile)
                self.assertEqual(graph["source_revision"], self.stores[tenant].read("Guide.md").revision)
                self.assertEqual(len(graph["attributes"]), 4 if profile == "all" else 2)

    async def test_cas_repeated_history_and_stale_graph_preserve_other_tenant(self):
        async with self.client() as alice, self.client("eve") as eve:
            source, first, request = await self.seed_graph(alice)
            await self.seed_graph(eve, tenant="beta")
            beta_before = self.snapshot("beta")
            second_text = source + "원문 수정 1\n"
            second = self.payload(await self.write(alice, second_text, revision=first["revision"]))
            stale = self.payload(await alice.call_tool("ontology_query", self.requests()["ontology_query"]))
            self.assertEqual(stale["status"], "stale")
            for key in ("entities", "relations", "relation_candidates", "attributes"):
                self.assertEqual(stale[key], [])
            self.payload(await self.write(alice, "old", revision=first["revision"]), code="conflict")
            self.payload(await alice.call_tool("ontology_generate", request), code="conflict")
            request["expected_revision"] = second["revision"]
            self.payload(await alice.call_tool("ontology_generate", request))
            third = self.payload(await self.write(alice, second_text + "원문 수정 2\n", revision=second["revision"]))
            root = self.stores["acme"].data_dir
            self.assertEqual((root / second["history_path"]).read_bytes(), source.encode())
            self.assertEqual((root / third["history_path"]).read_bytes(), second_text.encode())
            self.assertEqual(len([p for p in self.stores["acme"].history_dir.rglob("*.md") if p.is_file()]), 2)
            self.assertEqual(self.snapshot("beta"), beta_before)
            self.assertEqual(list(self.tenant_root.rglob(".wiki-*.tmp")), [])

    async def test_history_failure_retains_source_graph_and_other_tenant_can_write(self):
        async with self.client() as alice, self.client("eve") as eve:
            source, saved, _ = await self.seed_graph(alice)
            _, beta, _ = await self.seed_graph(eve, tenant="beta")
            before = self.snapshot("acme")
            real_link = os.link

            def fail_acme_history(source_path, target, *args, **kwargs):
                if self.stores["acme"].history_dir in Path(target).parents:
                    raise OSError(errno.ENOSPC, "injected history storage full")
                return real_link(source_path, target, *args, **kwargs)

            with patch("core.modules.documents.store.os.link", side_effect=fail_acme_history):
                with self.assertLogs("core.mcp.results", level="ERROR"):
                    self.payload(await self.write(alice, source + "failed update", revision=saved["revision"]),
                                 code="storage_error")
                beta_update = self.payload(await self.write(eve, "beta still writable", tenant="beta",
                                                            revision=beta["revision"]))
            self.assertEqual(self.snapshot("acme"), before)
            self.assertIsNotNone(beta_update["history_path"])
            self.assertEqual(self.payload(await alice.call_tool("ontology_query", self.requests()["ontology_query"]))["status"], "ready")
            context = self.payload(await alice.call_tool("ontology_context", self.requests()["ontology_context"]))
            self.assertEqual(context["documents"][0]["source"]["content"], source)
            self.assertEqual(context["documents"][0]["ontology"]["status"], "ready")

    async def protocol_flow(self, client):
        context = self.payload(await client.call_tool("access_context", {}))
        self.assertEqual(context["user_id"], "alice")
        source, first, _ = await self.seed_graph(client)
        graph = self.payload(await client.call_tool("ontology_query", {
            "tenant": "acme", "document": "Guide.md", "profile": "developer",
        }))
        self.assertEqual({a["id"] for a in graph["attributes"]}, {"price", "volume"})
        bundle = self.payload(await client.call_tool("ontology_context", {
            "tenant": "acme", "documents": ["Guide.md"], "profile": "developer",
        }))
        self.assertEqual(bundle["access"]["profile_id"], "developer")
        entry = bundle["documents"][0]
        self.assertEqual(entry["source"]["content"], source)
        self.assertEqual(entry["source"]["revision"], first["revision"])
        self.assertEqual(entry["ontology"]["source_revision"], first["revision"])
        self.assertEqual(entry["selection"]["attributes"]["focus"], [0, 2])
        self.assertEqual(len(entry["ontology"]["attributes"]), 4)
        second = self.payload(await self.write(client, source + "\ntransport update\n", revision=first["revision"]))
        stale_context = self.payload(await client.call_tool("ontology_context", self.requests()["ontology_context"]))
        stale_entry = stale_context["documents"][0]
        self.assertEqual(stale_entry["source"]["content"], source + "\ntransport update\n")
        self.assertEqual(stale_entry["source"]["revision"], second["revision"])
        self.assertEqual(stale_entry["ontology"]["status"], "stale")
        self.assertEqual(stale_entry["ontology"]["attributes"], [])
        self.assertFalse(stale_context["complete"])
        read = self.payload(await client.call_tool("wiki_read", self.requests()["wiki_read"]))
        self.assertEqual(read["revision"], second["revision"])
        search = self.payload(await client.call_tool("wiki_search", {"tenant": "acme", "query": "transport update"}))
        self.assertEqual([item["document"] for item in search["matches"]], ["Guide.md"])
        self.assertEqual((self.stores["acme"].data_dir / second["history_path"]).read_bytes(), source.encode())
        self.payload(await client.call_tool("wiki_read", self.requests("beta")["wiki_read"]), code="access_denied")

    def stdio_client(self, *, mode="legacy"):
        params = StdioServerParameters(
            command=sys.executable,
            args=["-B", "-m", "core.mcp_server", "--access-config", str(self.config_path),
                  "--tenant-root", str(self.tenant_root), "--token-env", "LLM_WIKI_TEST_TOKEN"],
            env={"LLM_WIKI_TEST_TOKEN": self.tokens["alice"]}, cwd=PROJECT_DIR,
        )
        return Client(params, mode=mode, read_timeout_seconds=10)

    async def test_actual_stdio_authenticated_read_write_search_graph_and_history(self):
        async with self.stdio_client() as client:
            await self.protocol_flow(client)

    async def test_actual_auto_stdio_authenticated_context_and_history(self):
        async with self.stdio_client(mode="auto") as client:
            await self.protocol_flow(client)

    async def test_actual_stdio_context_retains_common_definition_conditions_and_exceptions(self):
        # Fixed synthetic claims test transport preservation, not LLM accuracy.
        source, entities, relations, candidates, attributes = context_fixture()
        self.config["tenants"]["acme"]["profiles"]["architecture"] = {
            "domain": None, "viewpoint": "architecture",
        }
        self.config["users"]["alice"]["memberships"]["acme"]["profiles"].append("architecture")
        self.save_policy()
        async with self.stdio_client() as client:
            saved = self.payload(await self.write(client, source))
            self.payload(await client.call_tool("ontology_generate", {
                "tenant": "acme", "document": "Guide.md", "expected_revision": saved["revision"],
                "entities": entities, "relations": relations,
                "relation_candidates": candidates, "attributes": attributes,
            }))
            before = self.snapshot()
            snapshots = []
            for profile, focus in (("business", [1]), ("developer", [2]), ("architecture", [3])):
                bundle = self.payload(await client.call_tool("ontology_context", {
                    "tenant": "acme", "documents": ["Guide.md"], "profile": profile,
                }))
                entry = bundle["documents"][0]
                self.assertTrue(bundle["complete"])
                self.assertEqual(entry["source"], {
                    "content": source, "revision": saved["revision"], "line_start": 1, "line_end": 7,
                })
                self.assertEqual(entry["selection"]["relations"]["focus"], focus)
                self.assertEqual(entry["selection"]["relations"]["unclassified"], [0])
                self.assertEqual(entry["ontology"]["relations"][1]["qualifiers"]["condition"],
                                 "재고가 10개 이상일 때")
                self.assertEqual(entry["ontology"]["relations"][1]["qualifiers"]["scope"],
                                 "단 예약상품은 제외한다")
                self.assertEqual(entry["ontology"]["relations"][3]["qualifiers"]["scope"],
                                 "냉장품에는 적용하지 않는다")
                self.assertEqual(entry["ontology"]["attributes"][0]["provenance"], attributes[0]["provenance"])
                self.assertEqual(entry["ontology"]["attributes"][0]["qualifiers"]["time"], "2026-10-22")
                self.assertEqual(entry["ontology"]["relation_candidates"][0]["status"], "needs_review")
                self.assertEqual(entry["ontology"]["relations"][3]["evidence"]["start_line"], 4)
                snapshots.append(entry["ontology"])
            self.assertEqual(snapshots[0], snapshots[1])
            self.assertEqual(snapshots[1], snapshots[2])
            self.assertEqual(self.snapshot(), before)

    @asynccontextmanager
    async def http_client(self, url, user="alice", *, mode="legacy"):
        async with httpx2.AsyncClient(
            headers={"Authorization": "Bearer " + self.tokens[user]}, timeout=10, trust_env=False,
        ) as http:
            async with Client(streamable_http_client(url, http_client=http),
                              mode=mode, read_timeout_seconds=10) as client:
                yield client

    @asynccontextmanager
    async def http_server(self):
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-B", "-m", "core.mcp_server", "--access-config", str(self.config_path),
            "--tenant-root", str(self.tenant_root), "--transport", "streamable-http", "--port", str(port),
            cwd=PROJECT_DIR, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        url = f"http://127.0.0.1:{port}/mcp"
        try:
            deadline = time.monotonic() + 10
            async with httpx2.AsyncClient(timeout=0.5, trust_env=False) as http:
                while True:
                    if process.returncode is not None:
                        self.fail(f"HTTP tenant test server exited: {process.returncode}")
                    try:
                        if (await http.get(url)).status_code == 401:
                            break
                    except httpx2.TransportError:
                        pass
                    if time.monotonic() >= deadline:
                        self.fail("HTTP tenant test server was not ready within 10 seconds")
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
            for token in self.tokens.values():
                self.assertNotIn(token.encode(), stderr)

    async def test_actual_http_users_are_isolated_during_concurrent_calls_and_revocation(self):
        async with self.http_server() as url:
            async with self.http_client(url) as alice, self.http_client(url, "eve") as eve:
                await self.protocol_flow(alice)
                await self.seed_graph(eve, tenant="beta")
                async with self.http_client(url, mode="auto") as auto:
                    self.assertEqual({tool.name for tool in (await auto.list_tools()).tools},
                                     DATA_TOOLS | CORRESPONDENCE_TOOLS | CONCEPT_TOOLS | {
                                         "access_context", "source_read", "analysis_job_query", "analysis_job_claim", "analysis_job_update",
                                         "extraction_rules_read", "analysis_job_input_prepare", "analysis_job_input_read", "source_extraction_submit",
                                         "analysis_job_wiki_write", "analysis_job_ontology_generate", "analysis_job_result_query"})
                    self.assertEqual(self.payload(await auto.call_tool("access_context", {}))["user_id"], "alice")
                    read = self.payload(await auto.call_tool("wiki_read", self.requests()["wiki_read"]))
                    self.assertIn("acme-private-marker", read["content"])
                    context = self.payload(await auto.call_tool("ontology_context", self.requests()["ontology_context"]))
                    self.assertEqual(context["documents"][0]["source"]["content"], read["content"])
                    self.assertEqual(context["documents"][0]["ontology"]["status"], "stale")
                pairs = [(client, tenant) for _ in range(5)
                         for client, tenant in ((alice, "acme"), (eve, "beta"))]
                results = await asyncio.gather(*(client.call_tool("ontology_context", self.requests(tenant)["ontology_context"])
                                                 for client, tenant in pairs))
                for (_, tenant), result in zip(pairs, results):
                    self.assertIn(f"{tenant}-private-marker", self.payload(result)["documents"][0]["source"]["content"])
                del self.config["users"]["alice"]
                self.save_policy()
                async with httpx2.AsyncClient(timeout=5, trust_env=False) as http:
                    revoked = await http.post(url, headers={"Authorization": "Bearer " + self.tokens["alice"]},
                                              json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                    self.assertEqual(revoked.status_code, 401)
                self.payload(await eve.call_tool("wiki_read", self.requests("beta")["wiki_read"]))

    async def test_http_missing_duplicate_and_wrong_auth_fail_before_any_data_access(self):
        before = self.snapshot()
        app = create_tenant_http_app(self.policy)
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app),
                                      base_url="http://127.0.0.1:8765") as http:
            token = self.tokens["alice"]
            for headers in ([], [("Authorization", "Bearer " + secrets.token_urlsafe(32))],
                            [("Authorization", "Basic " + token)],
                            [("Authorization", "Bearer " + token)] * 2):
                response = await http.post("/mcp", headers=headers, json={
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
                        "name": "wiki_write", "arguments": self.requests()["wiki_write"],
                    },
                })
                self.assertEqual(response.status_code, 401)
                self.assertNotIn(token, response.text)
            for headers in ({"Host": "attacker.invalid"}, {"Origin": "https://attacker.invalid"}):
                response = await http.get("/mcp", headers={"Authorization": "Bearer " + token, **headers})
                self.assertIn(response.status_code, (400, 403, 421))
        self.assertEqual(self.snapshot(), before)

    async def test_cli_rejects_legacy_data_root_mixed_with_tenant_mode(self):
        before = self.snapshot()
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-B", "-m", "core.mcp_server", "--access-config", str(self.config_path),
            "--tenant-root", str(self.tenant_root), "--data-dir", str(self.root / "legacy"),
            cwd=PROJECT_DIR, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(stdout, b"")
        self.assertFalse((self.root / "legacy").exists())
        self.assertEqual(self.snapshot(), before)
        for token in self.tokens.values():
            self.assertNotIn(token.encode(), stderr)

    @staticmethod
    def impact_baseline(result):
        return {key: result[key] for key in (
            "source_revision", "graph_revision", "review_revision", "history_revision",
        )}

    async def impact(self, client, *, tenant="acme", profile="business", baseline=None, limit=20):
        return self.payload(await client.call_tool("ontology_impact", {
            "tenant": tenant, "document": "Guide.md", "profile": profile,
            "baseline": baseline, "limit": limit,
        }))

    async def seed_impact(self, client, *, tenant="acme"):
        originals = {
            "Guide.md": "MCP는 프로토콜이다.\n\n[참조](Peer.md)\n",
            "Peer.md": "MCP를 설명하는 관련 문서다.\n",
            "Incoming.md": "MCP를 설명한다.\n\n[주 문서](Guide.md)\n",
        }
        revisions = {}
        for document, content in originals.items():
            result = self.payload(await self.write(client, content, tenant=tenant, document=document))
            revisions[document] = result["revision"]
            self.payload(await client.call_tool("ontology_generate", {
                "tenant": tenant, "document": document, "expected_revision": result["revision"],
                "entities": [{"id": "mcp", "type": "concept", "label": "MCP", "evidence": "MCP"}],
                "relations": [],
            }))
        return originals, revisions

    async def test_impact_schema_read_only_baselines_and_invalid_inputs(self):
        async with self.client() as alice, self.client("bob") as reader:
            await self.seed_impact(alice)
            tool = next(item for item in (await reader.list_tools()).tools if item.name == "ontology_impact")
            self.assertTrue(tool.annotations.read_only_hint)
            self.assertFalse(tool.annotations.destructive_hint)
            self.assertIn("profile", tool.input_schema["properties"])
            for field in ("actor", "domain", "viewpoint", "permissions"):
                self.assertNotIn(field, tool.input_schema["properties"])
            first = await self.impact(reader)
            self.assertEqual(first["baseline_status"], "not_compared")
            self.assertEqual(first["changes"], dict.fromkeys(("source", "graph", "review", "history")))
            baseline = self.impact_baseline(first)
            same = await self.impact(reader, baseline=baseline)
            self.assertEqual(same["changes"], dict.fromkeys(("source", "graph", "review", "history"), False))
            before = self.snapshot()
            invalid = ["null", "{}", json.dumps(baseline), [], True, 3, {},
                       {**baseline, "document": "elsewhere.md"},
                       {**baseline, "source_revision": None}, {**baseline, "history_revision": None}]
            invalid.extend({**baseline, key: value} for key in baseline for value in (True, 1, "a" * 63, ["a" * 64]))
            for value in invalid:
                self.payload(await reader.call_tool("ontology_impact", {
                    "tenant": "acme", "document": "Guide.md", "baseline": value,
                }), code="invalid_argument")
            for value in (True, 0, 101, "2", 1.5):
                self.assertTrue((await reader.call_tool("ontology_impact", {
                    "tenant": "acme", "document": "Guide.md", "limit": value,
                })).is_error)
            self.payload(await reader.call_tool("ontology_impact", {
                "tenant": "acme", "document": "Missing.md",
            }), code="not_found")
            self.payload(await reader.call_tool("ontology_impact", {
                "tenant": "acme", "document": "../outside.md",
            }), code="invalid_argument")
            self.assertEqual(before, self.snapshot())

    async def test_impact_authorizes_before_read_and_rechecks_profiles_and_revocation(self):
        async with self.client() as alice, self.client("bob") as bob, self.client("eve") as eve:
            await self.seed_impact(alice)
            await self.seed_impact(eve, tenant="beta")
            secret = self.payload(await self.write(eve, "beta-hidden-impact-marker", tenant="beta", document="Secret.md"))
            guide = self.stores["acme"].read("Guide.md")
            self.payload(await self.write(alice, guide.content + "[다른 문서](Secret.md)\n", revision=guide.revision))
            before = self.snapshot()
            with patch("core.modules.access.policy.WikiStore", side_effect=AssertionError("unauthorized store access")), \
                    patch.object(ImpactStore, "query", side_effect=AssertionError("unauthorized impact read")):
                foreign = self.payload(await alice.call_tool("ontology_impact", {
                    "tenant": "beta", "document": "Guide.md",
                }), code="access_denied")
                absent = self.payload(await alice.call_tool("ontology_impact", {
                    "tenant": "absent", "document": "Guide.md",
                }), code="access_denied")
                self.assertEqual(foreign, absent)
                for tenant in ("beta", "absent"):
                    invalid = self.payload(await alice.call_tool("ontology_impact", {
                        "tenant": tenant, "document": "Guide.md", "baseline": "{}",
                    }), code="access_denied")
                    self.assertEqual(foreign, invalid)
                self.payload(await bob.call_tool("ontology_impact", {
                    "tenant": "acme", "document": "Guide.md", "profile": "all",
                }), code="access_denied")
            result = await self.impact(bob, profile="developer")
            self.assertEqual(result["access"]["profile_id"], "developer")
            self.assertEqual(result["selection"], {"domain": None, "viewpoint": "developer"})
            for forbidden in ("beta-hidden-impact-marker", secret["revision"], str(self.tenant_root / "beta")):
                self.assertNotIn(forbidden, json.dumps(result))
            foreign_links = [item for item in result["explicit_links"] if item["target_document"] == "Secret.md"]
            self.assertTrue(foreign_links)
            self.assertTrue(all(item["target_status"] == "missing" for item in foreign_links))
            for key, value in (("actor", "eve"), ("domain", "beta"), ("viewpoint", "business")):
                self.payload(await bob.call_tool("ontology_impact", {
                    "tenant": "acme", "document": "Guide.md", key: value,
                }), code="invalid_argument")
            membership = self.config["users"]["bob"]["memberships"]["acme"]
            membership["permissions"] = []
            self.save_policy()
            with patch.object(ImpactStore, "query", side_effect=AssertionError("revoked read")):
                self.payload(await bob.call_tool("ontology_impact", {
                    "tenant": "acme", "document": "Guide.md",
                }), code="access_denied")
            self.assertEqual(before, self.snapshot())

    async def impact_flow(self, client):
        originals, revisions = await self.seed_impact(client)
        before = self.snapshot()
        first = await self.impact(client)
        self.assertEqual(before, self.snapshot())
        self.assertTrue(first["complete"])
        self.assertFalse(first["truncated"])
        self.assertEqual({link["direction"] for link in first["explicit_links"]}, {"incoming", "outgoing"})
        self.assertTrue(first["candidates"])
        self.assertTrue(all(item["status"] == "candidate" for item in first["candidates"]))
        small = await self.impact(client, limit=1)
        self.assertTrue(small["truncated"])
        self.assertFalse(small["complete"])
        baseline = self.impact_baseline(first)
        graph_before = OntologyStore(self.stores["acme"])._path("Guide.md").read_bytes()
        updated = self.payload(await self.write(client, "HTTP를 설명한다.\n", revision=revisions["Guide.md"]))
        saved_snapshot = self.snapshot()
        after = await self.impact(client, baseline=baseline)
        self.assertEqual(after["changes"], {"source": True, "graph": False, "review": False, "history": True})
        self.assertFalse(after["complete"])
        removed = [item for item in after["explicit_links"] if item["change"] == "removed"]
        self.assertTrue(any(item["target_document"] == "Peer.md" and item["origin"] == "baseline_source" for item in removed))
        self.assertEqual(saved_snapshot, self.snapshot())
        self.assertEqual(OntologyStore(self.stores["acme"])._path("Guide.md").read_bytes(), graph_before)
        self.assertEqual((self.stores["acme"].data_dir / updated["history_path"]).read_bytes(), originals["Guide.md"].encode())
        self.assertEqual(self.stores["acme"].read("Peer.md").content, originals["Peer.md"])
        self.assertEqual(list(self.tenant_root.rglob(".wiki-*.tmp")), [])

    async def test_impact_source_changes_and_removed_links_in_process(self):
        async with self.client() as client:
            await self.impact_flow(client)

    async def test_actual_stdio_impact_source_changes_and_removed_links(self):
        async with self.stdio_client(mode="auto") as client:
            await self.impact_flow(client)

    async def test_actual_http_impact_source_changes_and_removed_links(self):
        async with self.http_server() as url:
            async with self.http_client(url, mode="auto") as client:
                await self.impact_flow(client)

    async def test_impact_incomplete_result_and_query_failure_preserve_successful_save(self):
        async with self.client() as client:
            _, revisions = await self.seed_impact(client)
            peer_graph = OntologyStore(self.stores["acme"])._path("Peer.md")
            peer_graph.write_bytes(b"invalid derived graph fixture")
            before = self.snapshot()
            partial = await self.impact(client)
            self.assertFalse(partial["complete"])
            self.assertTrue(partial["skipped"])
            self.assertEqual(before, self.snapshot())
            saved = self.payload(await self.write(client, "new saved source\n", revision=revisions["Guide.md"]))
            after_save = self.snapshot()
            with patch.object(ImpactStore, "query", side_effect=OSError(errno.EIO, "injected impact failure")):
                with self.assertLogs("core.mcp.results", level="ERROR"):
                    self.payload(await client.call_tool("ontology_impact", {
                        "tenant": "acme", "document": "Guide.md",
                    }), code="storage_error")
            self.assertEqual(after_save, self.snapshot())
            self.assertEqual(self.stores["acme"].read("Guide.md").revision, saved["revision"])


if __name__ == "__main__":
    unittest.main()
