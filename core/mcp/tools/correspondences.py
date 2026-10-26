"""문서 간 대응의 조회·prepare·제안·검토·정책 도구를 등록한다."""
# 서로 다른 문서의 조건과 개념이 어떻게 대응하는지 조회/기록하는 입구다.
# 후보 제안, 원문 근거 검토, 전문가 업무 판단을 각각 다른 동작과 권한으로 처리한다.


from typing import Annotated, Literal

from mcp.types import CallToolResult, ToolAnnotations
from pydantic import Field, StrictInt, StrictStr

from core.modules.access.policy import AccessDenied
from core.modules.correspondences.store import CorrespondenceStore
from core.mcp.request_context import _authorized_scope
from core.mcp.results import _invoke
from core.mcp.schemas import CorrespondenceReasonInput, SourceRevisionInput


# 조회와 변경 도구를 등록한다. 읽기 전용 표시만으로 쓰기 권한이 부여되는 것은 아니다.
def _register_correspondence_tools(server, get_store):
    """D-038 judgments use the existing individually authenticated tenant scope."""
    read_only = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)
    mutation = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

    # 현재 인증 주체를 actor로 구성해 CorrespondenceStore에 전달한다. 호출자가 actor를 임의로 보내지 않는다.
    def invoke(name, method, **arguments):
        store = get_store()
        scope = _authorized_scope.get()
        if scope is None:
            raise AccessDenied()
        actor = {"user_id": scope.user_id, "tenant": scope.tenant, "profile_id": scope.profile_id,
                 "domain": scope.domain, "viewpoint": scope.viewpoint,
                 "policy_revision": scope.policy_revision}
        return _invoke(store, name, lambda: getattr(CorrespondenceStore(store, actor), method)(**arguments))

    # 대응의 판단 상태와 실제 적용 조건·근거 최신성을 함께 조회한다.
    @server.tool(annotations=read_only, structured_output=False)
    def ontology_correspondence_query(
        correspondence_id: StrictStr | None = None, draft: dict | None = None,
        application_context: dict | None = None, as_of: StrictStr = "",
    ) -> CallToolResult:
        """Read a condition-to-concept judgment, or prepare a new unreviewed proposal.

        Supply exactly one correspondence_id or complete draft. A new draft prepare
        returns a server ID, absence CAS and canonical draft without writing a file.
        Draft fields and exact anchors follow docs/DECISIONS.md D-038. Candidate
        endpoints alone do not prove a link. No fake entity, source edit, graph
        merge or human approval is created. Inspect source_proposal, reviews,
        policies, history, decision/applicability, reasons and dependency versions.
        accepted can still need review after evidence changes. Unknown scope,
        missing inputs and expired periods are not current applicable judgments.
        Check complete/truncated/skipped; incomplete reads provide no mutation CAS.
        as_of needs an offset-aware timestamp and only evaluates the current log.
        Before explaining B's surrounding rules also call ontology_review_query for
        B's current policies, conditions and exceptions. Cite each judgment event
        and state_revision separately; this judgment does not approve those rules.
        On conflict reread and reconcile, never exchange tokens on an old payload.
        """
        return invoke("ontology_correspondence_query", "query", correspondence_id=correspondence_id,
                      draft=draft, application_context=application_context, as_of=as_of or None)

    # 조건/개념과 전체 초안을 명시한 기준 버전에 제출한다. 이름의 일치만으로 대응을 확정하지 않는다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_correspondence_propose(
        correspondence_id: StrictStr, draft: dict, expected_state_revision: SourceRevisionInput,
        reason: CorrespondenceReasonInput,
    ) -> CallToolResult:
        """Publish query(draft)'s exact prepared ID/draft as an unreviewed source proposal.

        Requires ontology_write and read. Only candidate/source basis is allowed;
        actor, decisions and approval are server-controlled. Successful storage is
        distinct from semantic correctness or a person's approval. Reconcile a
        conflict using latest evidence. If a response is lost, query this same ID
        to inspect events before deciding what happened; do not create a fresh ID
        or resend a possibly completed proposal. cleanup_failures means saved.
        """
        return invoke("ontology_correspondence_propose", "propose", correspondence_id=correspondence_id,
                      draft=draft, expected_state_revision=expected_state_revision, reason=reason)

    # 수정할 내용과 의존 근거를 먼저 고정해 확인용 토큰을 만든다. 토큰 자체가 변경 권한은 아니다.
    @server.tool(annotations=read_only, structured_output=False)
    def ontology_correspondence_prepare(
        correspondence_id: StrictStr,
        operation: Literal["review", "review_undo", "policy", "policy_undo"], change: dict,
    ) -> CallToolResult:
        """Prepare an existing judgment change without writing or approving it.

        change contains the matching mutation's complete arguments except tenant,
        profile, correspondence_id and expected_state_revision. Capture the union
        of current, replacement and restored-before dependencies, with the exact
        operation/payload digest. Use the returned token only for that change.
        Replacement, policy and both undo calls require this change prepare;
        unchanged-value accept/reject/defer may also use a complete detail token.
        read permission prepares; mutation permission is checked again on save.
        Incomplete or unreadable evidence never grants a mutation token. Confirmed
        missing inputs may permit only rejection, deferral or undo withdrawal.
        """
        return invoke("ontology_correspondence_prepare", "prepare", correspondence_id=correspondence_id,
                      operation=operation, change=change)

    # 현재 상태 버전에서 원문 근거 판단을 새 이벤트로 기록한다. 수정 시 전체 replacement를 전달한다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_correspondence_review(
        correspondence_id: StrictStr, action: Literal["accept", "reject", "defer", "edit"],
        expected_state_revision: SourceRevisionInput, reason: CorrespondenceReasonInput,
        replacement: dict | None = None, decision: Literal["accepted", "deferred"] | None = None,
    ) -> CallToolResult:
        """Record an explicitly requested source-grounded review with ontology_review permission.

        accept requires actual link evidence; candidate endpoint quotes alone do
        not qualify. edit requires a complete replacement and explicit accepted or
        deferred decision with a matching change-prepare token. Reject/defer does
        not assert a contrary fact. This lane cannot override or undo an expert
        policy. The source, graph and old events stay preserved. Authentication is
        not proof of a person's manual approval; scripted judgments are simulations.
        Reconcile conflicts; successful cleanup warnings must not trigger a retry.
        """
        return invoke("ontology_correspondence_review", "review", correspondence_id=correspondence_id,
                      action=action, expected_state_revision=expected_state_revision, reason=reason,
                      replacement=replacement, decision=decision)

    # 기존 이벤트를 지우는 대신 되돌림 이벤트를 추가해 판단의 이력을 보존한다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_correspondence_review_undo(
        correspondence_id: StrictStr, event_id: StrictStr,
        expected_state_revision: SourceRevisionInput, reason: CorrespondenceReasonInput,
    ) -> CallToolResult:
        """Append an inverse event for the latest source review using a change-prepare token.

        Requires ontology_review permission. It cannot delete a proposal, skip a
        later review or undo an expert policy. Restores the exact previous value,
        decision and original evidence baseline; changed evidence leaves a restored
        acceptance pending re-review. Other files and prior events are preserved.
        Reconcile conflicts; never repeat an undo whose storage already succeeded.
        """
        return invoke("ontology_correspondence_review_undo", "review_undo", correspondence_id=correspondence_id,
                      event_id=event_id, expected_state_revision=expected_state_revision, reason=reason)

    # 원문 인용과 구분되는 전문가 업무 판단을 기록한다. 기존 판단 교체 시 대체할 최신 이벤트를 명시한다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_correspondence_policy(
        correspondence_id: StrictStr, replacement: dict,
        expected_state_revision: SourceRevisionInput, reason: CorrespondenceReasonInput,
        judgment_id: StrictStr | None = None, supersedes_event_id: StrictStr | None = None,
    ) -> CallToolResult:
        """Append an explicitly requested expert business judgment with separate ontology_policy permission.

        Requires the exact policy change-prepare token and complete expert-basis
        replacement. Do not provide link evidence, fake provenance, actor or an
        invented approval; this Action log event is the judgment's source. A/B
        source anchors remain required. Business scope comes from the requested
        judgment; policy scope is server-fixed to the selected authorized profile.
        A changed existing judgment requires its judgment_id and explicit latest
        supersedes_event_id in that exact scope. Source proposal/review stays intact.
        Token use is not evidence of a human click; test decisions are simulations.
        Cite event_id and state_revision. Reconcile conflicts and never retry saved
        changes because cleanup or a later query failed.
        """
        return invoke("ontology_correspondence_policy", "policy", correspondence_id=correspondence_id,
                      replacement=replacement, expected_state_revision=expected_state_revision, reason=reason,
                      judgment_id=judgment_id, supersedes_event_id=supersedes_event_id)

    # 전문가 판단을 새 되돌림 이벤트로 취소한다. 과거 기록을 삭제하거나 다른 판단으로 위장하지 않는다.
    @server.tool(annotations=mutation, structured_output=False)
    def ontology_correspondence_policy_undo(
        correspondence_id: StrictStr, event_id: StrictStr,
        expected_state_revision: SourceRevisionInput, reason: CorrespondenceReasonInput,
    ) -> CallToolResult:
        """Append an inverse event for the latest expert judgment in its exact policy scope.

        Requires ontology_policy permission and the matching undo change-prepare
        token. Ordinary review cannot replace this authority. First-policy undo
        restores inactive, never accepts the original source candidate. Restored
        judgments retain their old evidence baseline and need renewed review when
        dependencies changed. No history deletion or cascading undo is performed.
        """
        return invoke("ontology_correspondence_policy_undo", "policy_undo", correspondence_id=correspondence_id,
                      event_id=event_id, expected_state_revision=expected_state_revision, reason=reason)

    # 선택한 허용 문서 안에서 대응을 찾고 조건/시점/범위에 따른 적용 결과를 반환한다.
    @server.tool(annotations=read_only, structured_output=False)
    def ontology_correspondence_find(
        documents: Annotated[list[StrictStr], Field(min_length=1, max_length=8)],
        text: Annotated[StrictStr, Field(max_length=2000)] = "",
        application_context: dict | None = None, as_of: StrictStr = "",
        limit: Annotated[StrictInt, Field(ge=1, le=100)] = 20,
    ) -> CallToolResult:
        """Find bounded precedents referencing selected documents by NFKC/casefold substring.

        Matches paths, statement and endpoint expressions, not semantic identity.
        Inspect scope, results, actual sources, decision/applicability and
        complete/truncated/skipped; empty or partial results never prove no impact.
        Get a mutation token from detailed query/prepare, not this search. A new
        document C needs its own draft prepare/propose and review; reference an
        old event as precedent without importing its approval or executing B's rules.
        """
        return invoke("ontology_correspondence_find", "find", documents=documents, text=text or None,
                      application_context=application_context, as_of=as_of or None, limit=limit)
