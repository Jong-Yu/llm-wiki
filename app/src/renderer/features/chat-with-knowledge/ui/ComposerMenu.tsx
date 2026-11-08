import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import type { AiModelOption } from '../model/aiModelOptions';
import { ANSWER_TEMPLATES, templateById } from '../model/answerTemplates';
import styles from './ComposerMenu.module.scss';

type ComposerMenuProps = {
  disabled: boolean;
  template: string;
  onTemplate: (id: string) => void;
  models: readonly AiModelOption[];
  currentModel: string;
  onModel: (value: string) => void;
  modelDisabled: boolean;
  onPasteText: (text: string) => void;
  onPickFile?: () => void;
};
type Panel = 'main' | 'template' | 'model' | 'paste';
type Choice = { id: string; name: string; description?: string };
const templates: readonly Choice[] = [
  { id: '', name: '기본 답변', description: 'AI가 알아서 씁니다' },
  ...ANSWER_TEMPLATES,
];

/** ＋ 메뉴에서 질문 옵션을 고릅니다. 붙여넣기 패널의 초안은 메뉴를 다시 열어도 보존합니다. */
export function ComposerMenu({
  disabled,
  template,
  onTemplate,
  models,
  currentModel,
  onModel,
  modelDisabled,
  onPasteText,
  onPickFile,
}: ComposerMenuProps): JSX.Element {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [pasteText, setPasteText] = useState('');
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const selectedTemplate = templateById(template);
  const selectedModel =
    currentModel === 'default'
      ? '기본 설정'
      : (models.find(
          (option: AiModelOption): boolean => option.value === currentModel,
        )?.label ?? currentModel);

  // 첨부 읽기나 응답 생성으로 잠기면 열려 있던 메뉴만 닫고 붙여넣기 초안은 남깁니다.
  if (disabled && panel !== null) setPanel(null);

  useLayoutEffect((): void => {
    const target =
      popup.current?.querySelector<HTMLElement>(
        'textarea, [aria-checked="true"]',
      ) ??
      popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    target?.focus();
  }, [panel]);

  useEffect((): (() => void) | void => {
    if (!panel) return;
    const dismissOutside = (event: Event): void => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target)
      )
        setPanel(null);
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return (): void => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [panel]);

  /** 메뉴 닫기와 선택을 마치면 열기 버튼에 초점을 돌려줍니다. */
  function close(): void {
    setPanel(null);
    trigger.current?.focus();
  }

  /** 편집 중에는 기본 글 이동 키를 유지하고 메뉴 항목 사이에서만 방향키를 씁니다. */
  function navigate(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && panel && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (
      panel === 'paste' ||
      !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
    )
      return;
    if (!panel) {
      if (event.key === 'ArrowDown' && !disabled) {
        event.preventDefault();
        setPanel('main');
      }
      return;
    }
    const items = Array.from(
      popup.current?.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)',
      ) ?? [],
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.findIndex(
      (item: HTMLButtonElement): boolean => item === event.target,
    );
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  }

  /** 양식·모델의 현재 선택과 후보를 같은 키보드 동작으로 표시합니다. */
  function choices(
    title: string,
    items: readonly Choice[],
    value: string,
    select: (id: string) => void,
  ): JSX.Element {
    return (
      <>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={styles.back}
          onClick={(): void => setPanel('main')}
        >
          <Icon name="chevron-left" size={12} /> {title}
        </button>
        {items.map((item: Choice): JSX.Element => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            tabIndex={-1}
            aria-checked={value === item.id}
            className={`${styles.item} ${value === item.id ? styles.picked : ''}`}
            onClick={(): void => {
              select(item.id);
              close();
            }}
          >
            <span>{item.name}</span>
            {item.description && <small>{item.description}</small>}
          </button>
        ))}
      </>
    );
  }

  return (
    <div ref={anchor} className={styles.plus} onKeyDown={navigate}>
      <button
        ref={trigger}
        type="button"
        className={styles.plusButton}
        aria-label="옵션 열기"
        aria-haspopup="menu"
        aria-controls={panel ? popupId : undefined}
        aria-expanded={!!panel}
        disabled={disabled}
        onClick={(): void => setPanel(panel ? null : 'main')}
      >
        <Icon name="plus" size={16} />
      </button>
      {panel && !disabled && (
        <div
          ref={popup}
          id={popupId}
          className={styles.menu}
          role={panel === 'paste' ? 'dialog' : 'menu'}
          aria-label={panel === 'paste' ? '자료 붙여넣기' : '질문 옵션'}
        >
          {panel === 'main' && (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${styles.menuRow} ${selectedTemplate ? styles.picked : ''}`}
                onClick={(): void => setPanel('template')}
              >
                <span>답변 양식</span>
                <small>
                  {selectedTemplate?.name ?? '기본 답변'}
                  <Icon name="chevron-right" size={12} />
                </small>
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={styles.menuRow}
                onClick={(): void => setPanel('paste')}
              >
                <span>자료 붙여넣기</span>
                <small>외부 글 참고</small>
              </button>
              {onPickFile && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={styles.menuRow}
                  onClick={(): void => {
                    close();
                    onPickFile();
                  }}
                >
                  <span>파일 첨부</span>
                  <small>DOCX · XLSX · PDF · 그림</small>
                </button>
              )}
              {models.length > 1 && (
                <>
                  <hr />
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={styles.menuRow}
                    disabled={modelDisabled}
                    onClick={(): void => setPanel('model')}
                  >
                    <span>모델</span>
                    <small>
                      {selectedModel}
                      <Icon name="chevron-right" size={12} />
                    </small>
                  </button>
                </>
              )}
            </>
          )}
          {panel === 'template' &&
            choices('답변 양식', templates, template, onTemplate)}
          {panel === 'model' &&
            choices(
              '모델',
              models.map((option: AiModelOption): Choice => ({
                id: option.value,
                name: option.value === 'default' ? '기본 설정' : option.label,
              })),
              currentModel,
              onModel,
            )}
          {panel === 'paste' && (
            <div className={styles.pastePanel}>
              <label htmlFor={`${popupId}-paste`}>붙여넣을 글</label>
              <textarea
                id={`${popupId}-paste`}
                rows={5}
                value={pasteText}
                placeholder="보도자료 같은 글을 붙여넣으세요"
                onChange={(event: ChangeEvent<HTMLTextAreaElement>): void =>
                  setPasteText(event.currentTarget.value)
                }
              />
              <div className={styles.pasteActions}>
                <button type="button" onClick={(): void => setPanel('main')}>
                  뒤로
                </button>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!pasteText.trim()}
                  onClick={(): void => {
                    onPasteText(pasteText);
                    setPasteText('');
                    close();
                  }}
                >
                  첨부에 추가
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
