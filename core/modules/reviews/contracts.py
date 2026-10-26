"""검토 원장의 한도·엄격 필드·오류를 한 곳에서 소유한다.

한도를 낮춘 검증도 전체 원장을 버리지 않고 거부하도록 모든 읽기/쓰기가
이 모듈의 현재 값을 참조한다.
"""

# MAX_로 시작하는 값은 원장/이벤트/이력의 처리 한도다. 한도에 맞추려고 옛 기록을 잘라내지 않는다.
# Validation은 잘못된 입력, Corrupt는 기존 기록 손상, Conflict는 검토 기준 변경을 나타내며 처리 방법이 다르다.
import re
from core.modules.documents.store import RevisionConflictError


MAX_REVIEW_BYTES = 8 * 1024 * 1024

MAX_REVIEW_EVENTS = 1000

MAX_HISTORY_ENTRIES = 10000

_HEX = re.compile(r"[0-9a-f]{64}")

_ID = re.compile(r"[a-z][a-z0-9_-]{0,63}")

_UUID = re.compile(r"[0-9a-f]{32}")

_COLLECTIONS = ("relations", "attributes", "relation_candidates")

_ACTIONS = {"accept", "edit", "reject", "defer"}

_DECISIONS = _ACTIONS | {"unreviewed"}

_ACTOR_FIELDS = {"user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision"}

_EVENT_FIELDS = {
    "id", "action", "claim_id", "collection", "target", "before", "after", "reason",
    "actor", "timestamp", "source_revision", "graph_revision", "history_revision",
    "undo_of", "previous_hash", "hash",
}

_POLICY_ACTIONS = {"policy", "policy_undo"}

_POLICY_EVENT_FIELDS = _EVENT_FIELDS | {"scope", "base_state_revision", "before_effective", "after_effective"}

_POLICY_PREFIX = re.compile(r"policy_([0-9a-f]{32})_[0-9a-f]{16}")

class ReviewValidationError(ValueError):
    """The requested review is not a complete, source-supported operation."""

class ReviewCorruptError(ValueError):
    """The review ledger is invalid; it must not be silently replaced."""

class ReviewLimitError(ValueError):
    """Appending would exceed a bound; the entire previous ledger remains."""

class ReviewConflictError(RevisionConflictError):
    """The source/generation/review editing base is no longer current."""
