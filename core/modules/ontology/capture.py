"""동일 잠금 안에서 그래프와 원문의 바이트를 안전하게 읽는다.

호출자가 WikiStore 잠금을 소유한다. 재진입 잠금을 추가하지 않으며,
성장하거나 바뀐 파일·읽다 실패한 입력도 기존 캡처 예산 규칙을 따른다."""

# raw는 파일에서 읽은 원래 바이트다. 텍스트를 해석하기 전에 파일 종류/크기와 읽는 중 변경 여부를 확인한다.
# remaining은 여러 구성 파일이 함께 사용하는 남은 용량 목록으로, 한 파일을 읽을 때마다 같은 값이 줄어든다.

import os
from pathlib import Path
import stat

from core.modules.documents.store import MAX_DOCUMENT_BYTES, DocumentTooLargeError
from . import constants
from .errors import OntologyCorruptError, _ContextBudgetError


def read_graph_bytes(ontology, path: Path):
    # 아직 그래프 파일이 없으면 None, 있으면 최대 크기를 확인한 원래 바이트를 반환한다.
    ontology.store._check_path(path)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OntologyCorruptError("Stored ontology must be a regular file")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            raw = stream.read(constants.MAX_ONTOLOGY_BYTES + 1)
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if len(raw) > constants.MAX_ONTOLOGY_BYTES:
        raise OntologyCorruptError("Stored ontology exceeds the 1 MiB byte limit")
    return raw


def capture_bytes(ontology, path: Path, remaining: list, document: str, component: str, *, max_bytes=None):
    """Capture bounded bytes; external file changes never create partial text.

    The caller holds the shared store lock. Read exactly the descriptor's
    measured size, so a growing file cannot consume another document's budget.
    The mutable budget also counts bytes of malformed inputs we later omit.
    """
    # remaining[0]을 공유 용량으로 사용한다. 글자 수가 아니라 실제 읽은 바이트 수만큼 차감한다.
    ontology.store._check_path(path)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if component == "ontology":
            return None
        raise
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            if component == "ontology":
                raise OntologyCorruptError("Stored ontology must be a regular file")
            raise OSError("Context input must be a regular file")
        limit = (MAX_DOCUMENT_BYTES if component == "source" else constants.MAX_ONTOLOGY_BYTES) if max_bytes is None else max_bytes

        def check_size(size):
            if size > limit:
                if component == "source":
                    raise DocumentTooLargeError(document, size)
                raise OntologyCorruptError("Captured input exceeds its byte limit")
            if size > remaining[0]:
                raise _ContextBudgetError("Context capture byte budget exhausted")

        check_size(info.st_size)
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            raw = stream.read(info.st_size)
            after = os.fstat(stream.fileno())
        # Recheck before decrementing: comparison uses this component's
        # original allowance, while the finally below counts bytes consumed.
        try:
            check_size(after.st_size)
            if (len(raw) != info.st_size or after.st_size != info.st_size
                    or after.st_mtime_ns != info.st_mtime_ns):
                raise OSError("Context input changed during capture")
        finally:
            remaining[0] -= len(raw)
        return raw
    finally:
        if descriptor is not None:
            os.close(descriptor)
