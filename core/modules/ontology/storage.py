"""지식 자료의 새 키와 기존 경로를 함께 검사한다. 읽기로 이관하지 않는다."""

from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat

from core.common.storage_layout import knowledge_root
from core.modules.documents.metadata import parse_document


class KnowledgeStorageConflict(ValueError):
    """둘 이상의 저장 위치나 문서 ID/경로가 충돌한다. 어느 쪽도 덮어쓰지 않는다."""

    code = "knowledge_storage_conflict"


def legacy_key(document):
    return "legacy-" + sha256(document.encode("utf-8")).hexdigest()


def validate_document_id(value):
    # 문서 ID는 경로 조각 하나여야 한다. legacy namespace는 서버 내부 키다.
    if (not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value)
            or value.startswith("legacy-")):
        raise KnowledgeStorageConflict("Invalid knowledge document identity")
    return value


def document_identity(store, document):
    store._document_path(store.wiki_dir, document)
    try:
        parsed = parse_document(store.read(document).content)
    except FileNotFoundError:
        return None
    return None if parsed.document_id is None else validate_document_id(parsed.document_id)


def _envelope(store, path, limit, remaining=None):
    store._check_path(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise KnowledgeStorageConflict("Knowledge files must be regular files")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            raw = stream.read(min(limit, remaining[0] if remaining is not None else limit) + 1)
            if remaining is not None:
                remaining[0] -= len(raw)
                if remaining[0] < 0:
                    raise KnowledgeStorageConflict("Knowledge identity scan byte limit exceeded")
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if len(raw) > limit:
        raise KnowledgeStorageConflict("Knowledge identity envelope exceeds its limit")
    from .snapshots import _unique_object, _reject_constant
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise KnowledgeStorageConflict("Cannot establish the stored document identity") from error
    if not isinstance(value, dict):
        raise KnowledgeStorageConflict("Invalid knowledge identity envelope")
    return value


def existing_path(store, preferred, alternatives):
    paths = list(dict.fromkeys([preferred, *alternatives]))
    present = []
    for path in paths:
        store._check_path(path)
        try:
            path.lstat()
        except FileNotFoundError:
            continue
        present.append(path)
    if len(present) > 1:
        raise KnowledgeStorageConflict("Both current and legacy knowledge files exist; preserve and reconcile explicitly")
    return present[0] if present else preferred


def document_path(store, document, kind, *, max_bytes):
    document_id = document_identity(store, document)
    directory = knowledge_root(store.data_dir, kind)
    key = document_id or legacy_key(document)
    preferred = directory / (key + ".json")
    old_dir = "_ontology" if kind == "graphs" else "_reviews"
    alternatives = [store.data_dir / old_dir / (sha256(document.encode("utf-8")).hexdigest() + ".json")]
    if document_id is not None:
        alternatives.append(directory / (legacy_key(document) + ".json"))
    elif not store._document_path(store.wiki_dir, document).exists():
        # 원문이 없어진 뒤에도 새 경로의 사람 판단을 발견할 수 있어야 한다.
        # 전역 인덱스를 만들거나 문서/히스토리에 ID를 쓰지 않는다.
        store._check_path(directory)
        try:
            entries = os.scandir(directory)
        except FileNotFoundError:
            entries = None
        if entries is not None:
            remaining = [16 * 1024 * 1024]
            with entries:
                for index, entry in enumerate(entries):
                    if index >= 1000:
                        raise KnowledgeStorageConflict("Knowledge identity scan limit exceeded")
                    if not entry.name.endswith(".json") or Path(entry.path) == preferred:
                        continue
                    value = _envelope(store, Path(entry.path), max_bytes, remaining)
                    if value.get("document") == document:
                        alternatives.append(Path(entry.path))
    path = existing_path(store, preferred, alternatives)
    if path.exists():
        value = _envelope(store, path, max_bytes)
        if value.get("document") != document:
            raise KnowledgeStorageConflict("Document ID is already bound to a different path")
        stored_id = value.get("document_id")
        if stored_id is not None:
            validate_document_id(stored_id)
            if document_id is not None and stored_id != document_id:
                raise KnowledgeStorageConflict("Stored and current document IDs differ")
        if path.parent == directory:
            expected_key = stored_id or legacy_key(document)
            if path.stem not in {expected_key, legacy_key(document)}:
                raise KnowledgeStorageConflict("Knowledge filename does not match its document identity")
    return path


def source_fields(content, *, include_body=False):
    parsed = parse_document(content)
    result = {"metadata": parsed.metadata, "document_id": parsed.document_id,
              "body_revision": parsed.body_revision, "body_start_line": parsed.body_start_line,
              "evidence_coordinates": "full_file"}
    if include_body:
        result["body"] = parsed.body
    return result


def storage_entries(store, directories):
    """두 위치의 탐색 예산은 호출자가 합산하며 링크는 따라가지 않는다."""
    for directory in directories:
        store._check_path(directory)
        try:
            entries = os.scandir(directory)
        except FileNotFoundError:
            continue
        with entries:
            yield from entries
