"""대응 업무의 공용 API. 실제 검증·읽기·명령은 책임별 모듈에 명시 위임한다."""

# CorrespondenceStore는 저장소·인증된 actor와 공개 함수를 연결하는 입구다.
# queries(조회) → preparation(변경 준비) → commands(기록)의 순서로 읽으면 업무 흐름을 따라갈 수 있다.
# owner/self는 이 Store를 보조 함수에 넘기는 인자이며 각 파일이 제각기 저장소를 새로 만드는 구조가 아니다.

from copy import deepcopy
from core.common.storage_layout import knowledge_root
from core.modules.ontology.storage import existing_path

from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _actor
from . import schema
from . import state, evidence, applicability, preparation, queries, commands
from . import ledger as ledger_ops

class CorrespondenceStore:

    """현재 권한이 확인된 저장소·actor로 대응 업무를 조립하는 공용 진입점."""

    def __init__(self, wiki_store, actor):
        # 서버가 고른 WikiStore와 actor를 받아 같은 저장소의 검토·그래프 기능을 연결한다.
        _actor(actor)
        self.store = wiki_store
        self.actor = deepcopy(actor)
        self.reviews = ReviewStore(wiki_store)
        self.ontology = OntologyStore(wiki_store)
        self.correspondence_dir = knowledge_root(wiki_store.data_dir, "correspondences")
        self.legacy_correspondence_dir = wiki_store.data_dir / "_reviews" / "correspondences"
        self.correspondence_dirs = (self.correspondence_dir, self.legacy_correspondence_dir)

    def _path(self, correspondence_id):
        schema.identifier(correspondence_id, "correspondence_id")
        target = self.correspondence_dir / (correspondence_id + ".json")
        return existing_path(self.store, target, [self.legacy_correspondence_dir / (correspondence_id + ".json")])

    def _snapshot_schema(self, value, documents, lane):
        return ledger_ops._snapshot_schema(self, value, documents, lane)

    def _ledger(self, raw, cid):
        return ledger_ops._ledger(self, raw, cid)

    @staticmethod
    def _inactive(scope):
        return state._inactive(scope)

    @staticmethod
    def _application_context(value):
        return state._application_context(value)

    def _token(self, cid, revision, dependencies, kind, payload):
        return state._token(self, cid, revision, dependencies, kind, payload)

    @staticmethod
    def _complete(dependencies):
        return state._complete(dependencies)

    def _validate_anchor(self, anchor, ctx):
        return evidence._validate_anchor(self, anchor, ctx)

    def _validate_graph(self, document, ref, ctx):
        return evidence._validate_graph(self, document, ref, ctx)

    def _validate_value(self, value, ctx, cid):
        return evidence._validate_value(self, value, ctx, cid)

    @staticmethod
    def _preserve_reference_scope(parent, child):
        return evidence._preserve_reference_scope(parent, child)

    def _structural_applicability(self, snapshot, deps):
        return applicability._structural_applicability(self, snapshot, deps)

    def _applicability(self, snapshot, deps, ctx, stack=None):
        return applicability._applicability(self, snapshot, deps, ctx, stack)

    def _judgments(self, ledger, ctx, cid, stack=None, *, structural=False):
        return applicability._judgments(self, ledger, ctx, cid, stack, structural=structural)

    def _result(self, cid, raw, ledger, ctx, dependencies=None, *, receipt=False):
        return queries._result(self, cid, raw, ledger, ctx, dependencies, receipt=receipt)

    def query(self, correspondence_id=None, draft=None, application_context=None, as_of=None):
        # queries.query에 조회를 위임한다. 내부 helpers의 _ 접두사는 보조 함수 관례이며 접근 권한 표시는 아니다.
        return queries.query(self, correspondence_id, draft, application_context, as_of)

    def _change(self, operation, change):
        return preparation._change(self, operation, change)

    def _plan(self, cid, ledger, operation, change, *, validate_actor=True):
        return preparation._plan(self, cid, ledger, operation, change, validate_actor=validate_actor)

    def _prepared(self, cid, raw, ledger, operation, change, ctx, *, validate=True):
        return preparation._prepared(self, cid, raw, ledger, operation, change, ctx, validate=validate)

    def prepare(self, correspondence_id, operation, change):
        # 변경 내용을 먼저 고정한 읽기 전용 준비 결과를 돌려준다. 이후 실제 변경 때 이 기준을 재검사한다.
        return preparation.prepare(self, correspondence_id, operation, change)

    def _publish(self, cid, encoded, existing, cleanup):
        return ledger_ops._publish(self, cid, encoded, existing, cleanup)

    def _finish(self, cid, ledger, event, ctx, existing, cleanup):
        return ledger_ops._finish(self, cid, ledger, event, ctx, existing, cleanup)

    @staticmethod
    def _cleanup(result, cleanup, store):
        return ledger_ops._cleanup(result, cleanup, store)

    def propose(self, correspondence_id, draft, expected_state_revision, reason):
        # 신규 제안의 전체 값을 commands.propose에 넘긴다. 사실/사용자 승인으로 자동 승격하지 않는다.
        return commands.propose(self, correspondence_id, draft, expected_state_revision, reason)

    def _event(self, eid, sequence, action, lane, judgment, before, after, reason, observed, base, undo, previous_hash):
        return ledger_ops._event(self, eid, sequence, action, lane, judgment, before, after, reason, observed, base, undo, previous_hash)

    def _mutate(self, cid, operation, change, expected):
        return commands._mutate(self, cid, operation, change, expected)

    def review(self, correspondence_id, action, expected_state_revision, reason, replacement=None, decision=None):
        return commands.review(self, correspondence_id, action, expected_state_revision, reason, replacement, decision)

    def review_undo(self, correspondence_id, event_id, expected_state_revision, reason):
        return commands.review_undo(self, correspondence_id, event_id, expected_state_revision, reason)

    def policy(self, correspondence_id, replacement, expected_state_revision, reason, judgment_id=None, supersedes_event_id=None):
        return commands.policy(self, correspondence_id, replacement, expected_state_revision, reason, judgment_id, supersedes_event_id)

    def policy_undo(self, correspondence_id, event_id, expected_state_revision, reason):
        return commands.policy_undo(self, correspondence_id, event_id, expected_state_revision, reason)

    def find(self, documents, text=None, application_context=None, as_of=None, limit=20):
        return queries.find(self, documents, text, application_context, as_of, limit)
