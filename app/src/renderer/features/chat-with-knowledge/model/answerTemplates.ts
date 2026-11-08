import type { ExportFormat } from '@contracts/fileExports.contract';

/** AI에게 정해진 구조의 Markdown으로 답하게 하는 양식입니다. 변환기가 이 구조를 Word·Excel·PowerPoint로 옮깁니다. */
export type AnswerTemplate = {
  id: string;
  name: string;
  description: string;
  /** 이 양식을 고르면 내려받기 형식의 기본값으로 제안합니다. */
  suggestedFormat: ExportFormat;
  instruction: string;
};

const GROUNDING =
  '위키 근거에 없는 내용은 지어내지 말고 해당 자리에 "근거 없음"이라고 쓰세요. 코드 블록으로 감싸지 말고 Markdown만 쓰세요.';

export const ANSWER_TEMPLATES: readonly AnswerTemplate[] = [
  {
    id: 'compare-report',
    name: '비교 분석 보고서',
    description: '비교표와 충돌·차이점을 정리한 보고서',
    suggestedFormat: 'docx',
    instruction: [
      '다음 구조의 Markdown 보고서로 답하세요. 제목은 # 하나, 아래 절은 ## 제목으로 쓰고 이 순서와 이름을 지키세요.',
      '# (보고서 제목)',
      '## 요약 — 핵심 결론을 세 문장 이내로.',
      '## 비교표 — 비교 대상별 항목을 Markdown 표로. 첫 열은 항목, 다음 열은 각 대상.',
      '## 충돌·차이점 — 서로 어긋나는 부분을 항목별로, 각각 어느 문서의 어떤 내용인지 함께.',
      '## 결론 및 권고',
      '## 근거 문서 — 사용한 위키 문서를 목록으로.',
      GROUNDING,
    ].join('\n'),
  },
  {
    id: 'mapping-table',
    name: '항목 매핑표',
    description: '항목을 짝지어 한 장의 표로 정리 (Excel에 적합)',
    suggestedFormat: 'xlsx',
    instruction: [
      '하나의 Markdown 표로 정리해 답하세요. 구조는 다음과 같습니다.',
      '# (표 제목)',
      '## 매핑표 — 열은 질문에 맞게 정하되 첫 열은 기준 항목, 마지막 열은 "근거 문서"로 하세요. 셀에는 짧은 값만 쓰세요.',
      '## 비고 — 표에 담지 못한 가정·누락·불확실한 사항을 목록으로.',
      GROUNDING,
    ].join('\n'),
  },
  {
    id: 'timeline-process',
    name: '타임라인·프로세스',
    description: '단계·담당·선행 조건을 순서대로 정리',
    suggestedFormat: 'docx',
    instruction: [
      '다음 구조의 Markdown으로 답하세요.',
      '# (제목)',
      '## 개요 — 한두 문장.',
      '## 단계 — Markdown 표로. 열은 "순서 | 단계 | 담당 | 선행 조건 | 근거 문서".',
      '## 주의사항 — 목록으로.',
      GROUNDING,
    ].join('\n'),
  },
  {
    id: 'summary-briefing',
    name: '요약 브리핑',
    description: '슬라이드로 바로 쓸 수 있는 요약 (PowerPoint에 적합)',
    suggestedFormat: 'pptx',
    instruction: [
      '슬라이드 발표용 Markdown으로 답하세요. # 제목 하나로 표지를 쓰고, ## 제목마다 슬라이드 한 장이 됩니다.',
      '## 핵심 요약 — 글머리표 세 개.',
      '## (주제별 슬라이드 2~5장) — 각 슬라이드는 ## 제목과 글머리표 3~5개. 글머리표 한 줄은 40자 안팎으로 짧게.',
      '## 근거 문서 — 사용한 위키 문서를 목록으로.',
      GROUNDING,
    ].join('\n'),
  },
];

/** 저장된 질문에서 읽은 번호로 양식을 찾습니다. 앱이 바뀌어 없어진 번호는 null입니다. */
export function templateById(id: string): AnswerTemplate | null {
  return (
    ANSWER_TEMPLATES.find((item: AnswerTemplate): boolean => item.id === id) ??
    null
  );
}
