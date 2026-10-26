"""분석 결과 요청을 파일에 보관하고 다시 읽는 역할을 맡는다.

store.py가 '언제 무엇을 저장할지' 정하고, 이 파일은 '어디에 어떻게 기록할지' 맡는다.
요청마다 _jobs/<job_id>/results/<request_id>/ 폴더를 사용한다.
  manifest.json / component-*.txt: 제출값과 그 내용을 확인할 지문(hash). 변경하지 않는다.
  receipt.json: 접수·거부·완료 등 요청 처리 기록.
  saved.json: 기존 저장 함수가 성공한 뒤 남기는 별도의 저장 증거.

마지막 영수증이 없어도 saved.json이 있으면 이미 저장됐다는 근거를 유지할 수 있다.
반대로 현재 위키 내용이 제출 내용과 같다는 이유만으로 이번 요청의 성공을 단정하지 않는다.
"""

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.analysis_inputs import basis, files
from core.modules.analysis_jobs import records
from core.modules.sources import files as source_files
from .contracts import MAX_RESULTS, MAX_SUBMISSION_BYTES, MAX_TOTAL_BYTES, ResultError


def directory(service, job_id, request_id):
    """이번 요청의 보관 경로를 만든다. 경로 계산만 하며 폴더를 생성하지 않는다."""
    # jobs_dir는 pathlib.Path 객체다. 여기서 /는 나눗셈이 아니라 경로를 이어 붙이는 연산이다.
    return service.jobs.jobs_dir / job_id / "results" / request_id


def publish(service, job, request_id, payload):
    """제출값을 새 불변 묶음으로 보관한다. 기존 요청의 파일을 덮어쓰지 않는다.

    payload는 본문/그래프와 기준 버전을 담은 dict다. 저장 전에 작업별 개수와
    누적 바이트 한도를 확인하며, 초과하면 예외를 내고 기존 제출은 그대로 둔다.
    """
    parent = service.jobs.jobs_dir / job["job_id"] / "results"
    names = source_files.entries(service.store, parent, maximum=MAX_RESULTS + 1)
    if len(names) >= MAX_RESULTS:
        raise ResultError("result_limit")
    text = canonical_json_bytes(payload).decode("utf-8")
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


def load(service, job, request_id):
    """요청 소속과 내용 지문을 검사해 (처리 기록, 원래 제출값) 두 값을 반환한다.

    이 함수는 파일을 읽기만 한다. 영수증이 불완전해도 위키/그래프 저장을 재실행하지 않는다.
    service를 호출하는 쪽에서 먼저 현재 사용자의 권한·작업 소유권을 확인해야 한다.
    """
    path = directory(service, job["job_id"], request_id)
    # 여러 반환값을 순서대로 받는다. _는 '이 값은 여기서 사용하지 않는다'는 관례다.
    manifest, _, components = files.load(service.store, path, maximum=MAX_SUBMISSION_BYTES + 65536)
    expected = {"job_id": job["job_id"], "tenant": job["tenant"], "user_id": job["user_id"], "request_id": request_id}
    import json
    try:
        payload = json.loads(components["submission"])
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
    parent = jobs.jobs_dir / job["job_id"] / "results"
    current_basis = basis.active(job)
    input_bases = {}
    values, saved = [], set()
    # values는 요청별 표시용 목록, saved는 중복을 제거한 (문서, 산출물 종류) 집합이다.
    for request_id in source_files.entries(jobs.store, parent, maximum=MAX_RESULTS + 1):
        record, payload = load(service, job, request_id)
        current_run = payload["run_id"] == job["run_id"]
        key = (payload["bundle_id"], payload["bundle_revision"])
        if key not in input_bases:
            # 저장 미확인/초안에도 입력 기준이 있다. 현재 규약 사용권 없이 불변 묶음만 읽는다.
            from core.modules.analysis_inputs import contracts as input_limits
            input_limits.identifier(key[0]); input_limits.revision(key[1])
            try:
                manifest, _, _ = files.load(jobs.store, jobs.jobs_dir / job["job_id"] / "inputs" / key[0],
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
    parent = service.jobs.jobs_dir / job["job_id"] / "results"
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
