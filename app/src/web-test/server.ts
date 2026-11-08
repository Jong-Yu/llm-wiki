import { resolve } from 'node:path';
import { startWebTestServer } from './httpServer';
import { createWebServices } from './services';

/** 실행기가 확정한 전용 경로와 서버 주소만 사용합니다. */
async function main(): Promise<void> {
  const temporary = process.env.WIKI_WEB_TEST_ROOT;
  const project = process.env.WIKI_WEB_TEST_PROJECT;
  const upstream = process.env.WIKI_WEB_SERVER_URL;
  const port = Number(process.env.WIKI_WEB_TEST_PORT || '4173');
  if (
    !temporary ||
    !project ||
    !upstream ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('invalid_configuration');
  const services = await createWebServices(temporary, project, upstream);
  const server = await startWebTestServer({
    assetsRoot: resolve(temporary, 'browser'),
    services,
    port,
  });
  process.stdout.write(
    `LLM Wiki 웹 테스트: ${server.url}\n로그인과 임시 초안은 테스트 서버 종료 시 해제됩니다.\n`,
  );
  const stop = (): void => {
    void server.close().then((): void => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch((): void => {
  process.stderr.write(
    '웹 테스트 서버를 시작하지 못했습니다. 실행 설정과 포트 사용 여부를 확인해 주세요.\n',
  );
  process.exitCode = 1;
});
