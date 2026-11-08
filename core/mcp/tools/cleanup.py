"""Authenticated MCP adapters: identical preview, explicit selection, receipts and undo."""
from typing import Annotated
from mcp.types import CallToolResult, ToolAnnotations
from pydantic import Field, StrictStr, StrictInt
from core.common.access import access_dict
from core.modules.access.policy import AccessDenied, PolicyError
from core.modules.reviews.cleanup import CleanupStore
from core.modules.reviews.values import actor_basis
from core.mcp.request_context import _authorized_scope
from core.mcp.results import _invoke, _access_error
from core.mcp.schemas import SourceRevisionInput
from .analysis_jobs import _job_authorizer

CleanupId = Annotated[StrictStr, Field(pattern=r"^[a-f0-9]{32}$")]

CLEANUP_TOOLS = {"ontology_cleanup_preview", "ontology_cleanup_apply", "ontology_cleanup_history",
                 "ontology_cleanup_request", "ontology_cleanup_undo"}


def _register_cleanup_tools(server, get_store):
    read = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)
    mutation = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

    def invoke(name, document, method, **fields):
        scope = _authorized_scope.get()
        if scope is None:
            raise AccessDenied()
        actor = access_dict(scope)
        def recheck():
            callback = _job_authorizer.get()
            if callback is None or actor_basis(callback("ontology_review")) != actor_basis(actor):
                raise AccessDenied()
        if method in {"apply", "undo"}:
            fields["before_commit"] = recheck
        store = get_store()
        try:
            return _invoke(store, name, lambda: getattr(CleanupStore(store, actor), method)(document, **fields))
        except AccessDenied:
            return _access_error("access_denied")
        except PolicyError:
            return _access_error("access_unavailable")

    @server.tool(annotations=read, structured_output=False)
    def ontology_cleanup_preview(document: StrictStr, limit: Annotated[StrictInt, Field(ge=1, le=50)] = 20,
                                 cursor: StrictStr | None = None) -> CallToolResult:
        """Read one document's exact cleanup candidates. Does not save or approve anything.

        Use server item_ids/preview_revision and explicitly select items after review.
        Rejected and old source-review entries can be hidden from current lists without
        deleting raw claims, evidence or journals. Deferral/uncertainty is not falsity.
        Exact duplicate claims are already prohibited; never merge similar names.
        Honor pagination and capability reasons. A changed basis requires a new preview.
        """
        return invoke("ontology_cleanup_preview", document, "preview", limit=limit, cursor=cursor)

    @server.tool(annotations=read, structured_output=False)
    def ontology_cleanup_history(document: StrictStr, limit: Annotated[StrictInt, Field(ge=1, le=50)] = 20,
                                 cursor: StrictStr | None = None) -> CallToolResult:
        """Read the validated cleanup audit journal, newest first, with bounded pagination."""
        return invoke("ontology_cleanup_history", document, "history", limit=limit, cursor=cursor)

    @server.tool(annotations=read, structured_output=False)
    def ontology_cleanup_request(document: StrictStr, request_id: CleanupId) -> CallToolResult:
        """Recover this user's exact-scope cleanup receipt after lost response or cancellation.

        Read permission suffices after write permission is revoked. Missing receipt is
        not proof an in-flight operation was cancelled. Never silently submit a new ID.
        """
        return invoke("ontology_cleanup_request", document, "request", request_id=request_id)

    @server.tool(annotations=mutation, structured_output=False)
    def ontology_cleanup_apply(document: StrictStr, request_id: CleanupId, preview_revision: SourceRevisionInput,
                               item_ids: Annotated[list[SourceRevisionInput], Field(min_length=1, max_length=50)], reason: Annotated[StrictStr, Field(min_length=1, max_length=1000)]) -> CallToolResult:
        """Apply only explicitly selected preview item IDs with ontology_review permission.

        Uses one atomic journal save; preserves source, machine evidence and judgments.
        Requires current preview and a unique 32-hex request ID. Exact replay returns the
        receipt without reapplying; changed input under that ID conflicts. After lost
        response query the receipt first. Cleanup warnings mean saved, not retry needed.
        Does not archive expert policies, create rejection, or carry approval to a new generation.
        """
        return invoke("ontology_cleanup_apply", document, "apply", request_id=request_id,
                      preview_revision=preview_revision, item_ids=item_ids, reason=reason)

    @server.tool(annotations=mutation, structured_output=False)
    def ontology_cleanup_undo(document: StrictStr, request_id: CleanupId, event_id: CleanupId,
                              expected_state_revision: SourceRevisionInput,
                              reason: Annotated[StrictStr, Field(min_length=1, max_length=1000)]) -> CallToolResult:
        """Undo a whole cleanup apply via a new event in the same exact authorized scope.

        Requires latest state_revision and ontology_review permission. Restores display
        only where source/judgment is still applicable; never revives old approval or
        changes a newer cleanup. Recover a lost response through the same request ID.
        """
        return invoke("ontology_cleanup_undo", document, "undo", request_id=request_id, event_id=event_id,
                      expected_state_revision=expected_state_revision, reason=reason)
