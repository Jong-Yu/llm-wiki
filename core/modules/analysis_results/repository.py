"""분석 결과 요청을 파일에 보관하고 다시 읽는 역할을 맡는다.

store.py가 '언제 무엇을 저장할지' 정하고, 이 파일은 '어디에 어떻게 기록할지' 맡는다.
신규 요청은 _personal/<user_id>/analysis/<job_id>/results/<request_id>/에 둔다.
기존 _jobs/<job_id>는 같은 위치에서 계속 읽고 갱신한다.
  manifest.json / component-*.txt: 제출값과 그 내용을 확인할 지문(hash). 변경하지 않는다.
  receipt.json: 접수·거부·완료 등 요청 처리 기록.
  saved.json: 기존 저장 함수가 성공한 뒤 남기는 별도의 저장 증거.

마지막 영수증이 없어도 saved.json이 있으면 이미 저장됐다는 근거를 유지할 수 있다.
반대로 현재 위키 내용이 제출 내용과 같다는 이유만으로 이번 요청의 성공을 단정하지 않는다.
"""

from collections import OrderedDict
import json

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.analysis_inputs import basis, contracts as input_limits, files
from core.modules.analysis_jobs import records
from core.modules.sources import files as source_files
from .contracts import MAX_RESULTS, MAX_SUBMISSION_BYTES, MAX_TOTAL_BYTES, ResultError


_SUMMARY_INPUT_CACHE_ENTRIES = 8
_SUMMARY_INPUT_CACHE_BYTES = 8 * 1024 * 1024


def _summary_input_loader(store, parent):
    """Share validated immutable inputs only within one job summary call.

    Retain bounded UTF-8 bytes, never mutable manifests/components or a policy
    decision. Every hit reconstructs isolated return values. Unsupported input
    options and values which cannot be safely packed use the original loader.
    """
    cached, retained = OrderedDict(), 0

    def load_input(candidate_store, directory, **options):
        nonlocal retained
        expected = options.get("expected_revision")
        maximum = options.get("maximum")
        effective_maximum = input_limits.MAX_BUNDLE_BYTES if maximum is None else maximum
        reusable = (candidate_store is store and getattr(directory, "parent", None) == parent
                    and set(options) <= {"expected_revision", "maximum"}
                    and type(expected) is str and len(expected) == 64
                    and all(character in "0123456789abcdef" for character in expected)
                    and type(effective_maximum) is int and effective_maximum >= 0
                    and _SUMMARY_INPUT_CACHE_ENTRIES > 0)
        key = (directory, expected, effective_maximum) if reusable else None
        if reusable and key in cached:
            raw, parts, _ = cached[key]
            cached.move_to_end(key)
            text = raw.decode("utf-8")
            return json.loads(text), text, {name.decode("utf-8"): value.decode("utf-8") for name, value in parts}
        value = files.load(candidate_store, directory, **options)
        if not reusable:
            return value
        try:
            manifest, text, components = value
            raw = text.encode("utf-8")
            parts = tuple((name.encode("utf-8"), component.encode("utf-8")) for name, component in components.items())
            size = len(raw) + sum(len(name) + len(component) for name, component in parts)
            if size > _SUMMARY_INPUT_CACHE_BYTES or json.loads(text) != manifest:
                return value
        except (AttributeError, TypeError, ValueError, UnicodeError, RecursionError):
            # Memo construction must not add validation to a successful loader.
            return value
        while cached and (len(cached) >= _SUMMARY_INPUT_CACHE_ENTRIES or retained + size > _SUMMARY_INPUT_CACHE_BYTES):
            _, (_, _, removed) = cached.popitem(last=False)
            retained -= removed
        cached[key] = (raw, parts, size)
        retained += size
        return value

    return load_input


def directory(service, job_id, request_id):
    """이번 요청의 보관 경로를 만든다. 경로 계산만 하며 폴더를 생성하지 않는다."""
    # 소유 확인에서 선택한 신규/기존 경로에만 요청을 저장한다.
    return service.jobs.job_root(job_id) / "results" / request_id


def publish(service, job, request_id, payload):
    """제출값을 새 불변 묶음으로 보관한다. 기존 요청의 파일을 덮어쓰지 않는다.

    payload는 본문/그래프와 기준 버전을 담은 dict다. 저장 전에 작업별 개수와
    누적 바이트 한도를 확인하며, 초과하면 예외를 내고 기존 제출은 그대로 둔다.
    """
    parent = service.jobs.job_root(job["job_id"]) / "results"
    names = source_files.entries(service.store, parent, maximum=MAX_RESULTS + 1)
    if len(names) >= MAX_RESULTS:
        raise ResultError("result_limit")
    stored_payload = payload
    if payload["stage"] == "prepare_wiki" and job["events"][0]["details"].get("registration"):
        # 기본 MD 본문은 고정 입력에 한 번 보관한다. 요청은 그 검증 가능한 판본을 참조한다.
        _, _, parts = files.load(service.store, service.jobs.job_root(job["job_id"]) / "inputs" / payload["bundle_id"],
                                 expected_revision=payload["bundle_revision"])
        if payload.get("content") == parts.get("data/registration.md"):
            stored_payload = {key: value for key, value in payload.items() if key != "content"}
            stored_payload["preserved_content_ref"] = {"bundle_id": payload["bundle_id"],
                "bundle_revision": payload["bundle_revision"], "component": "data/registration.md"}
    text = canonical_json_bytes(stored_payload).decode("utf-8")
    # 한글/이모지는 한 글자가 여러 바이트다. 글자 수 대신 UTF-8 바이트 수로 용량을 계산한다.
    total = len(text.encode("utf-8"))
    for name in names:
        manifest, _, _ = files.load(service.store, parent / name, maximum=MAX_SUBMISSION_BYTES + 65536)
        total += manifest["components"]["submission"]["size_bytes"]
    if total > MAX_TOTAL_BYTES:
        raise ResultError("result_limit")
    manifest = {"schema_version": 1, "job_id": job["job_id"], "tenant": job["tenant"],
        "user_id": job["user_id"], "request_id": request_id, "payload_hash": canonical_json_hash(payload),
        "components": files.descriptors({"submission": text})}
    files.publish(service.store, directory(service, job["job_id"], request_id), manifest,
                  {"submission": text}, maximum=MAX_SUBMISSION_BYTES + 65536)


def load(service, job, request_id, *, input_loader=None):
    """요청 소속과 내용 지문을 검사해 (처리 기록, 원래 제출값) 두 값을 반환한다.

    이 함수는 파일을 읽기만 한다. 영수증이 불완전해도 위키/그래프 저장을 재실행하지 않는다.
    service를 호출하는 쪽에서 먼저 현재 사용자의 권한·작업 소유권을 확인해야 한다.
    input_loader는 summary 한 번 안의 불변 입력 재사용용이며 기본 읽기는 그대로다.
    """
    path = directory(service, job["job_id"], request_id)
    # 여러 반환값을 순서대로 받는다. _는 '이 값은 여기서 사용하지 않는다'는 관례다.
    manifest, _, components = files.load(service.store, path, maximum=MAX_SUBMISSION_BYTES + 65536)
    expected = {"job_id": job["job_id"], "tenant": job["tenant"], "user_id": job["user_id"], "request_id": request_id}
    try:
        payload = json.loads(components["submission"])
        if "preserved_content_ref" in payload:
            reference = payload.pop("preserved_content_ref")
            if (reference != {"bundle_id": payload["bundle_id"], "bundle_revision": payload["bundle_revision"],
                    "component": "data/registration.md"} or payload["stage"] != "prepare_wiki"
                    or not job["events"][0]["details"].get("registration") or "content" in payload):
                raise ValueError()
            from core.modules.analysis_inputs.contracts import identifier, revision
            identifier(reference["bundle_id"]); revision(reference["bundle_revision"])
            fixed_loader = files.load if input_loader is None else input_loader
            _, _, fixed = fixed_loader(service.store, service.jobs.job_root(job["job_id"]) / "inputs" / reference["bundle_id"],
                                       expected_revision=reference["bundle_revision"])
            payload["content"] = fixed["data/registration.md"]
        # any(...)는 조건 중 하나라도 참이면 True다. 다른 소유자의 자료나 변한 내용을 거부한다.
        if (any(manifest[key] != value for key, value in expected.items())
                or manifest["payload_hash"] != canonical_json_hash(payload)):
            raise ValueError()
        try:
            record = records.read(service.jobs, path / "receipt.json")
        except FileNotFoundError:
            # 제출 파일만 남고 처리 기록을 쓰기 전에 중단됐을 수 있다. 실패/성공을 추측하지 않는다.
            record = {**expected, "payload_hash": manifest["payload_hash"], "state": "pending_reconcile",
                      "saved": None, "receipt": None, "validation_report": None, "cleanup_failures": []}
        if (any(record[key] != value for key, value in expected.items())
                or record["payload_hash"] != manifest["payload_hash"]
                or record["state"] not in {"pending_reconcile", "complete", "rejected", "storage_busy", "draft"}):
            raise ValueError()
        try:
            evidence = records.read(service.jobs, path / "saved.json")
        except FileNotFoundError:
            evidence = None
        if evidence is not None:
            if (evidence["payload_hash"] != manifest["payload_hash"] or evidence["saved"] is not True
                    or any(evidence[key] != value for key, value in expected.items())):
                raise ValueError()
            # 독립적인 저장 증거만 성공으로 인정한다. 현재 파일 hash로 성공을 추정하지 않는다.
            record = {**record, "saved": True, "receipt": evidence["receipt"],
                      "validation_report": evidence["validation_report"],
                      "cleanup_failures": evidence["cleanup_failures"],
                      "diagnostics": evidence.get("diagnostics")}
            # 마지막 응답/영수증만 유실된 경우 실제 저장 증거와 job 연결이 모두 있으면
            # 읽기 결과로 완료를 확인한다. 파일을 고치거나 위키를 다시 저장하지 않는다.
            if any(event["details"].get("operation") == "result_saved"
                   and event["details"].get("request_id") == request_id
                   and event["details"].get("run_id") == payload["run_id"]
                   and event["details"].get("stage") == payload["stage"]
                   and event["details"].get("document") == payload["document"]
                   and all(event["details"].get(key) == evidence["receipt"].get(key)
                           for key in ("source_revision", "graph_revision")) for event in job["events"]):
                record["state"] = "complete"
        elif record.get("saved") is True or record["state"] == "complete":
            # 성공이라고 적혀 있어도 별도의 저장 증거가 없으면 일관되지 않은 기록으로 취급한다.
            raise ValueError()
        # 응답의 진단 본문은 반드시 불변 원시 제출과 일치해야 한다. 초기 영수증 유실도 조회한다.
        from . import diagnostics
        diagnostic = record.get("diagnostics")
        if diagnostic is not None:
            if (diagnostic.get("report") != payload.get("diagnostics")
                    or diagnostic.get("report_hash") != canonical_json_hash(payload.get("diagnostics"))):
                raise ValueError()
        elif payload.get("diagnostics") is not None:
            record["diagnostics"] = diagnostics.observation(payload)
        return record, payload
    except (ValueError, TypeError, KeyError) as error:
        raise ResultError("result_corrupt") from error


def summary(jobs, job):
    """본인 작업의 저장 근거를 읽어 집계한다. CLI 자기보고는 완료 근거로 쓰지 않는다."""
    from .store import ResultStore
    service = ResultStore(jobs.store, jobs.rulesets, jobs=jobs)
    parent = jobs.job_root(job["job_id"]) / "results"
    current_basis = basis.active(job)
    input_bases = {}
    input_loader = _summary_input_loader(jobs.store, jobs.job_root(job["job_id"]) / "inputs")
    values, saved = [], set()
    # values는 요청별 표시용 목록, saved는 중복을 제거한 (문서, 산출물 종류) 집합이다.
    for request_id in source_files.entries(jobs.store, parent, maximum=MAX_RESULTS + 1):
        record, payload = load(service, job, request_id, input_loader=input_loader)
        current_run = payload["run_id"] == job["run_id"]
        key = (payload["bundle_id"], payload["bundle_revision"])
        if key not in input_bases:
            # 저장 미확인/초안에도 입력 기준이 있다. 현재 규약 사용권 없이 불변 묶음만 읽는다.
            input_limits.identifier(key[0]); input_limits.revision(key[1])
            try:
                manifest, _, _ = input_loader(jobs.store, jobs.job_root(job["job_id"]) / "inputs" / key[0],
                                             expected_revision=key[1])
            except (FileNotFoundError, input_limits.InputConflictError):
                # 존재하지 않는 bundle 제출도 원시 거부 기록으로 보존된다. 이 때문에 작업 조회를 막지 않는다.
                input_bases[key] = "unavailable"
            else:
                if manifest["job_id"] != job["job_id"] or manifest["run_id"] != payload["run_id"]:
                    input_bases[key] = "unavailable"
                else:
                    input_bases[key] = manifest.get("analysis_basis_revision")
        basis_current = (None if input_bases[key] == "unavailable" else
                         input_bases[key] == (current_basis["revision"] if current_basis else None))
        # 명시 reclaim은 실행권만 바꾼다. 같은 고정 기준에서 확인된 이전 run 저장은
        # 유지하며, 실제 최신 출력 여부는 실행기가 영수증의 current_output으로 대조한다.
        if basis_current and record["state"] == "complete" and record["saved"] is True:
            saved.add((payload["document"], "wiki" if payload["stage"] == "prepare_wiki" else "ontology"))
        values.append({"request_id": request_id, "stage": payload["stage"], "document": payload["document"],
                       "run_id": payload["run_id"], "state": record["state"], "saved": record["saved"],
                       "basis_current": basis_current, "current_run": current_run,
                       "current_scope": basis_current is True or current_run and basis_current is None})
    required = {(target["document"], output) for target in job["targets"] for output in job["outputs"]}
    # 예: 문서 하나에 wiki/ontology를 요청했다면 필요한 결과는 두 쌍이다.
    # required <= saved는 숫자 비교가 아니라 '필요한 쌍이 모두 저장 집합에 있는가'라는 뜻이다.
    scoped = [value for value in values if value["current_scope"]]
    pending = any(value["state"] == "pending_reconcile" for value in scoped)
    # 확인 대기 → 전체 저장 → 일부 저장 → 거부 → 시작 전 순서로 표시 상태를 결정한다.
    status = ("pending_reconcile" if pending else "complete" if required <= saved else "partial" if saved
              else "rejected" if any(value["state"] in {"rejected", "storage_busy"} for value in scoped)
              else "draft" if any(value["state"] == "draft" for value in scoped) else "not_started")
    return {"status": status, "saved_count": len(saved & required), "required_count": len(required), "results": values}


def wiki_receipt(service, job, document, revision, *, history_revision=None):
    """같은 작업 기준의 완료된 위키 영수증을 찾는다. 본문만으로 계보를 발명하지 않는다."""
    parent = service.jobs.job_root(job["job_id"]) / "results"
    current_basis = basis.active(job)
    for request_id in source_files.entries(service.store, parent, maximum=MAX_RESULTS + 1):
        record, payload = load(service, job, request_id)
        if (record["state"] == "complete" and record["saved"] is True
                and current_basis is not None and payload["stage"] == "prepare_wiki"
                and record["receipt"].get("analysis_basis_revision") == (current_basis["revision"] if current_basis else None)
                and payload["document"] == document and record["receipt"]["source_revision"] == revision
                and history_revision is not None and record["receipt"].get("history_revision") == history_revision):
            # 본문이 A→B→A로 돌아오면 내용 지문은 같아진다. 이력까지 같아야 앞 단계로 인정한다.
            return {"request_id": request_id, "payload_hash": record["payload_hash"], "source_revision": revision}
    raise ResultError("wiki_result_required")
