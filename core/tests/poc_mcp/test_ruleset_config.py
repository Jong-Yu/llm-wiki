"""명시 규약 설정·기존 인자 호환·Mac 런처 전달을 격리 파일과 가짜 실행기로 검사한다."""
from contextlib import redirect_stderr
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from core.runtime import http_cli
from core.runtime.rulesets import configured_ruleset_paths


class RulesetConfigTests(unittest.TestCase):
    def test_schema_validation_reuses_only_identical_bounded_bytes(self):
        """같은 스키마만 재사용하며 바뀌거나 잘못된 스키마는 다시 검사한다."""
        from core.modules.extraction_rules import store
        from core.runtime.extraction_schema import build_submission_schema
        store._check_schema.cache_clear()
        self.addCleanup(store._check_schema.cache_clear)
        schema = build_submission_schema()
        with patch.object(store.Draft202012Validator, "check_schema",
                          wraps=store.Draft202012Validator.check_schema) as check:
            raw = store.schema_bytes(schema)
            self.assertEqual(store.schema_bytes(json.loads(raw)), raw)
            self.assertEqual(check.call_count, 1)
            schema["description"] = "x" * (store.limits.MAX_COMPONENT_BYTES + 1)
            with self.assertRaises(store.RulesetCompatibilityError):
                store.schema_bytes(schema)
            self.assertEqual(check.call_count, 1)
            del schema["description"]
            schema["properties"]["invalid"] = {"type": "invalid_type"}
            for _ in range(2):
                with self.assertRaises(store.RulesetCompatibilityError):
                    store.schema_bytes(schema)
            self.assertEqual(check.call_count, 3)

    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.rules = self.root / "published rules"
        self.rules.mkdir()
        self.policy = self.root / "rulesets.json"
        self.policy.write_text('{"version":1,"tenants":{}}')
        self.data = self.root / "data"
        self.data.mkdir()
        self.config = self.root / "server-rulesets.json"
        self.value = {"ruleset_root": str(self.rules), "ruleset_policy": str(self.policy)}
        self.config.write_text(json.dumps(self.value))

    def test_valid_config_and_existing_options(self):
        self.assertEqual(configured_ruleset_paths(self.config), (self.rules, self.policy))
        self.assertEqual(configured_ruleset_paths(None), (None, None))
        self.assertEqual(configured_ruleset_paths(None, Path("relative-rules"), Path("relative-policy")),
                         (Path("relative-rules"), Path("relative-policy")))
        for root, policy in [(self.rules, None), (None, self.policy), (self.rules, self.policy)]:
            with self.subTest(root=root, policy=policy), self.assertRaises(ValueError):
                configured_ruleset_paths(self.config, root, policy)

    def test_malformed_incomplete_unknown_duplicate_and_relative_values_fail(self):
        invalid = ["{", "[]", "null", "{}", json.dumps({**self.value, "extra": True}),
                   json.dumps({"ruleset_root": str(self.rules)}),
                   json.dumps({**self.value, "ruleset_policy": "relative.json"}),
                   json.dumps({**self.value, "ruleset_root": 7}),
                   json.dumps({**self.value, "ruleset_root": "/nul\0path"}),
                   '{"ruleset_root":"/first",' + json.dumps(self.value)[1:], " " * 32769]
        for raw in invalid:
            with self.subTest(raw=raw[:80]):
                self.config.write_text(raw)
                with self.assertRaises((ValueError, OSError)):
                    configured_ruleset_paths(self.config)

    def test_missing_nonregular_and_linked_paths_fail(self):
        linked = self.root / "linked.json"
        linked.symlink_to(self.config)
        broken = self.root / "broken.json"
        broken.symlink_to(self.root / "absent")
        for path in [self.root / "absent", self.rules, linked, broken]:
            with self.subTest(path=path.name), self.assertRaises((ValueError, OSError)):
                configured_ruleset_paths(path)
        parent = self.root / "linked-parent"
        parent.symlink_to(self.rules, target_is_directory=True)
        for change in [{"ruleset_root": str(self.root / "absent")},
                       {"ruleset_policy": str(self.root / "absent")},
                       {"ruleset_policy": str(linked)}, {"ruleset_root": str(parent)}]:
            self.config.write_text(json.dumps({**self.value, **change}))
            with self.subTest(change=change), self.assertRaises((ValueError, OSError)):
                configured_ruleset_paths(self.config)

    def test_http_uses_registry_and_refuses_data_overlap_before_application_start(self):
        access = SimpleNamespace(tenant_root=self.data, validate=lambda: None)
        argv = ["http_cli", "--access-config", "access.json", "--tenant-root", str(self.data)]
        for extra, expected_root in [([], None), (["--ruleset-root", str(self.rules),
                "--ruleset-policy", str(self.policy)], self.rules),
                (["--ruleset-config", str(self.config)], self.rules)]:
            with self.subTest(extra=extra), patch.object(sys, "argv", argv + extra), \
                    patch.object(http_cli, "AccessPolicy", return_value=access), \
                    patch.object(http_cli, "create_application") as create, \
                    patch.object(http_cli.uvicorn, "run") as serve:
                http_cli.main()
                registry = create.call_args.kwargs["rulesets"]
                self.assertEqual(registry.root if registry else None, expected_root)
                serve.assert_called_once_with(create.return_value, host="127.0.0.1", port=8766,
                    workers=1, log_level="warning", access_log=False, proxy_headers=False)
        self.config.write_text(json.dumps({**self.value, "ruleset_root": str(self.data)}))
        for extra in [["--ruleset-config", str(self.config)],
                      ["--ruleset-config", str(self.config), "--ruleset-policy", str(self.policy)]]:
            with self.subTest(extra=extra), patch.object(sys, "argv", argv + extra), \
                    patch.object(http_cli, "AccessPolicy", return_value=access), \
                    patch.object(http_cli, "create_application") as create, \
                    patch.object(http_cli.uvicorn, "run") as serve, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    http_cli.main()
                self.assertEqual(error.exception.code, 2)
                create.assert_not_called()
                serve.assert_not_called()


class MacLauncherRulesetTests(unittest.TestCase):
    def test_launch_passes_only_explicit_config_including_broken_link(self):
        source = Path(__file__).resolve().parents[3] / "tools/start-mac.command"
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "project with spaces"
            for name in ["tools", ".venv/bin", ".local/tenancy"]:
                (root / name).mkdir(parents=True, exist_ok=True)
            launcher = root / "tools/start-mac.command"
            shutil.copyfile(source, launcher)
            (root / ".local/tenancy/access.json").write_text("{}")
            python = root / ".venv/bin/python"
            python.write_text('#!/bin/bash\nif [[ "${2:-}" == "-" ]]; then cat >/dev/null; exit 0; fi\n'
                              'printf "%s\\n" "$@" > "$PWD/http-argv"\nexit 7\n')
            python.chmod(0o700)
            tunnel = root / ".local/cloudflared"
            tunnel.write_text("#!/bin/bash\nexit 99\n")
            tunnel.chmod(0o700)
            config = root / ".local/server-rulesets.json"
            for mode in ["absent", "file", "broken-link"]:
                with self.subTest(mode=mode):
                    if mode == "file":
                        config.write_text("{}")
                    elif mode == "broken-link":
                        config.unlink()
                        config.symlink_to(root / "absent.json")
                    process = subprocess.run(["/bin/bash", str(launcher), "8767"], cwd="/",
                        text=True, capture_output=True, timeout=15)
                    self.assertNotEqual(process.returncode, 0)
                    args = (root / "http-argv").read_text().splitlines()
                    self.assertEqual(args[:4], ["-B", "-m", "core.runtime.http_cli", "--access-config"])
                    expected = [] if mode == "absent" else ["--ruleset-config", str(config)]
                    self.assertEqual(args[4:], [".local/tenancy/access.json", "--tenant-root", "data",
                        "--port", "8767", "--tracked-read-index", "--read-metrics", *expected])


if __name__ == "__main__":
    unittest.main()
