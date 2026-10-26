"""Electron 검사에만 쓰는 실제 서버와 가짜 개인 AI를 임시 폴더에 준비한다."""

import asyncio
from hashlib import sha256
import json
from pathlib import Path
import signal
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from core.tests.runtime.test_personal_ai_workflow import (
    GRAPH, SOURCE, PersonalAIWorkflowTests,
)
from core.modules.analysis_results.diagnostics import empty_report


def fake_codex(root):
    """실제 모델 대신 고정 응답을 낸다. API·CLI·저장은 제품 코드를 그대로 사용한다."""
    path = root / "electron-fake-codex"
    mode = root / "ai-mode.txt"
    started = root / "ai-started.json"
    mode.write_text("success", encoding="utf-8")
    wiki = {"content": SOURCE, "diagnostics": {**empty_report(),
        "warnings": ["모의 진단: 원문 조건을 별도로 대조해야 합니다."]}}
    # 의미 판정은 모의 자기 보고이며 실제 사람의 승인이나 독립 검증으로 기록하지 않는다.
    graph_report = {**empty_report(), "reviewer_kind": "ai_self_check",
        "warnings": ["모의 진단: 원문 조건을 별도로 대조해야 합니다."],
        "omissions": ["모의 누락 의견: 업무 적용 범위의 별도 확인이 필요합니다."],
        "reviewed_ranges": [{"start_line": 1, "end_line": 1}],
        "findings": [{"rule_id": "R-S01", "verdict": "supported",
            "source": {"quote": SOURCE.strip(), "start_line": 1, "end_line": 1},
            "target": {"collection": "relations", "index": 0},
            "reason": "모의 진단: 실제 원문 줄과 제출 관계의 인용을 대조했습니다.",
            "recommendation": None, "question": None}]}
    graph = {"submission": GRAPH, "diagnostics": graph_report}
    # 모드는 검사 프로세스만 바꾼다. 앱 화면에 모의 성공/실패 선택기를 넣지 않는다.
    body = f"#!{Path(sys.executable).resolve()}\n"
    body += "import json,os,sys,time\nfrom pathlib import Path\n"
    body += "if '--version' in sys.argv:\n print('codex-test 1.0'); raise SystemExit(0)\n"
    body += "if '--help' in sys.argv:\n print('--ephemeral --ignore-user-config --output-schema --output-last-message --json --sandbox --skip-git-repo-check --disable --enable'); raise SystemExit(0)\n"
    body += f"mode = Path({str(mode)!r}).read_text().strip()\n"
    body += "prompt = sys.stdin.read()\nwiki_stage = '작업 단계: prepare_wiki' in prompt\n"
    body += f"Path({str(started)!r}).write_text(json.dumps({{'pid':os.getpid(),'mode':mode}}))\n"
    body += "if mode == 'wait':\n time.sleep(90)\n"
    body += "if mode == 'fail_graph' and not wiki_stage:\n print(json.dumps({'type':'turn.failed'})); raise SystemExit(0)\n"
    body += f"wiki = json.loads({json.dumps(json.dumps(wiki, ensure_ascii=False))})\n"
    body += f"graph = json.loads({json.dumps(json.dumps(graph, ensure_ascii=False))})\n"
    body += "result = wiki if wiki_stage else graph\n"
    body += "Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')\n"
    body += "print(json.dumps({'type':'thread.started','thread_id':'electron-synthetic'}))\n"
    body += "print(json.dumps({'type':'turn.started'}))\nprint(json.dumps({'type':'item.completed','item':{'type':'agent_message'}}))\nprint(json.dumps({'type':'turn.completed'}))\n"
    path.write_text(body, encoding="utf-8")
    path.chmod(0o700)
    return path, mode, started


async def main():
    """종료 신호를 받으면 자식 서버와 이번 검사에서 만든 임시 자료만 정리한다."""
    supplied = json.loads(sys.stdin.readline())
    # 기존 검사 클래스의 준비/종료만 재사용하며 그 클래스의 검사들은 실행하지 않는다.
    fixture = PersonalAIWorkflowTests("test_actual_cli_stores_wiki_graph_and_client_execution_receipts")
    fixture.setUp()
    try:
        fixture.tokens["alice"] = supplied["token"]
        fixture.config["users"]["alice"]["token_sha256"] = sha256(supplied["token"].encode()).hexdigest()
        fixture.save_policy()
        root = fixture.root.resolve()
        executable, mode, started = fake_codex(root)
        stopped = asyncio.Event()
        loop = asyncio.get_running_loop()
        for name in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(name, stopped.set)
        async with fixture.server() as (http, url):
            response = await http.post(fixture.base + "/sources", json={
                "request_id": uuid4().hex, "title": "Electron 분석 원본", "format": "txt", "content": SOURCE})
            if response.status_code != 201:
                raise RuntimeError("임시 분석 원본을 등록하지 못했습니다.")
            # 토큰은 표준 입력으로만 전달하고 준비 응답에는 넣지 않는다.
            print(json.dumps({"serverUrl": url, "root": str(root), "fakeCli": str(executable),
                              "modePath": str(mode), "startedPath": str(started)}, ensure_ascii=False), flush=True)
            await stopped.wait()
    finally:
        fixture.doCleanups()


if __name__ == "__main__":
    asyncio.run(main())
