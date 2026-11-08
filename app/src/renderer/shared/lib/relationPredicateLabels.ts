/** 화면에 보이는 관계 이름표(확정 용어)이며 저장 값은 영문 술어 그대로입니다. */
export const relationPredicateLabels: Record<string, string> = {
  uses: '사용',
  depends_on: '의존성',
  part_of: '소속',
  implements: '구현',
  related_to: '연관',
  authored_by: '작성',
  subclass_of: '하위 분류',
  instance_of: '인스턴스',
  composed_of: '포함 구성요소',
  located_in: '위치',
  has_input: '입력값',
  has_output: '출력값',
  participates_in: '참여',
  precedes: '선행',
  causes: '원인 유발',
  enables: '활성화',
  prevents: '차단',
  predicts: '예측',
  supports_prediction: '예측 근거',
  measures: '측정',
  observes: '모니터링',
  view_of: '관점',
  same_as: '동일 대상',
  different_from: '상이 대상',
  responsible_for: '담당',
  approves: '승인',
  follows_reference: '참조 연결',
  follow_reference: '참조 연결',
  has_source_metadata: '원문 메타데이터',
};

/** 알려진 술어는 한국어 이름표로, 그 밖의 값은 저장된 그대로 보여 줍니다. */
export function relationPredicateLabel(predicate: string): string {
  return relationPredicateLabels[predicate] ?? predicate;
}
