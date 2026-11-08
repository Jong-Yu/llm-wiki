"""작업의 공통 기준을 입력 이벤트에 고정하고 단계·재실행 사이에 승계한다.

기존 job 파일 형식과 불변 bundle은 그대로 둔다. 최초 준비와 명시 rebase만
새 기준을 이벤트에 추가하고, 각 bundle은 그 기준의 지문을 참조한다.
"""

from uuid import uuid4
from hashlib import sha256

from core.common.json_codec import canonical_json_hash
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.contracts import MAX_HISTORY_ENTRIES
from core.modules.sources import files as source_files
from . import capture, contracts as limits


def active(job):
    """run이 바뀌어도 마지막으로 확정한 작업 기준을 반환한다. 읽기 중 복구하지 않는다."""
    current = None
    for event in job["events"]:
        details = event["details"]
        if details.get("operation") != "input_prepared":
            continue
        value = details.get("analysis_basis")
        revision = details.get("analysis_basis_revision")
        if value is not None:
            try:
                if (type(value) is not dict or set(value) != {"version", "basis_id", "ruleset_ref", "profile",
                        "source_ref", "context_documents", "context_dependencies", "target_dependencies"}
                        or type(value["version"]) is not int or value["version"] != 1
                        or value["source_ref"] != job["source_ref"]
                        or type(value["context_documents"]) is not list
                        or type(value["context_dependencies"]) is not list
                        or type(value["target_dependencies"]) is not list
                        or type(value["profile"]) is not dict
                        or set(value["profile"]) != {"profile_id", "domain", "viewpoint"}
                        or type(value["ruleset_ref"]) is not dict
                        or set(value["ruleset_ref"]) != {"ruleset_id", "ruleset_version", "ruleset_revision"}
                        or canonical_json_hash(value) != revision):
                    raise ValueError()
                limits.identifier(value["basis_id"])
                limits.revision(revision)
                limits.revision(value["ruleset_ref"]["ruleset_revision"])
            except (TypeError, ValueError, KeyError) as error:
                raise limits.InputCorruptError("The job analysis basis is inconsistent.") from error
            current = {**value, "revision": revision}
        elif revision is not None and (current is None or current["revision"] != revision):
            raise limits.InputCorruptError("The input event references an unknown analysis basis.")
    return current


def selection(job, previous, requested, *, rebase, rebase_reason, stage):
    """생략은 기준 승계이며 명시 빈 목록은 선택 변경이다. 조용한 변경은 허용하지 않는다."""
    if (type(rebase) is not bool or type(rebase_reason) is not str or len(rebase_reason) > 1000
            or (rebase and (stage != "read_source" or not rebase_reason.strip()))
            or (not rebase and rebase_reason)):
        raise limits.InputValidationError("Rebase requires read_source, a bounded reason and the current job revision.")
    legacy = any(event["details"].get("operation") == "input_prepared" for event in job["events"])
    if previous is None and legacy and not rebase:
        raise limits.InputConflictError("analysis_basis_required")
    if requested is None:
        return [] if previous is None else previous["context_documents"]
    if previous is not None and not rebase and requested != previous["context_documents"]:
        raise limits.InputConflictError("analysis_basis_changed")
    return requested


def rules(rulesets, tenant, previous, ruleset_id, ruleset_version, *, rebase):
    """진행 중 작업은 새 기본값 대신 고정 규약을 읽고 현재 허용/철회를 재검사한다."""
    if previous is not None and not rebase:
        expected = previous["ruleset_ref"]
        if ruleset_id is not None or ruleset_version is not None:
            if (ruleset_id, ruleset_version) != (expected["ruleset_id"], expected["ruleset_version"]):
                raise limits.InputConflictError("analysis_basis_changed")
        release = rulesets.validate_reference(tenant, expected)
        return release
    return rulesets.read(tenant, ruleset_id=ruleset_id, ruleset_version=ruleset_version)


def context_dependencies(selected, dependencies):
    """출력 대상과 겹쳐도 명시한 참고 문서의 기준을 제외하지 않는다."""
    names = {item["document"] for item in selected}
    return [item for item in dependencies if item["document"] in names]


def targets_locked(service, job):
    """본문 입력 범위를 늘리지 않고 최대8개 출력 대상의 상태 지문만 포착한다."""
    reviews = ReviewStore(service.store)
    values = []
    for target in job["targets"]:
        document = target["document"]
        try:
            _, _, _, tokens = reviews._snapshot_locked(document)
            value = {"status": "captured", **tokens}
        except FileNotFoundError:
            # 새 문서라도 남아 있는 그래프/원장/전체 이력은 무시하거나 삭제하지 않는다.
            graph = reviews.ontology._read_bytes(reviews.ontology._path(document))
            ledger = reviews._read_bytes(document)
            reviews._ledger(ledger, document)
            value = {"document": document, "status": "not_found", "source_revision": None,
                     "state_revision": None, "history_revision": reviews._history_revision(document),
                     "graph_revision": None if graph is None else sha256(graph).hexdigest(),
                     "review_revision": None if ledger is None else sha256(ledger).hexdigest()}
        values.append(value)
    return values


def expected_after_saves(service, job, fixed):
    """같은 작업/기준의 확인된 저장 연쇄를 재개 run에도 승계한다."""
    from core.modules.analysis_results import repository
    expected = {item["document"]: dict(item) for item in fixed["target_dependencies"]}
    history_entries = {document: [] for document in expected}
    for event in job["events"]:
        details = event["details"]
        if details.get("operation") != "result_saved":
            continue
        record, payload = repository.load(service, job, details["request_id"])
        receipt = record.get("receipt")
        if (record["state"] != "complete" or record["saved"] is not True or not receipt
                or payload["run_id"] != details.get("run_id")
                or receipt.get("analysis_basis_revision") != fixed["revision"]):
            continue
        document = payload["document"]
        previous = expected.get(document)
        if (previous is None or receipt.get("base_state_revision") != previous["state_revision"]
                or receipt.get("state_revision") is None or receipt.get("history_revision") is None):
            raise limits.InputConflictError("analysis_basis_changed")
        next_value = {**previous, "status": "captured", "source_revision": receipt["source_revision"]}
        if payload["stage"] == "prepare_wiki":
            entry = receipt.get("history_entry")
            audit_added = receipt.get("authorship_entry_created", False)
            if audit_added:
                history_entries[document].append("changes.json")
            needs_history = previous["source_revision"] is not None and receipt["changed"]
            if needs_history:
                if type(entry) is not str or not entry or "/" in entry or "\\" in entry:
                    raise limits.InputConflictError("analysis_basis_changed")
                history_entries[document].append(entry)
            elif entry is not None or (not audit_added and receipt["history_revision"] != previous["history_revision"]):
                raise limits.InputConflictError("analysis_basis_changed")
            next_value["history_revision"] = receipt["history_revision"]
        elif payload["stage"] == "extract_ontology":
            if (receipt["source_revision"] != previous["source_revision"]
                    or receipt["history_revision"] != previous["history_revision"]):
                raise limits.InputConflictError("analysis_basis_changed")
            next_value["graph_revision"] = receipt["graph_revision"]
        else:
            raise limits.InputCorruptError("A saved analysis result has an unknown stage.")
        # 위키 저장은 그래프/검토를, 그래프 저장은 원문/검토를 변경하지 않는다.
        # 저장 뒤 관측에 외부 변경이 끼었다면 이 예상 복합 상태와 일치하지 않는다.
        tokens = {key: value for key, value in next_value.items() if key not in {"status", "state_revision"}}
        next_value["state_revision"] = canonical_json_hash(tokens)
        if next_value["state_revision"] != receipt["state_revision"]:
            raise limits.InputConflictError("analysis_basis_changed")
        expected[document] = next_value
    for original in fixed["target_dependencies"]:
        document = original["document"]
        owned = history_entries[document]
        if not owned:
            continue
        path = service.store._document_path(service.store.history_dir, document)
        names = source_files.entries(service.store, path, maximum=MAX_HISTORY_ENTRIES)
        if (len(owned) != len(set(owned)) or not set(owned) <= set(names)
                or canonical_json_hash([name for name in names if name not in owned]) != original["history_revision"]):
            raise limits.InputConflictError("analysis_basis_changed")
    return expected


def validate_captured(service, job, fixed, selected, dependencies, targets):
    """명시 맥락과 모든 출력 대상을 원래 기준 또는 증명된 자기 저장 결과에 대조한다."""
    expected = expected_after_saves(service, job, fixed)
    if targets != [expected[item["document"]] for item in fixed["target_dependencies"]]:
        raise limits.InputConflictError("analysis_basis_changed")
    contexts = []
    for item in fixed["context_dependencies"]:
        value = expected.get(item["document"], item)
        # 부재를 보존하는 일반 맥락 계약에는 null 토큰을 새로 주입하지 않는다.
        if value.get("status") == "not_found":
            value = {"document": value["document"], "status": "not_found"}
        contexts.append(value)
    if context_dependencies(selected, dependencies) != contexts:
        raise limits.InputConflictError("analysis_basis_changed")


def capture_basis(service, job, actor, reference, selected, dependencies, previous, *, rebase):
    """위키 잠금 안에서 맥락·모든 출력 기준을 고정한다. 이후 자기 저장만 증거로 승계한다."""
    targets = targets_locked(service, job)
    if previous is not None and not rebase:
        if (reference != previous["ruleset_ref"] or capture.profile(actor) != previous["profile"]
                or selected != previous["context_documents"]):
            raise limits.InputConflictError("analysis_basis_changed")
        validate_captured(service, job, previous, selected, dependencies, targets)
        return {key: value for key, value in previous.items() if key != "revision"}, previous["revision"]
    if previous is None and not rebase:
        for original, current in zip(job["targets"], targets):
            if any(original[key] != current[key] for key in ("document", "source_revision", "state_revision")):
                raise limits.InputConflictError("analysis_basis_changed")
    value = {"version": 1, "basis_id": uuid4().hex,
             "ruleset_ref": reference, "profile": capture.profile(actor), "source_ref": job["source_ref"],
             "context_documents": selected, "context_dependencies": context_dependencies(selected, dependencies),
             "target_dependencies": targets}
    revision = canonical_json_hash(value)
    return value, revision


def validate_manifest(job, manifest):
    """옛 기준의 bundle/추출물은 보존하되 현재 작업의 새 저장에 사용할 수 없다."""
    current = active(job)
    if current is None:
        raise limits.InputConflictError("analysis_basis_required")
    if manifest.get("analysis_basis_revision") != current["revision"]:
        raise limits.InputConflictError("analysis_basis_changed", bundle_id=manifest["bundle_id"])
    return current


def validate_current_locked(service, job, manifest, actor):
    """저장 직전 공통 위키 잠금 안에서 작업 기준의 맥락·관점까지 다시 검사한다."""
    current = validate_manifest(job, manifest)
    _, dependencies, _ = capture.documents_locked(service.store, current["context_documents"], actor)
    if capture.profile(actor) != current["profile"] or manifest["ruleset_ref"] != current["ruleset_ref"]:
        raise limits.InputConflictError("analysis_basis_changed", bundle_id=manifest["bundle_id"])
    validate_captured(service, job, current, current["context_documents"], dependencies, targets_locked(service, job))
