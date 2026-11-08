"""Lock-inode invalidation journal tests, entirely in temporary directories."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import errno
import fcntl
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.common import read_changes as journal
from core.modules.documents.store import WikiStore


class ReadChangesCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = WikiStore(self.root)

    @contextmanager
    def locked(self, kind="wiki"):
        path = self.root / (".storage.lock" if kind == "wiki" else ".registration.lock")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            with journal.bind_lock(self.store, kind, fd):
                yield fd
        finally:
            os.close(fd)

    def test_empty_legacy_lock_is_a_stable_read_only_baseline(self):
        with self.locked() as fd:
            before = os.fstat(fd)
            self.assertEqual(journal.changes_since(self.store, "wiki", None), (journal.EMPTY_TOKEN, None))
            self.assertEqual(journal.changes_since(self.store, "wiki", journal.EMPTY_TOKEN), (journal.EMPTY_TOKEN, []))
            self.assertEqual(os.pread(fd, 1, 0), b"")
            self.assertEqual(os.fstat(fd).st_mtime_ns, before.st_mtime_ns)
        self.assertEqual((self.root / ".storage.lock").read_bytes(), b"")

    def test_first_and_repeated_intents_preserve_inode_and_return_ordered_unique_keys(self):
        with self.locked() as fd:
            identity = os.fstat(fd).st_ino
            first = journal.before_change(self.store, "wiki", "wiki/a.md")
            second = journal.before_change(self.store, "wiki", "_history/a.md/changes.json")
            third = journal.before_change(self.store, "wiki", "wiki/a.md")
            self.assertEqual(len({first, second, third}), 3)
            self.assertEqual(journal.changes_since(self.store, "wiki", journal.EMPTY_TOKEN),
                             (third, ["wiki/a.md", "_history/a.md/changes.json"]))
            self.assertEqual(journal.changes_since(self.store, "wiki", first),
                             (third, ["_history/a.md/changes.json", "wiki/a.md"]))
            self.assertEqual(journal.changes_since(self.store, "wiki", third), (third, []))
            self.assertEqual(os.fstat(fd).st_ino, identity)
            self.assertEqual((self.root / ".storage.lock").stat().st_ino, identity)
            self.assertLessEqual(os.fstat(fd).st_size, journal.MAX_JOURNAL_BYTES)
            self.assertEqual(os.fstat(fd).st_mode & 0o777, 0o600)
            record = json.loads(os.pread(fd, journal.MAX_JOURNAL_BYTES, 0))
            self.assertEqual(len(record["changes"]), 3)

    def test_unbound_reader_falls_back_and_unbound_writer_stops_before_file_effects(self):
        self.assertEqual(journal.changes_since(self.store, "wiki", None), (None, None))
        effects = []
        with self.assertRaises(RuntimeError):
            journal.before_change(self.store, "wiki", "wiki/a.md")
            effects.append("canonical write")
        self.assertEqual(effects, [])
        self.assertFalse((self.root / ".storage.lock").exists())

    def test_registration_and_wiki_bindings_nest_and_survive_new_store_instance(self):
        with self.locked("registration"):
            registration = journal.before_change(self.store, "registration", "_sources/source/catalog.json")
            with self.locked("wiki"):
                wiki = journal.before_change(self.store, "wiki", "wiki/a.md")
                another = WikiStore(self.root)
                self.assertEqual(journal.changes_since(another, "wiki", journal.EMPTY_TOKEN), (wiki, ["wiki/a.md"]))
                self.assertEqual(journal.changes_since(another, "registration", journal.EMPTY_TOKEN),
                                 (registration, ["_sources/source/catalog.json"]))
            self.assertEqual(journal.changes_since(self.store, "wiki", wiki), (None, None))
            self.assertEqual(journal.changes_since(self.store, "registration", registration), (registration, []))

    def test_bindings_are_restored_after_exceptions_and_do_not_cross_roots(self):
        with self.assertRaisesRegex(ValueError, "caller"):
            with self.locked():
                raise ValueError("caller")
        self.assertEqual(journal.changes_since(self.store, "wiki", None), (None, None))
        with tempfile.TemporaryDirectory() as other_root, self.locked():
            other_store = WikiStore(other_root)
            self.assertEqual(journal.changes_since(other_store, "wiki", None), (None, None))
            with self.assertRaises(RuntimeError):
                journal.before_change(other_store, "wiki", "wiki/a.md")

    def test_corrupt_partial_duplicate_and_oversize_records_require_full_reconciliation(self):
        with self.locked() as fd:
            old = journal.before_change(self.store, "wiki", "wiki/old.md")
            corrupt_records = (b"{", b"not a journal", b'{"schema_version":1,"schema_version":1}',
                               b"x" * (journal.MAX_JOURNAL_BYTES + 1))
            for raw in corrupt_records:
                with self.subTest(raw_size=len(raw)):
                    os.pwrite(fd, raw, 0)
                    os.ftruncate(fd, len(raw))
                    self.assertEqual(journal.changes_since(self.store, "wiki", old), (None, None))
                    self.assertEqual(os.pread(fd, len(raw), 0), raw)
                    new = journal.before_change(self.store, "wiki", "wiki/new.md")
                    self.assertNotEqual(new, old)
                    self.assertEqual(journal.changes_since(self.store, "wiki", old), (new, None))
                    self.assertEqual(journal.changes_since(self.store, "wiki", new), (new, []))

    def test_valid_json_payload_tampering_and_bad_chain_are_not_trusted(self):
        with self.locked() as fd:
            token = journal.before_change(self.store, "wiki", "wiki/a.md")
            value = json.loads(os.pread(fd, journal.MAX_JOURNAL_BYTES, 0))
            value["changes"][0]["key"] = "wiki/changed.md"
            raw = json.dumps(value).encode()
            os.pwrite(fd, raw, 0)
            os.ftruncate(fd, len(raw))
            self.assertEqual(journal.changes_since(self.store, "wiki", token), (None, None))
            payload = {key: item for key, item in value.items() if key != "hash"}
            payload["changes"].append(dict(payload["changes"][0]))
            raw = journal._encode(payload)
            os.pwrite(fd, raw, 0)
            os.ftruncate(fd, len(raw))
            self.assertEqual(journal.changes_since(self.store, "wiki", token), (None, None))

    def test_count_overflow_keeps_a_bounded_chain_and_expired_tokens_require_full_scan(self):
        with self.locked() as fd, patch.object(journal, "MAX_CHANGE_RECORDS", 3):
            tokens = [journal.before_change(self.store, "wiki", f"wiki/{number}.md") for number in range(5)]
            self.assertEqual(journal.changes_since(self.store, "wiki", journal.EMPTY_TOKEN), (tokens[-1], None))
            self.assertEqual(journal.changes_since(self.store, "wiki", tokens[0]), (tokens[-1], None))
            self.assertEqual(journal.changes_since(self.store, "wiki", tokens[1]),
                             (tokens[-1], ["wiki/2.md", "wiki/3.md", "wiki/4.md"]))
            value = json.loads(os.pread(fd, journal.MAX_JOURNAL_BYTES, 0))
            self.assertEqual(len(value["changes"]), 3)
            self.assertEqual(value["base"], tokens[1])

    def test_byte_overflow_can_fall_back_to_an_empty_chain_with_a_new_epoch(self):
        with self.locked() as fd, patch.object(journal, "MAX_JOURNAL_BYTES", 512):
            token = journal.before_change(self.store, "wiki", "wiki/" + "x" * 2048 + ".md")
            self.assertEqual(journal.changes_since(self.store, "wiki", journal.EMPTY_TOKEN), (token, None))
            self.assertEqual(journal.changes_since(self.store, "wiki", token), (token, []))
            self.assertLessEqual(os.fstat(fd).st_size, 512)

    def test_short_writes_are_completed_without_changing_the_descriptor_offset(self):
        pwrite = os.pwrite
        with self.locked() as fd:
            os.lseek(fd, 19, os.SEEK_SET)
            with patch.object(journal.os, "pwrite", side_effect=lambda descriptor, raw, offset: pwrite(descriptor, raw[:13], offset)) as written:
                token = journal.before_change(self.store, "wiki", "wiki/a.md")
            self.assertGreater(written.call_count, 1)
            self.assertEqual(os.lseek(fd, 0, os.SEEK_CUR), 19)
            self.assertEqual(journal.changes_since(self.store, "wiki", journal.EMPTY_TOKEN), (token, ["wiki/a.md"]))

    def test_partial_write_and_fsync_failures_abort_before_canonical_effect(self):
        pwrite = os.pwrite
        with self.locked() as fd:
            failure = OSError(errno.ENOSPC, "injected journal write failure")
            calls, effects = [], []

            def partial(descriptor, raw, offset):
                if not calls:
                    calls.append(True)
                    return pwrite(descriptor, raw[:11], offset)
                raise failure

            with patch.object(journal.os, "pwrite", side_effect=partial):
                with self.assertRaises(OSError) as caught:
                    journal.before_change(self.store, "wiki", "wiki/a.md")
                    effects.append("canonical write")
            self.assertIs(caught.exception, failure)
            self.assertEqual(effects, [])
            self.assertEqual(journal.changes_since(self.store, "wiki", journal.EMPTY_TOKEN), (None, None))
            fsync_failure = OSError(errno.EIO, "injected journal fsync failure")
            with patch.object(journal.os, "fsync", side_effect=fsync_failure):
                with self.assertRaises(OSError) as caught:
                    journal.before_change(self.store, "wiki", "wiki/a.md")
                    effects.append("canonical write")
            self.assertIs(caught.exception, fsync_failure)
            self.assertEqual(effects, [])
            current, changes = journal.changes_since(self.store, "wiki", journal.EMPTY_TOKEN)
            self.assertIsNotNone(current)
            self.assertIsNone(changes)  # The incomplete prior chain was reset.

    def test_zero_progress_truncate_and_read_failures_keep_original_errors(self):
        with self.locked():
            with patch.object(journal.os, "pwrite", return_value=0):
                with self.assertRaises(OSError) as caught:
                    journal.before_change(self.store, "wiki", "wiki/a.md")
            self.assertEqual(caught.exception.errno, errno.EIO)
            failure = OSError(errno.EIO, "injected truncate failure")
            with patch.object(journal.os, "ftruncate", side_effect=failure):
                with self.assertRaises(OSError) as caught:
                    journal.before_change(self.store, "wiki", "wiki/a.md")
            self.assertIs(caught.exception, failure)
            with patch.object(journal.os, "pread", side_effect=failure):
                self.assertEqual(journal.changes_since(self.store, "wiki", None), (None, None))
                with self.assertRaises(OSError) as caught:
                    journal.before_change(self.store, "wiki", "wiki/a.md")
            self.assertIs(caught.exception, failure)

    def test_invalid_keys_and_wrong_lock_descriptor_stop_without_rewriting(self):
        with self.locked() as fd:
            for key in ("", "/wiki/a.md", "wiki//a.md", "wiki/../a.md", "wiki/./a.md", "wiki\\a.md", "wiki/a\x00.md", 1):
                with self.subTest(key=key), self.assertRaises(ValueError):
                    journal.before_change(self.store, "wiki", key)
            self.assertEqual(os.pread(fd, 1, 0), b"")
            other = os.open(self.root / ".registration.lock", os.O_CREAT | os.O_RDWR, 0o600)
            os.close(other)
            with self.assertRaises(ValueError), journal.bind_lock(self.store, "registration", fd):
                self.fail("wrong lock descriptor accepted")

    def test_symlinks_nonregular_files_and_replaced_lock_inodes_are_rejected(self):
        target = self.root / "target"
        target.write_bytes(b"preserve target")
        path = self.root / ".storage.lock"
        path.symlink_to(target)
        descriptor = os.open(target, os.O_RDWR)
        try:
            with self.assertRaises(ValueError), journal.bind_lock(self.store, "wiki", descriptor):
                self.fail("symbolic link accepted")
        finally:
            os.close(descriptor)
        self.assertEqual(target.read_bytes(), b"preserve target")
        path.unlink()  # Only this test's synthetic symlink.
        os.mkfifo(path, 0o600)
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        try:
            with self.assertRaises(ValueError), journal.bind_lock(self.store, "wiki", descriptor):
                self.fail("FIFO accepted")
        finally:
            os.close(descriptor)
        path.unlink()  # Only this test's synthetic FIFO.
        with self.locked():
            replacement = self.root / "replacement"
            replacement.write_bytes(b"preserve replacement")
            replacement.chmod(0o600)
            os.replace(replacement, path)
            self.assertEqual(journal.changes_since(self.store, "wiki", None), (None, None))
            with self.assertRaises(ValueError):
                journal.before_change(self.store, "wiki", "wiki/a.md")
            self.assertEqual(path.read_bytes(), b"preserve replacement")

    def test_concurrent_writers_keep_every_intent_under_the_existing_flock(self):
        with self.locked() as descriptor:
            inode = os.fstat(descriptor).st_ino

        def writer(number):
            with self.locked():
                return [journal.before_change(self.store, "wiki", f"wiki/{number}-{item}.md") for item in range(6)]

        with ThreadPoolExecutor(max_workers=4) as pool:
            tokens = [token for result in pool.map(writer, range(4)) for token in result]
        self.assertEqual(len(set(tokens)), 24)
        with self.locked() as descriptor:
            current, keys = journal.changes_since(self.store, "wiki", journal.EMPTY_TOKEN)
            self.assertIn(current, tokens)
            self.assertEqual(set(keys), {f"wiki/{number}-{item}.md" for number in range(4) for item in range(6)})
            self.assertEqual(os.fstat(descriptor).st_ino, inode)


if __name__ == "__main__":
    unittest.main()
