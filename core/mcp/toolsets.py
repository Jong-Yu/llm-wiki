"""역할별 MCP 도구 묶음(toolset). 업무 안내 카탈로그에서 파생하며 권한을 부여하지 않는다.

MCP 클라이언트는 노출된 모든 도구 정의와 서버 안내를 매 요청 문맥에 싣는다. 전문 역할 하나가
쓰는 도구·업무 안내·표준 prompt만 노출해 그 고정 비용을 줄인다. 인증·tenant·profile·행동 권한
검사는 그대로이며, 묶음 밖 도구는 호출을 거부한다. 기본 all은 기존 전체 노출과 같다.
"""

from dataclasses import dataclass
from typing import Any

from mcp.shared.exceptions import MCPError
from mcp.types import INVALID_PARAMS

from core.mcp.guidance import GUIDANCE_TOOL, catalog, common_instructions


ALL = "all"
ALWAYS_TOOLS = ("access_context", GUIDANCE_TOOL)


@dataclass(frozen=True)
class Toolset:
    name: str
    title: str
    role: str
    economy: str
    tasks: tuple[str, ...]
    extra_tools: tuple[str, ...] = ()
    # 읽기 전용 역할은 전체 파일 사본(content)을 빼고 본문 보기만 기본으로 받는다.
    read_view: str = "full"


TOOLSETS = {
    "ask": Toolset(
        "ask", "질문·조회",
        "Answer questions and look up values from current wiki knowledge. Read-only: it cannot save, review or run jobs.",
        "Spend tokens on evidence, not breadth: choose documents from wiki_search snippets before reading; wiki_read "
        "returns the body view here (pass view=full only when the raw front matter text matters); prepare "
        "knowledge_context_prepare or ontology_review_query only for documents you will cite; for one term prefer "
        "ontology_concept_find or ontology_glossary_query over whole-graph reads; reuse a result already read in this "
        "session while its revision is unchanged instead of reading it again.",
        ("search", "answer", "glossary", "graph", "context", "connections", "versions", "impact", "diagnose"),
        ("ontology_correspondence_find", "ontology_correspondence_query", "ontology_review_queue"),
        read_view="body"),
    "write": Toolset(
        "write", "본문 작성·편집",
        "Create or edit wiki body text and compare or restore versions.",
        "Locate targets with wiki_search instead of reading many documents; read each target once with wiki_read and "
        "edit from that content and revision; inspect wiki_versions metadata before reading full past versions.",
        ("search", "edit", "versions", "restore", "diagnose")),
    "extract": Toolset(
        "extract", "등록·추출",
        "Register originals and run, inspect or cancel analysis and ontology extraction jobs.",
        "Read extraction_rules_read once per ruleset revision and reuse it; use the frozen analysis job input instead "
        "of rereading related wiki documents; check a draft with ontology_validate_draft before submitting it.",
        ("sources", "register", "jobs", "cancel", "results", "extract", "diagnose")),
    "review": Toolset(
        "review", "판단·관계 검토",
        "Record or undo explicitly requested reviews, expert policies, relations, correspondences and Clean Up, "
        "and inspect their impact.",
        "Work on one document's review snapshot at a time; mutation results are compact, so follow their detail_query "
        "only when you need the full snapshot; preview Clean Up before applying it.",
        ("search", "review", "policy", "relations", "correspondences", "impact", "cleanup", "diagnose")),
}
TOOLSET_NAMES = (ALL, *TOOLSETS)


class ToolsetError(ValueError):
    pass


def validate(name: str) -> str:
    if name not in TOOLSET_NAMES:
        raise ValueError("toolset must be one of: " + ", ".join(TOOLSET_NAMES) + ".")
    return name


def tasks(name: str, *, tenant: bool) -> dict:
    """묶음에 속한 업무 안내. all은 현재 서버 종류의 전체 카탈로그다."""
    available = catalog(tenant)
    if name == ALL:
        return available
    return {task: available[task] for task in TOOLSETS[name].tasks if task in available}


def tool_names(name: str, *, tenant: bool) -> frozenset[str] | None:
    """노출할 도구 이름. None은 제한 없음(all)이다."""
    if name == ALL:
        return None
    names = set(ALWAYS_TOOLS) | set(TOOLSETS[name].extra_tools)
    for task in tasks(name, tenant=tenant).values():
        names.update(task.tools if tenant else task.legacy_tools)
    return frozenset(names)


def instructions(name: str, *, tenant: bool) -> str:
    """공통 규칙 + 역할 + 토큰 사용 원칙 + 묶음 업무의 기존 안내 원문만 조립한다."""
    toolset = TOOLSETS[name]
    selected = tasks(name, tenant=tenant)
    lines = [
        common_instructions(tenant),
        f"This connection uses the '{name}' toolset. {toolset.role} Only this role's tools are listed; other work "
        "needs a connection with the matching toolset (" + ", ".join(TOOLSET_NAMES) + ").",
        "Token economy: " + toolset.economy,
        "Workflows:",
    ]
    lines.extend(f"- {task.name}: " + (task.instructions if tenant else task.legacy_instructions)
                 for task in selected.values())
    return "\n".join(lines)


def requested(request: Any) -> str | None:
    """HTTP 요청의 ?toolset= 값. stdio처럼 요청 객체가 없으면 None이다."""
    if request is None:
        return None
    try:
        values = request.query_params.getlist("toolset")
    except AttributeError:
        return None
    if not values:
        return None
    if len(values) != 1 or values[0] not in TOOLSET_NAMES:
        raise ToolsetError("Unknown toolset. Use one of: " + ", ".join(TOOLSET_NAMES) + ".")
    return values[0]


def selected(fixed: str, request: Any) -> str:
    """서버 시작 시 고른 묶음이 우선이며, all 서버에서만 요청별 선택을 허용한다."""
    value = requested(request)
    if value is None or value == fixed:
        return fixed
    if fixed != ALL:
        raise ToolsetError(f"This server is fixed to the '{fixed}' toolset.")
    return value


def context_request(context: Any) -> Any:
    """call_tool/get_prompt 문맥의 HTTP 요청. stdio·직접 호출은 None이다."""
    try:
        return context.request_context.request
    except AttributeError:
        return None


def blocked_message(name: str, tool: str) -> str:
    return (f"{tool} is not available in the '{name}' toolset. Connect with a toolset that includes this work "
            "(" + ", ".join(TOOLSET_NAMES) + ").")


def _guidance_schema(tool: dict, allowed_tasks) -> dict:
    tool = dict(tool)
    schema = dict(tool.get("inputSchema") or {})
    properties = dict(schema.get("properties") or {})
    if "task" in properties:
        task = dict(properties["task"])
        task["enum"] = ["catalog", *allowed_tasks]
        properties["task"] = task
        schema["properties"] = properties
        tool["inputSchema"] = schema
    return tool


def _read_view_schema(tool: dict, view: str) -> dict:
    tool = dict(tool)
    schema = dict(tool.get("inputSchema") or {})
    properties = dict(schema.get("properties") or {})
    if "view" in properties:
        properties["view"] = {**properties["view"], "default": view}
        schema["properties"] = properties
        tool["inputSchema"] = schema
    return tool


class ToolsetMiddleware:
    """초기화 안내와 도구·prompt 목록을 선택한 묶음으로 좁힌다. 호출 거부는 서버 call_tool이 맡는다."""

    def __init__(self, server):
        self.server = server

    async def __call__(self, ctx, call_next):
        if getattr(ctx, "request_id", None) is None:
            # 알림은 응답이 없다. 잘못된 묶음은 같은 연결의 요청(initialize 등)에서 오류로 알린다.
            return await call_next(ctx)
        try:
            name = selected(self.server.toolset, getattr(ctx, "request", None))
        except ToolsetError as error:
            raise MCPError(INVALID_PARAMS, str(error)) from None
        result = await call_next(ctx)
        if name == ALL or not isinstance(result, dict):
            return result
        tenant = bool(getattr(self.server, "guidance_tenant", False))
        method = ctx.method
        if method == "initialize":
            return {**result, "instructions": instructions(name, tenant=tenant)}
        if method == "tools/list":
            allowed = tool_names(name, tenant=tenant)
            allowed_tasks = list(tasks(name, tenant=tenant))
            view = TOOLSETS[name].read_view
            tools = []
            for tool in result.get("tools", []):
                if tool.get("name") not in allowed:
                    continue
                if tool.get("name") == GUIDANCE_TOOL:
                    tool = _guidance_schema(tool, allowed_tasks)
                elif tool.get("name") == "wiki_read" and view != "full":
                    tool = _read_view_schema(tool, view)
                tools.append(tool)
            return {**result, "tools": tools}
        if method == "prompts/list":
            allowed = {"wiki_" + task for task in tasks(name, tenant=tenant)}
            return {**result, "prompts": [item for item in result.get("prompts", []) if item.get("name") in allowed]}
        return result
