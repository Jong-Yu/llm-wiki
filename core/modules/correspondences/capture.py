"""같은 tenant 잠금 안에서 원문·그래프·원장과 실제 의존 closure를 캡처한다.

owner는 공용 Store의 저장소·actor·같은 잠금 안의 협력 메서드만 전달한다.
파일 I/O와 잠금의 경계는 기존 호출 순서를 유지한다.
"""

# _Capture는 한 대응을 판단하는 데 필요한 문서·그래프·검토·다른 대응을 묶어 읽는다.
# collect가 참조를 따라가며 근거 목록을 만든다. 누락/순환/한도도 결과에 남겨 의존 자료가 없는 상황을 숨기지 않는다.

from . import contracts as limits
from . import schema
from .contracts import CorrespondenceCorruptError
from .contracts import CorrespondenceLimitError
from .contracts import CorrespondenceValidationError
from .state import _manifest
from .state import _states
from .state import _values
from copy import deepcopy
from core.common.json_codec import canonical_json_hash as _hash
from core.modules.ontology.snapshots import _stored_graph
from core.modules.documents.store import MAX_DOCUMENT_BYTES
from datetime import datetime, timezone
from hashlib import sha256
import os
import stat


class _Capture:
    """한 대응의 의존 자료와 탐색 상태를 모은다. 다른 시작 대응의 탐색 상태와 섞지 않는다."""
    def __init__(self, owner, *, application_context=None, as_of=None, byte_limit=None):
        self.owner = owner
        self.raw = {}
        self.docs = {}
        self.ledgers = {}
        self.closure_cache = {}
        self.total_bytes = 0
        self.byte_limit = limits.MAX_CAPTURE_BYTES if byte_limit is None else byte_limit
        self.application_context = owner._application_context(application_context)
        self.at = datetime.now(timezone.utc) if as_of is None else schema.instant(as_of, "as_of")

    def read(self, path, limit, *, corrupt=CorrespondenceCorruptError):
        # 원래 바이트를 크기 한도 안에서 읽고 같은 요청의 캐시에 둔다. 실제 근거가 바뀐 것을 옛 캐시로 숨기지 않도록 요청마다 객체를 만든다.
        key = str(path)
        if key in self.raw:
            return self.raw[key]
        self.owner.store._check_path(path)
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            self.raw[key] = None
            return None
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise corrupt("Dependency must be a regular file")
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = None
                raw = stream.read(min(limit, self.byte_limit - self.total_bytes) + 1)
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if len(raw) > limit:
            raise corrupt("Stored component exceeds its byte limit")
        if self.total_bytes + len(raw) > self.byte_limit:
            raise CorrespondenceLimitError("Dependency capture exceeds its byte budget")
        self.total_bytes += len(raw)
        self.raw[key] = raw
        return raw

    def ledger(self, cid):
        if cid not in self.ledgers:
            raw = self.read(self.owner._path(cid), limits.MAX_CORRESPONDENCE_BYTES)
            self.ledgers[cid] = (raw, None if raw is None else self.owner._ledger(raw, cid))
        return self.ledgers[cid]

    def document(self, document, full=False):
        owner = self.owner
        path = owner.store._document_path(owner.store.wiki_dir, document)
        if document not in self.docs:
            if len(self.docs) >= limits.MAX_DEPENDENCY_DOCUMENTS:
                raise CorrespondenceLimitError("Dependency closure exceeds eight documents")
            raw = self.read(path, MAX_DOCUMENT_BYTES)
            content = None if raw is None else raw.decode("utf-8")
            history = owner.reviews._history_revision(document)
            self.docs[document] = {"raw": raw, "content": content,
                "row": {"document": document, "source_revision": None if raw is None else sha256(raw).hexdigest(), "history_revision": history, "status": "missing" if raw is None else "ready"}}
        result = self.docs[document]
        if full and "full" not in result:
            from core.modules.ontology.errors import OntologyCorruptError
            from core.modules.ontology import constants as ontology_limits
            from core.modules.reviews.contracts import ReviewCorruptError, MAX_REVIEW_BYTES
            graph_raw = self.read(owner.ontology._path(document), ontology_limits.MAX_ONTOLOGY_BYTES, corrupt=OntologyCorruptError)
            review_raw = self.read(owner.reviews._path(document), MAX_REVIEW_BYTES, corrupt=ReviewCorruptError)
            # Parse even stale dependencies; malformed histories are never missing.
            if graph_raw is not None:
                _stored_graph(graph_raw, document)
            owner.reviews._ledger(review_raw, document)
            base = result["row"]
            tokens = {"document": document, "source_revision": base["source_revision"], "graph_revision": None if graph_raw is None else sha256(graph_raw).hexdigest(), "review_revision": None if review_raw is None else sha256(review_raw).hexdigest(), "history_revision": base["history_revision"]}
            tokens["state_revision"] = _hash(tokens)
            snapshot = None
            if result["raw"] is not None:
                from core.modules.documents.store import DocumentSnapshot
                source = DocumentSnapshot(result["content"], base["source_revision"])
                snapshot = owner.reviews._query_captured(document, source, graph_raw, review_raw, base["history_revision"], domain=owner.actor["domain"], viewpoint=owner.actor["viewpoint"])
                if snapshot["status"] == "unavailable":
                    raise OntologyCorruptError("Referenced ontology is corrupt")
            status = "missing" if graph_raw is None else "stale" if snapshot is None else snapshot["status"]
            result.update(full={**base, **{k: tokens[k] for k in ("graph_revision", "review_revision", "state_revision")}, "graph_status": status, "references": []}, snapshot=snapshot)
        return result

    def collect(self, values, root, stack=None, reached=None):
        # 대응이 실제로 참조한 문서/대응을 따라가 의존 manifest를 만든다. 순환 경로와 누락을 확인한다.
        stack = [root] if stack is None else stack
        reached = set() if reached is None else reached
        cache_key = (root, tuple(stack), _hash(values))
        if cache_key in self.closure_cache:
            cached = self.closure_cache[cache_key]
            reached.update(row["correspondence_id"] for row in cached["correspondences"])
            if len(reached) > limits.MAX_DEPENDENCY_CORRESPONDENCES:
                raise CorrespondenceLimitError("Correspondence closure exceeds eight other ledgers")
            return deepcopy(cached)
        sources, full, references = set(), set(), []
        document_refs = []
        for value in values:
            if value is None:
                continue
            anchors = [value["condition"], value["concept"], *value["basis"]["link_evidence"]]
            for anchor in anchors:
                sources.add(anchor["document"])
                if "graph_ref" in anchor:
                    full.add(anchor["document"])
                    document_refs.append({"kind": "graph", "document": anchor["document"], "graph_ref": anchor["graph_ref"]})
            for ref in value["references"]:
                if ref["kind"] == "correspondence":
                    references.append(ref)
                else:
                    sources.add(ref["document"])
                    full.add(ref["document"])
                    document_refs.append(ref)
        doc_rows = {doc: deepcopy(self.document(doc, doc in full)["full" if doc in full else "row"]) for doc in sorted(sources)}
        for ref in document_refs:
            captured = self.document(ref["document"], True)
            snapshot = captured["snapshot"]
            state = "missing"
            if snapshot is not None:
                if ref["kind"] == "graph":
                    graph_ref = ref["graph_ref"]
                    graph = snapshot["machine_graph"]
                    if graph_ref["collection"] == "entities":
                        entities = list(graph["entities"])
                        if graph_ref["layer"] == "reviewed":
                            entities.extend(entity for policy in snapshot.get("policies", []) for entity in policy.get("entities", []))
                        candidates = [entity for entity in entities if entity["id"] == graph_ref["entity_id"]]
                    else:
                        claims = [claim for claim in snapshot["claims"] if claim["claim_id"] == graph_ref["claim_id"] and claim["collection"] == graph_ref["collection"]]
                        if graph_ref["layer"] == "machine":
                            candidates = [claim["value"] for claim in claims]
                        else:
                            candidates = [claim.get("source_reviewed_value", claim["reviewed_value"]) for claim in claims if claim.get("source_decision", claim["decision"]) not in {"reject", "defer"}]
                            # Enumerate preserved exact policy scopes, rather than
                            # deriving structural state from the query profile.
                            candidates.extend(policy["value"] for policy in snapshot.get("policies", []) if policy["claim_id"] == graph_ref["claim_id"] and policy["collection"] == graph_ref["collection"] and policy["status"] in {"active", "other_scope"})
                    state = "changed" if snapshot["status"] != "ready" else "missing" if not candidates else "ready" if any(candidate == graph_ref["snapshot"] for candidate in candidates) else "changed"
                else:
                    event = next((event for event in snapshot["history"] if event["id"] == ref["event_id"]), None)
                    state = "missing" if event is None else "ready" if event["after"] == ref["snapshot"] else "changed"
            entry = {"key": _hash(ref), "status": state}
            if entry not in doc_rows[ref["document"]]["references"]:
                doc_rows[ref["document"]]["references"].append(entry)
        for doc_row in doc_rows.values():
            if "references" in doc_row:
                doc_row["references"].sort(key=lambda item: item["key"])
        corr_rows = {}
        references = list({_hash(ref): ref for ref in references}.values())
        for ref in references:
            cid = ref["correspondence_id"]
            if cid in stack:
                raise CorrespondenceValidationError("Correspondence dependency cycles are forbidden")
            if len(stack) > limits.MAX_REFERENCE_DEPTH:
                raise CorrespondenceLimitError("Correspondence reference depth exceeds four")
            reached.add(cid)
            if len(reached) > limits.MAX_DEPENDENCY_CORRESPONDENCES:
                raise CorrespondenceLimitError("Correspondence closure exceeds eight other ledgers")
            raw, ledger = self.ledger(cid)
            if ledger is None:
                row = {"correspondence_id": cid, "correspondence_revision": None, "dependencies_digest": None, "status": "missing", "references": []}
                status, current_id = "missing", None
            else:
                states = _states(ledger)
                deps = self.collect(_values(states), root, [*stack, cid], reached)
                for docrow in deps["documents"]:
                    old = doc_rows.get(docrow["document"])
                    if old is None or "graph_revision" in docrow:
                        replacement = deepcopy(docrow)
                        if old is not None and "references" in old and "references" in replacement:
                            replacement["references"] = sorted({item["key"]: item for item in [*old["references"], *replacement["references"]]}.values(), key=lambda item: item["key"])
                        doc_rows[docrow["document"]] = replacement
                for crow in deps["correspondences"]:
                    self._merge_corr(corr_rows, crow)
                row = {"correspondence_id": cid, "correspondence_revision": sha256(raw).hexdigest(), "dependencies_digest": _hash(deps), "status": "ready", "references": []}
                event = next((event for event in ledger["events"] if event["id"] == ref["event_id"]), None)
                current = None if event is None else states.get((event["lane"], event["judgment_id"]))
                current_id = None if current is None else current["id"]
                status = "missing" if event is None else "needs_review" if current_id != event["id"] else self.owner._structural_applicability(event["after"], self.collect([event["after"]["value"]], root, [*stack, cid], reached))[0]
            row["references"].append({"event_id": ref["event_id"], "current_event_id": current_id, "status": status})
            self._merge_corr(corr_rows, row)
        manifest = {"documents": [doc_rows[key] for key in sorted(doc_rows)], "correspondences": [corr_rows[key] for key in sorted(corr_rows)]}
        _manifest(manifest)
        self.closure_cache[cache_key] = deepcopy(manifest)
        return manifest

    @staticmethod
    def _merge_corr(rows, row):
        cid = row["correspondence_id"]
        if cid not in rows:
            rows[cid] = deepcopy(row)
        else:
            for reference in row["references"]:
                if reference not in rows[cid]["references"]:
                    rows[cid]["references"].append(deepcopy(reference))
        rows[cid]["references"].sort(key=lambda item: item["event_id"])
