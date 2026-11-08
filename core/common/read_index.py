"""Rebuildable, workspace-local summaries of canonical files.

Callers hold their existing canonical-store lock while collecting signatures,
syncing and querying. This module never takes that non-reentrant lock or writes
canonical files. Each sync/get write commits independently; read methods and
unchanged sync observe a SQL statement rather than a context-wide transaction.

Only cache operations raise CanonicalIndexUnavailable. Loader and JSON encoding
errors propagate unchanged so falling back cannot hide canonical data errors.
An unrecognized or damaged existing database is preserved, never replaced.
"""

from contextlib import contextmanager
from functools import wraps
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import stat

from core.common.read_metrics import cache_event, span


_APPLICATION_ID = 0x4C574931  # LWI1, not a canonical storage format.
_SCHEMA_VERSION = 1
_MAX_BUSY_SECONDS = 0.1
_FIELDS = ("title", "source_id", "state", "created_at", "revision", "owner")
_TABLE = "read_index_rows"
_CREATE_TABLE = (
    "CREATE TABLE read_index_rows ("
    "namespace TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, "
    "signature TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, "
    "title TEXT, source_id TEXT, state TEXT, created_at TEXT, revision TEXT, owner TEXT, "
    "PRIMARY KEY (namespace, scope, key)) WITHOUT ROWID"
)
_CREATE_INDEXES = {
    "read_index_title": "CREATE INDEX read_index_title ON read_index_rows (namespace, scope, title, key)",
    "read_index_source": "CREATE INDEX read_index_source ON read_index_rows (namespace, scope, source_id, key)",
    "read_index_owner_state": "CREATE INDEX read_index_owner_state ON read_index_rows (namespace, scope, owner, state, created_at, key)",
}
_EXPECTED_SCHEMA = {("table", _TABLE): _CREATE_TABLE}
_EXPECTED_SCHEMA.update({("index", name): sql for name, sql in _CREATE_INDEXES.items()})


class CanonicalIndexUnavailable(Exception):
    """The derived cache is unusable; the caller may use canonical reads."""

    def __init__(self, message, *, reason="unknown"):
        super().__init__(message)
        self.reason = reason


def _sql_reason(error):
    code = getattr(error, "sqlite_errorcode", 0) & 0xff
    if code in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
        return "busy"
    if code in {sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB}:
        return "corrupt"
    return "io"


def _measured(stage):
    def decorate(function):
        @wraps(function)
        def call(*args, **kwargs):
            with span(stage):
                return function(*args, **kwargs)
        return call
    return decorate


def _text(value, label, *, nonempty=False):
    if not isinstance(value, str) or (nonempty and not value):
        raise TypeError(f"{label} must be a string" + (" and nonempty" if nonempty else ""))
    return value


class CanonicalReadIndex:
    """One request's connection; use read_index(store) to open and close it."""

    def __init__(self, store):
        self.store = store
        self.directory = Path(store.data_dir) / "_index"
        self.path = self.directory / "read.sqlite3"
        self.connection = None
        self._identity = None
        self._busy_ms = int(min(_MAX_BUSY_SECONDS, store.lock_timeout_seconds) * 1000)

    def _paths(self):
        return (self.path, *(Path(str(self.path) + suffix) for suffix in ("-wal", "-shm", "-journal")))

    def _check_paths(self, *, require_database=True):
        try:
            self.store._check_path(self.directory)
            directory_stat = self.directory.lstat()
            if not stat.S_ISDIR(directory_stat.st_mode) or directory_stat.st_mode & 0o077:
                raise ValueError("index directory must be private and regular")
            for path in self._paths():
                self.store._check_path(path)
                try:
                    observed = path.lstat()
                except FileNotFoundError:
                    if path == self.path and require_database:
                        raise
                    continue
                if not stat.S_ISREG(observed.st_mode) or observed.st_mode & 0o077:
                    raise ValueError("index files must be private regular files")
                if path == self.path and self._identity is not None:
                    if (observed.st_dev, observed.st_ino) != self._identity:
                        raise ValueError("index file changed while open")
        except (OSError, ValueError) as error:
            raise CanonicalIndexUnavailable("Unsafe or inaccessible read index path",
                reason="unsafe_path" if isinstance(error, ValueError) else "io") from error

    def _execute(self, statement, parameters=()):
        # Keep this wrapper away from loaders: their sqlite/OSError/ValueError
        # exceptions belong to the canonical operation and must remain intact.
        try:
            return self.connection.execute(statement, parameters)
        except sqlite3.Error as error:
            raise CanonicalIndexUnavailable("Read index SQL operation failed", reason=_sql_reason(error)) from error

    def _connect(self, *, read_only=False):
        try:
            path = self.path.as_uri() + "?mode=ro" if read_only else str(self.path)
            self.connection = sqlite3.connect(path, timeout=self._busy_ms / 1000,
                                              isolation_level=None, uri=read_only)
        except sqlite3.Error as error:
            raise CanonicalIndexUnavailable("Cannot open read index", reason=_sql_reason(error)) from error
        self._execute(f"PRAGMA busy_timeout={self._busy_ms}")
        self._execute("PRAGMA trusted_schema=OFF")

    def _all(self, statement, parameters=()):
        try:
            return self._execute(statement, parameters).fetchall()
        except sqlite3.Error as error:
            raise CanonicalIndexUnavailable("Read index SQL result failed", reason=_sql_reason(error)) from error

    def _rollback(self):
        try:
            self.connection.rollback()
        except sqlite3.Error:
            pass  # Preserve the original failure, especially a loader failure.

    @contextmanager
    def _transaction(self):
        self._execute("BEGIN IMMEDIATE")
        try:
            yield
            self._execute("COMMIT")
        except BaseException:
            self._rollback()
            raise

    def _open(self):
        created = False
        try:
            self.store._check_path(self.directory)
            self.directory.mkdir(mode=0o700, exist_ok=True)
            self._check_paths(require_database=False)
            # O_EXCL distinguishes our new empty file from existing unknown
            # files, including empty ones. Never initialize those in place.
            self.store._check_path(self.path)
            try:
                descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                descriptor = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
            else:
                created = True
            try:
                observed = os.fstat(descriptor)
                if not stat.S_ISREG(observed.st_mode):
                    raise ValueError("index database must be a regular file")
                self._identity = (observed.st_dev, observed.st_ino)
                if not created:
                    header = os.read(descriptor, 100)
                    if (len(header) != 100 or header[:16] != b"SQLite format 3\x00"
                            or int.from_bytes(header[68:72], "big") != _APPLICATION_ID
                            or int.from_bytes(header[60:64], "big") != _SCHEMA_VERSION):
                        raise ValueError("unrecognized index database")
            finally:
                os.close(descriptor)
        except (OSError, ValueError) as error:
            raise CanonicalIndexUnavailable("Cannot prepare read index", reason="io") from error
        self._check_paths()
        try:
            # An existing file must pass schema validation without hot-journal
            # recovery or other SQLite writes before it is trusted as ours.
            self._connect(read_only=not created)
            if created:
                with self._transaction():
                    self._execute(_CREATE_TABLE)
                    for sql in _CREATE_INDEXES.values():
                        self._execute(sql)
                    self._execute(f"PRAGMA application_id={_APPLICATION_ID}")
                    self._execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
            else:
                # Validate before a persistent pragma can modify an existing
                # file. Schema metadata is the only unscoped SELECT here.
                schema = {(kind, name): sql for kind, name, sql in self._all(
                    "SELECT type, name, sql FROM sqlite_master ORDER BY type, name")}
                if schema != _EXPECTED_SCHEMA:
                    raise CanonicalIndexUnavailable("Read index schema does not match this application", reason="schema")
                if (self._all("PRAGMA application_id")[0][0] != _APPLICATION_ID
                        or self._all("PRAGMA user_version")[0][0] != _SCHEMA_VERSION):
                    raise CanonicalIndexUnavailable("Read index version does not match this application", reason="schema")
                self._close()
                self._check_paths()
                self._connect()
            if self._all("PRAGMA journal_mode")[0][0] != "wal":
                if self._all("PRAGMA journal_mode=WAL")[0][0] != "wal":
                    raise CanonicalIndexUnavailable("Read index WAL mode is unavailable", reason="io")
            self._execute("PRAGMA synchronous=FULL")
            self._check_paths()
        except BaseException:
            self._close(suppress=True)
            raise
        return self

    def _close(self, *, suppress=False):
        if self.connection is not None:
            try:
                self.connection.close()
            except sqlite3.Error as error:
                if not suppress:
                    raise CanonicalIndexUnavailable("Cannot close read index", reason=_sql_reason(error)) from error
            finally:
                self.connection = None

    def _scope(self, namespace, scope):
        _text(namespace, "namespace", nonempty=True)
        _text(scope, "scope")
        self._check_paths()

    @staticmethod
    def _encode(payload):
        if not isinstance(payload, dict):
            raise TypeError("read index loader must return a JSON dictionary")
        # Encoding validates only the caller's derived summary. In particular,
        # do not turn its ValueError/TypeError into a cache fallback signal.
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)

    @staticmethod
    def _decode(payload, payload_hash):
        try:
            if sha256(payload.encode("utf-8")).hexdigest() != payload_hash:
                raise ValueError("cached summary hash differs")
            result = json.loads(payload)
            if not isinstance(result, dict):
                raise ValueError("cached summary is not a dictionary")
            return result
        except (AttributeError, TypeError, ValueError) as error:
            raise CanonicalIndexUnavailable("Read index summary is corrupt", reason="corrupt") from error

    def _put(self, namespace, scope, key, signature, payload, encoded):
        normalized = tuple(payload.get(field) if isinstance(payload.get(field), str) else None for field in _FIELDS)
        self._execute(
            "INSERT INTO read_index_rows (namespace, scope, key, signature, payload, payload_hash, title, source_id, state, created_at, revision, owner) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, scope, key) DO UPDATE SET "
            "signature=excluded.signature, payload=excluded.payload, payload_hash=excluded.payload_hash, title=excluded.title, source_id=excluded.source_id, "
            "state=excluded.state, created_at=excluded.created_at, revision=excluded.revision, owner=excluded.owner",
            (namespace, scope, key, signature, encoded, sha256(encoded.encode("utf-8")).hexdigest(), *normalized))

    @_measured("index_sync")
    def sync(self, namespace, scope, entries, loader):
        """Atomically match one scope; load only added/changed signatures.

        A loader failure rolls back updates and removals from this invocation,
        preserving the previously complete scope. Other scopes are untouched.
        Matching signatures return at the initial SELECT without a write lock;
        changes are checked again after acquiring the SQL write transaction.
        """
        self._scope(namespace, scope)
        current = {}
        for key, signature in entries:
            _text(key, "key")
            _text(signature, "signature")
            if key in current:
                raise ValueError("read index entries must have unique keys")
            current[key] = signature
        statement = "SELECT key, signature FROM read_index_rows WHERE namespace=? AND scope=?"
        if dict(self._all(statement, (namespace, scope))) == current:
            cache_event("hit")
            return
        cache_event("miss")
        with self._transaction():
            previous = dict(self._all(statement, (namespace, scope)))
            for key, signature in current.items():
                if previous.get(key) != signature:
                    payload = loader(key)
                    encoded = self._encode(payload)
                    self._put(namespace, scope, key, signature, payload, encoded)
            for key in previous.keys() - current.keys():
                self._execute("DELETE FROM read_index_rows WHERE namespace=? AND scope=? AND key=?", (namespace, scope, key))

    @_measured("index_lookup")
    def get(self, namespace, scope, key, signature, loader):
        """Read one summary or atomically load and commit its new signature."""
        self._scope(namespace, scope)
        _text(key, "key")
        _text(signature, "signature")
        parameters = (namespace, scope, key)
        statement = "SELECT signature, payload, payload_hash FROM read_index_rows WHERE namespace=? AND scope=? AND key=?"
        rows = self._all(statement, parameters)
        if rows and rows[0][0] == signature:
            cache_event("hit")
            return self._decode(rows[0][1], rows[0][2])
        cache_event("miss")
        with self._transaction():
            rows = self._all(statement, parameters)
            if rows and rows[0][0] == signature:
                return self._decode(rows[0][1], rows[0][2])
            payload = loader()
            encoded = self._encode(payload)
            self._put(namespace, scope, key, signature, payload, encoded)
            return self._decode(encoded, sha256(encoded.encode("utf-8")).hexdigest())

    @_measured("index_lookup")
    def lookup(self, namespace, scope, keys=None, *, filters=None):
        """Read signatures and summaries from one scope in one SQL statement.

        None selects the scope's thin metadata; an iterable selects only those
        unique string keys. Missing keys are omitted. Callers compare returned
        signatures with canonical observations before reusing each summary.
        No loader runs and no transaction or connection state is retained.
        """
        self._scope(namespace, scope)
        extra = ""
        parameters = [namespace, scope]
        if keys is not None:
            if isinstance(keys, (str, bytes)):
                raise TypeError("keys must be an iterable of unique strings")
            selected, seen = [], set()
            for key in keys:
                _text(key, "key")
                if key in seen:
                    raise ValueError("read index lookup keys must be unique")
                seen.add(key)
                selected.append(key)
            if not selected:
                return {}
            extra = " AND key IN (" + ",".join("?" for _ in selected) + ")"
            parameters.extend(selected)
        filtered, arguments = self._filters(filters)
        parameters.extend(arguments)
        rows = self._all(
            "SELECT key, signature, payload, payload_hash FROM read_index_rows "
            "WHERE namespace=? AND scope=?" + extra + filtered + " ORDER BY key", parameters)
        return {key: (signature, self._decode(payload, payload_hash))
                for key, signature, payload, payload_hash in rows}

    @staticmethod
    def _filters(filters):
        conditions, parameters = [], []
        for field, value in (filters or {}).items():
            if field not in _FIELDS:
                raise ValueError("unsupported read index filter")
            if isinstance(value, (list, tuple)):
                if not value:
                    conditions.append("0")
                else:
                    for item in value:
                        _text(item, "filter value")
                    conditions.append(field + " IN (" + ",".join("?" for _ in value) + ")")
                    parameters.extend(value)
            elif value is None:
                conditions.append(f"{field} IS NULL")
            else:
                _text(value, "filter value")
                conditions.append(f"{field}=?")
                parameters.append(value)
        return "".join(" AND " + condition for condition in conditions), parameters

    @staticmethod
    def _matching(search, any_filters):
        extra, parameters = "", []
        if search is not None:
            _text(search, "search")
            extra += " AND instr(title,?)>0"
            parameters.append(search)
        if any_filters:
            conditions = []
            for field, value in any_filters.items():
                if field not in _FIELDS:
                    raise ValueError("unsupported read index filter")
                _text(value, "filter value")
                conditions.append(field + "=?")
                parameters.append(value)
            extra += " AND (" + " OR ".join(conditions) + ")"
        return extra, parameters

    @_measured("index_sync")
    def replace_owner(self, namespace, scope, owner, entries):
        """Atomically replace one derived resource, including its manifest row.

        Encode all projections before touching previous rows. Canonical data is
        never written here; the caller retains its canonical lock throughout.
        """
        self._scope(namespace, scope)
        _text(owner, "owner", nonempty=True)
        prepared, seen = [], set()
        for key, signature, payload in entries:
            _text(key, "key", nonempty=True)
            _text(signature, "signature")
            if key in seen or payload.get("owner") != owner:
                raise ValueError("projection keys must be unique and belong to the owner")
            seen.add(key)
            prepared.append((key, signature, payload, self._encode(payload)))
        with self._transaction():
            self._execute("DELETE FROM read_index_rows WHERE namespace=? AND scope=? AND owner=?",
                          (namespace, scope, owner))
            for key, signature, payload, encoded in prepared:
                self._put(namespace, scope, key, signature, payload, encoded)

    @_measured("index_page")
    def count(self, namespace, scope, *, filters=None, search=None, any_filters=None):
        self._scope(namespace, scope)
        extra, parameters = self._filters(filters)
        matching, arguments = self._matching(search, any_filters)
        rows = self._all("SELECT count(*) FROM read_index_rows WHERE namespace=? AND scope=?" + extra + matching,
                         [namespace, scope, *parameters, *arguments])
        return rows[0][0]

    @_measured("index_page")
    def page(self, namespace, scope, after=None, limit=100, reverse=False, *, filters=None,
             search=None, any_filters=None):
        """Return a SQL keyset page, ordered by the caller's stored key."""
        self._scope(namespace, scope)
        if after is not None:
            _text(after, "after")
        if type(limit) is not int or limit < 1:
            raise ValueError("limit must be a positive integer")
        if type(reverse) is not bool:
            raise TypeError("reverse must be a boolean")
        extra, parameters = self._filters(filters)
        matching, arguments = self._matching(search, any_filters)
        extra += matching
        parameters.extend(arguments)
        parameters = [namespace, scope, *parameters]
        if after is not None:
            extra += " AND key" + ("<?" if reverse else ">?")
            parameters.append(after)
        parameters.append(limit)
        rows = self._all(
            "SELECT key, payload, payload_hash FROM read_index_rows WHERE namespace=? AND scope=?" + extra
            + " ORDER BY key " + ("DESC" if reverse else "ASC") + " LIMIT ?", parameters)
        return [(key, self._decode(payload, payload_hash)) for key, payload, payload_hash in rows]

    @_measured("index_lookup")
    def values(self, namespace, scope, *, filters=None):
        """Return a scope's thin metadata where the domain needs all rows."""
        self._scope(namespace, scope)
        extra, parameters = self._filters(filters)
        rows = self._all(
            "SELECT key, payload, payload_hash FROM read_index_rows WHERE namespace=? AND scope=?" + extra + " ORDER BY key",
            (namespace, scope, *parameters))
        return [(key, self._decode(payload, payload_hash)) for key, payload, payload_hash in rows]


@contextmanager
def read_index(store):
    """Open a request-local cache connection without acquiring the store lock.

    Catch CanonicalIndexUnavailable around cache use to fall back to canonical
    reads. A cache failure never means a canonical save failed or needs retry.
    """
    index = CanonicalReadIndex(store)._open()
    try:
        yield index
    except BaseException:
        index._close(suppress=True)
        raise
    else:
        index._close()
