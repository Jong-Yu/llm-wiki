"""입력 구성은 원시 UTF-8 파일로 불변 공개하며 JSON 메타 한도와 분리한다."""

# 입력 묶음은 manifest(구성 설명서)와 여러 텍스트 구성 파일로 이뤄진다.
# 완성한 새 폴더를 한 번 공개하고, 읽을 때 설명서의 크기/hash와 실제 바이트를 다시 맞춘다.

from hashlib import sha256
import json
import os
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.sources import files as source_files
from . import contracts as limits


def digest(raw):
    # 바이트 내용의 SHA-256 지문을 16진수 문자열로 반환한다. 암호화나 사용자 인증은 아니다.
    return sha256(raw).hexdigest()


def read_text(store, path, *, maximum):
    # 정규 파일에서 실제 읽은 크기를 검사한 뒤 문자열로 바꾼다. 잘못된 UTF-8은 거부한다.
    with source_files.open_regular(store, path) as stream:
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise limits.InputLimitError("An input component exceeds its byte limit.")
    try:
        return raw.decode("utf-8")
    except UnicodeError as error:
        raise limits.InputCorruptError("An input component is not UTF-8.") from error


def write_text(store, path, text):
    # O_EXCL은 이미 있는 파일을 덮어쓰지 않게 한다. fsync 뒤 완성한 파일만 공개 대상으로 삼는다.
    raw = text.encode("utf-8")
    fd = os.open(source_files.checked(store, path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def publish(store, destination, manifest, components, *, maximum=None):
    """완성된 묶음 디렉터리를 한 번 공개한다. 기존 묶음은 교체하지 않는다."""
    raw_manifest = canonical_json_bytes(manifest)
    references = manifest.get("component_references", {})
    if not isinstance(references, dict) or set(references) - set(components):
        raise limits.InputCorruptError("Invalid fixed component references.")
    maximum = limits.MAX_BUNDLE_BYTES if maximum is None else maximum
    if len(raw_manifest) + sum(len(value.encode("utf-8")) for value in components.values()) > maximum:
        raise limits.InputLimitError("The complete fixed input exceeds its byte budget.")
    source_files.mkdir(store, destination.parent)
    pending = destination.parent / (".pending-" + uuid4().hex)
    # 공개 경로에 곧바로 조각을 쓰면 독자가 미완성 묶음을 볼 수 있어 옆의 임시 폴더에서 완성한다.
    source_files.mkdir(store, pending)
    paths = []
    primary = None
    try:
        for index, (name, value) in enumerate(sorted(components.items())):
            if name in references:
                if resolve_reference(store, references[name]) != value:
                    raise limits.InputCorruptError("A fixed component reference changed before publication.")
                continue
            # 논리적 구성 이름을 로컬 경로로 직접 쓰지 않고, 정렬한 순서의 번호 파일에 대응시킨다.
            path = pending / f"component-{index}.txt"
            write_text(store, path, value)
            paths.append(path)
        path = pending / "manifest.json"
        write_text(store, path, raw_manifest.decode("utf-8"))
        paths.append(path)
        source_files.checked(store, destination)
        if destination.exists():
            raise limits.InputCorruptError("An immutable input ID already exists.")
        os.rename(pending, destination)
    except BaseException as error:
        primary = error
        raise
    finally:
        # 오류/취소에도 이번 임시 폴더만 정리한다. 이미 공개한 기존 묶음은 삭제하지 않는다.
        if pending.exists():
            failures = []
            for path in [*reversed(paths), pending]:
                try:
                    path.rmdir() if path == pending else path.unlink(missing_ok=True)
                except OSError as error:
                    failures.append({"path": path.relative_to(store.data_dir).as_posix(),
                                     "error_type": type(error).__name__, "errno": error.errno})
            if failures and primary is not None:
                primary.cleanup_failures = [*getattr(primary, "cleanup_failures", []), *failures]
            elif failures:
                raise limits.InputCorruptError("Input publication cleanup could not be confirmed.")
    return digest(raw_manifest)


def load(store, directory, *, expected_revision=None, maximum=None):
    # (설명서 dict, 설명서 원문 문자열, 구성별 문자열 dict)를 반환한다. 파일을 고치지 않는다.
    maximum = limits.MAX_BUNDLE_BYTES if maximum is None else maximum
    # 설명서도 전체 읽기 예산에 포함한다. 작은 한도를 요청했을 때 설명서만으로
    # 한도를 넘지 않도록, 메타데이터 상한과 전체 상한 중 작은 값만 허용한다.
    text = read_text(store, directory / "manifest.json", maximum=min(1024 * 1024, maximum))
    raw = text.encode("utf-8")
    if expected_revision is not None and digest(raw) != expected_revision:
        raise limits.InputConflictError("bundle_revision_conflict")
    try:
        manifest = json.loads(text, object_pairs_hook=source_files._object)
        if type(manifest) is not dict or canonical_json_bytes(manifest) != raw or type(manifest["components"]) is not dict:
            raise ValueError()
        components = {}
        references = manifest.get("component_references", {})
        if type(references) is not dict or set(references) - set(manifest["components"]):
            raise ValueError()
        size = len(raw)
        for index, (name, descriptor) in enumerate(manifest["components"].items()):
            if (type(name) is not str or type(descriptor) is not dict
                    or set(descriptor) != {"file", "sha256", "size_bytes"}
                    or descriptor["file"] != f"component-{index}.txt"
                    or type(descriptor["size_bytes"]) is not int or descriptor["size_bytes"] < 0):
                raise ValueError()
            # 매 파일에 전체 한도를 다시 주면 여러 파일이 한도만큼씩 쌓인다.
            # 남은 예산만 넘겨 실제 파일이 설명서보다 커져도 읽는 도중 멈춘다.
            remaining = maximum - size
            if descriptor["size_bytes"] > remaining:
                raise limits.InputLimitError("The complete fixed input exceeds its byte budget.")
            value = (resolve_reference(store, references[name]) if name in references
                     else read_text(store, directory / descriptor["file"], maximum=remaining))
            encoded = value.encode("utf-8")
            size += len(encoded)
            if len(encoded) != descriptor["size_bytes"] or digest(encoded) != descriptor["sha256"]:
                raise ValueError()
            components[name] = value
        if size > maximum:
            raise limits.InputLimitError("The complete fixed input exceeds its byte budget.")
        return manifest, text, components
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError) as error:
        if isinstance(error, limits.InputLimitError):
            raise
        raise limits.InputCorruptError("The fixed input manifest or component hash is invalid.") from error


def descriptors(components):
    # 각 구성의 파일명·바이트 지문·크기를 모아 manifest에 넣을 dict를 만든다.
    # sort_keys로 저장되는 manifest의 순서와 파일 번호를 일치시킨다.
    return {name: {"file": f"component-{index}.txt", "sha256": digest(value.encode("utf-8")),
                   "size_bytes": len(value.encode("utf-8"))}
            for index, (name, value) in enumerate(sorted(components.items()))}


def document_revision(store, document, revision):
    """정확한 현재/전체 이력 판본만 읽는다. 최신 판본으로 바꿔 끼우지 않는다."""
    from core.modules.documents.history import validate_history_id
    limits.revision(revision)
    try:
        snapshot = store.read(document)
        if snapshot.revision == revision:
            return snapshot.content
    except FileNotFoundError:
        pass
    directory = store._document_path(store.history_dir, document)
    for name in source_files.entries(store, directory, maximum=1001):
        if name == "changes.json":
            continue
        validate_history_id(name)
        content = read_text(store, directory / name, maximum=1024 * 1024)
        if digest(content.encode("utf-8")) == revision:
            return content
    raise limits.InputCorruptError("The exact referenced document revision is unavailable.")


def resolve_reference(store, reference):
    """새 기본 등록의 중복 본문을 불변 원본/MD 판본 참조로 복원한다."""
    if type(reference) is not dict:
        raise limits.InputCorruptError("Invalid fixed component reference.")
    if reference.get("kind") == "registration" and set(reference) == {"kind", "job"}:
        from core.modules.analysis_jobs.registration import materialize
        from core.modules.analysis_jobs.store import JobStore
        job = reference["job"]
        content, _ = materialize(JobStore(store), job, job["actor"])
        return content
    if reference.get("kind") == "document_context" and set(reference) == {"kind", "context"}:
        from copy import deepcopy
        context = deepcopy(reference["context"])
        for row in context["documents"]:
            source = row.get("source")
            if source is not None:
                if "content" in source or source["document"] != row["document"]:
                    raise limits.InputCorruptError("Invalid document context reference.")
                source["content"] = document_revision(store, source["document"], source["revision"])
        return canonical_json_bytes(context).decode("utf-8")
    raise limits.InputCorruptError("Unknown fixed component reference.")
