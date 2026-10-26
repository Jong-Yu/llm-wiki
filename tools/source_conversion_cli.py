"""개인 PC 원본 변환기: stdout은 구조화 JSONL이며 토큰·예외 원문을 출력하지 않는다."""

import argparse
import asyncio
import json
from pathlib import Path
import signal
import tempfile

from core.client.analysis import read_token
from core.client.source_conversion import convert_source
from core.client.source_conversion_formats import diagnostics
from core.client.transport import AnalysisClientError


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Convert a fixed source on this PC; optionally store its client-reported text.")
    parser.add_argument("--diagnose", action="store_true")
    for name in ("server", "tenant", "source-id", "source-version", "source-sha256", "registration-revision"):
        parser.add_argument("--" + name)
    parser.add_argument("--profile")
    parser.add_argument("--request-id")
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--cancel-file", type=Path)
    parser.add_argument("--submit", action="store_true", help="Store the conversion report separately from the original.")
    parser.add_argument("--ocr", choices=["auto", "never", "always"], default="auto")
    parser.add_argument("--ocr-language", default="eng")
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    if args.diagnose:
        emit({"schema_version": 1, "type": "result", "ok": True, "diagnostics": diagnostics(args.ocr_language)})
        return
    for name in ("server", "tenant", "source_id", "source_version", "source_sha256", "registration_revision", "token_file", "work_dir"):
        if getattr(args, name) is None:
            parser.error("--" + name.replace("_", "-") + " is required unless --diagnose is used")
    # 신호는 취소 파일로 바꿔 전달하며 전송 중인 저장 응답을 중간에 버리지 않는다.
    with tempfile.TemporaryDirectory(prefix="wiki-conversion-cancel-") as temporary:
        cancel_file = args.cancel_file or Path(temporary) / "cancel"
        previous = {}
        def cancel(signum, frame):
            cancel_file.touch(mode=0o600, exist_ok=True)
        for name in (signal.SIGINT, signal.SIGTERM):
            previous[name] = signal.signal(name, cancel)
        try:
            result = asyncio.run(convert_source(base_url=args.server, tenant=args.tenant, token=read_token(args.token_file),
                source_ref={key: getattr(args, key) for key in ("source_id", "source_version", "source_sha256", "registration_revision")},
                work_dir=args.work_dir, profile=args.profile, request_id=args.request_id, cancel_file=cancel_file,
                submit=args.submit, ocr=args.ocr, ocr_language=args.ocr_language, timeout=args.timeout, on_event=emit))
            # 시작 전 오류에는 변환 방법이 없다. 로컬 진단은 보존하고 UI에는 null로 보낸다.
            converted = result.get("conversion")
            emit({**result, "type": "result", "conversion": converted if converted and converted.get("method") else None})
            raise SystemExit(130 if result["state"] == "cancelled" else 0 if result["ok"] else 1)
        except (AnalysisClientError, OSError, ValueError) as error:
            emit({"schema_version": 1, "type": "error", "ok": False,
                "error": {"code": error.code if isinstance(error, AnalysisClientError) else "client_input_or_file_error"}})
            raise SystemExit(1) from None
        finally:
            for name, handler in previous.items():
                signal.signal(name, handler)


if __name__ == "__main__":
    main()
