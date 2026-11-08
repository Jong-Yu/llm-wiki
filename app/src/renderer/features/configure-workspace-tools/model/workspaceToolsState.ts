import type {
  ConnectionResult,
  ConnectionProtection,
} from '@contracts/connection.contract';

export type ToolsFailure = { title: string; detail: string };
type ConnectionFailure = Extract<ConnectionResult, { ok: false }>['error'];

/** 원문 오류나 토큰을 화면에 재출력하지 않고 공개 오류 코드로 다음 행동을 안내합니다. */
export function describeToolsConnectionFailure(
  error: ConnectionFailure,
): ToolsFailure {
  if (error.code === 'auth_outcome_unknown' || error.status === 409)
    return { title: '로그인·가입 확인', detail: error.message };
  if (error.code === 'unauthorized' || error.status === 401)
    return {
      title: '로그인 정보를 확인해 주세요',
      detail:
        '로그인을 확인할 수 없습니다. 가입한 이름으로 다시 로그인해 주세요.',
    };
  if (error.code === 'forbidden' || error.status === 403)
    return {
      title: '작업 공간 접근 권한이 없습니다',
      detail:
        '연결 설정에서 작업 공간을 확인하거나 서버 운영자에게 권한을 요청하세요.',
    };
  if (error.code === 'invalid_url' || error.code === 'invalid_request')
    return {
      title: '연결 입력을 확인해 주세요',
      detail: '이름과 서버 주소를 다시 확인해 주세요.',
    };
  if (error.code === 'protection_delete_failed')
    return {
      title: '저장된 인증정보를 삭제하지 못했습니다',
      detail:
        '로그아웃했지만 저장된 로그인이 남아 있을 수 있습니다. 로그아웃을 다시 시도해 주세요.',
    };
  if (error.code === 'recovery_delete_failed')
    return {
      title: '이 PC의 복구 자료를 지우지 못했습니다',
      detail: '로그아웃은 완료됐습니다. 이 PC에 복구 자료가 남아 있습니다.',
    };
  if (error.code.startsWith('protection_'))
    return {
      title: '저장한 연결을 복원하지 못했습니다',
      detail: '이름과 서버 주소로 다시 로그인해 주세요.',
    };
  return {
    title: '문서 서버에 연결하지 못했습니다',
    detail: '서버 주소와 인터넷 연결을 확인한 뒤 다시 로그인해 주세요.',
  };
}

/** 활성 연결의 저장 여부와 과거 저장 파일 존재 여부를 구분합니다. */
export function describeToolsProtection(
  protection: ConnectionProtection | undefined,
): ToolsFailure | null {
  if (!protection) return null;
  if (protection.issue !== 'none')
    return {
      title: '로그인 저장 상태를 확인해 주세요',
      detail: protection.remembered
        ? '로그인은 저장됐지만 저장 상태를 확인하는 중 문제가 생겼습니다.'
        : '로그인을 저장하지 못했습니다. 다시 로그인해 주세요.',
    };
  if (protection.availability === 'session_only')
    return {
      title: '다음에 앱을 열 때 다시 로그인해 주세요',
      detail: '이 PC에서는 로그인을 저장할 수 없습니다.',
    };
  return null;
}
