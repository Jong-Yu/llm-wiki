"""앱의 고정 CLI가 보호 실행기를 통과하며 임의 명령은 거부되는지 확인한다."""

import asyncio
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from core.runtime import desktop_bridge


class DesktopBridgeCommandTests(unittest.TestCase):
    """운영 자료나 외부 AI 없이 실제 bridge→CLI→PNG 경계를 검사한다."""

    def test_every_app_cli_is_allowed_without_enabling_arbitrary_modules(self):
        root = Path(__file__).resolve().parents[3]
        commands = set()
        for path in (root / "app/src/main/backend").glob("*.ts"):
            commands.update(re.findall(r"['\"](tools\.[a-z_]+_cli)['\"]", path.read_text()))
        self.assertTrue(commands)
        self.assertEqual(commands, desktop_bridge.MODULES)
        for arguments in (["-B", "-m", "os"], ["-c", "print('unexpected')"],
                          ["-B", "-m", "tools.source_preview_cli.evil"]):
            with self.subTest(arguments=arguments), patch.object(desktop_bridge, "_parent_watch") as parent:
                with self.assertRaisesRegex(ValueError, "unsupported_personal_command"):
                    asyncio.run(desktop_bridge.launch(os.getpid(), arguments))
                parent.assert_not_called()

    def _run(self, module, *arguments):
        """stdin 수명을 유지해 Electron의 실제 launch 계약으로 CLI를 실행한다."""
        child = subprocess.Popen(
            [sys.executable, "-B", "-m", "core.runtime.desktop_bridge", "launch",
             "--parent-pid", str(os.getpid()), "--", "-B", "-m", module, *arguments],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=Path(__file__).resolve().parents[3],
        )
        try:
            code = child.wait(timeout=15)
            output = child.stdout.read().decode("utf-8")
            error = child.stderr.read().decode("utf-8")
            self.assertEqual(code, 0, (output, error))
            return output
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()

    def test_image_preview_reaches_real_cli_through_bridge(self):
        with tempfile.TemporaryDirectory(prefix="wiki-bridge-preview-") as directory:
            root = Path(directory)
            Image.new("RGB", (40, 30), "red").save(root / "source.png", format="PNG")
            arguments = ("--work-dir", directory, "--format", "png")
            prepared = json.loads(self._run("tools.source_preview_cli", "prepare", *arguments))
            self.assertTrue(prepared["ok"])
            self.assertEqual(prepared["data"]["pageCount"], 1)
            rendered = json.loads(self._run("tools.source_preview_cli", "render", *arguments,
                                            "--page", "1"))
            self.assertTrue(rendered["ok"])
            with Image.open(root / "page.png") as image:
                self.assertEqual(image.size, (40, 30))
                self.assertEqual(image.convert("RGB").getpixel((20, 15)), (255, 0, 0))

    def test_image_recovery_entrypoint_reaches_parser_without_ai_or_credentials(self):
        output = self._run("tools.source_image_recovery_cli", "--help")
        self.assertIn("--request-file", output)
        self.assertNotIn("desktop_runtime_boundary_failed", output)
