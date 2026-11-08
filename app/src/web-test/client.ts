import { createWikiBridge } from '../shared/createWikiBridge';
import { SOURCE_CHANNELS } from '@contracts/sources.contract';
import { CONNECTION_CHANNELS } from '@contracts/connection.contract';
import type { WikiBridge } from '@contracts/app.contract';
import {
  chooseBrowserSource,
  downloadBrowserSource,
  exportBrowserMarkdown,
  invalidateBrowserFiles,
} from './browserFiles';
import '../renderer/shared/theme/tokens.css';
import './client.css';

/** 요청을 한 번만 보내며 전송 실패 뒤 저장 요청을 자동 재시도하지 않습니다. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (
    channel === CONNECTION_CHANNELS.authenticate ||
    channel === CONNECTION_CHANNELS.connect ||
    channel === CONNECTION_CHANNELS.disconnect ||
    channel === CONNECTION_CHANNELS.selectWorkspace ||
    channel === CONNECTION_CHANNELS.restoreSaved ||
    channel === CONNECTION_CHANNELS.forgetSaved
  )
    invalidateBrowserFiles();
  if (channel === SOURCE_CHANNELS.chooseFile && args.length === 1)
    return chooseBrowserSource(args[0]);
  if (channel === SOURCE_CHANNELS.download && args.length === 1)
    return downloadBrowserSource(args[0]);
  try {
    const response = await fetch('/__wiki_test/invoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wiki-Test-Request': '1',
      },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify({ channel, args }),
    });
    if (!response.ok) throw new Error('web_test_transport_failed');
    const result: unknown = await response.json();
    return result;
  } catch {
    throw new Error(
      '웹 테스트 서버의 응답을 확인하지 못했습니다. 저장 작업이었다면 다시 보내기 전에 현재 결과를 확인해 주세요.',
    );
  }
}

/** 공개 연결을 먼저 설치한 뒤 제품과 같은 React 진입점을 시작합니다. */
async function start(): Promise<void> {
  window.addEventListener('pagehide', invalidateBrowserFiles);
  Object.defineProperty(window, 'wiki', {
    value: {
      ...createWikiBridge(invoke),
      fileExports: {
        formats: ['md', 'txt'],
        exportMarkdown: exportBrowserMarkdown,
      },
    } satisfies WikiBridge,
    writable: false,
    configurable: false,
  });
  await import('../renderer/main');
}

void start().catch((): void => {
  const root = document.getElementById('root');
  if (!root) return;
  const notice = document.createElement('p');
  notice.setAttribute('role', 'alert');
  notice.textContent =
    '웹 테스트 화면을 시작하지 못했습니다. 테스트 서버 상태를 확인한 뒤 새로고침해 주세요.';
  root.replaceChildren(notice);
});
