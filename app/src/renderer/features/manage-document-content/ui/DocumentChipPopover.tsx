import type { JSX } from 'react';
import { MetadataPopover } from '@renderer/shared/ui/MetadataPopover';
import type { MetadataPopoverProps } from '@renderer/shared/ui/MetadataPopover';

/** 기존 문서의 속성 칩 계약을 공용 말풍선에 연결합니다. */
export function DocumentChipPopover(props: MetadataPopoverProps): JSX.Element {
  return <MetadataPopover {...props} />;
}
