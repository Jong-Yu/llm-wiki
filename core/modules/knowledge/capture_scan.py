"""tenant 안의 문서/검토/대응 후보만 안전하게 발견하고 탐색 예산을 지킨다."""

# scan_documents/scan_correspondences는 선택한 tenant 안에서 조회 후보의 경로만 발견한다.
# 항목 수·문서 수·깊이 한도를 지키며 링크를 따라가지 않는다. 탐색 완료와 실제 자료 읽기 완료는 구분한다.

from .contracts import ConceptCaptureLimitError
from core.modules.correspondences.contracts import CorrespondenceCorruptError
from pathlib import Path
from core.modules.ontology.storage import legacy_key, validate_document_id
from core.modules.reviews.contracts import ReviewCorruptError
from core.modules.ontology.errors import _ContextBudgetError
from core.modules.ontology.snapshots import _reject_constant
from core.modules.ontology.snapshots import _unique_object
from . import contracts
from core.modules.correspondences.schema import identifier
import json
import os
from hashlib import sha256


def _entries(self, directory, phase):
    key = str(directory)
    if key in self._directory_cache:
        return self._directory_cache[key]
    collected = []
    try:
        self.store._check_path(directory)
        try:
            entries = os.scandir(directory)
        except FileNotFoundError:
            self._directory_cache[key] = []
            return []
        with entries:
            while True:
                try:
                    entry = next(entries)
                except StopIteration:
                    break
                if self.scanned_entries >= self.limits["entries"]:
                    raise ConceptCaptureLimitError("Directory scan entry budget exhausted")
                self.scanned_entries += 1
                collected.append(entry)
    except (OSError, ValueError, TypeError) as error:
        self._skip("scan", key, error, phase=phase)
    collected.sort(key=lambda entry: entry.name)
    self._directory_cache[key] = collected
    return collected

def scan_documents(self):
    # 원문/검토 후보 경로를 제한 탐색한다. 다른 tenant 자료를 먼저 읽고 결과에서 숨기는 방식은 쓰지 않는다.
    if self._scan_documents is not None:
        return list(self._scan_documents)
    candidates = set()
    pending = [self.store.wiki_dir]
    while pending:
        directory = pending.pop(0)
        for entry in self._entries(directory, "document_discovery"):
            try:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif entry.name.endswith(".md"):
                    name = Path(entry.path).relative_to(self.store.wiki_dir).as_posix()
                    self.store._document_path(self.store.wiki_dir, name)
                    candidates.add(name)
            except (OSError, ValueError, TypeError) as error:
                self._skip("scan", entry.path, error, phase="document_discovery")
        pending.sort()
        if self.truncated and self.scanned_entries >= self.limits["entries"]:
            break
    # A policy-only term must remain discoverable through a validated ledger
    # even if its source is missing. Never trust a claimed path before its
    # filename/hash and relative-path boundaries have been checked.
    for directory in self.reviews.review_dirs:
        for entry in self._entries(directory, "review_discovery"):
            if not entry.name.endswith(".json"):
                continue
            row_key = str(Path(entry.path).relative_to(self.store.data_dir))
            row = self._touch("review", row_key, "discovery", "discovery")
            try:
                if not entry.is_file(follow_symlinks=False):
                    raise ReviewCorruptError("Document-review discovery does not follow symbolic links")
                if len(self._unresolved_review_files) >= self.limits["documents"]:
                    raise ConceptCaptureLimitError("Document-review candidate limit exceeded")
                self._unresolved_review_files.add(row_key)
                path = Path(entry.path)
                before = self.remaining[0]
                try:
                    raw = self.ontology._context_bytes(path, self.remaining, entry.name, "ontology", max_bytes=contracts.MAX_REVIEW_BYTES)
                finally:
                    row["captured_bytes"] = before - self.remaining[0]
                row.update(status="missing" if raw is None else "ready", revision=None if raw is None else sha256(raw).hexdigest())
                if raw is None:
                    raise FileNotFoundError(entry.name)
                value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
                name = value.get("document") if isinstance(value, dict) else None
                self.store._document_path(self.store.wiki_dir, name)
                expected = sha256(name.encode("utf-8")).hexdigest()
                allowed = {expected} if directory == self.reviews.legacy_review_dir else {legacy_key(name)}
                if directory == self.reviews.review_dir and value.get("document_id") is not None:
                    allowed.add(validate_document_id(value["document_id"]))
                if path.stem not in allowed or self.reviews._path(name) != path:
                    raise ReviewCorruptError("Review filename differs from its document identity")
                self._unresolved_review_files.remove(row_key)
                self._reserve("review", name)
                self._rows.pop(("review", row_key), None)
                previous = row
                row = self._touch("review", name, "discovery", "discovery")
                row.update(status=previous["status"], revision=previous["revision"], captured_bytes=previous["captured_bytes"])
                row_key = name
                self.raw[("review", name)] = raw
                if name not in self._parsed_reviews:
                    self._parsed_reviews[name] = self.reviews._ledger(raw, name)
                candidates.add(name)
            except (OSError, ValueError, TypeError) as error:
                if isinstance(error, _ContextBudgetError):
                    error = ConceptCaptureLimitError("Shared discovery byte budget exhausted")
                if not isinstance(error, (OSError, ConceptCaptureLimitError, ReviewCorruptError)):
                    error = ReviewCorruptError("Document-review discovery envelope is malformed")
                self._validated_error("review", row_key, error, phase="review_discovery")
    ordered = sorted(candidates)
    if len(ordered) > self.limits["documents"]:
        self._skip("scan", "documents", ConceptCaptureLimitError("Document candidate limit exceeded"), phase="document_discovery")
        ordered = ordered[:self.limits["documents"]]
    self._scan_documents = ordered
    return list(ordered)

def scan_correspondences(self):
    # 같은 tenant의 대응 파일 후보를 발견한다. 이후 원장 검증·현재 적용 판단과는 별개다.
    if self._scan_correspondences is not None:
        return list(self._scan_correspondences)
    candidates = []
    for entry in (entry for directory in self.correspondences.correspondence_dirs
                  for entry in self._entries(directory, "correspondence_discovery")):
        if entry.name.startswith(".wiki-") and entry.name.endswith(".tmp"):
            continue
        try:
            if not entry.name.endswith(".json") or not entry.is_file(follow_symlinks=False):
                raise CorrespondenceCorruptError("Unexpected correspondence directory entry")
            cid = identifier(entry.name[:-5], "correspondence_id")
            self.correspondences._path(cid)
            if cid not in candidates:
                candidates.append(cid)
        except (OSError, ValueError, TypeError) as error:
            self._skip("scan", entry.name, error, phase="correspondence_discovery")
    if len(candidates) > self.limits["correspondences"]:
        self._skip("scan", "correspondences", ConceptCaptureLimitError("Correspondence candidate limit exceeded"), phase="correspondence_discovery")
        candidates = candidates[:self.limits["correspondences"]]
    self._scan_correspondences = candidates
    return list(candidates)
