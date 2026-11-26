"""오류 보고는 위키와 분리한 data/voc의 불변 JSON 파일로 보존한다."""

from collections.abc import Callable
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes


_LOGGER = logging.getLogger(__name__)


def save_report(data_root: Path, *, user_id: str, content: str,
                before_commit: Callable[[], None]) -> dict[str, str]:
    """본문을 완성한 뒤 새 이름으로만 공개하며 사용자·경로 입력을 분리한다."""
    if type(content) is not str or not content.strip():
        raise ValueError("A report requires text.")
    report_id = uuid4().hex
    created_at = datetime.now(timezone.utc).isoformat()
    raw = canonical_json_bytes({"version": 1, "report_id": report_id,
        "created_at": created_at, "user_id": user_id, "content": content})
    root_fd = os.open(data_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir("voc", mode=0o700, dir_fd=root_fd)
        except FileExistsError:
            pass
        # 디렉터리 fd를 기준으로 열어 voc가 링크로 바뀌어도 다른 자료에 쓰지 않는다.
        directory_fd = os.open("voc", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        try:
            _publish(directory_fd, report_id + ".json", raw, before_commit)
        finally:
            os.close(directory_fd)
    finally:
        os.close(root_fd)
    return {"report_id": report_id, "created_at": created_at}


def _publish(directory_fd: int, filename: str, raw: bytes,
             before_commit: Callable[[], None]) -> None:
    """배타적 임시 파일과 hard link로 부분 공개·기존 보고 덮어쓰기를 막는다."""
    temporary = ".pending-" + uuid4().hex
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600, dir_fd=directory_fd)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        before_commit()
        os.link(temporary, filename, src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
            follow_symlinks=False)
        os.fsync(directory_fd)
    finally:
        # 이미 공개된 보고는 유지한다. 정리 실패 때문에 같은 보고를 다시 보내지 않는다.
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except OSError:
            _LOGGER.warning("Error report temporary file cleanup is pending.")
