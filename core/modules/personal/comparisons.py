"""저장된 추출의 제한된 검색·대조를 기존 개인 원장에 기록한다.

검색·인용·판본은 서버가 확인하고 관련성은 클라이언트 AI의 미확정 판단으로
보존한다. 원문·그래프·전문가 원장을 변경하지 않는다.
"""

import base64
from copy import deepcopy
from hashlib import sha256
import json
import math
from core.common.access import access_dict, access_basis
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.analysis_inputs.files import document_revision
from core.modules.analysis_jobs.store import JobStore
from core.modules.access.policy import AccessDenied
from core.modules.personal.store import PersonalStore, PersonalConflictError, PersonalLimitError
from core.modules.knowledge.concepts import ConceptStore
from core.modules.reviews.store import ReviewStore

KIND = "knowledge-comparisons"
MAX_STEPS = 5
MAX_MATCHES = 20
MAX_STEP_BYTES = 120 * 1024
REVISION_FIELDS = ("source_revision", "graph_revision", "state_revision", "history_revision")


def _text(value, maximum=2000):
    if type(value) is not str or not 1 <= len(value) <= maximum:
        raise ValueError("A bounded nonempty string is required")
    return value


def _strings(value):
    """추출에 실제 존재하는 표현만 검색 재료로 읽으며 동의어를 생성하지 않는다."""
    if isinstance(value, str):
        yield value
    elif type(value) in {int, float} and (type(value) is int or math.isfinite(value)):
        yield json.dumps(value, ensure_ascii=False)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key not in {"id", "evidence", "provenance", "context", "subject", "object", "entity"}:
                yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def seed_terms(graph):
    """이름·술어·속성·조건의 원래 표현을 제한된 첫 검색에 사용한다."""
    values = [item.get("label", "") for item in graph.get("entities", [])]
    for collection in ("relations", "attributes", "relation_candidates"):
        values.extend(_strings(graph.get(collection, [])))
    terms = list(dict.fromkeys(value for value in values if isinstance(value, str) and 0 < len(value) <= 200))
    return terms[:12], len(terms) > 12


def _target(match):
    target = deepcopy(match["target_ref"])
    # 같은 주장 안의 속성 검색 위치만 다르면 같은 판본의 같은 항목이다.
    target.pop("selector", None)
    return target


def _references(record):
    refs = {}
    for event in record["events"]:
        if event.get("kind") == "lookup":
            for item in event["result"].get("matches", []):
                refs[item["reference_id"]] = item
    return refs


def _state(record):
    results = [event for event in record["events"] if event.get("kind") == "result"]
    return results[-1]["status"] if results else "running"


def _encode_cursor(item):
    # 마지막으로 준 항목의 생성 시각과 ID만 담는다. 권한 판단에는 쓰이지 않는다.
    raw = json.dumps({"c": item["created_at"], "i": item["id"]}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _decode_cursor(cursor):
    if cursor is None:
        return None
    try:
        value = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True))
        if type(value) is not dict or set(value) != {"c", "i"} or type(value["c"]) is not str or type(value["i"]) is not str:
            raise ValueError()
    except (ValueError, TypeError, RecursionError):
        raise ValueError("Invalid comparison cursor") from None
    return (value["c"], value["i"])


class ComparisonStore:
    """인가된 사용자 한 명의 비교 실행·조회 이력·후보를 보존한다."""

    def __init__(self, scope):
        self.scope, self.personal = scope, PersonalStore(scope)
        self.actor, self.store = access_dict(scope), scope.store
        self.concepts = ConceptStore(scope.store, actor=self.actor)
        self.reviews = ReviewStore(scope.store)

    def _knowledge(self, document):
        return self.reviews.query(document, domain=self.scope.domain, viewpoint=self.scope.viewpoint)

    def _scope(self, record):
        actor = deepcopy(record["actor"])
        if actor.get("access_revision"):
            actor.pop("policy_revision", None)
        if actor != access_basis(self.scope):
            raise AccessDenied()

    def _fresh(self, record):
        self._scope(record)
        basis = record["data"]["basis"]
        current = self._knowledge(basis["document"])
        if any(current.get(key) != basis.get(key) for key in REVISION_FIELDS):
            raise PersonalConflictError()

    def _arguments(self):
        return {"tenant": self.scope.tenant, "policy_revision": self.scope.policy_revision,
                "profile": {key: self.actor[key] for key in ("profile_id", "domain", "viewpoint")}}

    def _target_input(self, record):
        """재대조는 이전 대화의 기억 대신 현재 고정 판본의 전체 원문·판단을 받는다."""
        self._scope(record)
        basis = record["data"]["basis"]
        current = self._knowledge(basis["document"])
        if any(current.get(key) != basis.get(key) for key in REVISION_FIELDS):
            raise PersonalConflictError()
        return {"basis": deepcopy(basis),
                "source": {"document": basis["document"], "revision": basis["source_revision"],
                           "content": document_revision(self.store, basis["document"], basis["source_revision"])},
                "entities": current["machine_graph"]["entities"], "claims": current["claims"],
                "policies": current.get("policies", []), "authored_relations": current.get("authored_relations", []),
                "pending_history": current.get("pending_history", []),
                "history_projection": "current_judgments_only", "replaces_prior_session_memory": True}

    def _currentness(self, record):
        """현재 참조와의 차이만 표시하고 이전 후보나 원문을 갱신하지 않는다."""
        documents, changed, unavailable = {}, [], []
        refs = [record["data"]["basis"]]
        for match in _references(record).values():
            target = match["target_ref"]
            if target["kind"] == "anchor":
                refs.append({"document": target["anchor"]["document"], **target["observation"]})
            elif "document" in target:
                refs.append(target)
            elif target["kind"] == "correspondence_endpoint":
                try:
                    current = self.concepts.correspondences.query(target["correspondence_id"])
                    if current["correspondence_revision"] != target["correspondence_revision"]:
                        changed.append({"correspondence_id": target["correspondence_id"]})
                except (OSError, ValueError):
                    unavailable.append({"correspondence_id": target["correspondence_id"]})
        for ref in refs:
            document = ref["document"]
            if document not in documents:
                try:
                    documents[document] = self._knowledge(document)
                except (OSError, ValueError):
                    documents[document] = None
            current = documents[document]
            if current is None:
                if document not in unavailable:
                    unavailable.append(document)
            elif any(key in ref and ref[key] != current.get(key) for key in REVISION_FIELDS):
                if document not in changed:
                    changed.append(document)
        return {"status": "needs_recheck" if changed or unavailable else "current",
                "changed": changed, "unavailable": unavailable, "automatic_recomparison": False}

    def _project(self, record):
        steps = [event for event in record["events"] if event.get("kind") == "lookup"]
        result = next((event for event in reversed(record["events"]) if event.get("kind") == "result"), None)
        coverage = {"complete": all(step["result"].get("complete") is True for step in steps),
                    "truncated": any(step["result"].get("truncated") for step in steps),
                    "lookup_limit_reached": len(steps) >= MAX_STEPS,
                    "seed_terms_truncated": record["data"]["seed_terms_truncated"],
                    "semantic_coverage": "not_guaranteed",
                    "skipped": [{"lookup_number": step["number"], **item} for step in steps
                                for item in step["result"].get("skipped", [])]}
        return {"record": record, "revision": canonical_json_hash(record), "status": _state(record),
                "lookup_count": len(steps), "lookup_limit": MAX_STEPS, "result": result,
                "references": list(_references(record).values()), "currentness": self._currentness(record),
                "coverage": coverage,
                "human_approval": False, "origin": "client_reported", "sharing": "personal"}

    def create(self, *, request_id, document, source_revision, graph_revision, session_id, job_id=None, provider=None, before_commit):
        """저장이 확인된 현재 그래프 하나를 기준으로 새 대조 실행을 만든다."""
        _text(session_id, 200)
        if provider not in {None, "codex", "claude"}:
            raise ValueError("Unknown comparison provider")
        payload = dict(document=document, source_revision=source_revision, graph_revision=graph_revision,
                       session_id=session_id, job_id=job_id, provider=provider)
        try:
            old = self.personal.receipt(KIND, request_id, payload=payload)
            return {**self._project(old["record"]), "target_input": self._target_input(old["record"]), "replayed": True}
        except FileNotFoundError:
            pass
        if job_id is not None:
            job = JobStore(self.store).query(job_id, tenant=self.scope.tenant, user_id=self.scope.user_id)
            if document not in {item["document"] for item in job["targets"]}:
                raise ValueError("Comparison document must be a target of the owned analysis job")
        current = self._knowledge(document)
        if (current["source_revision"] != source_revision or current["graph_revision"] != graph_revision
                or current["machine_graph"].get("status") != "ready"):
            raise PersonalConflictError()
        terms, truncated = seed_terms(current["machine_graph"])
        data = {"title": document, "document": document, "job_id": job_id, "session_id": session_id, "provider": provider,
                "basis": {"document": document, **{key: current.get(key) for key in REVISION_FIELDS}},
                "seed_terms": terms, "seed_terms_truncated": truncated, "lookup_limit": MAX_STEPS,
                "contract_version": "knowledge-comparison-v1", "human_approval": False}
        own_id = sha256(f"{KIND}:{self.scope.tenant}:{self.scope.user_id}:{request_id}".encode()).hexdigest()[:32]
        def guard():
            before_commit()
            # PersonalStore.create가 이미 잡은 공통 잠금 안에서 확인해 자동 대조와
            # 수동 재실행이 같은 제공자 대화에 동시에 resume하는 것을 막는다.
            for name in self.personal._names(KIND):
                if name == own_id + ".json":
                    continue
                other = self.personal._read(KIND, name.removesuffix(".json"))
                if (other["data"]["session_id"] == session_id and other["data"].get("provider") == provider
                        and _state(other) == "running"):
                    raise PersonalConflictError()
            now = self._knowledge(document)
            if any(now.get(key) != data["basis"][key] for key in REVISION_FIELDS):
                raise PersonalConflictError()
        made = self.personal.create(KIND, request_id, payload, data, self.actor, before_commit=guard)
        return {**self._project(made["record"]), "target_input": self._target_input(made["record"]), "replayed": made["replayed"]}

    def read(self, record_id, *, step_id=None, include_target=False):
        record = self.personal.read(KIND, record_id)["record"]
        projected = self._project(record)
        if include_target:
            projected["target_input"] = self._target_input(record)
        if step_id is not None:
            event = next((item for item in record["events"] if item["id"] == step_id and item.get("kind") == "lookup"), None)
            if event is None:
                raise FileNotFoundError()
            projected.update(step=event, lookup_result=self._hydrate(event["result"]))
        return projected

    def list(self, *, document=None, job_id=None, limit=20, cursor=None):
        """현재 사용자의 실행을 최신순으로 반환하되 이전 결과도 별도 항목으로 유지한다."""
        if type(limit) is not int or not 1 <= limit <= 50:
            raise ValueError("Invalid comparison listing limit")
        after = _decode_cursor(cursor)
        if document is not None:
            self.store._document_path(self.store.wiki_dir, document)
        with self.personal._coordination():
            items = []
            for name in self.personal._names(KIND):
                if not name.endswith(".json"):
                    raise ValueError("Unexpected comparison entry")
                record = self.personal._read(KIND, name[:-5])
                data = record["data"]
                if ((document is not None and data["document"] != document)
                        or (job_id is not None and data.get("job_id") != job_id)):
                    continue
                items.append({"id": record["id"], "document": data["document"], "job_id": data.get("job_id"),
                              "created_at": record["created_at"], "status": _state(record),
                              "revision": canonical_json_hash(record)})
            items.sort(key=lambda item: (item["created_at"], item["id"]), reverse=True)
            latest_id = items[0]["id"] if items else None
            # 생성 시각·ID를 기준으로 이어 읽어, 페이지 사이에 새 기록이 생겨도 누락·중복되지 않게 한다.
            if after is not None:
                items = [item for item in items if (item["created_at"], item["id"]) < after]
            page = items[:limit]
            more = len(items) > limit
            return {"items": page, "latest_id": latest_id,
                    "next_cursor": _encode_cursor(page[-1]) if more else None,
                    "complete": not more, "truncated": more,
                    "skipped": [], "scope": "current_user_only"}

    def _search(self, terms, baseline):
        if (type(terms) is not list or not 1 <= len(terms) <= 12
                or any(type(term) is not str or not 1 <= len(term) <= 200 for term in terms)):
            raise ValueError("Use one to twelve bounded search terms")
        items, skipped, complete, truncated = {}, [], True, False
        for term in dict.fromkeys(terms):
            found = self.concepts.find(term, limit=100, **self._arguments())
            complete = complete and found["complete"]
            truncated = truncated or found["truncated"]
            skipped.extend({"term": term, **item} for item in found["skipped"])
            for match in found["matches"]:
                target = _target(match)
                document = target.get("document", target.get("anchor", {}).get("document"))
                if document == baseline:
                    continue
                key = canonical_json_hash(target)
                if key not in items:
                    items[key] = {"reference_id": key, "target_ref": target,
                        "document": document, "matched_terms": [], "matched_fields": [],
                        **{name: deepcopy(match[name]) for name in ("match_origin", "currentness", "historical",
                           "selectable_as_current", "provenance", "review_status", "policy_status", "decision", "applicability") if name in match}}
                item = items[key]
                if term not in item["matched_terms"]:
                    item["matched_terms"].append(term)
                field = {"field": match["matched_field"], "expression": match["original_text"]}
                if field not in item["matched_fields"]:
                    item["matched_fields"].append(field)
        ordered = sorted(items.values(), key=lambda item: (-len(item["matched_terms"]), item["reference_id"]))
        if len(ordered) > MAX_MATCHES:
            complete, truncated = False, True
            skipped.append({"reason": "result_limit", "omitted": len(ordered) - MAX_MATCHES})
        result = {"matches": ordered[:MAX_MATCHES], "complete": complete, "truncated": truncated,
                  "skipped": skipped[:100], "semantic_coverage": "not_guaranteed", "scope": "bounded_tenant_scan"}
        while len(canonical_json_bytes(result)) > MAX_STEP_BYTES and result["matches"]:
            removed = result["matches"].pop()
            result.update(complete=False, truncated=True)
            result["skipped"].append({"reason": "output_budget", "reference_id": removed["reference_id"]})
        if len(skipped) > 100:
            result.update(complete=False, truncated=True)
            result["skipped"].append({"reason": "skipped_metadata_limit", "omitted": len(skipped) - 100})
        return result

    def _read_reference(self, match, operation):
        target = match["target_ref"]
        detail = self.concepts.query(target, **self._arguments())
        if detail["target"]["status"] != "current":
            return {"reference_id": match["reference_id"], "target": detail["target"], "complete": False,
                    "truncated": False, "skipped": [{"reason": "reference_changed"}]}
        # 전체 원문은 정확한 판본 참조로 보관하고 응답에만 복원해 개인 원장 중복을 피한다.
        documents = []
        for document in detail["documents"]:
            claims = [claim for claim in document.get("claims", []) if claim["claim_id"] == target.get("claim_id")]
            entity_ids = {value for claim in claims for value in (claim["value"].get("subject"), claim["value"].get("object"), claim["value"].get("entity"))}
            entities = [entity for entity in document.get("effective_graph", {}).get("entities", []) if entity["id"] in entity_ids]
            projected = {"document": document["document"], **{key: document.get(key) for key in REVISION_FIELDS},
                         "claims": claims, "entities": entities,
                         "policies": document.get("policies", []) if operation == "document" else
                             [item for item in document.get("policies", []) if item.get("claim_id") == target.get("claim_id")]}
            if operation == "document":
                projected["content_ref"] = {"document": document["document"], "source_revision": document["source_revision"]}
            documents.append(projected)
        result = {"reference_id": match["reference_id"], "target": detail["target"], "snapshot": target.get("snapshot", target.get("anchor")),
                  "documents": documents, "correspondences": detail["correspondences"],
                  "complete": detail["complete"], "truncated": detail["truncated"], "skipped": detail["skipped"],
                  "reading_scope": "full_source_and_policies" if operation == "document" else "selected_claim_and_evidence",
                  "unread_context": operation != "document", "semantic_coverage": "not_guaranteed"}
        if len(canonical_json_bytes(result)) > MAX_STEP_BYTES:
            return {"reference_id": match["reference_id"], "complete": False, "truncated": True,
                    "skipped": [{"reason": "whole_component_exceeds_output_budget"}]}
        return result

    def _hydrate(self, result):
        result = deepcopy(result)
        for document in result.get("documents", []):
            ref = document.get("content_ref")
            if ref is not None:
                try:
                    document["content"] = document_revision(self.store, ref["document"], ref["source_revision"])
                except (OSError, ValueError):
                    result.update(complete=False, truncated=True)
                    result["skipped"].append({"document": ref["document"], "reason": "exact_document_revision_unavailable"})
        return result

    def step(self, record_id, *, request_id, expected_revision, operation, terms=None, reference_id=None, before_commit):
        """한 batch 검색 또는 한 참조 읽기를 한 번으로 세며 CAS로 여섯 번째 요청을 막는다."""
        payload = {"operation": operation, "terms": terms, "reference_id": reference_id}
        with self.personal._coordination(create=True):
            record = self.personal._read(KIND, record_id)
            before_commit()
            self._scope(record)
            if request_id in record["requests"]:
                if record["requests"][request_id] != canonical_json_hash(payload):
                    raise PersonalConflictError()
                event = next(item for item in record["events"] if item["id"] == request_id)
                return {**self._project(record), "step": event, "lookup_result": self._hydrate(event["result"]), "replayed": True}
            if canonical_json_hash(record) != expected_revision or _state(record) != "running":
                raise PersonalConflictError()
            count = sum(event.get("kind") == "lookup" for event in record["events"])
            if count >= MAX_STEPS:
                raise PersonalLimitError("Comparison lookup limit reached")
            self._fresh(record)
            if operation == "search" and reference_id is None:
                result = self._search(terms, record["data"]["document"])
            elif operation in {"read", "document"} and terms is None:
                match = _references(record).get(reference_id)
                if match is None:
                    raise ValueError("Read a reference returned by this comparison")
                result = self._read_reference(match, operation)
            else:
                raise ValueError("Invalid comparison lookup")
            event = {"kind": "lookup", "number": count + 1, "operation": operation,
                     "terms": terms, "reference_id": reference_id, "result": result}
            def guard():
                before_commit()
                self._fresh(record)
            saved = self.personal.append_locked(KIND, record_id, request_id, expected_revision,
                payload, event, self.actor, before_commit=guard)
            stored = saved["record"]["events"][-1]
            return {**self._project(saved["record"]), "step": stored, "lookup_result": self._hydrate(result), "replayed": False}

    def finish(self, record_id, *, request_id, expected_revision, status, candidates, excluded, unconfirmed, failure=None, before_commit):
        """AI의 판단을 실제 조회 참조에만 연결하며 기존 관계나 전문가 판단으로 승격하지 않는다."""
        if status not in {"complete", "incomplete"} or (status == "complete" and failure is not None):
            raise ValueError("Invalid comparison result state")
        if failure is not None:
            _text(failure, 1000)
        if type(unconfirmed) is not list or len(unconfirmed) > 100:
            raise ValueError("Invalid unconfirmed items")
        for text in unconfirmed:
            _text(text)
        payload = dict(status=status, candidates=candidates, excluded=excluded, unconfirmed=unconfirmed, failure=failure)
        with self.personal._coordination(create=True):
            record = self.personal._read(KIND, record_id)
            before_commit()
            self._scope(record)
            if request_id in record["requests"]:
                if record["requests"][request_id] != canonical_json_hash(payload):
                    raise PersonalConflictError()
                return {**self._project(record), "replayed": True}
            if canonical_json_hash(record) != expected_revision or _state(record) != "running":
                raise PersonalConflictError()
            references = _references(record)
            used = set()
            for collection in (candidates, excluded):
                if type(collection) is not list or len(collection) > 100:
                    raise ValueError("Invalid comparison candidates")
                for item in collection:
                    if type(item) is not dict or set(item) != {"reference_id", "reason", "unconfirmed"}:
                        raise ValueError("A candidate needs reference, reason and unconfirmed items")
                    ref = item["reference_id"]
                    if ref not in references or ref in used:
                        raise ValueError("Use each actually observed reference at most once")
                    used.add(ref)
                    _text(item["reason"])
                    if type(item["unconfirmed"]) is not list or len(item["unconfirmed"]) > 20:
                        raise ValueError("Invalid candidate uncertainty")
                    for text in item["unconfirmed"]:
                        _text(text)
            if status == "complete" and not record["events"]:
                raise ValueError("A completed comparison must have performed a lookup")
            event = {"kind": "result", **deepcopy(payload), "origin": "client_reported",
                     "human_approval": False, "semantic_identity_confirmed": False,
                     "unassessed_reference_ids": sorted(set(references) - used)}
            saved = self.personal.append_locked(KIND, record_id, request_id, expected_revision,
                payload, event, self.actor, before_commit=before_commit)
            return {**self._project(saved["record"]), "replayed": False}
