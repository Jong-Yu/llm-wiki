"""불변 manifest·카탈로그·요청의 구조와 서로 연결된 근거를 검증한다."""

# manifest는 한 판본의 설명서, catalog는 여러 판본을 연결한 등록 목록이다.
# 파일이 존재한다는 것만 믿지 않고 필수 항목·소속·내용 지문이 서로 일치하는지 확인한다.

from datetime import datetime
from hashlib import sha256
from pathlib import PurePosixPath
import re

from core.common.json_codec import canonical_json_hash
from .contracts import SourceCorruptError, identifier, metadata, ID, HEX


ACTOR_FIELDS = {"user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision"}
MANIFEST_FIELDS = {"source_id", "source_version", "source_sha256", "size_bytes", "kind", "format",
                   "filename", "title", "actor", "created_at", "request_id", "payload_hash"}


def cleanup_failures(value):
    # 정리 경고도 저장된 데이터다. 응답에 서버 절대 경로나 잘못된 오류 값을 내보내지 않게 검사한다.
    if type(value) is not list or len(value) > 10:
        raise SourceCorruptError("Stored cleanup warnings are invalid.")
    for item in value:
        if type(item) is not dict or set(item) != {"path", "error_type", "errno"}:
            raise SourceCorruptError("Stored cleanup warnings are invalid.")
        path = item["path"]
        if (type(path) is not str or not path or len(path) > 4096 or "\\" in path or ":" in path
                or any(ord(char) < 32 for char in path) or PurePosixPath(path).is_absolute()
                or any(part in ("", ".", "..") for part in path.split("/"))):
            raise SourceCorruptError("A cleanup warning path is invalid.")
        if type(item["error_type"]) is not str or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,99}", item["error_type"]):
            raise SourceCorruptError("A cleanup warning error type is invalid.")
        number = item["errno"]
        if number is not None and (type(number) is not int or not 0 <= number <= 2 ** 31 - 1):
            raise SourceCorruptError("A cleanup warning error number is invalid.")
    return value


def actor(value, tenant, user_id):
    # actor는 서버가 인증한 행동 주체다. 제출 본문에 적힌 사용자 이름으로 대신할 수 없다.
    if (type(value) is not dict or set(value) != ACTOR_FIELDS or value["tenant"] != tenant
            or value["user_id"] != user_id or type(value["policy_revision"]) is not str
            or not HEX.fullmatch(value["policy_revision"])):
        raise SourceCorruptError("The server authorization scope is invalid.")
    return dict(value)


def manifest(value, source_id=None, source_version=None):
    # 예상한 필드만 허용한다. 선택 인자가 있으면 설명서가 요청한 원본/판본의 것인지도 대조한다.
    try:
        if type(value) is not dict or set(value) != MANIFEST_FIELDS:
            raise ValueError()
        for field in ("source_id", "source_version", "request_id"):
            identifier(value[field])
        for field in ("source_sha256", "payload_hash"):
            if type(value[field]) is not str or not HEX.fullmatch(value[field]):
                raise ValueError()
        if type(value["size_bytes"]) is not int or value["size_bytes"] < 0:
            raise ValueError()
        metadata(**{key: value[key] for key in ("kind", "title", "format", "filename")})
        actor(value["actor"], value["actor"]["tenant"], value["actor"]["user_id"])
        parsed = datetime.fromisoformat(value["created_at"])
        if parsed.tzinfo is None:
            raise ValueError()
        if source_id is not None and value["source_id"] != source_id:
            raise ValueError()
        if source_version is not None and value["source_version"] != source_version:
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError) as error:
        raise SourceCorruptError("The source manifest is invalid.") from error


def catalog(value, source_id):
    # 모든 판본이 유효하고 최신 표시가 마지막 판본과 일치할 때만 카탈로그 지문을 계산한다.
    try:
        if type(value) is not dict or set(value) != {"source_id", "title", "current_version", "versions", "documents"}:
            raise ValueError()
        if value["source_id"] != source_id or type(value["versions"]) is not list or not value["versions"]:
            raise ValueError()
        versions = value["versions"]
        for item in versions:
            manifest(item, source_id)
        if len({item["source_version"] for item in versions}) != len(versions):
            raise ValueError()
        if value["current_version"] != versions[-1]["source_version"] or value["title"] != versions[-1]["title"]:
            raise ValueError()
        if value["documents"] != []:
            raise ValueError()
        return {**value, "registration_revision": canonical_json_hash(value)}
    except (ValueError, TypeError, KeyError) as error:
        raise SourceCorruptError("The registration catalog is invalid.") from error


def request_key(tenant, user_id, request_id):
    # 요청 ID와 소유 범위를 함께 지문화해 파일명으로 쓴다. 원래 값의 암호화를 뜻하지는 않는다.
    identifier(request_id)
    return canonical_json_hash({"tenant": tenant, "user_id": user_id, "request_id": request_id})


def request_record(value, *, tenant, user_id, request_id):
    # 완료 기록의 영수증까지 같은 요청·원본을 가리켜야 한다. 불일치는 자동 복구로 덮지 않는다.
    fields = {"tenant", "user_id", "request_id", "payload_hash", "operation", "source_id", "source_version",
              "manifest", "registration_revision", "state", "receipt", "cleanup_failures"}
    try:
        if type(value) is not dict or set(value) != fields:
            raise ValueError()
        if any(value[key] != expected for key, expected in (("tenant", tenant), ("user_id", user_id), ("request_id", request_id))):
            raise ValueError()
        manifest(value["manifest"], value["source_id"], value["source_version"])
        if value["manifest"]["request_id"] != request_id or value["manifest"]["payload_hash"] != value["payload_hash"]:
            raise ValueError()
        if value["manifest"]["actor"]["user_id"] != user_id or value["manifest"]["actor"]["tenant"] != tenant:
            raise ValueError()
        if value["state"] not in ("complete", "pending_reconcile") or value["operation"] not in ("create", "version"):
            raise ValueError()
        if type(value["registration_revision"]) is not str or not HEX.fullmatch(value["registration_revision"]):
            raise ValueError()
        cleanup_failures(value["cleanup_failures"])
        if value["state"] == "complete":
            expected = {"request_id": request_id, "source_id": value["source_id"],
                "source_version": value["source_version"], "source_sha256": value["manifest"]["source_sha256"],
                "size_bytes": value["manifest"]["size_bytes"], "registration_revision": value["registration_revision"],
                "actor": value["manifest"]["actor"], "created_at": value["manifest"]["created_at"],
                "storage_status": "stored", "analysis_status": "not_started"}
            if value["receipt"] != expected:
                raise ValueError()
        elif value["receipt"] is not None:
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError) as error:
        raise SourceCorruptError("The request receipt is invalid.") from error
