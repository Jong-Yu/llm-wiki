export type SavedTemplate = {
  id: string;
  name: string;
  fileName: string;
  rules: string;
  example: boolean;
};
export type TemplateDraft = Omit<SavedTemplate, 'id'>;
export type ReusableScreen = 'manage' | 'chat';

export const reusableTemplates: SavedTemplate[] = [
  {
    id: 'screen',
    name: '회사 화면설계서',
    fileName: '회사_화면설계서.pptx',
    rules:
      '각 화면에 목적, 구성 요소, 동작, 예외 상태를 포함하세요.\n회사 로고와 슬라이드의 기본 배치를 유지하세요.\n근거가 없는 내용은 임의로 확정하지 말고 질문하세요.',
    example: true,
  },
  {
    id: 'report',
    name: '주간 업무보고',
    fileName: '주간업무보고.docx',
    rules:
      '이번 주 진행 내용과 다음 주 계획을 구분하세요.\n확인이 필요한 일정은 미정으로 표시하세요.',
    example: true,
  },
  {
    id: 'checklist',
    name: '요구사항 점검표',
    fileName: '요구사항점검표.xlsx',
    rules:
      '요구사항별로 근거와 확인 상태를 작성하세요.\n기존 열 순서와 수식을 유지하세요.',
    example: true,
  },
];

/** 실제 파일 내용은 읽지 않고 표시할 확장자만 구합니다. */
export function templateFileType(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '파일' : name.slice(dot + 1).toUpperCase();
}

/** 자연어 룰을 읽기 쉬운 줄 목록으로 표시합니다. */
export function templateRuleLines(rules: string): string[] {
  return rules
    .split('\n')
    .map((line: string): string => line.trim())
    .filter(Boolean);
}
