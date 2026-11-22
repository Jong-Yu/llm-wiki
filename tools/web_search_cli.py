"""현재 질문 또는 명시 검색어만 개인 AI의 웹 검색에 보내고 읽은 본문을 반환한다."""

import argparse
import asyncio
import json
from pathlib import Path

from core.client.web_research import research
from tools.cli_io import add_ai_arguments

PROTOCOL = "web-search-cli-v1"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Search public pages with the selected personal AI and read their text.")
    parser.add_argument("--work-dir", required=True, type=Path)
    input_group = parser.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--query-file", type=Path)
    input_group.add_argument("--question-file", type=Path)
    add_ai_arguments(parser, default_timeout=90)
    args = parser.parse_args(argv)
    try:
        question_based = args.question_file is not None
        limit = 16000 if question_based else 200
        with (args.question_file or args.query_file).open("r", encoding="utf-8") as stream:
            raw = stream.read(limit + 2)
        text = raw.strip()
        if len(raw) > limit + 1 or not 1 <= len(text) <= limit:
            raise ValueError("invalid_question" if question_based else "invalid_query")
        web = asyncio.run(research(None if question_based else text,
            question=text if question_based else None, provider=args.ai_provider, cli=args.ai_cli, model=args.ai_model,
            directory=args.work_dir / "invocation", timeout_seconds=args.ai_timeout))
        value = {"ok": True, "web": web}
    except (OSError, ValueError):
        value = {"ok": False, "error": {"code": "invalid_question" if args.question_file else "invalid_query"}}
    print(json.dumps({"protocol": PROTOCOL, **value}, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if value["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
