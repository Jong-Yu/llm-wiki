"""Protected launcher and real stdio tests using only temporary credentials/data."""

import asyncio
from contextlib import redirect_stderr, redirect_stdout
import errno
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from mcp import Client, StdioServerParameters

from core.runtime import personal_launcher as launcher
from core.modules.access.policy import AccessPolicy
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.documents.store import WikiStore
from core.tests.modules.test_correspondences import correspondence_fixture


READ_TOOLS = {
    "access_context", "wiki_read", "wiki_search", "ontology_query", "ontology_connections",
    "ontology_context", "ontology_impact", "ontology_review_query", "ontology_correspondence_query",
    "ontology_correspondence_prepare", "ontology_correspondence_find", "ontology_concept_find", "ontology_concept_query",
}


class _Fixture:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-personal-launcher-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.root.chmod(0o700)
        self.credentials = self.root / "credentials"
        self.credentials.mkdir(mode=0o700)
        self.tenant_root = self.root / "tenants"
        self.tenant_root.mkdir(mode=0o700)
        (self.tenant_root / "acme").mkdir(mode=0o700)
        self.token_file = self.credentials / "alice.token"
        self.token = secrets.token_urlsafe(32)
        self.secrets = [self.token]
        self.token_file.write_text(self.token, encoding="ascii")
        self.token_file.chmod(0o600)
        self.policy_file = self.root / "access.json"
        self.policy = {"version": 1, "tenants": {"acme": {"profiles": {
            "business": {"domain": None, "viewpoint": "business"},
        }}}, "users": {"alice": {"token_sha256": sha256(self.token.encode()).hexdigest(),
            "memberships": {"acme": {"permissions": ["read"], "profiles": ["business"], "default_profile": "business"}}}}}
        self.save_policy()

    def save_policy(self):
        staged = self.root / "policy-staging.json"
        with os.fdopen(os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            json.dump(self.policy, stream)
        os.replace(staged, self.policy_file)

    def arguments(self, **changes):
        result = {"token_file": self.token_file, "access_config": self.policy_file, "tenant_root": self.tenant_root}
        result.update(changes)
        return result

    def command(self, **changes):
        values = self.arguments(**changes)
        return [sys.executable, "-B", "-m", "core.personal_launcher", "--token-file", str(values["token_file"]),
                "--access-config", str(values["access_config"]), "--tenant-root", str(values["tenant_root"])]

    def snapshot(self):
        return {str(path.relative_to(self.root)): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file() and not path.is_symlink()}

    def assert_no_secret(self, value):
        text = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)
        self.assertTrue(all(secret not in text for secret in self.secrets), "Credential was exposed")


class PersonalLauncherTests(_Fixture, unittest.TestCase):
    def test_prepare_is_fixed_stdio_and_does_not_change_files_or_inherit_legacy_credentials(self):
        before = self.snapshot()
        inherited = {"HOME": str(self.root), "PATH": os.environ.get("PATH", ""),
                     "LLM_WIKI_TOKEN": "legacy-must-not-survive", "LLM_WIKI_PERSONAL_TOKEN": "inherited-wrong-value",
                     "LLM_WIKI_OTHER_TOKEN": "other-must-not-survive", "PYTHONPATH": "/untrusted", "PYTHONINSPECT": "1"}
        spec = launcher.prepare_launch(**self.arguments(), environment=inherited)
        self.assertEqual(spec.executable, str(launcher.PROJECT_PYTHON))
        self.assertEqual(spec.cwd, str(launcher.PROJECT_DIR))
        self.assertEqual(spec.argv[:4], (str(launcher.PROJECT_PYTHON), "-B", "-m", "core.mcp_server"))
        self.assertEqual(spec.argv[spec.argv.index("--transport") + 1], "stdio")
        self.assertEqual(spec.argv[spec.argv.index("--token-env") + 1], launcher.PERSONAL_TOKEN_ENV)
        self.assertNotIn("--data-dir", spec.argv)
        self.assertNotIn("--token-file", spec.argv)
        self.assertTrue(secrets.compare_digest(spec.environment[launcher.PERSONAL_TOKEN_ENV], self.token))
        self.assertEqual({key for key in spec.environment if key.startswith("LLM_WIKI_")}, {launcher.PERSONAL_TOKEN_ENV})
        self.assertFalse(any(key.startswith("PYTHON") for key in spec.environment))
        self.assertIn("LLM_WIKI_TOKEN", inherited)
        self.assertEqual(spec.environment["HOME"], str(self.root))
        self.assert_no_secret(repr(spec))
        self.assert_no_secret(spec.argv)
        self.assertTrue(self.snapshot() == before, "Fixture files changed")

    def test_valid_boundaries_and_one_optional_line_ending(self):
        for length in (32, 256):
            token = "a" * length
            self.policy["users"]["alice"]["token_sha256"] = sha256(token.encode()).hexdigest()
            self.save_policy()
            for ending in (b"", b"\n", b"\r\n"):
                with self.subTest(length=length, ending_length=len(ending)):
                    self.token_file.write_bytes(token.encode() + ending)
                    spec = launcher.prepare_launch(**self.arguments())
                    self.assertTrue(secrets.compare_digest(spec.environment[launcher.PERSONAL_TOKEN_ENV], token))

    def test_invalid_token_formats_and_sizes_fail_closed(self):
        cases = [b"", b"a" * 31, b"a" * 257, b"a" * 32 + b"\n\n", b"a" * 32 + b" ",
                 b" " + b"a" * 32, b"a" * 32 + b"/", b"a" * 32 + b"\t", b"\xff" * 32, b"a" * 4096]
        for index, raw in enumerate(cases):
            with self.subTest(case=index):
                self.token_file.write_bytes(raw)
                before = self.snapshot()
                with self.assertRaises(launcher.LauncherError) as caught:
                    launcher.prepare_launch(**self.arguments())
                self.assert_no_secret(caught.exception)
                self.assertTrue(self.snapshot() == before, "Fixture files changed")

    def test_token_and_policy_require_exact_0600_and_one_link(self):
        for path in (self.token_file, self.policy_file):
            for mode in (0o400, 0o644, 0o660):
                with self.subTest(kind=path.name, mode=mode):
                    path.chmod(mode)
                    with self.assertRaises(launcher.LauncherError):
                        launcher.prepare_launch(**self.arguments())
                    path.chmod(0o600)
            alias = self.root / (path.name + ".alias")
            os.link(path, alias)
            with self.assertRaises(launcher.LauncherError):
                launcher.prepare_launch(**self.arguments())
            alias.unlink()

    def test_leaf_parent_and_tenant_symlinks_are_rejected(self):
        token_alias = self.credentials / "alias.token"
        token_alias.symlink_to(self.token_file)
        directory_alias = self.root / "credential-alias"
        directory_alias.symlink_to(self.credentials, target_is_directory=True)
        policy_alias = self.root / "policy-alias.json"
        policy_alias.symlink_to(self.policy_file)
        root_alias = self.root / "tenant-alias"
        root_alias.symlink_to(self.tenant_root, target_is_directory=True)
        for changes in ({"token_file": token_alias}, {"token_file": directory_alias / self.token_file.name},
                        {"access_config": policy_alias}, {"tenant_root": root_alias}):
            with self.subTest(fields=sorted(changes)):
                with self.assertRaises(launcher.LauncherError):
                    launcher.prepare_launch(**self.arguments(**changes))

    def test_private_parents_and_all_ancestors_are_checked(self):
        for mode in (0o750, 0o755, 0o770):
            self.credentials.chmod(mode)
            with self.subTest(mode=mode):
                with self.assertRaises(launcher.LauncherError):
                    launcher.prepare_launch(**self.arguments())
        self.credentials.chmod(0o700)
        self.root.chmod(0o770)
        with self.assertRaises(launcher.LauncherError):
            launcher.prepare_launch(**self.arguments())
        self.root.chmod(0o700)
        launcher.prepare_launch(**self.arguments())

    def test_other_owner_and_nonregular_credentials_are_rejected_without_blocking(self):
        real_fstat = os.fstat
        inode = self.token_file.stat().st_ino

        def different_owner(descriptor):
            result = real_fstat(descriptor)
            if result.st_ino == inode and stat.S_ISREG(result.st_mode):
                return SimpleNamespace(st_mode=result.st_mode, st_uid=os.geteuid() + 1, st_nlink=result.st_nlink)
            return result

        with patch("core.runtime.personal_launcher.os.fstat", side_effect=different_owner):
            with self.assertRaises(launcher.LauncherError):
                launcher.prepare_launch(**self.arguments())
        def special_permission_bits(descriptor):
            result = real_fstat(descriptor)
            if result.st_ino == inode and stat.S_ISREG(result.st_mode):
                return SimpleNamespace(st_mode=result.st_mode | stat.S_ISUID, st_uid=result.st_uid,
                                       st_nlink=result.st_nlink)
            return result

        # Some macOS temporary filesystems strip setuid on chmod; inject its
        # observed stat bits to test the exact-mode guard without relying on that.
        with patch("core.runtime.personal_launcher.os.fstat", side_effect=special_permission_bits):
            with self.assertRaises(launcher.LauncherError):
                launcher.prepare_launch(**self.arguments())
        fifo = self.credentials / "credential-fifo"
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(launcher.LauncherError):
            launcher.prepare_launch(**self.arguments(token_file=fifo))
        with self.assertRaises(launcher.LauncherError):
            launcher.prepare_launch(**self.arguments(token_file=self.credentials))

    def test_secrets_and_policy_must_be_outside_tenant_storage_and_paths_absolute(self):
        private = self.tenant_root / "private"
        private.mkdir(mode=0o700)
        for changes in ({"token_file": private / "key"}, {"access_config": private / "access.json"},
                        {"token_file": self.policy_file}, {"token_file": Path("relative.token")},
                        {"tenant_root": self.root / "tenants" / ".." / "tenants"}):
            with self.subTest(fields=sorted(changes)):
                with self.assertRaises(launcher.LauncherError):
                    launcher.prepare_launch(**self.arguments(**changes))

    def test_invalid_or_mismatched_policy_does_not_use_environment_as_fallback(self):
        before = self.snapshot()
        self.policy["users"]["alice"]["token_sha256"] = sha256(b"different-personal-credential").hexdigest()
        self.save_policy()
        with self.assertRaises(launcher.LauncherError) as caught:
            launcher.prepare_launch(**self.arguments(), environment={"LLM_WIKI_TOKEN": self.token})
        self.assertEqual(caught.exception.code, "credentials_rejected")
        self.policy_file.write_text("{malformed isolated policy", encoding="utf-8")
        with self.assertRaises(launcher.LauncherError) as caught:
            launcher.prepare_launch(**self.arguments())
        self.assertEqual(caught.exception.code, "policy_unavailable")
        self.assertTrue(self.token_file.read_bytes() == before["credentials/alice.token"], "Credential file changed")

    def test_invalid_wait_and_missing_runtime_fail_without_execution(self):
        for value in (True, -1, float("inf"), float("nan"), "5", 10 ** 400):
            with self.subTest(type=type(value).__name__):
                with self.assertRaises(launcher.LauncherError):
                    launcher.prepare_launch(**self.arguments(), lock_timeout=value)
        with patch("core.runtime.personal_launcher.PROJECT_PYTHON", self.root / "missing-python"):
            with self.assertRaises(launcher.LauncherError) as caught:
                launcher.prepare_launch(**self.arguments())
            self.assertEqual(caught.exception.code, "runtime_unavailable")

    def test_exec_replaces_process_with_fixed_command_and_secret_only_in_environment(self):
        class CapturedExec(BaseException):
            pass

        with patch("core.runtime.personal_launcher.os.chdir") as change_directory, patch(
            "core.runtime.personal_launcher.os.execve", side_effect=CapturedExec
        ) as execute:
            with self.assertRaises(CapturedExec):
                launcher.launch(**self.arguments())
        change_directory.assert_called_once_with(str(launcher.PROJECT_DIR))
        executable, argv, environment = execute.call_args.args
        self.assertEqual(executable, str(launcher.PROJECT_PYTHON))
        self.assert_no_secret(argv)
        self.assertTrue(secrets.compare_digest(environment[launcher.PERSONAL_TOKEN_ENV], self.token))

    def test_errors_and_argument_parsing_never_echo_paths_or_secrets(self):
        for extra in (["--token", self.token], ["--transport", "streamable-http"], ["--data-dir", str(self.root)],
                      ["--token-env", "LLM_WIKI_TOKEN"], ["--lock-timeout", self.token]):
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr), self.assertRaises(SystemExit) as caught:
                launcher.main(self.command()[4:] + extra)
            self.assertEqual(caught.exception.code, 2)
            self.assertTrue(stdout.getvalue() == "", "Unexpected stdout")
            self.assert_no_secret(stderr.getvalue())
            self.assertTrue(str(self.root) not in stderr.getvalue())
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr), patch("core.runtime.personal_launcher.os.chdir"), patch(
            "core.runtime.personal_launcher.os.execve", side_effect=OSError(errno.EACCES, self.token)
        ):
            result = launcher.main(self.command()[4:])
        self.assertEqual(result, 2)
        self.assertTrue(stdout.getvalue() == "", "Unexpected stdout")
        self.assert_no_secret(stderr.getvalue())
        self.assertEqual(stderr.getvalue(), "personal-launcher: exec_failed.\n")

    def test_real_cli_startup_failure_has_empty_stdout_and_no_legacy_fallback(self):
        environment = {**os.environ, "LLM_WIKI_TOKEN": self.token, launcher.PERSONAL_TOKEN_ENV: self.token}
        completed = subprocess.run(self.command(token_file=self.credentials / "absent.token"), cwd=launcher.PROJECT_DIR,
                                   env=environment, capture_output=True, timeout=10)
        self.assertEqual(completed.returncode, 2)
        self.assert_no_secret(completed.stdout)
        self.assertTrue(completed.stdout == b"", "Unexpected stdout")
        self.assert_no_secret(completed.stderr)
        self.assertTrue(str(self.root).encode() not in completed.stderr)


class PersonalLauncherStdioTests(_Fixture, unittest.IsolatedAsyncioTestCase):
    def client(self):
        return Client(StdioServerParameters(command=sys.executable, args=self.command()[1:], cwd=launcher.PROJECT_DIR,
            env={"LLM_WIKI_TOKEN": "wrong-legacy-value", launcher.PERSONAL_TOKEN_ENV: "wrong-inherited-value"}),
            mode="legacy", read_timeout_seconds=10)

    def payload(self, result, code=None):
        payload = result.structured_content
        self.assertIsInstance(payload, dict)
        self.assertEqual(json.loads(result.content[0].text), payload)
        self.assertEqual(result.is_error, code is not None)
        self.assertEqual(payload["ok"], code is None)
        self.assert_no_secret(json.dumps(payload))
        if code is not None:
            self.assertEqual(payload["error"]["code"], code)
        return payload

    def seed(self):
        store = WikiStore(self.tenant_root / "acme")
        store.save("Guide.md", "isolated personal launcher fixture\n", expected_revision=None)
        draft = correspondence_fixture(store, basis="candidate")
        scope = AccessPolicy(self.policy_file, self.tenant_root).authorize(self.token, "acme", "read")
        actor = {name: getattr(scope, name) for name in ("user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision")}
        correspondences = CorrespondenceStore(store, actor)
        prepared = correspondences.query(draft=draft)
        saved = correspondences.propose(prepared["correspondence_id"], draft, prepared["state_revision"],
                                        "isolated fixture setup simulation; no human approval")
        return saved["correspondence_id"]

    async def test_actual_launcher_sdk_lists_registered_tools_and_preserves_read_profile(self):
        correspondence_id = self.seed()
        before = self.snapshot()
        async with self.client() as client:
            context = self.payload(await client.call_tool("access_context", {}))
            self.assertEqual(context["user_id"], "alice")
            self.assertEqual(context["memberships"]["acme"]["permissions"], ["read"])
            tools = {tool.name for tool in (await client.list_tools()).tools}
            self.assertEqual(len(tools), 35)
            self.assertTrue(READ_TOOLS <= tools)
            requests = {
                "wiki_read": {"document": "Guide.md"}, "wiki_search": {"query": "isolated"},
                "ontology_query": {"document": "Guide.md"}, "ontology_connections": {"document": "Guide.md"},
                "ontology_context": {"documents": ["Guide.md"]}, "ontology_impact": {"document": "Guide.md"},
                "ontology_review_query": {"document": "Guide.md"},
                "ontology_correspondence_query": {"correspondence_id": correspondence_id},
                "ontology_correspondence_find": {"documents": ["a.md"]},
                "ontology_correspondence_prepare": {"correspondence_id": correspondence_id, "operation": "review",
                    "change": {"action": "reject", "reason": "isolated read-only prepare simulation"}},
                "ontology_concept_find": {"text": "isolated"},
            }
            found = None
            for name, arguments in requests.items():
                payload = self.payload(await client.call_tool(name, {"tenant": "acme", **arguments}))
                if name == "ontology_concept_find":
                    found = payload
            target = next(item["target_ref"] for item in found["matches"] if item["target_ref"]["kind"] == "anchor")
            self.payload(await client.call_tool("ontology_concept_query", {"tenant": "acme", "target": target}))
            # 새 분석 조회/실행 도구의 권한은 전용 MCP 계약 검사에서 확인한다.
            # 이 런처 검사는 기존 read13과 기존 11개 쓰기 거부를 보존한다.
            analysis_tools = {"source_read", "analysis_job_query", "analysis_job_claim", "analysis_job_update",
                "extraction_rules_read", "analysis_job_input_prepare", "analysis_job_input_read", "source_extraction_submit",
                "analysis_job_wiki_write", "analysis_job_ontology_generate", "analysis_job_result_query"}
            self.assertTrue(analysis_tools <= tools)
            mutations = tools - READ_TOOLS - analysis_tools
            self.assertEqual(len(mutations), 11)
            for name in sorted(mutations):
                self.payload(await client.call_tool(name, {"tenant": "acme"}), "access_denied")
        self.assertTrue(self.snapshot() == before, "Fixture files changed")

    async def test_warm_permission_revoke_is_rechecked_without_restarting_launcher(self):
        self.seed()
        async with self.client() as client:
            self.payload(await client.call_tool("wiki_read", {"tenant": "acme", "document": "Guide.md"}))
            before = {key: value for key, value in self.snapshot().items() if key != "access.json"}
            self.policy["users"]["alice"]["memberships"]["acme"]["permissions"] = []
            self.save_policy()
            context = self.payload(await client.call_tool("access_context", {}))
            self.assertEqual(context["memberships"]["acme"]["permissions"], [])
            self.payload(await client.call_tool("wiki_read", {"tenant": "acme", "document": "Guide.md"}), "access_denied")
            self.assertTrue({key: value for key, value in self.snapshot().items() if key != "access.json"} == before,
                            "Fixture data changed")

    async def test_rotation_requires_new_launch_and_old_process_cannot_use_new_credential_file(self):
        self.seed()
        async with self.client() as old:
            self.payload(await old.call_tool("access_context", {}))
            new_token = secrets.token_urlsafe(32)
            self.secrets.append(new_token)
            self.token_file.write_text(new_token, encoding="ascii")
            # The old process retains its startup credential; a new launch fails
            # until the administrator policy authorizes the new file's value.
            self.payload(await old.call_tool("access_context", {}))
            with self.assertRaises(launcher.LauncherError) as caught:
                launcher.prepare_launch(**self.arguments())
            self.assertEqual(caught.exception.code, "credentials_rejected")
            self.policy["users"]["alice"]["token_sha256"] = sha256(new_token.encode()).hexdigest()
            self.save_policy()
            before = self.snapshot()
            self.payload(await old.call_tool("access_context", {}), "access_denied")
            async with self.client() as fresh:
                context = self.payload(await fresh.call_tool("access_context", {}))
                self.assertEqual(context["user_id"], "alice")
                self.payload(await fresh.call_tool("wiki_read", {"tenant": "acme", "document": "Guide.md"}))
            self.assertTrue(self.snapshot() == before, "Fixture files changed")

    async def test_raw_stdio_has_only_jsonrpc_and_never_prints_token(self):
        process = await asyncio.create_subprocess_exec(*self.command(), cwd=launcher.PROJECT_DIR,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=2 * 1024 * 1024)
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25",
                "capabilities": {}, "clientInfo": {"name": "isolated-launcher-client", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "access_context", "arguments": {}}},
        ]
        try:
            for request in requests:
                process.stdin.write((json.dumps(request) + "\n").encode())
                await process.stdin.drain()
                if "id" in request:
                    raw = await asyncio.wait_for(process.stdout.readline(), timeout=10)
                    self.assert_no_secret(raw)
                    response = json.loads(raw)
                    self.assertEqual(response["id"], request["id"])
                    self.assertEqual(response["jsonrpc"], "2.0")
                    if request["id"] == 2:
                        self.assertEqual(len(response["result"]["tools"]), 35)
                    if request["id"] == 3:
                        result = response["result"]
                        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
                        self.assertTrue(result["structuredContent"]["ok"])
            process.stdin.close()
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
            self.assert_no_secret(stdout)
            self.assertTrue(stdout == b"", "Unexpected stdout")
            self.assert_no_secret(stderr)
            self.assertEqual(process.returncode, 0)
        finally:
            if process.returncode is None:
                process.terminate()
                await process.wait()


if __name__ == "__main__":
    unittest.main()
