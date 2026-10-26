"""ui_8: 합성 모델 실행파일 + 실제 격리 HTTP/MCP 서버를 앱 main 시험에 제공한다."""
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from core.tests.runtime.test_proposal_cli import ProposalCliTests

async def main():
    fixture = ProposalCliTests()
    fixture.setUp()
    try:
        cli = fixture.fake_cli(delay=0.15)
        before = fixture.canonical()
        async with fixture.server() as (http, url):
            proposal = await fixture.proposal(http)
            print(json.dumps({"url": url, "proposal": proposal, "token_file": str(fixture.token_path), "codex": str(cli), "private_root": str(fixture.root.resolve() / 'electron-private')}), flush=True)
            while command := await asyncio.to_thread(sys.stdin.readline):
                if command.strip() == 'verify':
                    print(json.dumps({"canonical_unchanged": fixture.canonical() == before}), flush=True)
                elif command.strip() == 'slow':
                    fixture.fake_cli(delay=6)
                    print(json.dumps({"slow": True}), flush=True)
                elif command.strip() == 'stop':
                    break
    finally:
        fixture.doCleanups()

asyncio.run(main())
