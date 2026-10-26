"""Storage behavior tests; all data lives in TemporaryDirectory instances."""

from contextlib import contextmanager
from dataclasses import FrozenInstanceError
import errno
from hashlib import sha256
import multiprocessing
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from core.modules.documents.store import (
    CleanupFailure,
    DEFAULT_LOCK_TIMEOUT_SECONDS,
    DocumentSnapshot,
    DocumentTooLargeError,
    MAX_DOCUMENT_BYTES,
    RevisionConflictError,
    SaveResult,
    StorageBusyError,
    WikiStore,
)


def _edit_same_base(data_dir, worker, barrier, results):
    store = WikiStore(data_dir)
    snapshot = store.read("shared.md")
    # All participants finish reading before any writer can proceed.
    barrier.wait(timeout=20)
    try:
        store.save("shared.md", f"worker-{worker}", expected_revision=snapshot.revision)
    except RevisionConflictError as error:
        results.put(("conflict", worker, error.expected_revision, error.current_revision))
    else:
        results.put(("saved", worker, snapshot.revision, None))


def _create_same_path(data_dir, worker, barrier, results):
    store = WikiStore(data_dir)
    barrier.wait(timeout=20)
    try:
        store.save("shared.md", f"worker-{worker}", expected_revision=None)
    except RevisionConflictError as error:
        results.put(("conflict", worker, error.expected_revision, error.current_revision))
    else:
        results.put(("saved", worker, None, None))


def _hold_write_lock(data_dir, ready, release):
    with WikiStore(data_dir)._write_lock():
        ready.set()
        if not release.wait(timeout=20):
            raise RuntimeError("test lock holder did not receive release signal")


class WikiStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.data = self.root / "data"
        self.data.mkdir()
        self.store = WikiStore(self.data)

    def histories(self):
        return sorted(p for p in self.store.history_dir.rglob("*.md") if p.is_file())

    def assert_no_temporary_files(self):
        self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [])

    def test_create_and_read_preserves_unicode_and_line_endings(self):
        text = "# 한글 제목\r\n본문 🌱\n\n"
        result = self.store.save("주제/문서.md", text, expected_revision=None)
        self.assertIsInstance(result, SaveResult)
        self.assertTrue(result.changed)
        self.assertIsNone(result.history_path)
        self.assertEqual(result.cleanup_failures, ())
        snapshot = self.store.read("주제/문서.md")
        self.assertIsInstance(snapshot, DocumentSnapshot)
        self.assertEqual(snapshot.content, text)
        self.assertEqual(result.revision, snapshot.revision)
        self.assertEqual(snapshot.revision, sha256(text.encode("utf-8")).hexdigest())
        self.assertEqual((self.store.wiki_dir / "주제/문서.md").read_bytes(), text.encode())
        self.assertEqual(self.histories(), [])
        self.assert_no_temporary_files()

    def test_snapshot_is_immutable_and_revision_survives_new_store_instance(self):
        self.store.save("note.md", "original", expected_revision=None)
        snapshot = self.store.read("note.md")
        self.assertEqual(WikiStore(self.data).read("note.md"), snapshot)
        with self.assertRaises(FrozenInstanceError):
            snapshot.content = "changed"
        with self.assertRaises(FrozenInstanceError):
            snapshot.revision = "changed"
        self.assertEqual(self.store.read("note.md"), snapshot)

    @contextmanager
    def observe_document_reads(self, target, before=None, after=None):
        """Observe actual read sizes while optionally changing a temporary fixture."""
        real_open = Path.open
        observations = []

        @contextmanager
        def observed_open(path, mode="r", *args, **kwargs):
            with real_open(path, mode, *args, **kwargs) as stream:
                if path != target or mode != "rb":
                    yield stream
                    return

                class ObservedReader:
                    def read(self, size=-1):
                        if before is not None:
                            before()
                        content = stream.read(size)
                        observations.append((size, len(content)))
                        if after is not None:
                            after(content)
                        return content

                yield ObservedReader()

        with patch.object(Path, "open", observed_open):
            yield observations

    def test_read_content_and_revision_come_from_same_bytes(self):
        self.store.save("note.md", "first", expected_revision=None)
        target = self.store.wiki_dir / "note.md"
        reads = []

        def replace_after_read(content):
            reads.append(content)
            replacement = target.with_name("replacement.md")
            replacement.write_bytes(b"second")
            os.replace(replacement, target)

        # Direct writes are confined to this temporary concurrency fixture.
        with self.observe_document_reads(target, after=replace_after_read) as observed:
            snapshot = self.store.read("note.md")
        self.assertEqual(observed, [(MAX_DOCUMENT_BYTES + 1, len(b"first"))])
        self.assertEqual(reads, [b"first"])
        self.assertEqual(snapshot.content, "first")
        self.assertEqual(snapshot.revision, sha256(b"first").hexdigest())
        self.assertEqual(self.store.read("note.md").content, "second")

    def test_repeated_updates_keep_every_full_prior_version(self):
        revisions = ["첫 내용\r\n", "", "둘째 내용\n" * 100, "최신 내용"]
        self.store.save("topic/note.md", revisions[0], expected_revision=None)
        versions = []
        for content in revisions[1:]:
            snapshot = self.store.read("topic/note.md")
            versions.append(self.store.save("topic/note.md", content,
                                            expected_revision=snapshot.revision).history_path)
        self.assertEqual(self.store.read("topic/note.md").content, revisions[-1])
        self.assertEqual(len(set(versions)), 3)
        self.assertEqual([p.read_bytes() for p in versions], [s.encode() for s in revisions[:-1]])
        self.assertEqual(len(self.histories()), 3)
        self.assert_no_temporary_files()

    def test_unchanged_content_does_not_create_duplicate_history(self):
        self.store.save("note.md", "before", expected_revision=None)
        prior = self.store.save("note.md", "after", expected_revision=self.store.read("note.md").revision).history_path
        after = self.store.read("note.md")
        result = self.store.save("note.md", "after", expected_revision=after.revision)
        self.assertEqual(result, SaveResult(after.revision, None, False, ()))
        self.assertEqual(self.store.read("note.md"), after)
        self.assertEqual(self.histories(), [prior])
        self.assertEqual(prior.read_bytes(), b"before")
        self.assert_no_temporary_files()

    def test_stale_edit_is_rejected_without_changing_current_or_history(self):
        self.store.save("Guide.md", "original", expected_revision=None)
        author_a = self.store.read("Guide.md")
        author_b = self.store.read("Guide.md")
        prior = self.store.save("Guide.md", "A's edit", expected_revision=author_a.revision).history_path
        current = self.store.read("Guide.md")
        with self.assertRaises(RevisionConflictError) as raised:
            self.store.save("Guide.md", "B's edit", expected_revision=author_b.revision)
        self.assertEqual(raised.exception.document, "Guide.md")
        self.assertEqual(raised.exception.expected_revision, author_b.revision)
        self.assertEqual(raised.exception.current_revision, current.revision)
        self.assertEqual(self.store.read("Guide.md"), current)
        self.assertEqual(self.histories(), [prior])
        self.assertEqual(prior.read_bytes(), b"original")
        self.assert_no_temporary_files()

    def test_stale_revision_is_rejected_even_if_submitted_content_matches_current(self):
        self.store.save("note.md", "before", expected_revision=None)
        before = self.store.read("note.md")
        prior = self.store.save("note.md", "after", expected_revision=before.revision).history_path
        after = self.store.read("note.md")
        with self.assertRaises(RevisionConflictError):
            self.store.save("note.md", "after", expected_revision=before.revision)
        self.assertEqual(self.store.read("note.md"), after)
        self.assertEqual(self.histories(), [prior])
        self.assert_no_temporary_files()

    def test_create_only_rejects_existing_document_even_with_identical_content(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        for content in ("replacement", "original"):
            with self.subTest(content=content):
                with self.assertRaises(RevisionConflictError) as raised:
                    self.store.save("note.md", content, expected_revision=None)
                self.assertIsNone(raised.exception.expected_revision)
                self.assertEqual(raised.exception.current_revision, original.revision)
        self.assertEqual(self.store.read("note.md"), original)
        self.assertEqual(self.histories(), [])
        self.assert_no_temporary_files()

    def test_existing_revision_cannot_create_a_missing_document(self):
        expected = sha256(b"old content").hexdigest()
        with self.assertRaises(RevisionConflictError) as raised:
            self.store.save("missing/note.md", "replacement", expected_revision=expected)
        self.assertEqual(raised.exception.document, "missing/note.md")
        self.assertEqual(raised.exception.expected_revision, expected)
        self.assertIsNone(raised.exception.current_revision)
        self.assertEqual(list(self.store.wiki_dir.iterdir()), [])
        self.assertEqual(self.histories(), [])
        self.assert_no_temporary_files()

    def test_expected_revision_is_required_and_keyword_only(self):
        with self.assertRaises(TypeError):
            self.store.save("note.md", "content")
        with self.assertRaises(TypeError):
            self.store.save("note.md", "content", None)
        self.assertEqual(list(self.store.wiki_dir.iterdir()), [])
        self.assertEqual(self.histories(), [])

    def test_expected_revision_rejects_invalid_types(self):
        for expected in (0, False, b"revision", [], object()):
            with self.subTest(expected=expected):
                with self.assertRaises(TypeError):
                    self.store.save("note.md", "content", expected_revision=expected)
        self.assertEqual(list(self.store.wiki_dir.iterdir()), [])
        self.assertEqual(self.histories(), [])

    def test_conflict_can_be_resolved_by_reading_and_reapplying_changes(self):
        self.store.save("Guide.md", "소개: 원본\n설치: 원본\n", expected_revision=None)
        author_a = self.store.read("Guide.md")
        author_b = self.store.read("Guide.md")
        first_history = self.store.save(
            "Guide.md", author_a.content.replace("소개: 원본", "소개: A 수정"),
            expected_revision=author_a.revision).history_path
        with self.assertRaises(RevisionConflictError):
            self.store.save(
                "Guide.md", author_b.content.replace("설치: 원본", "설치: B 수정"),
                expected_revision=author_b.revision)
        refreshed = self.store.read("Guide.md")
        second_history = self.store.save(
            "Guide.md", refreshed.content.replace("설치: 원본", "설치: B 수정"),
            expected_revision=refreshed.revision).history_path
        self.assertEqual(self.store.read("Guide.md").content, "소개: A 수정\n설치: B 수정\n")
        self.assertEqual(first_history.read_text(), author_a.content)
        self.assertEqual(second_history.read_text(), refreshed.content)
        self.assertEqual(len(self.histories()), 2)
        self.assert_no_temporary_files()

    def test_revision_identifies_content_state_when_content_returns_to_original(self):
        self.store.save("note.md", "A", expected_revision=None)
        original = self.store.read("note.md")
        first = self.store.save("note.md", "B", expected_revision=original.revision).history_path
        intermediate = self.store.read("note.md")
        self.assertNotEqual(intermediate.revision, original.revision)
        second = self.store.save("note.md", "A", expected_revision=intermediate.revision).history_path
        self.assertEqual(self.store.read("note.md"), original)
        third = self.store.save("note.md", "C", expected_revision=original.revision).history_path
        self.assertEqual(self.store.read("note.md").content, "C")
        self.assertEqual([p.read_bytes() for p in (first, second, third)], [b"A", b"B", b"A"])

    def test_missing_document_raises_file_not_found(self):
        with self.assertRaises(FileNotFoundError):
            self.store.read("missing.md")

    def test_history_directory_failure_keeps_original(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        blocker = self.store.history_dir / "note.md"
        blocker.write_bytes(b"existing user file")
        with self.assertRaises(FileExistsError):
            self.store.save("note.md", "replacement", expected_revision=original.revision)
        self.assertEqual(self.store.read("note.md"), original)
        self.assertEqual(blocker.read_bytes(), b"existing user file")
        self.assert_no_temporary_files()

    def test_history_flush_failure_keeps_original_and_existing_versions(self):
        self.store.save("note.md", "oldest", expected_revision=None)
        prior = self.store.save("note.md", "current", expected_revision=self.store.read("note.md").revision).history_path
        current = self.store.read("note.md")
        real_fsync = os.fsync
        calls = 0

        def fail_history_flush(descriptor):
            nonlocal calls
            calls += 1
            # The new current file is staged first, then the history file.
            if calls == 2:
                raise OSError(errno.ENOSPC, "simulated history flush failure")
            return real_fsync(descriptor)

        with patch("core.modules.documents.store.os.fsync", side_effect=fail_history_flush):
            with self.assertRaises(OSError) as raised:
                self.store.save("note.md", "replacement", expected_revision=current.revision)
        self.assertEqual(raised.exception.errno, errno.ENOSPC)
        self.assertEqual(calls, 2)
        self.assertEqual(self.store.read("note.md"), current)
        self.assertEqual(self.histories(), [prior])
        self.assertEqual(prior.read_bytes(), b"oldest")
        self.assert_no_temporary_files()

    def test_history_publish_failure_keeps_original_and_allows_same_revision_retry(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        with patch("core.modules.documents.store.os.link", side_effect=PermissionError("history denied")):
            with self.assertRaises(PermissionError):
                self.store.save("note.md", "replacement", expected_revision=original.revision)
        self.assertEqual(self.store.read("note.md"), original)
        self.assertEqual(self.histories(), [])
        self.assert_no_temporary_files()
        prior = self.store.save("note.md", "replacement", expected_revision=original.revision).history_path
        self.assertEqual(prior.read_bytes(), b"original")
        self.assertEqual(self.store.read("note.md").content, "replacement")

    def test_version_collision_never_overwrites_history_or_original(self):
        self.store.save("note.md", "oldest", expected_revision=None)
        with patch.object(WikiStore, "_version_name", return_value="fixed-version.md"):
            prior = self.store.save("note.md", "current", expected_revision=self.store.read("note.md").revision).history_path
            with self.assertRaises(FileExistsError):
                self.store.save("note.md", "replacement", expected_revision=self.store.read("note.md").revision)
        self.assertEqual(self.store.read("note.md").content, "current")
        self.assertEqual(prior.read_bytes(), b"oldest")
        self.assertEqual(self.histories(), [prior])
        self.assert_no_temporary_files()

    def test_current_replace_failure_keeps_complete_snapshot_and_revision(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        with patch("core.modules.documents.store.os.replace", side_effect=PermissionError("replace denied")):
            with self.assertRaises(PermissionError):
                self.store.save("note.md", "replacement", expected_revision=original.revision)
        self.assertEqual(self.store.read("note.md"), original)
        self.assertEqual([p.read_bytes() for p in self.histories()], [b"original"])
        self.assert_no_temporary_files()

    def test_save_result_and_cleanup_failure_are_immutable(self):
        result = self.store.save("note.md", "content", expected_revision=None)
        with self.assertRaises(FrozenInstanceError):
            result.changed = False
        failure = CleanupFailure(self.root / "temporary.tmp", PermissionError("denied"))
        with self.assertRaises(FrozenInstanceError):
            failure.path = self.root / "other.tmp"

    def test_create_cleanup_failure_reports_success_and_preserves_unrelated_file(self):
        unrelated = self.store.wiki_dir / ".wiki-unrelated.tmp"
        unrelated.write_bytes(b"user-owned fixture")
        cleanup_error = PermissionError(errno.EACCES, "cleanup denied")
        with patch.object(Path, "unlink", side_effect=cleanup_error):
            result = self.store.save("note.md", "created", expected_revision=None)
        self.assertTrue(result.changed)
        self.assertIsNone(result.history_path)
        self.assertEqual(result.revision, self.store.read("note.md").revision)
        self.assertEqual(self.store.read("note.md").content, "created")
        self.assertEqual(len(result.cleanup_failures), 1)
        failure = result.cleanup_failures[0]
        self.assertIsInstance(failure, CleanupFailure)
        self.assertIs(failure.error, cleanup_error)
        self.assertEqual(failure.path.read_bytes(), b"created")
        self.assertNotEqual(failure.path, unrelated)
        self.assertEqual(unrelated.read_bytes(), b"user-owned fixture")
        self.assertEqual(set(self.data.rglob(".wiki-*.tmp")), {failure.path, unrelated})
        self.assertEqual(self.histories(), [])
        # Retrying a successful create is a conflict, not a recovery operation.
        with self.assertRaises(RevisionConflictError):
            self.store.save("note.md", "created", expected_revision=None)

    def test_history_cleanup_failure_still_reports_successful_update(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        cleanup_error = PermissionError(errno.EACCES, "history cleanup denied")
        real_unlink = Path.unlink

        def deny_history_cleanup(path, *args, **kwargs):
            if self.store.history_dir in path.parents:
                raise cleanup_error
            return real_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", deny_history_cleanup):
            result = self.store.save("note.md", "updated", expected_revision=original.revision)
        self.assertTrue(result.changed)
        self.assertEqual(self.store.read("note.md").content, "updated")
        self.assertEqual(result.revision, self.store.read("note.md").revision)
        self.assertEqual(result.history_path.read_bytes(), b"original")
        self.assertEqual(self.histories(), [result.history_path])
        self.assertEqual(len(result.cleanup_failures), 1)
        failure = result.cleanup_failures[0]
        self.assertIs(failure.error, cleanup_error)
        self.assertEqual(failure.path.read_bytes(), b"original")
        self.assertEqual(list(self.data.rglob(".wiki-*.tmp")), [failure.path])

    def test_successful_replace_does_not_unlink_consumed_staging_path(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        real_unlink = Path.unlink
        cleaned = []

        def observe_cleanup(path, *args, **kwargs):
            cleaned.append(path)
            if path.parent == self.store.wiki_dir:
                raise AssertionError("rename consumed this staging path")
            return real_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", observe_cleanup):
            result = self.store.save("note.md", "updated", expected_revision=original.revision)
        self.assertEqual(self.store.read("note.md").content, "updated")
        self.assertEqual(result.history_path.read_bytes(), b"original")
        self.assertEqual(result.cleanup_failures, ())
        self.assertEqual(len(cleaned), 1)
        self.assert_no_temporary_files()

    def test_cleanup_failure_does_not_mask_staging_fsync_failure(self):
        primary_error = OSError(errno.ENOSPC, "staging fsync failed")
        cleanup_error = PermissionError(errno.EACCES, "cleanup denied")
        with patch("core.modules.documents.store.os.fsync", side_effect=primary_error), \
                patch.object(Path, "unlink", side_effect=cleanup_error):
            with self.assertRaises(OSError) as raised:
                self.store.save("note.md", "content", expected_revision=None)
        self.assertIs(raised.exception, primary_error)
        self.assertEqual(raised.exception.errno, errno.ENOSPC)
        self.assertFalse((self.store.wiki_dir / "note.md").exists())
        self.assertEqual(self.histories(), [])
        failures = raised.exception.cleanup_failures
        self.assertIsInstance(failures, tuple)
        self.assertEqual(len(failures), 1)
        self.assertIs(failures[0].error, cleanup_error)
        self.assertEqual(failures[0].path.read_bytes(), b"content")

    def test_cleanup_failure_does_not_mask_new_document_publish_failure(self):
        primary_error = PermissionError(errno.EPERM, "create link denied")
        cleanup_error = PermissionError(errno.EACCES, "cleanup denied")
        with patch("core.modules.documents.store.os.link", side_effect=primary_error), \
                patch.object(Path, "unlink", side_effect=cleanup_error):
            with self.assertRaises(PermissionError) as raised:
                self.store.save("note.md", "content", expected_revision=None)
        self.assertIs(raised.exception, primary_error)
        self.assertEqual(raised.exception.errno, errno.EPERM)
        self.assertFalse((self.store.wiki_dir / "note.md").exists())
        self.assertEqual(self.histories(), [])
        self.assertEqual(len(raised.exception.cleanup_failures), 1)
        self.assertIs(raised.exception.cleanup_failures[0].error, cleanup_error)

    def test_cleanup_failures_do_not_mask_history_publish_failure(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        primary_error = PermissionError(errno.EPERM, "history link denied")
        cleanup_error = PermissionError(errno.EACCES, "cleanup denied")
        with patch("core.modules.documents.store.os.link", side_effect=primary_error), \
                patch.object(Path, "unlink", side_effect=cleanup_error):
            with self.assertRaises(PermissionError) as raised:
                self.store.save("note.md", "updated", expected_revision=original.revision)
        self.assertIs(raised.exception, primary_error)
        self.assertEqual(raised.exception.errno, errno.EPERM)
        self.assertEqual(self.store.read("note.md"), original)
        self.assertEqual(self.histories(), [])
        failures = raised.exception.cleanup_failures
        self.assertEqual(len(failures), 2)
        self.assertEqual({failure.path.read_bytes() for failure in failures},
                         {b"original", b"updated"})
        self.assertTrue(all(failure.error is cleanup_error for failure in failures))
        self.assertEqual(set(self.data.rglob(".wiki-*.tmp")),
                         {failure.path for failure in failures})

    def test_cleanup_failures_do_not_mask_current_replace_failure(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        primary_error = PermissionError(errno.EPERM, "replace denied")
        cleanup_error = PermissionError(errno.EACCES, "cleanup denied")
        with patch("core.modules.documents.store.os.replace", side_effect=primary_error), \
                patch.object(Path, "unlink", side_effect=cleanup_error):
            with self.assertRaises(PermissionError) as raised:
                self.store.save("note.md", "updated", expected_revision=original.revision)
        self.assertIs(raised.exception, primary_error)
        self.assertEqual(raised.exception.errno, errno.EPERM)
        self.assertEqual(self.store.read("note.md"), original)
        self.assertEqual([p.read_bytes() for p in self.histories()], [b"original"])
        failures = raised.exception.cleanup_failures
        self.assertEqual(len(failures), 2)
        self.assertEqual({failure.path.read_bytes() for failure in failures},
                         {b"original", b"updated"})
        self.assertTrue(all(failure.error is cleanup_error for failure in failures))
        self.assertEqual(set(self.data.rglob(".wiki-*.tmp")),
                         {failure.path for failure in failures})

    def test_exact_ascii_size_limit_allows_read_update_and_full_history(self):
        self.assertEqual(MAX_DOCUMENT_BYTES, 1024 * 1024)
        original = "a" * MAX_DOCUMENT_BYTES
        self.store.save("large.md", original, expected_revision=None)
        snapshot = self.store.read("large.md")
        self.assertEqual(snapshot.content, original)
        updated = original[:-1] + "b"
        result = self.store.save("large.md", updated, expected_revision=snapshot.revision)
        self.assertEqual(self.store.read("large.md").content, updated)
        self.assertEqual(result.history_path.read_bytes(), original.encode("utf-8"))
        self.assert_no_temporary_files()

    def test_multibyte_utf8_limit_uses_bytes_and_rejects_before_writes(self):
        for character in ("가", "🌱"):
            with self.subTest(character=character):
                width = len(character.encode("utf-8"))
                text = character * (MAX_DOCUMENT_BYTES // width)
                text += "a" * (MAX_DOCUMENT_BYTES % width)
                document = f"{width}-byte.md"
                self.assertEqual(len(text.encode("utf-8")), MAX_DOCUMENT_BYTES)
                self.store.save(document, text, expected_revision=None)
                before = self.store.read(document)
                with patch.object(self.store, "_write_lock", side_effect=AssertionError("must not lock")):
                    with self.assertRaises(DocumentTooLargeError) as raised:
                        self.store.save(document, text + "a", expected_revision=before.revision)
                self.assertEqual(raised.exception.document, document)
                self.assertEqual(raised.exception.limit_bytes, MAX_DOCUMENT_BYTES)
                self.assertEqual(raised.exception.observed_bytes, MAX_DOCUMENT_BYTES + 1)
                self.assertEqual(self.store.read(document), before)
                self.assertEqual(self.histories(), [])
                self.assert_no_temporary_files()

    def test_oversize_string_rejects_before_encoding_or_filesystem_writes(self):
        class EncodingForbidden(str):
            def encode(self, *args, **kwargs):
                raise AssertionError("oversize text must be rejected before encoding")

        content = EncodingForbidden("x" * (MAX_DOCUMENT_BYTES + 1))
        with patch.object(self.store, "_write_lock", side_effect=AssertionError("must not lock")):
            with self.assertRaises(DocumentTooLargeError) as raised:
                self.store.save("new/note.md", content, expected_revision=None)
        self.assertEqual(raised.exception.document, "new/note.md")
        self.assertEqual(raised.exception.limit_bytes, MAX_DOCUMENT_BYTES)
        self.assertGreater(raised.exception.observed_bytes, MAX_DOCUMENT_BYTES)
        self.assertFalse((self.data / ".storage.lock").exists())
        self.assertEqual(list(self.store.wiki_dir.iterdir()), [])
        self.assertEqual(self.histories(), [])
        self.assert_no_temporary_files()

    def test_oversize_update_preserves_current_and_existing_history(self):
        self.store.save("note.md", "oldest", expected_revision=None)
        result = self.store.save("note.md", "current", expected_revision=self.store.read("note.md").revision)
        current = self.store.read("note.md")
        with self.assertRaises(DocumentTooLargeError):
            self.store.save("note.md", "x" * (MAX_DOCUMENT_BYTES + 1),
                            expected_revision=current.revision)
        self.assertEqual(self.store.read("note.md"), current)
        self.assertEqual(self.histories(), [result.history_path])
        self.assertEqual(result.history_path.read_bytes(), b"oldest")
        self.assert_no_temporary_files()

    def test_existing_oversize_document_rejects_bounded_read_and_update(self):
        self.store.save("note.md", "oldest", expected_revision=None)
        prior = self.store.save("note.md", "current",
                                expected_revision=self.store.read("note.md").revision).history_path
        target = self.store.wiki_dir / "note.md"
        # Simulate an externally supplied preexisting document in this fixture.
        external = b"x" * (MAX_DOCUMENT_BYTES + 100)
        target.write_bytes(external)
        for operation in ("read", "save"):
            with self.subTest(operation=operation):
                with self.observe_document_reads(target) as observed:
                    with self.assertRaises(DocumentTooLargeError) as raised:
                        if operation == "read":
                            self.store.read("note.md")
                        else:
                            self.store.save("note.md", "smaller", expected_revision=sha256(external).hexdigest())
                self.assertEqual(observed, [(MAX_DOCUMENT_BYTES + 1, MAX_DOCUMENT_BYTES + 1)])
                self.assertEqual(raised.exception.observed_bytes, MAX_DOCUMENT_BYTES + 1)
                self.assertEqual(target.read_bytes(), external)
                self.assertEqual(self.histories(), [prior])
                self.assertEqual(prior.read_bytes(), b"oldest")
                self.assert_no_temporary_files()

    def test_document_growing_after_open_is_rejected_with_bounded_read(self):
        for operation in ("read", "save"):
            with self.subTest(operation=operation):
                document = f"{operation}.md"
                self.store.save(document, "initial", expected_revision=None)
                before = self.store.read(document)
                target = self.store.wiki_dir / document

                def grow_after_open():
                    with target.open("ab") as stream:
                        stream.write(b"x" * MAX_DOCUMENT_BYTES)

                with self.observe_document_reads(target, before=grow_after_open) as observed:
                    with self.assertRaises(DocumentTooLargeError):
                        if operation == "read":
                            self.store.read(document)
                        else:
                            self.store.save(document, "updated", expected_revision=before.revision)
                self.assertEqual(observed, [(MAX_DOCUMENT_BYTES + 1, MAX_DOCUMENT_BYTES + 1)])
                self.assertEqual(target.stat().st_size, len(b"initial") + MAX_DOCUMENT_BYTES)
                self.assertTrue(target.read_bytes().startswith(b"initial"))
                self.assertEqual(self.histories(), [])
                self.assert_no_temporary_files()

    def test_invalid_paths_are_rejected(self):
        for document in ("", "/absolute.md", "../escape.md", "a/../../escape.md",
                         "./note.md", "a/./note.md", "a//note.md", "a\\note.md",
                         "note.txt", "note.md/", "null\x00.md"):
            with self.subTest(document=document):
                with self.assertRaises(ValueError):
                    self.store.save(document, "content", expected_revision=None)
                with self.assertRaises(ValueError):
                    self.store.read(document)
        self.assertEqual(list(self.store.wiki_dir.iterdir()), [])
        self.assertEqual(self.histories(), [])

    def test_symbolic_links_cannot_redirect_document_access(self):
        outside = self.root / "outside"
        outside.mkdir()
        original = outside / "note.md"
        original.write_bytes(b"outside content")
        (self.store.wiki_dir / "linked.md").symlink_to(original)
        (self.store.wiki_dir / "linked-dir").symlink_to(outside, target_is_directory=True)
        (self.store.wiki_dir / "broken.md").symlink_to(outside / "missing.md")
        for document in ("linked.md", "linked-dir/note.md", "broken.md"):
            with self.subTest(document=document):
                with self.assertRaises(ValueError):
                    self.store.read(document)
                with self.assertRaises(ValueError):
                    self.store.save(document, "changed", expected_revision=None)
        self.assertEqual(original.read_bytes(), b"outside content")
        self.assertFalse((outside / "missing.md").exists())

    def test_symbolic_history_directory_keeps_original_and_outside_untouched(self):
        self.store.save("note.md", "original", expected_revision=None)
        outside = self.root / "outside"
        outside.mkdir()
        (self.store.history_dir / "note.md").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.store.save("note.md", "replacement", expected_revision=self.store.read("note.md").revision)
        self.assertEqual(self.store.read("note.md").content, "original")
        self.assertEqual(list(outside.iterdir()), [])
        self.assert_no_temporary_files()

    def test_missing_data_root_is_not_created(self):
        missing = self.root / "typo"
        with self.assertRaises(FileNotFoundError):
            WikiStore(missing)
        self.assertFalse(missing.exists())

    def test_lock_timeout_configuration_rejects_invalid_values(self):
        self.assertEqual(DEFAULT_LOCK_TIMEOUT_SECONDS, 5.0)
        self.assertEqual(self.store.lock_timeout_seconds, 5.0)
        for timeout in (0, 0.01, 2):
            with self.subTest(valid=timeout):
                self.assertEqual(
                    WikiStore(self.data, lock_timeout_seconds=timeout).lock_timeout_seconds,
                    float(timeout),
                )
        for timeout in (True, False, None, "5", [], object()):
            with self.subTest(invalid_type=timeout):
                with self.assertRaises(TypeError):
                    WikiStore(self.data, lock_timeout_seconds=timeout)
        for timeout in (-1, -0.01, float("nan"), float("inf"), -float("inf"), 10 ** 400):
            with self.subTest(invalid_number=timeout):
                with self.assertRaises(ValueError):
                    WikiStore(self.data, lock_timeout_seconds=timeout)

    @contextmanager
    def held_process_lock(self):
        context = multiprocessing.get_context("spawn")
        ready, release = context.Event(), context.Event()
        process = context.Process(target=_hold_write_lock, args=(self.data, ready, release))
        process.start()
        try:
            self.assertTrue(ready.wait(timeout=10), "lock holder did not start")
            yield release
        finally:
            release.set()
            process.join(timeout=10)
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
            exitcode = process.exitcode
            process.close()
            self.assertEqual(exitcode, 0)

    def test_lock_timeout_preserves_current_history_and_lock_file(self):
        self.store.save("note.md", "oldest", expected_revision=None)
        history = self.store.save(
            "note.md", "current", expected_revision=self.store.read("note.md").revision
        ).history_path
        current = self.store.read("note.md")
        contender = WikiStore(self.data, lock_timeout_seconds=0.05)
        lock_path = self.data / ".storage.lock"
        with self.held_process_lock():
            lock_inode = lock_path.stat().st_ino
            start = time.monotonic()
            with self.assertRaises(StorageBusyError) as raised:
                contender.save("note.md", "rejected", expected_revision=current.revision)
            elapsed = time.monotonic() - start
            self.assertIsInstance(raised.exception, TimeoutError)
            self.assertEqual(raised.exception.timeout_seconds, 0.05)
            self.assertIn(raised.exception.__cause__.errno, (errno.EAGAIN, errno.EWOULDBLOCK))
            self.assertGreaterEqual(elapsed, 0.05)
            self.assertLess(elapsed, 2)
            self.assertEqual(lock_path.stat().st_ino, lock_inode)
            self.assertEqual(self.store.read("note.md"), current)
            self.assertEqual(self.histories(), [history])
            self.assertEqual(history.read_bytes(), b"oldest")
            self.assert_no_temporary_files()
        result = contender.save("note.md", "retried", expected_revision=current.revision)
        self.assertEqual(result.history_path.read_bytes(), b"current")
        self.assertEqual(self.store.read("note.md").content, "retried")
        self.assertEqual(lock_path.stat().st_ino, lock_inode)

    def test_lock_timeout_does_not_create_document_directory(self):
        contender = WikiStore(self.data, lock_timeout_seconds=0.01)
        with self.held_process_lock():
            with self.assertRaises(StorageBusyError):
                contender.save("new/note.md", "rejected", expected_revision=None)
        self.assertEqual(list(self.store.wiki_dir.iterdir()), [])
        self.assertEqual(list(self.store.history_dir.iterdir()), [])
        self.assert_no_temporary_files()

    def test_zero_lock_timeout_attempts_once_and_can_save_after_release(self):
        contender = WikiStore(self.data, lock_timeout_seconds=0)
        from core.modules.documents import store as storage

        with self.held_process_lock(), \
                patch("core.modules.documents.store.fcntl.flock", wraps=storage.fcntl.flock) as flock, \
                patch("core.modules.documents.store.time.sleep", side_effect=AssertionError("must not wait")):
            with self.assertRaises(StorageBusyError) as raised:
                contender.save("note.md", "content", expected_revision=None)
            self.assertEqual(raised.exception.timeout_seconds, 0)
            self.assertEqual(flock.call_count, 1)
        result = contender.save("note.md", "content", expected_revision=None)
        self.assertEqual(result.revision, self.store.read("note.md").revision)
        self.assertEqual(self.histories(), [])
        self.assert_no_temporary_files()

    def test_waiting_writer_succeeds_after_lock_release_within_timeout(self):
        self.store.save("note.md", "original", expected_revision=None)
        original = self.store.read("note.md")
        contender = WikiStore(self.data, lock_timeout_seconds=2)
        with self.held_process_lock() as release:
            timer = threading.Timer(0.05, release.set)
            timer.start()
            try:
                result = contender.save("note.md", "updated", expected_revision=original.revision)
            finally:
                timer.join(timeout=5)
                self.assertFalse(timer.is_alive())
        self.assertTrue(result.changed)
        self.assertEqual(result.history_path.read_bytes(), b"original")
        self.assertEqual(self.store.read("note.md").content, "updated")
        self.assert_no_temporary_files()

    def test_read_remains_available_while_write_lock_is_held(self):
        self.store.save("note.md", "current", expected_revision=None)
        current = self.store.read("note.md")
        with self.held_process_lock(), \
                patch("core.modules.documents.store.fcntl.flock", side_effect=AssertionError("read must not lock")):
            self.assertEqual(self.store.read("note.md"), current)

    def test_noncontention_lock_error_preserves_original_exception(self):
        self.store.save("note.md", "current", expected_revision=None)
        current = self.store.read("note.md")
        for code in (errno.EIO, errno.EACCES):
            primary_error = OSError(code, "simulated flock failure")
            with self.subTest(errno=code), \
                    patch("core.modules.documents.store.fcntl.flock", side_effect=primary_error), \
                    patch("core.modules.documents.store.time.sleep", side_effect=AssertionError("must not retry")), \
                    patch("core.modules.documents.store.os.close", wraps=os.close) as close:
                with self.assertRaises(OSError) as raised:
                    self.store.save("note.md", "rejected", expected_revision=current.revision)
                self.assertIs(raised.exception, primary_error)
                self.assertEqual(raised.exception.errno, code)
                close.assert_called_once()
                descriptor = close.call_args.args[0]
            with self.assertRaises(OSError) as closed:
                os.fstat(descriptor)
            self.assertEqual(closed.exception.errno, errno.EBADF)
            self.assertEqual(self.store.read("note.md"), current)
            self.assertEqual(self.histories(), [])
            self.assert_no_temporary_files()

    def run_competing_processes(self, worker):
        context = multiprocessing.get_context("spawn")
        barrier = context.Barrier(4)
        results = context.Queue()
        processes = [context.Process(target=worker, args=(self.data, n, barrier, results))
                     for n in range(4)]
        try:
            for process in processes:
                process.start()
            for process in processes:
                process.join(timeout=30)
                self.assertEqual(process.exitcode, 0)
            return [results.get(timeout=5) for _ in processes]
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
                if process.pid is not None and not process.is_alive():
                    process.close()
            results.close()
            results.join_thread()

    def test_concurrent_processes_from_same_revision_allow_only_one_edit(self):
        self.store.save("shared.md", "initial", expected_revision=None)
        initial = self.store.read("shared.md")
        results = self.run_competing_processes(_edit_same_base)
        successes = [result for result in results if result[0] == "saved"]
        conflicts = [result for result in results if result[0] == "conflict"]
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(conflicts), 3)
        current = self.store.read("shared.md")
        self.assertEqual(current.content, f"worker-{successes[0][1]}")
        for _, _, expected, actual in conflicts:
            self.assertEqual(expected, initial.revision)
            self.assertEqual(actual, current.revision)
        self.assertEqual([p.read_bytes() for p in self.histories()], [b"initial"])
        self.assert_no_temporary_files()

    def test_concurrent_creates_allow_only_one_document_creation(self):
        results = self.run_competing_processes(_create_same_path)
        successes = [result for result in results if result[0] == "saved"]
        conflicts = [result for result in results if result[0] == "conflict"]
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(conflicts), 3)
        current = self.store.read("shared.md")
        self.assertEqual(current.content, f"worker-{successes[0][1]}")
        for _, _, expected, actual in conflicts:
            self.assertIsNone(expected)
            self.assertEqual(actual, current.revision)
        self.assertEqual(self.histories(), [])
        self.assert_no_temporary_files()


if __name__ == "__main__":
    unittest.main()
