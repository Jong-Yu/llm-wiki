"""기존 합성 결과 생성기를 Claude의 NDJSON 외피로 실행한다. 실제 AI는 호출하지 않는다."""

from core.client.ai.claude import _REQUIRED_FLAGS


def as_claude(path):
    shebang, body = path.read_text().split("\n", 1)
    wrapper = '''import builtins, json, sys
from pathlib import Path
if '--version' in sys.argv:
 print('claude-fixture 1.0'); raise SystemExit(0)
if '--help' in sys.argv:
 print(HELP_FLAGS); raise SystemExit(0)
assert '--safe-mode' in sys.argv and '--bare' not in sys.argv
assert sys.argv[sys.argv.index('--tools') + 1] == ''
assert '--no-session-persistence' in sys.argv
schema_path = Path('.fixture-schema.json')
schema_path.write_text(sys.argv[sys.argv.index('--json-schema') + 1])
fixture_result = Path('.fixture-result.json')
sys.argv = [sys.argv[0], '--output-schema', str(schema_path), '--output-last-message', str(fixture_result), '-']
original_print = builtins.print
def translate(*values, **kwargs):
 if kwargs.get('file') is sys.stderr:
  return original_print(*values, **kwargs)
 event = json.loads(values[0])
 kind, item = event['type'], event.get('item', {})
 if kind == 'thread.started':
  message = {'type':'system','subtype':'init','model':'claude-fixture-model'}
 elif kind == 'turn.failed':
  message = {'type':'result','subtype':'error_during_execution','is_error':True}
 elif kind in ('item.updated','item.completed') and item.get('type') == 'agent_message' and isinstance(item.get('text'),str):
  message = {'type':'assistant','message':{'content':[{'type':'text','text':item['text']}]}}
 elif kind == 'turn.completed':
  message = {'type':'result','subtype':'success','is_error':False,'structured_output':json.loads(fixture_result.read_text())}
 else:
  return
 original_print(json.dumps(message,ensure_ascii=False),flush=True)
builtins.print = translate
'''.replace("HELP_FLAGS", repr(" ".join(_REQUIRED_FLAGS)))
    path.write_text(shebang + "\n" + wrapper + "\n" + body)
    return path
