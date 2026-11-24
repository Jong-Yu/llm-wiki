import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { DocumentTasksPage } from '@renderer/pages/tasks/DocumentTasksPage';
import { useRouteTitle } from '@renderer/shared/lib/routeTitle';
import { useThemePreference } from '@renderer/shared/theme/useThemePreference';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import styles from './Preview.module.scss';

type PageState = 'pending' | 'usable' | 'held';
type Phase =
  | 'review'
  | 'saving'
  | 'approved'
  | 'claiming'
  | 'accepting'
  | 'running'
  | 'other-pc'
  | 'complete';
type Scenario =
  | 'pending'
  | 'held'
  | 'ready'
  | 'unprepared'
  | 'other-pc'
  | 'complete'
  | 'offline'
  | 'saving'
  | 'approved'
  | 'claiming'
  | 'accepting';
type Page = { number: number; state: PageState };
type NotificationFilter = 'all' | 'unread' | 'approval';
type ScenarioOption = { value: Scenario; label: string };
type FilterOption = { value: NotificationFilter; label: string };
const title = '시스템 아키텍처 가이드';
const taskPath = '/tasks?taskId=000000000000000000000000000000c9';
const scenarios: readonly ScenarioOption[] = [
  { value: 'pending', label: '처음 알림 · 0/30쪽' },
  { value: 'held', label: '검토 중 · 8쪽 확인·1쪽 보류' },
  { value: 'ready', label: '확인 완료 · 승인 전' },
  { value: 'unprepared', label: '이 PC 실행 준비 전' },
  { value: 'saving', label: '승인 저장 중' },
  { value: 'approved', label: '승인됨 · 진행 전' },
  { value: 'claiming', label: '실행 기기 확보 중' },
  { value: 'accepting', label: '접수 확인 중' },
  { value: 'other-pc', label: '다른 PC에서 실행 중' },
  { value: 'complete', label: '처리 완료' },
  { value: 'offline', label: '연결 끊김 · 이전 기록' },
];
const phaseLabels: Record<Phase, string> = {
  review: '문자 사용 승인 대기',
  saving: '승인 저장 중',
  approved: '승인됨 · 진행 전',
  claiming: '실행 기기 확보 중',
  accepting: '접수 확인 중',
  running: '이 PC에서 실행 중',
  'other-pc': '다른 PC에서 실행 중',
  complete: '처리 완료',
};

/** 사용자가 실제 원본으로 오인하지 않도록 시안 전용 쪽을 생성합니다. */
function makePages(count: number, hold = false): Page[] {
  return Array.from({ length: 30 }, (_: unknown, index: number): Page => ({
    number: 1 + index * 5,
    state:
      index < count ? 'usable' : hold && index === count ? 'held' : 'pending',
  }));
}

/** 외부 파일이나 폰트를 읽지 않는 대조용 합성 원본 이미지입니다. */
function originalPage(page: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="650" viewBox="0 0 560 650">
  <rect width="560" height="650" fill="white"/>
  <g fill="#30363b" font-family="sans-serif">
  <text x="46" y="42" font-size="11" fill="#69717a">SYSTEM ARCHITECTURE / 화면 검토용 합성 자료</text>
  <path d="M46 60H514" stroke="#d8dcdf"/>
  <text x="46" y="105" font-size="25" font-weight="700">기록의 보관과 작업 처리</text>
  <text x="46" y="145" font-size="13">작업 기록은 서버에 보관하고 같은 계정에서 조회한다.</text>
  <text x="46" y="170" font-size="13">사용자 PC는 문서를 처리하고 결과를 서버로 전달한다.</text>
  <rect x="46" y="196" width="468" height="66" fill="#f6f7f8"/>
  <text x="62" y="222" font-size="13" font-weight="600">자료가 보관되어도 다음 단계의 승인이 필요할 수 있다.</text>
  <text x="62" y="245" font-size="13">알림을 읽는 행동과 작업을 승인하는 행동을 구별한다.</text>
  <text x="46" y="307" font-size="18" font-weight="600">1. 실행 기기의 역할</text>
  <text x="46" y="340" font-size="13">① 변환된 문자를 원본과 대조한다.</text>
  <text x="46" y="366" font-size="13">② 사용할 문자를 승인한다.</text>
  <text x="46" y="392" font-size="13">③ 준비된 한 기기에서 다음 단계를 진행한다.</text>
  <path d="M46 424H514M46 462H514M46 500H514M46 538H514" stroke="#c4c9ce"/>
  <text x="58" y="449" font-size="13" font-weight="600">보관 위치</text><text x="220" y="449" font-size="13" font-weight="600">기록</text>
  <text x="58" y="487" font-size="13">서버</text><text x="220" y="487" font-size="13">알림 · 확인 내역 · 승인</text>
  <text x="58" y="525" font-size="13">사용자 PC</text><text x="220" y="525" font-size="13">현재 실행 상태</text>
  <text x="46" y="592" font-size="11" fill="#69717a">사용자 원문을 포함하지 않는 화면 예시입니다.</text>
  <text x="514" y="620" text-anchor="end" font-size="12">${page} / 170</text></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type ReviewProps = {
  pages: Page[];
  selected: number;
  offline: boolean;
  saved: string;
  ready: boolean;
  onSelect: (index: number) => void;
  onMark: (state: PageState) => void;
  onApprove: () => void;
};

/** 쪽 확인은 명시 조작으로만 진행하며 최종 승인과 구분합니다. */
function Review({
  pages,
  selected,
  offline,
  saved,
  ready,
  onSelect,
  onMark,
  onApprove,
}: ReviewProps): JSX.Element {
  const [tab, setTab] = useState<'original' | 'text'>('original');
  const [zoom, setZoom] = useState(false);
  const [onlyHeld, setOnlyHeld] = useState(false);
  const current = pages[selected];
  const usable = pages.filter(
    (page: Page): boolean => page.state === 'usable',
  ).length;
  const held = pages.filter(
    (page: Page): boolean => page.state === 'held',
  ).length;
  const unreviewed = 30 - usable - held;
  return (
    <>
      <StatusNotice
        tone="warning"
        title="30쪽의 문자 사용 승인을 기다리고 있습니다."
      >
        전체 170쪽의 변환 문자는 보관되었습니다. 아래 쪽은 인식이 불확실해
        원본과 대조해야 합니다. 승인 후 Wiki 저장과 관계 추출을 진행합니다.
      </StatusNotice>
      <section className={styles.reviewSection} aria-label="경고 쪽 검토">
        <div className={styles.sectionHeading}>
          <div>
            <h2>원본과 문자 대조</h2>
            <p>변환 3회 · 원본 1판 · 경고가 있는 30쪽</p>
          </div>
          <div className={styles.reviewCount}>
            <strong data-review-count>
              {usable}
              <span> / 30쪽 사용 가능</span>
            </strong>
            <span>
              미확인 {unreviewed} · 보류 {held}
            </span>
          </div>
        </div>
        <progress
          value={usable}
          max={30}
          aria-label="문자 사용 가능으로 확인한 쪽"
        />
        <div className={styles.reviewGrid}>
          <nav className={styles.pageList} aria-label="확인할 쪽">
            <div className={styles.pageListHeading}>
              <strong>확인할 쪽</strong>
              <button
                type="button"
                aria-pressed={onlyHeld}
                disabled={held === 0 && !onlyHeld}
                onClick={(): void => {
                  if (!onlyHeld) {
                    const firstHeld = pages.findIndex(
                      (page: Page): boolean => page.state === 'held',
                    );
                    if (firstHeld >= 0 && current.state !== 'held')
                      onSelect(firstHeld);
                  }
                  setOnlyHeld(!onlyHeld);
                }}
              >
                보류만 {held}
              </button>
            </div>
            <div className={styles.pageNumbers}>
              {pages.map((page: Page, index: number): JSX.Element | null =>
                onlyHeld && page.state !== 'held' ? null : (
                  <button
                    key={page.number}
                    type="button"
                    aria-current={selected === index ? 'page' : undefined}
                    className={styles.pageButton}
                    onClick={(): void => onSelect(index)}
                  >
                    <span>{page.number}쪽</span>
                    <span data-state={page.state}>
                      {page.state === 'usable'
                        ? '사용 가능'
                        : page.state === 'held'
                          ? '보류'
                          : '미확인'}
                    </span>
                  </button>
                ),
              )}
              {onlyHeld && held === 0 && <p>보류한 쪽이 없습니다.</p>}
            </div>
          </nav>
          <div className={styles.comparison}>
            <div className={styles.comparisonHeading}>
              <h3 aria-live="polite">
                {current.number}쪽{' '}
                <span>
                  ·{' '}
                  {current.state === 'usable'
                    ? '사용 가능'
                    : current.state === 'held'
                      ? '보류'
                      : '미확인'}
                </span>
              </h3>
              <span className={styles.muted}>인식이 불확실한 쪽</span>
            </div>
            <div
              className={styles.mobileTabs}
              role="group"
              aria-label="대조 영역 선택"
            >
              <Button
                variant="secondary"
                aria-pressed={tab === 'original'}
                onClick={(): void => setTab('original')}
              >
                원본
              </Button>
              <Button
                variant="secondary"
                aria-pressed={tab === 'text'}
                onClick={(): void => setTab('text')}
              >
                변환 문자
              </Button>
            </div>
            <div className={styles.compareColumns} data-tab={tab}>
              <section
                className={styles.original}
                aria-label={`${current.number}쪽 원본`}
              >
                <div className={styles.paneHeading}>
                  <strong>원본 · {current.number}쪽</strong>
                  <Button
                    variant="surface"
                    size="small"
                    aria-pressed={zoom}
                    onClick={(): void => setZoom(!zoom)}
                  >
                    <Icon name="maximize-2" />
                    {zoom ? '폭 맞춤' : '확대'}
                  </Button>
                </div>
                <div
                  className={styles.paperViewport}
                  tabIndex={0}
                  aria-label="원본 쪽 이미지. 확대 시 가로로 이동할 수 있습니다."
                >
                  <img
                    className={zoom ? styles.zoomed : undefined}
                    src={originalPage(current.number)}
                    alt={`합성 원본 ${current.number}쪽. 기록의 보관과 작업 처리에 대한 문서`}
                  />
                </div>
              </section>
              <section
                className={styles.textPane}
                aria-label={`${current.number}쪽 변환 문자`}
              >
                <div className={styles.paneHeading}>
                  <strong>보관된 변환 문자</strong>
                  <span>읽기 전용</span>
                </div>
                <div className={styles.extracted} tabIndex={0}>
                  <h4>기록의 보관과 작업 처리</h4>
                  <p>
                    작업 기록은 서버에 보관하고 같은 계정에서 조회한다. 사용자
                    PC는 문서를 처리하고 결과를 서버로 전달한다.
                  </p>
                  <p>
                    자료가 보관되어도 다음 단계의 승인이 필요할 수 있다. 알림을
                    읽는 행동과 작업을 승인하는 행동을 구별한다.
                  </p>
                  <h4>1. 실행 기기의 역할</h4>
                  <p>
                    ① 변환된 문자를 원본과 대조한다.
                    <br />② 사용할 문자를 승인한다.
                    <br />③ 준비된 한 기기에서 다음 단계를 진행한다.
                  </p>
                  <p>
                    보관 위치 | 기록
                    <br />
                    서버 | 알림 · 확인 내역 · 승인
                    <br />
                    사용자 PC | 현재 실행 상태
                  </p>
                </div>
              </section>
            </div>
            <div className={styles.pageActions}>
              <p>내용이 불확실하면 보류하세요.</p>
              <div>
                <Button
                  variant="secondary"
                  disabled={offline}
                  onClick={(): void => {
                    setOnlyHeld(false);
                    onMark('held');
                  }}
                >
                  이 쪽 보류
                </Button>
                <Button
                  disabled={offline}
                  onClick={(): void => {
                    setOnlyHeld(false);
                    onMark('usable');
                  }}
                >
                  이 쪽 문자 사용 · 다음 쪽 <Icon name="arrow-right" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className={styles.approval} aria-label="최종 문자 사용 승인">
        <div>
          <h2>문자 사용 승인</h2>
          <p>
            {usable === 30
              ? '30쪽 모두 사용 가능으로 확인했습니다. 이 변환 결과를 사용하도록 승인할 수 있습니다.'
              : `사용 가능 ${usable}쪽 · 미확인 ${unreviewed}쪽 · 보류 ${held}쪽. 모든 쪽을 확인하면 승인할 수 있습니다.`}
          </p>
          <p className={styles.muted}>
            승인은 변환 문자 사용에 대한 선택입니다. 원문 정확성이나 추출된
            관계의 검토 완료를 뜻하지 않습니다.
          </p>
          <p className={styles.sync} role="status">
            <Icon name={offline ? 'circle-alert' : 'check-check'} />
            {saved}
          </p>
        </div>
        {!ready && (
          <StatusNotice title="이 PC에서 AI 실행 준비가 필요합니다.">
            승인만 먼저 저장할 수 있습니다. 준비된 다른 PC에서 같은 작업을
            이어갈 수 있습니다.
          </StatusNotice>
        )}
        <div className={styles.approvalActions}>
          <span>
            {ready
              ? '이 PC: 작업용 노트북 · 실행 준비됨'
              : '이 PC: 열람용 PC · 실행 준비 전'}
          </span>
          <Button
            data-approve
            disabled={usable !== 30 || offline}
            onClick={onApprove}
          >
            {ready ? '30쪽 사용을 승인하고 이 PC에서 계속' : '문자 사용 승인'}
          </Button>
        </div>
      </section>
    </>
  );
}

type ProgressProps = { phase: Phase; ready: boolean; onContinue: () => void };
/** 승인·접수·실행 기기·완료를 구별해 중복 실행 없이 다음 행동을 안내합니다. */
function Progress({ phase, ready, onContinue }: ProgressProps): JSX.Element {
  const completed = phase === 'complete';
  const running = phase === 'running' || phase === 'other-pc';
  const executor = phase === 'other-pc' ? '사무실 PC' : '작업용 노트북';
  return (
    <>
      <StatusNotice
        tone={completed ? 'success' : 'info'}
        title={phaseLabels[phase]}
      >
        {phase === 'saving'
          ? '30쪽의 문자 사용 승인을 저장하고 있습니다. 저장이 확인되기 전에는 다음 단계를 시작하지 않습니다.'
          : phase === 'approved'
            ? '문자 사용 승인은 저장되었습니다. 아직 다음 단계는 시작하지 않았습니다.'
            : phase === 'claiming'
              ? '이 작업을 진행할 기기를 확인하고 있습니다.'
              : phase === 'accepting'
                ? '같은 작업의 접수 결과를 확인하고 있습니다. 확인될 때까지 다시 시작하지 않습니다.'
                : phase === 'other-pc'
                  ? '사무실 PC에서 관계를 추출하고 있습니다. 이 PC에서는 진행 상황을 확인할 수 있습니다.'
                  : completed
                    ? 'Wiki 문서 저장과 관계 추출이 완료되었습니다. 결과를 열어 내용을 검토할 수 있습니다.'
                    : '보관한 변환 문자로 Wiki 저장과 관계 추출을 진행하고 있습니다.'}
      </StatusNotice>
      <ol className={styles.steps} aria-label="문서 처리 단계">
        {['문자 사용 승인', 'Wiki 저장', '관계 추출'].map(
          (label: string, index: number): JSX.Element => {
            const done =
              completed ||
              (index === 0 && phase !== 'saving') ||
              (index === 1 && running);
            const active = index === 2 && running;
            return (
              <li key={label} data-done={done}>
                <Icon
                  name={
                    done ? 'circle-check' : active ? 'loader-circle' : 'clock'
                  }
                />
                <div>
                  <strong>{label}</strong>
                  <p>
                    {done
                      ? '완료'
                      : active
                        ? '진행 중'
                        : index === 0
                          ? '저장 중'
                          : '진행 전'}
                  </p>
                </div>
              </li>
            );
          },
        )}
      </ol>
      <WorkspaceSection title="승인과 실행 기록">
        <dl className={styles.facts}>
          <div>
            <dt>승인 대상</dt>
            <dd>변환 3회 · 30쪽 · 원본 1판</dd>
          </div>
          <div>
            <dt>문자 사용 승인</dt>
            <dd>
              {phase === 'saving'
                ? '저장 확인 중'
                : '김지민 · 2026.11.24 14:12'}
            </dd>
          </div>
          <div>
            <dt>실행 기기</dt>
            <dd>
              {running || completed
                ? `${executor}${phase === 'other-pc' ? ' · 다른 PC' : ' · 이 PC'}`
                : '아직 실행하지 않음'}
            </dd>
          </div>
          <div>
            <dt>사용할 자료</dt>
            <dd>이미 보관된 170쪽의 변환 문자</dd>
          </div>
        </dl>
        {phase === 'approved' && (
          <div className={styles.inlineAction}>
            <p>
              {ready
                ? '이 PC에서 이어갈 준비가 되었습니다.'
                : '이 PC의 AI 연결을 설정하거나 준비된 다른 PC에서 이 작업을 여세요.'}
            </p>
            {ready ? (
              <Button onClick={onContinue}>이 PC에서 계속</Button>
            ) : (
              <Link to="/settings">
                실행 준비 보기 <Icon name="arrow-right" />
              </Link>
            )}
          </div>
        )}
        {phase === 'other-pc' && (
          <p className={styles.muted}>
            이 PC에서 중복 실행하지 않습니다. 실행 기기가 바뀌면 여기서 확인할
            수 있습니다.
          </p>
        )}
      </WorkspaceSection>
      {completed && (
        <WorkspaceSection title="완료된 결과">
          <div className={styles.results}>
            <Link to="/document?path=preview.md">
              <Icon name="file-text" />
              <div>
                <strong>Wiki 문서 열기</strong>
                <span>{title}</span>
              </div>
              <Icon name="arrow-right" />
            </Link>
            <Link to="/ontology?path=preview.md">
              <Icon name="network" />
              <div>
                <strong>추출 관계 검토하기</strong>
                <span>AI가 추출한 관계 · 검토 전</span>
              </div>
              <Icon name="arrow-right" />
            </Link>
          </div>
        </WorkspaceSection>
      )}
      <WorkspaceSection title="처리 이력">
        <ol className={styles.history}>
          {completed && (
            <li>
              <time>14:16</time>
              <div>
                <strong>Wiki 저장·관계 추출 완료</strong>
                <p>{executor}에서 처리했습니다.</p>
              </div>
            </li>
          )}
          {phase !== 'saving' && (
            <li>
              <time>14:12</time>
              <div>
                <strong>30쪽 문자 사용 승인</strong>
                <p>김지민 · {ready ? '작업용 노트북' : '열람용 PC'}</p>
              </div>
            </li>
          )}
          <li>
            <time>13:58</time>
            <div>
              <strong>문자 확인 요청</strong>
              <p>
                170쪽의 문자 보관 · 30쪽에 인식 경고. 원래 보고와 경고는
                보존됩니다.
              </p>
            </div>
          </li>
        </ol>
      </WorkspaceSection>
    </>
  );
}

type NotificationsProps = {
  phase: Phase;
  read: boolean;
  completionRead: boolean;
  offline: boolean;
  onRead: () => void;
  onOpen: (event: 'request' | 'completion') => void;
};
/** 읽음·승인 대기 필터와 문서의 현재 처리 상태를 함께 보여 줍니다. */
function Notifications({
  phase,
  read,
  completionRead,
  offline,
  onRead,
  onOpen,
}: NotificationsProps): JSX.Element {
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const awaiting = phase === 'review' || phase === 'saving';
  const unreadCount =
    Number(!read) + Number(phase === 'complete' && !completionRead);
  const showRequest =
    filter === 'all' ||
    (filter === 'unread' && !read) ||
    (filter === 'approval' && awaiting);
  const showComplete =
    phase === 'complete' &&
    (filter === 'all' || (filter === 'unread' && !completionRead));
  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <div>
          <h1>알림</h1>
          <p>승인이 필요한 작업과 처리 결과를 확인하세요.</p>
        </div>
        <Button
          variant="secondary"
          onClick={onRead}
          disabled={offline || unreadCount === 0}
        >
          모두 읽음
        </Button>
      </div>
      <div className={styles.filters} role="group" aria-label="알림 필터">
        {(
          [
            { value: 'all', label: '전체' },
            {
              value: 'unread',
              label: `읽지 않음 ${unreadCount}`,
            },
            { value: 'approval', label: `승인 대기 ${awaiting ? 1 : 0}` },
          ] as const
        ).map((item: FilterOption): JSX.Element => (
          <Button
            key={item.value}
            variant="surface"
            aria-pressed={filter === item.value}
            onClick={(): void => setFilter(item.value)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {offline ? (
        <StatusNotice tone="warning" title="알림을 새로 가져오지 못했습니다.">
          14:00에 확인한 기록입니다. 연결되면 새 알림과 다른 PC의 변경 사항을
          다시 확인합니다.
        </StatusNotice>
      ) : (
        <p className={styles.muted}>
          모든 기기의 알림 · 마지막 동기화 2026.11.24 14:16
        </p>
      )}
      <section aria-label="알림 목록" className={styles.notificationList}>
        {showComplete && (
          <article className={styles.notification}>
            <span className={styles.eventIcon} data-tone="success">
              <Icon name="circle-check" />
            </span>
            <div className={styles.notificationBody}>
              <h2>{title}</h2>
              <div className={styles.notificationMeta}>
                <span>문서 처리 완료 · Wiki 저장·관계 추출</span>
                {!completionRead && (
                  <span className={styles.unread}>읽지 않음</span>
                )}
              </div>
            </div>
            <time
              className={styles.notificationTime}
              dateTime="2026-11-24T14:16:00+09:00"
            >
              <span>2026.11.24</span> <span>14:16</span>
            </time>
            <Button
              size="small"
              variant="secondary"
              onClick={(): void => onOpen('completion')}
            >
              결과 보기 <Icon name="arrow-right" />
            </Button>
          </article>
        )}
        {showRequest && (
          <article className={styles.notification}>
            <span className={styles.eventIcon}>
              <Icon name="clipboard-check" />
            </span>
            <div className={styles.notificationBody}>
              <h2>{title}</h2>
              <div className={styles.notificationMeta}>
                <span>문자 사용 승인 요청 · 30/170쪽</span>
                <span
                  className={styles.statusLabel}
                  data-done={phase === 'complete'}
                  data-progress={!awaiting && phase !== 'complete'}
                >
                  {awaiting ? '승인 대기' : phaseLabels[phase]}
                </span>
                {!read && <span className={styles.unread}>읽지 않음</span>}
              </div>
            </div>
            <time
              className={styles.notificationTime}
              dateTime="2026-11-24T13:58:00+09:00"
            >
              <span>2026.11.24</span> <span>13:58</span>
            </time>
            <Button
              size="small"
              variant="secondary"
              onClick={(): void => onOpen('request')}
            >
              {awaiting ? '검토하기' : '작업 보기'}
              <Icon name="arrow-right" />
            </Button>
          </article>
        )}
        {filter === 'all' && (
          <article className={styles.notification}>
            <span className={styles.eventIcon} data-tone="success">
              <Icon name="circle-check" />
            </span>
            <div className={styles.notificationBody}>
              <h2>서비스 운영 안내</h2>
              <div className={styles.notificationMeta}>
                <span>문서 처리 완료 · Wiki 저장·관계 추출</span>
              </div>
            </div>
            <time
              className={styles.notificationTime}
              dateTime="2026-11-24T11:26:00+09:00"
            >
              <span>2026.11.24</span> <span>11:26</span>
            </time>
            <Link to="/document?path=other-preview.md">
              결과 보기 <Icon name="arrow-right" />
            </Link>
          </article>
        )}
        {!showRequest && !showComplete && (
          <div className={styles.empty}>
            <Icon name="check-check" size={24} />
            <h2>
              {filter === 'approval'
                ? '승인을 기다리는 작업이 없습니다.'
                : '읽지 않은 알림이 없습니다.'}
            </h2>
            <p>
              {filter === 'unread' && awaiting
                ? '문자 사용 승인은 아직 필요합니다. 승인 대기에서 확인하세요.'
                : '전체 목록에서 이전 기록을 볼 수 있습니다.'}
            </p>
          </div>
        )}
      </section>
      <p className={styles.listFootnote}>
        앱이 닫혀 있는 동안 서버에 기록된 알림도 여기에 모입니다. 알림을 읽어도
        작업이 승인되거나 시작되지 않습니다.
      </p>
    </div>
  );
}

/** 실제 앱과 분리된 메모리 시뮬레이션이며 외부 저장·실행을 호출하지 않습니다. */
export function Preview(): JSX.Element {
  const navigate = useNavigate();
  const route = useLocation();
  const { preference, setPreference } = useThemePreference();
  const [pages, setPages] = useState<Page[]>((): Page[] => makePages(0));
  const [selected, setSelected] = useState(0);
  const [phase, setPhase] = useState<Phase>('review');
  const [scenario, setScenario] = useState<Scenario>('pending');
  const [ready, setReady] = useState(true);
  const [offline, setOffline] = useState(false);
  const [read, setRead] = useState(false);
  const [completionRead, setCompletionRead] = useState(false);
  const [saved, setSaved] = useState(
    '확인 내역은 같은 계정의 다른 PC에서도 이어집니다.',
  );
  const timers = useRef<number[]>([]);
  const before = new URLSearchParams(location.search).get('mode') === 'before';
  useRouteTitle('task:000000000000000000000000000000c9', title);
  useEffect((): void => {
    window.dispatchEvent(
      new CustomEvent('notification-preview-phase', {
        detail: {
          label: phaseLabels[phase],
          pending: phase === 'review',
          ready,
        },
      }),
    );
  }, [phase, ready]);
  useEffect((): void => {
    if (preference === 'system') setPreference('light');
  }, [preference, setPreference]);
  useEffect(
    (): (() => void) => (): void =>
      timers.current.forEach((timer: number): void =>
        window.clearTimeout(timer),
      ),
    [],
  );

  /** 시안 도구는 빠른 상태 비교만 제공하며 제품의 승인 동작과 분리합니다. */
  function selectScenario(value: Scenario): void {
    timers.current.forEach((timer: number): void => window.clearTimeout(timer));
    timers.current = [];
    setScenario(value);
    setReady(value !== 'unprepared');
    setOffline(value === 'offline');
    setRead(false);
    setCompletionRead(false);
    const count =
      value === 'pending'
        ? 0
        : value === 'held' || value === 'offline'
          ? 8
          : 30;
    setPages(makePages(count, value === 'held'));
    setSelected(value === 'held' || value === 'offline' ? 8 : 0);
    setSaved(
      value === 'offline'
        ? '연결 대기 · 14:00에 저장된 확인 내역'
        : count > 0
          ? '확인 내역 저장됨 · 같은 계정의 모든 PC에 반영'
          : '확인 내역은 같은 계정의 다른 PC에서도 이어집니다.',
    );
    setPhase(
      value === 'pending' ||
        value === 'held' ||
        value === 'ready' ||
        value === 'unprepared' ||
        value === 'offline'
        ? 'review'
        : value,
    );
    void navigate(value === 'pending' ? '/notifications' : taskPath);
  }
  useEffect((): (() => void) => {
    Reflect.set(
      window,
      '__notificationPreviewNavigate',
      (path: string): void => {
        void navigate(path);
      },
    );
    Reflect.set(
      window,
      '__notificationPreviewScenario',
      (value: unknown): void => {
        const found = scenarios.find(
          (item: ScenarioOption): boolean => item.value === value,
        );
        if (found) selectScenario(found.value);
      },
    );
    return (): void => {
      Reflect.deleteProperty(window, '__notificationPreviewScenario');
      Reflect.deleteProperty(window, '__notificationPreviewNavigate');
    };
  });

  /** 시간 경과는 화면 전이만 모의하며 실제 처리를 시작하지 않습니다. */
  function later(next: Phase, delay: number): void {
    timers.current.push(window.setTimeout((): void => setPhase(next), delay));
  }
  function continueProcessing(): void {
    setPhase('claiming');
    later('accepting', 1000);
    later('running', 2200);
    later('complete', 6500);
  }
  function approve(): void {
    if (
      offline ||
      phase !== 'review' ||
      pages.some((page: Page): boolean => page.state !== 'usable')
    )
      return;
    setPhase('saving');
    later('approved', 900);
    if (ready) {
      later('claiming', 1800);
      later('accepting', 2700);
      later('running', 3800);
      later('complete', 8000);
    }
  }
  function mark(state: PageState): void {
    if (offline) return;
    const updated = pages.map((page: Page, index: number): Page =>
      index === selected ? { ...page, state } : page,
    );
    setPages(updated);
    const next = updated.findIndex(
      (page: Page, index: number): boolean =>
        index > selected && page.state === 'pending',
    );
    const fallback = updated.findIndex(
      (page: Page): boolean => page.state === 'pending',
    );
    if (next >= 0) setSelected(next);
    else if (fallback >= 0) setSelected(fallback);
    setSaved(
      `${pages[selected].number}쪽 ${state === 'held' ? '보류' : '사용 가능'} 저장됨 · 같은 계정의 모든 PC에 반영`,
    );
  }
  function switchMode(after: boolean): void {
    const url = new URL(location.href);
    url.searchParams.set('mode', after ? 'after' : 'before');
    url.hash = after ? '/notifications' : taskPath;
    location.assign(url.href);
  }
  return (
    <div
      className={styles.root}
      data-wiki-theme={preference === 'dark' ? 'dark' : 'light'}
    >
      <aside className={styles.previewTools} aria-label="시안 도구">
        <strong>알림·문자 승인 시안</strong>
        <span>합성 자료 · 저장·동기화·실행은 모의</span>
        <div role="group" aria-label="시안 비교">
          <button
            type="button"
            aria-pressed={before}
            onClick={(): void => switchMode(false)}
          >
            현재 화면
          </button>
          <button
            type="button"
            aria-pressed={!before}
            onClick={(): void => switchMode(true)}
          >
            개선안
          </button>
        </div>
        {!before && (
          <label>
            사례{' '}
            <select
              aria-label="상태 사례"
              value={scenario}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                const found = scenarios.find(
                  (item: ScenarioOption): boolean =>
                    item.value === event.target.value,
                );
                if (found) selectScenario(found.value);
              }}
            >
              {scenarios.map((item: ScenarioOption): JSX.Element => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          테마{' '}
          <select
            aria-label="시안 테마"
            value={preference}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
              setPreference(event.target.value === 'dark' ? 'dark' : 'light')
            }
          >
            <option value="light">화이트</option>
            <option value="dark">다크</option>
          </select>
        </label>
      </aside>
      <div className={styles.frame}>
        <AppShell>
          {before ? (
            <DocumentTasksPage />
          ) : route.pathname === '/notifications' ? (
            <Notifications
              phase={phase}
              read={read}
              completionRead={completionRead}
              offline={offline}
              onRead={(): void => {
                setRead(true);
                if (phase === 'complete') setCompletionRead(true);
              }}
              onOpen={(event: 'request' | 'completion'): void => {
                if (event === 'request') setRead(true);
                else setCompletionRead(true);
                void navigate(taskPath);
              }}
            />
          ) : route.pathname === '/tasks' ? (
            <div className={styles.page}>
              <div className={styles.titleRow}>
                <div>
                  <Link className={styles.back} to="/notifications">
                    <Icon name="arrow-left" />
                    알림으로
                  </Link>
                  <h1>{title}</h1>
                  <p>PDF 원본 · 170쪽 · 변환 3회</p>
                </div>
                <span
                  className={styles.statusLabel}
                  data-done={phase === 'complete'}
                  data-progress={phase !== 'review' && phase !== 'complete'}
                >
                  {phaseLabels[phase]}
                </span>
              </div>
              {offline && (
                <StatusNotice tone="warning" title="서버에 연결할 수 없습니다.">
                  저장된 확인 내역을 보여 줍니다. 연결이 복구되면 최신 상태를
                  확인한 뒤 검토와 승인을 이어갈 수 있습니다.
                  <Button
                    variant="secondary"
                    onClick={(): void => {
                      setOffline(false);
                      setSaved('확인 내역 저장됨 · 같은 계정의 모든 PC에 반영');
                    }}
                  >
                    연결 다시 확인
                  </Button>
                </StatusNotice>
              )}
              {phase === 'review' ? (
                <Review
                  key={scenario}
                  pages={pages}
                  selected={selected}
                  offline={offline}
                  saved={saved}
                  ready={ready}
                  onSelect={setSelected}
                  onMark={mark}
                  onApprove={approve}
                />
              ) : (
                <Progress
                  phase={phase}
                  ready={ready}
                  onContinue={continueProcessing}
                />
              )}
            </div>
          ) : (
            <div className={styles.page}>
              <Link className={styles.back} to={taskPath}>
                <Icon name="arrow-left" />
                같은 작업으로 돌아가기
              </Link>
              <h1>
                {route.pathname === '/settings'
                  ? '실행 준비'
                  : route.pathname === '/ontology'
                    ? '추출 관계 검토'
                    : route.pathname === '/document'
                      ? '저장된 Wiki 문서'
                      : '시안 범위 밖의 화면'}
              </h1>
              <p>
                이 화면은 이동 경로를 확인하는 자리입니다. 실제 설정·결과는
                연결하지 않았습니다.
              </p>
            </div>
          )}
        </AppShell>
      </div>
    </div>
  );
}
