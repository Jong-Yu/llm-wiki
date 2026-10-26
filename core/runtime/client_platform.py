"""개인 PC 실행기의 파일/경로 경계. 저장 서버의 POSIX 계약과 분리한다.

Windows는 chmod를 ACL 보호로 해석하지 않는다. pywin32가 없거나 reparse point,
공개 DACL이면 실패하며 기존 파일의 권한을 자동 수정하지 않는다.
"""

from contextlib import contextmanager, ExitStack
import os
from pathlib import Path
import stat


class ClientPlatformError(OSError):
    pass


def is_windows():
    return os.name == "nt"


def project_python(project):
    return Path(project) / ".venv" / ("Scripts/python.exe" if is_windows() else "bin/python")


def _win():
    try:
        import win32api, win32con, win32file, win32security, pywintypes
        return win32api, win32con, win32file, win32security, pywintypes
    except ImportError:
        raise ClientPlatformError("windows_security_dependency_missing") from None


def _sid():
    api, con, _, security, _ = _win()
    with security.OpenProcessToken(api.GetCurrentProcess(), con.TOKEN_QUERY) as token:
        return security.GetTokenInformation(token, security.TokenUser)[0]


def _attributes():
    _, con, _, security, types = _win()
    sid = _sid()
    acl = security.ACL()
    acl.AddAccessAllowedAceEx(security.ACL_REVISION,
        con.OBJECT_INHERIT_ACE | con.CONTAINER_INHERIT_ACE, con.FILE_ALL_ACCESS, sid)
    sd = security.SECURITY_DESCRIPTOR()
    sd.SetSecurityDescriptorOwner(sid, False)
    sd.SetSecurityDescriptorDacl(True, acl, False)
    sd.SetSecurityDescriptorControl(security.SE_DACL_PROTECTED, security.SE_DACL_PROTECTED)
    attrs = types.SECURITY_ATTRIBUTES()
    attrs.SECURITY_DESCRIPTOR = sd
    return attrs


def _check_acl(handle):
    _, _, _, security, _ = _win()
    sd = security.GetSecurityInfo(handle, security.SE_FILE_OBJECT,
        security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION)
    sid = _sid()
    if sd.GetSecurityDescriptorOwner() != sid:
        raise ClientPlatformError("private_file_required")
    dacl = sd.GetSecurityDescriptorDacl()
    if dacl is None:
        raise ClientPlatformError("private_file_required")
    permitted = {security.ConvertSidToStringSid(sid), "S-1-5-18", "S-1-5-32-544"}
    for index in range(dacl.GetAceCount()):
        ace = dacl.GetAce(index)
        kind = ace[0][0]
        # 복잡한 object/callback ACE를 허용했다고 추정하지 않는다.
        if kind not in (security.ACCESS_ALLOWED_ACE_TYPE, security.ACCESS_DENIED_ACE_TYPE):
            raise ClientPlatformError("unsupported_file_acl")
        if kind == security.ACCESS_ALLOWED_ACE_TYPE and security.ConvertSidToStringSid(ace[2]) not in permitted:
            raise ClientPlatformError("private_file_required")


@contextmanager
def _win_handle(path, *, directory=False, private=True, create=False):
    _, con, files, _, types = _win()
    flags = con.FILE_FLAG_OPEN_REPARSE_POINT | (con.FILE_FLAG_BACKUP_SEMANTICS if directory else 0)
    handle = None
    try:
        handle = files.CreateFile(str(path), con.GENERIC_WRITE | con.READ_CONTROL if create else con.GENERIC_READ,
            con.FILE_SHARE_READ | (con.FILE_SHARE_WRITE if directory else 0),
            _attributes() if create else None, con.CREATE_NEW if create else con.OPEN_EXISTING, flags, None)
        info = files.GetFileInformationByHandle(handle)
        if info[0] & con.FILE_ATTRIBUTE_REPARSE_POINT or bool(info[0] & con.FILE_ATTRIBUTE_DIRECTORY) != directory:
            raise ClientPlatformError("unsafe_file_path")
        if not directory and info[7] != 1:
            raise ClientPlatformError("unsafe_file_path")
        if private:
            _check_acl(handle)
        yield handle
    except types.error as error:
        if getattr(error, "winerror", None) in {80, 183}:
            raise FileExistsError(path) from None
        raise ClientPlatformError("windows_file_unavailable") from None
    finally:
        if handle is not None:
            handle.Close()


@contextmanager
def _win_parents(path):
    # 열린 조상 핸들은 delete sharing을 허용하지 않아 읽는 동안 경로 교체를 막는다.
    with ExitStack() as stack:
        for parent in reversed(path.parents):
            stack.enter_context(_win_handle(parent, directory=True, private=False))
        yield


def _path(value):
    path = Path(value).absolute()
    if ".." in path.parts or (is_windows() and (str(path).startswith("\\\\") or any(":" in p for p in path.parts[1:]))):
        raise ClientPlatformError("unsafe_file_path")
    for part in ((path, *path.parents) if is_windows() else (path,)):
        if part.is_symlink() or getattr(part.lstat() if part.exists() else None, "st_file_attributes", 0) & 0x400:
            raise ClientPlatformError("unsafe_file_path")
    return path


def private_directory(value, *, exist_ok=True):
    path = _path(value)
    if is_windows():
        _, _, files, _, types = _win()
        with _win_parents(path):
            if not path.exists():
                try:
                    files.CreateDirectory(str(path), _attributes())
                except types.error:
                    raise ClientPlatformError("windows_directory_unavailable") from None
            elif not exist_ok:
                raise FileExistsError(path)
            with _win_handle(path, directory=True):
                pass
    else:
        path.mkdir(mode=0o700, exist_ok=exist_ok)
        info = path.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
            raise ClientPlatformError("private_directory_required")
    return path


def open_new(value):
    """기존 파일은 보존하고 새 0600/DACL 파일 descriptor만 반환한다."""
    path = _path(value)
    if not is_windows():
        return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    import msvcrt
    with _win_parents(path), _win_handle(path, create=True) as handle:
        # DuplicateHandle을 CRT로 넘겨 context의 handle.Close와 소유권을 분리한다.
        api, con, _, _, _ = _win()
        copied = api.DuplicateHandle(api.GetCurrentProcess(), handle, api.GetCurrentProcess(),
                                     0, False, con.DUPLICATE_SAME_ACCESS)
        native = copied.Detach()
        try:
            return msvcrt.open_osfhandle(native, os.O_WRONLY | os.O_BINARY)
        except BaseException:
            api.CloseHandle(native)
            raise


def write_new(path, raw):
    with os.fdopen(open_new(path), "wb") as stream:
        stream.write(raw)


def read_private(value, maximum, *, single_link=True):
    path = _path(value)
    if is_windows():
        _, _, files, _, _ = _win()
        with _win_parents(path), _win_handle(path) as handle:
            before = files.GetFileInformationByHandle(handle)
            size = (before[5] << 32) + before[6]
            if size > maximum:
                raise ClientPlatformError("file_limit")
            raw = files.ReadFile(handle, size)[1] if size else b""
            after = files.GetFileInformationByHandle(handle)
            # 읽기 자체의 last-access-time 갱신은 내용 변경이 아니다.
            if before[:2] + before[3:] != after[:2] + after[3:]:
                raise ClientPlatformError("file_changed")
            return raw
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid()
                or single_link and info.st_nlink != 1):
            raise ClientPlatformError("private_file_required")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        if (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ClientPlatformError("file_changed")
        if len(raw) > maximum:
            raise ClientPlatformError("file_limit")
        return raw
