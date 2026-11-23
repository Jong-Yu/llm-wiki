import type {
  DocumentTaskCreateRequest,
  DocumentTaskReadRequest,
  DocumentTaskSession,
  DocumentTaskResult,
  DocumentTaskListResult,
  DocumentTaskDetailResult,
  DocumentTasksBridge,
} from '@contracts/documentTasks.contract';

/** 보호된 기기 작업 기록은 main의 범위 검증을 거쳐서만 읽고 만듭니다. */
function getBridge(): DocumentTasksBridge {
  if (!window.wiki?.documentTasks)
    throw new Error(
      '문서 작업 기록을 읽으려면 최신 데스크톱 앱에서 실행해 주세요.',
    );
  return window.wiki.documentTasks;
}

/** 구버전·격리 검증 bridge에서 작업 기록 지원 여부만 조회합니다. */
export function hasDocumentTaskBridge(): boolean {
  return !!window.wiki?.documentTasks;
}

export const documentTasksGateway: DocumentTasksBridge = {
  create: (request: DocumentTaskCreateRequest): Promise<DocumentTaskResult> =>
    getBridge().create(request),
  list: (request: DocumentTaskSession): Promise<DocumentTaskListResult> =>
    getBridge().list(request),
  read: (request: DocumentTaskReadRequest): Promise<DocumentTaskDetailResult> =>
    getBridge().read(request),
};
