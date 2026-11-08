/** 경로는 그대로 보존하고 사람이 읽는 이름에서만 서버 식별자를 감춥니다. */
export function documentDisplayName(path: string, title?: string): string {
  const opaque =
    /^(?:(?:doc(?:ument)?|source|artifact|draft)[-_])?(?:[a-f0-9]{24,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
  const supplied = title?.trim();
  const extension = /\.(?:md|txt|pdf|docx|xlsx|png|jpe?g|webp|gif|bmp|tiff?)$/i;
  if (supplied && !opaque.test(supplied.replace(extension, '')))
    return supplied;
  const filename = path.split(/[\\/]/).at(-1)?.trim() ?? '';
  const name = filename.replace(extension, '');
  return name && !opaque.test(name) ? name : '제목 없는 문서';
}
