"""파일 재배치가 실행·기본 저장 경로와 import 경계를 바꾸지 않는지 확인한다."""

import inspect
import os
from pathlib import Path
import subprocess
import sys
import unittest

from core.paths import DEFAULT_DATA_DIR, PROJECT_DIR, PROJECT_PYTHON


class LayoutPathTests(unittest.TestCase):
    def test_default_paths_use_project_root_at_every_entry(self):
        from core.modules.documents.store import WikiStore
        from core.runtime import personal_launcher
        from tools import verify_codex

        expected_root = Path(__file__).resolve().parents[3]
        self.assertEqual(PROJECT_DIR, expected_root)
        self.assertEqual(PROJECT_PYTHON, expected_root / ".venv/bin/python")
        self.assertEqual(DEFAULT_DATA_DIR, expected_root / "data")
        self.assertEqual(inspect.signature(WikiStore).parameters["data_dir"].default,
                         DEFAULT_DATA_DIR)
        self.assertEqual(personal_launcher.PROJECT_DIR, PROJECT_DIR)
        self.assertEqual(personal_launcher.PROJECT_PYTHON, PROJECT_PYTHON)
        self.assertEqual(verify_codex.PROJECT_DIR, PROJECT_DIR)

    def test_registered_entrypoints_delegate_to_actual_owners(self):
        from core import mcp_server, personal_launcher
        from core.mcp.server import create_server
        from core.mcp.tenant import create_tenant_server
        from core.runtime import mcp_cli
        from core.runtime.personal_launcher import main

        self.assertIs(personal_launcher.main, main)
        self.assertIs(mcp_server.main, mcp_cli.main)
        self.assertIs(mcp_server.create_server, create_server)
        self.assertIs(mcp_server.create_tenant_server, create_tenant_server)

    def test_runtime_and_manual_tools_import_without_running(self):
        # 별도 프로세스에서 cache 영향을 없애고 실제 CLI/AI 실행·자료 생성을 차단한다.
        script = """
import importlib
from pathlib import Path
from unittest.mock import patch
from core.modules.documents.store import WikiStore
from core.modules.access.policy import AccessPolicy

blocked = AssertionError('import must not initialize or execute')
with patch.object(WikiStore, '__init__', side_effect=blocked), \\
     patch.object(AccessPolicy, '__init__', side_effect=blocked), \\
     patch.object(Path, 'mkdir', side_effect=blocked), \\
     patch('os.execve', side_effect=blocked), \\
     patch('subprocess.run', side_effect=blocked), \\
     patch('subprocess.Popen', side_effect=blocked):
    for name in ('core.runtime.personal_launcher', 'core.personal_launcher',
                 'tools.transition_check', 'tools.verify_answers',
                 'tools.verify_codex', 'tools.verify_ontology', 'tools.verify_transition'):
        importlib.import_module(name)
print('layout-imports-ok')
"""
        result = subprocess.run(
            [sys.executable, "-B", "-c", script], cwd=PROJECT_DIR,
            capture_output=True, text=True, timeout=20,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "layout-imports-ok\n")


if __name__ == "__main__":
    unittest.main()
