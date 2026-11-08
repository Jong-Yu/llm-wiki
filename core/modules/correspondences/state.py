"""대응의 lane 상태·의존 manifest·CAS token을 계산하는 순수 보조 함수.

owner는 공용 Store의 저장소·actor·같은 잠금 안의 협력 메서드만 전달한다.
파일 I/O와 잠금의 경계는 기존 호출 순서를 유지한다.
"""

# lane은 원문 근거 판단(source)과 전문가 판단(expert)의 기록 줄기를 구분한다.
# manifest는 참조 자료의 버전 목록이고 token은 변경 내용과 그 목록의 지문이다. 이 값만으로 접근 권한을 부여하지 않는다.

from . import contracts as limits
from . import schema
from .contracts import CorrespondenceLimitError
from .contracts import CorrespondenceValidationError
from copy import deepcopy
from core.common.json_codec import canonical_json_hash as _hash


def _scope(actor):
    return {"domain": actor["domain"], "viewpoint": actor["viewpoint"]}


def _states(ledger):
    latest = {}
    for event in ledger["events"]:
        latest[(event["lane"], event["judgment_id"])] = event
    return latest


def _values(states):
    return [event["after"]["value"] for event in states.values() if event["after"]["value"] is not None]


def _manifest(value):
    # 근거 문서와 다른 대응의 revision을 정리해 내용 변경에 비교할 기준을 만든다.
    schema.fields(value, {"documents", "correspondences"}, name="dependencies")
    if not isinstance(value["documents"], list) or not isinstance(value["correspondences"], list):
        raise CorrespondenceValidationError("dependency collections must be lists")
    if len(value["documents"]) > limits.MAX_DEPENDENCY_DOCUMENTS or len(value["correspondences"]) > limits.MAX_DEPENDENCY_CORRESPONDENCES:
        raise CorrespondenceLimitError("dependency closure exceeds its limit")
    names = set()
    for row in value["documents"]:
        schema.fields(row, {"document", "source_revision", "history_revision", "status"}, {"graph_revision", "review_revision", "state_revision", "graph_status", "references"}, "document dependency")
        if row["document"] in names or row["status"] not in {"ready", "missing"}:
            raise CorrespondenceValidationError("invalid or duplicate source dependency")
        names.add(row["document"])
        if row["source_revision"] is not None:
            schema.token(row["source_revision"])
        schema.token(row["history_revision"])
        if set(row) != {"document", "source_revision", "history_revision", "status"}:
            schema.fields(row, {"document", "source_revision", "history_revision", "status", "graph_revision", "review_revision", "state_revision", "graph_status", "references"}, name="full document dependency")
            for name in ("graph_revision", "review_revision"):
                if row[name] is not None:
                    schema.token(row[name])
            schema.token(row["state_revision"])
            if row["graph_status"] not in {"ready", "missing", "stale"}:
                raise CorrespondenceValidationError("invalid graph dependency status")
            if not isinstance(row["references"], list) or len(row["references"]) > 100:
                raise CorrespondenceValidationError("invalid document reference statuses")
            for reference in row["references"]:
                schema.fields(reference, {"key", "status"}, name="document reference state")
                schema.token(reference["key"])
                if reference["status"] not in {"ready", "missing", "changed"}:
                    raise CorrespondenceValidationError("invalid document reference status")
    names = set()
    for row in value["correspondences"]:
        schema.fields(row, {"correspondence_id", "correspondence_revision", "dependencies_digest", "status", "references"}, name="correspondence dependency")
        schema.identifier(row["correspondence_id"])
        if row["correspondence_id"] in names or row["status"] not in {"ready", "missing"}:
            raise CorrespondenceValidationError("invalid or duplicate correspondence dependency")
        names.add(row["correspondence_id"])
        for name in ("correspondence_revision", "dependencies_digest"):
            if row[name] is not None:
                schema.token(row[name])
        if not isinstance(row["references"], list) or len(row["references"]) > 50:
            raise CorrespondenceValidationError("invalid dependency reference states")
        for ref in row["references"]:
            schema.fields(ref, {"event_id", "current_event_id", "status"}, name="reference state")
            schema.identifier(ref["event_id"])
            if ref["current_event_id"] is not None:
                schema.identifier(ref["current_event_id"])
            if ref["status"] not in {"applicable", "missing", "unavailable", "needs_review", "inactive", "other_scope", "out_of_period", "unknown_scope", "conflicting"}:
                raise CorrespondenceValidationError("invalid referenced applicability")


def _inactive(scope):
    return {"value": None, "decision": "inactive", "basis_dependencies": deepcopy(limits._EMPTY), "policy_scope": deepcopy(scope), "supersedes_event_id": None, "origin_event_id": None}


def _application_context(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 50:
        raise CorrespondenceValidationError("application_context must map at most 50 axis names to text")
    for name, item in value.items():
        schema.text(name, "application axis", 100)
        schema.text(item, "application value")
    return deepcopy(value)


def _token(owner, cid, revision, dependencies, kind, payload):
    # 대응 자체 revision, 의존 manifest, 요청한 payload를 함께 지문으로 묶는다. token은 인증 토큰이 아니다.
    return _hash({"contract_version": 1, "tenant": owner.actor["tenant"], "correspondence_id": cid, "correspondence_revision": revision, "access_policy_revision": owner.actor.get("access_revision", owner.actor["policy_revision"]), "selected_profile": {name: owner.actor[name] for name in ("profile_id", "domain", "viewpoint")}, "payload_digest": _hash({"kind": kind, "payload": payload}), "dependencies": dependencies})


def _complete(dependencies):
    return not any(row["status"] == "missing" or row.get("graph_status") == "missing" or any(ref["status"] == "missing" for ref in row.get("references", [])) for row in dependencies["documents"]) and not any(row["status"] == "missing" or any(ref["status"] == "missing" for ref in row["references"]) for row in dependencies["correspondences"])
