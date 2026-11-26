import type { BrowserWindow } from 'electron';
import {
  VOC_CHANNELS,
  vocSubmitSchema,
  vocSubmitResultSchema,
} from '@contracts/voc.contract';
import type { VocBridge } from '@contracts/voc.contract';
import type { ConnectionService } from '@main/backend/ConnectionService';
import { createIpcRegistrar } from './registerIpcHandlers';
import type { IpcContracts } from './registerIpcHandlers';

const contracts = {
  submit: {
    channel: VOC_CHANNELS.submit,
    request: vocSubmitSchema,
    result: vocSubmitResultSchema,
  },
} satisfies IpcContracts<VocBridge, typeof VOC_CHANNELS>;

/** 허용된 앱 창의 검증된 텍스트 보고만 현재 로그인 연결에 전달합니다. */
export function registerVocHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: Pick<ConnectionService, 'submitVoc'>,
): void {
  const { validated } = createIpcRegistrar(getWindow, rendererLocation, {
    invalidRequest: '보고 내용을 확인해 주세요.',
    unexpected: {
      code: 'voc_unavailable',
      message: '보고 결과를 확인하지 못했습니다. 입력한 내용은 유지됩니다.',
    },
  });
  validated(contracts.submit, service.submitVoc.bind(service));
}
