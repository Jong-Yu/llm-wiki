# 실제 Codex CLI가 MCP를 어떤 순서로 호출했는지와 임시 위키의 실제 파일/전체 이력을 비교하는 수동 도구다.
# 검사 결과는 모델의 자기보고가 아니라 기록된 호출·반환값·파일에 근거한다. 실제 실행에는 계정 사용량이 들 수 있다.

"""명시 실행할 때만 개인 CLI의 실제 연결 흐름을 검증하는 도구.

실행에는 모델 사용량이 들 수 있으며 합성 자료와 임시 위키를 사용한다.
일반 서버 기동이나 자동 단위 검사에서 실제 AI 요청을 실행하는 모듈이 아니다.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
from uuid import uuid4


from core.paths import PROJECT_DIR
SERVER_NAME = "llm_wiki"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


# 설정 조회 명령의 stdout을 JSON으로 읽는다. 실제 모델 실행과는 별도의 설정 확인 함수다.
def cli_json(cli: str, *arguments: str, cwd: Path = PROJECT_DIR):
    completed = subprocess.run(
        [cli, *arguments], cwd=cwd, stdin=subprocess.DEVNULL,
        text=True, capture_output=True, timeout=30,
    )
    require(completed.returncode == 0, f"Codex configuration query failed: {completed.stderr[-1500:]}")
    return json.loads(completed.stdout)


# 검증용 CLI를 별도 프로세스 그룹으로 시작한다. 시간 초과에는 자신이 만든 자식 그룹만 정리한다.
def run_cli(command: list[str], timeout: float = 240, cwd: Path = PROJECT_DIR,
            env: dict | None = None) -> subprocess.CompletedProcess:
    # A new process group lets a timed-out run stop its own MCP child as well.
    process = subprocess.Popen(
        command, cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=True, env=env,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


# 기록된 호출 순서/인자/성공 여부와 실제 최신 파일/전체 이력을 대조한다.
def check_transcript(stdout: str, data: Path, document: str, marker: str, contents: list[str],
                     server_name: str = SERVER_NAME) -> dict:
    events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    require(any(event.get("type") == "turn.completed" for event in events), "CLI turn did not complete")
    require(not any(event.get("type") in ("error", "turn.failed") for event in events), "CLI reported a failure")
    items = [event["item"] for event in events if event.get("type") == "item.completed"]
    # Tool discovery and model messages are allowed, but execution must use MCP.
    require(not any(item.get("type") in ("command_execution", "file_change", "error") for item in items),
            "CLI attempted a non-MCP mutation or reported an error")
    calls = [item for item in items if item.get("type") == "mcp_tool_call"]
    require(all(call["server"] == server_name for call in calls), "Unexpected MCP server was called")
    expected_tools = ["wiki_write", "wiki_read", "wiki_write", "wiki_read",
                      "wiki_write", "wiki_write", "wiki_read", "wiki_search"]
    require([call["tool"] for call in calls] == expected_tools, "Required MCP call sequence was not observed")
    revisions = [hashlib.sha256(content.encode("utf-8")).hexdigest() for content in contents]
    payloads = []
    for index, call in enumerate(calls):
        require(call.get("error") is None, f"MCP transport error on call {index}")
        result = call.get("result") or {}
        payload = result.get("structured_content")
        require(isinstance(payload, dict), f"Missing structured MCP result on call {index}")
        require(json.loads(result["content"][0]["text"]) == payload, "Text and structured result differ")
        require(payload.get("ok") is (index != 5), f"Unexpected success/failure on call {index}")
        if index != 7:
            require(call["arguments"]["document"] == document, "Unexpected document was accessed")
        payloads.append(payload)

    for index, version, expected_revision in ((0, 0, None), (2, 1, revisions[0]), (4, 2, revisions[1])):
        require(calls[index]["arguments"]["content"] == contents[version], "Write input content differs")
        require(calls[index]["arguments"]["expected_revision"] == expected_revision, "Write editing base differs")
        require(payloads[index]["revision"] == revisions[version], "Saved revision differs")
        require(payloads[index]["changed"] is True, "Expected write did not change the file")
        require(payloads[index]["cleanup_failures"] == [], "Temporary file cleanup failed")
    require(payloads[0]["history_path"] is None, "Create unexpectedly produced history")
    for index, version in ((1, 0), (3, 1), (6, 2)):
        require(payloads[index]["content"] == contents[version], "Read content differs")
        require(payloads[index]["revision"] == revisions[version], "Read revision differs")

    require(calls[5]["arguments"]["expected_revision"] == revisions[0], "Stale revision was not tested")
    require(payloads[5]["error"]["code"] == "conflict", "Stale edit was not rejected")
    require(payloads[5]["error"]["current_revision"] == revisions[2], "Conflict reported wrong current revision")
    require(calls[7]["arguments"]["query"] == marker, "Search query differs")
    search = payloads[7]
    require(search["truncated"] is False and search["skipped"] == [], "Search was incomplete")
    require(len(search["matches"]) == 1, "Search did not find exactly the test document")
    require(search["matches"][0]["document"] == document, "Search returned the wrong document")
    require(search["matches"][0]["revision"] == revisions[2], "Search returned an old version")

    current = data / "wiki" / document
    require(current.read_bytes() == contents[2].encode("utf-8"), "Actual latest file differs")
    histories = []
    for index, previous in ((2, contents[0]), (4, contents[1])):
        relative = Path(payloads[index]["history_path"])
        require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe history path returned")
        history = (data / relative).resolve(strict=True)
        require(history.is_relative_to(data / "_history"), "History escaped its root")
        require(history.read_bytes() == previous.encode("utf-8"), "Full prior version was not preserved")
        histories.append(history)
    require(len(set(histories)) == 2, "History paths are not distinct")
    history_files = {path for path in (data / "_history").rglob("*.md") if path.is_file()}
    wiki_files = {path for path in (data / "wiki").rglob("*.md") if path.is_file()}
    require(history_files == set(histories), "Unexpected or missing history")
    require(wiki_files == {current}, "Unexpected wiki document")
    require(not list(data.rglob(".wiki-*.tmp")), "Temporary save files remain")
    return {"mcp_calls": len(calls), "history_versions": len(histories), "conflicts": 1,
            "read_write_search": "passed", "latest_revision": revisions[2]}


def verify_legacy(cli: str) -> None:
    configured = cli_json(cli, "mcp", "get", SERVER_NAME, "--json")
    transport = configured["transport"]
    require(configured["enabled"] and transport["type"] == "stdio", "Enable the project's stdio MCP server first")
    require(Path(transport["cwd"]).resolve() == PROJECT_DIR, "Configured server cwd is not this project")
    require(transport["command"] == str(PROJECT_DIR / ".venv/bin/python"), "Unexpected server executable")
    configured_args = transport["args"]
    require(configured_args[:3] == ["-B", "-m", "core.mcp_server"], "Unexpected MCP server entrypoint")
    require(configured_args.count("--data-dir") == 1, "Expected one explicit server data root")
    # Match the live run's feature settings: plugin-generated entries disappear
    # when plugins are disabled and must not become incomplete config tables.
    servers = cli_json(cli, "--disable", "apps", "--disable", "plugins", "mcp", "list", "--json")

    with tempfile.TemporaryDirectory(prefix="llm-wiki-codex-check-") as directory:
        data = Path(directory).resolve()
        temporary_args = configured_args.copy()
        temporary_args[temporary_args.index("--data-dir") + 1] = str(data)
        data_override = "mcp_servers.llm_wiki.args=" + json.dumps(temporary_args)
        effective = cli_json(cli, "-c", data_override, "mcp", "get", SERVER_NAME, "--json")
        require(effective["transport"]["args"] == temporary_args, "Temporary data override was not applied")
        marker = "poc-" + uuid4().hex
        document = f"verification/{marker}.md"
        contents = [f"검증 ID: {marker}\n단계: {number}\n" for number in (1, 2, 3)]
        command = [cli, "exec", "--ephemeral", "--skip-git-repo-check", "--json",
                   "--sandbox", "read-only", "-C", str(PROJECT_DIR)]
        for feature in ("apps", "plugins", "shell_tool", "multi_agent"):
            command.extend(["--disable", feature])
        # Keep the CLI's code-mode host: this build needs it to dispatch tools.
        for server in servers:
            if server["name"] != SERVER_NAME and server["enabled"]:
                # The CLI splits dotted override keys literally; quoted names
                # would create a different, incomplete server configuration.
                require(re.fullmatch(r"[A-Za-z0-9_-]+", server["name"]) is not None,
                        "Cannot isolate this MCP server name with a CLI override")
                command.extend(["-c", f'mcp_servers.{server["name"]}.enabled=false'])
        command.extend(["-c", data_override])
        # User-authorized fixture writes only, for this invocation. The saved
        # project configuration keeps its normal write-confirmation policy.
        command.extend(["-c", 'mcp_servers.llm_wiki.tools.wiki_write.approval_mode="approve"'])
        fixture = json.dumps({"document": document, "contents": contents, "query": marker}, ensure_ascii=False)
        command.append(
            "You are executing an authorized LLM Wiki integration test, not implementing a project stage. "
            "The parent has already checked the plan and instructions. Only use llm_wiki MCP tools; "
            "do not run shell commands, edit files directly, browse, delegate, or change settings. "
            "The server is bound to an isolated temporary data root for this run; the following writes are authorized. "
            "Perform exactly these eight tool calls in this order, sequentially:\n"
            "1. wiki_write(document, contents[0], expected_revision=null).\n"
            "2. wiki_read(document); remember its revision as R1.\n"
            "3. wiki_write(document, contents[1], expected_revision=R1).\n"
            "4. wiki_read(document); remember its revision as R2.\n"
            "5. wiki_write(document, contents[2], expected_revision=R2).\n"
            "6. wiki_write(document, 'stale write must be rejected', expected_revision=R1). "
            "This intentional stale request MUST fail with conflict. Do not retry it.\n"
            "7. wiki_read(document); expect contents[2].\n"
            "8. wiki_search(query, limit=20); expect the current document.\n"
            "Preserve the exact content strings and newlines. After the calls, briefly report observations. "
            "Do not inspect history files yourself: the parent verifier compares their bytes.\nFixture: " + fixture
        )
        print("Running Codex CLI against temporary wiki data (uses model quota)...", flush=True)
        completed = run_cli(command)
        require(completed.returncode == 0, "Codex CLI failed: " + completed.stderr[-2000:])
        try:
            summary = check_transcript(completed.stdout, data, document, marker, contents)
        except (RuntimeError, ValueError, KeyError, TypeError) as error:
            # Transcript contains only generated fixture data; keep no log file.
            print(completed.stdout[-12000:])
            raise RuntimeError(f"Live CLI verification failed: {error}") from error
    print(json.dumps({"ok": True, **summary, "temporary_data_removed": True}, ensure_ascii=False))


_FACT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["value", "basis", "event_id"],
    "properties": {
        "value": {"type": "string"},
        "basis": {"type": "string", "enum": ["source_unreviewed", "source_reviewed", "expert_policy"]},
        "event_id": {"type": ["string", "null"]},
    },
}
EXPERT_ANSWER_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["profiles"],
    "properties": {"profiles": {
        "type": "array", "minItems": 1, "maxItems": 2,
        "items": {
            "type": "object", "additionalProperties": False,
            "required": ["profile_id", "document", "source_revision", "state_revision",
                         "classification", "amount", "unit"],
            "properties": {
                **{key: {"type": "string"} for key in
                   ("profile_id", "document", "source_revision", "state_revision", "unit")},
                "classification": _FACT_SCHEMA, "amount": _FACT_SCHEMA,
            },
        },
    }},
}
_READ_TOOLS = {"access_context", "wiki_search", "wiki_read", "ontology_query",
               "ontology_context", "ontology_connections", "ontology_review_query", "ontology_impact"}
_SETUP_WARNING = "Under-development features enabled: skip_host_skill_discovery."


def _files_digest(root: Path) -> dict:
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file()}


def _expected_answer(snapshot: dict, profile: str) -> dict:
    graph = snapshot["effective_graph"]
    entities = {item["id"]: item for item in graph["entities"]}
    relation, = graph["relations"]
    attribute, = graph["attributes"]

    def fact(claim, value):
        provenance = claim.get("provenance") or {}
        expert = provenance.get("kind") == "expert_policy"
        return {"value": value, "basis": "expert_policy" if expert else "source_unreviewed",
                "event_id": provenance.get("event_id") if expert else None}

    return {"profile_id": profile, "document": snapshot["document"],
            "source_revision": snapshot["source_revision"],
            "state_revision": snapshot["state_revision"],
            "classification": fact(relation, entities[relation["object"]]["label"]),
            "amount": fact(attribute, attribute["value"]), "unit": attribute["unit"]}


def check_expert_transcript(stdout: str, answer: dict, *, marker: str,
                            expected: dict[str, dict]) -> dict:
    """Check observed read-only MCP calls and the answer, not model self-assessment."""
    from jsonschema import validate

    validate(answer, EXPERT_ANSWER_SCHEMA)
    events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    require(any(event.get("type") == "turn.completed" for event in events), "CLI turn did not complete")
    require(not any(event.get("type") in ("error", "turn.failed") for event in events), "CLI reported a failure")
    items = [event["item"] for event in events if event.get("type") == "item.completed"]
    notices = [item for item in items if item.get("type") == "error"
               and item.get("message", "").startswith(_SETUP_WARNING)]
    allowed = {"agent_message", "reasoning", "mcp_tool_call"}
    require(all(item in notices or item.get("type") in allowed for item in items),
            "Fresh session used a non-MCP tool or reported an error")
    calls = [item for item in items if item.get("type") == "mcp_tool_call"]
    require(calls and all(call.get("server") == SERVER_NAME for call in calls), "Unexpected MCP server")
    require(all(call.get("tool") in _READ_TOOLS for call in calls), "Fresh session attempted a mutation")
    discovered = set()
    queried = {}
    for call in calls:
        require(call.get("error") is None, "MCP call failed")
        result = call.get("result") or {}
        payload = result.get("structured_content")
        require(isinstance(payload, dict) and payload.get("ok") is True, "Missing successful MCP result")
        content = result.get("content") or []
        require(len(content) == 1 and json.loads(content[0]["text"]) == payload,
                "Text and structured MCP results differ")
        args = call.get("arguments") or {}
        if call["tool"] != "access_context":
            require(args.get("tenant") == "acme", "Unexpected tenant was requested")
        if call["tool"] == "wiki_search":
            require(args.get("query") == marker, "Fresh session did not discover the requested marker")
            require(payload.get("truncated") is False and payload.get("skipped") == [], "Search was incomplete")
            discovered.update(match["document"] for match in payload["matches"])
        elif call["tool"] == "ontology_review_query":
            require(args.get("document") in discovered, "Review query preceded document discovery")
            profile = (payload.get("access") or {}).get("profile_id")
            require(profile in expected, "Unexpected profile was queried")
            require(payload.get("status") == "ready" and payload.get("pending_history") == [],
                    "Fresh session did not receive applicable current knowledge")
            require(_expected_answer(payload, profile) == expected[profile], "MCP returned an unexpected snapshot")
            queried[profile] = payload["state_revision"]
    require(set(queried) == set(expected), "Not every requested profile used the authoritative query")
    actual = answer["profiles"]
    require(len(actual) == len(expected), "Answer omitted or duplicated a profile")
    require({row["profile_id"] for row in actual} == set(expected), "Answer used an unexpected profile")
    for row in actual:
        require(row == expected[row["profile_id"]], "Answer did not preserve the latest judgment, scope or provenance")
    session_id = next((event.get("thread_id") for event in events if event.get("type") == "thread.started"), None)
    require(isinstance(session_id, str) and session_id, "Missing fresh session identity")
    return {"session_id": session_id, "tools": [call["tool"] for call in calls],
            "answer": answer, "setup_notices": len(notices),
            "usage": [event.get("usage") for event in events if event.get("type") == "turn.completed"],
            "transcript_sha256": hashlib.sha256(stdout.encode()).hexdigest()}


def _expert_fixture(root: Path) -> dict:
    """Synthetic expert actions exercise plumbing; they are not human approvals."""
    from core.modules.access.policy import AccessPolicy
    from core.modules.ontology.store import OntologyStore
    from core.modules.reviews.store import ReviewStore
    from core.modules.documents.store import WikiStore

    tenant_root = root / "tenants"
    (tenant_root / "acme").mkdir(parents=True)
    tokens = {user: secrets.token_urlsafe(32) for user in ("expert", "reader")}
    profiles = {name: {"domain": "검증 업무", "viewpoint": name} for name in ("business", "developer")}
    config = {"version": 1, "tenants": {"acme": {"profiles": profiles}}, "users": {
        user: {"token_sha256": hashlib.sha256(token.encode()).hexdigest(), "memberships": {
            "acme": {"permissions": ["read", "ontology_policy"] if user == "expert" else ["read"],
                     "profiles": list(profiles), "default_profile": "business"}}}
        for user, token in tokens.items()}}
    policy_path = root / "access.json"
    policy_path.write_text(json.dumps(config), encoding="utf-8")
    policy = AccessPolicy(policy_path, tenant_root)
    scope = policy.authorize(tokens["expert"], "acme", "ontology_policy", "business")
    actor = {key: getattr(scope, key) for key in
             ("user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision")}
    store = WikiStore(tenant_root / "acme")
    marker = "expert-" + uuid4().hex
    document = f"verification/{uuid4().hex}.md"
    source = f"검증 ID: {marker}\nA는 사람이다.\nA의 검토 한도는 20 점이다.\n"
    revision = store.save(document, source, expected_revision=None).revision
    OntologyStore(store).generate(
        document, expected_revision=revision,
        entities=[{"id": "a", "label": "A", "type": "concept", "evidence": "A는 사람이다."},
                  {"id": "person", "label": "사람", "type": "concept", "evidence": "A는 사람이다."}],
        relations=[{"subject": "a", "predicate": "instance_of", "object": "person", "evidence": "A는 사람이다."}],
        attributes=[{"id": "limit", "subject": "a", "property": "검토 한도", "datatype": "number",
                     "value": "20", "unit": "점", "evidence": "A의 검토 한도는 20 점이다."}],
    )
    reviews = ReviewStore(store)
    snapshot = reviews.query(document, domain=actor["domain"], viewpoint=actor["viewpoint"])
    claims = {claim["collection"]: claim["claim_id"] for claim in snapshot["claims"]}
    qualifiers = {"polarity": "positive", "modality": "asserted", "condition": None, "scope": None, "time": None}
    context = {"domain": actor["domain"], "viewpoints": [actor["viewpoint"]]}
    revised = reviews.policy(
        document, claim_id=claims["relations"], expected_state_revision=snapshot["state_revision"],
        reason="검증 fixture의 모의 전문가 분류 변경; 실제 업무 승인 아님", actor=actor,
        replacement={"subject": "a", "predicate": "instance_of", "object": "animal",
                     "qualifiers": qualifiers, "context": context},
        entities=[{"id": "animal", "label": "동물", "type": "concept"}],
    )
    classification_event = revised["history"][-1]["id"]
    values = [str(100 + secrets.randbelow(800)), str(1000 + secrets.randbelow(8000))]
    for value in values:
        revised = reviews.policy(
            document, claim_id=claims["attributes"], expected_state_revision=revised["state_revision"],
            reason="검증 fixture의 모의 한도 갱신; 실제 업무 승인 아님", actor=actor,
            replacement={"id": "limit", "subject": "a", "property": "검토 한도", "datatype": "number",
                         "value": value, "unit": "점", "qualifiers": qualifiers, "context": context},
        )
    return {"reviews": reviews, "document": document, "marker": marker, "actor": actor,
            "classification_event": classification_event, "reader_token": tokens["reader"],
            "amount_event": revised["history"][-1]["id"], "latest_amount": values[-1],
            "source_revision": revision, "policy_path": policy_path, "tenant_root": tenant_root}


def _fixture_expected(fixture: dict, profile: str, snapshot: dict, *, undone: bool) -> dict:
    """The semantic oracle is the requested fixture action, not the query's own answer."""
    expert_class = profile == "business" and not undone
    expert_amount = profile == "business"
    expected = {
        "profile_id": profile, "document": fixture["document"],
        "source_revision": fixture["source_revision"], "state_revision": snapshot["state_revision"],
        "classification": {"value": "동물" if expert_class else "사람",
                           "basis": "expert_policy" if expert_class else "source_unreviewed",
                           "event_id": fixture["classification_event"] if expert_class else None},
        "amount": {"value": fixture["latest_amount"] if expert_amount else "20",
                   "basis": "expert_policy" if expert_amount else "source_unreviewed",
                   "event_id": fixture["amount_event"] if expert_amount else None}, "unit": "점",
    }
    require(_expected_answer(snapshot, profile) == expected,
            "Stored effective knowledge does not match the independently specified fixture actions")
    return expected


def _failure_details(completed: subprocess.CompletedProcess, token: str) -> str:
    errors = []
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") in ("error", "turn.failed"):
            errors.append(event)
        item = event.get("item") or {}
        if item.get("type") == "error" and not item.get("message", "").startswith(_SETUP_WARNING):
            errors.append({"message": item.get("message")})
    detail = json.dumps(errors, ensure_ascii=False)[-1500:] if errors else completed.stderr[-1500:]
    return detail.replace(token, "<redacted>")


def _expert_command(cli: str, root: Path, fixture: dict, profiles: list[str], attempt: int) -> tuple[list[str], Path]:
    work = root / f"empty-session-{attempt}"
    work.mkdir()
    schema = root / "answer-schema.json"
    schema.write_text(json.dumps(EXPERT_ANSWER_SCHEMA), encoding="utf-8")
    output = root / f"answer-{attempt}.json"
    command = [cli, "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--json",
               "--sandbox", "read-only", "-C", str(work), "--output-schema", str(schema),
               "--output-last-message", str(output)]
    for setting in ('model="gpt-6-astra"', 'model_reasoning_effort="xhigh"', "project_doc_max_bytes=0",
                    'web_search="disabled"', "agents.enabled=false"):
        command.extend(["-c", setting])
    for feature in ("apps", "plugins", "shell_tool", "multi_agent", "memories", "hooks", "computer_use",
                    "browser_use", "image_generation", "goals", "sleep_tool", "skill_search", "view_image"):
        command.extend(["--disable", feature])
    command.extend(["--enable", "skip_host_skill_discovery"])
    config = {"command": str(PROJECT_DIR / ".venv/bin/python"), "cwd": str(PROJECT_DIR),
              "args": ["-B", "-m", "core.mcp_server", "--access-config", str(fixture["policy_path"]),
                       "--tenant-root", str(fixture["tenant_root"]), "--token-env", "LLM_WIKI_POLICY_CHECK_TOKEN"],
              "env_vars": ["LLM_WIKI_POLICY_CHECK_TOKEN"], "enabled": True}
    for key, value in config.items():
        command.extend(["-c", f"mcp_servers.{SERVER_NAME}.{key}=" + json.dumps(value)])
    command.append(
        "독립된 읽기 전용 Wiki 조회입니다. MCP 서버 지침에 따라 현재 적용되는 지식을 확인하세요. "
        "셸·파일 직접 접근·웹 검색·위임·설정 변경·쓰기 도구를 사용하지 마세요. "
        f"테넌트 acme, 관점 {json.dumps(profiles)}에서 검증 ID {fixture['marker']}의 자료를 찾아, "
        "A의 현재 분류와 검토 한도 및 단위를 알려주세요. 각 관점은 따로 확인하세요. "
        "응답 스키마의 classification.value는 분류명, amount.value는 숫자 문자열입니다. "
        "각 사실의 basis에는 원문 미검토(source_unreviewed), 원문 검토(source_reviewed), "
        "전문가 정책(expert_policy)을 구분하고 전문가 정책이면 결정 event_id를, 아니면 null을 넣으세요. "
        "문서 경로, 원문 revision, 현재 조회 state_revision을 그대로 보존하세요. "
        "이는 모의 자료 조회이며 실제 사람이 승인했다는 뜻은 아닙니다. 최종 응답은 요청된 JSON으로만 작성하세요."
    )
    return command, output


# 임시 합성 자료에서 전문가 정책 수정/되돌림 뒤 새 읽기 세션이 최신 판단을 사용하는지 확인한다.
def verify_expert_policy(cli: str) -> None:
    summaries = []
    with tempfile.TemporaryDirectory(prefix="llm-wiki-expert-cli-") as directory:
        root = Path(directory).resolve()
        fixture = _expert_fixture(root)
        reviews, document = fixture["reviews"], fixture["document"]
        env = os.environ.copy()
        env["LLM_WIKI_POLICY_CHECK_TOKEN"] = fixture["reader_token"]
        for attempt, profiles in enumerate((["business"], ["business", "developer"]), start=1):
            if attempt == 2:
                snapshot = reviews.query(document, domain="검증 업무", viewpoint="business")
                reviews.policy_undo(document, event_id=fixture["classification_event"],
                                    expected_state_revision=snapshot["state_revision"], actor=fixture["actor"],
                                    reason="검증 fixture의 모의 분류 되돌림; 실제 업무 승인 아님")
            expected = {profile: _fixture_expected(fixture, profile,
                                                   reviews.query(document, domain="검증 업무", viewpoint=profile),
                                                   undone=attempt == 2)
                        for profile in profiles}
            before = _files_digest(fixture["tenant_root"])
            command, output = _expert_command(cli, root, fixture, profiles, attempt)
            print(f"Running fresh read-only expert-policy session {attempt}/2 (uses model quota)...", flush=True)
            completed = run_cli(command, timeout=1800, cwd=root / f"empty-session-{attempt}", env=env)
            require(completed.returncode == 0,
                    f"Fresh expert-policy CLI session {attempt} failed (exit {completed.returncode}): "
                    + _failure_details(completed, fixture["reader_token"]))
            require(output.is_file(), "Fresh session did not produce a structured answer")
            answer = json.loads(output.read_text(encoding="utf-8"))
            # Never print the full transcript/configuration/environment or credentials.
            for token in (fixture["reader_token"],):
                require(token not in completed.stdout and token not in completed.stderr
                        and token not in json.dumps(answer), "Credential appeared in CLI output")
            require(_files_digest(fixture["tenant_root"]) == before, "Read-only session changed tenant data")
            try:
                summary = check_expert_transcript(completed.stdout, answer, marker=fixture["marker"], expected=expected)
            except (RuntimeError, ValueError, KeyError, TypeError):
                events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
                items = [event.get("item", {}) for event in events if event.get("type") == "item.completed"]
                print(json.dumps({"ok": False, "phase": attempt, "answer": answer,
                                  "item_types": [item.get("type") for item in items],
                                  "tools": [item.get("tool") for item in items if item.get("type") == "mcp_tool_call"]},
                                 ensure_ascii=False), flush=True)
                raise
            summaries.append(summary)
            print(json.dumps({"ok": True, "phase": "latest" if attempt == 1 else "undo_and_profile",
                              "data_unchanged": True, **summary}, ensure_ascii=False), flush=True)
        require(len({item["session_id"] for item in summaries}) == 2, "Sessions were not independent")
    print(json.dumps({"ok": True, "expert_policy": "passed", "fresh_sessions": 2,
                      "configured_model": "gpt-6-astra", "reasoning_effort": "xhigh",
                      "expert_actions": "synthetic fixture, not human approval",
                      "temporary_data_removed": True}, ensure_ascii=False))


# 옵션에 따라 실제 CLI 검증 종류를 고른다. 이 파일을 import하는 것만으로는 실행되지 않는다.
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--expert-policy", action="store_true", help="Run two isolated read-only sessions after expert edits and undo.")
    mode.add_argument("--transition", action="store_true", help="Check D-038/D-040 in a fresh isolated session through the personal launcher.")
    parser.add_argument("--cli", help="Codex executable; otherwise use codex on PATH.")
    args = parser.parse_args()
    cli = args.cli or shutil.which("codex")
    require(cli is not None, "codex is not on PATH; pass --cli or install/sign in before this live check")
    if args.transition:
        from tools.verify_transition import verify_transition
        verify_transition(cli)
    else:
        (verify_expert_policy if args.expert_policy else verify_legacy)(cli)


if __name__ == "__main__":
    main()
