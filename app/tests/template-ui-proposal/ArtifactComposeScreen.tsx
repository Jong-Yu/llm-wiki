import { useState } from 'react';
import type { ChangeEvent, SubmitEvent, JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, FileText, FolderOpen } from 'lucide-react';
import { Button } from '../../src/renderer/shared/ui/Button';
import { Field } from '../../src/renderer/shared/ui/Field';
import type { FieldControlProps } from '../../src/renderer/shared/ui/Field';
import { SelectField } from '../../src/renderer/shared/ui/SelectField';
import controls from '../../src/renderer/shared/ui/FieldControl.module.scss';
import composer from '../../src/renderer/features/chat-with-knowledge/ui/ChatComposer.module.scss';
import { templateFileType, templateRuleLines } from './ReusableTemplateModel';
import type { SavedTemplate } from './ReusableTemplateModel';
import styles from './ArtifactComposeScreen.module.scss';

export type ArtifactComposeScreenProps = {
  templates: SavedTemplate[];
  selectedId: string;
  onSelect: (id: string) => void;
  mode?: 'compose' | 'chat';
  onCompose?: () => void;
};
const requestSchema = z.object({
  request: z.string().trim().min(1, '요청 내용을 입력해 주세요.'),
});
type RequestValues = z.infer<typeof requestSchema>;
type RequestSnapshot = {
  template: SavedTemplate;
  request: string;
};

/** 저장한 템플릿을 고르면 그 양식과 룰을 함께 적용하는 작성 화면 시안입니다. */
export function ArtifactComposeScreen({
  templates,
  selectedId,
  onSelect,
  mode = 'compose',
  onCompose,
}: ArtifactComposeScreenProps): JSX.Element {
  const isChat = mode === 'chat';
  const [submitted, setSubmitted] = useState<RequestSnapshot | null>(null);
  const selected = templates.find(
    (template: SavedTemplate): boolean => template.id === selectedId,
  );
  const form = useForm<RequestValues>({
    resolver: zodResolver(requestSchema),
    defaultValues: {
      request: 'Nori 문서 상세 화면의 화면설계서를 만들어 줘.',
    },
  });
  const request = useWatch({ control: form.control, name: 'request' });
  const rules = selected ? templateRuleLines(selected.rules) : [];
  const changed =
    submitted !== null &&
    (submitted.request !== request.trim() ||
      submitted.template.id !== selected?.id ||
      submitted.template.name !== selected.name ||
      submitted.template.fileName !== selected.fileName ||
      submitted.template.rules !== selected.rules);

  /** 요청 당시의 양식과 룰을 복사하며 실제 파일 생성이나 외부 전송은 하지 않습니다. */
  function previewRequest(values: RequestValues): void {
    if (!selected) return;
    setSubmitted({ template: { ...selected }, request: values.request });
  }

  const requestField = (
    <Field
      className={styles.requestField}
      label={isChat ? '질문 또는 작성 요청' : '무엇을 만들까요?'}
      error={form.formState.errors.request?.message}
    >
      {(field: FieldControlProps): JSX.Element => (
        <textarea
          {...field}
          {...form.register('request')}
          className={controls.control}
          rows={isChat ? 3 : 5}
          placeholder={
            isChat
              ? '프로젝트에 대해 질문하거나 산출물을 요청하세요.'
              : '만들 산출물의 대상과 내용을 적어 주세요.'
          }
        />
      )}
    </Field>
  );

  return (
    <section
      className={[styles.root, isChat ? styles.chat : ''].join(' ')}
      aria-label={isChat ? 'AI 채팅 화면' : '산출물 작성 화면'}
    >
      <div className={styles.content}>
        <header className={styles.header}>
          <div>
            <h2>{isChat ? 'Nori 프로젝트와 대화' : '산출물 만들기'}</h2>
            <p>
              {isChat
                ? '프로젝트 지식을 바탕으로 질문하거나 산출물을 요청하세요.'
                : '템플릿을 고르고, 만들고 싶은 내용을 알려 주세요.'}
            </p>
          </div>
          {isChat && onCompose && (
            <Button
              type="button"
              variant="surface"
              size="small"
              onClick={onCompose}
            >
              산출물 만들기
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          )}
        </header>
        <details className={styles.project}>
          <summary>
            <FolderOpen size={16} aria-hidden="true" />
            <strong>Nori 프로젝트</strong>
            <span>참고할 문서 3개</span>
          </summary>
          <ul>
            <li>Nori 아키텍처</li>
            <li>UI/UX 가이드</li>
            <li>권한 정책</li>
          </ul>
          <p>프로젝트에 정리된 지식을 참고합니다.</p>
        </details>
        <form
          className={[
            styles.form,
            isChat ? `${composer.composer} ${styles.chatForm}` : '',
          ].join(' ')}
          onSubmit={(event: SubmitEvent<HTMLFormElement>): void =>
            event.preventDefault()
          }
        >
          {isChat && requestField}
          <section
            className={styles.templateSection}
            aria-label="사용할 템플릿"
          >
            <div className={styles.templateChoice}>
              <SelectField
                label="템플릿"
                value={selectedId}
                onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                  onSelect(event.target.value)
                }
              >
                {templates.map((template: SavedTemplate): JSX.Element => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </SelectField>
            </div>
            {selected ? (
              <div className={styles.selectedTemplate}>
                <div className={styles.file}>
                  <FileText size={20} aria-hidden="true" />
                  <strong>{selected.fileName}</strong>
                  <span>{templateFileType(selected.fileName)}</span>
                </div>
                <p>저장된 양식과 작성 룰을 함께 적용합니다.</p>
                <details className={styles.rules}>
                  <summary>적용할 작성 룰 {rules.length}개 보기</summary>
                  {rules.length > 0 ? (
                    <ol>
                      {rules.map((rule: string, index: number): JSX.Element => (
                        <li key={index}>{rule}</li>
                      ))}
                    </ol>
                  ) : (
                    <p>추가로 등록한 작성 룰이 없습니다.</p>
                  )}
                </details>
              </div>
            ) : (
              <p className={styles.muted}>먼저 템플릿을 등록해 주세요.</p>
            )}
          </section>
          {!isChat && requestField}
          <div className={styles.submit}>
            <p>모호하거나 충돌하는 내용은 작성 전에 질문합니다.</p>
            <Button
              type="button"
              disabled={!selected}
              onClick={(): void => {
                void form.handleSubmit(previewRequest)();
              }}
            >
              {isChat ? '보내기' : '산출물 만들기'}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </form>
        {submitted && (
          <section className={styles.result} aria-live="polite">
            <header>
              <h3>작성 요청 미리보기</h3>
              {changed && <span>이전 요청 기준</span>}
            </header>
            <p className={styles.request}>{submitted.request}</p>
            <dl>
              <dt>참고 지식</dt>
              <dd>Nori 프로젝트 문서 3개</dd>
              <dt>템플릿</dt>
              <dd>{submitted.template.name}</dd>
              <dt>양식 파일</dt>
              <dd>{submitted.template.fileName}</dd>
            </dl>
            <details className={styles.rules}>
              <summary>요청에 포함된 작성 룰 보기</summary>
              <p className={styles.preservedRules}>
                {submitted.template.rules || '추가 작성 룰 없음'}
              </p>
            </details>
            <p className={styles.muted}>시안에서는 파일을 생성하지 않습니다.</p>
          </section>
        )}
      </div>
    </section>
  );
}
