# prepare에서 시작해 API/MCP의 사용자·작업 일치 확인 → 실행 claim → 원본 다운로드 → 수신 보고 순서로 읽으면 된다.
# 네트워크 연결과 파일은 async with/with로 닫고, 받은 본문을 셸 명령이나 AI 실행 지시로 해석하지 않는다.

"""같은 인증 사용자의 API·MCP 작업을 대조하고 정확한 원본을 로컬로 받는다.

기본 동작은 원본 인계이며, adapter를 명시하면 개인 AI 실행과 결과 저장까지
이어간다. 원문은 실행 지침이 아니며 서버 토큰을 AI에 전달하지 않는다.
"""

import codecs
from hashlib import sha256
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from core.runtime.client_platform import private_directory, open_new, read_private, ClientPlatformError
from .inputs import receive_input
from .transport import AnalysisClientError, api_call, tool_call
from .ai.contracts import MAX_LITERAL_SOURCE_BYTES

MAX_ORIGINAL_BYTES = 20 * 1024 * 1024
_ID = re.compile(r"[0-9a-f]{32}")
_HASH = re.compile(r"[0-9a-f]{64}")


# 자격 증명/임의 query가 섞인 URL을 거부하고, loopback 이외의 서버에는 HTTPS를 요구한다.
def server_url(value):
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise AnalysisClientError("invalid_server_url")
    local = parsed.hostname == "localhost"
    try:
        local = local or ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        pass
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise AnalysisClientError("https_required")
    if any(part in {".", ".."} for part in parsed.path.split("/")) or "%" in parsed.path:
        raise AnalysisClientError("invalid_server_url")
    return value.rstrip("/")


def read_token(path):
    """그룹·다른 사용자 접근을 막은 정규 파일에서만 토큰을 읽는다."""
    try:
        raw = read_private(path, 257)
    except ClientPlatformError:
        raise AnalysisClientError("private_token_file_required") from None
    try:
        token = raw.decode("ascii").rstrip("\r\n")
    except UnicodeError:
        raise AnalysisClientError("invalid_token_file") from None
    if re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token) is None or len(raw) >= 258:
        raise AnalysisClientError("invalid_token_file")
    return token


def _identifier(value):
    if type(value) is not str or _ID.fullmatch(value) is None:
        raise AnalysisClientError("invalid_identifier")
    return value


def _private_directory(path):
    path = Path(path).absolute()
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise AnalysisClientError("unsafe_work_directory")
    try:
        return private_directory(path)
    except ClientPlatformError:
        raise AnalysisClientError("private_work_directory_required") from None



# API와 MCP에서 본 작업이 같은 사용자·tenant·원본·버전에 속하는지 비교한다.
def _same_job(api, mcp, *, job_id, tenant, user):
    keys = ("job_id", "tenant", "user_id", "job_revision", "source_ref", "targets", "outputs")
    if (any(api.get(key) != mcp.get(key) for key in keys)
            or mcp.get("job_id") != job_id or mcp.get("tenant") != tenant or mcp.get("user_id") != user):
        raise AnalysisClientError("api_mcp_job_mismatch")


async def _download(http, endpoint, directory, source):
    """원본 바이트를 검증해 새 파일로 공개한다. 줄바꿈·문자열 정규화는 하지 않는다."""
    size, digest = 0, sha256()
    expected_size, expected_hash = source.get("size_bytes"), source.get("source_sha256")
    if (type(expected_size) is not int or not 0 <= expected_size <= MAX_ORIGINAL_BYTES
            or type(expected_hash) is not str or _HASH.fullmatch(expected_hash) is None):
        raise AnalysisClientError("invalid_source_reference")
    temporary, original = directory / ".original.part", directory / "original"
    descriptor = open_new(temporary)
    try:
        with os.fdopen(descriptor, "wb") as destination:
            decoder = codecs.getincrementaldecoder("utf-8")("strict")
            async with http.stream("GET", endpoint) as response:
                if response.status_code != 200:
                    raise AnalysisClientError("source_download_failed")
                async for block in response.aiter_bytes(65536):
                    size += len(block)
                    if size > expected_size:
                        raise AnalysisClientError("source_hash_mismatch")
                    decoder.decode(block)
                    digest.update(block)
                    destination.write(block)
                decoder.decode(b"", final=True)
            if size != expected_size or digest.hexdigest() != expected_hash:
                raise AnalysisClientError("source_hash_mismatch")
            destination.flush()
            os.fsync(destination.fileno())
        # 기존 초안이 있으면 교체하지 않고 실패한다. 확인한 임시 파일만 새 이름으로 공개한다.
        os.link(temporary, original)
        return original
    finally:
        temporary.unlink(missing_ok=True)


# 이 비동기 함수는 작업 인계만 수행한다. await는 다음 단계가 쓰는 결과가 도착할 때까지 기다린다는 뜻이다.
async def prepare(*, base_url, tenant, job_id, token, work_dir, reclaim=False,
                  prepare_input=False, context_documents=None, adapter=None, profile=None,
                  expected_job_revision=None, semantic_check=False):
    """작업을 확인해 인계하고, 어댑터를 명시한 경우에만 실제 AI 단계를 실행한다."""
    base = server_url(base_url)
    _identifier(job_id)
    if expected_job_revision is not None and _HASH.fullmatch(expected_job_revision) is None:
        raise AnalysisClientError("invalid_job_revision")
    if re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", tenant) is None:
        raise AnalysisClientError("invalid_tenant")
    if profile is not None and (not isinstance(profile, str) or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile) is None):
        raise AnalysisClientError("invalid_profile")
    prepare_input = prepare_input or adapter is not None or profile is not None
    root = _private_directory(work_dir)
    async with httpx2.AsyncClient(base_url=base + "/", headers={"Authorization": "Bearer " + token},
                                 timeout=15, trust_env=False, follow_redirects=False) as http:
        api_access = await api_call(http, "GET", base + "/api/v1/access-context")
        api_job = await api_call(http, "GET", base + f"/api/v1/tenants/{tenant}/analysis-jobs/{job_id}")
        if expected_job_revision is not None and api_job.get("job_revision") != expected_job_revision:
            raise AnalysisClientError("analysis_job_changed")
        from .ai.resume import fixed_selection, completed_results
        profile, context_documents, ruleset_ref = fixed_selection(api_job, profile, context_documents)
        if adapter is not None:
            # 첫 어댑터는 명시 범위가 하나인 작업만 처리한다. 여러 문서로 임의 분할하지 않는다.
            if len(api_job["targets"]) != 1:
                raise AnalysisClientError("analysis_target_scope_required")
            if "wiki" in api_job["outputs"] and api_job["source_ref"]["size_bytes"] > MAX_LITERAL_SOURCE_BYTES:
                raise AnalysisClientError("analysis_source_limit")
        async with Client(streamable_http_client(base + "/mcp", http_client=http), mode="legacy") as mcp:
            mcp_access = await tool_call(mcp, "access_context", {})
            if (api_access.get("user_id") != mcp_access.get("user_id")
                    or api_access.get("policy_revision") != mcp_access.get("policy_revision")
                    or tenant not in api_access.get("memberships", {})
                    or tenant not in mcp_access.get("memberships", {})):
                raise AnalysisClientError("api_mcp_access_mismatch")
            job = await tool_call(mcp, "analysis_job_query", {"tenant": tenant, "job_id": job_id})
            _same_job(api_job, job, job_id=job_id, tenant=tenant, user=mcp_access["user_id"])
            completed, prior_receipts = await completed_results(mcp, tenant=tenant, job=job, profile=profile)
            required = {(target["document"], "prepare_wiki" if kind == "wiki" else "extract_ontology")
                        for target in job["targets"] for kind in job["outputs"]}
            if adapter is not None and required <= completed:
                return {"job_id": job_id, "run_id": job["run_id"], "tenant": tenant,
                    "job_revision": job["job_revision"], "lease_revision": job["lease_revision"],
                    "ai_execution": {"status": "stored", "receipts": prior_receipts,
                        "executions": [], "resumed": True, "new_execution": False, "human_approval": False}}
            if adapter is not None:
                preflight = getattr(adapter, "preflight", None)
                if preflight is not None:
                    await preflight()
            claimed = await tool_call(mcp, "analysis_job_claim", {"tenant": tenant, "job_id": job_id,
                "expected_job_revision": job["job_revision"], "reclaim": reclaim})
            run = _identifier(claimed["run_id"])
            source_input = await tool_call(mcp, "source_read", {"tenant": tenant, "job_id": job_id, "run_id": run})
            source = source_input["source_ref"]
            if source != claimed["source_ref"]:
                raise AnalysisClientError("source_reference_changed")
            source_id, version = _identifier(source["source_id"]), _identifier(source["source_version"])
            endpoint = f"/api/v1/tenants/{tenant}/sources/{source_id}/versions/{version}/file"
            if source_input.get("file_ref", endpoint) != endpoint:
                raise AnalysisClientError("unexpected_source_endpoint")
            parent = _private_directory(root / job_id)
            directory = parent / run
            private_directory(directory, exist_ok=False)  # 재연결로 기존 작업용 사본·초안을 덮어쓰지 않는다.
            fixed_input = None
            if prepare_input:
                fixed_input = await receive_input(mcp, tenant=tenant, job_id=job_id, run_id=run,
                    expected_job_revision=source_input["job_revision"], directory=directory,
                    context_documents=context_documents, profile=profile, ruleset_ref=ruleset_ref)
            original = await _download(http, base + endpoint, directory, source)
            # 입력 준비도 job을 갱신하므로 준비 후 받은 revision으로 진행 상황을 보고한다.
            reported = await tool_call(mcp, "analysis_job_update", {"tenant": tenant, "job_id": job_id,
                "run_id": run, "expected_job_revision": (fixed_input or source_input)["job_revision"],
                "reported_status": "input_ready", "message": "Host bridge received the fixed original and verified its bytes."})
            output = {"user_id": mcp_access["user_id"], "tenant": tenant, "job_id": job_id, "run_id": run,
                "job_revision": reported["job_revision"], "lease_revision": reported["lease_revision"],
                "source_ref": source, "execution_ready": reported["execution_ready"], "blockers": reported["blockers"],
                "connection_check": "authenticated_user_tenant_job_match", "backend_identity": "not_available",
                "local_file": str(original)}
            if fixed_input is not None:
                output["fixed_input"] = fixed_input
            local_record = {key: value for key, value in output.items() if key != "local_file"}
            with (directory / "handoff.json").open("x", encoding="utf-8") as stream:
                json.dump({**local_record, "original": "original"}, stream, ensure_ascii=False, indent=2)
            if adapter is not None:
                # 같은 인증된 API/MCP 연결을 쓰고, 확인한 run과 입력만 AI 실행 흐름에 넘긴다.
                from .ai.workflow import run_analysis
                output["ai_execution"] = await run_analysis(http, mcp, tenant=tenant, job_id=job_id,
                    run_id=run, directory=directory, original=original, source_ref=source,
                    job_revision=reported["job_revision"], lease_revision=reported["lease_revision"],
                    fixed_input=fixed_input, adapter=adapter, profile=profile, context_documents=context_documents,
                    completed_stages=completed, prior_receipts=prior_receipts, semantic_check=semantic_check)
                output["job_revision"] = output["ai_execution"]["job_revision"]
                output["lease_revision"] = output["ai_execution"]["lease_revision"]
                # 처음 인계 시점의 준비 상태와 지금 확인한 저장 결과를 혼동하지 않게 구분한다.
                output["handoff_readiness"] = {"execution_ready": output.pop("execution_ready"),
                                               "blockers": output.pop("blockers")}
            return output
