"""Synthetic v4 consumer boundaries; no operational data or human approvals."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.modules.knowledge.concepts import ConceptStore
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.knowledge.impact import ImpactStore
from core.tests.modules.test_correspondences import correspondence_actor, correspondence_fixture
from core.tests.mcp.test_anchor_mcp import SOURCE, DOCUMENT, graph_request
from tools.transition_check import check_transition
from tools.verify_ontology import response_schema, validate_v2_phase


class AnchorConsumerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-anchor-consumers-")
        self.addCleanup(temporary.cleanup)
        self.wiki = WikiStore(temporary.name)
        saved = self.wiki.save(DOCUMENT, SOURCE, expected_revision=None)
        self.request = graph_request(saved.revision)
        self.ontology = OntologyStore(self.wiki)
        self.ontology.generate(DOCUMENT, saved.revision, self.request["entities"], self.request["relations"], schema_version=4)
        self.graph = self.ontology.query(DOCUMENT)
        self.reviews = ReviewStore(self.wiki)
        self.actor = correspondence_actor(domain=None, viewpoint=None)
        self.concepts = ConceptStore(self.wiki, actor=self.actor)

    def snapshot(self):
        return {p.relative_to(self.wiki.data_dir).as_posix(): p.read_bytes()
                for p in self.wiki.data_dir.rglob("*") if p.is_file()}

    def endpoint_target(self):
        result = self.concepts.find("워크스페이스", documents=[DOCUMENT], limit=100)
        return next(match["target_ref"] for match in result["matches"]
                    if match["target_ref"].get("kind") == "document_claim"
                    and match["target_ref"].get("selector") == "subject"
                    and match["target_ref"]["layer"] == "machine")

    def test_concept_selector_preserves_relation_and_source_position(self):
        before = self.snapshot()
        target = self.endpoint_target()
        result = self.concepts.query(target, documents=[DOCUMENT])
        self.assertEqual(result["target"]["status"], "current")
        self.assertTrue(result["complete"])
        document = result["documents"][0]
        self.assertEqual(document["machine_graph"]["relations"], self.graph["relations"])
        self.assertEqual(len(document["machine_graph"]["entities"]), 1)
        self.assertEqual(document["claims"][0]["decision"], "unreviewed")
        self.assertEqual(self.snapshot(), before)

    def test_correspondence_relation_snapshot_and_exact_endpoint_expansion(self):
        draft = correspondence_fixture(self.wiki)
        target = self.endpoint_target()
        endpoint = {key: value for key, value in target["snapshot"]["subject"].items() if key != "kind"}
        endpoint["graph_ref"] = {"graph_revision": target["graph_revision"], "state_revision": target["state_revision"],
                                 "collection": "relations", "layer": "machine", "claim_id": target["claim_id"],
                                 "snapshot": deepcopy(target["snapshot"])}
        draft["condition"] = endpoint
        draft["statement"] = "합성 원문 끝점과 별도 개념 간의 모의 대응."
        corr = CorrespondenceStore(self.wiki, self.actor)
        prepared = corr.query(draft=draft)
        created = corr.propose(prepared["correspondence_id"], prepared["draft"], prepared["state_revision"], "격리 simulation")
        cid = created["correspondence_id"]
        state = corr.query(cid)
        self.assertTrue(state["complete"])
        corr.review(cid, "accept", state["state_revision"], "합성 대응만 simulation; 실제 사람 승인 아님")
        partial = self.concepts.query(target, documents=[DOCUMENT], expansion="direct_confirmed",
                                      application_context={"service": "catalog"})
        self.assertFalse(partial["complete"])
        self.assertIn("b.md", partial["scope"]["content_documents"])
        self.assertEqual(next(doc for doc in partial["documents"] if doc["document"] == "b.md")["machine_graph"]["status"], "missing")
        for document in ("b.md", "d.md"):
            self.ontology.generate(document, self.wiki.read(document).revision, [], [])
        result = self.concepts.query(target, documents=[DOCUMENT], expansion="direct_confirmed",
                                     application_context={"service": "catalog"})
        self.assertTrue(result["complete"])
        self.assertIn("b.md", result["scope"]["content_documents"])
        self.assertIn(cid, result["scope"]["content_correspondences"])
        self.assertEqual(self.reviews.query(DOCUMENT)["claims"][0]["decision"], "unreviewed")
        # Same graph snapshot with a different source position cannot match the
        # selected endpoint merely because both belong to one relation.
        resolution = {"status": "current", "selectable_as_current": True}
        other_endpoint = deepcopy(endpoint)
        other_endpoint["quote"] = target["snapshot"]["object"]["quote"]
        self.assertFalse(self.concepts._endpoint_matches(target, other_endpoint, {}, resolution))

    def test_entity_connection_and_impact_candidates_keep_existing_entity_scope(self):
        saved = self.wiki.save("other.md", "육상 앱은 별도 문서의 대상이다.\n", expected_revision=None)
        self.ontology.generate("other.md", saved.revision,
            [{"id": "app2", "type": "system", "label": "육상 앱", "evidence": "육상 앱은 별도 문서의 대상이다."}], [])
        before = self.snapshot()
        connections = self.ontology.connections(DOCUMENT)
        impact = ImpactStore(self.wiki).query(DOCUMENT)
        for result in (connections, impact):
            self.assertFalse(result["truncated"])
            self.assertEqual(result["skipped"], [])
            self.assertEqual(len(result["candidates"]), 1)
            self.assertEqual(result["candidates"][0]["source_entity"]["id"], "app")
            self.assertEqual(result["candidates"][0]["status"], "candidate")
            self.assertFalse(result["candidates"][0].get("identity_confirmed", False))
        self.assertEqual(self.ontology.query(DOCUMENT)["relations"], self.graph["relations"])
        self.assertEqual(self.snapshot(), before)

    def test_transition_inspection_validates_all_v4_layers_and_preserves_files(self):
        before = self.snapshot()
        result = check_transition(self.wiki.data_dir, tenant="acme")
        self.assertTrue(result["ok"], result)
        with patch.object(ReviewStore, "_validate_all_layers", side_effect=ValueError("isolated sentinel")) as validation:
            blocked = check_transition(self.wiki.data_dir, tenant="acme")
        self.assertGreater(validation.call_count, 0)
        self.assertFalse(blocked["ok"])
        self.assertEqual(self.snapshot(), before)

    def test_structure_evaluator_v4_preserves_entity_only_nonrelation_contract(self):
        shape = response_schema(4)["properties"]["cases"]["items"]["properties"]
        relation = shape["relations"]["items"]["properties"]
        self.assertIn("anyOf", relation["subject"])
        self.assertEqual(shape["relation_candidates"]["items"]["properties"]["subject"], {"type": "string"})
        self.assertEqual(shape["attributes"]["items"]["properties"]["subject"], {"type": "string"})
        output = {"id": "synthetic", **{name: _input(self.graph[name])
                   for name in ("entities", "relations", "attributes", "relation_candidates")}, "omissions": []}
        case = {"id": "synthetic", "document": DOCUMENT, "source": SOURCE, "split": "dev"}
        result = validate_v2_phase([case], {"cases": [output]}, schema_version=4)
        self.assertEqual(result["overall"]["invalid_graphs"], 0, result)
        self.assertIsNone(result["semantic_acceptance"])
        del output["relations"][0]["subject"]["occurrence"]
        invalid = validate_v2_phase([case], {"cases": [output]}, schema_version=4)
        self.assertEqual(invalid["overall"]["invalid_graphs"], 1)


if __name__ == "__main__":
    unittest.main()
