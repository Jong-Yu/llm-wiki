import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import type {
  DocumentListItem,
  DocumentListPage,
} from '@contracts/documents.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  listContextDocuments,
  preparePersonalContext,
} from '../api/personalRecords.api';
import type {
  PersonalBasis,
  PersonalError,
  PersonalSession,
} from '../model/personalRecords';
import type { QuestionSource } from '../model/personalForms';
import styles from './ManagePersonalRecords.module.scss';

type ContextPickerProps = {
  session: PersonalSession;
  documents: string[];
  onChange: (documents: string[]) => void;
  sources?: QuestionSource[];
  onSourcesChange?: (sources: QuestionSource[]) => void;
  disabled: boolean;
  onError: (error: PersonalError) => void;
};
/** 실제 현재 목록에서 최대 여덟 문서를 선택하며 선택 밖의 문서를 자동 확장하지 않습니다. */
export function ContextPicker({
  session,
  documents,
  sources = [],
  onSourcesChange,
  onChange,
  disabled,
  onError,
}: ContextPickerProps): JSX.Element {
  const [page, setPage] = useState<DocumentListPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [index, setIndex] = useState(0);
  const life = useRef(0);
  /** 이전 페이지 응답이 새 목록을 덮지 않게 읽기 수명을 확인합니다. */
  async function load(cursor: string | null): Promise<void> {
    const stamp = ++life.current;
    setLoading(true);
    setError('');
    const result = await listContextDocuments(session, cursor);
    if (stamp !== life.current) return;
    setLoading(false);
    if (result.ok) setPage(result.data);
    else {
      setError(result.error.message);
      onError(result.error);
    }
  }
  useEffect((): (() => void) => {
    const stamp = ++life.current;
    void listContextDocuments(session, null).then(
      (result: Awaited<ReturnType<typeof listContextDocuments>>): void => {
        if (stamp !== life.current) return;
        setLoading(false);
        if (result.ok) setPage(result.data);
        else {
          setError(result.error.message);
          onError(result.error);
        }
      },
    );
    return (): void => {
      life.current += 1;
    };
  }, [session, onError]);
  return (
    <fieldset className={styles.contextPicker} disabled={disabled}>
      <legend>
        근거 문서 <span>{documents.length}/8</span>
      </legend>
      <p className={styles.muted}>선택한 문서를 모두 필수 근거로 준비합니다.</p>
      {documents.length > 0 && (
        <div className={styles.selectedDocuments}>
          {documents.map((name: string): JSX.Element => (
            <button
              type="button"
              key={name}
              onClick={(): void =>
                onChange(
                  documents.filter((item: string): boolean => item !== name),
                )
              }
            >
              {name} ×
            </button>
          ))}
        </div>
      )}
      {loading && <p>문서 목록을 읽고 있습니다.</p>}
      {error && (
        <StatusNotice tone="error">
          {error}
          <Button
            variant="secondary"
            onClick={(): void => {
              void load(cursors[index] || null);
            }}
          >
            다시 읽기
          </Button>
        </StatusNotice>
      )}
      {page && (
        <>
          <div className={styles.documentOptions}>
            {page.items
              .filter(
                (
                  item: DocumentListItem,
                ): item is Extract<DocumentListItem, { kind: 'wiki' }> =>
                  item.kind === 'wiki',
              )
              .map(
                (
                  item: Extract<DocumentListItem, { kind: 'wiki' }>,
                ): JSX.Element => (
                  <label key={item.document}>
                    <input
                      type="checkbox"
                      checked={documents.includes(item.document)}
                      disabled={
                        !documents.includes(item.document) &&
                        documents.length >= 8
                      }
                      onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                        onChange(
                          event.currentTarget.checked
                            ? [...documents, item.document]
                            : documents.filter(
                                (name: string): boolean =>
                                  name !== item.document,
                              ),
                        )
                      }
                    />
                    <span>{item.document}</span>
                  </label>
                ),
              )}
          </div>
          {onSourcesChange && (
            <div className={styles.documentOptions}>
              <p>
                등록 원본 {sources.length}/4 · 선택한 불변 판본을 보존합니다.
              </p>
              {sources.map((source: QuestionSource): JSX.Element => (
                <Button
                  key={`${source.source_id}:${source.source_version}`}
                  variant="secondary"
                  onClick={(): void =>
                    onSourcesChange(
                      sources.filter(
                        (item: QuestionSource): boolean => item !== source,
                      ),
                    )
                  }
                >
                  선택 원본 {source.source_id.slice(0, 8)} ·{' '}
                  {source.source_version.slice(0, 8)} ×
                </Button>
              ))}
              {page.items
                .filter(
                  (
                    item: DocumentListItem,
                  ): item is Extract<DocumentListItem, { kind: 'source' }> =>
                    item.kind === 'source',
                )
                .map(
                  (
                    item: Extract<DocumentListItem, { kind: 'source' }>,
                  ): JSX.Element => {
                    const selected = sources.some(
                      (source: QuestionSource): boolean =>
                        source.source_id === item.sourceId &&
                        source.source_version === item.sourceVersion,
                    );
                    return (
                      <label key={`${item.sourceId}:${item.sourceVersion}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!selected && sources.length >= 4}
                          onChange={(
                            event: ChangeEvent<HTMLInputElement>,
                          ): void =>
                            onSourcesChange(
                              event.currentTarget.checked
                                ? [
                                    ...sources,
                                    {
                                      source_id: item.sourceId,
                                      source_version: item.sourceVersion,
                                      source_sha256: item.sourceSha256,
                                    },
                                  ]
                                : sources.filter(
                                    (source: QuestionSource): boolean =>
                                      source.source_id !== item.sourceId ||
                                      source.source_version !==
                                        item.sourceVersion,
                                  ),
                            )
                          }
                        />
                        <span>
                          {item.title} · {item.format.toUpperCase()} ·{' '}
                          {item.sourceVersion.slice(0, 8)}
                        </span>
                      </label>
                    );
                  },
                )}
            </div>
          )}
          {page.items.every(
            (item: DocumentListItem): boolean => item.kind !== 'wiki',
          ) && <p>이 페이지에 위키 문서가 없습니다.</p>}
          {(page.truncated ||
            page.skipped.length > 0 ||
            !page.complete ||
            page.requiresRefresh) && (
            <p className={styles.warning}>
              문서 목록 일부가 누락됐거나 갱신이 필요합니다. 선택한 근거는 준비
              단계에서 다시 확인합니다.
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={index === 0 || loading}
              onClick={(): void => {
                const previous = index - 1;
                setIndex(previous);
                void load(cursors[previous] || null);
              }}
            >
              이전
            </Button>
            <span>{index + 1}쪽</span>
            <Button
              variant="secondary"
              disabled={!page.nextCursor || loading}
              onClick={(): void => {
                const cursor = page.nextCursor;
                if (!cursor) return;
                setCursors([...cursors.slice(0, index + 1), cursor]);
                setIndex(index + 1);
                void load(cursor);
              }}
            >
              다음
            </Button>
          </div>
        </>
      )}
    </fieldset>
  );
}

type ContextPreparationProps = {
  session: PersonalSession;
  documents: string[];
  sources?: QuestionSource[];
  disabled: boolean;
  onPrepared: (basis: PersonalBasis) => void;
  onError: (error: PersonalError) => void;
};
/** 저장 성공과 별개인 준비 조회를 수행하고 부분 준비를 성공으로 표시하지 않습니다. */
export function ContextPreparation({
  session,
  documents,
  sources = [],
  disabled,
  onPrepared,
  onError,
}: ContextPreparationProps): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const life = useRef(0);
  const selection = JSON.stringify([documents, sources]);
  useEffect(
    (): (() => void) => (): void => {
      life.current += 1;
    },
    [selection],
  );
  /** 선택된 현재 문서 전체가 준비된 경우에만 폼에 스냅샷을 전달합니다. */
  async function prepare(): Promise<void> {
    const stamp = ++life.current;
    setLoading(true);
    setError('');
    const result = await preparePersonalContext(
      { documents, required_documents: documents, source_refs: sources },
      session,
    );
    if (stamp !== life.current) return;
    setLoading(false);
    if (result.ok) onPrepared(result.data);
    else {
      setError(result.error.message);
      onError(result.error);
    }
  }
  return (
    <div className={styles.preparation}>
      <Button
        variant="secondary"
        disabled={
          disabled || loading || documents.length + sources.length === 0
        }
        onClick={(): void => {
          void prepare();
        }}
      >
        {loading ? '근거 준비 중…' : '선택 근거 준비·확인'}
      </Button>
      {error && (
        <p role="alert" className={styles.warning}>
          {error}
        </p>
      )}
      <small>
        저장할 때 서버가 같은 명시 범위를 다시 읽습니다. 실제 보관된 기준은 저장
        결과에서 확인합니다.
      </small>
    </div>
  );
}
