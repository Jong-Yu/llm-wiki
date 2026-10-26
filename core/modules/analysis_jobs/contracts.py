"""분석 접수 묶음의 한도와 공개 오류. AI 결과 저장 계약은 아직 포함하지 않는다."""

# 작업의 서버 상태, CLI 자기보고, 임시 실행권(lease)은 서로 다른 값으로 관리한다.
# 이 파일은 각 파일에서 함께 사용할 한도와 검증 함수·오류 종류를 모은다.

from datetime import datetime, timezone
import re

MAX_JOBS = 1000
MAX_EVENTS = 1000
MAX_RUNS = 1000
MAX_TARGETS = 8
MAX_TOTAL_METADATA_BYTES = 16 * 1024 * 1024
LEASE_SECONDS = 300
HEX = re.compile(r"[0-9a-f]{64}")
ID = re.compile(r"[0-9a-f]{32}")
REPORTED_STATUSES = frozenset({"input_ready", "analyzing", "blocked", "failed", "stopped"})
BLOCKERS = ["common_ruleset_required", "fixed_input_bundle_required"]


class JobValidationError(ValueError):
    """작업 입력이나 CLI 보고가 접수 계약과 다르다."""


class JobCorruptError(ValueError):
    """작업·소유자·요청·lease 기록이 손상되었다."""


class JobLimitError(ValueError):
    """작업 또는 보존 이벤트 한도에 도달했다."""


class JobConflictError(Exception):
    def __init__(self, code="conflict", **details):
        self.code, self.details = code, details
        super().__init__("Reconcile the current job, source or lease basis.")


def identifier(value):
    # 식별자는 서버가 발급하는 32자리 값이다. 화면 제목이나 경로를 ID 대신 받지 않는다.
    if type(value) is not str or not ID.fullmatch(value):
        raise JobValidationError("A server-format identifier is required.")
    return value


def revision(value):
    # revision은 기준 내용의 지문이며 순번이 아니다. 앞부분만 보낸 값은 비교 기준으로 쓰지 않는다.
    if type(value) is not str or not HEX.fullmatch(value):
        raise JobValidationError("A complete revision is required.")
    return value


def instant(value):
    # 시간대 없는 시각은 PC마다 다르게 해석될 수 있어 거부하고 UTC 시각으로 통일한다.
    try:
        result = datetime.fromisoformat(value)
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError):
        raise JobCorruptError("A server timestamp is invalid.") from None
