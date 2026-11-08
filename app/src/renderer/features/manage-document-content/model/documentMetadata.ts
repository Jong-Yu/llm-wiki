import { z } from 'zod';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { DocumentContent } from '@contracts/documents.contract';

export const editableMetadataSchema = z.object({
  title: z.string().trim().min(1, '제목을 입력해 주세요.').max(200),
  tags: z
    .string()
    .max(10100)
    .refine(
      (value: string): boolean =>
        value.split(',').filter((item: string): boolean => !!item.trim())
          .length <= 100 &&
        value
          .split(',')
          .map((item: string): string => item.trim())
          .filter(Boolean)
          .every((item: string): boolean => item.length <= 100),
      '태그는 각각 100자 이내로 입력하세요.',
    ),
  description: z.string().max(4000),
});
export type EditableMetadata = z.infer<typeof editableMetadataSchema>;

/** 서버가 분리한 메타데이터만 초기값으로 쓰며 문서 ID·원본 연결은 폼에서 받지 않습니다. */
export function metadataFields(base: DocumentContent): EditableMetadata {
  const metadata = base.metadata;
  return {
    title:
      typeof metadata?.title === 'string'
        ? metadata.title
        : (base.document.replace(/\.md$/, '').split('/').at(-1) ??
          base.document),
    tags: Array.isArray(metadata?.tags)
      ? metadata.tags
          .filter(
            (value: unknown): value is string => typeof value === 'string',
          )
          .join(', ')
      : '',
    description:
      typeof metadata?.description === 'string' ? metadata.description : '',
  };
}

/** 서버가 확인한 Front Matter가 있는 파일에서만 헤더와 본문을 나눕니다. */
export function draftParts(
  base: DocumentContent,
  content: string,
): { header: string; body: string } {
  if (!base.documentId || base.body === undefined)
    return { header: '', body: content };
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('document_metadata_changed');
  return { header: match[0], body: content.slice(match[0].length) };
}

/** 원래 YAML의 표기와 관계없이 업무 메타정보만 읽으며 저장용 헤더는 변경하지 않습니다. */
export function documentMetadataPreview(header: string): string {
  if (!header) return '';
  try {
    const value = load(
      header.replace(/^---\r?\n/, '').replace(/\r?\n---(?:\r?\n)?$/, ''),
      { schema: JSON_SCHEMA },
    );
    const fields = z
      .object({
        title: z.string(),
        tags: z.array(z.string()),
        description: z.string().optional(),
      })
      .parse(value);
    const indent = (text: string, spaces: number): string =>
      text
        .split('\n')
        .map((line: string): string => `${' '.repeat(spaces)}${line}`)
        .join('\n');
    return [
      `제목:\n${indent(fields.title, 2)}`,
      fields.tags.length
        ? `태그:\n${fields.tags.map((tag: string): string => `  • ${tag.replaceAll('\n', '\n    ')}`).join('\n')}`
        : '태그: 없음',
      ...(fields.description !== undefined
        ? [`설명:\n${indent(fields.description, 2)}`]
        : []),
    ].join('\n');
  } catch {
    return '문서 정보의 형식을 읽을 수 없습니다.';
  }
}

/** 앱이 직렬화한 수정안만 다시 읽고 임의 YAML의 의미는 서버 조회값을 사용합니다. */
export function draftMetadataFields(
  base: DocumentContent,
  content: string,
): EditableMetadata {
  const initial = metadataFields(base);
  if (content === base.content || !base.documentId) return initial;
  try {
    const lines = draftParts(base, content)
      .header.trim()
      .split(/\r?\n/)
      .slice(1, -1);
    const values: Record<string, unknown> = {};
    for (const line of lines) {
      const index = line.indexOf(':');
      if (index < 0) return initial;
      values[line.slice(0, index)] = JSON.parse(line.slice(index + 1));
    }
    return editableMetadataSchema.parse({
      title: values.title,
      description: values.description ?? '',
      tags: Array.isArray(values.tags)
        ? values.tags
            .filter(
              (value: unknown): value is string => typeof value === 'string',
            )
            .join(', ')
        : '',
    });
  } catch {
    return initial;
  }
}

/** 기존 헤더를 바꾸지 않고 본문만 교체하여 전체 파일 CAS를 유지합니다. */
export function replaceBody(
  base: DocumentContent,
  content: string,
  body: string,
): string {
  return draftParts(base, content).header + body;
}

/** 서버 소유 필드는 원래 조회에서 복사하고 설명 필드만 안전한 YAML 값으로 직렬화합니다. */
export function replaceMetadata(
  base: DocumentContent,
  content: string,
  fields: EditableMetadata,
): string {
  if (!base.documentId || !base.metadata) return content;
  const values = editableMetadataSchema.parse(fields);
  const metadata = {
    ...base.metadata,
    title: values.title,
    tags: [
      ...new Set(
        values.tags
          .split(',')
          .map((item: string): string => item.trim())
          .filter(Boolean),
      ),
    ],
    description: values.description,
  };
  return `---\n${Object.entries(metadata)
    .map(
      ([key, value]: [string, unknown]): string =>
        `${key}: ${JSON.stringify(value)}`,
    )
    .join('\n')}\n---\n${draftParts(base, content).body}`;
}

/** 작성 표시는 서버 원장의 origin과 실제 요청자를 구분하며 미기록 값을 추정하지 않습니다. */
export function authorshipLabel(
  authorship: DocumentContent['authorship'],
  principal?: { userId: string; displayName: string },
): string {
  const change = authorship?.updated;
  if (!change || authorship?.status !== 'recorded')
    return authorship?.status === 'pending_reconcile'
      ? '작성 이력 확인 중'
      : '작성자 미기록';
  const origin = change.origin;
  const kind =
    typeof origin === 'string'
      ? origin
      : origin && typeof origin === 'object' && !Array.isArray(origin)
        ? origin.kind
        : null;
  const actor = change.actor;
  const user =
    actor &&
    typeof actor === 'object' &&
    !Array.isArray(actor) &&
    typeof actor.user_id === 'string'
      ? actor.user_id
      : '미기록';
  const displayName =
    actor &&
    typeof actor === 'object' &&
    !Array.isArray(actor) &&
    typeof actor.display_name === 'string' &&
    actor.display_name.trim()
      ? actor.display_name
      : principal?.userId === user
        ? principal.displayName
        : '이름 미기록';
  return `${kind === 'ai' ? 'AI 작성' : kind === 'human' ? '사람 수정' : '작성 경로 미기록'} · 요청·반영 사용자 ${displayName}`;
}
