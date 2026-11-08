"""기존 지식 집계의 선택 범위·근거·부분 결과를 보존하는 읽기 전용 MCP 경계."""
from typing import Annotated, Literal

from mcp.types import CallToolResult, ToolAnnotations
from pydantic import Field, StrictInt, StrictStr, ValidationError

from core.api.v1.knowledge.schemas import (
    ClaimSelection, HistoryRequest, QuestionContextRequest, QuestionSource,
    ReviewQueueRequest,
)
from core.api.v1.knowledge.glossary_schemas import GlossaryRequest
from core.common.access import access_dict
from core.modules.access.policy import AccessDenied
from core.modules.knowledge.aggregation import history_query, prepare_question, review_queue
from core.modules.knowledge.concepts import ConceptStore
from core.mcp.request_context import _authorized_scope
from core.mcp.results import _invoke

KNOWLEDGE_QUERY_TOOLS = {
    "knowledge_context_prepare", "ontology_review_queue", "wiki_history_query",
    "ontology_glossary_query",
}
_MODELS = {
    "knowledge_context_prepare": QuestionContextRequest,
    "ontology_review_queue": ReviewQueueRequest,
    "wiki_history_query": HistoryRequest,
    "ontology_glossary_query": GlossaryRequest,
}
Selection = Annotated[list[StrictStr], Field(max_length=8)]
Limit = Annotated[StrictInt, Field(ge=1, le=100)]
Cursor = Annotated[StrictStr, Field(max_length=16384)]
ReviewState = Literal["unreviewed", "defer", "pending"]


def _glossary(store, actor, **fields):
    """현재 허용 범위의 개체 한 건만 용어 설명 자료로 읽는다."""
    return ConceptStore(store, actor=actor).glossary(**fields)


def validate_arguments(name, arguments):
    """Validate original JSON before the MCP SDK can parse encoded collections."""
    if name not in _MODELS:
        return True
    if not isinstance(arguments, dict) or "profile" in arguments:
        return False
    values = dict(arguments)
    try:
        if name != "knowledge_context_prepare" and "cursor" in values:
            if type(values["cursor"]) is not str:
                return False
            values["cursor"] = values["cursor"] or None
        _MODELS[name].model_validate(values)
    except (ValidationError, ValueError, TypeError):
        return False
    return True


def _register_knowledge_query_tools(server, get_store):
    read = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)

    def invoke(name, action, **fields):
        scope = _authorized_scope.get()
        if scope is None:
            raise AccessDenied()
        store = get_store()
        body = _MODELS[name].model_validate(fields)
        return _invoke(store, name, lambda: action(
            store, access_dict(scope), **body.model_dump(exclude={"profile"})))

    @server.tool(annotations=read, structured_output=False)
    def knowledge_context_prepare(
        documents: Selection = [], required_documents: Selection = [],
        claims: Annotated[list[ClaimSelection], Field(max_length=100)] = [],
        source_refs: Annotated[list[QuestionSource], Field(max_length=4)] = [],
    ) -> CallToolResult:
        """Read full selected evidence and current knowledge for a question; never run AI or save.

        Explicitly include required definition/exception documents and exact claim_id,
        state_revision and source version/hash references. Conversion references retain
        the reported page/cell evidence. Stale or unavailable selections stay in skipped;
        can_prepare/complete/truncated describe this bounded selection, not the whole wiki.
        Preserve machine claims, effective judgments, pending history and source quotes
        separately. A current claim is not necessarily approved; a snapshot hash is not
        write CAS, durable storage, or permission for a later action. No automatic approval.
        """
        return invoke("knowledge_context_prepare", prepare_question, documents=documents,
                      required_documents=required_documents, claims=claims, source_refs=source_refs)

    @server.tool(annotations=read, structured_output=False)
    def ontology_glossary_query(
        document: Annotated[StrictStr, Field(min_length=1, max_length=4096)],
        entity_id: Annotated[StrictStr, Field(min_length=1, max_length=4096)],
        expected_state_revision: Annotated[StrictStr, Field(pattern=r"^[0-9a-f]{64}$")],
        limit: Annotated[StrictInt, Field(ge=1, le=20)] = 10,
    ) -> CallToolResult:
        """Read a bounded source-grounded term card for one explicitly selected current entity.

        First find a selectable entity with ontology_concept_find and copy its
        document, entity_id and state_revision into expected_state_revision.
        Keep the same tenant/profile. A name or identifier match does not merge
        entities or establish cross-document equivalence. Refresh the selection
        after catalog_changed; never swap only the revision on an old target.

        The card derives source context, business scope, identifiers and current
        attributes/relations from existing records. Source passages can be mere
        mentions, not definitions. Preserve qualifiers, origin, decision and
        provenance: effective knowledge can be unreviewed, and expert-policy
        events are not source quotations or proof that their conditions hold.
        Check source_passage_status, totals and coverage; omitted items do not
        establish absence. Read the source or ontology_concept_query when more
        context is needed. Do not use this partial card as a replacement graph.

        This optional read does not invoke AI, save a glossary, create review
        work or add input to ordinary chat. Use it when a term needs clarification,
        rather than collecting every term for each question.
        """
        return invoke("ontology_glossary_query", _glossary, document=document,
                      entity_id=entity_id, expected_state_revision=expected_state_revision, limit=limit)

    @server.tool(annotations=read, structured_output=False)
    def ontology_review_queue(
        coverage: Literal["selected", "tenant"] = "selected", documents: Selection = [],
        correspondence_ids: Selection = [],
        states: Annotated[list[ReviewState], Field(min_length=1, max_length=3)] = ["unreviewed", "defer", "pending"],
        limit: Limit = 20, cursor: Cursor = "",
    ) -> CallToolResult:
        """Read unreviewed, deferred and pending items without changing any judgments.

        selected requires explicit documents and optional correspondences; tenant performs bounded
        discovery in the authorized workspace and cannot also select individual resources.
        Keep exact references, revisions, source evidence and judgment origins. Pending
        old judgments are not current approval, and deferral does not establish falsity.
        Honor scope, scope_complete, complete, truncated, skipped and next_cursor. A cursor
        is bound to user/profile, selection and snapshot; changed scope requires a new query.
        Omit cursor or use an empty string to start; JSON null is not a cursor.
        An empty page never proves the absence of all knowledge or review work.
        """
        return invoke("ontology_review_queue", review_queue, coverage=coverage, documents=documents,
                      correspondence_ids=correspondence_ids, states=states, limit=limit, cursor=cursor or None)

    @server.tool(annotations=read, structured_output=False)
    def wiki_history_query(
        coverage: Literal["selected", "tenant"] = "selected", documents: Selection = [],
        correspondence_ids: Selection = [], job_ids: Selection = [],
        limit: Limit = 20, cursor: Cursor = "",
    ) -> CallToolResult:
        """Read bounded document, judgment, correspondence and owned job history together.

        selected requires explicit documents with optional correspondence/job IDs;
        tenant discovers authorized resources and
        the caller's jobs. Historical values and past approval are not current facts.
        Preserve event/version references, actors and origins; inspect scope, pagination,
        complete, scope_complete, truncated and skipped before drawing conclusions.
        Reuse a cursor only in its original access/selection basis; omit it or use an
        empty string to start (not JSON null). No ledger, history,
        approval, job or AI execution is created or changed by this read.
        """
        return invoke("wiki_history_query", history_query, coverage=coverage, documents=documents,
                      correspondence_ids=correspondence_ids, job_ids=job_ids, limit=limit, cursor=cursor or None)
