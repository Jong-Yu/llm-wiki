"""Mac 런처가 같은 포트의 이 프로젝트 이전 런처만 내리고 다른 프로세스는 보존하는지 가짜 실행기로 검사한다."""
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest

SOURCE = Path(__file__).resolve().parents[3] / "tools/start-mac.command"
LISTEN = ("import socket, sys, time\n"
          "s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
          "s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(); time.sleep(120)\n")
# 이름에 start-mac.command가 들어간 가짜 이전 런처: 첫 인자 폴더에서 듣는 자식을 띄우고 TERM에 자식과 함께 끝난다.
OLD_LAUNCHER = ('#!/bin/bash\ncd "$1"\n"$2" -c "$4" "$3" &\nchild=$!\n'
                'trap \'kill -TERM "$child"; wait "$child"; printf stopped > "$PWD/old-stopped"; exit 0\' TERM\n'
                'wait "$child"\n')


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_listening(port, process):
    for _ in range(100):
        if process.poll() is not None:
            raise AssertionError("가짜 서버가 시작 전에 끝났습니다.")
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            return
        except OSError:
            time.sleep(0.05)
    raise AssertionError("가짜 서버가 포트를 열지 않았습니다.")


class MacLauncherRestartTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / "project with spaces"
        for name in ["tools", ".venv/bin", ".local/tenancy", "old"]:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.launcher = self.root / "tools/start-mac.command"
        shutil.copyfile(SOURCE, self.launcher)
        (self.root / ".local/tenancy/access.json").write_text("{}")
        # 사전 검사(-B -)는 통과하고 policy-fails가 있으면 정책 검사만 실패한다. 서버 실행은 인자를 남기고 실패한다.
        python = self.root / ".venv/bin/python"
        python.write_text('#!/bin/bash\nif [[ "${2:-}" == "-" ]]; then cat >/dev/null\n'
                          '  [[ -n "${3:-}" || ! -e "$PWD/policy-fails" ]] || exit 1; exit 0; fi\n'
                          'printf "%s\\n" "$@" > "$PWD/http-argv"\nexit 7\n')
        python.chmod(0o700)
        tunnel = self.root / ".local/cloudflared"
        tunnel.write_text("#!/bin/bash\nexit 99\n")
        tunnel.chmod(0o700)
        self.port = free_port()

    def start(self, command, port):
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop, process)
        wait_listening(port, process)
        return process

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)

    def old_launcher(self, folder):
        script = self.root / "old/start-mac.command"
        script.write_text(OLD_LAUNCHER)
        return self.start(["/bin/bash", str(script), str(folder), sys.executable, str(self.port), LISTEN],
                          self.port)

    def run_launcher(self):
        return subprocess.run(["/bin/bash", str(self.launcher), str(self.port)], cwd="/",
                              text=True, capture_output=True, timeout=60)

    def test_restarts_previous_launcher_of_this_project_on_same_port(self):
        old = self.old_launcher(self.root)
        result = self.run_launcher()
        self.assertIn(f"이전 런처를 종료합니다: {old.pid}", result.stdout)
        self.assertEqual(old.wait(timeout=10), 0)
        self.assertEqual((self.root / "old-stopped").read_text(), "stopped")
        self.assertIn("서버가 시작되지 않았습니다", result.stderr)
        args = (self.root / "http-argv").read_text().splitlines()
        self.assertEqual(args[args.index("--port") + 1], str(self.port))

    def test_keeps_other_owners_and_fails_without_starting(self):
        other_project = self.base / "other project"
        other_project.mkdir()
        cases = {
            "plain process": lambda: self.start([sys.executable, "-c", LISTEN, str(self.port)], self.port),
            "other project's launcher": lambda: self.old_launcher(other_project),
        }
        for name, owner in cases.items():
            with self.subTest(owner=name):
                process = owner()
                result = self.run_launcher()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("이 프로젝트 런처가 아닌 프로세스", result.stderr)
                self.assertNotIn("이전 런처를 종료합니다", result.stdout)
                self.assertIsNone(process.poll())
                self.assertFalse((self.root / "http-argv").exists())
                self.stop(process)

    def test_policy_failure_keeps_previous_launcher(self):
        (self.root / "policy-fails").write_text("")
        old = self.old_launcher(self.root)
        result = self.run_launcher()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("이전 런처를 종료합니다", result.stdout)
        self.assertIsNone(old.poll())
        self.assertFalse((self.root / "old-stopped").exists())


if __name__ == "__main__":
    unittest.main()
