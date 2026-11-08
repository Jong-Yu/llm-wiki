"""baseline 원문과 기존 원장 prefix의 실제 복원 가능성을 확인한다."""

# 옛 source revision과 일치하는 전체 본문 및 검토 원장의 이전 구간을 실제 자료에서 복원한다.
# 찾지 못하면 복원 불가로 남기며 현재 내용을 옛 내용인 것처럼 대체하지 않는다.

from core.modules.documents.store import DocumentSnapshot
from core.modules.ontology.errors import _ContextBudgetError
from core.modules.ontology.errors import _connection_error
from core.common.json_codec import canonical_json_bytes as _encode
from hashlib import sha256


def _review_prefix(ledger, revision):
    """Match canonical historical ledger prefixes with bounded cleanup-prefix work.

    v1 prefixes remain recognizable after a first policy upgrades the envelope
    to v2; event bytes and hashes were not rewritten by that upgrade.
    """
    if revision is None:
        return 0
    if sha256(_encode(ledger)).hexdigest() == revision:
        return len(ledger["events"])
    prefix = b'{"document":' + _encode(ledger["document"]).rstrip(b"\n")
    if "document_id" in ledger:
        prefix += b',"document_id":' + _encode(ledger["document_id"]).rstrip(b"\n")
    digest = sha256(prefix + b',"events":[')
    has_policy = False
    for index, event in enumerate(ledger["events"]):
        if index:
            digest.update(b",")
        digest.update(_encode(event).rstrip(b"\n"))
        has_policy = has_policy or event["action"] in {"policy", "policy_undo"}
        for version in (2,) if has_policy else (1, 2):
            candidate = digest.copy()
            candidate.update(b'],"version":' + str(version).encode() + b'}\n')
            if candidate.hexdigest() == revision:
                return index + 1
    # Cleanup is an additive envelope field, never a rewrite of review events.
    # Match its historical prefixes too, with a bounded amount of hashed input.
    # Exhaustion remains an explicit unavailable restoration, not a guessed match.
    cleanup = sha256(b'{"cleanup_events":[')
    remaining = 16 * 1024 * 1024
    encoded_events = [_encode(event).rstrip(b"\n") for event in ledger["events"]]
    for index, event in enumerate(ledger.get("cleanup_events", [])):
        if index:
            cleanup.update(b",")
        encoded = _encode(event).rstrip(b"\n")
        remaining -= len(encoded)
        if remaining < 0:
            return None
        cleanup.update(encoded)
        candidate_prefix = cleanup.copy()
        candidate_prefix.update(b'],' + prefix[1:] + b',"events":[')
        has_policy = False
        for offset, encoded_review in enumerate(encoded_events):
            remaining -= len(encoded_review)
            if remaining < 0:
                return None
            if offset:
                candidate_prefix.update(b",")
            candidate_prefix.update(encoded_review)
            has_policy = has_policy or ledger["events"][offset]["action"] in {"policy", "policy_undo"}
            for version in (2,) if has_policy else (1, 2):
                candidate = candidate_prefix.copy()
                candidate.update(b'],"version":' + str(version).encode() + b'}\n')
                if candidate.hexdigest() == revision:
                    return offset + 1
    # 독립 관계 원장도 같은 파일 CAS에 포함된다. 과거 조합을 한도 내에서만 확인한다.
    for relation_count in range(1, len(ledger.get("relation_events", [])) + 1):
        for cleanup_count in range(len(ledger.get("cleanup_events", [])) + 1):
            for review_count in range(len(ledger["events"]) + 1):
                base = {key: value for key, value in ledger.items() if key not in {"events", "cleanup_events", "relation_events", "version"}}
                base["events"] = ledger["events"][:review_count]
                base["relation_events"] = ledger["relation_events"][:relation_count]
                if cleanup_count:
                    base["cleanup_events"] = ledger["cleanup_events"][:cleanup_count]
                has_policy = any(event["action"] in {"policy", "policy_undo"} for event in base["events"])
                for version in (2,) if has_policy else (1, 2):
                    encoded = _encode({**base, "version": version})
                    remaining -= len(encoded)
                    if remaining < 0:
                        return None
                    if sha256(encoded).hexdigest() == revision:
                        return review_count
    return None

def restore_source(ctx):
    """원문 hash가 일치하는 전체 이력만 baseline 원문으로 사용한다."""
    # history에서 실제로 일치하는 옛 본문을 찾는다. 복원 실패는 상태로 남기고 임의의 이전 본문을 발명하지 않는다.
    if ctx.baseline is not None:
        if ctx.baseline["source_revision"] == ctx.sources[ctx.document].revision:
            ctx.old_source = ctx.sources[ctx.document]
            ctx.restoration["source"] = "current_match"
        elif ctx.root["history_revision"] is not None:
            for filename in ctx.history_names[ctx.document]:
                if filename == "changes.json":
                    continue
                try:
                    path = ctx.owner.store._document_path(ctx.owner.store.history_dir, ctx.document) / filename
                    raw_old = ctx.owner.ontology._context_bytes(path, ctx.remaining, ctx.document, "source")
                    if sha256(raw_old).hexdigest() == ctx.baseline["source_revision"]:
                        ctx.old_source = DocumentSnapshot(raw_old.decode("utf-8"), ctx.baseline["source_revision"])
                        ctx.restoration["source"] = "matching_archive"
                        break
                except (OSError, ValueError, TypeError) as error:
                    code = "byte_budget" if isinstance(error, _ContextBudgetError) else _connection_error(error)
                    ctx.skip(ctx.document, code, "baseline_source")
                    if code == "byte_budget":
                        break
        if ctx.old_source is None:
            ctx.restoration["source"] = "unavailable"
            ctx.skip(ctx.document, "baseline_source_unavailable", "baseline_source", omitted=False)
