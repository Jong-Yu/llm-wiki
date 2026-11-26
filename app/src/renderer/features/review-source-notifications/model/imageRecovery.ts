import type { NotificationDetail } from './notificationView';

/** 저신뢰 경고와 실제 보관 단위가 일대일로 맞는 PPTX 슬라이드만 복구 대상으로 표시합니다. */
export function imageRecoveryUnits(
  detail: NotificationDetail | null,
): string[] {
  const report = detail?.conversion;
  if (
    !detail ||
    detail.source_format !== 'pptx' ||
    !report ||
    report.manifest.complete ||
    detail.workflow.state !== 'review' ||
    detail.workflow.blocked_reason ||
    !report.manifest.unread_ranges.length
  )
    return [];
  const ids = new Set<string>();
  for (const range of report.manifest.unread_ranges) {
    const match =
      /^slide ([1-9][0-9]*): ocr_low_or_missing_confidence_text_retained_manual_review_required$/.exec(
        range,
      );
    if (!match) return [];
    const number = Number(match[1]);
    const matches = report.manifest.units.filter(
      (unit: (typeof report.manifest.units)[number]): boolean =>
        unit.location.kind === 'slides' &&
        typeof unit.location.start === 'number' &&
        typeof unit.location.end === 'number' &&
        unit.location.start <= number &&
        unit.location.end >= number,
    );
    const unit = matches[0];
    if (
      matches.length !== 1 ||
      !unit ||
      unit.location.kind !== 'slides' ||
      unit.location.start !== number ||
      unit.location.end !== number ||
      !report.components[unit.unit_id]?.trim() ||
      !detail.workflow.pages.some(
        (target: NotificationDetail['workflow']['pages'][number]): boolean =>
          target.unit_id === unit.unit_id &&
          !target.input_required &&
          !target.correction_ref,
      )
    )
      return [];
    ids.add(unit.unit_id);
  }
  return ids.size <= 40 ? [...ids] : [];
}
