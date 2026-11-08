/** 제목(파일명은 확장자를 뺀 제목)에서 위키 저장 이름의 기본 이름을 만듭니다. */
export function baseNameFromTitle(title: string): string {
  const cleaned = Array.from(title)
    .map((character: string): string =>
      character.charCodeAt(0) < 32 ? ' ' : character,
    )
    .join('')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return cleaned || '새-문서';
}

/** 파일명에서 확장자를 뺀 문서 제목을 만듭니다(제목 상한 200자). */
export function titleFromFilename(filename: string): string {
  return (
    filename.replace(/\.[^.]+$/, '').slice(0, 200) || filename.slice(0, 200)
  );
}

/** 기본 이름에 번호를 붙인 저장 경로입니다. 번호가 없으면 기본 경로입니다. 예: 운영-가이드-2.md */
export function targetWithNumber(base: string, number: number): string {
  return number <= 1 ? `${base}.md` : `${base}-${number}.md`;
}
