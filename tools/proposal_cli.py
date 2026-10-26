"""추출안 전용 개인 실행 CLI. stdout은 proposal-cli-v1 JSONL, stdin은 취소만 받는다."""

import argparse
import asyncio
import json
from pathlib import Path
import signal
import sys
import threading

from core.client.analysis import read_token
from core.client.ai import create_adapter
from core.client.proposal import run_proposal
from core.client.proposal_records import PROTOCOL
from core.client.transport import client_error_code


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def _stdin_cancel(loop, event):
    try:
        while line := sys.stdin.readline(4097):
            if len(line) > 4096:
                return
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if value == {"type": "cancel"}:
                loop.call_soon_threadsafe(event.set)
                return
    except (OSError, RuntimeError):
        return


async def execute(args, token):
    event, loop, previous = asyncio.Event(), asyncio.get_running_loop(), {}
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            previous[sig] = signal.getsignal(sig)
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(event.set))
    if not sys.stdin.isatty():
        threading.Thread(target=_stdin_cancel, args=(loop, event), daemon=True).start()
    try:
        adapter = create_adapter(args.ai_provider, cli=args.ai_cli, model=args.ai_model, timeout_seconds=args.ai_timeout) if args.run_ai else None
        return await run_proposal(base_url=args.server, tenant=args.tenant, token=token, profile=args.profile,
            work_dir=args.work_dir, proposal_id=args.proposal_id, execution_id=args.execution_id,
            request_id=args.request_id, expected_proposal_revision=args.expected_proposal_revision,
            reason=args.reason, adapter=adapter, semantic_check=args.semantic_check, resume_dir=args.resume_dir,
            cancel=args.cancel, receipt_request_id=args.receipt_request_id, on_event=emit, cancel_event=event)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Explicit personal re-extraction to a proposal candidate; emit proposal-cli-v1 JSONL.")
    for name in ("server", "tenant", "proposal-id"):
        parser.add_argument("--" + name, required=True)
    for name in ("profile", "execution-id", "request-id", "expected-proposal-revision"):
        parser.add_argument("--" + name)
    parser.add_argument("--reason", default="Explicit personal AI re-extraction")
    for name in ("token-file", "work-dir"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--resume-dir", type=Path, help="Exact prior work_dir. Reconcile reads only unless --run-ai is explicit.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--run-ai", action="store_true", help="Execute personal AI; submit a candidate only, never apply canonical.")
    mode.add_argument("--cancel", action="store_true", help="Cancel the specified server execution without running AI.")
    mode.add_argument("--receipt-request-id", help="Read the exact proposal link receipt without executing or resubmitting.")
    parser.add_argument("--semantic-check", action="store_true")
    parser.add_argument("--ai-provider", choices=("codex", "claude"), default="codex")
    parser.add_argument("--ai-cli", help="Selected provider's executable; defaults to its name.")
    parser.add_argument("--ai-model")
    parser.add_argument("--ai-timeout", type=float, default=900)
    args = parser.parse_args(argv)
    try:
        value = asyncio.run(execute(args, read_token(args.token_file)))
    except (KeyboardInterrupt, asyncio.CancelledError):
        value = {"ok": False, "status": "cancelled", "candidate_saved": None,
                 "error": {"code": "proposal_cancel_unconfirmed"}}
    except Exception as error:
        code = client_error_code(error) or ("client_input_or_file_error" if isinstance(error, (OSError, ValueError)) else "proposal_execution_failed")
        value = {"ok": False, "status": "failed", "candidate_saved": None, "error": {"code": code}}
    try:
        emit({"protocol": PROTOCOL, "type": "result", "canonical_saved": False, "human_approval": False,
              "diagnostics_saved": False, "receipt": None, **value})
    except BrokenPipeError:
        return 1
    return 130 if value["status"] == "cancelled" else 0 if value["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
