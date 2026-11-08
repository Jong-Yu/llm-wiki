"""전체 질문 근거의 불변 분리 저장을 격리 자료에서 확인한다."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.knowledge.aggregation import prepare_question
from core.modules.personal import question_basis as module
from core.modules.personal.question_basis import QuestionBasisStore, describe_basis, is_basis_reference
from core.modules.personal.store import PersonalCorruptError, PersonalLimitError
from core.modules.sources import files
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR


class QuestionBasisTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document()
        self.generate()
        self.scope = SimpleNamespace(store=self.wiki, **ACTOR)
        self.store = QuestionBasisStore(self.scope)
        self.basis = prepare_question(self.wiki, ACTOR, documents=["a.md"],
            required_documents=["a.md"], claims=[], source_refs=[])

    def changed(self, **values):
        basis = {**deepcopy(self.basis), **values}
        basis.pop("snapshot_revision")
        return {**basis, "snapshot_revision": canonical_json_hash(basis)}

    def large(self):
        return self.changed(verified_history_text="원문·조건과 예외 😀\n" * 100000)

    def preserved_files(self, directory):
        return {p.relative_to(directory).as_posix(): p.read_bytes()
            for p in directory.rglob("*") if p.is_file() and not p.is_symlink()}

    def test_descriptor_does_not_write_or_change_input(self):
        basis = self.large()
        original = deepcopy(basis)
        tree = self.tree()
        value = describe_basis(basis)
        self.assertEqual(self.tree(), tree)
        self.assertEqual(basis, original)
        self.assertFalse(is_basis_reference(value))
        self.assertNotIn("verified_history_text", value)
        self.assertNotIn("content", value["documents"][0])
        self.assertNotIn("knowledge", value["documents"][0])
        self.assertEqual(value["documents"][0]["id"], "d1")
        self.assertEqual(value["documents"][0]["title"], "A uses B.")
        self.assertEqual(value["documents"][0]["graph_revision"], basis["documents"][0]["knowledge"]["graph_revision"])
        for key in ("scope", "snapshot_revision", "complete", "can_prepare", "truncated", "skipped"):
            self.assertEqual(value[key], basis[key])

    def test_large_unicode_basis_round_trips_and_each_file_stays_below_json_cap(self):
        basis = self.large()
        original = deepcopy(basis)
        self.assertGreater(len(canonical_json_bytes(basis)), 1024 * 1024)
        reference = self.store.freeze(basis)
        self.assertTrue(is_basis_reference(reference))
        self.assertLess(len(canonical_json_bytes(reference)), 128 * 1024)
        self.assertEqual(self.store.load(reference), basis)
        self.assertEqual(basis, original)
        path = self.store._path(reference["basis_id"])
        self.assertGreater(len(list(path.glob("component-*.txt"))), 1)
        self.assertTrue(all(p.stat().st_size < 1024 * 1024 for p in path.iterdir()))
        loaded = self.store.load(reference)
        loaded["documents"].clear()
        self.assertEqual(self.store.load(reference), original)

    def test_same_basis_reuses_immutable_files_and_works_under_parent_lock(self):
        reference = self.store.freeze(self.basis)
        path = self.store._path(reference["basis_id"])
        before = self.preserved_files(path)
        mtimes = {p.name: p.stat().st_mtime_ns for p in path.iterdir()}
        self.assertEqual(self.store.freeze(deepcopy(self.basis)), reference)
        self.assertEqual(self.preserved_files(path), before)
        self.assertEqual({p.name: p.stat().st_mtime_ns for p in path.iterdir()}, mtimes)
        with self.store.personal._coordination():
            self.assertEqual(self.store.load(reference), self.basis)

    def test_concurrent_same_basis_has_one_publication(self):
        basis = self.large()
        barrier = Barrier(4)
        def freeze():
            barrier.wait()
            return QuestionBasisStore(self.scope).freeze(basis)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: freeze(), range(4)))
        self.assertTrue(all(value == results[0] for value in results))
        self.assertEqual(files.entries(self.wiki, self.store.root, maximum=10), [results[0]["basis_id"]])
        self.assertEqual(self.store.load(results[0]), basis)

    def test_owner_tenant_and_profile_roots_do_not_read_another_binding(self):
        reference = self.store.freeze(self.basis)
        for values in ({"user_id": "bob"}, {"tenant": "other-team"}, {"profile_id": "other-view"}):
            with self.subTest(values=values):
                scope = SimpleNamespace(store=self.wiki, **{**ACTOR, **values})
                other = QuestionBasisStore(scope)
                self.assertNotEqual(other.root, self.store.root)
                with self.assertRaises(FileNotFoundError):
                    other.load(reference)
                changed = deepcopy(self.basis)
                changed["scope"]["profile"].update(values)
                changed.pop("snapshot_revision")
                changed["snapshot_revision"] = canonical_json_hash(changed)
                own = other.freeze(changed)
                self.assertEqual(other.load(own), changed)
                self.assertEqual(self.store.load(reference), self.basis)

    def test_wrong_binding_or_changed_snapshot_is_rejected_before_publication(self):
        before = self.tree()
        changed = deepcopy(self.basis)
        changed["scope"]["profile"]["user_id"] = "bob"
        changed.pop("snapshot_revision")
        changed["snapshot_revision"] = canonical_json_hash(changed)
        with self.assertRaises(PersonalCorruptError):
            self.store.freeze(changed)
        broken = deepcopy(self.basis)
        broken["documents"][0]["content"] = "Changed after preparation"
        with self.assertRaises(PersonalCorruptError):
            self.store.freeze(broken)
        self.assertEqual(self.tree(), before)

    def test_tampered_reference_and_traversal_do_not_change_existing_files(self):
        reference = self.store.freeze(self.basis)
        before = self.tree()
        for patch_value in ({"basis_id": "../a"}, {"snapshot_revision": "f" * 64},
                            {"documents": []}, {"extra": "not a reference field"}):
            with self.subTest(patch_value=patch_value), self.assertRaises(PersonalCorruptError):
                self.store.load({**reference, **patch_value})
        self.assertEqual(self.tree(), before)

    def test_missing_or_tampered_component_is_corrupt_without_repair(self):
        reference = self.store.freeze(self.large())
        path = self.store._path(reference["basis_id"])
        part = next(path.glob("component-*.txt"))
        original = part.read_bytes()
        part.write_bytes(b"invalid replacement")
        with self.assertRaises(PersonalCorruptError):
            self.store.load(reference)
        self.assertEqual(part.read_bytes(), b"invalid replacement")
        part.write_bytes(original)
        part.unlink()
        with self.assertRaises(PersonalCorruptError):
            self.store.load(reference)
        self.assertFalse(part.exists())

    def test_symlink_components_are_rejected(self):
        reference = self.store.freeze(self.basis)
        path = self.store._path(reference["basis_id"])
        part = next(path.glob("component-*.txt"))
        other = self.root / "unrelated.txt"
        other.write_bytes(part.read_bytes())
        part.unlink()
        part.symlink_to(other)
        with self.assertRaises(PersonalCorruptError):
            self.store.load(reference)
        self.assertTrue(part.is_symlink())

    def test_manifest_binding_or_descriptor_tamper_is_rejected(self):
        reference = self.store.freeze(self.basis)
        path = self.store._path(reference["basis_id"])
        manifest_path = path / "manifest.json"
        original = files.read_json(self.wiki, manifest_path)
        bad = deepcopy(original)
        bad["binding"]["user_id"] = "bob"
        files.write_json(self.wiki, manifest_path, bad)
        with self.assertRaises(PersonalCorruptError):
            self.store.load(reference)
        bad = deepcopy(original)
        bad["components"]["part-0000"].pop("file")
        files.write_json(self.wiki, manifest_path, bad)
        with self.assertRaises(PersonalCorruptError):
            self.store.freeze(self.basis)
        self.assertEqual(files.read_json(self.wiki, manifest_path), bad)

    def test_partial_basis_is_described_but_cannot_be_frozen(self):
        basis = self.changed(complete=False, can_prepare=False, skipped=[{"code": "capture_limit"}], truncated=True)
        before = self.tree()
        self.assertFalse(describe_basis(basis)["can_prepare"])
        with self.assertRaises(ValueError):
            self.store.freeze(basis)
        self.assertEqual(self.tree(), before)

    def test_size_count_and_total_quota_reject_without_altering_prior_bundle(self):
        reference = self.store.freeze(self.basis)
        path = self.store._path(reference["basis_id"])
        before = self.preserved_files(path)
        changed = self.changed(extra="a new immutable version")
        for name, limit in (("MAX_BASIS_BYTES", 1024), ("MAX_BUNDLES", 1), ("MAX_SCOPE_BYTES", 1)):
            with self.subTest(name=name), patch.object(module, name, limit), self.assertRaises(PersonalLimitError):
                self.store.freeze(changed)
        self.assertEqual(self.preserved_files(path), before)
        self.assertEqual(self.store.load(reference), self.basis)

    def test_publication_failure_preserves_prior_bundle_and_removes_own_pending(self):
        reference = self.store.freeze(self.basis)
        path = self.store._path(reference["basis_id"])
        before = self.preserved_files(path)
        with patch.object(module.immutable_files.os, "rename", side_effect=OSError("isolated rename failure")):
            with self.assertRaises(OSError):
                self.store.freeze(self.changed(extra="new"))
        self.assertEqual(self.preserved_files(path), before)
        self.assertEqual(files.entries(self.wiki, self.store.root, maximum=10), [reference["basis_id"]])
        self.assertEqual(self.store.load(reference), self.basis)

    def test_cleanup_failure_is_attached_to_original_failure_without_retry(self):
        reference = self.store.freeze(self.basis)
        path = self.store._path(reference["basis_id"])
        before = self.preserved_files(path)
        original_unlink = Path.unlink
        def deny_own_cleanup(value, *args, **kwargs):
            if any(part.startswith(".pending-") for part in value.parts):
                raise PermissionError("isolated cleanup failure")
            return original_unlink(value, *args, **kwargs)
        with patch.object(module.immutable_files.os, "rename", side_effect=OSError("isolated publication failure")) as rename:
            with patch.object(Path, "unlink", deny_own_cleanup):
                with self.assertRaises(OSError) as raised:
                    self.store.freeze(self.changed(extra="new version"))
        self.assertEqual(rename.call_count, 1)
        self.assertTrue(raised.exception.cleanup_failures)
        self.assertTrue(all(".pending-" in row["path"] for row in raised.exception.cleanup_failures))
        self.assertEqual(self.preserved_files(path), before)
        self.assertEqual(self.store.load(reference), self.basis)

    def test_oversized_component_is_rejected_before_common_bundle_read(self):
        reference = self.store.freeze(self.basis)
        path = self.store._path(reference["basis_id"])
        part = next(path.glob("component-*.txt"))
        part.write_bytes(b"x" * (module._MAX_PART_BYTES + 1))
        with patch.object(module.immutable_files, "load") as load:
            with self.assertRaises(PersonalCorruptError):
                self.store.load(reference)
        load.assert_not_called()

    def test_old_wiki_and_history_are_unchanged_and_old_basis_stays_exact(self):
        source = self.wiki.read("a.md")
        reference = self.store.freeze(self.basis)
        changed = self.wiki.save("a.md", source.content + "A newer fact.\n", expected_revision=source.revision)
        history = changed.history_path.read_bytes()
        self.assertEqual(self.store.load(reference), self.basis)
        self.assertEqual(self.wiki.read("a.md").revision, changed.revision)
        self.assertEqual(changed.history_path.read_bytes(), history)
        self.assertEqual(sha256(history).hexdigest(), source.revision)

    def test_original_and_web_descriptors_keep_origin_without_copying_text(self):
        source_ref = {"source_id": "a" * 32, "source_version": "b" * 32, "source_sha256": "c" * 64}
        web = {"query": "isolated example", "status": "complete", "warnings": [], "sources": [{
            "url": "https://example.com/reference", "title": "Source title", "content": "Full web text\n",
            "content_sha256": sha256(b"Full web text\n").hexdigest(), "retrieved_at": "2026-11-06T00:00:00Z"}]}
        basis = self.changed(originals=[{"source_ref": source_ref, "manifest": {"title": "Original title"},
                                        "content": "Exact original text\n"}], web=web)
        descriptor = describe_basis(basis)
        self.assertEqual(descriptor["originals"][0]["id"], "o1")
        self.assertEqual(descriptor["originals"][0]["source_ref"], source_ref)
        self.assertEqual(descriptor["web"]["sources"][0]["id"], "w1")
        self.assertNotIn("content", descriptor["web"]["sources"][0])
        reference = self.store.freeze(basis)
        self.assertEqual(self.store.load(reference), basis)

    def test_material_line_count_keeps_unicode_separators_inside_original_line(self):
        self.document("unicode.md", body="A\u2028B\r\nC\u2029D\n", plain=True)
        basis = prepare_question(self.wiki, ACTOR, documents=["unicode.md"],
            required_documents=[], claims=[], source_refs=[])
        descriptor = describe_basis(basis)
        self.assertEqual(descriptor["documents"][0]["line_count"], 2)
        self.assertEqual(self.store.load(self.store.freeze(basis)), basis)


if __name__ == "__main__":
    unittest.main()
