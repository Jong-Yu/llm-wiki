import type { BrowserWindow } from 'electron';
import {
  REGISTRATION_DRAFT_CHANNELS,
  registrationDraftGetSchema,
  registrationDraftSaveSchema,
  registrationDraftClearSchema,
  registrationDraftResultSchema,
} from '@contracts/registrationDrafts.contract';
import type { RegistrationDraftsBridge } from '@contracts/registrationDrafts.contract';
import type { RegistrationDraftService } from '@main/backend/RegistrationDraftService';
import { createIpcRegistrar } from './registerIpcHandlers';
import type { IpcContracts } from './registerIpcHandlers';

const contracts = {
  get: {
    channel: REGISTRATION_DRAFT_CHANNELS.get,
    request: registrationDraftGetSchema,
    result: registrationDraftResultSchema,
  },
  save: {
    channel: REGISTRATION_DRAFT_CHANNELS.save,
    request: registrationDraftSaveSchema,
    result: registrationDraftResultSchema,
  },
  clear: {
    channel: REGISTRATION_DRAFT_CHANNELS.clear,
    request: registrationDraftClearSchema,
    result: registrationDraftResultSchema,
  },
} satisfies IpcContracts<
  RegistrationDraftsBridge,
  typeof REGISTRATION_DRAFT_CHANNELS
>;

/** 허용된 최상위 앱 창과 검증된 입력만 현재 인증 범위의 초안에 접근합니다. */
export function registerRegistrationDraftHandlers(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  service: RegistrationDraftService,
): void {
  const { validated } = createIpcRegistrar(getWindow, rendererLocation, {
    invalidRequest: '등록 초안 요청 항목을 확인해 주세요.',
    unexpected: {
      code: 'registration_draft_unavailable',
      message:
        '등록 초안을 보관하거나 복원하지 못했습니다. 현재 입력과 기존 초안은 보존됩니다.',
    },
  });
  validated(contracts.get, service.get.bind(service));
  validated(contracts.save, service.save.bind(service));
  validated(contracts.clear, service.clear.bind(service));
}
