"""선택한 개인 AI 질문 실행기. 실행 출력은 question-cli-v1 NDJSON이며 비밀은 포함하지 않는다."""

import argparse
import asyncio
from pathlib import Path

from core.client.analysis import read_token
from core.client.ai import create_adapter
from core.client.question import PROTOCOL, run_question
from core.client.transport import AnalysisClientError
from tools.cli_io import add_ai_arguments, cancellation_handler, emit_json as emit


async def execute(args, token):
    event = asyncio.Event()
    with cancellation_handler(event.set):
        adapter = create_adapter(args.ai_provider, cli=args.ai_cli, model=args.ai_model, timeout_seconds=args.ai_timeout) if args.run_ai else None
        return await run_question(base_url=args.server, tenant=args.tenant, token=token, work_dir=args.work_dir,
            question_run_id=args.question_run_id, conversation_id=args.conversation_id,
            question_turn_id=args.question_turn_id, expected_conversation_revision=args.expected_conversation_revision,
            create_request_id=args.create_request_id, adapter=adapter, profile=args.profile, reclaim=args.reclaim,
            cancel=args.cancel, receipt_request_id=args.receipt_request_id, on_event=emit, cancel_event=event,
            session_dir=args.session_dir)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run a stored question using personal AI; emit question-cli-v1 NDJSON.")
    parser.add_argument("--server", required=True)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--profile")
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--session-dir", type=Path, help="Stable private directory that keeps AI sessions so later questions can resume them.")
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
    add_ai_arguments(parser)
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
