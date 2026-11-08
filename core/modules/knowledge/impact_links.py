"""현재 명시 링크와 복원 원문에서 사라진 링크를 구분해 유지한다."""

# 현재 원문에 있는 명시 링크와 옛 본문에는 있었지만 사라진 링크를 각각 기록한다.
# 링크는 문서 데이터다. 링크를 발견했다고 내용을 명령으로 실행하거나 자동 수정하지 않는다.

from core.modules.ontology.connections import _link_target
from core.modules.ontology.connections import _source_links
from core.modules.documents.metadata import parse_document
from . import contracts
import stat


def collect_links(ctx):
    """현재 원문의 제한된 전체 링크와 대조해야 삭제된 링크로 표시한다."""
    # 현재 링크와 복원한 옛 링크를 비교한다. 제거된 링크도 과거 근거로 남기되 현재 연결과 구분한다.
    ctx.explicit = [{**item, "origin": "current", "change": "current"} for item in ctx.connections["explicit_links"]]
    if ctx.old_source is not None and ctx.old_source.revision != ctx.sources[ctx.document].revision:
        try:
            current_parsed = parse_document(ctx.sources[ctx.document].content)
            old_parsed = parse_document(ctx.old_source.content)
        except ValueError:
            ctx.skip(ctx.document, "invalid_document_metadata", "baseline_source")
            return
        # Connections intentionally return one edge per document pair. A
        # second fragment may still exist even when its edge was deduped.
        # Prove absence against the bounded current source, not its output.
        current_targets, current_links_complete = set(), True
        for index, (href, _) in enumerate(_source_links(ctx.sources[ctx.document].content, parsed=current_parsed)):
            if index >= contracts.MAX_CONNECTION_LINKS:
                current_links_complete = False
                ctx.skip(ctx.document, "link_budget", "current_source")
                break
            if isinstance(href, str) and len(href) > contracts.MAX_LINK_HREF_CHARACTERS:
                current_links_complete = False
                ctx.skip(ctx.document, "link_href_too_long", "current_source")
                continue
            destination = _link_target(ctx.document, href)
            if destination is None:
                continue
            name, _ = destination
            try:
                path = ctx.owner.store._document_path(ctx.owner.store.wiki_dir, name)
                try:
                    info = path.stat()
                    name = ctx.captured["identities"].get((info.st_dev, info.st_ino), name)
                except FileNotFoundError:
                    pass
            except (OSError, ValueError, TypeError):
                continue
            current_targets.add(name)
        seen = set()
        for index, (href, evidence) in enumerate(_source_links(ctx.old_source.content, parsed=old_parsed)):
            if index >= contracts.MAX_CONNECTION_LINKS:
                ctx.skip(ctx.document, "link_budget", "baseline_source")
                break
            if isinstance(href, str) and len(href) > contracts.MAX_LINK_HREF_CHARACTERS:
                ctx.skip(ctx.document, "link_href_too_long", "baseline_source")
                continue
            target = _link_target(ctx.document, href)
            if target is None:
                continue
            name, fragment = target
            try:
                path = ctx.owner.store._document_path(ctx.owner.store.wiki_dir, name)
                try:
                    info = path.stat()
                    name = ctx.captured["identities"].get((info.st_dev, info.st_ino), name)
                    status = "resolved" if name in ctx.sources else "unscanned" if stat.S_ISREG(info.st_mode) else "unavailable"
                except FileNotFoundError:
                    status = "missing"
            except (OSError, ValueError, TypeError):
                continue
            if not current_links_complete or name == ctx.document or name in current_targets or name in seen:
                continue
            seen.add(name)
            if len(ctx.explicit) >= 2 * contracts.MAX_CONNECTION_LIMIT:
                ctx.skip(ctx.document, "reference_budget", "baseline_source")
                break
            ctx.explicit.append({"source_document": ctx.document, "source_revision": ctx.old_source.revision,
                             "target_document": name, "target_revision": ctx.sources[name].revision if name in ctx.sources else None,
                             "target_status": status, "direction": "outgoing", "href": href, "fragment": fragment,
                             "evidence": evidence, "origin": "baseline_source", "change": "removed"})
