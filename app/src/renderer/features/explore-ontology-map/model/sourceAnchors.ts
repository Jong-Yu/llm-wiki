import { z } from 'zod';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';

/** 완전한 JSON 텍스트만 읽기 표현으로 해석하며 저장 값은 변경하지 않습니다. */
export function structuredTextValue(text: string): KnowledgeJson | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const result = z.json().safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** 원문 인용의 JSON 표현만 해석하며 참조와 원래 인용 문자열은 변경하지 않습니다. */
export function sourceAnchorValue(
  anchor: KnowledgeValue,
): KnowledgeJson | undefined {
  return typeof anchor.quote === 'string'
    ? (structuredTextValue(anchor.quote) ?? anchor.quote)
    : anchor.quote;
}

/** 원문 전체를 노드 이름으로 쓰지 않고 근거 종류와 실제 줄 위치로 구분합니다. */
export function sourceAnchorLabel(anchor: KnowledgeValue): string {
  const value = sourceAnchorValue(anchor);
  const metadata =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ['original_record_id', 'original_sha256', 'metadata_role'].some(
      (key: string): boolean => key in value,
    );
  const name =
    typeof anchor.label === 'string' && anchor.label.trim()
      ? anchor.label.trim().replace(/\s+/g, ' ').slice(0, 80)
      : metadata
        ? '원문 메타데이터'
        : '원문 근거';
  const start = anchor.start_line;
  const end = anchor.end_line;
  return typeof start === 'number' && Number.isInteger(start) && start > 0
    ? `${name} · ${typeof end === 'number' && Number.isInteger(end) && end > start ? `${start}–${end}` : start}행`
    : name;
}
