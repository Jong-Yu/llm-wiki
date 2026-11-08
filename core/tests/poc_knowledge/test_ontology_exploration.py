"""SQL map projections, using isolated canonical files and verified scopes."""

import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common import read_changes, read_index, read_snapshots
from core.common.json_codec import canonical_json_hash
from core.common.read_index import CanonicalIndexUnavailable
from core.common.read_metrics import collect
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.documents.store import WikiStore
from core.modules.knowledge.concepts import ConceptStore
from core.modules.knowledge import ontology_exploration as exploration
from core.modules.knowledge import ontology_exploration_index as observations
from core.modules.reviews.relations import RelationStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.tests.poc_knowledge.test_storage import ACTOR, KnowledgeFixture
from core.tests.poc_mcp.test_server_integration import ServerFixture


class OntologyExplorationTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document()
        self.generate()
        self.document("b.md", title="Second document")
        self.generate("b.md")
        self.tracked = WikiStore(self.root, tracked_reads=True)
        self.service = ConceptStore(self.tracked, ACTOR)

    def search(self, **options):
        return self.service.explore_search(**options)

    def neighbors(self, document="a.md", entity_id="a", **options):
        ref = self.search(kind="document", document=document)["items"][0]["ref"]
        return self.service.explore_neighbors(document, entity_id, ref["state_revision"], **options)

    def canonical(self):
        return {key: value for key, value in self.tree().items() if key != ".storage.lock"}

    def anchor_graph(self):
        """같은 줄의 반복 구절과 공유 앵커를 실제 원문 검증으로 생성한다."""
        quote = "A and B use token token."
        source = self.document("anchors.md", body=quote + "\n")
        line = source.content[:source.content.index(quote)].count("\n") + 1
        anchors = [dict(kind="source_anchor", document="anchors.md", source_revision=source.revision,
                        quote="token", start_line=line, end_line=line, occurrence=number)
                   for number in (0, 1)]
        entities = [dict(id=value.lower(), label=value, type="system", evidence=quote) for value in "AB"]
        relations = [
            dict(subject="a", predicate="uses", object=anchors[0], evidence=quote,
                 qualifiers={"polarity": "negative", "modality": "possible"}),
            dict(subject="a", predicate="uses", object=anchors[1], evidence=quote),
            dict(subject="b", predicate="uses", object=anchors[0], evidence=quote),
            dict(subject=anchors[1], predicate="uses", object="a", evidence=quote),
            dict(subject="a", predicate="uses", object="b", evidence=quote),
        ]
        candidate = dict(id="uncertain", subject="b", predicate="depends_on", object="a", evidence=quote,
                         reason="isolated uncertainty", question="Does B depend on A?")
        self.ontology.generate("anchors.md", source.revision, entities, relations, [candidate], schema_version=4)
        return source, anchors, quote

    def test_source_anchors_are_bounded_relation_endpoints_not_search_concepts_or_evidence_copies(self):
        source, anchors, quote = self.anchor_graph()
        before = self.canonical()
        documents = self.search(kind="document", document="anchors.md")
        document = documents["items"][0]
        self.assertEqual((document["concept_count"], document["relation_count"]), (2, 6))
        self.assertTrue(documents["coverage"]["complete"])
        concepts = self.search(kind="concept", document="anchors.md")
        self.assertEqual(concepts["total"], 2)
        selected = next(item for item in concepts["items"] if item["concept"]["entity_id"] == "a")
        self.assertEqual(selected["relation_count"], 5)
        self.assertTrue(any(item["other_name"].startswith("원문 근거 · ") for item in selected["previews"]))
        revision = document["ref"]["state_revision"]
        edges, summaries, cursor = {}, {}, None
        with patch.object(exploration, "_project", side_effect=AssertionError("warm anchor capture")), collect() as warm:
            while True:
                page = self.service.explore_neighbors("anchors.md", "a", revision, limit=2, cursor=cursor)
                self.assertEqual(page["total"], 5)
                self.assertLessEqual(len(page["edges"]), 2)
                self.assertEqual({item["entity_id"] for item in page["concepts"]} - {"a", "b"}, set())
                anchor_ids = {endpoint["anchor_id"] for edge in page["edges"]
                              for endpoint in (edge["subject"], edge["object"]) if "anchor_id" in endpoint}
                self.assertEqual({item["anchor_id"] for item in page["anchors"]}, anchor_ids)
                for edge in page["edges"]:
                    self.assertNotIn(edge["key"], edges)
                    edges[edge["key"]] = edge
                summaries.update((item["anchor_id"], item) for item in page["anchors"])
                cursor = page["next_cursor"]
                if cursor is None:
                    break
        self.assertEqual(warm.finish()["counters"].get("canonical_reads", 0), 0)
        self.assertEqual(set(summaries), {canonical_json_hash(anchor) for anchor in anchors})
        self.assertEqual({item["occurrence"] for item in summaries.values()}, {0, 1})
        self.assertTrue(all(item["source_revision"] == source.revision and item["ref"] == document["ref"]
                            for item in summaries.values()))
        self.assertTrue(all(set(item) == {"document", "anchor_id", "source_revision", "start_line", "end_line", "occurrence", "ref"}
                            for item in summaries.values()))
        qualified = next(item for item in edges.values() if item["polarity"] == "negative")
        self.assertEqual((qualified["modality"], qualified["origin"]), ("possible", "machine"))
        self.assertTrue(any(item["collection"] == "relation_candidates" for item in edges.values()))
        with sqlite3.connect(self.root / "_index" / "read.sqlite3") as connection:
            payload = "\n".join(row[0] for row in connection.execute(
                "SELECT payload FROM read_index_rows WHERE namespace=?", (observations.NAMESPACE,)))
        self.assertNotIn(quote, payload)
        self.assertNotIn('"quote"', payload)
        self.assertNotIn('"evidence"', payload)
        self.assertEqual(before, self.canonical())

    def test_source_anchor_lookup_does_not_treat_its_id_as_a_real_concept(self):
        _, anchors, _ = self.anchor_graph()
        anchor_id = canonical_json_hash(anchors[0])
        ref = self.search(kind="document", document="anchors.md")["items"][0]["ref"]
        with self.assertRaises(InvalidCursorError):
            self.service.explore_neighbors("anchors.md", anchor_id, ref["state_revision"])
        # A valid entity ID may equal a 64-character anchor hash; the lookup still has a distinct type.
        self.assertNotEqual(exploration._endpoint_lookup(dict(document="anchors.md", entity_id="a" * 64)),
                            exploration._endpoint_lookup(dict(document="anchors.md", anchor_id="a" * 64)))

    def test_source_anchor_review_refs_and_revision_boundaries_survive(self):
        source, _, _ = self.anchor_graph()
        state = self.reviews.query("anchors.md")
        claims = [claim for claim in state["claims"] if isinstance(claim["value"].get("object"), dict)]
        accepted = claims[0]
        self.reviews.review("anchors.md", action="accept", claim_id=accepted["claim_id"],
            expected_state_revision=state["state_revision"], reason="isolated anchor acceptance", actor=ACTOR)
        first = self.neighbors("anchors.md", limit=1)
        full = self.neighbors("anchors.md")
        projected = next(edge for edge in full["edges"] if edge["claim_id"] == accepted["claim_id"])
        self.assertEqual(projected["origin"], "reviewed")
        self.assertEqual(projected["object"]["anchor_id"], canonical_json_hash(accepted["reviewed_value"]["object"]))
        actor = ConceptStore(self.tracked, {**ACTOR, "profile_id": "other", "viewpoint": "business"})
        other = actor.explore_search(kind="document", document="anchors.md")["items"][0]["ref"]
        with self.assertRaises(InvalidCursorError):
            actor.explore_neighbors("anchors.md", "a", other["state_revision"], cursor=first["next_cursor"], limit=1)
        state = self.reviews.query("anchors.md")
        rejected = next(claim for claim in claims if claim["claim_id"] != accepted["claim_id"])
        self.reviews.review("anchors.md", action="reject", claim_id=rejected["claim_id"],
            expected_state_revision=state["state_revision"], reason="isolated anchor rejection", actor=ACTOR)
        current = self.neighbors("anchors.md")
        self.assertNotIn(rejected["claim_id"], {edge["claim_id"] for edge in current["edges"]})
        with self.assertRaises(CatalogChangedError):
            self.service.explore_neighbors("anchors.md", "a", first["document"]["state_revision"], cursor=first["next_cursor"], limit=1)
        self.wiki.save("anchors.md", source.content + "Changed.\n", expected_revision=source.revision)
        with self.assertRaises(CatalogChangedError):
            self.service.explore_neighbors("anchors.md", "a", current["document"]["state_revision"])

    def test_anchor_projection_rejects_invalid_or_foreign_endpoint_summaries(self):
        _, anchors, _ = self.anchor_graph()
        ref = self.search(kind="document", document="anchors.md")["items"][0]["ref"]
        for value in ({"unrelated": "object"}, {**anchors[0], "document": "b.md"},
                      {**anchors[0], "source_revision": "f" * 64}, {**anchors[0], "occurrence": -1}):
            self.assertEqual(exploration._endpoint(value, "anchors.md", ref, {}), (None, None))

    def test_existing_v1_projection_does_not_keep_source_anchor_relations_hidden(self):
        self.anchor_graph()
        old_scope = canonical_json_hash({"actor": exploration.actor_basis(ACTOR), "version": 1})
        with self.tracked._write_lock(), read_index.read_index(self.tracked) as index:
            files = observations.observations(self.tracked)["files"]
            rows, manifest = exploration._project(self.service, "anchors.md", files["wiki/anchors.md"][3])
            old_rows = [(key, payload) for key, payload in rows if payload["state"] in {"concept", "document"}]
            old_rows[0][1]["item"]["relation_count"] = 0
            manifest["relation_count"] = 0
            manifest.pop("anchor_count")
            manifest["skipped"] = [{"document": "anchors.md", "code": "source_anchor_relation_not_projected"}]
            signature = observations.signature(files, "anchors.md", manifest["document_id"])
            index.replace_owner("ontology_exploration_v1", old_scope, "anchors.md",
                [(key, signature, payload) for key, payload in [*old_rows, ("m:anchors.md", manifest)]])
            prior = index.lookup("ontology_exploration_v1", old_scope)
        before = self.canonical()
        with patch.object(exploration, "_project", wraps=exploration._project) as projected:
            current = self.search(kind="document", document="anchors.md")
        self.assertIn("anchors.md", [call.args[1] for call in projected.call_args_list])
        self.assertEqual(current["items"][0]["relation_count"], 6)
        self.assertTrue(current["coverage"]["complete"])
        self.assertEqual(len(self.neighbors("anchors.md")["anchors"]), 2)
        with self.tracked._write_lock(), read_index.read_index(self.tracked) as index:
            self.assertEqual(prior, index.lookup("ontology_exploration_v1", old_scope))
        self.assertEqual(before, self.canonical())

    def test_cold_warm_sql_limits_counts_and_no_canonical_reads(self):
        before = self.canonical()
        with patch.object(exploration, "_project", wraps=exploration._project) as projected, collect() as cold:
            first = self.search(kind="concept", limit=1)
        self.assertEqual(projected.call_count, 2)
        self.assertEqual(first["total"], 4)
        self.assertIsNotNone(first["next_cursor"])
        self.assertGreater(cold.finish()["counters"]["canonical_reads"], 0)
        sql = []
        execute = read_index.CanonicalReadIndex._execute

        def trace(index, statement, arguments=()):
            sql.append(statement)
            return execute(index, statement, arguments)

        with patch.object(exploration, "_project", side_effect=AssertionError("warm canonical capture")), \
                patch.object(observations, "_scan", side_effect=AssertionError("warm metadata inventory")), \
                patch.object(read_index.CanonicalReadIndex, "_execute", trace), collect() as warm:
            second = self.search(kind="concept", limit=1, cursor=first["next_cursor"])
            page = self.neighbors(limit=1)
        counters = warm.finish()["counters"]
        self.assertEqual(counters.get("canonical_reads", 0), 0)
        self.assertEqual(counters.get("scanned", 0), 0)
        self.assertNotEqual(second["items"], first["items"])
        self.assertEqual((page["total"], len(page["edges"]), len(page["concepts"])), (1, 1, 2))
        self.assertEqual(len({edge["key"] for edge in page["edges"]}), 1)
        self.assertTrue(any("count(*)" in statement for statement in sql))
        selected_payloads = [statement for statement in sql if statement.startswith("SELECT key, payload")]
        self.assertTrue(selected_payloads)
        self.assertTrue(all("LIMIT ?" in statement for statement in selected_payloads))
        self.assertEqual(before, self.canonical())

    def test_one_changed_document_only_is_captured_and_old_cursors_stop(self):
        old = self.search(limit=1)
        original = self.wiki.read("a.md")
        self.wiki.save("a.md", original.content + "Changed.\n", expected_revision=original.revision)
        with patch.object(exploration, "_project", wraps=exploration._project) as projected, collect() as changed:
            current = self.search(kind="document")
        self.assertEqual([call.args[1] for call in projected.call_args_list], ["a.md"])
        self.assertGreater(changed.finish()["counters"]["canonical_reads"], 0)
        self.assertNotEqual(current["index_revision"], old["index_revision"])
        ref = next(item["ref"] for item in current["items"] if item["ref"]["document"] == "a.md")
        self.assertEqual(ref["status"], "stale")
        self.assertFalse(current["coverage"]["complete"])
        with self.assertRaises(CatalogChangedError):
            self.search(limit=1, cursor=old["next_cursor"])

    def test_transient_canonical_read_failure_retries_without_a_file_change(self):
        before = self.canonical()
        query_captured = ReviewStore._query_captured
        failed = []

        def fail_once(review, document, *args, **kwargs):
            if document == "a.md" and not failed:
                failed.append(document)
                raise OSError("isolated one-time canonical read failure")
            return query_captured(review, document, *args, **kwargs)

        with patch.object(ReviewStore, "_query_captured", fail_once):
            first = self.search(kind="document", document="a.md")
        self.assertEqual(first["items"][0]["ref"]["status"], "unavailable")
        self.assertEqual(first["items"][0]["concept_count"], 0)
        self.assertFalse(first["coverage"]["complete"])
        self.assertIn({"document": "a.md", "code": "read_error"}, first["coverage"]["skipped"])
        direct = self.reviews.query("a.md")
        self.assertEqual(direct["status"], "ready")
        with patch.object(exploration, "_project", wraps=exploration._project) as projected:
            current = self.search(kind="document", document="a.md")
        self.assertEqual([call.args[1] for call in projected.call_args_list], ["a.md"])
        self.assertEqual(current["items"][0]["ref"]["status"], "ready")
        self.assertEqual(current["items"][0]["concept_count"], 2)
        self.assertTrue(current["coverage"]["complete"])
        self.assertNotEqual(current["index_revision"], first["index_revision"])
        with patch.object(exploration, "_project", side_effect=AssertionError("recovered warm capture")):
            self.search(kind="concept")
        self.assertEqual(before, self.canonical())

    def test_graph_and_review_publication_invalidate_tracked_projection(self):
        previous = self.search(kind="concept", document="a.md")["items"][0]["concept"]["ref"]
        self.ontology.generate("a.md", self.wiki.read("a.md").revision,
            _input(self.reviews.query("a.md")["machine_graph"]["entities"]), [], force_generation=True)
        with patch.object(exploration, "_project", wraps=exploration._project) as projected:
            new = self.search(kind="document", document="a.md")["items"][0]
        self.assertEqual(projected.call_count, 1)
        self.assertEqual(new["relation_count"], 0)
        self.assertNotEqual(new["ref"]["state_revision"], previous["state_revision"])
        # Restore a graph, then reject its current relation through the real ledger.
        self.generate()
        self.search()
        state = self.reviews.query("a.md")
        self.reviews.review("a.md", action="reject", claim_id=state["claims"][0]["claim_id"],
            expected_state_revision=state["state_revision"], reason="isolated rejection", actor=ACTOR)
        with patch.object(exploration, "_project", wraps=exploration._project) as projected:
            current = self.search(kind="document", document="a.md")["items"][0]
        self.assertEqual(projected.call_count, 1)
        self.assertEqual(current["relation_count"], 0)

    def test_history_only_publication_changes_state_and_prevents_aba(self):
        previous = self.search(kind="document", document="a.md")["items"][0]["ref"]
        old = self.wiki.read("a.md")
        with patch("core.modules.documents.changes.begin", side_effect=OSError("after full archive")):
            with self.assertRaisesRegex(OSError, "after full archive"):
                self.wiki.save("a.md", old.content + "unpublished", expected_revision=old.revision)
        self.assertEqual(self.wiki.read("a.md"), old)
        current = self.search(kind="document", document="a.md")["items"][0]["ref"]
        self.assertEqual(current["source_revision"], previous["source_revision"])
        self.assertNotEqual(current["history_revision"], previous["history_revision"])
        self.assertNotEqual(current["state_revision"], previous["state_revision"])
        with self.assertRaises(CatalogChangedError):
            self.service.explore_neighbors("a.md", "a", previous["state_revision"])

    def test_profiles_names_and_duplicate_authored_claims_do_not_merge(self):
        original = self.reviews.query("a.md")
        replacement = _input(original["machine_graph"]["relations"][0])
        replacement.pop("evidence")
        replacement.pop("provenance")
        relations = RelationStore(self.wiki, ACTOR)
        for _ in range(2):
            state = self.reviews.query("a.md")
            relations.create("a.md", kind="policy", replacement=replacement, request_id=uuid4().hex,
                expected_state_revision=state["state_revision"], reason="isolated policy")
        own = self.neighbors()
        self.assertEqual(own["total"], 3)
        self.assertEqual(len({edge["key"] for edge in own["edges"]}), 3)
        self.assertEqual([edge["origin"] for edge in own["edges"]].count("policy"), 2)
        other = ConceptStore(self.tracked, {**ACTOR, "profile_id": "business", "viewpoint": "business"})
        ref = other.explore_search(kind="document", document="a.md")["items"][0]["ref"]
        page = other.explore_neighbors("a.md", "a", ref["state_revision"])
        self.assertEqual(page["total"], 1)
        matches = self.search(text="A", kind="concept")["items"]
        self.assertEqual({item["concept"]["document"] for item in matches}, {"a.md", "b.md"})
        first = self.search(kind="concept", limit=1)
        with self.assertRaises(InvalidCursorError):
            other.explore_search(kind="concept", limit=1, cursor=first["next_cursor"])
        changed_access = ConceptStore(self.tracked, {**ACTOR, "access_revision": "2" * 64})
        with self.assertRaises(InvalidCursorError):
            changed_access.explore_search(kind="concept", limit=1, cursor=first["next_cursor"])

    def test_corrupt_projection_and_missing_rows_fail_explicitly_preserving_canonical(self):
        self.search()
        before = self.canonical()
        database = self.root / "_index" / "read.sqlite3"
        with sqlite3.connect(database) as connection:
            connection.execute("DELETE FROM read_index_rows WHERE state='edge'")
        with self.assertRaises(CanonicalIndexUnavailable):
            self.search()
        self.assertEqual(before, self.canonical())

    def test_corrupt_database_is_preserved_without_false_empty_results(self):
        self.search()
        database = self.root / "_index" / "read.sqlite3"
        database.write_bytes(b"preserved damaged cache")
        before = self.canonical()
        with self.assertRaises(CanonicalIndexUnavailable):
            self.search()
        self.assertEqual(database.read_bytes(), b"preserved damaged cache")
        self.assertEqual(before, self.canonical())

    def test_invalidation_failure_prevents_graph_or_review_publication(self):
        before = self.canonical()
        state = self.reviews.query("a.md")
        with patch.object(read_changes.os, "fsync", side_effect=OSError("isolated journal failure")):
            with self.assertRaisesRegex(OSError, "isolated journal failure"):
                self.ontology.generate("a.md", self.wiki.read("a.md").revision,
                    [], [], force_generation=True)
            with self.assertRaisesRegex(OSError, "isolated journal failure"):
                self.reviews.review("a.md", action="accept", claim_id=state["claims"][0]["claim_id"],
                    expected_state_revision=state["state_revision"], reason="isolated", actor=ACTOR)
        self.assertEqual(before, self.canonical())

    def test_untracked_reads_reconcile_metadata_and_reuse_unchanged_captures(self):
        strict = ConceptStore(self.wiki, ACTOR)
        strict.explore_search()
        with patch.object(exploration, "_project", side_effect=AssertionError("unchanged canonical capture")), \
                patch.object(observations, "_scan", wraps=observations._scan) as scanned:
            strict.explore_search()
            strict.explore_search()
        self.assertEqual(scanned.call_count, 2)

    def test_journal_gap_damage_and_periodic_reconciliation_stay_current(self):
        self.search()
        (self.root / ".storage.lock").write_bytes(b"damaged read-only journal")
        with patch.object(observations, "_scan", wraps=observations._scan) as scanned:
            self.search()
            self.search()
        self.assertEqual(scanned.call_count, 2)
        self.assertEqual((self.root / ".storage.lock").read_bytes(), b"damaged read-only journal")
        # A subsequent canonical write restores a bounded journal under the same lock.
        self.document("c.md")
        self.search()
        with patch.object(read_snapshots, "RECONCILE_SECONDS", 0), \
                patch.object(observations, "_scan", wraps=observations._scan) as scanned:
            self.search()
        self.assertEqual(scanned.call_count, 1)

    def test_global_search_has_no_document_limit_and_finds_late_document(self):
        for number in range(1001):
            self.document(f"many/{number:04d}.md", plain=True)
        found = self.search(text="many/1000.md", kind="document")
        self.assertEqual(found["total"], 1)
        self.assertEqual(found["items"][0]["ref"]["document"], "many/1000.md")
        self.assertEqual(self.search(kind="document", limit=1)["total"], 1003)

    def test_large_graph_pages_decode_only_selected_edge_rows(self):
        labels = [f"Node {number}" for number in range(100)]
        body = "\n".join(f"Node 0 uses {label}." for label in labels[1:]) + "\n"
        source = self.document("large.md", body=body)
        entities = [{"id": f"n{number}", "label": label, "type": "system",
                     "evidence": f"Node 0 uses {label}." if number else "Node 0 uses Node 1."}
                    for number, label in enumerate(labels)]
        relations = [{"subject": "n0", "predicate": "uses", "object": f"n{number}",
                      "evidence": f"Node 0 uses {labels[number]}."} for number in range(1, 100)]
        self.ontology.generate("large.md", source.revision, entities, relations)
        ref = self.search(kind="document", document="large.md")["items"][0]["ref"]
        decoded = []
        decode = read_index.CanonicalReadIndex._decode

        def inspect(payload, digest):
            result = decode(payload, digest)
            if result.get("state") == "edge":
                decoded.append(result)
            return result

        with patch.object(read_index.CanonicalReadIndex, "_decode", staticmethod(inspect)), \
                patch.object(exploration, "_project", side_effect=AssertionError("warm capture")):
            first = self.service.explore_neighbors("large.md", "n0", ref["state_revision"], limit=7)
        self.assertEqual((first["total"], len(first["edges"])), (99, 7))
        self.assertEqual(len(decoded), 8)  # SQL page plus one lookahead.
        decoded.clear()
        with patch.object(read_index.CanonicalReadIndex, "_decode", staticmethod(inspect)), \
                patch.object(exploration, "_project", side_effect=AssertionError("warm capture")):
            matched = self.search(text="Ｎｏｄｅ ９９", kind="concept", document="large.md", limit=1)
        self.assertEqual(matched["total"], 1)
        self.assertLessEqual(len(decoded), 2)
        second = self.service.explore_neighbors("large.md", "n0", ref["state_revision"],
                                                limit=7, cursor=first["next_cursor"])
        self.assertTrue(set(edge["key"] for edge in first["edges"]).isdisjoint(
                        edge["key"] for edge in second["edges"]))

    def test_qualifiers_candidates_attributes_and_original_claim_refs_survive(self):
        quote = "A may not use B when enabled."
        source = self.document("qualified.md", body=quote + "\nA mode is test.\nB may depend on A.\n")
        entities = [{"id": char.lower(), "label": char, "type": "system", "evidence": quote} for char in "AB"]
        relation = {"subject": "a", "predicate": "uses", "object": "b", "evidence": quote,
                    "qualifiers": {"polarity": "negative", "modality": "possible", "condition": "when enabled"}}
        candidate = {"id": "candidate", "subject": "b", "predicate": "depends_on", "object": "a",
                     "reason": "uncertain", "question": "Does B depend on A?", "evidence": "B may depend on A."}
        attribute = {"id": "mode", "subject": "a", "property": "mode", "datatype": "text",
                     "value": "test", "unit": None, "evidence": "A mode is test."}
        self.ontology.generate("qualified.md", source.revision, entities, [relation], [candidate], attributes=[attribute])
        page = self.neighbors("qualified.md")
        self.assertEqual(page["total"], 2)
        concept = next(item for item in page["concepts"] if item["entity_id"] == "a")
        self.assertEqual(concept["attribute_count"], 1)
        edge = next(item for item in page["edges"] if item["collection"] == "relations")
        self.assertEqual((edge["polarity"], edge["modality"], edge["conditional"]), ("negative", "possible", True))
        self.assertNotIn("evidence", edge)
        self.assertNotIn("condition", edge)
        state = self.reviews.query("qualified.md")
        claim = next(item for item in state["claims"] if item["collection"] == "relation_candidates")
        self.reviews.review("qualified.md", action="accept", claim_id=claim["claim_id"],
            expected_state_revision=state["state_revision"], reason="isolated candidate acceptance", actor=ACTOR)
        current = self.neighbors("qualified.md")
        accepted = next(item for item in current["edges"] if item["claim_id"] == claim["claim_id"])
        self.assertEqual((accepted["collection"], accepted["original_collection"]), ("relations", "relation_candidates"))
        self.assertEqual(accepted["origin"], "reviewed")

    def test_unrelated_document_changes_keep_neighbor_cursor_and_coverage(self):
        state = self.reviews.query("a.md")
        replacement = _input(state["machine_graph"]["relations"][0])
        replacement.pop("evidence")
        replacement.pop("provenance")
        RelationStore(self.wiki, ACTOR).create("a.md", kind="policy",
            replacement=replacement, request_id=uuid4().hex,
            expected_state_revision=state["state_revision"], reason="isolated duplicate assertion")
        first = self.neighbors(limit=1)
        old = self.wiki.read("b.md")
        self.wiki.save("b.md", old.content + "Changed.\n", expected_revision=old.revision)
        second = self.service.explore_neighbors("a.md", "a", first["document"]["state_revision"],
                                                cursor=first["next_cursor"], limit=1)
        self.assertEqual(second["index_revision"], first["index_revision"])
        self.assertTrue(second["coverage"]["complete"])
        self.assertNotEqual(first["edges"][0]["key"], second["edges"][0]["key"])

    def test_index_replace_failure_rolls_back_projection_without_rewriting_canonical_files(self):
        first = self.search(kind="document", document="a.md")
        self.ontology.generate("a.md", self.wiki.read("a.md").revision, [], [], force_generation=True)
        before = self.canonical()
        put = read_index.CanonicalReadIndex._put

        def interrupted(index, *args):
            put(index, *args)
            raise CanonicalIndexUnavailable("isolated interrupted projection", reason="busy")

        with patch.object(read_index.CanonicalReadIndex, "_put", interrupted):
            with self.assertRaises(CanonicalIndexUnavailable):
                self.search()
        self.assertEqual(before, self.canonical())
        with self.tracked._write_lock(), read_index.read_index(self.tracked) as index:
            scope = exploration._arguments(self.service, 20)
            manifest = index.lookup(observations.NAMESPACE, scope, keys=["m:a.md"])["m:a.md"][1]
            self.assertEqual(manifest["ref"], first["items"][0]["ref"])
        current = self.search(kind="document", document="a.md")
        self.assertNotEqual(current["index_revision"], first["index_revision"])
        self.assertEqual(current["items"][0]["relation_count"], 0)
        self.assertEqual(before, self.canonical())


class OntologyExplorationIndexHTTP(ServerFixture):
    def test_broken_index_returns_503_preserves_records_and_does_not_bypass_revocation(self):
        store = self.policy.authorize(self.token, self.tenant, "read").store
        store.save("isolated.md", "Preserved source.\n", expected_revision=None)
        endpoint = f"/api/v1/tenants/{self.tenant}/ontology/search"
        first = self.client.post(endpoint, headers=self.headers(), json={})
        self.assertEqual(first.status_code, 200, first.text)
        database = store.data_dir / "_index" / "read.sqlite3"
        database.write_bytes(b"preserve this broken derived cache")
        before = {path.relative_to(store.data_dir): path.read_bytes()
                  for path in store.data_dir.rglob("*") if path.is_file() and "_index" not in path.parts}
        response = self.client.post(endpoint, headers=self.headers(), json={})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["error"]["code"], "index_unavailable")
        self.assertEqual(database.read_bytes(), b"preserve this broken derived cache")
        self.assertEqual(before, {path.relative_to(store.data_dir): path.read_bytes()
                         for path in store.data_dir.rglob("*") if path.is_file() and "_index" not in path.parts})
        self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        with patch.object(read_index.CanonicalReadIndex, "_open", side_effect=AssertionError("denied cache access")):
            denied = self.client.post(endpoint, headers=self.headers(), json={})
        self.assertEqual(denied.status_code, 403, denied.text)
        self.assertNotIn(self.token, response.text)


if __name__ == "__main__":
    unittest.main()
