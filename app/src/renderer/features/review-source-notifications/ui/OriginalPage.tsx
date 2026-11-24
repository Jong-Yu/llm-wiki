import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { Button } from '@renderer/shared/ui/Button';
import { notificationsApi } from '../api/notifications.api';
import {
  notificationAccessLost,
  notificationSession,
} from '../model/notificationView';
import styles from './Notifications.module.scss';

type OriginalPageProps = {
  scope: SourceConversionScope;
  workflowId: string;
  page: number;
  onAvailable: (available: boolean) => void;
  onAccessLost: () => void;
};

/** 고정된 원본 판본의 해당 쪽만 bridge로 가져와 확대해서 표시합니다. */
export function OriginalPage({
  scope,
  workflowId,
  page,
  onAvailable,
  onAccessLost,
}: OriginalPageProps): JSX.Element {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(false);
  useEffect((): (() => void) => {
    let live = true;
    void notificationsApi
      .page({ ...notificationSession(scope), workflowId, page })
      .then(
        (result: Awaited<ReturnType<typeof notificationsApi.page>>): void => {
          if (!live) return;
          if (!result.ok) {
            if (notificationAccessLost(result.error)) onAccessLost();
            setError(result.error.message);
          } else if (result.data.page !== page)
            setError(
              '요청한 쪽과 다른 원본이 반환되었습니다. 다시 확인해 주세요.',
            );
          else setImage(result.data.dataUrl);
        },
      )
      .catch((): void => {
        if (live) setError('원본 쪽을 불러오지 못했습니다.');
      });
    return (): void => {
      live = false;
    };
  }, [onAccessLost, onAvailable, page, retry, scope, workflowId]);
  return (
    <>
      <div className={styles.paneHeading}>
        <strong>원본 {page}쪽</strong>
        <Button
          variant="surface"
          size="small"
          disabled={!image || !!error}
          aria-pressed={zoom}
          onClick={(): void => {
            setZoom(!zoom);
          }}
        >
          {zoom ? '너비 맞춤' : '원본 확대'}
        </Button>
      </div>
      <div
        className={styles.paperViewport}
        tabIndex={0}
        aria-label={`원본 ${page}쪽 보기`}
      >
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button
              variant="secondary"
              size="small"
              onClick={(): void => {
                setRetry(retry + 1);
                setImage(null);
                setError(null);
                onAvailable(false);
              }}
            >
              원본 다시 불러오기
            </Button>
          </div>
        ) : image ? (
          <img
            src={image}
            alt={`등록한 PDF의 ${page}쪽 원본`}
            data-zoom={zoom}
            onLoad={(): void => {
              onAvailable(true);
            }}
            onError={(): void => {
              setError('원본 이미지를 표시하지 못했습니다.');
              onAvailable(false);
            }}
          />
        ) : (
          <p role="status">원본 {page}쪽을 불러오고 있습니다…</p>
        )}
      </div>
    </>
  );
}
