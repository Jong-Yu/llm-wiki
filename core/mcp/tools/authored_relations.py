"""독립 관계의 기존 원장·권한·복합 CAS·영수증 계약을 연결하는 MCP 경계."""
from typing import Annotated, Literal

from mcp.types import CallToolResult, ToolAnnotations
from pydantic import Field, JsonValue, StrictStr, ValidationError

from core.api.v1.reviews.relations_router import RelationCreate, RelationUndo
from core.api.v1.reviews.schemas import EventQuery
from core.common.access import access_dict
from core.modules.access.policy import AccessDenied, PolicyError
from core.modules.reviews.relations import RelationStore
from core.modules.reviews.values import actor_basis
from core.modules.ontology.constants import RELATION_PREDICATES
from core.mcp.request_context import _authorized_scope
from core.mcp.results import _access_error, _invoke
from .analysis_jobs import _job_authorizer

AUTHORED_RELATION_TOOLS = {
    "ontology_relation_create", "ontology_relation_undo", "ontology_relation_request",
}
Identifier = Annotated[StrictStr, Field(pattern=r"^[a-f0-9]{32}$")]
Revision = Annotated[StrictStr, Field(pattern=r"^[a-f0-9]{64}$")]
Document = Annotated[StrictStr, Field(min_length=1, max_length=4096)]
Reason = Annotated[StrictStr, Field(min_length=1, max_length=1000)]

# 외부 MCP 클라이언트도 전체 값의 필수 키를 알 수 있게 종류별 입력을 공개한다.
_REPLACEMENT_GUIDE = (
    "A complete directed relation: subject and object are existing machine-graph entity IDs, "
    "not labels, source anchors or new entities. Common fields: subject, predicate, object, qualifiers, context. "
    "qualifiers must contain polarity (positive|negative), modality (asserted|possible|capability|planned|hypothetical), "
    "condition, scope and time; the last three are exact source quotations for source relations or explicit expert "
    "qualifications for policy relations, each string or null. context contains domain (string|null) and viewpoints "
    "(array of business|developer|architecture). For kind=policy these five common fields are the ONLY fields; "
    "context must equal access.domain and [access.viewpoint], or [] when that viewpoint is null. "
    "Do not send evidence or provenance for policy; the server records the Action log. Policy predicates: "
    + ", ".join(sorted(RELATION_PREDICATES)) + ". "
    "kind=source requires a current machine graph with schema_version>=3; this tool does not upgrade older graphs. "
    "For kind=source also include evidence (exact source quote string) and provenance with source_entity "
    "(existing document-type entity ID or null), attributed_to (existing person/organization/system entity ID "
    "or null) and basis (quote string or null). Each non-null source condition/scope/time, context.domain "
    "and provenance.basis must occur verbatim inside this relation's evidence. Preserve all source "
    "qualifications and use predicates supported by the current machine graph's schema_version. "
    "For source schema>=5 maps_to, include mapping={within:existing entity ID,subject_cardinality:'many',"
    "object_cardinality:'many'}; other relations must omit mapping. Never copy normalized quote/location "
    "objects into quote string inputs. Resolve direction from evidence or the user's explicit judgment."
)
Replacement = Annotated[dict[str, JsonValue], Field(description=_REPLACEMENT_GUIDE)]


class _RelationRequest(EventQuery):
    request_id: Identifier


_MODELS = {
    "ontology_relation_create": RelationCreate,
    "ontology_relation_undo": RelationUndo,
    "ontology_relation_request": _RelationRequest,
}


def validate_arguments(name, arguments):
    """Reject extra actor/entity fields and encoded JSON before SDK preprocessing."""
    if name not in _MODELS:
        return True
    if not isinstance(arguments, dict) or "profile" in arguments:
        return False
    try:
        _MODELS[name].model_validate(arguments)
    except (ValidationError, ValueError, TypeError):
        return False
    return True


def _register_authored_relation_tools(server, get_store):
    read = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)
    mutation = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

    def invoke(name, method, document, **fields):
        scope = _authorized_scope.get()
        if scope is None:
            raise AccessDenied()
        actor = access_dict(scope)
        store = get_store()

        def recheck():
            callback = _job_authorizer.get()
            permission = "ontology_policy" if fields["kind"] == "policy" else "ontology_review"
            if callback is None or actor_basis(callback(permission)) != actor_basis(actor):
                raise AccessDenied()

        try:
            if method in {"create", "undo"}:
                recheck()
                fields["before_commit"] = recheck
            return _invoke(store, name, lambda: getattr(RelationStore(store, actor), method)(document, **fields))
        except AccessDenied:
            return _access_error("access_denied")
        except PolicyError:
            return _access_error("access_unavailable")

    @server.tool(annotations=mutation, structured_output=False)
    def ontology_relation_create(
        document: Document, request_id: Identifier, expected_state_revision: Revision,
        kind: Literal["source", "policy"], replacement: Replacement, reason: Reason,
    ) -> CallToolResult:
        """Record an explicitly requested independent relation between existing graph entities.

        source requires ontology_review and real source quotation with all qualifiers;
        policy requires ontology_policy and an explicit expert judgment/reason in the
        selected scope, without invented source evidence. Actor and Action log provenance
        come from the server. Token use or an AI suggestion is not proof of human approval.
        Never create new entities or disguise an existing claim correction as an addition.
        Use latest ontology_review_query state_revision. Same request ID and payload replay
        the receipt; changed payload conflicts. Query the receipt after a lost response;
        do not automatically retry writes. Old-generation additions become pending, not
        inherited approval. Saved cleanup warnings do not mean the mutation failed.
        """
        return invoke("ontology_relation_create", "create", document, request_id=request_id,
                      expected_state_revision=expected_state_revision, kind=kind,
                      replacement=replacement, reason=reason)

    @server.tool(annotations=mutation, structured_output=False)
    def ontology_relation_undo(
        document: Document, request_id: Identifier, event_id: Identifier,
        expected_state_revision: Revision, kind: Literal["source", "policy"], reason: Reason,
    ) -> CallToolResult:
        """Undo a current independent addition through a new retained event, never deletion.

        Requires the addition's kind-specific review/policy permission, latest state CAS,
        and current generation/scope. Read authored_relations and relation_history through
        ontology_review_query first. Pending old judgments cannot be revived or silently
        reapplied. Preserve the request ID to recover an exact receipt after lost response.
        """
        return invoke("ontology_relation_undo", "undo", document, request_id=request_id,
                      event_id=event_id, expected_state_revision=expected_state_revision,
                      kind=kind, reason=reason)

    @server.tool(annotations=read, structured_output=False)
    def ontology_relation_request(document: Document, request_id: Identifier) -> CallToolResult:
        """Recover this user's independent-relation receipt in its exact authorized scope.

        Read permission suffices after mutation permission is revoked. A missing receipt
        does not prove an in-flight mutation was cancelled. This lookup never retries or
        approves a mutation; inspect current authored_relations/relation_history separately.
        """
        return invoke("ontology_relation_request", "request", document, request_id=request_id)
