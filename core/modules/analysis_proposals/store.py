"""Wiki 원문에서 준비한 전체 추출안을 불변 보관하고 명시 요청에서만 적용한다.

원문/그래프/검토 기준은 기존 캡처 함수, 그래프 형식·인용은 기존 검증기,
실제 적용은 OntologyStore.generate를 재사용한다. 여기의 상태 파일은 초안과
요청 영수증이며 canonical 위키나 검토 원장을 대신하지 않는다.
"""

from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
from types import SimpleNamespace

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.access.policy import AccessDenied
from core.modules.analysis_inputs import capture, files, contracts as limits
from core.modules.analysis_results.validation import graph_submission
from core.modules.documents.store import RevisionConflictError, StorageBusyError
from core.modules.documents.history import list_versions, read_version
from core.modules.ontology.store import OntologyStore
from core.modules.ontology.snapshots import _stored_graph
from core.modules.ontology.validation import _graph
from core.modules.ontology.errors import OntologyValidationError, OntologyCorruptError
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _claim_id
from core.modules.sources import files as source_files
from core.runtime.extraction_schema import build_submission_schema

MAX_PROPOSALS = 200
MAX_EVENTS = 100
MAX_CAPTURE_BYTES = 8 * 1024 * 1024
MAX_CANDIDATES = 100
MAX_CANDIDATE_TOTAL_BYTES = 32 * 1024 * 1024


def now():
    """클라이언트 입력 대신 서버의 UTC 시각을 기록한다."""
    return datetime.now(timezone.utc).isoformat()


def claims(graph):
    """기존 검토와 같은 안정된 주장 ID를 계산하되 이전 승인을 복사하지 않는다."""
    return [{"claim_id": _claim_id(collection, value, graph["entities"]), "collection": collection,
             "value": deepcopy(value), "decision": "unreviewed"}
            for collection in ("relations", "attributes", "relation_candidates") for value in graph.get(collection, [])]


class ProposalStore:
    """현재 인증된 사용자 소유의 초안·입력·적용 영수증만 처리한다."""

    def __init__(self, store, actor, *, rulesets=None):
        self.store, self.actor, self.rulesets = store, actor, rulesets
        owner = sha256(actor["user_id"].encode()).hexdigest()
        self.root = store.data_dir / "_analysis_proposals" / owner

    def _path(self, proposal_id):
        """사용자 입력을 파일 경로로 직접 붙이지 않고 서버 형식 ID를 검사한다."""
        limits.identifier(proposal_id)
        return source_files.checked(self.store, self.root / proposal_id)

    def _load_input(self, proposal_id):
        """상태 연결이 아직 없어도 완성된 불변 입력의 소유자와 hash를 검사한다."""
        path = self._path(proposal_id)
        manifest, text, parts = files.load(self.store, path / "input", maximum=MAX_CAPTURE_BYTES)
        if (manifest.get("kind") != "native_wiki_analysis_input" or manifest.get("proposal_id") != proposal_id
                or manifest.get("tenant") != self.actor["tenant"] or manifest.get("user_id") != self.actor["user_id"]):
            raise FileNotFoundError()
        basis = json.loads(parts["basis.json"])
        if manifest["actor"] != basis["actor"]:
            raise limits.InputCorruptError("Proposal actor basis is inconsistent")
        return path, manifest, basis, files.digest(text.encode())

    def _load(self, proposal_id):
        """검사한 불변 입력에 연결된 가변 상태를 읽는다. 손상된 상태는 초기화하지 않는다."""
        path, manifest, basis, input_revision = self._load_input(proposal_id)
        state = source_files.read_json(self.store, path / "state.json")
        if (state.get("proposal_id") != proposal_id or state.get("input_revision") != input_revision
                or type(state.get("events")) is not list or type(state.get("requests")) is not dict
                or len(state["events"]) > MAX_EVENTS or len(state["requests"]) > MAX_EVENTS):
            raise limits.InputCorruptError("Proposal state is inconsistent")
        return path, manifest, basis, state

    def _finish_preparation(self, path, manifest, basis, input_revision, request_id, payload_hash,
                            submission, before_commit, *, replayed=False):
        """최초 상태만 연결한다. 이미 공개한 입력/후보는 덮거나 다시 만들지 않는다.

        입력 공개 뒤 프로세스가 중단되어 state.json이 없을 수 있다. 이때도 같은
        요청 지문, 실제 불변 후보, 현재 원문/권한을 모두 확인한 뒤에만 연결한다.
        """
        before_commit()
        self._current(basis)
        state = {"proposal_id": manifest["proposal_id"], "input_revision": input_revision, "candidate": None,
                 "events": [], "requests": {}, "decisions": [], "applications": {}}
        if submission is not None:
            state["candidate"] = self._candidate(path, basis, request_id, submission, [], state,
                payload_hash, "initial_submission")
            candidate_manifest, saved_submission, saved_graph = self._read_candidate(path, state["candidate"])
            # 같은 요청 ID라는 이유만으로 다른 내용/일부 파일을 초기 상태에 연결하지 않는다.
            if (candidate_manifest["source_revision"] != self._target(basis)["source"]["revision"]
                    or saved_submission != submission or saved_graph != self._normalize(basis, submission)):
                raise limits.InputCorruptError("The initial candidate does not match its fixed request")
        elif source_files.entries(self.store, path / "candidates", maximum=MAX_CANDIDATES):
            raise limits.InputCorruptError("An input-only preparation contains an unexpected candidate")
        state["requests"][request_id] = payload_hash
        self._event(state, "prepared", request_id=request_id, candidate_ref=state["candidate"])
        # 후보 읽기/공개 중 기준이 바뀌었어도 옛 상태를 연결하지 않도록 마지막에 재확인한다.
        with self.store._write_lock():
            before_commit()
            self._current(basis, locked=True)
            self._write(path, state)
        return self._view(manifest["proposal_id"], replayed=replayed)

    def _write(self, path, state):
        """기존 원자 JSON 교체를 사용하고 기록 한도 때문에 이전 이벤트를 자르지 않는다."""
        if len(state["events"]) > MAX_EVENTS or len(state["requests"]) > MAX_EVENTS:
            raise limits.InputLimitError("Proposal event or request limit reached")
        source_files.write_json(self.store, path / "state.json", state)

    def _event(self, state, kind, **values):
        """작업 상태를 지우지 않고 새 사건을 추가해 과거 판단의 기준을 보존한다."""
        state["events"].append({"kind": kind, "recorded_at": now(), "actor": self.actor, **values})

    def _capture(self, document, contexts):
        """한 Wiki 잠금 안에서 전체 원문·그래프·전문가 판단·각 판본을 함께 읽는다."""
        selected = capture.selection(self.store, contexts)
        selected = [item for item in selected if item["document"] != document]
        selected.insert(0, {"document": document, "required": True, "reason": "native_wiki_target"})
        if len(selected) > 8:
            raise ValueError("Target and context together exceed eight documents")
        with self.store._write_lock():
            values, dependencies, skipped = capture.documents_locked(self.store, selected, self.actor)
            raw = OntologyStore(self.store)._read_bytes(OntologyStore(self.store)._path(document))
        target = next(item for item in values if item["document"] == document)
        previous = {"status": "missing", "graph": None, "claims": [], "source": None,
                    "source_restoration": "not_applicable", "historical_events": []}
        if raw is not None:
            try:
                graph = _stored_graph(raw, document)[0]
                previous.update(status="captured", graph=graph, claims=claims(graph))
                previous["historical_events"] = [event for event in target["review"]["history"]
                    if event["source_revision"] == graph["source_revision"] and event["graph_revision"] == sha256(raw).hexdigest()]
                if graph["source_revision"] == target["source"]["revision"]:
                    previous.update(source=deepcopy(target["source"]), source_restoration="current_source")
                else:
                    previous.update(source_restoration="unavailable")
                    cursor = None
                    # 오래된 그래프를 현재 사실로 표시하지 않고, 실제 보관 본문만 과거 근거로 복원한다.
                    for _ in range(20):
                        page = list_versions(self.store, document, tenant=self.actor["tenant"],
                            scope_key=canonical_json_hash(self.actor), limit=50, cursor=cursor)
                        match = next((item for item in page["items"] if item["revision"] == graph["source_revision"]), None)
                        if match is not None:
                            previous.update(source={"document": document, **read_version(self.store, document, match["history_id"])},
                                            source_restoration="restored_history")
                            break
                        cursor = page["next_cursor"]
                        if cursor is None:
                            break
            except (OSError, OntologyCorruptError):
                previous.update(status="unavailable", source_restoration="unavailable")
        # 필수 원문을 캡처했더라도 현재 읽지 못한 그래프는 그 상태 그대로 보존한다.
        return {"actor": self.actor, "documents": values, "dependencies": dependencies,
                "skipped": skipped, "scope": "full_selected_sources", "target_document": document,
                "previous": previous}

    def _rules(self):
        """게시 규약이 있으면 정확한 내용을 고정하고, 없으면 현재 서버 검증 스키마를 고정한다."""
        if self.rulesets is None:
            return {"origin": "current_server_schema", "schema_revision": canonical_json_hash(build_submission_schema())}
        release = self.rulesets.read(self.actor["tenant"])
        return {"origin": "published_ruleset", **{key: release[key] for key in ("ruleset_id", "ruleset_version", "ruleset_revision")}}

    def _current(self, basis, *, locked=False):
        """입력 당시 모든 원문/판단/관점을 다시 대조한다. revision 숫자만 교체하지 않는다."""
        if basis["actor"] != self.actor:
            raise AccessDenied()
        selected = [{"document": item["document"], "required": True, "reason": "proposal_input"}
                    for item in basis["dependencies"]]
        if locked:
            _, current, _ = capture.documents_locked(self.store, selected, self.actor)
        else:
            with self.store._write_lock():
                _, current, _ = capture.documents_locked(self.store, selected, self.actor)
        # 캡처의 reason은 입력 안내이며 비교에는 실제 자원 판본만 사용한다.
        if current != basis["dependencies"]:
            raise limits.InputConflictError("proposal_basis_changed")
        if self._rules() != basis["ruleset_ref"]:
            raise limits.InputConflictError("proposal_ruleset_changed")

    def _target(self, basis):
        """대상 Wiki의 원문과 현재 검토값을 고정 입력에서 가져온다."""
        return next(item for item in basis["documents"] if item["document"] == basis["target_document"])

    def _normalize(self, basis, submission):
        """공통 제출 형식과 기존 전체 그래프·실제 인용 검사를 저장 없이 실행한다."""
        graph_submission(SimpleNamespace(expected_schema=build_submission_schema()), submission)
        target = self._target(basis)
        source = target["source"]
        return _graph(source["document"], source["revision"], submission["entities"], submission["relations"],
            source["content"], submission["relation_candidates"], attributes=submission["attributes"],
            schema_version=submission["schema_version"])

    def _candidate(self, path, basis, request_id, submission, resolves, state, request_hash, operation, resolution_bindings=None, *, execution_ref=None):
        """새 전체 초안을 불변 묶음으로 공개한다. 이 단계는 canonical 그래프를 바꾸지 않는다."""
        normalized = self._normalize(basis, submission)
        components = {"submission.json": canonical_json_bytes(submission).decode(),
                      "normalized.json": canonical_json_bytes(normalized).decode()}
        candidate_id = request_id
        manifest = {"kind": "whole_graph_proposal", "candidate_id": candidate_id,
            "source_revision": self._target(basis)["source"]["revision"], "document": basis["target_document"],
            "origin": "client_reported", "human_approval": False, "resolves_decision_ids": resolves,
            "resolution_bindings": resolution_bindings or [],
            "request_id": request_id, "payload_hash": request_hash, "operation": operation,
            "components": files.descriptors(components)}
        if execution_ref is not None:
            manifest["execution_ref"] = deepcopy(execution_ref)
        linked = {value["candidate_id"] for value in [state["candidate"],
            *(event.get("candidate_ref") for event in state["events"]),
            *(item.get("candidate_ref") for item in state["decisions"])] if value is not None}
        names = source_files.entries(self.store, path / "candidates", maximum=MAX_CANDIDATES)
        used = 0
        existing = None
        for name in names:
            limits.identifier(name)
            prior, text, parts = files.load(self.store, path / "candidates" / name, maximum=MAX_CAPTURE_BYTES)
            used += len(text.encode()) + sum(len(value.encode()) for value in parts.values())
            if name == request_id:
                if prior["payload_hash"] != request_hash or prior["operation"] != operation:
                    raise limits.InputConflictError("proposal_request_conflict")
                existing = {"candidate_id": name, "candidate_revision": files.digest(text.encode())}
            elif name not in linked:
                # 연결 실패 파일도 삭제/무시하지 않는다. 먼저 정확한 요청을 조회·대조해야 한다.
                raise limits.InputConflictError("proposal_candidate_unlinked", request_id=name)
        if existing is not None:
            return existing
        needed = len(canonical_json_bytes(manifest)) + sum(len(value.encode()) for value in components.values())
        if len(names) >= MAX_CANDIDATES or used + needed > MAX_CANDIDATE_TOTAL_BYTES:
            raise limits.InputLimitError("All linked and unlinked candidate bytes exceed their proposal budget")
        revision = files.publish(self.store, path / "candidates" / candidate_id, manifest, components, maximum=MAX_CAPTURE_BYTES)
        return {"candidate_id": candidate_id, "candidate_revision": revision}

    def _read_candidate(self, path, reference):
        """명시한 초안 판본에서 전체 제출값과 정상화한 미검토 주장을 읽는다."""
        limits.identifier(reference["candidate_id"])
        limits.revision(reference["candidate_revision"])
        manifest, _, parts = files.load(self.store, path / "candidates" / reference["candidate_id"],
            expected_revision=reference["candidate_revision"], maximum=MAX_CAPTURE_BYTES)
        return manifest, json.loads(parts["submission.json"]), json.loads(parts["normalized.json"])

    def _recovery_bindings(self, path, state, graph):
        """명시 복구한 전체 주장이 최종 후보에도 실제 그대로 남았는지 연결한다.

        두 번째 복구는 새 전체 후보를 만든다. 첫 복구의 candidate_ref를 그 숫자로
        바꾸면 당시 판단 근거를 잃는다. 대신 당시 불변 후보와 최종 후보의 실제
        주장/인용/한정어를 대조하고, 검토 승인을 포함하지 않은 연결만 만든다.
        """
        latest = {item["old_claim_id"]: item for item in state["decisions"]}
        final_claims = {item["claim_id"]: item for item in claims(graph)}
        bindings = []
        for decision in latest.values():
            if decision["action"] != "keep":
                continue
            _, _, original_graph = self._read_candidate(path, decision["candidate_ref"])
            original = next((item for item in claims(original_graph)
                if item["claim_id"] == decision["new_claim_id"]), None)
            final = final_claims.get(decision["new_claim_id"])
            if (original is None or final != original or original_graph["document"] != graph["document"]
                    or original_graph["source_revision"] != graph["source_revision"]):
                raise ValueError("A kept claim changed or disappeared; an explicit new decision is required")
            # claim_id에는 끝점 개체의 의미가 들어 있다. 전체 정규화 값도 비교해
            # 같은 ID만 붙이거나 인용/조건을 바꾼 결과를 복구로 인정하지 않는다.
            bindings.append({"decision_id": decision["decision_id"], "old_claim_id": decision["old_claim_id"],
                "new_claim_id": decision["new_claim_id"], "source_revision": graph["source_revision"],
                "decision_candidate_ref": deepcopy(decision["candidate_ref"]),
                "final_candidate_ref": deepcopy(state["candidate"]),
                "claim_revision": canonical_json_hash(original), "review_approval_copied": False})
        return bindings

    def prepare(self, request_id, document, expected_source_revision, expected_state_revision, contexts,
                *, submission=None, before_commit):
        """현재 Wiki에서 분석 입력을 준비한다. 별도 source 등록 없이 원문 그대로 사용한다."""
        limits.identifier(request_id)
        payload = {"document": document, "expected_source_revision": expected_source_revision,
            "expected_state_revision": expected_state_revision, "contexts": contexts, "submission": submission}
        proposal_id = sha256((self.actor["tenant"] + ":" + self.actor["user_id"] + ":" + request_id).encode()).hexdigest()[:32]
        path = self._path(proposal_id)
        with source_files.coordination(self.store, create=True):
            if path.exists():
                path, manifest, basis, input_revision = self._load_input(proposal_id)
                if manifest["payload_hash"] != canonical_json_hash(payload):
                    raise limits.InputConflictError("proposal_request_conflict")
                try:
                    source_files.read_json(self.store, path / "state.json")
                except FileNotFoundError:
                    # 완성 입력은 보존하고 누락된 최초 상태만 정확한 원래 요청으로 연결한다.
                    return self._finish_preparation(path, manifest, basis, input_revision, request_id,
                        canonical_json_hash(payload), submission, before_commit, replayed=True)
                return self._view(proposal_id, replayed=True)
            if len(source_files.entries(self.store, self.root, maximum=MAX_PROPOSALS)) >= MAX_PROPOSALS:
                raise limits.InputLimitError("Proposal count limit reached")
            basis = self._capture(document, contexts)
            target = self._target(basis)
            if target["source"]["revision"] != expected_source_revision or target["review"]["state_revision"] != expected_state_revision:
                raise limits.InputConflictError("proposal_basis_changed")
            basis["ruleset_ref"] = self._rules()
            # 원본에 없는 주장을 허용하지 않도록 제출값이 있으면 공개 전에 검사한다.
            if submission is not None:
                self._normalize(basis, submission)
            components = {"basis.json": canonical_json_bytes(basis).decode(),
                          "submission-schema.json": canonical_json_bytes(build_submission_schema()).decode()}
            if self.rulesets is not None:
                release = self.rulesets.read(self.actor["tenant"])
                if {key: release[key] for key in ("ruleset_id", "ruleset_version", "ruleset_revision")} != {
                        key: basis["ruleset_ref"][key] for key in ("ruleset_id", "ruleset_version", "ruleset_revision")}:
                    raise limits.InputConflictError("proposal_ruleset_changed")
                for name, value in release["components"].items():
                    components["rules/" + name] = value["content"]
            manifest = {"kind": "native_wiki_analysis_input", "proposal_id": proposal_id,
                "tenant": self.actor["tenant"], "user_id": self.actor["user_id"], "actor": self.actor,
                "created_at": now(), "request_id": request_id, "payload_hash": canonical_json_hash(payload),
                "components": files.descriptors(components)}
            before_commit()
            self._current(basis)
            input_revision = files.publish(self.store, path / "input", manifest, components, maximum=MAX_CAPTURE_BYTES)
            return self._finish_preparation(path, manifest, basis, input_revision, request_id,
                canonical_json_hash(payload), submission, before_commit)

    def _view(self, proposal_id, *, replayed=False):
        """당시 입력과 초안·적용/검토 상태를 구분해 반환한다."""
        path, manifest, basis, state = self._load(proposal_id)
        _, _, frozen_parts = files.load(self.store, path / "input", expected_revision=state["input_revision"], maximum=MAX_CAPTURE_BYTES)
        graph, candidate_manifest, submission = None, None, None
        if state["candidate"] is not None:
            candidate_manifest, submission, graph = self._read_candidate(path, state["candidate"])
        preview = [] if graph is None else claims(graph)
        previous = basis["previous"]["claims"]
        present = {item["claim_id"] for item in preview}
        missing = [item for item in previous if item["claim_id"] not in present]
        try:
            self._current(basis)
            basis_status = "current"
        except (ValueError, OSError, AccessDenied, limits.InputConflictError):
            basis_status = "changed_or_unavailable"
        from .executions import report_receipt, report_links
        links = report_links(self, state, basis_status)
        current_reports = [report_receipt(self, path, state, item["request_id"]) for item in links
                           if item["currentness"] == "current"]
        return {"proposal_id": proposal_id, "input_revision": state["input_revision"],
            "state_revision": canonical_json_hash(state), "basis": basis, "basis_status": basis_status,
            "submission_schema": json.loads(frozen_parts["submission-schema.json"]),
            "rules_components": {name[6:]: value for name, value in frozen_parts.items() if name.startswith("rules/")},
            "candidate_ref": state["candidate"], "submission": submission, "preview_claims": preview,
            "missing_claims": missing, "missing_observation": "not_in_current_proposal_only",
            "previous_restoration": basis["previous"]["source_restoration"],
            "decisions": state["decisions"], "events": state["events"], "applications": state["applications"],
            "executions": list(state.get("executions", {}).values()),
            "active_execution_id": state.get("active_execution_id"),
            "result_links": links, "current_reports": current_reports,
            "origin": "client_reported", "canonical_changed_by_read": False, "human_approval": False,
            "semantic_validation": "not_run", "replayed": replayed,
            "required_action": "submit_whole_graph" if graph is None else
                "review_current_generation" if any(item["saved"] is True for item in state["applications"].values()) else "explicit_apply"}

    def read(self, proposal_id):
        """조회는 준비·모델 실행·그래프 적용을 자동 시작하지 않는다."""
        with source_files.coordination(self.store):
            return self._view(proposal_id)

    def _basis_and_state(self, proposal_id, expected_state_revision):
        """수정 시점의 초안 상태와 원문 기준을 함께 검사한다."""
        path, manifest, basis, state = self._load(proposal_id)
        if canonical_json_hash(state) != expected_state_revision:
            raise limits.InputConflictError("proposal_state_changed")
        self._current(basis)
        return path, manifest, basis, state

    def submit(self, proposal_id, request_id, expected_state_revision, submission, resolves_decision_ids,
               *, resolution_bindings=None, before_commit):
        """새 전체 결과를 불변 초안으로 추가한다. 일부 행만 원본 그래프에 덮지 않는다."""
        limits.identifier(request_id)
        payload = {"submission": submission, "resolves_decision_ids": resolves_decision_ids,
                   "expected_state_revision": expected_state_revision}
        if resolution_bindings:
            payload["resolution_bindings"] = resolution_bindings
        payload_hash = canonical_json_hash(payload)
        with source_files.coordination(self.store, create=True):
            path, _, basis, state = self._load(proposal_id)
            if request_id in state["applications"]:
                raise limits.InputConflictError("proposal_request_conflict")
            if request_id in state["requests"]:
                if state["requests"][request_id] != payload_hash:
                    raise limits.InputConflictError("proposal_request_conflict")
                return self._view(proposal_id, replayed=True)
            path, _, basis, state = self._basis_and_state(proposal_id, expected_state_revision)
            decisions = {item["decision_id"]: item for item in state["decisions"]}
            bindings = {item["decision_id"]: item for item in (resolution_bindings or [])}
            if len(bindings) != len(resolution_bindings or []):
                raise ValueError("Resolution decisions must be unique")
            resolution_ids = set(resolves_decision_ids) | set(bindings)
            if any(identifier not in decisions or decisions[identifier]["action"] != "reextract" for identifier in resolution_ids):
                raise ValueError("Only existing re-extraction decisions can be resolved")
            candidate_claims = {item["claim_id"] for item in claims(self._normalize(basis, submission))}
            for identifier in resolves_decision_ids:
                if identifier not in bindings:
                    bindings[identifier] = {"decision_id": identifier, "new_claim_id": decisions[identifier]["old_claim_id"],
                        "reason": "explicit_same_id_resolution"}
            if any(item["new_claim_id"] not in candidate_claims for item in bindings.values()):
                raise ValueError("Bind each resolution to a real claim in this full candidate")
            before_commit()
            state["candidate"] = self._candidate(path, basis, request_id, submission, sorted(resolution_ids),
                state, payload_hash, "whole_graph_submission", list(bindings.values()))
            state["requests"][request_id] = payload_hash
            self._event(state, "whole_graph_submitted", request_id=request_id, candidate_ref=state["candidate"])
            self._write(path, state)
            return self._view(proposal_id)

    def validate(self, proposal_id):
        """현재 원문/상태와 전체 초안 형식·실제 인용을 검사한다. 의미 승인은 하지 않는다."""
        with source_files.coordination(self.store):
            path, _, basis, state = self._load(proposal_id)
            self._current(basis)
            if state["candidate"] is None:
                raise ValueError("Submit a whole graph before validating")
            _, submission, _ = self._read_candidate(path, state["candidate"])
            self._normalize(basis, submission)
            return {"proposal_id": proposal_id, "state_revision": canonical_json_hash(state),
                "candidate_ref": state["candidate"], "automatic": "passed", "semantic": "not_run", "human_approval": False}

    def apply(self, proposal_id, request_id, expected_state_revision, candidate_revision, *, before_commit):
        """명시 요청에서만 기존 그래프 저장기를 호출하고 정확한 요청 영수증을 남긴다."""
        limits.identifier(request_id)
        payload_hash = canonical_json_hash({"expected_state_revision": expected_state_revision,
                                          "candidate_revision": candidate_revision})
        with source_files.coordination(self.store, create=True):
            path, _, basis, state = self._load(proposal_id)
            if request_id in state["requests"]:
                raise limits.InputConflictError("proposal_request_conflict")
            if request_id in state["applications"]:
                if state["applications"][request_id]["payload_hash"] != payload_hash:
                    raise limits.InputConflictError("proposal_request_conflict")
                return self._receipt(path, state, request_id, replayed=True)
            path, _, basis, state = self._basis_and_state(proposal_id, expected_state_revision)
            if state["candidate"] is None or state["candidate"]["candidate_revision"] != candidate_revision:
                raise limits.InputConflictError("proposal_candidate_changed")
            _, submission, _ = self._read_candidate(path, state["candidate"])
            target = self._target(basis)
            entry = {"request_id": request_id, "payload_hash": payload_hash, "state": "pending_reconcile",
                "saved": None, "receipt": None, "candidate_ref": state["candidate"], "started_at": now()}
            state["applications"][request_id] = entry
            self._event(state, "apply_started", request_id=request_id, candidate_ref=state["candidate"])
            self._write(path, state)
            def final_guard():
                # generate가 Wiki 잠금을 보유하므로 재진입 없이 기존 캡처 함수를 호출한다.
                before_commit()
                self._current(basis, locked=True)
            try:
                result = OntologyStore(self.store).generate(basis["target_document"], target["source"]["revision"],
                    **submission, expected_state_revision=target["review"]["state_revision"], before_commit=final_guard,
                    force_generation=True)
            except (RevisionConflictError, OntologyValidationError, AccessDenied, StorageBusyError, limits.InputConflictError):
                entry.update(state="rejected", saved=False)
                self._write(path, state)
                raise
            except (OSError, ValueError):
                # 저장 여부가 불명확하면 같은 요청을 재실행하지 않고 영수증 조회만 허용한다.
                return self._receipt(path, state, request_id)
            receipt = {"proposal_id": proposal_id, "document": basis["target_document"],
                "source_revision": result["source_revision"], "graph_revision": result["graph_revision"],
                "base_state_revision": target["review"]["state_revision"], "candidate_ref": state["candidate"],
                "state_revision": None, "state_revision_basis": "query_current_output_separately",
                "input_revision": state["input_revision"], "changed": result["changed"],
                "review_status": "unreviewed", "actor": self.actor, "recorded_at": now(),
                "cleanup_failures": result["cleanup_failures"], "human_approval": False}
            entry.update(saved=True, receipt=receipt)
            try:
                # 실제 저장 함수가 반환한 증거를 상태 갱신보다 먼저 별도 파일로 남긴다.
                source_files.write_json(self.store, path / "receipts" / f"{request_id}.json", entry)
                entry["state"] = "complete"
                self._event(state, "applied", request_id=request_id, graph_revision=result["graph_revision"])
                self._write(path, state)
            except (OSError, ValueError):
                entry["state"] = "pending_reconcile"
            return self._receipt(path, state, request_id)

    def _receipt(self, path, state, request_id, *, replayed=False):
        """내용 hash 추측 대신 기록된 요청과 저장 반환값의 영수증을 사용한다."""
        entry = state["applications"].get(request_id)
        if entry is None:
            raise FileNotFoundError()
        try:
            saved = source_files.read_json(self.store, path / "receipts" / f"{request_id}.json")
        except FileNotFoundError:
            saved = None
        if saved is not None:
            if saved["payload_hash"] != entry["payload_hash"] or saved["request_id"] != request_id or saved["saved"] is not True:
                raise limits.InputCorruptError("Proposal receipt is inconsistent")
            entry = {**entry, "saved": True, "receipt": saved["receipt"]}
        current = None
        if entry["saved"] is True:
            try:
                value = ReviewStore(self.store).query(entry["receipt"]["document"], domain=self.actor["domain"], viewpoint=self.actor["viewpoint"])
                current = {key: value[key] for key in ("source_revision", "graph_revision", "state_revision")}
                current["status"] = "current" if (value["source_revision"] == entry["receipt"]["source_revision"] and value["graph_revision"] == entry["receipt"]["graph_revision"]) else "changed"
            except (OSError, ValueError):
                current = {"status": "unavailable"}
        return {**entry, "proposal_id": state["proposal_id"], "state_revision": canonical_json_hash(state),
                "current_output": current, "replayed": replayed, "retry_policy": "read_receipt_only_if_uncertain"}

    def receipt(self, proposal_id, request_id):
        """쓰기 권한이나 현재 입력 일치와 독립적으로 자기 저장 영수증을 읽는다."""
        limits.identifier(request_id)
        with source_files.coordination(self.store):
            path, _, _, state = self._load(proposal_id)
            if (path / "result-links" / request_id).exists():
                from .executions import report_receipt
                return report_receipt(self, path, state, request_id)
            if request_id not in state["applications"]:
                manifest, text, _ = files.load(self.store, path / "candidates" / request_id, maximum=MAX_CAPTURE_BYTES)
                reference = {"candidate_id": request_id, "candidate_revision": files.digest(text.encode())}
                linked = state["requests"].get(request_id) == manifest["payload_hash"]
                execution = manifest.get("execution_ref")
                return {**({"execution_id": execution["execution_id"], "result_ref": execution,
                            "mode": "candidate", "linked": linked, "report": None} if execution else {}),
                    "proposal_id": proposal_id, "request_id": request_id, "payload_hash": manifest["payload_hash"],
                    "operation": "result_link" if execution else manifest["operation"], "candidate_ref": reference,
                    "state": "complete" if linked else "published_unlinked", "saved": False,
                    "canonical_changed": False, "state_revision": canonical_json_hash(state),
                    "retry_policy": "exact_request_reconciliation_only"}
            return self._receipt(path, state, request_id)

    def decide(self, proposal_id, request_id, expected_state_revision, candidate_revision, old_claim_id,
               action, reason, checked_whole, evidence, replacement, *, before_commit):
        """미발견 관찰에 판본별 제외·복구 초안·재추출 요청을 별도 판단으로 추가한다."""
        limits.identifier(request_id)
        payload = {"expected_state_revision": expected_state_revision, "candidate_revision": candidate_revision,
            "old_claim_id": old_claim_id, "action": action, "reason": reason, "checked_whole": checked_whole,
            "evidence": evidence, "replacement": replacement}
        fingerprint = canonical_json_hash(payload)
        with source_files.coordination(self.store, create=True):
            path, _, basis, state = self._load(proposal_id)
            if request_id in state["applications"]:
                raise limits.InputConflictError("proposal_request_conflict")
            if request_id in state["requests"]:
                if state["requests"][request_id] != fingerprint:
                    raise limits.InputConflictError("proposal_request_conflict")
                return self._view(proposal_id, replayed=True)
            path, _, basis, state = self._basis_and_state(proposal_id, expected_state_revision)
            if state["candidate"] is None or state["candidate"]["candidate_revision"] != candidate_revision:
                raise limits.InputConflictError("proposal_candidate_changed")
            _, submission, normalized = self._read_candidate(path, state["candidate"])
            old = next((claim for claim in basis["previous"]["claims"] if claim["claim_id"] == old_claim_id), None)
            if old is None or old_claim_id in {item["claim_id"] for item in claims(normalized)}:
                raise ValueError("Select an actually missing prior claim")
            text = self._target(basis)["source"]["content"]
            if evidence and evidence not in text:
                raise ValueError("Evidence must be a literal quote from the fixed current source")
            if action == "exclude" and (not checked_whole or replacement is not None):
                raise ValueError("Exclusion requires whole-source confirmation and no fabricated replacement")
            decision = {"decision_id": request_id, "old_claim_id": old_claim_id, "old_claim": old,
                "action": action, "reason": reason, "evidence": evidence, "checked_whole": checked_whole,
                "source_revision": self._target(basis)["source"]["revision"], "actor": self.actor, "recorded_at": now(),
                "candidate_ref": deepcopy(state["candidate"]), "new_claim_id": None, "scope": "this_proposal_only"}
            before_commit()
            if action == "keep":
                if replacement is None or not evidence or replacement.get("evidence") != evidence:
                    raise ValueError("A recovery draft needs full replacement and exact current evidence")
                whole = deepcopy(submission)
                whole[old["collection"]].append(replacement)
                graph = self._normalize(basis, whole)
                recovered = [item for item in claims(graph) if item["claim_id"] not in {c["claim_id"] for c in claims(normalized)}]
                if len(recovered) != 1:
                    raise ValueError("Recovery must identify one new full claim")
                state["candidate"] = self._candidate(path, basis, request_id, whole, [], state, fingerprint, "recovery_draft")
                decision.update(candidate_ref=deepcopy(state["candidate"]), new_claim_id=recovered[0]["claim_id"],
                                recovery_status="draft_only_requires_whole_apply_then_new_review")
            elif action not in {"exclude", "reextract"} or replacement is not None:
                raise ValueError("Select exclude, keep, or reextract")
            state["decisions"].append(decision)
            state["requests"][request_id] = fingerprint
            self._event(state, "missing_decision", decision_id=request_id, action=action)
            self._write(path, state)
            return self._view(proposal_id)

    def complete(self, proposal_id, request_id, expected_state_revision, expected_review_state_revision,
                 reviewed_claim_ids, reason, *, before_commit):
        """실제 적용된 새 주장과 제외 판단을 대조해 명시된 비교 범위만 완료한다."""
        limits.identifier(request_id)
        payload = {"expected_state_revision": expected_state_revision,
            "expected_review_state_revision": expected_review_state_revision,
            "reviewed_claim_ids": reviewed_claim_ids, "reason": reason}
        fingerprint = canonical_json_hash(payload)
        with source_files.coordination(self.store, create=True):
            path, _, basis, state = self._load(proposal_id)
            if basis["actor"] != self.actor:
                raise AccessDenied()
            if request_id in state["applications"]:
                raise limits.InputConflictError("proposal_request_conflict")
            if request_id in state["requests"]:
                if state["requests"][request_id] != fingerprint:
                    raise limits.InputConflictError("proposal_request_conflict")
                return self._view(proposal_id, replayed=True)
            if canonical_json_hash(state) != expected_state_revision or state["candidate"] is None:
                raise limits.InputConflictError("proposal_state_changed")
            applied = [self._receipt(path, state, key) for key in state["applications"]]
            applied = [item for item in applied if item["saved"] is True and item["candidate_ref"] == state["candidate"]]
            if not applied:
                raise ValueError("Apply and confirm this complete candidate before completing review")
            current = ReviewStore(self.store).query(basis["target_document"], domain=self.actor["domain"], viewpoint=self.actor["viewpoint"])
            receipt = applied[-1]["receipt"]
            if (current["state_revision"] != expected_review_state_revision or current["source_revision"] != receipt["source_revision"]
                    or current["graph_revision"] != receipt["graph_revision"]):
                raise limits.InputConflictError("proposal_applied_basis_changed")
            candidate_manifest, _, graph = self._read_candidate(path, state["candidate"])
            rows = {item["claim_id"]: item for item in current["claims"]}
            proposed = {item["claim_id"] for item in claims(graph)}
            if basis["previous"]["status"] == "unavailable" or basis["previous"]["source_restoration"] == "unavailable":
                raise ValueError("The prior graph could not be restored; comparison completeness is unknown")
            previous = {item["claim_id"] for item in basis["previous"]["claims"]}
            needed = set(reviewed_claim_ids)
            decisions = {item["old_claim_id"]: item for item in state["decisions"]}
            resolutions = {item["decision_id"]: item["new_claim_id"] for item in candidate_manifest.get("resolution_bindings", [])}
            recoveries = self._recovery_bindings(path, state, graph)
            recovered = {item["decision_id"]: item for item in recoveries}
            for old_id in previous - proposed:
                decision = decisions.get(old_id)
                if decision is not None and decision["action"] == "reextract" and decision["decision_id"] in resolutions:
                    needed.add(resolutions[decision["decision_id"]])
                    continue
                if decision is not None and decision["action"] == "keep" and decision["decision_id"] in recovered:
                    needed.add(recovered[decision["decision_id"]]["new_claim_id"])
                    continue
                if decision is None or decision["candidate_ref"] != state["candidate"] or decision["action"] == "reextract":
                    raise ValueError("Missing claims need explicit decisions for this exact proposal")
            # 기존 인용을 그대로 복구하면 old_id가 다시 나타난다. 위의 '미발견'
            # 반복에서 빠지더라도 모든 복구 주장은 새 세대의 실제 검토가 필요하다.
            needed.update(item["new_claim_id"] for item in recoveries)
            for decision in state["decisions"]:
                if decision["decision_id"] in candidate_manifest["resolves_decision_ids"]:
                    resolved_id = resolutions.get(decision["decision_id"], decision["old_claim_id"])
                    if resolved_id not in proposed:
                        raise ValueError("Re-extraction is still missing the explicitly linked claim")
                    needed.add(resolved_id)
            if any(identifier not in rows or rows[identifier]["decision"] not in {"accept", "edit"} for identifier in needed):
                raise ValueError("Recovered and selected claims require an actual new-generation review")
            before_commit()
            # 다른 주장·문서의 전체 승인으로 확대하지 않는 별도 비교 완료 기록이다.
            self._event(state, "comparison_completed", request_id=request_id, reason=reason,
                reviewed_claim_ids=sorted(needed), review_state_revision=current["state_revision"],
                recovery_bindings=recoveries,
                coverage="explicit_missing_and_selected_claims_only", other_claims_approved=False)
            state["requests"][request_id] = fingerprint
            self._write(path, state)
            return self._view(proposal_id)
