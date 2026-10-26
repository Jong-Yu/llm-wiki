"""인증된 원본을 내려받아 개인 PC에서 변환하고 별도 불변 보고를 저장한다.

서버는 파서/OCR을 실행하지 않는다. 로컬 원본·checkpoint·전송할 보고·영수증을
분리하므로 취소/충돌/응답 유실이 이미 받은 자료나 변환 문자를 지우지 않는다.
"""

import asyncio
from contextlib import suppress
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
from .source_conversion_worker import atomic_json

MAX_ORIGINAL = 20 * 1024 * 1024
SOURCE_KEYS = ("source_id", "source_version", "source_sha256", "registration_revision")


def check_ref(reference):
    if type(reference) is not dict or set(reference) != set(SOURCE_KEYS):
        raise AnalysisClientError("invalid_source_reference")
    for key, value in reference.items():
        length = 32 if key in {"source_id", "source_version"} else 64
        if type(value) is not str or re.fullmatch(r"[0-9a-f]{%d}" % length, value) is None:
            raise AnalysisClientError("invalid_source_reference")


def cancelled(cancel_file):
    return cancel_file is not None and Path(cancel_file).exists()


def empty_conversion(format, code):
    return {"format": format, "method": None, "units": [], "complete": False,
        "unread_ranges": ["whole source: " + code], "warnings": [], "diagnostics": [{"code": code}],
        "unit_methods": {}, "state": "failed", "origin": "client_reported",
        "coverage": "reported_units_only", "original_coverage": "not_verified", "semantic_validation": "not_run"}


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
    if process.returncode is not None:
        return
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    await process.wait()


async def run_worker(original, format, result_path, *, ocr, language, timeout, cancel_file, emit):
    scratch = Path(tempfile.mkdtemp(prefix="scratch-", dir=result_path.parent))
    environment = {**os.environ, "TMPDIR": str(scratch), "TEMP": str(scratch), "TMP": str(scratch)}
    process, job = None, None
    reason, previous, deadline = None, None, time.monotonic() + timeout
    try:
        job = WindowsJob() if is_windows() else None
        arguments = [sys.executable, "-B", "-m", "core.client.source_conversion_worker",
                     str(original), format, str(result_path), "--ocr", ocr, "--language", language]
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
            if result_path.exists():
                snapshot = json.loads(result_path.read_text(encoding="utf-8"))
                progress = (len(snapshot["units"]), len(snapshot["unread_ranges"]))
                if progress != previous:
                    previous = progress
                    emit("convert", completed=progress[0], total=snapshot.get("total_units"), unread=progress[1])
            await asyncio.sleep(0.1)
        await process.wait()
    except asyncio.CancelledError:
        if process is not None:
            await stop_worker(process)
        raise
    finally:
        if process is not None and process.returncode is None:
            await stop_worker(process)
        if job is not None:
            job.close()
        shutil.rmtree(scratch)
    value = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else empty_conversion(format, reason or "worker_failed")
    if reason or process.returncode != 0 or value.get("state") == "running":
        code = reason or "worker_failed"
        value["complete"] = False
        value["state"] = "cancelled" if code == "conversion_cancelled" else "partial" if value["units"] else "failed"
        value["unread_ranges"] = value["unread_ranges"][:99] + ["remaining source: " + code]
        value["diagnostics"] = value["diagnostics"][:99] + [{"code": code, "scope": "remaining source", "unread": True}]
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
                         cancel_file=None, submit=False, ocr="auto", ocr_language="eng", timeout=120,
                         on_event=None, http=None):
    """원본 기준을 고정하고 다운로드→격리 변환→선택한 보고 저장을 실행한다."""
    base_url = server_url(base_url)
    check_ref(source_ref)
    if (not isinstance(tenant, str) or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", tenant) is None
            or (profile is not None and re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", profile) is None)
            or ocr not in {"auto", "never", "always"} or not 0 < timeout <= 120
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
                                     timeout=timeout, cancel_file=cancel_file, emit=emit)
        local["conversion"] = conversion
        if cancelled(cancel_file):
            conversion["complete"] = False
            conversion["state"] = "cancelled"
            if not any("conversion_cancelled" in value for value in conversion["unread_ranges"]):
                conversion["unread_ranges"] = conversion["unread_ranges"][:99] + ["remaining source: conversion_cancelled"]
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
        conversion.update(complete=False, state="cancelled")
        conversion["unread_ranges"] = conversion["unread_ranges"][:99] + ["remaining source: conversion_cancelled"]
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
