"""명시 선택한 대조만 다시 실행한다. 원문 추출·저장을 반복하지 않는다."""
import argparse
import asyncio
import json
from pathlib import Path
import sys

from core.client.analysis import read_token
from core.client.ai import create_adapter
from core.client.comparison_restart import restart_comparison
from core.client.transport import client_error_code
from tools.cli_io import add_ai_arguments, cancellable


def main():
    """앱에서 전달한 고정 접수 ID를 같은 실행의 영수증 확인에 사용한다."""
    parser = argparse.ArgumentParser(description="Restart comparison only, using its saved AI session.")
    for name in ("server", "tenant", "comparison-id", "request-id"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--session-registry", type=Path,
                        help="Same protected session reference directory used by the analysis CLI.")
    parser.add_argument("--profile")
    add_ai_arguments(parser)
    args = parser.parse_args()
    try:
        adapter = create_adapter(args.ai_provider, cli=args.ai_cli, model=args.ai_model, timeout_seconds=args.ai_timeout)
        value = asyncio.run(cancellable(restart_comparison(base_url=args.server, tenant=args.tenant,
            token=read_token(args.token_file), comparison_id=args.comparison_id, request_id=args.request_id,
            work_dir=args.work_dir, adapter=adapter, provider=args.ai_provider, profile=args.profile,
            session_registry=args.session_registry)))
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except (Exception, asyncio.CancelledError) as error:
        print(json.dumps({"event": "comparison_failed", "request_id": args.request_id,
            "error": client_error_code(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
