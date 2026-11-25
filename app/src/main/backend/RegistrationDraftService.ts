import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  registrationDraftIdentitySchema,
  registrationDraftSchema,
  registrationDraftGetSchema,
  registrationDraftSaveSchema,
  registrationDraftClearSchema,
} from '@contracts/registrationDrafts.contract';
import type {
  RegistrationDraftIdentity,
  RegistrationDraft,
  RegistrationDraftGetRequest,
  RegistrationDraftSaveRequest,
  RegistrationDraftClearRequest,
  RegistrationDraftResult,
} from '@contracts/registrationDrafts.contract';
import type { RecoveryEntry } from '@contracts/recovery.contract';
import type { ProcessRecovery } from './processRecovery';

const storedSchema = z.strictObject({
  version: z.literal(1),
  identity: registrationDraftIdentitySchema,
  chunks: z
    .array(z.strictObject({ key: z.string(), revision: z.string() }))
    .nullable(),
  cleared: z.enum(['registered', 'discarded']).nullable(),
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const chunkSchema = z.strictObject({
  version: z.literal(1),
  text: z.string(),
});
type StoredDraft = z.infer<typeof storedSchema>;
type LocatedDraft = {
  entry: RecoveryEntry;
  value: StoredDraft;
  draft: RegistrationDraft | null;
};
type LoadedDraft = { found: LocatedDraft | null; entries: RecoveryEntry[] };
type Recovery = Pick<ProcessRecovery, 'execute'>;

/** 인증정보나 본문이 파일 이름에 들어가지 않도록 고정된 참조만 해시합니다. */
function hash(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key: string, item: unknown): unknown => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item))
          return Object.fromEntries(
            Object.entries(item).sort(
              ([left]: [string, unknown], [right]: [string, unknown]): number =>
                left.localeCompare(right),
            ),
          );
        return item;
      }),
    )
    .digest('hex');
}

/** 입력 객체의 키 순서와 연결 ID가 바뀌어도 같은 불변 원본을 찾습니다. */
function identity(
  request: RegistrationDraftIdentity,
): RegistrationDraftIdentity {
  return registrationDraftIdentitySchema.parse({
    workflowId: request.workflowId,
    sourceRef: request.sourceRef,
    conversionRef: request.conversionRef,
  });
}

/** 실패해도 현재 편집값과 이전 암호문은 그대로 보존됩니다. */
function failure(code: string): RegistrationDraftResult {
  return {
    ok: false,
    error: {
      code,
      message: `등록 초안을 보관하거나 복원하지 못했습니다 (${code}). 현재 입력과 기존 초안은 보존되어 있습니다.`,
    },
  };
}

/** 삭제 표시에는 본문을 남기지 않되 CAS를 유지해 늦은 자동 저장의 부활을 막습니다. */
function success(
  located: LocatedDraft | null,
  cleanupWarningCount: number = 0,
): RegistrationDraftResult {
  return {
    ok: true,
    data: {
      draft: located?.draft ?? null,
      revision: located?.entry.revision ?? null,
      savedAt: located?.entry.savedAt ?? null,
      cleared: located?.value.cleared ?? null,
      cleanupWarningCount,
    },
  };
}

/** 서버 본문을 바꾸지 않고 같은 인증 범위의 등록 입력만 OS 보호 저장소에 보관합니다. */
export class RegistrationDraftService {
  readonly #recovery: Recovery;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(recovery: Recovery) {
    this.#recovery = recovery;
  }

  /** 같은 창의 연속 요청은 직렬화하고 다른 프로세스의 쓰기는 디스크 CAS로 검사합니다. */
  #serial(
    operation: () => Promise<RegistrationDraftResult>,
  ): Promise<RegistrationDraftResult> {
    const task = this.#queue.then(
      async (): Promise<RegistrationDraftResult> => {
        try {
          return await operation();
        } catch {
          return failure('registration_draft_unavailable');
        }
      },
    );
    this.#queue = task;
    return task;
  }

  /** 매 요청에서 현재 계정·관점·접근 판본을 RecoveryService가 다시 확인합니다. */
  async #read(
    request: RegistrationDraftGetRequest,
  ): Promise<LoadedDraft | RegistrationDraftResult> {
    const result = await this.#recovery.execute({
      connectionId: request.connectionId,
      expectedScope: request.expectedScope,
      operation: 'list',
      kind: 'registration-drafts',
    });
    if (!result.ok) return result;
    const fixed = identity(request);
    const key = hash(fixed);
    const entry = result.data.entries.find(
      (item: RecoveryEntry): boolean => item.key === key,
    );
    if (!entry) return { found: null, entries: result.data.entries };
    const parsed = storedSchema.safeParse(JSON.parse(entry.payload));
    if (
      !parsed.success ||
      hash(parsed.data.identity) !== key ||
      (parsed.data.chunks === null) === (parsed.data.cleared === null)
    )
      return failure('registration_draft_corrupt');
    const chunks: string[] = [];
    for (const reference of parsed.data.chunks ?? []) {
      const part = result.data.entries.find(
        (item: RecoveryEntry): boolean =>
          item.key === reference.key && item.revision === reference.revision,
      );
      if (!part) return failure('registration_draft_corrupt');
      chunks.push(chunkSchema.parse(JSON.parse(part.payload)).text);
    }
    const draft = parsed.data.chunks
      ? registrationDraftSchema.parse(JSON.parse(chunks.join('')))
      : null;
    return {
      found: { entry, value: parsed.data, draft },
      entries: result.data.entries,
    };
  }

  /** 조회는 초안을 복원할 뿐 저장·등록·AI 실행을 시작하지 않습니다. */
  get(value: RegistrationDraftGetRequest): Promise<RegistrationDraftResult> {
    return this.#serial(async (): Promise<RegistrationDraftResult> => {
      const parsed = registrationDraftGetSchema.safeParse(value);
      if (!parsed.success) return failure('invalid_request');
      const found = await this.#read(parsed.data);
      return 'ok' in found ? found : success(found.found);
    });
  }

  /** 원래 기준과 요청 ID를 보존하며 충돌한 편집을 최신 판본으로 바꿔 저장하지 않습니다. */
  save(value: RegistrationDraftSaveRequest): Promise<RegistrationDraftResult> {
    return this.#serial(async (): Promise<RegistrationDraftResult> => {
      const parsed = registrationDraftSaveSchema.safeParse(value);
      if (!parsed.success) return failure('invalid_request');
      return this.#mutate(parsed.data, 'save');
    });
  }

  /** 성공 등록 또는 사용자의 명시 폐기만 본문 없는 종료 표시를 저장합니다. */
  clear(
    value: RegistrationDraftClearRequest,
  ): Promise<RegistrationDraftResult> {
    return this.#serial(async (): Promise<RegistrationDraftResult> => {
      const parsed = registrationDraftClearSchema.safeParse(value);
      if (!parsed.success) return failure('invalid_request');
      return this.#mutate(parsed.data, 'clear');
    });
  }

  /** 응답 유실 재시도는 같은 결과를 돌려주고 다른 요청·이전 revision은 거부합니다. */
  async #mutate(
    request: RegistrationDraftSaveRequest | RegistrationDraftClearRequest,
    operation: 'save' | 'clear',
  ): Promise<RegistrationDraftResult> {
    const loaded = await this.#read(request);
    if ('ok' in loaded) return loaded;
    const found = loaded.found;
    const fixed = identity(request);
    const draft = 'draft' in request ? request.draft : null;
    const cleared = 'reason' in request ? request.reason : null;
    const requestHash = hash({
      operation,
      identity: fixed,
      expectedRevision: request.expectedRevision,
      draft,
      cleared,
    });
    if (found?.value.requestId === request.requestId)
      return found.value.requestHash === requestHash
        ? success(found)
        : failure('registration_draft_request_conflict');
    if ((found?.entry.revision ?? null) !== request.expectedRevision)
      return failure('recovery_conflict');
    if (found?.value.cleared === 'registered')
      return failure('registration_draft_closed');
    if (
      draft &&
      found?.draft &&
      (draft.basisRevision !== found.draft.basisRevision ||
        hash(draft.basisContents) !== hash(found.draft.basisContents))
    )
      return failure('registration_draft_basis_conflict');
    const written: RecoveryEntry[] = [];
    let chunkWarnings = 0;
    // 각 조각은 기존 8 MiB entry 경계 안에서 보관하고 마지막 manifest CAS 전에는 공개하지 않습니다.
    if (draft) {
      const plain = JSON.stringify(draft);
      const chunkLength = 512 * 1024;
      const attemptId = randomUUID().replaceAll('-', '');
      for (let offset = 0; offset < plain.length; offset += chunkLength) {
        const key = `${hash(fixed)}:${attemptId}:${offset / chunkLength}`;
        const payload = JSON.stringify({
          version: 1,
          text: plain.slice(offset, offset + chunkLength),
        });
        const part = await this.#recovery.execute({
          connectionId: request.connectionId,
          expectedScope: request.expectedScope,
          operation: 'put',
          kind: 'registration-drafts',
          key,
          payload,
          expectedRevision: null,
        });
        if (!part.ok) {
          await this.#cleanup(request, written);
          return part;
        }
        chunkWarnings += part.data.cleanupWarningCount;
        const entry = part.data.entries.find(
          (item: RecoveryEntry): boolean => item.key === key,
        );
        if (!entry) {
          await this.#cleanup(request, written);
          return failure('registration_draft_write_unconfirmed');
        }
        written.push(entry);
      }
    }
    const stored: StoredDraft = {
      version: 1,
      identity: fixed,
      chunks: draft
        ? written.map(
            (entry: RecoveryEntry): { key: string; revision: string } => ({
              key: entry.key,
              revision: entry.revision,
            }),
          )
        : null,
      cleared,
      requestId: request.requestId,
      requestHash,
    };
    const result = await this.#recovery.execute({
      connectionId: request.connectionId,
      expectedScope: request.expectedScope,
      operation: 'put',
      kind: 'registration-drafts',
      key: hash(fixed),
      payload: JSON.stringify(stored),
      expectedRevision: request.expectedRevision,
    });
    if (!result.ok) {
      await this.#cleanup(request, written);
      return result;
    }
    const entry = result.data.entries.find(
      (item: RecoveryEntry): boolean => item.key === hash(fixed),
    );
    const old = (found?.value.chunks ?? []).flatMap(
      (part: { key: string; revision: string }): RecoveryEntry[] => {
        const item = loaded.entries.find(
          (candidate: RecoveryEntry): boolean =>
            candidate.key === part.key && candidate.revision === part.revision,
        );
        return item ? [item] : [];
      },
    );
    const cleanupWarnings = await this.#cleanup(request, old);
    return entry
      ? success(
          { entry, value: stored, draft },
          result.data.cleanupWarningCount + cleanupWarnings + chunkWarnings,
        )
      : failure('registration_draft_write_unconfirmed');
  }

  /** 연결된 옛 조각 또는 이번 요청이 만든 미연결 조각만 관측한 CAS로 정리합니다. */
  async #cleanup(
    request: RegistrationDraftGetRequest,
    entries: RecoveryEntry[],
  ): Promise<number> {
    let warnings = 0;
    for (const entry of entries) {
      try {
        const result = await this.#recovery.execute({
          connectionId: request.connectionId,
          expectedScope: request.expectedScope,
          operation: 'remove',
          kind: 'registration-drafts',
          key: entry.key,
          expectedRevision: entry.revision,
        });
        warnings += result.ok ? result.data.cleanupWarningCount : 1;
      } catch {
        warnings += 1;
      }
    }
    return warnings;
  }
}
