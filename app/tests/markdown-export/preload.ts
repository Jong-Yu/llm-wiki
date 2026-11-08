import { contextBridge, ipcRenderer } from 'electron';
import { FILE_EXPORT_CHANNELS } from '../../src/shared/contracts/fileExports.contract';
import { createWikiBridge } from '../../src/shared/createWikiBridge';

contextBridge.exposeInMainWorld(
  'wiki',
  createWikiBridge((channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  ),
);
// 잘못된 인자도 실제 main 경계에서 차단되는지 한 채널만 검증합니다.
contextBridge.exposeInMainWorld(
  'exportProbe',
  (...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(FILE_EXPORT_CHANNELS.markdown, ...args),
);
