"""개인 PC가 보고한 웹 자료의 형식·내용 지문만 검사한다. 서버는 URL을 열지 않는다."""

from copy import deepcopy
from datetime import datetime, timedelta
from hashlib import sha256
from ipaddress import ip_address
import re
from urllib.parse import urlsplit


WEB_SOURCE_FIELDS = ("url", "title", "content_sha256", "retrieved_at")


def public_web_url(value):
    """자격 증명·비공개 주소가 없는 웹 URL인지 검사한다. DNS/실제 취득 검증은 아니다."""
    if (not isinstance(value, str) or not 1 <= len(value) <= 2048
            or any(ord(char) <= 32 or ord(char) == 127 for char in value) or "\\" in value):
        raise ValueError("A web source needs a public HTTP(S) URL")
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if (parsed.scheme not in {"http", "https"} or not host or parsed.username is not None
                or parsed.password is not None or parsed.port not in {None, 80, 443}):
            raise ValueError()
        try:
            address = ip_address(host)
        except ValueError:
            ascii_host = host.encode("idna").decode("ascii").lower().rstrip(".")
            if ("." not in ascii_host or len(ascii_host) > 253
                    or not any(char.isalpha() for char in ascii_host.rsplit(".", 1)[-1])
                    or ascii_host.endswith((".local", ".localhost", ".internal", ".invalid", ".test"))
                    or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                        for label in ascii_host.split("."))):
                raise ValueError()
        else:
            if not address.is_global:
                raise ValueError()
    except (ValueError, UnicodeError) as error:
        raise ValueError("A web source needs a public HTTP(S) URL") from error
    return value


def web_retrieved_at(value):
    """확인 시점은 시차가 명시된 UTC 문자열만 받으며 서버 확인 시각으로 가장하지 않는다."""
    try:
        if not isinstance(value, str) or len(value) > 64:
            raise ValueError()
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if moment.tzinfo is None or moment.utcoffset() != timedelta(0):
            raise ValueError()
    except (ValueError, TypeError) as error:
        raise ValueError("Web retrieval time must be an explicit UTC timestamp") from error
    return value


def validate_web_evidence(value):
    """외부 근거를 제한된 원문과 출처로 고정하고 검증 한계를 보존한다."""
    if not isinstance(value, dict) or set(value) != {"query", "status", "sources", "warnings"}:
        raise ValueError("Select one explicit web research result")
    query, status, sources, warnings = (value[key] for key in ("query", "status", "sources", "warnings"))
    if not isinstance(query, str) or not 1 <= len(query) <= 200 or not query.strip():
        raise ValueError("A web query must contain 1 to 200 characters")
    if not isinstance(status, str) or status not in {"complete", "partial", "empty", "unavailable"}:
        raise ValueError("Unknown web research status")
    if not isinstance(sources, list) or len(sources) > 5:
        raise ValueError("Select at most five web sources")
    if (not isinstance(warnings, list) or len(warnings) > 10
            or any(not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) for code in warnings)):
        raise ValueError("Web warnings must be short diagnostic codes")
    if (status in {"complete", "partial"}) != bool(sources):
        raise ValueError("Web research status must match its retained sources")
    if status == "complete" and warnings:
        raise ValueError("Partial web research must retain its warnings")
    seen = set()
    for source in sources:
        if not isinstance(source, dict) or set(source) != {*WEB_SOURCE_FIELDS, "content"}:
            raise ValueError("A web source needs its exact retained text and metadata")
        public_web_url(source["url"])
        web_retrieved_at(source["retrieved_at"])
        if source["url"] in seen:
            raise ValueError("Select unique web source URLs")
        seen.add(source["url"])
        if not isinstance(source["title"], str) or not 1 <= len(source["title"]) <= 300 or not source["title"].strip():
            raise ValueError("A web source needs a title")
        content = source["content"]
        if not isinstance(content, str) or not 1 <= len(content) <= 12000 or not content.strip():
            raise ValueError("A web source needs 1 to 12000 retained characters")
        if source["content_sha256"] != sha256(content.encode("utf-8")).hexdigest():
            raise ValueError("The web content fingerprint does not match its retained text")
    return {**deepcopy(value), "origin": "client_reported", "retrieval_verification": "not_independently_verified",
        "human_approval": False}
