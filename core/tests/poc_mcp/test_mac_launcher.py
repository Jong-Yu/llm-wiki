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


MEMO = SOURCE.parent / "publish-server-address.sh"
MEMO_ID = "0123456789abcdef0123456789abcdef"
# 가짜 gh: 호출마다 인자를 NUL로 구분해 calls/에 남기고, 새 메모 만들기에는 고정 ID를 돌려준다.
FAKE_GH = ('#!/bin/bash\ncalls="{calls}"\nprintf "%s\\0" "$@" > "$calls/$(ls "$calls" | wc -l | tr -d " ")"\n'
           '[[ ! -e "$calls/../gh-fails" ]] || {{ echo "HTTP 404: Not Found" >&2; exit 1; }}\n'
           'for arg in "$@"; do [[ "$arg" != POST ]] || {{ echo ' + MEMO_ID + '; exit 0; }}; done\n')
SERVE_401 = ("import http.server, sys\n"
             "class Handler(http.server.BaseHTTPRequestHandler):\n"
             "    def do_GET(self):\n        self.send_response(401); self.end_headers()\n"
             "    def log_message(self, *args):\n        pass\n"
             "http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()\n")


class AddressMemoTests(unittest.TestCase):
    """새 주소를 비공개 GitHub 메모에 올리는 기능은 켠 경우에만 동작하고 인증 정보는 보내지 않는다."""

    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / "project with spaces"
        for name in ["tools", ".local/tenancy", ".venv/bin", "bin", "calls"]:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        for source in (SOURCE, MEMO):
            target = self.root / "tools" / source.name
            shutil.copyfile(source, target)
            target.chmod(0o700)
        gh = self.root / "bin/gh"
        gh.write_text(FAKE_GH.format(calls=self.root / "calls"))
        gh.chmod(0o700)
        self.id_file = self.root / ".local/address-gist-id"
        self.env = {"PATH": f"{self.root / 'bin'}:/usr/bin:/bin", "HOME": str(self.base)}

    def publish(self, *args):
        return subprocess.run(["/bin/bash", str(self.root / "tools" / MEMO.name), *args], cwd="/", env=self.env,
                              text=True, capture_output=True, timeout=30)

    def calls(self):
        files = sorted((self.root / "calls").iterdir(), key=lambda path: int(path.name))
        return [path.read_bytes().decode().split("\0")[:-1] for path in files]

    @staticmethod
    def field(call, prefix):
        return next(arg[len(prefix):] for arg in call if arg.startswith(prefix))

    def test_does_nothing_until_enabled(self):
        result = self.publish("https://new-address.trycloudflare.com")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        self.assertEqual(self.calls(), [])

    def test_first_run_creates_a_secret_memo_and_remembers_it(self):
        self.id_file.write_text("")
        result = self.publish("https://first-address.trycloudflare.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        [call] = self.calls()
        self.assertEqual(call[:4], ["api", "--method", "POST", "gists"])
        self.assertEqual(call[call.index("-F") + 1], "public=false")
        content = self.field(call, "files[llm-wiki-server-address.md][content]=")
        self.assertIn("앱 서버 주소: https://first-address.trycloudflare.com\n", content)
        self.assertIn("MCP 주소: https://first-address.trycloudflare.com/mcp\n", content)
        self.assertEqual(self.id_file.read_text(), MEMO_ID + "\n")
        self.assertIn(f"https://gist.github.com/{MEMO_ID}", result.stdout)

    def test_later_runs_update_the_same_memo_from_the_saved_address(self):
        self.id_file.write_text(MEMO_ID + "\n")
        (self.root / ".local/last-server-url.txt").write_text("https://second-address.trycloudflare.com\n")
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        [call] = self.calls()
        self.assertEqual(call[:4], ["api", "--method", "PATCH", f"gists/{MEMO_ID}"])
        self.assertNotIn("public=false", call)
        self.assertIn("MCP 주소: https://second-address.trycloudflare.com/mcp\n",
                      self.field(call, "files[llm-wiki-server-address.md][content]="))
        self.assertEqual(self.id_file.read_text(), MEMO_ID + "\n")

    def test_bad_input_is_refused_without_calling_github(self):
        cases = {"bad address": (MEMO_ID, "https://x.example/a?token=1"),
                 "not https": (MEMO_ID, "http://x.trycloudflare.com"),
                 "bad memo id": ("../../user/repos", "https://x.trycloudflare.com")}
        for name, (saved, url) in cases.items():
            with self.subTest(name):
                self.id_file.write_text(saved)
                result = self.publish(url)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("주소 메모를 바꾸지 못했습니다", result.stderr)
                self.assertEqual(self.calls(), [])
                self.assertEqual(self.id_file.read_text(), saved)

    def test_github_failure_is_reported_and_keeps_the_saved_id(self):
        (self.root / "gh-fails").write_text("")
        for saved in ("", MEMO_ID + "\n"):
            with self.subTest(saved=saved):
                self.id_file.write_text(saved)
                result = self.publish("https://x.trycloudflare.com")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("gh auth status", result.stderr)
                self.assertNotIn("HTTP 404", result.stderr)
                self.assertEqual(self.id_file.read_text(), saved)

    def test_launcher_publishes_the_new_address_and_keeps_running(self):
        self.id_file.write_text(MEMO_ID + "\n")
        port = free_port()
        (self.root / ".local/tenancy/access.json").write_text("{}")
        serve = self.base / "serve.py"
        serve.write_text(SERVE_401)
        # 사전 검사(-B -)는 통과하고, 서버 실행은 401을 돌려주는 진짜 HTTP 서버로 바꾼다.
        python = self.root / ".venv/bin/python"
        python.write_text('#!/bin/bash\nif [[ "${2:-}" == "-" ]]; then cat >/dev/null; exit 0; fi\n'
                          f'exec "{sys.executable}" "{serve}" {port}\n')
        python.chmod(0o700)
        tunnel = self.root / ".local/cloudflared"
        tunnel.write_text("#!/bin/bash\nprintf 'INF |  https://memo-test.trycloudflare.com  |\\n"
                          "INF Registered tunnel connection\\n'\nexec sleep 60\n")
        tunnel.chmod(0o700)
        log = (self.base / "launcher.log").open("w")
        self.addCleanup(log.close)
        launcher = subprocess.Popen(["/bin/bash", str(self.root / "tools/start-mac.command"), str(port)], cwd="/",
                                    env=self.env, stdout=log, stderr=subprocess.STDOUT)
        self.addCleanup(lambda: launcher.poll() is not None or (launcher.kill(), launcher.wait()))
        for _ in range(300):
            if self.calls() or launcher.poll() is not None:
                break
            time.sleep(0.1)
        self.assertIsNone(launcher.poll(), (self.base / "launcher.log").read_text())
        [call] = self.calls()
        self.assertEqual(call[:4], ["api", "--method", "PATCH", f"gists/{MEMO_ID}"])
        self.assertIn("앱 서버 주소: https://memo-test.trycloudflare.com\n",
                      self.field(call, "files[llm-wiki-server-address.md][content]="))
        launcher.terminate()
        self.assertEqual(launcher.wait(timeout=30), 143)
        self.assertFalse((self.root / ".local/last-server-url.txt").exists())
        self.assertIn("주소 메모를 새 주소로 바꿨습니다", (self.base / "launcher.log").read_text())


if __name__ == "__main__":
    unittest.main()
