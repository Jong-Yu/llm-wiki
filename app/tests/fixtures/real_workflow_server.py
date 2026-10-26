"""실제 모델·Electron 전체 동선용 격리 서버. 개인·운영 자료를 사용하지 않는다."""
import asyncio
from hashlib import sha256
import json
from pathlib import Path
import signal
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from core.tests.runtime.test_personal_ai_workflow import PersonalAIWorkflowTests

async def main():
    supplied = json.loads(sys.stdin.readline())
    fixture = PersonalAIWorkflowTests('test_actual_cli_stores_wiki_graph_and_client_execution_receipts')
    fixture.setUp()
    try:
        fixture.tokens['alice'] = supplied['token']
        fixture.config['users']['alice']['token_sha256'] = sha256(supplied['token'].encode()).hexdigest()
        fixture.config['users']['alice']['memberships']['alpha']['permissions'] = [
            'read', 'source_write', 'write', 'ontology_write', 'ontology_review',
            'conversation_write', 'result_write', 'comparison_write']
        fixture.save_policy()
        stopped = asyncio.Event()
        for name in (signal.SIGTERM, signal.SIGINT):
            asyncio.get_running_loop().add_signal_handler(name, stopped.set)
        async with fixture.server() as (_http, url):
            print(json.dumps({'serverUrl': url, 'root': str(fixture.root.resolve())}), flush=True)
            await stopped.wait()
    finally:
        fixture.doCleanups()

if __name__ == '__main__':
    asyncio.run(main())
