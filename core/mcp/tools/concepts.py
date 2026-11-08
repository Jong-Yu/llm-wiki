"""개념 발견과 명시적으로 선택한 대상의 통합 조회를 MCP에 연결한다."""
# 문자열로 개념 후보를 찾은 뒤, 선택한 정확한 버전의 대상을 통합 조회하는 도구다.
# 이름이 같아도 같은 개체로 확정하지 않는다. 업무 조건(application_context)과 접근 권한(profile/tenant)은 구분한다.


from typing import Annotated, Literal

from mcp.types import CallToolResult, ToolAnnotations
from pydantic import Field, StrictBool, StrictInt, StrictStr
from core.common.access import access_dict

from core.modules.access.policy import AccessDenied
from core.modules.knowledge.concepts import ConceptStore
from core.mcp.request_context import _authorized_scope
from core.mcp.results import _invoke


# 조회 도구만 등록한다. 발견/조회 결과가 원문·그래프·검토 기록을 바꾸지는 않는다.
def _register_concept_tools(server, get_store):
    """Register D-040 read assembly only on the authenticated tenant server."""
    read_only = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)

    # 서버가 확인한 actor와 선택 관점을 ConceptStore에 전달한다. getattr은 method 이름에 해당하는 함수를 꺼낸다.
    def invoke(name, method, **arguments):
        store = get_store()
        scope = _authorized_scope.get()
        if scope is None:
            raise AccessDenied()
        actor = access_dict(scope)
        return _invoke(store, name, lambda: getattr(ConceptStore(store, actor=actor), method)(
            **arguments, tenant=scope.tenant, policy_revision=scope.policy_revision,
            profile={"profile_id": scope.profile_id, "domain": scope.domain, "viewpoint": scope.viewpoint},
        ))

    # 입력 문자열과 관련된 후보/버전 참조를 찾는다. include_history를 켜면 과거 근거도 현재 근거와 구분해 조회한다.
    @server.tool(annotations=read_only, structured_output=False)
    def ontology_concept_find(
        text: Annotated[StrictStr, Field(min_length=1, max_length=200)],
        documents: Annotated[list[StrictStr], Field(min_length=1, max_length=8)] | None = None,
        include_history: StrictBool = False,
        application_context: dict | None = None, as_of: StrictStr = "",
        limit: Annotated[StrictInt, Field(ge=1, le=100)] = 20,
    ) -> CallToolResult:
        """Discover versioned concept targets, including terms found only in expert decisions.

        Uses literal NFKC/casefold substring matching over source, current graph,
        reviewed knowledge, policy values/entities and correspondence snapshots.
        A matching label or number never establishes identity, a new concept or an
        accepted semantic connection. Inspect match_origin, matched_field, original
        expression, currentness and provenance; choose a returned typed target_ref
        explicitly before ontology_concept_query. Pending/other-scope/inactive and
        historical policy values are diagnostic, never silently current facts.
        include_history explicitly includes bounded old/withdrawn terms; no raw
        Action log text or invented source quote becomes concept knowledge.

        Omitted documents means a bounded tenant scan, not complete semantic
        discovery. Inspect scope, completeness, complete/truncated/skipped and
        resource_manifest. An empty result does not prove knowledge or exceptions
        absent. profile selects policy/view context, not permissions; omitted
        business axes stay unknown. as_of evaluates current records, not an old
        ledger restoration. snapshot_revision/view_revision identify read results,
        not write CAS or authorization. Read only; no extraction, merge or cache.
        """
        return invoke("ontology_concept_find", "find", text=text, documents=documents,
                      include_history=include_history, application_context=application_context,
                      as_of=as_of or None, limit=limit)

    # 발견 결과에서 명시적으로 고른 target을 조회한다. 같은 이름의 다른 대상이나 다른 버전으로 조용히 바꾸지 않는다.
    @server.tool(annotations=read_only, structured_output=False)
    def ontology_concept_query(
        target: dict,
        documents: Annotated[list[StrictStr], Field(min_length=1, max_length=8)] | None = None,
        correspondence_ids: Annotated[list[StrictStr], Field(max_length=8)] | None = None,
        expansion: Literal["none", "direct_confirmed"] = "none",
        application_context: dict | None = None, as_of: StrictStr = "",
        limit: Annotated[StrictInt, Field(ge=1, le=100)] = 20,
    ) -> CallToolResult:
        """Assemble current source, reviewed claims and judgments around one exact typed target.

        Copy target_ref from ontology_concept_find, including versions, snapshots
        and Action log origin refs. Never pass a bare concept name. Version changes
        stop target-centered expansion without silently reselecting a same-name
        entity. Policy-snapshot targets can be read diagnostically when absent from
        effective_graph; that does not insert or activate them.

        Default expansion=none preserves explicit scope. direct_confirmed permits
        one exact, currently applicable D-038 step, retaining direction, scope,
        conditions, exceptions and sources. Dependency-only reads do not expand
        content; candidates, unreviewed/stale/other-scope/conflicting judgments do
        not expand. Name matches, overlapping quotes and numeric inclusion cannot
        merge identities or transfer approval. Explicit precedents stay separate.

        Preserve complete source/graphs, other_context and unclassified constraints
        alongside focus refs. Inspect component status, provenance, decision,
        applicability, pending history, scope and complete/truncated/skipped.
        Effective graphs include unreviewed source claims; active policy status
        does not evaluate free-text conditions/time or an instance's current stock.
        Source quotations and expert Action log citations remain distinct. No
        latest-timestamp winner, inferred reverse classification or automatic
        approval is produced. limit bounds connection/candidate lists, not a
        sliced source or graph. snapshot_revision/view_revision are read hashes;
        before mutation re-read the existing query/prepare and use its own CAS.
        Never send this bundle, focus or map as a replacement ontology graph.
        """
        return invoke("ontology_concept_query", "query", target=target, documents=documents,
                      correspondence_ids=correspondence_ids, expansion=expansion,
                      application_context=application_context, as_of=as_of or None, limit=limit)
