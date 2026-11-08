"""같은 요청 캡처에서 원문·그래프·검토 원장의 일관된 문서 상태를 계산한다."""

# document가 한 문서의 원문·그래프·검토를 묶어 조합하는 입구다.
# full=False면 원문 앵커 확인에 필요한 범위만, full=True면 실제 그래프와 검토 상태도 확인한다.

from core.modules.documents.store import DocumentSnapshot
from core.modules.ontology.storage import source_fields
from .capture_errors import _empty_graph
from core.common.json_codec import canonical_json_hash as _hash
from core.modules.ontology.snapshots import _query_snapshot
from core.modules.ontology.snapshots import _stored_graph
from copy import deepcopy
from hashlib import sha256


def document_raw(self, document):
    return {name: self.raw.get((kind, document)) for name, kind in (("source", "source"), ("graph", "graph"), ("review", "review"))}

def document_ledger(self, document):
    return deepcopy(self._parsed_reviews.get(document))

def document(self, document, purpose="content", required_by=None, *, root=False, full=True):
    """캡처한 원문·그래프·원장을 함께 평가한다. 빠진 의존 자료를 현재 사실로 메우지 않는다."""
    # root는 명시 조회 대상 여부, full은 그래프/검토까지 읽을지 나타낸다. 읽기 실패도 해당 구성의 상태로 남긴다.
    self.store._document_path(self.store.wiki_dir, document)
    source = None
    try:
        raw_source = self._read("source", document, purpose, required_by)
        if raw_source is None:
            self._skip("source", document, reason="not_found")
            if root:
                raise FileNotFoundError(document)
        else:
            try:
                source = DocumentSnapshot(raw_source.decode("utf-8"), sha256(raw_source).hexdigest())
            except UnicodeError as error:
                self._validated_error("source", document, error)
                raise
    except (OSError, ValueError, TypeError):
        if root:
            raise
    history = None
    try:
        history = self._history_capture(document, purpose, required_by)
    except (OSError, ValueError, TypeError):
        pass
    graph_raw = review_raw = None
    ledger = None
    machine = _empty_graph(document, None if source is None else source.revision)
    graph_read_ok = review_ok = False
    if full:
        try:
            graph_raw = self._read("graph", document, purpose, required_by)
            graph_read_ok = True
            if graph_raw is not None:
                _stored_graph(graph_raw, document)
            if source is not None:
                machine = _query_snapshot(document, source, graph_raw)
                self._rows[("graph", document)]["status"] = machine["status"]
                if machine["status"] != "ready" or machine.get("needs_reextraction", False):
                    self._skip("graph", document, reason="ontology_" + machine["status"] if machine["status"] != "ready" else "needs_reextraction", phase="validation")
            elif graph_raw is None:
                machine = _empty_graph(document, None, "missing")
            else:
                machine = _empty_graph(document, None, "stale")
        except (OSError, ValueError, TypeError) as error:
            if ("graph", document) not in self.errors:
                self._validated_error("graph", document, error)
            machine = _empty_graph(document, None if source is None else source.revision)
        try:
            review_raw = self._read("review", document, purpose, required_by)
            ledger = self._parsed_reviews.get(document)
            if ledger is None:
                ledger = self.reviews._ledger(review_raw, document)
                self._parsed_reviews[document] = ledger
            review_ok = True
        except (OSError, ValueError, TypeError) as error:
            if ("review", document) not in self.errors:
                self._validated_error("review", document, error)
    snapshot = None
    if full and source is not None and history is not None and graph_read_ok and review_ok:
        try:
            snapshot = self.reviews._query_captured(document, source, graph_raw, review_raw, history["revision"],
                                  domain=self.actor["domain"], viewpoint=self.actor["viewpoint"])
        except (OSError, ValueError, TypeError) as error:
            self._validated_error("review", document, error)
    tokens = {"document": document,
              "source_revision": None if source is None else source.revision,
              "history_revision": None if history is None else history["revision"],
              "graph_revision": self._component("graph", document)["revision"] if full else None,
              "review_revision": self._component("review", document)["revision"] if full else None,
              "state_revision": None if snapshot is None else snapshot["state_revision"]}
    source_entry = None if source is None else {"content": source.content, "revision": source.revision,
        **source_fields(source.content, include_body=True),
        "line_start": 1 if source.content else 0,
        "line_end": len(source.content.splitlines())}
    graph_valid = full and ("graph", document) not in self.errors and machine["status"] == "ready" and not machine.get("needs_reextraction", False)
    effective_available = graph_valid and snapshot is not None and ("review", document) not in self.errors
    entry = {**tokens, "tokens": deepcopy(tokens), "source": source_entry,
             "content": None if source is None else source.content,
             "machine_graph": machine if full else None,
             "effective_graph": deepcopy(snapshot["effective_graph"]) if effective_available else None,
             "claims": [] if snapshot is None else deepcopy(snapshot.get("current_claims", snapshot["claims"])),
             "cleanup": {} if snapshot is None else deepcopy(snapshot.get("cleanup", {})),
             "policies": [] if snapshot is None else deepcopy(snapshot.get("policies", [])),
             "history": [] if ledger is None else deepcopy(ledger["events"]),
             "ledger": deepcopy(ledger),
             "pending_history": [] if snapshot is None else deepcopy(snapshot.get("current_pending_history", snapshot["pending_history"])),
             "snapshot": deepcopy(snapshot),
             "components": {kind: self._component(kind, document) if full or kind in {"source", "history"} else {"status": "not_requested", "revision": None, "captured_bytes": 0} for kind in ("source", "graph", "review", "history")},
             "policy_evaluation": {"status": "ready" if effective_available else "not_requested" if not full else "unavailable"},
             "complete": source is not None and history is not None and (not full or effective_available)}
    return entry

def _dependency_document(self, document, full, purpose, required_by):
    # 참조에 필요한 구성만 요청한다. 원문 앵커만 필요한 읽기를 무관한 그래프 손상 때문에 실패시키지 않는다.
    entry = self.document(document, purpose, required_by, full=full)
    for kind in (("source", "history", "graph", "review") if full else ("source", "history")):
        error = self.errors.get((kind, document))
        if error is not None:
            raise error
    base = {"document": document, "source_revision": entry["source_revision"],
            "history_revision": entry["history_revision"], "status": "missing" if entry["source"] is None else "ready"}
    result = {"raw": self.raw.get(("source", document)), "content": entry["content"], "row": base}
    if full:
        result.update(full={**base, "graph_revision": entry["graph_revision"], "review_revision": entry["review_revision"],
                           "state_revision": entry["state_revision"] or _hash({key: entry[key] for key in ("document", "source_revision", "graph_revision", "review_revision", "history_revision")}),
                           "graph_status": entry["machine_graph"]["status"], "references": []},
                      snapshot=entry["snapshot"])
    return result
