"""휴지통의 원문/이력 보존, 권한·CAS·실패·검색 배제를 격리 자료로 검사한다."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.api.dependencies import access_value
from core.modules.documents import trash
from core.modules.documents.metadata import render_document
from core.modules.documents.store import WikiStore, RevisionConflictError
from core.modules.knowledge.catalogue import list_catalogue
from core.modules.knowledge.capture import ConceptCapture
from core.modules.knowledge.concepts import ConceptStore
from core.modules.knowledge.question_index import discover
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.sources.store import SourceStore
from core.modules.sources import trash as source_trash, files, contracts
from core.modules.sources.contracts import SourceConflictError, SourceLimitError, SourceCorruptError
from core.tests.poc_knowledge.test_storage import ACTOR, ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class TrashStorageTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.store = WikiStore(self.root, tracked_reads=True)
        self.content = render_document("A uses B.\r\n", title="Original")
        self.first = self.store.save("folder/a.md", self.content, expected_revision=None)
        self.current = self.content.replace("Original", "Updated")
        self.saved = self.store.save("folder/a.md", self.current, expected_revision=self.first.revision)
        self.sources = SourceStore(self.store)

    def source(self):
        staged = self.sources.stage(BytesIO(b"Exact original.\r\n"), kind="text", title="Source", format="txt")
        return self.sources.commit(staged, tenant=ACTOR["tenant"], user_id=ACTOR["user_id"],
            request_id=uuid4().hex, authorize=lambda: dict(ACTOR))

    def listing(self):
        return list_catalogue(self.store, tenant="team", scope_key="scope")

    def test_round_trip_preserves_bytes_history_and_warm_catalog(self):
        before_history = {p.name: p.read_bytes() for p in (self.store.history_dir / "folder/a.md").iterdir()}
        self.assertEqual(len(self.listing()["items"]), 1)
        result = trash.move_to_trash(self.store, "folder/a.md", self.saved.revision, actor=ACTOR)
        self.assertEqual(result["state"], "trashed")
        self.assertEqual(self.listing()["items"], [])
        with self.assertRaises(FileNotFoundError):
            self.store.read("folder/a.md")
        with self.assertRaises(RevisionConflictError):
            self.store.save("folder/a.md", "resurrected", expected_revision=None)
        page = trash.list_trash(self.store)
        self.assertTrue(page["complete"])
        self.assertEqual(page["items"][0]["revision"], self.saved.revision)
        trash.restore(self.store, "folder/a.md", self.saved.revision)
        self.assertEqual(self.store.read("folder/a.md").content, self.current)
        self.assertEqual(trash.list_trash(self.store)["items"], [])
        self.assertEqual(len(self.listing()["items"]), 1)
        for name, raw in before_history.items():
            self.assertEqual((self.store.history_dir / "folder/a.md" / name).read_bytes(), raw)
        self.assertEqual((self.store.history_dir / "folder/a.md" / result["history_id"]).read_bytes(), self.current.encode())

    def test_wrong_basis_and_authorization_failure_do_not_change_original(self):
        with self.assertRaises(RevisionConflictError):
            trash.move_to_trash(self.store, "folder/a.md", self.first.revision)
        def deny():
            raise PermissionError("revoked")
        with self.assertRaises(PermissionError):
            trash.move_to_trash(self.store, "folder/a.md", self.saved.revision, before_commit=deny)
        self.assertEqual(self.store.read("folder/a.md").content, self.current)
        self.assertEqual(trash.list_trash(self.store)["items"], [])

    def test_history_and_move_failures_keep_current_bytes(self):
        with patch.object(self.store, "_archive", side_effect=OSError("history unavailable")):
            with self.assertRaises(OSError):
                trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)
        self.assertEqual(self.store.read("folder/a.md").content, self.current)
        with patch.object(trash.os, "rename", side_effect=OSError("move unavailable")):
            with self.assertRaises(OSError):
                trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)
        self.assertEqual(self.store.read("folder/a.md").content, self.current)
        self.assertEqual(trash.list_trash(self.store)["items"], [])
        trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)

    def test_authorization_revoked_during_archive_prevents_delete(self):
        allowed = True
        def authorize():
            if not allowed:
                raise PermissionError("revoked during history preservation")
        archive = self.store._archive
        def revoke_after_archive(*args, **kwargs):
            nonlocal allowed
            result = archive(*args, **kwargs)
            allowed = False
            return result
        with patch.object(self.store, "_archive", side_effect=revoke_after_archive):
            with self.assertRaises(PermissionError):
                trash.move_to_trash(self.store, "folder/a.md", self.saved.revision, before_commit=authorize)
        self.assertEqual(self.store.read("folder/a.md").content, self.current)
        self.assertEqual(trash.list_trash(self.store)["items"], [])
        self.assertIn(self.current.encode(), [path.read_bytes()
            for path in (self.store.history_dir / "folder/a.md").glob("*.md")])

    def test_authorization_revoked_during_metadata_check_prevents_restore(self):
        trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)
        allowed = True
        def authorize():
            if not allowed:
                raise PermissionError("revoked during restore validation")
        validate = self.store._validate_metadata
        def revoke_after_validation(*args, **kwargs):
            nonlocal allowed
            validate(*args, **kwargs)
            allowed = False
        with patch.object(self.store, "_validate_metadata", side_effect=revoke_after_validation):
            with self.assertRaises(PermissionError):
                trash.restore(self.store, "folder/a.md", self.saved.revision, before_commit=authorize)
        with self.assertRaises(FileNotFoundError):
            self.store.read("folder/a.md")
        self.assertEqual(trash.list_trash(self.store)["items"][0]["revision"], self.saved.revision)
        self.assertEqual((trash.directory(self.store, "folder/a.md") / "content.md").read_bytes(), self.current.encode())

    def test_restore_conflict_failure_and_identity_collision_keep_trash(self):
        trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)
        with self.assertRaises(RevisionConflictError):
            trash.restore(self.store, "folder/a.md", self.first.revision)
        with patch.object(trash.os, "rename", side_effect=OSError("restore unavailable")):
            with self.assertRaises(OSError):
                trash.restore(self.store, "folder/a.md", self.saved.revision)
        self.store.save("duplicate.md", self.current, expected_revision=None)
        with self.assertRaises(ValueError):
            trash.restore(self.store, "folder/a.md", self.saved.revision)
        self.assertEqual(trash.list_trash(self.store)["items"][0]["revision"], self.saved.revision)

    def test_concurrent_delete_and_edit_cannot_lose_newer_content(self):
        def delete():
            try:
                return trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)["state"]
            except (RevisionConflictError, FileNotFoundError):
                return "conflict"
        def edit():
            try:
                self.store.save("folder/a.md", self.current + "New", expected_revision=self.saved.revision)
                return "edited"
            except RevisionConflictError:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            a, b = pool.submit(delete), pool.submit(edit)
            results = [a.result(), b.result()]
        self.assertEqual(results.count("conflict"), 1)
        if "edited" in results:
            self.assertEqual(self.store.read("folder/a.md").content, self.current + "New")
        else:
            self.assertEqual((trash.directory(self.store, "folder/a.md") / "content.md").read_bytes(), self.current.encode())

    def test_graph_review_and_question_discovery_are_preserved_but_excluded(self):
        ontology = OntologyStore(self.store)
        ontology.generate("folder/a.md", self.saved.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        reviews = ReviewStore(self.store)
        review = reviews.query("folder/a.md")
        reviews.review("folder/a.md", action="accept", claim_id=review["claims"][0]["claim_id"],
            expected_state_revision=review["state_revision"], reason="Isolated", actor=ACTOR)
        knowledge = {p: p.read_bytes() for p in (self.root / "_knowledge").rglob("*.json")}
        owner = ConceptStore(self.store, ACTOR)
        self.assertTrue(owner.find("uses")["matches"])
        self.assertEqual(discover(self.store, ACTOR, "uses", [], [])["documents"], ["folder/a.md"])
        trash.move_to_trash(self.store, "folder/a.md", self.saved.revision, actor=ACTOR)
        self.assertEqual(owner.find("uses")["matches"], [])
        self.assertEqual(discover(self.store, ACTOR, "uses", [], [])["documents"], [])
        with self.store._write_lock():
            capture = ConceptCapture(self.store, actor=ACTOR)
            self.assertEqual(capture.scan_documents(), [])
        for path, raw in knowledge.items():
            self.assertEqual(path.read_bytes(), raw)
        trash.restore(self.store, "folder/a.md", self.saved.revision)
        self.assertTrue(owner.find("uses")["matches"])
        self.assertEqual(discover(self.store, ACTOR, "uses", [], [])["documents"], ["folder/a.md"])

    def test_cleanup_failure_is_success_with_retained_snapshot(self):
        original_unlink = Path.unlink
        def fail_temporary(path, *args, **kwargs):
            if path.name.startswith(".wiki-") and path.parent == self.store.history_dir / "folder/a.md":
                raise PermissionError("temporary cleanup failed")
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_temporary):
            result = trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)
        self.assertEqual(result["state"], "trashed")
        self.assertEqual(len(result["cleanup_failures"]), 1)
        self.assertEqual(trash.list_trash(self.store)["items"][0]["revision"], self.saved.revision)

    def test_corrupt_metadata_is_reported_without_replacing_preserved_content(self):
        trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)
        location = trash.directory(self.store, "folder/a.md")
        record_path = location / "record.json"
        record = json.loads(record_path.read_text())
        record["deleted_at"] = ["invalid"]
        record_path.write_text(json.dumps(record))
        page = trash.list_trash(self.store)
        self.assertFalse(page["complete"])
        self.assertTrue(page["skipped"])
        with self.assertRaises(SourceCorruptError):
            trash.restore(self.store, "folder/a.md", self.saved.revision)
        self.assertEqual((location / "content.md").read_bytes(), self.current.encode())

    def test_source_trash_preserves_original_quota_linked_wiki_and_warm_lists(self):
        source = self.source()
        linked = render_document("Linked body", title="Linked", source={"id": source["source_id"], "version": source["source_version"]})
        self.store.save("linked.md", linked, expected_revision=None)
        original_files = {p: p.read_bytes() for p in self.sources.sources_dir.rglob("*") if p.is_file()}
        usage = files.original_usage(self.store, incoming=False)
        self.sources.list_sources(tenant="team", scope_key="scope")
        self.listing()
        result = source_trash.set_state(self.sources, source["source_id"], source["registration_revision"], authorize=lambda: ACTOR)
        self.assertEqual(result["state"], "trashed")
        self.assertEqual(self.sources.list_sources(tenant="team", scope_key="scope")["items"], [])
        self.assertEqual(self.sources.search_titles("Source")["matches"], [])
        self.assertEqual(len(self.listing()["items"]), 2)
        with self.assertRaises(FileNotFoundError):
            self.sources.get_source(source["source_id"])
        stream, _ = self.sources.open_original(source["source_id"], source["source_version"])
        with stream:
            self.assertEqual(stream.read(), b"Exact original.\r\n")
        linked_snapshot = self.store.read("linked.md")
        self.store.save("linked.md", linked + " edited", expected_revision=linked_snapshot.revision)
        self.assertEqual(files.original_usage(self.store, incoming=False), usage)
        for path, raw in original_files.items():
            self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(len(source_trash.list_trash(self.sources)["items"]), 1)
        source_trash.set_state(self.sources, source["source_id"], source["registration_revision"], restore=True, authorize=lambda: ACTOR)
        self.assertEqual(source_trash.list_trash(self.sources)["items"], [])
        self.assertEqual(len(self.sources.list_sources(tenant="team", scope_key="scope")["items"]), 1)

    def test_deleted_sources_still_count_toward_registration_quota(self):
        source = self.source()
        source_trash.set_state(self.sources, source["source_id"], source["registration_revision"], authorize=lambda: ACTOR)
        with patch.object(contracts, "MAX_SOURCES", 1):
            with self.assertRaises(SourceLimitError):
                self.source()
        self.assertEqual(len(source_trash.list_trash(self.sources)["items"]), 1)

    def test_source_conflict_failed_publish_and_deleted_version_write_preserve_bytes(self):
        source = self.source()
        with self.assertRaises(SourceConflictError):
            source_trash.set_state(self.sources, source["source_id"], "0" * 64, authorize=lambda: ACTOR)
        with patch.object(source_trash, "write_record", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                source_trash.set_state(self.sources, source["source_id"], source["registration_revision"], authorize=lambda: ACTOR)
        self.assertEqual(self.sources.get_source(source["source_id"])["registration_revision"], source["registration_revision"])
        source_trash.set_state(self.sources, source["source_id"], source["registration_revision"], authorize=lambda: ACTOR)
        staged = self.sources.stage(BytesIO(b"Replacement"), kind="text", title="New", format="txt")
        with self.assertRaises(FileNotFoundError):
            self.sources.commit(staged, tenant="team", user_id="alice", request_id=uuid4().hex,
                source_id=source["source_id"], expected_registration_revision=source["registration_revision"], authorize=lambda: ACTOR)
        self.assertEqual(len(source_trash.list_trash(self.sources)["items"]), 1)

    def test_unsafe_trash_path_does_not_move_original(self):
        target = self.root / "outside"
        target.mkdir()
        (self.root / "_trash").symlink_to(target, target_is_directory=True)
        with self.assertRaises(ValueError):
            trash.move_to_trash(self.store, "folder/a.md", self.saved.revision)
        self.assertEqual(self.store.read("folder/a.md").content, self.current)


class TrashApiTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.prefix = f"/api/v1/tenants/{self.tenant}"
        self.scope = self.policy.authorize(self.token, self.tenant, "write")
        self.actor = access_value(self.scope)
        self.saved = self.scope.store.save("example.md", "Exact body\r\n", expected_revision=None)

    def test_document_api_round_trip_and_cas(self):
        body = {"document": "example.md", "expected_revision": self.saved.revision}
        wrong = self.client.post(self.prefix + "/documents/trash", json={**body, "expected_revision": "0" * 64}, headers=self.headers())
        self.assertEqual(wrong.status_code, 409)
        response = self.client.post(self.prefix + "/documents/trash", json=body, headers=self.headers())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"]["state"], "trashed")
        listing = self.client.get(self.prefix + "/documents/trash", headers=self.headers())
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertTrue(listing.json()["data"]["complete"])
        self.assertEqual(self.client.get(self.prefix + "/documents/content", params={"document": "example.md"}, headers=self.headers()).status_code, 404)
        restored = self.client.post(self.prefix + "/documents/trash/restore", json=body, headers=self.headers())
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(self.scope.store.read("example.md").content, "Exact body\r\n")

    def test_source_api_and_write_permissions(self):
        source = self.client.post(self.prefix + "/sources", json={"request_id": uuid4().hex,
            "title": "Original", "format": "txt", "content": "Preserve"}, headers=self.headers()).json()["data"]
        source_path = self.prefix + "/sources/" + source["source_id"]
        body = {"expected_registration_revision": source["registration_revision"]}
        response = self.client.post(source_path + "/trash", json=body, headers=self.headers())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.get(source_path, headers=self.headers()).status_code, 404)
        listing = self.client.get(self.prefix + "/sources-trash", headers=self.headers())
        self.assertEqual(len(listing.json()["data"]["items"]), 1)
        restored = self.client.post(source_path + "/restore", json=body, headers=self.headers())
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(self.client.get(source_path, headers=self.headers()).status_code, 200)
        self.assertEqual(self.client.post(source_path + "/trash", json=body, headers=self.headers()).status_code, 200)
        def read_only(value):
            value["users"][self.user["user_id"]]["memberships"][self.tenant]["permissions"] = ["read"]
        self.change_policy(read_only)
        denied = self.client.post(source_path + "/restore", json=body, headers=self.headers())
        self.assertEqual(denied.status_code, 403)
        denied = self.client.post(self.prefix + "/documents/trash", json={"document": "example.md", "expected_revision": self.saved.revision}, headers=self.headers())
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(self.scope.store.read("example.md").content, "Exact body\r\n")


if __name__ == "__main__":
    unittest.main()
