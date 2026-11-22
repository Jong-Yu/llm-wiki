"""질문 후보를 찾는 재생성 가능 투영. 정본 판단과 인용은 기존 Store가 결정한다."""

from collections import defaultdict
from copy import deepcopy
import math
import re
import unicodedata

from core.common.json_codec import canonical_json_hash
from core.common.read_index import read_index, CanonicalIndexUnavailable
from core.modules.reviews.values import actor_basis, _actor
from .concepts import ConceptStore
from .ontology_exploration_index import observations, signature

NAMESPACE = "question_grounding_v1"
# 큰 문서의 본문 단어가 가나다순으로 잘리지 않게 문서당 단어·질문당 색인 행 상한을 넉넉히 둔다.
MAX_TERMS = 60000
MAX_QUERY_TERMS = 128
MAX_POSTINGS = 16384
# 그래프 점수 순위와 본문 드문 단어 순위를 번갈아 고른다(온톨로지가 없는 문서도 본문으로 찾는다).
RANKING_POLICY = "graph_and_body_bm25_interleaved_v1"
PROJECTION_VERSION = 2
STOP_WORDS = frozenset("an the is are of to in for and or what how does do can this that please 알려줘 무엇 어떻게 그리고 대한 대해 설명 해줘".split())


def folded(value):
    return unicodedata.normalize("NFKC", value).casefold()


def mentions(surface, question):
    """영문 이름의 부분 단어 일치와 한국어 조사 뒤의 이름을 구분한다."""
    name = folded(surface)
    return bool(name and re.search(r"(?<![a-z0-9_])" + re.escape(name) + r"(?![a-z0-9_])", folded(question)))


_WORD = re.compile(r"[a-z0-9]+(?:[-./][a-z0-9]+)*|[가-힣]+")


def terms(value):
    """저장된 문자만 사용하며 번역·별칭 생성이나 의미 판정을 하지 않는다.

    돌려주는 모든 단어는 folded(value)의 부분 문자열이다(overlap이 이 성질을 쓴다).
    """
    result = set()
    for word in _WORD.findall(folded(value)):
        if word not in STOP_WORDS:
            result.add(word)
        # _WORD의 두 갈래 중 한글 갈래인지 첫 글자로 구분한다.
        if len(word) > 2 and "가" <= word[0] <= "힣":
            result.update([word[i:i + 2] for i in range(len(word) - 1)])
    return result


def overlap_counter(wanted):
    """len(wanted & terms(value))와 같은 값을 세는 함수를 돌려준다.

    wanted의 어느 단어도 folded(value)의 부분 문자열이 아니면 겹침이 없으므로 토큰화를 건너뛴다.
    큰 문서의 단락 수천 개를 질문마다 다시 토큰화하지 않기 위한 것이다(2026-11-22 측정).
    """
    if not wanted:
        return lambda value: 0
    pattern = re.compile("|".join(map(re.escape, sorted(wanted, key=len, reverse=True))))

    def count(value):
        if pattern.search(folded(value)) is None:
            return 0
        return len(wanted & terms(value))
    return count


def without_evidence(value, *, strip_quotes=False):
    if isinstance(value, dict):
        return {k: without_evidence(v, strip_quotes=strip_quotes) for k, v in value.items()
                if k != "evidence" and not (strip_quotes and k == "quote")}
    if isinstance(value, list):
        return [without_evidence(v, strip_quotes=strip_quotes) for v in value]
    return deepcopy(value)


def searchable(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(searchable(v) for k, v in value.items() if k not in {
            "evidence", "claim_id", "event_id", "review_event_id", "source_revision", "state_revision"})
    if isinstance(value, list):
        return " ".join(searchable(v) for v in value)
    return ""


def catalog_revision(store, observed=None):
    """선택 밖 문서 추가·원문/판단 변경까지 묶는 발견 판본. 호출자는 Wiki 잠금을 갖는다."""
    observed = observations(store) if observed is None else observed
    return canonical_json_hash(observed)


def _scope(actor):
    _actor(actor)
    return canonical_json_hash({"actor": actor_basis(actor), "version": 1})


def _project(owner, document):
    capture = owner._capture("query", None, None, None)
    entry = capture.document(document, purpose="question_projection", required_by=["question"], full=True)
    snapshot = entry.get("snapshot") or {}
    source = entry.get("source") or {}
    ref = {k: entry.get(k) for k in ("source_revision", "graph_revision", "review_revision", "history_revision", "state_revision")}
    rows, weights = [], {}
    # 본문은 복제하지 않고 후보 발견용 단어의 hash만 역색인한다.
    for word in terms(source.get("body", source.get("content", ""))):
        weights[word] = 1
    graph = snapshot.get("machine_graph", {})
    entities = {e["id"]: e for e in graph.get("entities", [])}
    entities.update({e["id"]: e for e in (snapshot.get("effective_graph") or {}).get("entities", [])})
    for identifier, entity in entities.items():
        item = without_evidence(entity, strip_quotes=True)
        rows.append(("entity:" + identifier, {"owner": document, "state": "entity", "item": item, "ref": ref}))
        for word in terms(searchable(item)):
            weights[word] = 8
    attention = False
    archived = set(snapshot.get("cleanup", {}).get("archived_claim_ids", []))
    records = [("claim", c) for c in snapshot.get("claims", [])]
    records += [("policy", p) for p in snapshot.get("policies", [])]
    records += [("authored", r) for r in snapshot.get("authored_relations", [])]
    for position, (kind, record) in enumerate(records):
        item = without_evidence(record, strip_quotes=True)
        item["archived"] = record.get("claim_id") in archived
        endpoints = set()
        for value in (record.get("value"), record.get("reviewed_value")):
            if not isinstance(value, dict):
                continue
            pair = tuple(canonical_json_hash(folded(entities[e]["label"])) if isinstance(e, str) and e in entities else None
                         for e in (value.get("subject"), value.get("object")))
            endpoints.add(pair)
        for variant, (subject, object_id) in enumerate(sorted(endpoints or {(None, None)}, key=str)):
            rows.append((f"{kind}:{position}:{variant}", {"owner": document, "state": kind, "item": item,
                "source_id": subject, "revision": object_id, "ref": ref}))
        attention |= record.get("decision") in {"reject", "defer", "policy"} or kind == "policy"
        attention |= any(isinstance(v, dict) and (v.get("qualifiers") or {}).get("polarity") == "negative"
                         for v in (record.get("value"), record.get("reviewed_value")))
        for word in terms(searchable(item)):
            weights[word] = max(3, weights.get(word, 0))
    for event in [*snapshot.get("history", []), *snapshot.get("relation_history", [])]:
        for word in terms(event.get("reason", "")):
            weights[word] = max(3, weights.get(word, 0))
    ordered = sorted(weights, key=lambda word: (-weights[word], word))
    limited = len(ordered) > MAX_TERMS
    for word in ordered[:MAX_TERMS]:
        token = canonical_json_hash(word)
        rows.append(("term:" + token, {"owner": document, "state": "term", "source_id": token,
            "weight": weights[word]}))
    omissions = [{"document": document, "code": item["reason"]} for item in capture.skipped]
    manifest = {"owner": document, "state": "manifest", "document_id": source.get("document_id"),
        "projection_version": PROJECTION_VERSION,
        "ref": ref, "status": graph.get("status", "unavailable"), "attention": attention,
        "term_count": min(len(ordered), MAX_TERMS),
        "skipped": omissions, "truncated": limited or capture.truncated, "row_count": len(rows) + 1}
    rows.append(("manifest", manifest))
    return rows, manifest


def ensure_locked(store, actor, index, *, should_stop=None):
    """기존 변경 관측과 문서별 교체를 사용하며 Wiki 잠금을 다시 잡지 않는다."""
    observed = observations(store)
    files, scope = observed["files"], _scope(actor)
    history = defaultdict(list)
    for path, value in sorted(files.items()):
        if path.startswith("_history/"):
            history[path[9:].rpartition("/")[0]].append((path, value))
    documents = sorted(p[5:] for p in files if p.startswith("wiki/") and p.endswith(".md"))
    manifests = index.lookup(NAMESPACE, scope, filters={"state": "manifest"})
    active = set(documents)
    for key, (_, previous) in list(manifests.items()):
        if previous["owner"] not in active:
            index.replace_owner(NAMESPACE, scope, previous["owner"], [])
            del manifests[key]
    owner = ConceptStore(store, actor)
    for document in documents:
        if should_stop is not None and should_stop():
            from .ontology_exploration import IndexPreparationStopped
            raise IndexPreparationStopped()
        key = document + ":manifest"
        old = manifests.get(key)
        before = old[1] if old else {}
        stamp = signature(files, document, before.get("document_id"), history=history[document])
        retry = any(s["code"] in {"read_error", "permission_denied", "not_found", "observation_failed"}
                    for s in before.get("skipped", []))
        if old and old[0] == stamp and before.get("projection_version") == PROJECTION_VERSION and not retry:
            continue
        rows, manifest = _project(owner, document)
        stamp = signature(files, document, manifest.get("document_id"), history=history[document])
        index.replace_owner(NAMESPACE, scope, document,
            [(document + ":" + key, stamp, row) for key, row in rows])
        manifests[key] = stamp, manifest
    if index.count(NAMESPACE, scope) != sum(m["row_count"] for _, m in manifests.values()):
        raise CanonicalIndexUnavailable("Question projection rows are incomplete", reason="corrupt")
    return observed, manifests


def _body_scores(postings, term_counts, k1=1.2, b=0.3):
    """질문 단어가 든 문서마다 BM25(출현 여부 기준)로 점수를 낸다. 가중치(본문·주장·개념)는 보지 않는다.

    색인은 단어 출현 여부만 가지므로 빈도는 1로 보고, 문서 길이는 색인한 고유 단어 수로 보정한다.
    드문 단어일수록, 어휘가 작은 문서일수록 한 단어의 몫이 커서 어휘가 많은 큰 문서가 단어 수만으로 앞서지 않는다.
    출현 여부만 세므로 일반 BM25(b=0.75)보다 길이 보정을 약하게(b=0.3) 둬, 어휘가 아주 많은 MB 단위 문서도
    드문 단어 하나로 상위에 올 수 있게 한다(실측: evals/2026-11-20-large-doc-lines/ranking-*.json).
    그래프가 없는 문서도 본문 단어만으로 같은 기준의 점수를 받는다.
    """
    owners = defaultdict(set)
    for _, row in postings:
        owners[row["source_id"]].add(row["owner"])
    count = max(len(term_counts), 1)
    average = max(sum(term_counts.values()) / count, 1)
    scores = defaultdict(float)
    for token, documents in owners.items():
        frequency = len(documents)
        idf = math.log(1 + (count - frequency + 0.5) / (frequency + 0.5))
        for document in documents:
            norm = k1 * (1 - b + b * term_counts.get(document, average) / average)
            scores[document] += idf * (k1 + 1) / (1 + norm)
    return scores


def discover(store, actor, question, documents, required_documents):
    """현재 허용 공간의 후보를 선택하고 제한·미확인 범위를 표시한다."""
    anchors = list(dict.fromkeys(required_documents))
    if len(anchors) > 8:
        raise ValueError("Select at most eight unique question documents")
    query_terms = sorted(terms(question))
    with store._write_lock(), read_index(store) as index:
        observed, manifests = ensure_locked(store, actor, index)
        scope = _scope(actor)
        postings = index.page(NAMESPACE, scope, limit=MAX_POSTINGS + 1, filters={"state": "term",
            "source_id": [canonical_json_hash(word) for word in query_terms[:MAX_QUERY_TERMS]]})
        scores = defaultdict(int)
        for _, row in postings[:MAX_POSTINGS]:
            scores[row["owner"]] += row["weight"]
        # 이름 일치는 동일성 확정이 아니다. 관계의 양 끝점을 색인 조회해 다른 문서의 판단도 후보로 확장한다.
        seeds = sorted(scores, key=lambda doc: (-scores[doc], doc))[:8]
        entity_rows = index.page(NAMESPACE, scope, limit=257, filters={"state": "entity", "owner": seeds})
        names = sorted({folded(r["item"]["label"]) for _, r in entity_rows[:256]
                        if mentions(r["item"]["label"], question)})
        label_hashes = {canonical_json_hash(name) for name in names[:16]}
        relation_scores, related_records, relation_limited = {}, 0, len(entity_rows) > 256 or len(names) > 16
        for label_hash in sorted(label_hashes):
            relations = index.page(NAMESPACE, scope, limit=257,
                filters={"state": ["claim", "policy", "authored"]},
                any_filters={"source_id": label_hash, "revision": label_hash})
            related_records += min(len(relations), 256)
            relation_limited |= len(relations) > 256
            for _, relation in relations[:256]:
                matched_ends = sum(relation.get(key) in label_hashes for key in ("source_id", "revision"))
                relation_scores[relation["owner"]] = max(relation_scores.get(relation["owner"], 0), matched_ends * 10)
        for document, score in relation_scores.items():
            scores[document] += score
        attention = {m["owner"]: m["attention"] for _, m in manifests.values()}
        ranked = sorted(set(scores) | set(documents),
            key=lambda doc: (-scores[doc], -attention.get(doc, False), doc not in documents, doc))
        body = _body_scores(postings[:MAX_POSTINGS], {m["owner"]: m.get("term_count", 0) for _, m in manifests.values()})
        body_ranked = sorted(set(scores) | set(documents),
            key=lambda doc: (-body.get(doc, 0.0), doc not in documents, doc))
        merged = []
        for graph_doc, body_doc in zip(ranked, body_ranked):
            for doc in (graph_doc, body_doc):
                if doc not in merged:
                    merged.append(doc)
        chosen = list(dict.fromkeys([*anchors, *merged]))[:8]
        skipped = [*observed["skipped"], *(s for _, m in manifests.values() for s in m["skipped"])]
        limited = (len(query_terms) > MAX_QUERY_TERMS or len(postings) > MAX_POSTINGS
                   or relation_limited or len(set([*anchors, *ranked])) > 8
                   or any(m["truncated"] for _, m in manifests.values()))
        return {"documents": chosen, "catalog_revision": catalog_revision(store, observed),
            "coverage": "authorized_workspace", "complete": not skipped and not limited,
            "indexed_resources": "current_wiki_documents", "registered_originals": "explicit_selection_only",
            "truncated": limited, "skipped": skipped[:20], "matched_documents": len(scores),
            "selected_documents": chosen, "relation_lookup_rows": related_records,
            "absence_proven": False, "policy": NAMESPACE, "ranking": RANKING_POLICY}
