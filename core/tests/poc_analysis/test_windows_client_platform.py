"""Windows 상수의 소유 모듈과 기존 파일 보호 계약을 검사한다."""

import os
from pathlib import Path, PureWindowsPath
import sys
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from core.runtime import client_platform as platform


class WindowsApiError(OSError):
    """pywintypes.error와 앱 경계의 OSError 하위 오류를 구별한다."""


class Handle:
    """시험이 만든 핸들의 종료만 관측한다."""

    def __init__(self):
        self.closed = False

    def Close(self):
        self.closed = True


class WindowsConstantsTests(unittest.TestCase):
    """win32con에 없는 파일 상수는 win32file만 제공하는 경계를 재현한다."""

    def setUp(self):
        self.con = SimpleNamespace(
            OBJECT_INHERIT_ACE=1, CONTAINER_INHERIT_ACE=2,
            FILE_FLAG_BACKUP_SEMANTICS=0x02000000,
            GENERIC_READ=0x80000000, GENERIC_WRITE=0x40000000,
            READ_CONTROL=0x20000, FILE_SHARE_READ=1, FILE_SHARE_WRITE=2,
            CREATE_NEW=1, OPEN_EXISTING=3,
            FILE_ATTRIBUTE_REPARSE_POINT=0x400, FILE_ATTRIBUTE_DIRECTORY=0x10,
        )
        self.calls = []
        self.handles = []
        self.attributes = 0
        self.links = 1

        def create_file(*args):
            self.calls.append(args)
            handle = Handle()
            self.handles.append(handle)
            return handle

        self.files = SimpleNamespace(
            FILE_ALL_ACCESS=0x1F01FF,
            FILE_FLAG_OPEN_REPARSE_POINT=0x00200000,
            CreateFile=create_file,
            GetFileInformationByHandle=lambda _: (
                self.attributes, None, None, None, 0, 0, 0, self.links, 0, 0
            ),
        )
        self.sid = object()
        self.aces = []
        self.controls = []
        self.owners = []
        self.dacls = []
        acl = SimpleNamespace(AddAccessAllowedAceEx=lambda *args: self.aces.append(args))
        descriptor = SimpleNamespace(
            SetSecurityDescriptorOwner=lambda *args: self.owners.append(args),
            SetSecurityDescriptorDacl=lambda *args: self.dacls.append(args),
            SetSecurityDescriptorControl=lambda *args: self.controls.append(args),
        )
        self.security = SimpleNamespace(
            ACL=lambda: acl, SECURITY_DESCRIPTOR=lambda: descriptor,
            ACL_REVISION=2, SE_DACL_PROTECTED=0x1000,
        )
        self.types = SimpleNamespace(SECURITY_ATTRIBUTES=SimpleNamespace, error=WindowsApiError)
        self.modules = (None, self.con, self.files, self.security, self.types)

    def test_private_attributes_keep_owner_full_access_and_protected_inheritance(self):
        with patch.object(platform, '_win', return_value=self.modules), \
                patch.object(platform, '_sid', return_value=self.sid):
            attributes = platform._attributes()
        self.assertEqual(self.owners, [(self.sid, False)])
        self.assertEqual(self.aces, [(2, 3, self.files.FILE_ALL_ACCESS, self.sid)])
        self.assertEqual(self.controls, [(0x1000, 0x1000)])
        self.assertEqual(len(self.dacls), 1)
        self.assertIsNotNone(attributes.SECURITY_DESCRIPTOR)
        self.assertFalse(hasattr(self.con, 'FILE_ALL_ACCESS'))

    def test_file_opens_reparse_point_itself_and_checks_acl(self):
        with patch.object(platform, '_win', return_value=self.modules), \
                patch.object(platform, '_check_acl') as check:
            with platform._win_handle(PureWindowsPath('C:/user/input.txt')) as handle:
                self.assertFalse(handle.closed)
        self.assertEqual(self.calls[0][-2], self.files.FILE_FLAG_OPEN_REPARSE_POINT)
        self.assertEqual(self.calls[0][4], self.con.OPEN_EXISTING)
        check.assert_called_once_with(self.handles[0])
        self.assertTrue(self.handles[0].closed)
        self.assertFalse(hasattr(self.con, 'FILE_FLAG_OPEN_REPARSE_POINT'))

    def test_parent_handles_keep_directory_and_reparse_flags_without_delete_sharing(self):
        self.attributes = self.con.FILE_ATTRIBUTE_DIRECTORY
        path = PureWindowsPath('C:/Users/example/work/invocation')
        with patch.object(platform, '_win', return_value=self.modules), \
                patch.object(platform, '_check_acl') as check:
            with platform._win_parents(path):
                self.assertEqual(len(self.handles), len(path.parents))
                self.assertTrue(all(not handle.closed for handle in self.handles))
        check.assert_not_called()
        for call in self.calls:
            self.assertEqual(call[-2], self.files.FILE_FLAG_OPEN_REPARSE_POINT |
                             self.con.FILE_FLAG_BACKUP_SEMANTICS)
            self.assertEqual(call[2], self.con.FILE_SHARE_READ | self.con.FILE_SHARE_WRITE)
        self.assertTrue(all(handle.closed for handle in self.handles))

    def test_reparse_and_hardlink_files_are_still_rejected(self):
        for attributes, links in [(self.con.FILE_ATTRIBUTE_REPARSE_POINT, 1), (0, 2)]:
            self.attributes, self.links = attributes, links
            with self.subTest(attributes=attributes, links=links), \
                    patch.object(platform, '_win', return_value=self.modules):
                with self.assertRaisesRegex(platform.ClientPlatformError, 'unsafe_file_path'):
                    with platform._win_handle('input.txt'):
                        self.fail('unsafe input must not be opened')
                self.assertTrue(self.handles[-1].closed)

    def test_acl_rejection_still_closes_handle_and_preserves_error(self):
        with patch.object(platform, '_win', return_value=self.modules), \
                patch.object(platform, '_check_acl', side_effect=platform.ClientPlatformError('private_file_required')):
            with self.assertRaisesRegex(platform.ClientPlatformError, 'private_file_required'):
                with platform._win_handle('input.txt'):
                    self.fail('unprotected input must not be accepted')
        self.assertTrue(self.handles[-1].closed)

    def test_new_file_handle_can_read_its_own_attributes(self):
        with patch.object(platform, '_win', return_value=self.modules), \
                patch.object(platform, '_attributes', return_value=object()), \
                patch.object(platform, '_check_acl'):
            with platform._win_handle(PureWindowsPath('C:/user/prompt.txt'), create=True):
                pass
        access = self.calls[0][1]
        self.assertEqual(access & 0x80, 0x80)
        self.assertEqual(access & (self.con.GENERIC_WRITE | self.con.READ_CONTROL),
                         self.con.GENERIC_WRITE | self.con.READ_CONTROL)
        self.assertEqual(access & self.con.GENERIC_READ, 0)
        self.assertEqual(self.calls[0][4], self.con.CREATE_NEW)


class WindowsHandleLifetimeTests(unittest.TestCase):
    """pywin32 PyHANDLE은 with 문을 지원하지 않으므로 Close만 있는 대역으로 수명을 검사한다."""

    def test_handle_double_matches_pywin32_without_context_manager(self):
        self.assertFalse(hasattr(Handle, '__enter__'))

    def _sid_modules(self, token_information):
        token = Handle()
        api = SimpleNamespace(GetCurrentProcess=lambda: 'current-process')
        con = SimpleNamespace(TOKEN_QUERY=8)
        security = SimpleNamespace(
            TokenUser=1, OpenProcessToken=lambda process, access: token,
            GetTokenInformation=token_information,
        )
        return token, (api, con, None, security, None)

    def test_sid_reads_user_and_closes_token(self):
        sid = object()
        token, modules = self._sid_modules(lambda handle, kind: (sid, 0))
        with patch.object(platform, '_win', return_value=modules):
            self.assertIs(platform._sid(), sid)
        self.assertTrue(token.closed)

    def test_sid_failure_still_closes_token(self):
        def fail(handle, kind):
            raise WindowsApiError('token')
        token, modules = self._sid_modules(fail)
        with patch.object(platform, '_win', return_value=modules):
            with self.assertRaises(WindowsApiError):
                platform._sid()
        self.assertTrue(token.closed)

    def _job_modules(self, assign):
        process = Handle()
        api = SimpleNamespace(OpenProcess=lambda access, inherit, pid: process)
        con = SimpleNamespace(PROCESS_SET_QUOTA=0x100, PROCESS_TERMINATE=1)
        job = SimpleNamespace(AssignProcessToJobObject=assign)
        return process, {'win32api': api, 'win32con': con, 'win32job': job}

    def test_job_assignment_closes_process_handle(self):
        from core.runtime.client_process import WindowsJob
        assigned = []
        process, modules = self._job_modules(lambda job, handle: assigned.append((job, handle)))
        windows_job = object.__new__(WindowsJob)
        windows_job.job = 'job'
        with patch.dict(sys.modules, modules):
            windows_job.assign(1234)
        self.assertEqual(assigned, [('job', process)])
        self.assertTrue(process.closed)

    def test_job_assignment_failure_still_closes_process_handle(self):
        from core.runtime.client_process import WindowsJob
        def fail(job, handle):
            raise WindowsApiError('assign')
        process, modules = self._job_modules(fail)
        windows_job = object.__new__(WindowsJob)
        windows_job.job = 'job'
        with patch.dict(sys.modules, modules):
            with self.assertRaises(WindowsApiError):
                windows_job.assign(1234)
        self.assertTrue(process.closed)


class WindowsJobCreationTests(unittest.TestCase):
    """pywin32 311의 필수 문자열 인자와 Job 생성 중 핸들 보존을 검사한다."""

    def _job_module(self, *, failure=None):
        handle, names, configured = Handle(), [], []
        info = {"BasicLimitInformation": {"LimitFlags": 0x10}}

        def create(attributes, name):
            # b311의 WCHAR * 변환은 None을 허용하지 않는다. MagicMock은 이 오류를 놓친다.
            if not isinstance(name, str):
                raise TypeError('name must be a string')
            names.append(name)
            return handle

        def query(job, kind):
            if failure == 'query':
                raise WindowsApiError('query')
            return info

        def configure(job, kind, value):
            if failure == 'configure':
                raise WindowsApiError('configure')
            configured.append((job, kind, value))

        module = SimpleNamespace(
            CreateJobObject=create, QueryInformationJobObject=query,
            SetInformationJobObject=configure, JobObjectExtendedLimitInformation=9,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000,
        )
        return module, handle, names, configured

    def test_unnamed_job_accepts_pywin32_string_contract_and_keeps_kill_on_close(self):
        from core.runtime.client_process import WindowsJob
        module, handle, names, configured = self._job_module()
        with patch.dict(sys.modules, {'win32job': module}):
            job = WindowsJob()
        try:
            self.assertEqual(names, [''])
            self.assertEqual(configured, [(handle, 9, {'BasicLimitInformation': {'LimitFlags': 0x2010}})])
            self.assertFalse(handle.closed)
        finally:
            job.close()
        self.assertTrue(handle.closed)
        self.assertIsNone(job.job)
        job.close()

    def test_partial_job_creation_closes_handle_on_query_or_configuration_failure(self):
        from core.runtime.client_process import WindowsJob
        for phase in ('query', 'configure'):
            with self.subTest(phase=phase):
                module, handle, _, _ = self._job_module(failure=phase)
                with patch.dict(sys.modules, {'win32job': module}):
                    with self.assertRaises(WindowsApiError):
                        WindowsJob()
                self.assertTrue(handle.closed)


@unittest.skipUnless(os.name == 'nt', 'requires native Windows and pywin32')
class NativeWindowsJobTests(unittest.TestCase):
    """Windows에서는 실제 확장 모듈로 익명 Job 생성과 종료 제한을 확인한다."""

    def test_create_separate_unnamed_jobs_with_kill_on_close(self):
        import win32job
        from core.runtime.client_process import WindowsJob
        job = WindowsJob()
        try:
            info = win32job.QueryInformationJobObject(job.job, win32job.JobObjectExtendedLimitInformation)
            self.assertTrue(info['BasicLimitInformation']['LimitFlags'] & win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
            other = WindowsJob()
            try:
                other_info = win32job.QueryInformationJobObject(other.job, win32job.JobObjectExtendedLimitInformation)
                other_info['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                other_info['BasicLimitInformation']['ActiveProcessLimit'] = 1
                win32job.SetInformationJobObject(other.job, win32job.JobObjectExtendedLimitInformation, other_info)
                unchanged = win32job.QueryInformationJobObject(job.job, win32job.JobObjectExtendedLimitInformation)
                self.assertFalse(unchanged['BasicLimitInformation']['LimitFlags'] & win32job.JOB_OBJECT_LIMIT_ACTIVE_PROCESS)
            finally:
                other.close()
        finally:
            job.close()


@unittest.skipUnless(os.name == 'nt', 'requires native Windows and pywin32')
class NativeWindowsFileTests(unittest.TestCase):
    """실제 Windows에서는 같은 생성·읽기·기존 파일 보존을 직접 검사한다."""

    def test_private_directory_write_read_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            directory = platform.private_directory(Path(root) / 'private', exist_ok=False)
            path = directory / 'input.txt'
            content = '연결 확인'.encode('utf-8')
            platform.write_new(path, content)
            self.assertEqual(platform.read_private(path, 1024), content)
            with self.assertRaises(FileExistsError):
                platform.write_new(path, b'replacement')
            self.assertEqual(path.read_bytes(), content)

    def test_hardlink_rejection_preserves_both_files(self):
        with tempfile.TemporaryDirectory() as root:
            directory = platform.private_directory(Path(root) / 'private', exist_ok=False)
            original, linked = directory / 'original', directory / 'linked'
            platform.write_new(original, b'preserved')
            os.link(original, linked)
            with self.assertRaisesRegex(platform.ClientPlatformError, 'unsafe_file_path'):
                platform.read_private(linked, 1024)
            self.assertEqual(original.read_bytes(), b'preserved')
            self.assertEqual(linked.read_bytes(), b'preserved')


if __name__ == '__main__':
    unittest.main()
