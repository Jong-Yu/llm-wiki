"""인증된 원본을 내려받아 개인 PC에서 변환하고 별도 불변 보고를 저장한다.

서버는 파서/OCR을 실행하지 않는다. 로컬 원본·checkpoint·전송할 보고·영수증을
분리하므로 취소/충돌/응답 유실이 이미 받은 자료나 변환 문자를 지우지 않는다.
"""

import asyncio
from contextlib import suppress
import errno
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import time
from urllib.parse import urlencode
from uuid import uuid4

import httpx2
from core.runtime.client_platform import is_windows
from core.runtime.client_process import WindowsJob, process_arguments, spawn_options, stop_windows
from .analysis import _private_directory, server_url
from .transport import AnalysisClientError, api_call
from .source_conversion_worker import atomic_json, transient_checkpoint_error
from .source_conversion_report import empty_conversion, interrupt_conversion

MAX_ORIGINAL = 20 * 1024 * 1024
MAX_CONVERSION_SECONDS = 30 * 60
MAX_IDLE_SECONDS = 120
SOURCE_KEYS = ("source_id", "source_version", "source_sha256", "registration_revision")
WORKER_FAILURE_CODES = frozenset({"conversion_checkpoint_locked", "conversion_checkpoint_write_failed",
    "conversion_memory_failed", "conversion_worker_io_failed", "conversion_worker_exception"})


def worker_exit_failure(path, returncode):
    """전용 실패 보고의 허용 필드와 종료 숫자만 읽고 원시 stderr는 공개하지 않는다."""
    failure = {}
    try:
        with path.open("rb") as stream:
            raw = stream.read(4097)
        report = json.loads(raw) if len(raw) <= 4096 else None
        if (type(report) is dict and report.get("schema_version") == 1
                and report.get("code") in WORKER_FAILURE_CODES):
            failure["code"] = report["code"]
            for key in ("errno", "winerror"):
                number = report.get(key)
                if type(number) is int and -(2 ** 31) <= number < 2 ** 32:
                    failure[key] = number
    except (OSError, ValueError, TypeError):
        pass
    if "code" not in failure:
        # Windows NTSTATUS는 bootstrap을 거치면 signed/unsigned 어느 쪽으로도 올 수 있다.
        native = returncode & 0xffffffff
        if native in {0xc0000017, 0xc000012d}:
            code = "conversion_memory_failed"
        elif native == 0xc000009a:
            code = "conversion_resources_failed"
        elif native in {0xc0000005, 0xc000001d, 0xc0000094, 0xc00000fd, 0xc0000409}:
            code = "conversion_worker_crashed"
        elif returncode in {-signal.SIGSEGV, -signal.SIGABRT, -signal.SIGILL,
                            -getattr(signal, "SIGBUS", signal.SIGSEGV)}:
            code = "conversion_worker_crashed"
        elif returncode < 0:
            code = "conversion_worker_terminated"
        else:
            code = "worker_failed"
        failure["code"] = code
    return {**failure, "exit_code": returncode}


def check_ref(reference):
    if type(reference) is not dict or set(reference) != set(SOURCE_KEYS):
        raise AnalysisClientError("invalid_source_reference")
    for key, value in reference.items():
        length = 32 if key in {"source_id", "source_version"} else 64
        if type(value) is not str or re.fullmatch(r"[0-9a-f]{%d}" % length, value) is None:
            raise AnalysisClientError("invalid_source_reference")


def cancelled(cancel_file):
    return cancel_file is not None and Path(cancel_file).exists()


async def download(http, endpoint, directory, original, cancel_file, emit):
    size = original.get("size_bytes")
    if type(size) is not int or not 0 <= size <= MAX_ORIGINAL:
        raise AnalysisClientError("invalid_source_size")
    path = directory / "original.part"
    digest, received = sha256(), 0
    with path.open("xb") as destination:
        os.chmod(path, 0o600)
        async with http.stream("GET", endpoint) as response:
            if response.status_code != 200:
                raise AnalysisClientError("source_download_failed")
            async for block in response.aiter_bytes(65536):
                if cancelled(cancel_file):
                    raise AnalysisClientError("conversion_cancelled")
                received += len(block)
                if received > size:
                    raise AnalysisClientError("source_hash_mismatch")
                digest.update(block)
                destination.write(block)
                emit("download", completed=received, total=size)
        if received != size or digest.hexdigest() != original["source_sha256"]:
            raise AnalysisClientError("source_hash_mismatch")
        destination.flush()
        os.fsync(destination.fileno())
    target = directory / "original"
    path.rename(target)
    return target


async def stop_worker(process):
    """본인이 만든 파서와 OCR 자식만 종료한다. Windows에서는 트리를 종료한다."""
    if is_windows():
        await stop_windows(process)
        return
    # worker가 먼저 끝나도 OCR/Office 자식이 같은 전용 세션에 남을 수 있다.
    # 직접 만든 group만 정리하며 사용자의 다른 프로그램에는 신호를 보내지 않는다.
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    await process.wait()


def transient_checkpoint_read_error(error):
    # Windows의 built-in open은 CRT를 거쳐 공유 충돌에도 winerror 없이 EACCES를 낸다.
    # os.replace의 Win32 오류 분류나 다른 플랫폼의 권한 거부에는 적용하지 않는다.
    return transient_checkpoint_error(error) or (is_windows()
        and getattr(error, "winerror", None) is None and error.errno == errno.EACCES)


class CheckpointReadError(AnalysisClientError):
    """원시 오류·경로 대신 읽기 실패의 코드와 안전한 OS 숫자만 보존한다."""

    def __init__(self, error):
        super().__init__("conversion_checkpoint_read_failed")
        self.failure = {"code": self.code}
        for key in ("errno", "winerror"):
            number = getattr(error, key, None)
            if type(number) is int and -(2 ** 31) <= number < 2 ** 32:
                self.failure[key] = number


async def read_checkpoint(path, *, final=False):
    """진행 조회의 짧은 Windows 공유 충돌은 실행 실패로 바꾸지 않는다."""
    for attempt in range(8 if final else 1):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except OSError as error:
            if not transient_checkpoint_read_error(error) or (final and attempt == 7):
                raise CheckpointReadError(error) from None
            if not final:
                return None
            if attempt < 7:
                await asyncio.sleep(min(.01 * 2 ** attempt, .2))
        except (ValueError, UnicodeError) as error:
            raise CheckpointReadError(error) from None


async def run_worker(original, format, result_path, *, ocr, language, timeout, cancel_file, emit,
                     idle_timeout=MAX_IDLE_SECONDS):
    scratch = Path(tempfile.mkdtemp(prefix="scratch-", dir=result_path.parent))
    failure_path = scratch / "worker-failure.json"
    environment = {**os.environ, "TMPDIR": str(scratch), "TEMP": str(scratch), "TMP": str(scratch)}
    process, job = None, None
    reason, previous, deadline = None, None, time.monotonic() + timeout
    idle_deadline = time.monotonic() + idle_timeout
    latest = None
    failure = None
    try:
        job = WindowsJob() if is_windows() else None
        arguments = [sys.executable, "-B", "-m", "core.client.source_conversion_worker",
                     str(original), format, str(result_path), "--ocr", ocr, "--language", language,
                     "--failure-report", str(failure_path)]
        process = await asyncio.create_subprocess_exec(*process_arguments(arguments),
            cwd=Path(__file__).resolve().parents[2], env=environment, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, **spawn_options())
        if job is not None:
            # 공통 bootstrap은 Job 연결 전에는 파서/OCR 자식을 시작하지 않는다.
            try:
                job.assign(process.pid)
                process._wiki_job = job
            except BaseException:
                process.kill()
                await process.wait()
                raise
            process.stdin.write(b"\0")
            await process.stdin.drain()
        process.stdin.close()
        while process.returncode is None:
            if cancelled(cancel_file) or time.monotonic() >= deadline:
                reason = "conversion_cancelled" if cancelled(cancel_file) else "conversion_timeout"
                await stop_worker(process)
                break
            snapshot = await read_checkpoint(result_path)
            if snapshot is not None:
                # 단위·미독·OCR 처리 기록 등 실제 보고 변경만 무진행 제한을 연장한다.
                # 같은 보고의 반복 기록은 전체·무진행 상한 어느 쪽도 우회하지 않는다.
                if snapshot != latest:
                    idle_deadline = time.monotonic() + idle_timeout
                    latest = snapshot
                progress = (len(snapshot["units"]), len(snapshot["unread_ranges"]))
                if progress != previous:
                    previous = progress
                    emit("convert", completed=progress[0], total=snapshot.get("total_units"), unread=progress[1])
            if time.monotonic() >= idle_deadline:
                reason = "conversion_idle_timeout"
                await stop_worker(process)
                break
            await asyncio.sleep(0.1)
        await process.wait()
        if process.returncode != 0 and reason is None:
            failure = worker_exit_failure(failure_path, process.returncode)
    except AnalysisClientError as error:
        reason = error.code
        if isinstance(error, CheckpointReadError):
            failure = error.failure
        if process is not None:
            await stop_worker(process)
    except asyncio.CancelledError:
        if process is not None:
            await stop_worker(process)
        raise
    finally:
        if process is not None:
            await stop_worker(process)
        if job is not None:
            job.close()
        shutil.rmtree(scratch)
    checkpoint_unread = False
    try:
        value = await read_checkpoint(result_path, final=True)
    except AnalysisClientError as error:
        # 마지막 파일 조회가 실패해도 이전에 확인한 전체 checkpoint를 잃지 않는다.
        # 읽지 못한 파일에는 더 새 단위가 있을 수 있으므로 이 사본으로 덮지 않는다.
        checkpoint_unread = True
        if reason is None:
            reason = error.code
        if isinstance(error, CheckpointReadError):
            if failure is None and reason == error.code:
                failure = error.failure
            else:
                # 작업자 실패·취소·시간 제한과 마지막 읽기 오류를 구분한다.
                failure = {**(failure or {"code": reason}),
                    **{"checkpoint_" + key: number for key, number in error.failure.items() if key != "code"}}
        value = latest
    code = reason or (failure or {}).get("code", "worker_failed")
    value = value if value is not None else latest if latest is not None else empty_conversion(format, code)
    if reason or process.returncode != 0 or value.get("state") == "running":
        interrupt_conversion(value, code)
        failure = {**(failure or {"code": code}), "exit_code": process.returncode}
        value["worker_failure"] = failure
        # 기존 불변 보고에도 원인 분류와 종료 숫자가 남아 앱 재시작 뒤 조회할 수 있다.
        warning = "worker: " + ";".join(f"{key}={item}" for key, item in failure.items())
        if len(value["warnings"]) < 100:
            value["warnings"].append(warning)
        elif len(value["warnings"][-1]) + len(warning) + 3 <= 1000:
            # 긴 OCR의 경고 상한에서도 기존 마지막 안내를 유지하고 실패 원인을 전달한다.
            value["warnings"][-1] += " | " + warning
    if not checkpoint_unread:
        atomic_json(result_path, value)
    return value


def report_body(conversion, source_ref, request_id, profile):
    units = []
    for unit in conversion["units"]:
        where = unit["location"]
        if where["kind"] != "table_cells":
            where = {"start": None, "end": None, "sheet": None, "cells": None, **where}
        units.append({**unit, "location": where})
    body = {"request_id": request_id, "source_ref": source_ref, "method": conversion["method"],
        "units": units, "complete": conversion["complete"], "unread_ranges": conversion["unread_ranges"],
        "warnings": conversion["warnings"]}
    if profile is not None:
        body["profile"] = profile
    return body


def checked_receipt(value, body, conversion_id):
    """HTTP 성공뿐 아니라 실제 저장된 요청·본문·위치·판본을 대조한다."""
    manifest = value.get("manifest", {})
    units = [{key: item for key, item in unit.items() if key != "content"} for unit in body["units"]]
    components = {unit["unit_id"]: unit["content"] for unit in body["units"]}
    if (manifest.get("id") != conversion_id or any(manifest.get(key) != body[key] for key in
            ("request_id", "source_ref", "method", "complete", "warnings", "unread_ranges"))
            or manifest.get("units") != units or value.get("components") != components
            or re.fullmatch(r"[a-f0-9]{64}", value.get("revision", "")) is None):
        raise AnalysisClientError("conversion_receipt_mismatch")
    return {"state": "saved", "conversion_ref": {"conversion_id": conversion_id,
        "conversion_revision": value["revision"]}, "revision": value["revision"],
        "manifest": manifest, "replayed": value.get("replayed", False)}


async def submit_report(http, base, query, body, user_id, emit):
    conversion_id = sha256(f"conversions:{base.rsplit('/', 1)[-1]}:{user_id}:{body['request_id']}".encode()).hexdigest()[:32]
    emit("submit", completed=0)
    try:
        response = await http.post(base + "/analysis-conversions", json=body)
        if response.status_code in {200, 201}:
            receipt = checked_receipt(response.json()["data"], body, conversion_id)
            emit("submit", completed=1)
            return receipt
        if response.status_code < 500:
            error = response.json().get("error", {}).get("code", "report_rejected")
            code = error if isinstance(error, str) and re.fullmatch(r"[a-z0-9_]{1,80}", error) else "report_rejected"
            return {"state": "rejected", "error": {"code": code}, "http_status": response.status_code}
    except (httpx2.HTTPError, KeyError, ValueError, AnalysisClientError):
        pass
    # 응답 유실 후 같은 불변 ID를 읽는다. 자동 재전송 없이 미확인 상태를 남긴다.
    try:
        stored = await api_call(http, "GET", base + "/analysis-conversions/" + conversion_id + query)
        receipt = checked_receipt(stored, body, conversion_id)
        receipt["reconciled"] = True
        emit("submit", completed=1)
        return receipt
    except (httpx2.HTTPError, AnalysisClientError, ValueError):
        return {"state": "unconfirmed", "conversion_id": conversion_id,
                "error": {"code": "report_save_unconfirmed"}}


async def convert_source(*, base_url, tenant, token, source_ref, work_dir, profile=None, request_id=None,
                         cancel_file=None, submit=False, ocr="auto", ocr_language="eng", timeout=MAX_CONVERSION_SECONDS,
                         idle_timeout=MAX_IDLE_SECONDS, on_event=None, http=None):
    """원본 기준을 고정하고 다운로드→격리 변환→선택한 보고 저장을 실행한다."""
    base_url = server_url(base_url)
    check_ref(source_ref)
    if (not isinstance(tenant, str) or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", tenant) is None
            or (profile is not None and re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile) is None)
            or ocr not in {"auto", "never", "always"} or not 0 < timeout <= MAX_CONVERSION_SECONDS
            or not 0 < idle_timeout <= MAX_IDLE_SECONDS
            or re.fullmatch(r"[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*", ocr_language) is None):
        raise AnalysisClientError("invalid_conversion_options")
    request_id = request_id or uuid4().hex
    if re.fullmatch(r"[a-f0-9]{32}", request_id) is None:
        raise AnalysisClientError("invalid_request_id")
    root = _private_directory(work_dir)
    directory = Path(tempfile.mkdtemp(prefix="conversion-" + request_id + "-", dir=root))
    result_path, report_path = directory / "conversion.json", directory / "report.json"
    local = {"schema_version": 1, "request_id": request_id, "source_ref": source_ref,
        "work_dir": str(directory), "original_file": None, "result_file": str(result_path),
        "report_file": None, "format": None, "receipt": {"state": "not_submitted"}}
    def emit(stage, **values):
        if on_event:
            on_event({"schema_version": 1, "type": "progress", "request_id": request_id, "stage": stage, **values})
    base = base_url + f"/api/v1/tenants/{tenant}"
    query = "?" + urlencode({"profile": profile}) if profile else ""
    owned_http = http is None
    if owned_http:
        http = httpx2.AsyncClient(headers={"Authorization": "Bearer " + token}, timeout=15,
                                  trust_env=False, follow_redirects=False)
    try:
        if cancelled(cancel_file):
            raise AnalysisClientError("conversion_cancelled")
        catalog = await api_call(http, "GET", base + "/sources/" + source_ref["source_id"] + query)
        if (catalog.get("source_id") != source_ref["source_id"]
                or catalog.get("current_version") != source_ref["source_version"]
                or catalog.get("registration_revision") != source_ref["registration_revision"]):
            raise AnalysisClientError("source_basis_changed")
        original = next((item for item in catalog["versions"] if item["source_version"] == source_ref["source_version"]), None)
        if not original or original["source_sha256"] != source_ref["source_sha256"]:
            raise AnalysisClientError("source_basis_changed")
        local["format"] = original["format"]
        path = await download(http, base + f"/sources/{source_ref['source_id']}/versions/{source_ref['source_version']}/file" + query,
                              directory, original, cancel_file, emit)
        local["original_file"] = str(path)
        conversion = await run_worker(path, original["format"], result_path, ocr=ocr, language=ocr_language,
                                     timeout=timeout, idle_timeout=idle_timeout, cancel_file=cancel_file, emit=emit)
        local["conversion"] = conversion
        if conversion.get("worker_failure"):
            # 첫 checkpoint 이전 실패는 UI가 method 없는 보고를 null로 투영하므로 코드도 별도로 보낸다.
            local["error"] = {"code": conversion["worker_failure"]["code"]}
        if cancelled(cancel_file):
            conversion["complete"] = False
            conversion["state"] = "cancelled"
            if not any("conversion_cancelled" in value for value in conversion["unread_ranges"]):
                interrupt_conversion(conversion, "conversion_cancelled", diagnostic=False)
            atomic_json(result_path, conversion)
        if conversion["units"]:
            body = report_body(conversion, source_ref, request_id, profile)
            atomic_json(report_path, body)
            local["report_file"] = str(report_path)
            if submit and conversion["state"] != "cancelled":
                if len(json.dumps(body, ensure_ascii=False).encode()) > 8 * 1024 * 1024:
                    local["receipt"] = {"state": "rejected", "error": {"code": "report_transport_limit"}}
                else:
                    local["receipt"] = await submit_report(http, base, query, body, catalog["access"]["user_id"], emit)
        local["state"] = "report_unconfirmed" if local["receipt"]["state"] == "unconfirmed" else conversion["state"]
        local["ok"] = conversion["state"] in {"complete", "partial"} and local["receipt"]["state"] in {"saved", "not_submitted"}
    except asyncio.CancelledError:
        conversion = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else empty_conversion(local["format"], "conversion_cancelled")
        interrupt_conversion(conversion, "conversion_cancelled", diagnostic=False)
        local.update(ok=False, state="cancelled", conversion=conversion)
        atomic_json(result_path, conversion)
        # 강제 취소 중 저장 응답을 확인하지 못하면 성공으로 추정하지 않는다.
        if submit and local["report_file"]:
            local["receipt"] = {"state": "unconfirmed", "error": {"code": "report_save_unconfirmed"}}
    except Exception as error:
        code = error.code if isinstance(error, AnalysisClientError) else "conversion_client_failed"
        # 전송/로컬 후처리가 실패해도 완료된 변환 checkpoint를 빈 결과로 덮지 않는다.
        conversion = local.get("conversion")
        if conversion is None and result_path.exists():
            with suppress(ValueError, OSError):
                conversion = json.loads(result_path.read_text(encoding="utf-8"))
        conversion = conversion or empty_conversion(local["format"], code)
        local.update(ok=False, state="cancelled" if code == "conversion_cancelled" else "failed",
                     error={"code": code}, conversion=conversion)
        if submit and local["report_file"] and local["receipt"]["state"] == "not_submitted":
            local["receipt"] = {"state": "unconfirmed", "error": {"code": "report_save_unconfirmed"}}
        atomic_json(result_path, conversion)
    finally:
        if owned_http:
            await http.aclose()
    atomic_json(directory / "result.json", local)
    return local
