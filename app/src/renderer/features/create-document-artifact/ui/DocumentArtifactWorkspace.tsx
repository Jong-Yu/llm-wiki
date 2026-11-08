import { Button } from '@renderer/shared/ui/Button';
import { documentDisplayName } from '@renderer/domains/documents';
import {
  formatTimestamp,
  formatTimestampWithZone,
} from '@renderer/shared/lib/formatTimestamp';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import {
  artifactTitleKey,
  useRouteTitle,
} from '@renderer/shared/lib/routeTitle';
import { Icon } from '@renderer/shared/ui/Icon';
import { ExportFormatSelect } from '@renderer/shared/ui/ExportFormatSelect';
import {
  EXPORT_FORMAT_NAMES,
  availableExportFormats,
} from '@renderer/platform/fileExports';
import { LineComparison } from '@renderer/shared/ui/LineComparison';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import { ReadingProperties } from '@renderer/shared/ui/ReadingProperties';
import type { ChangeEvent, JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  artifactGenerationStatus,
  artifactEvidence,
  artifactFormSchema,
} from '../model/documentArtifact';
import type {
  ArtifactEvidence,
  ArtifactForm,
  SavedArtifact,
} from '../model/documentArtifact';
import type { QuestionDetail } from '@contracts/questionRuns.contract';
import type { IconName } from '@renderer/shared/ui/Icon';
import { useDocumentArtifact } from '../model/useDocumentArtifact';
import styles from './DocumentArtifactWorkspace.module.scss';

const formStatuses = {
  dirty: {
    label: '미저장 변경 있음',
    detail: '편집 중 · 아직 개인 초안에 미저장',
  },
  draft: { label: '저장한 개인 초안', detail: '개인 편집 초안' },
  saved: { label: '저장된 AI 결과', detail: '저장된 AI 결과' },
};
const downloadLabels = {
  supported: {
    label: '내려받기',
    title:
      '현재 편집 내용을 고른 형식으로 내려받습니다. 서버 저장이나 승인은 수행하지 않습니다.',
  },
  unsupported: {
    label: '다운로드 미지원',
    title: '현재 실행 환경에서는 Markdown 내려받기를 지원하지 않습니다.',
  },
};
const downloadAppearance = {
  editing: { variant: 'surface', className: styles.button },
  preview: {
    variant: 'primary',
    className: `${styles.button} ${styles.primary}`,
  },
} satisfies Record<
  string,
  { variant: 'surface' | 'primary'; className: string }
>;

export type DocumentArtifactWorkspaceProps = {
  artifactId: string | null;
  questionRunId: string | null;
  draftId: string | null;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
};

/** 결과의 실제 본문과 고정 근거만 표시하고 편집·저장 동작을 명시적으로 엽니다. */
export function DocumentArtifactWorkspace({
  artifactId,
  questionRunId,
  draftId,
  editing,
  onEditingChange: setEditing,
}: DocumentArtifactWorkspaceProps): JSX.Element {
  const model = useDocumentArtifact(artifactId, questionRunId, draftId);
  const artifact = model.artifact;
  const edit = model.edit;
  const generation = model.generation;
  const conversationId =
    artifact?.record.data.conversation_id ?? generation?.conversationId;
  const chatHref = conversationId
    ? `/chat?conversationId=${encodeURIComponent(conversationId)}`
    : '/chat';
  const evidence = artifact ? artifactEvidence(artifact.record.data.basis) : [];
  const form = edit?.form ?? { title: '', content: '' };
  const baseline =
    edit?.draft?.draft ??
    (artifact
      ? {
          title: artifact.record.data.title,
          content: artifact.record.data.content,
        }
      : null);
  const dirty =
    baseline !== null &&
    (baseline.title !== form.title || baseline.content !== form.content);

  const ready = model.status === 'ready' && artifact !== null;
  const contentReady = artifact !== null && edit !== null;
  const formStatus =
    formStatuses[dirty ? 'dirty' : edit?.draft ? 'draft' : 'saved'];
  const downloadLabel =
    downloadLabels[model.canDownload ? 'supported' : 'unsupported'];
  const downloadButton = downloadAppearance[editing ? 'editing' : 'preview'];
  const recoveryAction = edit?.pending
    ? { label: '저장 결과 확인', run: model.confirm }
    : edit?.draft
      ? { label: '최신 초안 읽기', run: model.inspect }
      : { label: '다시 읽기', run: model.refresh };
  // 산출물 제목은 앱 Header가 보입니다.
  useRouteTitle(artifactTitleKey(artifactId ?? ''), ready ? form.title : null);
  return (
    <div className={styles.root} data-editing={editing}>
      {ready && (
        <HeaderActions>
          <Button
            variant="surface"
            type="submit"
            className={styles.button}
            onClick={(): void => setEditing(!editing)}
          >
            {editing ? '프리뷰 보기' : '본문 편집'}
          </Button>
          {model.canDownload && (
            <ExportFormatSelect
              formats={availableExportFormats()}
              labels={EXPORT_FORMAT_NAMES}
              value={model.downloadFormat}
              disabled={model.busy}
              onChange={model.setDownloadFormat}
            />
          )}
          <Button
            variant={downloadButton.variant}
            type="submit"
            className={downloadButton.className}
            disabled={!model.canDownload || model.busy}
            title={downloadLabel.title}
            onClick={(): void => {
              void model.download();
            }}
          >
            {downloadLabel.label}
          </Button>
        </HeaderActions>
      )}
      <div className={styles.titleGroup}>
        {contentReady && (
          <p className={styles.statusLine}>
            <span>{edit.pending ? '저장 확인 대기' : formStatus.label}</span>
            <span>개인 초안 · Wiki에는 반영되지 않음</span>
          </p>
        )}
      </div>
      {model.status === 'loading' ? (
        <div className={styles.empty} role="status">
          저장 결과와 편집 내용을 불러오는 중…
        </div>
      ) : model.status === 'error' ? (
        <section className={styles.empty} role="alert">
          <div className={styles.symbol}>
            <Icon name="triangle-alert" size={24} />
          </div>
          <h2>결과물을 읽지 못했습니다</h2>
          <p>{model.error?.message}</p>
          <div className={styles.actions}>
            <Button
              variant="surface"
              type="submit"
              className={styles.button}
              onClick={model.refresh}
            >
              다시 읽기
            </Button>
            <Link className={styles.button} to="/settings">
              연결하기
            </Link>
            <Link className={styles.button} to={chatHref}>
              AI 채팅으로 돌아가기
            </Link>
          </div>
        </section>
      ) : (
        <>
          {edit?.pending && !model.error && (
            <section className={styles.notice} role="status">
              <h2>이전 저장 결과를 확인해야 합니다</h2>
              <p>
                편집 내용과 원래 저장 요청을 복원했습니다. 다시 저장하기 전에
                같은 요청의 결과를 확인해 주세요.
              </p>
              <Button
                variant="surface"
                type="submit"
                className={styles.button}
                disabled={model.busy}
                onClick={model.confirm}
              >
                저장 결과 확인
              </Button>
            </section>
          )}
          {model.error && (
            <section className={styles.error} role="alert">
              <h2>
                {model.error.code === 'conflict'
                  ? '다른 변경과 충돌했습니다'
                  : '작업을 완료하지 못했습니다'}
              </h2>
              <p>{model.error.message}</p>
              <p>완성 결과와 편집 내용은 유지됩니다.</p>
              <div className={styles.actions}>
                <Button
                  variant="surface"
                  type="submit"
                  className={styles.button}
                  disabled={model.busy}
                  onClick={recoveryAction.run}
                >
                  {recoveryAction.label}
                </Button>
              </div>
            </section>
          )}
          {model.downloadError && (
            <section className={styles.error} role="alert">
              <h2>파일을 내려받지 못했습니다</h2>
              <p>{model.downloadError.message}</p>
              <div className={styles.actions}>
                <Button
                  variant="surface"
                  type="submit"
                  className={styles.button}
                  onClick={(): void => setEditing(true)}
                >
                  본문 계속 편집
                </Button>
              </div>
            </section>
          )}
          {model.message && (
            <p className={styles.notice} role="status">
              {model.message}
            </p>
          )}
          <ArtifactGenerationNotice
            artifact={artifact}
            generation={generation}
            chatHref={chatHref}
            onRefresh={model.refresh}
          />
          {contentReady && (
            <>
              {model.inspection && (
                <section
                  className={styles.comparison}
                  aria-label="최신 초안 비교"
                >
                  <h2>최신 서버 초안</h2>
                  <ArtifactDraftComparison
                    latest={model.inspection.draft}
                    form={form}
                  />
                  <Button
                    variant="surface"
                    type="submit"
                    className={styles.button}
                    disabled={model.busy || !!edit.pending}
                    onClick={(): void => {
                      model.beginMerge();
                      setEditing(true);
                    }}
                  >
                    최신 초안으로 병합 편집 시작
                  </Button>
                </section>
              )}
              {!model.canWrite && (
                <p className={styles.notice}>
                  현재 작업 공간에 결과 쓰기 권한이 없어 개인 초안 저장을 사용할
                  수 없습니다.
                </p>
              )}
              <div className={styles.layout}>
                <section
                  className={styles.paperArea}
                  aria-label="결과물 프리뷰"
                >
                  {editing ? (
                    <ArtifactEditor
                      key={`${edit.artifactId}:${edit.draft?.revision ?? 'original'}:${model.previousForm ? 'merge' : ''}`}
                      form={form}
                      busy={model.busy}
                      canSave={
                        model.canWrite && !edit.pending && !edit.conflicted
                      }
                      onChange={model.change}
                      onSave={model.save}
                      onPreview={(): void => setEditing(false)}
                      notice={model.recoveryNotice}
                    />
                  ) : (
                    <article className={styles.paper}>
                      {form.content.trim() ? (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          skipHtml
                          components={{
                            img: ({ alt }: { alt?: string }): JSX.Element => (
                              <span className={styles.notice}>
                                이미지:{' '}
                                {alt || '외부 이미지는 표시하지 않습니다.'}
                              </span>
                            ),
                            a: ({
                              children,
                            }: {
                              children?: ReactNode;
                            }): JSX.Element => (
                              <span className={styles.inlineLink}>
                                {children}
                              </span>
                            ),
                            table: ({
                              children,
                            }: {
                              children?: ReactNode;
                            }): JSX.Element => (
                              <div className={styles.tableScroll}>
                                <table>{children}</table>
                              </div>
                            ),
                          }}
                        >
                          {form.content}
                        </ReactMarkdown>
                      ) : (
                        <p>
                          본문이 비어 있습니다. 본문 편집에서 내용을 입력해
                          주세요.
                        </p>
                      )}
                    </article>
                  )}
                  {model.previousForm && (
                    <details className={styles.comparison} open>
                      <summary>병합 전 내 편집 내용</summary>
                      <h3>{model.previousForm.title}</h3>
                      <pre>{model.previousForm.content}</pre>
                    </details>
                  )}
                </section>
                <ReadingProperties title="결과물 정보" className={styles.info}>
                  <WorkspaceSection
                    title="작성 당시 자료"
                    actions={
                      <span className={styles.badge}>{evidence.length}개</span>
                    }
                  >
                    {evidence.length === 0 ? (
                      <p>저장된 문서 근거가 없습니다.</p>
                    ) : (
                      <>
                        {evidence.map((item: ArtifactEvidence): JSX.Element => (
                          <Link
                            className={styles.document}
                            key={`${item.document}:${item.revision}`}
                            to={`/document?path=${encodeURIComponent(item.document)}`}
                          >
                            <span className={styles.documentIcon}>
                              <Icon name="file-text" />
                            </span>
                            <span>
                              <strong>
                                {documentDisplayName(item.document)}
                              </strong>
                            </span>
                            <Icon name="arrow-right" />
                          </Link>
                        ))}
                        <p className={styles.hint}>
                          작성 당시 버전을 근거로 보관했습니다. 문서 링크는 현재
                          본문을 엽니다.
                        </p>
                      </>
                    )}
                  </WorkspaceSection>
                  <WorkspaceSection title="작성 정보">
                    <dl className={styles.meta}>
                      <dt>작성 시각</dt>
                      <dd>
                        <time
                          dateTime={artifact.record.created_at}
                          title={formatTimestampWithZone(
                            artifact.record.created_at,
                          )}
                        >
                          {formatTimestamp(artifact.record.created_at)}
                        </time>
                      </dd>
                      <dt>원본 대화</dt>
                      <dd>
                        {conversationId ? (
                          <Link to={chatHref}>
                            생성한 대화 <Icon name="external-link" />
                          </Link>
                        ) : (
                          '연결된 대화 정보 없음'
                        )}
                      </dd>
                      <dt>상태</dt>
                      <dd>{formStatus.detail}</dd>
                      <dt>파일 형식</dt>
                      <dd>Markdown (.md)</dd>
                    </dl>
                  </WorkspaceSection>

                  {!editing && model.recoveryNotice && (
                    <p className={styles.hint}>{model.recoveryNotice}</p>
                  )}
                </ReadingProperties>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

type ArtifactComparisonField = {
  key: keyof ArtifactForm;
  leftTitle: string;
  rightTitle: string;
};
const comparisonFields: ArtifactComparisonField[] = [
  { key: 'title', leftTitle: '최신 서버 제목', rightTitle: '내 제목' },
  { key: 'content', leftTitle: '최신 서버 초안', rightTitle: '내 편집 내용' },
];
type ArtifactDraftComparisonProps = {
  latest: ArtifactForm;
  form: ArtifactForm;
};
/** 제목과 본문을 같은 비교 순서로 표시합니다. */
function ArtifactDraftComparison({
  latest,
  form,
}: ArtifactDraftComparisonProps): JSX.Element {
  return (
    <>
      {comparisonFields.map(
        ({
          key,
          leftTitle,
          rightTitle,
        }: ArtifactComparisonField): JSX.Element => (
          <LineComparison
            key={key}
            leftTitle={leftTitle}
            rightTitle={rightTitle}
            left={latest[key]}
            right={form[key]}
          />
        ),
      )}
    </>
  );
}

type ArtifactGenerationNoticeProps = {
  artifact: SavedArtifact | null;
  generation: QuestionDetail | null;
  chatHref: string;
  onRefresh: () => void;
};
type GenerationNotice = {
  title: string;
  description: string;
  icon: IconName;
  role: 'alert' | 'status';
  chatLabel: string;
};
const generationDescription =
  '원본 대화에서 실행과 저장 상태를 확인할 수 있습니다.';
const generationNotices: Record<
  ReturnType<typeof artifactGenerationStatus>,
  GenerationNotice
> = {
  none: {
    title: '아직 만든 결과물이 없습니다',
    description:
      'AI 채팅에서 필요한 문서를 요청해 보세요. 저장한 결과물을 여기서 확인하고 편집할 수 있습니다.',
    icon: 'file-text',
    role: 'status',
    chatLabel: 'AI 채팅에서 작성',
  },
  unconfirmed: {
    title: '답변 저장 결과를 확인해야 합니다',
    description: generationDescription,
    icon: 'file-text',
    role: 'status',
    chatLabel: 'AI 채팅에서 작성',
  },
  running: {
    title: '결과물을 생성하고 있습니다',
    description: generationDescription,
    icon: 'file-text',
    role: 'status',
    chatLabel: 'AI 채팅에서 작성',
  },
  unsaved: {
    title: '대화에서 결과물을 저장해 주세요',
    description: generationDescription,
    icon: 'file-text',
    role: 'status',
    chatLabel: 'AI 채팅에서 작성',
  },
  failed: {
    title: '결과물을 만들지 못했습니다',
    description: '',
    icon: 'triangle-alert',
    role: 'alert',
    chatLabel: '원본 대화에서 다시 확인',
  },
};
/** 생성 실패·미확인·진행·빈 상태는 같은 안내와 행동 틀을 사용합니다. */
function ArtifactGenerationNotice({
  artifact,
  generation,
  chatHref,
  onRefresh,
}: ArtifactGenerationNoticeProps): JSX.Element | null {
  const status = artifactGenerationStatus(generation);
  if (artifact && status !== 'failed') return null;
  const notice = generationNotices[status];
  const failed = status === 'failed';
  const description = failed
    ? `AI 실행이 ${generation?.status === 'cancelled' ? '취소되었습니다' : '완료되지 않았습니다'}. 작성 요청과 원본 대화는 유지됩니다.`
    : notice.description;
  return (
    <section
      className={failed && artifact ? styles.error : styles.empty}
      role={notice.role}
    >
      <div className={styles.symbol}>
        <Icon name={notice.icon} size={24} />
      </div>
      <h2>{notice.title}</h2>
      <p>{description}</p>
      {failed && <blockquote>{generation?.question}</blockquote>}
      <div className={styles.actions}>
        <Link className={`${styles.button} ${styles.primary}`} to={chatHref}>
          {notice.chatLabel}
        </Link>
        {generation && (
          <Button
            variant="surface"
            type="submit"
            className={styles.button}
            onClick={onRefresh}
          >
            생성 상태 다시 읽기
          </Button>
        )}
      </div>
    </section>
  );
}

type ArtifactEditorProps = {
  form: ArtifactForm;
  busy: boolean;
  canSave: boolean;
  notice: string;
  onChange: (form: ArtifactForm) => void;
  onSave: () => Promise<void>;
  onPreview: () => void;
};

/** 제목·본문 검증은 폼이 맡고 입력마다 별도 초안으로 보존합니다. */
function ArtifactEditor({
  form,
  busy,
  canSave,
  notice,
  onChange,
  onSave,
  onPreview,
}: ArtifactEditorProps): JSX.Element {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ArtifactForm>({
    resolver: zodResolver(artifactFormSchema),
    defaultValues: form,
  });
  return (
    <form
      className={styles.editor}
      onSubmit={handleSubmit(async (): Promise<void> => {
        await onSave();
      })}
    >
      <label htmlFor="artifact-title">결과물 제목</label>
      <input
        id="artifact-title"
        {...register('title')}
        disabled={busy}
        aria-invalid={!!errors.title}
        aria-describedby={errors.title ? 'artifact-title-error' : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
          void register('title').onChange(event);
          onChange({ ...form, title: event.target.value });
        }}
      />
      {errors.title && (
        <p id="artifact-title-error" role="alert">
          {errors.title.message}
        </p>
      )}
      <label htmlFor="artifact-markdown">결과물 Markdown 본문</label>
      <textarea
        id="artifact-markdown"
        {...register('content')}
        disabled={busy}
        spellCheck={false}
        aria-invalid={!!errors.content}
        aria-describedby={errors.content ? 'artifact-content-error' : undefined}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
          void register('content').onChange(event);
          onChange({ ...form, content: event.target.value });
        }}
      />
      {errors.content && (
        <p id="artifact-content-error" role="alert">
          {errors.content.message}
        </p>
      )}
      <div className={styles.editorActions}>
        <span role="status">{notice}</span>
        <Button
          variant="surface"
          type="button"
          className={styles.button}
          onClick={onPreview}
        >
          프리뷰 보기
        </Button>
        <Button
          variant="primary"
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          disabled={busy || !canSave}
        >
          {busy ? '저장 확인 중…' : '개인 초안 저장'}
        </Button>
      </div>
    </form>
  );
}
