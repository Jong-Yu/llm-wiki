import type { JSX } from 'react';

type ExportFormatSelectProps<T extends string> = {
  /** 현재 실행 환경에서 쓸 수 있는 형식입니다. 화면이 넘기며 이 컴포넌트는 환경을 조회하지 않습니다. */
  formats: readonly T[];
  labels: Record<T, string>;
  value: T;
  disabled?: boolean;
  className?: string;
  onChange: (format: T) => void;
};

/** 고른 형식만 알리며 변환·저장은 호출자의 내려받기 동작이 맡습니다. */
export function ExportFormatSelect<T extends string>({
  formats,
  labels,
  value,
  disabled,
  className,
  onChange,
}: ExportFormatSelectProps<T>): JSX.Element | null {
  const first = formats[0];
  if (formats.length < 2 || first === undefined) return null;
  return (
    <select
      aria-label="내려받을 형식"
      className={className}
      value={formats.includes(value) ? value : first}
      disabled={disabled}
      onChange={(event: { currentTarget: { value: string } }): void => {
        const next = formats.find(
          (item: T): boolean => item === event.currentTarget.value,
        );
        if (next !== undefined) onChange(next);
      }}
    >
      {formats.map((item: T): JSX.Element => (
        <option key={item} value={item}>
          {labels[item]}
        </option>
      ))}
    </select>
  );
}
