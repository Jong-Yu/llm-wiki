import {
  templateSessionSchema,
  templateChooseFileSchema,
  templateReadRequestSchema,
  templateSaveRequestSchema,
  templateArchiveRequestSchema,
  templateOriginalRequestSchema,
  templatePrepareResultRequestSchema,
  templateDownloadResultRequestSchema,
  templateListResultSchema,
  templateDetailResultSchema,
  templateFileResultSchema,
  templatePreparedResultResultSchema,
  templateDownloadResultSchema,
} from '@contracts/templates.contract';
import type {
  TemplatesBridge,
  TemplateSession,
  TemplateChooseFileRequest,
  TemplateReadRequest,
  TemplateSaveRequest,
  TemplateArchiveRequest,
  TemplateOriginalRequest,
  TemplatePrepareResultRequest,
  TemplateDownloadResultRequest,
  TemplateListResult,
  TemplateDetailResult,
  TemplateFileResult,
  TemplatePreparedResultResult,
  TemplateDownloadResult,
} from '@contracts/templates.contract';

/** 템플릿은 허용된 bridge를 통해서만 읽고 파일 경로·바이트는 main이 관리합니다. */
function bridge(): TemplatesBridge {
  if (!window.wiki?.templates)
    throw new Error('템플릿 기능을 사용할 수 있는 앱에서 다시 실행해 주세요.');
  return window.wiki.templates;
}

/** 범위와 응답 형식을 검사하며 등록 파일을 일반 첨부로 변환하지 않습니다. */
export const templatesGateway: TemplatesBridge = {
  list: async (request: TemplateSession): Promise<TemplateListResult> =>
    templateListResultSchema.parse(
      await bridge().list(templateSessionSchema.parse(request)),
    ),
  read: async (request: TemplateReadRequest): Promise<TemplateDetailResult> =>
    templateDetailResultSchema.parse(
      await bridge().read(templateReadRequestSchema.parse(request)),
    ),
  chooseFile: async (
    request: TemplateChooseFileRequest,
  ): Promise<TemplateFileResult> =>
    templateFileResultSchema.parse(
      await bridge().chooseFile(templateChooseFileSchema.parse(request)),
    ),
  save: async (request: TemplateSaveRequest): Promise<TemplateDetailResult> =>
    templateDetailResultSchema.parse(
      await bridge().save(templateSaveRequestSchema.parse(request)),
    ),
  archive: async (
    request: TemplateArchiveRequest,
  ): Promise<TemplateDetailResult> =>
    templateDetailResultSchema.parse(
      await bridge().archive(templateArchiveRequestSchema.parse(request)),
    ),
  downloadOriginal: async (
    request: TemplateOriginalRequest,
  ): Promise<TemplateDownloadResult> =>
    templateDownloadResultSchema.parse(
      await bridge().downloadOriginal(
        templateOriginalRequestSchema.parse(request),
      ),
    ),
  prepareResult: async (
    request: TemplatePrepareResultRequest,
  ): Promise<TemplatePreparedResultResult> =>
    templatePreparedResultResultSchema.parse(
      await bridge().prepareResult(
        templatePrepareResultRequestSchema.parse(request),
      ),
    ),
  downloadResult: async (
    request: TemplateDownloadResultRequest,
  ): Promise<TemplateDownloadResult> =>
    templateDownloadResultSchema.parse(
      await bridge().downloadResult(
        templateDownloadResultRequestSchema.parse(request),
      ),
    ),
};
