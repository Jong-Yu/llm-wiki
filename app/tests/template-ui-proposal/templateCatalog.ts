import type { ExportFormat } from '../../src/shared/contracts/fileExports.contract';
import type { SavedTemplate } from './ReusableTemplateModel';
import { reusableTemplates } from './ReusableTemplateModel';

/** 기존 선택 UI의 계약을 유지하는 시안용 카탈로그이며 AI 요청에는 연결하지 않습니다. */
export type AnswerTemplate = {
  id: string;
  name: string;
  description: string;
  suggestedFormat: ExportFormat;
  instruction: string;
};
const builtins: readonly AnswerTemplate[] = [
  {
    id: 'compare-report',
    name: '비교 분석 보고서',
    description: '비교표와 충돌·차이점을 정리한 보고서',
    suggestedFormat: 'docx',
    instruction: '비교표와 충돌·차이점, 결론 및 근거를 구분하세요.',
  },
  {
    id: 'mapping-table',
    name: '항목 매핑표',
    description: '항목을 짝지어 한 장의 표로 정리 (Excel에 적합)',
    suggestedFormat: 'xlsx',
    instruction: '항목별 대응과 근거를 표로 정리하세요.',
  },
  {
    id: 'timeline-process',
    name: '타임라인·프로세스',
    description: '단계·담당·선행 조건을 순서대로 정리',
    suggestedFormat: 'docx',
    instruction: '단계와 담당, 선행 조건 및 근거를 정리하세요.',
  },
  {
    id: 'summary-briefing',
    name: '요약 브리핑',
    description: '슬라이드로 바로 쓸 수 있는 요약 (PowerPoint에 적합)',
    suggestedFormat: 'pptx',
    instruction: '핵심 요약과 주제별 내용, 근거를 구분하세요.',
  },
];

/** 원본 형식을 그대로 보여 줄 수 있는 파일 카드인지 판단하며 다른 형식으로 치환하지 않습니다. */
export function templateOutputFormat(name: string): ExportFormat | null {
  const extension = name.split('.').at(-1)?.toLowerCase();
  if (
    extension === 'docx' ||
    extension === 'pptx' ||
    extension === 'xlsx' ||
    extension === 'pdf' ||
    extension === 'md' ||
    extension === 'txt'
  )
    return extension;
  return null;
}

/** 등록된 파일과 룰을 기존 양식 선택 목록의 표시 값으로 연결합니다. */
function catalogItem(template: SavedTemplate): AnswerTemplate {
  return {
    id: template.id,
    name: template.name,
    description: `${template.fileName} · 저장한 지침 적용`,
    suggestedFormat: templateOutputFormat(template.fileName) ?? 'docx',
    instruction: `원본 양식: ${template.fileName}\n${template.rules}`,
  };
}
export let ANSWER_TEMPLATES: readonly AnswerTemplate[] = [
  ...reusableTemplates.map(catalogItem),
  ...builtins,
];

/** 관리 화면에서 저장한 목록을 다음 선택 메뉴 열기에 반영합니다. */
export function updateSavedTemplates(templates: SavedTemplate[]): void {
  ANSWER_TEMPLATES = [...templates.map(catalogItem), ...builtins];
}

/** 선택한 번호를 찾으며 기본 답변의 빈 번호는 null로 반환합니다. */
export function templateById(id: string): AnswerTemplate | null {
  return (
    ANSWER_TEMPLATES.find((item: AnswerTemplate): boolean => item.id === id) ??
    null
  );
}
