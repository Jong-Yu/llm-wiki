"""Windows Job에 연결된 뒤에만 CLI를 생성하는 표준 라이브러리 bootstrap."""
import os
import sys


if __name__ == "__main__":
    import subprocess
    import threading
    if sys.argv[1:2] != ["--"] or os.read(sys.stdin.fileno(), 1) != b"\0":
        raise SystemExit(2)
    child = subprocess.Popen(sys.argv[2:], stdin=subprocess.PIPE)
    def forward():
        try:
            # Raw reads forward live cancel lines and leave no buffered lock held
            # by this daemon when the child finishes before the parent closes stdin.
            while block := os.read(sys.stdin.fileno(), 65536):
                child.stdin.write(block)
                child.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                child.stdin.close()
            except (BrokenPipeError, OSError):
                pass
    threading.Thread(target=forward, daemon=True).start()
    raise SystemExit(child.wait())
