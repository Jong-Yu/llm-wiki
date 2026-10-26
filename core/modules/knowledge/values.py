"""정규화·검색 값 순회와 실제 판단 이력의 참조를 계산한다."""

# 검색 문자열 정규화와 표시/이력 참조를 계산하는 작은 함수들이다.
# 문자열을 정규화해도 원문 값은 바꾸지 않는다. 감사 이유·actor 같은 필드를 개념 내용 검색으로 오인하지 않게 한다.

from core.modules.reviews.state import _is_policy
from core.modules.correspondences.schema import identifier
from core.modules.ontology.anchors import is_source_anchor
import unicodedata


def _normalized(value):
    return unicodedata.normalize("NFKC", value).casefold()

def _strings(value, prefix=""):
    """Search semantic values only, never free-form audit reasons or actors."""
    # yield는 발견한 문자열을 하나씩 전달한다. 감사 이유/실행 주체 같은 메타데이터를 원문 내용 탐색에서 제외한다.
    if isinstance(value, str):
        yield prefix, value
    elif isinstance(value, dict):
        for name, item in value.items():
            if name not in {"provenance", "reason", "question", "actor", "timestamp"}:
                yield from _strings(item, f"{prefix}.{name}".strip("."))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _strings(item, f"{prefix}[{index}]")

def _latest(events, key):
    result = {}
    for event in events:
        result[key(event)] = event
    return result

def _display_collection(claim):
    original = claim.get("original_collection", claim.get("collection"))
    return "relations" if original == "relation_candidates" and claim.get("decision") in {"accept", "edit"} else original

def _value_selector(collection, value, field):
    if collection == "attributes" and field.startswith("value"):
        return "value"
    if collection == "relations":
        for endpoint in ("subject", "object"):
            if field.startswith(endpoint + ".") and is_source_anchor(value.get(endpoint)):
                return endpoint
    return None

def _audit_refs(history, selected):
    """Keep the selected event and its restored decision's real audit origin."""
    # 선택한 판단을 이해하는 데 필요한 되돌림/이전 연결 이벤트 참조를 따라가 보존한다.
    by_id = {event["id"]: (index, event) for index, event in enumerate(history)}
    refs, pending = set(selected), list(selected)
    while pending:
        identifier = pending.pop()
        if identifier not in by_id:
            continue
        index, event = by_id[identifier]
        after = event.get("after", {})
        value = after.get("value")
        dependencies = [event.get("undo_of"), after.get("origin_event_id")]
        if isinstance(value, dict):
            dependencies.append(value.get("provenance", {}).get("event_id"))
        if event.get("action") == "undo":
            restored = [previous for previous in history[:index] if not _is_policy(previous)
                        and previous.get("claim_id") == event.get("claim_id")
                        and previous.get("collection") == event.get("collection")
                        and all(previous.get(name) == event.get(name) for name in ("source_revision", "graph_revision", "history_revision"))
                        and previous.get("action") != "undo" and previous.get("after") == after]
            if restored:
                dependencies.append(restored[-1]["id"])
        for dependency in dependencies:
            if dependency is not None and dependency not in refs:
                refs.add(dependency)
                pending.append(dependency)
    return refs
