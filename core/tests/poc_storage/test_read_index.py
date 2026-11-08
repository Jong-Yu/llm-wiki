"""Derived SQLite cache tests: no operational or user data is used."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

from core.common import read_index as module
from core.common.read_index import CanonicalIndexUnavailable, read_index
from core.modules.documents.store import WikiStore


class ReadIndexCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = WikiStore(self.root, lock_timeout_seconds=0.03)
        first = self.store.save("a.md", "first\r\n", expected_revision=None)
        self.store.save("a.md", "second\r\n", expected_revision=first.revision)
        self.directory = self.root / "_index"
        self.database = self.directory / "read.sqlite3"

    def canonical_files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*")
                if path.is_file() and self.directory not in path.parents}

    def seed(self):
        with read_index(self.store) as index:
            index.sync("documents", "tenant", [("a", "1"), ("b", "1")],
                       lambda key: {"title": key, "revision": "1"})

    def test_cold_warm_update_remove_preserves_canonical_bytes_and_history(self):
        before = self.canonical_files()
        loaded = []

        def loader(key):
            loaded.append(key)
            return {"title": "제목 " + key, "revision": signatures[key]}

        signatures = {"b": "1", "a": "1"}
        with self.store._write_lock(), read_index(self.store) as index:
            index.sync("documents", "tenant", signatures.items(), loader)
            self.assertEqual(loaded, ["b", "a"])
            self.assertEqual([key for key, _ in index.values("documents", "tenant")], ["a", "b"])
        loaded.clear()
        with read_index(self.store) as index:
            index.sync("documents", "tenant", signatures.items(), loader)
            self.assertEqual(loaded, [])
            signatures = {"a": "2", "c": "1"}
            index.sync("documents", "tenant", signatures.items(), loader)
            self.assertEqual(loaded, ["a", "c"])
            self.assertEqual(index.values("documents", "tenant"), [
                ("a", {"title": "제목 a", "revision": "2"}),
                ("c", {"title": "제목 c", "revision": "1"})])
            index.sync("documents", "tenant", [], lambda key: self.fail("empty scope loaded"))
            self.assertEqual(index.values("documents", "tenant"), [])
        self.assertEqual(self.canonical_files(), before)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.database.stat().st_mode & 0o777, 0o600)

    def test_namespace_and_owner_scopes_do_not_mix(self):
        with read_index(self.store) as index:
            for namespace, scope, owner in (("jobs", "alice", "alice"), ("jobs", "bob", "bob"),
                                            ("sources", "alice", "source")):
                index.sync(namespace, scope, [("same-key", "1")], lambda key: {"owner": owner})
            index.sync("jobs", "alice", [], lambda key: self.fail("unnecessary load"))
            self.assertEqual(index.values("jobs", "alice"), [])
            self.assertEqual(index.values("jobs", "bob"), [("same-key", {"owner": "bob"})])
            self.assertEqual(index.page("sources", "alice", limit=1), [("same-key", {"owner": "source"})])
            self.assertEqual(index.values("jobs", "unknown"), [])

    def test_sync_warm_noop_has_one_select_without_write_transaction(self):
        self.seed()
        with read_index(self.store) as index:
            statements = []
            index.connection.set_trace_callback(statements.append)
            index.sync("documents", "tenant", [("b", "1"), ("a", "1")],
                       lambda key: self.fail("unchanged scope loaded"))
            self.assertEqual(len(statements), 1)
            self.assertTrue(statements[0].startswith("SELECT key, signature"))
            self.assertIn("WHERE namespace='documents' AND scope='tenant'", statements[0])
            self.assertFalse(index.connection.in_transaction)
            statements.clear()
            index.sync("documents", "empty", [], lambda key: self.fail("empty scope loaded"))
            self.assertEqual(len(statements), 1)
            self.assertTrue(statements[0].startswith("SELECT key, signature"))

    def test_sync_cold_changed_and_removed_scopes_recheck_inside_transaction(self):
        with read_index(self.store) as index:
            statements, loaded = [], []
            index.connection.set_trace_callback(statements.append)

            def loader(key):
                loaded.append(key)
                return {"title": key}

            for entries, expected_loaded, expected_deletions in (
                    ([("b", "1"), ("a", "1")], ["b", "a"], 0),
                    ([("a", "2"), ("c", "1")], ["a", "c"], 1),
                    ([], [], 2)):
                with self.subTest(entries=entries):
                    statements.clear()
                    loaded.clear()
                    index.sync("documents", "tenant", entries, loader)
                    self.assertEqual(loaded, expected_loaded)
                    self.assertEqual(statements.count("BEGIN IMMEDIATE"), 1)
                    self.assertEqual(statements.count("COMMIT"), 1)
                    self.assertEqual(sum(sql.startswith("SELECT key, signature") for sql in statements), 2)
                    self.assertEqual(sum(sql.startswith("DELETE") for sql in statements), expected_deletions)
                    self.assertEqual(sum(sql.startswith("INSERT") for sql in statements), len(expected_loaded))
                    self.assertLess(statements.index("BEGIN IMMEDIATE"),
                                    next(position for position, sql in enumerate(statements)
                                         if position and sql.startswith("SELECT key, signature")))

    def test_page_uses_scoped_sql_keyset_limit_and_normalized_filter(self):
        with read_index(self.store) as index:
            entries = [(f"{number:04d}", "1") for number in range(250)]
            index.sync("jobs", "alice", entries, lambda key: {
                "title": "Chosen" if int(key) % 2 else "Other", "owner": "alice", "state": "done"})
            statements = []
            index.connection.set_trace_callback(statements.append)
            self.assertEqual([key for key, _ in index.page("jobs", "alice", after="0100", limit=3)],
                             ["0101", "0102", "0103"])
            self.assertEqual([key for key, _ in index.page("jobs", "alice", after="0100", limit=3, reverse=True)],
                             ["0099", "0098", "0097"])
            self.assertEqual([key for key, _ in index.page("jobs", "alice", after="0100", limit=2,
                                                          filters={"title": "Chosen"})], ["0101", "0103"])
            self.assertTrue(all("namespace='jobs' AND scope='alice'" in sql and "LIMIT" in sql
                                for sql in statements if sql.startswith("SELECT")))
            plan = index.connection.execute(
                "EXPLAIN QUERY PLAN SELECT key FROM read_index_rows WHERE namespace=? AND scope=? AND title=?",
                ("jobs", "alice", "Chosen")).fetchall()
            self.assertIn("read_index_title", str(plan))

    def test_sync_loader_failure_preserves_previous_complete_scope_and_exception(self):
        self.seed()
        for failure in (OSError("original read"), ValueError("original JSON"), sqlite3.OperationalError("loader SQL")):
            with self.subTest(failure=failure), read_index(self.store) as index:
                expected = index.values("documents", "tenant")

                def loader(key):
                    if key == "c":
                        raise failure
                    return {"title": "changed"}

                with self.assertRaises(type(failure)) as caught:
                    index.sync("documents", "tenant", [("a", "2"), ("c", "1")], loader)
                self.assertIs(caught.exception, failure)
                self.assertEqual(index.values("documents", "tenant"), expected)
                self.assertFalse(index.connection.in_transaction)

    def test_json_encoding_failure_rolls_back_without_becoming_cache_error(self):
        self.seed()
        with read_index(self.store) as index:
            before = index.values("documents", "tenant")
            with self.assertRaises(ValueError):
                index.sync("documents", "tenant", [("a", "2"), ("c", "1")],
                           lambda key: {"title": "changed"} if key == "a" else {"value": float("nan")})
            self.assertEqual(index.values("documents", "tenant"), before)

    def test_get_is_lazy_and_each_success_commits_independently(self):
        with read_index(self.store) as index:
            value = index.get("history", "a.md", "old.md", "1", lambda: {"title": "old", "nested": [1]})
            value["nested"].append(2)
            self.assertEqual(index.get("history", "a.md", "old.md", "1", lambda: self.fail("warm loader")),
                             {"title": "old", "nested": [1]})
            failure = OSError("canonical history unreadable")

            def loader():
                raise failure

            with self.assertRaises(OSError) as caught:
                index.get("history", "a.md", "old.md", "2", loader)
            self.assertIs(caught.exception, failure)
        with read_index(self.store) as index:
            self.assertEqual(index.values("history", "a.md"), [("old.md", {"title": "old", "nested": [1]})])

    def test_lookup_all_returns_signatures_and_only_the_requested_scope(self):
        self.seed()
        with read_index(self.store) as index:
            index.sync("documents", "other-tenant", [("a", "other")], lambda key: {"title": "other"})
            index.sync("jobs", "tenant", [("a", "job")], lambda key: {"title": "job"})
            with patch.object(index, "_scope", wraps=index._scope) as scoped, \
                    patch.object(index, "_check_paths", wraps=index._check_paths) as checked, \
                    patch.object(index, "_all", wraps=index._all) as selected:
                self.assertEqual(index.lookup("documents", "tenant"), {
                    "a": ("1", {"title": "a", "revision": "1"}),
                    "b": ("1", {"title": "b", "revision": "1"})})
            scoped.assert_called_once_with("documents", "tenant")
            checked.assert_called_once_with()
            selected.assert_called_once()
            self.assertIn("WHERE namespace=? AND scope=?", selected.call_args.args[0])
            self.assertEqual(selected.call_args.args[1], ["documents", "tenant"])
            self.assertEqual(index.lookup("documents", "missing"), {})

    def test_lookup_selected_keys_use_bound_parameters_and_omit_misses(self):
        self.seed()
        quoted = "x') OR scope='other-tenant' --"
        with read_index(self.store) as index:
            index.get("documents", "tenant", quoted, "quoted", lambda: {"title": "literal"})
            index.get("documents", "other-tenant", "secret", "other", lambda: {"title": "private"})
            with patch.object(index, "_scope", wraps=index._scope) as scoped, \
                    patch.object(index, "_all", wraps=index._all) as selected:
                actual = index.lookup("documents", "tenant", (key for key in (quoted, "missing", "b")))
            self.assertEqual(actual, {quoted: ("quoted", {"title": "literal"}),
                                      "b": ("1", {"title": "b", "revision": "1"})})
            scoped.assert_called_once_with("documents", "tenant")
            selected.assert_called_once()
            statement, parameters = selected.call_args.args
            self.assertIn("WHERE namespace=? AND scope=? AND key IN (?,?,?)", statement)
            self.assertNotIn(quoted, statement)
            self.assertEqual(parameters, ["documents", "tenant", quoted, "missing", "b"])

    def test_lookup_empty_checks_scope_safety_without_selecting(self):
        self.seed()
        with read_index(self.store) as index:
            with patch.object(index, "_scope", wraps=index._scope) as scoped, \
                    patch.object(index, "_all", wraps=index._all) as selected:
                self.assertEqual(index.lookup("documents", "tenant", []), {})
            scoped.assert_called_once_with("documents", "tenant")
            selected.assert_not_called()
            with patch.object(self.store, "_check_path", side_effect=PermissionError("unsafe cache")):
                with self.assertRaises(CanonicalIndexUnavailable):
                    index.lookup("documents", "tenant", [])

    def test_lookup_rejects_duplicate_and_nonstring_keys_before_select(self):
        self.seed()
        with read_index(self.store) as index:
            for keys, expected_error in ((["a", "a"], ValueError), (["a", 1], TypeError),
                                         ("a", TypeError), (b"a", TypeError)):
                with self.subTest(keys=keys), patch.object(index, "_all", wraps=index._all) as selected:
                    with self.assertRaises(expected_error):
                        index.lookup("documents", "tenant", keys)
                    selected.assert_not_called()

    def test_lookup_validates_only_selected_payloads_and_reports_sql_failure(self):
        self.seed()
        with read_index(self.store) as index:
            index.connection.execute(
                "UPDATE read_index_rows SET payload=? WHERE namespace=? AND scope=? AND key=?",
                ('{"title":"changed"}', "documents", "tenant", "b"))
            self.assertEqual(index.lookup("documents", "tenant", ["a"]), {
                "a": ("1", {"title": "a", "revision": "1"})})
            for keys in (["b"], None):
                with self.subTest(keys=keys), self.assertRaises(CanonicalIndexUnavailable):
                    index.lookup("documents", "tenant", keys)
            index.connection.close()
            with self.assertRaises(CanonicalIndexUnavailable) as caught:
                index.lookup("documents", "tenant", ["a"])
            self.assertIsInstance(caught.exception.__cause__, sqlite3.ProgrammingError)

    def test_lookup_detects_replaced_database_even_for_empty_keys(self):
        self.seed()
        before = self.canonical_files()
        with read_index(self.store) as index:
            replacement = self.directory / "replacement"
            replacement.write_bytes(self.database.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, self.database)
            for keys in (None, [], ["a"]):
                with self.subTest(keys=keys), self.assertRaises(CanonicalIndexUnavailable):
                    index.lookup("documents", "tenant", keys)
        self.assertEqual(self.canonical_files(), before)

    def test_connections_are_request_local_and_concurrent_scopes_remain_complete(self):
        self.seed()

        def request(number):
            with read_index(self.store) as index:
                index.sync("jobs", str(number), [(str(item), "1") for item in range(8)],
                           lambda key: {"owner": str(number), "title": key})
                return index.values("jobs", str(number))

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(request, range(4)))
        self.assertEqual([len(result) for result in results], [8] * 4)
        self.assertEqual([result[0][1]["owner"] for result in results], ["0", "1", "2", "3"])

    def test_sql_busy_is_bounded_and_preserves_existing_scope(self):
        self.seed()
        blocker = sqlite3.connect(self.database, isolation_level=None)
        self.addCleanup(blocker.close)
        blocker.execute("BEGIN IMMEDIATE")
        before = self.canonical_files()
        started = time.monotonic()
        with self.assertRaises(CanonicalIndexUnavailable) as caught, read_index(self.store) as index:
            index.sync("documents", "tenant", [("a", "2")], lambda key: self.fail("busy loader"))
        self.assertIsInstance(caught.exception.__cause__, sqlite3.OperationalError)
        self.assertLess(time.monotonic() - started, 0.5)
        blocker.rollback()
        with read_index(self.store) as index:
            self.assertEqual(len(index.values("documents", "tenant")), 2)
        self.assertEqual(self.canonical_files(), before)

    def test_unknown_existing_files_and_sqlite_database_are_preserved(self):
        self.directory.mkdir(mode=0o700)
        for content in (b"", b"existing unrelated file", b"SQLite format 3\x00" + b"\x00" * 200):
            with self.subTest(content=content):
                self.database.write_bytes(content)
                self.database.chmod(0o600)
                with self.assertRaises(CanonicalIndexUnavailable), read_index(self.store):
                    self.fail("unrecognized file accepted")
                self.assertEqual(self.database.read_bytes(), content)
        self.database.unlink()  # Only this test's own synthetic artifact.
        with sqlite3.connect(self.database) as connection:
            connection.execute("CREATE TABLE unrelated (value TEXT)")
            connection.execute("INSERT INTO unrelated VALUES ('preserve')")
        self.database.chmod(0o600)
        original = self.database.read_bytes()
        with self.assertRaises(CanonicalIndexUnavailable), read_index(self.store):
            self.fail("unrelated database accepted")
        self.assertEqual(self.database.read_bytes(), original)

    def test_valid_application_marker_with_changed_schema_is_preserved(self):
        self.seed()
        with sqlite3.connect(self.database) as connection:
            connection.execute("CREATE TABLE unrelated (value TEXT)")
        original = self.database.read_bytes()
        connect = sqlite3.connect
        with patch.object(module.sqlite3, "connect", wraps=connect) as opened:
            with self.assertRaises(CanonicalIndexUnavailable), read_index(self.store):
                self.fail("changed schema accepted")
        self.assertEqual(opened.call_count, 1)
        self.assertTrue(opened.call_args.kwargs["uri"])
        self.assertTrue(opened.call_args.args[0].endswith("?mode=ro"))
        self.assertEqual(self.database.read_bytes(), original)

    def test_corrupt_recognized_database_is_preserved(self):
        self.seed()
        original = bytearray(self.database.read_bytes())
        original[100:120] = b"corrupt page content"
        self.database.write_bytes(original)
        with self.assertRaises(CanonicalIndexUnavailable), read_index(self.store):
            self.fail("corrupt schema accepted")
        self.assertEqual(self.database.read_bytes(), original)

    def test_cached_json_and_valid_json_bit_changes_are_cache_failures(self):
        self.seed()
        for payload in ("{", '{"title":"changed"}', "[]"):
            with self.subTest(payload=payload), read_index(self.store) as index:
                index.connection.execute(
                    "UPDATE read_index_rows SET payload=? WHERE namespace=? AND scope=? AND key=?",
                    (payload, "documents", "tenant", "a"))
                with self.assertRaises(CanonicalIndexUnavailable):
                    index.page("documents", "tenant", limit=1)
        with read_index(self.store) as index:
            payload = "[]"
            index.connection.execute(
                "UPDATE read_index_rows SET payload=?, payload_hash=? WHERE namespace=? AND scope=? AND key=?",
                (payload, sha256(payload.encode()).hexdigest(), "documents", "tenant", "a"))
            with self.assertRaises(CanonicalIndexUnavailable):
                index.get("documents", "tenant", "a", "1", lambda: self.fail("corruption must not reload"))

    def test_index_directory_database_and_sidecar_symlinks_are_rejected(self):
        target = self.root / "untouched"
        target.write_bytes(b"preserve outside target")
        for name in ("_index", "read.sqlite3", "read.sqlite3-wal", "read.sqlite3-shm", "read.sqlite3-journal"):
            with self.subTest(name=name):
                with tempfile.TemporaryDirectory() as temporary:
                    store = WikiStore(temporary)
                    directory = Path(temporary) / "_index"
                    if name == "_index":
                        directory.symlink_to(self.root, target_is_directory=True)
                    else:
                        directory.mkdir(mode=0o700)
                        (directory / name).symlink_to(target)
                    with self.assertRaises(CanonicalIndexUnavailable), read_index(store):
                        self.fail("symlink accepted")
                    self.assertTrue((directory if name == "_index" else directory / name).is_symlink())
        self.assertEqual(target.read_bytes(), b"preserve outside target")

    def test_nonregular_database_and_sidecars_are_rejected_before_open(self):
        for suffix in ("", "-wal", "-shm"):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as temporary:
                store = WikiStore(temporary)
                directory = Path(temporary) / "_index"
                directory.mkdir(mode=0o700)
                path = directory / ("read.sqlite3" + suffix)
                os.mkfifo(path, 0o600)
                with self.assertRaises(CanonicalIndexUnavailable), read_index(store):
                    self.fail("FIFO accepted")
                self.assertTrue(path.exists())

    def test_cache_permissions_and_path_check_failures_do_not_touch_canonical_data(self):
        before = self.canonical_files()
        with patch.object(self.store, "_check_path", side_effect=PermissionError("cache denied")):
            with self.assertRaises(CanonicalIndexUnavailable), read_index(self.store):
                self.fail("permission failure accepted")
        self.assertEqual(self.canonical_files(), before)
        self.directory.mkdir(mode=0o755)
        with self.assertRaises(CanonicalIndexUnavailable), read_index(self.store):
            self.fail("public cache directory accepted")
        self.assertFalse(self.database.exists())
        self.assertEqual(self.canonical_files(), before)

    def test_sql_connection_permission_error_is_a_cache_failure(self):
        self.seed()
        original = self.database.read_bytes()
        failure = sqlite3.OperationalError("unable to open database file")
        with patch.object(module.sqlite3, "connect", side_effect=failure):
            with self.assertRaises(CanonicalIndexUnavailable) as caught, read_index(self.store):
                self.fail("unavailable connection accepted")
        self.assertIs(caught.exception.__cause__, failure)
        self.assertEqual(self.database.read_bytes(), original)

    def test_sql_failure_rolls_back_updates_and_removals(self):
        self.seed()
        with read_index(self.store) as index:
            expected = index.values("documents", "tenant")
            index.connection.execute(
                "CREATE TRIGGER reject_c BEFORE INSERT ON read_index_rows WHEN NEW.key='c' "
                "BEGIN SELECT RAISE(ABORT, 'injected cache write failure'); END")
            with self.assertRaises(CanonicalIndexUnavailable) as caught:
                index.sync("documents", "tenant", [("a", "2"), ("c", "1")], lambda key: {"title": "changed"})
            self.assertIsInstance(caught.exception.__cause__, sqlite3.IntegrityError)
            self.assertEqual(index.values("documents", "tenant"), expected)
            self.assertFalse(index.connection.in_transaction)

    def test_database_replacement_while_open_is_not_silently_used(self):
        self.seed()
        with read_index(self.store) as index:
            replacement = self.directory / "replacement"
            replacement.write_bytes(self.database.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, self.database)
            with self.assertRaises(CanonicalIndexUnavailable):
                index.values("documents", "tenant")

    def test_invalid_api_inputs_leave_completed_scope_unchanged(self):
        self.seed()
        with read_index(self.store) as index:
            before = index.values("documents", "tenant")
            for entries in ([("a", "2"), ("a", "3")], [("a", (1, 2))]):
                with self.assertRaises((ValueError, TypeError)):
                    index.sync("documents", "tenant", entries, lambda key: self.fail("invalid entries loaded"))
            with self.assertRaises(ValueError):
                index.page("documents", "tenant", limit=True)
            with self.assertRaises(ValueError):
                index.values("documents", "tenant", filters={"injected SQL": "value"})
            self.assertEqual(index.values("documents", "tenant"), before)


if __name__ == "__main__":
    unittest.main()
