import type { JSX } from 'react';
import { Dialog } from './Dialog';

type SaveCleanupNoticeProps = { count: number; onClose: () => void };

/** 저장 성공과 임시 파일 정리 경고를 분리해 같은 쓰기의 반복을 막습니다. */
export function SaveCleanupNotice({
  count,
  onClose,
}: SaveCleanupNoticeProps): JSX.Element {
  return (
    <Dialog
      open
      title="저장은 완료됐습니다"
      description="임시 파일 정리 안내"
      closeLabel="확인"
      onOpenChange={(open: boolean): void => {
        if (!open) onClose();
      }}
    >
      <p>
        저장된 내용은 반영됐으며 임시 파일 정리 문제가 {count}건 보고됐습니다.
      </p>
      <p>같은 저장을 다시 보낼 필요는 없습니다.</p>
    </Dialog>
  );
}
