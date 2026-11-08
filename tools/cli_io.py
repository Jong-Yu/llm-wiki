"""개인 CLI의 JSON 출력·표준 AI 인자·협력 취소를 모은다. 업무 실행과 저장은 하지 않는다."""

import asyncio
from contextlib import contextmanager
import json
import signal
import sys
import threading


def emit_json(value):
    """JSONL 공개 결과만 출력하며 비표준 NaN과 버퍼 지연을 허용하지 않는다."""
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def add_ai_arguments(parser, *, default_timeout=900):
    """각 개인 CLI가 같은 제공자·실행 경로·모델 옵션을 받게 한다."""
    parser.add_argument("--ai-provider", choices=("codex", "claude"), default="codex")
    parser.add_argument("--ai-cli", help="Selected provider's executable; defaults to its name.")
    parser.add_argument("--ai-model")
    parser.add_argument("--ai-timeout", type=float, default=default_timeout)


def _read_cancel(request):
    """정확한 cancel 한 줄만 처리한다. stdin EOF나 잘못된 JSON은 취소가 아니다."""
    try:
        while line := sys.stdin.readline(4097):
            if len(line) > 4096:
                return
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if value == {"type": "cancel"}:
                request()
                return
    except (OSError, RuntimeError):
        return


@contextmanager
def cancellation_handler(cancel):
    """signal/stdin을 호출자가 정한 Task 또는 Event 취소에 연결하고 신호 처리를 복원한다."""
    loop = asyncio.get_running_loop()
    previous = {}

    def request(*_):
        loop.call_soon_threadsafe(cancel)

    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            previous[sig] = signal.getsignal(sig)
            signal.signal(sig, request)
    if not sys.stdin.isatty():
        threading.Thread(target=_read_cancel, args=(request,), daemon=True).start()
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


async def cancellable(operation):
    """분석·대조의 Task 취소를 기존 자식 프로세스 회수 경로로 전달한다."""
    task = asyncio.create_task(operation)
    with cancellation_handler(task.cancel):
        return await task
