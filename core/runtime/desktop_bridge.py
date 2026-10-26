"""Electron 전용 비밀 파일/프로세스 경계. stdout에는 계약 JSON/자식 출력만 쓴다.

prepare는 새 실행 폴더만 만들고, launch는 자신의 실행 트리만 종료한다.
capabilities는 읽기 전용이며 실제 Windows 배포 인증을 뜻하지 않는다.
"""

import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import uuid

from .client_platform import ClientPlatformError, private_directory, read_private, write_new, is_windows
from .client_process import WindowsJob, process_arguments, spawn_options, stop_windows, start_owned_process

MODULES = frozenset({"tools.analysis_cli", "tools.question_cli", "tools.source_conversion_cli", "tools.proposal_cli"})
CANCEL = b'{"type":"cancel"}\n'


def capabilities():
    available = not is_windows() or all(importlib.util.find_spec(name) is not None
                                        for name in ("win32api", "win32file", "win32security", "win32job"))
    return {"platform": sys.platform, "private_files": available, "process_tree": available,
            "mechanism": "windows_job_and_dacl" if is_windows() else "posix_mode_and_process_group",
            "native_validation": "not_certified", "windows_app_verified": False,
            "runtime_ready": False, "probe": "not_run"}


async def _probe_process_tree():
    """실제 Job의 자식·손자 핸들이 종료되는지 확인하며 외부 CLI를 실행하지 않는다."""
    import win32api, win32con, win32event
    script = (
        "import json,os,subprocess,sys,time; "
        "child=subprocess.Popen([sys.executable,'-B','-c','import time; time.sleep(60)']); "
        "print(json.dumps([os.getpid(),child.pid]),flush=True); time.sleep(60)"
    )
    process = await start_owned_process(
        [sys.executable, "-B", "-c", script], stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=256)
    job = getattr(process, "_wiki_job", None)
    handles = []
    try:
        if job is None:
            raise OSError("process_probe_failed")
        process.stdin.write(b"\0")
        await process.stdin.drain()
        line = await asyncio.wait_for(process.stdout.readline(), 3)
        pids = json.loads(line)
        if (not isinstance(pids, list) or len(pids) != 2 or
                any(type(pid) is not int or pid <= 1 for pid in pids) or
                len(set([process.pid, *pids])) != 3):
            raise OSError("process_probe_failed")
        for pid in pids:
            handles.append(win32api.OpenProcess(win32con.SYNCHRONIZE, False, pid))
        job.close()
        await asyncio.wait_for(process.wait(), 2)
        for handle in handles:
            if win32event.WaitForSingleObject(handle, 1000) != win32event.WAIT_OBJECT_0:
                raise OSError("process_probe_failed")
    finally:
        try:
            if job is not None:
                job.close()
            if process.returncode is None:
                process.kill()
                await asyncio.wait_for(process.wait(), 2)
        finally:
            for handle in handles:
                handle.Close()


def probe():
    """현재 Windows의 보호 기능만 실제 점검한다. 앱 배포 인증과 구분한다."""
    if not is_windows():
        return {"ok": True, "capabilities": capabilities()}
    root = Path(tempfile.gettempdir()).resolve() / f"llm-wiki-runtime-probe-{uuid.uuid4()}"
    private_directory(root, exist_ok=False)
    token_file, linked = root / "probe", root / "linked"
    try:
        raw = b"non-secret-runtime-probe"
        write_new(token_file, raw)
        if read_private(token_file, 256) != raw:
            raise OSError("private_file_check_failed")
        try:
            write_new(token_file, b"must-not-replace")
        except FileExistsError:
            pass
        else:
            raise OSError("private_file_check_failed")
        # 같은 볼륨의 별칭을 통한 비밀 파일 접근도 실제 파일 정보로 거부해야 한다.
        os.link(token_file, linked)
        try:
            read_private(token_file, 256)
        except ClientPlatformError:
            pass
        else:
            raise OSError("private_file_check_failed")
        linked.unlink()
        if read_private(token_file, 256) != raw:
            raise OSError("private_file_check_failed")
        asyncio.run(_probe_process_tree())
    finally:
        # 이번 probe의 두 파일/빈 디렉터리만 지운다. 정리 실패도 준비 성공으로 숨기지 않는다.
        cleanup_error = None
        for path in (linked, token_file):
            try:
                path.unlink(missing_ok=True)
            except OSError as error:
                cleanup_error = cleanup_error or error
        try:
            root.rmdir()
        except OSError as error:
            cleanup_error = cleanup_error or error
        if cleanup_error is not None:
            raise OSError("runtime_probe_cleanup_failed") from cleanup_error
    return {"ok": True, "capabilities": {**capabilities(), "runtime_ready": True,
            "probe": "private_file_and_process_tree"}}


def _probe_job():
    """새 bootstrap을 실제 Job에 넣을 수 없으면 token/CLI를 생성하지 않는다."""
    if not is_windows():
        return
    job = WindowsJob()
    child = None
    try:
        child = subprocess.Popen(process_arguments([sys.executable, "-B", "-c", "pass"]),
                                 stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 **spawn_options())
        job.assign(child.pid)
        child.communicate(b"\0", timeout=5)
        if child.returncode != 0:
            raise OSError("process_probe_failed")
    finally:
        job.close()
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def prepare(root, name, token):
    if re.fullmatch(r"exec-[A-Za-z0-9-]{8,100}", name) is None:
        raise ValueError("invalid_execution_name")
    # 토큰은 argv/environment에 들어가지 않으며 파일 생성 전에 한도를 검증한다.
    if re.fullmatch(rb"[A-Za-z0-9_-]{32,256}\n?", token) is None:
        raise ValueError("invalid_token_input")
    token = token.rstrip(b"\n")
    _probe_job()
    root = private_directory(root)
    directory = private_directory(root / name, exist_ok=False)
    try:
        auth = private_directory(directory / "auth", exist_ok=False)
        work = private_directory(directory / "work", exist_ok=False)
        token_file = auth / "token"
        write_new(token_file, token)
        if read_private(token_file, 256) != token:
            raise OSError("private_file_check_failed")
    except BaseException:
        # 이름을 추정한 재귀 삭제는 하지 않는다. 이번에 생성한 파일/빈 폴더만 회수한다.
        for item in (directory / "auth/token", directory / "auth", directory / "work", directory):
            try:
                item.rmdir() if item.is_dir() else item.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    return {"ok": True, "directory": str(directory), "token_file": str(token_file),
            "work_directory": str(work), "capabilities": {**capabilities(),
                "probe": "job_assignment_and_private_file" if is_windows() else "private_file"}}


def _parent_watch(parent_pid):
    if parent_pid <= 1:
        raise ValueError("invalid_parent_pid")
    if is_windows():
        import win32api, win32con, win32event
        handle = win32api.OpenProcess(win32con.SYNCHRONIZE, False, parent_pid)
        return (lambda: win32event.WaitForSingleObject(handle, 0) == win32event.WAIT_TIMEOUT), handle.Close
    if os.getppid() != parent_pid:
        raise ValueError("parent_changed")
    return (lambda: os.getppid() == parent_pid), lambda: None


async def _reap(process):
    if is_windows():
        await stop_windows(process)
        return
    # 정상 종료 뒤에도 같은 실행 그룹의 도구 자식이 남지 않게 회수한다.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(process.wait(), 2)
    except TimeoutError:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await process.wait()


def _read_stdin():
    return os.read(sys.stdin.fileno(), 65536)


async def launch(parent_pid, arguments, *, grace_seconds=10):
    if arguments[:1] == ["--"]:
        arguments = arguments[1:]
    if len(arguments) < 3 or arguments[:2] != ["-B", "-m"] or arguments[2] not in MODULES:
        raise ValueError("unsupported_personal_command")
    alive, close_parent = _parent_watch(parent_pid)
    process = None
    job = None
    tasks = []
    loop = asyncio.get_running_loop()
    stopping = asyncio.Event()
    old_signals = {}
    try:
        def requested(signum, frame):
            loop.call_soon_threadsafe(stopping.set)
        for number in (signal.SIGINT, signal.SIGTERM):
            old_signals[number] = signal.signal(number, requested)
        process = await start_owned_process([sys.executable, *arguments], stdin=asyncio.subprocess.PIPE)
        job = getattr(process, "_wiki_job", None)
        if job is not None:
            process.stdin.write(b"\0")
            await process.stdin.drain()
        # A daemon reader avoids waiting on an open Electron pipe after child completion.
        # A bounded queue gives backpressure instead of accumulating unbounded input.
        queue = asyncio.Queue(maxsize=4)
        def reader():
            try:
                while True:
                    block = _read_stdin()
                    asyncio.run_coroutine_threadsafe(queue.put(block), loop).result()
                    if not block:
                        return
            except Exception:
                if not loop.is_closed():
                    loop.call_soon_threadsafe(stopping.set)
        threading.Thread(target=reader, daemon=True).start()

        async def forward():
            try:
                while block := await queue.get():
                    process.stdin.write(block)
                    await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                stopping.set()

        async def watch():
            while alive():
                await asyncio.sleep(0.2)
            stopping.set()

        tasks = [asyncio.create_task(forward()), asyncio.create_task(watch()),
                 asyncio.create_task(process.wait()), asyncio.create_task(stopping.wait())]
        await asyncio.wait(tasks[2:], return_when=asyncio.FIRST_COMPLETED)
        if process.returncode is None:
            try:
                process.stdin.write(CANCEL)
                await process.stdin.drain()
                process.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass
            try:
                await asyncio.wait_for(asyncio.shield(tasks[2]), grace_seconds)
            except TimeoutError:
                pass
        await _reap(process)
        return process.returncode
    finally:
        for number, handler in old_signals.items():
            signal.signal(number, handler)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if process is not None and process.returncode is None:
            await _reap(process)
        if job is not None:
            job.close()
        close_parent()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("capabilities")
    sub.add_parser("probe", help="현재 PC의 보호 기능을 비밀 없는 임시 파일/프로세스로 확인")
    prep = sub.add_parser("prepare")
    prep.add_argument("--root", type=Path, required=True)
    prep.add_argument("--name", required=True)
    run = sub.add_parser("launch")
    run.add_argument("--parent-pid", type=int, required=True)
    run.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.operation == "launch":
            return asyncio.run(launch(args.parent_pid, args.arguments))
        if args.operation == "probe":
            result = probe()
        else:
            result = {"ok": True, "capabilities": capabilities()} if args.operation == "capabilities" else prepare(
                args.root, args.name, sys.stdin.buffer.read(258))
    except Exception:
        # Native exceptions may contain paths/input; do not leak raw errors to app logs.
        result = {"ok": False, "error": {"code": "desktop_runtime_boundary_failed"}}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
