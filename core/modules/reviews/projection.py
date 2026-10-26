"""검증한 전체 검토 원장에서 목록·단건 응답만 골라낸다.

원장을 먼저 자르면 앞선 판단과 되돌림을 잃을 수 있으므로 ReviewStore.query가
전체 이력을 검증한 뒤 마지막 출력 단계에서만 페이지를 나눈다.
"""

from core.common.json_codec import canonical_json_hash
from core.modules.documents.listing import _encode_cursor, _decode_cursor
from core.modules.documents.history import _offset
from core.modules.reviews.store import ReviewStore


def _snapshot(store, document, domain, viewpoint):
    """현재 원문·그래프·전체 원장이 함께 검증된 응답을 얻는다."""
    return ReviewStore(store).query(document, domain=domain, viewpoint=viewpoint)


def list_events(store, document, *, tenant, scope_key, domain=None, viewpoint=None,
                limit=20, cursor=None):
    """현재 관점과 전체 상태 판본에 묶인 이벤트 페이지를 반환한다."""
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("Invalid event page size")
    snapshot = _snapshot(store, document, domain, viewpoint)
    scope = canonical_json_hash({"kind": "document_events", "document": document, "scope": scope_key})
    previous = None if cursor is None else _decode_cursor(cursor, tenant, scope)
    events = list(reversed(snapshot["history"]))
    names = [event["id"] for event in events]
    catalog = snapshot["state_revision"]
    offset = _offset(previous, catalog, names)
    page = events[offset:offset + limit]
    more = offset + len(page) < len(events)
    cursor = _encode_cursor({"version": 1, "tenant": tenant, "scope": scope,
        "catalog": catalog, "after": page[-1]["id"]}) if more and page else None
    return {"document": document, "items": page, "state_revision": catalog,
            "pending_history": snapshot["pending_history"], "next_cursor": cursor,
            "complete": not more, "truncated": False, "skipped": [], "requires_refresh": False}


def read_event(store, document, event_id, *, domain=None, viewpoint=None):
    """당시 before/after·이유·인증 주체를 그대로 읽고 현재 상태로 덮어쓰지 않는다."""
    snapshot = _snapshot(store, document, domain, viewpoint)
    event = next((item for item in snapshot["history"] if item["id"] == event_id), None)
    if event is None:
        raise FileNotFoundError("No event in this document")
    return {"document": document, "event": event, "state_revision": snapshot["state_revision"],
            "pending": event_id in snapshot["pending_history"]}
