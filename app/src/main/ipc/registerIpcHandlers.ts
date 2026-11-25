import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { isAppSender } from './isAppSender';

type Parser<Value> = { parse: (value: unknown) => Value };
type Method = (...args: never[]) => unknown;
type Failure = {
  ok: false;
  error: { code: string; message: string };
};
type FailureMessages = {
  invalidRequest: string;
  unexpected: Failure['error'];
};
type ValidatedContract<Request, Result> = {
  channel: string;
  request: Parser<Request>;
  result: Parser<Result>;
};

/** 채널 이름과 공개 bridge의 요청·결과를 같은 작업 키에서 검사합니다. */
export type IpcContracts<
  Bridge,
  Channels extends Record<keyof Bridge, string>,
> = {
  [Key in keyof Channels]: Key extends keyof Bridge
    ? Bridge[Key] extends (request: infer Request) => infer Result
      ? ValidatedContract<Request, Awaited<Result>> & {
          channel: Channels[Key];
        }
      : never
    : never;
};

/** 기존 채널 상수에서 작업별 인자 수와 결과 타입을 얻습니다. */
export type IpcMethods<Bridge, Channels> = {
  [Key in keyof Channels & keyof Bridge as Channels[Key] & string]: Extract<
    Bridge[Key],
    Method
  >;
};

type Registrar = {
  register: <Result>(
    channel: string,
    count: 0 | 1,
    operation: (value: unknown) => Result | Promise<Result>,
  ) => void;
  validated: <Request, Result>(
    contract: ValidatedContract<Request, Result>,
    operation: (
      request: NoInfer<Request>,
    ) => NoInfer<Result> | Promise<NoInfer<Result>>,
  ) => void;
};

/** main 내부의 명시한 작업만 등록하며 호출자·인자 수·실패 변환 순서를 보존합니다. */
export function createIpcRegistrar(
  getWindow: () => BrowserWindow | null,
  rendererLocation: string,
  failures: FailureMessages,
): Registrar {
  /** 요청 검사와 실행에서 발생한 동기·비동기 예외를 업무별 실패로 돌려줍니다. */
  function register<Result>(
    channel: string,
    count: 0 | 1,
    operation: (value: unknown) => Result | Promise<Result>,
  ): void {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<Result | Failure> => {
        if (!isAppSender(event, getWindow, rendererLocation))
          return {
            ok: false,
            error: {
              code: 'forbidden',
              message: '허용되지 않은 앱 요청입니다.',
            },
          };
        if (args.length !== count)
          return {
            ok: false,
            error: {
              code: 'invalid_request',
              message: failures.invalidRequest,
            },
          };
        try {
          return await operation(args[0]);
        } catch {
          return { ok: false, error: { ...failures.unexpected } };
        }
      },
    );
  }

  /** 입력과 응답 parser를 bridge 계약에 맞는 업무 메서드에 연결합니다. */
  function validated<Request, Result>(
    contract: ValidatedContract<Request, Result>,
    operation: (
      request: NoInfer<Request>,
    ) => NoInfer<Result> | Promise<NoInfer<Result>>,
  ): void {
    register(contract.channel, 1, async (value: unknown): Promise<Result> => {
      const request = contract.request.parse(value);
      return contract.result.parse(await operation(request));
    });
  }

  return { register, validated };
}
