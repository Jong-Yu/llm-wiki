import { useRef, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  ArrowLeft,
  Check,
  FileText,
  Plus,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '../../src/renderer/shared/ui/Button';
import { Field } from '../../src/renderer/shared/ui/Field';
import type { FieldControlProps } from '../../src/renderer/shared/ui/Field';
import { TextField } from '../../src/renderer/shared/ui/TextField';
import { ChatAnswer } from '../../src/renderer/features/chat-with-knowledge/ui/ChatAnswer';
import styles from './GalleryVariant.module.scss';
import {
  TemplateAssetEditor,
  TemplateAssetPreview,
  defaultTemplateAsset,
  templateAssetLabel,
} from './TemplateAsset';
import type { TemplateAsset } from './TemplateAsset';

const templateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '이름을 입력해 주세요.')
    .max(60, '60자 이내로 입력해 주세요.'),
  body: z.string().trim().min(1, '템플릿을 선택하거나 직접 정의해 주세요.'),
  rule1: z.string(),
  rule2: z.string(),
  rule3: z.string(),
});
const requestSchema = z.object({
  question: z.string().trim().min(1, '요청 내용을 입력해 주세요.'),
  rule: z.string(),
});
type TemplateValues = z.infer<typeof templateSchema>;
type RequestValues = z.infer<typeof requestSchema>;
type Template = TemplateValues & {
  id: string;
  description: string;
  asset: TemplateAsset;
};
type Surface = 'gallery' | 'edit' | 'request' | 'questions' | 'result';
type Policy = '' | 'current' | 'proposed' | 'pending';
type Width = '' | '640' | '960' | 'pending';
type Result = {
  policy: 'current' | 'proposed';
  width: '640' | '960';
  request: RequestValues;
  template: string;
  asset: TemplateAsset;
};
const exampleBody =
  '# 화면 설계서\n\n## 1. 화면 개요\n화면의 목적과 사용자를 설명합니다.\n\n## 2. 레이아웃\n영역의 배치와 크기를 정의합니다.\n\n## 3. 구성 요소\n| 요소 | 표시 내용 | 동작 |\n| --- | --- | --- |\n\n## 4. 동작 및 권한\n행동별 권한과 근거를 작성합니다.\n\n## 5. 예외 상태\n로딩, 접근 불가, 잠금, 오류를 정의합니다.';
const example: Template = {
  id: 'screen-spec',
  name: '화면 설계서',
  description: '화면의 구조·동작·권한·예외 상태',
  body: exampleBody,
  asset: defaultTemplateAsset,
  rule1: '로고와 고정 배치를 유지하고 지정한 영역에만 작성한다.',
  rule2: '각 동작의 근거 또는 미정 여부를 표시한다.',
  rule3: '잠긴 문서도 검토자는 수정할 수 있다.',
};
const initialTemplates: Template[] = [
  example,
  {
    id: 'feature-spec',
    name: '기능 명세서',
    description: '기능의 목적·입출력·처리 조건',
    asset: {
      kind: 'document',
      name: '기능명세서.docx',
      output: 'DOCX',
      mode: 'fill',
      status: 'example',
    },
    body: '# 기능 명세서\n\n## 1. 목적\n기능의 사용자와 해결할 문제\n\n## 2. 입출력\n| 입력 | 출력 | 제약 |\n| --- | --- | --- |\n\n## 3. 처리 흐름\n정상 흐름과 실패 흐름\n\n## 4. 확인할 사항\n미정 항목과 질문',
    rule1: '입력과 출력을 구분한다.',
    rule2: '근거 없는 동작은 미정으로 표시한다.',
    rule3: '',
  },
  {
    id: 'review-report',
    name: '검토 체크리스트',
    description: '검토 대상·근거·차이·후속 질문',
    asset: {
      kind: 'sheet',
      name: '검토체크리스트.xlsx',
      output: 'XLSX',
      mode: 'fill',
      status: 'example',
    },
    body: '# 검토 보고서\n\n## 1. 검토 범위\n대상과 기준\n\n## 2. 발견 사항\n| 항목 | 근거 | 판단 |\n| --- | --- | --- |\n\n## 3. 확인할 사항\n추가로 확인할 근거와 질문',
    rule1: '사실과 검토 의견을 구분한다.',
    rule2: '확인할 수 없는 항목을 남긴다.',
    rule3: '',
  },
];
/** 새 등록은 저장된 예시와 별개의 빈 입력에서 시작합니다. */
function emptyTemplate(): TemplateValues {
  return {
    name: '',
    body: `원본 양식: ${defaultTemplateAsset.name}`,
    rule1: '',
    rule2: '',
    rule3: '',
  };
}
/** 확인한 값만 고정 Nori 예시에 반영하며 검사할 불일치 한 곳을 남깁니다. */
function resultBody(result: Result, corrected: boolean): string {
  return `# Nori 문서 상세 화면 설계서

## 1. 화면 개요
문서 내용을 읽고 편집 또는 검토로 이어지는 화면입니다. 일반 사용자와 검토자가 사용합니다.

## 2. 레이아웃
제목과 상태 → 본문 / 속성 → 관련 문서 순서로 배치합니다. 상세 영역은 **${result.width}px**이며 좁은 화면에서는 가용 폭을 사용합니다.

근거: 이번 확인 질문의 사용자 답변.

## 3. 구성 요소
| 요소 | 표시 내용 | 동작 |
| --- | --- | --- |
| 제목줄 | 문서 제목·잠금 상태 | 이력으로 이동 |
| 본문 | Markdown·근거 | 읽기·근거 확인 |
| 속성 | 작성자·문서 상태 | 좁은 화면에서 본문 뒤에 표시 |

본문 최대 너비는 ${corrected ? result.width : result.width === '640' ? '960' : '640'}px입니다.

## 4. 동작 및 권한
${result.policy === 'current' ? '잠긴 문서는 검토자를 포함한 모든 사용자에게 편집을 차단합니다. 템플릿의 검토자 예외는 이번 요청에 적용하지 않았습니다.' : '변경안: 잠긴 문서도 검토자에게 편집을 허용합니다. 현재 서버는 검토자에게도 HTTP 423을 반환하므로 구현 전 정책·서버 변경 검토가 필요합니다.'}

근거: Nori 아키텍처의 잠금 정책 + 이번 사용자 답변.

## 5. 예외 상태
| 상태 | 화면 처리 | 근거 |
| --- | --- | --- |
| 불러오는 중 | 제목·본문 위치를 유지 | UI·UX 가이드 |
| 접근 불가 | 이유와 목록 복귀 제공 | Nori 아키텍처 |
| 잠긴 문서 | “잠긴 문서는 수정할 수 없습니다.” 안내 | 정확한 문구는 원문에 없음 |

시안의 고정 예시 결과입니다. 선택한 임의 양식과 요청을 AI가 생성·검사한 결과가 아닙니다.`;
}

/** 템플릿 탐색과 양식 확인을 먼저 하는 보관함 중심의 인터랙티브 시안입니다. */
export function GalleryVariant(): JSX.Element {
  const [surface, setSurface] = useState<Surface>('gallery');
  const [templates, setTemplates] = useState<Template[]>(initialTemplates);
  const [selectedId, setSelectedId] = useState(example.id);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [policy, setPolicy] = useState<Policy>('');
  const [width, setWidth] = useState<Width>('');
  const [result, setResult] = useState<Result | null>(null);
  const [corrected, setCorrected] = useState(false);
  const drafts = useRef(new Map<string, TemplateValues>());
  const assetDrafts = useRef(new Map<string, TemplateAsset>());
  const [asset, setAsset] = useState<TemplateAsset>(defaultTemplateAsset);
  const selected =
    templates.find((item: Template): boolean => item.id === selectedId) ??
    example;
  const templateForm = useForm<TemplateValues>({
    resolver: zodResolver(templateSchema),
    defaultValues: emptyTemplate(),
  });
  const body = useWatch({ control: templateForm.control, name: 'body' });
  const requestForm = useForm<RequestValues>({
    resolver: zodResolver(requestSchema),
    defaultValues: {
      question: 'Nori 문서 상세 화면의 화면 설계서를 작성해 줘.',
      rule: '',
    },
  });
  const visible = templates.filter((item: Template): boolean =>
    item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  /** 대상별 편집 초안을 유지하여 보관함 왕복으로 입력을 잃지 않습니다. */
  function openEditor(template: Template | null): void {
    const key = template?.id ?? 'new';
    setEditingId(template?.id ?? null);
    templateForm.reset(drafts.current.get(key) ?? template ?? emptyTemplate());
    setAsset(
      assetDrafts.current.get(key) ?? template?.asset ?? defaultTemplateAsset,
    );
    setNotice('');
    setSurface('edit');
  }
  /** 저장은 시안 메모리에만 반영합니다. */
  function saveTemplate(values: TemplateValues): void {
    const id = editingId ?? `personal-${Date.now()}`;
    const next = {
      ...values,
      id,
      asset: { ...asset },
      description:
        asset.status === 'example'
          ? '직접 등록한 개인 양식 · 예시'
          : '파일 내용 확인 전',
    };
    setTemplates((current: Template[]): Template[] =>
      editingId
        ? current.map((item: Template): Template =>
            item.id === id ? next : item,
          )
        : [...current, next],
    );
    drafts.current.delete(editingId ?? 'new');
    assetDrafts.current.delete(editingId ?? 'new');
    setSelectedId(id);
    setSearch('');
    setNotice('개인 템플릿을 시안 메모리에 저장했습니다.');
    setSurface('gallery');
  }
  /** 미확정 답변은 임의로 채우지 않고 확인 질문에 머무릅니다. */
  function showResult(): void {
    if (selected.asset.status === 'unverified') {
      setNotice(
        '원본 내용과 작성 위치를 먼저 확인해야 합니다. 실제 파일·링크의 분석은 시안에 연결되지 않았습니다.',
      );
      return;
    }
    if (
      (policy !== 'current' && policy !== 'proposed') ||
      (width !== '640' && width !== '960')
    ) {
      setNotice(
        '아직 확정되지 않은 답변이 있습니다. 선택할 때까지 작성을 기다립니다.',
      );
      return;
    }
    setResult({
      policy,
      width,
      request: requestForm.getValues(),
      template: selected.name,
      asset: { ...selected.asset },
    });
    setCorrected(false);
    setNotice('');
    setSurface('result');
  }
  /** 입력면을 떠날 때 현재 초안을 보관합니다. */
  function backToGallery(): void {
    if (surface === 'edit') {
      drafts.current.set(editingId ?? 'new', templateForm.getValues());
      assetDrafts.current.set(editingId ?? 'new', asset);
    }
    setNotice('');
    setSurface('gallery');
  }
  return (
    <section className={styles.root} aria-label="템플릿 보관함 시안">
      {surface === 'gallery' ? (
        <>
          <header className={styles.header}>
            <div>
              <h2>템플릿 보관함</h2>
              <p>양식과 규칙을 살펴보고 작성을 시작하세요.</p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={(): void => openEditor(null)}
            >
              <Plus size={16} />새 템플릿 등록
            </Button>
          </header>
          <div className={styles.gallery}>
            <aside className={styles.library} aria-label="내 템플릿 목록">
              <div className={styles.search}>
                <Search size={16} />
                <TextField
                  label="이름 검색"
                  value={search}
                  onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                    setSearch(event.target.value)
                  }
                />
              </div>
              <p className={styles.muted}>
                내 템플릿 · {visible.length}개 · 시안 예시
              </p>
              <div className={styles.items}>
                {visible.map((item: Template): JSX.Element => (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.item}
                    aria-pressed={selectedId === item.id}
                    onClick={(): void => {
                      setSelectedId(item.id);
                      setNotice('');
                    }}
                  >
                    <FileText size={16} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{templateAssetLabel(item.asset)} · 개인</small>
                      <small>{item.description}</small>
                    </span>
                    {selectedId === item.id && <Check size={16} />}
                  </button>
                ))}
              </div>
              {visible.length === 0 && <p>일치하는 이름이 없습니다.</p>}
            </aside>
            <article className={styles.detail}>
              <header className={styles.detailHeader}>
                <div>
                  <span className={styles.muted}>
                    개인 템플릿 · {templateAssetLabel(selected.asset)}
                  </span>
                  <h3>{selected.name}</h3>
                </div>
                <Button
                  type="button"
                  variant="surface"
                  onClick={(): void => openEditor(selected)}
                >
                  편집
                </Button>
              </header>
              <Button
                type="button"
                disabled={selected.asset.status === 'unverified'}
                onClick={(): void => {
                  setNotice('');
                  setSurface('request');
                }}
              >
                이 템플릿으로 작성
              </Button>
              <p className={styles.muted}>
                결과 형식 {selected.asset.output} ·{' '}
                {selected.asset.mode === 'fill'
                  ? '지정 영역 채우기'
                  : selected.asset.mode === 'structure'
                    ? '구조를 따라 새로 작성'
                    : '참고하여 재구성'}
              </p>
              {selected.asset.status === 'unverified' && (
                <p role="status">
                  내용 확인 전 · 원본 파일·링크의 분석은 시안에 연결되지
                  않았습니다. 편집에서 예시 양식을 선택해 흐름을 살펴볼 수
                  있습니다.
                </p>
              )}
              <section className={styles.section}>
                <h3>원본 양식</h3>
                <div className={styles.preview}>
                  <TemplateAssetPreview value={selected.asset} compact />
                  {selected.asset.kind === 'text' && (
                    <details>
                      <summary>직접 정의한 내용</summary>
                      <pre>{selected.body}</pre>
                    </details>
                  )}
                </div>
              </section>
              <section className={styles.section}>
                <h3>작성 규칙</h3>
                <ol>
                  {[selected.rule1, selected.rule2, selected.rule3]
                    .filter(Boolean)
                    .map((rule: string, index: number): JSX.Element => (
                      <li key={index}>{rule}</li>
                    ))}
                </ol>
              </section>
            </article>
          </div>
        </>
      ) : (
        <div className={styles.workspace}>
          <Button
            type="button"
            variant="surface"
            className={styles.back}
            onClick={backToGallery}
          >
            <ArrowLeft size={16} />
            보관함으로
          </Button>
          {surface === 'edit' ? (
            <>
              <header className={styles.header}>
                <div>
                  <h2>{editingId ? '템플릿 편집' : '새 템플릿 등록'}</h2>
                  <p>반복할 양식과 작성할 때 지킬 기준을 나누어 입력하세요.</p>
                </div>
              </header>
              <form className={styles.form}>
                <TextField
                  label="이름"
                  required
                  {...templateForm.register('name')}
                  error={templateForm.formState.errors.name?.message}
                />
                <TemplateAssetEditor
                  value={asset}
                  text={body}
                  error={templateForm.formState.errors.body?.message}
                  onText={(text: string): void =>
                    templateForm.setValue('body', text, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                  onChange={(next: TemplateAsset): void => {
                    setAsset(next);
                    templateForm.setValue(
                      'body',
                      next.kind === 'text' && next.status === 'example'
                        ? asset.kind === 'text' && asset.status === 'example'
                          ? body
                          : ''
                        : `원본 양식: ${next.name}`,
                      { shouldDirty: true, shouldValidate: true },
                    );
                  }}
                />
                <div className={styles.actions}>
                  <span className={styles.muted}>
                    작성 규칙은 파일 형식과 별도로 설정합니다.
                  </span>
                  <Button
                    type="button"
                    variant="surface"
                    onClick={(): void => {
                      templateForm.setValue('rule1', example.rule1);
                      templateForm.setValue('rule2', example.rule2);
                      templateForm.setValue('rule3', example.rule3);
                    }}
                  >
                    예시 작성 규칙 불러오기
                  </Button>
                </div>
                <h3>작성 규칙</h3>
                <Field label="규칙 1">
                  {(props: FieldControlProps): JSX.Element => (
                    <textarea
                      {...props}
                      {...templateForm.register('rule1')}
                      rows={2}
                    />
                  )}
                </Field>
                <Field label="규칙 2">
                  {(props: FieldControlProps): JSX.Element => (
                    <textarea
                      {...props}
                      {...templateForm.register('rule2')}
                      rows={2}
                    />
                  )}
                </Field>
                <Field label="규칙 3">
                  {(props: FieldControlProps): JSX.Element => (
                    <textarea
                      {...props}
                      {...templateForm.register('rule3')}
                      rows={2}
                    />
                  )}
                </Field>
                <div className={styles.actions}>
                  <span className={styles.muted}>
                    돌아가도 입력 중인 초안은 유지됩니다.
                  </span>
                  <Button
                    type="button"
                    onClick={(): void => {
                      void templateForm.handleSubmit(saveTemplate)();
                    }}
                  >
                    개인 템플릿 저장
                  </Button>
                </div>
              </form>
            </>
          ) : surface === 'request' ? (
            <>
              <header className={styles.header}>
                <div>
                  <h2>{selected.name}로 작성</h2>
                  <p>이번 요청에 사용할 자료와 추가 규칙을 정하세요.</p>
                  <p>
                    템플릿 {selected.asset.name} → 결과 형식{' '}
                    {selected.asset.output}
                  </p>
                </div>
              </header>
              <div className={styles.form}>
                <section>
                  <h3>원문 · 예시</h3>
                  <div className={styles.sources}>
                    <span>
                      <FileText size={16} />
                      Nori 아키텍처.md
                    </span>
                    <span>
                      <FileText size={16} />
                      UI·UX 가이드.md
                    </span>
                  </div>
                </section>
                <Field
                  label="요청 내용"
                  required
                  error={requestForm.formState.errors.question?.message}
                >
                  {(props: FieldControlProps): JSX.Element => (
                    <textarea
                      {...props}
                      {...requestForm.register('question')}
                      rows={4}
                    />
                  )}
                </Field>
                <Field
                  label="이번 요청의 작성 규칙"
                  description="이 요청에만 사용하며 저장된 템플릿은 바꾸지 않습니다."
                >
                  {(props: FieldControlProps): JSX.Element => (
                    <textarea
                      {...props}
                      {...requestForm.register('rule')}
                      rows={3}
                      placeholder="예: 모바일에서의 배치를 함께 설명해 줘."
                    />
                  )}
                </Field>
                <p className={styles.muted}>
                  작성·검사는 Nori 화면 설계서의 고정 예시로 체험합니다.
                </p>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={(): void => openEditor(selected)}
                  >
                    양식·규칙 편집
                  </Button>
                  <Button
                    type="button"
                    onClick={(): void => {
                      void requestForm.handleSubmit((): void => {
                        setNotice('');
                        setSurface('questions');
                      })();
                    }}
                  >
                    작성 전 확인
                  </Button>
                </div>
              </div>
            </>
          ) : surface === 'questions' ? (
            <>
              <header className={styles.header}>
                <div>
                  <h2>두 가지만 확인할게요</h2>
                  <p>서로 다른 정책과 미정인 너비를 먼저 정합니다.</p>
                </div>
              </header>
              <div className={styles.form}>
                <fieldset>
                  <legend>1. 잠긴 문서의 편집 기준</legend>
                  <p>
                    Nori 예시 원문은 모든 사용자의 편집을 막고 HTTP 423을
                    반환합니다. 화면 설계서의 예시 규칙은 검토자에게 편집을
                    허용합니다.
                  </p>
                  <label>
                    <input
                      type="radio"
                      name="gallery-policy"
                      checked={policy === 'current'}
                      onChange={(): void => setPolicy('current')}
                    />
                    현행 정책 유지 · 검토자도 편집 차단
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="gallery-policy"
                      checked={policy === 'proposed'}
                      onChange={(): void => setPolicy('proposed')}
                    />
                    검토자 예외를 변경안으로 작성
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="gallery-policy"
                      checked={policy === 'pending'}
                      onChange={(): void => setPolicy('pending')}
                    />
                    아직 정하지 못했어요
                  </label>
                </fieldset>
                <fieldset>
                  <legend>2. 문서 상세 영역 너비</legend>
                  <p>
                    원문에 너비가 정해져 있지 않습니다. 시안에서 사용할 값을
                    골라 주세요.
                  </p>
                  <label>
                    <input
                      type="radio"
                      name="gallery-width"
                      checked={width === '640'}
                      onChange={(): void => setWidth('640')}
                    />
                    640px · 읽기에 집중
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="gallery-width"
                      checked={width === '960'}
                      onChange={(): void => setWidth('960')}
                    />
                    960px · 표와 속성을 함께 보기
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="gallery-width"
                      checked={width === 'pending'}
                      onChange={(): void => setWidth('pending')}
                    />
                    아직 정하지 못했어요
                  </label>
                </fieldset>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={(): void => {
                      setNotice('');
                      setSurface('request');
                    }}
                  >
                    요청 수정
                  </Button>
                  <Button type="button" onClick={showResult}>
                    답변으로 예시 확인
                  </Button>
                </div>
              </div>
            </>
          ) : result ? (
            <>
              <header className={styles.header}>
                <div>
                  <h2>내용 검토용 초안 · 예시</h2>
                  <p>{result.template} 선택으로 시작한 Nori 고정 예시입니다.</p>
                  <p>
                    {result.asset.output} 파일 생성은 미연결입니다. 아래 내용이
                    원본 파일에 반영된 것은 아닙니다.
                  </p>
                </div>
              </header>
              <section
                className={styles.inspection}
                aria-label="예시 검사 결과"
              >
                <h3>검사 결과</h3>
                <div className={styles.statuses}>
                  <span>
                    <Check size={16} />
                    내용 구조 예시 확인
                  </span>
                  <span>
                    <TriangleAlert size={16} />
                    {corrected ? '내용 자동 검사 통과' : '내용 1개 확인 필요'}
                  </span>
                  <span>원문 검사 불가 1개</span>
                  <span>파일 서식 검사 미실행</span>
                </div>
                <details>
                  <summary>검사 상세</summary>
                  <p>
                    내용 구조만 예시로 확인합니다. 슬라이드 배치·문서 서식·셀
                    수식 등 파일 형식별 보존 검사는 아직 실행하지 않았습니다.
                  </p>
                  <p>
                    {corrected
                      ? `너비를 ${result.width}px로 통일했습니다.`
                      : `확인한 ${result.width}px와 구성 요소 설명의 너비가 다릅니다.`}
                  </p>
                  <p>
                    검사 불가: 잠금 안내의 정확한 문구가 원문에 없어 확인할 수
                    없습니다. 너비를 고쳐도 이 항목은 남습니다.
                  </p>
                </details>
                {!corrected && (
                  <Button
                    type="button"
                    onClick={(): void => setCorrected(true)}
                  >
                    너비 수정 후 다시 검사
                  </Button>
                )}
              </section>
              <details className={styles.requestSummary}>
                <summary>이번 요청 확인</summary>
                <p>{result.request.question}</p>
                <p>추가 규칙: {result.request.rule || '없음'}</p>
                <p>저장된 템플릿의 규칙은 유지됩니다.</p>
                <p>
                  원본 {result.asset.name} · 결과 형식 {result.asset.output}
                </p>
              </details>
              <details>
                <summary>사용한 원본 양식 보기</summary>
                <TemplateAssetPreview value={result.asset} compact />
              </details>
              <ChatAnswer content={resultBody(result, corrected)} />
            </>
          ) : null}
        </div>
      )}
      <p className={styles.notice} role="status">
        {notice}
      </p>
    </section>
  );
}
