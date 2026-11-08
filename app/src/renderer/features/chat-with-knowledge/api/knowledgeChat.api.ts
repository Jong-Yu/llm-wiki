import { sameAccessRevision } from '@contracts/connection.contract';
import { z } from 'zod';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { isDocumentPath } from '@contracts/documents.contract';
import type {
  QuestionDetail,
  QuestionDetailResult,
  QuestionSession,
} from '@contracts/questionRuns.contract';
import { markdownExportRequestSchema } from '@contracts/fileExports.contract';
import type {
  ExportFormat,
  MarkdownExportResult,
} from '@contracts/fileExports.contract';
import type { AiProvider, RuntimeSnapshot } from '@contracts/runtime.contract';
import type {
  WorkspaceOperation,
  WorkspaceRequest,
  WorkspaceScope,
} from '@contracts/workspace.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { questionRunsGateway } from '@renderer/platform/questionRuns';
import { exportMarkdownFile } from '@renderer/platform/fileExports';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { executeRuntime } from '@renderer/platform/runtime';
import { workspaceGateway } from '@renderer/platform/workspace';
import {
  LINK_SEEDS,
  composeDocuments,
  discoveryTerms,
  linkedDocuments,
  mergeTerms,
  rankDocuments,
  searchBrief,
} from './chatDiscovery';

export type ChatAccess = {
  session: QuestionSession;
  permissions: string[];
};
export type ChatDiscovery = {
  documents: string[];
  partial: boolean;
  queries: string[];
  /** 문서 간 명시 링크 덕분에 새로 포함된 문서 수입니다. */
  linked: number;
};

/** 요청 실패와 저장 결과 미확인을 구분하여 재시도 의도를 보존합니다. */
export class ChatRequestError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly unknownOutcome: boolean;

  constructor(
    code: string,
    message: string,
    status?: number,
    unknownOutcome: boolean = false,
  ) {
    super(message);
    this.name = 'ChatRequestError';
    this.code = code;
    this.status = status;
    this.unknownOutcome = unknownOutcome;
  }
}

const readOperations = new Set<WorkspaceOperation>([
  'search',
  'ontology',
  'connections',
  'context',
  'conceptFind',
  'conceptQuery',
  'impact',
  'reviewQueue',
  'history',
  'questionContext',
  'documentVersions',
  'documentVersion',
  'conversations',
  'conversation',
  'savedResults',
  'savedResult',
  'comparisons',
  'comparison',
  'personalReceipt',
  'correspondenceFind',
  'correspondenceQuery',
  'correspondencePrepare',
  'extraction',
  'extractionContent',
  'artifactReceipt',
  'conversion',
  'analysisPlan',
  'validateAnalysisPlan',
  'analysisPlanReceipt',
]);
const connectionsSchema = z.object({
  explicit_links: z.array(
    z.object({
      source_document: z.string().refine(isDocumentPath),
      target_document: z.string().refine(isDocumentPath),
      target_status: z.string(),
    }),
  ),
  truncated: z.boolean(),
});
const searchSchema = z.object({
  matches: z.array(
    z.object({
      document: z.string().refine(isDocumentPath),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      snippet: z.string(),
    }),
  ),
  truncated: z.boolean(),
  skipped: z.array(z.object({ document: z.string(), code: z.string() })),
  scanned: z.number().int().nonnegative(),
});

/** 현재 연결의 사용자·tenant·관점과 권한을 함께 고정합니다. */
export async function loadChatAccess(): Promise<ChatAccess> {
  try {
    const result = await connectionGateway.getState();
    if (!result.ok)
      throw new ChatRequestError(result.error.code, result.error.message);
    const current = result.data;
    if (current.status !== 'connected' || !current.selection)
      throw new ChatRequestError(
        'connection_required',
        '서버와 작업 공간을 연결한 뒤 질문해 주세요.',
      );
    const selection = current.selection;
    const workspace = current.workspaces.find(
      (item: (typeof current.workspaces)[number]): boolean =>
        item.id === selection.tenant,
    );
    if (
      !workspace ||
      !workspace.profiles.some(
        (profile: (typeof workspace.profiles)[number]): boolean =>
          profile.id === selection.profile,
      )
    )
      throw new ChatRequestError(
        'scope_changed',
        '현재 연결과 작업 공간을 다시 확인해 주세요.',
      );
    return {
      session: {
        connectionId: current.connectionId,
        expectedScope: {
          userId: current.userId,
          tenant: selection.tenant,
          profileId: selection.profile,
          policyRevision: current.policyRevision,
          ...(current.accessRevision
            ? { accessRevision: current.accessRevision }
            : {}),
        },
      },
      permissions: [...workspace.permissions],
    };
  } catch (error: unknown) {
    if (error instanceof ChatRequestError) throw error;
    throw new ChatRequestError(
      'bridge_unavailable',
      '현재 앱의 서버 연결을 확인할 수 없습니다.',
    );
  }
}

/** 같은 사용자와 허용 범위의 응답만 이전 질문에 연결합니다. */
function matchesScope(left: WorkspaceScope, right: WorkspaceScope): boolean {
  return (
    left.userId === right.userId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    sameAccessRevision(left, right)
  );
}

/** main의 업무 API를 사용하고 응답 유실 때 쓰기를 다시 보내지 않습니다. */
export async function requestChat(
  request: WorkspaceRequest,
): Promise<KnowledgeValue> {
  const before = await loadChatAccess();
  const expected = request.expectedScope ?? before.session.expectedScope;
  if (
    request.connectionId !== before.session.connectionId ||
    !matchesScope(expected, before.session.expectedScope)
  )
    throw new ChatRequestError(
      'scope_changed',
      '연결 또는 작업 공간이 변경되었습니다. 현재 연결에서 다시 열어 주세요.',
    );
  const mutation = !readOperations.has(request.operation);
  let dispatched = false;
  try {
    dispatched = true;
    const result = await workspaceGateway.execute({
      ...request,
      expectedScope: expected,
    });
    if (!result.ok)
      throw new ChatRequestError(
        result.error.code,
        result.error.message,
        result.error.status,
        mutation &&
          (result.error.retry === 'reconcile' ||
            result.error.code === 'outcome_unknown' ||
            result.error.code === 'invalid_response' ||
            result.error.status === undefined ||
            result.error.status >= 500),
      );
    let after: ChatAccess;
    try {
      after = await loadChatAccess();
    } catch (error: unknown) {
      if (error instanceof ChatRequestError)
        throw new ChatRequestError(
          error.code,
          error.message,
          error.status,
          mutation,
        );
      throw error;
    }
    if (
      after.session.connectionId !== request.connectionId ||
      !matchesScope(after.session.expectedScope, expected) ||
      result.data.connectionId !== request.connectionId ||
      !matchesScope(result.data.access, expected)
    )
      throw new ChatRequestError(
        'scope_changed',
        mutation
          ? '응답 전에 연결 범위가 바뀌었습니다. 이전 범위의 같은 요청으로 저장 여부를 확인해 주세요.'
          : '연결 범위가 달라져 이전 응답을 표시하지 않습니다.',
        403,
        mutation,
      );
    if (result.data.operation !== request.operation)
      throw new ChatRequestError(
        'invalid_response',
        '요청한 작업과 응답이 일치하지 않습니다. 같은 요청의 기록을 확인해 주세요.',
        undefined,
        mutation,
      );
    return result.data.data;
  } catch (error: unknown) {
    if (error instanceof ChatRequestError) {
      // 전송 뒤 연결 조회가 실패하면 저장되지 않았다고 단정할 수 없습니다.
      if (mutation && dispatched && error.code === 'bridge_unavailable')
        throw new ChatRequestError(
          error.code,
          error.message,
          error.status,
          true,
        );
      throw error;
    }
    throw new ChatRequestError(
      mutation ? 'outcome_unknown' : 'bridge_unavailable',
      mutation
        ? '저장 응답을 확인하지 못했습니다. 같은 요청으로 확인해 주세요.'
        : '현재 연결에서 자료를 읽을 수 없습니다.',
      undefined,
      mutation && dispatched,
    );
  }
}

/** 개인 CLI의 검증된 상세만 전달하며 IPC 예외는 실행 결과 미확인으로 남깁니다. */
export async function runChat(
  operation: () => Promise<QuestionDetailResult>,
): Promise<QuestionDetail> {
  try {
    const result = await operation();
    if (!result.ok)
      throw new ChatRequestError(
        result.error.code,
        result.error.message,
        result.error.status,
        result.error.code === 'outcome_unknown' ||
          result.error.code === 'invalid_response' ||
          (result.error.status !== undefined && result.error.status >= 500),
      );
    return result.data;
  } catch (error: unknown) {
    if (error instanceof ChatRequestError) throw error;
    throw new ChatRequestError(
      'outcome_unknown',
      '개인 AI 실행 응답을 확인하지 못했습니다. 실행 상태를 조회해 주세요.',
      undefined,
      true,
    );
  }
}

/** 선택한 AI에게 질문 문장만 보내 동의어까지 풀어 받습니다. 실패하면 빈 목록으로 기존 검색을 계속합니다. */
async function expandedTerms(
  session: QuestionSession,
  question: string,
  material: string,
): Promise<string[]> {
  try {
    const result = await questionRunsGateway.searchTerms({
      ...session,
      question: searchBrief(question, material),
    });
    return result.terms;
  } catch {
    return [];
  }
}

/** 조사를 뗀 검색어별로 조회하고, 구체적인 검색어가 걸린 문서를 앞에 두어 상위 8개를 고릅니다. */
export async function discoverChatDocuments(
  session: QuestionSession,
  question: string,
  material: string = '',
): Promise<ChatDiscovery> {
  const queries = mergeTerms(
    await expandedTerms(session, question, material),
    discoveryTerms(question),
  );
  const hits = new Map<string, string[]>();
  let partial = false;
  for (const query of queries) {
    const value = await requestChat({
      ...session,
      operation: 'search',
      input: { query, limit: 50 },
    });
    const parsed = searchSchema.safeParse(value);
    if (!parsed.success)
      throw new ChatRequestError(
        'invalid_response',
        '문서 검색 응답의 구조를 확인할 수 없습니다. 질문은 보존했습니다.',
      );
    partial ||= parsed.data.truncated || parsed.data.skipped.length > 0;
    hits.set(
      query,
      parsed.data.matches.map(
        (match: (typeof parsed.data.matches)[number]): string => match.document,
      ),
    );
  }
  const ranked = rankDocuments(hits);
  // 상위 문서와 명시 링크로 이어진 문서를 함께 읽습니다. 링크 조회는 부가 단계라 실패해도 검색 결과로 계속합니다.
  const linkedBySeed: string[][] = [];
  for (const seed of ranked.slice(0, LINK_SEEDS)) {
    try {
      const value = await requestChat({
        ...session,
        operation: 'connections',
        input: { document: seed, limit: 20 },
      });
      const parsed = connectionsSchema.safeParse(value);
      if (!parsed.success) {
        partial = true;
        continue;
      }
      partial ||= parsed.data.truncated;
      linkedBySeed.push(linkedDocuments(seed, parsed.data.explicit_links));
    } catch (reason: unknown) {
      // 권한·연결 범위 오류는 숨기지 않고 그대로 알립니다.
      if (
        reason instanceof ChatRequestError &&
        (reason.code === 'scope_changed' || reason.code === 'forbidden')
      )
        throw reason;
      partial = true;
    }
  }
  const composed = composeDocuments(ranked, linkedBySeed);
  return {
    documents: composed.documents,
    partial: partial || ranked.length > 8,
    queries,
    linked: composed.added,
  };
}

/** 현재 제공자와 실제 설치 진단을 읽으며 모델 호출은 시작하지 않습니다. */
export async function readChatRuntime(
  diagnose: boolean = false,
): Promise<RuntimeSnapshot> {
  try {
    if (!diagnose) return await useAiConnection.readSnapshot();
    const snapshot = await executeRuntime({ operation: 'diagnose' });
    useAiConnection.update(snapshot);
    return snapshot;
  } catch {
    throw new ChatRequestError(
      'runtime_unavailable',
      '개인 AI 실행 환경을 확인할 수 없습니다. 설정에서 AI 연결을 확인해 주세요.',
    );
  }
}

/** 고른 모델을 바로 저장해 다음 질문부터 쓰며, 저장된 결과의 실행 설정을 돌려받습니다. */
export async function selectChatModel(
  provider: AiProvider,
  model: string,
): Promise<RuntimeSnapshot> {
  try {
    const snapshot = await executeRuntime({
      operation: 'select-model',
      provider,
      model,
    });
    useAiConnection.update(snapshot);
    return snapshot;
  } catch {
    throw new ChatRequestError(
      'model_unavailable',
      '모델을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
    );
  }
}

/** 질문 실행 연결은 이 adapter에서만 공개하고 인증·프로세스는 main에 둡니다. */
export const chatRunsApi = questionRunsGateway;

/** 내 폴더(개인 결과물)에 저장된 답변입니다. */
export type AnswerArtifact = { id: string; title: string; content: string };
const answerArtifactSchema = z.object({
  record: z.object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    kind: z.literal('saved-results'),
    tenant: z.string(),
    user_id: z.string(),
    data: z.object({ title: z.string(), content: z.string() }),
    requests: z.record(z.string(), z.string()),
  }),
});

/**
 * 완료된 답변을 내 폴더의 결과물로 한 번만 저장합니다.
 * 요청 ID를 답변 턴 ID로 고정해 재시도·응답 유실에도 같은 결과물을 가리키며,
 * 먼저 영수증을 조회해 이미 있으면 새로 만들지 않습니다. 제목이 달라 충돌하면 기존 기록을 그대로 씁니다.
 */
export async function saveAnswerArtifact(
  session: QuestionSession,
  target: { conversationId: string; turnId: string; title: string },
): Promise<AnswerArtifact> {
  const requestId = target.turnId;
  const accept = (value: KnowledgeValue): AnswerArtifact => {
    const parsed = answerArtifactSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.record.tenant !== session.expectedScope.tenant ||
      parsed.data.record.user_id !== session.expectedScope.userId ||
      !parsed.data.record.requests[requestId]
    )
      throw new ChatRequestError(
        'invalid_response',
        '저장된 결과물을 확인하지 못했습니다.',
      );
    const { id, data } = parsed.data.record;
    return { id, title: data.title, content: data.content };
  };
  const receipt = async (): Promise<AnswerArtifact> =>
    accept(
      await requestChat({
        ...session,
        operation: 'personalReceipt',
        input: { kind: 'saved-results', request_id: requestId },
      }),
    );
  try {
    return await receipt();
  } catch (reason: unknown) {
    if (!(reason instanceof ChatRequestError) || reason.status !== 404)
      throw reason;
  }
  try {
    return accept(
      await requestChat({
        ...session,
        operation: 'createSavedResult',
        input: {
          request_id: requestId,
          title: target.title.slice(0, 200),
          conversation_id: target.conversationId,
          turn_id: target.turnId,
        },
      }),
    );
  } catch (reason: unknown) {
    // 같은 요청이 다른 제목으로 이미 저장된 경우나 응답 유실은 기존 기록 확인으로 마무리합니다.
    if (
      reason instanceof ChatRequestError &&
      (reason.status === 409 || reason.unknownOutcome)
    )
      return await receipt();
    throw reason;
  }
}

/** 답변 본문을 Markdown 파일로 내려받습니다. 현재 연결 범위를 고정하고 서버에는 쓰지 않습니다. */
export async function downloadAnswerMarkdown(
  session: QuestionSession,
  title: string,
  content: string,
  format: ExportFormat = 'md',
): Promise<MarkdownExportResult> {
  const parsed = markdownExportRequestSchema.safeParse({ title, content });
  if (!parsed.success)
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message:
          parsed.error.issues[0]?.message ?? '내려받을 답변을 확인해 주세요.',
      },
    };
  try {
    const current = await loadChatAccess();
    if (
      current.session.connectionId !== session.connectionId ||
      !matchesScope(session.expectedScope, current.session.expectedScope)
    )
      return {
        ok: false,
        error: {
          code: 'scope_changed',
          message: '연결 범위가 바뀌어 내려받기를 중단했습니다.',
        },
      };
    return await exportMarkdownFile({
      ...parsed.data,
      // Markdown은 기존 요청 모양(형식 생략)을 유지합니다.
      ...(format === 'md' ? {} : { format }),
      connectionId: session.connectionId,
      expectedScope: session.expectedScope,
    });
  } catch {
    return {
      ok: false,
      error: {
        code: 'download_failed',
        message: '답변을 내려받지 못했습니다.',
      },
    };
  }
}
