"""기계 그래프를 생성·공개하고 일관된 원문/그래프 조회를 조립한다.

원문 CAS와 검토 상태 guard는 같은 저장 잠금 안에서 검사한다. 그래프 교체가
완료된 뒤의 임시 파일 정리 경고는 성공 결과이며 자동 재시도의 근거가 아니다."""

# OntologyStore는 기존 WikiStore를 받아 같은 자료 공간과 잠금을 사용한다.
# generate는 전체 그래프를 검증해 교체하고 query는 원문/그래프 버전을 대조해 기계 결과를 읽는다.
# 검토 이력이 있는 문서는 검토 상태 버전도 대조해야 하므로 원문 revision만으로 재생성을 승인하지 않는다.

from hashlib import sha256
import os
from pathlib import Path
import stat
from uuid import uuid4

from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_bytes
from core.modules.documents.store import CleanupFailure, RevisionConflictError, WikiStore
from . import constants
from .capture import capture_bytes, read_graph_bytes
from .connections import connection_documents, connections_snapshot_locked
from .context import _filter_snapshot, selected_context
from .errors import OntologyValidationError, OntologyCorruptError
from .snapshots import _stored_graph, _query_snapshot
from .validation import _items, _graph
from .values import _revision, _text


class OntologyStore:
    """기계 그래프의 공개 서비스: 같은 WikiStore 잠금과 저장 순서를 소유한다.

    검증·캡처·조회 계산은 협력 함수에 맡긴다. 아래 private 진입점은 검토와
    영향 조회가 이미 보유한 잠금 안에서 재사용하므로 잠금을 추가하지 않는다.
    """

    def __init__(self, store: WikiStore):
        self.store = store
        self.ontology_dir = store.data_dir / "_ontology"

    def _path(self, document: str) -> Path:
        self.store._document_path(self.store.wiki_dir, document)
        path = self.ontology_dir / (sha256(document.encode("utf-8")).hexdigest() + ".json")
        self.store._check_path(path)
        return path

    def _read_source(self, document: str):
        path = self.store._document_path(self.store.wiki_dir, document)
        if not stat.S_ISREG(path.stat().st_mode):
            raise OntologyValidationError("source document must be a regular file")
        return self.store.read(document)

    def _read_bytes(self, path: Path):
        """호출자가 가진 잠금 안에서 전체 그래프 바이트를 읽는다."""
        return read_graph_bytes(self, path)

    def generate(self, document: str, expected_revision: str, entities: list, relations: list,
                 relation_candidates=None, *, attributes=None, schema_version=3,
                 expected_state_revision=None, before_commit=None, force_generation=False) -> dict:
        """정확한 원문 판본과 검토 상태를 확인한 뒤 검증된 그래프를 공개한다.

        내부 작업의 before_commit은 같은 저장 잠금 안에서 인자 없이 호출한다.
        원문/상태 CAS와 그래프 검증 뒤, 쓰기나 no-op 성공 전에 최종 입력을
        재검사하며 콜백에서 비재진입 잠금을 다시 획득해서는 안 된다.
        """
        # 전달받은 전체 추출을 검증해 저장한다. expected_revision은 실제 원문 기준이며 before_commit은 같은 잠금에서 실행할 최종 검사 함수다.
        _revision(expected_revision)
        if expected_state_revision is not None:
            _revision(expected_state_revision)
        # Cheap structure/size checks precede acquiring the shared storage lock.
        _items(entities, relations, relation_candidates=relation_candidates,
               attributes=attributes, schema_version=schema_version,
               document=document, source_revision=expected_revision)
        self._path(document)
        cleanup_failures: list[CleanupFailure] = []
        try:
            with self.store._write_lock():
                path = self._path(document)
                source = self._read_source(document)
                if source.revision != expected_revision:
                    raise RevisionConflictError(document, expected_revision, source.revision)
                # Lazy import keeps graph validation reusable by the review ledger.
                # A reviewed document cannot be replaced by an unaware generator.
                from core.modules.reviews.store import ReviewStore
                ReviewStore(self.store).guard_generation(document, expected_state_revision)
                graph = _graph(document, source.revision, entities, relations, source.content,
                               relation_candidates, attributes=attributes, schema_version=schema_version)
                # 기존 그래프 인코더의 옵션까지 보존한다. 이 옵션은 입력 검증을 대신하지 않는다.
                encoded = canonical_json_bytes(graph, allow_nan=True)
                if len(encoded) > constants.MAX_ONTOLOGY_BYTES:
                    raise OntologyValidationError("Generated ontology exceeds the 1 MiB byte limit")
                previous = self._read_bytes(path)
                changed = previous != encoded
                if changed and previous is not None:
                    try:
                        previous_graph, _, _, _, _ = _stored_graph(previous, document)
                    except OntologyCorruptError:
                        # A valid explicit generation can repair derived data.
                        pass
                    else:
                        changed = {k: v for k, v in previous_graph.items()
                                   if k != "generation_id"} != graph
                # 명시적인 새 전체 추출안 적용은 내용이 같아도 새 세대로 만든다.
                # 기본값 False는 기존 MCP의 동일 내용 no-op 동작을 그대로 유지한다.
                if force_generation:
                    changed = True
                if changed:
                    # Unique publication identity prevents A -> B -> A from
                    # accidentally reactivating an older human decision.
                    graph["generation_id"] = uuid4().hex
                    encoded = canonical_json_bytes(graph, allow_nan=True)
                    if len(encoded) > constants.MAX_ONTOLOGY_BYTES:
                        raise OntologyValidationError("Generated ontology exceeds the 1 MiB byte limit")
                # 본문·검토·맥락 변경이 이 검사와 실제 공개 사이에 끼어들 수 없게 한다.
                if before_commit is not None:
                    before_commit()
                if changed:
                    self.store._mkdir(self.ontology_dir)
                    with self.store._staged_file(self.ontology_dir, encoded, cleanup_failures) as staged:
                        os.replace(staged.path, path)
                        staged.consumed = True
        except Exception as error:
            if cleanup_failures:
                error.cleanup_failures = tuple(cleanup_failures)
            raise
        return {
            "document": document, "source_revision": source.revision, "status": "ready",
            "entity_count": len(graph["entities"]), "relation_count": len(graph["relations"]),
            "candidate_count": len(graph.get("relation_candidates", [])),
            "attribute_count": len(graph.get("attributes", [])),
            "changed": changed,
            "graph_revision": sha256(encoded if changed else previous).hexdigest(),
            "layer": "machine", "review_tool": "ontology_review_query",
            "cleanup_failures": cleanup_details(self.store.data_dir, cleanup_failures),
        }

    def query(self, document: str, *, domain=None, viewpoint=None) -> dict:
        """Read a consistent source/cache pair, optionally selecting claim contexts.

        Filters do not provide authorization or establish equivalence between views.
        Stale facts are never returned, and entities remain for reference resolution.
        """
        # 현재 원문에 맞는 기계 그래프만 조회한다. 전문가 판단이 적용된 답은 ReviewStore.query의 effective_graph를 확인한다.
        if domain is not None:
            _text(domain, constants.MAX_EVIDENCE_CHARACTERS, "domain filter")
        if viewpoint is not None and (not isinstance(viewpoint, str) or viewpoint not in constants.VIEWPOINTS):
            raise OntologyValidationError("viewpoint filter must be a supported tag")
        self._path(document)
        with self.store._write_lock():
            path = self._path(document)
            source = self._read_source(document)
            raw = self._read_bytes(path)
            result = _filter_snapshot(_query_snapshot(document, source, raw), domain, viewpoint)
            return {**result, "graph_revision": sha256(raw).hexdigest() if raw else None,
                    "layer": "machine", "review_tool": "ontology_review_query"}

    def _context_bytes(self, path: Path, remaining: list, document: str, component: str, *, max_bytes=None):
        """이미 잠긴 합성 조회에서 같은 가변 바이트 예산을 사용한다."""
        return capture_bytes(self, path, remaining, document, component, max_bytes=max_bytes)

    def context(self, documents: list[str], *, domain=None, viewpoint=None) -> dict:
        """명시한 문서의 전체 원문·그래프와 선택 관점의 참조 그룹을 반환한다."""
        return selected_context(self, documents, domain=domain, viewpoint=viewpoint)

    def _connection_documents(self, skipped: list) -> tuple:
        return connection_documents(self, skipped)

    def _connections_snapshot_locked(self, document: str, limit: int = 20) -> tuple:
        """영향 조회와 공유하는 캡처 결과; 호출자가 가진 잠금을 다시 얻지 않는다."""
        return connections_snapshot_locked(self, document, limit)

    def connections(self, document: str, limit: int = 20) -> dict:
        """Read machine links/candidates using the shared bounded snapshot."""
        # 연결 조회에서도 WikiStore의 공유 잠금을 사용한다. 별도 저장소에서 다른 시점의 그래프를 섞지 않는다.
        with self.store._write_lock():
            result, _ = self._connections_snapshot_locked(document, limit)
        return result
