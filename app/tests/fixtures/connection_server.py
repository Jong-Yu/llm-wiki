"""실제 FastAPI/인가를 임시 정책으로 실행한다. 운영 자료나 자격 증명은 읽지 않는다."""

import asyncio
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import socket
import sys
import tempfile
from uuid import UUID, uuid4
from unittest.mock import patch
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

import uvicorn
from pydantic import JsonValue
from starlette.responses import JSONResponse, RedirectResponse, Response

from core.modules.access.policy import AccessPolicy
from core.api.dependencies import access_value
from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_inputs.store import InputStore
from core.modules.analysis_inputs import artifacts
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.runtime.extraction_schema import build_submission_schema
from core.tests.modules.test_ontology import ontology_v3_fixture
from core.modules.sources.store import SourceStore
from core.runtime.application import create_application


def workspace_seed(root: Path, tenant_root: Path, policy: AccessPolicy, token: str,
                   store: WikiStore, sources: SourceStore, original: dict[str, JsonValue]
                   ) -> tuple[dict[str, JsonValue], RulesetRegistry]:
    """새 화면 전용 자료를 실제 저장·그래프·작업·불변 파일 모듈로만 준비한다."""
    source, entities, relations, candidates, attributes = ontology_v3_fixture()
    documents = []
    for name, peer in (("Guide-01.md", "Guide-02.md"), ("Guide-02.md", "Guide-01.md")):
        current = store.read(name)
        body = f"# {name} 연결된 지식 검증\n\n{source}\n[연관 문서]({peer})\n"
        saved = store.save(name, body, expected_revision=current.revision)
        OntologyStore(store).generate(name, expected_revision=saved.revision,
            entities=entities, relations=relations, relation_candidates=candidates, attributes=attributes,
            schema_version=3)
        knowledge = ReviewStore(store).query(name)
        documents.append({"document": name, "revision": saved.revision,
            "stateRevision": knowledge["state_revision"], "claimId": knowledge["claims"][0]["claim_id"],
            "claimCount": len(knowledge["claims"]), "entityId": "catalog"})

    # 발행·사용 허용 설정도 이 임시 root 안에서만 만들며 운영 규약은 읽거나 바꾸지 않는다.
    schema = build_submission_schema()
    rules_root, rules_policy = root / "rules", root / "rules-policy.json"
    reference = {"ruleset_id": "wiki", "ruleset_version": "1"}
    publish(rules_root, tenant_root=tenant_root, reason="isolated Electron workspace fixture",
        schema=schema, expected_schema=schema, **reference)
    rules_policy.write_text(json.dumps({"version": 1, "tenants": {"alpha": {
        "default": reference, "allowed": [reference], "revoked": []}}}), encoding="utf-8")
    rulesets = RulesetRegistry(rules_root, rules_policy, tenant_root, expected_schema=schema)

    def authorize(permission: str = "source_write") -> dict[str, JsonValue]:
        """시드의 작성자·권한도 기존 시험 토큰의 실제 정책에서 확인한다."""
        return access_value(policy.authorize(token, "alpha", permission))

    def authorize_input(permission: str = "source_write") -> dict[str, JsonValue]:
        """접수 관점 all과 달리 새 화면에서 선택하는 business로 실제 입력을 고정한다."""
        return access_value(policy.authorize(token, "alpha", permission, "business"))

    jobs = JobStore(store, rulesets=rulesets)
    created = jobs.create(tenant="alpha", user_id="alice", request_id=uuid4().hex,
        source_id=original["source_id"], source_version=original["source_version"],
        source_sha256=original["source_sha256"], expected_registration_revision=original["registration_revision"],
        targets=["Guide-01.md"], outputs=["wiki", "ontology"], authorize=authorize)
    claimed = jobs.claim(created["job_id"], tenant="alpha", user_id="alice",
        expected_job_revision=created["job_revision"], authorize=authorize)
    common = {"tenant": "alpha", "user_id": "alice", "run_id": claimed["run_id"], "authorize": authorize_input}
    inputs = InputStore(store, rulesets, jobs=jobs)
    prepared = inputs.prepare(created["job_id"], **common,
        expected_job_revision=claimed["job_revision"], stage="read_source")
    with sources.open_original(original["source_id"], original["source_version"])[0] as opened:
        extracted_text = opened.read().decode("utf-8")
    extracted = inputs.submit_extraction(created["job_id"], **common,
        expected_job_revision=prepared["job_revision"], bundle_id=prepared["bundle_id"],
        bundle_revision=prepared["bundle_revision"], request_id=uuid4().hex,
        content=extracted_text, method="verbatim")
    artifact_bytes = b"Electron workspace artifact\x00fixture\r\n"
    artifact_request_id = uuid4().hex
    uploaded = artifacts.submit(inputs, created["job_id"], **common,
        expected_job_revision=extracted["job_revision"], bundle_id=prepared["bundle_id"],
        bundle_revision=prepared["bundle_revision"], extraction_id=extracted["extraction_id"],
        extraction_revision=extracted["extraction_revision"], request_id=artifact_request_id,
        filename="workspace-artifact.bin", media_type="application/octet-stream",
        content_sha256=sha256(artifact_bytes).hexdigest(), stream=BytesIO(artifact_bytes))
    seed = {"documents": documents, "inputProfileId": "business",
        "jobId": created["job_id"], "jobRevision": uploaded["job_revision"],
        "runId": claimed["run_id"], "bundleId": prepared["bundle_id"], "bundleRevision": prepared["bundle_revision"],
        "sourceId": original["source_id"], "sourceVersion": original["source_version"],
        "sourceSha256": original["source_sha256"], "extractionId": extracted["extraction_id"],
        "extractionRevision": extracted["extraction_revision"], "extractionContent": extracted_text,
        "artifactId": uploaded["artifact_id"], "artifactRequestId": artifact_request_id,
        "artifactSha256": uploaded["sha256"], "artifactSizeBytes": uploaded["size_bytes"],
        "artifactFilename": "workspace-artifact.bin"}
    return seed, rulesets


def main():
    tokens = json.loads(sys.stdin.readline())
    workspace_enabled = tokens.get("workspace") is True
    documents_enabled = bool(tokens.get("documents")) or workspace_enabled
    with tempfile.TemporaryDirectory(prefix="wiki-connection-api-") as temporary:
        root = Path(temporary)
        tenant_root = root / "data"
        for tenant in ("alpha", "beta"):
            (tenant_root / tenant).mkdir(parents=True)
        profiles = {"all": {"domain": None, "viewpoint": None},
                    "business": {"domain": None, "viewpoint": "business"}}
        config = {"version": 1, "tenants": {
            tenant: {"profiles": profiles} for tenant in ("alpha", "beta")}, "users": {}}
        for user, memberships in (("alice", ("alpha", "beta")), ("bob", ("beta",)), ("none", ())):
            config["users"][user] = {
                "token_sha256": sha256(tokens[user].encode()).hexdigest(),
                "memberships": {tenant: {"permissions": ["read"],
                    "profiles": list(profiles), "default_profile": "all"} for tenant in memberships}}
        if documents_enabled:
            config["users"]["alice"]["memberships"]["alpha"]["permissions"].append("source_write")
        if workspace_enabled:
            permissions = config["users"]["alice"]["memberships"]["alpha"]["permissions"]
            permissions.extend(["write", "ontology_write", "ontology_review", "ontology_policy",
                                "conversation_write", "result_write", "comparison_write"])
        workspace_permissions = list(config["users"]["alice"]["memberships"]["alpha"]["permissions"])
        policy_path = root / "access.json"
        policy_path.write_text(json.dumps(config), encoding="utf-8")
        policy = AccessPolicy(policy_path, tenant_root)
        rulesets = None
        stats = {"slow": 0, "redirect_followed": 0, "methods": [], "document_requests": [], "registrations": 0, "receipt_requests": 0,
                 "content_requests": [], "content_completed": [], "source_requests": [], "source_completed": []}
        document_mode = "normal"
        content_mode = "normal"
        source_mode = "normal"
        registration_mode = "normal"
        workspace_data = None
        if documents_enabled:
            # 모든 문서·원본은 이 시험의 임시 tenant에 실제 저장 모듈로 생성합니다.
            store = WikiStore(tenant_root / "alpha")
            for number in range(1, 22):
                body = f"# Guide {number}\nFixture only.\n"
                if number == 1:
                    body = ("# 문서 읽기 검증\n\n실제 API에서 받은 **첫 번째 문서**입니다.\n\n"
                            "| 항목 | 값 |\n| --- | --- |\n| 실행 | 읽기 전용 |\n\n"
                            "- [x] 본문 조회\n- [ ] 다음 작업\n\n"
                            "```ts\nconst fixture = '본문 그대로';\n```\n\n"
                            "[문서 링크](https://example.invalid/body-link)\n\n"
                            "![외부 이미지](https://example.invalid/body-image.png)\n\n"
                            "<script>window.bodyUnsafe = true</script>\n"
                            "<img src=x onerror=\"window.bodyUnsafe = true\">\n")
                elif number == 2:
                    body = ""
                elif number == 3:
                    body = "# 긴 본문 검증\n\n" + "\n\n".join(
                        f"{line}번째 문단 · 독립 스크롤을 확인하는 실제 저장 본문입니다. " * 12
                        for line in range(1, 36))
                store.save(f"Guide-{number:02}.md", body, expected_revision=None)
            sources = SourceStore(store)
            source_bytes = b"Source for the document catalogue.\n"
            if tokens.get("sourcePreview"):
                source_bytes = ("# 원본 미리보기 검증\n\n등록된 **원문 그대로**입니다.\n\n"
                                "| 항목 | 값 |\n| --- | --- |\n| 원본 | 보존 |\n\n"
                                "![원격 이미지](https://example.invalid/source.png)\n\n"
                                "<script>window.sourceUnsafe = true</script>\n").encode()
            staged = sources.stage(BytesIO(source_bytes),
                                   kind="file", title="등록 원본", format="md", filename="source.md")
            original = sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                           authorize=lambda: access_value(policy.authorize(tokens["alice"], "alpha", "source_write")))
            if tokens.get("sourcePreview"):
                for title, raw in (("텍스트 원본", "\ufeff# 서식 없는 원본\r\n  공백\t유지 🌱\r\n<script>window.sourceUnsafe = true</script>\n".encode()),
                                   ("빈 원본", b""), ("큰 원본", b"x" * (20 * 1024 * 1024))):
                    staged = sources.stage(BytesIO(raw), kind="file", title=title, format="txt", filename="original.txt")
                    sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                                   authorize=lambda: access_value(policy.authorize(tokens["alice"], "alpha", "source_write")))
            if tokens.get("registration"):
                for number in range(24):
                    staged = sources.stage(BytesIO(b"Existing fixture source.\n"), kind="text",
                                           title=f"Existing source {number}", format="txt")
                    sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                        authorize=lambda: access_value(policy.authorize(tokens["alice"], "alpha", "source_write")))

        if workspace_enabled:
            workspace_data, rulesets = workspace_seed(root, tenant_root, policy, tokens["alice"], store, sources, original)
        application = create_application(policy, rulesets=rulesets)

        async def fixture(scope, receive, send):
            nonlocal document_mode, content_mode, source_mode, registration_mode
            if scope["type"] != "http":
                return await application(scope, receive, send)
            path = scope["path"]
            if workspace_enabled and path == "/fixture-workspace" and scope["method"] == "GET":
                return await JSONResponse(workspace_data)(scope, receive, send)
            if workspace_enabled and path.startswith("/fixture-workspace-mode/") and scope["method"] == "POST":
                mode = path.rsplit("/", 1)[-1]
                if mode not in {"normal", "read-only", "revoke", "business-only"}:
                    return await JSONResponse({"ok": False}, status_code=400)(scope, receive, send)
                membership = config["users"]["alice"]["memberships"]["alpha"]
                membership["permissions"] = [] if mode == "revoke" else ["read"] if mode == "read-only" else list(workspace_permissions)
                membership["profiles"] = ["business"] if mode == "business-only" else list(profiles)
                membership["default_profile"] = "business" if mode == "business-only" else "all"
                policy_path.write_text(json.dumps(config), encoding="utf-8")
                return await JSONResponse({"ok": True})(scope, receive, send)
            if path == "/fixture-stats":
                return await JSONResponse(stats)(scope, receive, send)
            if tokens.get("registration") and path.startswith("/fixture-registration-mode/") and scope["method"] == "POST":
                registration_mode = path.rsplit("/", 1)[-1]
                return await JSONResponse({"ok": True})(scope, receive, send)
            if tokens.get("sourcePreview") and path.startswith("/fixture-source-mode/") and scope["method"] == "POST":
                source_mode = path.rsplit("/", 1)[-1]
                return await JSONResponse({"ok": True})(scope, receive, send)
            if tokens.get("sourcePreview") and path == "/fixture-source-version" and scope["method"] == "POST":
                catalog = next(item for item in sources.list_sources(tenant="alpha", scope_key="fixture")["items"]
                               if item["title"] == "등록 원본")
                staged = sources.stage(BytesIO("# 새 원본 판본\n선택한 옛 판본을 바꾸지 않습니다.\n".encode()),
                                       kind="file", title="등록 원본", format="md", filename="source.md")
                sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                    source_id=catalog["source_id"], expected_registration_revision=catalog["registration_revision"],
                    authorize=lambda: access_value(policy.authorize(tokens["alice"], "alpha", "source_write")))
                return await JSONResponse({"ok": True})(scope, receive, send)
            if documents_enabled and path == "/fixture-change" and scope["method"] == "POST":
                store.save("Guide-22.md", "# Added during pagination\n", expected_revision=None)
                return await JSONResponse({"ok": True})(scope, receive, send)
            if documents_enabled and path.startswith("/fixture-mode/") and scope["method"] == "POST":
                document_mode = path.rsplit("/", 1)[-1]
                return await JSONResponse({"ok": True})(scope, receive, send)
            if documents_enabled and path.startswith("/fixture-content-mode/") and scope["method"] == "POST":
                content_mode = path.rsplit("/", 1)[-1]
                return await JSONResponse({"ok": True})(scope, receive, send)
            if documents_enabled and path == "/fixture-content-change" and scope["method"] == "POST":
                current = store.read("Guide-04.md")
                store.save("Guide-04.md", "# 바뀐 본문\n\n목록 조회 후 새 판본으로 바뀌었습니다.\n",
                           expected_revision=current.revision)
                return await JSONResponse({"ok": True})(scope, receive, send)
            stats["methods"].append(scope["method"])
            if path.startswith("/broken/"):
                return await JSONResponse({"unexpected": tokens["alice"]})(scope, receive, send)
            if path.startswith("/redirect/"):
                return await RedirectResponse("/capture")(scope, receive, send)
            if path == "/capture":
                stats["redirect_followed"] += 1
                return await JSONResponse({})(scope, receive, send)
            for prefix in ("/proxy", "/slow"):
                if path.startswith(prefix + "/"):
                    if prefix == "/slow":
                        stats["slow"] += 1
                        await asyncio.sleep(0.3)
                    scope = {**scope, "path": path[len(prefix):],
                             "raw_path": path[len(prefix):].encode()}
                    break
            if tokens.get("registration") and scope["path"].endswith("/sources") and scope["method"] == "POST":
                stats["registrations"] += 1
                if registration_mode == "pinned":
                    # 새 원본이 첫 페이지 밖에 정렬되도록 서버 발급 ID만 고정합니다.
                    with patch("core.modules.sources.commands.uuid4", side_effect=[UUID(hex="f" * 32), UUID(hex="e" * 32)]):
                        return await application(scope, receive, send)
                if registration_mode == "lost":
                    # 실제 저장은 완료하되 성공 응답을 손상해 영수증 GET만 복구하는지 확인합니다.
                    async def discard_response(message):
                        pass
                    await application(scope, receive, discard_response)
                    return await JSONResponse({"unexpected": tokens["alice"]})(scope, receive, send)
                if registration_mode == "pending":
                    actual = SourceStore._write_request
                    def fail_completion(source_store, path, record):
                        if record["state"] == "complete":
                            raise OSError("fixture completion receipt failure")
                        return actual(source_store, path, record)
                    with patch.object(SourceStore, "_write_request", fail_completion):
                        return await application(scope, receive, send)
                if registration_mode == "revoke":
                    actual = SourceStore.stage
                    def revoke_after_receive(source_store, *args, **kwargs):
                        staged = actual(source_store, *args, **kwargs)
                        config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
                        policy_path.write_text(json.dumps(config), encoding="utf-8")
                        return staged
                    with patch.object(SourceStore, "stage", revoke_after_receive):
                        return await application(scope, receive, send)
            if tokens.get("registration") and "/requests/" in scope["path"]:
                stats["receipt_requests"] += 1
            if "/sources/" in scope["path"]:
                query = scope["query_string"].decode("ascii")
                stats["source_requests"].append({"path": scope["path"], "query": query})
                if scope["path"].endswith("/file"):
                    try:
                        if source_mode == "slow":
                            await asyncio.sleep(0.35)
                        elif source_mode == "missing":
                            with patch.object(SourceStore, "open_original", side_effect=FileNotFoundError("fixture only")):
                                return await application(scope, receive, send)
                        elif source_mode == "corrupt":
                            return await Response(tokens["alice"], media_type="text/markdown",
                                headers={"X-Source-Sha256": "0" * 64})(scope, receive, send)
                        elif source_mode == "redirect":
                            return await RedirectResponse("/capture")(scope, receive, send)
                        elif source_mode == "bytes":
                            async def changed_bytes(message):
                                if message["type"] == "http.response.body" and message.get("body"):
                                    raw = message["body"]
                                    message = {**message, "body": bytes([raw[0] ^ 1]) + raw[1:]}
                                await send(message)
                            return await application(scope, receive, changed_bytes)
                        elif source_mode == "revoke":
                            # 실제 전송 후 정책을 회수해 카탈로그 재확인이 공개를 막는지 검사합니다.
                            await application(scope, receive, send)
                            config["users"]["alice"]["memberships"]["alpha"]["permissions"] = []
                            policy_path.write_text(json.dumps(config), encoding="utf-8")
                            return
                        return await application(scope, receive, send)
                    finally:
                        stats["source_completed"].append(scope["path"])
            if scope["path"].endswith("/documents"):
                stats["document_requests"].append({"path": scope["path"],
                                                   "query": scope["query_string"].decode("ascii")})
                if document_mode == "slow":
                    await asyncio.sleep(0.3)
                elif document_mode == "broken":
                    return await JSONResponse({"unexpected": tokens["alice"]})(scope, receive, send)
                elif document_mode == "partial":
                    # 실제 목록 경로에서 탐색 한도·읽기 실패를 주입해 부분 결과 표시를 검사합니다.
                    with patch("core.modules.documents.listing.MAX_LIST_FILES", 2), \
                         patch.object(WikiStore, "read", side_effect=PermissionError("fixture only")):
                        return await application(scope, receive, send)
            if scope["path"].endswith("/documents/content"):
                query = scope["query_string"].decode("ascii")
                document = parse_qs(query).get("document", [""])[0]
                stats["content_requests"].append({"path": scope["path"], "query": query})
                try:
                    if content_mode == "slow" and document == "Guide-01.md":
                        await asyncio.sleep(0.35)
                    elif content_mode == "broken":
                        return await JSONResponse({"unexpected": tokens["alice"]})(scope, receive, send)
                    elif content_mode == "missing":
                        with patch.object(WikiStore, "read", side_effect=FileNotFoundError("fixture only")):
                            return await application(scope, receive, send)
                    return await application(scope, receive, send)
                finally:
                    stats["content_completed"].append(document)
            await application(scope, receive, send)

        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(128)
            print(json.dumps({"port": listener.getsockname()[1], "policy": str(policy_path),
                              **({"workspace": workspace_data} if workspace_enabled else {})}), flush=True)
            server = uvicorn.Server(uvicorn.Config(fixture, log_level="critical", access_log=False,
                                                  timeout_graceful_shutdown=1))
            server.run(sockets=[listener])


if __name__ == "__main__":
    main()
