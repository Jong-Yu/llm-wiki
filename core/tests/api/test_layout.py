"""HTTP·MCP 어댑터의 업무 재사용·import 부작용·공개 응답 계약 검사."""

import ast
from pathlib import Path
import subprocess
import sys
import unittest

from core.paths import PROJECT_DIR


class ReadApiLayoutTests(unittest.TestCase):
    def test_api_and_mcp_do_not_import_each_other(self):
        for owner, forbidden in (("api", "core.mcp"), ("mcp", "core.api")):
            for path in (PROJECT_DIR / "core" / owner).rglob("*.py"):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    names = ([node.module or ""] if isinstance(node, ast.ImportFrom) else
                             [alias.name for alias in node.names] if isinstance(node, ast.Import) else [])
                    self.assertFalse(any(name == forbidden or name.startswith(forbidden + ".") for name in names), path)

    def test_new_modules_import_without_initializing_policy_or_storage(self):
        script = """
import importlib
from pathlib import Path
from unittest.mock import patch
from core.modules.documents.store import WikiStore
from core.modules.access.policy import AccessPolicy
with patch.object(WikiStore, '__init__', side_effect=AssertionError('storage at import')), \
     patch.object(AccessPolicy, '__init__', side_effect=AssertionError('policy at import')), \
     patch.object(Path, 'mkdir', side_effect=AssertionError('mkdir at import')):
    for name in ('core.api.router', 'core.runtime.application', 'core.runtime.http_cli',
                 'core.runtime.http_security', 'core.modules.documents.listing'):
        importlib.import_module(name)
print('read-api-imports-ok')
"""
        result = subprocess.run([sys.executable, "-B", "-c", script], cwd=PROJECT_DIR,
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "read-api-imports-ok\n")

    def test_cli_requires_explicit_policy_and_root_and_rejects_bad_ports(self):
        for args in ([], ["--access-config", "/unavailable"],
                     ["--access-config", "/unavailable", "--tenant-root", "/unavailable", "--port", "0"]):
            result = subprocess.run([sys.executable, "-B", "-m", "core.runtime.http_cli", *args],
                                    cwd=PROJECT_DIR, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
