import type { JSX } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useDocumentHistory } from '../model/useDocumentHistory';
import type {
  DocumentHistoryInput,
  DocumentHistoryVersion,
  DocumentRestoreOutcome,
} from '../api/documentHistory.api';
import styles from './ViewDocumentHistory.module.scss';

export type ViewDocumentHistoryProps = DocumentHistoryInput & {
  allowed?: boolean;
  onRestored: (outcome: DocumentRestoreOutcome) => void;
  onScopeInvalidated: () => void;
};

/** 판본 목록의 보관 시각만 표시하며 알려지지 않은 작성자/이유를 추측하지 않습니다. */
function versionTime(version: DocumentHistoryVersion): string {
  return version.archived_at || '보관 시각 정보 없음';
}

/** 수정 전 전체 파일을 읽고 현재 본문과 대조한 후 명시적으로 새 판본 복원합니다. */
function DocumentHistorySession(props: ViewDocumentHistoryProps): JSX.Element {
  const { allowed = true } = props;
  const model = useDocumentHistory(props);
  const page = model.list.status === 'ready' ? model.list.page : null;
  const selected = model.selected.status === 'ready' ? model.selected : null;
  const incomplete =
    page &&
    (!page.complete ||
      page.truncated ||
      page.skipped.length > 0 ||
      page.requires_refresh);
  return (
    <section className={styles.workspace} aria-label="문서 버전·변경">
      <header className={styles.heading}>
        <div>
          <h2>Markdown 본문</h2>
          <p>
            수정 전 전체 파일을 보관한 이력입니다. 원본 파일의 판본과
            구분합니다.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={model.reload}
          disabled={model.busy || model.list.status === 'loading'}
        >
          이력 새로고침
        </Button>
      </header>
      {model.list.status === 'loading' && (
        <StatusNotice title="본문 이력을 불러오고 있습니다">
          현재 문서와 같은 조회 범위에서 확인합니다.
        </StatusNotice>
      )}
      {model.list.status === 'error' && (
        <StatusNotice tone="error" title="본문 이력을 확인하지 못했습니다">
          {model.list.error.message}
        </StatusNotice>
      )}
      {page && (
        <>
          <p className={styles.revision}>
            현재 본문 판본: {page.current.revision}
          </p>
          {page.items.length === 0 && (
            <StatusNotice title="보관된 이전 본문이 없습니다">
              현재 본문을 처음 수정하면 수정 전 전체 파일이 보관됩니다.
            </StatusNotice>
          )}
          <ul className={styles.versions} aria-label="본문 판본 목록">
            {page.items.map((version: DocumentHistoryVersion): JSX.Element => (
              <li key={version.history_id}>
                <div>
                  <strong>이전 본문 · {versionTime(version)}</strong>
                  <p>
                    {new Intl.NumberFormat('ko-KR').format(version.size_bytes)}{' '}
                    B
                  </p>
                  <p className={styles.revision}>{version.revision}</p>
                  <p>
                    작성자: {version.author || '기록 없음'} · 이유:{' '}
                    {version.reason || '기록 없음'}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={(): void => model.select(version.history_id)}
                  disabled={model.busy}
                >
                  이 판본 보기
                </Button>
              </li>
            ))}
          </ul>
          {incomplete && (
            <StatusNotice tone="warning" title="이력 조회 범위 안내">
              {page.next_cursor
                ? '다음 페이지에 이력이 더 있습니다. '
                : '전체 이력 조회가 완료되지 않았습니다. '}
              {page.truncated && '조회 한도에 도달했습니다. '}
              {page.skipped.length > 0 &&
                `읽지 못한 이력 ${page.skipped.length}개. `}
              {page.requires_refresh && '목록을 새로고침해 주세요.'}
            </StatusNotice>
          )}
          <div className={styles.pagination}>
            <span>{model.pageNumber}페이지</span>
            <Button
              variant="secondary"
              onClick={model.previous}
              disabled={model.busy || !model.canPrevious}
            >
              이전 페이지
            </Button>
            <Button
              variant="secondary"
              onClick={model.next}
              disabled={
                model.busy || !page.next_cursor || page.requires_refresh
              }
            >
              다음 페이지
            </Button>
          </div>
        </>
      )}
      {model.selected.status === 'loading' && (
        <StatusNotice title="과거·현재 본문을 대조하고 있습니다">
          조회만 수행하며 현재 문서를 바꾸지 않습니다.
        </StatusNotice>
      )}
      {model.selected.status === 'error' && (
        <StatusNotice tone="error" title="본문 비교 안내">
          {model.selected.error.message}
        </StatusNotice>
      )}
      {model.uncertain && (
        <StatusNotice tone="warning" title="복원 결과 확인이 필요합니다">
          같은 복원을 다시 전송하지 않습니다. 현재 본문을 읽어 대조하되 내용의
          일치만으로 이전 요청의 완료를 확정하지 않습니다.
        </StatusNotice>
      )}
      {model.conflict && (
        <StatusNotice tone="warning" title="현재 본문이 변경되었습니다">
          이전에 비교한 기준으로는 복원하지 않았습니다. 현재 전체 본문을 다시
          대조한 뒤 명시적으로 복원해 주세요.
        </StatusNotice>
      )}
      {model.error && (
        <StatusNotice tone="error" title="복원·조회 안내">
          <p>{model.error.message}</p>
          {model.error.traceId && <p>문의 코드: {model.error.traceId}</p>}
        </StatusNotice>
      )}
      {selected && (
        <section
          className={styles.comparisonSection}
          aria-label="과거·현재 본문 비교"
        >
          <h3>과거 본문과 현재 본문</h3>
          <div className={styles.comparison}>
            <section>
              <h4>선택한 이전 본문</h4>
              <p className={styles.revision}>{selected.old.revision}</p>
              <pre>{selected.old.content}</pre>
            </section>
            <section>
              <h4>현재 본문</h4>
              <p className={styles.revision}>{selected.current.revision}</p>
              <pre>{selected.current.content}</pre>
            </section>
          </div>
          <p className={styles.caption}>
            복원은 선택한 과거 본문을 새 저장으로 적용합니다. 현재 본문도 전체
            이력에 남으며 그래프·검토 승인·전문가 판단을 과거 상태로 복원하지
            않습니다.
          </p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={model.compareCurrent}
              disabled={model.busy}
            >
              현재 본문 다시 대조
            </Button>
            <Button
              onClick={(): void => {
                void model.restore();
              }}
              disabled={
                !allowed ||
                model.busy ||
                model.conflict ||
                model.uncertain ||
                model.restored !== null ||
                selected.old.revision === selected.current.revision
              }
            >
              {model.busy ? '복원 확인 중' : '이 본문을 새 판본으로 복원'}
            </Button>
          </div>
          {!allowed && (
            <p className={styles.caption}>
              현재 작업 공간의 본문 쓰기 권한이 필요합니다.
            </p>
          )}
        </section>
      )}
      {model.restored && (
        <StatusNotice
          tone={model.restored.cleanupWarningCount > 0 ? 'warning' : 'success'}
          title={
            model.restored.changed
              ? '본문을 새 판본으로 복원했습니다'
              : '현재 본문과 같은 내용입니다'
          }
        >
          <p className={styles.revision}>
            저장 판본: {model.restored.revision}
          </p>
          {model.restored.cleanupWarningCount > 0 && (
            <p>
              저장은 완료됐으며 임시 파일 정리 문제{' '}
              {model.restored.cleanupWarningCount}건이 있습니다. 복원을 반복하지
              마세요.
            </p>
          )}
        </StatusNotice>
      )}
    </section>
  );
}

/** 문서/연결/관점이 바뀌면 이전 이력과 지연 응답의 수명을 분리합니다. */
export function ViewDocumentHistory(
  props: ViewDocumentHistoryProps,
): JSX.Element {
  return (
    <DocumentHistorySession
      key={JSON.stringify([
        props.connectionId,
        props.scope.userId,
        props.scope.tenant,
        props.scope.profileId,
        props.scope.policyRevision,
        props.document,
      ])}
      {...props}
    />
  );
}
