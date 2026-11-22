"""로컬 실행 경과를 재사용 기준이나 서버 execution 계약과 분리해 관측한다."""

import asyncio
from contextlib import contextmanager
from time import perf_counter


def outcome(error):
    return "cancelled" if isinstance(error, asyncio.CancelledError) else "failed"


class StageTimings:
    """구간의 exclusive 시간만 합산해 중첩된 관측을 중복 집계하지 않는다.

    현재 실행기는 순차 실행이다. adapter 호출 시간은 별도 관측이므로 이 합계에
    다시 더하지 않는다. 전체 경과에는 구간 밖의 로컬 처리/대기도 포함된다.
    """
    def __init__(self, *, clock=None):
        self.clock = clock or perf_counter
        self.started = self.clock()
        self.ended = None
        self.status = "running"
        self.events = []
        self._active = []

    @contextmanager
    def measure(self, phase, **details):
        started = self.clock()
        if self._active:
            parent = self._active[-1]
            parent["exclusive_seconds"] += started - parent.pop("_resumed")
        event = {"phase": phase, **details, "status": "running",
                 "elapsed_seconds": 0.0, "exclusive_seconds": 0.0, "_resumed": started}
        self.events.append(event)
        self._active.append(event)
        try:
            yield event
        except BaseException as error:
            event.update(status=outcome(error), error_type=type(error).__name__)
            raise
        else:
            event["status"] = "completed"
        finally:
            ended = self.clock()
            event["elapsed_seconds"] = ended - started
            event["exclusive_seconds"] += ended - event.pop("_resumed")
            self._active.pop()
            if self._active:
                self._active[-1]["_resumed"] = ended

    async def wait(self, phase, awaitable, **details):
        with self.measure(phase, **details):
            return await awaitable

    def finish(self, status):
        self.ended = self.clock()
        self.status = status

    def summary(self):
        elapsed = (self.ended if self.ended is not None else self.clock()) - self.started
        phases = {}
        events = [{key: value for key, value in event.items() if not key.startswith("_")}
                  for event in self.events]
        for event in events:
            phase = event["phase"]
            phases[phase] = phases.get(phase, 0.0) + event["exclusive_seconds"]
        measured = sum(phases.values())
        return {"version": 1, "clock": "perf_counter", "status": self.status,
                "elapsed_seconds": elapsed, "measured_seconds": measured,
                "unmeasured_seconds": max(0.0, elapsed - measured),
                "phase_seconds": phases, "events": events,
                "aggregation": "exclusive_spans; adapter_call_durations_are_not_added",
                "boundary": "client_start_to_outcome_before_final_local_record"}
