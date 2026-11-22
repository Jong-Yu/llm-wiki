import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, useLocation } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { Prototype, readPrototypeSnapshot } from './Prototype';
import type { PrototypeSnapshot } from './Prototype';
import { GalleryVariant } from './GalleryVariant';
import { GuidedVariant } from './GuidedVariant';
import './previewEnvironment';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import preview from './Preview.module.scss';
import styles from './Variants.module.scss';

type Variant = 'chat' | 'gallery' | 'guided';
type VariantProps = { kind: Variant; label: string; description: string };
type StoredState = {
  chat?: PrototypeSnapshot;
  gutters: Record<Variant, number>;
};
type TweakControl = {
  addSlider: (
    state: { gutter: number },
    property: string,
    options: {
      label: string;
      min: number;
      max: number;
      step: number;
      unit: string;
    },
  ) => void;
  dispose: () => void;
};
type TweakConstructor = new (options: {
  container: HTMLElement;
  onChange: () => void;
}) => TweakControl;

/** 호스트의 선택적 도구는 함수인지 확인하고 없으면 그대로 표시합니다. */
function isTweak(value: unknown): value is TweakConstructor {
  return typeof value === 'function';
}
/** 외부 복원 자료에서는 알려진 예시 상태와 여백만 읽습니다. */
function readState(value: unknown): StoredState {
  const defaults = {
    chat: undefined,
    gutters: { chat: 24, gallery: 24, guided: 24 },
  };
  if (typeof value !== 'object' || value === null) return defaults;
  const chat = readPrototypeSnapshot('chat' in value ? value.chat : undefined);
  const raw = 'gutters' in value ? value.gutters : undefined;
  const gutters = { ...defaults.gutters };
  if (typeof raw === 'object' && raw !== null) {
    for (const key of ['chat', 'gallery', 'guided'] satisfies Variant[]) {
      const size: unknown = Reflect.get(raw, key);
      if (typeof size === 'number' && size >= 16 && size <= 32)
        gutters[key] = size;
    }
  }
  return { chat, gutters };
}
const host: unknown = Reflect.get(window, 'openai');
const saved: unknown =
  typeof host === 'object' && host !== null && 'widgetState' in host
    ? host.widgetState
    : undefined;
let state = readState(
  typeof saved === 'object' && saved !== null && 'privateContent' in saved
    ? saved.privateContent
    : undefined,
);
let lastSent = '';

/** 시안 간 상태는 함께 저장하되 입력 본문은 호스트로 보내지 않습니다. */
function saveState(): void {
  if (typeof host !== 'object' || host === null || !('setWidgetState' in host))
    return;
  const setter = host.setWidgetState;
  if (typeof setter !== 'function') return;
  lastSent = JSON.stringify(state);
  Promise.resolve(
    setter.call(host, {
      modelContent: {
        comparison: ['채팅에서 선택', '템플릿 보관함', '단계별 작성'],
        gutters: state.gutters,
      },
      privateContent: state,
    }),
  ).catch((): void => {});
}

/** 하나의 변경안 안에서 메뉴를 오가도 작성 화면을 마운트한 채 유지합니다. */
function VariantContent({ kind }: { kind: Variant }): JSX.Element {
  const location = useLocation();
  const [restored, setRestored] = useState<{
    snapshot?: PrototypeSnapshot;
    serial: number;
  }>({ snapshot: state.chat, serial: 0 });
  useEffect((): (() => void) | undefined => {
    if (kind !== 'chat') return undefined;
    const restore = (): void =>
      setRestored(
        (previous: {
          snapshot?: PrototypeSnapshot;
          serial: number;
        }): { snapshot?: PrototypeSnapshot; serial: number } => ({
          snapshot: state.chat,
          serial: previous.serial + 1,
        }),
      );
    window.addEventListener('template-options-restored', restore);
    return (): void =>
      window.removeEventListener('template-options-restored', restore);
  }, [kind]);
  return (
    <>
      <div hidden={location.pathname !== '/chat'}>
        {kind === 'chat' ? (
          <div className={styles.chat}>
            <Prototype
              key={restored.serial}
              initialSnapshot={restored.snapshot}
            />
          </div>
        ) : kind === 'gallery' ? (
          <GalleryVariant />
        ) : (
          <GuidedVariant />
        )}
      </div>
      {location.pathname !== '/chat' && (
        <div className={preview.outside}>
          <p>템플릿 등록과 사용을 비교하는 시안입니다.</p>
          <Link to="/chat">템플릿 시안으로 돌아가기</Link>
        </div>
      )}
    </>
  );
}

/** 실제 앱 프레임 안에 서로 다른 사용 방식을 표시합니다. */
function VariantStage({ kind, label, description }: VariantProps): JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  useEffect((): (() => void) | undefined => {
    const node = element.current;
    if (!node) return undefined;
    // 독립 앱 프레임의 고정 ID를 시안별로 구분합니다.
    for (const id of ['app-content', 'workspace-navigation']) {
      const target = node.querySelector<HTMLElement>(`[id="${id}"]`);
      if (target) target.id = `${kind}-${id}`;
      node
        .querySelectorAll<HTMLElement>(`[aria-controls="${id}"]`)
        .forEach((control: HTMLElement): void => {
          control.setAttribute('aria-controls', `${kind}-${id}`);
        });
      node
        .querySelectorAll<HTMLAnchorElement>(`a[href="#${id}"]`)
        .forEach((link: HTMLAnchorElement): void => {
          link.href = `#${kind}-${id}`;
        });
    }
    const setting = { gutter: state.gutters[kind] };
    const apply = (): void =>
      node.style.setProperty('--variant-gutter', `${setting.gutter}px`);
    apply();
    const restore = (): void => {
      setting.gutter = state.gutters[kind];
      apply();
    };
    window.addEventListener('template-options-restored', restore);
    const Constructor: unknown = Reflect.get(globalThis, 'Tweak');
    let control: TweakControl | undefined;
    if (isTweak(Constructor)) {
      control = new Constructor({
        container: node,
        onChange: (): void => {
          apply();
          state.gutters[kind] = setting.gutter;
          saveState();
        },
      });
      control.addSlider(setting, 'gutter', {
        label: '작업 영역 여백',
        min: 16,
        max: 32,
        step: 4,
        unit: 'px',
      });
    }
    return (): void => {
      control?.dispose();
      window.removeEventListener('template-options-restored', restore);
    };
  }, [kind]);
  return (
    <div
      className={`${preview.preview} ${styles.stage}`}
      ref={element}
      aria-label={label}
    >
      <div className={preview.label}>
        <div className={styles.heading}>
          <strong>{label}</strong>
          <span>{description}</span>
        </div>
        <span>예시 · 저장·AI 미연결</span>
      </div>
      <div className={`${preview.shellFrame} ${styles.frame}`}>
        <MemoryRouter initialEntries={['/chat']}>
          <AppShell>
            <VariantContent kind={kind} />
          </AppShell>
        </MemoryRouter>
      </div>
    </div>
  );
}

window.addEventListener('template-proposal-state', (event: Event): void => {
  if (!(event instanceof CustomEvent)) return;
  const next = readPrototypeSnapshot(event.detail);
  if (next) {
    state.chat = next;
    saveState();
  }
});
window.addEventListener('openai:set_globals', (event: Event): void => {
  if (!(event instanceof CustomEvent)) return;
  const detail: unknown = event.detail;
  if (typeof detail !== 'object' || detail === null || !('globals' in detail))
    return;
  const globals = detail.globals;
  if (
    typeof globals !== 'object' ||
    globals === null ||
    !('widgetState' in globals)
  )
    return;
  const widget = globals.widgetState;
  if (
    typeof widget !== 'object' ||
    widget === null ||
    !('privateContent' in widget)
  )
    return;
  const next = readState(widget.privateContent);
  if (JSON.stringify(next) === lastSent) return;
  state = next;
  window.dispatchEvent(new Event('template-options-restored'));
});

for (const option of [
  {
    kind: 'chat',
    label: '채팅에서 선택',
    description: '작성하던 대화에서 바로 적용',
  },
  {
    kind: 'gallery',
    label: '템플릿 보관함',
    description: '양식과 규칙을 비교한 뒤 시작',
  },
  {
    kind: 'guided',
    label: '단계별 작성',
    description: '빠뜨리지 않도록 순서대로 확인',
  },
] satisfies VariantProps[]) {
  const node = document.getElementById(`template-${option.kind}-option`);
  if (!node) throw new Error('시안 표시 영역이 없습니다.');
  createRoot(node, { identifierPrefix: `option-${option.kind}-` }).render(
    <VariantStage {...option} />,
  );
}

// 가장 긴 작업면 높이를 공유하되 내용이 길어지면 자연스럽게 늘어납니다.
const carousel = document.getElementById('template-design-options');
if (carousel) {
  let tallest = 900;
  const observer = new ResizeObserver(
    (entries: ResizeObserverEntry[]): void => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0)
          tallest = Math.max(tallest, Math.ceil(entry.contentRect.height));
      }
      carousel.style.setProperty('--variant-stage-height', `${tallest}px`);
    },
  );
  carousel
    .querySelectorAll<HTMLElement>('[id$="-option"]')
    .forEach((node: HTMLElement): void => observer.observe(node));
}
