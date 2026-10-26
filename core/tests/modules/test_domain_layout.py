"""업무 패키지 분리 후 import·호환 타입·공유 잠금의 경계를 검증한다."""

import ast
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


from core.paths import PROJECT_DIR


class DomainLayoutTests(unittest.TestCase):
    def test_domains_import_without_transport_or_storage_initialization(self):
        script = """
import importlib
import importlib.abc
import pkgutil
import sys
from pathlib import Path
from unittest.mock import patch
from core.modules.documents.store import WikiStore

class RejectTransport(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        prefixes = ('mcp', 'fastapi', 'core.mcp', 'core.api', 'core.runtime')
        if any(fullname == p or fullname.startswith(p + '.') for p in prefixes):
            raise AssertionError('business module imported transport/runtime: ' + fullname)
        return None

sys.meta_path.insert(0, RejectTransport())
blocked = AssertionError('import must not initialize storage or directories')
with patch.object(WikiStore, '__init__', side_effect=blocked), \\
     patch.object(Path, 'mkdir', side_effect=blocked):
    import core.storage
    import core.anchors
    import core.reviews
    import core.modules.documents
    import core.modules.access
    import core.modules.ontology
    import core.modules.correspondences
    import core.modules.reviews
    import core.modules.knowledge
    for package in (core.modules.documents, core.modules.access,
                    core.modules.ontology, core.modules.correspondences,
                    core.modules.reviews, core.modules.knowledge):
        for module in pkgutil.walk_packages(package.__path__, package.__name__ + '.'):
            importlib.import_module(module.name)
print('domain-imports-ok')
"""
        result = subprocess.run(
            [sys.executable, "-B", "-c", script], cwd=PROJECT_DIR,
            capture_output=True, text=True, timeout=20,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "domain-imports-ok\n")

    def test_consumers_and_retained_compatibility_share_canonical_classes(self):
        from core.modules.reviews.store import OntologyStore
        from core.mcp.results import OntologyCorruptError
        from core.modules.knowledge.concepts import CorrespondenceStore
        from core.modules.knowledge.capture_correspondences import _Capture
        from core.modules.correspondences.capture import CorrespondenceValidationError
        from core.modules.ontology.store import OntologyStore as CurrentOntologyStore
        from core.modules.ontology.errors import OntologyCorruptError as CurrentOntologyError
        from core.modules.correspondences.store import CorrespondenceStore as CurrentCorrespondenceStore
        from core.modules.correspondences.capture import _Capture as CurrentCapture
        from core.modules.correspondences.contracts import CorrespondenceValidationError as CurrentError
        from core.modules.knowledge.capture_correspondences import _CorrespondenceCapture
        from core.reviews import ReviewStore, ReviewValidationError
        from core.mcp.tools.concepts import ConceptStore
        from core.modules.knowledge.capture import ConceptCapture
        from core.mcp.results import ConceptValidationError
        from core.mcp.tools.ontology import ImpactStore
        from core.modules.reviews.store import ReviewStore as CurrentReviewStore
        from core.modules.reviews.contracts import ReviewValidationError as CurrentReviewError
        from core.modules.knowledge.concepts import ConceptStore as CurrentConceptStore
        from core.modules.knowledge.capture import ConceptCapture as CurrentConceptCapture
        from core.modules.knowledge.schema import ConceptValidationError as CurrentConceptError
        from core.modules.knowledge.impact import ImpactStore as CurrentImpactStore
        from core.storage import WikiStore, RevisionConflictError
        from core.modules.documents.store import WikiStore as CurrentWikiStore
        from core.modules.documents.store import RevisionConflictError as CurrentConflict
        from core.anchors import normalize_anchor
        from core.modules.ontology.anchors import normalize_anchor as current_normalize_anchor

        self.assertIs(OntologyStore, CurrentOntologyStore)
        self.assertIs(OntologyCorruptError, CurrentOntologyError)
        self.assertIs(CorrespondenceStore, CurrentCorrespondenceStore)
        self.assertIs(CorrespondenceValidationError, CurrentError)
        self.assertIs(_Capture, CurrentCapture)
        self.assertIs(_CorrespondenceCapture.__bases__[0], CurrentCapture)
        self.assertIs(ReviewStore, CurrentReviewStore)
        self.assertIs(ReviewValidationError, CurrentReviewError)
        self.assertIs(ConceptStore, CurrentConceptStore)
        self.assertIs(ConceptCapture, CurrentConceptCapture)
        self.assertIs(ConceptValidationError, CurrentConceptError)
        self.assertIs(ImpactStore, CurrentImpactStore)
        self.assertIs(WikiStore, CurrentWikiStore)
        self.assertIs(RevisionConflictError, CurrentConflict)
        self.assertIs(normalize_anchor, current_normalize_anchor)

    def test_business_and_transport_code_do_not_depend_on_tests(self):
        # 검증 도구의 합성 입력은 tests에 둘 수 있지만 실제 업무/전송이 의존해서는 안 된다.
        paths = [*PROJECT_DIR.glob("core/modules/**/*.py"),
                 *PROJECT_DIR.glob("core/mcp/**/*.py"),
                 *PROJECT_DIR.glob("core/runtime/**/*.py")]
        imports = []
        for path in paths:
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.Import):
                    imports.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    imports.append(node.module or "")
        self.assertFalse([name for name in imports
                          if name == "tests" or name.startswith("tests.")
                          or name == "core.tests" or name.startswith("core.tests.")
                          or name.startswith("core.test_")])

    def test_delegated_operations_keep_one_tenant_lock(self):
        from core.modules.documents.store import WikiStore
        from core.modules.ontology.store import OntologyStore
        from core.modules.correspondences.store import CorrespondenceStore
        from core.modules.reviews.store import ReviewStore
        from core.modules.knowledge.concepts import ConceptStore
        from core.modules.knowledge.impact import ImpactStore
        from core.tests.modules.test_correspondences import correspondence_actor, correspondence_fixture

        with TemporaryDirectory() as directory:
            wiki = WikiStore(directory)
            original_lock = wiki._write_lock
            held = False
            acquisitions = 0

            @contextmanager
            def nonreentrant_lock():
                nonlocal held, acquisitions
                self.assertFalse(held, "delegation must not reacquire the tenant lock")
                held = True
                acquisitions += 1
                try:
                    with original_lock():
                        yield
                finally:
                    held = False

            with patch.object(wiki, "_write_lock", nonreentrant_lock):
                draft = correspondence_fixture(wiki)
                ontology = OntologyStore(wiki)
                source = wiki.read("a.md")
                ontology.generate("a.md", source.revision, [{
                    "id": "stock", "label": "판매 가능 재고", "type": "concept",
                    "evidence": source.content.strip(),
                }], [])
                ontology.query("a.md")
                ontology.context(["a.md", "b.md"])
                ontology.connections("a.md")
                correspondences = CorrespondenceStore(wiki, correspondence_actor())
                prepared = correspondences.query(draft=draft)
                result = correspondences.propose(
                    prepared["correspondence_id"], prepared["draft"],
                    prepared["state_revision"], "격리된 합성 제안",
                )
                current = correspondences.query(result["correspondence_id"])
                accepted = correspondences.review(
                    result["correspondence_id"], "accept", current["state_revision"],
                    "격리된 합성 검토",
                )
                self.assertIn("event_id", accepted)
                reviews = ReviewStore(wiki)
                reviewed = reviews.query("a.md")
                concepts = ConceptStore(wiki, actor=correspondence_actor())
                concepts.find("상품", documents=["a.md", "b.md"])
                anchor = draft["condition"]
                concepts.query({
                    "kind": "anchor", "anchor": anchor,
                    "observation": {"source_revision": anchor["source_revision"],
                                    "history_revision": reviewed["history_revision"]},
                }, correspondence_ids=[result["correspondence_id"]], expansion="direct_confirmed")
                ImpactStore(wiki).query("a.md")
            self.assertFalse(held)
            self.assertGreaterEqual(acquisitions, 10)


if __name__ == "__main__":
    unittest.main()
