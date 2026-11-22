import { useQuery } from '@tanstack/react-query';
import type {
  UseQueryResult,
  QueryFunctionContext,
} from '@tanstack/react-query';
import type {
  TemplateSession,
  TemplateDetail,
  TemplateListResult,
  TemplatesBridge,
} from '@contracts/templates.contract';
import {
  ReadQueryError,
  useReadQueries,
} from '@renderer/shared/lib/readQueries';

type TemplateCatalog = Extract<TemplateListResult, { ok: true }>['data'];

/** 공개 범위와 접근 판본을 모두 키에 담아 다른 공간의 템플릿을 재사용하지 않습니다. */
export function useTemplateCatalogQuery(
  session: TemplateSession,
  gateway: TemplatesBridge,
): UseQueryResult<TemplateCatalog, Error> {
  const { cache, snapshot } = useReadQueries();
  return useQuery({
    queryKey: cache.key('templates', session),
    enabled: !snapshot.failure,
    queryFn: async ({
      signal,
    }: QueryFunctionContext): Promise<TemplateCatalog> => {
      const result = await gateway.list(session);
      signal.throwIfAborted();
      if (!result.ok) throw new ReadQueryError(result.error);
      return result.data;
    },
  });
}

/** 편집의 기준 판본은 폼이 별도로 보존하고 읽기 캐시는 최신 상세만 갱신합니다. */
export function useTemplateQuery(
  session: TemplateSession,
  templateId: string | null,
  gateway: TemplatesBridge,
  revision?: string,
): UseQueryResult<TemplateDetail, Error> {
  const { cache, snapshot } = useReadQueries();
  return useQuery({
    queryKey: cache.key('template', session, templateId, revision),
    enabled: !!templateId && !snapshot.failure,
    queryFn: async ({
      signal,
    }: QueryFunctionContext): Promise<TemplateDetail> => {
      if (!templateId) throw new Error('템플릿을 선택해 주세요.');
      const result = await gateway.read({
        ...session,
        templateId,
        ...(revision ? { revision } : {}),
      });
      signal.throwIfAborted();
      if (!result.ok) throw new ReadQueryError(result.error);
      return result.data;
    },
  });
}

/** 목록과 채팅이 같은 파일 형식 이름을 표시합니다. */
export function templateFileType(filename: string): string {
  const extension = filename.includes('.') ? filename.split('.').pop() : '';
  return extension?.toLocaleUpperCase() || '파일';
}
