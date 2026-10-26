"""요청 공유 바이트/오류 캐시·자료 수·전체 history 관측을 관리한다."""

# 같은 요청의 파일 읽기·오류·history 관측과 남은 용량을 관리한다.
# _read에서 바이트를 캡처하고 _history_capture에서 전체 수정 이력을 확인한다. 일부 실패를 정상적인 빈 자료로 바꾸지 않는다.

from .contracts import ConceptCaptureLimitError
from core.modules.correspondences.contracts import CorrespondenceCorruptError
from core.modules.correspondences.contracts import CorrespondenceLimitError
from core.modules.ontology.errors import OntologyCorruptError
from core.modules.reviews.contracts import ReviewCorruptError
from core.modules.ontology.errors import _ContextBudgetError
from .capture_errors import _error_code
from core.common.json_codec import canonical_json_hash as _hash
from . import contracts
from copy import deepcopy
import os
from hashlib import sha256


def _touch(self, kind, key, purpose, required_by):
    identity = kind, key
    row = self._rows.setdefault(identity, {"kind": kind, "key": key, "revision": None,
                "status": "not_requested", "captured_bytes": 0, "purpose": [], "required_by": []})
    for field, values in (("purpose", purpose), ("required_by", required_by)):
        values = values if isinstance(values, (list, tuple, set)) else [values]
        for value in values:
            if value is not None and value not in row[field]:
                row[field].append(value)
        row[field].sort()
    # Cached failures gain the new request's provenance as well.
    for item in self.skipped:
        if item.get("resource_kind") == kind and item.get("resource_key") == key:
            item["required_by"] = list(row["required_by"])
    return row

def _skip(self, kind, key, error=None, *, reason=None, phase="capture", truncated=False):
    reason = reason or _error_code(error)
    identity = (kind, key, phase, reason)
    if not any((item["resource_kind"], item["resource_key"], item["phase"], item["reason"]) == identity for item in self.skipped):
        row = self._rows.get((kind, key), {})
        item = {"component": kind, "phase": phase, "reason": reason,
                "resource_kind": kind, "resource_key": key,
                "required_by": list(row.get("required_by", []))}
        if kind in {"source", "graph", "review", "history"}:
            item["document"] = key
        elif kind == "correspondence":
            item["correspondence_id"] = key
        if error is not None:
            item["error_type"] = type(error).__name__
            if getattr(error, "errno", None) is not None:
                item["errno"] = error.errno
        self.skipped.append(item)
    self.truncated = self.truncated or truncated or isinstance(error, (ConceptCaptureLimitError, CorrespondenceLimitError))

def _reserve(self, kind, key):
    selected = self._correspondence_ids if kind == "correspondence" else self._documents
    maximum = self.limits["correspondences" if kind == "correspondence" else "documents"]
    if key not in selected:
        count = len(selected) + (0 if kind == "correspondence" else len(self._unresolved_review_files))
        if count >= maximum:
            raise ConceptCaptureLimitError("Request exceeds its unique resource count")
        selected.add(key)

def _path(self, kind, key):
    if kind == "source":
        return self.store._document_path(self.store.wiki_dir, key)
    if kind == "graph":
        return self.ontology._path(key)
    if kind == "review":
        return self.reviews._path(key)
    if kind == "correspondence":
        return self.correspondences._path(key)
    raise ValueError("unsupported file component")

def _read(self, kind, key, purpose, required_by):
    """같은 자료의 바이트·오류를 재사용해 한 요청의 공유 예산을 중복 계산하지 않는다."""
    # 같은 파일의 원래 바이트 또는 읽기 실패를 한 요청 안에서 재사용한다. 성공한 일부를 전체 파일로 대체하지 않는다.
    row = self._touch(kind, key, purpose, required_by)
    identity = kind, key
    if identity in self.errors:
        raise self.errors[identity]
    if identity in self.raw:
        return self.raw[identity]
    before = self.remaining[0]
    try:
        self._reserve(kind, key)
        path = self._path(kind, key)
        limits = {"source": contracts.MAX_DOCUMENT_BYTES, "graph": contracts.MAX_ONTOLOGY_BYTES,
                  "review": contracts.MAX_REVIEW_BYTES, "correspondence": contracts.MAX_CORRESPONDENCE_BYTES}
        raw = self.ontology._context_bytes(path, self.remaining, key,
                   "source" if kind == "source" else "ontology", max_bytes=limits[kind])
    except (OSError, ValueError, TypeError) as error:
        if isinstance(error, _ContextBudgetError):
            error = ConceptCaptureLimitError("Shared capture byte budget exhausted")
        elif isinstance(error, OntologyCorruptError) and kind == "review":
            error = ReviewCorruptError("Stored review component is not a bounded regular file")
        elif isinstance(error, OntologyCorruptError) and kind == "correspondence":
            error = CorrespondenceCorruptError("Stored correspondence is not a bounded regular file")
        row.update(status="unavailable", captured_bytes=before - self.remaining[0])
        self.errors[identity] = error
        self._skip(kind, key, error)
        raise error
    row.update(status="missing" if raw is None else "ready", captured_bytes=before - self.remaining[0],
               revision=None if raw is None else sha256(raw).hexdigest())
    self.raw[identity] = raw
    return raw

def _validated_error(self, kind, key, error, *, phase="validation"):
    self.errors[(kind, key)] = error
    self._rows[(kind, key)]["status"] = "unavailable"
    self._skip(kind, key, error, phase=phase)

def _history_capture(self, document, purpose, required_by):
    # 전체 history를 관측해 내용이 A→B→A로 돌아온 중간 변경도 구분할 근거를 만든다.
    row = self._touch("history", document, purpose, required_by)
    identity = "history", document
    if identity in self.errors:
        raise self.errors[identity]
    if document in self._history:
        return self._history[document]
    try:
        self._reserve("history", document)
        path = self.store._document_path(self.store.history_dir, document)
        names = []
        exists = True
        try:
            entries = os.scandir(path)
        except FileNotFoundError:
            entries, exists = None, False
        if entries is not None:
            with entries:
                while True:
                    # One lookahead distinguishes an exact boundary from an
                    # incomplete listing; only accepted entries consume budget.
                    try:
                        entry = next(entries)
                    except StopIteration:
                        break
                    if len(names) >= contracts.MAX_HISTORY_ENTRIES or self.history_entries >= self.limits["history_entries"]:
                        raise ConceptCaptureLimitError("History entry budget exhausted")
                    self.history_entries += 1
                    if not entry.is_file(follow_symlinks=False):
                        raise ReviewCorruptError("Source history entries must be regular files")
                    names.append(entry.name)
        names.sort()
        result = {"names": names, "revision": _hash(names), "exists": exists}
        row.update(status="ready", revision=result["revision"], exists=exists,
                   captured_entries=len(names), captured_bytes=0)
        self._history[document] = result
        return result
    except (OSError, ValueError, TypeError) as error:
        row.update(status="unavailable", revision=None)
        self.errors[identity] = error
        self._skip("history", document, error)
        raise

def _component(self, kind, key):
    row = self._rows.get((kind, key))
    if row is None:
        return {"status": "not_requested", "revision": None, "captured_bytes": 0}
    result = {name: deepcopy(row[name]) for name in ("status", "revision", "captured_bytes")}
    for name in ("exists", "captured_entries"):
        if name in row:
            result[name] = row[name]
    error = self.errors.get((kind, key))
    if error is not None:
        result["error"] = {"code": _error_code(error), "error_type": type(error).__name__, "errno": getattr(error, "errno", None)}
    return result
