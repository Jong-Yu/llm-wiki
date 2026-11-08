/** 파일에서 읽지 못한 부분의 고정 코드를 사용자 말로 바꿉니다. 코드 자체는 화면에 보이지 않습니다. */
const NOTES: Record<string, string> = {
  headers_footers_notes_images_or_embedded_objects_not_read:
    '머리말·각주·이미지·내장 개체는 읽지 않았어요.',
  textboxes_revision_markup_symbols_or_external_content_not_read:
    '텍스트 상자·변경 추적·기호는 읽지 않았어요.',
  nested_table_not_read: '표 안의 표는 읽지 않았어요.',
  unsupported_body_block: '읽을 수 없는 구성 요소가 있었어요.',
};

/** 알려진 코드는 각자의 문장으로, 그 밖의 코드는 한 문장으로 묶어 중복 없이 보여 줍니다. */
export function describeNotes(notes: readonly string[]): string {
  const messages: string[] = [];
  let unknown = false;
  for (const code of notes) {
    if (code === 'rows_stopped_at_limit') continue; // 큰 표는 별도 안내(앞부분만 담음)가 있습니다.
    const known = NOTES[code];
    if (known) {
      if (!messages.includes(known)) messages.push(known);
    } else unknown = true;
  }
  if (unknown) messages.push('일부 내용은 읽지 못했어요.');
  return messages.join(' ');
}
