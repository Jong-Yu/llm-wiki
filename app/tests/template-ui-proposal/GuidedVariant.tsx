import { useState } from 'react';
import type { JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, ArrowRight, Check, FileText, Upload } from 'lucide-react';
import { Button } from '../../src/renderer/shared/ui/Button';
import { Field } from '../../src/renderer/shared/ui/Field';
import type { FieldControlProps } from '../../src/renderer/shared/ui/Field';
import { TextField } from '../../src/renderer/shared/ui/TextField';
import { ChatAnswer } from '../../src/renderer/features/chat-with-knowledge/ui/ChatAnswer';
import controls from '../../src/renderer/shared/ui/FieldControl.module.scss';
import {
  defaultTemplateAsset,
  TemplateAssetEditor,
  TemplateAssetPreview,
  templateAssetLabel,
} from './TemplateAsset';
import type { TemplateAsset } from './TemplateAsset';
import styles from './GuidedVariant.module.scss';

const headings = [
  '화면 개요',
  '레이아웃',
  '구성 요소',
  '동작 및 권한',
  '예외 상태',
];
const originalRules = [
  '원본의 배치와 고정 요소를 유지한다.',
  '각 동작의 근거 또는 미정 여부를 표시한다.',
  '잠긴 문서도 검토자는 수정할 수 있다.',
];
const schema = z.object({
  newName: z.string().trim().min(1, '템플릿 이름을 입력해 주세요.'),
  newBody: z.string().trim().min(1, '직접 정의할 양식을 입력해 주세요.'),
  rule1: z.string().trim().min(1, '작성 규칙을 입력해 주세요.'),
  rule2: z.string().trim().min(1, '작성 규칙을 입력해 주세요.'),
  rule3: z.string().trim().min(1, '작성 규칙을 입력해 주세요.'),
  question: z.string().trim().min(1, '작성할 문서를 요청해 주세요.'),
  requestRule: z.string(),
});
type Values = z.infer<typeof schema>;
type Policy = '' | 'source' | 'proposal' | 'unknown';
type Scope = '' | 'request' | 'new';
type Result = {
  name: string;
  policy: Policy;
  width: string;
  signature: string;
  asset: TemplateAsset;
};
const stepNames = ['양식', '작성 규칙', '자료·요청', '확인·결과'];
const tasks = [
  '문서의 기본 양식을 선택해 주세요.',
  '문서에 적용할 작성 규칙을 확인해 주세요.',
  '근거 자료와 이번 요청을 정리해 주세요.',
  '서로 다른 기준 두 가지를 확인해 주세요.',
];

/** 사용자 답변을 반영한 고정 예시이며 실제 문서를 생성하지 않습니다. */
function resultContent(result: Result, corrected: boolean): string {
  const chosenPolicy =
    result.policy === 'source'
      ? '잠긴 문서는 누구도 수정할 수 없습니다.'
      : '검토자 수정 허용을 변경안으로 제안합니다. 현행 원문은 누구도 수정할 수 없다고 정합니다.';
  return `# Nori 문서 상세 화면 설계서

## 1. 화면 개요
문서 내용을 읽고 근거를 확인하는 화면입니다. 사용한 양식: ${result.name}.

## 2. 레이아웃
제목과 상태 → 본문 → 속성 순서로 배치합니다. 상세 영역의 최대 너비는 **${result.width}px**이며 좁은 화면에서는 가용 폭을 사용합니다.

## 3. 구성 요소
| 요소 | 표시 내용 | 동작 |
| --- | --- | --- |
| 제목줄 | 제목 · 잠금 상태 | 이력 확인 |
| 본문 | Markdown · 근거 | 원문 읽기 |
| 속성 | 작성자 · 문서 상태 | 펼쳐 보기 |

구성 요소 영역의 최대 너비: **${corrected ? result.width : result.width === '640' ? '960' : '640'}px**.

## 4. 동작 및 권한
${chosenPolicy}

근거: Nori 아키텍처.md의 잠금 정책과 이번 확인 답변. 실제 원문·서버 권한은 변경하지 않습니다.

## 5. 예외 상태
로딩 시 본문 자리를 유지하고 접근 불가 시 목록으로 돌아갈 수 있게 안내합니다. 잠금 안내 문구는 “잠긴 문서는 수정할 수 없습니다.”로 제안합니다.

근거: UI·UX 가이드.md. 정확한 잠금 안내 문구는 원문에서 확인되지 않았습니다.`;
}

/** 단계별 초안과 답변을 유지하며 한 번에 하나의 작성 과정을 안내합니다. */
export function GuidedVariant(): JSX.Element {
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [mode, setMode] = useState<'saved' | 'new'>('saved');
  const [scope, setScope] = useState<Scope>('');
  const [policy, setPolicy] = useState<Policy>('');
  const [width, setWidth] = useState('');
  const [newAsset, setNewAsset] = useState<TemplateAsset>(defaultTemplateAsset);
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [corrected, setCorrected] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      newName: '',
      newBody: '',
      rule1: originalRules[0],
      rule2: originalRules[1],
      rule3: originalRules[2],
      question: '문서 상세 화면의 화면 설계서를 작성해 줘.',
      requestRule: '미정인 권한은 임의로 확정하지 않는다.',
    },
  });
  const values = useWatch({ control: form.control });
  const changedRules =
    values.rule1 !== originalRules[0] ||
    values.rule2 !== originalRules[1] ||
    values.rule3 !== originalRules[2];
  const asset = mode === 'new' ? newAsset : defaultTemplateAsset;
  const name = mode === 'new' ? values.newName || '새 템플릿' : '화면 설계서';
  const signature = JSON.stringify({
    values,
    mode,
    scope,
    policy,
    width,
    asset,
  });
  const stale = result !== null && result.signature !== signature;
  const ready =
    (policy === 'source' || policy === 'proposal') &&
    width !== '' &&
    asset.status === 'example';

  /** 직접 정의만 본문을 검사하며 파일·링크의 원본 상태는 따로 확인합니다. */
  async function validateTemplate(): Promise<boolean> {
    if (mode === 'saved') return true;
    return form.trigger(
      asset.kind === 'text' && asset.status === 'example'
        ? ['newName', 'newBody']
        : 'newName',
    );
  }

  /** 원본을 바꾸어도 작성한 직접 정의와 이름은 보존합니다. */
  function changeAsset(nextAsset: TemplateAsset): void {
    setNewAsset(nextAsset);
    if (!form.getValues('newName').trim()) {
      form.setValue('newName', nextAsset.name, { shouldDirty: true });
    }
  }

  /** 공통 편집기의 직접 정의 초안을 폼 검증과 연결합니다. */
  function changeText(text: string): void {
    form.setValue('newBody', text, { shouldDirty: true, shouldValidate: true });
  }

  /** 필요한 단계의 필드만 검증하며 이전 초안은 그대로 둡니다. */
  async function next(): Promise<void> {
    setNotice('');
    if (step === 0 && !(await validateTemplate())) return;
    if (step === 1 && !(await form.trigger(['rule1', 'rule2', 'rule3'])))
      return;
    if (step === 1 && mode === 'saved' && changedRules && scope === '') {
      setNotice('수정한 규칙을 어디에 적용할지 선택해 주세요.');
      return;
    }
    if (step === 2 && !(await form.trigger('question'))) return;
    setReached(Math.max(reached, step + 1));
    setStep(step + 1);
  }

  /** 모든 확인 답변이 정해진 경우에만 예시 결과로 이동합니다. */
  async function createResult(): Promise<void> {
    if (!ready) return;
    if (!(await validateTemplate())) {
      setStep(0);
      return;
    }
    if (!(await form.trigger(['rule1', 'rule2', 'rule3']))) {
      setStep(1);
      return;
    }
    if (mode === 'saved' && changedRules && scope === '') {
      setNotice('수정한 규칙을 어디에 적용할지 선택해 주세요.');
      setStep(1);
      return;
    }
    if (!(await form.trigger('question'))) {
      setStep(2);
      return;
    }
    setResult({
      name: mode === 'saved' && scope === 'new' ? '화면 설계서 사본' : name,
      policy,
      width,
      signature,
      asset,
    });
    setCorrected(false);
  }

  return (
    <div className={styles.root}>
      <header className={styles.heading}>
        <p className={styles.eyebrow}>단계별 작성</p>
        <h2>템플릿으로 문서 작성</h2>
        <p className={styles.muted}>
          양식부터 결과 확인까지, 필요한 내용을 차례로 정리합니다.
        </p>
      </header>
      <ol className={styles.steps} aria-label="문서 작성 단계">
        {stepNames.map((label: string, index: number): JSX.Element => (
          <li key={label}>
            <button
              type="button"
              disabled={index > reached}
              aria-current={step === index ? 'step' : undefined}
              aria-label={`${index + 1} ${label}${index < reached ? ' 완료' : ''}`}
              onClick={(): void => {
                setStep(index);
                setNotice('');
              }}
            >
              <span className={styles.number}>{index + 1}</span>
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ol>
      <section
        className={styles.work}
        aria-label={`${step + 1}단계 ${stepNames[step]}`}
      >
        <div className={styles.current}>
          <span>{step + 1} / 4</span>
          <h3>{tasks[step]}</h3>
        </div>
        {step === 0 && (
          <>
            <div className={styles.choices} aria-label="양식 준비 방법">
              <button
                className={styles.choice}
                type="button"
                aria-pressed={mode === 'saved'}
                onClick={(): void => {
                  setMode('saved');
                }}
              >
                <FileText size={18} aria-hidden="true" />
                <strong>저장된 템플릿 사용</strong>
                <span>기존 양식과 작성 규칙을 가져옵니다.</span>
              </button>
              <button
                className={styles.choice}
                type="button"
                aria-pressed={mode === 'new'}
                onClick={(): void => {
                  setMode('new');
                }}
              >
                <Upload size={18} aria-hidden="true" />
                <strong>새 템플릿 등록</strong>
                <span>반복 사용할 양식을 직접 준비합니다.</span>
              </button>
            </div>
            {mode === 'saved' ? (
              <>
                <div className={styles.selected}>
                  <span className={styles.muted}>선택한 템플릿</span>
                  <Button
                    type="button"
                    variant="surface"
                    aria-pressed="true"
                    onClick={(): void => {
                      setNotice(`${asset.name} 예시가 선택되어 있습니다.`);
                    }}
                  >
                    {asset.name} <Check size={14} aria-hidden="true" />
                  </Button>
                  <span className={styles.muted}>
                    {templateAssetLabel(asset)} · 작성 규칙 3개
                  </span>
                </div>
                <TemplateAssetPreview value={asset} />
                <details className={styles.structure}>
                  <summary>양식에 담긴 내용 구성</summary>
                  <ol>
                    {headings.map((heading: string): JSX.Element => (
                      <li key={heading}>{heading}</li>
                    ))}
                  </ol>
                </details>
              </>
            ) : (
              <div className={styles.fields}>
                <TextField
                  label="템플릿 이름"
                  required
                  {...form.register('newName')}
                  error={form.formState.errors.newName?.message}
                />
                <TemplateAssetEditor
                  value={newAsset}
                  onChange={changeAsset}
                  text={values.newBody || ''}
                  onText={changeText}
                  error={
                    asset.kind === 'text' && asset.status === 'example'
                      ? form.formState.errors.newBody?.message
                      : undefined
                  }
                />
              </div>
            )}
          </>
        )}
        {step === 1 && (
          <>
            <p className={styles.muted}>
              양식과 함께 보관할 규칙입니다. 이번 요청에만 필요한 조건은 다음
              단계에서 적습니다.
            </p>
            <div className={styles.fields}>
              <Field
                label="규칙 1"
                error={form.formState.errors.rule1?.message}
              >
                {(props: FieldControlProps): JSX.Element => (
                  <textarea
                    {...props}
                    {...form.register('rule1')}
                    className={controls.control}
                    rows={2}
                  />
                )}
              </Field>
              <Field
                label="규칙 2"
                error={form.formState.errors.rule2?.message}
              >
                {(props: FieldControlProps): JSX.Element => (
                  <textarea
                    {...props}
                    {...form.register('rule2')}
                    className={controls.control}
                    rows={2}
                  />
                )}
              </Field>
              <Field
                label="규칙 3"
                error={form.formState.errors.rule3?.message}
              >
                {(props: FieldControlProps): JSX.Element => (
                  <textarea
                    {...props}
                    {...form.register('rule3')}
                    className={controls.control}
                    rows={2}
                  />
                )}
              </Field>
            </div>
            {mode === 'saved' && (
              <div className={styles.scope}>
                <h3>규칙을 수정했다면</h3>
                <p className={styles.muted}>
                  원래의 ‘화면 설계서’ 템플릿은 유지됩니다.
                </p>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="surface"
                    aria-pressed={scope === 'request'}
                    onClick={(): void => {
                      setScope('request');
                      setNotice('');
                    }}
                  >
                    이번 요청만
                  </Button>
                  <Button
                    type="button"
                    variant="surface"
                    aria-pressed={scope === 'new'}
                    onClick={(): void => {
                      setScope('new');
                      setNotice('');
                    }}
                  >
                    새 템플릿으로 저장
                  </Button>
                </div>
                {scope === 'new' && (
                  <p className={styles.muted}>
                    ‘화면 설계서 사본’으로 저장하는 모의 흐름입니다.
                  </p>
                )}
                {scope === 'request' && (
                  <p className={styles.muted}>
                    변경한 규칙은 이번 결과에만 사용합니다.
                  </p>
                )}
              </div>
            )}
            {mode === 'new' && (
              <p className={styles.muted}>
                ‘{name}’에 양식과 작성 규칙 3개를 함께 저장하는 모의 흐름입니다.
              </p>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <div className={styles.sources}>
              <h3>근거 자료</h3>
              <div className={styles.chips}>
                <span>
                  <FileText size={14} aria-hidden="true" />
                  Nori 아키텍처.md
                </span>
                <span>
                  <FileText size={14} aria-hidden="true" />
                  UI·UX 가이드.md
                </span>
              </div>
              <p className={styles.muted}>
                이미 추출된 원문을 사용하는 예시 자료 2개
              </p>
            </div>
            <div className={styles.fields}>
              <Field
                label="작성 요청"
                required
                error={form.formState.errors.question?.message}
              >
                {(props: FieldControlProps): JSX.Element => (
                  <textarea
                    {...props}
                    {...form.register('question')}
                    className={controls.control}
                    rows={3}
                  />
                )}
              </Field>
              <Field
                label="이번 요청에만 추가할 규칙"
                description="템플릿에 저장되지 않습니다."
              >
                {(props: FieldControlProps): JSX.Element => (
                  <textarea
                    {...props}
                    {...form.register('requestRule')}
                    className={controls.control}
                    rows={2}
                  />
                )}
              </Field>
            </div>
            <div className={styles.preview}>
              <h3>시작 전 요약</h3>
              <dl>
                <div>
                  <dt>양식</dt>
                  <dd>{name}</dd>
                </div>
                <div>
                  <dt>원본</dt>
                  <dd>
                    {asset.name} · {templateAssetLabel(asset)}
                  </dd>
                </div>
                <div>
                  <dt>결과 형식</dt>
                  <dd>{asset.output}</dd>
                </div>
                <div>
                  <dt>작성 방식</dt>
                  <dd>
                    {asset.mode === 'fill'
                      ? '원본 양식에 채우기'
                      : asset.mode === 'structure'
                        ? '구조를 따라 작성'
                        : '참고 자료로 사용'}
                  </dd>
                </div>
                <div>
                  <dt>작성 규칙</dt>
                  <dd>
                    3개
                    {changedRules
                      ? scope === 'new'
                        ? ' · 새 템플릿 사본'
                        : ' · 이번 요청에 수정 적용'
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt>자료</dt>
                  <dd>원문 2개</dd>
                </div>
                <div>
                  <dt>추가 규칙</dt>
                  <dd>{values.requestRule || '없음'}</dd>
                </div>
              </dl>
            </div>
          </>
        )}
        {step === 3 && (
          <>
            {asset.status === 'unverified' && (
              <p className={styles.attention} role="status">
                선택한 원본은 확인이 필요합니다. 파일·링크 분석이 연결되지 않아
                결과 작성을 기다립니다. 1단계에서 예시 양식을 선택하면 흐름을
                체험할 수 있습니다.
              </p>
            )}
            <div className={styles.question}>
              <h3>1. 잠긴 문서의 수정 권한</h3>
              <p>
                <strong>원문</strong> · 잠긴 문서는 누구도 수정할 수 없습니다.
              </p>
              <p>
                <strong>작성 규칙</strong> · {values.rule3}
              </p>
              <p className={styles.muted}>
                이번 예시에서 원문과 규칙을 비교합니다. 변경안을 골라도 실제
                권한은 바뀌지 않습니다.
              </p>
              <div className={styles.answers}>
                <Button
                  type="button"
                  variant="surface"
                  aria-pressed={policy === 'source'}
                  onClick={(): void => {
                    setPolicy('source');
                  }}
                >
                  원문 기준 유지
                </Button>
                <Button
                  type="button"
                  variant="surface"
                  aria-pressed={policy === 'proposal'}
                  onClick={(): void => {
                    setPolicy('proposal');
                  }}
                >
                  검토자 허용을 변경안으로
                </Button>
                <Button
                  type="button"
                  variant="surface"
                  aria-pressed={policy === 'unknown'}
                  onClick={(): void => {
                    setPolicy('unknown');
                  }}
                >
                  권한 미정
                </Button>
              </div>
              {policy === 'unknown' && (
                <p className={styles.attention} role="status">
                  권한 답변을 기다립니다. 원문 기준이나 변경안이 정해지면 결과를
                  작성할 수 있습니다.
                </p>
              )}
            </div>
            <div className={styles.question}>
              <h3>2. 상세 영역의 최대 너비</h3>
              <p className={styles.muted}>
                Nori 아키텍처에는 640px, UI·UX 가이드에는 960px로 적혀 있습니다.
                이번 문서에 쓸 너비를 골라 주세요.
              </p>
              <div className={styles.actions}>
                <Button
                  type="button"
                  variant="surface"
                  aria-pressed={width === '640'}
                  onClick={(): void => {
                    setWidth('640');
                  }}
                >
                  640px
                </Button>
                <Button
                  type="button"
                  variant="surface"
                  aria-pressed={width === '960'}
                  onClick={(): void => {
                    setWidth('960');
                  }}
                >
                  960px
                </Button>
              </div>
            </div>
            {result && (
              <div className={styles.result}>
                <h3>내용 검토용 초안과 검사</h3>
                <TemplateAssetPreview value={result.asset} compact />
                <p className={styles.muted}>
                  {result.asset.output} 파일 생성 미연결 · 아래는 내용을
                  검토하기 위한 예시 초안입니다.
                </p>
                {stale && (
                  <p className={styles.attention}>
                    입력 또는 답변이 바뀌었습니다. 아래 결과는 이전 답변
                    기준이며 다시 작성할 수 있습니다.
                  </p>
                )}
                <div className={styles.checks}>
                  <span>초안 항목 확인</span>
                  <span>내용 확인 필요 {corrected ? 0 : 1}</span>
                  <span>원문 대조 검사 불가 1</span>
                  <span>파일 서식 검사 미실행</span>
                </div>
                <details>
                  <summary>검사 세부 내용</summary>
                  <ul>
                    <li>
                      초안: 내용 항목 5개와 구성 요소 표의 내용을 확인하는
                      예시입니다.
                    </li>
                    <li>
                      파일 서식: 원본 배치·고정 요소·서식 보존은 검사하지
                      않았습니다.
                    </li>
                    <li>
                      {corrected
                        ? `내용: 상세 영역과 구성 요소의 너비를 ${result.width}px로 맞췄습니다.`
                        : '내용: 레이아웃과 구성 요소 설명의 너비가 서로 다릅니다.'}
                    </li>
                    <li>
                      검사 불가: 제안한 잠금 안내 문구의 정확한 표현이 원문에
                      없습니다. 사람의 확인이 필요합니다.
                    </li>
                  </ul>
                </details>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={corrected || stale}
                  onClick={(): void => {
                    setCorrected(true);
                  }}
                >
                  수정하고 재검사
                </Button>
                <ChatAnswer content={resultContent(result, corrected)} />
              </div>
            )}
          </>
        )}
      </section>
      {notice && (
        <p className={styles.attention} role="status">
          {notice}
        </p>
      )}
      <footer className={styles.footer}>
        <div>
          {step > 0 && (
            <Button
              type="button"
              variant="secondary"
              onClick={(): void => {
                setStep(step - 1);
                setNotice('');
              }}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              이전
            </Button>
          )}
        </div>
        <span className={styles.muted}>
          {step === 3
            ? asset.status === 'unverified'
              ? '원본 확인 필요 · 예시 결과 작성 대기'
              : ready
                ? '필수 답변 2개가 정해졌습니다.'
                : `답변 ${Number(policy === 'source' || policy === 'proposal') + Number(width !== '')} / 2 · 확인이 필요합니다.`
            : '이전 단계로 돌아가도 입력은 유지됩니다.'}
        </span>
        {step < 3 ? (
          <Button
            type="button"
            onClick={(): void => {
              void next();
            }}
          >
            다음 <ArrowRight size={14} aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            disabled={!ready}
            onClick={(): void => {
              void createResult();
            }}
          >
            예시 결과 작성
          </Button>
        )}
      </footer>
    </div>
  );
}
