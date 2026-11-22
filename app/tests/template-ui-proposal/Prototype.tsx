import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent, SubmitEvent } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  Globe,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from '../../src/renderer/shared/ui/Button';
import { Field } from '../../src/renderer/shared/ui/Field';
import type { FieldControlProps } from '../../src/renderer/shared/ui/Field';
import { TextField } from '../../src/renderer/shared/ui/TextField';
import { ChatAnswer } from '../../src/renderer/features/chat-with-knowledge/ui/ChatAnswer';
import { ChatHistoryPanel } from '../../src/renderer/features/chat-with-knowledge/ui/ChatHistoryPanel';
import { ComposerMenu } from '../../src/renderer/features/chat-with-knowledge/ui/ComposerMenu';
import { aiModelOptions } from '../../src/renderer/features/chat-with-knowledge/model/aiModelOptions';
import { ANSWER_TEMPLATES } from '../../src/renderer/features/chat-with-knowledge/model/answerTemplates';
import chat from '../../src/renderer/features/chat-with-knowledge/ui/KnowledgeChat.module.scss';
import composer from '../../src/renderer/features/chat-with-knowledge/ui/ChatComposer.module.scss';
import {
  defaultTemplateAsset,
  TemplateAssetEditor,
  TemplateAssetPreview,
  templateAssetLabel,
} from './TemplateAsset';
import type { TemplateAsset } from './TemplateAsset';
import styles from './Prototype.module.scss';

const templateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '템플릿 이름을 입력해 주세요.')
    .max(60, '60자 이내로 입력해 주세요.'),
  description: z.string(),
  body: z.string().trim().min(1, '직접 정의할 구조와 항목을 입력해 주세요.'),
  asset: z.object({
    kind: z.enum([
      'slides',
      'document',
      'sheet',
      'reference',
      'text',
      'link',
      'unknown',
    ]),
    name: z.string().trim().min(1, '템플릿 파일 또는 링크를 선택해 주세요.'),
    output: z.string().trim().min(1, '결과 형식을 정해 주세요.'),
    mode: z.enum(['fill', 'structure', 'reference']),
    status: z.enum(['example', 'unverified']),
  }),
  rules: z.array(z.object({ text: z.string() })),
});
type TemplateValues = z.infer<typeof templateSchema>;
type Template = TemplateValues & { id: string };
type Surface = 'chat' | 'register' | 'manage';
type Phase = 'compose' | 'clarify' | 'result';
type Policy = '' | 'current' | 'proposed' | 'unsure' | 'other';
type Snapshot = {
  template: Template;
  requestRule: string;
  policy: 'current' | 'proposed';
  width: number;
  question: string;
};
export type PrototypeProps = {
  initialView?: 'chat' | 'register' | 'manage' | 'questions' | 'result';
  initialSnapshot?: PrototypeSnapshot;
};

const prototypeSnapshotSchema = z.object({
  surface: z.enum(['chat', 'register', 'manage']),
  phase: z.enum(['compose', 'clarify', 'result']),
  selectedId: z.enum([
    '',
    'screen-spec',
    'compare-report',
    'mapping-table',
    'timeline-process',
    'summary-briefing',
  ]),
  policy: z.enum(['', 'current', 'proposed', 'unsure', 'other']),
  widthChoice: z.enum(['', '640', '960', 'custom']),
  customWidth: z.string().regex(/^\d{0,4}$/),
  confirmedPolicy: z.enum(['current', 'proposed']).nullable(),
  confirmedWidth: z.number().int().min(240).max(1920).nullable(),
  resultPolicy: z.enum(['current', 'proposed']).nullable(),
  resultWidth: z.number().int().min(240).max(1920).nullable(),
  corrected: z.boolean(),
  stale: z.boolean(),
});
export type PrototypeSnapshot = z.infer<typeof prototypeSnapshotSchema>;

/** 호스트에서 돌아온 값은 예시 선택과 답변 값만 검증해 복원합니다. */
export function readPrototypeSnapshot(
  value: unknown,
): PrototypeSnapshot | undefined {
  const result = prototypeSnapshotSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** 새 등록의 시작 값이며 저장한 템플릿 편집과 공유하지 않습니다. */
function emptyTemplate(): TemplateValues {
  return {
    name: '',
    description: '',
    body: `원본 양식: ${defaultTemplateAsset.name}`,
    asset: defaultTemplateAsset,
    rules: [{ text: '' }],
  };
}

const exampleBody = `원본 양식: ${defaultTemplateAsset.name}`;
const exampleTemplate: Template = {
  id: 'screen-spec',
  name: '화면 설계서',
  description: '화면의 구조부터 동작·권한·예외까지 정리합니다.',
  body: exampleBody,
  asset: defaultTemplateAsset,
  rules: [
    { text: '원본 양식의 제목 순서와 표의 열을 유지한다.' },
    { text: '각 동작의 근거 또는 미정 여부를 표시한다.' },
    { text: '잠긴 문서도 검토자는 수정할 수 있다.' },
  ],
};
const builtins = ANSWER_TEMPLATES;
const defaultQuestion = 'Nori 문서 상세 화면의 화면 설계서를 작성해 줘.';

/** 확정된 답변으로 예시 문서를 만들고 검사 전 한 문장의 불일치를 남깁니다. */
function buildResult(snapshot: Snapshot, corrected: boolean): string {
  const wrongWidth = snapshot.width === 960 ? 640 : 960;
  const policy =
    snapshot.policy === 'current'
      ? '현행 정책 유지'
      : '검토자 예외를 추가하는 변경안';
  return `# Nori 문서 상세 화면 설계서

## 1. 화면 개요
문서 내용을 읽고, 권한에 따라 편집 또는 검토로 이어지는 화면입니다. 대상은 일반 사용자와 검토자이며, **${policy}**를 기준으로 작성했습니다.

## 2. 레이아웃
문서 제목과 상태 → 본문 / 속성 → 관련 문서 순서로 배치합니다. 상세 영역은 **${snapshot.width}px**이며, 좁은 화면에서는 가용 폭을 사용하고 속성을 본문 아래로 옮깁니다.

근거: 이번 확인 질문에서 사용자가 상세 영역 ${snapshot.width}px를 선택했습니다.

## 3. 구성 요소
| 요소 | 표시 내용 | 동작 |
| --- | --- | --- |
| 제목줄 | 문서 제목, 잠금 상태 | 이력으로 이동 |
| 문서 본문 | Markdown, 인용 근거 | 읽기·근거 확인 |
| 속성 | 작성자, 문서 상태 | 본문 뒤에서 펼침 |

본문 상세 영역의 최대 너비는 ${corrected ? snapshot.width : wrongWidth}px로 설정합니다.

## 4. 동작 및 권한
| 동작 | 처리 기준 | 근거 |
| --- | --- | --- |
| 문서 읽기 | 조회 권한이 있으면 허용 | Nori 아키텍처 · 문서 조회 |
| 잠긴 문서 편집 | ${snapshot.policy === 'current' ? '모든 사용자에게 차단' : '변경안: 검토자에게만 허용'} | ${snapshot.policy === 'current' ? '원문 잠금 정책 + 이번 사용자 답변' : '이번 사용자 답변 · 구현 전 검토 필요'} |
| 현재 서버의 편집 요청 | 잠긴 문서는 HTTP 423 반환 | Nori 아키텍처 · 잠금 정책 |

${snapshot.policy === 'proposed' ? '검토자 편집 허용은 제안입니다. 현재 서버는 검토자에게도 423을 반환하므로 권한 정책과 서버 동작 변경이 필요합니다.' : '템플릿의 검토자 예외 규칙은 이번 사용자 답변으로 적용하지 않았습니다.'}

## 5. 예외 상태
| 상태 | 화면 처리 | 근거 |
| --- | --- | --- |
| 불러오는 중 | 제목·본문 위치를 유지하며 로딩 표시 | UI·UX 가이드 |
| 접근 불가 | 이유와 목록으로 돌아가기 제공 | Nori 아키텍처 |
| 잠긴 문서 | “잠긴 문서는 수정할 수 없습니다.” 안내 | 정책은 확인됨 · 정확한 문구는 원문에 없음 |

작성 근거: Nori 아키텍처.md, UI·UX 가이드.md, 이번 확인 질문의 답변. 이 문서는 시안의 예시 결과입니다.`;
}

/** 제품과 분리된 메모리 상태로 템플릿 작성 흐름을 검토합니다. */
export function Prototype({
  initialView = 'chat',
  initialSnapshot,
}: PrototypeProps): JSX.Element {
  const startsWithResult = initialView === 'result';
  const startsWithQuestions = initialView === 'questions';
  const [surface, setSurface] = useState<Surface>(
    initialSnapshot?.surface ??
      (initialView === 'register' || initialView === 'manage'
        ? initialView
        : 'chat'),
  );
  const [phase, setPhase] = useState<Phase>(
    initialSnapshot?.phase ??
      (startsWithResult
        ? 'result'
        : startsWithQuestions
          ? 'clarify'
          : 'compose'),
  );
  const [templates, setTemplates] = useState<Template[]>([exampleTemplate]);
  const [selectedId, setSelectedId] = useState(
    initialSnapshot?.selectedId ??
      (startsWithResult || startsWithQuestions ? exampleTemplate.id : ''),
  );
  const [question, setQuestion] = useState(defaultQuestion);
  const [sentQuestion, setSentQuestion] = useState(defaultQuestion);
  const [requestRule, setRequestRule] = useState('');
  const [policyText, setPolicyText] = useState('');
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [isWebEnabled, setWebEnabled] = useState(false);
  const [model, setModel] = useState('default');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fileError, setFileError] = useState('');
  const [attachments, setAttachments] = useState([
    'Nori 아키텍처.md',
    'UI·UX 가이드.md',
  ]);
  const [policy, setPolicy] = useState<Policy>(initialSnapshot?.policy ?? '');
  const [widthChoice, setWidthChoice] = useState<string>(
    initialSnapshot?.widthChoice ?? '',
  );
  const [customWidth, setCustomWidth] = useState(
    initialSnapshot?.customWidth ?? '',
  );
  const [confirmedPolicy, setConfirmedPolicy] = useState<
    'current' | 'proposed' | null
  >(initialSnapshot?.confirmedPolicy ?? null);
  const [confirmedWidth, setConfirmedWidth] = useState<number | null>(
    initialSnapshot?.confirmedWidth ?? null,
  );
  const [clarificationNotice, setClarificationNotice] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(
    startsWithResult ||
      (initialSnapshot?.resultPolicy && initialSnapshot.resultWidth)
      ? {
          template: exampleTemplate,
          requestRule: '',
          policy: initialSnapshot?.resultPolicy ?? 'current',
          width: initialSnapshot?.resultWidth ?? 640,
          question: defaultQuestion,
        }
      : null,
  );
  const [isCorrected, setCorrected] = useState(
    initialSnapshot?.corrected ?? false,
  );
  const [isInspectionOpen, setInspectionOpen] = useState(false);
  const [isStale, setStale] = useState(initialSnapshot?.stale ?? false);
  const [inspectionNotice, setInspectionNotice] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const templateButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const inspectionRef = useRef<HTMLElement>(null);
  const inspectionButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const [isHistoryOpen, setHistoryOpen] = useState(false);
  const [isNarrow, setNarrow] = useState(false);
  const editorDrafts = useRef(new Map<string, TemplateValues>());
  const [hasNewDraft, setHasNewDraft] = useState(false);
  const hasUserAction = useRef(false);
  const form = useForm<TemplateValues>({
    resolver: zodResolver(templateSchema),
    defaultValues: emptyTemplate(),
  });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'rules',
  });
  const body = useWatch({ control: form.control, name: 'body' });
  const asset = useWatch({ control: form.control, name: 'asset' });
  const selected = templates.find(
    (item: Template): boolean => item.id === selectedId,
  );
  const selectedName =
    selected?.name ??
    builtins.find(
      (item: { id: string; name: string }): boolean => item.id === selectedId,
    )?.name ??
    '템플릿 선택';

  /** 팝오버 밖 클릭과 Escape는 선택을 바꾸지 않고 메뉴만 닫습니다. */
  useEffect((): (() => void) | undefined => {
    if (!isMenuOpen) return undefined;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[data-template-option]')
      ?.focus();
    const closeOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      )
        setMenuOpen(false);
    };
    const closeEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        templateButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return (): void => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [isMenuOpen]);

  /** 이동한 화면 제목으로 초점을 보내고 편집 초안은 보존합니다. */
  useEffect((): void => {
    if (surface !== 'chat') titleRef.current?.focus();
  }, [surface]);

  /** 작업면의 실제 너비에 따라 대화 목록과 본문을 전환합니다. */
  useEffect((): (() => void) | undefined => {
    const workspace = workspaceRef.current;
    if (!workspace) return undefined;
    const observer = new ResizeObserver(
      (entries: ResizeObserverEntry[]): void => {
        const entry = entries[0];
        if (entry) setNarrow(entry.contentRect.width < 900);
      },
    );
    observer.observe(workspace);
    return (): void => observer.disconnect();
  }, []);

  /** 파일·초안 본문을 제외하고 검증 가능한 예시 상태만 기억합니다. */
  useEffect((): void => {
    if (!hasUserAction.current) return;
    // 직접 편집한 양식을 원래 예시로 바꿔 복원하지 않습니다.
    const canRestoreResult =
      selected?.id === exampleTemplate.id &&
      selected.body === exampleBody &&
      JSON.stringify(selected.asset) === JSON.stringify(defaultTemplateAsset) &&
      JSON.stringify(selected.rules) ===
        JSON.stringify(exampleTemplate.rules) &&
      !requestRule &&
      sentQuestion === defaultQuestion;
    const state = readPrototypeSnapshot({
      surface,
      phase: canRestoreResult ? phase : 'compose',
      selectedId:
        selectedId === 'screen-spec' ||
        builtins.some((item: { id: string }): boolean => item.id === selectedId)
          ? selectedId
          : '',
      policy,
      widthChoice,
      customWidth: /^\d{0,4}$/.test(customWidth) ? customWidth : '',
      confirmedPolicy,
      confirmedWidth,
      resultPolicy: canRestoreResult ? (snapshot?.policy ?? null) : null,
      resultWidth: canRestoreResult ? (snapshot?.width ?? null) : null,
      corrected: isCorrected,
      stale: isStale,
    });
    if (state)
      window.dispatchEvent(
        new CustomEvent('template-proposal-state', { detail: state }),
      );
  }, [
    surface,
    phase,
    selectedId,
    policy,
    widthChoice,
    customWidth,
    confirmedPolicy,
    confirmedWidth,
    snapshot,
    isCorrected,
    isStale,
    selected,
    requestRule,
    sentQuestion,
  ]);

  /** 호스트에는 원문을 제외한 작은 선택 상태만 전달합니다. */
  function remember(
    _action: string,
    _values: Record<string, string | number | boolean>,
  ): void {
    hasUserAction.current = true;
  }
  /** 템플릿 선택은 이번 질문에만 적용합니다. */
  function handleSelect(id: string): void {
    setSelectedId(id);
    setMenuOpen(false);
    setNotice('');
    remember('select-template', { selectedId: id });
    requestAnimationFrame((): void => templateButtonRef.current?.focus());
  }
  /** 대화로 돌아가도 질문과 등록 중인 입력은 유지합니다. */
  function handleReturn(): void {
    if (surface === 'register') {
      editorDrafts.current.set(editingId ?? 'new', form.getValues());
      if (editingId === null) setHasNewDraft(form.formState.isDirty);
    }
    setSurface('chat');
    remember('return-chat', { surface: 'chat' });
    requestAnimationFrame((): void => templateButtonRef.current?.focus());
  }
  /** 저장한 템플릿을 명시해서 열 때만 편집 값을 새로 읽습니다. */
  function handleEdit(template?: Template): void {
    const id = template?.id ?? 'new';
    const draft = editorDrafts.current.get(id);
    form.reset(template ?? emptyTemplate());
    if (draft) form.reset(draft, { keepDefaultValues: true });
    setEditingId(template?.id ?? null);
    setMenuOpen(false);
    setSurface('register');
    remember('open-editor', { surface: 'register' });
  }
  /** 원본 형식과 작성 방식을 보존하며 텍스트 정의만 별도로 검증합니다. */
  function handleAssetChange(next: TemplateAsset): void {
    form.setValue('asset', next, { shouldDirty: true, shouldValidate: true });
    if (next.kind !== 'text' || next.status === 'unverified') {
      form.setValue('body', next.name ? `원본 양식: ${next.name}` : '', {
        shouldDirty: true,
      });
      form.clearErrors('body');
    } else if (asset.kind !== 'text' || asset.status === 'unverified') {
      form.setValue('body', '', { shouldDirty: true });
    }
  }
  /** 질문에 첨부하는 참고 원문만 텍스트 파일로 읽습니다. */
  async function handleFile(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.(md|txt)$/i.test(file.name) || file.size > 1024 * 1024) {
      setFileError(
        '참고 원문 첨부는 이 시안에서 1 MiB 이내의 .md 또는 .txt만 읽습니다. 템플릿 등록은 별도로 이용하세요.',
      );
      return;
    }
    try {
      await file.text();
      setAttachments((items: string[]): string[] => [...items, file.name]);
      setFileError('');
      setNotice(
        '참고 원문을 읽었습니다. 시안의 작성 결과는 고정된 예시 자료를 사용합니다.',
      );
    } catch {
      setFileError(
        '파일을 읽지 못했습니다. 다른 파일을 선택하거나 직접 붙여 넣어 주세요.',
      );
    }
  }
  /** 검증한 값을 시안 메모리에 저장하고 이번 질문에 선택합니다. */
  function handleSave(values: TemplateValues): void {
    const template = {
      ...values,
      id: editingId ?? `template-${Date.now()}`,
      rules: values.rules.filter((rule: { text: string }): boolean =>
        Boolean(rule.text.trim()),
      ),
    };
    setTemplates((items: Template[]): Template[] => [
      ...items.filter((item: Template): boolean => item.id !== template.id),
      template,
    ]);
    setEditingId(template.id);
    editorDrafts.current.delete(editingId ?? 'new');
    if (editingId === null) setHasNewDraft(false);
    form.reset(template);
    setSelectedId(template.id);
    setNotice(
      `‘${template.name}’을 내 템플릿에 저장하고 선택했습니다. (이 시안에서만 유지)`,
    );
    setSurface('chat');
    requestAnimationFrame((): void => templateButtonRef.current?.focus());
    remember('save-template', {
      selectedId: 'custom',
      ruleCount: template.rules.length,
    });
  }
  /** 이번 시안이 다루는 템플릿에 한해 확인 질문으로 진행합니다. */
  function handleSend(): void {
    if (!question.trim()) {
      textareaRef.current?.focus();
      return;
    }
    if (!selected) {
      setNotice(
        '작성 흐름은 내 템플릿 ‘화면 설계서’를 선택해 체험할 수 있습니다. 기본 답변과 기본 제공 양식은 기존 기능입니다.',
      );
      return;
    }
    if (selected.asset.status === 'unverified') {
      setNotice(
        '템플릿 내용 확인 전입니다. 예시 파일을 선택하면 작성 흐름을 체험할 수 있습니다.',
      );
      return;
    }
    setPhase('clarify');
    setSentQuestion(question);
    setNotice('');
    setConfirmedPolicy(null);
    setConfirmedWidth(null);
    setPolicy('');
    setWidthChoice('');
    setClarificationNotice('');
    remember('start-questions', { phase: 'clarify' });
  }
  /** 부분 답변을 보존하고 미정 항목이 남아 있으면 생성을 기다립니다. */
  function handleAnswers(event?: SubmitEvent<HTMLFormElement>): void {
    event?.preventDefault();
    const nextPolicy =
      confirmedPolicy ??
      (policy === 'current' || policy === 'proposed' ? policy : null);
    const parsedWidth = Number(
      widthChoice === 'custom' ? customWidth : widthChoice,
    );
    const nextWidth =
      confirmedWidth ??
      (Number.isInteger(parsedWidth) &&
      parsedWidth >= 240 &&
      parsedWidth <= 1920
        ? parsedWidth
        : null);
    setConfirmedPolicy(nextPolicy);
    setConfirmedWidth(nextWidth);
    if (!nextPolicy || !nextWidth) {
      setClarificationNotice(
        !nextPolicy && policy === 'unsure'
          ? '권한 정책이 아직 미정입니다. 결정되면 답변을 반영해 주세요. 결과 작성은 기다립니다.'
          : '답변한 항목은 반영했습니다. 남은 항목을 정하면 작성을 시작합니다.',
      );
      return;
    }
    setSnapshot({
      template: selected ?? exampleTemplate,
      requestRule,
      policy: nextPolicy,
      width: nextWidth,
      question: sentQuestion,
    });
    setPhase('result');
    setCorrected(false);
    setStale(false);
    setInspectionNotice('');
    setClarificationNotice('');
    remember('generate-example', { policy: nextPolicy, width: nextWidth });
  }
  /** 기존 결과를 보존한 채 확인 답변을 다시 입력합니다. */
  function handleChangeAnswers(): void {
    setPhase('clarify');
    setStale(true);
    setConfirmedPolicy(null);
    setConfirmedWidth(null);
    setPolicy(snapshot?.policy ?? '');
    const savedWidth = snapshot?.width;
    setWidthChoice(
      savedWidth === 640 || savedWidth === 960
        ? String(savedWidth)
        : savedWidth
          ? 'custom'
          : '',
    );
    setCustomWidth(savedWidth ? String(savedWidth) : '');
    setClarificationNotice(
      '기존 답변을 불러왔습니다. 변경한 뒤 반영하면 새 결과로 작성합니다.',
    );
  }

  const templateMenu = (
    <div className={styles.templatePicker} ref={menuRef}>
      <button
        ref={templateButtonRef}
        className={styles.templateTrigger}
        type="button"
        aria-expanded={isMenuOpen}
        aria-controls="template-picker"
        onClick={(): void => setMenuOpen(!isMenuOpen)}
      >
        <FileText size={16} />
        <span>
          {selectedName}
          {selected ? ` · ${selected.asset.output}` : ''}
        </span>
        <ChevronDown size={14} />
      </button>
      {isMenuOpen && (
        <div
          id="template-picker"
          className={styles.popover}
          aria-label="이번 요청의 템플릿"
        >
          <p className={styles.menuLabel}>이번 요청에 사용할 템플릿</p>
          <button
            data-template-option
            type="button"
            className={styles.menuOption}
            onClick={(): void => handleSelect('')}
          >
            <span>기본 답변</span>
            {!selectedId && <Check size={16} />}
          </button>
          <p className={styles.menuLabel}>내 템플릿</p>
          {templates.map((template: Template): JSX.Element => (
            <button
              key={template.id}
              type="button"
              className={styles.menuOption}
              onClick={(): void => handleSelect(template.id)}
            >
              <span>
                {template.name}
                <small>
                  {templateAssetLabel(template.asset)} ·{' '}
                  {template.asset.status === 'unverified'
                    ? '내용 확인 전'
                    : '예시'}
                </small>
              </span>
              {selectedId === template.id && <Check size={16} />}
            </button>
          ))}
          <p className={styles.menuLabel}>기본 제공</p>
          <div className={styles.builtinOptions}>
            {builtins.map((item: { id: string; name: string }): JSX.Element => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selectedId === item.id}
                onClick={(): void => handleSelect(item.id)}
              >
                {item.name}
                {selectedId === item.id && <Check size={14} />}
              </button>
            ))}
          </div>
          <div className={styles.menuFooter}>
            <button type="button" onClick={(): void => handleEdit()}>
              <Plus size={16} />
              {hasNewDraft ? '등록 중인 템플릿 이어쓰기' : '새 템플릿 등록'}
            </button>
            <button
              type="button"
              onClick={(): void => {
                setMenuOpen(false);
                setSurface('manage');
              }}
            >
              내 템플릿 관리
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const composerArea = (
    <div className={composer.wrap}>
      <form
        className={composer.composer}
        onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
          event.preventDefault();
          handleSend();
        }}
      >
        <div className={styles.sources}>
          <span>참고 원문 · 예시</span>
          {attachments.map((name: string, index: number): JSX.Element => (
            <span className={styles.sourceChip} key={`${name}-${index}`}>
              <FileText size={13} />
              {name}
              <button
                type="button"
                aria-label={`${name} 첨부 해제`}
                onClick={(): void =>
                  setAttachments((items: string[]): string[] =>
                    items.filter(
                      (_item: string, position: number): boolean =>
                        position !== index,
                    ),
                  )
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
        <label className={composer.srOnly} htmlFor="proposal-question">
          질문
        </label>
        <textarea
          id="proposal-question"
          ref={textareaRef}
          className={composer.input}
          value={question}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
            setQuestion(event.target.value)
          }
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>): void => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              handleSend();
            }
          }}
        />
        <div className={`${composer.toolbar} ${styles.composerToolbar}`}>
          <ComposerMenu
            disabled={false}
            template={selectedId}
            onTemplate={handleSelect}
            models={aiModelOptions.claude}
            currentModel={model}
            onModel={(value: string): void => {
              setModel(value);
              setNotice('모델 선택만 표시합니다. 실제 AI는 호출하지 않습니다.');
            }}
            modelDisabled={false}
            onPasteText={(_text: string): void => {
              setAttachments((items: string[]): string[] => [
                ...items,
                '붙여넣은 텍스트',
              ]);
              setNotice(
                '붙여넣기 동작을 확인했습니다. 작성 결과는 고정된 예시 자료를 사용합니다.',
              );
            }}
            onPickFile={(): void => {
              setNotice(
                '제품의 파일 첨부 메뉴입니다. 참고 원문 첨부는 이 시안에서 .md · .txt만 읽습니다. 템플릿은 별도로 등록하세요.',
              );
              attachmentRef.current?.click();
            }}
          />
          <button
            className={styles.iconTool}
            type="button"
            aria-label="웹 검색"
            aria-pressed={isWebEnabled}
            onClick={(): void => {
              setWebEnabled(!isWebEnabled);
              setNotice(
                '웹 검색 선택을 표시합니다. 이 시안에서는 외부 검색을 실행하지 않습니다.',
              );
            }}
          >
            <Globe size={16} />
          </button>
          {templateMenu}
          <button
            className={composer.send}
            type="button"
            onClick={handleSend}
            aria-label="작성"
            disabled={
              !question.trim() || selected?.asset.status === 'unverified'
            }
          >
            <ArrowUp size={16} />
          </button>
        </div>
        {selected && (
          <div className={styles.templateContext}>
            <div className={styles.selectionSummary}>
              <span>
                <strong>{selected.name}</strong> · 원본 양식 · 작성 규칙{' '}
                {selected.rules.length}개
                <small className={styles.assetMeta}>
                  {templateAssetLabel(selected.asset)}
                  {selected.asset.status === 'unverified'
                    ? ' · 내용 확인 전'
                    : ' · 예시'}
                </small>
              </span>
              <button type="button" onClick={(): void => handleEdit(selected)}>
                내용 보기·편집
              </button>
            </div>
            <details>
              <summary>이번 요청 규칙</summary>
              <Field
                label="이번 결과에만 추가할 규칙"
                description="저장된 템플릿은 바뀌지 않습니다."
              >
                {(props: FieldControlProps): JSX.Element => (
                  <textarea
                    {...props}
                    className={styles.textarea}
                    rows={2}
                    value={requestRule}
                    placeholder="예: 모바일 화면의 예외 상태도 함께 정리해 줘."
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
                      setRequestRule(event.target.value)
                    }
                    onBlur={(): void =>
                      remember('request-rule', {
                        hasRequestRule: Boolean(requestRule),
                      })
                    }
                  />
                )}
              </Field>
            </details>
          </div>
        )}
      </form>
      <p className={composer.hint}>
        Enter 전송 · Shift+Enter 줄바꿈 · Claude Code
        {model !== 'default' ? ` · ${model}` : ''}
      </p>
      {selected && (
        <p className={styles.muted}>
          {selected.asset.status === 'unverified'
            ? '내용 확인 전인 템플릿은 아직 작성에 사용할 수 없습니다. 템플릿 편집에서 예시를 선택해 체험하세요.'
            : `예시 Nori 내용 초안으로 흐름을 체험합니다. ${selected.asset.output} 파일 생성과 원본 서식 검사는 연결하지 않았습니다.`}
        </p>
      )}
      {(notice || fileError) && (
        <p className={styles.notice} role="status">
          {fileError || notice}
        </p>
      )}
    </div>
  );

  return (
    <div
      ref={workspaceRef}
      className={`${chat.root} ${styles.root}`}
      data-history={isHistoryOpen}
      data-layout={isNarrow ? 'narrow' : undefined}
      onPointerDownCapture={(): void => {
        hasUserAction.current = true;
      }}
      onKeyDownCapture={(): void => {
        hasUserAction.current = true;
      }}
    >
      <ChatHistoryPanel
        panelRef={historyRef}
        visible={isHistoryOpen}
        narrow={isNarrow}
        disabled={false}
        threads={[]}
        selected={null}
        onClose={(): void => {
          setHistoryOpen(false);
          requestAnimationFrame((): void => historyButtonRef.current?.focus());
        }}
        onNew={(): void => {
          setHistoryOpen(false);
          setNotice(
            '이 시안은 현재 대화의 템플릿 흐름을 보여 줍니다. 작성 중인 입력을 유지했습니다.',
          );
        }}
        onSelect={(_id: string): void => setHistoryOpen(false)}
      />
      <section
        className={`${chat.column} ${styles.column}`}
        hidden={isHistoryOpen && isNarrow}
      >
        <header className={chat.header}>
          <div className={chat.titleGroup}>
            <button
              ref={historyButtonRef}
              type="button"
              className={styles.iconTool}
              aria-label={isHistoryOpen ? '대화 목록 닫기' : '대화 목록 열기'}
              aria-expanded={isHistoryOpen}
              aria-controls="chat-history"
              onClick={(): void => {
                setHistoryOpen(!isHistoryOpen);
                if (!isHistoryOpen)
                  requestAnimationFrame((): void =>
                    historyRef.current?.focus(),
                  );
              }}
            >
              <PanelLeft size={16} />
            </button>
            <h1 className={chat.title}>
              {surface === 'chat' ? '새 대화' : '내 템플릿'}
            </h1>
          </div>
          <span className={styles.headerNote}>채팅에서 사용</span>
        </header>
        {surface === 'register' && (
          <div className={styles.editor}>
            <button
              type="button"
              className={styles.back}
              onClick={handleReturn}
            >
              <ArrowLeft size={16} />
              대화로 돌아가기
            </button>
            <div className={styles.pageHeading}>
              <h2 ref={titleRef} tabIndex={-1}>
                {editingId ? '템플릿 편집' : '새 템플릿 등록'}
              </h2>
              <p>반복할 원본 양식과 작성할 때 지킬 규칙을 함께 저장하세요.</p>
            </div>
            <form
              noValidate
              onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
                void form.handleSubmit(handleSave)(event);
              }}
              className={styles.templateForm}
            >
              <TextField
                label="이름"
                required
                placeholder="예: 화면 설계서"
                {...form.register('name')}
                error={form.formState.errors.name?.message}
              />
              <TextField
                label="설명"
                placeholder="언제 사용하는 템플릿인가요?"
                {...form.register('description')}
              />
              <section className={styles.formSection}>
                <div className={styles.sectionHeading}>
                  <div>
                    <h3>원본 양식</h3>
                    <p>
                      파일, 링크, 직접 정의 중에서 반복해 사용할 양식을
                      정합니다.
                    </p>
                  </div>
                </div>
                <TemplateAssetEditor
                  value={asset}
                  onChange={handleAssetChange}
                  text={
                    asset.kind === 'text' && asset.status === 'example'
                      ? body
                      : ''
                  }
                  onText={(value: string): void =>
                    form.setValue('body', value, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                  error={
                    form.formState.errors.asset?.name?.message ??
                    form.formState.errors.asset?.output?.message ??
                    form.formState.errors.body?.message
                  }
                />
                <p className={styles.muted}>
                  질문에 첨부한 참고 자료와 별개입니다. 원본을 Markdown으로
                  바꾸거나 작성 규칙을 자동 추출하지 않습니다.
                </p>
              </section>
              <section className={styles.formSection}>
                <div className={styles.sectionHeading}>
                  <div>
                    <h3>작성 규칙</h3>
                    <p>내용에 반드시 지킬 기준을 한 가지씩 적습니다.</p>
                  </div>
                </div>
                {fields.map(
                  (field: { id: string }, index: number): JSX.Element => (
                    <div key={field.id} className={styles.ruleRow}>
                      <Field label={`규칙 ${index + 1}`}>
                        {(props: FieldControlProps): JSX.Element => (
                          <textarea
                            {...props}
                            {...form.register(`rules.${index}.text`)}
                            className={styles.textarea}
                            rows={2}
                            placeholder="예: 각 동작의 근거 또는 미정 여부를 표시한다."
                          />
                        )}
                      </Field>
                      <button
                        type="button"
                        className={styles.iconTool}
                        aria-label={`규칙 ${index + 1} 삭제`}
                        onClick={(): void => remove(index)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ),
                )}
                <Button
                  variant="secondary"
                  size="small"
                  onClick={(): void => append({ text: '' })}
                >
                  <Plus size={16} />
                  규칙 추가
                </Button>
              </section>
              <div className={styles.saveRow}>
                <span>
                  {form.formState.isDirty
                    ? '저장하지 않은 변경이 있습니다.'
                    : '이 시안의 내 템플릿에만 저장됩니다.'}
                </span>
                <Button
                  onClick={(): void => {
                    void form.handleSubmit(handleSave)();
                  }}
                >
                  내 템플릿에 저장하고 선택
                </Button>
              </div>
            </form>
          </div>
        )}
        {surface === 'manage' && (
          <div className={styles.editor}>
            <button
              type="button"
              className={styles.back}
              onClick={handleReturn}
            >
              <ArrowLeft size={16} />
              대화로 돌아가기
            </button>
            <div className={styles.sectionHeading}>
              <div className={styles.pageHeading}>
                <h2 ref={titleRef} tabIndex={-1}>
                  내 템플릿
                </h2>
                <p>저장한 양식을 이번 질문에 선택하거나 수정하세요.</p>
              </div>
              <Button
                onClick={(): void => {
                  handleEdit();
                }}
              >
                <Plus size={16} />새 템플릿
              </Button>
            </div>
            <div className={styles.search}>
              <Search size={16} />
              <TextField
                label="템플릿 검색"
                value={search}
                onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                  setSearch(event.target.value)
                }
                placeholder="이름이나 설명 검색"
              />
            </div>
            <div className={styles.templateList}>
              {templates
                .filter((item: Template): boolean =>
                  `${item.name} ${item.description}`.includes(search),
                )
                .map((template: Template): JSX.Element => (
                  <div className={styles.templateRow} key={template.id}>
                    <FileText size={20} />
                    <div>
                      <strong>{template.name}</strong>
                      <p>{template.description}</p>
                      <small>
                        {templateAssetLabel(template.asset)} · 작성 규칙{' '}
                        {template.rules.length}개
                        {template.asset.status === 'unverified'
                          ? ' · 내용 확인 전'
                          : ''}
                      </small>
                    </div>
                    <div className={styles.rowActions}>
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={(): void => handleEdit(template)}
                      >
                        편집
                      </Button>
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={(): void => {
                          handleSelect(template.id);
                          handleReturn();
                        }}
                      >
                        이번 질문에 선택
                      </Button>
                    </div>
                  </div>
                ))}
              {!templates.some((item: Template): boolean =>
                `${item.name} ${item.description}`.includes(search),
              ) && (
                <p className={styles.emptySearch}>
                  일치하는 템플릿이 없습니다. 검색어를 바꿔 주세요.
                </p>
              )}
            </div>
          </div>
        )}
        {surface === 'chat' && phase === 'compose' && (
          <div className={styles.start}>
            <div className={styles.greeting}>
              <h2>무엇을 찾아볼까요?</h2>
              <p>위키에 저장된 문서에서 근거를 찾아 답합니다.</p>
            </div>
            {composerArea}
          </div>
        )}
        {surface === 'chat' && phase !== 'compose' && (
          <div className={styles.conversation}>
            <div className={chat.user}>
              <div className={chat.questionBubble}>
                {snapshot?.question ?? sentQuestion}
              </div>
            </div>
            {phase === 'clarify' && (
              <form className={styles.clarifications} onSubmit={handleAnswers}>
                <div className={styles.pageHeading}>
                  <h2>작성 전에 두 가지만 정할게요.</h2>
                  <p>원문과 규칙이 다른 부분, 양식에 없는 값을 확인합니다.</p>
                </div>
                {confirmedPolicy && (
                  <p className={styles.confirmed}>
                    <Check size={16} />
                    권한 정책:{' '}
                    {confirmedPolicy === 'current'
                      ? '현재 정책 유지'
                      : '변경안으로 작성'}
                  </p>
                )}
                {!confirmedPolicy && (
                  <fieldset>
                    <legend>1. 잠긴 문서를 검토자가 수정할 수 있나요?</legend>
                    <div className={styles.evidence}>
                      <p>
                        <strong>원문</strong> Nori 아키텍처 · “잠긴 문서는
                        누구도 수정할 수 없다. 수정 요청은 423을 반환한다.”
                      </p>
                      <p>
                        <strong>작성 규칙</strong> “잠긴 문서도 검토자는 수정할
                        수 있다.”
                      </p>
                    </div>
                    <div className={styles.radioList}>
                      {(
                        [
                          {
                            value: 'current',
                            label: '현재 정책 유지',
                            hint: '모든 사용자의 수정을 막습니다.',
                          },
                          {
                            value: 'proposed',
                            label: '변경안으로 작성',
                            hint: '검토자 예외를 제안하고 현행 423 동작을 함께 적습니다.',
                          },
                          {
                            value: 'other',
                            label: '다르게 정하기',
                            hint: '별도의 권한 정책을 직접 적습니다.',
                          },
                          {
                            value: 'unsure',
                            label: '아직 미정',
                            hint: '이 항목은 정해질 때까지 작성을 기다립니다.',
                          },
                        ] satisfies {
                          value: Policy;
                          label: string;
                          hint: string;
                        }[]
                      ).map(
                        (option: {
                          value: Policy;
                          label: string;
                          hint: string;
                        }): JSX.Element => (
                          <label
                            className={styles.radioOption}
                            key={option.value}
                          >
                            <input
                              type="radio"
                              name="policy"
                              value={option.value}
                              checked={policy === option.value}
                              onChange={(): void => setPolicy(option.value)}
                            />
                            <span>
                              {option.label}
                              <small>{option.hint}</small>
                            </span>
                          </label>
                        ),
                      )}
                    </div>
                    {policy === 'other' && (
                      <Field
                        label="별도로 정할 권한 정책"
                        description="자유 답변의 추가 질문은 제품 연결 후 제공됩니다. 이 시안에서는 선택지로 흐름을 계속할 수 있습니다."
                      >
                        {(props: FieldControlProps): JSX.Element => (
                          <textarea
                            {...props}
                            className={styles.textarea}
                            rows={3}
                            value={policyText}
                            onChange={(
                              event: ChangeEvent<HTMLTextAreaElement>,
                            ): void => setPolicyText(event.target.value)}
                          />
                        )}
                      </Field>
                    )}
                  </fieldset>
                )}
                {confirmedWidth && (
                  <p className={styles.confirmed}>
                    <Check size={16} />
                    상세 영역 너비: {confirmedWidth}px
                  </p>
                )}
                {!confirmedWidth && (
                  <fieldset>
                    <legend>2. 상세 영역의 너비를 얼마로 할까요?</legend>
                    <p className={styles.evidence}>
                      UI·UX 가이드는 좁은 화면의 재배치만 정의합니다. 데스크톱
                      너비는 정해져 있지 않습니다.
                    </p>
                    <div className={styles.widthOptions}>
                      {['640', '960', 'custom'].map(
                        (value: string): JSX.Element => (
                          <label key={value} className={styles.radioOption}>
                            <input
                              type="radio"
                              name="width"
                              checked={widthChoice === value}
                              onChange={(): void => setWidthChoice(value)}
                            />
                            <span>
                              {value === 'custom' ? '직접 입력' : `${value}px`}
                            </span>
                          </label>
                        ),
                      )}
                    </div>
                    {widthChoice === 'custom' && (
                      <TextField
                        label="상세 영역 너비 (px)"
                        type="number"
                        min={240}
                        max={1920}
                        value={customWidth}
                        onChange={(
                          event: ChangeEvent<HTMLInputElement>,
                        ): void => setCustomWidth(event.target.value)}
                        description="240~1920px 사이의 정수"
                      />
                    )}
                  </fieldset>
                )}
                {clarificationNotice && (
                  <p className={styles.notice} role="status">
                    {clarificationNotice}
                  </p>
                )}
                <div className={styles.answerActions}>
                  <span>모든 항목이 정해져야 작성을 시작합니다.</span>
                  <Button onClick={(): void => handleAnswers()}>
                    답변 반영
                  </Button>
                </div>
              </form>
            )}
            {snapshot && (
              <div
                className={styles.resultLayout}
                data-inspection={isInspectionOpen}
              >
                <div className={styles.result}>
                  <div className={styles.resultHeading}>
                    <span>
                      <FileText size={16} />
                      {snapshot.template.name}
                    </span>
                    <button type="button" onClick={handleChangeAnswers}>
                      답변 변경
                    </button>
                  </div>
                  <div className={styles.inspectionSummary}>
                    <div>
                      <span className={styles.passed}>
                        <Check size={16} />
                        내용 구조 예시 확인
                      </span>
                      <span
                        className={isCorrected ? styles.passed : styles.warning}
                      >
                        {isCorrected ? (
                          <Check size={16} />
                        ) : (
                          <TriangleAlert size={16} />
                        )}
                        내용 {isCorrected ? '자동 검사 통과' : '1개 확인 필요'}
                      </span>
                      <span>파일 서식 검사 미실행</span>
                      <span>원문 대조 검사 불가 1개</span>
                    </div>
                    <Button
                      variant="secondary"
                      size="small"
                      ref={inspectionButtonRef}
                      aria-expanded={isInspectionOpen}
                      onClick={(): void => {
                        setInspectionOpen(!isInspectionOpen);
                        if (!isInspectionOpen)
                          requestAnimationFrame((): void =>
                            inspectionRef.current?.focus(),
                          );
                      }}
                    >
                      검사 상세 {isInspectionOpen ? '닫기' : '보기'}
                    </Button>
                  </div>
                  {isStale && (
                    <p className={styles.stale} role="status">
                      <TriangleAlert size={16} />
                      변경 전 기준으로 검사됨 · 새 답변을 반영하기 전의
                      결과입니다.
                    </p>
                  )}
                  <div className={styles.assetResult}>
                    <div>
                      <strong>내용 검토용 초안</strong>
                      <p>
                        {snapshot.template.asset.output} 파일 생성 미연결 · 원본
                        서식 보존 여부는 확인하지 않았습니다.
                      </p>
                    </div>
                    <TemplateAssetPreview
                      value={snapshot.template.asset}
                      compact
                    />
                  </div>
                  <ChatAnswer content={buildResult(snapshot, isCorrected)} />
                  <details className={styles.snapshot}>
                    <summary>작성 당시 설정</summary>
                    <dl>
                      <dt>저장된 템플릿</dt>
                      <dd>{snapshot.template.name}</dd>
                      <dt>원본 양식</dt>
                      <dd>{snapshot.template.asset.name}</dd>
                      <dt>결과 형식</dt>
                      <dd>{snapshot.template.asset.output}</dd>
                      <dt>사용 방식</dt>
                      <dd>
                        {snapshot.template.asset.mode === 'fill'
                          ? '원본 양식에 내용 채우기'
                          : snapshot.template.asset.mode === 'structure'
                            ? '구조를 따르기'
                            : '참고 자료로 사용'}
                      </dd>
                      {snapshot.template.asset.kind === 'text' && (
                        <>
                          <dt>직접 정의</dt>
                          <dd>
                            <pre>{snapshot.template.body}</pre>
                          </dd>
                        </>
                      )}
                      <dt>작성 규칙</dt>
                      <dd>
                        <ul>
                          {snapshot.template.rules.map(
                            (
                              rule: { text: string },
                              index: number,
                            ): JSX.Element => (
                              <li key={index}>{rule.text}</li>
                            ),
                          )}
                        </ul>
                      </dd>
                      <dt>이번 요청 규칙</dt>
                      <dd>{snapshot.requestRule || '추가 없음'}</dd>
                      <dt>확정 답변</dt>
                      <dd>
                        {snapshot.policy === 'current'
                          ? '현재 정책 유지'
                          : '검토자 예외를 변경안으로 작성'}{' '}
                        · 상세 영역 {snapshot.width}px
                      </dd>
                    </dl>
                  </details>
                </div>
                {isInspectionOpen && (
                  <aside
                    className={styles.inspector}
                    ref={inspectionRef}
                    tabIndex={-1}
                    aria-label="검사 상세"
                  >
                    <div className={styles.sectionHeading}>
                      <h2>검사 상세</h2>
                      <button
                        type="button"
                        className={styles.iconTool}
                        aria-label="검사 상세 닫기"
                        onClick={(): void => {
                          setInspectionOpen(false);
                          requestAnimationFrame((): void =>
                            inspectionButtonRef.current?.focus(),
                          );
                        }}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <p className={styles.muted}>
                      예시 검사 결과 · 작성 당시 원문과 답변 기준
                    </p>
                    <section>
                      <h3 className={styles.passed}>
                        <Check size={16} />
                        내용 구조 예시 확인
                      </h3>
                      <p>
                        내용 검토용 예시 초안의 5개 항목과 표를 확인했습니다.
                        원본 파일의 실제 페이지·슬라이드·셀 구조를 검사한 결과는
                        아닙니다.
                      </p>
                    </section>
                    <section>
                      <h3>
                        <TriangleAlert size={16} />
                        파일 서식 검사 미실행
                      </h3>
                      <p>
                        결과 파일을 생성하지 않아 원본의 레이아웃, 스타일, 셀
                        서식 등을 대조하지 않았습니다.
                      </p>
                    </section>
                    <section>
                      <h3
                        className={isCorrected ? styles.passed : styles.warning}
                      >
                        {isCorrected ? (
                          <Check size={16} />
                        ) : (
                          <TriangleAlert size={16} />
                        )}
                        {isCorrected ? '내용 수정 확인' : '내용 확인 필요'} ·
                        상세 영역 너비
                      </h3>
                      <dl>
                        <dt>규칙</dt>
                        <dd>확정한 사용자 답변과 본문 값이 일치해야 합니다.</dd>
                        <dt>{isCorrected ? '수정한 문장' : '확인할 문장'}</dt>
                        <dd>
                          “본문 상세 영역의 최대 너비는{' '}
                          {isCorrected
                            ? snapshot.width
                            : snapshot.width === 960
                              ? 640
                              : 960}
                          px로 설정합니다.”
                        </dd>
                        <dt>최신 확정 답변</dt>
                        <dd>상세 영역 {snapshot.width}px</dd>
                      </dl>
                      {!isCorrected && (
                        <Button
                          disabled={isStale}
                          onClick={(): void => {
                            setCorrected(true);
                            setInspectionNotice(
                              '너비 문장을 수정하고 다시 검사했습니다. 파일 서식 검사는 미실행이며 원문 대조 검사 불가 1개가 남아 있습니다.',
                            );
                            remember('correct-result', { corrected: true });
                          }}
                        >
                          수정하고 다시 검사
                        </Button>
                      )}
                    </section>
                    <section>
                      <h3>
                        <TriangleAlert size={16} />
                        원문 대조 검사 불가 · 오류 문구
                      </h3>
                      <dl>
                        <dt>검사 기준</dt>
                        <dd>
                          오류 안내가 원문의 정확한 표현과 일치하는지
                          확인합니다.
                        </dd>
                        <dt>본문</dt>
                        <dd>“잠긴 문서는 수정할 수 없습니다.”</dd>
                        <dt>원문</dt>
                        <dd>
                          잠금 정책과 423 응답만 있고 실제 표시 문구는 없습니다.
                        </dd>
                        <dt>다음 행동</dt>
                        <dd>
                          오류 문구를 정한 가이드나 현재 화면을 근거로 추가해야
                          합니다.
                        </dd>
                      </dl>
                    </section>
                    <Button
                      variant="secondary"
                      disabled={isStale}
                      onClick={(): void =>
                        setInspectionNotice(
                          isCorrected
                            ? '본문을 바꾸지 않고 다시 검사했습니다. 파일 서식 검사 미실행과 원문 대조 검사 불가 1개는 그대로입니다.'
                            : '본문을 바꾸지 않고 다시 검사했습니다. 너비 불일치 1개와 검사 불가 1개가 그대로입니다.',
                        )
                      }
                    >
                      <RefreshCw size={16} />
                      검사만 다시 실행
                    </Button>
                    {isStale && (
                      <p className={styles.notice}>
                        새 답변을 반영한 뒤 수정·검사를 진행하세요.
                      </p>
                    )}
                    {inspectionNotice && (
                      <p className={styles.notice} role="status">
                        {inspectionNotice}
                      </p>
                    )}
                  </aside>
                )}
              </div>
            )}
          </div>
        )}
        <input
          ref={attachmentRef}
          type="file"
          accept=".md,.txt"
          hidden
          onChange={(event: ChangeEvent<HTMLInputElement>): void => {
            void handleFile(event);
          }}
        />
      </section>
    </div>
  );
}
