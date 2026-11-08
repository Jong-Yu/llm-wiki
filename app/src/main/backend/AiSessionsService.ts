import type {
  AiActivity,
  AiSessionsRequest,
  AiSessionsResult,
} from '@contracts/aiSessions.contract';
import type { ConnectionService } from './ConnectionService';
import { AccountUsageService } from './AccountUsageService';
import { apiFailure } from './readApi';

type ActivitySource = {
  activities: () => AiActivity[];
  readonly activeCount: number;
};
/** 현재 인증 범위에서만 로컬 실행 상태와 개인 계정 한도를 공개합니다. */
export class AiSessionsService {
  readonly #connection: Pick<
    ConnectionService,
    'analysisContext' | 'isAnalysisCurrent' | 'onScopeChanged'
  >;
  readonly #sources: ActivitySource[];
  readonly #usage: AccountUsageService;
  constructor(
    connection: Pick<
      ConnectionService,
      'analysisContext' | 'isAnalysisCurrent' | 'onScopeChanged'
    >,
    sources: ActivitySource[],
    usage: AccountUsageService = new AccountUsageService(),
  ) {
    this.#connection = connection;
    this.#sources = sources;
    this.#usage = usage;
    connection.onScopeChanged((): void => usage.clear());
  }

  /** 접수와 실행 수는 종료 확인에만 사용하고 계정 사용량과 구분합니다. */
  get activeCount(): number {
    return this.#sources.reduce(
      (sum: number, source: ActivitySource): number => sum + source.activeCount,
      0,
    );
  }

  /** 늦게 도착한 이전 연결의 사용량 응답은 공개하지 않습니다. */
  async read(request: AiSessionsRequest): Promise<AiSessionsResult> {
    const context = await this.#connection.analysisContext(
      request.connectionId,
    );
    if ('ok' in context) return context;
    const usage = await this.#usage.read(request.refreshUsage);
    if (!this.#connection.isAnalysisCurrent(context))
      return apiFailure(
        'scope_changed',
        '연결이 바뀌었습니다. 현재 계정에서 다시 확인해 주세요.',
      );
    return {
      ok: true,
      data: {
        activities: this.#sources
          .flatMap((source: ActivitySource): AiActivity[] =>
            source.activities(),
          )
          .filter(
            (activity: AiActivity): boolean =>
              activity.connectionId === request.connectionId,
          ),
        usage,
      },
    };
  }
}
