# prepare_launch가 보호된 토큰/설정/실행 파일을 확인해 실행 계획을 만들고 launch가 그 계획으로 stdio 서버를 시작한다.
# 파일 이름을 셸 문자열로 조립하지 않고 검증한 실행 인자를 사용한다. 계획 확인과 실제 프로세스 실행은 별도 함수다.

"""보호된 파일의 개인 토큰으로 프로젝트 stdio MCP를 시작하는 POSIX 런처.

클라이언트 설정·데이터 복사·수신 포트 생성이나 legacy 인증 대체는 하지 않는다.
로컬 관리자 및 같은 OS 사용자로 실행되는 프로세스와의 비밀 격리는 보장하지 않는다.
"""

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
import math
import os
from pathlib import Path
import re
import stat
import sys

from core.modules.access.policy import AccessDenied, AccessPolicy, MAX_POLICY_BYTES, PolicyError


# 호출한 셸의 작업 경로·PATH 대신 이 프로젝트의 모듈과 가상환경을 실행한다.
from core.paths import PROJECT_DIR, PROJECT_PYTHON
PERSONAL_TOKEN_ENV = "LLM_WIKI_PERSONAL_TOKEN"
MAX_TOKEN_FILE_BYTES = 258  # At most 256 URL-safe bytes plus one optional CRLF.
_TOKEN_FILE = re.compile(rb"[A-Za-z0-9_-]{32,256}(?:\r?\n)?", re.ASCII)


class LauncherError(ValueError):
    """CLI에는 입력값을 담지 않은 고정 오류 코드만 전달한다."""

    def __init__(self, code="validation_failed"):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class LaunchSpec:
    """실행 인자를 묶되, 비밀이 든 환경 변수는 객체 repr에서 제외한다."""

    executable: str
    argv: tuple[str, ...]
    cwd: str
    environment: dict[str, str] = field(repr=False)


def _absolute_path(value):
    try:
        path = Path(value)
        if not path.is_absolute() or ".." in path.parts or "\x00" in str(path):
            raise ValueError
        return path
    except (ValueError, TypeError, OSError):
        raise LauncherError("invalid_path") from None


def _directory_security(info, *, private=False):
    if not stat.S_ISDIR(info.st_mode):
        raise LauncherError("protected_path_invalid")
    uid = os.geteuid()
    mode = stat.S_IMODE(info.st_mode)
    if private:
        if info.st_uid != uid or mode != 0o700:
            raise LauncherError("protected_parent_invalid")
    elif info.st_uid not in {0, uid} or (
        mode & 0o022 and not (info.st_uid == 0 and mode & stat.S_ISVTX)
    ):
        # Root-owned sticky OS temporary ancestors are safe traversal boundaries;
        # the credential's direct parent must still be current-user 0700.
        raise LauncherError("protected_path_invalid")


@contextmanager
def _directory(path):
    """경로 중간의 링크도 따르지 않도록 dir_fd/O_NOFOLLOW로 각 디렉터리를 연다."""
    descriptor = None
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        descriptor = os.open(path.anchor, flags)
        _directory_security(os.fstat(descriptor))
        for component in path.parts[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            _directory_security(os.fstat(descriptor))
        yield descriptor
    except OSError:
        raise LauncherError("protected_path_invalid") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


# 경로와 파일 권한을 확인하고 열린 descriptor로 같은 파일을 읽는다. 단순 파일명 재조회 사이의 바꿔치기를 줄인다.
def _protected_bytes(path, limit):
    descriptor = None
    try:
        with _directory(path.parent) as parent:
            _directory_security(os.fstat(parent), private=True)
            descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                 dir_fd=parent)
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
                    or stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1):
                raise LauncherError("protected_file_invalid")
            if before.st_size > limit:
                raise LauncherError("protected_file_too_large")
            # Read boundedly even if the file changes after the initial fstat.
            with os.fdopen(descriptor, "rb") as source:
                descriptor = None
                raw = source.read(limit + 1)
                after = os.fstat(source.fileno())
            if len(raw) > limit or _fingerprint(before) != _fingerprint(after):
                raise LauncherError("protected_file_changed")
            return raw
    except OSError:
        raise LauncherError("protected_file_unavailable") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


# 토큰을 서버 실행 환경에 넣을 계획을 만든다. 계획만 반환하며 원문이나 클라이언트 설정을 수정하지 않는다.
def prepare_launch(*, token_file, access_config, tenant_root, lock_timeout=5,
                   environment=None) -> LaunchSpec:
    """프로세스를 시작하거나 데이터를 쓰지 않고 stdio 실행 계획을 검증한다.

    비밀이 든 environment는 LaunchSpec의 repr에서 제외한다. 이 계획으로 서버의
    인증을 대신하지 않으며, 서버는 도구 호출마다 현재 정책으로 다시 확인한다.
    """
    if os.name != "posix":
        raise LauncherError("unsupported_platform")
    token_file = _absolute_path(token_file)
    access_config = _absolute_path(access_config)
    tenant_root = _absolute_path(tenant_root)
    if (token_file.is_relative_to(tenant_root) or access_config.is_relative_to(tenant_root)
            or token_file == access_config):
        raise LauncherError("credential_boundary_invalid")
    try:
        valid_timeout = (not isinstance(lock_timeout, bool) and isinstance(lock_timeout, (int, float))
                         and math.isfinite(lock_timeout) and lock_timeout >= 0)
    except (ValueError, TypeError, OverflowError):
        valid_timeout = False
    if not valid_timeout:
        raise LauncherError("invalid_lock_timeout")
    with _directory(tenant_root):
        pass
    raw = _protected_bytes(token_file, MAX_TOKEN_FILE_BYTES)
    if _TOKEN_FILE.fullmatch(raw) is None:
        raise LauncherError("credential_format_invalid")
    token = raw.removesuffix(b"\n").removesuffix(b"\r").decode("ascii")
    _protected_bytes(access_config, MAX_POLICY_BYTES)
    try:
        # 서버와 같은 정책 파서를 사용하되 저장소 생성이나 tenant 본문 접근은 하지 않는다.
        AccessPolicy(access_config, tenant_root, lock_timeout_seconds=lock_timeout).authenticate(token)
    except AccessDenied:
        raise LauncherError("credentials_rejected") from None
    except (PolicyError, OSError, ValueError, TypeError):
        raise LauncherError("policy_unavailable") from None
    if not PROJECT_PYTHON.is_file() or not os.access(PROJECT_PYTHON, os.X_OK):
        raise LauncherError("runtime_unavailable")
    inherited = os.environ if environment is None else environment
    # 공유 토큰과 상속된 Python 실행 설정이 개인 인증·프로젝트 모듈 선택에 끼어들지 않게 한다.
    child_environment = {key: value for key, value in inherited.items()
                         if not key.startswith(("LLM_WIKI_", "PYTHON"))}
    # 토큰 원문은 argv에 넣지 않고 자식 프로세스 환경으로 전달한다.
    child_environment[PERSONAL_TOKEN_ENV] = token
    argv = (str(PROJECT_PYTHON), "-B", "-m", "core.mcp_server",
            "--access-config", str(access_config), "--tenant-root", str(tenant_root),
            "--transport", "stdio", "--token-env", PERSONAL_TOKEN_ENV,
            "--lock-timeout", str(lock_timeout))
    return LaunchSpec(str(PROJECT_PYTHON), argv, str(PROJECT_DIR), child_environment)


# 검증한 계획으로 현재 프로세스를 서버 실행으로 교체한다. 실패하면 비밀 값 대신 고정 오류를 알린다.
def launch(**arguments):
    spec = prepare_launch(**arguments)
    try:
        os.chdir(spec.cwd)
        os.execve(spec.executable, list(spec.argv), spec.environment)
    except OSError:
        raise LauncherError("exec_failed") from None
    raise LauncherError("exec_failed")  # exec must replace this process.


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse 기본 오류는 입력 인자를 반복할 수 있어 비밀이 없는 고정 문구로 바꾼다.
        self.exit(2, "personal-launcher: invalid_arguments.\n")


# 명령줄의 명시 경로를 받아 개인 stdio 서버를 시작하는 입구다.
def main(argv=None):
    parser = _Parser(prog="llm-wiki-personal", description=__doc__, allow_abbrev=False)
    parser.add_argument("--token-file", required=True, type=Path,
                        help="Absolute current-user 0600 personal token file under a private 0700 parent.")
    parser.add_argument("--access-config", required=True, type=Path,
                        help="Absolute protected policy file outside tenant storage.")
    parser.add_argument("--tenant-root", required=True, type=Path,
                        help="Absolute existing tenant root; authentication never falls back to legacy.")
    parser.add_argument("--lock-timeout", type=float, default=5,
                        help="Finite nonnegative writer-lock wait in seconds (default: 5).")
    args = parser.parse_args(argv)
    try:
        launch(token_file=args.token_file, access_config=args.access_config,
               tenant_root=args.tenant_root, lock_timeout=args.lock_timeout)
    except LauncherError as error:
        print(f"personal-launcher: {error.code}.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
