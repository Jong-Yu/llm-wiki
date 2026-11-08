import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, JSX } from 'react';
import type { OntologyMapConcept } from '@contracts/ontologyExploration.contract';
import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { conceptKey } from '../model/buildOntologyGraph';
import styles from './OntologySelectionBar.module.scss';

type OntologySelectionBarProps = {
  concepts: OntologyMapConcept[];
  focusKey: string | null;
  onFocus: (key: string) => void;
  onRemove: (key: string) => void;
};
type ScrollState = { previous: boolean; next: boolean };

/** 함께 보는 개념을 바로 찾고 빼며 많은 개념도 같은 한 줄에서 관리합니다. */
export function OntologySelectionBar({
  concepts,
  focusKey,
  onFocus,
  onRemove,
}: OntologySelectionBarProps): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const labelId = useId();
  const [scroll, setScroll] = useState<ScrollState>({
    previous: false,
    next: false,
  });
  const hasOverflow = scroll.previous || scroll.next;

  useEffect((): (() => void) => {
    const frame = viewport.current;
    const content = list.current;
    if (!frame || !content) return (): void => {};
    const measure = (): void => {
      const previous = frame.scrollLeft > 1;
      const next = frame.scrollLeft + frame.clientWidth < frame.scrollWidth - 1;
      setScroll((current: ScrollState): ScrollState =>
        current.previous === previous && current.next === next
          ? current
          : { previous, next },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);
    frame.addEventListener('scroll', measure, { passive: true });
    measure();
    return (): void => {
      observer.disconnect();
      frame.removeEventListener('scroll', measure);
    };
  }, []);

  /** 현재 중심이 바뀐 경우만 드러내며 사용자가 직접 옮긴 목록 위치는 유지합니다. */
  useEffect((): void => {
    if (!focusKey) return;
    const button = buttons.current.get(focusKey);
    const frame = viewport.current;
    if (!button || !frame) return;
    const chip = button.parentElement;
    if (!chip) return;
    const area = frame.getBoundingClientRect();
    const item = chip.getBoundingClientRect();
    if (item.left < area.left) frame.scrollLeft += item.left - area.left;
    else if (item.right > area.right)
      frame.scrollLeft += item.right - area.right;
  }, [focusKey]);

  /** Tab으로 들어온 개념도 문서 전체를 움직이지 않고 이 띠 안에서만 드러냅니다. */
  function revealFocusedConcept(event: FocusEvent<HTMLDivElement>): void {
    const frame = viewport.current;
    if (!frame || !(event.target instanceof HTMLElement)) return;
    const chip = event.target.closest('li');
    if (!chip) return;
    const area = frame.getBoundingClientRect();
    const item = chip.getBoundingClientRect();
    if (item.left < area.left) frame.scrollLeft += item.left - area.left;
    else if (item.right > area.right)
      frame.scrollLeft += item.right - area.right;
  }

  function moveList(direction: -1 | 1): void {
    const frame = viewport.current;
    if (frame)
      frame.scrollLeft += direction * Math.max(100, frame.clientWidth * 0.75);
  }

  /** 제외한 버튼이 사라져도 옆 개념으로 키보드 탐색을 계속할 수 있게 합니다. */
  function removeConcept(key: string, index: number): void {
    const adjacent = concepts[index + 1] ?? concepts[index - 1];
    onRemove(key);
    if (!adjacent) return;
    const adjacentKey = conceptKey(adjacent.document, adjacent.entity_id);
    requestAnimationFrame((): void =>
      buttons.current.get(adjacentKey)?.focus(),
    );
  }

  return (
    <nav
      className={styles.bar}
      aria-label={`함께 보는 개념 ${concepts.length}개`}
    >
      <span className={styles.label}>
        <span>함께 보는 </span>개념 <b>{concepts.length}</b>
      </span>
      {hasOverflow && (
        <button
          type="button"
          className={styles.scrollButton}
          aria-label="앞쪽 개념 보기"
          disabled={!scroll.previous}
          onClick={(): void => moveList(-1)}
        >
          <Icon name="chevron-left" size={14} />
        </button>
      )}
      <div
        ref={viewport}
        className={styles.viewport}
        onFocusCapture={revealFocusedConcept}
      >
        <ul ref={list} className={styles.list}>
          {concepts.map(
            (concept: OntologyMapConcept, index: number): JSX.Element => {
              const key = conceptKey(concept.document, concept.entity_id);
              const documentName = documentDisplayName(concept.document);
              const sameDocumentName = concepts.some(
                (item: OntologyMapConcept): boolean =>
                  item.document !== concept.document &&
                  item.name === concept.name &&
                  documentDisplayName(item.document) === documentName,
              );
              const sourceLabel = sameDocumentName
                ? concept.document
                : documentName;
              const documentId = `${labelId}-${index}`;
              return (
                <li
                  key={key}
                  className={styles.chip}
                  data-current={key === focusKey}
                >
                  <button
                    type="button"
                    className={styles.focus}
                    ref={(element: HTMLButtonElement | null): void => {
                      if (element) buttons.current.set(key, element);
                      else buttons.current.delete(key);
                    }}
                    aria-current={key === focusKey ? 'true' : undefined}
                    aria-label={`${concept.name} 지도 중심으로 이동`}
                    aria-describedby={documentId}
                    onClick={(): void => onFocus(key)}
                    title={`${concept.name} · ${sourceLabel}`}
                  >
                    <strong>{concept.name}</strong>
                    <small id={documentId}>{sourceLabel}</small>
                  </button>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`${concept.name} 함께 보기에서 빼기`}
                    aria-describedby={documentId}
                    title={`${concept.name} 함께 보기에서 빼기`}
                    onClick={(): void => removeConcept(key, index)}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </li>
              );
            },
          )}
        </ul>
      </div>
      {hasOverflow && (
        <button
          type="button"
          className={styles.scrollButton}
          aria-label="뒤쪽 개념 보기"
          disabled={!scroll.next}
          onClick={(): void => moveList(1)}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      )}
    </nav>
  );
}
