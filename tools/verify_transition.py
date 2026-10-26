# 개인 런처를 통한 새 CLI 세션의 읽기 연결을 합성 자료로 확인한다.
# fixture 구성 → 기대값 고정 → 새 세션 실행 → 실제 도구 호출/버전 대조 순서이며 실제 CLI 실행은 선택 작업이다.

"""합성 자료로 개인 런처를 통한 새 CLI의 읽기 연결을 확인하는 선택 실행 도구.

검사 자체의 회귀와 실제 CLI 실행은 별도이며 후자는 모델 사용량이 들 수 있다.
운영 사용자 자료나 실제 업무 승인을 시험 정답으로 대신하지 않는다.
"""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import tempfile

from tools.verify_codex import (
    PROJECT_DIR, SERVER_NAME, _SETUP_WARNING, _expert_fixture, _files_digest,
    _failure_details, require, run_cli,
)


READ_TOOLS = (
    "access_context", "wiki_read", "wiki_search", "ontology_query", "ontology_connections",
    "ontology_context", "ontology_impact", "ontology_review_query", "ontology_correspondence_query",
    "ontology_correspondence_prepare", "ontology_correspondence_find", "ontology_concept_find",
    "ontology_concept_query",
)
AS_OF = "2026-10-24T00:00:00+09:00"
PREPARE_CHANGE = {"action": "defer", "reason": "isolated preparation only; no human approval or mutation"}


# 임시 자료와 모의 판단을 준비한다. 이 판단은 실제 사람의 승인으로 기록하지 않는다.
def transition_fixture(root: Path) -> dict:
    """Reuse fixed synthetic source fixtures and the existing ledger APIs, never user data."""
    from core.modules.access.policy import AccessPolicy
    from core.modules.correspondences.store import CorrespondenceStore
    from core.modules.ontology.store import OntologyStore
    from core.tests.modules.test_correspondences import correspondence_fixture

    fixture = _expert_fixture(root)
    policy_path = fixture["policy_path"]
    config = json.loads(policy_path.read_text())
    config["users"]["expert"]["memberships"]["acme"]["permissions"] = [
        "read", "write", "ontology_write", "ontology_review", "ontology_policy"]
    policy_path.write_text(json.dumps(config))
    policy_path.chmod(0o600)
    root.chmod(0o700)
    fixture["tenant_root"].chmod(0o700)
    (fixture["tenant_root"] / "acme").chmod(0o700)
    credentials = root / "credentials"
    credentials.mkdir(mode=0o700)
    token_path = credentials / "reader.token"
    descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(fixture["reader_token"] + "\n")
    fixture["token_path"] = token_path
    policy = AccessPolicy(policy_path, fixture["tenant_root"])
    scope = policy.authorize(fixture["reader_token"], "acme", "read", "business")
    reader = {key: getattr(scope, key) for key in
              ("user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision")}
    # Scripted setup actions retain the original expert identity and explicitly remain simulations.
    actor = {**fixture["actor"], "policy_revision": reader["policy_revision"]}
    wiki = fixture["reviews"].store
    correspondence_fixture(wiki)
    source = wiki.read("a.md")
    wiki.save("a.md", source.content + f"검증 ID: {fixture['marker']}\n", expected_revision=source.revision)
    draft = correspondence_fixture(wiki)
    draft["condition"]["quote"] = wiki.read("a.md").content.splitlines()[0]
    for document in ("a.md", "b.md", "d.md"):
        OntologyStore(wiki).generate(document, wiki.read(document).revision, entities=[], relations=[])
    correspondences = CorrespondenceStore(wiki, actor)
    prepared = correspondences.query(draft=draft)
    proposal = correspondences.propose(prepared["correspondence_id"], prepared["draft"],
                                       prepared["state_revision"], "isolated simulated proposal")
    accepted = correspondences.review(proposal["correspondence_id"], "accept",
                                      correspondences.query(proposal["correspondence_id"])["state_revision"],
                                      "isolated simulated review; not a person's approval")
    fixture.update(reader=reader, correspondence_id=proposal["correspondence_id"],
                   correspondence_event=accepted["event_id"], expert_term="동물")
    return fixture


def expected_transition(fixture: dict) -> dict:
    from core.modules.knowledge.concepts import ConceptStore
    from core.modules.correspondences.store import CorrespondenceStore

    wiki, actor = fixture["reviews"].store, fixture["reader"]
    store = ConceptStore(wiki, actor=actor)
    common = {"tenant": "acme", "policy_revision": actor["policy_revision"],
              "profile": {key: actor[key] for key in ("profile_id", "domain", "viewpoint")}, "as_of": AS_OF}
    found = store.find(fixture["expert_term"], documents=[fixture["document"]], **common)
    target = next(match["target_ref"] for match in found["matches"]
                  if (match.get("target_ref") or {}).get("kind") == "entity"
                  and match["match_origin"] == "document_policy")
    queries = {}
    for profile in ("business", "developer"):
        selected = {**actor, "profile_id": profile, "viewpoint": profile}
        options = {**common, "profile": {key: selected[key] for key in ("profile_id", "domain", "viewpoint")}}
        queries[profile] = ConceptStore(wiki, actor=selected).query(target, **options)
    business_json = json.dumps(queries["business"], ensure_ascii=False)
    require(fixture["expert_term"] in business_json and fixture["classification_event"] in business_json,
            "Synthetic expert action was not preserved")
    require("other_scope" in json.dumps(queries["developer"]), "Other scope was not preserved")
    require(queries["business"]["condition_evaluation"] == "not_evaluated", "Conditions were inferred")
    corr = CorrespondenceStore(wiki, actor)
    detail = corr.query(fixture["correspondence_id"], application_context={"service": "catalog"}, as_of=AS_OF)
    require(detail["source_proposal"]["decision"] == "accepted"
            and detail["source_proposal"]["applicability"] == "applicable", "Synthetic review was not preserved")
    prepare = corr.prepare(fixture["correspondence_id"], "review", deepcopy(PREPARE_CHANGE))
    return {"target": target, "queries": queries, "correspondence": detail, "prepare": prepare}


def transition_command(cli: str, root: Path, fixture: dict) -> tuple[list[str], Path]:
    work = root / "empty-session"
    work.mkdir()
    command = [cli, "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--json",
               "--sandbox", "read-only", "-C", str(work)]
    for setting in ("project_doc_max_bytes=0", 'web_search="disabled"', "agents.enabled=false"):
        command.extend(["-c", setting])
    for feature in ("apps", "plugins", "shell_tool", "multi_agent", "memories", "hooks", "computer_use",
                    "browser_use", "image_generation", "goals", "sleep_tool", "skill_search", "view_image"):
        command.extend(["--disable", feature])
    command.extend(["--enable", "skip_host_skill_discovery"])
    config = {
        "command": str(PROJECT_DIR / ".venv/bin/python"), "cwd": str(PROJECT_DIR),
        "args": ["-B", "-m", "core.personal_launcher", "--token-file", str(fixture["token_path"]),
                 "--access-config", str(fixture["policy_path"]), "--tenant-root", str(fixture["tenant_root"])],
        "enabled": True, "required": True, "enabled_tools": list(READ_TOOLS),
        "startup_timeout_sec": 20, "tool_timeout_sec": 30, "default_tools_approval_mode": "writes",
    }
    for key, value in config.items():
        command.extend(["-c", f"mcp_servers.{SERVER_NAME}.{key}=" + json.dumps(value)])
    command.append(
        "You are running a synthetic read-only MCP integration check in a fresh session. "
        "Use only llm_wiki MCP tools. Do not access files, shell, web, other servers, or change settings. "
        "All setup judgments are simulations, not human approvals. Call access_context first and use its "
        "authorized tenant acme and profiles business/developer. "
        f"Search wiki_search for marker {fixture['marker']}; discover the source documents from its results. "
        "Read ontology_review_query in business for the discovered document about A's classification. "
        f"Use ontology_concept_find with text {json.dumps(fixture['expert_term'], ensure_ascii=False)} "
        "and that document in business. Select the entity target_ref from document_policy exactly as returned. "
        "Pass that unchanged target to ontology_concept_query twice, business then developer, expansion=none. "
        f"Set as_of={AS_OF} in both concept find/query calls. Preserve other_scope and unreviewed states. "
        "Then ontology_correspondence_find over the wiki_search document results, profile=business, "
        f'application_context={{"service":"catalog"}}, as_of={AS_OF}. '
        "Read the found correspondence_id using ontology_correspondence_query with the same scope/time. "
        "Finally ontology_correspondence_prepare for that ID, operation=review, "
        f"change={json.dumps(PREPARE_CHANGE)}, profile=business. "
        "Preparation is read-only; do not call a mutation. Report a brief summary of observed source/event/"
        "version/scope and incomplete states. Never invent a revision, target or approval."
    )
    return command, work


# 모델의 최종 문장보다 실제 조회 도구/인자/반환 버전을 기준으로 연결을 확인한다.
def check_transition_transcript(stdout: str, fixture: dict, expected: dict) -> dict:
    """Validate observed tool arguments/results and versioned discovery; ignore model self-assessment."""
    events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    require(any(event.get("type") == "turn.completed" for event in events), "CLI turn did not complete")
    require(not any(event.get("type") in ("error", "turn.failed") for event in events), "CLI reported failure")
    items = [event["item"] for event in events if event.get("type") == "item.completed"]
    allowed = {"agent_message", "reasoning", "mcp_tool_call"}
    require(all(item.get("type") in allowed or (item.get("type") == "error"
                and item.get("message", "").startswith(_SETUP_WARNING)) for item in items),
            "CLI used a non-MCP tool or reported an error")
    calls = [item for item in items if item.get("type") == "mcp_tool_call"]
    require(calls and calls[0].get("tool") == "access_context", "Missing initial access context")
    discovered, concept_targets, corr_ids, profiles = set(), [], set(), set()
    reviewed = detail_read = prepared = False
    for call in calls:
        name, args = call.get("tool"), call.get("arguments") or {}
        require(call.get("server") == SERVER_NAME and name in READ_TOOLS, "Unexpected server or mutation")
        require(call.get("error") is None, "MCP transport error")
        result = call.get("result") or {}
        payload = result.get("structured_content")
        content = result.get("content") or []
        require(isinstance(payload, dict) and payload.get("ok") is True, "Missing successful MCP result")
        require(len(content) == 1 and json.loads(content[0]["text"]) == payload, "MCP representations differ")
        if name == "access_context":
            require(args == {} and payload.get("user_id") == "reader"
                    and payload.get("policy_revision") == fixture["reader"]["policy_revision"],
                    "Unexpected authenticated identity")
            continue
        require(args.get("tenant") == "acme", "Unexpected tenant")
        access = payload.get("access") or {}
        require(access.get("user_id") == "reader" and access.get("tenant") == "acme"
                and access.get("policy_revision") == fixture["reader"]["policy_revision"], "Wrong access scope")
        profile = access.get("profile_id")
        require(profile in ("business", "developer"), "Unexpected profile")
        if name == "wiki_search":
            require(args.get("query") == fixture["marker"], "Wrong discovery query")
            require(not payload.get("truncated") and payload.get("skipped") == [], "Incomplete source search")
            discovered.update(match["document"] for match in payload["matches"])
        elif name == "ontology_review_query":
            require(args.get("document") in discovered, "Review did not follow source discovery")
            if args.get("document") == fixture["document"]:
                require(profile == "business" and fixture["classification_event"] in json.dumps(payload),
                        "Latest expert judgment was not read")
                reviewed = True
        elif name == "ontology_concept_find":
            require(reviewed and args.get("text") == fixture["expert_term"]
                    and args.get("documents") == [fixture["document"]], "Concept discovery bypassed judgment lookup")
            require(args.get("as_of") == AS_OF and profile == "business", "Wrong discovery scope/time")
            concept_targets.extend(match.get("target_ref") for match in payload["matches"])
            require(expected["target"] in concept_targets, "Expert term did not produce a versioned entity target")
        elif name == "ontology_concept_query":
            require(args.get("target") in concept_targets and args.get("target") == expected["target"],
                    "Target was invented or differs from discovery")
            require(args.get("as_of") == AS_OF and args.get("expansion", "none") == "none", "Wrong query scope/time")
            for key, value in expected["queries"][profile].items():
                require(payload.get(key) == value, "Integrated knowledge differs: " + key)
            profiles.add(profile)
        elif name == "ontology_correspondence_find":
            require(set(args.get("documents", [])) <= discovered and bool(args.get("documents")),
                    "Correspondence discovery bypassed source search")
            require(args.get("application_context") == {"service": "catalog"}
                    and args.get("as_of") == AS_OF and profile == "business", "Wrong correspondence scope/time")
            require(payload.get("complete") is True and payload.get("skipped") == [], "Incomplete correspondence search")
            corr_ids.update(item["correspondence_id"] for item in payload["results"])
            for item in payload["results"]:
                discovered.update((item.get("documents") or {}).values())
        elif name == "ontology_correspondence_query":
            require(args.get("correspondence_id") in corr_ids
                    and args.get("correspondence_id") == fixture["correspondence_id"], "Undiscovered correspondence")
            require(args.get("application_context") == {"service": "catalog"}
                    and args.get("as_of") == AS_OF and profile == "business", "Wrong correspondence detail scope/time")
            for key in ("correspondence_revision", "state_revision", "source_proposal", "policies", "history", "dependencies"):
                require(payload.get(key) == expected["correspondence"].get(key), "Correspondence state differs: " + key)
            detail_read = True
        elif name == "ontology_correspondence_prepare":
            require(detail_read and args.get("correspondence_id") == fixture["correspondence_id"]
                    and args.get("operation") == "review" and args.get("change") == PREPARE_CHANGE
                    and profile == "business",
                    "Preparation bypassed detail or changed intent")
            for key in ("state_revision", "payload_digest", "prepared_change", "dependencies", "complete"):
                require(payload.get(key) == expected["prepare"].get(key), "Prepared basis differs: " + key)
            prepared = True
    require(profiles == {"business", "developer"} and reviewed and detail_read and prepared,
            "Required D-038/D-040 read flow was incomplete")
    session = next((event.get("thread_id") for event in events if event.get("type") == "thread.started"), None)
    require(isinstance(session, str) and session, "Missing fresh session identity")
    return {"session_id": session, "mcp_calls": len(calls), "tools": [call["tool"] for call in calls],
            "transcript_sha256": hashlib.sha256(stdout.encode()).hexdigest(),
            "usage": [event.get("usage") for event in events if event.get("type") == "turn.completed"]}


# 격리 임시 폴더에서 fixture와 CLI 실행을 연결한 뒤 결과를 보고한다.
def verify_transition(cli: str) -> None:
    with tempfile.TemporaryDirectory(prefix="llm-wiki-transition-cli-") as directory:
        root = Path(directory).resolve()
        fixture = transition_fixture(root)
        expected = expected_transition(fixture)
        before = _files_digest(fixture["tenant_root"])
        command, work = transition_command(cli, root, fixture)
        print("Running an isolated fresh CLI session through the personal launcher (uses model quota)...", flush=True)
        completed = run_cli(command, timeout=900, cwd=work)
        require(_files_digest(fixture["tenant_root"]) == before, "Read-only CLI changed tenant files")
        token = fixture["reader_token"]
        require(token not in completed.stdout and token not in completed.stderr, "Credential appeared in CLI output")
        require(completed.returncode == 0, "Fresh transition CLI failed: " + _failure_details(completed, token))
        try:
            result = check_transition_transcript(completed.stdout, fixture, expected)
        except (RuntimeError, ValueError, KeyError, TypeError):
            # Print only tool names, never raw transcripts, arguments or credentials.
            events = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
            calls = [event.get("item", {}) for event in events if event.get("type") == "item.completed"
                     and event.get("item", {}).get("type") == "mcp_tool_call"]
            print(json.dumps({"ok": False, "tools_observed": [call.get("tool") for call in calls]}), flush=True)
            raise
    print(json.dumps({"ok": True, "transition_cli": "passed", "data_unchanged": True,
                      "temporary_data_removed": True, "manual_approval_verified": False,
                      "connection_ready": False, "write_ready": False, "remote_verified": False,
                      "judgments": "synthetic simulation, not human approval", **result}, ensure_ascii=False))
