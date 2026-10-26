"""선택한 개인 AI 질문 실행기. 실행 출력은 question-cli-v1 NDJSON이며 비밀은 포함하지 않는다."""

import argparse
import asyncio
import json
from pathlib import Path
import signal
import sys
import threading

from core.client.analysis import read_token
from core.client.ai import create_adapter
from core.client.question import PROTOCOL, run_question
from core.client.transport import AnalysisClientError


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def _stdin_cancel(loop, event):
    """Windows에서도 앱이 stdin의 한 줄로 자기 실행을 취소할 수 있다. EOF는 취소가 아니다."""
    try:
        while line := sys.stdin.readline(4097):
            if len(line) > 4096:
                return
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message == {"type": "cancel"}:
                loop.call_soon_threadsafe(event.set)
                return
    except (OSError, RuntimeError):
        return


async def execute(args, token):
    event, loop = asyncio.Event(), asyncio.get_running_loop()
    previous = {}
    # signal.signal은 Windows에서도 작동한다. 실제 subprocess 종료는 선택한 AI 어댑터가 맡는다.
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            previous[sig] = signal.getsignal(sig)
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(event.set))
    if not sys.stdin.isatty():
        threading.Thread(target=_stdin_cancel, args=(loop, event), daemon=True).start()
    try:
        adapter = create_adapter(args.ai_provider, cli=args.ai_cli, model=args.ai_model, timeout_seconds=args.ai_timeout) if args.run_ai else None
        return await run_question(base_url=args.server, tenant=args.tenant, token=token, work_dir=args.work_dir,
            question_run_id=args.question_run_id, conversation_id=args.conversation_id,
            question_turn_id=args.question_turn_id, expected_conversation_revision=args.expected_conversation_revision,
            create_request_id=args.create_request_id, adapter=adapter, profile=args.profile, reclaim=args.reclaim,
            cancel=args.cancel, receipt_request_id=args.receipt_request_id, on_event=emit, cancel_event=event)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run a stored question using personal AI; emit question-cli-v1 NDJSON.")
    parser.add_argument("--server", required=True)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--profile")
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--question-run-id")
    selection.add_argument("--conversation-id")
    parser.add_argument("--question-turn-id")
    parser.add_argument("--expected-conversation-revision")
    parser.add_argument("--create-request-id", help="Stable creation request ID for exact receipt lookup after response loss.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--run-ai", action="store_true", help="Explicitly execute personal AI and submit the answer.")
    mode.add_argument("--cancel", action="store_true", help="Cancel the selected server run; never executes AI.")
    mode.add_argument("--receipt-request-id", help="Read an exact answer receipt; never executes AI or repeats submission.")
    parser.add_argument("--reclaim", action="store_true", help="Explicitly claim a running resource only after server lease expiry.")
    parser.add_argument("--ai-provider", choices=("codex", "claude"), default="codex")
    parser.add_argument("--ai-cli", help="Selected provider's executable; defaults to its name.")
    parser.add_argument("--ai-model")
    parser.add_argument("--ai-timeout", type=float, default=900)
    args = parser.parse_args(argv)
    try:
        result = asyncio.run(execute(args, read_token(args.token_file)))
    except (AnalysisClientError, OSError, ValueError) as error:
        result = {"ok": False, "status": "failed", "saved": False, "receipt": None,
            "error": {"code": error.code if isinstance(error, AnalysisClientError) else "client_input_or_file_error"}}
    except KeyboardInterrupt:
        result = {"ok": False, "status": "cancelled", "saved": None, "receipt": None,
            "error": {"code": "question_cancel_unconfirmed"}}
    except Exception:
        result = {"ok": False, "status": "failed", "saved": None, "receipt": None,
            "error": {"code": "question_execution_failed"}}
    try:
        emit({"protocol": PROTOCOL, "type": "result", **result})
    except BrokenPipeError:
        return 1
    if result["status"] == "cancelled":
        return 130
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
