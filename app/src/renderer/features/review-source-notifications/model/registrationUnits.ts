import { notificationLocationKey } from '@contracts/notifications.contract';
import type { NotificationLocation } from '@contracts/notifications.contract';
import type { NotificationDetail } from './notificationView';

export type RegistrationUnit = NotificationLocation & {
  key: string;
  label: string;
  position: number;
  needsReview: boolean;
  inputRequired?: boolean;
  canBeBlank: boolean;
};
type Unit = NonNullable<
  NotificationDetail['conversion']
>['manifest']['units'][number];

/** 형식별 실제 위치를 페이지로 바꾸지 않고 짧게 표시합니다. */
function unitLabel(unit: Unit): string {
  const location = unit.location;
  if (location.kind === 'table_cells')
    return `표 ${location.table} · ${location.row}행 ${location.column}열`;
  if (location.kind === 'cells') return `${location.sheet} · ${location.cells}`;
  if (location.kind === 'whole') return '문서 전체';
  const names = {
    pages: '페이지',
    slides: '슬라이드',
    paragraphs: '문단',
    lines: '줄',
    blocks: '구간',
  };
  return `${location.start}${location.end !== location.start ? `–${location.end}` : ''}${names[location.kind]}`;
}

/** 원래 변환 단위와 실제 누락 위치를 합쳐 전체 탐색 범위를 구성합니다. */
export function registrationUnits(
  detail: NotificationDetail,
): RegistrationUnit[] {
  const entries = new Map<string, RegistrationUnit>();
  for (const unit of detail.conversion?.manifest.units ?? []) {
    const location: NotificationLocation =
      unit.location.kind === 'pages' &&
      unit.location.start === unit.location.end &&
      unit.location.start
        ? { page: unit.location.start }
        : { unit_id: unit.unit_id };
    const key = notificationLocationKey(location);
    entries.set(key, {
      ...location,
      key,
      label: unitLabel(unit),
      position: entries.size + 1,
      needsReview: false,
      canBeBlank: ['pages', 'slides'].includes(unit.location.kind),
    });
  }
  for (const review of detail.workflow.pages) {
    const key = notificationLocationKey(review);
    const current = entries.get(key);
    entries.set(
      key,
      current
        ? {
            ...current,
            needsReview: true,
            inputRequired: review.input_required && !review.correction_ref,
          }
        : {
            page: review.page,
            unit_id: review.unit_id,
            whole_document: review.whole_document,
            key,
            position: entries.size + 1,
            needsReview: true,
            canBeBlank: review.page !== undefined,
            inputRequired: review.input_required && !review.correction_ref,
            label: review.page
              ? `${review.page}페이지`
              : review.whole_document
                ? '문서 전체'
                : '변환하지 못한 구간',
          },
    );
  }
  const values = [...entries.values()];
  if (
    values.every((entry: RegistrationUnit): boolean => entry.page !== undefined)
  )
    values.sort(
      (a: RegistrationUnit, b: RegistrationUnit): number =>
        (a.page ?? 0) - (b.page ?? 0),
    );
  return values.map(
    (entry: RegistrationUnit, index: number): RegistrationUnit => ({
      ...entry,
      position: index + 1,
    }),
  );
}
