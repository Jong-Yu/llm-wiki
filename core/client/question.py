"""개인 PC에서 고정 질문을 실행하고 정확한 답변 저장 영수증을 확인한다.

서버는 원장·권한·근거·사용권을 검사한다. 이 모듈만 개인 AI 어댑터를 호출한다.
전송 전에 요청을 보존하며 응답 유실을 새 요청/모델 재실행으로 해결하지 않는다.
"""

import asyncio
import inspect
import math
import re
from urllib.parse import urlencode
from uuid import uuid4

import httpx2

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.client.analysis import _identifier, _private_directory, server_url
from core.client.transport import AnalysisClientError
from core.client.question_ai import AnswerPreview, assemble_question, answer_payload, question_answer_schema
from core.runtime.client_platform import private_directory, write_new

PROTOCOL = "question-cli-v1"
# 알 수 없는 서버 오류/전송 예외 원문에는 비밀이 섞일 수 있어 출력하지 않는다.
_SAFE_CODES = {"conflict", "access_denied", "access_unavailable", "unauthorized", "not_found",
    "invalid_argument", "storage_busy", "personal_limit", "record_corrupt", "storage_error",
    "request_disconnected", "request_too_large", "document_too_large"}


class QuestionClientError(AnalysisClientError):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.status = status


async def _call(http, method, path, body=None):
    """HTTP/업무 실패 코드를 구분하되 서버 메시지·전송 예외는 내보내지 않는다."""
    try:
        response = await http.request(method, path, json=body)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        raise QuestionClientError("connection_failed") from error
    if len(response.content) > 8 * 1024 * 1024:
        raise QuestionClientError("question_response_limit")
    try:
        value = response.json()
        if response.status_code not in {200, 201, 202}:
            code = value.get("error", {}).get("code")
            raise QuestionClientError(code if code in _SAFE_CODES else "api_request_failed", response.status_code)
        if type(value["data"]) is not dict:
            raise ValueError()
        return value["data"]
    except (KeyError, TypeError, ValueError) as error:
        raise QuestionClientError("invalid_api_result") from error


def _profile(value):
    if value is not None and (not isinstance(value, str) or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value) is None):
        raise QuestionClientError("invalid_profile")
    return value


def _known_receipt(value, question_run_id, request_id, payload=None):
    """반환된 영수증의 정확한 실행/요청 계보를 확인한다. 본문 유사성은 사용하지 않는다."""
    if value.get("record_id") != question_run_id or value.get("request_id") != request_id:
        raise QuestionClientError("question_receipt_mismatch")
    if value.get("saved") is True:
        receipt = value.get("receipt")
        if not isinstance(receipt, dict) or receipt.get("question_run_id") != question_run_id or receipt.get("answer_turn_id") != request_id:
            raise QuestionClientError("question_receipt_mismatch")
        if payload is not None and any(receipt.get("execution", {}).get(key) != payload["execution"][key]
                for key in ("input_sha256", "output_sha256", "prompt_sha256")):
            raise QuestionClientError("question_receipt_mismatch")
    elif value.get("saved") is not None and not (value.get("saved") is False and value.get("state") == "rejected"):
        raise QuestionClientError("question_receipt_mismatch")
    return value


class _QuestionExecution:
    def __init__(self, http, *, base, tenant, directory, profile, on_event, cancel_event,
                 poll_seconds, heartbeat_seconds):
        self.http, self.base = http, base + f"/api/v1/tenants/{tenant}"
        self.tenant, self.profile, self.directory = tenant, profile, directory
        self.on_event, self.cancel_event = on_event, cancel_event or asyncio.Event()
        self.poll_seconds, self.heartbeat_seconds = poll_seconds, heartbeat_seconds
        self.question_run_id = self.run_id = self.request_id = None
        self.state = self.receipt = None
        self.submitted = False
        self.cancellation = None
        self.lock = asyncio.Lock()

    def emit(self, kind, **fields):
        if self.on_event is not None:
            try:
                self.on_event({"protocol": PROTOCOL, "type": kind, "question_run_id": self.question_run_id,
                    "run_id": self.run_id, **fields})
            except (OSError, BrokenPipeError):
                self.cancel_event.set()

    def endpoint(self, suffix="", *, query=None):
        path = self.base + "/question-runs/" + self.question_run_id + suffix
        params = {**({"profile": self.profile} if self.profile else {}), **(query or {})}
        return path + ("?" + urlencode(params) if params else "")

    def selected(self, body):
        return {**body, **({"profile": self.profile} if self.profile else {})}

    def record(self, name, value):
        write_new(self.directory / name, canonical_json_bytes(value))

    async def read(self):
        return await _call(self.http, "GET", self.endpoint())

    async def command(self, operation, fields=None):
        """진행과 heartbeat의 서로 다른 CAS를 직렬화하며 유실 응답은 읽기로 확인한다."""
        async with self.lock:
            request_id = uuid4().hex
            body = {"request_id": request_id, **(fields or {})}
            if operation == "heartbeat":
                body.update(run_id=self.run_id, expected_lease_revision=self.state["lease_revision"])
            else:
                body["expected_state_revision"] = self.state["state_revision"]
                if operation == "progress":
                    body["run_id"] = self.run_id
            self.record(f"{operation}-{request_id}.json", body)
            try:
                current = await _call(self.http, "POST", self.base + "/question-runs/" + self.question_run_id + "/" + operation,
                    self.selected(body))
            except QuestionClientError as error:
                # 명백한 거부도 다시 쓰지 않는다. 읽기에서 바로 이 요청의 지문이 확인돼야 한다.
                try:
                    current = await self.read()
                except QuestionClientError:
                    raise error
                if current["record"]["requests"].get(request_id) != canonical_json_hash(body):
                    raise error
            self.state = current
            return current

    def check_cancel(self):
        if self.cancel_event.is_set():
            raise QuestionClientError("question_cancelled")

    def check_active(self, current):
        runtime = current["runtime"]
        if runtime["status"] == "cancelled":
            raise QuestionClientError("question_cancelled")
        if runtime["status"] != "running" or runtime["run_id"] != self.run_id or current["lease_status"] != "active":
            raise QuestionClientError("question_lease_lost")
        if current["state_revision"] != self.state["state_revision"]:
            raise QuestionClientError("question_run_changed")
        before, now = self.state.get("access", {}), current.get("access", {})
        if any(before.get(key) != now.get(key) for key in ("user_id", "tenant", "profile_id", "domain", "viewpoint")):
            raise QuestionClientError("question_profile_changed")

    async def monitor(self):
        next_heartbeat = asyncio.get_running_loop().time() + self.heartbeat_seconds
        while True:
            await asyncio.sleep(self.poll_seconds)
            async with self.lock:
                self.check_active(await self.read())
            if asyncio.get_running_loop().time() >= next_heartbeat:
                # 모델 완료가 이미 보낸 heartbeat의 응답을 버리면 서버만 lease CAS가
                # 바뀐다. 종료 때도 같은 요청의 확인/복구를 마친 뒤 최신 상태를 유지한다.
                heartbeat = asyncio.create_task(self.command("heartbeat"))
                try:
                    current = await asyncio.shield(heartbeat)
                except asyncio.CancelledError:
                    await heartbeat
                    raise
                self.check_active(current)
                self.emit("phase", phase="heartbeat", saved=False)
                next_heartbeat = asyncio.get_running_loop().time() + self.heartbeat_seconds

    async def guarded_model(self, adapter, prompt, schema):
        """취소/원격 취소/사용권 실패가 먼저 오면 어댑터가 자기 자식만 종료할 때까지 기다린다."""
        preview = AnswerPreview(self.emit)
        options = {"prompt": prompt, "schema": schema, "directory": self.directory / "invocation"}
        old_callback = getattr(adapter, "on_event", None)
        if "on_event" in inspect.signature(adapter.run).parameters:
            options["on_event"] = preview
        elif hasattr(adapter, "on_event"):
            adapter.on_event = preview
        work = asyncio.create_task(adapter.run(**options))
        monitor = asyncio.create_task(self.monitor())
        cancellation = asyncio.create_task(self.cancel_event.wait())
        try:
            await asyncio.wait((work, monitor, cancellation), return_when=asyncio.FIRST_COMPLETED)
            self.check_cancel()
            if monitor.done():
                await monitor
            return await work
        finally:
            for task in (work, monitor, cancellation):
                task.cancel()
            await asyncio.gather(work, monitor, cancellation, return_exceptions=True)
            if hasattr(adapter, "on_event"):
                adapter.on_event = old_callback

    async def submit(self, body):
        """최종 전송 뒤에는 취소보다 저장 영수증 확인이 우선이다. POST를 반복하지 않는다."""
        self.request_id = body["request_id"]
        self.record("answer-request.json", self.selected(body))
        self.emit("answer_request", request_id=self.request_id, saved=False)
        self.check_cancel()
        self.submitted = True
        task = asyncio.create_task(_call(self.http, "POST", self.base + "/question-runs/" + self.question_run_id + "/answers",
            self.selected(body)))
        try:
            # 호출자가 Task를 취소해도 이미 보낸 저장 요청을 버려 성공/실패를 추측하지 않는다.
            try:
                result = await asyncio.shield(task)
            except asyncio.CancelledError:
                self.cancel_event.set()
                result = await task
        except QuestionClientError as original:
            try:
                result = await _call(self.http, "GET", self.endpoint("/answers/" + self.request_id))
            except QuestionClientError:
                if original.status in {400, 401, 403, 404, 409, 413, 422}:
                    self.submitted = False  # 서버가 이 새 요청을 명시 거부했다.
                    raise original
                raise QuestionClientError("question_answer_unconfirmed") from original
        self.receipt = _known_receipt(result, self.question_run_id, self.request_id, body)
        return self.finish_receipt()

    def finish_receipt(self):
        saved = self.receipt.get("saved")
        if saved is True:
            return self.finish("stored", True, warnings=self.receipt.get("cleanup_failures", []),
                reconciliation_required=self.receipt.get("state") != "complete")
        return self.finish("failed" if saved is False else "unconfirmed", saved,
            error="question_answer_rejected" if saved is False else "question_answer_unconfirmed")

    def finish(self, status, saved, *, error=None, **extra):
        value = {"ok": status in {"stored", "prepared", "receipt"} or status == "cancelled" and self.cancellation == "confirmed", "status": status, "saved": saved,
            "question_run_id": self.question_run_id, "run_id": self.run_id, "request_id": self.request_id,
            "receipt": self.receipt, "error": {"code": error} if error else None,
            "work_dir": str(self.directory), "origin": "client_reported", "human_approval": False,
            "semantic_validation": "not_run", "cancellation": self.cancellation, **extra}
        try:
            self.record("result.json", value)
        except OSError:
            # 서버 저장 성공과 로컬 파일 보존 실패를 뒤섞지 않는다.
            value["local_record_error"] = "question_local_record_failed"
        return value

    async def stop(self, *, cancelled):
        if self.state is None or self.submitted:
            return
        try:
            if cancelled:
                if self.state["runtime"]["status"] == "cancelled":
                    self.cancellation = "confirmed"
                    return
                current = await self.command("cancel")
                self.cancellation = "confirmed" if current["runtime"]["status"] == "cancelled" else "unconfirmed"
            elif self.run_id:
                await self.command("progress", {"progress": "failed", "message": "Personal question runner stopped; inspect preserved local draft and receipts."})
        except Exception:
            if cancelled:
                # 외부 취소와의 CAS 충돌이면 같은 실행의 취소 상태만 읽어 확인한다.
                try:
                    current = await self.read()
                    if current["runtime"]["status"] == "cancelled" and current["runtime"]["run_id"] == self.run_id:
                        self.cancellation = "confirmed"
                    else:
                        self.cancellation = "unconfirmed"
                except Exception:
                    self.cancellation = "unconfirmed"

    async def execute(self, *, question_run_id, conversation_id, question_turn_id, expected_conversation_revision,
                      create_request_id, adapter, reclaim, cancel, receipt_request_id):
        try:
            self.check_cancel()
            access = await _call(self.http, "GET", self.base.split("/api/v1/tenants/")[0] + "/api/v1/access-context")
            if self.tenant not in access.get("memberships", {}):
                raise QuestionClientError("access_denied")
            if question_run_id is None:
                if self.profile is None:
                    conversation = await _call(self.http, "GET", self.base + "/conversations/" + conversation_id)
                    question = next((turn for turn in conversation["record"]["events"]
                        if turn["id"] == question_turn_id and turn["role"] == "user"), None)
                    if question is None:
                        raise QuestionClientError("question_turn_missing")
                    self.profile = _profile(question["basis"]["scope"]["profile"]["profile_id"])
                request_id = create_request_id or uuid4().hex
                body = {"request_id": request_id, "conversation_id": conversation_id, "question_turn_id": question_turn_id,
                    "expected_conversation_revision": expected_conversation_revision}
                self.record("create-request.json", self.selected(body))
                try:
                    made = await _call(self.http, "POST", self.base + "/question-runs", self.selected(body))
                except QuestionClientError as original:
                    try:
                        made = await _call(self.http, "GET", self.base + "/personal-requests/question-runs/" + request_id
                            + ("?" + urlencode({"profile": self.profile}) if self.profile else ""))
                    except QuestionClientError:
                        raise original
                    payload = {key: value for key, value in body.items() if key != "request_id"}
                    if made["record"]["requests"].get(request_id) != canonical_json_hash(payload):
                        raise QuestionClientError("question_creation_mismatch")
                question_run_id = made["record"]["id"]
            self.question_run_id = _identifier(question_run_id)
            self.state = await self.read()
            record = self.state["record"]
            if record["tenant"] != self.tenant or record["user_id"] != access["user_id"]:
                raise QuestionClientError("question_owner_mismatch")
            if receipt_request_id:
                # 과거 실행 관점을 더 이상 사용할 수 없어도 현재 read/소유권으로
                # 영수증을 확인한다. 읽기만 하므로 새 실행 권한으로 승격하지 않는다.
                self.request_id, self.run_id = receipt_request_id, self.state["runtime"]["run_id"]
                self.receipt = _known_receipt(await _call(self.http, "GET", self.endpoint("/answers/" + receipt_request_id)),
                    question_run_id, receipt_request_id)
                return self.finish_receipt()
            frozen_profile = record["data"]["basis"]["scope"]["profile"]["profile_id"]
            if self.profile is not None and self.profile != frozen_profile:
                raise QuestionClientError("question_profile_mismatch")
            self.profile = _profile(frozen_profile)
            self.state = await self.read()  # 최초 기본 관점 대신 고정 관점으로 현재 인가를 재확인한다.
            self.emit("phase", phase="prepared", saved=False)
            # 저장되었거나 미확인인 기존 전송이 있으면 모델을 재실행하지 않는다.
            existing = [item for item in self.state["answer_requests"] if item.get("saved") is not False]
            if existing:
                self.receipt = _known_receipt(existing[-1], question_run_id, existing[-1]["request_id"])
                self.request_id = self.receipt["request_id"]
                return self.finish_receipt()
            if cancel:
                self.run_id = self.state["runtime"]["run_id"]
                await self.stop(cancelled=True)
                return self.finish("cancelled" if self.cancellation == "confirmed" else "unconfirmed", False,
                    error=None if self.cancellation == "confirmed" else "question_cancel_unconfirmed")
            if adapter is None:
                return self.finish("prepared", False)
            self.check_cancel()
            await adapter.preflight()
            self.check_cancel()
            claimed = await self.command("claim", {"reclaim": reclaim})
            self.run_id = _identifier(claimed["runtime"]["run_id"])
            self.check_active(claimed)
            self.record("claimed.json", claimed)
            self.check_cancel()
            handoff = await _call(self.http, "GET", self.endpoint("/input", query={"run_id": self.run_id}))
            prompt = assemble_question(handoff, self.state["record"])
            self.record("input.json", handoff)
            # 모델 실행 직전 읽은 대화 기준을 저장까지 유지한다. 충돌 때 새 revision만 바꾸지 않는다.
            conversation = await _call(self.http, "GET", self.base + "/conversations/" + record["data"]["conversation_id"]
                + "?" + urlencode({"profile": self.profile}))
            self.record("conversation-basis.json", {"conversation_id": record["data"]["conversation_id"], "revision": conversation["revision"]})
            await self.command("progress", {"progress": "input_ready", "message": "Frozen question input verified on the personal PC."})
            self.emit("phase", phase="input_ready", saved=False)
            self.check_cancel()
            await self.command("progress", {"progress": "answering", "message": "Personal AI is generating an unsaved answer."})
            self.emit("phase", phase="answering", saved=False)
            result = await self.guarded_model(adapter, prompt, question_answer_schema(handoff))
            # 유효하지 않은 모델 식별자도 원시 출력 그대로 남긴다. 추측 보정/자동 재호출하지 않는다.
            self.record("answer-result.json", result)
            payload = answer_payload(result, handoff=handoff, prompt=prompt)
            self.record("answer-draft.json", payload)
            self.emit("answer_preview", content=payload["content"], saved=False, origin="client_reported")
            self.check_cancel()
            self.check_active(await self.read())
            # 사용권/현재 근거/현재 쓰기 권한을 다시 검사한 뒤 전송한다.
            await self.command("heartbeat")
            self.check_cancel()
            body = {"request_id": uuid4().hex, "run_id": self.run_id, "expected_state_revision": self.state["state_revision"],
                "expected_conversation_revision": conversation["revision"], **payload}
            self.emit("phase", phase="submitting", saved=False)
            return await self.submit(body)
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            code = error.code if isinstance(error, AnalysisClientError) else "question_cancelled" if isinstance(error, asyncio.CancelledError) else "question_execution_failed"
            cancelled = code == "question_cancelled"
            await self.stop(cancelled=cancelled)
            return self.finish("unconfirmed" if self.submitted else "cancelled" if cancelled else "failed",
                None if self.submitted else False, error=code)


async def run_question(*, base_url, tenant, token, work_dir, question_run_id=None, conversation_id=None,
                       question_turn_id=None, expected_conversation_revision=None, create_request_id=None,
                       adapter=None, profile=None, reclaim=False, cancel=False, receipt_request_id=None,
                       on_event=None, cancel_event=None, http=None, poll_seconds=2, heartbeat_seconds=30):
    """명시 adapter가 있을 때만 AI를 실행한다. http 주입은 격리 API 검증에 사용한다."""
    base = server_url(base_url)
    if not isinstance(tenant, str) or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", tenant) is None:
        raise QuestionClientError("invalid_tenant")
    _profile(profile)
    if question_run_id is not None:
        _identifier(question_run_id)
        if any(value is not None for value in (conversation_id, question_turn_id, expected_conversation_revision, create_request_id)):
            raise QuestionClientError("question_input_conflict")
    else:
        _identifier(conversation_id); _identifier(question_turn_id)
        if not isinstance(expected_conversation_revision, str) or re.fullmatch(r"[0-9a-f]{64}", expected_conversation_revision) is None:
            raise QuestionClientError("question_conversation_revision_required")
        if cancel or receipt_request_id:
            raise QuestionClientError("question_run_required")
    for value in (create_request_id, receipt_request_id):
        if value is not None:
            _identifier(value)
    if sum((adapter is not None, cancel, receipt_request_id is not None)) > 1:
        raise QuestionClientError("question_mode_conflict")
    if any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in (poll_seconds, heartbeat_seconds)) or heartbeat_seconds >= 120:
        raise QuestionClientError("question_interval_invalid")
    root = _private_directory(work_dir)
    directory = root / ("question-" + uuid4().hex)
    private_directory(directory, exist_ok=False)
    write_new(directory / "session.json", canonical_json_bytes({"tenant": tenant, "profile": profile, "question_run_id": question_run_id,
        "automatic_retry": False, "protocol": PROTOCOL}))
    options = dict(base=base, tenant=tenant, directory=directory, profile=profile, on_event=on_event,
        cancel_event=cancel_event, poll_seconds=poll_seconds, heartbeat_seconds=heartbeat_seconds)
    arguments = dict(question_run_id=question_run_id, conversation_id=conversation_id, question_turn_id=question_turn_id,
        expected_conversation_revision=expected_conversation_revision, create_request_id=create_request_id,
        adapter=adapter, reclaim=reclaim, cancel=cancel, receipt_request_id=receipt_request_id)
    if http is not None:
        return await _QuestionExecution(http, **options).execute(**arguments)
    async with httpx2.AsyncClient(base_url=base + "/", headers={"Authorization": "Bearer " + token},
            timeout=15, trust_env=False, follow_redirects=False) as connection:
        return await _QuestionExecution(connection, **options).execute(**arguments)
