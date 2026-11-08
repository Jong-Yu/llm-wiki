"""원문·그래프·원장·전체 이력의 같은 시점 기준을 캡처한다.

이 함수들은 호출자가 보유한 WikiStore 잠금에 참여하며 잠금을 다시 얻지 않는다.
그래프 생성의 guard도 이 경로를 써서 과거 검토가 새 세대에 이식되지 않게 한다.
"""

# source는 위키 원문, graph_raw는 기계 그래프, ledger_raw는 검토/정책 원장의 원래 바이트다.
# tokens는 이 자료들과 전체 수정 이력을 함께 묶은 기준 버전이다. 그중 하나라도 바뀌면 같은 검토 기준이 아니다.
from hashlib import sha256
from dataclasses import dataclass
import json
import os
import stat
from core.common.json_codec import canonical_json_bytes, canonical_json_hash as _hash
from . import contracts
from .contracts import ReviewCorruptError, ReviewLimitError, ReviewConflictError
from .values import _token
from .state import _source_layer_matches


@dataclass(frozen=True)
class _ValidatedReview:
    """Successful ledger validation bound to one exact locked capture."""

    key: tuple
    encoded: bytes
    digest: str
    machine: object

    @staticmethod
    def key_for(owner, document, source, graph_raw, ledger_raw, history_revision):
        return (str(owner.store.data_dir), document, source.revision, source.content,
                graph_raw, ledger_raw, history_revision)

    def matches(self, owner, document, source, graph_raw, ledger_raw, history_revision):
        try:
            return self.key == self.key_for(owner, document, source, graph_raw, ledger_raw, history_revision)
        except (AttributeError, TypeError, ValueError):
            return False

    def read(self, owner, document, source, graph_raw, ledger_raw, history_revision):
        try:
            if (not self.matches(owner, document, source, graph_raw, ledger_raw, history_revision)
                    or sha256(self.encoded).hexdigest() != self.digest):
                return None
            value = json.loads(self.encoded)
            return (value if type(value) is dict and value.get("document") == document
                    and type(value.get("events")) is list and value.get("version") in (1, 2) else None)
        except (AttributeError, TypeError, ValueError, UnicodeError, RecursionError):
            return None


def captured_ledger(self, document, source, graph_raw, ledger_raw, history_revision, *, machine=None):
    """Validate at the caller's original ledger-read point, then seal a copy."""
    ledger = self._ledger(ledger_raw, document)
    try:
        encoded = canonical_json_bytes(ledger)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return ledger, None
    proof = _ValidatedReview(_ValidatedReview.key_for(self, document, source, graph_raw, ledger_raw, history_revision),
                             encoded, sha256(encoded).hexdigest(), machine)
    return ledger, proof


def _read_bytes(self, document):
    path = self._path(document)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ReviewCorruptError("Review ledger must be a regular file")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            raw = stream.read(contracts.MAX_REVIEW_BYTES + 1)
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if len(raw) > contracts.MAX_REVIEW_BYTES:
        raise ReviewCorruptError("Review ledger exceeds its byte limit")
    return raw


def _history_revision(self, document):
    path = self.store._document_path(self.store.history_dir, document)
    try:
        with os.scandir(path) as entries:
            names = []
            for entry in entries:
                if len(names) >= contracts.MAX_HISTORY_ENTRIES:
                    raise ReviewLimitError("Source history exceeds the review scan limit")
                if not entry.is_file(follow_symlinks=False):
                    raise ReviewCorruptError("Source history entries must be regular files")
                names.append(entry.name)
    except FileNotFoundError:
        names = []
    return _hash(sorted(names))


def _snapshot_locked(self, document):
    # 한 잠금에서 원문·기계 그래프·원장·전체 이력을 읽어 서로 같은 관측 기준을 만든다.
    source = self.ontology._read_source(document)
    graph_raw = self.ontology._read_bytes(self.ontology._path(document))
    ledger_raw = self._read_bytes(document)
    ledger, tokens = self._captured_state(document, source, graph_raw, ledger_raw, self._history_revision(document))
    return source, graph_raw, ledger, tokens


def _captured_state(self, document, source, graph_raw, ledger_raw, history_revision, *, validated_capture=None):
    """Validate a caller's bounded capture from the same WikiStore lock."""
    # 각 구성의 지문과 전체 상태 지문을 계산한다. 원문만 같아도 검토/이력이 다르면 state_revision은 달라진다.
    _token(history_revision, "history_revision")
    ledger = (validated_capture.read(self, document, source, graph_raw, ledger_raw, history_revision)
              if isinstance(validated_capture, _ValidatedReview) else None)
    if ledger is None:
        ledger = self._ledger(ledger_raw, document)
    tokens = {"document": document, "source_revision": source.revision,
              "graph_revision": None if graph_raw is None else sha256(graph_raw).hexdigest(),
              "review_revision": None if ledger_raw is None else sha256(ledger_raw).hexdigest(),
              "history_revision": history_revision}
    tokens["state_revision"] = _hash(tokens)
    return ledger, tokens


def _query_captured(self, document, source, graph_raw, ledger_raw, history_revision, *, domain=None, viewpoint=None,
                    validated_capture=None):
    options = {} if validated_capture is None else {"validated_capture": validated_capture}
    ledger, tokens = self._captured_state(document, source, graph_raw, ledger_raw, history_revision, **options)
    machine = (getattr(validated_capture, "machine", None) if isinstance(validated_capture, _ValidatedReview)
               and validated_capture.matches(self, document, source, graph_raw, ledger_raw, history_revision) else None)
    render_options = {} if machine is None else {"machine_capture": machine}
    result = self._render(source, graph_raw, ledger, tokens, domain, viewpoint, **render_options)
    if result["status"] == "ready" and result["machine_graph"].get("schema_version") in (3, 4, 5, 6):
        try:
            source_layer = (result if _source_layer_matches(ledger, domain, viewpoint)
                else self._render(source, graph_raw, ledger, tokens, policies=False, **render_options))
            self._validate_effective(source, source_layer)
            self._validate_effective(source, result)
        except (ValueError, TypeError) as error:
            raise ReviewCorruptError("Current reviewed graph is inconsistent") from error
    return result


def guard_generation(self, document, expected_state_revision=None):
    """Called by generation while its existing WikiStore lock is held."""
    # 검토 이력이 있으면 최신 복합 state_revision도 필요하다. 원문 버전만 맞춘 재생성으로 옛 판단을 덮어쓰지 못하게 한다.
    if expected_state_revision is None and self._read_bytes(document) is None:
        return
    if expected_state_revision is not None:
        _token(expected_state_revision, "expected_state_revision")
    _, _, ledger, tokens = self._snapshot_locked(document)
    if ((ledger["events"] or ledger.get("relation_events") or expected_state_revision is not None)
            and tokens["state_revision"] != expected_state_revision):
        raise ReviewConflictError(document, expected_state_revision, tokens["state_revision"])

