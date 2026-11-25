import type {
  RegistrationDraft,
  RegistrationDraftGetRequest,
  RegistrationDraftResult,
  RegistrationDraftSaveRequest,
  RegistrationDraftClearRequest,
  RegistrationDraftsBridge,
} from '@contracts/registrationDrafts.contract';
import { notificationRequestId } from './notificationView';

/** 저장 순서와 미확인 요청을 고정해 늦은 자동 저장이 더 최신 입력을 덮지 못하게 합니다. */
export class RegistrationDraftController {
  #revision: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #pending: RegistrationDraftSaveRequest | null = null;
  #pendingClear: RegistrationDraftClearRequest | null = null;
  #closed = false;
  readonly identity: RegistrationDraftGetRequest;
  readonly api: RegistrationDraftsBridge;
  constructor(
    identity: RegistrationDraftGetRequest,
    api: RegistrationDraftsBridge,
  ) {
    this.identity = identity;
    this.api = api;
  }

  /** 보호된 디스크 초안을 먼저 읽은 뒤에만 편집을 허용합니다. */
  async read(): Promise<RegistrationDraft | null> {
    const data = this.#data(await this.api.get(this.identity));
    this.#revision = data.revision;
    this.#closed = data.cleared === 'registered';
    return data.draft;
  }

  /** 새 요청 전에 미확인 쓰기를 동일 ID와 기준으로 확인합니다. */
  save(draft: RegistrationDraft): Promise<number> {
    const snapshot = structuredClone(draft);
    const task = this.#queue
      .catch((): void => {})
      .then(async (): Promise<number> => {
        let warnings = this.#pendingClear ? await this.#sendClear() : 0;
        if (this.#closed)
          throw new Error('등록이 완료된 초안에는 다시 저장할 수 없습니다.');
        if (this.#pending) warnings += await this.#send();
        this.#pending = {
          ...this.identity,
          expectedRevision: this.#revision,
          requestId: notificationRequestId(),
          draft: snapshot,
        };
        return warnings + (await this.#send());
      });
    this.#queue = task;
    return task;
  }

  /** 등록 성공 또는 명시 취소 뒤에만 tombstone을 확정합니다. */
  clear(reason: 'registered' | 'discarded'): Promise<number> {
    const task = this.#queue
      .catch((): void => {})
      .then(async (): Promise<number> => {
        const warnings = this.#pending ? await this.#send() : 0;
        if (this.#pendingClear && this.#pendingClear.reason !== reason)
          throw new Error('이전 초안 정리 결과를 먼저 확인해 주세요.');
        this.#pendingClear ??= {
          ...this.identity,
          expectedRevision: this.#revision,
          requestId: notificationRequestId(),
          reason,
        };
        return warnings + (await this.#sendClear());
      });
    this.#queue = task;
    return task;
  }

  /** 저장 실패 시 현재 요청을 버리지 않고 이후 명시 재시도까지 보존합니다. */
  async #send(): Promise<number> {
    if (!this.#pending) return 0;
    const data = this.#data(await this.api.save(this.#pending));
    this.#revision = data.revision;
    this.#pending = null;
    return data.cleanupWarningCount;
  }

  /** 정리 응답이 유실돼도 최초 ID와 CAS로 같은 tombstone만 확인합니다. */
  async #sendClear(): Promise<number> {
    if (!this.#pendingClear) return 0;
    const request = this.#pendingClear;
    const data = this.#data(await this.api.clear(request));
    this.#revision = data.revision;
    this.#closed = request.reason === 'registered';
    this.#pendingClear = null;
    return data.cleanupWarningCount;
  }

  /** 접근 거부와 저장 실패를 성공으로 숨기지 않습니다. */
  #data(
    result: RegistrationDraftResult,
  ): Extract<RegistrationDraftResult, { ok: true }>['data'] {
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }
}
