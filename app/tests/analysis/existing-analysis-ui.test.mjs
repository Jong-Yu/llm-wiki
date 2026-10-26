import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';

const appRoot = resolve(import.meta.dirname, '../..');

// 실제 React 구성요소를 브라우저에 렌더링하되 제한된 데스크톱 bridge만 시험 대역으로 제공합니다.
void test('existing job UI is read-only on mount; explicit execute, stop, resume and conflict preserve CAS', async (t) => {
  const root = await mkdtemp('/private/tmp/ui_4-browser-test-');
  let server;
  let browser;
  t.after(async () => {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true });
  });
  await writeFile(
    join(root, 'index.html'),
    '<html lang="ko"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>',
  );
  await writeFile(
    join(root, 'entry.tsx'),
    `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RunAnalysisJob} from ${JSON.stringify(join(appRoot, 'src/renderer/features/run-source-analysis/index.ts'))};
import ${JSON.stringify(join(appRoot, 'src/renderer/shared/theme/tokens.css'))};
const id='a'.repeat(32), hash='a'.repeat(64);
const scope={connectionId:'fixture',userId:'tester',tenant:'test',profileId:'default',policyRevision:hash};
const job={actor:{user_id:'tester',tenant:'test',profile_id:'default',domain:null,viewpoint:null,policy_revision:hash},job_id:id,tenant:'test',user_id:'tester',request_id:id,created_at:'2026-10-25T00:00:00Z',source_ref:{source_id:id,source_version:id,source_sha256:hash,size_bytes:50,registration_revision:hash},targets:[{document:'분석/실제-저장-영수증을-확인하는-아주-긴-문서-경로.md',source_revision:null,state_revision:null}],outputs:['wiki','ontology'],state:'awaiting_cli',run_id:null,reported_status:null,job_revision:hash,events:[],active_input_ref:null,analysis_basis_ref:null,lease_status:'none',lease_expires_at:null,basis_status:'current',blockers:[],input_readiness:'not_prepared',result_summary:{status:'not_started',saved_count:0,required_count:2,results:[]}};
const fixture=window.fixture={calls:[],phase:'ready',conflict:false,job};
function detail(){return {job,local:{status:fixture.phase==='running'?'running':fixture.phase==='stopped'?'stopped':'idle',message:'합성 fixture 프로세스 상태'},receipts:[],receiptErrors:[]};}
window.wiki={connection:{getState:async()=>({ok:true,data:{status:'connected',connectionId:scope.connectionId,userId:scope.userId,policyRevision:scope.policyRevision,selection:{tenant:scope.tenant,profile:scope.profileId}}})},analysis:{
 inspectExecution:async(request)=>{fixture.calls.push(['inspect',request]);return {ok:true,data:{detail:detail(),mode:fixture.phase==='running'?null:job.state==='awaiting_cli'?'start':'resume',blockers:fixture.phase==='running'?['현재 실행 중']:[],checkedAt:'2026-10-25T00:00:00Z'}};},
 execute:async(request)=>{fixture.calls.push(['execute',request]);if(fixture.conflict)return {ok:false,error:{code:'conflict',message:'확인한 작업 판본이 변경되었습니다.'}};fixture.phase='running';job.state='claimed';job.run_id=id;job.job_revision='b'.repeat(64);return {ok:true,data:detail()};},
 stopLocal:async(request)=>{fixture.calls.push(['stop',request]);fixture.phase='stopped';job.reported_status='stopped';job.job_revision='c'.repeat(64);return {ok:true,data:detail()};},
 start:async()=>{fixture.calls.push(['new-job']);throw new Error('new job forbidden');}
}};
function Harness(){const[open,setOpen]=useState(true);return <><button onClick={()=>setOpen(true)}>기존 작업 열기</button>{open&&<RunAnalysisJob scope={scope} jobId={id} onClose={()=>setOpen(false)}/>}</>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`,
  );
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, 'cache'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': join(appRoot, 'src/renderer'),
        '@contracts': join(appRoot, 'src/shared/contracts'),
        react: join(appRoot, 'node_modules/react'),
        'react-dom': join(appRoot, 'node_modules/react-dom'),
      },
    },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, appRoot] } },
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WIKI_UI_TEST_CHROMIUM,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  const execute = page.getByRole('button', {
    name: '확인한 작업 실행',
    exact: true,
  });
  await execute.waitFor();
  await page.waitForFunction(() =>
    window.fixture.calls.some(([kind]) => kind === 'inspect'),
  );
  assert.equal(await execute.isEnabled(), true);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.calls.filter(([kind]) => kind !== 'inspect'),
    ),
    [],
  );
  await page.getByRole('button', { name: '최신 기준 다시 확인' }).click();
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.calls.filter(([kind]) => kind !== 'inspect'),
    ),
    [],
  );
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    const bounds = await page.getByRole('dialog').boundingBox();
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport.width + 1 &&
        bounds.y + bounds.height <= viewport.height + 1,
    );
    assert.equal(
      await page
        .getByRole('dialog')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
    );
  }
  await execute.click();
  await page.getByRole('button', { name: '이 앱의 실행 중단' }).waitFor();
  const first = await page.evaluate(() =>
    window.fixture.calls.filter(([kind]) => kind === 'execute'),
  );
  assert.equal(first.length, 1);
  assert.equal(first[0][1].mode, 'start');
  assert.equal(first[0][1].expectedJobRevision, 'a'.repeat(64));
  await page.getByRole('button', { name: '이 앱의 실행 중단' }).click();
  const resume = page.getByRole('button', {
    name: '확인한 기준으로 남은 단계 재개',
  });
  await resume.waitFor();
  assert.equal(await resume.isEnabled(), true);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '기존 작업 열기' }).click();
  await resume.waitFor();
  assert.equal(
    await page.evaluate(
      () => window.fixture.calls.filter(([kind]) => kind === 'execute').length,
    ),
    1,
  );
  await page.evaluate(() => {
    window.fixture.conflict = true;
  });
  await resume.click();
  await page
    .getByText('확인한 작업 판본이 변경되었습니다.', { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: '확인한 작업 실행', exact: true })
      .isDisabled(),
    true,
  );
  const second = await page.evaluate(() =>
    window.fixture.calls.filter(([kind]) => kind === 'execute'),
  );
  assert.equal(second.length, 2);
  assert.equal(second[1][1].mode, 'resume');
  assert.equal(second[1][1].expectedJobRevision, 'c'.repeat(64));
  assert.equal(
    await page.evaluate(() =>
      window.fixture.calls.some(([kind]) => kind === 'new-job'),
    ),
    false,
  );
  assert.deepEqual(errors, []);
});
