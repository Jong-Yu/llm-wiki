import type {
  RegistrationDraftGetRequest,
  RegistrationDraftSaveRequest,
  RegistrationDraftClearRequest,
  RegistrationDraftResult,
  RegistrationDraftsBridge,
} from '@contracts/registrationDrafts.contract';

/** 편집 초안은 renderer 일반 저장소 대신 main의 보호된 저장소를 사용합니다. */
function getBridge(): RegistrationDraftsBridge {
  if (!window.wiki?.registrationDrafts)
    throw new Error(
      '등록 초안 복원을 사용하려면 최신 데스크톱 앱에서 실행해 주세요.',
    );
  return window.wiki.registrationDrafts;
}

/** 구버전에서는 메모리 편집과 디스크 보관 지원 여부를 구분합니다. */
export function hasRegistrationDraftBridge(): boolean {
  return !!window.wiki?.registrationDrafts;
}

export const registrationDraftsGateway: RegistrationDraftsBridge = {
  get: (
    request: RegistrationDraftGetRequest,
  ): Promise<RegistrationDraftResult> => getBridge().get(request),
  save: (
    request: RegistrationDraftSaveRequest,
  ): Promise<RegistrationDraftResult> => getBridge().save(request),
  clear: (
    request: RegistrationDraftClearRequest,
  ): Promise<RegistrationDraftResult> => getBridge().clear(request),
};
