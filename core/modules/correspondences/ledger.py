"""대응 원장의 전체 이벤트/hash chain을 검증하고 불변 공개·교체와 영수증을 마무리한다.

owner는 공용 Store의 저장소·actor·같은 잠금 안의 협력 메서드만 전달한다.
파일 I/O와 잠금의 경계는 기존 호출 순서를 유지한다.
"""

# _ledger는 이전/이후 상태와 hash로 연결된 전체 이벤트를 읽어 검증한다.
# _publish는 완성된 파일을 공개하고 _finish는 저장 결과와 정리 경고를 응답으로 조립한다. 여러 파일을 한 거래로 취급하지 않는다.

from . import contracts as limits
from . import schema
from .contracts import CorrespondenceCorruptError
from .contracts import CorrespondenceLimitError
from .contracts import CorrespondenceValidationError
from .state import _manifest
from .state import _scope
from copy import deepcopy
from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_bytes as _encode
from core.common.json_codec import canonical_json_hash as _hash
from core.modules.ontology.snapshots import _reject_constant
from core.modules.ontology.snapshots import _unique_object
from core.modules.reviews.values import _actor
from datetime import datetime, timezone
import json
import os


def _snapshot_schema(owner, value, documents, lane):
    schema.fields(value, limits._SNAPSHOT_FIELDS, name="judgment snapshot")
    _manifest(value["basis_dependencies"])
    if value["origin_event_id"] is not None:
        schema.identifier(value["origin_event_id"], "origin_event_id")
    if value["supersedes_event_id"] is not None:
        schema.identifier(value["supersedes_event_id"], "supersedes_event_id")
    if lane == "source":
        if value["policy_scope"] is not None or value["decision"] not in {"unreviewed", "accepted", "rejected", "deferred"} or value["value"] is None or value["supersedes_event_id"] is not None:
            raise CorrespondenceValidationError("invalid source snapshot")
    else:
        schema.scope(value["policy_scope"])
        if value["decision"] not in {"active", "inactive"} or (value["decision"] == "active" and value["value"] is None):
            raise CorrespondenceValidationError("invalid policy snapshot")
    if value["value"] is not None:
        schema.value_schema(value["value"], owner.store, documents)
        kind = value["value"]["basis"]["kind"]
        if (lane == "expert") != (kind == "expert"):
            raise CorrespondenceValidationError("basis and lane differ")
        if value["decision"] == "accepted" and kind != "source":
            raise CorrespondenceValidationError("candidate cannot be accepted as source evidence")
    elif value["origin_event_id"] is not None or value["basis_dependencies"] != limits._EMPTY or value["supersedes_event_id"] is not None:
        raise CorrespondenceValidationError("inactive initial policy must have no invented basis")


def _ledger(owner, raw, cid):
    # 전체 이벤트 원장을 읽어 과거/현재 상태·지문 연결·되돌림을 재검증한다. 일부만 읽고 손상된 나머지를 버리지 않는다.
    try:
        ledger = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        schema.fields(ledger, {"version", "tenant", "correspondence_id", "documents", "events"}, name="ledger")
        if type(ledger["version"]) is not int or ledger["version"] != 1 or ledger["tenant"] != owner.actor["tenant"] or ledger["correspondence_id"] != cid:
            raise CorrespondenceValidationError("ledger identity/version mismatch")
        schema.fields(ledger["documents"], {"condition", "concept"}, name="documents")
        for doc in ledger["documents"].values():
            owner.store._document_path(owner.store.wiki_dir, doc)
        if not isinstance(ledger["events"], list) or not 1 <= len(ledger["events"]) <= limits.MAX_CORRESPONDENCE_EVENTS:
            raise CorrespondenceValidationError("invalid event count")
        latest, seen, previous_hash = {}, {}, None
        for sequence, event in enumerate(ledger["events"], 1):
            schema.fields(event, limits._EVENT_FIELDS, name="event")
            schema.identifier(event["id"], "event_id")
            if event["id"] in seen or type(event["sequence"]) is not int or event["sequence"] != sequence:
                raise CorrespondenceValidationError("duplicate event or discontinuous sequence")
            if event["previous_hash"] != previous_hash or event["hash"] != _hash({key: val for key, val in event.items() if key != "hash"}):
                raise CorrespondenceValidationError("broken event hash chain")
            schema.text(event["reason"], "reason")
            schema.instant(event["timestamp"])
            if schema.instant(event["timestamp"]).utcoffset().total_seconds() != 0:
                raise CorrespondenceValidationError("event timestamp must be UTC")
            _actor(event["actor"])
            if event["actor"]["tenant"] != ledger["tenant"]:
                raise CorrespondenceValidationError("cross-tenant actor")
            schema.token(event["base_state_revision"])
            for name in ("basis_dependencies", "observed_dependencies"):
                _manifest(event[name])
                if cid in {row["correspondence_id"] for row in event[name]["correspondences"]}:
                    raise CorrespondenceValidationError("own ledger cannot be its judgment basis")
            lane = event["lane"]
            if lane not in {"source", "expert"}:
                raise CorrespondenceValidationError("invalid event lane")
            if lane == "source" and event["judgment_id"] is not None:
                raise CorrespondenceValidationError("source judgment_id must be null")
            if lane == "expert":
                schema.identifier(event["judgment_id"], "judgment_id")
            key = lane, event["judgment_id"]
            previous = latest.get(key)
            owner._snapshot_schema(event["after"], ledger["documents"], lane)
            if event["after"]["basis_dependencies"] != event["basis_dependencies"] or event["after"]["supersedes_event_id"] != event["supersedes_event_id"]:
                raise CorrespondenceValidationError("event and snapshot basis mismatch")
            if event["action"] == "propose":
                if sequence != 1 or lane != "source" or event["before"] is not None or event["after"]["decision"] != "unreviewed":
                    raise CorrespondenceValidationError("only the first event proposes source")
            else:
                if ("source", None) not in latest:
                    raise CorrespondenceValidationError("a source proposal must exist first")
                owner._snapshot_schema(event["before"], ledger["documents"], lane)
                if previous is not None:
                    if event["before"] != previous["after"]:
                        raise CorrespondenceValidationError("before snapshot differs from replay")
                elif lane != "expert" or event["before"] != owner._inactive(event["after"]["policy_scope"]):
                    raise CorrespondenceValidationError("invalid initial before snapshot")
                if event["action"] in {"review_undo", "policy_undo"}:
                    undone = seen.get(event["undo_of"])
                    if previous is not undone or undone is None or undone["action"] == "propose" or event["after"] != undone["before"]:
                        raise CorrespondenceValidationError("undo must reverse the latest same-lane event")
                    if (event["action"] == "review_undo") != (lane == "source"):
                        raise CorrespondenceValidationError("undo lane mismatch")
                elif event["action"] == "review":
                    if lane != "source" or event["after"]["decision"] not in {"accepted", "rejected", "deferred"}:
                        raise CorrespondenceValidationError("invalid review state")
                    if event["after"]["value"] != event["before"]["value"] and event["after"]["decision"] not in {"accepted", "deferred"}:
                        raise CorrespondenceValidationError("edit requires accepted or deferred")
                elif event["action"] == "policy":
                    if lane != "expert" or event["after"]["decision"] != "active":
                        raise CorrespondenceValidationError("invalid policy event")
                    if previous is not None:
                        first = next(item for item in ledger["events"] if item["lane"] == "expert" and item["judgment_id"] == event["judgment_id"])
                        if event["after"]["policy_scope"] != first["after"]["policy_scope"] or event["after"]["value"]["business_scope"] != first["after"]["value"]["business_scope"]:
                            raise CorrespondenceValidationError("judgment scopes are fixed")
                        if event["supersedes_event_id"] != previous["id"]:
                            raise CorrespondenceValidationError("policy update requires latest explicit supersession")
                    supersedes = event["supersedes_event_id"]
                    source_latest = latest[("source", None)]
                    if previous is None and source_latest["after"]["decision"] == "accepted" and source_latest["after"]["value"]["business_scope"] == event["after"]["value"]["business_scope"] and supersedes != source_latest["id"]:
                        raise CorrespondenceValidationError("first expert replacement of accepted source requires its latest explicit event")
                    if supersedes is not None:
                        target = seen.get(supersedes)
                        if target is None or latest.get((target["lane"], target["judgment_id"])) is not target or target["after"]["value"] is None or target["after"]["value"]["business_scope"] != event["after"]["value"]["business_scope"]:
                            raise CorrespondenceValidationError("supersession must name latest exact business scope")
                        if target["lane"] == "expert" and target["after"]["policy_scope"] != event["after"]["policy_scope"]:
                            raise CorrespondenceValidationError("policy supersession scope mismatch")
                else:
                    raise CorrespondenceValidationError("unsupported event action")
            if event["action"] not in {"review_undo", "policy_undo"}:
                if event["undo_of"] is not None or event["after"]["origin_event_id"] != event["id"]:
                    raise CorrespondenceValidationError("invalid event provenance")
            if lane == "expert" and event["after"]["policy_scope"] != _scope(event["actor"]):
                raise CorrespondenceValidationError("expert event actor scope mismatch")
            seen[event["id"]] = event
            latest[key] = event
            previous_hash = event["hash"]
        return ledger
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError, UnicodeError) as error:
        raise CorrespondenceCorruptError("Stored correspondence is malformed; preserved bytes were not replaced") from error


def _publish(owner, cid, encoded, existing, cleanup):
    # 임시 파일의 전체 바이트를 준비한 뒤 새 파일 공개 또는 교체를 수행한다.
    owner.store._mkdir(owner.correspondence_dir)
    path = owner._path(cid)
    with owner.store._staged_file(owner.correspondence_dir, encoded, cleanup) as staged:
        if existing:
            os.replace(staged.path, path)
            staged.consumed = True
        else:
            os.link(staged.path, path)


def _finish(owner, cid, ledger, event, ctx, existing, cleanup):
    # 저장한 원장의 실제 revision과 정리 경고를 결과에 묶는다. 정리 경고 때문에 성공한 쓰기를 재실행하지 않는다.
    if len(ledger["events"]) > limits.MAX_CORRESPONDENCE_EVENTS:
        raise CorrespondenceLimitError("Event limit reached; existing events remain intact")
    encoded = _encode(ledger)
    if len(encoded) > limits.MAX_CORRESPONDENCE_BYTES:
        raise CorrespondenceLimitError("Ledger byte limit reached; existing history remains intact")
    owner._ledger(encoded, cid)
    # Receipt is fully built/encoded before the only publication operation.
    result = owner._result(cid, encoded, ledger, ctx, receipt=True)
    result.update(changed=True, event_id=event["id"], sequence=event["sequence"], event_hash=event["hash"], cleanup_failures=[])
    if len(_encode(result)) > limits.MAX_RECEIPT_BYTES:
        raise CorrespondenceLimitError("Successful-save receipt would exceed its size limit")
    owner._publish(cid, encoded, existing, cleanup)
    return result


def _cleanup(result, cleanup, store):
    result["cleanup_failures"] = cleanup_details(store.data_dir, cleanup)
    return result


def _event(owner, eid, sequence, action, lane, judgment, before, after, reason, observed, base, undo, previous_hash):
    event = {"id": eid, "sequence": sequence, "action": action, "lane": lane, "judgment_id": judgment, "before": deepcopy(before), "after": deepcopy(after), "reason": reason, "actor": deepcopy(owner.actor), "timestamp": datetime.now(timezone.utc).isoformat(), "basis_dependencies": deepcopy(after["basis_dependencies"]), "observed_dependencies": deepcopy(observed), "base_state_revision": base, "undo_of": None if undo is None else undo["id"], "supersedes_event_id": after["supersedes_event_id"], "previous_hash": previous_hash}
    event["hash"] = _hash(event)
    return event
