# 이미 고정한 답변 비교 기록을 재생하며 원문 버전·인용·입력 범위가 맞는지 검사한다.
# 기록 속 경로/문장을 실행 지시로 사용하지 않고, 형식/무결성 검사와 의미 정확도 평가를 구별한다.

"""고정한 답변 비교 기록의 출처·판본·입력 무결성을 재생 검사한다.

기록의 형식·hash·선택 범위를 확인하며 답변의 의미 정확성을 자동 판정하지 않는다.
저장 원장의 정규 JSON과 이 평가 기록의 인코딩 계약도 구분한다.
"""

import argparse
from collections import Counter
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import re
import tempfile

from core.modules.ontology.store import OntologyStore
from core.modules.documents.store import WikiStore


LIMITS = {
    "input_max_bytes": 196608,
    "output_max_bytes": 32768,
    "answer_max_chars": 1600,
    "citations_max": 5,
    "quote_max_chars": 240,
    "replicates": 2,
    "questions_per_run": 6,
}
MODES = ("natural", "graph", "combined")


def digest(text):
    return sha256(text.encode("utf-8")).hexdigest()


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _constant(value):
    raise ValueError(f"non-finite JSON number: {value}")


def _json(text):
    return json.loads(text, object_pairs_hook=_unique, parse_constant=_constant)


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _same(left, right):
    """JSON equality that does not confuse booleans with integer metadata."""
    return (json.dumps(left, ensure_ascii=False, sort_keys=True, allow_nan=False)
            == json.dumps(right, ensure_ascii=False, sort_keys=True, allow_nan=False))


def _result(errors, **counts):
    return {"ok": not errors, "errors": errors,
            "semantic_evaluation": "not_performed", **counts}


def _sources(bundle):
    """Return only the declared snapshot; never resolve external file paths."""
    errors, sources, ids = [], {}, set()
    documents = bundle.get("documents") if isinstance(bundle, dict) else None
    if not isinstance(documents, list) or not documents:
        return {}, ["source_bundle.documents must be a nonempty array"]
    for index, item in enumerate(documents):
        label = f"source[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label}: expected object")
            continue
        identifier, document, content = item.get("id"), item.get("document"), item.get("content")
        if not isinstance(identifier, str) or not identifier or identifier in ids:
            errors.append(f"{label}: missing or duplicate id")
        else:
            ids.add(identifier)
        if (not isinstance(document, str) or not document or document in sources
                or Path(document).is_absolute() or ".." in Path(document).parts
                or "\\" in document or not document.endswith(".md")):
            errors.append(f"{label}: invalid or duplicate document")
            continue
        if not isinstance(content, str):
            errors.append(f"{label}: content must be text")
            continue
        try:
            revision = digest(content)
        except UnicodeError:
            errors.append(f"{label}: content is not valid UTF-8")
            continue
        if item.get("sha256") != revision:
            errors.append(f"{label}: source hash mismatch")
        sources[document] = item
    return sources, errors


def _limits(protocol):
    errors = []
    if protocol is not None:
        if not isinstance(protocol, dict):
            errors.append("protocol must be an object")
        else:
            for name, expected in LIMITS.items():
                if type(protocol.get(name)) is not int or protocol[name] != expected:
                    errors.append(f"protocol.{name} must equal frozen limit {expected}")
    return errors


# 답변 인용의 문서/버전/구절이 고정 입력에 속하는지 검사한다. 답변 내용의 참·거짓 점수는 매기지 않는다.
def validate_answer(answer_data, source_bundle, question_ids, protocol=None):
    """Validate one six-question response without grading its meaning.

    question_ids may have another size for focused unit checks; archive replay
    separately enforces the frozen six-question comparison design.
    """
    sources, errors = _sources(source_bundle)
    errors += _limits(protocol)
    citations = 0
    if not isinstance(answer_data, dict) or set(answer_data) != {"answers"}:
        return _result(errors + ["response must contain only answers"], answer_count=0, citation_count=0)
    answers = answer_data["answers"]
    if not isinstance(answers, list):
        return _result(errors + ["answers must be an array"], answer_count=0, citation_count=0)
    supplied = []
    for index, answer in enumerate(answers):
        label = f"answer[{index}]"
        if not isinstance(answer, dict) or set(answer) != {"question_id", "answer", "citations", "uncertainties"}:
            errors.append(f"{label}: expected question_id, answer, citations, uncertainties only")
            continue
        identifier = answer["question_id"]
        if not isinstance(identifier, str):
            errors.append(f"{label}: question_id must be text")
        else:
            supplied.append(identifier)
        body, uncertainties = answer["answer"], answer["uncertainties"]
        if not isinstance(body, str) or not body.strip():
            errors.append(f"{label}: answer must be nonempty text")
        if not isinstance(uncertainties, list) or not all(isinstance(value, str) for value in uncertainties):
            errors.append(f"{label}: uncertainties must be an array of text")
        elif isinstance(body, str) and len(body) + sum(map(len, uncertainties)) > LIMITS["answer_max_chars"]:
            errors.append(f"{label}: answer and uncertainties exceed character budget")
        references = answer["citations"]
        if not isinstance(references, list):
            errors.append(f"{label}: citations must be an array")
            continue
        if len(references) > LIMITS["citations_max"]:
            errors.append(f"{label}: too many citations")
        for citation in references:
            citations += 1
            if not isinstance(citation, dict) or set(citation) != {"document", "source_revision", "quote"}:
                errors.append(f"{label}: invalid citation fields")
                continue
            document = citation["document"]
            source = sources.get(document) if isinstance(document, str) else None
            if source is None:
                errors.append(f"{label}: citation document is outside allowed source snapshot")
                continue
            if citation["source_revision"] != source.get("sha256"):
                errors.append(f"{label}: citation revision mismatch")
            quote = citation["quote"]
            if not isinstance(quote, str) or not quote.strip() or len(quote) > LIMITS["quote_max_chars"]:
                errors.append(f"{label}: quotation must be nonempty text within quote budget")
            elif quote not in source["content"]:
                errors.append(f"{label}: quotation is not a contiguous source substring")
    if Counter(supplied) != Counter(question_ids):
        errors.append("question coverage must match exactly once without unknown questions")
    try:
        size = len(_encoded(answer_data))
        if size > LIMITS["output_max_bytes"]:
            errors.append("response exceeds compact JSON UTF-8 byte budget")
    except (TypeError, ValueError, UnicodeError):
        size = None
        errors.append("response is not UTF-8 JSON")
    return _result(errors, answer_count=len(answers), citation_count=citations, output_bytes=size)


# 임시 저장소의 기존 그래프 검증기로 원시 제출을 확인한다. 실제 사용자의 위키를 생성/수정하지 않는다.
def validate_graph(graph_data, source_bundle, public_graph=None):
    """Regenerate raw submitted graphs through existing validation in temp data."""
    sources, errors = _sources(source_bundle)
    if not isinstance(graph_data, dict):
        return _result(errors + ["graph submission must be an object"], graph_count=0)
    cases = graph_data.get("cases", graph_data.get("documents"))
    if not isinstance(cases, list):
        return _result(errors + ["graph submission requires cases or documents"], graph_count=0)
    by_id = {item["id"]: item for item in sources.values() if isinstance(item.get("id"), str)}
    seen, generated, stored = [], {}, {}
    with tempfile.TemporaryDirectory(prefix="llm-wiki-answer-graph-") as temporary:
        store = WikiStore(Path(temporary))
        ontology = OntologyStore(store)
        for index, case in enumerate(cases):
            if not isinstance(case, dict):
                errors.append(f"graph[{index}]: expected object")
                continue
            document = case.get("document")
            source = sources.get(document) if isinstance(document, str) else None
            if source is None:
                identifier = case.get("id")
                source = by_id.get(identifier) if isinstance(identifier, str) else None
            if source is None:
                errors.append(f"graph[{index}]: document is outside allowed source snapshot")
                continue
            document = source["document"]
            seen.append(document)
            if seen.count(document) > 1:
                errors.append(f"graph[{index}]: duplicate document")
                continue
            supplied_revision = case.get("source_revision", case.get("source_sha256", case.get("sha256")))
            if supplied_revision != source.get("sha256"):
                errors.append(f"graph[{index}]: source revision mismatch")
            try:
                revision = store.save(document, source["content"], expected_revision=None).revision
                ontology.generate(document, revision, case.get("entities"), case.get("relations"),
                                  case.get("relation_candidates", []), attributes=case.get("attributes", []),
                                  schema_version=case.get("schema_version", 3))
                generated[document] = ontology.context([document])["documents"][0]["ontology"]
                stored[document] = _json(ontology._path(document).read_text(encoding="utf-8"))
                if store.read(document).content != source["content"]:
                    errors.append(f"graph[{index}]: source changed during generation")
            except (OSError, ValueError, TypeError) as error:
                errors.append(f"graph[{index}]: {type(error).__name__}: {error}")
    if Counter(seen) != Counter(sources.keys()):
        errors.append("graph coverage must match source documents exactly once")
    if public_graph is not None:
        if not isinstance(public_graph, dict) or set(public_graph) != {"documents"}:
            errors.append("graph_public wrapper must contain only documents")
        documents = public_graph.get("documents") if isinstance(public_graph, dict) else None
        if not isinstance(documents, list):
            errors.append("graph_public.documents must be an array")
        else:
            public_seen = []
            for document in documents:
                name = document.get("document") if isinstance(document, dict) else None
                if not isinstance(name, str) or name not in generated:
                    errors.append("graph_public document is outside validated graph submission")
                    continue
                public_seen.append(name)
                expected = deepcopy(generated[name])
                expected.update(title=sources[name].get("title"), url=sources[name].get("url"),
                                source_version=sources[name].get("version"))
                if set(document) != set(expected):
                    errors.append(f"graph_public {name}: unexpected or missing document fields")
                generation_id = document.get("generation_id")
                if not isinstance(generation_id, str) or re.fullmatch(r"[0-9a-f]{32}", generation_id) is None:
                    errors.append(f"graph_public {name}: invalid generation_id")
                else:
                    # Replayed generation IDs are intentionally new. Validate
                    # the recorded ID and recompute its original stored hash.
                    expected["generation_id"] = generation_id
                    original = {**stored[name], "generation_id": generation_id}
                    serialized = json.dumps(original, ensure_ascii=False, sort_keys=True,
                                            separators=(",", ":")) + "\n"
                    expected["graph_revision"] = digest(serialized)
                for candidate in expected.get("relation_candidates", []):
                    candidate.pop("reason", None)
                    candidate.pop("question", None)
                for field in expected:
                    if not _same(document.get(field), expected[field]):
                        errors.append(f"graph_public {name}: {field} changed from normalized submission")
            if Counter(public_seen) != Counter(sources.keys()):
                errors.append("graph_public coverage must match source documents exactly once")
    return _result(errors, graph_count=len(cases))


def _packet_errors(packet, mode, questions, sources, access, graph, protocol):
    expected_keys = {"questions", "access", "mode", "budget"}
    if mode in ("natural", "combined"):
        expected_keys.add("documents")
    if mode in ("graph", "combined"):
        expected_keys.add("graph")
    if not isinstance(packet, dict) or set(packet) != expected_keys:
        return ["input packet fields differ from the frozen mode contract"]
    errors = []
    expected = {"questions": questions, "access": access, "mode": mode,
                "budget": {name: protocol[name] for name in LIMITS}}
    if "documents" in expected_keys:
        expected["documents"] = sources["documents"]
    if "graph" in expected_keys:
        expected["graph"] = graph
    for key, value in expected.items():
        if packet[key] != value:
            errors.append(f"input packet {key} differs from frozen shared record")
    return errors


def _graph_citation_errors(answer, graph):
    """Graph-only answers can quote only evidence actually in their packet."""
    if not isinstance(graph, dict) or not isinstance(graph.get("documents"), list):
        return ["graph_public.documents must be an array"]
    quotes = {}
    for document in graph["documents"]:
        if not isinstance(document, dict) or not isinstance(document.get("document"), str):
            continue
        evidence = []
        for field in ("entities", "relations", "attributes", "relation_candidates"):
            for item in document.get(field, []) if isinstance(document.get(field, []), list) else []:
                if isinstance(item, dict):
                    value = item.get("evidence")
                    if isinstance(value, dict):
                        value = value.get("quote")
                    if isinstance(value, str):
                        evidence.append(value)
                    for identifier in item.get("identifiers", []):
                        if isinstance(identifier, dict):
                            value = identifier.get("evidence")
                            if isinstance(value, dict):
                                value = value.get("quote")
                            if isinstance(value, str):
                                evidence.append(value)
        quotes[document["document"]] = evidence
    errors = []
    for item in answer.get("answers", []) if isinstance(answer, dict) else []:
        if not isinstance(item, dict) or not isinstance(item.get("citations"), list):
            continue
        for citation in item["citations"]:
            if not isinstance(citation, dict):
                continue
            document, quote = citation.get("document"), citation.get("quote")
            if (isinstance(document, str) and isinstance(quote, str)
                    and not any(quote in evidence for evidence in quotes.get(document, []))):
                errors.append("graph-only citation is absent from supplied graph evidence")
    return errors


# 기록된 바이트/hash와 비교 실행의 입력 범위를 대조해 재생 보고를 만든다.
def validate_archive(path):
    """Check recorded bytes, the paired run design and exact source citations."""
    errors, reports = [], []
    try:
        archive = _json(Path(path).read_text(encoding="utf-8"))
        if not isinstance(archive, dict) or not isinstance(archive.get("records"), dict):
            raise ValueError("archive.records must be an object")
        records = archive["records"]
        parsed = {}
        for name, record in records.items():
            if not isinstance(record, dict) or not isinstance(record.get("text"), str):
                errors.append(f"record {name}: text is required")
                continue
            if record.get("sha256") != digest(record["text"]):
                errors.append(f"record {name}: hash mismatch")
        for name in ("questions", "source_bundle", "protocol", "access", "graph_public"):
            if name not in records:
                raise ValueError(f"required record missing: {name}")
            parsed[name] = _json(records[name]["text"])
        errors += _limits(parsed["protocol"])
        questions = parsed["questions"].get("questions") if isinstance(parsed["questions"], dict) else None
        if not isinstance(questions, list):
            raise ValueError("questions.questions must be an array")
        question_ids = [question.get("id", question.get("question_id"))
                        if isinstance(question, dict) else None for question in questions]
        if (len(question_ids) != LIMITS["questions_per_run"]
                or not all(isinstance(value, str) and value for value in question_ids)
                or len(set(question_ids)) != len(question_ids)):
            raise ValueError("six unique nonempty question IDs are required")
        _, source_errors = _sources(parsed["source_bundle"])
        errors += source_errors
        graph_report = None
        if "graph_raw" in records:
            graph_report = validate_graph(_json(records["graph_raw"]["text"]), parsed["source_bundle"],
                                          parsed["graph_public"])
            errors += [f"graph_raw: {error}" for error in graph_report["errors"]]
        else:
            errors.append("required record missing: graph_raw")
        runs = archive.get("runs")
        if not isinstance(runs, list):
            raise ValueError("archive.runs must be an array")
        pairs, sessions, run_ids = [], [], []
        for index, run in enumerate(runs):
            label = f"run[{index}]"
            if not isinstance(run, dict):
                errors.append(f"{label}: expected object")
                continue
            mode, replicate = run.get("mode"), run.get("replicate")
            if mode not in MODES or type(replicate) is not int:
                errors.append(f"{label}: invalid mode or replicate")
            else:
                pairs.append((mode, replicate))
            for key, values in (("session_id", sessions), ("id", run_ids)):
                value = run.get(key)
                if not isinstance(value, str) or not value:
                    errors.append(f"{label}: {key} is required")
                else:
                    values.append(value)
            try:
                run_records = {}
                for kind in ("input", "output"):
                    record = records[run[f"{kind}_record"]]
                    if not isinstance(record, dict) or not isinstance(record.get("text"), str):
                        raise ValueError(f"{kind} record must contain text")
                    if run.get(f"{kind}_sha256") != record.get("sha256"):
                        errors.append(f"{label}: {kind} hash reference mismatch")
                    run_records[kind] = record
                input_size = len(run_records["input"]["text"].encode("utf-8"))
                if input_size > LIMITS["input_max_bytes"]:
                    errors.append(f"{label}: input exceeds UTF-8 byte budget")
                output_size = len(run_records["output"]["text"].encode("utf-8"))
                if output_size > LIMITS["output_max_bytes"]:
                    errors.append(f"{label}: raw output record exceeds UTF-8 byte budget")
                packet = _json(run_records["input"]["text"])
                errors += [f"{label}: {error}" for error in _packet_errors(
                    packet, mode, questions, parsed["source_bundle"], parsed["access"],
                    parsed["graph_public"], parsed["protocol"])]
                answer = _json(run_records["output"]["text"])
                report = validate_answer(answer, parsed["source_bundle"],
                                         question_ids, parsed["protocol"])
                if mode == "graph":
                    errors += [f"{label}: {error}" for error in _graph_citation_errors(answer, parsed["graph_public"])]
                reports.append({"id": run.get("id"), "input_bytes": input_size,
                                "output_record_bytes": output_size, **report})
                errors += [f"{label}: {error}" for error in report["errors"]]
            except (KeyError, TypeError, ValueError, UnicodeError) as error:
                errors.append(f"{label}: invalid input/output record: {error}")
        expected_pairs = [(mode, replicate) for mode in MODES for replicate in (1, 2)]
        if Counter(pairs) != Counter(expected_pairs):
            errors.append("runs must contain every mode/replicate pair exactly once")
        if len(sessions) != 6 or len(set(sessions)) != 6:
            errors.append("all six runs require distinct session IDs")
        if len(run_ids) != 6 or len(set(run_ids)) != 6:
            errors.append("all six runs require distinct IDs")
        return _result(errors, record_count=len(records), runs=reports, graph=graph_report)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError) as error:
        return _result(errors + [f"invalid archive: {error}"], runs=reports)


# 명시한 --replay 파일을 읽고 무결성 검사 결과를 출력하는 실행 입구다.
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay", required=True, type=Path, help="frozen answer comparison JSON")
    args = parser.parse_args()
    result = validate_archive(args.replay)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
