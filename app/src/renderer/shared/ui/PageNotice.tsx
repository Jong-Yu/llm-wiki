import type { JSX, ReactNode } from 'react';
import { StatusNotice } from './StatusNotice';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import styles from './PageNotice.module.scss';

export type ConnectionNoticeKind =
  | 'ai-required'
  | 'chat-ai-required'
  | 'chat-ai-error'
  | 'server-disconnected';
type ConnectionNoticeProps = {
  kind: ConnectionNoticeKind;
  /** 호출자가 정한 버튼 하나(예: AI 연결하기 링크, 다시 연결 버튼). */
  action?: ReactNode;
  className?: string;
};
type EmptyStateProps = {
  title: ReactNode;
  icon?: IconName;
  description?: ReactNode;
  /** 현재 계정·필요한 권한 같은 보조 안내. */
  detail?: ReactNode;
  /** 돌아가기·다시 시도 중 하나만 둡니다. */
  action?: ReactNode;
  /** 본문 영역 전체를 채우는 패널(카드)로 보여 줍니다. 뒤 바탕만 보이지 않게 할 때 씁니다. */
  framed?: boolean;
  className?: string;
};

const connectionNotices: Record<
  ConnectionNoticeKind,
  { tone: 'warning' | 'error'; title: string; text: string }
> = {
  'ai-required': {
    tone: 'warning',
    title: '연결 필요',
    text: 'AI가 연결되어 있지 않아 문서 분석과 질문을 할 수 없습니다.',
  },
  'chat-ai-required': {
    tone: 'warning',
    title: 'AI가 연결되어 있지 않아요',
    text: '연결하면 질문할 수 있습니다.',
  },
  'chat-ai-error': {
    tone: 'error',
    title: 'AI 연결을 확인해 주세요',
    text: 'AI 설정에서 오류 원인을 확인하고 다시 시도해 주세요.',
  },
  'server-disconnected': {
    tone: 'error',
    title: '서버 연결 끊김',
    text: '서버에 연결할 수 없어 저장과 조회가 멈췄습니다. 작성 중인 내용은 이 화면에 남아 있습니다.',
  },
};

/** 화면 맨 위에 두는 연결 안내 한 줄입니다. 연결 상태 판단은 호출자가 합니다. */
export function ConnectionNotice({
  kind,
  action,
  className,
}: ConnectionNoticeProps): JSX.Element {
  const notice = connectionNotices[kind];
  const chat = kind.startsWith('chat-');
  return (
    <StatusNotice
      variant={chat ? 'box' : 'bar'}
      tone={notice.tone}
      title={notice.title}
      action={action}
      className={[chat ? styles.chatLine : styles.line, className]
        .filter(Boolean)
        .join(' ')}
    >
      {notice.text}
    </StatusNotice>
  );
}

/**
 * 권한 없음·불러오기 실패처럼 본문 자리를 대신하는 빈 상태입니다. 우회 동작을 두지 않습니다.
 * 사용 예:
 * <EmptyState title="문서를 불러오지 못했습니다" description="잠시 후 다시 시도해 주세요."
 *   action={<Button>다시 시도</Button>} />
 */
export function EmptyState({
  title,
  icon,
  description,
  detail,
  action,
  framed = false,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      role="status"
      data-framed={framed ? '' : undefined}
      className={[styles.empty, framed ? styles.framed : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      {icon && <Icon name={icon} size={32} className={styles.emptyIcon} />}
      <strong className={styles.emptyTitle}>{title}</strong>
      {description != null && <p>{description}</p>}
      {detail != null && <p className={styles.detail}>{detail}</p>}
      {action != null && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}
