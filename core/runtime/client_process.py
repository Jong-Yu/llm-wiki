"""개인 실행기 전용 OS 프로세스 경계. 전역 CLI나 다른 실행은 종료하지 않는다."""

import asyncio
import os
from pathlib import Path
import shutil
import signal
import sys

from .client_platform import is_windows, ClientPlatformError


def cli_command(cli):
    executable = shutil.which(cli)
    if executable is None:
        raise ClientPlatformError("ai_cli_unavailable")
    path = Path(executable)
    if not is_windows() or path.suffix.lower() == ".exe":
        return [str(path)]
    # npm의 cmd/PowerShell shim은 셸로 실행하지 않는다. 알려진 npm 진입점을 Node로 직접 실행한다.
    npm_entries = {
        "codex": "@openai/codex/bin/codex.js",
        "claude": "@anthropic-ai/claude-code/cli.js",
    }
    name = path.stem.lower() if path.suffix.lower() in {".cmd", ".ps1"} else path.name.lower()
    if name in npm_entries:
        script = path.parent / "node_modules" / npm_entries[name]
        node = shutil.which("node.exe")
        if node and script.is_file():
            return [node, str(script)]
    raise ClientPlatformError("ai_cli_native_executable_required")


def spawn_options():
    if is_windows():
        import subprocess
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


class WindowsJob:
    """CLI 자신의 job을 닫으면 그 안에서 생성한 자식도 회수한다."""
    def __init__(self):
        import win32job
        self.job = win32job.CreateJobObject(None, None)
        try:
            info = win32job.QueryInformationJobObject(self.job, win32job.JobObjectExtendedLimitInformation)
            info["BasicLimitInformation"]["LimitFlags"] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            win32job.SetInformationJobObject(self.job, win32job.JobObjectExtendedLimitInformation, info)
        except BaseException:
            self.close()
            raise

    def assign(self, pid):
        import win32api, win32con, win32job
        with win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE, False, pid) as handle:
            win32job.AssignProcessToJobObject(self.job, handle)

    def close(self):
        if self.job is not None:
            self.job.Close()
            self.job = None


async def stop_windows(process):
    job = getattr(process, "_wiki_job", None)
    if job is not None:
        job.close()
    elif process.returncode is None:
        # job 연결 실패 시에도 아직 input을 전달하지 않은 자신의 프로세스를 회수한다.
        process.kill()
    await process.wait()


def process_arguments(arguments):
    if is_windows():
        # bootstrap은 부모가 Job Object에 넣고 첫 바이트를 보내기 전에는 자식을 만들지 않는다.
        return [sys.executable, "-B", str(Path(__file__).with_name("windows_cli_bootstrap.py").resolve()), "--", *arguments]
    return arguments


async def start_owned_process(arguments, **options):
    """생성 도중 취소되어도 실제 handle을 회수한 뒤 자기 자식만 종료한다.

    Windows는 gate를 전송하지 않은 상태로 Job에 할당해 반환한다. 호출자가
    이후 첫 NUL을 보내고 정상/오류 종료 때 _wiki_job을 닫는다.
    """
    job = WindowsJob() if is_windows() else None
    try:
        creation = asyncio.create_task(asyncio.create_subprocess_exec(
            *process_arguments(arguments), **options, **spawn_options()))
    except BaseException:
        if job is not None:
            job.close()
        raise
    process = None

    async def reclaim():
        try:
            child = await creation
        except BaseException:
            return
        if is_windows():
            if child.returncode is None:
                child.kill()  # bootstrap has not received its launch gate yet
        else:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        async def discard(stream):
            if stream is not None:
                while await stream.read(65536):
                    pass
        await asyncio.gather(child.wait(), discard(child.stdout), discard(child.stderr))

    try:
        process = await asyncio.shield(creation)
        if job is not None:
            try:
                job.assign(process.pid)
                process._wiki_job = job
            except BaseException:
                raise ClientPlatformError("ai_process_job_failed") from None
        return process
    except BaseException:
        cleanup = asyncio.create_task(reclaim())
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                continue
        try:
            cleanup.result()
        finally:
            if job is not None:
                job.close()
        raise
