import { installFixtureBridge } from '../document-tasks/fixtures';
import type {
  RuntimeRequest,
  RuntimeResult,
  RuntimeSnapshot,
} from '@contracts/runtime.contract';
import { useAiConnection } from '@renderer/platform/aiConnection';

/** 기존 제품 화면도 동일한 합성 보고를 읽고 실제 서버를 호출하지 않게 합니다. */
installFixtureBridge();
const controls: unknown = Reflect.get(window, '__documentTaskChecks');
if (
  typeof controls !== 'object' ||
  controls === null ||
  !('scenario' in controls) ||
  typeof controls.scenario !== 'function'
)
  throw new Error('합성 문서 처리 fixture를 준비하지 못했습니다.');
controls.scenario('text-review');

/** 실제 연결 검사를 하지 않고 시안의 실행 준비 상태와 같은 표시를 제공합니다. */
function runtimeSnapshot(ready: boolean): RuntimeSnapshot {
  return {
    settings: {
      root: '',
      python: '',
      provider: 'codex',
      codex: '',
      claude: '',
      tesseract: '',
      tessdata: '',
      models: { codex: 'default', claude: 'default' },
    },
    activeProvider: 'codex',
    activeModel: 'default',
    restartRequired: false,
    saved: true,
    issue: null,
    checks: [],
    platform: 'win32',
    cliConnection: {
      provider: 'codex',
      status: ready ? 'connected' : 'login_required',
      message: '시안의 모의 실행 준비 상태입니다.',
      code: null,
      verifiedAt: ready ? '2026-11-24T05:00:00Z' : null,
    },
  };
}

if (new URLSearchParams(location.search).get('mode') !== 'before') {
  if (!window.wiki) throw new Error('시안 전용 연결을 찾지 못했습니다.');
  let snapshot = runtimeSnapshot(true);
  Object.defineProperty(window.wiki.runtime, 'execute', {
    value: async (request: RuntimeRequest): Promise<RuntimeResult> =>
      request.operation === 'read'
        ? { ok: true, data: snapshot }
        : {
            ok: false,
            error: {
              code: 'fixture',
              message: '실제 설정 변경과 실행은 시안에 연결하지 않았습니다.',
            },
          },
  });
  window.addEventListener(
    'notification-preview-phase',
    (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const value: unknown = event.detail;
      if (
        typeof value !== 'object' ||
        value === null ||
        !('ready' in value) ||
        typeof value.ready !== 'boolean'
      )
        return;
      snapshot = runtimeSnapshot(value.ready);
      useAiConnection.update(snapshot);
    },
  );
}

/** 시안 밖의 이전 테마 선택을 기본 화면에 섞지 않습니다. */
const theme = new URLSearchParams(location.search).get('theme');
localStorage.setItem(
  'llm-wiki.theme-preference',
  theme === 'dark' ? 'dark' : 'light',
);
