"""불변 입력 읽기의 실제 수신 예산과 기존 hash·판본 계약만 확인한다."""

from contextlib import contextmanager
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_inputs import files
from core.modules.analysis_inputs.contracts import InputConflictError, InputCorruptError, InputLimitError
from core.modules.documents.store import WikiStore
from core.modules.sources import files as source_files


class AnalysisInputFileTests(unittest.TestCase):
    def setUp(self):
        """기존 자료 대신 각 검사만 사용하는 임시 폴더를 만든다."""
        temporary = tempfile.TemporaryDirectory(prefix="wiki-input-file-budget-")
        self.addCleanup(temporary.cleanup)
        self.store = WikiStore(temporary.name)
        self.directory = self.store.data_dir / "_test_bundle"

    def snapshot(self):
        """읽기 실패가 보존된 파일을 고치지 않았는지 원래 바이트로 비교한다."""
        return {path.name: path.read_bytes() for path in self.directory.iterdir() if path.is_file()}

    def test_over_budget_stops_reading_and_preserves_stored_bytes(self):
        """합계 초과·거짓 크기·설명서 초과에서 실제 읽은 양도 예산을 지킨다."""
        parts = {str(index): "x" * 300 for index in range(4)}
        manifest = {"components": files.descriptors(parts)}
        files.publish(self.store, self.directory, manifest, parts)
        original_open = source_files.open_regular
        observed = []

        @contextmanager
        def observe(store, path):
            # read의 요청 크기뿐 아니라 실제 반환 바이트를 세어 늦은 검사를 잡는다.
            with original_open(store, path) as stream:
                def read(maximum):
                    raw = stream.read(maximum)
                    observed.append((path.name, len(raw)))
                    return raw
                yield SimpleNamespace(read=read)

        for scenario in ("declared_total", "underreported_size", "manifest_only"):
            with self.subTest(scenario=scenario):
                manifest["components"]["1"]["size_bytes"] = 0 if scenario == "underreported_size" else 300
                raw = canonical_json_bytes(manifest)
                (self.directory / "manifest.json").write_bytes(raw)
                maximum = len(raw) - 1 if scenario == "manifest_only" else len(raw) + 450
                before = self.snapshot()
                observed.clear()
                with patch.object(source_files, "open_regular", observe), self.assertRaises(InputLimitError):
                    files.load(self.store, self.directory, maximum=maximum)
                # 초과 여부 확인용 1바이트 외에는 전체 예산을 넘겨 읽지 않는다.
                self.assertLessEqual(sum(size for _, size in observed), maximum + 1)
                self.assertNotIn("component-2.txt", [name for name, _ in observed])
                self.assertEqual(self.snapshot(), before)

    def test_exact_budget_keeps_utf8_revision_and_hash_checks(self):
        """정상 경계에서는 원래 문자·판본을 읽고 변조된 파일은 그대로 보존한다."""
        parts = {"korean": "조건과 예외 🌱\r\n", "empty": ""}
        manifest = {"components": files.descriptors(parts)}
        raw = canonical_json_bytes(manifest)
        maximum = len(raw) + sum(len(value.encode("utf-8")) for value in parts.values())
        revision = files.publish(self.store, self.directory, manifest, parts, maximum=maximum)
        loaded, text, actual = files.load(self.store, self.directory, expected_revision=revision, maximum=maximum)
        self.assertEqual((loaded, text.encode("utf-8"), actual), (manifest, raw, parts))
        with self.assertRaises(InputConflictError):
            files.load(self.store, self.directory, expected_revision="0" * 64, maximum=maximum)
        path = self.directory / manifest["components"]["korean"]["file"]
        path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n\n"))
        before = self.snapshot()
        with self.assertRaises(InputCorruptError):
            files.load(self.store, self.directory, maximum=maximum)
        self.assertEqual(self.snapshot(), before)
