import type { JSX } from 'react';

/** 자료 행과 읽기 패널에서 사용하는 장식 문서 아이콘입니다. */
export function DocumentIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <path d="M5 2.5h6l4 4v11H5z" />
      <path d="M11 2.5v4h4M7.5 10h5M7.5 13h5" />
    </svg>
  );
}
