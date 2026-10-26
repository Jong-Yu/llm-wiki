"""잠금 안에서 선택한 전체 원문·현재 검토/정책을 근거 버전과 함께 캡처한다."""

# capture는 여러 파일을 '같은 시점의 입력'으로 모으는 과정이다. 여기서 원문을 수정하지 않는다.
# 원문/검토 값, 나중에 비교할 의존 버전, 읽지 못한 항목을 따로 반환해 누락을 숨기지 않는다.

from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.reviews.store import ReviewStore
from . import contracts as limits


def encoded(value):
    # 저장용 JSON 바이트를 입력 구성 파일에 넣을 UTF-8 문자열로 바꾼다.
    return canonical_json_bytes(value).decode("utf-8")


def profile(actor):
    # 관점 선택은 해석의 우선순위다. 허용 tenant나 문서 접근 권한을 대신하는 값은 아니다.
    return {key: actor[key] for key in ("profile_id", "domain", "viewpoint")}


def selection(store, requested, target_document=None):
    # 사용자가 명시한 참고 문서·필수 여부·선택 이유를 검사한다. 비슷한 문서를 자동 추가하지 않는다.
    if type(requested) is not list or len(requested) > limits.MAX_CONTEXT_DOCUMENTS:
        raise limits.InputValidationError("Select at most eight context documents.")
    values, seen = [], set()
    for item in requested:
        if (type(item) is not dict or set(item) != {"document", "required", "reason"}
                or type(item["document"]) is not str or type(item["required"]) is not bool
                or type(item["reason"]) is not str or not item["reason"].strip() or len(item["reason"]) > 1000):
            raise limits.InputValidationError("Each context selection needs its document, required flag and reason.")
        document = item["document"]
        store._document_path(store.wiki_dir, document)
        if document in seen:
            raise limits.InputValidationError("Do not repeat a selected context document.")
        seen.add(document)
        values.append(dict(item))
    if target_document is not None:
        store._document_path(store.wiki_dir, target_document)
        if target_document in seen:
            values = [{**item, "required": True} if item["document"] == target_document else item for item in values]
        else:
            values.append({"document": target_document, "required": True, "reason": "target_document"})
    if len(values) > limits.MAX_CONTEXT_DOCUMENTS:
        raise limits.InputValidationError("Target and context together exceed eight documents.")
    return values


def documents_locked(store, selected, actor):
    """호출자가 위키 잠금을 보유한 상태에서 전체 원문과 현재 검토 판단을 함께 읽는다."""
    reviews = ReviewStore(store)
    values, dependencies, skipped = [], [], []
    # values는 실제 읽은 내용, dependencies는 비교용 버전, skipped는 빠진 항목의 표시다.
    for item in selected:
        document = item["document"]
        try:
            source = reviews.ontology._read_source(document)
            graph = reviews.ontology._read_bytes(reviews.ontology._path(document))
            ledger = reviews._read_bytes(document)
            history = reviews._history_revision(document)
            current = reviews._query_captured(document, source, graph, ledger, history,
                                               domain=actor["domain"], viewpoint=actor["viewpoint"])
        except (OSError, ValueError) as error:
            if item["required"]:
                # 필수 입력의 실패는 전체 작업을 막는다. 선택 입력의 실패는 skipped로 알려 준다.
                raise
            code = "not_found" if isinstance(error, FileNotFoundError) else "context_unavailable"
            dependencies.append({"document": document, "status": code})
            if code == "not_found" and item["reason"] == "target_existing_or_new":
                values.append({"kind": "target_absent", **item, "source": None, "review": None})
                continue
            skipped.append({"document": document, "code": code, "required": False})
            continue
        # 현재 본문 hash만으로는 중간 변경과 검토 판단의 변경을 구분할 수 없다.
        tokens = {key: current[key] for key in ("source_revision", "graph_revision", "review_revision",
                                               "history_revision", "state_revision")}
        dependencies.append({"document": document, "status": "captured", **tokens})
        values.append({"kind": "source_and_current_review_data", **item,
                       "source": {"document": document, "content": source.content, "revision": source.revision,
                                  "line_count": len(source.content.splitlines())},
                       "review": current})
        if current["status"] == "unavailable":
            skipped.append({"document": document, "component": "machine_graph", "code": "graph_unavailable", "required": False})
    return values, dependencies, skipped


def basis(actor, documents, source_ref, extraction=None):
    # 권한 주체의 관점·선택 문서 버전·원본·읽기 결과를 한 비교 기준 dict로 묶는다.
    return {"profile": profile(actor), "documents": documents, "source_ref": source_ref,
            "extraction": extraction}


def dependency_revision(value):
    # 개별 본문뿐 아니라 전체 의존 기준을 지문화해, 참고 자료/검토 판단 변경도 검출한다.
    return canonical_json_hash(value)
