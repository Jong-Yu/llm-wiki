"""문서 페이지·변경 기준·읽기 한도 검사는 임시 저장소에서만 수행한다."""

import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.documents.listing import (
    CatalogChangedError, InvalidCursorError, list_documents,
)
from core.modules.documents.store import StorageBusyError, WikiStore


class DocumentListingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-listing-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = WikiStore(self.root, lock_timeout_seconds=0)

    def save(self, document, content="원문"):
        return self.store.save(document, content, expected_revision=None)

    def listing(self, **kwargs):
        return list_documents(self.store, tenant="alpha", scope_key="user:policy:profile", **kwargs)

    def test_empty_listing_is_complete_without_creating_documents(self):
        result = self.listing()
        self.assertEqual(result["items"], [])
        self.assertTrue(result["complete"])
        self.assertFalse(result["truncated"])
        self.assertIsNone(result["next_cursor"])
        self.assertEqual(result["skipped"], [])
        self.assertEqual(list(self.store.wiki_dir.iterdir()), [])
        self.assertEqual(result["scope"], {"tenant": "alpha", "kind": "wiki_documents"})

    def test_single_existing_document_has_actual_revision_and_no_source_link(self):
        saved = self.save("주제/본문.md", "본문\r\n🌱")
        result = self.listing()
        self.assertEqual(result["items"], [{"document": "주제/본문.md", "revision": saved.revision,
                                             "source_status": "unlinked"}])
        self.assertTrue(result["complete"])

    def test_default_twenty_and_maximum_fifty_pages_are_stably_sorted(self):
        names = [f"문서/{number:03}.md" for number in range(53)]
        for name in reversed(names):
            self.save(name)
        default = self.listing()
        self.assertEqual([item["document"] for item in default["items"]], names[:20])
        first = self.listing(limit=50)
        second = self.listing(limit=50, cursor=first["next_cursor"])
        self.assertEqual([item["document"] for item in first["items"] + second["items"]], names)
        self.assertEqual(first["catalog_revision"], second["catalog_revision"])
        self.assertFalse(first["complete"])
        self.assertFalse(first["truncated"])
        self.assertTrue(second["complete"])
        self.assertIsNone(second["next_cursor"])

    def test_root_and_nested_names_use_whole_relative_path_order(self):
        names = ["z.md", "a/b.md", "a.md", "한글.md"]
        for name in names:
            self.save(name)
        self.assertEqual([item["document"] for item in self.listing()["items"]], sorted(names))

    def test_added_changed_and_deleted_documents_expire_existing_cursor(self):
        for mutation in ("add", "change", "delete"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                store = WikiStore(temporary)
                store.save("a.md", "before", expected_revision=None)
                store.save("b.md", "before", expected_revision=None)
                first = list_documents(store, tenant="alpha", scope_key="s", limit=1)
                if mutation == "add":
                    store.save("c.md", "new", expected_revision=None)
                elif mutation == "change":
                    snapshot = store.read("b.md")
                    store.save("b.md", "after", expected_revision=snapshot.revision)
                else:
                    (store.wiki_dir / "b.md").unlink()
                with self.assertRaises(CatalogChangedError) as caught:
                    list_documents(store, tenant="alpha", scope_key="s", cursor=first["next_cursor"])
                self.assertTrue(caught.exception.requires_refresh)
                refreshed = list_documents(store, tenant="alpha", scope_key="s")
                self.assertNotEqual(first["catalog_revision"], refreshed["catalog_revision"])

    def test_cursor_is_bound_to_tenant_and_current_authorization_scope(self):
        self.save("a.md")
        self.save("b.md")
        first = self.listing(limit=1)
        for tenant, scope in (("beta", "user:policy:profile"), ("alpha", "other_user"),
                              ("alpha", "new_policy"), ("alpha", "other_profile")):
            with self.subTest(tenant=tenant, scope=scope), self.assertRaises(InvalidCursorError):
                list_documents(self.store, tenant=tenant, scope_key=scope, cursor=first["next_cursor"])

    def test_bad_cursor_shape_and_unknown_position_are_rejected(self):
        self.save("a.md")
        self.save("b.md")
        first = self.listing(limit=1)
        cursor = first["next_cursor"]
        value = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        value["after"] = "unknown.md"
        changed = base64.urlsafe_b64encode(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).rstrip(b"=").decode()
        for candidate in ("", "!bad", "e30", "x" * 16385, cursor + "=", changed):
            with self.subTest(candidate=candidate[:30]), self.assertRaises(InvalidCursorError):
                self.listing(cursor=candidate)

    def test_limits_reject_coercion_boolean_and_outside_range(self):
        for limit in (True, False, 0, -1, 51, "20", 1.0, None):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                self.listing(limit=limit)

    def test_file_budget_returns_partial_without_unsafe_continuation(self):
        for number in range(4):
            self.save(f"{number}.md")
        with patch("core.modules.documents.listing.MAX_LIST_FILES", 2):
            result = self.listing(limit=1)
        self.assertFalse(result["complete"])
        self.assertTrue(result["truncated"])
        self.assertIsNone(result["next_cursor"])
        self.assertEqual(len(result["items"]), 1)

    def test_entry_budget_includes_non_markdown_and_directories(self):
        for number in range(4):
            (self.store.wiki_dir / f"{number}.txt").write_text("ignored")
        self.save("last.md")
        with patch("core.modules.documents.listing.MAX_LIST_ENTRIES", 2):
            result = self.listing()
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        self.assertIsNone(result["next_cursor"])

    def test_skip_budget_stops_unsafe_entries_and_marks_incomplete(self):
        outside = self.root / "outside.md"
        outside.write_text("private")
        for number in range(3):
            (self.store.wiki_dir / f"{number}.md").symlink_to(outside)
        with patch("core.modules.documents.listing.MAX_LIST_SKIPPED", 2):
            result = self.listing()
        self.assertEqual(len(result["skipped"]), 2)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        self.assertIsNone(result["next_cursor"])

    def test_read_failure_is_partial_sanitized_and_other_documents_survive(self):
        self.save("a.md")
        self.save("b.md")
        original = self.store.read

        def failed(document):
            if document == "a.md":
                raise PermissionError("secret /server/absolute/path")
            return original(document)

        with patch.object(self.store, "read", side_effect=failed):
            result = self.listing()
        self.assertEqual([item["document"] for item in result["items"]], ["b.md"])
        self.assertEqual(result["skipped"], [{"document": "a.md", "code": "read_failed"}])
        self.assertFalse(result["complete"])
        self.assertNotIn("/server/absolute/path", json.dumps(result))

    def test_oversized_and_invalid_utf8_files_are_reported_not_truncated_or_deleted(self):
        self.save("okay.md")
        (self.store.wiki_dir / "large.md").write_bytes(b"x" * (1024 * 1024 + 1))
        (self.store.wiki_dir / "bad.md").write_bytes(b"\xff")
        before = {path.name: path.read_bytes() for path in self.store.wiki_dir.iterdir()}
        result = self.listing()
        self.assertEqual([item["document"] for item in result["items"]], ["okay.md"])
        self.assertEqual({entry["document"]: entry["code"] for entry in result["skipped"]},
                         {"bad.md": "invalid_document", "large.md": "document_too_large"})
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.store.wiki_dir.iterdir()})

    def test_symlinks_and_nonregular_files_are_never_followed(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "private.md").write_text("private text")
        (self.store.wiki_dir / "linked").symlink_to(outside, target_is_directory=True)
        (self.store.wiki_dir / "linked.md").symlink_to(outside / "private.md")
        os.mkfifo(self.store.wiki_dir / "pipe.md")
        result = self.listing()
        self.assertEqual(result["items"], [])
        self.assertEqual(len(result["skipped"]), 3)
        self.assertFalse(result["complete"])
        self.assertNotIn("private text", json.dumps(result))
        self.assertNotIn(str(outside), json.dumps(result))

    def test_busy_lock_is_distinct_and_does_not_read_documents(self):
        self.save("a.md")
        with self.store._write_lock(), patch.object(self.store, "read") as reader:
            with self.assertRaises(StorageBusyError):
                self.listing()
            reader.assert_not_called()

    def test_listing_preserves_source_history_graph_and_review_bytes(self):
        saved = self.save("a.md", "old")
        self.store.save("a.md", "new", expected_revision=saved.revision)
        for directory in ("_ontology", "_reviews"):
            (self.root / directory).mkdir()
            (self.root / directory / "fixture.json").write_bytes(b'{"unchanged":true}\n')
        before = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        result = self.listing()
        after = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.assertTrue(result["complete"])
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
