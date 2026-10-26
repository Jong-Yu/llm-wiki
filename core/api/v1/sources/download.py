# 이미 권한·무결성을 확인한 원본 파일을 조각으로 내려보내는 응답이다.
# 연결이 끊겨도 열린 파일을 닫는 책임을 응답 객체가 끝까지 유지한다.

"""이미 검증해 연 불변 판본의 descriptor만 스트리밍한다."""

from urllib.parse import quote
from starlette.responses import StreamingResponse
from core.api.concurrency import run_owned_thread
from core.modules.sources.contracts import SOURCE_MEDIA_TYPES


class OriginalResponse(StreamingResponse):
    def __init__(self, stream, manifest):
        self.original = stream
        extension = manifest["format"]
        filename = manifest.get("filename") or "original." + extension
        headers = {
            "Content-Length": str(manifest["size_bytes"]),
            "Content-Disposition": f"attachment; filename=\"original.{extension}\"; filename*=UTF-8''{quote(filename, safe='')}",
            "ETag": '"' + manifest["source_sha256"] + '"',
            "X-Source-Sha256": manifest["source_sha256"],
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        }
        # ArtifactResponse도 열린 descriptor의 수명주기를 재사용한다.
        # source 등록 형식 검증은 별도이며, 산출물 bin은 일반 바이너리로 보낸다.
        media_type = SOURCE_MEDIA_TYPES.get(extension, "application/octet-stream")
        super().__init__(self.chunks(), media_type=media_type, headers=headers)

    def chunks(self):
        while chunk := self.original.read(65536):
            yield chunk

    # 응답을 보내는 동안 파일 사용권을 유지하고, finally에서 파일을 닫아 취소 시에도 핸들이 남지 않게 한다.
    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # 전송 취소/헤더 실패에도 pathname을 다시 열지 않고 descriptor를 닫는다.
            await run_owned_thread(self.original.close)
