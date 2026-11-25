"""변환 전용 자식 프로세스. 부모가 시간 제한·취소와 전체 프로세스 종료를 관리한다."""

import argparse
import json
import os
from pathlib import Path
import tempfile
import time
from .source_conversion_formats import convert_file


class CheckpointWriteError(OSError):
    """checkpoint 실패의 종류와 숫자만 전달하고 경로·예외 원문은 보관하지 않는다."""

    def __init__(self, error):
        self.code = ("conversion_checkpoint_locked" if transient_checkpoint_error(error)
                     else "conversion_checkpoint_write_failed")
        super().__init__(self.code)
        self.errno = error.errno
        self.winerror = getattr(error, "winerror", None)


def transient_checkpoint_error(error):
    """Windows의 짧은 공유/잠금·교체 거부만 재시도 대상으로 취급한다."""
    return isinstance(error, OSError) and getattr(error, "winerror", None) in {5, 32, 33}


def atomic_json(path, value):
    """이번 실행 전용 디렉터리의 checkpoint만 원자적으로 교체한다."""
    path = Path(path)
    descriptor, name = tempfile.mkstemp(prefix=".conversion-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        # 부모의 진행 조회나 보안 프로그램이 파일을 잠깐 열면 Windows는 교체를 거부한다.
        # 같은 완전한 임시 파일만 재시도하며 기존 checkpoint를 먼저 삭제하지 않는다.
        for attempt in range(8):
            try:
                os.replace(name, path)
                break
            except OSError as error:
                if not transient_checkpoint_error(error) or attempt == 7:
                    raise
                time.sleep(min(.01 * 2 ** attempt, .2))
    except OSError as error:
        raise CheckpointWriteError(error) from None
    finally:
        Path(name).unlink(missing_ok=True)


def worker_failure(error):
    """파서 원문·파일 경로 없이 지원에 필요한 고정 분류와 OS 숫자만 남긴다."""
    code = (error.code if isinstance(error, CheckpointWriteError)
            else "conversion_memory_failed" if isinstance(error, MemoryError)
            else "conversion_worker_io_failed" if isinstance(error, OSError)
            else "conversion_worker_exception")
    value = {"schema_version": 1, "code": code}
    for key in ("errno", "winerror"):
        number = getattr(error, key, None)
        if type(number) is int:
            value[key] = number
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("original", type=Path)
    parser.add_argument("format")
    parser.add_argument("result", type=Path)
    parser.add_argument("--ocr", choices=["auto", "never", "always"], default="auto")
    parser.add_argument("--language", default="eng")
    parser.add_argument("--page", type=int)
    parser.add_argument("--failure-report", type=Path)
    args = parser.parse_args()
    try:
        options = {"selected_page": args.page} if args.page is not None else {}
        convert_file(args.original, args.format, ocr=args.ocr, language=args.language,
                     checkpoint=lambda value: atomic_json(args.result, value), **options)
    except Exception as error:
        if args.failure_report is not None:
            try:
                # checkpoint와 다른 새 파일이므로 기존 부분 결과를 덮지 않는다.
                atomic_json(args.failure_report, worker_failure(error))
            except (OSError, CheckpointWriteError):
                pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
