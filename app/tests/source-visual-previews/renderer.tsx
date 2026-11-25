import { StrictMode, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router';
import type { Location } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { RetainedWorkspace } from '@renderer/app/RetainedWorkspace';
import { NotificationWorkflow } from '@renderer/features/review-source-notifications';
import { OriginalContent } from '@renderer/features/review-source-notifications/ui/OriginalContent';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import type { SourceFormat } from '@contracts/documents.contract';
import type {
  NotificationReadRequest,
  NotificationDetailResult,
} from '@contracts/notifications.contract';
import type {
  SourceVisualPreviewRequest,
  SourceVisualPreviewResult,
  SourceVisualPreviewReleaseRequest,
  SourceVisualPreviewReleaseResult,
} from '@contracts/sourceVisualPreviews.contract';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import { installNotifications, workflowId } from '../notifications/fixtures';
import { fixtureRevision } from '../document-tasks/fixtures';

installNotifications();
const bridge = window.wiki;
if (!bridge?.notifications) throw new Error('fixture bridge missing');
const originalRead = bridge.notifications.read;
let format: SourceFormat = 'xlsx';
let fail = false;
let released = 0;
let requests = 0;
bridge.notifications.read = async (
  request: NotificationReadRequest,
): Promise<NotificationDetailResult> => {
  const result = await originalRead(request);
  if (result.ok) result.data.source_format = format;
  return result;
};
bridge.sourceVisualPreviews = {
  read: async (
    request: SourceVisualPreviewRequest,
  ): Promise<SourceVisualPreviewResult> => {
    requests += 1;
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 180);
    });
    if (fail)
      return {
        ok: false,
        error: {
          code: 'office_preview_unavailable',
          message:
            '이 PC에 LibreOffice가 없어 Office 원본을 표시할 수 없습니다. 원본 파일을 열어 확인해 주세요.',
        },
      };
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 700;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas missing');
    context.fillStyle = request.page === 1 ? '#e7eef8' : '#e9f5e8';
    context.fillRect(0, 0, 900, 700);
    context.fillStyle = '#202020';
    context.font = '40px sans-serif';
    context.fillText(`Isolated source fixture ${request.page}`, 40, 80);
    return {
      ok: true,
      data: {
        previewId: request.previewId,
        page: request.page,
        pageCount: 30,
        kind: format === 'png' ? 'image' : 'office',
        limited: false,
        dataUrl: canvas.toDataURL('image/png'),
      },
    };
  },
  release: async (
    _request: SourceVisualPreviewReleaseRequest,
  ): Promise<SourceVisualPreviewReleaseResult> => {
    released += 1;
    return { ok: true };
  },
};
declare global {
  interface Window {
    __sourcePreviewFixture: {
      setFormat: (next: SourceFormat) => void;
      setFail: (next: boolean) => void;
      state: () => { released: number; requests: number };
    };
  }
}
window.__sourcePreviewFixture = {
  setFormat: (next: SourceFormat): void => {
    format = next;
  },
  setFail: (next: boolean): void => {
    fail = next;
  },
  state: (): { released: number; requests: number } => ({ released, requests }),
};
const scope = {
  connectionId: 'fixture',
  userId: 'fixture-user',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: fixtureRevision,
  canPrepare: true,
};
/** 원본 데이터가 같은 새 scope 객체와 실제 접근 판본 변경을 구별하는 격리 화면입니다. */
function ScopeProbe(): JSX.Element {
  const [current, setCurrent] = useState<SourceConversionScope>(scope);
  return (
    <>
      <button
        onClick={(): void => {
          setCurrent({ ...current });
        }}
      >
        동일 범위 다시 렌더
      </button>
      <button
        onClick={(): void => {
          setCurrent({ ...current, accessRevision: 'changed-access' });
        }}
      >
        실제 범위 변경
      </button>
      <section aria-label="범위 변경 원본">
        <OriginalContent
          scope={{ ...current }}
          workflowId={workflowId}
          sourceFormat="xlsx"
          onAvailable={ignoreAvailable}
          onAccessLost={ignoreAccessLost}
        />
      </section>
    </>
  );
}
/** 관찰 콜백의 함수 정체성이 시험 결과를 바꾸지 않게 고정합니다. */
function ignoreAvailable(_available: boolean): void {}
function ignoreAccessLost(): void {}
/** 실제 등록 작업면·앱 셸에서 합성 원본 bridge만 바꿔 동시 대조를 검증합니다. */
function renderRoutes(location: Location): JSX.Element {
  return (
    <Routes location={location}>
      <Route path="/scope-probe" element={<ScopeProbe />} />
      <Route
        path="/documents"
        element={
          <NotificationWorkflow
            scope={scope}
            workflowId={workflowId}
            backPath="/library"
          />
        }
      />
      <Route path="*" element={<p>격리 원본 열기</p>} />
    </Routes>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <ReadQueriesProvider identity="isolated-source-previews">
        <AppShell>
          <RetainedWorkspace render={renderRoutes} />
        </AppShell>
      </ReadQueriesProvider>
    </HashRouter>
  </StrictMode>,
);
