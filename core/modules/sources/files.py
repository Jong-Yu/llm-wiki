"""원본 저장의 안전한 파일 접근·별도 조정 잠금·원자 기록 도우미."""

# 파일을 읽고 쓰는 낮은 수준의 공통 기능이다. 원본 등록 여부는 commands.py에서 결정한다.
# 경로 검사 → 정규 파일 확인 → 크기 제한을 지키며 읽기/쓰기를 수행한다.

from contextlib import contextmanager
import errno
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import tempfile
import time

from core.common.json_codec import canonical_json_bytes
from core.modules.documents.store import StorageBusyError
from . import contracts as limits
from .contracts import SourceCorruptError, SourceLimitError


def checked(store, path):
    # 경로가 자료 루트 밖이나 심볼릭 링크로 이어지는지 기존 WikiStore 규칙을 재사용한다.
    try:
        store._check_path(path)
    except (ValueError, RuntimeError) as error:
        raise SourceCorruptError("Source storage contains an unsafe path.") from error
    return path


def mkdir(store, path):
    # 필요한 폴더만 만들고, 같은 이름의 일반 파일 등 예상 밖 상태라면 중단한다.
    checked(store, path).mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir():
        raise SourceCorruptError("A storage directory is invalid.")


@contextmanager
def coordination(store, *, create=False):
    """원본·작업·고정 입력이 공유하는 잠금이다. 위키 잠금보다 먼저 획득한다.

    각 업무가 별도 잠금을 만들면 같은 원본 기준을 확인한 뒤 서로 다른 상태를
    공개할 수 있다. 같은 tenant의 기준 검사와 상태 갱신을 이 잠금 안에 둔다.
    """
    path = checked(store, store.data_dir / ".registration.lock")
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(path, flags | (os.O_CREAT if create else 0), 0o600)
    except FileNotFoundError:
        if create or (store.data_dir / "_registrations").exists() or (store.data_dir / "_sources").exists():
            raise SourceCorruptError("The registration lock is unavailable.") from None
        yield
        return
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SourceCorruptError("The registration lock must be regular.")
        deadline = time.monotonic() + store.lock_timeout_seconds
        # 시스템 시계가 보정돼도 대기 시간이 어긋나지 않도록 경과 시간용 시계를 쓴다.
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                    raise
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise StorageBusyError(store.lock_timeout_seconds) from error
                time.sleep(min(0.05, remaining))
        yield
    finally:
        os.close(fd)


def open_regular(store, path):
    # 파이프/장치 파일을 읽다 멈추지 않도록 정규 파일만 연다. 반환한 스트림은 호출자가 닫는다.
    fd = os.open(checked(store, path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SourceCorruptError("A stored file must be regular.")
        result = os.fdopen(fd, "rb")
        fd = None
        return result
    finally:
        if fd is not None:
            os.close(fd)


def _object(pairs):
    # JSON의 같은 키가 두 번 나오면 뒤의 값으로 조용히 덮어쓰지 않고 손상으로 처리한다.
    result = {}
    for key, value in pairs:
        if key in result:
            raise SourceCorruptError("Stored JSON has duplicate keys.")
        result[key] = value
    return result


def read_json(store, path):
    # 한도보다 1바이트 더 읽어, 파일 크기 정보가 바뀌어도 실제 읽은 크기로 초과를 잡는다.
    try:
        with open_regular(store, path) as stream:
            raw = stream.read(limits.MAX_JSON_BYTES + 1)
        if len(raw) > limits.MAX_JSON_BYTES:
            raise SourceCorruptError("A metadata record exceeds its byte limit.")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_object,
                           parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
        if type(value) is not dict:
            raise ValueError()
        return value
    except (UnicodeError, ValueError, RecursionError, TypeError) as error:
        raise SourceCorruptError("A metadata record is invalid.") from error


def write_json(store, path, value):
    """같은 디렉터리의 임시 파일을 fsync 후 교체한다. 다중 파일 거래는 아니다."""
    raw = canonical_json_bytes(value)
    if len(raw) > limits.MAX_JSON_BYTES:
        raise SourceLimitError("A metadata record exceeds its byte limit.")
    mkdir(store, path.parent)
    checked(store, path)
    fd, name = tempfile.mkstemp(prefix=".source-", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    primary = None
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        checked(store, path)
        os.replace(temporary, path)
        # 완성한 임시 파일을 같은 디렉터리 안에서 교체한다. 여러 파일 전체의 거래를 뜻하지 않는다.
    except BaseException as error:
        primary = error
        raise
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError as error:
                if primary is None:
                    raise
                primary.cleanup_failures = [*getattr(primary, "cleanup_failures", []), {
                    "path": temporary.relative_to(store.data_dir).as_posix(),
                    "error_type": type(error).__name__, "errno": error.errno}]


def entries(store, directory, *, maximum):
    # 항목 이름만 정렬해 반환한다. 폴더가 없으면 빈 목록이고, 너무 많거나 링크가 있으면 오류다.
    checked(store, directory)
    try:
        with os.scandir(directory) as scan:
            result = []
            for entry in scan:
                if len(result) >= maximum:
                    raise SourceLimitError("The metadata scan limit was reached.")
                if entry.is_symlink():
                    raise SourceCorruptError("Symbolic links are not allowed in source storage.")
                result.append(entry.name)
            return sorted(result)
    except FileNotFoundError:
        return []


def original_usage(store, *, published=True, incoming=True):
    """공개 카탈로그가 없는 원본과 수신 중 원본도 합산한다."""
    total = count = 0
    roots = []
    if published:
        roots.append(store.data_dir / "_sources")
    if incoming:
        roots.append(store.data_dir / "_incoming")
    for root in roots:
        stack = [(root, 0)]
        # stack에는 (다음에 살필 폴더, 깊이)를 넣는다. 재귀 호출 대신 반복으로 탐색 범위를 제한한다.
        while stack:
            directory, depth = stack.pop()
            if depth > 4:
                raise SourceCorruptError("Source storage nesting is invalid.")
            for name in entries(store, directory, maximum=limits.MAX_SCAN_ENTRIES):
                count += 1
                if count > limits.MAX_SCAN_ENTRIES:
                    raise SourceLimitError("The source scan limit was reached.")
                path = directory / name
                info = path.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    stack.append((path, depth + 1))
                elif stat.S_ISREG(info.st_mode):
                    if name != "manifest.json":
                        total += info.st_size
                else:
                    raise SourceCorruptError("Source storage contains a nonregular file.")
    return total


def verify_original(store, path, manifest):
    # 실제 원본을 끝까지 읽어 설명서의 크기/hash와 대조한다. 성공하면 처음 위치로 되감아 반환한다.
    stream = open_regular(store, path)
    try:
        digest = sha256()
        size = 0
        while block := stream.read(limits.CHUNK_BYTES):
            size += len(block)
            if size > limits.MAX_SOURCE_BYTES:
                raise SourceCorruptError("The stored original exceeds its limit.")
            digest.update(block)
        if size != manifest["size_bytes"] or digest.hexdigest() != manifest["source_sha256"]:
            raise SourceCorruptError("The original differs from its recorded bytes.")
        stream.seek(0)
        return stream
    except BaseException:
        stream.close()
        raise
