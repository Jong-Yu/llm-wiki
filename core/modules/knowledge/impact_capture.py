"""연결 캡처의 남은 예산으로 전체 history와 검토 상태를 같은 잠금 안에서 읽는다."""

# 영향 조회의 현재 상태와 history를 남은 읽기 예산 안에서 캡처한다.
# compare는 baseline과 현재 버전을 비교한다. 버전 차이는 변경 관측이며 연결된 주장의 의미 오류 확정은 아니다.

from core.modules.ontology.errors import OntologyCorruptError
from core.modules.reviews.contracts import ReviewCorruptError
from core.modules.ontology.errors import _ContextBudgetError
from core.modules.ontology.errors import _connection_error
from core.common.json_codec import canonical_json_hash as _hash
from . import contracts
import os
from hashlib import sha256


def initialize(ctx):
    """연결이 소비한 바이트/탐색 수를 이어받아 중복 예산을 허용하지 않는다."""
    ctx.connections, ctx.captured = ctx.owner.ontology._connections_snapshot_locked(
        ctx.document, contracts.MAX_CONNECTION_LIMIT, capture_validated=True)
    ctx.sources, ctx.raw_graphs = ctx.captured["sources"], ctx.captured["raw_graphs"]
    ctx.remaining = [contracts.MAX_CONNECTION_BYTES - ctx.captured["captured_bytes"]]
    ctx.entry_budget = [contracts.MAX_CONNECTION_SCAN_ENTRIES - ctx.captured["scan_entries"]]
    ctx.skipped = [{**item, "component": "connections"} for item in ctx.connections["skipped"]]
    ctx.incomplete = bool(ctx.connections["truncated"])
    ctx.truncated = bool(ctx.connections["truncated"])
    if not ctx.captured["scan_complete"]:
        ctx.skipped.append({"document": ctx.document, "component": "scan", "code": "scan_incomplete"})

def skip(ctx, name, code, component, *, omitted=True):
    ctx.incomplete = True
    ctx.truncated = ctx.truncated or omitted
    item = {"document": name, "component": component, "code": code}
    if item not in ctx.skipped and len(ctx.skipped) < contracts.MAX_CONNECTION_DOCUMENTS:
        ctx.skipped.append(item)

def history_entries(ctx, name):
    try:
        path = ctx.owner.store._document_path(ctx.owner.store.history_dir, name)
        names = []
        with os.scandir(path) as entries:
            for entry in entries:
                if ctx.entry_budget[0] <= 0:
                    ctx.skip(name, "entry_budget", "history")
                    return names, None
                ctx.entry_budget[0] -= 1
                if not entry.is_file(follow_symlinks=False):
                    ctx.skip(name, "history_not_regular", "history")
                    return names, None
                names.append(entry.name)
        return sorted(names), _hash(sorted(names))
    except FileNotFoundError:
        return [], _hash([])
    except (OSError, ValueError, TypeError) as error:
        ctx.skip(name, _connection_error(error), "history")
        return [], None

def capture_states(ctx):
    """문서별 현재 검토 상태를 캡처하며 손상과 읽기 실패를 구분한다."""
    # 같은 잠금의 원문/그래프 관측에 검토/전체 이력을 추가해 현재 상태를 묶는다.
    ctx.states, ctx.review_snapshots, ctx.ledgers, ctx.history_names = {}, {}, {}, {}
    ctx.known_states = {item["document"]: item for item in ctx.connections["ontology_states"]}
    for name, source in ctx.sources.items():
        raw = ctx.raw_graphs.get(name)
        graph_available = name not in ctx.captured["graph_errors"]
        graph_state = ctx.known_states[name]
        state = {"document": name, "source_revision": source.revision,
                 "source_status": "available",
                 "graph_revision": sha256(raw).hexdigest() if raw is not None else None,
                 "review_revision": None, "history_revision": None, "state_revision": None,
                 "ontology_status": graph_state["status"], "review_status": "unavailable",
                 "policy_pending": False, "needs_review": graph_state["status"] != "ready",
                 "reasons": [], "state_available": False}
        names, history_revision = ctx.history_entries(name)
        ctx.history_names[name] = names
        state["history_revision"] = history_revision
        try:
            raw_review = ctx.owner.ontology._context_bytes(ctx.owner.reviews._path(name), ctx.remaining, name, "ontology", max_bytes=contracts.MAX_REVIEW_BYTES)
            state["review_revision"] = sha256(raw_review).hexdigest() if raw_review is not None else None
            ledger, validated = ctx.owner.reviews._captured_ledger(name, source, raw, raw_review, history_revision,
                machine=ctx.captured.get("validated_graphs", {}).get(name))
            ctx.ledgers[name] = ledger
            if history_revision is not None and graph_available:
                reviewed = ctx.owner.reviews._query_captured(name, source, raw, raw_review, history_revision,
                    domain=ctx.domain, viewpoint=ctx.viewpoint, validated_capture=validated)
                ctx.review_snapshots[name] = reviewed
                state.update(state_revision=reviewed["state_revision"], state_available=True,
                             review_status="pending" if reviewed["pending_history"] else "available",
                             policy_pending=any(item["status"] == "pending" for item in reviewed.get("policies", [])),
                             needs_review=reviewed["needs_review"])
            else:
                ctx.skip(name, "state_unavailable", "review", omitted=False)
        except (OSError, ValueError, TypeError) as error:
            code = "byte_budget" if isinstance(error, _ContextBudgetError) else "review_corrupt" if isinstance(error, (ReviewCorruptError, OntologyCorruptError)) else _connection_error(error)
            state["review_status"] = "corrupt" if code == "review_corrupt" else "unavailable"
            ctx.ledgers.pop(name, None)
            ctx.skip(name, code, "review")
        if graph_state["status"] != "ready" or graph_state.get("needs_reextraction"):
            state["reasons"].append("ontology_" + graph_state["status"] if graph_state["status"] != "ready" else "needs_reextraction")
            ctx.skip(name, state["reasons"][-1], "ontology", omitted=False)
        if state["review_status"] != "available":
            state["reasons"].append("review_" + state["review_status"])
            ctx.skip(name, state["reasons"][-1], "review", omitted=False)
        ctx.states[name] = state

def compare(ctx):
    """관측 가능한 revision만 기준과 비교하고 복원 상태를 초기화한다."""
    # baseline이 있을 때만 이전/현재 버전을 대조한다. 기준이 없으면 바뀌었다는 결론을 만들지 않는다.
    ctx.root = ctx.states[ctx.document]
    ctx.current = {key: ctx.root[key] for key in contracts._BASELINE_FIELDS}
    ctx.changes = {name.removesuffix("_revision"): None if ctx.baseline is None or (name == "history_revision" and ctx.current[name] is None)
               or (name == "review_revision" and ctx.root["review_status"] in {"corrupt", "unavailable"})
               or (name == "graph_revision" and ctx.document in ctx.captured["graph_errors"])
               else ctx.baseline[name] != ctx.current[name] for name in contracts._BASELINE_FIELDS}
    ctx.restoration = {"source": "not_requested", "graph": "not_requested", "review": "not_requested",
                   "complete": ctx.baseline is None, "limits": ["past_incoming_links_not_restored", "no_semantic_dependency_proof"]}
    ctx.old_source = None
