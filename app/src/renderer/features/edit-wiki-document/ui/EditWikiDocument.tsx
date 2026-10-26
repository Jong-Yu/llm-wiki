import type { ChangeEvent, JSX } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { DocumentContent } from '@contracts/documents.contract';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useWikiEditor } from '../model/useWikiEditor';
import { wikiEditorSchema } from '../model/wikiEditor.schema';
import type { WikiEditorValues } from '../model/wikiEditor.schema';
import type { DocumentSaveOutcome } from '../api/wikiEditor.api';
import styles from './EditWikiDocument.module.scss';

export type EditWikiDocumentProps = {
  current: DocumentContent;
  allowed?: boolean;
  onSaved: (outcome: DocumentSaveOutcome) => void;
  onClose: () => void;
  onScopeInvalidated: () => void;
};

/** 실제로 읽은 전체 본문을 편집·비교한 뒤 명시 저장하며 원본 파일과 분석 상태는 변경하지 않습니다. */
function EditWikiDocumentSession({
  current,
  allowed = true,
  onSaved,
  onClose,
  onScopeInvalidated,
}: EditWikiDocumentProps): JSX.Element {
  const model = useWikiEditor({ current, onSaved, onScopeInvalidated });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<WikiEditorValues, unknown>({
    resolver: zodResolver(wikiEditorSchema),
    defaultValues: { content: model.draft.content },
  });
  const field = register('content');
  const draft = model.draft;
  const comparison = draft.latest || draft.base;
  const showComparison = draft.phase !== 'edit' && draft.phase !== 'saved';
  /** 저장 중 닫기를 막고 그 밖의 단계는 초안을 메모리에 보존한 채 닫습니다. */
  function close(open: boolean): void {
    if (!open && !model.busy) onClose();
  }
  /** 폼 검증을 통과한 본문만 변경 비교에 전달합니다. */
  function compare(values: WikiEditorValues): void {
    model.compare(values.content);
  }
  return (
    <Dialog
      open
      onOpenChange={close}
      title={draft.phase === 'edit' ? '본문 편집' : '본문 변경 비교'}
      description={current.document}
      className={styles.dialog}
    >
      <div className={styles.workspace} aria-busy={model.busy}>
        <p className={styles.caption}>
          수정 전 전체 본문은 이력에 보존합니다. 본문 저장은 원본 파일 교체나
          지식 재추출·검토 승인을 뜻하지 않습니다.
        </p>
        {!allowed && (
          <StatusNotice tone="warning" title="본문 쓰기 권한이 없습니다">
            현재 본문을 읽거나 수정안을 확인할 수 있습니다.
          </StatusNotice>
        )}
        {draft.phase === 'conflict' && (
          <StatusNotice tone="warning" title="본문이 변경되었습니다">
            수정안과 원래 기준은 보존했습니다. 최신 전체 본문을 다시 읽어 대조한
            뒤 편집 기준을 명시적으로 선택해 주세요.
          </StatusNotice>
        )}
        {draft.phase === 'unknown' && (
          <StatusNotice tone="warning" title="저장 결과를 확인하지 못했습니다">
            같은 저장을 다시 보내지 않습니다. 현재 본문을 읽어 대조해 주세요.
            내용이 같더라도 이전 요청의 완료가 확인된 것은 아닙니다.
          </StatusNotice>
        )}
        {model.error && (
          <StatusNotice tone="error" title="본문 저장·조회 안내">
            <p>{model.error.message}</p>
            {model.error.traceId && <p>문의 코드: {model.error.traceId}</p>}
          </StatusNotice>
        )}
        {draft.phase === 'edit' ? (
          <form
            onSubmit={handleSubmit(compare)}
            noValidate
            className={styles.form}
          >
            <TextareaField
              {...field}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
                void field.onChange(event);
                model.change(event.currentTarget.value);
              }}
              label="위키 본문"
              rows={14}
              error={errors.content?.message}
              disabled={model.busy}
              description="UTF-8 1 MiB 이내의 전체 Markdown 본문을 입력합니다. 공백과 줄바꿈을 보존합니다."
            />
            <p className={styles.revision}>기준 판본: {draft.base.revision}</p>
            <div className={styles.actions}>
              <Button
                variant="secondary"
                onClick={onClose}
                disabled={model.busy}
              >
                닫기
              </Button>
              <Button type="submit" disabled={model.busy || !allowed}>
                변경 비교
              </Button>
            </div>
          </form>
        ) : null}
        {showComparison && (
          <>
            <div className={styles.comparison} aria-label="본문 변경 비교">
              <section>
                <h3>{draft.latest ? '현재 본문' : '수정 전 본문'}</h3>
                <p className={styles.revision}>{comparison.revision}</p>
                <pre>{comparison.content}</pre>
              </section>
              <section>
                <h3>수정안</h3>
                <p className={styles.caption}>저장 전 초안</p>
                <pre>{draft.content}</pre>
              </section>
            </div>
            <div className={styles.actions}>
              {draft.phase === 'compare' && (
                <>
                  <Button
                    variant="secondary"
                    onClick={model.edit}
                    disabled={model.busy}
                  >
                    계속 편집
                  </Button>
                  <Button
                    onClick={(): void => {
                      void model.save();
                    }}
                    disabled={model.busy || !allowed}
                  >
                    {model.busy ? '저장 확인 중' : '본문 저장'}
                  </Button>
                </>
              )}
              {(draft.phase === 'conflict' || draft.phase === 'unknown') && (
                <Button
                  variant="secondary"
                  onClick={(): void => {
                    void model.readLatest();
                  }}
                  disabled={model.busy}
                >
                  현재 본문 확인
                </Button>
              )}
              {draft.phase === 'conflict' && draft.latest && (
                <Button
                  onClick={model.adoptLatest}
                  disabled={model.busy || !allowed}
                >
                  대조한 현재 본문을 기준으로 계속 편집
                </Button>
              )}
              {draft.phase === 'unknown' && (
                <Button
                  variant="secondary"
                  onClick={onClose}
                  disabled={model.busy}
                >
                  초안을 보존하고 닫기
                </Button>
              )}
            </div>
          </>
        )}
        {model.saved && (
          <StatusNotice
            tone={model.saved.cleanupWarningCount > 0 ? 'warning' : 'success'}
            title={
              model.saved.changed
                ? '본문을 저장했습니다'
                : '본문 내용이 같습니다'
            }
          >
            <p>저장 판본: {model.saved.revision}</p>
            {model.saved.cleanupWarningCount > 0 && (
              <p>
                저장은 완료됐으며 임시 파일 정리 문제{' '}
                {model.saved.cleanupWarningCount}건이 있습니다. 저장을 반복하지
                마세요.
              </p>
            )}
            <Button variant="secondary" onClick={onClose}>
              닫기
            </Button>
          </StatusNotice>
        )}
      </div>
    </Dialog>
  );
}

/** 문서/연결/관점이 바뀌면 편집 세션을 교체해 이전 응답과 초안을 섞지 않습니다. */
export function EditWikiDocument(props: EditWikiDocumentProps): JSX.Element {
  const current = props.current;
  return (
    <EditWikiDocumentSession
      key={JSON.stringify([
        current.connectionId,
        current.access.userId,
        current.access.tenant,
        current.access.profileId,
        current.access.policyRevision,
        current.document,
      ])}
      {...props}
    />
  );
}
