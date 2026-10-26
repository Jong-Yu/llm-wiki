"""명시한 추출안 실행을 개인 Codex와 후보/진단 영수증에 연결한다.

공통 입력 수신·프롬프트 조립·Codex 프로세스·lease·별도 검사를 재사용한다.
이 모듈은 항상 save=False로 제출하며 canonical 적용 API를 호출하지 않는다.
"""

import asyncio
import json
from pathlib import Path
import re
from urllib.parse import urlencode
from uuid import uuid4

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from core.client.analysis import _identifier, _private_directory, server_url, _same_job
from core.client.ai.assembly import assemble_input
from core.client.ai.lease import LeaseKeeper
from core.client.inputs import receive_input, load_input
from core.client.transport import AnalysisClientError, tool_call, client_error_code
from core.client.proposal_records import (PROTOCOL, CandidatePreview, checked_result, record,
                                         read_record, result_reference)
from core.common.json_codec import canonical_json_hash
from core.runtime.client_platform import private_directory

_SAFE_CODES = {"conflict", "access_denied", "access_unavailable", "unauthorized", "not_found",
    "invalid_argument", "storage_busy", "storage_error", "request_disconnected", "request_too_large",
    "document_too_large", "input_conflict", "input_limit", "job_conflict", "ruleset_incompatible"}


async def _call(http, method, path, body=None):
    """서버 오류 본문/토큰/주소를 출력하지 않으며 실패한 POST를 재전송하지 않는다."""
    try:
        response = await http.request(method, path, json=body)
        if len(response.content) > 20 * 1024 * 1024:
            raise AnalysisClientError("proposal_response_limit")
        value = response.json()
        if response.status_code not in {200, 201, 202}:
            code = value.get("error", {}).get("code")
            raise AnalysisClientError(code if code in _SAFE_CODES else "api_request_failed")
        if type(value.get("data")) is not dict:
            raise ValueError()
        return value["data"]
    except AnalysisClientError:
        raise
    except asyncio.CancelledError:
        raise
    except Exception:
        raise AnalysisClientError("connection_failed") from None


class ProposalExecution:
    def __init__(self, http, *, base, tenant, proposal_id, profile, directory, on_event, cancel_event):
        self.http, self.base, self.tenant = http, base, tenant
        self.proposal_id, self.profile, self.directory = proposal_id, profile, directory
        self.on_event, self.cancel_event = on_event, cancel_event or asyncio.Event()
        self.execution_id = self.job_id = self.run_id = self.request_id = None
        self.job_revision = self.fixed = self.proposal = self.execution = self.receipt = None
        self.candidate_saved = self.diagnostics_saved = False
        self.cancellation = None
        self.client = None
        self.pending = None
        self.semantic_check = False
        self.writable = False
        self.result_ref = None
        self.link_request_id = None

    def endpoint(self, suffix="", *, query=True):
        path = self.base + f"/api/v1/tenants/{self.tenant}/analysis-proposals/{self.proposal_id}" + suffix
        return path + ("?" + urlencode({"profile": self.profile}) if self.profile and query else "")

    def selected(self, body):
        return {**body, **({"profile": self.profile} if self.profile else {})}

    def emit(self, kind, **fields):
        if self.on_event:
            try:
                self.on_event({"protocol": PROTOCOL, "type": kind, "proposal_id": self.proposal_id,
                    "execution_id": self.execution_id, "job_id": self.job_id, "run_id": self.run_id,
                    "request_id": self.request_id, "work_dir": str(self.directory),
                    "result_ref": self.result_ref, "link_request_id": self.link_request_id,
                    "canonical_saved": False, "human_approval": False, **fields})
            except (OSError, BrokenPipeError):
                self.cancel_event.set()

    def check_cancel(self):
        if self.cancel_event.is_set():
            raise AnalysisClientError("proposal_cancelled")

    def finish(self, status, error=None, **extra):
        value = {"ok": status in {"prepared", "candidate_ready", "receipt"}, "status": status,
            "proposal_id": self.proposal_id, "execution_id": self.execution_id, "job_id": self.job_id,
            "run_id": self.run_id, "request_id": self.request_id, "work_dir": str(self.directory),
            "candidate_saved": self.candidate_saved, "diagnostics_saved": self.diagnostics_saved,
            "canonical_saved": False, "human_approval": False, "receipt": self.receipt,
            "error": {"code": error} if error else None, "cancellation": self.cancellation,
            "semantic_validation": "client_reported" if self.diagnostics_saved else "not_run",
            "automatic_retry": False, **extra}
        value.update(result_ref=self.result_ref, link_request_id=self.link_request_id)
        try:
            record(self.directory, "result-" + uuid4().hex + ".json", value)
        except (OSError, AnalysisClientError):
            value["local_record_error"] = "proposal_local_record_failed"
        return value

    async def read_execution(self):
        value = await _call(self.http, "GET", self.endpoint("/executions/" + self.execution_id))
        if value.get("proposal_id") != self.proposal_id or value.get("execution_id") != self.execution_id:
            raise AnalysisClientError("proposal_execution_mismatch")
        if self.execution and any(value.get(key) != self.execution.get(key) for key in ("input_revision", "job_id", "plan_ref")):
            raise AnalysisClientError("proposal_execution_mismatch")
        return value

    async def current(self, *, exact_job=True):
        self.check_cancel()
        access = await _call(self.http, "GET", self.base + "/api/v1/access-context")
        membership = access.get("memberships", {}).get(self.tenant, {})
        if not {"source_write", "ontology_write"} <= set(membership.get("permissions", [])):
            raise AnalysisClientError("access_denied")
        if self.profile not in membership.get("profiles", []):
            raise AnalysisClientError("access_denied")
        value = await self.read_execution()
        if value.get("state") not in {"ready", "candidate_ready"}:
            raise AnalysisClientError("proposal_execution_" + value["state"] if value.get("state") in {
                "cancelled", "superseded", "basis_changed", "pending_reconcile"} else "proposal_execution_changed")
        job = value["job"]
        if self.run_id and (job["run_id"] != self.run_id or job["state"] != "claimed" or job["lease_status"] != "active"):
            raise AnalysisClientError("proposal_lease_lost")
        if exact_job and self.job_revision is not None and job["job_revision"] != self.job_revision:
            raise AnalysisClientError("proposal_job_changed")
        return value

    async def guarded(self, operation, lease):
        async def monitor():
            while True:
                await asyncio.sleep(2)
                await self.current()
        work = asyncio.create_task(lease.guard(operation))
        watch = asyncio.create_task(monitor())
        cancel = asyncio.create_task(self.cancel_event.wait())
        try:
            await asyncio.wait((work, watch, cancel), return_when=asyncio.FIRST_COMPLETED)
            self.check_cancel()
            if watch.done():
                await watch
            return await work
        finally:
            for task in (work, watch, cancel):
                task.cancel()
            await asyncio.gather(work, watch, cancel, return_exceptions=True)

    async def submit_result(self, name, arguments):
        """서버 초안 보존과 정확한 payload 지문 확인. 기존 요청은 GET만 수행한다."""
        prior = read_record(self.directory, name + "-result-request.json")
        if prior is not None:
            arguments = prior
        else:
            record(self.directory, name + "-result-request.json", arguments)
            self.pending = "result"
            self.request_id = arguments["request_id"]
            self.emit("progress", phase="submitting_" + name)
            try:
                # 이미 전송한 요청의 응답 확인은 취소 입력보다 먼저 끝낸다.
                await tool_call(self.client, "analysis_job_ontology_generate", arguments)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
        self.request_id = arguments["request_id"]
        self.result_ref = result_reference(arguments)
        self.pending = "result"
        try:
            value = await tool_call(self.client, "analysis_job_result_query", {
                "tenant": self.tenant, "job_id": arguments["job_id"], "request_id": arguments["request_id"]})
        except Exception:
            raise AnalysisClientError("proposal_result_unconfirmed") from None
        value = checked_result(value, arguments)
        self.pending = None
        self.job_revision = value["job_revision"]
        record(self.directory, name + "-result-receipt.json", {
            key: item for key, item in value.items() if key not in {"job_revision", "replayed", "current_output", "access"}})
        return arguments

    def checked_link(self, value, body=None):
        if value.get("proposal_id") != self.proposal_id or value.get("request_id") != self.request_id:
            raise AnalysisClientError("proposal_receipt_mismatch")
        if value.get("canonical_changed") is not False or value.get("saved") is not False:
            raise AnalysisClientError("proposal_receipt_mismatch")
        if value.get("mode") not in {"candidate", "diagnostics"} or not isinstance(value.get("result_ref"), dict):
            raise AnalysisClientError("proposal_receipt_mismatch")
        if body and (value.get("mode") != body["mode"] or value.get("execution_id") != body["execution_id"]
                     or any(value["result_ref"].get(key) != item for key, item in body["result_ref"].items())):
            raise AnalysisClientError("proposal_receipt_mismatch")
        if body and value.get("payload_hash") != canonical_json_hash({key: item for key, item in body.items()
                                                                     if key not in {"request_id", "profile"}}):
            raise AnalysisClientError("proposal_receipt_mismatch")
        if value.get("state") != "complete":
            raise AnalysisClientError("proposal_link_unconfirmed")
        return value

    async def link(self, name, arguments, *, read_only=False):
        filename = name + "-link-request.json"
        body = read_record(self.directory, filename)
        if body is None:
            if read_only:
                raise AnalysisClientError("proposal_link_not_submitted")
            self.check_cancel()
            await self.current()
            # 대상 판본은 처음 읽은 proposal 또는 확인된 자기 candidate 연결 결과다.
            body = {"request_id": uuid4().hex, "expected_state_revision": self.proposal["state_revision"],
                "candidate_revision": (self.proposal.get("candidate_ref") or {}).get("candidate_revision"),
                "execution_id": self.execution_id, "mode": "candidate" if name == "candidate" else "diagnostics",
                "result_ref": result_reference(arguments), "resolves_decision_ids": [], "resolution_bindings": []}
            record(self.directory, filename, body)
            self.request_id, self.pending = body["request_id"], "link"
            self.emit("progress", phase="linking_" + name)
            try:
                await _call(self.http, "POST", self.endpoint("/result-links", query=False), self.selected(body))
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
        self.request_id, self.pending = body["request_id"], "link"
        self.link_request_id = self.request_id
        if body["execution_id"] != self.execution_id or body["result_ref"] != result_reference(arguments):
            raise AnalysisClientError("proposal_receipt_mismatch")
        if name == "candidate":
            self.candidate_saved = None
        else:
            self.diagnostics_saved = None
        try:
            value = await _call(self.http, "GET", self.endpoint("/requests/" + self.request_id))
        except AnalysisClientError:
            raise AnalysisClientError("proposal_link_unconfirmed") from None
        self.receipt = self.checked_link(value, body)
        self.pending = None
        if name == "candidate":
            self.candidate_saved = True
        else:
            self.diagnostics_saved = True
        # 현재 상태와 저장 증거는 별개다. 자기 후보가 아닌 변경은 자동 승계하지 않는다.
        self.proposal = await _call(self.http, "GET", self.endpoint())
        if self.proposal.get("candidate_ref") != self.receipt.get("candidate_ref"):
            raise AnalysisClientError("proposal_candidate_changed")
        self.emit("progress", phase=name + "_saved", candidate_saved=self.candidate_saved,
                  diagnostics_saved=self.diagnostics_saved, receipt=self.receipt)

    async def stop(self, cancelled=False):
        if not self.writable or not self.job_id or self.pending:
            return
        try:
            job = (await self.read_execution())["job"]
            if job["run_id"] != self.run_id:
                return
            if cancelled:
                if job["state"] != "cancelled":
                    job = await _call(self.http, "POST", self.base + f"/api/v1/tenants/{self.tenant}/analysis-jobs/{self.job_id}/cancel",
                        {"expected_job_revision": job["job_revision"], "reason": "Personal proposal execution cancelled."})
                self.cancellation = "confirmed" if job["state"] == "cancelled" else "unconfirmed"
            elif self.run_id and self.client and self.job_revision == job["job_revision"]:
                await tool_call(self.client, "analysis_job_update", {"tenant": self.tenant, "job_id": self.job_id,
                    "run_id": self.run_id, "expected_job_revision": self.job_revision, "reported_status": "stopped",
                    "message": "Personal proposal runner stopped. Inspect candidate and diagnostic receipts; canonical unchanged."})
        except Exception:
            if cancelled:
                self.cancellation = "unconfirmed"

    async def execute(self, *, adapter, execution_id, request_id, expected_proposal_revision, reason,
                      semantic_check, resume, cancel, receipt_request_id):
        self.writable = adapter is not None or cancel
        try:
            self.check_cancel()
            access = await _call(self.http, "GET", self.base + "/api/v1/access-context")
            self.proposal = await _call(self.http, "GET", self.endpoint())
            actor = self.proposal["basis"]["actor"]
            if actor["user_id"] != access["user_id"] or actor["tenant"] != self.tenant:
                raise AnalysisClientError("proposal_owner_mismatch")
            if self.profile is not None and self.profile != actor["profile_id"]:
                raise AnalysisClientError("proposal_profile_mismatch")
            self.profile = actor["profile_id"]
            session = {"server": self.base, "tenant": self.tenant, "proposal_id": self.proposal_id,
                       "profile": self.profile, "user_id": access["user_id"], "protocol": PROTOCOL}
            record(self.directory, "session.json", session)
            if receipt_request_id:
                self.request_id = receipt_request_id
                self.receipt = self.checked_link(await _call(self.http, "GET", self.endpoint("/requests/" + receipt_request_id)))
                self.candidate_saved = bool(self.receipt.get("candidate_ref"))
                self.diagnostics_saved = self.receipt["mode"] == "diagnostics"
                return self.finish("receipt")
            previous = read_record(self.directory, "execution.json") if resume else None
            start_body = read_record(self.directory, "start-request.json") if resume else None
            if previous:
                if execution_id is not None and execution_id != previous["execution_id"]:
                    raise AnalysisClientError("proposal_execution_mismatch")
                execution_id = previous["execution_id"]
            elif start_body:
                # 생성 응답 유실도 동일 요청의 조회로만 확인한다.
                execution_id = start_body["request_id"]
            if execution_id is None:
                if adapter is None:
                    return self.finish("prepared")
                if expected_proposal_revision != self.proposal["state_revision"]:
                    raise AnalysisClientError("proposal_changed")
                await adapter.preflight()
                self.check_cancel()
                self.execution_id = request_id or uuid4().hex
                self.request_id = self.execution_id
                body = {"request_id": self.execution_id, "expected_state_revision": expected_proposal_revision,
                    "candidate_revision": (self.proposal.get("candidate_ref") or {}).get("candidate_revision"), "reason": reason}
                start_body = body
                record(self.directory, "start-request.json", body)
                self.pending = "start"
                self.emit("progress", phase="starting")
                try:
                    await _call(self.http, "POST", self.endpoint("/executions", query=False), self.selected(body))
                except AnalysisClientError:
                    pass
            else:
                self.execution_id = execution_id
            self.execution = await self.read_execution()
            if start_body and (self.execution.get("payload_hash") != canonical_json_hash({
                    key: value for key, value in start_body.items() if key != "request_id"})
                    or self.execution.get("proposal_state_revision") != start_body["expected_state_revision"]):
                raise AnalysisClientError("proposal_execution_mismatch")
            if previous and any(previous.get(key) != self.execution.get(key) for key in
                                ("input_revision", "job_id", "plan_ref", "execution_revision")):
                raise AnalysisClientError("proposal_execution_mismatch")
            self.pending = None
            self.job_id = self.execution.get("job_id")
            if not self.job_id:
                raise AnalysisClientError("proposal_execution_unconfirmed")
            record(self.directory, "execution.json", previous or self.execution)
            self.proposal = await _call(self.http, "GET", self.endpoint())
            pinned = read_record(self.directory, "proposal-basis.json")
            if pinned is None:
                record(self.directory, "proposal-basis.json", self.proposal)
            elif resume:
                self.proposal = pinned
            self.run_id = self.execution["job"]["run_id"]
            if cancel:
                # 서버 실행은 claim 전에도 취소할 수 있다.
                job = self.execution["job"]
                if job["state"] != "cancelled":
                    job = await _call(self.http, "POST", self.base + f"/api/v1/tenants/{self.tenant}/analysis-jobs/{self.job_id}/cancel",
                        {"expected_job_revision": job["job_revision"], "reason": "Explicit proposal cancellation."})
                self.cancellation = "confirmed" if job["state"] == "cancelled" else "unconfirmed"
                return self.finish("cancelled")
            if adapter is None and not resume:
                return self.finish("prepared", execution=self.execution)
            async with Client(streamable_http_client(self.base + "/mcp", http_client=self.http), mode="legacy") as client:
                self.client = client
                mcp_access = await tool_call(client, "access_context", {})
                if any(mcp_access.get(key) != access.get(key) for key in ("user_id", "policy_revision")):
                    raise AnalysisClientError("api_mcp_access_mismatch")
                job = await tool_call(client, "analysis_job_query", {"tenant": self.tenant, "job_id": self.job_id})
                _same_job(self.execution["job"], job, job_id=self.job_id, tenant=self.tenant, user=access["user_id"])
                self.semantic_check = semantic_check
                self.fixed = read_record(self.directory, "fixed.json") if resume else None
                if resume:
                    return await self.resume_run(adapter, job)
                if self.execution["state"] != "ready":
                    raise AnalysisClientError("proposal_new_execution_required")
                await self.current(exact_job=False)
                await adapter.preflight()
                self.check_cancel()
                claimed = await tool_call(client, "analysis_job_claim", {"tenant": self.tenant, "job_id": self.job_id,
                    "expected_job_revision": job["job_revision"], "reclaim": False})
                self.run_id, self.job_revision = claimed["run_id"], claimed["job_revision"]
                record(self.directory, "claim.json", claimed)
                self.emit("progress", phase="claimed")
                self.fixed = await receive_input(client, tenant=self.tenant, job_id=self.job_id, run_id=self.run_id,
                    expected_job_revision=self.job_revision, directory=self.directory, stage="extract_ontology",
                    target_document=self.proposal["basis"]["target_document"], profile=self.profile,
                    ruleset_ref=self.proposal["basis"]["ruleset_ref"] if "origin" not in self.proposal["basis"]["ruleset_ref"]
                    else {key: self.proposal["basis"]["ruleset_ref"][key] for key in ("ruleset_id", "ruleset_version", "ruleset_revision")})
                self.job_revision = self.fixed["job_revision"]
                record(self.directory, "fixed.json", self.fixed)
                return await self.run_stages(adapter, claimed["lease_revision"])
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            code = client_error_code(error) or ("proposal_cancelled" if isinstance(error, asyncio.CancelledError) else "proposal_execution_failed")
            cancelled = code in {"proposal_cancelled", "proposal_execution_cancelled"}
            await self.stop(cancelled)
            status = "unconfirmed" if self.pending else "cancelled" if cancelled else "partial" if self.candidate_saved else "failed"
            return self.finish(status, code)

    async def resume_run(self, adapter, job):
        """저장 요청은 조회만 한다. 명시 재개도 기존 모델 출력과 불변 입력을 재사용한다."""
        if self.fixed is None:
            if adapter is None:
                return self.finish("prepared", execution=self.execution)
            raise AnalysisClientError("proposal_new_execution_required")
        self.run_id, self.job_revision = self.fixed["run_id"], job["job_revision"]
        load_input(self.fixed, self.directory)
        for name in ("candidate", "semantic"):
            arguments = read_record(self.directory, name + "-result-request.json")
            if arguments is not None:
                await self.submit_result(name, arguments)
                if read_record(self.directory, name + "-link-request.json") is not None:
                    await self.link(name, arguments, read_only=True)
                elif adapter is None:
                    raise AnalysisClientError("proposal_link_not_submitted")
        if adapter is None or self.candidate_saved and (not self.semantic_check or self.diagnostics_saved):
            return self.finish("candidate_ready" if self.candidate_saved else "prepared")
        if self.fixed["run_id"] != job["run_id"]:
            raise AnalysisClientError("proposal_new_execution_required")
        await self.current()
        if read_record(self.directory, "draft.json") is None:
            raise AnalysisClientError("proposal_new_execution_required")
        return await self.run_stages(adapter, job["lease_revision"])

    async def run_stages(self, adapter, lease_revision):
        document = self.proposal["basis"]["target_document"]
        assembled = assemble_input(self.fixed, self.directory, stage="extract_ontology", target_document=document)
        record(self.directory, "assembly.json", assembled["assembly"])
        target = next(item for item in assembled["manifest"]["dependency"]["documents"] if item["document"] == document)
        async with LeaseKeeper(self.http, tenant=self.tenant, job_id=self.job_id, run_id=self.run_id,
                               lease_revision=lease_revision) as lease:
            draft = read_record(self.directory, "draft.json")
            if draft is None:
                await self.current()
                self.emit("progress", phase="extracting")
                draft = await self.guarded(adapter.run(prompt=assembled["prompt"], schema=assembled["schema"],
                    output_schema=assembled["cli_schema"], directory=self.directory / "invocation",
                    on_event=CandidatePreview(self.emit)), lease)
                record(self.directory, "draft.json", draft)
                text = json.dumps(draft["value"]["submission"], ensure_ascii=False)
                raw = text.encode("utf-8")
                self.emit("candidate_preview", text=raw[:65536].decode("utf-8", errors="ignore"),
                          complete=len(raw) <= 65536, truncated=len(raw) > 65536, saved=False)
            observed = draft["execution"]
            if observed.get("status") != "completed" or observed.get("prompt_sha256") != assembled["assembly"]["prompt_sha256"]:
                raise AnalysisClientError("proposal_draft_mismatch")
            execution = {key: observed.get(key) for key in ("provider", "cli_version", "requested_model", "reported_model",
                        "prompt_sha256", "schema_sha256", "output_sha256")}
            execution["published_schema_sha256"] = assembled["assembly"]["published_schema_sha256"]
            async def submit(name, report):
                await self.current()
                lease.check()
                arguments = {"tenant": self.tenant, "profile": self.profile, "job_id": self.job_id, "run_id": self.run_id,
                    "expected_job_revision": self.job_revision, "bundle_id": self.fixed["bundle_id"],
                    "bundle_revision": self.fixed["bundle_revision"], "request_id": uuid4().hex, "document": document,
                    "expected_revision": target["source_revision"], "expected_state_revision": target["state_revision"],
                    "submission": draft["value"]["submission"], "diagnostics": report, "execution": execution, "save": False}
                arguments = await self.submit_result(name, arguments)
                await self.link(name, arguments)
            await submit("candidate", draft["value"]["diagnostics"])
            if self.semantic_check:
                from core.client.semantic_check import run_semantic_check
                report = read_record(self.directory, "semantic-report.json")
                if report is None:
                    await self.current()
                    self.emit("progress", phase="semantic_check")
                    report = await self.guarded(run_semantic_check(fixed_input=self.fixed, directory=self.directory,
                        target_document=document, submission=draft["value"]["submission"], adapter=adapter,
                        output_directory=self.directory / "semantic-check"), lease)
                    record(self.directory, "semantic-report.json", report)
                await submit("semantic", report)
            lease.check()
        await self.stop()
        return self.finish("candidate_ready")


async def run_proposal(*, base_url, tenant, token, work_dir, proposal_id, profile=None, adapter=None,
                       execution_id=None, request_id=None, expected_proposal_revision=None,
                       reason="Explicit personal AI re-extraction", semantic_check=False, resume_dir=None,
                       cancel=False, receipt_request_id=None, on_event=None, cancel_event=None):
    """인증된 사용자 범위를 확인하고 명시 adapter에서만 AI 실행을 시작한다."""
    base = server_url(base_url)
    _identifier(proposal_id)
    for value in (execution_id, request_id, receipt_request_id):
        if value is not None:
            _identifier(value)
    for name, value in (("tenant", tenant), ("profile", profile)):
        if (value is None and name == "tenant") or (value is not None and (not isinstance(value, str)
                or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value) is None)):
            raise AnalysisClientError("invalid_" + name)
    if sum((adapter is not None, cancel, receipt_request_id is not None)) > 1:
        raise AnalysisClientError("proposal_mode_conflict")
    if cancel and not execution_id or semantic_check and adapter is None:
        raise AnalysisClientError("proposal_execution_required")
    if expected_proposal_revision is not None and re.fullmatch(r"[0-9a-f]{64}", expected_proposal_revision) is None:
        raise AnalysisClientError("invalid_proposal_revision")
    if not isinstance(reason, str) or not 1 <= len(reason) <= 1000:
        raise AnalysisClientError("invalid_proposal_reason")
    root = _private_directory(work_dir)
    if resume_dir:
        directory = Path(resume_dir).absolute()
        if directory.parent != root or not directory.name.startswith("proposal-"):
            raise AnalysisClientError("unsafe_proposal_resume_directory")
        directory = _private_directory(directory)
        if read_record(directory, "session.json") is None:
            raise AnalysisClientError("proposal_resume_missing")
    else:
        directory = private_directory(root / ("proposal-" + uuid4().hex), exist_ok=False)
    async with httpx2.AsyncClient(base_url=base + "/", headers={"Authorization": "Bearer " + token},
            timeout=15, trust_env=False, follow_redirects=False) as http:
        runner = ProposalExecution(http, base=base, tenant=tenant, proposal_id=proposal_id, profile=profile,
            directory=directory, on_event=on_event, cancel_event=cancel_event)
        return await runner.execute(adapter=adapter, execution_id=execution_id, request_id=request_id,
            expected_proposal_revision=expected_proposal_revision, reason=reason, semantic_check=semantic_check,
            resume=bool(resume_dir), cancel=cancel, receipt_request_id=receipt_request_id)
