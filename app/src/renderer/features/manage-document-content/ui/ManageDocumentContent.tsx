import { Button } from '@renderer/shared/ui/Button';
import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  documentBodyStartLine,
  matchDocumentEvidence,
  readDocumentEvidence,
} from '@renderer/shared/lib/documentEvidence';
import type {
  DocumentEvidenceLocation,
  DocumentEvidenceMatch,
} from '@renderer/shared/lib/documentEvidence';
import { ConnectionNotice } from '@renderer/shared/ui/PageNotice';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useAiConnection } from '@renderer/platform/aiConnection';
import {
  documentTitleKey,
  useRouteTitle,
} from '@renderer/shared/lib/routeTitle';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { useDocumentContent } from '../model/useDocumentContent';
import { useDocumentEditing } from '../model/useDocumentEditing';
import { useDocumentExtraction } from '../model/useDocumentExtraction';
import { useDocumentHistory } from '../model/useDocumentHistory';
import { contentDraftKey } from '../model/documentDraft';
import { authorshipLabel } from '../model/documentMetadata';
import { readDocumentRelationStatus } from '../api/documentContent.api';
import type {
  ContentSession,
  DocumentRelationStatus,
} from '../api/documentContent.api';
import { DocumentMarkdown } from './DocumentMarkdown';
import { DocumentEditor, DocumentEditorActions } from './DocumentEditor';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { DocumentChipPopover } from './DocumentChipPopover';
import {
  DocumentVersionMenu,
  DocumentVersionView,
} from './DocumentVersionHistory';
import {
  DocumentExtractionBanner,
  DocumentExtractionButton,
} from './DocumentExtraction';
import { SkeletonBar, SkeletonText } from '@renderer/shared/ui/Skeleton';
import chips from './DocumentChips.module.scss';
import styles from './ManageDocumentContent.module.scss';

type ManageDocumentContentProps = { path: string };
type LoadedDocumentProps = {
  session: ContentSession;
  onInvalidated: () => void;
  refreshing: boolean;
  refreshError: string | null;
};

/** 관계 칩에 표시할 상태 문구입니다. */
function relationLabel(
  checked: boolean,
  status: DocumentRelationStatus,
): string {
  if (!checked) return '관계 확인 중';
  return status === 'stale'
    ? '관계 · 재추출 필요'
    : status === 'ready'
      ? '관계 · 최신'
      : status === 'missing'
        ? '관계 미추출'
        : '관계 상태 확인 불가';
}

/** 인증 범위가 확인된 문서의 본문·원본·버전과 관계 상태를 탭 없이 조합합니다. */
function LoadedDocument({
  session,
  onInvalidated,
  refreshing,
  refreshError,
}: LoadedDocumentProps): JSX.Element {
  const model = useDocumentEditing({ current: session.current, onInvalidated });
  const active = useWorkspaceActivity();
  const navigate = useNavigate();
  const location = useLocation();
  const handledReceipt = useRef(model.receipt);
  const [parameters, setParameters] = useSearchParams();
  const editing = parameters.get('mode') === 'edit';
  const versionId = editing ? null : parameters.get('version');
  const against =
    parameters.get('against') === 'current' ? 'current' : 'previous';
  const wasActive = useRef(active);
  const refreshOnReturn = useEffectEvent((): void => {
    if (active && !editing) void model.refreshPristine();
  });
  useEffect((): void => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (returned) refreshOnReturn();
  }, [active]);
  useEffect((): (() => void) => {
    const refresh = (): void => refreshOnReturn();
    window.addEventListener('focus', refresh);
    return (): void => window.removeEventListener('focus', refresh);
  }, []);
  /** 편집 모드와 선택한 버전을 주소에 보존하며 본문 초안은 기존 범위별 모델이 유지합니다. */
  function updateParameters(change: (next: URLSearchParams) => void): void {
    const next = new URLSearchParams(parameters);
    change(next);
    setParameters(next);
  }
  /** 편집의 종료는 초안을 폐기하지 않고 같은 문서 읽기로 복귀합니다. */
  function setEditing(value: boolean): void {
    updateParameters((next: URLSearchParams): void => {
      next.delete('version');
      next.delete('against');
      if (value) next.set('mode', 'edit');
      else next.delete('mode');
    });
  }
  /** 버전을 고르면 기본으로 바로 앞 버전과 비교합니다. */
  function selectVersion(historyId: string | null): void {
    updateParameters((next: URLSearchParams): void => {
      next.delete('against');
      if (historyId) next.set('version', historyId);
      else next.delete('version');
    });
  }
  function setAgainst(value: 'previous' | 'current'): void {
    updateParameters((next: URLSearchParams): void => {
      if (value === 'current') next.set('against', 'current');
      else next.delete('against');
    });
  }
  useEffect((): void => {
    if (model.receipt && model.receipt !== handledReceipt.current && active) {
      handledReceipt.current = model.receipt;
      const next = new URLSearchParams(parameters);
      next.delete('mode');
      next.delete('version');
      next.delete('against');
      setParameters(next, { replace: true });
    }
  }, [model.receipt, active, parameters, setParameters]);
  const dirty =
    model.draft.content !== model.draft.base.content ||
    model.draft.phase !== 'edit' ||
    model.draft.metadata !== undefined ||
    model.draft.mergedMetadata !== undefined ||
    model.draft.latest !== null ||
    model.draft.preserved.length > 0;
  const restoreDisabledReason = !session.canWrite
    ? '읽기 전용 권한에서는 버전을 복원할 수 없습니다.'
    : dirty
      ? '미저장 초안을 먼저 저장하고 복원할 버전을 다시 비교해 주세요.'
      : model.busy
        ? '진행 중인 작업을 확인하고 있습니다.'
        : model.restoration !== null
          ? '현재 본문 다시 확인 후 복원할 버전을 다시 비교해 주세요.'
          : null;
  const current = model.current;
  const evidenceLocation = useMemo(
    (): DocumentEvidenceLocation | null =>
      readDocumentEvidence(parameters, location.state, current.document),
    [parameters, location.state, current.document],
  );
  const evidenceMatch = useMemo(
    (): DocumentEvidenceMatch | null =>
      evidenceLocation
        ? matchDocumentEvidence(
            {
              document: current.document,
              revision: current.revision,
              content: current.content,
              body: current.body,
              bodyStartLine: current.bodyStartLine,
            },
            evidenceLocation,
          )
        : null,
    [
      current.document,
      current.revision,
      current.content,
      current.body,
      current.bodyStartLine,
      evidenceLocation,
    ],
  );
  const history = useDocumentHistory({ current, onInvalidated });
  const extraction = useDocumentExtraction({ current, onInvalidated });
  const [relations, setRelations] = useState<{
    revision: string;
    status: DocumentRelationStatus;
  } | null>(null);
  useEffect((): (() => void) => {
    let active = true;
    void readDocumentRelationStatus(current).then(
      (status: DocumentRelationStatus): void => {
        if (active) setRelations({ revision: current.revision, status });
      },
    );
    return (): void => {
      active = false;
    };
  }, [current]);
  // 버전 칩이 저장 이력 수를 항상 보여 주도록 본문 버전이 바뀔 때마다 목록을 읽습니다.
  const loadHistory = useEffectEvent((): void => {
    void history.load(null);
  });
  useEffect((): void => {
    loadHistory();
  }, [current.revision]);
  const selectFromLocation = useEffectEvent((historyId: string): void => {
    if (history.selected?.history_id !== historyId)
      void history.select(historyId);
  });
  useEffect((): void => {
    if (versionId && history.page) selectFromLocation(versionId);
  }, [versionId, history.page]);
  const query = `?path=${encodeURIComponent(current.document)}`;
  const source = current.metadata?.source;
  const originalPath =
    source &&
    typeof source === 'object' &&
    !Array.isArray(source) &&
    typeof source.id === 'string' &&
    typeof source.version === 'string'
      ? `/source?${new URLSearchParams({ sourceId: source.id, version: source.version })}`
      : null;
  // 이전 주소(tab=history/original/analysis)는 새 구성으로 옮겨 기존 링크가 깨지지 않게 합니다.
  const legacyTab = parameters.get('tab');
  const migrateLegacy = useEffectEvent((): void => {
    const next = new URLSearchParams(parameters);
    next.delete('tab');
    const historyId = next.get('historyId');
    next.delete('historyId');
    if (legacyTab === 'history' && historyId) next.set('version', historyId);
    if (legacyTab === 'original' && originalPath) {
      void navigate(originalPath, { replace: true });
      return;
    }
    setParameters(next, { replace: true });
  });
  useEffect((): void => {
    if (legacyTab !== null) migrateLegacy();
  }, [legacyTab]);
  const description =
    typeof current.metadata?.description === 'string'
      ? current.metadata.description
      : '';
  const tags = Array.isArray(current.metadata?.tags)
    ? current.metadata.tags.filter(
        (value: unknown): value is string => typeof value === 'string',
      )
    : [];
  const bytes = new TextEncoder().encode(current.content).byteLength;
  const relationChecked = relations?.revision === current.revision;
  const aiRequired = useAiConnection().status === 'required';
  const displayName = documentDisplayName(
    current.document,
    typeof current.metadata?.title === 'string'
      ? current.metadata.title
      : undefined,
  );
  // 이미 읽은 제목을 위치 경로·탭 제목에 알립니다.
  useRouteTitle(documentTitleKey(current.document), displayName);
  const extractionBlocked =
    !session.canExtract || model.restoration !== null || editing;
  return (
    <div className={styles.root} data-layout={editing ? 'work' : 'reading'}>
      {!editing && refreshing && (
        <p role="status">최신 본문을 확인하고 있습니다.</p>
      )}
      {!editing && refreshError && <p role="alert">{refreshError}</p>}
      {!editing && aiRequired && (
        <ConnectionNotice
          kind="ai-required"
          action={
            <Link className={styles.button} to="/settings?section=ai">
              AI 연결하기
            </Link>
          }
        />
      )}
      {dirty && (
        <div className={styles.eyebrow}>
          <span className={styles.badge}>미저장 초안 있음</span>
        </div>
      )}
      <HeaderActions>
        {editing ? (
          <DocumentEditorActions
            model={model}
            onClose={(): void => setEditing(false)}
          />
        ) : (
          <>
            <DocumentExtractionButton
              model={extraction}
              disabled={extractionBlocked}
            />
            <Button
              variant="primary"
              type="submit"
              className={styles.primaryButton}
              disabled={
                !session.canWrite ||
                model.busy ||
                model.restoration !== null ||
                versionId !== null
              }
              onClick={(): void => {
                setEditing(true);
              }}
            >
              <Icon name="pencil" /> 본문 편집
            </Button>
          </>
        )}
      </HeaderActions>
      {!editing && (
        <div className={chips.chipRow}>
          <Link
            className={chips.chip}
            data-kind="link"
            to={`/ontology${query}`}
          >
            <Icon name="network" size={14} />
            {relationLabel(relationChecked, relations?.status ?? 'unknown')}
          </Link>
          {originalPath && (
            <Link className={chips.chip} data-kind="link" to={originalPath}>
              <Icon name="external-link" size={14} />
              원본 보기
            </Link>
          )}
          <DocumentChipPopover
            icon="info"
            label="문서 정보"
            popoverLabel="문서 정보"
          >
            {(): JSX.Element => (
              <>
                <dl>
                  <dt>설명</dt>
                  <dd className={description ? undefined : chips.muted}>
                    {description || '없음'}
                  </dd>
                  <dt>태그</dt>
                  <dd className={tags.length > 0 ? undefined : chips.muted}>
                    {tags.length > 0 ? tags.join(', ') : '없음'}
                  </dd>
                  <dt>형식·크기</dt>
                  <dd>
                    Markdown ·{' '}
                    {(bytes / 1024).toLocaleString('ko-KR', {
                      maximumFractionDigits: 1,
                    })}{' '}
                    KB
                  </dd>
                  <dt>원본</dt>
                  <dd>
                    {current.metadata?.source
                      ? '변환 당시 버전 연결됨'
                      : '연결된 원본 없음'}
                  </dd>
                  <dt>작성</dt>
                  <dd>
                    {authorshipLabel(current.authorship, session.principal)}
                  </dd>
                  <dt>저장 경로</dt>
                  <dd>{current.document}</dd>
                </dl>
              </>
            )}
          </DocumentChipPopover>
          <DocumentVersionMenu
            model={history}
            selectedId={versionId}
            onSelect={selectVersion}
          />
        </div>
      )}
      {!session.canWrite && (
        <StatusNotice title="읽기 전용 문서">
          현재 권한에는 본문 수정이 포함되어 있지 않습니다.
        </StatusNotice>
      )}
      {model.receipt && (
        <StatusNotice
          tone={
            model.receipt.cleanup_failures.length > 0 ||
            model.receipt.audit_status === 'pending_reconcile'
              ? 'warning'
              : 'success'
          }
          title={
            model.receipt.restored_from
              ? '버전 복원 완료'
              : model.receipt.changed
                ? '본문 저장 완료'
                : '변경 사항 없음'
          }
        >
          {model.receipt.changed
            ? '관계를 갱신하려면 재추출해 주세요.'
            : '저장된 본문과 같습니다.'}
          {model.receipt.cleanup_failures.length > 0 && (
            <p>
              저장 후 임시 파일 정리 경고{' '}
              {model.receipt.cleanup_failures.length}개가 있습니다. 저장은
              완료되었으므로 반복하지 마세요.
            </p>
          )}
          {model.receipt.audit_status === 'pending_reconcile' && (
            <p>
              본문은 저장되었으며 작성 기록은 확인 대기 중입니다. 다시 저장하지
              마세요.
            </p>
          )}
        </StatusNotice>
      )}
      {model.restoration !== null && (
        <StatusNotice
          tone={model.restoration === 'saved' ? 'success' : 'warning'}
          title={
            model.restoration === 'pending'
              ? '버전을 복원하고 있습니다'
              : model.restoration === 'saved'
                ? '복원한 현재 본문 확인 필요'
                : model.restoration === 'conflict'
                  ? '복원 전에 본문이 변경되었습니다'
                  : '복원 완료 여부 확인 필요'
          }
        >
          <p>
            {model.restoration === 'saved'
              ? '복원 저장은 완료되었습니다. 아래 본문은 아직 복원 전일 수 있으므로 현재 본문을 다시 확인해 주세요.'
              : '화면에서 비교한 버전을 기준으로 처리합니다. 현재 본문을 다시 읽어도 복원을 자동으로 실행하지 않습니다.'}
          </p>
          {model.restoration !== 'pending' && (
            <Button
              variant="surface"
              type="submit"
              className={styles.button}
              disabled={model.busy}
              onClick={(): void => {
                void model.checkRestoration();
              }}
            >
              현재 본문 다시 확인
            </Button>
          )}
        </StatusNotice>
      )}
      {!editing && model.error && (
        <StatusNotice tone="warning" title="문서 상태를 확인해 주세요">
          {model.error.message}
        </StatusNotice>
      )}
      {!editing && history.error && !versionId && (
        <StatusNotice tone="warning" title="버전 목록을 불러오지 못했습니다">
          {history.error.message}
          <Button
            variant="surface"
            type="submit"
            className={styles.button}
            disabled={history.busy}
            onClick={(): void => {
              void history.load(null);
            }}
          >
            다시 불러오기
          </Button>
        </StatusNotice>
      )}
      {current.authorship?.status === 'pending_reconcile' && !model.receipt && (
        <StatusNotice tone="warning" title="작성 기록 확인 중">
          본문은 저장되었으며 작성 기록은 확인 대기 중입니다. 다시 저장하지
          마세요.
        </StatusNotice>
      )}
      {!editing && (
        <DocumentExtractionBanner model={extraction} current={current} />
      )}
      {!editing && !versionId && evidenceMatch && (
        <StatusNotice
          tone={evidenceMatch.status === 'matched' ? 'info' : 'warning'}
          title={
            evidenceMatch.status === 'matched'
              ? `근거 위치 · ${evidenceMatch.startLine}${evidenceMatch.endLine !== evidenceMatch.startLine ? `–${evidenceMatch.endLine}` : ''}행`
              : evidenceMatch.status === 'changed'
                ? '근거가 기록된 뒤 문서가 변경되었습니다'
                : '기록된 근거 위치를 찾지 못했습니다'
          }
        >
          {evidenceMatch.status === 'matched'
            ? '선택한 근거의 원문 위치를 표시합니다.'
            : evidenceMatch.status === 'changed'
              ? '현재 본문은 관계에 연결된 판본과 다릅니다. 관계 상세에서 근거를 다시 확인해 주세요.'
              : '현재 본문에서 행과 인용이 일치하지 않아 위치를 강조하지 않았습니다.'}
        </StatusNotice>
      )}
      {editing ? (
        <DocumentEditor model={model} />
      ) : versionId ? (
        <DocumentVersionView
          current={current}
          model={history}
          selectedId={versionId}
          against={against}
          onAgainst={setAgainst}
          onClose={(): void => selectVersion(null)}
          restoreDisabledReason={restoreDisabledReason}
          onRestore={model.restore}
        />
      ) : (
        <section className={styles.documentBody} aria-label="문서 본문">
          <DocumentMarkdown
            content={current.body ?? current.content}
            bodyStartLine={documentBodyStartLine(current)}
            evidence={evidenceMatch}
            evidenceKey={location.key}
            active={active}
          />
        </section>
      )}
    </div>
  );
}

/** 문서 선택·읽기 실패를 빈 본문과 구분하고 확인된 문서만 편집 흐름에 넘깁니다. */
export function ManageDocumentContent({
  path,
}: ManageDocumentContentProps): JSX.Element {
  const [parameters] = useSearchParams();
  const model = useDocumentContent(path, parameters.get('mode') === 'edit');
  if (!path)
    return (
      <div className={styles.state}>
        <span className={styles.documentSymbol}>
          <Icon name="file-text" size={24} />
        </span>
        <h1>읽을 문서를 선택해 주세요</h1>
        <Link className={styles.button} to="/documents">
          문서 목록으로
        </Link>
      </div>
    );
  if (model.state.status === 'loading')
    return (
      <div
        className={styles.root}
        role="status"
        aria-busy="true"
        aria-label="본문을 불러오고 있습니다"
      >
        <div className={chips.chipRow} aria-hidden="true">
          <span className={chips.chip}>
            <SkeletonBar shape="badge" />
          </span>
          <span className={chips.chip}>
            <SkeletonBar shape="badge" />
          </span>
          <span className={chips.chip}>
            <SkeletonBar shape="badge" />
          </span>
        </div>
        <div
          className={`${styles.documentBody} ${chips.skeleton}`}
          aria-hidden="true"
        >
          <SkeletonBar shape="heading" />
          <SkeletonText lines={4} />
          <SkeletonBar shape="title" />
          <SkeletonText lines={5} />
        </div>
      </div>
    );
  if (model.state.status === 'error')
    return (
      <div className={styles.state}>
        <span className={styles.documentSymbol}>
          <Icon name="triangle-alert" size={24} />
        </span>
        <h1>
          {model.state.error.status === 404
            ? '문서를 찾을 수 없습니다'
            : '본문을 불러오지 못했습니다'}
        </h1>
        <p role="alert">{model.state.error.message}</p>
        <div className={styles.actions}>
          <Button
            variant="primary"
            type="submit"
            className={styles.primaryButton}
            onClick={model.retry}
          >
            다시 불러오기
          </Button>
          <Link className={styles.button} to="/documents">
            문서 목록
          </Link>
          <Link className={styles.link} to="/settings">
            연결하기
          </Link>
        </div>
      </div>
    );
  return (
    <LoadedDocument
      key={contentDraftKey(model.state.session.current)}
      session={model.state.session}
      onInvalidated={model.invalidate}
      refreshing={model.refreshing}
      refreshError={model.refreshError}
    />
  );
}
