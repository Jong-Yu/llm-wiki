"""인증된 tenant의 원문 검토·전문가 정책·되돌림을 기존 원장에 위임한다."""
# 기계 그래프의 주장에 대한 검토/전문가 정책을 기록하는 입구다. 원문 정정은 wiki_write로 처리한다.
# 기계 추출 결과, 원문 기반 판단, 원문 인용 없는 업무 판단의 출처를 섞지 않는다.


from typing import Annotated, Literal

from mcp.types import CallToolResult, ToolAnnotations
from pydantic import Field, StrictStr
from core.common.access import access_dict

from core.modules.access.policy import AccessDenied, PolicyError
from core.mcp.request_context import _authorized_scope
from core.mcp.results import _access_error, _invoke
from core.mcp.schemas import SourceRevisionInput
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import actor_basis
from .analysis_jobs import _job_authorizer


# 검토 조회·변경·되돌림 도구를 같은 ReviewStore에 연결한다.
def _register_review_tools(server, get_store):
    """Review mutations exist only on the individually authenticated tenant server."""
    read_only = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)
    mutation = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

    # 현재 요청의 인증된 사용자/tenant/관점을 꺼낸다. 사용자 입력의 이름을 작성자로 믿지 않는다.
    def actor():
        scope = _authorized_scope.get()
        if scope is None:
            raise AccessDenied()
        return access_dict(scope)

    def guard(permission):
        expected = actor()
        def recheck():
            callback = _job_authorizer.get()
            if callback is None or actor_basis(callback(permission)) != actor_basis(expected):
                raise AccessDenied()
        return recheck

    def invoke(store, operation, action, response_mode):
        try:
            return _invoke(store, operation, action, response_mode=response_mode)
        except AccessDenied:
            return _access_error("access_denied")
        except PolicyError:
            return _access_error("access_unavailable")

    # 기계층에 검토와 전문가 정책을 반영한 effective_graph 및 보류/과거 판단을 함께 읽는다.
    @server.tool(annotations=read_only, structured_output=False)
    def ontology_review_query(
        document: StrictStr,
        domain: Annotated[StrictStr, Field(max_length=1000)] = "",
        viewpoint: Literal["", "business", "developer", "architecture"] = "",
    ) -> CallToolResult:
        """Read current expert policies, effective knowledge and the complete Action log.

        Current review evidence is REQUIRED before answering a document knowledge question,
        including in a fresh AI session. Discover relevant documents with wiki_search,
        then query this tool or knowledge_context_prepare for the selected documents
        in the chosen authorized profile.
        Use effective_graph, policies and pending_history; machine_graph and source
        text alone can omit or contradict authorized expert decisions. Cite the
        decision event_id and state_revision for expert policies, not a fabricated
        source quote. Active expert policies apply only to their exact scope.
        Other-scope and pending policies are visible for context, not current facts.
        Active does not prove a policy's condition/time qualifiers are satisfied;
        preserve them and ask or qualify the answer when the question omits them.
        A changed classification does not imply the old class is logically false.
        Use this snapshot's state_revision before review, undo or regenerating a
        previously reviewed document. State binds source, source history, graph
        and review ledger. Profiles prioritize claims, never hide tenant history.
        Effective claims retain unreviewed machine facts but exclude reject/defer;
        accepted/edited proposals still express a user's judgment, not proven truth.
        Changed source/graph leaves old decisions in history needing renewed review.
        Do not use array positions or transient extraction IDs as editing targets.
        """
        store = get_store()
        return _invoke(store, "ontology_review_query", lambda: ReviewStore(store).query(
            document, domain=domain or None, viewpoint=viewpoint or None,
        ))

    # claim_id와 최신 state_revision으로 주장 하나를 검토한다. AI의 검사 통과만으로 수용 이벤트를 만들지 않는다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_review(
        document: StrictStr, action: Literal["accept", "edit", "reject", "defer"],
        claim_id: SourceRevisionInput, expected_state_revision: SourceRevisionInput,
        reason: Annotated[StrictStr, Field(min_length=1, max_length=1000)],
        replacement: dict | None = None,
        response_mode: Literal["full", "compact"] = "full",
    ) -> CallToolResult:
        """Record an explicitly requested review decision using ontology_review permission.

        response_mode=compact returns the complete changed event and claim, versions,
        pending status and warnings; query ontology_review_query for the full snapshot.
        Read ontology_review_query and source evidence first. Submit its stable
        claim_id and state_revision. Identity, tenant and profile come from server
        authorization, never caller-supplied actor fields. Edit requires the entire
        relation/attribute input, including qualifiers, context and provenance,
        with verbatim source evidence. Candidates need evidence before acceptance.
        This corrects extraction interpretation. For an explicitly requested expert
        business decision without a source quote, use ontology_policy with its
        separate permission. This tool changes only source review; an active expert
        policy stays in effect and is never overridden by an ordinary review.
        Only record a user's actual requested decision; do not invent approvals or
        treat a model simulation as human confirmation. Auth proves a credential,
        not that a person manually performed this action. Conflict requires reread
        and reconciliation. Success with cleanup warnings must not be retried.
        """
        store = get_store()
        return invoke(store, "ontology_review", lambda: ReviewStore(store).review(
            document, action=action, claim_id=claim_id, expected_state_revision=expected_state_revision,
            reason=reason, replacement=replacement, actor=actor(), before_commit=guard("ontology_review"),
        ), response_mode=response_mode)

    # 기존 검토 이벤트를 삭제하지 않고 되돌림을 추가한다. 되돌릴 event_id와 현재 상태 버전이 필요하다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_review_undo(
        document: StrictStr, event_id: StrictStr, expected_state_revision: SourceRevisionInput,
        reason: Annotated[StrictStr, Field(min_length=1, max_length=1000)],
        response_mode: Literal["full", "compact"] = "full",
    ) -> CallToolResult:
        """Undo the latest decision for a claim by appending a new audit event.

        response_mode=compact retains the changed event/claim and state; use
        ontology_review_query for the complete graph and history.
        Requires ontology_review permission and a fresh ontology_review_query
        state_revision. Existing events are never deleted. Changed source/graph
        or a later decision on the same claim prevents unsafe undo. Reconcile
        conflicts; do not merely exchange revision values or retry a saved undo.
        """
        store = get_store()
        return invoke(store, "ontology_review_undo", lambda: ReviewStore(store).undo(
            document, event_id=event_id, expected_state_revision=expected_state_revision,
            reason=reason, actor=actor(), before_commit=guard("ontology_review"),
        ), response_mode=response_mode)

    # 원문 인용이 없는 업무 판단을 별도 권한/이유로 기록한다. 원문에서 추출한 사실처럼 가짜 인용을 붙이지 않는다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_policy(
        document: StrictStr, claim_id: SourceRevisionInput,
        expected_state_revision: SourceRevisionInput,
        reason: Annotated[StrictStr, Field(min_length=1, max_length=1000)],
        replacement: dict,
        entities: list[dict] | None = None,
        response_mode: Literal["full", "compact"] = "full",
    ) -> CallToolResult:
        """Record an explicitly requested expert decision without requiring a source quote.

        response_mode=compact retains the changed event/claim, relevant policies and
        state; use ontology_review_query for the complete graph and history.
        Requires separate ontology_policy permission and a fresh ontology_review_query
        claim_id/state_revision. AI extraction and ordinary review still require source
        evidence. This replaces an existing relation or attribute for the chosen exact
        authorized profile scope. Identity, tenant, profile and audit provenance are
        server-controlled. Do not invent an expert decision or infer approval from
        possessing a token. A scripted test must be identified as a simulation.

        replacement must contain all qualifiers (polarity, modality, condition, scope,
        time) and context (domain, viewpoints), exactly matching access.domain and
        [access.viewpoint], or [] when that viewpoint is null. Relation fields are
        subject, predicate, object, qualifiers, context. Attribute fields are id,
        subject, property, datatype, value, unit, qualifiers, context. Do not send
        evidence or provenance: the Action log is this decision's source. Optional
        entities introduce new concepts as {id, label, type}; their temporary IDs
        may be referenced by replacement and receive server-scoped IDs on save.

        The source and machine graph remain unchanged. Source/generation changes
        make the decision pending re-review rather than silently importing it.
        Conflict requires rereading and reconciling; a successful save with cleanup
        warnings must not be retried. Inspect event_id/state_revision in the result.
        """
        store = get_store()
        return invoke(store, "ontology_policy", lambda: ReviewStore(store).policy(
            document, claim_id=claim_id, expected_state_revision=expected_state_revision,
            reason=reason, replacement=replacement, entities=entities, actor=actor(), before_commit=guard("ontology_policy"),
        ), response_mode=response_mode)

    # 전문가 판단을 되돌리는 새 이벤트를 남긴다. 원문/기계 그래프를 직접 덮어쓰는 기능이 아니다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_policy_undo(
        document: StrictStr, event_id: StrictStr, expected_state_revision: SourceRevisionInput,
        reason: Annotated[StrictStr, Field(min_length=1, max_length=1000)],
        response_mode: Literal["full", "compact"] = "full",
    ) -> CallToolResult:
        """Undo the latest expert policy in its scope with a new Action log event.

        response_mode=compact retains the changed event/claim, relevant policies and
        state; use ontology_review_query for the complete graph and history.
        Requires ontology_policy permission, the matching authorized profile and a
        fresh ontology_review_query state_revision. Existing log entries remain.
        Ordinary ontology_review_undo cannot undo expert policies. Later decisions
        or changed source/generation require reconciliation; never swap revisions
        or retry an already successful undo. This is not source-document editing.
        """
        store = get_store()
        return invoke(store, "ontology_policy_undo", lambda: ReviewStore(store).policy_undo(
            document, event_id=event_id, expected_state_revision=expected_state_revision,
            reason=reason, actor=actor(), before_commit=guard("ontology_policy"),
        ), response_mode=response_mode)
