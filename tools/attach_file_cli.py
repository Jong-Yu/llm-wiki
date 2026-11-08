"""채팅 첨부용 파일 읽기. 파일 경로는 앱이 고른 개인 작업 폴더의 사본이며 결과는 stdout JSON 한 줄이다."""

import argparse
import json
from pathlib import Path

from core.client.attachment_text import AttachmentError, read_attachment

PROTOCOL = "attach-file-cli-v1"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read one attached file into text for the personal AI question.")
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--extension", required=True)
    parser.add_argument("--limit", type=int, default=12000)
    parser.add_argument("--ocr", choices=("auto", "never"), default="auto")
    parser.add_argument("--ocr-language", default="kor+eng")
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.limit <= 40000:
            raise AttachmentError("invalid_limit")
        value = {"ok": True, **read_attachment(args.file, args.extension, limit=args.limit, ocr=args.ocr, language=args.ocr_language)}
    except AttachmentError as error:
        value = {"ok": False, "error": {"code": error.code}}
    except Exception:
        value = {"ok": False, "error": {"code": "file_unreadable"}}
    print(json.dumps({"protocol": PROTOCOL, **value}, ensure_ascii=False, allow_nan=False), flush=True)
    return 0 if value["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
