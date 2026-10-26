"""공유 원장 바이트와 대응 root별 독립 의존 탐색 상태를 연결한다."""

# 공유 캡처의 대응 원장 캐시와 각 대응의 의존 탐색을 연결한다.
# 원장 바이트는 재사용하되 root별 탐색 경로는 별도로 둬 이전 root의 탐색 상태가 다른 판단을 대체하지 않게 한다.

from core.modules.correspondences.contracts import CorrespondenceLimitError
from core.modules.correspondences.capture import _Capture
from .capture_errors import _error_code
from core.modules.correspondences.state import _states
from . import contracts
from copy import deepcopy
from core.modules.correspondences.schema import identifier
from hashlib import sha256


def _ledger(self, cid, purpose, required_by):
    raw = self._read("correspondence", cid, purpose, required_by)
    if raw is None:
        self._skip("correspondence", cid, reason="not_found")
        return None, None
    if cid not in self._parsed_correspondences:
        try:
            self._parsed_correspondences[cid] = self.correspondences._ledger(raw, cid)
        except (OSError, ValueError, TypeError) as error:
            self._validated_error("correspondence", cid, error)
            raise
    return raw, self._parsed_correspondences[cid]

def correspondence(self, correspondence_id, purpose="content", required_by=None, *, root=False, evaluate=True):
    # 대응 원장과 현재 판단을 요청 캡처에 연결한다. root별 의존 탐색은 따로 만들어 다른 root의 결론을 가져다 쓰지 않는다.
    identifier(correspondence_id, "correspondence_id")
    try:
        raw, ledger = self._ledger(correspondence_id, purpose, required_by)
        if ledger is None:
            if root:
                raise FileNotFoundError(correspondence_id)
            return {"correspondence_id": correspondence_id, "correspondence_revision": None, "status": "missing",
                    "ledger": None, "history": [], "complete": False,
                    "components": {"correspondence": self._component("correspondence", correspondence_id)},
                    "evaluation": {"status": "unavailable"}}
    except (OSError, ValueError, TypeError) as error:
        if root:
            raise
        return {"correspondence_id": correspondence_id, "correspondence_revision": None, "status": "unavailable",
                "ledger": None, "history": [], "complete": False,
                "components": {"correspondence": self._component("correspondence", correspondence_id)},
                "evaluation": {"status": "unavailable", "reason": _error_code(error)}}
    error = None
    if evaluate:
        ctx = _CorrespondenceCapture(self, correspondence_id, purpose, required_by)
        try:
            result = self.correspondences._result(correspondence_id, raw, ledger, ctx)
            return {**result, "status": "ready", "ledger": deepcopy(ledger),
                    "components": {"correspondence": self._component("correspondence", correspondence_id)},
                    "evaluation": {"status": "ready", "evaluated_at": self.evaluated_at}}
        except (OSError, ValueError, TypeError) as caught:
            error = caught
            self._skip("correspondence", correspondence_id, error, phase="evaluation")
    source = None
    policies = []
    for event in _states(ledger).values():
        state = deepcopy(event["after"])
        item = {**state, "event_id": event["id"], "lane": event["lane"], "judgment_id": event["judgment_id"],
                "applicability": "unavailable" if state["decision"] in {"accepted", "active"} else "inactive",
                "reasons": ["evaluation_not_requested" if error is None else _error_code(error)], "conflict_refs": [],
                "provenance": {"kind": "action_log" if event["lane"] == "expert" else state["value"]["basis"]["kind"],
                               "event_id": state["origin_event_id"], "state_revision": event["base_state_revision"]}}
        if event["lane"] == "source":
            source = item
        else:
            policies.append(item)
    return {"ok": True, "correspondence_id": correspondence_id, "correspondence_revision": sha256(raw).hexdigest(),
            "documents": deepcopy(ledger["documents"]), "status": "ready", "source_proposal": source,
            "reviews": [source], "policies": policies, "history": deepcopy(ledger["events"]), "ledger": deepcopy(ledger),
            "dependencies": None, "complete": False, "truncated": isinstance(error, CorrespondenceLimitError),
            "components": {"correspondence": self._component("correspondence", correspondence_id)},
            "evaluation": {"status": "not_requested" if error is None else "unavailable", "evaluated_at": self.evaluated_at}}

class _CorrespondenceCapture(_Capture):
    """공유 바이트를 쓰면서도 대응별 의존 탐색 한도와 순환 감지는 독립적으로 유지한다."""
    def __init__(self, provider, root_id, purpose, required_by):
        super().__init__(provider.correspondences, application_context=provider.application_context,
                         as_of=provider.evaluated_at)
        self.provider = provider
        self.root_id = root_id
        self.purpose = purpose
        self.required_by = [f"correspondence:{root_id}"]
        if required_by is not None:
            self.required_by.extend(required_by if isinstance(required_by, list) else [required_by])

    def ledger(self, cid):
        if cid not in self.ledgers:
            self.ledgers[cid] = self.provider._ledger(cid, "dependency", self.required_by)
        return self.ledgers[cid]

    def document(self, document, full=False):
        if document not in self.docs:
            if len(self.docs) >= contracts.MAX_DEPENDENCY_DOCUMENTS:
                raise CorrespondenceLimitError("D-038 root closure exceeds eight documents")
            self.docs[document] = self.provider._dependency_document(document, full, "dependency", self.required_by)
        elif full and "full" not in self.docs[document]:
            self.docs[document] = self.provider._dependency_document(document, True, "dependency", self.required_by)
        return self.docs[document]
