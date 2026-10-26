"""분석 결과를 받아 위키 또는 그래프에 저장하는 전체 순서를 관리한다.

읽는 순서: write_wiki / generate_ontology → _submit → _save.
저장한 결과를 다시 확인할 때는 query에서 시작하면 된다.

주요 변수는 모두 이름과 값의 쌍을 담은 딕셔너리(dict)다.
  payload: 클라이언트가 제출한 본문/그래프와 작업·입력 버전 정보.
  manifest: 서버가 앞서 고정해 둔 입력 묶음의 설명서와 버전 정보.
  record: 이번 요청의 처리 상태·검사 보고·저장 영수증을 묶은 기록.
  receipt: 실제 저장된 문서와 버전을 가리키는 저장 영수증.

job_id는 분석 작업, run_id는 그 작업의 이번 실행, request_id는 한 번의
제출을 구분한다. revision은 내용의 지문 같은 값이며, 준비할 때 읽은 내용이
지금도 같은지 비교하는 데 쓴다. 서로 다른 종류의 ID나 revision을 섞지 않는다.
"""

from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.access.policy import AccessDenied, PolicyError
from core.modules.analysis_inputs import bundles, capture, contracts as inputs_limits
from core.modules.analysis_inputs.store import InputStore
from core.modules.analysis_jobs import commands, contracts as job_limits, records
from core.modules.documents.store import RevisionConflictError, StorageBusyError
from core.modules.ontology.errors import OntologyValidationError
from core.modules.ontology.store import OntologyStore
from . import diagnostics as diagnostic_reports, repository, validation, rule_checks
from .contracts import MAX_SUBMISSION_BYTES, ResultError


class ResultStore:
    """위키·입력·작업 저장 기능을 연결하는 서비스 객체다.

    self는 '지금 사용 중인 이 ResultStore 객체'를 뜻한다. 이름이 _로 시작하는
    메서드는 이 클래스 내부에서 쓸 보조 함수라는 관례이며 접근 권한 설정은 아니다.
    """

    def __init__(self, store, rulesets, *, jobs=None):
        """사용할 저장소와 규약을 받는다. 생성하는 것만으로 파일을 저장하지 않는다.

        store는 기존 WikiStore, rulesets는 사용할 규약을 확인하는 객체다.
        * 뒤의 jobs는 jobs=...처럼 이름을 붙여 전달한다. 생략하면 InputStore가
        작업 저장 객체를 구성하고, 전달하면 그 객체를 함께 사용한다.
        """
        self.store, self.rulesets = store, rulesets
        self.inputs = InputStore(store, rulesets, jobs=jobs)
        self.jobs = self.inputs.jobs

    def _write_receipt(self, path, value):
        """처리 기록을 파일로 남긴다. 위키 본문을 쓰는 함수와는 별도다."""
        records.write(self.jobs, path, value)

    def write_wiki(self, job_id, *, tenant, user_id, run_id, expected_job_revision,
                   bundle_id, bundle_revision, request_id, document, content, expected_revision, authorize,
                   execution=None, diagnostics=None, save=True):
        """위키 본문 저장의 시작점. 결과 딕셔너리를 반환하고 거부 사유는 예외로 알린다.

        document는 상대 문서 경로, content는 저장할 전체 본문이다.
        expected_revision은 본문을 작성할 때 읽었던 버전이며 신규 생성에만 None을 쓴다.
        bundle_id/bundle_revision은 참고한 고정 입력을 가리킨다.
        authorize는 최신 권한을 확인할 '함수'이며 저장 직전에도 다시 호출한다.
        나머지 작업·실행·요청 ID의 의미는 이 파일 맨 위 설명을 참고한다.
        """
        # 실행 정보는 선택값이다. 생략한 옛 호출의 payload/hash가 달라지지 않게 키 자체를 추가하지 않는다.
        value = {"content": content}
        if execution is not None:
            value["execution"] = execution
        self._report_options(value, diagnostics, save)
        return self._submit(job_id, tenant, user_id, run_id, expected_job_revision, bundle_id,
            bundle_revision, request_id, document, expected_revision, authorize, "prepare_wiki", value)

    def generate_ontology(self, job_id, *, tenant, user_id, run_id, expected_job_revision,
                          bundle_id, bundle_revision, request_id, document, expected_revision,
                          submission, authorize, expected_state_revision=None, execution=None,
                          diagnostics=None, save=True):
        """그래프 저장의 시작점. 위키 저장과 같은 접수·중복 방지 절차를 사용한다.

        submission은 개체·관계·인용 등을 담은 원시 딕셔너리다.
        expected_revision은 실제 위키 본문 버전, expected_state_revision은
        검토 상태의 기준 버전이다. 뒤의 값을 생략해도 고정 입력에 담긴 상태를 검사한다.
        """
        value = {"submission": submission, "expected_state_revision": expected_state_revision}
        if execution is not None:
            value["execution"] = execution
        self._report_options(value, diagnostics, save)
        return self._submit(job_id, tenant, user_id, run_id, expected_job_revision, bundle_id,
            bundle_revision, request_id, document, expected_revision, authorize, "extract_ontology", value)

    @staticmethod
    def _report_options(value, diagnostics, save):
        """옛 제출의 hash를 유지하고 명시적인 초안 보관/진단만 추가한다."""
        if type(save) is not bool:
            raise ResultError("invalid_submission")
        if diagnostics is not None:
            value["diagnostics"] = diagnostics
        if not save:
            value["save"] = False

    def query(self, job_id, *, tenant, user_id, request_id, authorize):
        """현재 read·소유권만 확인한다. 만료·취소·규약 철회 후에도 자기 결과를 확인할 수 있다."""
        job_limits.identifier(job_id); job_limits.identifier(request_id)
        with self.jobs.sources._coordination_lock():
            actor = records.authorized(lambda: authorize("read"), tenant, user_id)
            job = records.owned_state(self.jobs, job_id, tenant, user_id)
            record, _ = repository.load(self, job, request_id)
            value = self._response(record, job, replayed=False)
            value["current_output"] = self._observe(record["receipt"], actor) if record["saved"] is True else None
            return value

    @staticmethod
    def _response(record, job, *, replayed):
        """내부 기록에서 응답에 필요한 항목을 골라 새 딕셔너리로 만든다.

        @staticmethod는 self 없이 호출할 수 있다는 뜻이다. 아래의 { ... for ... }는
        여러 키를 반복해서 담는 표현이고, dict | dict는 두 딕셔너리를 합친다.
        replayed=True는 새로 저장한 것이 아니라 같은 요청의 기록을 반환했다는 뜻이다.
        """
        return {key: record.get(key) for key in (
            "request_id", "state", "saved", "receipt", "validation_report", "cleanup_failures", "diagnostics")} | {
                "job_id": job["job_id"], "job_revision": canonical_json_hash(job), "replayed": replayed,
                "submission_ref": {"request_id": record["request_id"], "payload_hash": record["payload_hash"],
                                   "retained": True, "format": "canonical_json_values"}}

    @staticmethod
    def _raise_record(record):
        """앞서 거부한 요청이 다시 오면 저장하지 않고 같은 거부 사유를 알린다."""
        raise ResultError(record.get("error_code", "invalid_submission"), request_id=record["request_id"],
                          state=record["state"], validation_report=record["validation_report"])

    def _submit(self, job_id, tenant, user_id, run_id, expected_job_revision, bundle_id,
                bundle_revision, request_id, document, expected_revision, authorize, stage, value):
        """위키와 그래프 저장이 공통으로 거치는 접수·중복 확인·오류 처리다.

        처리 순서: ID/크기 확인 → 현재 권한/소유자 확인 → 기존 요청 확인 →
        원시 제출 보관 → 실제 저장(_save) → 응답 또는 실패 보고.
        """
        for identifier in (job_id, run_id, bundle_id, request_id):
            job_limits.identifier(identifier)
        job_limits.revision(expected_job_revision); job_limits.revision(bundle_revision)
        if expected_revision is not None:
            job_limits.revision(expected_revision)
        permission = inputs_limits.stage_permission(stage)
        # **value는 딕셔너리의 항목을 펼쳐 넣는다. 위키라면 content가,
        # 그래프라면 submission과 expected_state_revision이 공통 항목에 추가된다.
        payload = {"job_id": job_id, "run_id": run_id, "request_id": request_id,
            "expected_job_revision": expected_job_revision, "bundle_id": bundle_id,
            "bundle_revision": bundle_revision, "document": document, "expected_revision": expected_revision,
            "stage": stage, **value}
        raw = canonical_json_bytes(payload)
        if len(raw) > MAX_SUBMISSION_BYTES:
            raise ResultError("result_limit")
        # with는 아래 처리가 끝나거나 예외가 나도 잠금을 해제한다.
        # 잠금을 보유하는 동안 같은 tenant의 원본/작업 상태 변경을 순서대로 처리한다.
        with self.jobs.sources._coordination_lock():
            # lambda는 나중에 실행할 짧은 함수다. 저장된 옛 허가 대신 지금 권한을 확인한다.
            actor = records.authorized(lambda: authorize(permission), tenant, user_id)
            job = records.owned_state(self.jobs, job_id, tenant, user_id)
            directory = repository.directory(self, job_id, request_id)
            # 같은 request_id가 다시 오면 '새 저장'보다 '기존 요청 확인'을 먼저 한다.
            if directory.exists():
                record, prior = repository.load(self, job, request_id)
                if canonical_json_hash(payload) != record["payload_hash"] or prior != payload:
                    raise ResultError("request_conflict", request_id=request_id)
                if record["state"] == "rejected":
                    self._raise_record(record)
                if record["state"] != "storage_busy":
                    return self._response(record, job, replayed=True)
            else:
                # 검사가 실패하더라도 어떤 원문/그래프를 제출했는지 확인할 수 있게 보관한다.
                repository.publish(self, job, request_id, payload)
            # saved=None: 아직 저장 여부를 확정하지 못함. False: 저장이 거부됨.
            # True: 저장 함수의 성공 결과를 받음. state는 영수증 연결 상태까지 따로 나타낸다.
            record = {"job_id": job_id, "tenant": tenant, "user_id": user_id, "request_id": request_id,
                "payload_hash": canonical_json_hash(payload), "state": "pending_reconcile", "saved": None,
                "receipt": None, "validation_report": validation.report(stage), "cleanup_failures": []}
            record["diagnostics"] = diagnostic_reports.observation(payload)
            # 접수 근거를 기록한 뒤에만 원문·그래프를 쓴다. 불명확한 결과는 조회로 확인한다.
            self._write_receipt(directory / "receipt.json", record)
            # try는 오류가 날 수 있는 처리를 실행하고, except는 오류 종류별로 대응한다.
            # 모든 오류를 '저장 실패' 하나로 묶으면 이미 성공한 저장을 반복할 수 있다.
            try:
                return self._save(job, actor, payload, record, directory, authorize)
            except (AccessDenied, PolicyError) as error:
                self._reject(record, directory, stage, "access_denied" if isinstance(error, AccessDenied) else "access_unavailable")
                raise
            except StorageBusyError:
                # 다른 쓰기가 잠금을 보유한 경우다. 입력 기준을 바꾸지 않고 나중에 재시도한다.
                self._reject(record, directory, stage, "storage_busy", state="storage_busy")
                raise
            except (ResultError, inputs_limits.InputConflictError, job_limits.JobConflictError,
                    ValueError, TypeError, RevisionConflictError) as error:
                if record["saved"] is True:
                    # 본문/그래프 저장 뒤 기록 연결만 실패했을 수 있다. 저장 성공을 취소하지 않는다.
                    record["state"] = "pending_reconcile"
                    return self._response(record, job, replayed=False)
                code = ("conflict" if isinstance(error, RevisionConflictError) else getattr(error, "code", None)
                        or ("invalid_ontology" if isinstance(error, OntologyValidationError) else "invalid_submission"))
                self._reject(record, directory, stage, code, details=getattr(error, "details", {}))
                # from error는 이번 오류의 원인이 된 원래 예외도 함께 추적할 수 있게 남긴다.
                raise ResultError(code, request_id=request_id, state="rejected",
                                  validation_report=record["validation_report"]) from error
            except OSError as error:
                # 저장 호출 중 예외는 일부 공개 가능성이 있어 hash 비교로 성공을 추정하지 않는다.
                rule_checks.failure(record["validation_report"], "storage_error")
                record["cleanup_failures"] = self._warnings(error)
                self._best_effort_receipt(directory, record)
                return self._response(record, job, replayed=False)

    def _reject(self, record, directory, stage, code, *, state="rejected", details=None):
        """저장 전 거부 사유를 기록한다. 원시 제출이나 기존 위키/그래프는 삭제하지 않는다."""
        record.update(state=state, saved=False, error_code=code)
        rule_checks.failure(record["validation_report"], code)
        if code in {"invalid_submission", "invalid_ontology", "invalid_execution_report"}:
            record["validation_report"]["automatic"] = "failed"
        if details:
            record["validation_report"]["details"] = details
        self._best_effort_receipt(directory, record)

    def _best_effort_receipt(self, directory, record):
        """가능하면 실패 보고도 저장한다. 보고 저장 오류로 원래 결과를 덮어쓰지 않는다."""
        try:
            self._write_receipt(directory / "receipt.json", record)
        except OSError:
            pass  # 원래 저장 결과와 불변 제출을 남기고 쓰기를 자동 재시도하지 않는다.

    def _warnings(self, value):
        """정리 경고가 객체/딕셔너리 중 어느 형태든 응답에 넣을 공통 형태로 맞춘다."""
        failures = getattr(value, "cleanup_failures", ())
        if failures and isinstance(failures[0], dict):
            from core.modules.sources.validation import validate_serialized_cleanup
            result = list(failures)
            validate_serialized_cleanup(result)
            return result
        return cleanup_details(self.store.data_dir, failures) if failures else []

    def _save(self, job, actor, payload, record, directory, authorize):
        """고정 입력을 확인하고 기존 WikiStore/OntologyStore로 실제 자료를 저장한다.

        호출 시 _submit이 이미 원본/작업 조정 잠금을 보유하고 있다.
        실제 위키 잠금은 각 저장 함수가 잡으며 before_commit에서 최종 확인을 한다.
        """
        report = record["validation_report"]
        rule_checks.start(report, "R-A01")
        if self.rulesets is None:
            raise ResultError("ruleset_unavailable")
        stage, document = payload["stage"], payload["document"]
        permission = inputs_limits.stage_permission(stage)
        rule_checks.start(report, "R-A02")
        job, actor = bundles.opened(self.inputs, job["job_id"], job["tenant"], job["user_id"],
            payload["run_id"], authorize, permission, payload["expected_job_revision"])
        # 재추출 작업은 실제 결과 초안만 제출하며 canonical 적용은 추출안의 명시 apply로 남긴다.
        from core.modules.analysis_proposals.executions import ensure_proposal_job_draft
        ensure_proposal_job_draft(self.store, job, actor, payload, rulesets=self.rulesets)
        manifest, _, components = bundles.load_locked(self.inputs, job, payload["bundle_id"], payload["bundle_revision"])
        # 위키 작성용 입력으로 그래프를 저장하거나, 다른 문서를 대상으로 바꾸는 것을 막는다.
        if manifest["stage"] != stage or manifest["target_document"] != document:
            raise ResultError("input_scope_mismatch")
        output = "wiki" if stage == "prepare_wiki" else "ontology"
        if output not in job["outputs"] or document not in {target["document"] for target in job["targets"]}:
            raise ResultError("input_scope_mismatch")
        rule_checks.mark(report, "R-A02", "pass", "authorized_live_job_and_bundle_scope")
        rule_checks.run(report, "R-A01", lambda: self.rulesets.validate_reference(job["tenant"], manifest["ruleset_ref"]))
        report["basis"] = {key: payload[key] for key in ("job_id", "run_id", "bundle_id", "bundle_revision", "document")}
        report["basis"].update(ruleset_ref=manifest["ruleset_ref"], source_revision=payload["expected_revision"],
                               submission_sha256=canonical_json_hash(payload.get("submission", payload.get("content"))),
                               schema_version=payload.get("submission", {}).get("schema_version"),
                               analysis_basis_revision=manifest.get("analysis_basis_revision"))
        rule_checks.start(report, "R-A04")
        if not manifest["input_ready"]:
            raise ResultError("input_incomplete")
        rule_checks.mark(report, "R-A04", "pass", "fixed_required_components_available_not_model_comprehension")
        # _submit이 원시 제출을 먼저 보관한 다음 여기로 온다. 잘못된 실행 신고도 확인할 근거를 남긴다.
        rule_checks.start(report, "R-A05")
        execution = validation.execution_report(payload.get("execution"))
        # next(...)는 여러 문서의 입력 기록 중 이번 대상 문서에 해당하는 하나를 고른다.
        target = next(item for item in manifest["dependency"]["documents"] if item["document"] == document)
        source_revision = target.get("source_revision")
        rule_checks.start(report, "R-A03")
        if payload["expected_revision"] != source_revision:
            raise ResultError("conflict")
        if stage == "extract_ontology" and payload["expected_state_revision"] not in (None, target.get("state_revision")):
            raise ResultError("conflict")
        rule_checks.start(report, "R-A05")
        diagnostic_reports.validate(payload.get("diagnostics"), manifest, components, payload)
        record["diagnostics"] = diagnostic_reports.observation(payload, manifest, validated=True)
        report["semantic"] = diagnostic_reports.semantic_summary(payload.get("diagnostics"))
        if payload.get("save") is False:
            # 초안 보존은 저장/승인이 아니다. 현재 권한·기준을 검사한 뒤 보고 영수증만 기록한다.
            with self.store._write_lock():
                rule_checks.start(report, "R-A02")
                current = records.authorized(lambda: authorize(permission), job["tenant"], job["user_id"])
                commands.check_basis(self.jobs, job["source_ref"])
                commands.live(self.jobs, job, payload["run_id"])
                rule_checks.start(report, "R-A03")
                bundles.validate_current_locked(self.inputs, job, manifest, current)
                rule_checks.mark(report, "R-A03", "pass", "current_fixed_basis_checked_draft_only")
                report.pop("active_rule", None)
                # 초안에는 그래프 검사를 실행하지 않는다. 신고된 미독도 숨기지 않는다.
                diagnostic = payload.get("diagnostics")
                if diagnostic and (diagnostic["unread_ranges"] or stage == "prepare_wiki" and diagnostic["omissions"]):
                    rule_checks.mark(report, "R-A04", "fail", "diagnostic_input_incomplete")
                record.update(state="draft", saved=False)
                self._write_receipt(directory / "receipt.json", record)
            return self._response(record, job, replayed=False)
        diagnostics = payload.get("diagnostics")
        # 미독 입력은 자동 차단하며 의미상 의심만으로 전체 그래프를 거부하지 않는다.
        rule_checks.start(report, "R-A04")
        if diagnostics is not None and (diagnostics["unread_ranges"] or
                stage == "prepare_wiki" and diagnostics["omissions"]):
            raise ResultError("diagnostic_input_incomplete")
        if stage == "extract_ontology":
            if payload["expected_state_revision"] not in (None, target.get("state_revision")):
                raise ResultError("conflict")
            if "wiki" in job["outputs"]:
                # 본문→그래프 작업에서는 앞서 같은 실행에서 저장한 위키의 영수증이 필요하다.
                predecessor = repository.wiki_receipt(self, job, document, source_revision,
                                                      history_revision=target.get("history_revision"))
                if manifest.get("previous_result") != predecessor:
                    raise ResultError("wiki_result_required")
            source = diagnostic_reports.source_text(manifest, components, payload)
            rule_checks.graph_checks(report, payload["submission"], source, document, source_revision,
                                     lambda: validation.graph_submission(self.rulesets, payload["submission"]))
        # 실제 저장 뒤 이벤트 한도에 걸리지 않도록 같은 크기의 후보로 먼저 검사한다.
        self._candidate(job, actor, payload, source_revision="0" * 64, graph_revision="0" * 64)

        def before_commit():
            """저장 함수가 위키 잠금을 잡은 뒤, 실제 자료 변경 직전에 호출하는 함수다."""
            # nonlocal은 바깥 _save의 actor를 바꾼다는 뜻이다. 최종 확인한 주체를 기록한다.
            nonlocal actor
            rule_checks.start(report, "R-A02")
            current = records.authorized(lambda: authorize(permission), job["tenant"], job["user_id"])
            commands.check_basis(self.jobs, job["source_ref"])
            commands.live(self.jobs, job, payload["run_id"])
            rule_checks.start(report, "R-A03")
            bundles.validate_current_locked(self.inputs, job, manifest, current)
            actor = current
            rule_checks.mark(report, "R-A03", "pass", "current_fixed_basis_and_storage_cas_checked")
            rule_checks.mark(report, "R-A05", "pass", "schema_and_canonical_storage_validation_completed")
            report.pop("active_rule", None)
            report["automatic"] = "passed"
            for check in report["checks"]:
                check["status"] = "passed"
            self._write_receipt(directory / "receipt.json", record)

        if stage == "prepare_wiki":
            rule_checks.start(report, "R-A05")
            # before_commit()처럼 여기서 실행하지 않고 함수 자체를 넘긴다.
            # WikiStore가 잠금을 보유한 정확한 시점에 이 함수를 실행해야 하기 때문이다.
            result = self.store.save(document, payload["content"], expected_revision=source_revision,
                                     before_commit=before_commit)
            result = {"source_revision": result.revision, "graph_revision": None, "changed": result.changed,
                      "history_entry": result.history_path.name if result.history_path is not None else None,
                      "cleanup_failures": cleanup_details(self.store.data_dir, result.cleanup_failures)}
        else:
            # 함수 호출의 **딕셔너리는 각 항목을 이름 있는 인자로 펼친다.
            # 예: {"entities": [...]} → generate(..., entities=[...]).
            # 새 분석 계획은 전체 재추출 요청이다. 같은 내용도 새 세대로 저장해
            # 이전 승인과 새 실행의 검토 상태가 섞이지 않게 한다. 옛 작업의 no-op은 유지한다.
            generation = {"force_generation": True} if job["events"][0]["details"].get("analysis_plan") else {}
            rule_checks.start(report, "R-A05")
            result = OntologyStore(self.store).generate(document, source_revision,
                **payload["submission"], **generation,
                expected_state_revision=target["state_revision"], before_commit=before_commit)
        receipt = {"document": document, "stage": stage, "source_revision": result["source_revision"],
            "graph_revision": result["graph_revision"], "state_revision": None, "changed": result["changed"],
            "ruleset_ref": manifest["ruleset_ref"], "bundle_id": payload["bundle_id"],
            "bundle_revision": payload["bundle_revision"], "payload_hash": record["payload_hash"],
            "source_ref": job["source_ref"], "extraction_ref": manifest["dependency"]["extraction"],
            "previous_result": manifest.get("previous_result"), "review_status": "unreviewed",
            "execution": execution}
        receipt["analysis_basis_revision"] = manifest.get("analysis_basis_revision")
        receipt["history_entry"] = result.get("history_entry")
        observed = self._observe(receipt, actor)
        if observed["status"] == "current":
            receipt["state_revision"] = observed["state_revision"]
            receipt["history_revision"] = observed["history_revision"]
        # 저장 함수의 source/graph revision과, 그 뒤 관측한 검토 상태의 시점을 구분한다.
        receipt.update(state_revision_basis="post_save_snapshot", base_state_revision=target.get("state_revision"),
                       actor=actor, recorded_at=self.jobs._now().isoformat())
        record.update(saved=True, receipt=receipt, cleanup_failures=result["cleanup_failures"])
        try:
            # 파일 기록 순서는 중요하다: 실제 성공 증거 → 작업 이력 연결 → 완료 영수증.
            # 마지막 파일을 쓰다가 끊겨도 앞의 성공 증거로 '자료는 저장됨'을 확인할 수 있다.
            # Canonical 저장이 반환한 revision을 별도로 남긴다. 영수증 실패가 저장 재실행을 유도하지 않는다.
            records.write(self.jobs, directory / "saved.json", record)
            candidate = self._candidate(job, actor, payload, source_revision=receipt["source_revision"],
                                        graph_revision=receipt["graph_revision"])
            self.jobs._write(records.state_path(self.jobs, job["job_id"]), candidate)
            record["state"] = "complete"
            self._write_receipt(directory / "receipt.json", record)
        except (OSError, ValueError, TypeError):
            record["state"] = "pending_reconcile"
            return self._response(record, job, replayed=False)
        return self._response(record, candidate, replayed=False)

    def _candidate(self, job, actor, payload, **revisions):
        """추가할 작업 이벤트를 만든다. **revisions는 이름 있는 버전 인자들을 모은 dict다."""
        return bundles.after(self.inputs, job, actor, "result_saved", request_id=payload["request_id"],
            stage=payload["stage"], document=payload["document"], **revisions)

    def _observe(self, receipt, actor):
        """과거 성공 영수증과 현재 출력을 구분한다. 조회 실패 때문에 저장을 반복하지 않는다."""
        try:
            with self.store._write_lock():
                _, values, _ = capture.documents_locked(self.store,
                    [{"document": receipt["document"], "required": True, "reason": "result_observation"}], actor)
            value = values[0]
            same = value["source_revision"] == receipt["source_revision"] and (
                receipt["graph_revision"] is None or value["graph_revision"] == receipt["graph_revision"])
            return {"status": "current" if same else "changed",
                    "state_changed": (value["state_revision"] != receipt["state_revision"]
                                      if receipt.get("state_revision") is not None else None),
                    **{name: value[name] for name in ("source_revision", "graph_revision", "state_revision", "history_revision")}}
        except (OSError, ValueError, TypeError, StorageBusyError):
            return {"status": "unavailable", "source_revision": None, "graph_revision": None, "state_revision": None}
