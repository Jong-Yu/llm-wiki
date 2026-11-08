"""대응 상세·신규 초안 준비·제한된 목록 발견의 조회 결과를 구성한다.

owner는 공용 Store의 저장소·actor·같은 잠금 안의 협력 메서드만 전달한다.
파일 I/O와 잠금의 경계는 기존 호출 순서를 유지한다.
"""

# query는 대응 하나의 현재 판단/근거를, find는 제한된 목록의 후보를 돌려준다.
# _result는 저장된 판단과 현재 적용 범위·누락 정보를 분리해 화면에서 확인할 수 있는 결과로 만든다.

from contextlib import closing
from core.modules.ontology.storage import storage_entries
from . import contracts as limits
from . import identifiers
from . import schema
from .capture import _Capture
from .contracts import CorrespondenceLimitError
from .contracts import CorrespondenceValidationError
from .state import _states
from .state import _values
from copy import deepcopy
from core.common.json_codec import canonical_json_bytes as _encode
from core.common.json_codec import canonical_json_hash as _hash
from hashlib import sha256
import unicodedata


def _result(owner, cid, raw, ledger, ctx, dependencies=None, *, receipt=False):
    states = _states(ledger)
    deps = dependencies if dependencies is not None else ctx.collect(_values(states), cid)
    complete = owner._complete(deps)
    revision = sha256(raw).hexdigest()
    judgments = owner._judgments(ledger, ctx, cid)
    source = next(item for item in judgments if item["lane"] == "source")
    result = {"ok": True, "correspondence_id": cid, "correspondence_revision": revision, "dependencies": deps, "access": deepcopy(owner.actor), "complete": complete, "truncated": False, "skipped": [] if complete else [{"reason": "missing_dependency"}], "documents": deepcopy(ledger["documents"]), "source_proposal": source, "reviews": [item for item in judgments if item["lane"] == "source"], "policies": [item for item in judgments if item["lane"] == "expert"], "application_context": deepcopy(ctx.application_context), "evaluated_at": ctx.at.isoformat()}
    if not receipt:
        result["history"] = deepcopy(ledger["events"])
    if complete:
        result["state_revision"] = owner._token(cid, revision, deps, "snapshot", {"states": [event["after"] for event in states.values()]})
    if len(_encode(result)) > (limits.MAX_RECEIPT_BYTES if receipt else limits.MAX_DETAIL_BYTES):
        raise CorrespondenceLimitError("Complete response exceeds its byte limit; history was not truncated")
    return result


def query(owner, correspondence_id=None, draft=None, application_context=None, as_of=None):
    """기존 대응을 읽거나 신규 초안을 준비한다. 신규 ID 반환은 저장·예약 완료가 아니다."""
    # 대응 식별자 하나의 현재 판단과 원장/근거를 제한된 응답으로 반환한다.
    if (correspondence_id is None) == (draft is None):
        raise CorrespondenceValidationError("query requires exactly one of correspondence_id or draft")
    with owner.store._write_lock():
        ctx = _Capture(owner, application_context=application_context, as_of=as_of)
        if draft is not None:
            draft = schema.value_schema(draft, owner.store)
            if draft["basis"]["kind"] == "expert":
                raise CorrespondenceValidationError("new source proposal cannot contain expert judgment")
            cid = identifiers.new_id()
            deps = ctx.collect([draft], cid)
            complete = owner._complete(deps)
            if complete:
                owner._validate_value(draft, ctx, cid)
            result = {"ok": True, "correspondence_id": cid, "correspondence_revision": None, "draft": draft, "payload_digest": _hash({"kind": "draft", "payload": draft}), "dependencies": deps, "access": deepcopy(owner.actor), "complete": complete, "truncated": False, "skipped": [] if complete else [{"reason": "missing_dependency"}], "application_context": deepcopy(ctx.application_context), "evaluated_at": ctx.at.isoformat()}
            if complete:
                result["state_revision"] = owner._token(cid, None, deps, "draft", draft)
            if len(_encode(result)) > limits.MAX_DETAIL_BYTES:
                raise CorrespondenceLimitError("Prepared draft exceeds detail response limit")
            return result
        raw, ledger = ctx.ledger(correspondence_id)
        if ledger is None:
            raise FileNotFoundError("Correspondence not found")
        return owner._result(correspondence_id, raw, ledger, ctx)


def find(owner, documents, text=None, application_context=None, as_of=None, limit=20):
    # 조건에 맞는 대응 후보를 한도 안에서 발견한다. 불완전 탐색을 전체 tenant에 대응 없음으로 표시하지 않는다.
    if not isinstance(documents, list) or not 1 <= len(documents) <= 8 or len(set(documents)) != len(documents):
        raise CorrespondenceValidationError("find requires 1-8 unique document paths")
    for document in documents:
        owner.store._document_path(owner.store.wiki_dir, document)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise CorrespondenceValidationError("limit must be 1-100")
    if text is not None:
        schema.text(text, "text")
    needle = None if text is None else unicodedata.normalize("NFKC", text).casefold()
    with owner.store._write_lock():
        ctx = _Capture(owner, application_context=application_context, as_of=as_of, byte_limit=min(limits.MAX_CAPTURE_BYTES, limits.MAX_FIND_BYTES))
        result = {"ok": True, "scope": {"documents": deepcopy(documents), "text": text, "limit": limit}, "results": [], "access": deepcopy(owner.actor), "complete": True, "truncated": False, "skipped": [], "application_context": ctx.application_context, "evaluated_at": ctx.at.isoformat()}
        with closing(storage_entries(owner.store, owner.correspondence_dirs)) as entries:
            scanned = 0
            for index, entry in enumerate(entries):
                if index >= limits.MAX_FIND_ENTRIES or scanned >= limits.MAX_FIND_FILES:
                    result.update(complete=False, truncated=True)
                    result["skipped"].append({"reason": "scan_limit"})
                    break
                if entry.name.startswith(".wiki-") and entry.name.endswith(".tmp"):
                    continue
                if not entry.name.endswith(".json"):
                    result["skipped"].append({"path": entry.name, "reason": "unrecognized_entry"})
                    result["complete"] = False
                    continue
                scanned += 1
                cid = entry.name[:-5]
                try:
                    schema.identifier(cid)
                    raw, ledger = ctx.ledger(cid)
                    if ledger is None:
                        raise FileNotFoundError("ledger disappeared")
                    # Match explicit current/history endpoint, evidence, reference and precedent docs.
                    related_docs = set(ledger["documents"].values())
                    for event in ledger["events"]:
                        value = event["after"]["value"]
                        if value is None:
                            continue
                        related_docs.update(anchor["document"] for anchor in value["basis"]["link_evidence"])
                        related_docs.update(ref["document"] for ref in value["references"] if "document" in ref)
                        for related in value["related_to"]:
                            _, precedent = ctx.ledger(related["correspondence_id"])
                            if precedent is not None:
                                related_docs.update(precedent["documents"].values())
                    if not related_docs.intersection(documents):
                        continue
                    if needle is not None:
                        searchable = " ".join([*related_docs, *[item["after"]["value"]["statement"] + " " + item["after"]["value"]["condition"]["quote"] + " " + item["after"]["value"]["concept"]["quote"] for item in _states(ledger).values() if item["after"]["value"] is not None]])
                        if needle not in unicodedata.normalize("NFKC", searchable).casefold():
                            continue
                    # Document closure limits are per result, total captured bytes remain shared.
                    ctx.docs = {}
                    detail = owner._result(cid, raw, ledger, ctx, receipt=True)
                    summary = {key: detail[key] for key in ("correspondence_id", "correspondence_revision", "documents", "source_proposal", "policies", "dependencies", "complete")}
                    if len(result["results"]) >= limit or len(_encode({**result, "results": [*result["results"], summary]})) > limits.MAX_FIND_OUTPUT_BYTES:
                        result.update(complete=False, truncated=True)
                        result["skipped"].append({"reason": "result_limit"})
                        break
                    result["results"].append(summary)
                    if not detail["complete"]:
                        result["complete"] = False
                        result["skipped"].append({"correspondence_id": cid, "reason": "missing_dependency"})
                except (OSError, ValueError, UnicodeError) as error:
                    result["complete"] = False
                    result["skipped"].append({"path": entry.name, "reason": type(error).__name__})
                    if isinstance(error, CorrespondenceLimitError):
                        result["truncated"] = True
        return result
