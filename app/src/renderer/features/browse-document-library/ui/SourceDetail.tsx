import { Button } from '@renderer/shared/ui/Button';
import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { ConnectionNotice } from '@renderer/shared/ui/PageNotice';
import { useAiConnection } from '@renderer/platform/aiConnection';
import {
  formatTimestamp,
  formatTimestampWithZone,
} from '@renderer/shared/lib/formatTimestamp';
import { availableExportFormats } from '@renderer/platform/fileExports';
import { exportFormatSchema } from '@contracts/fileExports.contract';
import type { ExportFormat } from '@contracts/fileExports.contract';
import { sourceTitleKey, useRouteTitle } from '@renderer/shared/lib/routeTitle';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  exportLinkedDocument,
  readSourceDetail,
  readSourceDocuments,
} from '../api/sourceDetail.api';
import type {
  SourceDetail as SourceDetailValue,
  LinkedSourceDocuments,
} from '../api/sourceDetail.api';
import { useLibrarySourcePreview } from '../model/useLibrarySourcePreview';
import { useSourceAnalysis } from '../model/useSourceAnalysis';
import type { SourceAnalysisStarter } from '../model/documentLibrary.types';
import {
  SkeletonBar,
  SkeletonList,
  SkeletonText,
} from '@renderer/shared/ui/Skeleton';
import styles from './DocumentLibrary.module.scss';

type SourceDetailProps = {
  sourceId: string;
  version: string;
  /** 이미 등록된 원본의 분석 시작입니다. 다른 feature의 후처리를 페이지가 연결합니다. */
  analysisStarter: SourceAnalysisStarter;
};

/** 문서 내보내기 형식의 화면 이름입니다. 표·슬라이드를 새로 만드는 xlsx·pptx는 산출물 화면에서만 고릅니다. */
const EXPORT_FORMAT_LABELS: Partial<Record<ExportFormat, string>> = {
  md: 'Markdown (.md)',
  txt: '텍스트 (.txt)',
  docx: 'Word (.docx)',
  pdf: 'PDF (.pdf)',
};

/** 보관 시각만 사람이 읽는 형식으로 바꾸고 유효하지 않은 값은 추정하지 않습니다. */
function versionTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '등록 시각 미기록'
    : formatTimestamp(value);
}

/** 원본의 판본·미리보기·파생 문서를 주소가 있는 일반 상세 화면으로 표시합니다. */
export function SourceDetail({
  sourceId,
  version,
  analysisStarter,
}: SourceDetailProps): JSX.Element {
  const [, setParameters] = useSearchParams();
  const [detail, setDetail] = useState<SourceDetailValue | null>(null);
  const [linked, setLinked] = useState<LinkedSourceDocuments | null>(null);
  const [error, setError] = useState('');
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('md');
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRoot = useRef<HTMLDivElement>(null);
  // 문서 상세의 말풍선처럼 밖을 누르거나 Esc를 누르면 닫습니다.
  useEffect((): (() => void) | undefined => {
    if (!infoOpen) return;
    const outside = (event: MouseEvent): void => {
      if (
        event.target instanceof Node &&
        !infoRoot.current?.contains(event.target)
      )
        setInfoOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setInfoOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return (): void => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [infoOpen]);
  const preview = useLibrarySourcePreview();
  const aiRequired = useAiConnection().status === 'required';
  const analysis = useSourceAnalysis(
    detail?.scope.connectionId ?? null,
    detail ? [detail.item] : [],
    analysisStarter,
  );
  const analysisView = detail ? analysis.viewOf(detail.item) : null;
  // 원본 제목을 위치 경로·탭 제목에 알립니다.
  useRouteTitle(
    sourceTitleKey(sourceId),
    detail ? documentDisplayName(detail.item.title) : null,
  );
  const generation = useRef(0);
  const loadSource = useEffectEvent(async (request: number): Promise<void> => {
    try {
      const value = await readSourceDetail(sourceId, version);
      if (request !== generation.current) return;
      setDetail(value);
      preview.open(value.item, value.scope);
      const documents = await readSourceDocuments(value, null);
      if (request === generation.current) setLinked(documents);
    } catch (reason: unknown) {
      if (request === generation.current) {
        setDetail(null);
        preview.close();
        setError(
          reason instanceof Error
            ? reason.message
            : '원본을 확인하지 못했습니다.',
        );
      }
    }
  });
  const clearSource = useEffectEvent((): void => {
    setDetail(null);
    setLinked(null);
    setError('');
    preview.close();
    setRefresh((value: number): number => value + 1);
  });
  useEffect((): (() => void) => {
    const request = ++generation.current;
    void loadSource(request);
    const invalidate = (): void => clearSource();
    window.addEventListener('wiki-connection-changed', invalidate);
    return (): void => {
      generation.current += 1;
      window.removeEventListener('wiki-connection-changed', invalidate);
    };
  }, [sourceId, version, refresh]);
  /** 같은 원본 판본의 다음 문서 범위만 이어 읽습니다. */
  async function loadMore(): Promise<void> {
    if (!detail || !linked?.nextCursor || loadingLinks) return;
    const request = generation.current;
    setLoadingLinks(true);
    try {
      const next = await readSourceDocuments(detail, linked.nextCursor);
      if (request === generation.current)
        setLinked({
          ...next,
          documents: [...linked.documents, ...next.documents],
          incomplete: next.incomplete || linked.omitted,
          omitted: next.omitted || linked.omitted,
        });
    } catch (reason: unknown) {
      if (request === generation.current)
        setError(
          reason instanceof Error
            ? reason.message
            : '문서 목록을 확인하지 못했습니다.',
        );
    } finally {
      if (request === generation.current) setLoadingLinks(false);
    }
  }
  const state = preview.state;
  const firstLinked = linked?.documents[0];
  const exportFormats = availableExportFormats().filter(
    (item: ExportFormat): boolean => item in EXPORT_FORMAT_LABELS,
  );
  const canExport =
    !!detail && !!firstLinked && exportFormats.includes(exportFormat);
  // 원본 서식이 표·셀·그림인 형식은 변환된 문서로 대신하지 않고 원본 내려받기로 안내합니다.
  const restoresPoorly =
    detail?.item.format === 'xlsx' ||
    !!detail?.item.format.match(/^(png|jpe?g|gif|webp|bmp|tiff?)$/);
  /** 원본에서 만든 문서의 현재 본문을 내려받습니다. 중복 요청은 막습니다. */
  async function exportCurrent(): Promise<void> {
    if (!detail || !firstLinked || exporting) return;
    setExporting(true);
    setExportMessage('');
    const result = await exportLinkedDocument(
      detail,
      firstLinked.document,
      documentDisplayName(
        firstLinked.document,
        typeof firstLinked.metadata?.title === 'string'
          ? firstLinked.metadata.title
          : undefined,
      ),
      exportFormat,
    );
    setExporting(false);
    setExportMessage(result.message);
  }
  return (
    <section
      className={`${styles.library} ${styles.sourceDetail}`}
      aria-label="등록 원본 상세"
    >
      <HeaderActions>
        {detail && analysisView?.kind === 'none' && (
          <Button
            variant="primary"
            type="submit"
            className={styles.primary}
            disabled={aiRequired}
            onClick={(): void => {
              void analysis.start(detail.item);
            }}
          >
            분석 시작
          </Button>
        )}
        {detail && analysisView?.jobId && (
          <Link
            className={styles.primary}
            to={`/jobs?jobId=${encodeURIComponent(analysisView.jobId)}`}
          >
            작업 보기
          </Link>
        )}
      </HeaderActions>
      {aiRequired && detail && (
        <ConnectionNotice
          kind="ai-required"
          action={
            <Link className={styles.primary} to="/settings?section=ai">
              AI 연결하기
            </Link>
          }
        />
      )}
      {analysis.message && <p role="alert">{analysis.message}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button
            variant="surface"
            type="submit"
            className={styles.button}
            onClick={(): void => {
              setError('');
              setDetail(null);
              preview.close();
              setRefresh(refresh + 1);
            }}
          >
            다시 확인
          </Button>
        </div>
      )}
      {!detail && !error && (
        <SkeletonList
          label="원본을 불러오는 중"
          className={styles.sourceSkeleton}
        >
          <div className={styles.sourceToolbar} aria-hidden="true">
            {[0, 1, 2, 3, 4].map((index: number): JSX.Element => (
              <span className={styles.chip} key={index}>
                <SkeletonBar shape="badge" />
              </span>
            ))}
          </div>
          <div className={styles.sourcePreview}>
            <SkeletonText lines={8} />
          </div>
        </SkeletonList>
      )}
      {detail && (
        <>
          <div className={styles.sourceToolbar}>
            <label className={styles.sourceVersionChoice}>
              <span className={styles.srOnly}>버전</span>
              <select
                aria-label="버전"
                value={detail.item.sourceVersion}
                onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                  setParameters({ sourceId, version: event.target.value });
                }}
              >
                {detail.versions.versions.map(
                  (
                    item: SourceDetailValue['versions']['versions'][number],
                  ): JSX.Element => (
                    <option key={item.sourceVersion} value={item.sourceVersion}>
                      {versionTime(item.createdAt)}
                      {item.sourceVersion === detail.versions.currentVersion
                        ? ' · 최신'
                        : ''}
                    </option>
                  ),
                )}
              </select>
            </label>
            <span className={styles.chip}>
              {detail.item.format.toUpperCase()} ·{' '}
              {detail.item.sizeBytes < 1024
                ? `${detail.item.sizeBytes.toLocaleString('ko-KR')} B`
                : `${(detail.item.sizeBytes / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} KB`}
            </span>
            <div className={styles.infoPopoverRoot} ref={infoRoot}>
              <button
                type="button"
                className={styles.chip}
                aria-expanded={infoOpen}
                aria-controls="source-facts"
                onClick={(): void =>
                  setInfoOpen((open: boolean): boolean => !open)
                }
              >
                <Icon name="info" size={14} />
                문서 정보
                <Icon name="chevron-down" size={14} data-open={infoOpen} />
              </button>
              {infoOpen && (
                <div
                  className={styles.infoPopover}
                  role="group"
                  aria-label="문서 정보"
                >
                  <dl id="source-facts" className={styles.sourceFacts}>
                    {detail.versions.versions
                      .filter(
                        (
                          item: SourceDetailValue['versions']['versions'][number],
                        ): boolean =>
                          item.sourceVersion === detail.item.sourceVersion,
                      )
                      .map(
                        (
                          item: SourceDetailValue['versions']['versions'][number],
                        ): JSX.Element => (
                          <div key={item.sourceVersion}>
                            <dt>등록 시각</dt>
                            <dd>{formatTimestampWithZone(item.createdAt)}</dd>
                          </div>
                        ),
                      )}
                  </dl>
                </div>
              )}
            </div>
            <button
              className={`${styles.chip} ${styles.linkChip}`}
              disabled={!state || state.downloading}
              aria-busy={state?.downloading}
              onClick={(): void => {
                void preview.download();
              }}
            >
              <Icon
                size={14}
                name={state?.downloading ? 'loader-circle' : 'download'}
                className={state?.downloading ? styles.spin : undefined}
              />
              {state?.downloading ? '내려받는 중…' : '내려받기'}
            </button>
            {!linked ? (
              <span
                className={styles.chip}
                role="status"
                aria-label="생성된 문서를 불러오는 중"
              >
                <SkeletonBar shape="badge" />
              </span>
            ) : linked.documents.length === 0 ? (
              <span className={`${styles.chip} ${styles.mutedChip}`}>
                생성된 문서 없음
              </span>
            ) : (
              linked.documents.map(
                (
                  item: LinkedSourceDocuments['documents'][number],
                ): JSX.Element => (
                  <Link
                    key={item.document}
                    className={`${styles.chip} ${styles.linkChip}`}
                    to={`/document?${new URLSearchParams({ path: item.document })}`}
                  >
                    <Icon name="file-text" size={14} />
                    생성된 문서:{' '}
                    {documentDisplayName(
                      item.document,
                      typeof item.metadata?.title === 'string'
                        ? item.metadata.title
                        : undefined,
                    )}
                  </Link>
                ),
              )
            )}
            {linked?.nextCursor && (
              <Button
                variant="surface"
                type="submit"
                className={styles.button}
                disabled={loadingLinks}
                onClick={(): void => {
                  void loadMore();
                }}
              >
                {loadingLinks && (
                  <Icon name="loader-circle" className={styles.spin} />
                )}
                {loadingLinks ? '조회 중…' : '다음 문서 범위 확인'}
              </Button>
            )}
            {canExport && (
              <label className={styles.sourceVersionChoice}>
                <span className={styles.srOnly}>내보내기 형식</span>
                <select
                  aria-label="내보내기 형식"
                  value={exportFormat}
                  disabled={exporting}
                  onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                    const next = exportFormatSchema.safeParse(
                      event.target.value,
                    );
                    if (next.success) setExportFormat(next.data);
                  }}
                >
                  {exportFormats.map((item: ExportFormat): JSX.Element => (
                    <option key={item} value={item}>
                      {EXPORT_FORMAT_LABELS[item]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {canExport && (
              <Button
                variant="surface"
                type="submit"
                className={styles.button}
                disabled={exporting}
                aria-busy={exporting}
                onClick={(): void => {
                  void exportCurrent();
                }}
              >
                <Icon
                  name={exporting ? 'loader-circle' : 'download'}
                  className={exporting ? styles.spin : undefined}
                />
                {exporting ? '내보내는 중…' : '내보내기'}
              </Button>
            )}
          </div>
          {state?.downloadMessage && (
            <p role={state.downloadFailed ? 'alert' : 'status'}>
              {state.downloadMessage}
            </p>
          )}
          {exportMessage && <p role="status">{exportMessage}</p>}
          {canExport && restoresPoorly && (
            <p className={styles.notice}>
              내보내기는 변환된 문서를 저장합니다. 원본 표·서식·그림은
              ‘내려받기’로 받아 주세요.
            </p>
          )}
          {linked?.incomplete && (
            <p className={styles.notice} role="status">
              생성된 문서 목록의 일부만 확인했습니다.
            </p>
          )}
          <section className={styles.sourcePreview} aria-label="원본 내용">
            {!state?.result ? (
              <SkeletonList
                label="원본 미리보기를 불러오는 중"
                className={styles.sourceSkeleton}
              >
                <SkeletonText lines={8} />
              </SkeletonList>
            ) : !state.result.ok ? (
              <div role="alert">
                <p>{state.result.error.message}</p>
                <Button
                  variant="surface"
                  type="submit"
                  className={styles.button}
                  onClick={(): void => preview.open(detail.item, detail.scope)}
                >
                  미리보기 다시 확인
                </Button>
              </div>
            ) : state.result.data.previewStatus === 'text' ? (
              <pre>{state.result.data.content || '본문이 비어 있습니다.'}</pre>
            ) : (
              <div className={styles.previewUnavailable}>
                <Icon name="file-text" size={24} />
                <h2>이 형식은 미리보기를 지원하지 않습니다</h2>
                <p>원본을 내려받아 확인할 수 있습니다.</p>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
