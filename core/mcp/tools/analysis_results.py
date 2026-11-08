"""고정 입력의 분석 결과 저장과 영수증 조회를 기존 저장 서비스에 연결한다."""

# 이 파일은 AI 클라이언트가 호출할 '입구'다. 입력 형태와 권한 문맥을 확인해
# ResultStore에 넘기며, 실제 저장 순서는 modules/analysis_results/store.py에 있다.
# 함수 안의 영어 설명문은 AI에 공개되는 도구 계약이라 그대로 유지한다.

from mcp.types import CallToolResult, ToolAnnotations
from pydantic import Field, JsonValue, StrictBool, StrictStr
from typing import Annotated, Literal

from core.mcp.request_context import _authorized_scope
from core.mcp.results import _access_error, _invoke
from core.mcp.schemas import SourceRevisionInput
from core.mcp.validation import validate_model_arguments
from core.mcp.tools.extraction import Identifier, InputModel, MAX_TOOL_BYTES, _authorize
from core.modules.access.policy import AccessDenied, PolicyError


RESULT_TOOLS = frozenset({"analysis_job_wiki_write", "analysis_job_ontology_generate", "analysis_job_result_query"})
# Annotated는 자료형에 검증 조건을 붙인다. StrictStr는 숫자를 문자열로 자동 바꾸지 않는다.
Document = Annotated[StrictStr, Field(min_length=1, max_length=4096)]


class ResultQuery(InputModel):
    # Pydantic 입력 모델: 어떤 필드를 받을지 선언하면 SDK 전처리 전에 그 형태를 검사할 수 있다.
    job_id: Identifier
    request_id: Identifier
    response_mode: Literal["full", "compact"] = "full"


class ResultSubmit(ResultQuery):
    # 상속하므로 ResultQuery의 job_id/request_id에 아래 필드를 추가해 함께 받는다.
    run_id: Identifier
    expected_job_revision: SourceRevisionInput
    bundle_id: Identifier
    bundle_revision: SourceRevisionInput
    document: Document
    # AI를 실행한 클라이언트의 자기신고 정보다. 실제 계정/모델 실행 또는 사람 승인의 증명이 아니다.
    execution: dict[str, JsonValue] | None = None
    diagnostics: dict[str, JsonValue] | None = None
    save: StrictBool = True


class WikiSubmit(ResultSubmit):
    content: StrictStr
    # A | None은 A 형식 또는 None을 허용한다는 뜻이다. =None이 없으므로 필드 자체는 필수다.
    expected_revision: SourceRevisionInput | None


class OntologySubmit(ResultSubmit):
    expected_revision: SourceRevisionInput
    expected_state_revision: SourceRevisionInput | None = None
    # 공통 제출의 필수 qualifiers는 기본값을 채우기 전 원시 JSON에서 검증한다.
    submission: dict[str, JsonValue]


_MODELS = {"analysis_job_wiki_write": WikiSubmit,
           "analysis_job_ontology_generate": OntologySubmit, "analysis_job_result_query": ResultQuery}


def validate_arguments(name, arguments):
    """SDK 전처리 전에 JSON 타입·추가 필드·총 바이트를 검사한다."""
    return validate_model_arguments(name, arguments, _MODELS, maximum=MAX_TOOL_BYTES)


def _register_result_tools(server, get_store):
    # ToolAnnotations는 클라이언트에 읽기/변경 동작을 안내한다. 실제 허가는 서버의 정책이 판단한다.
    read_only = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)
    mutation = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

    def invoke(operation, action, response_mode="full"):
        # 현재 요청에 연결된 scope에는 서버가 확인한 사용자/tenant/저장소가 들어 있다.
        scope = _authorized_scope.get()
        if scope is None:
            return _access_error("access_denied")
        from core.modules.analysis_results.store import ResultStore
        try:
            store = get_store()
            # lambda는 서비스를 실행할 짧은 함수다. _invoke가 공통 성공/오류 응답 형식으로 감싼다.
            return _invoke(store, operation, lambda: action(ResultStore(store, server.rulesets), scope),
                           response_mode=response_mode)
        except AccessDenied:
            return _access_error("access_denied")
        except PolicyError:
            return _access_error("access_unavailable")

    # @로 시작하는 데코레이터가 바로 아래 함수를 MCP 도구로 등록한다.
    # -> CallToolResult는 반환값의 자료형을 설명하는 표기다.
    # prepare_wiki 입력에서 작성한 전체 위키를 저장한다. 입력/권한 재확인·이력 보존·영수증 처리는 ResultStore가 맡는다.
    @server.tool(annotations=mutation, structured_output=False)
    def analysis_job_wiki_write(job_id: Identifier, run_id: Identifier,
            expected_job_revision: SourceRevisionInput, bundle_id: Identifier,
            bundle_revision: SourceRevisionInput, request_id: Identifier, document: Document,
            content: StrictStr, expected_revision: SourceRevisionInput | None,
            execution: dict[str, JsonValue] | None = None,
            diagnostics: dict[str, JsonValue] | None = None, save: StrictBool = True,
            response_mode: Literal["full", "compact"] = "full") -> CallToolResult:
        """Save one complete Wiki result against its exact prepare_wiki input.

        response_mode=compact omits successful checker explanations while retaining
        receipts, diagnostics, warnings and all failed/not-run checks. For details
        query analysis_job_result_query with response_mode=full and this request_id.
        Use the source revision captured in the bundle; null creates only an absent
        document. The server rechecks permission, source/context, live run and rules
        inside the save boundary and preserves full previous versions. A successful
        Wiki save is not graph storage or semantic approval. After uncertainty query
        this request's receipt instead of repeating the write with a new request ID.
        diagnostics follows the published diagnostics.schema.json and is retained
        separately from content. save=false preserves the draft/report only; it
        never updates Wiki or certifies semantic correctness or human approval.
        """
        return invoke("analysis_job_wiki_write", lambda results, scope: results.write_wiki(
            job_id, tenant=scope.tenant, user_id=scope.user_id, run_id=run_id,
            expected_job_revision=expected_job_revision, bundle_id=bundle_id,
            bundle_revision=bundle_revision, request_id=request_id, document=document,
            content=content, expected_revision=expected_revision, execution=execution,
            diagnostics=diagnostics, save=save, authorize=_authorize), response_mode)

    # 실제 위키에 묶인 원시 그래프를 제출한다. 기본값 적용 전 검사와 전체 저장은 ResultStore가 처리한다.
    @server.tool(annotations=mutation, structured_output=False)
    def analysis_job_ontology_generate(job_id: Identifier, run_id: Identifier,
            expected_job_revision: SourceRevisionInput, bundle_id: Identifier,
            bundle_revision: SourceRevisionInput, request_id: Identifier, document: Document,
            expected_revision: SourceRevisionInput, submission: dict[str, JsonValue],
            expected_state_revision: SourceRevisionInput | None = None,
            execution: dict[str, JsonValue] | None = None,
            diagnostics: dict[str, JsonValue] | None = None, save: StrictBool = True,
            response_mode: Literal["full", "compact"] = "full") -> CallToolResult:
        """Store a complete raw graph submission from the exact extract_ontology input.

        response_mode=compact omits only successful checker explanations; receipts,
        diagnostics and failed/not-run checks remain. Read this request_id through
        analysis_job_result_query with response_mode=full for full details.
        Supply schema_version, entities, relations, relation_candidates and attributes
        with all five qualifier keys explicitly present. Quotes must come from the
        fixed Wiki body, not Front Matter or context documents. Its body_start_line
        maps body positions to full-file evidence lines; expected_revision remains
        the full-file revision, never body_revision. Preserve all profile contexts.
        Current source/state, permission, rules and input dependencies are rechecked
        before replacement. Automatic validation and storage leave claims unreviewed;
        they do not certify semantics or human approval. A graph failure never retries
        an already successful Wiki save. Query the request receipt after uncertainty.
        Put omissions and semantic findings in diagnostics, never in submission.
        Use the published diagnostics.schema.json. These are client reports, not
        review decisions. save=false retains a draft without replacing the graph.
        New releases accept diagnostic v2 with one pass/fail/not_run/not_applicable/error
        result for every R-S01..10. A separate semantic check carries its exact
        bundle, rules, source and submission hashes plus client execution records.
        Submit that report with save=false under a distinct request_id before any
        explicit graph save. The server never runs a model or certifies these opinions.
        """
        return invoke("analysis_job_ontology_generate", lambda results, scope: results.generate_ontology(
            job_id, tenant=scope.tenant, user_id=scope.user_id, run_id=run_id,
            expected_job_revision=expected_job_revision, bundle_id=bundle_id,
            bundle_revision=bundle_revision, request_id=request_id, document=document,
            expected_revision=expected_revision, expected_state_revision=expected_state_revision,
            submission=submission, execution=execution, diagnostics=diagnostics, save=save,
            authorize=_authorize), response_mode)

    # 제출 hash·검사 보고·영수증·현재 출력 상태를 조회한다. 확인 대기 요청을 다시 저장하지 않는다.
    @server.tool(annotations=read_only, structured_output=False)
    def analysis_job_result_query(job_id: Identifier, request_id: Identifier,
            response_mode: Literal["full", "compact"] = "full") -> CallToolResult:
        """Read your retained submission reference, validation report and storage receipt without retrying.

        response_mode=compact omits only successful checker explanations and keeps
        current output, receipt, diagnostics and all failed/not-run checks intact.
        Read permission and job ownership are required. Expired or cancelled runs and
        revoked rules do not hide an existing result. pending_reconcile means storage
        completion is not confirmed; a matching content hash alone proves no request.
        validation_report.rule_results are server structure/citation checks;
        diagnostics.semantic.rule_results are client-reported meaning checks.
        Legacy reports without per-rule results must not be treated as per-rule passes.
        """
        return invoke("analysis_job_result_query", lambda results, scope: results.query(
            job_id, tenant=scope.tenant, user_id=scope.user_id, request_id=request_id, authorize=_authorize), response_mode)
