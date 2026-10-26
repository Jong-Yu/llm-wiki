# 일반 API 앞에서 query/GET 본문/응답 크기를 확인하는 공통 통로다.
# ASGI의 scope는 요청 정보, receive는 입력 받기, send는 응답 보내기 함수다. 실제 업무는 self.app으로 넘긴다.

"""일반 API query·JSON 응답 예산과 인증된 파일 스트리밍 경계를 적용한다."""

import re

from core.api.errors import error_response


MAX_QUERY_BYTES = 32768
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
_ORIGINAL_DOWNLOAD = re.compile(r"/api/v1/tenants/[a-z][a-z0-9_-]{0,63}/sources/[0-9a-f]{32}/versions/[0-9a-f]{32}/file")
_ARTIFACT_DOWNLOAD = re.compile(r"/api/v1/tenants/[a-z][a-z0-9_-]{0,63}/extractions/[0-9a-f]{32}/artifacts/[0-9a-f]{32}")


class ReadApiLimits:
    def __init__(self, app):
        self.app = app

    # async __call__ 덕분에 객체를 비동기 함수처럼 호출할 수 있다. 일반 API에만 아래 제한을 적용한다.
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        if len(scope.get("query_string", b"")) > MAX_QUERY_BYTES:
            await error_response(413, "request_too_large", "The query exceeds the byte limit.")(scope, receive, send)
            return
        if scope["method"] == "GET":
            # GET 요청 본문은 계약에 없으며 chunked/누락 Content-Length도 확인한다.
            while True:
                message = await receive()
                if message["type"] != "http.request":
                    return
                if message.get("body"):
                    await error_response(413, "request_body_not_allowed", "Read endpoints do not accept a request body.")(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break
            query = scope.get("query_string", b"").decode("latin-1")
            from urllib.parse import parse_qsl
            keys = [key for key, _ in parse_qsl(query, keep_blank_values=True)]
            if len(keys) != len(set(keys)):
                await error_response(422, "invalid_argument", "Duplicate query fields are not allowed.")(scope, receive, send)
                return
        messages, size, exceeded = [], 0, False

        async def uncached_send(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*(item for item in message["headers"] if item[0].lower() != b"cache-control"),
                                                   (b"cache-control", b"no-store")]}
            await send(message)

        if scope["method"] == "GET" and (_ORIGINAL_DOWNLOAD.fullmatch(scope["path"])
                or _ARTIFACT_DOWNLOAD.fullmatch(scope["path"])):
            # 원본/산출물은 별도20MiB·무결성 검사를 거쳐 전송한다. JSON16MiB와 분리한다.
            await self.app(scope, receive, uncached_send)
            return

        # 바로 전송하지 않고 응답 조각을 모아 전체 크기를 확인한다. 초과 응답을 중간까지만 보내지 않기 위해서다.
        async def capture(message):
            nonlocal size, exceeded
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*(item for item in message["headers"] if item[0].lower() != b"cache-control"),
                                                   (b"cache-control", b"no-store")]}
            elif message["type"] == "http.response.body":
                size += len(message.get("body", b""))
            if size > MAX_RESPONSE_BYTES:
                exceeded = True
                messages.clear()
            if not exceeded:
                messages.append(message)

        await self.app(scope, receive, capture)
        if exceeded:
            await error_response(500, "response_limit", "The complete result exceeds the response byte limit; no fields were omitted.")(scope, receive, send)
        else:
            for message in messages:
                await send(message)
