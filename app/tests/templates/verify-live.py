"""모의 자료만 실제 개인 Codex에 전달해 승인 템플릿 계약과 파일 출력을 확인한다.

제품 templatePrompt를 그대로 빌드해 사용한다. 사용자 자료·설정·서버는 읽거나
수정하지 않으며 원본 DOCX와 개인 실행 디렉터리는 실행 종료 시 정리한다.
"""

import asyncio
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from core.client.ai.codex import CodexAdapter
from core.client.ai.contracts import AIAdapterError
from core.client.question_ai import ANSWER_SCHEMA
from core.modules.templates.render import inspect_template, render_template

RESULTS = ROOT / 'app/test-results/template-implementation-20261115'
INSTRUCTIONS = '\n'.join([
    '양식의 항목명과 순서를 유지하세요.',
    '오류 문구는 원문 그대로 사용하세요.',
    "미정 사항은 '미정'이라고 표기하고 임의로 확정하지 마세요.",
])
FACTS = '\n'.join([
    '[검증용 모의 프로젝트 원문]',
    '화면 이름은 로그인입니다.',
    '목적은 등록된 사용자가 제품 연구 작업 공간에 들어가는 것입니다.',
    '구성 요소는 이메일 입력란, 비밀번호 입력란, 로그인 버튼입니다.',
    '로그인 성공 시 작업 공간 홈으로 이동합니다.',
    '이메일이나 비밀번호가 일치하지 않으면 "이메일 또는 비밀번호를 확인해 주세요."를 표시합니다.',
    '세션 만료 시간은 미정입니다.',
])
BUILD_PROMPT = '''
import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [appRoot, temporary] = process.argv.slice(1);
await build({ configFile:false, root:appRoot, logLevel:'error',
 resolve:{alias:{'@contracts':join(appRoot,'src/shared/contracts')}},
 ssr:{noExternal:true},
 build:{ssr:join(appRoot,'src/renderer/features/chat-with-knowledge/model/templateSnapshot.ts'),
 outDir:join(temporary,'bundle'),emptyOutDir:false,
 rolldownOptions:{output:{entryFileNames:'snapshot.mjs'}}}});
const { freezeTemplate, templatePrompt } = await import(pathToFileURL(join(temporary,'bundle/snapshot.mjs')));
const detail = JSON.parse(await readFile(join(temporary,'detail.json'),'utf8'));
await writeFile(join(temporary,'template-prompt.txt'),templatePrompt(freezeTemplate(detail)));
'''


def template():
    """실제 Word 라이브러리로 고정 항목명과 빈 입력 셀을 만든다."""
    from docx import Document
    document = Document()
    document.add_heading('화면 설계서', 0)
    table = document.add_table(rows=0, cols=2)
    table.style = 'Table Grid'
    for title in ['화면 이름', '목적', '구성 요소', '동작', '예외', '미정 사항']:
        cells = table.add_row().cells
        cells[0].paragraphs[0].add_run(title).bold = True
        cells[1].paragraphs[0].add_run('')
    output = BytesIO()
    document.save(output)
    return output.getvalue()


def inspect_result(original, generated):
    """파일을 재열어 사실·불확실성과 비대상 서식의 보존을 확인한다."""
    from docx import Document
    document = Document(BytesIO(generated))
    rows = [(row.cells[0].text, row.cells[1].text) for row in document.tables[0].rows]
    labels = ['화면 이름', '목적', '구성 요소', '동작', '예외', '미정 사항']
    checks = {
        'heading_preserved': document.paragraphs[0].text == '화면 설계서',
        'labels_and_order_preserved': [label for label, _ in rows] == labels,
        'fixed_labels_bold': all(row.cells[0].paragraphs[0].runs[0].bold for row in document.tables[0].rows),
        'all_value_cells_written': all(value.strip() for _, value in rows),
        'screen_name_supported': rows[0][1].strip() == '로그인',
        'purpose_supported': '제품 연구 작업 공간' in rows[1][1] and '등록' in rows[1][1],
        'components_supported': all(value in rows[2][1] for value in ['이메일', '비밀번호', '로그인 버튼']),
        'success_destination_supported': '작업 공간 홈' in rows[3][1],
        'exact_error_copy': '이메일 또는 비밀번호를 확인해 주세요.' in rows[4][1],
        'uncertainty_preserved': '미정' in rows[5][1] and not any(character.isdigit() for character in rows[5][1]),
    }
    with ZipFile(BytesIO(original)) as before, ZipFile(BytesIO(generated)) as after:
        checks['all_other_package_parts_identical'] = (before.namelist() == after.namelist()
            and all(before.read(name) == after.read(name) for name in before.namelist() if name != 'word/document.xml'))
    return rows, checks


async def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    report = {'kind': 'live_codex_template_smoke', 'fixture_only': True, 'calls': 0,
              'profile': 'question_profile=True; read-only; ephemeral; tools disabled',
              'instructions': INSTRUCTIONS, 'source': FACTS, 'passed': False}
    try:
        with TemporaryDirectory(prefix='wiki-template-live-', dir='/private/tmp') as temporary_name:
            temporary = Path(temporary_name).resolve()
            original = template()
            detail = {'template': {'id':'1'*32, 'revision':'2'*64, 'name':'검증용 화면 설계서',
                'instructions':INSTRUCTIONS, 'filename':'화면설계서.docx', 'sizeBytes':len(original),
                'sha256':sha256(original).hexdigest(), 'createdAt':'2026-11-15T00:00:00Z',
                'updatedAt':'2026-11-15T00:00:00Z', 'archived':False},
                'generation':inspect_template('화면설계서.docx', original)}
            (temporary/'detail.json').write_text(json.dumps(detail,ensure_ascii=False),encoding='utf8')
            node = shutil.which('node')
            if not node:
                raise RuntimeError('node_unavailable')
            subprocess.run([node,'--input-type=module','-e',BUILD_PROMPT,str(ROOT/'app'),str(temporary)],
                           cwd=ROOT/'app',check=True)
            fragment = (temporary/'template-prompt.txt').read_text(encoding='utf8')
            prompt = ('다음은 제품의 템플릿 생성 기능을 검증하기 위한 모의 입력입니다. '
                'JSON content에는 사용자에게 보여 줄 답변을, citations에는 빈 배열을 반환하세요. '
                '외부 검색이나 도구 실행 없이 제공한 원문만 사용하세요.\n\n'
                '사용자 요청: 아래 검증용 원문으로 로그인 화면 설계서 초안을 작성해 주세요. '
                '양식의 각 빈 입력 셀을 채우고, 세션 만료 시간은 미정이라고 적어 주세요.\n\n'
                + FACTS + fragment)
            schema = deepcopy(ANSWER_SCHEMA)
            schema['properties']['citations']['maxItems'] = 0
            report['prompt_sha256'] = sha256(prompt.encode()).hexdigest()
            report['template_prompt_sha256'] = sha256(fragment.encode()).hexdigest()
            report['fields'] = detail['generation']['fields']
            adapter = CodexAdapter(timeout_seconds=180)
            report['calls'] = 1
            output = await adapter.run(prompt=prompt,schema=schema,directory=temporary/'codex-run',question_profile=True)
            report['content'] = output['value']['content']
            execution = output['execution']
            report['execution'] = {key:execution.get(key) for key in ('provider','cli_version','requested_model',
                'reported_model','status','duration_seconds','token_usage','prompt_sha256','output_sha256')}
            generated = render_template('화면설계서.docx', original, output['value']['content'])
            rows, checks = inspect_result(original, generated)
            report.update(rows=rows,checks=checks,passed=all(checks.values()),output_sha256=sha256(generated).hexdigest())
            (RESULTS/'live-template-output.docx').write_bytes(generated)
    except AIAdapterError as error:
        report['error_code'] = error.code
    except Exception as error:
        report['error_code'] = type(error).__name__
        # 모의 실행의 안전한 오류 유형만 기록하며 CLI 원문 로그는 반사하지 않는다.
    (RESULTS/'live-template-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'passed':report['passed'],'calls':report['calls'],'error_code':report.get('error_code'),
                      'checks':report.get('checks'),'execution':report.get('execution')},ensure_ascii=False))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
