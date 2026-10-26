# 원본 업로드와 작업 JSON이 함께 쓰는 수신 규칙이다. 최대 용량과 오류 종류는 각 호출자가 전달한다.
# 수신량은 헤더에 적힌 숫자를 믿지 않고 실제로 받은 조각(chunk)의 바이트를 합산한다.

"""HTTP 헤더와 실제 수신량만 검사한다. 업무별 한도·오류·파싱은 호출자가 정한다."""

import json
from anyio import to_thread


class RequestInputError(Exception):
    """본문을 처리하기 전에 발견한 형식·크기 오류를 안전한 코드로 전달한다."""

    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def _unique_object(pairs):
    """JSON의 중복 키를 거부해 같은 요청이 두 가지 뜻으로 해석되지 않게 한다."""
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


def parse_json_model(raw, model):
    """UTF-8 JSON을 엄격한 요청 모델로 바꾸고 저장 불가능한 문자열도 거부한다."""
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
        result = model.model_validate(value)
        json.dumps(result.model_dump(), ensure_ascii=False, allow_nan=False).encode("utf-8")
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise RequestInputError(422, "invalid_argument", "JSON fields do not match the API contract.") from None


async def read_json_model(request, model, *, maximum=8 * 1024 * 1024):
    """헤더 대신 실제 수신 바이트를 세고, 기존 공통 스트림으로 JSON을 읽는다."""
    error = RequestInputError(415, "unsupported_media_type", "Use one application/json Content-Type header.")
    if content_type(request, error=error) != "application/json":
        raise error
    raw = bytearray()
    async for chunk in bounded_stream(request, maximum=maximum,
            error=RequestInputError(413, "request_too_large", "The JSON request exceeds its byte limit.")):
        raw.extend(chunk)
    return await to_thread.run_sync(parse_json_model, raw, model)


# 헤더가 정확히 하나인지 확인하고 application/json 같은 본문 형식 이름만 반환한다.
def content_type(request, *, error):
    """중복 Content-Type을 거부하고 매개변수를 제외한 media type을 반환한다."""
    values = request.headers.getlist("content-type")
    if len(values) != 1:
        raise error
    return values[0].split(";", 1)[0].strip().lower()


# async for로 네트워크 조각을 받고 yield로 호출자에게 하나씩 전달한다. 파일 전체를 여기서 메모리에 모으지 않는다.
async def bounded_stream(request, *, maximum, error):
    """Content-Length와 무관하게 실제 chunk를 합산하고 한도 초과 전에 거부한다."""
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > maximum:
            raise error
        yield chunk
