# 사람이 입력한 명령줄 옵션을 core.client.analysis.prepare에 연결하는 개발용 명령이다.
# asyncio.run은 비동기 인계 흐름을 실행하고, 성공은 stdout JSON, 실패 안내는 stderr JSON으로 출력한다.

"""작업 PC에서 원본을 받거나 명시적으로 개인 AI 분석·저장까지 실행한다."""

import argparse
import asyncio
import json
from pathlib import Path
import sys
import signal
import threading

from core.client.analysis import AnalysisClientError, prepare, read_token
from core.client.transport import client_error_code


async def _cancellable(operation):
    """SIGINT/TERM과 앱의 stdin cancel을 같은 asyncio 취소·자식 회수 경로에 연결한다."""
    loop = asyncio.get_running_loop()
    task = asyncio.create_task(operation)
    previous = {}
    def cancel(*_):
        if not task.done():
            loop.call_soon_threadsafe(task.cancel)
    def read_cancel():
        try:
            while line := sys.stdin.readline(4097):
                if len(line) > 4096:
                    return
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if value == {"type": "cancel"}:
                    cancel()
                    return
        except (OSError, RuntimeError):
            return
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            previous[sig] = signal.getsignal(sig)
            signal.signal(sig, cancel)
    if not sys.stdin.isatty():
        threading.Thread(target=read_cancel, daemon=True).start()
    try:
        return await task
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


# 명령줄 값을 읽고 보호된 토큰 파일을 확인한 다음, 인계 비동기 함수를 한 번 실행한다.
def main():
    parser = argparse.ArgumentParser(description="Prepare one authenticated analysis job through API and MCP.")
    parser.add_argument("--server", required=True)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--expected-job-revision", help="Exact job revision observed before explicit execution.")
    parser.add_argument("--semantic-check", action="store_true", help="Run a separate personal semantic check and retain its report before graph save.")
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--reclaim", action="store_true", help="Explicitly request a new run after expiry or a stopped/failed report.")
    parser.add_argument("--prepare-input", action="store_true", help="Receive and verify a fixed read_source input and its published ruleset.")
    parser.add_argument("--context-document", action="append", default=None, help="Explicit required context document (up to eight).")
    parser.add_argument("--profile", help="Keep this authorized view profile throughout every AI stage.")
    # action='store_true'는 옵션을 붙인 경우만 True다. 기존 인계 명령이 갑자기 AI를 호출하지 않게 한다.
    parser.add_argument("--run-ai", action="store_true", help="Explicitly run personal AI analysis and submit server results.")
    parser.add_argument("--ai-provider", choices=("codex", "claude"), default="codex")
    parser.add_argument("--ai-cli", help="Selected provider's executable; defaults to its name (no shell command string).")
    parser.add_argument("--ai-model", help="Explicit model; omit to use the isolated CLI's default model.")
    parser.add_argument("--ai-timeout", type=float, default=900, help="Maximum seconds per AI stage (default 900).")
    args = parser.parse_args()
    try:
        token = read_token(args.token_file)
        adapter = None
        if args.run_ai:
            from core.client.ai import create_adapter
            adapter = create_adapter(args.ai_provider, cli=args.ai_cli, model=args.ai_model, timeout_seconds=args.ai_timeout)
        result = asyncio.run(_cancellable(prepare(base_url=args.server, tenant=args.tenant, job_id=args.job_id,
                                     token=token, work_dir=args.work_dir, reclaim=args.reclaim,
                                     adapter=adapter, profile=args.profile, expected_job_revision=args.expected_job_revision,
                                     semantic_check=args.semantic_check,
                                     prepare_input=args.prepare_input, context_documents=[{
                                         "document": document, "required": True, "reason": "Explicit CLI context selection"}
                                         for document in args.context_document] if args.context_document is not None else None)))
    except (AnalysisClientError, OSError, ValueError) as error:
        code = error.code if isinstance(error, AnalysisClientError) else "client_input_or_file_error"
        print(json.dumps({"ok": False, "error": {"code": code}}), file=sys.stderr)
        raise SystemExit(1) from None
    except (KeyboardInterrupt, asyncio.CancelledError):
        # Ctrl+C도 자기 실행만 종료한다. 이미 저장한 결과와 작업 폴더의 초안은 유지한다.
        print(json.dumps({"ok": False, "error": {"code": "ai_cancelled"}}), file=sys.stderr)
        raise SystemExit(130) from None
    except Exception as error:
        # 전송/SDK 예외의 원문에는 자격 증명·주소가 있을 수 있어 출력하지 않는다.
        print(json.dumps({"ok": False, "error": {"code": client_error_code(error) or "connection_failed"}}), file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
