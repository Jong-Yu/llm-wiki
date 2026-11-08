/** 서버가 응답한 적이 있는지 읽기 요청 결과로만 모아, 연결 끊김 안내가 거짓으로 뜨지 않게 합니다. */

const unreachableAfter = 2;
let consecutiveFailures = 0;

/** HTTP 응답이 한 번이라도 오면(오류 상태 포함) 서버에 닿는 것으로 보고 실패 횟수를 지웁니다. */
export function recordServerResponse(): void {
  consecutiveFailures = 0;
}

/** 네트워크 오류나 시간 초과만 센다. 사용자가 취소한 요청은 세지 않습니다. */
export function recordServerFailure(): void {
  consecutiveFailures += 1;
}

/** 연속으로 두 번 이상 서버에 닿지 못했을 때만 끊김으로 봅니다. */
export function isServerUnreachable(): boolean {
  return consecutiveFailures >= unreachableAfter;
}
