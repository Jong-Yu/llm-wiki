"""현재 허용된 공간의 검토함·이력을 제한된 전체 탐색으로 구성한다.

문서/대응은 tenant 권한 안에서 발견한다. 개인 작업은 자신의 owner index만
열며 다른 사람의 작업을 먼저 읽고 숨기지 않는다. 전체 탐색에도 명시 한도와
누락 상태를 둔다. complete는 모든 관측 범위가 확보된 경우에만 참이다.
"""

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from datetime import datetime, timezone
from core.modules.documents.listing import _scan, CatalogChangedError
from core.modules.documents.store import StorageBusyError
from core.modules.sources import files
from core.modules.correspondences.schema import identifier as correspondence_id
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_jobs import records, contracts as jobs_contracts
from .aggregation import _capture, _queue_items, _history_items, _page, MAX_AGGREGATE_BYTES

MAX_TENANT_RESOURCES = 1000
MAX_TENANT_ITEMS = 2000


def _history_order(item):
    """서로 다른 기록의 시각을 UTC로 맞추고 같은 시각은 안정된 항목 ID로 정렬한다."""
    value = item.get("event", {}).get("timestamp") or item.get("version", {}).get("archived_at")
    try:
        instant = datetime.fromisoformat(value).astimezone(timezone.utc).isoformat() if value else ""
    except (TypeError, ValueError):
        instant = ""
    return instant, item["key"]


def _directory_refs(store, directory, kind, skipped):
    """기존 안전한 디렉터리 조회로 식별자만 찾고 링크·손상·한도를 숨기지 않는다."""
    try:
        names = files.entries(store, directory, maximum=MAX_TENANT_RESOURCES + 1)
    except StorageBusyError:
        raise
    except (OSError, ValueError):
        skipped.append({"kind": kind, "reference": "tenant", "code": "resource_scan_limit"})
        return []
    result = []
    for name in names[:MAX_TENANT_RESOURCES]:
        try:
            if not name.endswith(".json"):
                raise ValueError()
            value = name[:-5]
            if kind == "job":
                jobs_contracts.identifier(value)
            else:
                correspondence_id(value, "correspondence_id")
            result.append(value)
        except ValueError:
            skipped.append({"kind": kind, "reference": name, "code": "invalid_reference"})
    if len(names) > MAX_TENANT_RESOURCES:
        skipped.append({"kind": kind, "reference": "tenant", "code": "resource_scan_limit"})
    return result


def tenant_query(store, actor, *, kind, states=None, limit=20, cursor=None):
    """주체·관점·현재 자료의 판본에 묶인 전체 공간 페이지를 읽는다.

    각 자료를 읽은 시점은 서로 다를 수 있으므로 전역 단일 거래 시점이라고
    표시하지 않는다. 탐색/입력/출력 한도를 만나면 전체 미검토 없음으로 결론내리지 않는다.
    """
    if kind not in {"review_queue", "history"} or type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("Invalid tenant aggregate request")
    states = states or ["unreviewed", "defer", "pending"]
    if len(states) != len(set(states)):
        raise ValueError("Select unique states")
    skipped = []
    with store._write_lock():
        entries, unavailable, _, truncated = _scan(store)
    documents = [entry[0] for entry in entries[:MAX_TENANT_RESOURCES]]
    skipped.extend({"kind": "document", "reference": item["document"], "code": item["code"]} for item in unavailable)
    if truncated or len(entries) > MAX_TENANT_RESOURCES:
        skipped.append({"kind": "document", "reference": "tenant", "code": "resource_scan_limit"})
    correspondences = CorrespondenceStore(store, actor)
    with files.coordination(store):
        correspondence_ids = _directory_refs(store, correspondences.correspondence_dir, "correspondence", skipped)
        jobs = JobStore(store)
        # 서버 인증으로 받은 주체의 index만 열어 다른 주체의 개인 작업을 노출하지 않는다.
        own_jobs = _directory_refs(store, jobs.jobs_dir / "_owners" / records.owner_key(actor["tenant"], actor["user_id"]),
            "job", skipped) if kind == "history" else []
    discovered = {"documents": documents, "correspondences": correspondence_ids, "own_jobs": own_jobs}
    resources, items, used = [], [], 0
    pending = [("document", value) for value in documents] + [("correspondence", value) for value in correspondence_ids]
    for resource_kind, reference in pending:
        captured, errors = _capture(store, actor, [reference] if resource_kind == "document" else [],
            [reference] if resource_kind == "correspondence" else [])
        skipped.extend(errors)
        size = len(canonical_json_bytes(captured))
        if used + size > MAX_AGGREGATE_BYTES or len(items) >= MAX_TENANT_ITEMS:
            skipped.append({"kind": "aggregate", "reference": "tenant", "code": "capture_limit"})
            break
        used += size
        resources.extend(captured)
        if kind == "review_queue":
            items.extend(_queue_items(captured, skipped, states))
        else:
            items.extend(_history_items(store, actor, captured, skipped, []))
    if kind == "history":
        for job_id in own_jobs:
            captured = _history_items(store, actor, [], skipped, [job_id])
            size = len(canonical_json_bytes(captured))
            if used + size > MAX_AGGREGATE_BYTES or len(items) >= MAX_TENANT_ITEMS:
                skipped.append({"kind": "job", "reference": "tenant", "code": "capture_limit"})
                break
            items.extend(captured)
            used += size
    if len(items) > MAX_TENANT_ITEMS:
        skipped.append({"kind": "aggregate", "reference": "tenant", "code": "output_limit"})
        items = items[:MAX_TENANT_ITEMS]
    scope = {"tenant": actor["tenant"], "states": states if kind == "review_queue" else None,
        "resource_discovery_revision": canonical_json_hash(discovered), "job_visibility": "current_user_only",
        "order": "newest_first" if kind == "history" else "resource_reference",
        "discovered_counts": {name: len(values) for name, values in discovered.items()}}
    value = _page(actor, kind, scope, items, resources, skipped, limit, cursor, coverage="tenant_visible_resources",
        sort_key=_history_order if kind == "history" else None, reverse=kind == "history",
        scope_basis={name: scope[name] for name in ("tenant", "states", "job_visibility", "order")})
    # 이력에 선택되지 않은 다른 주체 작업이 있다고 '누락'으로 노출하거나 그 존재를 추측하지 않는다.
    return {**value, "bounds": {"resources_per_kind": MAX_TENANT_RESOURCES,
        "capture_bytes": MAX_AGGREGATE_BYTES, "items": MAX_TENANT_ITEMS}}
