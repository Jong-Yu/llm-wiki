import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type {
  TemplateDetail,
  TemplateSession,
} from '@contracts/templates.contract';
import {
  useTemplateCatalogQuery,
  useTemplateQuery,
  templateFileType,
} from '@renderer/domains/templates';
import { templatesGateway } from '@renderer/platform/templates';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import {
  templateTitleKey,
  useRouteTitle,
} from '@renderer/shared/lib/routeTitle';
import {
  notifyReadChange,
  useReadQueries,
} from '@renderer/shared/lib/readQueries';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { MetadataPopover } from '@renderer/shared/ui/MetadataPopover';
import { SkeletonList, SkeletonText } from '@renderer/shared/ui/Skeleton';
import { TemplateList } from './TemplateList';
import { TemplateEditor } from './TemplateEditor';
import styles from './TemplateWorkspace.module.scss';

export type TemplateLocation = {
  templateId: string | null;
  mode: 'list' | 'detail' | 'edit' | 'register';
};
type TemplateWorkspaceProps = {
  session: TemplateSession;
  canWrite: boolean;
  location: TemplateLocation;
  onNavigate: (location: TemplateLocation) => void;
  onUse: (templateId: string) => void;
};

/** 범위별 실제 목록·상세를 연결하고 자료가 없거나 읽지 못한 상태를 구별합니다. */
export function TemplateWorkspace({
  session,
  canWrite,
  location,
  onNavigate,
  onUse,
}: TemplateWorkspaceProps): JSX.Element {
  const catalog = useTemplateCatalogQuery(session, templatesGateway);
  const detail = useTemplateQuery(
    session,
    location.templateId,
    templatesGateway,
  );
  const { snapshot, cache } = useReadQueries();
  const template = detail.data?.template;
  useRouteTitle(
    templateTitleKey(location.templateId ?? ''),
    template?.name ?? null,
  );
  const register = (): void =>
    onNavigate({ templateId: null, mode: 'register' });
  const list = (): void => onNavigate({ templateId: null, mode: 'list' });
  const open = (templateId: string): void =>
    onNavigate({ templateId, mode: 'detail' });
  const saved = (value: TemplateDetail): void => open(value.template.id);
  if (snapshot.failure)
    return (
      <section className={styles.root}>
        <StatusNotice
          tone="error"
          action={
            <Button variant="surface" onClick={cache.clear}>
              다시 확인
            </Button>
          }
        >
          {snapshot.failure.message}
        </StatusNotice>
      </section>
    );
  if (location.mode === 'list')
    return (
      <section className={styles.root} aria-label="템플릿 등록 및 관리">
        {canWrite && (
          <HeaderActions>
            <Button onClick={register}>
              <Icon name="plus" />
              템플릿 등록
            </Button>
          </HeaderActions>
        )}
        {catalog.error && (
          <StatusNotice
            tone="error"
            action={
              <Button
                variant="surface"
                onClick={(): void => {
                  void catalog.refetch();
                }}
              >
                다시 불러오기
              </Button>
            }
          >
            {catalog.error.message}
          </StatusNotice>
        )}
        {!catalog.data && catalog.isPending ? (
          <SkeletonList label="템플릿 목록을 불러오는 중">
            <SkeletonText lines={3} />
          </SkeletonList>
        ) : (
          catalog.data && (
            <>
              {(!catalog.data.complete || catalog.data.truncated) && (
                <StatusNotice tone="warning">
                  일부 템플릿만 확인했습니다.
                </StatusNotice>
              )}
              <TemplateList
                items={catalog.data.items}
                onOpen={open}
                onRegister={canWrite ? register : undefined}
              />
            </>
          )
        )}
      </section>
    );
  if (location.mode === 'register')
    return (
      <section className={styles.root} aria-label="템플릿 등록 및 관리">
        {canWrite ? (
          <TemplateEditor session={session} onSaved={saved} onCancel={list} />
        ) : (
          <StatusNotice tone="warning">
            템플릿을 등록할 권한이 없습니다.
          </StatusNotice>
        )}
      </section>
    );
  if (!template || !detail.data)
    return (
      <section className={styles.root}>
        {detail.error ? (
          <StatusNotice
            tone="error"
            action={
              <Button
                variant="surface"
                onClick={(): void => {
                  void detail.refetch();
                }}
              >
                다시 불러오기
              </Button>
            }
          >
            {detail.error.message}
          </StatusNotice>
        ) : (
          <SkeletonList label="템플릿을 불러오는 중">
            <SkeletonText lines={4} />
          </SkeletonList>
        )}
        <Button variant="surface" onClick={list}>
          템플릿 목록으로
        </Button>
      </section>
    );
  if (location.mode === 'edit')
    return (
      <section className={styles.root} aria-label="템플릿 등록 및 관리">
        {canWrite && !template.archived ? (
          <TemplateEditor
            session={session}
            initial={template}
            onSaved={saved}
            onCancel={(): void => open(template.id)}
          />
        ) : (
          <StatusNotice tone="warning">
            이 템플릿을 편집할 수 없습니다.
          </StatusNotice>
        )}
      </section>
    );
  return (
    <TemplateReader
      session={session}
      detail={detail.data}
      canWrite={canWrite}
      onEdit={(): void => onNavigate({ templateId: template.id, mode: 'edit' })}
      onUse={(): void => onUse(template.id)}
      onArchived={list}
    />
  );
}

type TemplateReaderProps = {
  session: TemplateSession;
  detail: TemplateDetail;
  canWrite: boolean;
  onEdit: () => void;
  onUse: () => void;
  onArchived: () => void;
};

/** 지침은 읽기 본문, 파일은 기존 속성 칩에 두고 원본 내려받기를 제공합니다. */
function TemplateReader({
  session,
  detail,
  canWrite,
  onEdit,
  onUse,
  onArchived,
}: TemplateReaderProps): JSX.Element {
  const { template, generation } = detail;
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const alive = useRef(true);
  const lock = useRef(false);
  const archiveRequest = useRef<string | null>(null);
  useEffect((): (() => void) => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  /** 사용자가 선택한 고정 판본만 내려받고 실제 저장 여부를 확인합니다. */
  async function download(): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await templatesGateway.downloadOriginal({
        ...session,
        templateId: template.id,
        revision: template.revision,
      });
      if (!alive.current) return;
      if (!result.ok) setError(result.error.message);
      else if (result.data.started)
        setNotice(result.data.warning ?? '원본 파일을 저장했습니다.');
    } catch {
      if (alive.current) setError('원본 파일을 내려받지 못했습니다.');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  /** 보관은 새 선택에서만 제외하며 과거 요청에 연결된 판본은 삭제하지 않습니다. */
  async function archive(): Promise<void> {
    if (lock.current) return;
    archiveRequest.current ??= crypto.randomUUID().replaceAll('-', '');
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await templatesGateway.archive({
        ...session,
        templateId: template.id,
        expectedRevision: template.revision,
        requestId: archiveRequest.current,
      });
      if (!alive.current) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      notifyReadChange();
      onArchived();
    } catch {
      if (alive.current)
        setError('보관 결과를 확인하지 못했습니다. 다시 확인해 주세요.');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className={styles.root} aria-label="템플릿 등록 및 관리">
      <HeaderActions>
        {canWrite && !template.archived && (
          <Button variant="surface" onClick={onEdit} disabled={busy}>
            편집
          </Button>
        )}
        <Button
          onClick={onUse}
          disabled={template.archived || !generation.supported || busy}
        >
          AI 채팅에서 사용
        </Button>
      </HeaderActions>
      {error && <StatusNotice tone="error">{error}</StatusNotice>}
      {notice && <p role="status">{notice}</p>}
      {template.archived && (
        <StatusNotice tone="info">
          보관된 템플릿입니다. 이전 요청의 파일과 지침은 유지됩니다.
        </StatusNotice>
      )}
      <div className={styles.chipRow}>
        <MetadataPopover
          icon="info"
          label="템플릿 정보"
          popoverLabel="템플릿 정보"
        >
          {(): JSX.Element => (
            <>
              <dl>
                <dt>파일명</dt>
                <dd>{template.filename}</dd>
                <dt>형식</dt>
                <dd>{templateFileType(template.filename)}</dd>
                <dt>크기</dt>
                <dd>
                  {(template.sizeBytes / 1024).toLocaleString('ko-KR', {
                    maximumFractionDigits: 1,
                  })}{' '}
                  KB
                </dd>
              </dl>
              <div className={styles.actions}>
                <Button
                  variant="surface"
                  disabled={busy}
                  onClick={(): void => {
                    void download();
                  }}
                >
                  원본 내려받기
                </Button>
              </div>
            </>
          )}
        </MetadataPopover>
        {canWrite && !template.archived && (
          <MetadataPopover
            icon="ellipsis"
            label="더보기"
            popoverLabel="템플릿 관리"
          >
            {(close: () => void): JSX.Element => (
              <Button
                variant="surface"
                disabled={busy}
                onClick={(): void => {
                  close();
                  setConfirmArchive(true);
                }}
              >
                템플릿 보관
              </Button>
            )}
          </MetadataPopover>
        )}
      </div>
      {!generation.supported && (
        <StatusNotice tone="warning">
          {generation.reason ??
            '이 파일 형식은 등록·보관할 수 있지만 산출물 생성은 지원하지 않습니다.'}
        </StatusNotice>
      )}
      {confirmArchive && (
        <StatusNotice
          tone="warning"
          title="이 템플릿을 보관할까요?"
          action={
            <>
              <Button
                variant="surface"
                disabled={busy}
                onClick={(): void => setConfirmArchive(false)}
              >
                취소
              </Button>
              <Button
                disabled={busy}
                onClick={(): void => {
                  void archive();
                }}
              >
                보관
              </Button>
            </>
          }
        >
          새 요청의 목록에서 제외됩니다. 이전 요청의 파일과 지침은 유지됩니다.
        </StatusNotice>
      )}
      <article className={styles.documentBody} aria-label="지침">
        <h2>{template.instructions.trim() ? '지침' : '지침이 없습니다'}</h2>
        <p className={styles.preservedText}>
          {template.instructions.trim()
            ? template.instructions
            : '편집에서 이 양식에 함께 적용할 지침을 작성할 수 있습니다.'}
        </p>
      </article>
    </section>
  );
}
