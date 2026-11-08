import type {
  AccountRequest,
  ConnectionResult,
  SelectWorkspaceRequest,
} from '@contracts/connection.contract';
import type {
  RuntimeRequest,
  RuntimeSnapshot,
} from '@contracts/runtime.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { executeRuntime } from '@renderer/platform/runtime';

/** 인증된 공개 상태만 읽으며 이 조회를 서버 재진단으로 취급하지 않습니다. */
export function readToolsConnection(): Promise<ConnectionResult> {
  return connectionGateway.getState();
}

/** 이름 인증과 기본 공간 선택은 main에서 처리합니다. */
export function connectToolsServer(
  request: AccountRequest,
): Promise<ConnectionResult> {
  return connectionGateway.authenticate(request);
}

/** 새 작업 범위의 소속과 권한은 main에서 다시 검증합니다. */
export function selectToolsWorkspace(
  request: SelectWorkspaceRequest,
): Promise<ConnectionResult> {
  return connectionGateway.selectWorkspace(request);
}

/** 저장된 자격 증명은 main이 복호화·권한 확인하며 renderer로 반환하지 않습니다. */
export function restoreToolsConnection(): Promise<ConnectionResult> {
  return connectionGateway.restoreSaved();
}

/** 현재 연결과 로컬 복구 자료에 영향을 주는 명시 로그아웃만 전달합니다. */
export function disconnectToolsServer(): Promise<ConnectionResult> {
  return connectionGateway.disconnect();
}

/** 실행 파일 선택·진단·저장은 기존 main 계약을 사용합니다. */
export function requestToolsRuntime(
  request: RuntimeRequest,
): Promise<RuntimeSnapshot> {
  return executeRuntime(request);
}
