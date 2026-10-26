"""개인 재추출을 기존 계획/job에 인계하고 정확한 결과만 후보에 연결한다.

서버는 모델을 실행하지 않는다. 입력·후보·영수증은 불변 보존하고, 현재성은
조회 시 별도로 계산한다. 모든 canonical 변경은 ProposalStore.apply에 남긴다.
"""
from copy import deepcopy
import json
from types import SimpleNamespace

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.access.policy import AccessDenied
from core.modules.analysis_inputs import bundles, files, contracts as limits
from core.modules.analysis_jobs import records, commands
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_plans.store import PlanStore, stable_id
from core.modules.analysis_results import repository
from core.modules.analysis_results.store import ResultStore
from core.modules.sources import files as source_files
from .store import ProposalStore, MAX_CAPTURE_BYTES, MAX_EVENTS, claims, now

PREFIX = "proposal_execution:"
MAX_REPORT_TOTAL_BYTES = 8 * 1024 * 1024


class ProposalExecutionStore:
    """현재 인증 주체에 속한 추출안과 실제 job 결과 사이의 연결만 관리한다."""

    def __init__(self, store, actor, *, rulesets=None):
        self.store, self.actor, self.rulesets = store, actor, rulesets
        self.proposals = ProposalStore(store, actor, rulesets=rulesets)
        self.plans = PlanStore(store, actor, rulesets=rulesets)
        self.jobs = JobStore(store, rulesets=rulesets)
        self.results = ResultStore(store, rulesets, jobs=self.jobs)

    def _owned(self, proposal_id):
        values = self.proposals._load(proposal_id)
        # 관점은 비밀 경계는 아니지만 다른 관점의 보고를 현재 결과로 붙이지 않는다.
        if any(values[2]["actor"][key] != self.actor[key]
               for key in ("tenant", "user_id", "profile_id", "domain", "viewpoint")):
            raise AccessDenied()
        return values

    def _intent(self, path, execution_id):
        limits.identifier(execution_id)
        manifest, text, parts = files.load(self.store, path / "executions" / execution_id,
                                           maximum=MAX_CAPTURE_BYTES)
        if manifest.get("execution_id") != execution_id or manifest.get("proposal_id") != path.name:
            raise limits.InputCorruptError("Proposal execution identity differs")
        return manifest, files.digest(text.encode()), json.loads(parts["plan.json"])

    @staticmethod
    def _candidate_revision(state):
        return None if state["candidate"] is None else state["candidate"]["candidate_revision"]

    def _active(self, path, state, intent):
        if state.get("active_execution_id") != intent["execution_id"]:
            raise limits.InputConflictError("proposal_execution_superseded")
        if state["candidate"] != intent["candidate_ref"]:
            if state["candidate"] is None:
                raise limits.InputConflictError("proposal_candidate_changed")
            candidate, _, _ = self.proposals._read_candidate(path, state["candidate"])
            if candidate.get("execution_ref", {}).get("execution_id") != intent["execution_id"]:
                raise limits.InputConflictError("proposal_candidate_changed")

    def start(self, proposal_id, request_id, expected_state_revision, candidate_revision, reason, *, authorize):
        """명시 실행 의도를 먼저 보존하고 정확한 같은 계획/job 요청으로 인계한다."""
        limits.identifier(request_id)
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 1000:
            raise ValueError("A re-extraction reason is required")
        payload = dict(expected_state_revision=expected_state_revision, candidate_revision=candidate_revision, reason=reason)
        digest = canonical_json_hash(payload)
        with source_files.coordination(self.store, create=True):
            path, _, basis, state = self._owned(proposal_id)
            previous = state.get("executions", {}).get(request_id)
            if request_id in state["applications"] or request_id in state["requests"] and previous is None:
                raise limits.InputConflictError("proposal_request_conflict")
            if previous is not None:
                if state["requests"][request_id] != digest:
                    raise limits.InputConflictError("proposal_request_conflict")
                intent, _, body = self._intent(path, request_id)
            else:
                self.proposals._basis_and_state(proposal_id, expected_state_revision)
                if self._candidate_revision(state) != candidate_revision:
                    raise limits.InputConflictError("proposal_candidate_changed")
                if self.rulesets is None:
                    raise limits.InputConflictError("ruleset_unconfigured")
                names = source_files.entries(self.store, path / "executions", maximum=MAX_EVENTS)
                if request_id not in names and len(names) >= MAX_EVENTS:
                    raise limits.InputLimitError("Proposal execution count exceeded")
                for name in names:
                    if name != request_id and name not in state.get("executions", {}):
                        raise limits.InputConflictError("proposal_execution_unlinked", execution_id=name)
                if (path / "candidates" / request_id).exists() or (path / "result-links" / request_id).exists():
                    raise limits.InputConflictError("proposal_request_conflict")
                target = self.proposals._target(basis)
                plan_request = stable_id("proposal-plan", proposal_id, request_id)
                body = {"request_id": plan_request, "source_ref": None, "conversion_ref": None,
                    "wiki_ref": {"document": basis["target_document"], **{key: target["review"][key]
                        for key in ("source_revision", "graph_revision", "state_revision")}},
                    "locations": [], "outputs": [{"document": basis["target_document"],
                        "title": basis["target_document"][:200], "purpose": PREFIX + proposal_id + ":" + request_id,
                        "locations": [], "outputs": ["ontology"]}],
                    "context_documents": [{key: item[key] for key in ("document", "required", "reason")}
                        for item in basis["documents"] if item["document"] != basis["target_document"]]}
                intent = {"kind": "proposal_execution", "proposal_id": proposal_id, "execution_id": request_id,
                    "actor": self.actor, "payload_hash": digest, "input_revision": state["input_revision"],
                    "proposal_state_revision": expected_state_revision, "candidate_ref": deepcopy(state["candidate"]),
                    "source_revision": target["source"]["revision"], "graph_revision": target["review"]["graph_revision"],
                    "review_state_revision": target["review"]["state_revision"], "ruleset_ref": basis["ruleset_ref"],
                    "reason": reason, "created_at": now(),
                    "plan_id": stable_id("plans", self.actor["tenant"], self.actor["user_id"], plan_request)}
                components = {"plan.json": canonical_json_bytes(body).decode()}
                intent["components"] = files.descriptors(components)
                destination = path / "executions" / request_id
                if destination.exists():
                    prior, _, stored = self._intent(path, request_id)
                    if prior["payload_hash"] != digest or stored != body:
                        raise limits.InputConflictError("proposal_request_conflict")
                    intent = prior
                else:
                    authorize()
                    files.publish(self.store, destination, intent, components, maximum=MAX_CAPTURE_BYTES)
                with self.store._write_lock():
                    authorize()
                    self.proposals._current(basis, locked=True)
                    state.setdefault("executions", {})[request_id] = {"execution_id": request_id,
                        "candidate_ref": intent["candidate_ref"], "plan_id": intent["plan_id"], "input_revision": state["input_revision"]}
                    state["active_execution_id"] = request_id
                    state["requests"][request_id] = digest
                    self.proposals._event(state, "execution_requested", execution_id=request_id, request_id=request_id)
                    self.proposals._write(path, state)
        # 다른 저장기의 공개 API는 자체 조정 잠금을 잡는다. 중첩 호출하지 않는다.
        current = self.read(proposal_id, request_id)
        if previous is not None and current["state"] != "pending_reconcile":
            return {**current, "replayed": True}
        def current_authorize():
            actor = authorize()
            _, _, fixed, latest = self._owned(proposal_id)
            self._active(path, latest, intent)
            self.proposals._current(fixed)
            return actor
        planned = self.plans.create(SimpleNamespace(model_dump=lambda **_: body), current_authorize)
        self.plans.handoff(planned["manifest"]["id"], planned["revision"], request_id, current_authorize)
        return {**self.read(proposal_id, request_id), "replayed": previous is not None}

    def read(self, proposal_id, execution_id):
        """과거 접수 근거와 현재 job/후보 상태를 조회한다. 새 접수는 하지 않는다."""
        with source_files.coordination(self.store):
            path, _, basis, state = self._owned(proposal_id)
            intent, revision, _ = self._intent(path, execution_id)
            linked = execution_id in state.get("executions", {})
            status = "pending_reconcile"
            try:
                self.proposals._current(basis)
                if linked:
                    self._active(path, state, intent)
                elif canonical_json_hash(state) != intent["proposal_state_revision"]:
                    raise limits.InputConflictError("proposal_candidate_changed")
            except AccessDenied:
                status = "basis_changed"
            except limits.InputConflictError as error:
                status = "superseded" if error.code in {"proposal_execution_superseded", "proposal_candidate_changed"} else "basis_changed"
            except (OSError, ValueError):
                # 원문이나 발행 규약을 지금 읽지 못해도 당시 접수/결과는 read로 남긴다.
                status = "basis_changed"
            plan_ref = {"plan_id": intent["plan_id"], "plan_revision": None}
            try:
                _, plan_ref["plan_revision"], _ = self.plans._load_locked("plans", intent["plan_id"])
            except FileNotFoundError:
                pass
        job, handoff = None, None
        if plan_ref["plan_revision"] is not None:
            handoff = self.plans.handoff_receipt(intent["plan_id"], execution_id)
            child = handoff["jobs"][0]
            if child.get("job_id") is not None and child["state"] == "complete":
                job = self.jobs.query(child["job_id"], tenant=self.actor["tenant"], user_id=self.actor["user_id"])
                if status == "pending_reconcile" and linked:
                    status = "ready"
                if job["state"] == "cancelled":
                    status = "cancelled"
        if status == "ready" and any(item["execution_id"] == execution_id and item["mode"] == "candidate"
                                     and item["candidate_ref"] == state["candidate"] for item in state.get("result_links", [])):
            status = "candidate_ready"
        return {"proposal_id": proposal_id, "execution_id": execution_id, "execution_revision": revision,
            "request_id": execution_id, "payload_hash": intent["payload_hash"],
            "proposal_state_revision": intent["proposal_state_revision"], "reason": intent["reason"],
            "input_revision": intent["input_revision"], "state_revision": canonical_json_hash(state),
            "candidate_ref": intent["candidate_ref"], "plan_ref": plan_ref, "handoff": handoff, "job": job,
            "job_id": None if job is None else job["job_id"], "job_revision": None if job is None else job["job_revision"],
            "state": status, "linked": linked, "canonical_changed": False, "execution_started": False,
            "retry_policy": "exact_start_request_only_if_pending"}

    def _result(self, path, basis, state, intent, ref):
        for key in ("job_id", "run_id", "bundle_id", "request_id"):
            limits.identifier(ref[key])
        for key in ("bundle_revision", "payload_hash", "submission_sha256"):
            limits.revision(ref[key])
        job = records.owned_state(self.jobs, ref["job_id"], self.actor["tenant"], self.actor["user_id"])
        if job["actor"] != basis["actor"]:
            raise AccessDenied()
        plan = job["events"][0]["details"].get("analysis_plan")
        expected_request = stable_id("plan-job", intent["plan_id"], intent["execution_id"], basis["target_document"])
        if plan is None or plan["plan_id"] != intent["plan_id"] or job["request_id"] != expected_request:
            raise limits.InputConflictError("proposal_result_scope_mismatch")
        if job["state"] == "cancelled":
            raise limits.InputConflictError("job_cancelled")
        if job["run_id"] != ref["run_id"]:
            raise limits.InputConflictError("proposal_result_run_changed")
        commands.check_basis(self.jobs, job["source_ref"])
        commands.live(self.jobs, job, ref["run_id"])
        record, payload = repository.load(self.results, job, ref["request_id"])
        if any(payload[key] != ref[key] for key in ("job_id", "run_id", "bundle_id", "bundle_revision", "request_id")):
            raise limits.InputConflictError("proposal_result_reference_mismatch")
        if (record["payload_hash"] != ref["payload_hash"] or payload.get("stage") != "extract_ontology"
                or payload.get("save") is not False or payload["document"] != basis["target_document"]
                or canonical_json_hash(payload.get("submission")) != ref["submission_sha256"]):
            raise limits.InputConflictError("proposal_result_reference_mismatch")
        if record["saved"] is not False or record["state"] != "draft":
            raise limits.InputConflictError("proposal_result_not_draft")
        manifest, _, _ = bundles.load_locked(self.results.inputs, job, ref["bundle_id"], ref["bundle_revision"])
        rules = {key: basis["ruleset_ref"][key] for key in ("ruleset_id", "ruleset_version", "ruleset_revision")}
        if (manifest["actor"] != basis["actor"] or manifest["ruleset_ref"] != rules
                or manifest["stage"] != "extract_ontology" or manifest["target_document"] != basis["target_document"]
                or manifest["dependency"]["documents"] != basis["dependencies"]):
            # 이유·순서 외 모든 source/graph/history/review/state 판본이 같아야 한다.
            actual = {item["document"]: item for item in manifest["dependency"]["documents"]}
            expected = {item["document"]: item for item in basis["dependencies"]}
            if (actual != expected or manifest["actor"] != basis["actor"] or manifest["ruleset_ref"] != rules
                    or manifest["stage"] != "extract_ontology" or manifest["target_document"] != basis["target_document"]):
                raise limits.InputConflictError("proposal_result_basis_mismatch")
        bundles.validate_current(self.results.inputs, job, manifest, self.actor)
        self._active(path, state, intent)
        self.proposals._normalize(basis, payload["submission"])
        return record, payload, manifest

    def link(self, proposal_id, request_id, expected_state_revision, candidate_revision, execution_id,
             mode, result_ref, resolves_decision_ids, resolution_bindings, *, authorize):
        """서버가 보존한 정확한 초안만 가져오고 보고와 후보의 연결을 불변 기록한다."""
        limits.identifier(request_id); limits.identifier(execution_id)
        if mode not in {"candidate", "diagnostics"}:
            raise ValueError("Choose candidate or diagnostics")
        payload = dict(expected_state_revision=expected_state_revision, candidate_revision=candidate_revision,
            execution_id=execution_id, mode=mode, result_ref=result_ref,
            resolves_decision_ids=resolves_decision_ids, resolution_bindings=resolution_bindings)
        digest = canonical_json_hash(payload)
        with source_files.coordination(self.store, create=True):
            path, _, basis, state = self._owned(proposal_id)
            if request_id in state["applications"]:
                raise limits.InputConflictError("proposal_request_conflict")
            if request_id in state["requests"]:
                if state["requests"][request_id] != digest:
                    raise limits.InputConflictError("proposal_request_conflict")
                return self.proposals._view(proposal_id, replayed=True)
            self.proposals._basis_and_state(proposal_id, expected_state_revision)
            if (path / "executions" / request_id).exists():
                raise limits.InputConflictError("proposal_request_conflict")
            if self._candidate_revision(state) != candidate_revision:
                raise limits.InputConflictError("proposal_candidate_changed")
            intent, execution_revision, _ = self._intent(path, execution_id)
            record, raw, manifest = self._result(path, basis, state, intent, result_ref)
            reference = {**result_ref, "proposal_id": proposal_id, "input_revision": state["input_revision"],
                "proposal_state_revision": expected_state_revision, "execution_id": execution_id,
                "execution_revision": execution_revision, "source_revision": intent["source_revision"],
                "graph_revision": intent["graph_revision"], "review_state_revision": intent["review_state_revision"],
                "ruleset_ref": manifest["ruleset_ref"], "analysis_basis_revision": manifest.get("analysis_basis_revision"),
                "diagnostic_report_hash": (record.get("diagnostics") or {}).get("report_hash"),
                "result_job_revision": raw["expected_job_revision"],
                "result_receipt_revision": canonical_json_hash(record), "origin": "client_reported", "human_approval": False}
            if mode == "diagnostics":
                if state["candidate"] is None or resolves_decision_ids or resolution_bindings:
                    raise ValueError("Diagnostics require an existing candidate and no resolution edits")
                _, submission, _ = self.proposals._read_candidate(path, state["candidate"])
                if canonical_json_hash(submission) != result_ref["submission_sha256"]:
                    raise limits.InputConflictError("proposal_diagnostic_submission_mismatch")
                if not record.get("diagnostics") or record["diagnostics"].get("validation") != "structure_and_source_checked":
                    raise limits.InputConflictError("proposal_diagnostics_unvalidated")
            else:
                if state["candidate"] != intent["candidate_ref"]:
                    raise limits.InputConflictError("proposal_candidate_changed")
                decisions = {item["decision_id"]: item for item in state["decisions"]}
                bindings = {item["decision_id"]: item for item in resolution_bindings}
                if len(bindings) != len(resolution_bindings):
                    raise ValueError("Resolution decisions must be unique")
                identifiers = set(resolves_decision_ids) | set(bindings)
                if any(key not in decisions or decisions[key]["action"] != "reextract" for key in identifiers):
                    raise ValueError("Only re-extraction decisions can be resolved")
                for key in resolves_decision_ids:
                    bindings.setdefault(key, dict(decision_id=key, new_claim_id=decisions[key]["old_claim_id"], reason="explicit_same_id_resolution"))
                graph = self.proposals._normalize(basis, raw["submission"])
                claim_ids = {item["claim_id"] for item in claims(graph)}
                if any(item["new_claim_id"] not in claim_ids for item in bindings.values()):
                    raise ValueError("Resolution must refer to a claim in this candidate")
                authorize()
                state["candidate"] = self.proposals._candidate(path, basis, request_id, raw["submission"],
                    sorted(identifiers), state, digest, "execution_result", list(bindings.values()), execution_ref=reference)
            report_path = path / "result-links" / request_id
            entry = {"request_id": request_id, "execution_id": execution_id, "mode": mode,
                     "candidate_ref": deepcopy(state["candidate"]), "result_ref": reference, "payload_hash": digest}
            components = {"report.json": canonical_json_bytes({"validation_report": record["validation_report"],
                           "diagnostics": record.get("diagnostics"), "result_state": record["state"], "saved": False}).decode()}
            report_manifest = {**entry, "proposal_id": proposal_id, "components": files.descriptors(components)}
            if report_path.exists():
                old, _, _ = files.load(self.store, report_path, maximum=MAX_CAPTURE_BYTES)
                if old != report_manifest:
                    raise limits.InputConflictError("proposal_request_conflict")
            else:
                names = source_files.entries(self.store, path / "result-links", maximum=MAX_EVENTS)
                total = len(canonical_json_bytes(report_manifest)) + sum(len(text.encode()) for text in components.values())
                for name in names:
                    _, prior_manifest, prior_parts = files.load(self.store, path / "result-links" / name, maximum=MAX_CAPTURE_BYTES)
                    total += len(prior_manifest.encode()) + sum(len(text.encode()) for text in prior_parts.values())
                if total > MAX_REPORT_TOTAL_BYTES:
                    raise limits.InputLimitError("Proposal diagnostic byte budget exceeded")
                authorize()
                files.publish(self.store, report_path, report_manifest, components, maximum=MAX_CAPTURE_BYTES)
            with self.store._write_lock():
                authorize()
                self.proposals._current(basis, locked=True)
                state.setdefault("result_links", []).append(entry)
                state["requests"][request_id] = digest
                self.proposals._event(state, "result_linked", request_id=request_id, mode=mode,
                    candidate_ref=state["candidate"], execution_id=execution_id)
                self.proposals._write(path, state)
            return self.proposals._view(proposal_id)


def report_links(proposals, state, basis_status):
    """예전 보고는 보존하면서 현재 후보·실행·근거와 일치하는지를 별도로 표시한다."""
    jobs, values = JobStore(proposals.store, rulesets=proposals.rulesets), []
    for item in state.get("result_links", []):
        candidate_current = item["candidate_ref"] == state["candidate"]
        execution_current = item["execution_id"] == state.get("active_execution_id")
        status = ("candidate_changed" if not candidate_current else "basis_changed" if basis_status != "current"
                  else "execution_superseded" if not execution_current else "current")
        run_current, cancelled = False, False
        try:
            job = records.owned_state(jobs, item["result_ref"]["job_id"], proposals.actor["tenant"], proposals.actor["user_id"])
            run_current = job["run_id"] == item["result_ref"]["run_id"]
            cancelled = job["state"] == "cancelled"
            if status == "current":
                status = "job_cancelled" if cancelled else "current" if run_current else "run_changed"
        except (OSError, ValueError):
            status = "job_unavailable"
        values.append({**item, "candidate_current": candidate_current, "basis_current": basis_status == "current",
            "execution_current": execution_current, "run_current": run_current, "job_cancelled": cancelled,
            "currentness": status})
    return values


def report_receipt(proposals, path, state, request_id):
    """불변 보고 공개와 상태 연결을 구분하며 read만으로 응답 유실을 확인한다."""
    manifest, text, parts = files.load(proposals.store, path / "result-links" / request_id, maximum=MAX_CAPTURE_BYTES)
    if manifest["proposal_id"] != state["proposal_id"] or manifest["request_id"] != request_id:
        raise limits.InputCorruptError("Proposal report identity differs")
    linked = state["requests"].get(request_id) == manifest["payload_hash"]
    return {**manifest, "operation": "result_link", "linked": linked,
        "report_revision": files.digest(text.encode()), "report": json.loads(parts["report.json"]),
        "state": "complete" if linked else "published_unlinked", "saved": False, "canonical_changed": False,
        "state_revision": canonical_json_hash(state), "retry_policy": "exact_request_reconciliation_only"}


def ensure_proposal_job_draft(store, job, actor, payload, *, rulesets=None):
    """ResultStore 경계: 추출안 계획의 일반 save=true 호출도 canonical을 바꾸지 못한다.

    호출자는 source coordination을 보유하고 Wiki 잠금을 잡기 전에 호출한다.
    일반 계획/job은 그대로 통과한다. 문서 이름만으로 작업을 추측하지 않는다.
    """
    plan_ref = job["events"][0]["details"].get("analysis_plan")
    if plan_ref is None:
        return
    plan, _, _ = PlanStore(store, actor, rulesets=rulesets)._load_locked("plans", plan_ref["plan_id"], plan_ref["plan_revision"])
    output = next(item for item in plan["plan"]["outputs"] if item["document"] == plan_ref["document"])
    if not output["purpose"].startswith(PREFIX):
        return
    if payload.get("save") is not False:
        raise limits.InputConflictError("proposal_explicit_apply_required")
    parts = output["purpose"].split(":")
    if len(parts) != 3:
        raise limits.InputConflictError("proposal_execution_invalid")
    service = ProposalExecutionStore(store, actor, rulesets=rulesets)
    path, _, basis, state = service._owned(parts[1])
    intent, _, _ = service._intent(path, parts[2])
    expected_request = stable_id("plan-job", intent["plan_id"], intent["execution_id"], basis["target_document"])
    if intent["plan_id"] != plan_ref["plan_id"] or job["request_id"] != expected_request:
        raise limits.InputConflictError("proposal_result_scope_mismatch")
    service._active(path, state, intent)
    service.proposals._current(basis)
