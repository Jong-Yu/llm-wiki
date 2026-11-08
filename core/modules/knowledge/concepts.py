"""개념 발견·선택 조회의 공용 서비스. 상태와 공개 계약을 소유하고 책임별 함수에 위임한다."""

# ConceptStore는 문자열 찾기(find)와 명시 대상을 고른 상세 조회(query)의 입구다.
# 발견 목록의 target_ref를 골라 다시 조회하며, 같은 단어만으로 문서 사이 개체/판단을 하나로 합치지 않는다.

from core.modules.knowledge.schema import ConceptValidationError
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.correspondences.contracts import CorrespondenceValidationError
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.contracts import ReviewValidationError
from copy import deepcopy
from . import discovery
from . import projections
from . import queries
from . import references
from . import schema


class ConceptStore:
    """여러 원장과 원문을 명시 범위에서 조합하는 조회 서비스이며 별도 개념 저장소가 아니다."""

    def __init__(self, wiki_store, actor=None, budgets=None):
        self.store = wiki_store
        self.actor = deepcopy(actor or {"user_id": "reader", "tenant": "isolated", "profile_id": "all", "domain": None, "viewpoint": None, "policy_revision": "0" * 64})
        self.reviews = ReviewStore(wiki_store)
        self.correspondences = CorrespondenceStore(wiki_store, self.actor)
        self.budgets = budgets

    def _capture(self, mode, application_context, as_of, profile):
        # 한 요청이 공유할 캡처 객체를 만든다. 다른 요청의 캐시나 관점 상태를 이 서비스에 남기지 않는다.
        from core.modules.knowledge.capture import ConceptCapture
        actor = deepcopy(self.actor)
        if profile is not None:
            if not isinstance(profile, dict) or not set(profile) <= {"profile_id", "domain", "viewpoint"}:
                raise ConceptValidationError("profile must be a selected profile definition")
            actor.update(profile)
        try:
            owner = self.correspondences if actor == self.actor else CorrespondenceStore(self.store, actor)
            return ConceptCapture(self.store, reviews=self.reviews, correspondences=owner, actor=actor, mode=mode,
                                  application_context=application_context, as_of=as_of, budgets=self.budgets)
        except (CorrespondenceValidationError, ReviewValidationError) as error:
            raise ConceptValidationError(str(error)) from error

    def _arguments(self, documents, limit, include_history=None):
        paths = schema.documents(documents, self.store)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ConceptValidationError("limit must be an integer from 1 to 100")
        if include_history is not None and type(include_history) is not bool:
            raise ConceptValidationError("include_history must be boolean")
        return paths

    @staticmethod
    def _tokens(entry):
        return references._tokens(entry)

    def _base_ref(self, entry, kind, layer, snapshot):
        return references._base_ref(self, entry, kind, layer, snapshot)

    def _claim_ref(self, entry, claim, layer, snapshot, *, selector=None, origin=None, historical=False):
        return references._claim_ref(self, entry, claim, layer, snapshot, selector=selector, origin=origin, historical=historical)

    @staticmethod
    def _origin(entry, event, latest):
        return references._origin(entry, event, latest)

    @staticmethod
    def _policy_status(entry, event, latest):
        return references._policy_status(entry, event, latest)

    def _document_matches(self, entry, needle, include_history, omissions=None):
        return discovery._document_matches(self, entry, needle, include_history, omissions)

    @staticmethod
    def _claim_provenance(entry, claim):
        return references._claim_provenance(entry, claim)

    @staticmethod
    def _match(entry, ref, origin, field, string, *, historical=False, current=True, currentness=None, **metadata):
        return references._match(entry, ref, origin, field, string, historical=historical, current=current, currentness=currentness, **metadata)

    def _correspondence_matches(self, result, needle, include_history):
        return discovery._correspondence_matches(self, result, needle, include_history)

    def find(self, text, *, documents=None, include_history=False, application_context=None, as_of=None,
             limit=20, policy_revision=None, profile=None, tenant=None):
        # 문자열과 명시 범위에서 발견 목록을 반환한다. 실제 검색/출처 조립은 discovery.py를 읽는다.
        return discovery.find(self, text, documents=documents, include_history=include_history, application_context=application_context, as_of=as_of, limit=limit, policy_revision=policy_revision, profile=profile, tenant=tenant)

    def explore_search(self, text="", *, kind="all", document=None, cursor=None, limit=20):
        from .ontology_exploration import explore_search
        return explore_search(self, text, kind=kind, document=document, cursor=cursor, limit=limit)

    def explore_neighbors(self, document, entity_id, expected_state_revision, *, cursor=None, limit=20):
        from .ontology_exploration import explore_neighbors
        return explore_neighbors(self, document, entity_id, expected_state_revision, cursor=cursor, limit=limit)

    def glossary(self, document, entity_id, expected_state_revision, *, limit=10):
        from .glossary import glossary
        return glossary(self, document, entity_id, expected_state_revision, limit=limit)

    @staticmethod
    def _anchor_status(anchor, entry):
        return references._anchor_status(anchor, entry)

    def _resolve(self, target, docs, correspondences):
        return references._resolve(self, target, docs, correspondences)

    def _graph_ref_status(self, graph_ref, entry):
        return references._graph_ref_status(self, graph_ref, entry)

    def _endpoint_matches(self, target, anchor, docs, resolution):
        return references._endpoint_matches(self, target, anchor, docs, resolution)

    def query(self, target, *, documents=None, correspondence_ids=None, expansion="none", application_context=None,
              as_of=None, limit=20, policy_revision=None, profile=None, tenant=None):
        # 고른 target을 현재 자료에 대조한다. 대상 선택/직접 확장/완전성 처리는 queries.py에 위임한다.
        return queries.query(self, target, documents=documents, correspondence_ids=correspondence_ids, expansion=expansion, application_context=application_context, as_of=as_of, limit=limit, policy_revision=policy_revision, profile=profile, tenant=tenant)

    def _document_projection(self, entry, selected_event_ids=()):
        return projections._document_projection(self, entry, selected_event_ids)

    @staticmethod
    def _correspondence_projection(detail, selected_event_ids=()):
        return projections._correspondence_projection(detail, selected_event_ids)

    def _contexts(self, docs, actor):
        return projections._contexts(self, docs, actor)

    def _finish(self, result, capture, policy_revision, profile, tenant, requested_as_of, extra_skipped, truncated, *, output_limit):
        return projections._finish(self, result, capture, policy_revision, profile, tenant, requested_as_of, extra_skipped, truncated, output_limit=output_limit)
