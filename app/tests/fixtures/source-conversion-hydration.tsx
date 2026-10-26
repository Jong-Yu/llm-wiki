import { StrictMode, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvertSource } from '@renderer/features/convert-source';
import { useSourceConversion } from '@renderer/features/convert-source/model/useSourceConversion';
import type {
  ConversionSource,
  SourceConversionReference,
  SourceConversionScope,
} from '@contracts/sourceConversion.contract';
import '@renderer/shared/theme/tokens.css';

const original: ConversionSource = {
  sourceId: 'a'.repeat(32),
  sourceVersion: 'b'.repeat(32),
  sourceSha256: 'c'.repeat(64),
  registrationRevision: 'd'.repeat(64),
};
const scope: SourceConversionScope = {
  connectionId: 'fixture',
  userId: 'alice',
  tenant: 'alpha',
  profileId: 'all',
  policyRevision: 'e'.repeat(64),
};
type ProbeProps = { source: ConversionSource; onInvalidated: () => void };
/** key 없는 소비자에서도 이전 요청의 generation 취소를 확인합니다. */
function Probe({ source, onInvalidated }: ProbeProps): JSX.Element {
  const model = useSourceConversion({
    source,
    scope,
    onScopeInvalidated: onInvalidated,
  });
  return (
    <>
      <output aria-label="변환 모델">
        {JSON.stringify({
          busy: model.busy,
          recovering: model.recovering,
          run: model.run,
          error: model.error,
        })}
      </output>
      <button
        disabled={model.busy || model.recovering}
        onClick={(): void => {
          void model.refresh();
        }}
      >
        모델 새로 조회
      </button>
    </>
  );
}
/** 제품 변환 패널과 명시 계획 인계, 원본 전환만 조립하는 격리 시험입니다. */
function Fixture(): JSX.Element {
  const [source, setSource] = useState(original);
  const [invalidations, setInvalidations] = useState(0);
  const [plan, setPlan] = useState<SourceConversionReference | null>(null);
  const probe = new URLSearchParams(window.location.search).has('probe');
  const invalidate = (): void =>
    setInvalidations((value: number): number => value + 1);
  return (
    <main className="wiki-theme">
      <button
        onClick={(): void =>
          setSource({ ...original, sourceId: 'f'.repeat(32) })
        }
      >
        다른 원본 선택
      </button>
      <output aria-label="권한 변경 알림">{invalidations}</output>
      {probe ? (
        <Probe source={source} onInvalidated={invalidate} />
      ) : (
        <ConvertSource
          source={source}
          scope={scope}
          allowed
          onScopeInvalidated={invalidate}
          onConverted={setPlan}
        />
      )}
      <output aria-label="전달한 분석 계획 기준">
        {plan ? JSON.stringify(plan) : '인계 전'}
      </output>
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
