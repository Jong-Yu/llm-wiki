import { Button } from '@renderer/shared/ui/Button';
import type { EditableMetadata } from '../model/documentMetadata';
import {
  draftParts,
  replaceBody,
  documentMetadataPreview,
} from '../model/documentMetadata';
import { DocumentMetadataForm } from './DocumentMetadataForm';
import type { ChangeEvent, JSX } from 'react';
import { useId } from 'react';
import type { DocumentEditingModel } from '../model/useDocumentEditing';
import { Icon } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { DocumentComparison } from './DocumentComparison';
import chips from './DocumentChips.module.scss';
import styles from './ManageDocumentContent.module.scss';

/** 편집기 크기 표시: 1 KiB 미만은 바이트, 그 이상은 KB로 보입니다. */
function formatSize(bytes: number): string {
  return bytes < 1024
    ? `${bytes.toLocaleString('ko-KR')} B`
    : `${(bytes / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} KB`;
}
type DocumentEditorActionsProps = {
  model: DocumentEditingModel;
  onClose: () => void;
};
type DocumentEditorProps = { model: DocumentEditingModel };
/** 읽기 화면과 같은 제목 줄 오른쪽에 놓이는 편집·비교 단계의 명시 행동입니다. */
export function DocumentEditorActions({
  model,
  onClose,
}: DocumentEditorActionsProps): JSX.Element {
  const { draft, busy } = model;
  const disabled = busy || model.restoration !== null;
  return (
    <div className={styles.actions}>
      <Button
        variant="surface"
        type="submit"
        className={styles.button}
        onClick={onClose}
        disabled={disabled}
      >
        취소
      </Button>
      {draft.phase === 'compare' && (
        <Button
          variant="surface"
          type="submit"
          className={styles.button}
          onClick={model.edit}
          disabled={disabled}
        >
          계속 편집
        </Button>
      )}
      {draft.phase === 'edit' && (
        <Button
          variant="surface"
          type="submit"
          className={styles.button}
          onClick={model.compare}
          disabled={disabled}
        >
          변경 내용 확인
        </Button>
      )}
      {(draft.phase === 'edit' || draft.phase === 'compare') && (
        <Button
          variant="primary"
          type="submit"
          className={styles.primaryButton}
          onClick={(): void => {
            void model.save();
          }}
          disabled={disabled}
        >
          {busy && <Icon name="loader-circle" className={chips.spin} />}
          {busy ? '저장 중…' : '저장'}
        </Button>
      )}
    </div>
  );
}
/** 편집·비교·충돌의 명시 행동을 표시하며 모델이 CAS 기준과 초안을 소유합니다. */
export function DocumentEditor({ model }: DocumentEditorProps): JSX.Element {
  const editorId = useId();
  const mergedId = useId();
  const { draft, busy } = model;
  const disabled = busy || model.restoration !== null;
  const resolving = draft.phase === 'conflict' || draft.phase === 'unknown';
  const body =
    draft.phase === 'edit' ? draftParts(draft.base, draft.content).body : '';
  const lineCount = body.split('\n').length;
  return (
    <section
      className={styles.editor}
      aria-label="Markdown 편집"
      aria-busy={busy}
    >
      <div className={styles.editToolbar}>
        <div className={chips.editHeader}>
          <strong>
            {resolving
              ? '최신 본문에 수정안 반영'
              : draft.phase === 'compare'
                ? '변경 내용 확인'
                : '수정 중'}
          </strong>
        </div>
      </div>
      {model.error && (
        <StatusNotice
          tone="error"
          title={
            model.error.code === 'invalid_metadata'
              ? '문서 설명을 확인해 주세요'
              : model.error.code === 'storage_busy'
                ? '다른 저장 작업이 진행 중입니다'
                : resolving
                  ? '저장 결과를 대조해 주세요'
                  : '본문을 저장하지 못했습니다'
          }
        >
          <p>{model.error.message}</p>
          {model.error.cleanupWarningCount !== undefined &&
            model.error.cleanupWarningCount > 0 && (
              <p>
                별도 임시 파일 정리 오류 {model.error.cleanupWarningCount}개가
                보고되었습니다. 위 저장 오류와 구분해 확인해 주세요.
              </p>
            )}
          {model.error.code === 'storage_busy' && (
            <p>
              초안과 기준 버전을 유지했습니다. 잠시 후 같은 내용으로 다시 저장할
              수 있습니다.
            </p>
          )}
        </StatusNotice>
      )}
      {resolving ? (
        <>
          <StatusNotice
            tone="warning"
            title={
              draft.phase === 'unknown'
                ? '저장 완료 여부를 확인하지 못했습니다'
                : '다른 사람이 먼저 본문을 수정했습니다'
            }
          >
            내 초안은 보관되어 있습니다. 최신 본문과 비교하고 필요한 수정을 옮긴
            뒤 저장해 주세요.
          </StatusNotice>
          {!draft.latest && (
            <Button
              variant="surface"
              type="submit"
              className={styles.button}
              disabled={disabled}
              onClick={(): void => {
                void model.loadLatest();
              }}
            >
              {busy ? '최신 본문 확인 중…' : '최신 본문과 내 초안 비교'}
            </Button>
          )}
          {draft.latest && (
            <>
              <DocumentComparison
                metadata={!!draft.base.documentId}
                leftTitle="최신 본문"
                left={draft.latest.content}
                rightTitle="원래 내 초안"
                right={draft.content}
              />
              <details>
                <summary>편집을 시작한 기준 본문</summary>
                {draft.base.documentId && (
                  <pre className={styles.sourceText}>
                    {documentMetadataPreview(
                      draftParts(draft.base, draft.base.content).header,
                    )}
                  </pre>
                )}
                <pre className={styles.sourceText}>
                  {draftParts(draft.base, draft.base.content).body}
                </pre>
              </details>
              <DocumentMetadataForm
                key={draft.latest.revision}
                base={draft.latest}
                content={draft.merged}
                values={draft.mergedMetadata}
                disabled={disabled}
                onChange={(fields: EditableMetadata): void =>
                  model.changeMetadata(fields, true)
                }
              />
              <label className={styles.editorLabel} htmlFor={mergedId}>
                최신 본문을 기준으로 다시 작성할 내용
              </label>
              <textarea
                id={mergedId}
                name="reconciled-document"
                className={styles.markdownEditor}
                value={draftParts(draft.latest, draft.merged).body}
                disabled={disabled}
                spellCheck={false}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
                  model.changeMerge(
                    replaceBody(
                      draft.latest ?? draft.base,
                      draft.merged,
                      event.currentTarget.value,
                    ),
                  )
                }
              />
              <div className={styles.footer}>
                <Button
                  variant="primary"
                  type="submit"
                  className={styles.primaryButton}
                  onClick={model.reconcile}
                  disabled={disabled}
                >
                  검토한 본문으로 비교 계속
                </Button>
              </div>
            </>
          )}
        </>
      ) : draft.phase === 'compare' ? (
        <>
          <DocumentComparison
            metadata={!!draft.base.documentId}
            leftTitle="저장된 기준 본문"
            left={draft.base.content}
            rightTitle="저장할 수정안"
            right={draft.content}
          />
          {draftParts(draft.base, draft.content).body.length === 0 && (
            <StatusNotice tone="warning" title="빈 본문을 저장합니다">
              기존 전체 본문은 이력에 보존됩니다. 의도한 변경인지 확인해 주세요.
            </StatusNotice>
          )}
          <p className={styles.hint}>
            저장하면 이전 본문 전체가 버전으로 보관됩니다. 저장 후에는 관계
            재추출이 필요합니다.
          </p>
        </>
      ) : (
        <>
          <DocumentMetadataForm
            key={draft.base.revision}
            base={draft.base}
            content={draft.content}
            disabled={disabled}
            values={draft.metadata}
            onChange={model.changeMetadata}
            collapsible
          />
          <label className={styles.editorLabel} htmlFor={editorId}>
            Markdown 본문
          </label>
          <div className={chips.editorBody}>
            <pre className={chips.gutter} aria-hidden="true">
              {Array.from(
                { length: Math.max(lineCount, 20) },
                (_: unknown, index: number): number => index + 1,
              ).join('\n')}
            </pre>
            <textarea
              id={editorId}
              name="document-markdown"
              className={chips.lineEditor}
              value={body}
              rows={Math.max(lineCount, 20)}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
                model.change(
                  replaceBody(
                    draft.base,
                    draft.content,
                    event.currentTarget.value,
                  ),
                )
              }
              spellCheck={false}
              wrap="off"
              disabled={disabled}
            />
          </div>
          <div className={styles.footer}>
            <span className={styles.hint}>
              {formatSize(new TextEncoder().encode(draft.content).byteLength)} /
              1 MiB
            </span>
            <span className={styles.hint}>
              저장하지 않은 초안은 앱을 종료하면 사라집니다
            </span>
          </div>
        </>
      )}
      {draft.preserved.map(
        (
          value: (typeof draft.preserved)[number],
          index: number,
        ): JSX.Element => (
          <details key={`${value.revision}-${index}`}>
            <summary>재반영 전 초안 {index + 1}</summary>
            {draft.base.documentId && (
              <pre className={styles.sourceText}>
                {documentMetadataPreview(
                  draftParts(draft.base, value.content).header,
                )}
              </pre>
            )}
            <pre className={styles.sourceText}>
              {draftParts(draft.base, value.content).body}
            </pre>
            {value.metadata && (
              <dl className={styles.metadataList}>
                <dt>제목</dt>
                <dd>{value.metadata.title}</dd>
                <dt>태그</dt>
                <dd>{value.metadata.tags || '없음'}</dd>
                <dt>설명</dt>
                <dd>{value.metadata.description || '없음'}</dd>
              </dl>
            )}
          </details>
        ),
      )}
    </section>
  );
}
