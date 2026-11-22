import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
async function load(file) {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    root,
    resolve: { alias: { '@contracts': resolve(root, 'src/shared/contracts') } },
    ssr: { noExternal: true },
    build: {
      write: false,
      ssr: fileURLToPath(new URL(file, import.meta.url)),
      rolldownOptions: { output: { format: 'es' } },
    },
  });
  const chunk = (Array.isArray(built) ? built[0].output : built.output).find(
    (item) => item.type === 'chunk' && item.isEntry,
  );
  assert.ok(chunk);
  return await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  );
}

const { composeQuestion, splitQuestion } = await load('./externalMaterial.ts');
const { freezeTemplate, splitTemplateResult } = await load(
  './templateSnapshot.ts',
);
const detail = {
  template: {
    id: 'a'.repeat(32),
    revision: 'b'.repeat(64),
    name: '화면 설계서',
    instructions: '근거가 없으면 질문하세요.',
    filename: '화면.pptx',
    sizeBytes: 100,
    sha256: 'c'.repeat(64),
    createdAt: '2026-11-15',
    updatedAt: '2026-11-15',
    archived: false,
  },
  generation: {
    supported: true,
    format: 'pptx',
    reason: null,
    fields: [
      { id: 'f0001', text: '화면 이름', location: '슬라이드 1 · 문단 1' },
    ],
  },
};
await test('요청 당시 파일 판본·지침·작성 영역은 현재 템플릿 수정과 독립적으로 복원한다', () => {
  const snapshot = freezeTemplate(detail);
  const original = structuredClone(detail);
  const attachments = [
    {
      id: '1',
      kind: 'text',
      name: '회의록',
      text: '참고 자료입니다.',
      truncated: false,
    },
  ];
  const content = composeQuestion(
    '설계해 주세요',
    attachments,
    null,
    false,
    false,
    snapshot,
  );
  detail.template.instructions = '나중에 변경한 지침';
  const parsed = splitQuestion(content);
  assert.equal(parsed.question, '설계해 주세요');
  assert.deepEqual(parsed.attachments, attachments);
  assert.deepEqual(parsed.registeredTemplate, { ...original, version: 1 });
  assert.equal(parsed.template.name, '화면 설계서');
  assert.equal(
    parsed.registeredTemplate.generation.fields[0].location,
    '슬라이드 1 · 문단 1',
  );
});
await test('지원하지 않거나 보관된 템플릿을 생성 가능한 질문으로 만들지 않는다', () => {
  assert.throws(
    () =>
      freezeTemplate({
        ...detail,
        template: { ...detail.template, archived: true },
      }),
    /보관/,
  );
  assert.throws(
    () =>
      freezeTemplate({
        ...detail,
        generation: {
          ...detail.generation,
          supported: false,
          reason: '지원하지 않는 형식',
        },
      }),
    /지원하지 않는 형식/,
  );
});
await test('확인 질문·기본 답변은 파일 계획으로 해석하지 않고 완성되지 않은 계획은 본문에서 분리한다', () => {
  assert.equal(
    splitTemplateResult('검토자의 예외 권한을 적용할까요?').hasPlan,
    false,
  );
  assert.deepEqual(
    splitQuestion(composeQuestion('기본 질문')).question,
    '기본 질문',
  );
  assert.equal(
    splitTemplateResult('작성 중\n```wiki-template-result\n{"version":1').body,
    '작성 중',
  );
  assert.equal(
    splitTemplateResult('```wiki-template-result\nwrong\n```').valid,
    false,
  );
});
await test('다중 결과 계획은 승인하지 않고 단일 계획은 내용 미리보기로만 표시한다', () => {
  const plan =
    '```wiki-template-result\n{"version":1,"replacements":[{"id":"f0001","text":"완성 내용"}]}\n```';
  assert.equal(splitTemplateResult(plan + '\n' + plan).valid, false);
  assert.equal(splitTemplateResult('설명\n' + plan).preview, '완성 내용');
  assert.equal(splitTemplateResult('설명\n' + plan).body, '설명');
});
