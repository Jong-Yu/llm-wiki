import { z } from 'zod';
import { isDocumentPath } from '@contracts/documents.contract';
import type { analysisLocationSchema } from '@contracts/workspace.contract';

const numeric = z
  .string()
  .regex(/^[1-9][0-9]{0,5}$|^1000000$/, '1–1000000의 정수를 입력해 주세요.');
export const locationFieldsSchema = z
  .object({
    kind: z.enum([
      'whole',
      'lines',
      'pages',
      'cells',
      'blocks',
      'paragraphs',
      'table_cells',
    ]),
    start: z.string(),
    end: z.string(),
    sheet: z.string(),
    cells: z.string(),
    table: z.string(),
    row: z.string(),
    column: z.string(),
  })
  .superRefine((value: LocationFields, context: z.RefinementCtx): void => {
    if (['lines', 'pages', 'blocks', 'paragraphs'].includes(value.kind)) {
      if (!numeric.safeParse(value.start).success)
        context.addIssue({
          code: 'custom',
          path: ['start'],
          message: '시작 위치를 1–1000000의 정수로 입력해 주세요.',
        });
      if (
        !numeric.safeParse(value.end).success ||
        Number(value.end) < Number(value.start)
      )
        context.addIssue({
          code: 'custom',
          path: ['end'],
          message: '끝 위치는 시작 이상인 정수여야 합니다.',
        });
    }
    if (value.kind === 'table_cells') {
      for (const field of ['table', 'row', 'column'] as const) {
        if (!numeric.safeParse(value[field]).success)
          context.addIssue({
            code: 'custom',
            path: [field],
            message: '표·행·열 번호는 1–1000000의 정수여야 합니다.',
          });
      }
    }
    if (value.kind === 'cells') {
      if (!value.sheet.trim() || value.sheet.length > 200)
        context.addIssue({
          code: 'custom',
          path: ['sheet'],
          message: '시트 이름을 입력해 주세요.',
        });
      if (
        !/^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/.test(
          value.cells,
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['cells'],
          message: 'A1 또는 A1:B2 형식으로 입력해 주세요.',
        });
    }
  });
export type LocationFields = {
  kind:
    | 'whole'
    | 'lines'
    | 'pages'
    | 'cells'
    | 'blocks'
    | 'paragraphs'
    | 'table_cells';
  start: string;
  end: string;
  sheet: string;
  cells: string;
  table: string;
  row: string;
  column: string;
};
export type AnalysisLocation = z.infer<typeof analysisLocationSchema>;
const outputFields = z.object({
  document: z
    .string()
    .min(1, '저장할 문서 경로를 입력해 주세요.')
    .max(4096)
    .refine(isDocumentPath, '상대 Markdown 경로를 입력해 주세요.'),
  title: z.string().trim().min(1, '제목을 입력해 주세요.').max(200),
  purpose: z.string().trim().min(1, '목적을 입력해 주세요.').max(1000),
  selectedRanges: z.array(z.string()),
  outputs: z
    .array(z.enum(['wiki', 'ontology']))
    .min(1, '산출물을 선택해 주세요.')
    .max(2),
});
export const planFieldsSchema = z
  .object({
    locations: z.array(locationFieldsSchema).min(1).max(100),
    outputs: z.array(outputFields).min(1).max(8),
    contexts: z
      .array(
        z.object({
          document: z
            .string()
            .refine(isDocumentPath, '참고 Wiki를 선택해 주세요.'),
          required: z.boolean(),
          reason: z
            .string()
            .trim()
            .min(1, '함께 읽는 이유를 입력해 주세요.')
            .max(1000),
        }),
      )
      .max(7),
  })
  .superRefine((value: PlanFields, context: z.RefinementCtx): void => {
    if (
      new Set(
        value.outputs.map(
          (output: PlanFields['outputs'][number]): string => output.document,
        ),
      ).size !== value.outputs.length
    )
      context.addIssue({
        code: 'custom',
        path: ['outputs'],
        message: '산출물 문서 경로가 중복됩니다.',
      });
    if (
      new Set(
        value.contexts.map(
          (item: PlanFields['contexts'][number]): string => item.document,
        ),
      ).size !== value.contexts.length
    )
      context.addIssue({
        code: 'custom',
        path: ['contexts'],
        message: '문맥 문서가 중복됩니다.',
      });
    if (
      value.locations.length > 1 &&
      value.locations.some(
        (range: LocationFields): boolean => range.kind === 'whole',
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['locations'],
        message: '전체 범위와 개별 범위를 함께 지정하지 마세요.',
      });
    for (const [index, output] of value.outputs.entries()) {
      if (
        output.selectedRanges.some(
          (selected: string): boolean =>
            !/^[0-9]+$/.test(selected) || !value.locations[Number(selected)],
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['outputs', index, 'selectedRanges'],
          message: '삭제되거나 없는 분석 범위를 다시 선택해 주세요.',
        });
    }
  });
export type PlanFields = {
  locations: LocationFields[];
  outputs: {
    document: string;
    title: string;
    purpose: string;
    selectedRanges: string[];
    outputs: ('wiki' | 'ontology')[];
  }[];
  contexts: { document: string; required: boolean; reason: string }[];
};
export const conversionFieldsSchema = z
  .object({
    method: z.enum(['verbatim', 'pdf_text', 'ocr', 'xlsx_values', 'docx_text']),
    units: z
      .array(
        z.object({
          unitId: z
            .string()
            .regex(
              /^[a-zA-Z0-9_-]{1,64}$/,
              '영문·숫자·밑줄·하이픈 64자 이내 ID를 입력해 주세요.',
            ),
          location: locationFieldsSchema,
          content: z.string(),
        }),
      )
      .min(1)
      .max(1000),
    complete: z.boolean(),
    unreadRanges: z.string(),
    warnings: z.string(),
  })
  .superRefine((value: ConversionFields, context: z.RefinementCtx): void => {
    if (
      new Set(
        value.units.map(
          (unit: ConversionFields['units'][number]): string => unit.unitId,
        ),
      ).size !== value.units.length
    )
      context.addIssue({
        code: 'custom',
        path: ['units'],
        message: '보고 단위 ID가 중복됩니다.',
      });
    if (value.complete && value.unreadRanges.trim())
      context.addIssue({
        code: 'custom',
        path: ['complete'],
        message: '미독 범위가 있으면 완전 보고로 표시할 수 없습니다.',
      });
    if (
      value.units.reduce(
        (total: number, unit: ConversionFields['units'][number]): number =>
          total + new TextEncoder().encode(unit.content).byteLength,
        0,
      ) >
      4 * 1024 * 1024
    )
      context.addIssue({
        code: 'custom',
        path: ['units'],
        message: '변환 문자 전체는 UTF-8 4 MiB 이내여야 합니다.',
      });
    for (const [field, valueText] of [
      ['unreadRanges', value.unreadRanges],
      ['warnings', value.warnings],
    ]) {
      const lines = valueText
        .split('\n')
        .filter((line: string): boolean => line.trim().length > 0);
      if (
        lines.length > 100 ||
        lines.some((line: string): boolean => line.length > 1000)
      )
        context.addIssue({
          code: 'custom',
          path: [field],
          message: '100줄 이내, 각 줄 1000자 이내로 입력해 주세요.',
        });
    }
  });
export type ConversionFields = {
  method: 'verbatim' | 'pdf_text' | 'ocr' | 'xlsx_values' | 'docx_text';
  units: { unitId: string; location: LocationFields; content: string }[];
  complete: boolean;
  unreadRanges: string;
  warnings: string;
};

/** 전체·페이지·셀·줄의 빈 필드를 서버의 명시 null 계약으로 변환합니다. */
export function analysisLocation(value: LocationFields): AnalysisLocation {
  if (value.kind === 'table_cells')
    return {
      kind: value.kind,
      table: Number(value.table),
      row: Number(value.row),
      column: Number(value.column),
    };
  return {
    kind: value.kind,
    start: ['lines', 'pages', 'blocks', 'paragraphs'].includes(value.kind)
      ? Number(value.start)
      : null,
    end: ['lines', 'pages', 'blocks', 'paragraphs'].includes(value.kind)
      ? Number(value.end)
      : null,
    sheet: value.kind === 'cells' ? value.sheet : null,
    cells: value.kind === 'cells' ? value.cells : null,
  };
}
/** 새 입력은 실제 선택 전까지 범위·문서·목적을 임의 생성하지 않습니다. */
export function emptyLocation(): LocationFields {
  return {
    kind: 'whole',
    start: '1',
    end: '1',
    sheet: '',
    cells: '',
    table: '1',
    row: '1',
    column: '1',
  };
}
/** 산출물의 문서·제목·목적은 사용자가 명시합니다. */
export function emptyOutput(): PlanFields['outputs'][number] {
  return {
    document: '',
    title: '',
    purpose: '',
    selectedRanges: [],
    outputs: ['wiki'],
  };
}
/** 기본 계획은 전체 범위와 비어 있는 한 산출물로 시작합니다. */
export function emptyPlan(): PlanFields {
  return {
    locations: [emptyLocation()],
    outputs: [emptyOutput()],
    contexts: [],
  };
}
/** 선택 원본에 맞는 변환 보고 방법만 기본으로 제시하고 문자는 만들지 않습니다. */
export function emptyConversion(format: string): ConversionFields {
  const location = emptyLocation();
  const kinds = conversionLocationKinds(format);
  location.kind =
    kinds.find((kind: LocationFields['kind']): boolean => kind !== 'whole') ??
    'whole';
  const method = conversionMethods(format)[0] ?? 'verbatim';
  return {
    method,
    units: [{ unitId: '', location, content: '' }],
    complete: false,
    unreadRanges: '',
    warnings: '',
  };
}

/** 원본 형식이 제공하는 실제 위치 종류만 제안합니다. DOCX는 물리 페이지를 추정하지 않습니다. */
export function conversionLocationKinds(
  format: string,
): LocationFields['kind'][] {
  if (format === 'pdf') return ['whole', 'pages'];
  if (format === 'xlsx') return ['whole', 'cells'];
  if (format === 'docx')
    return ['whole', 'blocks', 'paragraphs', 'table_cells'];
  if (format === 'md' || format === 'txt') return ['whole', 'lines'];
  return ['whole', 'pages'];
}
/** 바이너리 형식을 UTF-8 문자 그대로인 것으로 제시하지 않습니다. */
export function conversionMethods(
  format: string,
): ConversionFields['method'][] {
  if (format === 'pdf') return ['pdf_text', 'ocr'];
  if (format === 'xlsx') return ['xlsx_values', 'ocr'];
  if (format === 'docx') return ['docx_text'];
  if (format === 'md' || format === 'txt') return ['verbatim'];
  return ['ocr'];
}
