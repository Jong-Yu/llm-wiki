# receive_input이 전체 흐름이며 _manifest_bytes, _receive_component, _receive_ruleset가 세부 검증을 나눈다.
# manifest는 구성 목록/지문의 설명서다. 각 페이지가 맞아도 전체를 이어 붙인 UTF-8 바이트의 지문을 다시 확인한다.

"""불변 입력·규약의 원래 바이트를 검증하고 로컬 인계 사본으로 보존한다."""

from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import is_windows, read_private, private_directory, write_new
from .transport import AnalysisClientError, tool_call


MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_COMPONENTS = 64


# xb는 새 바이너리 파일만 만드는 모드다. 같은 경로에 기존 작업 파일이 있으면 덮어쓰지 않고 실패한다.
def _write_new(path, raw):
    write_new(path, raw)


def _manifest_bytes(serialized, manifest, revision, error_code):
    """전달된 JSON 객체도 고정한 원래 바이트와 일치해야 신뢰할 수 있다."""
    raw = serialized.encode("utf-8") if isinstance(serialized, str) else serialized
    if sha256(raw).hexdigest() != revision or json.loads(serialized) != manifest:
        raise AnalysisClientError(error_code)
    return raw


# offset은 문자 위치지만 크기와 hash는 UTF-8 바이트 기준이다. 두 단위를 혼동하면 한글/이모지에서 틀어진다.
async def _receive_component(client, arguments, name, metadata, *, available):
    """문자 offset으로 페이지를 잇고, 완성된 UTF-8 바이트의 크기·hash를 대조한다."""
    if type(metadata.get("size_bytes")) is not int or not 0 <= metadata["size_bytes"] <= MAX_INPUT_BYTES:
        raise AnalysisClientError("input_component_limit")
    payload, offset = bytearray(), 0
    while True:
        page = await tool_call(client, "analysis_job_input_read", {
            **arguments, "component": name, "offset": offset, "limit": 65536})
        content = page.get("content")
        if type(content) is not str or page.get("component_sha256") != metadata["sha256"]:
            raise AnalysisClientError("input_component_mismatch")
        payload.extend(content.encode("utf-8"))
        if len(payload) > available:
            raise AnalysisClientError("input_component_limit")
        next_offset = page.get("next_offset")
        if next_offset is None:
            if page.get("complete") is not True:
                raise AnalysisClientError("analysis_input_incomplete")
            break
        if next_offset != offset + len(content) or not content or next_offset <= offset:
            raise AnalysisClientError("input_page_mismatch")
        offset = next_offset
    if len(payload) != metadata["size_bytes"] or sha256(payload).hexdigest() != metadata["sha256"]:
        raise AnalysisClientError("input_component_mismatch")
    return payload


async def _receive_ruleset(client, tenant, reference):
    release = await tool_call(client, "extraction_rules_read", {
        "tenant": tenant, "ruleset_id": reference["ruleset_id"], "ruleset_version": reference["ruleset_version"]})
    return _checked_ruleset(release, reference)


def _checked_ruleset(release, reference):
    # 서버에서 받았을 때와 로컬 사본을 다시 읽을 때 같은 검사로 규약을 확인한다.
    if any(release.get(key) != reference[key] for key in ("ruleset_id", "ruleset_version", "ruleset_revision")):
        raise AnalysisClientError("ruleset_hash_mismatch")
    raw = (release["manifest_text"].encode("utf-8") if "manifest_text" in release
           else canonical_json_bytes(release["manifest"]))
    _manifest_bytes(raw, release["manifest"], reference["ruleset_revision"], "ruleset_hash_mismatch")
    if set(release["components"]) != set(release["manifest"]["components"]):
        raise AnalysisClientError("ruleset_hash_mismatch")
    for name, component in release["components"].items():
        if (sha256(component["content"].encode("utf-8")).hexdigest() != component["sha256"]
                or component["sha256"] != release["manifest"]["components"][name]["sha256"]):
            raise AnalysisClientError("ruleset_hash_mismatch")
    return release


async def receive_input(client, *, tenant, job_id, run_id, expected_job_revision, directory,
                        context_documents=None, stage="read_source", target_document=None,
                        extraction_id=None, profile=None, ruleset_ref=None):
    """입력 준비 결과를 받아 검증한 뒤 새 작업 폴더에만 사본을 쓴다."""
    # 기존 호출은 read_source로 동작한다. 다음 단계는 같은 규약을 명시해
    # 관리자가 기본 규약을 바꿨다는 이유만으로 진행 중 입력을 바꾸지 않는다.
    if stage not in {"read_source", "prepare_wiki", "extract_ontology"}:
        raise AnalysisClientError("unsupported_analysis_stage")
    selection = {} if profile is None else {"profile": profile}
    arguments = {
        "tenant": tenant, "job_id": job_id, "run_id": run_id,
        "expected_job_revision": expected_job_revision, "stage": stage, **selection}
    if context_documents is not None:
        arguments["context_documents"] = context_documents
    for key, value in (("target_document", target_document), ("extraction_id", extraction_id)):
        if value is not None:
            arguments[key] = value
    if ruleset_ref is not None:
        arguments.update({key: ruleset_ref[key] for key in ("ruleset_id", "ruleset_version")})
    prepared = await tool_call(client, "analysis_job_input_prepare", arguments)
    if prepared.get("input_ready") is not True or prepared.get("can_analyze_input") is not True:
        raise AnalysisClientError("analysis_input_incomplete")
    reference = {name: prepared[name] for name in ("bundle_id", "bundle_revision")}
    if ruleset_ref is not None and prepared["ruleset_ref"] != ruleset_ref:
        raise AnalysisClientError("ruleset_hash_mismatch")
    arguments = {"tenant": tenant, "job_id": job_id, "run_id": run_id, **reference, **selection}
    bundle = await tool_call(client, "analysis_job_input_read", arguments)
    manifest = bundle["manifest"]
    raw = _manifest_bytes(bundle["manifest_text"], manifest, reference["bundle_revision"], "bundle_hash_mismatch")
    if any(manifest.get(key) != value for key, value in (("job_id", job_id), ("run_id", run_id), ("stage", stage))):
        raise AnalysisClientError("bundle_scope_mismatch")
    if "tenant" in manifest and manifest["tenant"] != tenant:
        raise AnalysisClientError("bundle_scope_mismatch")
    if target_document is not None and manifest.get("target_document") != target_document:
        raise AnalysisClientError("bundle_scope_mismatch")
    if profile is not None and manifest.get("actor", {}).get("profile_id") != profile:
        raise AnalysisClientError("bundle_scope_mismatch")
    components = bundle["components"]
    if (type(components) is not dict or not 1 <= len(components) <= MAX_COMPONENTS
            or set(components) != set(manifest.get("components", {}))):
        raise AnalysisClientError("input_component_limit")
    input_dir = directory / "inputs"
    private_directory(input_dir, exist_ok=False)
    _write_new(input_dir / "manifest.json", raw)
    total, locations = len(raw), {}
    for index, (name, metadata) in enumerate(components.items()):
        # 페이지가 신고한 hash끼리만 비교하면 구성과 manifest를 함께 바꾼 응답을 놓친다.
        pinned = manifest["components"][name]
        if any(metadata.get(key) != pinned.get(key) for key in ("sha256", "size_bytes")):
            raise AnalysisClientError("input_component_mismatch")
        payload = await _receive_component(client, arguments, name, metadata, available=MAX_INPUT_BYTES - total)
        total += len(payload)
        # 서버의 구성 이름은 대응표에만 두고 로컬 경로는 정해진 번호로 만든다.
        filename = f"component-{index:03}.txt"
        _write_new(input_dir / filename, payload)
        locations[name] = "inputs/" + filename
    rules = prepared["ruleset_ref"]
    if manifest.get("ruleset_ref") != rules:
        raise AnalysisClientError("ruleset_hash_mismatch")
    release = await _receive_ruleset(client, tenant, rules)
    _write_new(input_dir / "ruleset.json", canonical_json_bytes(release))
    return {**reference, "tenant": tenant, "job_id": job_id, "run_id": run_id,
            "ruleset_ref": rules, "stage": stage,
            "input_ready": True, "can_analyze_input": True, "job_revision": prepared["job_revision"],
            "manifest_file": "inputs/manifest.json", "ruleset_file": "inputs/ruleset.json",
            "components": locations}


def _local_bytes(directory, relative, maximum):
    """작업 폴더 안의 정규 파일만 제한된 크기로 읽는다. 원본이나 사본을 수정하지 않는다."""
    if (type(relative) is not str or not relative or "\\" in relative or ":" in relative
            or PurePosixPath(relative).is_absolute() or any(part in {"", ".", ".."} for part in relative.split("/"))):
        raise AnalysisClientError("unsafe_input_snapshot")
    root = Path(directory).absolute()
    # 루트 자신뿐 아니라 조상 경로도 확인한다. 검사 뒤 하위 폴더는 fd를 기준으로
    # 하나씩 열어, inputs가 심볼릭 링크로 교체되어 다른 폴더를 읽는 것을 막는다.
    if any(path.is_symlink() for path in (root, *root.parents)):
        raise AnalysisClientError("unsafe_input_snapshot")
    if is_windows():
        try:
            private_directory(root)
            return read_private(root / relative, maximum)
        except OSError:
            raise AnalysisClientError("unsafe_input_snapshot") from None
    descriptor = None
    try:
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        if os.fstat(descriptor).st_mode & 0o077:
            raise AnalysisClientError("private_work_directory_required")
        parts = PurePosixPath(relative).parts
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        child = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            if not stat.S_ISREG(os.fstat(child).st_mode):
                raise AnalysisClientError("unsafe_input_snapshot")
            with os.fdopen(child, "rb") as source:
                child = None
                raw = source.read(maximum + 1)
        finally:
            if child is not None:
                os.close(child)
        if len(raw) > maximum:
            raise AnalysisClientError("input_component_limit")
        return raw
    except OSError:
        raise AnalysisClientError("unsafe_input_snapshot") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def load_input(fixed_input, directory):
    """AI 실행 직전에 로컬 입력 전체를 다시 읽어 hash와 소속을 확인한다.

    반환값의 components는 파일 이름→문자열 dict다. 사용자는 이 함수가 반환한
    검증 사본만 프롬프트에 넣으며 임의 로컬 경로나 원격 주소를 따라가지 않는다.
    """
    try:
        if (fixed_input["manifest_file"] != "inputs/manifest.json"
                or fixed_input["ruleset_file"] != "inputs/ruleset.json"):
            raise AnalysisClientError("unsafe_input_snapshot")
        raw = _local_bytes(directory, fixed_input["manifest_file"], MAX_INPUT_BYTES)
        manifest = json.loads(raw)
        _manifest_bytes(raw, manifest, fixed_input["bundle_revision"], "bundle_hash_mismatch")
        for key in ("tenant", "job_id", "run_id", "stage"):
            if manifest[key] != fixed_input[key]:
                raise AnalysisClientError("bundle_scope_mismatch")
        if (manifest["bundle_id"] != fixed_input["bundle_id"]
                or manifest["ruleset_ref"] != fixed_input["ruleset_ref"]
                or manifest.get("input_ready") is not True):
            raise AnalysisClientError("bundle_scope_mismatch")
        locations = fixed_input["components"]
        if (type(locations) is not dict or not 1 <= len(locations) <= MAX_COMPONENTS
                or set(locations) != set(manifest["components"]) or len(set(locations.values())) != len(locations)):
            raise AnalysisClientError("input_component_mismatch")
        components, total = {}, len(raw)
        for name, relative in locations.items():
            if type(relative) is not str or re.fullmatch(r"inputs/component-[0-9]{3}\.txt", relative) is None:
                raise AnalysisClientError("unsafe_input_snapshot")
            value = _local_bytes(directory, relative, MAX_INPUT_BYTES)
            metadata = manifest["components"][name]
            total += len(value)
            if total > MAX_INPUT_BYTES:
                raise AnalysisClientError("input_component_limit")
            if len(value) != metadata["size_bytes"] or sha256(value).hexdigest() != metadata["sha256"]:
                raise AnalysisClientError("input_component_mismatch")
            components[name] = value.decode("utf-8")
        release = json.loads(_local_bytes(directory, fixed_input["ruleset_file"], MAX_INPUT_BYTES))
        _checked_ruleset(release, fixed_input["ruleset_ref"])
        # 실행 지침은 묶음 안에 고정한 사본과도 같아야 한다. 같은 버전 이름만 믿지 않는다.
        if components.get("rules/manifest.json") != release["manifest_text"]:
            raise AnalysisClientError("ruleset_hash_mismatch")
        for name, component in release["components"].items():
            if components.get("rules/" + name) != component["content"]:
                raise AnalysisClientError("ruleset_hash_mismatch")
        return {"manifest": manifest, "components": components, "ruleset": release}
    except (KeyError, TypeError, ValueError, UnicodeError, RecursionError):
        raise AnalysisClientError("invalid_input_snapshot") from None
