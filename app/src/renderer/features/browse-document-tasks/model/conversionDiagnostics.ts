const diagnosticMessages: ReadonlyMap<string, string> = new Map([
  [
    'picture_without_readable_text',
    '그림에서 읽을 문자를 찾지 못했습니다. 그림에 필요한 정보가 있는지 원본과 대조해 주세요.',
  ],
  [
    'small_picture_not_ocr',
    '작은 그림의 문자 인식은 생략했습니다. 필요한 내용이 있는지 원본과 대조해 주세요.',
  ],
  [
    'inherited_text_and_cached_fields_preserved_display_visibility_not_verified',
    '레이아웃에서 가져온 글자가 실제 슬라이드에 표시되는지 확인해 주세요.',
  ],
  [
    'connector_endpoint_not_resolved',
    '연결선의 시작 또는 끝 도형을 확인하지 못했습니다.',
  ],
  [
    'layout_or_master_graphics_not_read',
    '슬라이드 레이아웃·마스터의 그래픽 내용을 문자로 변환하지 못했습니다.',
  ],
  [
    'diagram_relations_estimated_by_position',
    '도형의 위치로 연결 관계를 추정했습니다. 실제 관계를 원본과 대조해 주세요.',
  ],
  [
    'diagram_relation_endpoints_unresolved',
    '일부 연결선의 끝을 확인하지 못했습니다. 도형 사이의 관계를 원본과 대조해 주세요.',
  ],
  [
    'pptx_diagram_relations_need_review',
    '도식의 연결 관계를 확인하지 못해 설명을 자동으로 추가하지 않았습니다. 원본을 확인해 주세요.',
  ],
  ['picture_content_not_read', '그림의 내용을 읽지 못했습니다.'],
  [
    'picture_too_large_not_read',
    '그림이 처리할 수 있는 크기를 넘어 내용을 읽지 못했습니다.',
  ],
  [
    'ocr_low_or_missing_confidence_text_retained_manual_review_required',
    '인식한 문자는 보관됐지만 정확도를 확인해야 합니다. 원본과 대조해 주세요.',
  ],
]);

const contentGapCodes: ReadonlySet<string> = new Set([
  'connector_endpoint_not_resolved',
  'layout_or_master_graphics_not_read',
  'picture_content_not_read',
  'picture_too_large_not_read',
]);

/** 위치가 붙은 보고와 개별 진단에서 같은 원인 코드를 읽습니다. */
function diagnosticCode(value: string): string {
  return value.slice(value.lastIndexOf(':') + 1).trim();
}

/** 알려진 내용 경고만 원인별로 한 번 표시하며 도구 버전이나 미확인 원인은 해석하지 않습니다. */
export function conversionDiagnosticMessages(
  values: readonly string[],
): string[] {
  const messages = new Set<string>();
  for (const value of values) {
    const message = diagnosticMessages.get(diagnosticCode(value));
    if (message) messages.add(message);
  }
  return [...messages];
}

/** 실제 미변환 범위에 기록된 그림·도식 원인만 내용 보완 안내로 연결합니다. */
export function conversionGapExplanation(
  unreadRanges: readonly string[],
): { body: string; next: string } | null {
  const gaps = unreadRanges.filter((value: string): boolean =>
    contentGapCodes.has(diagnosticCode(value)),
  );
  const messages = conversionDiagnosticMessages(gaps);
  // 모르는 미변환 사유가 섞였으면 내용 보완만으로 해결된다고 안내하지 않습니다.
  if (messages.length === 0 || gaps.length !== unreadRanges.length) return null;
  return {
    body: messages.join(' '),
    next: '원본과 변환된 내용을 대조하고, 누락된 글자나 그림·도식 설명을 보완해 주세요.',
  };
}
