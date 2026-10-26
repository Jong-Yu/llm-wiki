"""고정 입력 guard의 거부·경합이 원문/이력/그래프를 변경하지 않는 핵심 경계."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from core.modules.documents.store import RevisionConflictError, StorageBusyError, WikiStore
from core.modules.ontology.store import OntologyStore


class GuardRejected(ValueError):
    pass


class AnalysisSaveBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="wiki-save-guard-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = WikiStore(self.root)
        self.other_writer = WikiStore(self.root, lock_timeout_seconds=0)
        self.source = self.store.save("target.md", "모델은 센서를 사용한다.\r\n", expected_revision=None)

    def snapshot(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()}

    def guard(self):
        # 별도 저장 인스턴스도 같은 잠금에 막혀야 사전 검사와 저장 사이에 끼어들지 못한다.
        with self.assertRaises(StorageBusyError):
            self.other_writer.save("competing.md", "다른 쓰기", expected_revision=None)
        raise GuardRejected("input_basis_changed")

    def test_wiki_guard_rejection_and_noop_keep_original_and_full_history(self):
        before = self.snapshot()
        for content in ("새 전체 본문\n", self.store.read("target.md").content):
            with self.subTest(content=content), self.assertRaises(GuardRejected):
                self.store.save("target.md", content, expected_revision=self.source.revision,
                                before_commit=self.guard)
            self.assertEqual(self.snapshot(), before)
        invoked = []
        with self.assertRaises(RevisionConflictError):
            self.store.save("target.md", "오래된 제출", expected_revision="0" * 64,
                            before_commit=lambda: invoked.append(True))
        self.assertEqual(invoked, [])
        saved = self.store.save("target.md", "검증된 새 본문\n", expected_revision=self.source.revision,
                                before_commit=lambda: invoked.append(True))
        self.assertEqual(invoked, [True])
        self.assertEqual(saved.history_path.read_bytes(), "모델은 센서를 사용한다.\r\n".encode())
        self.assertEqual(self.store.read("target.md").content, "검증된 새 본문\n")

    def test_graph_guard_rejection_and_noop_keep_source_history_and_previous_graph(self):
        ontology = OntologyStore(self.store)
        entities = [{"id": "model", "type": "system", "label": "모델", "evidence": "모델"}]
        ontology.generate("target.md", self.source.revision, entities, [])
        before = self.snapshot()
        for proposed in (entities, []):
            with self.subTest(entities=proposed), self.assertRaises(GuardRejected):
                ontology.generate("target.md", self.source.revision, proposed, [], before_commit=self.guard)
            self.assertEqual(self.snapshot(), before)
        invoked = []
        result = ontology.generate("target.md", self.source.revision, entities, [],
                                   before_commit=lambda: invoked.append(True))
        self.assertEqual(invoked, [True])
        self.assertFalse(result["changed"])
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
