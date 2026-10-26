"""전송 코드 분리 후 import 부작용과 공통 검색의 독립성을 검증한다."""

import ast
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from core.modules.documents.search import search_documents
from core.modules.documents.store import WikiStore


from core.paths import PROJECT_DIR


class MCPLayoutTests(unittest.TestCase):
    def test_adapter_imports_do_not_open_stores_or_start_servers(self):
        # 새 프로세스에서 검사해야 이미 import한 모듈의 cache가 부작용을 숨기지 않는다.
        script = """
import importlib
import pkgutil
from pathlib import Path
from unittest.mock import patch
from core.modules.access.policy import AccessPolicy
from core.modules.documents.store import WikiStore
from mcp.server import MCPServer
import uvicorn

blocked = AssertionError('import must not initialize storage, policy or servers')
with patch.object(WikiStore, '__init__', side_effect=blocked), \\
     patch.object(AccessPolicy, '__init__', side_effect=blocked), \\
     patch.object(Path, 'mkdir', side_effect=blocked), \\
     patch.object(MCPServer, '__init__', side_effect=blocked), \\
     patch.object(MCPServer, 'run', side_effect=blocked), \\
     patch.object(uvicorn, 'run', side_effect=blocked):
    import core.mcp_server
    import core.mcp
    import core.runtime.mcp_cli
    for module in pkgutil.walk_packages(core.mcp.__path__, 'core.mcp.'):
        importlib.import_module(module.name)
print('imports-ok')
"""
        result = subprocess.run(
            [sys.executable, "-B", "-c", script], cwd=PROJECT_DIR,
            capture_output=True, text=True, timeout=20,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "imports-ok\n")

    def test_search_preserves_content_and_caller_error_codes(self):
        with TemporaryDirectory() as directory:
            store = WikiStore(directory)
            store.save("blocked.md", "상품", expected_revision=None)
            store.save("readable.md", "Straße 상품\n", expected_revision=None)
            before = {p.relative_to(store.data_dir): p.read_bytes()
                      for p in store.data_dir.rglob("*") if p.is_file()}
            read = store.read
            denied = PermissionError("synthetic read failure")
            classify = Mock(return_value="read_blocked")

            def read_selected(document):
                if document == "blocked.md":
                    raise denied
                return read(document)

            with patch.object(store, "read", side_effect=read_selected):
                result = search_documents(store, "상품", 20, read_error_code=classify)

            self.assertEqual(result["skipped"], [{"document": "blocked.md", "code": "read_blocked"}])
            self.assertEqual(result["matches"], [{
                "document": "readable.md", "revision": read("readable.md").revision,
                "snippet": "Straße 상품",
            }])
            self.assertEqual(result["scanned"], 2)
            self.assertFalse(result["truncated"])
            classify.assert_called_once_with(denied)
            after = {p.relative_to(store.data_dir): p.read_bytes()
                     for p in store.data_dir.rglob("*") if p.is_file()}
            self.assertEqual(before, after)

    def test_business_search_does_not_import_transport_or_runtime(self):
        # 이 경계를 지켜야 FastAPI가 MCP 코드를 거치지 않고 검색을 재사용할 수 있다.
        path = PROJECT_DIR / "core" / "modules" / "documents" / "search.py"
        tree = ast.parse(path.read_text())
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                imports.append(node.module or "")
            elif isinstance(node, ast.Import):
                imports.extend(name.name for name in node.names)
        blocked = ("core.mcp", "core.runtime", "core.api", "mcp", "fastapi")
        self.assertFalse([name for name in imports
                          if any(name == prefix or name.startswith(prefix + ".")
                                 for prefix in blocked)])


if __name__ == "__main__":
    unittest.main()
