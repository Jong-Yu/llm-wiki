"""검토 업무의 공용 진입점과 같은 저장소/잠금의 협력 경계를 소유한다.

캡처·원장·값 검증·조회·명령은 명시 협력 함수로 분리한다. private 메서드는
이미 잠긴 온톨로지 생성/통합 조회가 재사용하므로 자체 잠금을 추가하지 않는다.
"""

# ReviewStore는 호출할 함수를 모아 둔 입구다. self는 이 Store 객체이며 보조 모듈에 그대로 전달한다.
# query의 실제 조합은 render.py, 원문 검토 저장은 commands.py, 전문가 판단 저장은 policy_commands.py를 읽는다.
# 이곳의 짧은 return 함수들은 저장 로직을 복제하지 않고 해당 전문 모듈에 위임한다.
from hashlib import sha256
from core.modules.ontology.store import OntologyStore
from . import capture, policy_values, validation, render, commands, policy_commands
from . import ledger as ledger_ops


class ReviewStore:
    """서버가 권한을 검사한 동일 WikiStore로 검토 업무를 조립한다."""

    def __init__(self, store):
        # 전달받은 WikiStore와 같은 자료 공간의 OntologyStore를 연결한다. 사용자별 Store를 이곳에서 추정하지 않는다.
        self.store = store
        self.ontology = OntologyStore(store)
        self.review_dir = store.data_dir / "_reviews"

    def _path(self, document):
        self.store._document_path(self.store.wiki_dir, document)
        path = self.review_dir / (sha256(document.encode("utf-8")).hexdigest() + ".json")
        self.store._check_path(path)
        return path

    def _read_bytes(self, document):
        return capture._read_bytes(self, document)

    def _history_revision(self, document):
        return capture._history_revision(self, document)

    @staticmethod
    def _check_saved_value(document, value, collection, entities, source_revision):
        return validation._check_saved_value(document, value, collection, entities, source_revision)

    @staticmethod
    def _policy_value(value, collection, entities, scope, *, stored=False):
        return policy_values._policy_value(value, collection, entities, scope, stored=stored)

    @classmethod
    def _policy_state(cls, state, event, known):
        return policy_values._policy_state(cls, state, event, known)

    def _ledger(self, raw, document):
        return ledger_ops._ledger(self, raw, document)

    def _snapshot_locked(self, document):
        return capture._snapshot_locked(self, document)

    def _captured_state(self, document, source, graph_raw, ledger_raw, history_revision):
        return capture._captured_state(self, document, source, graph_raw, ledger_raw, history_revision)

    def _query_captured(self, document, source, graph_raw, ledger_raw, history_revision, *, domain=None, viewpoint=None):
        return capture._query_captured(self, document, source, graph_raw, ledger_raw, history_revision, domain=domain, viewpoint=viewpoint)

    def guard_generation(self, document, expected_state_revision=None):
        return capture.guard_generation(self, document, expected_state_revision)

    def _render(self, source, graph_raw, ledger, tokens, domain=None, viewpoint=None, *, policies=True):
        return render._render(self, source, graph_raw, ledger, tokens, domain, viewpoint, policies=policies)

    def _apply_policies(self, result, ledger, domain, viewpoint):
        return render._apply_policies(self, result, ledger, domain, viewpoint)

    def _validate_active_event(self, source, machine, event):
        return validation._validate_active_event(self, source, machine, event)

    def query(self, document, *, domain=None, viewpoint=None):
        # 현재 검토/정책이 적용된 조회 결과를 반환한다. 실제 조립과 잠금은 render.query에 위임한다.
        return render.query(self, document, domain=domain, viewpoint=viewpoint)

    def _normalize(self, source, graph, collection, value):
        return validation._normalize(self, source, graph, collection, value)

    def _validate_effective(self, source, snapshot):
        return validation._validate_effective(self, source, snapshot)

    def _validate_all_layers(self, source, graph_raw, ledger, tokens):
        return validation._validate_all_layers(self, source, graph_raw, ledger, tokens)

    def _commit_locked(self, document, ledger, cleanup_failures):
        return ledger_ops._commit_locked(self, document, ledger, cleanup_failures)

    def _mutate(self, document, *, action, claim_id, event_id, expected_state_revision, reason, actor, replacement, before_commit=None):
        return commands._mutate(
            self, document, action=action, claim_id=claim_id, event_id=event_id,
            expected_state_revision=expected_state_revision, reason=reason,
            actor=actor, replacement=replacement, before_commit=before_commit,
        )

    def review(self, document, *, action, claim_id, expected_state_revision, reason, actor, replacement=None, before_commit=None):
        # claim_id와 읽었던 state_revision을 받아 원문 근거 검토를 기록한다. 실제 저장 절차는 commands.py에 있다.
        return commands.review(
            self, document, action=action, claim_id=claim_id,
            expected_state_revision=expected_state_revision, reason=reason,
            actor=actor, replacement=replacement, before_commit=before_commit,
        )

    def undo(self, document, *, event_id, expected_state_revision, reason, actor, before_commit=None):
        return commands.undo(self, document, event_id=event_id, expected_state_revision=expected_state_revision, reason=reason, actor=actor, before_commit=before_commit)

    def _normalize_policy(self, replacement, entities, snapshot, collection, scope, event_id):
        return policy_values._normalize_policy(self, replacement, entities, snapshot, collection, scope, event_id)

    def _policy_mutate(self, document, *, claim_id, event_id, expected_state_revision, replacement, entities, reason, actor, before_commit=None):
        return policy_commands._policy_mutate(
            self, document, claim_id=claim_id, event_id=event_id,
            expected_state_revision=expected_state_revision, replacement=replacement,
            entities=entities, reason=reason, actor=actor, before_commit=before_commit,
        )

    def policy(self, document, *, claim_id, replacement, expected_state_revision, reason, actor, entities=None, before_commit=None):
        # 원문 근거 검토와 다른 전문가 업무 판단을 policy_commands에 넘긴다. 원장에는 새 이벤트로 보존한다.
        return policy_commands.policy(
            self, document, claim_id=claim_id, replacement=replacement,
            expected_state_revision=expected_state_revision, reason=reason,
            actor=actor, entities=entities, before_commit=before_commit,
        )

    def policy_undo(self, document, *, event_id, expected_state_revision, reason, actor, before_commit=None):
        return policy_commands.policy_undo(self, document, event_id=event_id, expected_state_revision=expected_state_revision, reason=reason, actor=actor, before_commit=before_commit)
