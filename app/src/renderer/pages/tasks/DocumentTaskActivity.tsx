import type { JSX } from 'react';
import { Link } from 'react-router';

/** 상태바는 문서 목록으로 연결하며 이 기기의 불완전한 기록으로 해결 필요 수를 단정하지 않습니다. */
export function DocumentTaskActivity(): JSX.Element {
  return <Link to="/documents">문서 진행 ›</Link>;
}
