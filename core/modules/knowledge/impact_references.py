"""현재/과거 개체 출처를 보존하고 이름·유형 일치를 후보로만 계산한다."""

# collect_references는 현재/과거 개체의 정확한 출처를 모으고 collect_candidates는 이름·유형 일치를 찾는다.
# 후자는 공통 개념 후보일 뿐 같은 실체·의미 의존·수정 필요가 확정됐다는 뜻은 아니다.

from core.modules.ontology.errors import OntologyCorruptError
from core.modules.ontology.validation import _graph
from core.common.json_codec import canonical_json_hash as _hash
from core.modules.reviews.values import _input
from core.modules.ontology.connections import _normalized_label
from core.modules.ontology.snapshots import _query_snapshot
from .impact_history import _review_prefix
from . import contracts
from copy import deepcopy


def collect_references(ctx):
    """기계/정책/과거 이벤트의 출처와 적용 관점을 각각 유지한다."""
    # 문서별 현재/과거 개체와 인용 출처를 보존한다. 다른 판본의 근거를 한 인용처럼 섞지 않는다.
    ctx.references = {name: [] for name in ctx.sources}
    ctx.reference_keys = {name: set() for name in ctx.sources}

    def add_entity(name, entity, source_revision, graph_revision, origin, *, event_id=None, phase=None, claim_id=None, scope=None):
        if len(ctx.references[name]) >= contracts.MAX_IMPACT_ENTITY_REFERENCES:
            ctx.skip(name, "entity_reference_budget", "concepts")
            return
        item = {"document": name, "source_revision": source_revision, "graph_revision": graph_revision,
                **deepcopy(entity), "origin": origin,
                "reference_status": "historical_action" if origin in {"expert_event", "review_source_snapshot", "authored_relation_event"}
                    else "historical_source" if origin == "baseline_graph" else "current_snapshot"}
        if event_id is not None:
            item.update(event_id=event_id, phase=phase, claim_id=claim_id, decision_scope=deepcopy(scope))
        key = _hash(item)
        if key not in ctx.reference_keys[name]:
            ctx.reference_keys[name].add(key)
            ctx.references[name].append(item)

    for name, graph in ctx.captured["graphs"].items():
        for entity in graph["entities"]:
            add_entity(name, entity, graph["source_revision"], ctx.states[name]["graph_revision"], "machine")
        reviewed = ctx.review_snapshots.get(name)
        if reviewed is not None:
            for entity in reviewed["effective_graph"]["entities"]:
                if entity.get("provenance", {}).get("kind") == "expert_policy":
                    add_entity(name, entity, graph["source_revision"], ctx.states[name]["graph_revision"], "expert_policy",
                               event_id=entity["provenance"]["event_id"], phase="current",
                               scope={"domain": ctx.domain, "viewpoint": ctx.viewpoint})

    if ctx.baseline is not None:
        if ctx.baseline["graph_revision"] is None:
            ctx.restoration["graph"] = "absent_at_baseline"
        elif ctx.baseline["graph_revision"] == ctx.root["graph_revision"] and ctx.old_source is not None and ctx.document in ctx.raw_graphs:
            try:
                old_graph = _query_snapshot(ctx.document, ctx.old_source, ctx.raw_graphs[ctx.document])
                if old_graph["status"] != "ready":
                    raise OntologyCorruptError("Baseline graph does not belong to the recovered source")
                ctx.restoration["graph"] = "validated_matching_cache"
                if ctx.old_source.revision != ctx.sources[ctx.document].revision:
                    for entity in old_graph["entities"]:
                        add_entity(ctx.document, entity, ctx.old_source.revision, ctx.baseline["graph_revision"], "baseline_graph")
            except (ValueError, TypeError):
                ctx.restoration["graph"] = "unavailable"
                ctx.skip(ctx.document, "baseline_graph_unverified", "baseline_graph", omitted=False)
        else:
            ctx.restoration["graph"] = "unavailable"
            ctx.skip(ctx.document, "previous_graph_not_preserved", "baseline_graph", omitted=False)

        ledger = ctx.ledgers.get(ctx.document)
        cutoff = None if ledger is None else _review_prefix(ledger, ctx.baseline["review_revision"])
        ctx.restoration["review"] = "matched_event_prefix" if cutoff is not None else "unavailable"
        if cutoff is None:
            ctx.skip(ctx.document, "baseline_review_unverified", "baseline_review", omitted=False)
        if ledger is not None and ctx.changes["review"]:
            for event in ledger["events"][0 if cutoff is None else cutoff:]:
                if "scope" in event and event["scope"] != {"domain": ctx.domain, "viewpoint": ctx.viewpoint}:
                    continue  # Preserve in the ledger; do not imply this view changed.
                source_for_event = next((source for source in (ctx.sources[ctx.document], ctx.old_source)
                                         if source is not None and source.revision == event["source_revision"]), None)
                source_entities = event["target"]["entities"]
                verified = False
                if source_for_event is not None:
                    # 과거 이벤트에는 추출 envelope가 없을 수 있다. 두 근거 범위의
                    # 실제 전체파일 위치 중 정확히 일치하는 것만 복원으로 인정한다.
                    for body_only in (False, True):
                        try:
                            check = _graph(ctx.document, source_for_event.revision, _input(source_entities), [],
                                           source_for_event.content, schema_version=3, body_only=body_only)
                            verified = check["entities"] == source_entities
                        except (ValueError, TypeError):
                            continue
                        if verified:
                            break
                if verified:
                    for entity in source_entities:
                        add_entity(ctx.document, entity, event["source_revision"], event["graph_revision"], "review_source_snapshot",
                                   event_id=event["id"], phase="target_before_after", claim_id=event["claim_id"], scope=event.get("scope"))
                elif source_entities:
                    ctx.skip(ctx.document, "event_source_unverified", "review_history", omitted=False)
                for phase in ("before", "after"):
                    for entity in event[phase].get("entities", []):
                        add_entity(ctx.document, entity, event["source_revision"], event["graph_revision"], "expert_event",
                                   event_id=event["id"], phase=phase, claim_id=event["claim_id"], scope=event.get("scope"))
        if ledger is not None and ctx.changes["review"] and ledger.get("relation_events"):
            # 원문/기계층을 바꾸지 않은 추가·되돌림도 관련 개체의 변경 후보로 표시한다.
            # 기존 prefix 반환은 검토 events의 위치이므로 추가 원장은 보수적으로 모두 대조한다.
            ctx.restoration["limits"].append("authored_relation_events_include_baseline_history")
            for event in ledger["relation_events"]:
                if event["kind"] == "policy" and event["scope"] != {"domain": ctx.domain, "viewpoint": ctx.viewpoint}:
                    continue
                source_for_event = next((source for source in (ctx.sources[ctx.document], ctx.old_source)
                                         if source is not None and source.revision == event["source_revision"]), None)
                verified = False
                if source_for_event is not None:
                    for body_only in (False, True):
                        try:
                            check = _graph(ctx.document, source_for_event.revision, _input(event["entities"]), [],
                                           source_for_event.content, schema_version=3, body_only=body_only)
                            verified = check["entities"] == event["entities"]
                        except (ValueError, TypeError):
                            continue
                        if verified:
                            break
                if verified:
                    for entity in event["entities"]:
                        add_entity(ctx.document, entity, event["source_revision"], event["graph_revision"], "authored_relation_event",
                                   event_id=event["id"], claim_id=event["claim_id"], scope=event["scope"])
                else:
                    ctx.skip(ctx.document, "event_source_unverified", "relation_history", omitted=False)
        ctx.restoration["complete"] = all(ctx.restoration[name] != "unavailable" for name in ("source", "graph", "review"))

def collect_candidates(ctx):
    """타입/정규화 이름 일치는 동일성이나 의미 의존의 증거가 아니다."""
    # 이름·유형 일치만 후보로 만든다. 후보를 실제 동일 개체나 확정된 수정 대상으로 승격하지 않는다.
    index = {}
    for name, items in ctx.references.items():
        if name != ctx.document:
            for item in items:
                index.setdefault((item["type"], _normalized_label(item["label"])), []).append(item)
    ctx.candidates = []
    candidate_pairs = set()
    candidate_overflow = False
    for entity in ctx.references[ctx.document]:
        for target in index.get((entity["type"], _normalized_label(entity["label"])), []):
            key = (_hash(entity), _hash(target))
            if key in candidate_pairs:
                continue
            candidate_pairs.add(key)
            if len(ctx.candidates) >= contracts.MAX_CONNECTION_LIMIT:
                ctx.skip(ctx.document, "candidate_budget", "concepts")
                candidate_overflow = True
                break
            ctx.candidates.append({"status": "candidate", "reason": "same_type_and_normalized_label",
                               "source_entity": entity, "target_entity": target,
                               "identity_confirmed": False, "dependency_confirmed": False, "current_fact": False})
        if candidate_overflow:
            break
