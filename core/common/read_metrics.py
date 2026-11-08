"""개인정보 없이 요청 안의 고정 단계 시간·건수만 모으는 선택적 측정 도우미.

HTTP 계층이 collect()를 소유하고 업무 계층은 span/increment/cache_event만 쓴다.
단계 시간은 중첩·병렬 구간을 포함한 합계이므로 전체 요청 시간과 더하지 않는다.
측정 오류는 업무 결과·예외를 바꾸지 않으며 요청 밖에서는 아무 기록도 하지 않는다.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock
from time import perf_counter
from uuid import uuid4


STAGES = frozenset({"authorization", "lock_wait", "lock_hold", "scan", "fingerprint",
    "index_lookup", "index_sync", "index_page", "canonical_read", "projection", "serialize"})
COUNTERS = frozenset({"scanned", "changed", "canonical_reads", "journal_reads", "reconciliations",
    "snapshot_hits", "cache_hits", "cache_misses", "cache_fallbacks"})
CACHE_REASONS = frozenset({"busy", "corrupt", "schema", "io", "unsafe_path", "unknown"})
_CURRENT = ContextVar("read_metrics", default=None)
_MAX_COUNT = 1_000_000_000


def _label(value, allowed):
    return value if type(value) is str and value in allowed else "other"


class RequestMetrics:
    """같은 요청에서 복사된 ContextVar·작업 스레드가 공유하는 작은 수집기."""

    def __init__(self):
        self.request_id = uuid4().hex
        self._lock = Lock()
        self._closed = False
        self._durations = {}
        self._calls = {}
        self._counters = {}
        self._fallbacks = {}

    def stage(self, name, seconds):
        name = _label(name, STAGES)
        with self._lock:
            if not self._closed:
                self._durations[name] = self._durations.get(name, 0.0) + max(0.0, seconds * 1000)
                self._calls[name] = min(_MAX_COUNT, self._calls.get(name, 0) + 1)

    def increment(self, name, amount):
        name = _label(name, COUNTERS)
        with self._lock:
            if not self._closed:
                self._counters[name] = min(_MAX_COUNT, self._counters.get(name, 0) + amount)

    def cache_event(self, outcome, reason):
        outcome = _label(outcome, {"hit", "miss", "fallback"})
        reason = reason if type(reason) is str and reason in CACHE_REASONS else "unknown"
        with self._lock:
            if self._closed:
                return
            counter = {"hit": "cache_hits", "miss": "cache_misses", "fallback": "cache_fallbacks"}.get(outcome, "other")
            self._counters[counter] = min(_MAX_COUNT, self._counters.get(counter, 0) + 1)
            if outcome == "fallback":
                self._fallbacks[reason] = min(_MAX_COUNT, self._fallbacks.get(reason, 0) + 1)

    def finish(self):
        with self._lock:
            self._closed = True
            return {"request_id": self.request_id,
                "stages_ms": {key: round(value, 3) for key, value in sorted(self._durations.items())},
                "stage_calls": dict(sorted(self._calls.items())),
                "counters": dict(sorted(self._counters.items())),
                "cache_fallbacks": dict(sorted(self._fallbacks.items()))}


@contextmanager
def collect():
    """전송 계층만 요청 시작/종료에 사용한다. 중첩 요청은 바깥 수집기를 복원한다."""
    metrics = token = None
    try:
        metrics = RequestMetrics()
        token = _CURRENT.set(metrics)
    except Exception:
        pass
    try:
        yield metrics
    finally:
        if token is not None:
            try:
                _CURRENT.reset(token)
            except Exception:
                pass


@contextmanager
def span(stage):
    """허용된 고정 단계의 실제 구간만 측정하며 원래 예외를 그대로 전파한다."""
    metrics = started = None
    try:
        metrics = _CURRENT.get()
        if metrics is not None:
            started = perf_counter()
    except Exception:
        pass
    try:
        yield
    finally:
        if metrics is not None and started is not None:
            try:
                metrics.stage(_label(stage, STAGES), perf_counter() - started)
            except Exception:
                pass


def increment(counter, amount=1):
    """경로·식별자 대신 고정 카운터 이름과 음수가 아닌 정수만 기록한다."""
    try:
        metrics = _CURRENT.get()
        if metrics is not None and type(amount) is int and 0 <= amount <= _MAX_COUNT:
            metrics.increment(_label(counter, COUNTERS), amount)
    except Exception:
        pass


def cache_event(outcome, reason=None):
    """cache hit/miss/fallback과 제한된 원인만 기록한다. 예외 문자열은 받지 않는다."""
    try:
        metrics = _CURRENT.get()
        if metrics is not None:
            selected = _label(outcome, {"hit", "miss", "fallback"})
            metrics.cache_event(selected, reason if type(reason) is str and reason in CACHE_REASONS else "unknown")
    except Exception:
        pass
