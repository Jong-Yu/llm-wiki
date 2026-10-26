"""Markdown 본문과 수정 전 전체 파일을 보존하는 파일 저장 모듈.

revision은 내용 바이트의 SHA-256이며 편집 횟수가 아니다. 모든 쓰기는 save()의
공유 잠금·기준 버전 확인·전체 이력 보존을 거친다. 파일 관리자의 외부 수정은
이 잠금 계약 밖이며, 이 모듈은 macOS/Linux의 파일 잠금 기능을 사용한다.
"""

# 처음 읽는다면 WikiStore.read → WikiStore.save 순서로 본다. read는 본문과 그 본문의 revision을 함께 돌려준다.
# save는 그 revision이 아직 같은지 확인하고, 이전 전체 본문을 _history에 보관한 뒤 새 본문을 공개한다.
# @dataclass는 아래 필드로 값을 담는 객체를 만들고, frozen=True는 만들어진 객체의 필드 변경을 막는다.

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import errno
import fcntl
from hashlib import sha256
import math
import os
from pathlib import Path
import stat
import tempfile
import time
from typing import Iterator, List, Optional, Tuple, Union
from uuid import uuid4


from core.paths import DEFAULT_DATA_DIR
MAX_DOCUMENT_BYTES = 1024 * 1024
DEFAULT_LOCK_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True)
class DocumentSnapshot:
    """Content and its SHA-256 state token, computed from the same file read."""

    content: str
    revision: str


@dataclass(frozen=True)
class CleanupFailure:
    """A temporary file that could not be removed after this operation."""

    path: Path
    error: OSError


@dataclass(frozen=True)
class SaveResult:
    """Successful save/no-op, with cleanup problems reported separately."""

    revision: str
    history_path: Optional[Path]
    changed: bool
    cleanup_failures: Tuple[CleanupFailure, ...] = ()


@dataclass
class _StagedFile:
    path: Path
    consumed: bool = False


class DocumentTooLargeError(ValueError):
    """The document exceeds the byte limit; observed_bytes is a lower bound."""

    def __init__(self, document: str, observed_bytes: int):
        self.document = document
        self.limit_bytes = MAX_DOCUMENT_BYTES
        self.observed_bytes = observed_bytes
        super().__init__(
            f"Document {document!r} exceeds {self.limit_bytes} UTF-8 bytes "
            f"(observed at least {observed_bytes} bytes)."
        )


class RevisionConflictError(Exception):
    """The current content differs from the caller's editing base."""

    def __init__(
        self,
        document: str,
        expected_revision: Optional[str],
        current_revision: Optional[str],
    ):
        self.document = document
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            f"Revision conflict for {document!r}; read the latest document and "
            "reconcile your changes before saving."
        )


class StorageBusyError(TimeoutError):
    """The write lock remained busy; no document or history was changed."""

    def __init__(self, timeout_seconds: float):
        self.timeout_seconds = timeout_seconds
        super().__init__(
            f"Storage remained busy for {timeout_seconds:g} seconds; "
            "try again later with the same expected revision."
        )


class WikiStore:
    """본문 읽기와 보존 저장의 공용 진입점. 쓰기는 반드시 save()를 사용한다."""

    def __init__(
        self,
        data_dir: Union[str, Path] = DEFAULT_DATA_DIR,
        *,
        lock_timeout_seconds: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
    ):
        if isinstance(lock_timeout_seconds, bool) or not isinstance(
            lock_timeout_seconds, (int, float)
        ):
            raise TypeError("lock_timeout_seconds must be a finite nonnegative number")
        try:
            timeout = float(lock_timeout_seconds)
        except OverflowError:
            raise ValueError("lock_timeout_seconds must be finite") from None
        if not math.isfinite(timeout) or timeout < 0:
            raise ValueError("lock_timeout_seconds must be finite and nonnegative")
        self.lock_timeout_seconds = timeout
        # Require an existing root so a typo cannot silently create a new store.
        self.data_dir = Path(data_dir).resolve(strict=True)
        if not self.data_dir.is_dir():
            raise NotADirectoryError(self.data_dir)
        self.wiki_dir = self.data_dir / "wiki"
        self.history_dir = self.data_dir / "_history"
        self._mkdir(self.wiki_dir)
        self._mkdir(self.history_dir)

    def read(self, document: str) -> DocumentSnapshot:
        """Read content and revision together, preserving original line endings."""
        # 파일의 원래 바이트를 한 번 읽어 본문과 내용 지문을 함께 반환한다. 두 값을 따로 읽으면 수정 사이에 버전이 어긋날 수 있다.
        raw = self._read_document(self._document_path(self.wiki_dir, document), document)
        return DocumentSnapshot(content=raw.decode("utf-8"), revision=self._revision(raw))

    def save(
        self, document: str, content: str, *, expected_revision: Optional[str],
        before_commit=None,
    ) -> SaveResult:
        """Save bounded UTF-8 text and return its committed result.

        expected_revision is required: None means create only; updates must use
        the revision returned with the content they were based on. A mismatch
        raises RevisionConflictError before changing the document or history,
        including when the submitted content already equals the current file.
        History errors propagate before the current file is replaced. A complete
        snapshot is kept if publishing the new current file subsequently fails.
        Cleanup failures alone do not undo a successful save: they are returned
        in SaveResult.cleanup_failures. If saving itself fails, its original
        exception is re-raised with cleanup_failures attached when applicable.

        before_commit is an internal workflow guard, called without arguments
        under the existing write lock after CAS and before any document/history
        write (including a no-op). It must not reacquire this non-reentrant lock.
        """
        # None 기준은 신규 생성만, 문자열 기준은 그 내용을 읽은 뒤 수정한다는 뜻이다. 기존 이력을 먼저 보존한 뒤 새 파일을 공개한다.
        if not isinstance(content, str):
            raise TypeError("content must be a string")
        if expected_revision is not None and not isinstance(expected_revision, str):
            raise TypeError("expected_revision must be a string or None")
        self._document_path(self.wiki_dir, document)
        # Each valid UTF-8 character takes at least one byte. Reject enormous
        # strings without allocating another full-size encoded copy.
        if len(content) > MAX_DOCUMENT_BYTES:
            raise DocumentTooLargeError(document, len(content))
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_DOCUMENT_BYTES:
            raise DocumentTooLargeError(document, len(encoded))
        revision = self._revision(encoded)
        cleanup_failures: List[CleanupFailure] = []

        try:
            with self._write_lock():
                target = self._document_path(self.wiki_dir, document)
                try:
                    previous = self._read_document(target, document)
                except FileNotFoundError:
                    previous = None

                current_revision = None if previous is None else self._revision(previous)
                # 내용이 같아 보이더라도 오래된 편집 기준을 먼저 거부해야 충돌을 숨기지 않는다.
                if expected_revision != current_revision:
                    raise RevisionConflictError(document, expected_revision, current_revision)

                # 고정 입력·현재 권한의 마지막 검사를 실제 저장과 같은 잠금에 둔다.
                # guard 안에서는 이미 가진 잠금을 다시 얻는 public 저장/조회를 호출하지 않는다.
                if before_commit is not None:
                    before_commit()

                if previous == encoded:
                    return SaveResult(revision=revision, history_path=None, changed=False)

                self._mkdir(target.parent)
                with self._staged_file(target.parent, encoded, cleanup_failures) as staged:
                    version = None
                    if previous is not None:
                        # 수정 전 전체 파일을 공개한 뒤에만 최신 파일을 교체한다.
                        version = self._archive(document, previous, cleanup_failures)
                        os.replace(staged.path, target)
                        # replace() consumed this name; there is nothing to unlink.
                        staged.consumed = True
                    else:
                        # Publish without overwriting a file created outside our lock.
                        os.link(staged.path, target)
        except Exception as error:
            if cleanup_failures:
                error.cleanup_failures = tuple(cleanup_failures)
            raise

        # Both staging contexts have exited, so all cleanup outcomes are known.
        return SaveResult(revision, version, True, tuple(cleanup_failures))

    @staticmethod
    def _read_document(path: Path, document: str) -> bytes:
        # One bounded read also catches growth without trusting a prior stat().
        with path.open("rb") as stream:
            raw = stream.read(MAX_DOCUMENT_BYTES + 1)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise DocumentTooLargeError(document, len(raw))
        return raw

    @staticmethod
    def _revision(content: bytes) -> str:
        # A content-state token, not a monotonic edit number: reverting to the
        # exact same bytes restores this token without losing any current edits.
        return sha256(content).hexdigest()

    def _archive(
        self, document: str, previous: bytes, cleanup_failures: List[CleanupFailure]
    ) -> Path:
        versions = self._document_path(self.history_dir, document)
        self._mkdir(versions)
        version = versions / self._version_name()
        with self._staged_file(versions, previous, cleanup_failures) as staged:
            # A hard link atomically publishes complete bytes and never replaces
            # an existing history file, even if version names collide.
            os.link(staged.path, version)
        return version

    @staticmethod
    def _version_name() -> str:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        return f"{timestamp}-{uuid4().hex}.md"

    def _document_path(self, base: Path, document: str) -> Path:
        # 상대 .md 경로만 허용해 .., 절대 경로, 링크로 자료 폴더 밖을 가리키지 못하게 한다.
        if not isinstance(document, str):
            raise TypeError("document must be a string")
        parts = document.split("/")
        if (
            not document
            or "\\" in document
            or "\x00" in document
            or any(part in ("", ".", "..") for part in parts)
            or not document.endswith(".md")
        ):
            raise ValueError("document must be a relative .md path without '.' or '..'")
        target = base.joinpath(*parts)
        self._check_path(target)
        return target

    def _check_path(self, path: Path) -> None:
        current = self.data_dir
        for part in ("", *path.relative_to(self.data_dir).parts):
            current = current / part
            if current.is_symlink():
                raise ValueError(f"symbolic links are not supported: {current}")

    def _mkdir(self, directory: Path) -> None:
        self._check_path(directory)
        directory.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def _write_lock(self) -> Iterator[None]:
        # Keep the lock file: unlinking it could let writers lock different inodes.
        """같은 tenant의 쓰기·복합 조회가 공유하는 비재진입 잠금. 잠금 파일은 삭제하지 않는다."""
        # with 블록 동안 같은 tenant의 쓰기를 순서대로 처리한다. 끝나거나 예외가 나면 finally에서 열린 descriptor를 닫는다.
        lock_path = self.data_dir / ".storage.lock"
        self._check_path(lock_path)
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ValueError("storage lock must be a regular file")
            # Nonblocking attempts keep lock contention bounded without changing
            # the critical section. A zero timeout still makes one attempt.
            deadline = time.monotonic() + self.lock_timeout_seconds
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as error:
                    if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise StorageBusyError(self.lock_timeout_seconds) from error
                    time.sleep(min(0.05, remaining))
                else:
                    break
            yield
        finally:
            os.close(descriptor)

    @staticmethod
    @contextmanager
    def _staged_file(
        directory: Path, content: bytes, cleanup_failures: List[CleanupFailure]
    ) -> Iterator[_StagedFile]:
        """전체 바이트를 임시 파일에 기록한 뒤 공개할 준비를 하고 정리 실패는 별도로 모은다."""
        # 임시 파일에 전체 내용을 쓰고 yield로 호출자에게 넘긴다. 공개되지 않은 임시 파일만 마지막에 정리한다.
        descriptor, name = tempfile.mkstemp(prefix=".wiki-", suffix=".tmp", dir=directory)
        staged = _StagedFile(Path(name))
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            yield staged
        finally:
            # Remove only the temporary file created by this invocation.
            if not staged.consumed:
                try:
                    staged.path.unlink(missing_ok=True)
                except OSError as error:
                    # Do not mask the primary failure or turn a committed save
                    # into an apparent write failure. The caller reports both.
                    cleanup_failures.append(CleanupFailure(staged.path, error))
