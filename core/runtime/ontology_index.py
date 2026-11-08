"""기동 전·저장 후 온톨로지 조회 색인을 준비하는 단일 Python 작업자.

AI·원문/그래프 쓰기·토큰 보관 없이 현재 정책의 read 범위만 계산한다. 기존
쓰기 원장의 lock stamp를 관찰하므로 HTTP/MCP 및 별도 Python writer를 함께
감지한다. 조회의 기존 권한/현재성 검사를 남겨 준비 경쟁·실패도 안전하게 처리한다.
"""

from collections import OrderedDict
import json
import logging
import stat
from threading import Event, Lock, Thread
import time

from core.common.access import access_basis, access_dict
from core.common.json_codec import canonical_json_hash
from core.common.read_metrics import collect
from core.common.read_snapshots import RECONCILE_SECONDS
from core.modules.documents.store import StorageBusyError, WikiStore
from core.modules.knowledge.concepts import ConceptStore
from core.modules.knowledge.ontology_exploration import IndexPreparationStopped, prepare_index


LOGGER = logging.getLogger("core.ontology_index")
MAX_SCOPES = 64


class OntologyIndexPreparer:
    """한 작업자·제한된 상태로 색인을 준비하며 저장 성공 여부에는 관여하지 않는다."""

    def __init__(self, policy, *, interval=0.25, reconcile_seconds=RECONCILE_SECONDS):
        self.policy = policy
        self.interval = interval
        self.reconcile_seconds = reconcile_seconds
        self._stop = Event()
        self._initial = Event()
        self._thread = None
        self._states = OrderedDict()
        self._failures = OrderedDict()
        self._guard = Lock()
        self._passes = Lock()
        self._counts = {"prepared": 0, "failed": 0, "busy": 0}

    @staticmethod
    def _stamp(store):
        """쓰기 기록의 metadata만 읽고 링크·비정상 잠금은 준비된 값으로 신뢰하지 않는다."""
        path = store.data_dir / ".storage.lock"
        store._check_path(path)
        try:
            info = path.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            return None
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns

    def status(self):
        """진단에는 수량/수명만 제공하며 경로·사용자·인증정보는 반환하지 않는다."""
        with self._guard:
            return {**self._counts, "scopes": len(self._states),
                    "initial_finished": self._initial.is_set(),
                    "running": self._thread is not None and self._thread.is_alive()}

    def run_once(self):
        """현재 정책을 다시 확인한 한 순회. 원본 변경은 기존 캡처에서 문서별로 처리한다."""
        with self._passes:
            active = set()
            for scope in self.policy.index_scopes():
                if self._stop.is_set():
                    break
                identity = scope.store.data_dir.stat()
                key = (str(scope.store.data_dir), identity.st_dev, identity.st_ino,
                       canonical_json_hash(access_basis(scope)))
                active.add(key)
                now = time.monotonic()
                try:
                    stamp = self._stamp(scope.store)
                    with self._guard:
                        previous = self._states.get(key)
                        failed = self._failures.get(key)
                        if previous is not None:
                            self._states.move_to_end(key)
                    if failed is not None and stamp == failed[0] and now < failed[1]:
                        continue
                    if (stamp is not None and previous is not None and stamp == previous[0]
                            and now - previous[1] < self.reconcile_seconds):
                        continue
                    # 배경 작업은 쓰기 잠금을 오래 기다리지 않고 다음 순회에 다시 확인한다.
                    store = WikiStore(scope.store.data_dir, tracked_reads=True,
                        lock_timeout_seconds=min(scope.store.lock_timeout_seconds, 0.05))
                    started = time.monotonic()
                    with collect() as metrics:
                        prepared = prepare_index(ConceptStore(store, access_dict(scope)),
                                                 should_stop=self._stop.is_set)
                    snapshot = metrics.finish() if metrics is not None else {}
                    with self._guard:
                        self._states[key] = prepared, time.monotonic()
                        self._states.move_to_end(key)
                        while len(self._states) > MAX_SCOPES:
                            self._states.popitem(last=False)
                        self._counts["prepared"] += 1
                        self._failures.pop(key, None)
                    LOGGER.info(json.dumps({"event": "ontology_index_prepared",
                        "duration_ms": round((time.monotonic() - started) * 1000, 3),
                        "documents_updated": snapshot.get("stage_calls", {}).get("index_sync", 0),
                        "canonical_reads": snapshot.get("counters", {}).get("canonical_reads", 0)}))
                except IndexPreparationStopped:
                    break
                except StorageBusyError:
                    with self._guard:
                        self._counts["busy"] += 1
                except Exception as error:
                    with self._guard:
                        self._counts["failed"] += 1
                        first_failure = key not in self._failures
                        self._failures[key] = self._stamp_or_none(scope.store), now + 5
                        self._failures.move_to_end(key)
                        while len(self._failures) > MAX_SCOPES:
                            self._failures.popitem(last=False)
                    # 정제한 유형만 기록한다. 실패를 저장 재시도나 빈 성공으로 바꾸지 않는다.
                    if first_failure:
                        LOGGER.warning("Ontology index preparation failed (%s)", type(error).__name__)
            with self._guard:
                for key in set(self._states) - active:
                    del self._states[key]
                for key in set(self._failures) - active:
                    del self._failures[key]

    def _stamp_or_none(self, store):
        """에러 처리의 경로 검사 실패도 원래 색인 실패와 분리해 둔다."""
        try:
            return self._stamp(store)
        except (OSError, ValueError):
            return None

    def _run(self):
        """여러 변경을 다음 순회로 모으며 오류·중단에서도 기동 대기를 끝낸다."""
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception as error:
                with self._guard:
                    self._counts["failed"] += 1
                    self._states.clear()
                LOGGER.warning("Ontology index policy scan failed (%s)", type(error).__name__)
                self._stop.wait(5)
            finally:
                self._initial.set()
            self._stop.wait(self.interval)

    def start(self):
        """ASGI 수명에서 한 번 시작하며 기본 strict 서버에는 작업자를 만들지 않는다."""
        if self._thread is not None:
            raise RuntimeError("Ontology index preparer is already started")
        self._thread = Thread(target=self._run, name="ontology-index", daemon=True)
        self._thread.start()

    def wait_initial(self, timeout=30):
        """기동 준비를 제한 시간만 기다린다. 미완료 시 기존 조회 경로가 검증을 맡는다."""
        finished = self._initial.wait(timeout)
        if not finished:
            LOGGER.warning("Ontology index preparation is continuing after the startup wait")
        return finished

    def close(self):
        """문서 사이의 취소 지점에서 종료하고 원문/파생 파일을 삭제하지 않는다."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=30)
            if self._thread.is_alive():
                LOGGER.warning("Ontology index worker is still finishing a document")
