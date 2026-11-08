"""D-072/073 지식 저장 계약. 모든 쓰기는 TemporaryDirectory에 한정한다."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.documents.metadata import parse_document, render_document, DocumentMetadataError
from core.modules.documents.store import WikiStore, RevisionConflictError
from core.modules.documents.listing import list_documents, InvalidCursorError
from core.modules.ontology.store import OntologyStore
from core.modules.ontology.storage import KnowledgeStorageConflict, legacy_key
from core.modules.ontology.validation import _graph
from core.modules.ontology.errors import OntologyValidationError, OntologyCorruptError
from core.modules.ontology.connections import _source_links
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.contracts import ReviewConflictError, ReviewCorruptError
from core.modules.reviews.values import _input
from core.modules.knowledge.catalogue import list_catalogue
from core.modules.knowledge.capture import ConceptCapture
from core.modules.knowledge.concepts import ConceptStore
from core.modules.knowledge.impact_history import _review_prefix
from core.modules.knowledge.impact import ImpactStore
from core.modules.knowledge.aggregation import review_queue
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.correspondences.contracts import CorrespondenceConflictError, CorrespondenceValidationError
from core.modules.sources.store import SourceStore


ACTOR = dict(user_id="alice", tenant="team", profile_id="all", domain=None,
             viewpoint=None, policy_revision="0" * 64, access_revision="1" * 64)
OLD_ACTOR = {key: value for key, value in ACTOR.items() if key != "access_revision"}
BODY = "A uses B.\n"
ENTITIES = [{"id": char.lower(), "label": char, "type": "system", "evidence": BODY.strip()} for char in "AB"]
RELATIONS = [{"subject": "a", "predicate": "uses", "object": "b", "evidence": BODY.strip()}]


class KnowledgeFixture:
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.wiki = WikiStore(self.root)
        self.ontology = OntologyStore(self.wiki)
        self.reviews = ReviewStore(self.wiki)

    def document(self, name="a.md", *, body=BODY, title="A uses B.", plain=False):
        content = body if plain else render_document(body, title=title)
        self.wiki.save(name, content, expected_revision=None)
        return self.wiki.read(name)

    def generate(self, name="a.md", **kwargs):
        return self.ontology.generate(name, self.wiki.read(name).revision, deepcopy(ENTITIES), deepcopy(RELATIONS), **kwargs)

    def accept(self, name="a.md", actor=ACTOR):
        current = self.reviews.query(name)
        return self.reviews.review(name, action="accept", claim_id=current["claims"][0]["claim_id"],
            expected_state_revision=current["state_revision"], reason="isolated contract test", actor=actor)

    def tree(self):
        # Durable invalidation intents may advance even when publication fails.
        # Preservation assertions cover canonical files, not coordination state.
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file() and not path.is_symlink()
                and path.relative_to(self.root).as_posix() != ".storage.lock"
                and path.relative_to(self.root).parts[0] != "_index"}


class KnowledgeStorageTests(KnowledgeFixture, unittest.TestCase):
    def test_active_review_reuses_validated_target_but_checks_changed_values(self):
        """이미 검증한 기계 주장만 재사용하고 편집값·다른 대상의 손상은 거부한다."""
        self.document()
        self.generate()
        self.accept()
        current = self.reviews.query("a.md")
        event = self.reviews._ledger(self.reviews._read_bytes("a.md"), "a.md")["events"][0]
        source = self.wiki.read("a.md")
        before = self.tree()
        with patch("core.modules.reviews.validation._graph", side_effect=AssertionError("duplicate target validation")):
            self.reviews._validate_active_event(source, current["machine_graph"], event)
        changed = deepcopy(event)
        changed["after"]["value"]["evidence"]["quote"] = "Absent source evidence."
        with self.assertRaises(ReviewCorruptError):
            self.reviews._validate_active_event(source, current["machine_graph"], changed)
        changed = deepcopy(event)
        changed["target"]["claim"]["evidence"]["start_line"] += 1
        with self.assertRaises(ReviewCorruptError):
            self.reviews._validate_active_event(source, current["machine_graph"], changed)
        self.assertEqual(self.tree(), before)

    def test_new_layout_body_evidence_and_full_file_coordinates(self):
        source = self.document()
        parsed = parse_document(source.content)
        self.generate()
        graph = self.ontology.query("a.md")
        self.assertTrue((self.root / "_knowledge/graphs" / (parsed.document_id + ".json")).is_file())
        self.assertEqual(graph["relations"][0]["evidence"]["start_line"], parsed.body_start_line)
        self.assertEqual(graph["body_revision"], parsed.body_revision)
        self.assertEqual(graph["source_revision"], source.revision)
        self.assertEqual(graph["evidence_scope"], "body")
        self.assertFalse((self.root / "_ontology").exists())
        self.accept()
        self.assertTrue((self.root / "_knowledge/reviews" / (parsed.document_id + ".json")).is_file())

    def test_metadata_cannot_supply_new_graph_evidence(self):
        self.document(title="MetadataOnly")
        with self.assertRaises(OntologyValidationError):
            self.ontology.generate("a.md", self.wiki.read("a.md").revision,
                [{"id": "x", "label": "MetadataOnly", "type": "concept", "evidence": "MetadataOnly"}], [])
        self.assertFalse((self.root / "_knowledge").exists())

    def test_metadata_and_body_edits_stale_and_keep_full_history(self):
        original = self.document()
        self.generate()
        accepted = self.accept()
        ledger_path = self.reviews._path("a.md")
        ledger_bytes = ledger_path.read_bytes()
        changed = self.wiki.save("a.md", original.content.replace('title: "A uses B."', 'title: "Renamed"'),
                                 expected_revision=original.revision)
        stale = self.ontology.query("a.md")
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["body_revision"], stale["indexed_body_revision"])
        self.assertEqual(stale["relations"], [])
        self.assertEqual(changed.history_path.read_text(), original.content)
        self.assertIn(accepted["event_id"], self.reviews.query("a.md")["pending_history"])
        with self.assertRaises(ReviewConflictError):
            self.generate()
        current = self.reviews.query("a.md")
        self.generate(expected_state_revision=current["state_revision"])
        self.assertEqual(ledger_path.read_bytes(), ledger_bytes)
        self.assertEqual(self.reviews.query("a.md")["claims"][0]["decision"], "unreviewed")
        now = self.wiki.read("a.md")
        self.wiki.save("a.md", now.content + "B stops.\n", expected_revision=now.revision)
        latest = self.ontology.query("a.md")
        self.assertEqual(latest["status"], "stale")
        self.assertNotEqual(latest["body_revision"], latest["indexed_body_revision"])

    def test_old_schema_envelopes_are_read_without_rewriting(self):
        for version in range(1, 7):
            with self.subTest(version=version):
                name = f"v{version}.md"
                source = self.document(name, plain=True)
                graph = _graph(name, source.revision, ENTITIES, RELATIONS, source.content, schema_version=version)
                graph["generation_id"] = uuid4().hex
                path = self.root / "_ontology" / (sha256(name.encode()).hexdigest() + ".json")
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(canonical_json_bytes(graph))
                before = self.tree()
                result = self.ontology.query(name)
                self.assertEqual(result["status"], "ready")
                self.assertEqual(result["schema_version"], version)
                self.assertEqual(result["generation_id"], graph["generation_id"])
                self.assertEqual(self.tree(), before)

    def test_idless_document_read_has_no_content_or_history_side_effect(self):
        self.document(plain=True)
        self.generate()
        self.assertEqual(self.ontology._path("a.md").name, legacy_key("a.md") + ".json")
        before = self.tree()
        self.ontology.context(["a.md"])
        self.reviews.query("a.md")
        self.assertEqual(self.tree(), before)
        self.assertIsNone(parse_document(self.wiki.read("a.md").content).document_id)

    def test_legacy_ledger_preserves_events_and_actor_on_append(self):
        self.document(plain=True)
        self.generate()
        accepted = self.accept(actor=OLD_ACTOR)
        current_path = self.reviews._path("a.md")
        ledger = json.loads(current_path.read_bytes())
        ledger.pop("document_id")
        old_path = self.root / "_reviews" / (sha256(b"a.md").hexdigest() + ".json")
        old_path.parent.mkdir(exist_ok=True)
        old_bytes = canonical_json_bytes(ledger)
        old_path.write_bytes(old_bytes)
        current_path.unlink()  # Fixture: place a genuine old-format envelope in isolation.
        before = self.tree()
        current = self.reviews.query("a.md")
        self.assertEqual(current["history"], accepted["history"])
        self.assertEqual(self.tree(), before)
        self.reviews.undo("a.md", event_id=accepted["event_id"], expected_state_revision=current["state_revision"], reason="test undo", actor=ACTOR)
        updated = json.loads(old_path.read_bytes())
        self.assertEqual(updated["events"][0], ledger["events"][0])
        self.assertNotIn("access_revision", updated["events"][0]["actor"])
        self.assertIn("access_revision", updated["events"][1]["actor"])
        self.assertEqual(_review_prefix(updated, sha256(old_bytes).hexdigest()), 1)
        self.assertFalse(current_path.exists())

    def test_new_ledger_prefix_survives_append(self):
        self.document()
        self.generate()
        first = self.accept()
        prefix = self.reviews._path("a.md").read_bytes()
        self.reviews.undo("a.md", event_id=first["event_id"], expected_state_revision=first["state_revision"], reason="undo", actor=ACTOR)
        ledger = json.loads(self.reviews._path("a.md").read_bytes())
        self.assertEqual(_review_prefix(ledger, sha256(prefix).hexdigest()), 1)

    def test_impact_restores_body_quote_in_new_review_history(self):
        self.document()
        self.generate()
        initial = self.reviews.query("a.md")
        baseline = {name: initial[name] for name in ("source_revision", "graph_revision", "review_revision", "history_revision")}
        self.accept()
        result = ImpactStore(self.wiki).query("a.md", baseline=baseline)
        self.assertFalse(any(row.get("code") == "event_source_unverified" for row in result["skipped"]))
        self.assertTrue(result["restoration"]["complete"])

    def test_dual_layout_conflicts_preserve_graph_and_ledger(self):
        self.document()
        self.generate()
        self.accept()
        for owner, old_folder, operation in ((self.ontology, "_ontology", self.generate),
                                             (self.reviews, "_reviews", lambda: self.reviews.query("a.md"))):
            with self.subTest(folder=old_folder):
                path = owner._path("a.md")
                old = self.root / old_folder / (sha256(b"a.md").hexdigest() + ".json")
                old.parent.mkdir(exist_ok=True)
                old.write_bytes(path.read_bytes())
                before = self.tree()
                with self.assertRaises(KnowledgeStorageConflict):
                    operation()
                self.assertEqual(self.tree(), before)
                old.unlink()

    def test_document_id_path_binding_cannot_overwrite_other_graph(self):
        self.document()
        self.generate()
        self.document("b.md")
        bpath = self.ontology._path("b.md")
        bpath.write_bytes(self.ontology._path("a.md").read_bytes())
        before = self.tree()
        with self.assertRaises(KnowledgeStorageConflict):
            self.generate("b.md")
        self.assertEqual(self.tree(), before)
        with self.assertRaises(DocumentMetadataError):
            self.wiki.save("duplicate.md", self.wiki.read("a.md").content, expected_revision=None)

    def test_source_and_body_revision_cannot_bypass_full_file_cas(self):
        old = self.document()
        self.generate()
        self.wiki.save("a.md", old.content + "Changed.\n", expected_revision=old.revision)
        before = self.tree()
        for revision in (old.revision, parse_document(self.wiki.read("a.md").content).body_revision):
            with self.assertRaises(RevisionConflictError):
                self.ontology.generate("a.md", revision, ENTITIES, RELATIONS)
        self.assertEqual(self.tree(), before)

    def test_full_file_anchor_and_stale_anchor_relabel_rejected(self):
        source = self.document()
        line = parse_document(source.content).body_start_line
        anchor = dict(kind="source_anchor", document="a.md", source_revision=source.revision,
                      quote="B", start_line=line, end_line=line, occurrence=0)
        relation = {**RELATIONS[0], "object": anchor}
        self.ontology.generate("a.md", source.revision, ENTITIES, [relation], schema_version=4)
        bad = deepcopy(relation)
        bad["object"].update(start_line=1, end_line=1)
        with self.assertRaises(OntologyValidationError):
            self.ontology.generate("a.md", source.revision, ENTITIES, [bad], schema_version=4)
        changed = self.wiki.save("a.md", source.content + "Changed.\n", expected_revision=source.revision)
        before = self.tree()
        with self.assertRaises(OntologyValidationError):
            self.ontology.generate("a.md", changed.revision, ENTITIES, [relation], schema_version=4)
        self.assertEqual(self.tree(), before)

    def test_new_generation_never_inherits_human_acceptance(self):
        self.document()
        self.generate()
        accepted = self.accept()
        with self.assertRaises(ReviewConflictError):
            self.generate(force_generation=True)
        result = self.generate(force_generation=True, expected_state_revision=accepted["state_revision"])
        after = self.reviews.query("a.md")
        self.assertNotEqual(result["graph_revision"], accepted["graph_revision"])
        self.assertIn(accepted["event_id"], after["pending_history"])
        self.assertEqual(after["claims"][0]["decision"], "unreviewed")

    def test_relabeling_saved_source_revision_does_not_make_graph_current(self):
        source = self.document()
        self.generate()
        path = self.ontology._path("a.md")
        graph = json.loads(path.read_bytes())
        current = self.wiki.save("a.md", source.content + "Changed.\n", expected_revision=source.revision)
        graph["source_revision"] = current.revision
        path.write_bytes(canonical_json_bytes(graph))  # Tampered-cache fixture.
        before = self.tree()
        with self.assertRaises(OntologyCorruptError):
            self.ontology.query("a.md")
        self.assertEqual(self.reviews.query("a.md")["status"], "unavailable")
        self.assertEqual(self.tree(), before)

    def test_expert_policy_is_preserved_as_pending_after_regeneration(self):
        self.document()
        self.generate()
        initial = self.reviews.query("a.md")
        claim = initial["claims"][0]
        replacement = {key: deepcopy(value) for key, value in claim["value"].items()
                       if key not in {"evidence", "provenance"}}
        replacement["predicate"] = "depends_on"
        policy = self.reviews.policy("a.md", claim_id=claim["claim_id"], replacement=replacement,
            expected_state_revision=initial["state_revision"], reason="simulated expert contract test", actor=ACTOR)
        self.assertEqual(policy["policies"][0]["status"], "active")
        self.assertIsNone(policy["policies"][0]["value"]["evidence"])
        ledger = self.reviews._path("a.md").read_bytes()
        self.generate(force_generation=True, expected_state_revision=policy["state_revision"])
        current = self.reviews.query("a.md")
        self.assertEqual(current["policies"][0]["status"], "pending")
        self.assertEqual(current["effective_graph"]["relations"][0]["predicate"], "uses")
        self.assertEqual(self.reviews._path("a.md").read_bytes(), ledger)

    def test_knowledge_symlink_is_refused_without_touching_target(self):
        self.document()
        path = self.ontology._path("a.md")
        path.parent.mkdir(parents=True)
        target = self.root / "unrelated.json"
        target.write_bytes(b"preserve")
        path.symlink_to(target)
        with self.assertRaises(ValueError):
            self.generate()
        self.assertEqual(target.read_bytes(), b"preserve")

    def test_concurrent_review_cas_has_one_winner(self):
        self.document()
        self.generate()
        initial = self.reviews.query("a.md")
        barrier = Barrier(2)
        def attempt(action):
            barrier.wait()
            try:
                ReviewStore(WikiStore(self.root)).review("a.md", action=action, actor=ACTOR, reason="race",
                    claim_id=initial["claims"][0]["claim_id"], expected_state_revision=initial["state_revision"])
                return "saved"
            except ReviewConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertCountEqual(executor.map(attempt, ["accept", "reject"]), ["saved", "conflict"])
        self.assertEqual(len(self.reviews.query("a.md")["history"]), 1)

    def test_failed_graph_and_review_publication_preserve_previous_bytes(self):
        self.document()
        self.generate()
        accepted = self.accept()
        before = self.tree()
        def fail(_src, _dest):
            raise OSError("injected publication failure")
        with patch("core.modules.ontology.store.os.replace", side_effect=fail):
            with self.assertRaises(OSError):
                self.generate(force_generation=True, expected_state_revision=accepted["state_revision"])
        self.assertEqual(self.tree(), before)
        with patch("core.modules.reviews.ledger.os.replace", side_effect=fail):
            with self.assertRaises(OSError):
                self.reviews.undo("a.md", event_id=accepted["event_id"], expected_state_revision=accepted["state_revision"], reason="undo", actor=ACTOR)
        self.assertEqual(self.tree(), before)

    def test_orphan_new_review_is_discovered_without_rewriting(self):
        self.document()
        self.generate()
        accepted = self.accept()
        (self.wiki.wiki_dir / "a.md").unlink()  # Missing-source fixture, never real user data.
        before = self.tree()
        with self.wiki._write_lock():
            capture = ConceptCapture(self.wiki, actor=ACTOR, mode="find")
            self.assertIn("a.md", capture.scan_documents())
            entry = capture.document("a.md")
        self.assertEqual(entry["history"][0]["id"], accepted["event_id"])
        self.assertIsNone(entry["effective_graph"])
        self.assertEqual(self.tree(), before)

    def test_links_ignore_front_matter_and_keep_full_file_line_numbers(self):
        text = render_document("[B](b.md)\n", title="[Wrong](wrong.md)")
        links = list(_source_links(text))
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0][0], "b.md")
        self.assertEqual(links[0][1]["start_line"], parse_document(text).body_start_line)

    def test_other_document_bad_metadata_is_reported_as_incomplete(self):
        self.document()
        self.generate()
        (self.wiki.wiki_dir / "broken.md").write_text("---\nbroken metadata\n")
        result = self.ontology.connections("a.md")
        self.assertTrue(any(item["document"] == "broken.md" for item in result["skipped"]))

    def test_catalogue_matches_document_metadata_and_authorship(self):
        source = SourceStore(self.wiki)
        staged = source.stage(BytesIO(BODY.encode()), kind="file", title="Original", format="txt", filename="original.txt")
        registered = source.commit(staged, tenant="team", user_id="alice", request_id=uuid4().hex, authorize=lambda: ACTOR)
        text = render_document(BODY, title="Current", source={"id": registered["source_id"], "version": registered["source_version"]})
        self.wiki.save("a.md", text, expected_revision=None, actor=ACTOR, origin={"kind": "ai", "provider": "test"})
        direct = list_documents(self.wiki, tenant="team", scope_key="test")["items"][0]
        catalogue = list_catalogue(self.wiki, tenant="team", scope_key="test")["items"]
        entry = next(item for item in catalogue if item.get("document") == "a.md")
        for name in ("metadata", "document_id", "body_revision", "authorship"):
            self.assertEqual(entry[name], direct[name])
        self.assertEqual(entry["source_status"], "linked")
        self.assertEqual(entry["authorship"]["created"]["actor"]["user_id"], "alice")
        self.assertEqual(entry["authorship"]["created"]["origin"]["kind"], "ai")

    def test_access_revision_drives_concept_and_queue_currentness(self):
        for name in ("a.md", "b.md"):
            self.document(name)
            self.generate(name)
        def find(actor):
            return ConceptStore(self.wiki, actor=actor).find("A", documents=["a.md"], as_of="2026-10-28T00:00:00+00:00")
        other_signup = {**ACTOR, "policy_revision": "2" * 64}
        revoked = {**ACTOR, "access_revision": "3" * 64}
        self.assertEqual(find(ACTOR)["snapshot_revision"], find(other_signup)["snapshot_revision"])
        self.assertNotEqual(find(ACTOR)["snapshot_revision"], find(revoked)["snapshot_revision"])
        arguments = dict(documents=["a.md", "b.md"], correspondence_ids=[], states=["unreviewed"], limit=1)
        first = review_queue(self.wiki, ACTOR, **arguments)
        self.assertIsNotNone(first["next_cursor"])
        review_queue(self.wiki, other_signup, cursor=first["next_cursor"], **arguments)
        with self.assertRaises(InvalidCursorError):
            review_queue(self.wiki, revoked, cursor=first["next_cursor"], **arguments)


class CorrespondenceStorageTests(KnowledgeFixture, unittest.TestCase):
    def draft(self):
        anchors = []
        for name in ("left.md", "right.md"):
            source = self.document(name)
            line = parse_document(source.content).body_start_line
            anchors.append(dict(document=name, source_revision=source.revision, quote=BODY.strip(), start_line=line, end_line=line))
        return dict(condition=anchors[0], concept=anchors[1], statement="A possible correspondence", direction="condition_to_concept",
            qualifiers=dict(quantity=dict(status="not_applicable", expression="none"), conditions=dict(status="none", items=[]), exceptions=dict(status="none", items=[])),
            business_scope=dict(axes=[dict(name="domain", status="unrestricted", value=None, source="test")], validity=dict(status="unrestricted", source="test")),
            basis=dict(kind="candidate", reason="test candidate", link_evidence=[]), references=[], questions=["Same meaning?"], related_to=[])

    def propose(self):
        owner = CorrespondenceStore(self.wiki, ACTOR)
        draft = self.draft()
        prepared = owner.query(draft=draft)
        saved = owner.propose(prepared["correspondence_id"], draft, prepared["state_revision"], "test proposal")
        return owner, saved

    def test_correspondence_new_old_layouts_and_dual_conflict(self):
        owner, saved = self.propose()
        cid = saved["correspondence_id"]
        current = owner._path(cid)
        self.assertEqual(current.parent, self.root / "_knowledge/correspondences")
        old = self.root / "_reviews/correspondences" / current.name
        old.parent.mkdir(parents=True)
        old.write_bytes(current.read_bytes())
        before = self.tree()
        with self.assertRaises(KnowledgeStorageConflict):
            owner.query(cid)
        self.assertFalse(owner.find(["left.md"])["complete"])
        self.assertEqual(self.tree(), before)
        current.unlink()
        detail = owner.query(cid)
        self.assertEqual(len(owner.find(["left.md"])["results"]), 1)
        owner.review(cid, "defer", detail["state_revision"], "needs context")
        self.assertEqual(len(owner.query(cid)["history"]), 2)
        self.assertFalse(current.exists())

    def test_correspondence_access_revision_cas_and_failed_write(self):
        owner, saved = self.propose()
        cid = saved["correspondence_id"]
        detail = owner.query(cid)
        updated = CorrespondenceStore(self.wiki, {**ACTOR, "policy_revision": "2" * 64})
        self.assertEqual(updated.query(cid)["state_revision"], detail["state_revision"])
        revoked = CorrespondenceStore(self.wiki, {**ACTOR, "access_revision": "3" * 64})
        with self.assertRaises(CorrespondenceConflictError):
            revoked.review(cid, "defer", detail["state_revision"], "changed access")
        before = self.tree()
        with patch("core.modules.correspondences.ledger.os.replace", side_effect=OSError("injected failure")):
            with self.assertRaises(OSError):
                owner.review(cid, "defer", detail["state_revision"], "test")
        self.assertEqual(self.tree(), before)
        source = self.wiki.read("left.md")
        self.wiki.save("left.md", source.content + "Changed.\n", expected_revision=source.revision)
        with self.assertRaises(CorrespondenceConflictError):
            owner.review(cid, "defer", detail["state_revision"], "old basis")

    def test_correspondence_success_and_cleanup_warning_are_separate(self):
        owner = CorrespondenceStore(self.wiki, ACTOR)
        draft = self.draft()
        prepared = owner.query(draft=draft)
        unlink = Path.unlink
        def fail_temp(path, *args, **kwargs):
            if path.name.startswith(".wiki-"):
                raise OSError("injected cleanup failure")
            return unlink(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_temp):
            result = owner.propose(prepared["correspondence_id"], draft, prepared["state_revision"], "test")
        self.assertTrue(result["changed"])
        self.assertEqual(len(result["cleanup_failures"]), 1)
        self.assertEqual(len(owner.query(prepared["correspondence_id"])["history"]), 1)
