import { useEffect, useRef, useState } from 'react';
import type { JSX, SubmitEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { notificationCorrectSchema } from '@contracts/notifications.contract';
import type { NotificationCorrectRequest } from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { notificationsApi } from '../api/notifications.api';
import {
  notificationAccessLost,
  notificationRequestId,
  notificationSession,
} from '../model/notificationView';
import styles from './Notifications.module.scss';

const editorSchema = z.object({
  content: notificationCorrectSchema.shape.content,
});
type EditorValues = z.infer<typeof editorSchema>;
type PageCorrectionEditorProps = {
  scope: SourceConversionScope;
  workflowId: string;
  revision: string;
  page: number;
  text: string | null;
  held: boolean;
  disabled: boolean;
  onEditingChange: (editing: boolean) => void;
  onRefresh: () => Promise<void>;
  onAccessLost: () => void;
};

/** 재인식 후보와 직접 수정을 분리하고 명시 저장 뒤에만 서버 문자를 다시 읽습니다. */
export function PageCorrectionEditor({
  scope,
  workflowId,
  revision,
  page,
  text,
  held,
  disabled,
  onEditingChange,
  onRefresh,
  onAccessLost,
}: PageCorrectionEditorProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [editing, setEditing] = useState(false);
  const [phase, setPhase] = useState<'ocr' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [method, setMethod] = useState<'manual' | 'ocr'>('manual');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [uncertain, setUncertain] = useState(false);
  const [checked, setChecked] = useState(false);
  const [basis, setBasis] = useState(revision);
  const live = useRef(true);
  const generation = useRef(0);
  const retryId = useRef<string | null>(null);
  const sent = useRef<NotificationCorrectRequest | null>(null);
  const form = useForm<EditorValues>({
    resolver: zodResolver(editorSchema),
    defaultValues: { content: '' },
  });
  const focusEditor = form.setFocus;
  useEffect((): void => {
    if (editing && active) focusEditor('content');
  }, [editing, active, focusEditor]);

  useEffect((): (() => void) => {
    live.current = true;
    return (): void => {
      live.current = false;
      generation.current += 1;
      const requestId = retryId.current;
      if (requestId)
        void notificationsApi
          .cancelRetry({
            ...notificationSession(scope),
            workflowId,
            requestId,
          })
          .catch((): void => {});
    };
  }, [scope, workflowId]);
  useEffect((): (() => void) | undefined => {
    if (!editing) return;
    /** 완전 종료에서 미저장 입력이 사라진다는 브라우저 확인을 요청합니다. */
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return (): void => window.removeEventListener('beforeunload', warn);
  }, [editing]);
  useEffect((): (() => void) => {
    onEditingChange(editing || phase !== null);
    return (): void => onEditingChange(false);
  }, [editing, phase, onEditingChange]);

  /** 편집 중 쪽 이동과 사용 확인은 잠그고 자동 조회가 입력을 덮지 않게 합니다. */
  function begin(
    content: string,
    origin: 'manual' | 'ocr',
    diagnostics: string[],
  ): void {
    form.reset({ content });
    setMethod(origin);
    setWarnings(diagnostics);
    sent.current = null;
    setUncertain(false);
    setChecked(false);
    setEditing(true);
    onEditingChange(true);
  }

  /** 인식 실패는 원래 문자와 페이지 판단을 바꾸지 않습니다. */
  async function retry(): Promise<void> {
    if (disabled || phase || editing) return;
    const requestId = notificationRequestId();
    retryId.current = requestId;
    setBasis(revision);
    const current = ++generation.current;
    setPhase('ocr');
    setError(null);
    setNotice(null);
    onEditingChange(true);
    try {
      const result = await notificationsApi.retryPage({
        ...notificationSession(scope),
        workflowId,
        requestId,
        expectedRevision: revision,
        page,
      });
      if (!live.current || current !== generation.current) return;
      if (!result.ok) {
        if (notificationAccessLost(result.error)) onAccessLost();
        throw new Error(result.error.message);
      }
      if (result.data.page !== page)
        throw new Error('다시 인식한 쪽을 확인하지 못했습니다.');
      begin(result.data.content, 'ocr', result.data.warnings);
      setNotice(
        result.data.content.trim()
          ? '다시 인식한 후보입니다. 원본과 대조하고 필요한 부분을 고친 뒤 저장해 주세요.'
          : '다시 인식했지만 문자를 찾지 못했습니다. 원본을 보며 직접 입력해 주세요.',
      );
    } catch (cause: unknown) {
      if (live.current && current === generation.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : '문자를 다시 인식하지 못했습니다. 직접 수정할 수 있습니다.',
        );
        onEditingChange(false);
      }
    } finally {
      if (live.current && current === generation.current) {
        retryId.current = null;
        setPhase(null);
      }
    }
  }

  /** 후보 실행만 취소하며 서버의 보류와 원래 문자는 그대로 둡니다. */
  async function cancelRetry(): Promise<void> {
    const requestId = retryId.current;
    if (!requestId) return;
    generation.current += 1;
    retryId.current = null;
    setPhase(null);
    setNotice(
      '재인식을 취소했습니다. 직접 문자를 수정하거나 다시 시도할 수 있습니다.',
    );
    onEditingChange(false);
    try {
      const result = await notificationsApi.cancelRetry({
        ...notificationSession(scope),
        workflowId,
        requestId,
      });
      if (!result.ok && live.current) {
        if (notificationAccessLost(result.error)) onAccessLost();
        setError(result.error.message);
      }
    } catch {
      if (live.current)
        setError(
          '재인식 중단 여부를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
        );
    }
  }

  /** 최초 전송한 본문·판본·ID를 보존해 유실 후에도 같은 저장만 재확인합니다. */
  async function save(values: EditorValues): Promise<void> {
    if (phase || disabled || (uncertain && !checked)) return;
    const payload = sent.current ?? {
      ...notificationSession(scope),
      workflowId,
      requestId: notificationRequestId(),
      expectedRevision: basis,
      page,
      content: values.content,
      method,
      warnings,
    };
    sent.current = payload;
    setPhase('save');
    setError(null);
    setChecked(false);
    try {
      const result = await notificationsApi.correct(payload);
      if (!live.current) return;
      if (!result.ok) {
        if (notificationAccessLost(result.error)) onAccessLost();
        throw new Error(result.error.message);
      }
      await onRefresh();
      if (!live.current) return;
      setEditing(false);
      setUncertain(false);
      sent.current = null;
      onEditingChange(false);
      setNotice(
        '수정 문자를 저장했습니다. 원본과 대조한 뒤 ‘이 쪽 문자 사용’을 선택해 주세요.',
      );
    } catch (cause: unknown) {
      if (live.current) {
        setUncertain(true);
        setError(
          cause instanceof Error
            ? cause.message
            : '수정 저장 결과를 확인하지 못했습니다.',
        );
      }
    } finally {
      if (live.current) setPhase(null);
    }
  }

  /** 유실 뒤 조회는 자동 저장·승인을 하지 않고 명시 재시도만 열어 줍니다. */
  async function checkSaved(): Promise<void> {
    await onRefresh();
    if (live.current) setChecked(true);
  }

  return (
    <section className={styles.correction} aria-label={`${page}쪽 문자 수정`}>
      <div className={styles.paneHeading}>
        <h3>{held ? '보류한 쪽 해결' : '문자 다시 확인·수정'}</h3>
      </div>
      {held && !editing && (
        <p>
          이 쪽을 다시 인식하거나 직접 고친 뒤, 사용할 문자를 확인해 주세요.
        </p>
      )}
      {error && (
        <StatusNotice
          tone="error"
          title={uncertain ? '수정 저장 확인 필요' : '재인식 결과 확인'}
        >
          {error}
        </StatusNotice>
      )}
      {notice && <p role="status">{notice}</p>}
      {!editing && (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={disabled || !!phase}
            onClick={(): void => {
              void retry();
            }}
          >
            이 쪽 다시 문자 인식
          </Button>
          <Button
            variant="secondary"
            disabled={disabled || !!phase}
            onClick={(): void => {
              setBasis(revision);
              setError(null);
              setNotice(null);
              begin(text ?? '', 'manual', []);
            }}
          >
            문자 직접 수정
          </Button>
          {phase === 'ocr' && (
            <>
              <span role="status">이 쪽의 문자를 다시 인식하고 있습니다…</span>
              <Button
                variant="secondary"
                onClick={(): void => {
                  void cancelRetry();
                }}
              >
                재인식 취소
              </Button>
            </>
          )}
        </div>
      )}
      {editing && (
        <form
          className={styles.correctionForm}
          onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
            void form.handleSubmit(save)(event);
          }}
        >
          <label htmlFor={`page-correction-${page}`}>{page}쪽 수정 문자</label>
          <textarea
            id={`page-correction-${page}`}
            {...form.register('content', {
              onChange: (): void => {
                setMethod('manual');
              },
            })}
            disabled={!!phase}
            readOnly={uncertain}
            aria-invalid={!!form.formState.errors.content}
            aria-describedby={`page-correction-help-${page}`}
          />
          <p id={`page-correction-help-${page}`} className={styles.receipt}>
            입력은 아직 저장되지 않았습니다. 다른 화면을 열어도 이 검토로
            돌아오면 남아 있으며, 앱을 종료하면 사라집니다. 다른 쪽을 선택하려면
            저장하거나 편집을 취소해 주세요.
          </p>
          {form.formState.errors.content && (
            <p role="alert">
              원본과 대조한 문자를 입력해 주세요. 한 쪽의 입력 한도는 UTF-8
              4MiB입니다.
            </p>
          )}
          {basis !== revision && !uncertain && (
            <p role="alert">
              검토 내역이 바뀌었습니다. 입력은 보존되어 있지만 현재 수정은
              충돌할 수 있습니다. 필요한 문자를 복사한 뒤 다시 확인해 주세요.
            </p>
          )}
          {!!warnings.length && (
            <details>
              <summary>재인식 진단 {warnings.length}개</summary>
              <ul>
                {warnings.map((warning: string, index: number): JSX.Element => (
                  <li key={`${index}:${warning}`}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <div className={styles.actions}>
            <Button
              type="submit"
              disabled={disabled || !!phase || (uncertain && !checked)}
            >
              {phase === 'save'
                ? '수정 문자 저장 중…'
                : uncertain
                  ? '같은 수정 다시 저장'
                  : '수정 문자 저장'}
            </Button>
            {uncertain && (
              <Button
                type="button"
                variant="secondary"
                disabled={!!phase}
                onClick={(): void => {
                  void checkSaved();
                }}
              >
                저장 상태 다시 확인
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={!!phase || (uncertain && !checked)}
              onClick={(): void => {
                setEditing(false);
                sent.current = null;
                setError(null);
                setUncertain(false);
                onEditingChange(false);
                setNotice(
                  '편집을 닫았습니다. 서버에 보관된 문자는 아래 확인 단계에서 사용할 수 있습니다.',
                );
              }}
            >
              {uncertain ? '확인한 편집 닫기' : '편집 취소'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
