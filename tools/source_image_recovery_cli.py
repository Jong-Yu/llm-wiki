"""개인 AI 그림 문자 복구 후보: stdout에는 단일 terminal JSONL만 출력한다."""

import argparse
import asyncio
import json
from pathlib import Path
import signal
import tempfile

from core.client.analysis import read_token
from core.client.source_image_recovery import DEFAULT_TIMEOUT, read_request, recover_images
from core.client.transport import AnalysisClientError


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # 인자 원문이나 토큰 경로를 stdout/stderr에 노출하지 않는다.
        raise AnalysisClientError("image_recovery_invalid_arguments")


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def main():
    previous = {}
    try:
        parser = _Parser(description="Create unapproved text candidates for selected PPTX slide images.")
        for name in ("server", "tenant"):
            parser.add_argument("--" + name, required=True)
        for name in ("token-file", "work-dir", "request-file"):
            parser.add_argument("--" + name, type=Path, required=True)
        parser.add_argument("--profile")
        parser.add_argument("--cancel-file", type=Path)
        parser.add_argument("--ai-provider", choices=("codex", "claude"), default="codex")
        parser.add_argument("--ai-cli")
        parser.add_argument("--ai-model")
        parser.add_argument("--ocr-language", default="kor+eng")
        parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
        args = parser.parse_args()
        request, token = read_request(args.request_file), read_token(args.token_file)
        with tempfile.TemporaryDirectory(prefix="wiki-image-recovery-cancel-") as temporary:
            cancel_file = args.cancel_file or Path(temporary) / "cancel"

            def cancel(signum, frame):
                cancel_file.touch(mode=0o600, exist_ok=True)

            for name in (signal.SIGINT, signal.SIGTERM):
                previous[name] = signal.signal(name, cancel)
            result = asyncio.run(recover_images(base_url=args.server, tenant=args.tenant, token=token,
                request=request, work_dir=args.work_dir, profile=args.profile, cancel_file=cancel_file,
                provider=args.ai_provider, cli=args.ai_cli, model=args.ai_model,
                ocr_language=args.ocr_language, timeout=args.timeout))
            emit(result)
        return 0
    except Exception as error:
        emit({"schema_version": 1, "type": "error", "ok": False, "error": {
            "code": error.code if isinstance(error, AnalysisClientError) else "image_recovery_client_failed"}})
        return 1
    finally:
        for name, handler in previous.items():
            signal.signal(name, handler)


if __name__ == "__main__":
    raise SystemExit(main())
