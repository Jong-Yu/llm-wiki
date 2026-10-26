"""추출안 실행의 공개 출력·불변 로컬 기록과 정확한 제출 지문을 관리한다."""

import json

from core.client.inputs import _local_bytes
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.runtime.client_platform import write_new

PROTOCOL = "proposal-cli-v1"


def record(directory, name, value):
    """이미 보존한 초안/요청은 덮어쓰지 않는다. 재개는 동일 값만 허용한다."""
    raw = canonical_json_bytes(value)
    try:
        write_new(directory / name, raw)
    except FileExistsError:
        if _local_bytes(directory, name, 8 * 1024 * 1024) != raw:
            raise AnalysisClientError("proposal_local_record_conflict") from None


def read_record(directory, name):
    """알려진 파일만 한도 내 읽고 심볼릭 링크/공개 폴더를 거부한다."""
    if not (directory / name).exists() and not (directory / name).is_symlink():
        return None
    try:
        value = json.loads(_local_bytes(directory, name, 8 * 1024 * 1024))
        if type(value) is not dict:
            raise ValueError()
        return value
    except (ValueError, UnicodeError):
        raise AnalysisClientError("proposal_local_record_invalid") from None


def result_payload(arguments):
    """기존 ResultStore가 보관하는 canonical JSON 값과 같은 지문을 계산한다."""
    return {**{key: value for key, value in arguments.items() if key not in {"tenant", "profile"}},
            "stage": "extract_ontology"}


def checked_result(value, arguments):
    """HTTP/MCP 성공만 믿지 않고 정확한 job/request/payload 및 초안 상태를 대조한다."""
    if (value.get("job_id") != arguments["job_id"] or value.get("request_id") != arguments["request_id"]
            or value.get("submission_ref", {}).get("payload_hash") != canonical_json_hash(result_payload(arguments))
            or value.get("submission_ref", {}).get("request_id") != arguments["request_id"]):
        raise AnalysisClientError("proposal_result_mismatch")
    if value.get("saved") is not False:
        raise AnalysisClientError("proposal_unexpected_canonical_result")
    if value.get("state") == "rejected":
        raise AnalysisClientError("proposal_result_rejected")
    if value.get("state") != "draft":
        raise AnalysisClientError("proposal_result_unconfirmed")
    return value


def result_reference(arguments):
    return {**{key: arguments[key] for key in ("job_id", "run_id", "bundle_id", "bundle_revision", "request_id")},
            "payload_hash": canonical_json_hash(result_payload(arguments)),
            "submission_sha256": canonical_json_hash(arguments["submission"])}


class CandidatePreview:
    """공통 어댑터가 허용한 공개 답변만 크기 제한된 미저장 스냅샷으로 전달한다."""

    def __init__(self, emit):
        self.emit, self.previous = emit, None

    def __call__(self, event):
        if event.get("type") != "agent_message" or not isinstance(event.get("text"), str):
            return
        text = event["text"]
        # 진단/그래프의 공개 JSON도 미완성일 수 있다. 미리보기는 저장 입력으로 재사용하지 않는다.
        raw = text.encode("utf-8")
        preview = raw[:65536].decode("utf-8", errors="ignore")
        if preview != self.previous:
            self.previous = preview
            self.emit("candidate_preview", text=preview, complete=False,
                      truncated=len(raw) > 65536, saved=False)
