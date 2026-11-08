"""선택 자료나 허용 공간의 검토함·이력, 선택 근거의 질문 준비 서비스다.

페이지는 전체 원장을 검증하고 현재 판단을 계산한 뒤 잘라서 반환한다.
문서끼리 같은 전역 시점을 보장하지 않으므로 각 자료의 판본을 따로 보존한다.
"""

from core.modules.reviews.values import actor_basis
from hashlib import sha256

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.documents.listing import (
    _encode_cursor, _decode_cursor, CatalogChangedError, InvalidCursorError,
)
from core.modules.documents.store import StorageBusyError
from core.modules.documents.history import list_versions
from core.modules.reviews.store import ReviewStore
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.correspondences.schema import identifier
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_jobs.contracts import identifier as job_identifier
from core.modules.analysis_plans.store import PlanStore
from core.modules.analysis_inputs.contracts import InputConflictError
from core.modules.sources.store import SourceStore
from core.modules.personal.web_evidence import validate_web_evidence
from .schema import documents as validate_documents
from .capture_errors import _error_code

MAX_AGGREGATE_BYTES = 8 * 1024 * 1024
MAX_HISTORY_ITEMS = 1000


def _selection(store, documents, correspondence_ids, job_ids=()):
    """사용자 입력의 경로·중복·상한을 읽기 전에 검사한다."""
    paths = validate_documents(documents, store)
    for values, maximum, check in ((correspondence_ids, 8, identifier), (job_ids, 8, job_identifier)):
        if len(values) > maximum or len(set(values)) != len(values):
            raise ValueError("Select unique resource references within the limit")
        for value in values:
            check(value)
    return paths


def _capture(store, actor, documents, correspondence_ids):
    """각 자료를 공용 조회 함수에서 읽고 읽기 실패를 빈 정상 자료와 구분한다."""
    resources, skipped, used = [], [], 0
    reviews = ReviewStore(store)
    correspondences = CorrespondenceStore(store, actor)
    for kind, references in (("document", documents), ("correspondence", correspondence_ids)):
        for reference in references:
            try:
                value = (reviews.query(reference, domain=actor["domain"], viewpoint=actor["viewpoint"])
                    if kind == "document" else correspondences.query(reference))
                size = len(canonical_json_bytes(value))
                if used + size > MAX_AGGREGATE_BYTES:
                    skipped.append({"kind": kind, "reference": reference, "code": "capture_limit"})
                    continue
                used += size
                resources.append({"kind": kind, "reference": reference, "value": value})
            except StorageBusyError:
                raise
            except (OSError, ValueError) as error:
                skipped.append({"kind": kind, "reference": reference, "code": _error_code(error)})
    return resources, skipped


def _resource_ref(resource):
    """본문·그래프·검토의 서로 다른 판본을 하나로 합치지 않고 출처에 붙인다."""
    value = resource["value"]
    names = {"document": ("source_revision", "graph_revision", "review_revision", "history_revision", "state_revision", "status"),
        "correspondence": ("correspondence_revision", "state_revision", "complete"),
        "job": ("job_revision", "state")}[resource["kind"]]
    return {"kind": resource["kind"], "reference": resource["reference"],
            **{name: value.get(name) for name in names}}


def _page(actor, kind, scope, items, resources, skipped, limit, cursor, *, coverage="explicit_selection_only", sort_key=None, reverse=False, scope_basis=None):
    """기존 목록의 cursor 검사 규칙을 재사용해 다른 범위·판본의 이어읽기를 거부한다."""
    ordered = sorted(items, key=sort_key or (lambda item: item["key"]), reverse=reverse)
    if len({item["key"] for item in ordered}) != len(ordered):
        raise ValueError("Aggregate item references must be unique")
    refs = [_resource_ref(resource) for resource in resources]
    scope_hash = canonical_json_hash({"actor": actor_basis(actor), "kind": kind, "scope": scope if scope_basis is None else scope_basis})
    snapshot_value = {"items": ordered, "resources": refs, "skipped": skipped}
    if "resource_discovery_revision" in scope:
        snapshot_value["resource_discovery_revision"] = scope["resource_discovery_revision"]
    snapshot = canonical_json_hash(snapshot_value)
    start = 0
    if cursor is not None:
        previous = _decode_cursor(cursor, actor["tenant"], scope_hash)
        if previous["catalog"] != snapshot:
            raise CatalogChangedError()
        positions = [index for index, item in enumerate(ordered) if item["key"] == previous["after"]]
        if not positions:
            raise InvalidCursorError("The aggregate cursor is unavailable")
        start = positions[0] + 1
    selected = ordered[start:start + limit]
    more = start + len(selected) < len(ordered)
    next_cursor = (_encode_cursor({"version": 1, "tenant": actor["tenant"], "scope": scope_hash,
        "catalog": snapshot, "after": selected[-1]["key"]}) if more else None)
    return {"kind": kind, "scope": {**scope, "coverage": coverage},
        "items": selected, "resources": refs, "snapshot_revision": snapshot,
        "consistency": "per_resource_snapshots", "total_items": len(ordered),
        "next_cursor": next_cursor, "scope_complete": not skipped,
        "complete": not skipped and not more, "truncated": any(item["code"].endswith("limit") for item in skipped),
        "skipped": skipped, "requires_refresh": False}


def _queue_items(resources, skipped, states):
    """이미 검증한 자료에서 검토 항목을 만든다. 명시/공간 전체 조회가 함께 사용한다."""
    items = []
    for resource in resources:
        value, reference = resource["value"], resource["reference"]
        ref = _resource_ref(resource)
        if resource["kind"] == "document":
            for claim in value.get("current_claims", value["claims"]):
                decision = claim["decision"]
                if decision in states:
                    items.append({"key": f"document:{reference}:claim:{claim['claim_id']}",
                        "kind": "document_claim", "status": decision, "ref": ref, "claim": claim})
            for event_id in value.get("current_pending_history", value["pending_history"]):
                if "pending" in states:
                    items.append({"key": f"document:{reference}:pending:{event_id}",
                        "kind": "pending_document_event", "status": "pending", "ref": ref, "event_id": event_id})
            if value["status"] != "ready" and "pending" in states:
                items.append({"key": f"document:{reference}:graph", "kind": "document_graph",
                    "status": "pending", "ref": ref, "graph_status": value["status"]})
        else:
            if not value["complete"]:
                skipped.append({"kind": "correspondence", "reference": reference, "code": "missing_dependency"})
            # source_proposal은 reviews에도 들어 있으므로 같은 이벤트를 두 번 세지 않는다.
            judgments = {item["event_id"]: item for item in [value["source_proposal"], *value["reviews"], *value["policies"]]}
            for judgment in judgments.values():
                decision = judgment.get("decision")
                applicability = judgment.get("applicability")
                status = ("defer" if decision == "deferred" else "unreviewed" if decision == "unreviewed"
                    else "pending" if applicability in {"needs_review", "unavailable", "unknown_scope"} else None)
                if status in states:
                    items.append({"key": f"correspondence:{reference}:{judgment['event_id']}", "kind": "correspondence_judgment",
                        "status": status, "ref": ref, "judgment": judgment})
    return items


def review_queue(store, actor, *, documents, correspondence_ids, states, limit=20, cursor=None, coverage="selected"):
    """선택 범위 또는 현재 허용 공간의 미검토/보류/오래된 판단을 읽는다."""
    if coverage == "tenant":
        if documents or correspondence_ids:
            raise ValueError("Tenant coverage cannot also select individual resources")
        from .tenant_aggregation import tenant_query
        return tenant_query(store, actor, kind="review_queue", states=states, limit=limit, cursor=cursor)
    documents = _selection(store, documents, correspondence_ids)
    if len(set(states)) != len(states) or coverage != "selected":
        raise ValueError("Select unique review states and a supported coverage")
    resources, skipped = _capture(store, actor, documents, correspondence_ids)
    return _page(actor, "review_queue", {"documents": documents, "correspondence_ids": correspondence_ids,
        "states": states}, _queue_items(resources, skipped, states), resources, skipped, limit, cursor)


def _history_items(store, actor, resources, skipped, job_ids):
    """원본 이력을 조립한다. 작업 결과물 검증은 작업 상세 조회에서 수행한다."""
    items = []
    for resource in resources:
        reference, value, ref = resource["reference"], resource["value"], _resource_ref(resource)
        for event in value.get("history", []):
            items.append({"key": f"{resource['kind']}:{reference}:event:{event['id']}",
                "kind": resource["kind"] + "_event", "ref": ref, "event": event})
        if resource["kind"] != "document":
            continue
        position, scanned = None, 0
        try:
            while True:
                versions = list_versions(store, reference, tenant=actor["tenant"],
                    scope_key=canonical_json_hash(actor_basis(actor)), limit=50, cursor=position)
                for version in versions["items"]:
                    items.append({"key": f"document:{reference}:version:{version['history_id']}",
                        "kind": "document_version", "ref": ref, "version": version})
                scanned += len(versions["items"])
                position = versions["next_cursor"]
                skipped.extend({"kind": "document_history", "reference": reference, **item} for item in versions["skipped"])
                if not position:
                    break
                if scanned >= MAX_HISTORY_ITEMS:
                    skipped.append({"kind": "document_history", "reference": reference, "code": "history_scan_limit"})
                    break
        except StorageBusyError:
            raise
        except (OSError, ValueError, CatalogChangedError) as error:
            skipped.append({"kind": "document_history", "reference": reference, "code": _error_code(error)})
    jobs = JobStore(store)
    for job_id in job_ids:
        try:
            job = jobs.history(job_id, tenant=actor["tenant"], user_id=actor["user_id"])
            # 소유·원본 상태·lease/등록은 확인하며 결과/입력 상세 조립은 이력에 사용하지 않는다.
            resource = {"kind": "job", "reference": job_id, "value": job}
            resources.append(resource)
            for index, event in enumerate(job["events"]):
                items.append({"key": f"job:{job_id}:{index:06d}", "kind": "job_event",
                    "ref": {"kind": "job", "job_id": job_id, "job_revision": job["job_revision"]}, "event": event})
        except StorageBusyError:
            raise
        except (OSError, ValueError) as error:
            skipped.append({"kind": "job", "reference": job_id, "code": _error_code(error)})
    return items


def history_query(store, actor, *, documents, correspondence_ids, job_ids, limit=20, cursor=None, coverage="selected"):
    """본문·판단·대응·본인 작업을 명시 선택 또는 허용된 공간 범위에서 읽는다."""
    if coverage == "tenant":
        if documents or correspondence_ids or job_ids:
            raise ValueError("Tenant coverage cannot also select individual resources")
        from .tenant_aggregation import tenant_query
        return tenant_query(store, actor, kind="history", limit=limit, cursor=cursor)
    if coverage != "selected":
        raise ValueError("Select a supported coverage")
    documents = _selection(store, documents, correspondence_ids, job_ids)
    resources, skipped = _capture(store, actor, documents, correspondence_ids)
    return _page(actor, "history", {"documents": documents, "correspondence_ids": correspondence_ids,
        "job_ids": job_ids}, _history_items(store, actor, resources, skipped, job_ids), resources, skipped, limit, cursor)


def prepare_question(store, actor, *, documents, required_documents, claims, source_refs, allow_empty=False, web=None,
                     retrieval_scope=None, lookup_question=None):
    """선택 근거의 전체 본문·현재 판단·고정 원본을 읽어 질문 준비값을 반환한다.

    snapshot_revision은 이 조회의 내용 지문이다. 영구 보관이나 쓰기 CAS가 아니며
    다음 질문/저장 때는 해당 자료의 현재 권한과 판본을 다시 검사해야 한다.
    """
    retrieval = None
    if retrieval_scope is not None:
        if retrieval_scope not in {"selected", "workspace"} or not isinstance(lookup_question, str) or not lookup_question.strip():
            raise ValueError("Question retrieval requires an explicit scope and question")
        if retrieval_scope == "workspace":
            from .question_index import discover
            pinned = list(dict.fromkeys([*required_documents, *(c["document"] for c in claims)]))
            retrieval = discover(store, actor, lookup_question, documents, pinned)
            documents = retrieval.pop("documents")
            allow_empty = allow_empty or not documents
        else:
            retrieval = {"coverage": "explicit_selection_only", "complete": True, "truncated": False,
                         "skipped": [], "absence_proven": False, "policy": "question_grounding_v1"}
        retrieval["question_sha256"] = sha256(lookup_question.encode()).hexdigest()
        retrieval["query_prefix_length"] = len(lookup_question)
    elif lookup_question is not None:
        raise ValueError("Select a question retrieval scope")
    # 외부 자료는 개인 PC의 보고다. 형식과 보관한 문자 hash만 검사하며 서버에서 웹에 접속하지 않는다.
    web = validate_web_evidence(web) if web is not None else None
    # 새 선택 항목을 생략한 기존 md/txt 요청은 이전 응답 구조와 지문을 유지한다.
    source_refs = [{key: value for key, value in reference.items()
        if key != "conversion_ref" or value is not None} for reference in source_refs]
    for values in (documents, required_documents):
        if len(set(values)) != len(values):
            raise ValueError("Select unique document paths")
    selected = list(dict.fromkeys([*documents, *required_documents]))
    # 아직 파생 위키가 없는 원본만으로도 질문할 수 있다. 빈 전체 범위는 허용하지 않는다.
    if selected:
        validate_documents(selected, store)
    elif not source_refs and not allow_empty:
        raise ValueError("Select documents or original source references")
    for claim in claims:
        if claim["document"] not in selected:
            raise ValueError("Every selected claim must belong to the explicit documents")
    if len({(value["source_id"], value["source_version"]) for value in source_refs}) != len(source_refs):
        raise ValueError("Select unique original versions")
    resources, skipped = _capture(store, actor, selected, [])
    snapshots, selected_claims, originals = [], [], []
    used = 0
    for resource in resources:
        reference, knowledge = resource["reference"], resource["value"]
        try:
            source = store.read(reference)
            if source.revision != knowledge["source_revision"]:
                skipped.append({"kind": "document", "reference": reference, "code": "snapshot_changed"})
                continue
            snapshot = {"document": reference, "source_revision": source.revision,
                "content": source.content, "knowledge": knowledge}
            size = len(canonical_json_bytes(snapshot))
            if used + size > MAX_AGGREGATE_BYTES:
                skipped.append({"kind": "document", "reference": reference, "code": "capture_limit"})
                continue
            used += size
            snapshots.append(snapshot)
        except StorageBusyError:
            raise
        except (OSError, ValueError) as error:
            skipped.append({"kind": "document", "reference": reference, "code": _error_code(error)})
    by_document = {item["document"]: item["knowledge"] for item in snapshots}
    for selection in claims:
        knowledge = by_document.get(selection["document"])
        claim = next((item for item in knowledge["claims"] if item["claim_id"] == selection["claim_id"]), None) if knowledge else None
        current = bool(knowledge and knowledge["state_revision"] == selection["state_revision"] and claim)
        selected_claims.append({"selection": selection, "status": "current" if current else "changed_or_unavailable",
            "claim": claim if current else None})
        if not current:
            skipped.append({"kind": "claim", "reference": selection["claim_id"], "code": "selection_changed"})
    sources = SourceStore(store)
    plans = PlanStore(store, actor)
    for reference in source_refs:
        try:
            stream, manifest = sources.open_original(reference["source_id"], reference["source_version"])
            with stream:
                # open_original은 원시 바이트 전체의 크기/hash를 이미 검사한다.
                # 바이너리는 다시 UTF-8로 해석하거나 서버에서 변환하지 않는다.
                if manifest["source_sha256"] != reference["source_sha256"]:
                    skipped.append({"kind": "source", "reference": reference, "code": "selection_changed"})
                    continue
                conversion_ref = reference.get("conversion_ref")
                if conversion_ref is None and manifest["format"] not in {"md", "txt"}:
                    skipped.append({"kind": "source", "reference": reference, "code": "client_conversion_required"})
                    continue
                if conversion_ref is None:
                    if manifest["size_bytes"] > MAX_AGGREGATE_BYTES - used:
                        skipped.append({"kind": "source", "reference": reference, "code": "capture_limit"})
                        continue
                    content = stream.read(MAX_AGGREGATE_BYTES + 1)
            if conversion_ref is None:
                if sha256(content).hexdigest() != reference["source_sha256"] or len(content) != manifest["size_bytes"]:
                    skipped.append({"kind": "source", "reference": reference, "code": "selection_changed"})
                    continue
                original = {"source_ref": reference, "manifest": manifest, "content": content.decode("utf-8")}
            else:
                # 분석 계획과 같은 불변 묶음 조회를 재사용해 소유자·revision과
                # 각 문자 파일의 크기/hash를 검사한다. 다른 원본의 변환은 섞지 않는다.
                conversion = plans.read("conversions", conversion_ref["conversion_id"], conversion_ref["conversion_revision"])
                converted = conversion["manifest"]
                if any(converted["source_ref"][key] != reference[key]
                        for key in ("source_id", "source_version", "source_sha256")):
                    skipped.append({"kind": "source", "reference": reference, "code": "conversion_source_changed"})
                    continue
                if not converted["complete"] or converted["unread_ranges"]:
                    skipped.append({"kind": "source", "reference": reference, "code": "conversion_incomplete"})
                    continue
                # 기존 질문 인용은 content에서 확인한다. 구성별 본문도 함께 보존해
                # 페이지/셀 위치와 인용을 다시 대조할 수 있게 한다. complete는 PC의
                # 보고이며, 원시 파일 전체의 판독 정확도를 서버가 검증한 뜻은 아니다.
                content = "\n\n".join(conversion["components"][unit["unit_id"]] for unit in converted["units"])
                original = {"source_ref": reference, "manifest": manifest, "content": content,
                    "conversion": {"conversion_ref": conversion_ref, "manifest": converted,
                        "components": conversion["components"]}}
            size = len(canonical_json_bytes(original))
            if used + size > MAX_AGGREGATE_BYTES:
                skipped.append({"kind": "source", "reference": reference, "code": "capture_limit"})
                continue
            used += size
            originals.append(original)
        except StorageBusyError:
            raise
        except InputConflictError as error:
            skipped.append({"kind": "source", "reference": reference, "code": error.code})
        except (OSError, ValueError) as error:
            skipped.append({"kind": "source", "reference": reference, "code": _error_code(error)})
    scope = {"documents": documents, "required_documents": required_documents, "claims": claims,
        "source_refs": source_refs, "coverage": "explicit_selection_only", "profile": actor}
    if allow_empty and not selected and not source_refs:
        # 검색으로 관련 자료를 찾지 못한 질문임을 근거 묶음에 남겨, 빈 선택을 실수로 허용한 것과 구별한다.
        scope["empty_selection"] = "no_matching_documents"

    value = {"kind": "question_context", "scope": scope, "documents": snapshots,
        "selected_claims": selected_claims, "originals": originals,
        "can_prepare": not skipped, "complete": not skipped,
        "truncated": any(item["code"].endswith("limit") for item in skipped), "skipped": skipped,
        "consistency": "per_resource_snapshots", "read_only": True, "ai_executed": False, "persisted": False}
    if web is not None:
        value["web"] = web
    if retrieval is not None:
        if retrieval_scope == "workspace":
            from .question_index import catalog_revision
            with store._write_lock():
                if catalog_revision(store) != retrieval["catalog_revision"]:
                    raise CatalogChangedError()
        value["retrieval"] = retrieval
    return {**value, "snapshot_revision": canonical_json_hash(value)}
