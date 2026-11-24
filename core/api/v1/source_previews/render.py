"""검증된 파일 descriptor를 별도 프로세스에서 한 페이지 PNG로 변환한다."""

import io
import math
import subprocess
import sys
from threading import BoundedSemaphore

MAX_PNG_BYTES = 8 * 1024 * 1024
MAX_EDGE = 1600
TIMEOUT_SECONDS = 20
_capacity = BoundedSemaphore(1)


class PreviewError(Exception):
    def __init__(self, code, status=422):
        self.code, self.status = code, status
        super().__init__(code)


def render_page(stream, page):
    """동시 PDFium 호출과 서버 메모리 누적을 피하고 종료 시간을 제한한다."""
    if not _capacity.acquire(blocking=False):
        raise PreviewError("source_preview_busy", 503)
    try:
        try:
            result = subprocess.run([sys.executable, "-m", __name__, str(page)],
                stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=TIMEOUT_SECONDS, check=False)
        except subprocess.TimeoutExpired:
            raise PreviewError("source_preview_timeout", 503) from None
        if result.returncode == 3:
            raise PreviewError("source_page_not_found", 404)
        if result.returncode == 4:
            raise PreviewError("source_preview_unavailable", 503)
        if (result.returncode != 0 or not result.stdout.startswith(b"\x89PNG\r\n\x1a\n")
                or len(result.stdout) > MAX_PNG_BYTES):
            raise PreviewError("source_preview_failed")
        return result.stdout
    finally:
        _capacity.release()


def _worker(page):
    """렌더러만 자원 제한을 적용하며 원본·임시 복사·캐시 파일을 쓰지 않는다."""
    if sys.platform.startswith("linux"):
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    try:
        import pypdfium2
    except ImportError:
        return 4
    try:
        with pypdfium2.PdfDocument(sys.stdin.buffer) as document:
            if not 1 <= page <= len(document):
                return 3
            rendered = document[page - 1]
            try:
                width, height = rendered.get_size()
                if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                    return 2
                scale = min(2.0, MAX_EDGE / max(width, height))
                bitmap = rendered.render(scale=scale)
                try:
                    with bitmap.to_pil() as image:
                        output = io.BytesIO()
                        image.save(output, format="PNG")
                        data = output.getvalue()
                finally:
                    bitmap.close()
            finally:
                rendered.close()
        if len(data) > MAX_PNG_BYTES:
            return 2
        sys.stdout.buffer.write(data)
        return 0
    except Exception:
        return 2


if __name__ == "__main__":
    raise SystemExit(_worker(int(sys.argv[1])))
