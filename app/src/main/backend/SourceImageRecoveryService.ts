import { access, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  notificationConversionRefSchema,
  notificationContentSchema,
  notificationRecoverImagesDataSchema,
  notificationSourceSchema,
} from '@contracts/notifications.contract';
import type { NotificationRecoverImagesResult } from '@contracts/notifications.contract';
import type { AnalysisContext, ConnectionService } from './ConnectionService';
import { apiFailure } from './readApi';
import { aiArguments, personalAi } from './personalAi';
import {
  assertPersonalRuntime,
  createPrivateExecution,
  runPersonalCommand,
} from './personalProcess';
import type { PrivateExecution } from './personalProcess';

const unitSchema = z.strictObject({
  unit_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  content: notificationContentSchema.refine(
    (value: string): boolean => !!value.trim(),
  ),
  location: z
    .strictObject({
      kind: z.literal('slides'),
      start: z.number().int().min(1).max(1_000_000),
      end: z.number().int().min(1).max(1_000_000),
    })
    .refine(
      (value: { start: number; end: number }): boolean =>
        value.start === value.end,
    ),
});
const requestSchema = z.strictObject({
  source_ref: notificationSourceSchema,
  conversion_ref: notificationConversionRefSchema,
  units: z
    .array(unitSchema)
    .min(1)
    .max(40)
    .refine(
      (units: ImageRecoveryUnit[]): boolean =>
        new Set(units.map((unit: ImageRecoveryUnit): string => unit.unit_id))
          .size === units.length &&
        new Set(
          units.map((unit: ImageRecoveryUnit): number => unit.location.start),
        ).size === units.length &&
        units.reduce(
          (total: number, unit: ImageRecoveryUnit): number =>
            total + Buffer.byteLength(unit.content, 'utf8'),
          0,
        ) <=
          20 * 1024 * 1024,
    ),
});
const terminalSchema = z.discriminatedUnion('type', [
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('result'),
    ok: z.literal(true),
    source_ref: notificationSourceSchema,
    conversion_ref: notificationConversionRefSchema,
    ...notificationRecoverImagesDataSchema.shape,
  }),
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('error'),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
    }),
  }),
]);
export type ImageRecoveryUnit = z.infer<typeof unitSchema>;
export type ImageRecoveryInput = z.infer<typeof requestSchema>;
type Connection = Pick<
  ConnectionService,
  'isAnalysisCurrent' | 'onScopeChanged'
>;
type Options = { workRoot: string; projectRoot?: string; python?: string };
type Dependencies = {
  selectAi?: typeof personalAi;
  createExecution?: typeof createPrivateExecution;
};

/** 고정 PPTX의 저신뢰 그림을 개인 AI로 읽고 저장 전 후보만 반환합니다. */
export class SourceImageRecoveryService {
  readonly #connection: Connection;
  readonly #options: Options;
  readonly #dependencies: Dependencies;
  #controller: AbortController | null = null;
  #cancelRequested = false;
  #cancelFile: string | null = null;
  #settled: Promise<void> = Promise.resolve();

  constructor(
    connection: Connection,
    options: Options,
    dependencies: Dependencies = {},
  ) {
    this.#connection = connection;
    this.#options = options;
    this.#dependencies = dependencies;
    connection.onScopeChanged((): void => {
      void this.stop();
    });
  }

  /** 협력 취소와 소유 프로세스 종료를 같은 실행에만 전달합니다. */
  async #cancel(): Promise<void> {
    const controller = this.#controller;
    if (controller) this.#cancelRequested = true;
    if (this.#cancelFile)
      await writeFile(this.#cancelFile, '', { mode: 0o600 }).catch(
        (): void => {},
      );
    controller?.abort();
  }

  /** 종료·범위 변경은 개인 실행과 토큰 정리가 끝날 때까지 기다립니다. */
  async stop(): Promise<void> {
    const settled = this.#settled;
    await this.#cancel();
    await settled;
  }

  /** 결과의 고정 원본·변환 판본·전체 단위 집합을 검증한 뒤에만 공개합니다. */
  async run(
    context: AnalysisContext,
    input: ImageRecoveryInput,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<NotificationRecoverImagesResult> {
    if (this.#controller)
      return apiFailure(
        'image_recovery_busy',
        '이미 그림 문자를 복구하고 있습니다.',
      );
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success || !/^[a-f0-9]{32}$/.test(requestId))
      return apiFailure(
        'invalid_image_recovery',
        '고정 원본과 복구할 슬라이드를 확인해 주세요.',
      );
    if (!this.#connection.isAnalysisCurrent(context))
      return apiFailure(
        'scope_changed',
        '작업 공간이나 연결이 변경되었습니다.',
      );
    if (signal?.aborted)
      return apiFailure(
        'image_recovery_cancelled',
        '그림 문자 복구를 취소했습니다.',
      );
    const fixed = parsed.data;
    const controller = new AbortController();
    this.#cancelRequested = false;
    this.#controller = controller;
    let finish: () => void = (): void => {};
    this.#settled = new Promise<void>((done: () => void): void => {
      finish = done;
    });
    const cancel = (): void => {
      void this.#cancel();
    };
    signal?.addEventListener('abort', cancel);
    let execution: PrivateExecution | undefined;
    let cleanupMessage = '';
    let result: NotificationRecoverImagesResult = apiFailure(
      'image_recovery_failed',
      '그림 문자를 복구하지 못했습니다. 원래 내용은 보존되며 직접 수정할 수 있습니다.',
    );
    try {
      const projectRoot =
        this.#options.projectRoot ??
        process.env.WIKI_CLIENT_ROOT ??
        process.env.WIKI_ANALYSIS_PROJECT_ROOT ??
        resolve(import.meta.dirname, '../../..');
      const python =
        this.#options.python ??
        process.env.WIKI_CLIENT_PYTHON ??
        process.env.WIKI_PYTHON ??
        process.env.WIKI_ANALYSIS_PYTHON ??
        join(
          projectRoot,
          process.platform === 'win32'
            ? '.venv/Scripts/python.exe'
            : '.venv/bin/python',
        );
      const runtime = { projectRoot, python };
      await access(python);
      await access(join(projectRoot, 'tools/source_image_recovery_cli.py'));
      await assertPersonalRuntime(runtime);
      const ai = await (this.#dependencies.selectAi ?? personalAi)('analysis');
      if (this.#cancelRequested || controller.signal.aborted)
        throw new Error('cancelled');
      execution = await (
        this.#dependencies.createExecution ?? createPrivateExecution
      )(runtime, this.#options.workRoot, context.token);
      this.#cancelFile = join(execution.directory, 'cancel');
      const requestFile = join(execution.directory, 'request.json');
      await writeFile(requestFile, JSON.stringify(fixed), {
        mode: 0o600,
        flag: 'wx',
      });
      if (
        this.#cancelRequested ||
        controller.signal.aborted ||
        !this.#connection.isAnalysisCurrent(context)
      )
        throw new Error('cancelled');
      const output = await runPersonalCommand(
        runtime,
        [
          '-B',
          '-m',
          'tools.source_image_recovery_cli',
          '--server',
          context.active.serverUrl.replace(/\/api\/v1\/$/, ''),
          '--tenant',
          context.selection.tenant,
          '--profile',
          context.selection.profile,
          '--token-file',
          execution.tokenFile,
          '--work-dir',
          execution.workDirectory,
          '--cancel-file',
          this.#cancelFile,
          '--request-file',
          requestFile,
          '--timeout',
          '240',
          ...aiArguments(ai),
        ],
        {
          maxBytes: 32 * 1024 * 1024,
          timeoutMs: 270_000,
          // Python이 별도 AI 프로세스 그룹을 2초 뒤 강제 회수하고 임시 원본을 정리할 시간을 보장합니다.
          terminateGraceMs: 5_000,
          signal: controller.signal,
        },
      );
      if (output.timedOut || output.tooLarge) throw new Error('output_limit');
      const lines = output.output
        .split('\n')
        .filter((line: string): boolean => !!line.trim());
      if (lines.length !== 1) throw new Error('invalid_terminal');
      const line = lines[0];
      if (!line) throw new Error('missing_terminal');
      const terminal = terminalSchema.parse(JSON.parse(line));
      if (terminal.type === 'error') {
        // 진단 코드만 제한적으로 전달하며 stderr·실행기 설명·토큰은 공개하지 않습니다.
        result = apiFailure(
          terminal.error.code,
          '그림 문자 복구를 완료하지 못했습니다. 원래 내용은 보존됩니다.',
        );
      } else {
        if (
          output.exitCode !== 0 ||
          JSON.stringify(terminal.source_ref) !==
            JSON.stringify(fixed.source_ref) ||
          JSON.stringify(terminal.conversion_ref) !==
            JSON.stringify(fixed.conversion_ref) ||
          terminal.provider !== ai.provider ||
          terminal.units.length !== fixed.units.length ||
          terminal.units.some(
            (unit: { unit_id: string }): boolean =>
              !fixed.units.some(
                (target: ImageRecoveryUnit): boolean =>
                  target.unit_id === unit.unit_id,
              ),
          )
        )
          throw new Error('invalid_recovery_output');
        result = {
          ok: true,
          data: notificationRecoverImagesDataSchema.parse(terminal),
        };
      }
    } catch {
      // 외부 오류 원문은 후보·UI로 전달하지 않고 실패 시 기존 내용을 유지합니다.
    } finally {
      const cleanupWarnings: string[] = [];
      // 고정 본문은 이번 실행의 대조용 사본이므로 자식 종료 뒤 제거합니다.
      try {
        if (execution)
          await rm(join(execution.directory, 'request.json'), { force: true });
      } catch {
        cleanupWarnings.push('private_request_cleanup_failed');
      }
      try {
        await execution?.cleanupAuth();
      } catch {
        cleanupWarnings.push('private_auth_cleanup_failed');
      }
      if (cleanupWarnings.length) {
        cleanupMessage = ` ${cleanupWarnings.includes('private_auth_cleanup_failed') ? '임시 인증 파일' : '임시 본문 파일'} 정리도 완료하지 못했습니다.`;
        if (
          result.ok &&
          result.data.warnings.length + cleanupWarnings.length <= 100
        )
          result.data.warnings.push(...cleanupWarnings);
        else if (result.ok)
          result = apiFailure(
            cleanupWarnings[0] ?? 'private_cleanup_failed',
            '그림 문자 후보를 만들었으나 임시 파일 정리를 완료하지 못했습니다. 경고를 빠짐없이 전달할 수 없어 후보를 적용하지 않았으며 원래 내용은 보존됩니다.',
          );
        else result.error.message += cleanupMessage;
      }
      signal?.removeEventListener('abort', cancel);
      this.#controller = null;
      this.#cancelFile = null;
      finish();
    }
    // 인증 정리를 기다리던 취소·범위 변경도 늦은 후보가 화면에 들어가지 못하게 합니다.
    if (!this.#connection.isAnalysisCurrent(context))
      return apiFailure(
        'scope_changed',
        '작업 공간이나 연결이 변경되어 복구 결과를 사용하지 않았습니다.' +
          cleanupMessage,
      );
    if (this.#cancelRequested || controller.signal.aborted || signal?.aborted)
      return apiFailure(
        'image_recovery_cancelled',
        '그림 문자 복구를 취소했습니다. 원래 내용은 보존됩니다.' +
          cleanupMessage,
      );
    return result;
  }
}
