import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { Link } from 'react-router';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import type { SourceFormat } from '@contracts/documents.contract';
import type { SourceVisualPreviewResult } from '@contracts/sourceVisualPreviews.contract';
import { Button } from '@renderer/shared/ui/Button';
import { IconButton } from '@renderer/shared/ui/IconButton';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { sourceVisualPreviewsApi } from '../api/notifications.api';
import {
  notificationAccessLost,
  notificationSession,
} from '../model/notificationView';
import styles from './Notifications.module.scss';
import previewStyles from './OriginalContent.module.scss';

type OriginalContentProps = {
  scope: SourceConversionScope;
  workflowId: string;
  sourceFormat: SourceFormat;
  page?: number;
  originalHref?: string;
  returnTo?: string;
  onAvailable: (available: boolean) => void;
  onAccessLost: () => void;
};
type Preview = Extract<SourceVisualPreviewResult, { ok: true }>['data'];

/** 원본 사본을 로컬에서 렌더하고 편집 영역을 유지한 채 한 위치씩 대조합니다. */
export function OriginalContent({
  scope,
  workflowId,
  sourceFormat,
  page: selectedPage,
  originalHref,
  returnTo,
  onAvailable,
  onAccessLost,
}: OriginalContentProps): JSX.Element {
  const active = useWorkspaceActivity();
  const {
    connectionId,
    userId,
    tenant,
    profileId,
    policyRevision,
    accessRevision,
  } = scope;
  const session = useMemo(
    (): ReturnType<typeof notificationSession> =>
      notificationSession({
        connectionId,
        userId,
        tenant,
        profileId,
        policyRevision,
        ...(accessRevision ? { accessRevision } : {}),
      }),
    [connectionId, userId, tenant, profileId, policyRevision, accessRevision],
  );
  const [previewId] = useState((): string =>
    crypto.randomUUID().replaceAll('-', ''),
  );
  const ownerBasis = JSON.stringify([session, workflowId, sourceFormat]);
  const navigationBasis = JSON.stringify([ownerBasis, selectedPage]);
  const [navigation, setNavigation] = useState({
    basis: navigationBasis,
    page: selectedPage ?? 1,
    number: String(selectedPage ?? 1),
  });
  const page =
    navigation.basis === navigationBasis
      ? navigation.page
      : (selectedPage ?? 1);
  const number =
    navigation.basis === navigationBasis ? navigation.number : String(page);
  const [data, setData] = useState<
    (Preview & { basis: string; ownerBasis: string }) | null
  >(null);
  const [failure, setFailure] = useState<{
    basis: string;
    message: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [activity, setActivity] = useState({ active, epoch: 0 });
  const activityEpoch = activity.epoch + (activity.active === active ? 0 : 1);
  // 보관 화면을 다시 열 때 이전 인증 확인의 이미지를 순간 재표시하지 않습니다.
  if (activity.active !== active) {
    setActivity({ active, epoch: activityEpoch });
    if (!active) {
      setData(null);
      setFailure(null);
    }
  }
  const office = ['docx', 'xlsx', 'pptx', 'ppt'].includes(sourceFormat);
  const unit =
    sourceFormat === 'xlsx'
      ? '인쇄 페이지'
      : ['pptx', 'ppt'].includes(sourceFormat)
        ? '슬라이드'
        : office
          ? '페이지'
          : '이미지';
  const basis = JSON.stringify([
    ownerBasis,
    selectedPage,
    page,
    retry,
    activityEpoch,
  ]);
  const error = failure?.basis === basis ? failure.message : null;
  const image = active && data?.basis === basis && !error ? data.dataUrl : null;
  const count = data?.ownerBasis === ownerBasis ? data.pageCount : 0;

  useEffect((): (() => void) | undefined => {
    if (!active) return undefined;
    return (): void => {
      void sourceVisualPreviewsApi.release({ previewId }).catch((): void => {});
    };
  }, [active, ownerBasis, previewId]);

  useEffect((): (() => void) => {
    let live = true;
    onAvailable(false);
    if (!active) {
      return (): void => {
        live = false;
      };
    }
    void sourceVisualPreviewsApi
      .read({ ...session, workflowId, previewId, page })
      .then((result: SourceVisualPreviewResult): void => {
        if (!live) return;
        if (!result.ok) {
          if (notificationAccessLost(result.error)) onAccessLost();
          setFailure({ basis, message: result.error.message });
        } else if (
          result.data.previewId !== previewId ||
          result.data.page !== page
        ) {
          setFailure({
            basis,
            message:
              '요청한 위치와 다른 원본이 반환되었습니다. 다시 확인해 주세요.',
          });
        } else {
          setFailure(null);
          setData({ ...result.data, basis, ownerBasis });
        }
      })
      .catch((): void => {
        if (live)
          setFailure({
            basis,
            message: '원본 미리보기를 불러오지 못했습니다.',
          });
      });
    return (): void => {
      live = false;
    };
  }, [
    basis,
    active,
    ownerBasis,
    onAccessLost,
    onAvailable,
    page,
    previewId,
    retry,
    session,
    workflowId,
  ]);

  const move = (next: number): void => {
    if (!Number.isInteger(next) || next < 1 || (count > 0 && next > count)) {
      setNavigation({ basis: navigationBasis, page, number: String(page) });
      return;
    }
    setNavigation({ basis: navigationBasis, page: next, number: String(next) });
  };

  return (
    <>
      <div className={styles.paneHeading}>
        <strong>원본 미리보기</strong>
        {originalHref && (
          <Link
            to={originalHref}
            state={returnTo ? { workflowReturnTo: returnTo } : undefined}
          >
            원본 열기
          </Link>
        )}
        <IconButton
          icon="maximize-2"
          label={zoom ? '너비 맞춤' : '원본 확대'}
          size="small"
          disabled={!image}
          aria-pressed={zoom}
          onClick={(): void => {
            setZoom(!zoom);
          }}
        />
      </div>
      <div className={previewStyles.toolbar}>
        <span>{unit}</span>
        <IconButton
          icon="chevron-left"
          size="small"
          label={`이전 ${unit}`}
          disabled={page <= 1 || !image}
          onClick={(): void => {
            move(page - 1);
          }}
        />
        <input
          aria-label={`원본 ${unit} 번호`}
          type="number"
          min={1}
          max={count || undefined}
          value={number}
          disabled={!count}
          onChange={(event: ChangeEvent<HTMLInputElement>): void => {
            setNavigation({
              basis: navigationBasis,
              page,
              number: event.target.value,
            });
          }}
          onBlur={(): void => {
            move(Number(number));
          }}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>): void => {
            if (event.key === 'Enter') move(Number(number));
          }}
        />
        <span className={previewStyles.count}>/ {count || '—'}</span>
        <IconButton
          icon="chevron-right"
          size="small"
          label={`다음 ${unit}`}
          disabled={!count || page >= count || !image}
          onClick={(): void => {
            move(page + 1);
          }}
        />
      </div>
      <p className={previewStyles.notice}>
        {office
          ? sourceFormat === 'xlsx'
            ? '인쇄 영역 기준 미리보기입니다. 수식은 저장된 값으로 표시하며 글꼴·배치는 원본 앱과 다를 수 있습니다.'
            : '글꼴·배치는 원본 앱과 다를 수 있습니다. 외부 연결과 실행 개체는 표시하지 않습니다.'
          : '등록한 이미지의 방향 정보를 적용해 표시합니다.'}
      </p>
      <div
        className={`${styles.paperViewport} ${previewStyles.viewport}`}
        tabIndex={0}
        aria-label={`원본 ${unit} ${page} 보기`}
        aria-busy={!image && !error}
      >
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button
              variant="secondary"
              size="small"
              onClick={(): void => {
                setData(null);
                setRetry(retry + 1);
              }}
            >
              원본 다시 불러오기
            </Button>
          </div>
        ) : image ? (
          <img
            src={image}
            alt={`등록한 원본의 ${unit} ${page}`}
            data-zoom={zoom}
            onLoad={(): void => {
              onAvailable(true);
            }}
            onError={(): void => {
              setFailure({
                basis,
                message: '원본 이미지를 표시하지 못했습니다.',
              });
              onAvailable(false);
            }}
          />
        ) : (
          <p role="status">원본 미리보기를 준비하고 있습니다…</p>
        )}
      </div>
    </>
  );
}
