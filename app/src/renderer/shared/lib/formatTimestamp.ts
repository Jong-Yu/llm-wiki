const timestampFormat = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 서버가 제공한 실제 시각만 사용자의 시간대로 일정하게 표시합니다. */
export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '시각 확인 불가';
  const parts = timestampFormat.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item: Intl.DateTimeFormatPart): boolean => item.type === type)
      ?.value ?? '';
  return `${part('year')}.${part('month')}.${part('day')} ${part('hour')}:${part('minute')}`;
}

/** 상세 설명에는 날짜·시각과 해석한 시간대를 함께 제공합니다. */
export function formatTimestampWithZone(value: string): string {
  return `${formatTimestamp(value)} (${timestampFormat.resolvedOptions().timeZone})`;
}
