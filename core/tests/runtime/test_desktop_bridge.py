"""실제 POSIX 실행/파이프 검증. Windows 안전성 인증으로 사용하지 않는다."""
import asyncio
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from core.runtime import desktop_bridge as bridge, client_process
from core.runtime.client_platform import read_private


class PreparationTests(unittest.TestCase):
    def test_private_files_no_replace_and_no_token_in_result(self):
        with tempfile.TemporaryDirectory(prefix="wiki-bridge-") as temporary:
            root = Path(temporary).resolve()
            token = b"a" * 40
            result = bridge.prepare(root, "exec-12345678", token + b"\n")
            self.assertEqual(read_private(result["token_file"], 256), token)
            self.assertNotIn(token.decode(), json.dumps(result))
            self.assertTrue(Path(result["work_directory"]).is_dir())
            with self.assertRaises(FileExistsError):
                bridge.prepare(root, "exec-12345678", b"b" * 40)
            self.assertEqual(read_private(result["token_file"], 256), token)

    def test_validation_and_symlink_do_not_mutate_target(self):
        with tempfile.TemporaryDirectory(prefix="wiki-bridge-") as temporary:
            root = Path(temporary).resolve()
            for name, token in [("../bad", b"a"*40), ("exec-12345678", b"a"*257),
                                ("exec-12345678", b"a"*32+b"\ntrailing")]:
                with self.assertRaises(ValueError): bridge.prepare(root, name, token)
            linked = root/"exec-12345678"
            linked.symlink_to(root, target_is_directory=True)
            with self.assertRaises(OSError): bridge.prepare(root, linked.name, b"a"*40)
            self.assertEqual(list(root.iterdir()), [linked])

    def test_probe_failure_happens_before_token_files(self):
        with tempfile.TemporaryDirectory(prefix="wiki-bridge-") as temporary:
            root = Path(temporary).resolve()
            with patch.object(bridge, "_probe_job", side_effect=OSError("fixture")):
                with self.assertRaises(OSError): bridge.prepare(root, "exec-12345678", b"a"*40)
            self.assertEqual(list(root.iterdir()), [])

    def test_bootstrap_forwards_cancel_before_eof(self):
        with tempfile.TemporaryDirectory(prefix="wiki-bootstrap-live-") as temporary:
            marker = Path(temporary)/"received"
            process = subprocess.Popen([sys.executable, "-B", str(Path(bridge.__file__).with_name("windows_cli_bootstrap.py")),
                "--", sys.executable, "-c", "import sys,pathlib; pathlib.Path(sys.argv[1]).write_text(sys.stdin.readline())", str(marker)], stdin=subprocess.PIPE)
            try:
                process.stdin.write(b"\0cancel\n");process.stdin.flush()
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertEqual(marker.read_text(), "cancel\n")
                process.wait(timeout=5)
                self.assertEqual(process.returncode, 0)
            finally:
                process.stdin.close()
                if process.poll() is None: process.kill()
                process.wait(timeout=5)


class RuntimeProbeTests(unittest.TestCase):
    def test_non_windows_does_not_claim_windows_readiness(self):
        with patch.object(bridge, "is_windows", return_value=False), patch.object(
                bridge, "_probe_process_tree", new_callable=AsyncMock) as process_probe:
            result = bridge.probe()
        self.assertFalse(result["capabilities"]["runtime_ready"])
        self.assertEqual(result["capabilities"]["native_validation"], "not_certified")
        self.assertEqual(result["capabilities"]["probe"], "not_run")
        process_probe.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "POSIX fixture; not Windows validation")
    def test_simulated_probe_is_bounded_to_own_files_and_preserves_release_status(self):
        with tempfile.TemporaryDirectory(prefix="wiki-probe-fixture-") as temporary:
            root = Path(temporary).resolve()
            neighbor = root / "existing"
            neighbor.write_text("preserve")
            with patch.object(bridge, "is_windows", return_value=True), patch.object(
                    bridge.tempfile, "gettempdir", return_value=str(root)), patch.object(
                    bridge, "_probe_process_tree", new_callable=AsyncMock) as process_probe:
                result = bridge.probe()
            process_probe.assert_awaited_once()
            self.assertTrue(result["capabilities"]["runtime_ready"])
            self.assertFalse(result["capabilities"]["windows_app_verified"])
            self.assertEqual(result["capabilities"]["native_validation"], "not_certified")
            self.assertEqual(result["capabilities"]["probe"], "private_file_and_process_tree")
            self.assertEqual(list(root.iterdir()), [neighbor])
            self.assertEqual(neighbor.read_text(), "preserve")

    @unittest.skipUnless(os.name == "posix", "POSIX fixture; not Windows validation")
    def test_process_probe_failure_cleans_own_files_and_remains_failure(self):
        with tempfile.TemporaryDirectory(prefix="wiki-probe-failed-") as temporary:
            root = Path(temporary).resolve()
            with patch.object(bridge, "is_windows", return_value=True), patch.object(
                    bridge.tempfile, "gettempdir", return_value=str(root)), patch.object(
                    bridge, "_probe_process_tree", new=AsyncMock(side_effect=TimeoutError)):
                with self.assertRaises(TimeoutError):
                    bridge.probe()
            self.assertEqual(list(root.iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "POSIX fixture; not Windows validation")
    def test_cleanup_failure_is_not_runtime_ready(self):
        with tempfile.TemporaryDirectory(prefix="wiki-probe-cleanup-") as temporary:
            with patch.object(bridge, "is_windows", return_value=True), patch.object(
                    bridge.tempfile, "gettempdir", return_value=temporary), patch.object(
                    bridge, "_probe_process_tree", new_callable=AsyncMock), patch.object(
                    Path, "rmdir", side_effect=PermissionError("fixture")):
                with self.assertRaisesRegex(OSError, "runtime_probe_cleanup_failed"):
                    bridge.probe()

    @unittest.skipUnless(os.name == "nt", "requires actual Windows DACL and Job Objects")
    def test_actual_windows_probe_validates_runtime_not_electron_release(self):
        result = bridge.probe()
        self.assertTrue(result["capabilities"]["runtime_ready"])
        self.assertEqual(result["capabilities"]["platform"], "win32")
        self.assertEqual(result["capabilities"]["native_validation"], "not_certified")
        self.assertFalse(result["capabilities"]["windows_app_verified"])


@unittest.skipUnless(os.name == "posix", "actual POSIX process boundary")
class LaunchTests(unittest.IsolatedAsyncioTestCase):
    async def test_eof_forwards_cancel_and_normal_exit(self):
        with tempfile.TemporaryDirectory(prefix="wiki-launch-") as temporary:
            marker = Path(temporary)/"received"
            script = "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.stdin.readline())"
            with patch.object(bridge, "_read_stdin", return_value=b""), patch.object(client_process, "process_arguments", return_value=[sys.executable,"-c",script,str(marker)]):
                code = await bridge.launch(os.getppid(), ["-B","-m","tools.question_cli"], grace_seconds=2)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(marker.read_text()), {"type":"cancel"})

    async def test_uncooperative_child_and_descendant_are_reaped(self):
        with tempfile.TemporaryDirectory(prefix="wiki-launch-tree-") as temporary:
            marker = Path(temporary)/"child"
            script = "import subprocess,sys,pathlib,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)"
            with patch.object(bridge, "_read_stdin", return_value=b""), patch.object(client_process, "process_arguments", return_value=[sys.executable,"-c",script,str(marker)]):
                started = time.monotonic()
                code = await bridge.launch(os.getppid(), ["-B","-m","tools.question_cli"], grace_seconds=.5)
            self.assertLess(time.monotonic()-started, 5)
            self.assertNotEqual(code, 0)
            pid = int(marker.read_text())
            for _ in range(50):
                try: os.kill(pid, 0)
                except ProcessLookupError: break
                await asyncio.sleep(.02)
            else: self.fail("descendant survived owned process-group cleanup")

    async def test_cancel_during_spawn_waits_for_handle_and_reaps_child(self):
        from core.runtime import client_process
        from core.client.ai.codex import _execute
        real_create = asyncio.create_subprocess_exec
        spawned, release = asyncio.Event(), asyncio.Event()
        children = []
        async def delayed(*args, **kwargs):
            child = await real_create(*args, **kwargs)
            children.append(child)
            spawned.set()
            await release.wait()
            return child
        with patch.object(client_process.asyncio, "create_subprocess_exec", side_effect=delayed):
            task = asyncio.create_task(_execute([sys.executable, "-c", "import time; time.sleep(60)"],
                directory=None, environment=dict(os.environ)))
            await asyncio.wait_for(spawned.wait(), 5)
            task.cancel()
            await asyncio.sleep(.02)
            self.assertFalse(task.done())
            task.cancel()  # repeated cancellation must not abandon cleanup
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 5)
        self.assertIsNotNone(children[0].returncode)
        with self.assertRaises(ProcessLookupError): os.kill(children[0].pid, 0)

    async def test_bad_command_and_wrong_parent_rejected_before_spawn(self):
        with patch.object(bridge.asyncio, "create_subprocess_exec", side_effect=AssertionError("must not spawn")):
            with self.assertRaises(ValueError): await bridge.launch(os.getppid(), ["-c","print('bad')"])
            with self.assertRaises(ValueError): await bridge.launch(1, ["-B","-m","tools.question_cli"])


if __name__ == "__main__": unittest.main()
