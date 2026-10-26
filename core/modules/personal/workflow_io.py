"""복합 개인 작업의 현재 근거 관측과 intent/실제 저장 증거를 공통 처리한다.

intent는 '시도하기 전에 고정한 요청', saved는 Store가 성공을 반환한 뒤 남긴
증거다. 현재 파일 내용이 우연히 같다는 이유로 저장 성공을 추측하지 않는다.
"""

from core.common.json_codec import canonical_json_hash
from core.modules.sources import files
from core.modules.sources.store import SourceStore
from core.modules.sources.contracts import identifier
from core.modules.reviews.store import ReviewStore
from core.modules.analysis_inputs.capture import documents_locked
from core.modules.personal.store import PersonalConflictError, PersonalCorruptError, PersonalLimitError


def observe_basis(store, basis, actor, *, wiki_locked=False, coordination_locked=False):
    """당시 snapshot은 보존하고 최신 판본과의 차이만 별도 반환한다."""
    expected = {item["document"]: item["knowledge"] for item in basis["documents"]}
    documents, originals = [], []
    for document, before in expected.items():
        try:
            if wiki_locked:
                _, deps, _ = documents_locked(store, [{"document": document, "required": True, "reason": "basis_check"}], actor)
                current = deps[0]
            else:
                current = ReviewStore(store).query(document, domain=actor["domain"], viewpoint=actor["viewpoint"])
            tokens = {key: current[key] for key in ("source_revision", "graph_revision", "state_revision", "history_revision")}
            same = all(tokens[key] == before[key] for key in tokens)
            documents.append({"document": document, "status": "current" if same else "changed", **tokens})
        except (OSError, ValueError):
            documents.append({"document": document, "status": "unavailable"})
    for original in basis.get("originals", []):
        reference = original["source_ref"]
        try:
            sources = SourceStore(store)
            current = sources._get_source_locked(reference["source_id"]) if coordination_locked else sources.get_source(reference["source_id"])
            status = "current" if current["current_version"] == reference["source_version"] else "changed"
            originals.append({"source_id": reference["source_id"], "source_version": current["current_version"], "status": status})
        except (OSError, ValueError):
            originals.append({"source_id": reference["source_id"], "status": "unavailable"})
    old_profile = basis.get("scope", {}).get("profile", {})
    profile_changed = any(old_profile.get(key) != actor.get(key) for key in ("profile_id", "domain", "viewpoint"))
    statuses = [item["status"] for item in [*documents, *originals]]
    status = "unavailable" if "unavailable" in statuses else "changed" if profile_changed or "changed" in statuses else "current"
    value = {"status": status, "documents": documents, "originals": originals, "profile_changed": profile_changed}
    return {**value, "observation_revision": canonical_json_hash(value)}


def request_path(personal, kind, record_id, request_id):
    """파일 경로는 서버가 정한 자원 종류와 검증된 ID만 사용한다."""
    if kind not in {"draft-applications", "question-answers"}:
        raise ValueError("Unknown workflow request kind")
    identifier(record_id); identifier(request_id)
    return personal.root / ("_" + kind) / record_id / request_id


def receipt(personal, kind, record_id, request_id, *, payload=None):
    """독립 저장 증거를 우선하며 알 수 없는 결과를 반복 쓰기로 해결하지 않는다."""
    path = request_path(personal, kind, record_id, request_id)
    record = files.read_json(personal.store, path / "intent.json")
    if record.get("record_id") != record_id or record.get("request_id") != request_id:
        raise PersonalCorruptError("Workflow request identity is inconsistent")
    if payload is not None and record["payload_hash"] != canonical_json_hash(payload):
        raise PersonalConflictError()
    try:
        saved = files.read_json(personal.store, path / "saved.json")
    except FileNotFoundError:
        saved = None
    if saved is not None:
        if saved.get("payload_hash") != record["payload_hash"] or saved.get("saved") is not True:
            raise PersonalCorruptError("Workflow storage evidence is inconsistent")
        record = {**record, **saved}
    elif record.get("saved") is True or record.get("state") == "complete":
        raise PersonalCorruptError("A completed workflow is missing independent storage evidence")
    return record


def start_request(personal, kind, record_id, request_id, payload, extra=None):
    """부작용 전에 요청을 기록하고 결과 미확인을 새 요청으로 우회하지 않는다."""
    path = request_path(personal, kind, record_id, request_id)
    parent = path.parent
    names = files.entries(personal.store, parent, maximum=100)
    if len(names) >= 100:
        raise PersonalLimitError("The workflow request count limit was reached")
    for previous in names:
        old = receipt(personal, kind, record_id, previous)
        if old["state"] == "pending_reconcile" and old["saved"] is None:
            raise PersonalConflictError()
    value = {"record_id": record_id, "request_id": request_id, "payload_hash": canonical_json_hash(payload),
        "state": "pending_reconcile", "saved": None, "receipt": None, "cleanup_failures": [], **(extra or {})}
    files.write_json(personal.store, path / "intent.json", value)
    return path, value


def saved_result(personal, path, record, value, *, cleanup_failures=None):
    """성공을 반환한 Store의 증거를 먼저 기록하고 정리/연결 실패는 따로 알린다."""
    evidence = {"payload_hash": record["payload_hash"], "saved": True, "receipt": value,
                "cleanup_failures": cleanup_failures or []}
    try:
        files.write_json(personal.store, path / "saved.json", evidence)
    except OSError:
        return {**record, **evidence, "state": "pending_reconcile", "assurance": "in_process_save_result"}
    complete = {**record, **evidence, "state": "complete"}
    try:
        files.write_json(personal.store, path / "intent.json", complete)
    except OSError:
        return {**complete, "state": "pending_reconcile"}
    return complete
