"""고정 과거 형식 fixture가 사용하는 저장 API의 명시 호환 진입점.

실제 구현은 modules.documents.store가 소유한다. 새 업무·전송·검증 코드는
그 실제 소유 모듈을 참조하며 여기에는 저장 동작을 복제하지 않는다.
"""
# 기존 import를 유지하기 위한 통로다. 실제 저장 동작은 modules/documents/store.py에서 읽으면 된다.
# __all__은 이 모듈이 외부에 공개하는 클래스·상수·오류 이름을 정리한 목록이다.
from core.modules.documents.store import (
    CleanupFailure, DEFAULT_DATA_DIR, DEFAULT_LOCK_TIMEOUT_SECONDS,
    DocumentSnapshot, DocumentTooLargeError, MAX_DOCUMENT_BYTES,
    RevisionConflictError, SaveResult, StorageBusyError, WikiStore,
)

__all__ = [
    "CleanupFailure", "DEFAULT_DATA_DIR", "DEFAULT_LOCK_TIMEOUT_SECONDS",
    "DocumentSnapshot", "DocumentTooLargeError", "MAX_DOCUMENT_BYTES",
    "RevisionConflictError", "SaveResult", "StorageBusyError", "WikiStore",
]
