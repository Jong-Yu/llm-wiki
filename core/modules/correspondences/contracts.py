"""대응 업무의 상한·예외·보존 원장 필드를 단일 위치에서 정의한다.

상한을 주입하는 회귀 검사는 이 모듈을 대상으로 한다. 업무 상태나 저장소를 생성하지 않는다.
"""

# 대응 파일·이벤트·의존 자료와 응답에 적용할 한도/허용 필드/오류를 정의한다.
# 상수를 읽는 것만으로 파일을 만들거나 판단을 바꾸지는 않는다. 손상·한도는 기존 원장을 초기화할 이유가 아니다.

import re

from core.modules.documents.store import RevisionConflictError

MAX_CORRESPONDENCE_BYTES = 8 * 1024 * 1024

MAX_CORRESPONDENCE_EVENTS = 1000

MAX_DEPENDENCY_DOCUMENTS = 8

MAX_DEPENDENCY_CORRESPONDENCES = 8

MAX_REFERENCE_DEPTH = 4

MAX_CAPTURE_BYTES = 32 * 1024 * 1024

MAX_DETAIL_BYTES = 16 * 1024 * 1024

MAX_RECEIPT_BYTES = 2 * 1024 * 1024

MAX_FIND_FILES = 100

MAX_FIND_ENTRIES = 1000

MAX_FIND_BYTES = 32 * 1024 * 1024

MAX_FIND_OUTPUT_BYTES = 2 * 1024 * 1024

HEX = re.compile(r"[0-9a-f]{64}")

UUID = re.compile(r"[0-9a-f]{32}")

class CorrespondenceValidationError(ValueError):
    """Incomplete or unsupported correspondence input."""

class CorrespondenceCorruptError(ValueError):
    """Invalid preserved ledger; never initialize over it."""

class CorrespondenceLimitError(ValueError):
    """A whole value/history cannot fit; nothing is discarded."""

class CorrespondenceConflictError(RevisionConflictError):
    """Re-read the actual contents and reconcile, rather than swapping tokens."""

_EVENT_FIELDS = {"id", "sequence", "action", "lane", "judgment_id", "before", "after", "reason", "actor", "timestamp", "basis_dependencies", "observed_dependencies", "base_state_revision", "undo_of", "supersedes_event_id", "previous_hash", "hash"}

_SNAPSHOT_FIELDS = {"value", "decision", "basis_dependencies", "policy_scope", "supersedes_event_id", "origin_event_id"}

_EMPTY = {"documents": [], "correspondences": []}
