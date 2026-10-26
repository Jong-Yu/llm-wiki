"""질문 UI main 시험용 실제 API와 합성 개인 AI CLI를 격리 경로에 준비한다."""
import asyncio
from hashlib import sha256
import json
from pathlib import Path
import signal
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from core.tests.runtime.test_personal_ai_workflow import PersonalAIWorkflowTests


def fake_cli(root):
    """모델만 합성하고 실제 CLI·lease·인용·저장 경로는 제품 코드를 실행한다."""
    mode = root / 'question-mode'
    count = root / 'question-count'
    mode.write_text('success')
    count.write_text('0')
    executable = root / 'question-fake-codex'
    body = f'''#!{Path(sys.executable).resolve()}
import json,sys,time
from pathlib import Path
if '--version' in sys.argv:
 print('personal-cli-test 1.0');raise SystemExit(0)
if '--help' in sys.argv:
 print('--ephemeral --ignore-user-config --output-schema --output-last-message --json --sandbox --skip-git-repo-check --disable --enable --print --output-format --json-schema --safe-mode --tools --setting-sources --settings --strict-mcp-config --mcp-config --disable-slash-commands --no-session-persistence --no-chrome --permission-mode --permission-prompts --verbose --disallowedTools');raise SystemExit(0)
count=Path({str(count)!r});count.write_text(str(int(count.read_text())+1))
mode=Path({str(mode)!r}).read_text()
prompt=sys.stdin.read();data=json.loads(prompt.splitlines()[-1]);basis=data['basis']
if basis['documents']:
 doc=basis['documents'][0];citation={{'kind':'document','document':doc['document'],'source_revision':doc['source_revision'],'quote':doc['content'].splitlines()[0]}}
else:
 doc=basis['originals'][0];citation={{'kind':'source',**{{key:doc['source_ref'][key] for key in ('source_id','source_version','source_sha256')}},'quote':doc['content']}}
value={{'content':'합성 질문 답변입니다.','citations':[citation]}}
claude='--json-schema' in sys.argv
if claude:
 print(json.dumps({{'type':'system','subtype':'init','model':'fixture-claude'}}),flush=True)
 print(json.dumps({{'type':'assistant','message':{{'content':[{{'type':'text','text':json.dumps(value,ensure_ascii=False)}}]}}}}),flush=True)
 if mode=='wait':time.sleep(90)
 if mode=='fail':
  print(json.dumps({{'type':'result','subtype':'error','is_error':True}}),flush=True);raise SystemExit(0)
 time.sleep(0.4)
 print(json.dumps({{'type':'result','subtype':'success','is_error':False,'structured_output':value}}),flush=True);raise SystemExit(0)
print(json.dumps({{'type':'thread.started','thread_id':'question-ui-synthetic'}}),flush=True)
print(json.dumps({{'type':'turn.started'}}),flush=True)
print(json.dumps({{'type':'item.updated','item':{{'id':'answer','type':'agent_message','text':'{{"content":"합성 질문'}}}}),flush=True)
if mode=='wait':time.sleep(90)
if mode=='fail':
 print(json.dumps({{'type':'turn.failed'}}),flush=True);raise SystemExit(0)
time.sleep(0.4)
Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
print(json.dumps({{'type':'item.completed','item':{{'id':'answer','type':'agent_message','text':json.dumps(value,ensure_ascii=False)}}}}),flush=True)
print(json.dumps({{'type':'turn.completed'}}),flush=True)
'''
    executable.write_text(body)
    executable.chmod(0o700)
    return executable, mode, count


async def main():
    """이번 fixture의 임시 루트만 종료 시 정리한다."""
    supplied = json.loads(sys.stdin.readline())
    fixture = PersonalAIWorkflowTests('test_actual_cli_stores_wiki_graph_and_client_execution_receipts')
    fixture.setUp()
    try:
        fixture.tokens['alice'] = supplied['token']
        fixture.config['users']['alice']['token_sha256'] = sha256(supplied['token'].encode()).hexdigest()
        fixture.config['users']['alice']['memberships']['alpha']['permissions'].append('conversation_write')
        fixture.save_policy()
        executable, mode, count = fake_cli(fixture.root.resolve())
        stopped = asyncio.Event()
        for name in (signal.SIGINT, signal.SIGTERM):
            asyncio.get_running_loop().add_signal_handler(name, stopped.set)
        async with fixture.server() as (_, url):
            print(json.dumps({'serverUrl':url,'root':str(fixture.root.resolve()),'fakeCli':str(executable),'modePath':str(mode),'countPath':str(count)}),flush=True)
            await stopped.wait()
    finally:
        fixture.doCleanups()

if __name__ == '__main__':
    asyncio.run(main())
