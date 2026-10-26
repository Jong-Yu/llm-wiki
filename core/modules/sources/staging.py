"""업로드를 공개 전에 제한된 스트림으로 수신하고 UTF-8·hash를 고정한다."""

# staging은 업로드 중인 파일의 임시 보관 단계다. 여기서는 등록 카탈로그나 위키를 갱신하지 않는다.
# 읽은 바이트를 그대로 쓰면서 크기·문자 형식·내용 지문을 함께 계산한다.

import codecs
from hashlib import sha256
import os
from uuid import uuid4

from . import contracts as limits
from .contracts import StagedSource, SourceCorruptError, SourceLimitError, SourceTooLargeError, metadata
from . import files
from .formats import validate_binary


def discard(self, staged):
    """이 호출이 만든 staging만 지운다. 정리 실패는 원래 저장 결과와 구분한다."""
    failures = []
    if staged.consumed:
        # 이미 공개된 원본은 더 이상 임시 파일이 아니다. 이번 정리 대상에서 제외한다.
        return failures
    directory = staged.directory
    if directory.parent != self.store.data_dir / "_incoming" or not limits.ID.fullmatch(directory.name):
        raise SourceCorruptError("The staging reference is invalid.")
    files.checked(self.store, directory)
    for path in (directory / "original", directory / "manifest.json", directory):
        try:
            if path == directory:
                path.rmdir()
            else:
                path.unlink(missing_ok=True)
        except FileNotFoundError:
            pass
        except OSError as error:
            failures.append({"path": path.relative_to(self.store.data_dir).as_posix(),
                             "error_type": type(error).__name__, "errno": error.errno})
    return failures


def stage(self, stream, *, kind, title, format, filename=None):
    # stream.read(n)으로 조금씩 읽어 메모리에 전체 원본을 올리지 않는다.
    # 성공 시 임시 폴더·크기·지문을 담은 StagedSource를 돌려주며 공개는 commit이 담당한다.
    values = metadata(kind=kind, title=title, format=format, filename=filename)
    if not hasattr(stream, "read"):
        raise limits.SourceValidationError("A binary input stream is required.")
    directory = self.store.data_dir / "_incoming" / uuid4().hex
    staged = StagedSource(directory, values, 0, "")
    try:
        with self._coordination_lock(create=True):
            used = files.original_usage(self.store, published=False)
            files.mkdir(self.store, directory)
            descriptor = os.open(directory / "original", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            # 텍스트만 UTF-8로 검사한다. 바이너리는 아래에서 형식 표식을 확인한다.
            decoder = codecs.getincrementaldecoder("utf-8")("strict") if format in {"md", "txt"} else None
            # 한글 한 글자의 바이트가 두 조각에 걸쳐 와도 이 decoder가 이어서 검사한다.
            digest = sha256()
            with os.fdopen(descriptor, "wb") as destination:
                while block := stream.read(limits.CHUNK_BYTES):
                    # :=는 읽은 조각을 block에 담으면서 반복 조건으로도 사용한다. 빈 바이트면 종료한다.
                    if type(block) is not bytes:
                        raise limits.SourceValidationError("The source stream must return bytes.")
                    staged.size_bytes += len(block)
                    if staged.size_bytes > limits.MAX_SOURCE_BYTES:
                        raise SourceTooLargeError(staged.size_bytes)
                    if used + staged.size_bytes > limits.MAX_STAGING_BYTES:
                        raise SourceLimitError("The tenant staging-byte quota was reached.")
                    if decoder is not None:
                        decoder.decode(block)
                    destination.write(block)
                    digest.update(block)
                if decoder is not None:
                    decoder.decode(b"", final=True)
                # 마지막에 미완성 UTF-8 문자가 남았는지도 확인한 뒤 디스크 쓰기를 마무리한다.
                destination.flush()
                os.fsync(destination.fileno())
            staged.source_sha256 = digest.hexdigest()
            if decoder is None:
                # 확장자만 바꾼 입력을 거부한다. 원본은 실행/변환/재압축하지 않는다.
                with files.open_regular(self.store, directory / "original") as original:
                    validate_binary(original, format)
        return staged
    except BaseException as error:
        # 취소를 포함해 수신이 중단돼도 이번 임시 파일만 정리하고 원래 오류를 다시 전달한다.
        failures = discard(self, staged)
        if failures:
            error.cleanup_failures = [*getattr(error, "cleanup_failures", []), *failures]
        raise
