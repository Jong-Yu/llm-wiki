import type { JSX } from 'react';
import type {
  SourceVersion,
  SourceVersionScope,
} from '@contracts/sources.contract';
import type { SourcePreviewRequest } from '@contracts/documents.contract';
import type { ConversionSource } from '@contracts/sourceConversion.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useSourceVersions } from '../model/useSourceVersions';
import styles from './ManageSourceVersions.module.scss';

export type NewSourceVersion = {
  sourceId: string;
  expectedRegistrationRevision: string;
  title: string;
};
export type ManageSourceVersionsProps = {
  sourceId: string;
  selectedVersion: string;
  scope: SourceVersionScope;
  onScopeInvalidated: () => void;
  onPreview: (reference: SourcePreviewRequest) => void;
  onNewVersion: (target: NewSourceVersion) => void;
  onOpenDocument: (document: string) => void;
  onConvert?: (source: ConversionSource) => void;
};

/** 불변 원본 판본과 파생 문서 연결을 실제 카탈로그에서 읽고 본문 이력과 구분합니다. */
export function ManageSourceVersions({
  sourceId,
  selectedVersion,
  scope,
  onScopeInvalidated,
  onPreview,
  onNewVersion,
  onOpenDocument,
  onConvert,
}: ManageSourceVersionsProps): JSX.Element {
  const model = useSourceVersions({ sourceId, scope, onScopeInvalidated });
  const state = model.state;
  return (
    <section className={styles.versions} aria-label="원본 판본 관리">
      <header>
        <div>
          <h2>버전·변경</h2>
          <p>
            이전 원본은 보존되며 새 원본을 올려도 위키 본문은 자동 변경되지
            않습니다.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={model.reload}
          disabled={state.status === 'loading'}
        >
          판본 새로고침
        </Button>
      </header>
      {state.status === 'loading' && (
        <StatusNotice title="원본 판본을 불러오고 있습니다">
          현재 등록 정보를 확인합니다.
        </StatusNotice>
      )}
      {state.status === 'error' && (
        <StatusNotice tone="error" title="판본 조회 안내">
          {state.error.message}
        </StatusNotice>
      )}
      {state.status === 'ready' && (
        <>
          {model.downloadMessage && (
            <p role="status">{model.downloadMessage}</p>
          )}
          <div className={styles.heading}>
            <h3>원본 파일 · {state.catalog.versions.length}개 판본</h3>
            <Button
              disabled={!state.canWrite}
              onClick={(): void =>
                onNewVersion({
                  sourceId,
                  expectedRegistrationRevision:
                    state.catalog.registrationRevision,
                  title: state.catalog.title,
                })
              }
            >
              새 원본 올리기
            </Button>
          </div>
          {!state.canWrite && (
            <p className={styles.caption}>
              이 작업 공간에서 새 원본을 올릴 권한이 없습니다.
            </p>
          )}
          <ol className={styles.list}>
            {state.catalog.versions
              .toReversed()
              .map((version: SourceVersion, index: number): JSX.Element => (
                <li
                  key={version.sourceVersion}
                  aria-current={
                    version.sourceVersion === selectedVersion
                      ? 'true'
                      : undefined
                  }
                >
                  <div className={styles.heading}>
                    <strong>
                      원본 {state.catalog.versions.length - index}판
                      {version.sourceVersion === state.catalog.currentVersion
                        ? ' · 현재'
                        : ' · 과거'}
                    </strong>
                    <Button
                      variant="secondary"
                      onClick={(): void =>
                        onPreview({
                          connectionId: scope.connectionId,
                          sourceId,
                          sourceVersion: version.sourceVersion,
                          sourceSha256: version.sourceSha256,
                          sizeBytes: version.sizeBytes,
                          format: version.format,
                        })
                      }
                    >
                      이 판본 미리보기
                    </Button>
                  </div>
                  <p>
                    {version.filename || '직접 입력'} ·{' '}
                    {version.format.toUpperCase()} ·{' '}
                    {new Intl.NumberFormat('ko-KR').format(version.sizeBytes)} B
                  </p>
                  <Button
                    variant="secondary"
                    onClick={(): void => {
                      void model.download({
                        connectionId: scope.connectionId,
                        sourceId,
                        sourceVersion: version.sourceVersion,
                        sourceSha256: version.sourceSha256,
                        sizeBytes: version.sizeBytes,
                        format: version.format,
                      });
                    }}
                  >
                    원본 내려받기
                  </Button>
                  {onConvert &&
                    version.sourceVersion === state.catalog.currentVersion && (
                      <Button
                        variant="secondary"
                        onClick={(): void =>
                          onConvert({
                            sourceId,
                            sourceVersion: version.sourceVersion,
                            sourceSha256: version.sourceSha256,
                            registrationRevision:
                              state.catalog.registrationRevision,
                          })
                        }
                      >
                        이 원본 문자 변환
                      </Button>
                    )}
                  <p className={styles.caption}>
                    {version.createdAt} · 등록자 {version.actor.userId}
                  </p>
                  <details>
                    <summary>판본·출처 정보</summary>
                    <dl>
                      <dt>원본 판본</dt>
                      <dd>{version.sourceVersion}</dd>
                      <dt>SHA-256</dt>
                      <dd>{version.sourceSha256}</dd>
                      <dt>등록 관점</dt>
                      <dd>{version.actor.profileId}</dd>
                      <dt>등록 당시 정책</dt>
                      <dd>{version.actor.policyRevision}</dd>
                    </dl>
                  </details>
                </li>
              ))}
          </ol>
          <section>
            <h3>연결된 위키</h3>
            {state.catalog.documents.length === 0 ? (
              <p className={styles.caption}>
                이 원본에 등록된 위키 연결이 없습니다.
              </p>
            ) : (
              state.catalog.documents.map(
                (
                  entry: Record<string, unknown>,
                  index: number,
                ): JSX.Element => (
                  <div className={styles.linked} key={index}>
                    {typeof entry.document === 'string' ? (
                      <Button
                        variant="secondary"
                        onClick={(): void => {
                          if (typeof entry.document === 'string')
                            onOpenDocument(entry.document);
                        }}
                      >
                        {entry.document}
                      </Button>
                    ) : (
                      <p>문서 연결 정보</p>
                    )}
                    <details>
                      <summary>연결 당시 근거</summary>
                      <pre>{JSON.stringify(entry, null, 2)}</pre>
                    </details>
                  </div>
                ),
              )
            )}
          </section>
        </>
      )}
    </section>
  );
}
