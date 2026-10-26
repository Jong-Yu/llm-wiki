"""변환 전용 자식 프로세스. 부모가 시간 제한·취소와 전체 프로세스 종료를 관리한다."""

import argparse
import json
import os
from pathlib import Path
import tempfile
from .source_conversion_formats import convert_file


def atomic_json(path, value):
    """이번 실행 전용 디렉터리의 checkpoint만 원자적으로 교체한다."""
    path = Path(path)
    descriptor, name = tempfile.mkstemp(prefix=".conversion-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("original", type=Path)
    parser.add_argument("format")
    parser.add_argument("result", type=Path)
    parser.add_argument("--ocr", choices=["auto", "never", "always"], default="auto")
    parser.add_argument("--language", default="eng")
    args = parser.parse_args()
    convert_file(args.original, args.format, ocr=args.ocr, language=args.language,
                 checkpoint=lambda value: atomic_json(args.result, value))


if __name__ == "__main__":
    main()
