import { useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link } from 'react-router';
import { isDocumentPath } from '@contracts/documents.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { useRouteTitle } from '@renderer/shared/lib/routeTitle';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  notificationEventLabel,
  pageText,
  workflowStateLabel,
} from '../model/notificationView';
import type { NotificationDetail, ReviewPage } from '../model/notificationView';
import { useNotificationWorkflow } from '../model/useNotificationWorkflow';
import { OriginalPage } from './OriginalPage';
import styles from './Notifications.module.scss';

type NotificationWorkflowProps = {
  scope: SourceConversionScope & { canPrepare: boolean };
  workflowId: string;
};
const pageLabels: Record<ReviewPage['state'], string> = {
  pending: '확인 전',
  usable: '사용 가능',
  held: '보류',
};

/** 다른 PC의 서버 검토 진행을 복원하고 명시된 페이지 확인과 최종 승인을 받습니다. */
export function NotificationWorkflow({
  scope,
  workflowId,
}: NotificationWorkflowProps): JSX.Element {
  const model = useNotificationWorkflow(scope, workflowId);
  const { detail, inspection, error, uncertain, phase } = model;
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const [heldOnly, setHeldOnly] = useState(false);
  const [tab, setTab] = useState<'original' | 'text'>('original');
  const [imageAvailable, setImageAvailable] = useState(false);
  const [target, setTarget] = useState('');
  useRouteTitle(`workflow:${workflowId}`, detail?.workflow.title ?? null);
  if (!detail)
    return (
      <section className={styles.page} aria-label="문자 검토와 처리">
        <StatusNotice
          tone={error ? 'error' : 'info'}
          title={
            error ? '작업을 확인하지 못했습니다' : '작업을 불러오고 있습니다'
          }
        >
          {error ?? '현재 작업 공간에서 원본과 변환 보고를 확인합니다.'}
        </StatusNotice>
        <div className={styles.actions}>
          <Button
            disabled={!!phase}
            onClick={(): void => {
              void model.load();
            }}
          >
            다시 확인
          </Button>
          <Link to="/notifications">알림 목록</Link>
        </div>
      </section>
    );
  const workflow = detail.workflow;
  const currentPage =
    selectedPage ??
    workflow.pages.find((page: ReviewPage): boolean => page.state !== 'usable')
      ?.page ??
    workflow.pages[0]?.page;
  const selected =
    workflow.pages.find(
      (page: ReviewPage): boolean => page.page === currentPage,
    ) ?? null;
  const usable = workflow.pages.filter(
    (page: ReviewPage): boolean => page.state === 'usable',
  ).length;
  const held = workflow.pages.filter(
    (page: ReviewPage): boolean => page.state === 'held',
  ).length;
  const pages = heldOnly
    ? workflow.pages.filter(
        (page: ReviewPage): boolean => page.state === 'held',
      )
    : workflow.pages;
  const reviewing = workflow.state === 'review' && !workflow.blocked_reason;
  const text = selected ? pageText(detail, selected.page) : null;
  const writable = scope.canPrepare && !phase && !uncertain && !error;
  const allUsable =
    workflow.pages.length > 0 &&
    usable === workflow.pages.length &&
    workflow.pages.every(
      (page: ReviewPage): boolean => pageText(detail, page.page) !== null,
    );
  const targetDocument = workflow.target_document ?? target.trim();
  const targetValid = isDocumentPath(targetDocument);
  const sourcePath = `/source?${new URLSearchParams({ sourceId: workflow.source_ref.source_id, version: workflow.source_ref.source_version })}`;
  const otherPc =
    workflow.execution?.device_id &&
    inspection &&
    workflow.execution.device_id !== inspection.deviceId;
  const resumable =
    !workflow.blocked_reason &&
    (['approved', 'failed', 'stopped'].includes(workflow.state) ||
      (workflow.state === 'claimed' &&
        workflow.execution?.device_id === inspection?.deviceId));
  const stateDescription =
    workflow.blocked_reason === 'source_changed'
      ? '등록 원본이 변경되었습니다. 이 기록의 확인과 승인은 보존되지만 다음 처리에는 사용할 수 없습니다. 현재 원본의 최신 변환 보고에서 다시 확인해 주세요.'
      : workflow.blocked_reason === 'report_changed'
        ? '새 문자 변환 보고가 있습니다. 이 기록의 확인과 승인은 보존되지만 다음 처리에는 사용할 수 없습니다. 최신 보고에서 경고 쪽을 다시 확인해 주세요.'
        : workflow.state === 'review'
          ? '경고가 있는 쪽의 원본과 보관 문자를 대조한 뒤 사용 여부를 확인해 주세요.'
          : workflow.state === 'approved'
            ? '문자 사용 승인이 서버에 저장되었습니다. 준비된 PC에서 명시적으로 이어갈 수 있습니다.'
            : workflow.state === 'claimed'
              ? '실행 기기를 확보했습니다. 원래 요청의 접수 상태를 확인하고 있습니다.'
              : workflow.state === 'running'
                ? `${otherPc ? '다른 PC' : (workflow.execution?.device_name ?? '실행 기기')}에서 처리하고 있습니다. 이 화면을 열어도 새 작업을 실행하지 않습니다.`
                : workflow.state === 'complete'
                  ? '처리 결과가 서버에 보관되었습니다. 원래 문자 경고와 승인 내역은 아래에 남습니다.'
                  : '처리가 끝나지 않았습니다. 기존 실행 기록에서 원인과 현재 상태를 확인해 주세요.';

  /** 현재 쪽 저장 영수증이 확인된 다음에만 다음 미확인 쪽으로 이동합니다. */
  async function decide(state: ReviewPage['state']): Promise<void> {
    if (!selected) return;
    const saved = await model.decide(selected.page, state);
    if (!saved) return;
    setHeldOnly(false);
    const after = workflow.pages.filter(
      (page: ReviewPage): boolean =>
        page.page > selected.page && page.state !== 'usable',
    );
    const next =
      after[0] ??
      workflow.pages.find(
        (page: ReviewPage): boolean =>
          page.page !== selected.page && page.state !== 'usable',
      );
    if (next) {
      setImageAvailable(false);
      setSelectedPage(next.page);
      setTab('original');
    }
  }

  return (
    <section
      className={styles.page}
      aria-label="문자 검토와 처리"
      aria-busy={!!phase}
      data-workflow-detail={workflowId}
    >
      <div className={styles.heading}>
        <div>
          <Link to="/notifications">알림 목록</Link>
          <h1>{workflow.title}</h1>
          <p>{workflowStateLabel(workflow.state, workflow.blocked_reason)}</p>
        </div>
        <Button
          variant="secondary"
          size="small"
          disabled={!!phase}
          onClick={(): void => {
            void model.load();
          }}
        >
          상태 다시 확인
        </Button>
      </div>
      <StatusNotice
        tone={
          workflow.state === 'complete'
            ? 'success'
            : workflow.state === 'failed' || workflow.state === 'stopped'
              ? 'error'
              : 'info'
        }
        title={workflowStateLabel(workflow.state, workflow.blocked_reason)}
      >
        {stateDescription}
        {workflow.blocked_reason && (
          <p>
            <Link
              to={`/source?${new URLSearchParams({ sourceId: workflow.source_ref.source_id })}`}
            >
              현재 원본과 새 변환 확인
            </Link>{' '}
            · <Link to="/notifications">새 알림 보기</Link>
          </p>
        )}
      </StatusNotice>
      {error && (
        <StatusNotice
          tone="error"
          title={uncertain ? '저장·접수 결과 확인 필요' : '최신 상태 확인 필요'}
        >
          {error}
          <p>
            상태를 다시 확인하기 전에는 추가 승인이나 실행을 요청하지 않습니다.
          </p>
        </StatusNotice>
      )}
      {phase && phase !== 'loading' && (
        <p role="status">
          {phase === 'page'
            ? '쪽 확인을 서버에 저장하고 있습니다…'
            : phase === 'approval'
              ? '문자 사용 승인을 서버에 저장하고 있습니다…'
              : '실행 기기를 확보하고 원래 요청의 접수를 확인하고 있습니다…'}
        </p>
      )}
      <p className={styles.receipt}>
        <Link to={sourcePath}>등록 원본과 변환 기록</Link>
        {detail.conversion && (
          <>
            {' '}
            · 이 검토는 보관된 변환 보고에 연결됩니다. 원본이나 보고가 달라지면
            새 검토가 필요합니다.
          </>
        )}
      </p>
      {detail.conversion && workflow.pages.length > 0 && (
        <section className={styles.review} aria-label="경고 쪽 검토">
          <div className={styles.sectionHeading}>
            <div>
              <h2>원본과 보관 문자 대조</h2>
              <p className={styles.receipt}>
                쪽 확인은 중간 기록입니다. 모든 쪽 확인을 저장한 뒤 최종
                승인합니다.
              </p>
            </div>
            <strong aria-label="서버에 저장된 사용 가능 쪽">
              {usable} / {workflow.pages.length}쪽 사용 가능
              {held > 0 ? ` · ${held}쪽 보류` : ''}
            </strong>
          </div>
          <progress
            max={workflow.pages.length}
            value={usable}
            aria-label="경고 쪽 확인 진행"
          />
          <div className={styles.reviewGrid}>
            <nav className={styles.pageList} aria-label="경고 쪽 목록">
              <div className={styles.pageListHeading}>
                <strong>경고 {workflow.pages.length}쪽</strong>
                <Button
                  variant="surface"
                  size="small"
                  aria-pressed={heldOnly}
                  disabled={!!phase}
                  onClick={(): void => {
                    const next = !heldOnly;
                    setHeldOnly(next);
                    if (next) {
                      const first = workflow.pages.find(
                        (page: ReviewPage): boolean => page.state === 'held',
                      );
                      if (first) {
                        setImageAvailable(false);
                        setSelectedPage(first.page);
                      }
                    }
                  }}
                >
                  보류만
                </Button>
              </div>
              <div className={styles.pageNumbers}>
                {pages.length ? (
                  pages.map((page: ReviewPage): JSX.Element => (
                    <button
                      type="button"
                      key={page.page}
                      className={styles.pageButton}
                      aria-current={
                        currentPage === page.page ? 'page' : undefined
                      }
                      disabled={!!phase}
                      onClick={(): void => {
                        if (page.page !== selectedPage)
                          setImageAvailable(false);
                        setSelectedPage(page.page);
                        setTab('original');
                      }}
                    >
                      <span>{page.page}쪽</span>
                      <span data-state={page.state}>
                        {pageLabels[page.state]}
                      </span>
                    </button>
                  ))
                ) : (
                  <p>보류한 쪽이 없습니다.</p>
                )}
              </div>
            </nav>
            {selected && (!heldOnly || selected.state === 'held') ? (
              <div className={styles.comparison}>
                <div className={styles.paneHeading}>
                  <h3>{selected.page}쪽 대조</h3>
                  <span>{pageLabels[selected.state]}</span>
                </div>
                <div className={styles.tabs} aria-label="대조 보기">
                  <Button
                    variant="surface"
                    size="small"
                    aria-pressed={tab === 'original'}
                    onClick={(): void => {
                      setTab('original');
                    }}
                  >
                    원본
                  </Button>
                  <Button
                    variant="surface"
                    size="small"
                    aria-pressed={tab === 'text'}
                    onClick={(): void => {
                      setTab('text');
                    }}
                  >
                    보관 문자
                  </Button>
                </div>
                <div className={styles.compareColumns}>
                  <div
                    className={styles.pane}
                    data-visible={tab === 'original'}
                  >
                    <OriginalPage
                      key={selected.page}
                      scope={scope}
                      workflowId={workflowId}
                      page={selected.page}
                      onAvailable={setImageAvailable}
                      onAccessLost={model.invalidate}
                    />
                  </div>
                  <div className={styles.pane} data-visible={tab === 'text'}>
                    <div className={styles.paneHeading}>
                      <strong>보관 문자</strong>
                      <span>변환 보고의 문자 그대로</span>
                    </div>
                    {text ? (
                      <pre
                        className={styles.text}
                        tabIndex={0}
                        aria-label={`${selected.page}쪽 보관 문자`}
                      >
                        {text}
                      </pre>
                    ) : (
                      <p className={styles.text} role="alert">
                        이 쪽에 연결된 보관 문자를 확인할 수 없습니다. 사용 승인
                        전에 변환 기록을 확인해 주세요.
                      </p>
                    )}
                  </div>
                </div>
                {reviewing && (
                  <div className={styles.pageActions}>
                    <Button
                      disabled={!writable || !text || !imageAvailable}
                      onClick={(): void => {
                        void decide('usable');
                      }}
                    >
                      이 쪽 문자 사용 · 다음 쪽
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!writable}
                      onClick={(): void => {
                        void decide('held');
                      }}
                    >
                      이 쪽 보류
                    </Button>
                    <span className={styles.receipt}>
                      원본과 문자를 확인한 뒤 선택해 주세요.
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className={styles.empty}>
                목록에서 확인할 쪽을 선택해 주세요.
              </p>
            )}
          </div>
        </section>
      )}
      <section
        className={styles.approval}
        aria-label="문자 사용 승인과 이어가기"
      >
        <h2>{reviewing ? '문자 사용 최종 승인' : '승인과 실행 내역'}</h2>
        {workflow.approval && (
          <p>
            승인: {workflow.approval.actor.user_id} ·{' '}
            {workflow.approval.device_name} ·{' '}
            {formatTimestamp(workflow.approval.approved_at)}
          </p>
        )}
        {workflow.execution?.device_name && (
          <p>
            실행 기기: {workflow.execution.device_name} ·{' '}
            {workflow.execution.claimed_at
              ? formatTimestamp(workflow.execution.claimed_at)
              : '실행 시각 확인 불가'}
          </p>
        )}
        {reviewing && (
          <>
            <p>
              {allUsable
                ? `${workflow.pages.length}쪽의 사용 가능 확인이 서버에 저장되었습니다.`
                : usable === workflow.pages.length
                  ? '보관 문자 연결을 확인하지 못한 쪽이 있습니다. 변환 기록을 확인해 주세요.'
                  : `아직 ${workflow.pages.length - usable}쪽의 사용 확인이 필요합니다.`}{' '}
              승인은 이 변환 문자를 다음 처리에 사용하는 선택입니다.
            </p>
            {!workflow.target_document && (
              <label>
                저장할 Wiki 경로
                <input
                  aria-label="저장할 Wiki 경로"
                  value={target}
                  placeholder="예: 아키텍처.md"
                  disabled={!!phase || uncertain}
                  onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                    setTarget(event.currentTarget.value);
                  }}
                />
                <span className={styles.receipt}>
                  {target && !targetValid
                    ? '폴더와 .md 확장자를 포함한 유효한 문서 경로를 입력해 주세요.'
                    : '기존 문서와 같은 경로를 입력하면 서버의 충돌 검사를 받습니다.'}
                </span>
              </label>
            )}
            <div className={styles.actions}>
              <Button
                disabled={!writable || !allUsable || !targetValid}
                onClick={(): void => {
                  void model.approve(
                    workflow.target_document ? undefined : targetDocument,
                    false,
                  );
                }}
              >
                문자 사용 승인만
              </Button>
              {inspection?.ready && (
                <Button
                  disabled={!writable || !allUsable || !targetValid}
                  onClick={(): void => {
                    void model.approve(
                      workflow.target_document ? undefined : targetDocument,
                      true,
                    );
                  }}
                >
                  {workflow.pages.length}쪽 사용을 승인하고 이 PC에서 계속
                </Button>
              )}
            </div>
          </>
        )}
        {resumable && (
          <div className={styles.actions}>
            <Button
              disabled={!writable || !inspection?.ready}
              onClick={(): void => {
                void model.continueHere();
              }}
            >
              {workflow.state === 'claimed'
                ? '기존 요청 이어가기'
                : '이 PC에서 계속'}
            </Button>
            <span className={styles.receipt}>
              다른 PC에서는 같은 계정으로 알림을 열고 이 작업을 이어가세요.
            </span>
          </div>
        )}
        {(reviewing || resumable) && (
          <>
            {!scope.canPrepare && (
              <StatusNotice tone="warning">
                현재 계정에는 승인·처리를 위한 쓰기 권한이 없습니다. 원본과
                기록은 확인할 수 있습니다.
              </StatusNotice>
            )}
            {!inspection?.ready && (
              <StatusNotice tone="info" title="이 PC의 실행 준비가 필요합니다">
                {model.readinessError ??
                  inspection?.blockers.join(' · ') ??
                  '실행 환경을 확인하고 있습니다…'}
                <p>
                  문자 사용 승인은 서버에 보관할 수 있습니다. 준비된 다른
                  PC에서도 이어갈 수 있습니다.
                </p>
                <div className={styles.actions}>
                  <Link to="/settings">실행 준비 설정</Link>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={(): void => {
                      void model.inspect();
                    }}
                  >
                    실행 준비 다시 확인
                  </Button>
                </div>
              </StatusNotice>
            )}
          </>
        )}
        {workflow.execution?.job_id && (
          <Link
            to={`/jobs?${new URLSearchParams({ jobId: workflow.execution.job_id })}`}
            state={{ workflowReturnTo: `/tasks?workflowId=${workflowId}` }}
          >
            기존 실행 기록 보기
          </Link>
        )}
        {workflow.state === 'complete' && workflow.target_document && (
          <div className={styles.actions}>
            <Link
              to={`/document?${new URLSearchParams({ path: workflow.target_document })}`}
            >
              보관된 Wiki 보기
            </Link>
            <Link
              to={`/ontology?${new URLSearchParams({ path: workflow.target_document })}`}
            >
              관계 보기
            </Link>
          </div>
        )}
      </section>
      <section className={styles.review} aria-label="알림과 처리 이력">
        <h2>알림과 처리 이력</h2>
        <ol className={styles.history}>
          {detail.events.map(
            (
              event: NotificationDetail['events'][number],
              index: number,
            ): JSX.Element => (
              <li key={`${event.kind}:${event.created_at}:${index}`}>
                <span>{notificationEventLabel(event.kind)}</span>
                <time dateTime={event.created_at}>
                  {formatTimestamp(event.created_at)}
                </time>
              </li>
            ),
          )}
        </ol>
        {detail.conversion && (
          <details>
            <summary>
              원래 변환 경고 {detail.conversion.manifest.warnings.length}개
            </summary>
            <ul>
              {detail.conversion.manifest.warnings.map(
                (warning: string, index: number): JSX.Element => (
                  <li key={`${index}:${warning}`}>{warning}</li>
                ),
              )}
            </ul>
          </details>
        )}
      </section>
    </section>
  );
}
