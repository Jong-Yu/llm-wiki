import { execFile } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  RuntimeCheck,
  RuntimeSettings,
} from '@contracts/runtime.contract';
import { AI_NETWORK_ENVIRONMENT } from './aiNetworkEnvironment';

/** 진단에 필요한 로컬 환경만 전달하며 서버 인증을 포함하지 않습니다. */
function environment(settings: RuntimeSettings): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    // macOS의 Claude Code 로그인 정보는 키체인에 있고 USER가 없으면 로그아웃으로 읽힙니다.
    'USER',
    'LOGNAME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    ...AI_NETWORK_ENVIRONMENT,
  ]) {
    if (process.env[key]) result[key] = process.env[key];
  }
  result.PYTHONNOUSERSITE = '1';
  result.PATH = withMacToolPaths(result.PATH);
  if (settings.tesseract)
    result.PATH = `${dirname(settings.tesseract)}${delimiter}${result.PATH || ''}`;
  if (settings.tessdata) result.TESSDATA_PREFIX = settings.tessdata;
  return result;
}
/**
 * Finder·Dock으로 연 앱은 셸의 PATH를 받지 못해 Homebrew로 설치한 도구(Tesseract 등)를 찾지 못합니다.
 * macOS의 표준 설치 위치를 PATH 뒤에 덧붙여 시스템 도구가 먼저 선택되게 합니다.
 */
export function withMacToolPaths(path: string | undefined): string {
  const base = path ?? '';
  if (process.platform !== 'darwin') return base;
  const known = new Set(base.split(delimiter));
  return [
    base,
    ...['/opt/homebrew/bin', '/usr/local/bin'].filter(
      (directory: string): boolean => !known.has(directory),
    ),
  ]
    .filter((value: string): boolean => value.length > 0)
    .join(delimiter);
}
/** 제한된 JSON만 받아들이며 원시 stderr나 경로가 든 예외를 UI에 보내지 않습니다. */
export function runRuntimeJson(
  python: string,
  args: string[],
  settings: RuntimeSettings,
): Promise<unknown> {
  return new Promise(
    (
      resolve: (value: unknown) => void,
      reject: (error: Error) => void,
    ): void => {
      execFile(
        python,
        args,
        {
          cwd: settings.root,
          env: environment(settings),
          timeout: 60_000,
          maxBuffer: 512 * 1024,
          windowsHide: true,
        },
        (error: Error | null, stdout: string): void => {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(
              new Error(error ? 'runtime_unavailable' : 'invalid_diagnostic'),
            );
          }
        },
      );
    },
  );
}
/**
 * 진단 도구를 실행하고 종료 코드만 돌려줍니다. 출력은 보고서 파일에만 남으며 화면에 원문을 보내지 않습니다.
 * 실제 AI 호출(45초)과 Python 재실행(60초)을 포함해 기다립니다.
 */
function runReport(
  python: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((resolve: (code: number | null) => void): void => {
    execFile(
      python,
      args,
      { cwd, env, timeout: 150_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error: (Error & { code?: unknown }) | null): void => {
        resolve(
          error === null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : null,
        );
      },
    );
  });
}
/** 설정·확인 기록을 저장하지 않고 Python·의존성·CLI 진단 결과를 돌려줍니다. */
export async function diagnoseRuntime(
  settings: RuntimeSettings,
): Promise<RuntimeCheck[]> {
  const raw = await runRuntimeJson(
    settings.python,
    [
      '-B',
      '-m',
      'tools.runtime_doctor',
      '--ai-provider',
      settings.provider,
      '--ai-cli',
      settings[settings.provider],
    ],
    settings,
  );
  const doctor = z
    .object({
      python_supported: z.boolean(),
      dependencies: z.array(z.object({ status: z.string() })),
      ai: z.object({ status: z.string(), login: z.string().optional() }),
    })
    .parse(raw);
  return [
    {
      name: 'Python 3.12 이상',
      status: doctor.python_supported ? 'ok' : 'error',
      detail: doctor.python_supported
        ? '실행 확인'
        : '지원하는 Python을 설치해 주세요.',
    },
    {
      name: '고정 Python 의존성',
      status: doctor.dependencies.every(
        (row: { status: string }): boolean => row.status === 'ok',
      )
        ? 'ok'
        : 'missing',
      detail: 'requirements.lock 기준 검사',
    },
    {
      name: `${settings.provider === 'claude' ? 'Claude Code' : 'Codex'} CLI·로그인`,
      status: doctor.ai.status === 'ok' ? 'ok' : 'error',
      detail:
        doctor.ai.login === 'credentials_present'
          ? '로컬 로그인 정보 존재. 실제 모델 사용 가능성은 미검증입니다.'
          : `선택한 ${settings.provider === 'claude' ? 'Claude Code' : 'Codex'} CLI의 설치와 개인 로그인을 확인해 주세요.`,
    },
  ];
}

/** OCR 진단 실패는 필수 실행 환경과 구분해 선택 항목의 오류로 돌려줍니다. */
export async function diagnoseOcr(
  settings: RuntimeSettings,
): Promise<RuntimeCheck> {
  try {
    const conversion = z
      .object({
        diagnostics: z
          .object({
            tesseract: z
              .object({
                available: z.boolean(),
                ready: z.boolean().optional(),
                missing_languages: z.array(z.string()).optional(),
              })
              .loose(),
          })
          .loose(),
      })
      .parse(
        await runRuntimeJson(
          settings.python,
          [
            '-B',
            '-m',
            'tools.source_conversion_cli',
            '--diagnose',
            '--ocr-language',
            'kor+eng',
          ],
          settings,
        ),
      );
    return {
      name: 'Tesseract OCR',
      status:
        conversion.diagnostics.tesseract.ready === true ? 'ok' : 'missing',
      detail: conversion.diagnostics.tesseract.available
        ? `실행 파일 탐지. 한국어·영어 준비: ${conversion.diagnostics.tesseract.ready === true ? '확인' : '미확인 또는 누락'}. 인식 정확도는 별도 검증합니다.`
        : 'Tesseract 실행 파일과 사용할 언어 데이터를 설치해 주세요.',
      optional: true,
    };
  } catch {
    return {
      name: 'Tesseract OCR',
      status: 'error',
      detail: '변환기 진단을 실행하지 못했습니다.',
      optional: true,
    };
  }
}

/** 기존 Claude 진단 도구를 호출합니다. 보고서의 보존·발견·열기는 호출자가 맡습니다. */
export function runClaudeDiagnostic(
  root: string,
  python: string,
  output: string,
  settings: RuntimeSettings,
): Promise<number | null> {
  return runReport(
    python,
    [
      '-B',
      join(root, 'tools/claude_call_diagnostic.py'),
      '--runtime',
      root,
      '--output',
      output,
      '--test',
    ],
    root,
    environment(settings),
  );
}
