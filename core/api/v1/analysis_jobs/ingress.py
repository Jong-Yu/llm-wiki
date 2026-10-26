# 작업 요청의 실제 수신량을 제한하고 JSON을 모델에 맞게 읽는다.
# 중복 키나 비정상 숫자는 같은 요청이 서로 다른 뜻으로 해석되는 것을 막기 위해 거부한다.

"""인가 뒤 실제 JSON 수신량·중복 키·형식을 제한한다."""

import json
from anyio import to_thread
from pydantic import ValidationError
from core.api.errors import error_response
from core.api.ingress import bounded_stream, content_type


MAX_JOB_REQUEST_BYTES = 256 * 1024


class JobInputError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


# JSON에서 같은 키가 두 번 나온 경우를 거부한다. 마지막 값만 남기면 제출 뜻이 달라질 수 있다.
def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


# 바이트를 UTF-8 JSON으로 읽고 요청 모델로 검사한다. 메타데이터도 실제 UTF-8로 저장 가능한지 확인한다.
def _parse(raw, model):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_object,
                           parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
        result = model.model_validate(value)
        # 메타데이터에도 저장 불가능한 surrogate를 허용하지 않는다.
        json.dumps(result.model_dump(), ensure_ascii=False).encode("utf-8")
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError, ValidationError):
        raise JobInputError(422, "invalid_argument", "Job JSON fields do not match the contract.") from None


async def read_json(request, model):
    """권한을 확인한 요청만 읽으며 작업 전용 한도·엄격 JSON 규칙을 유지한다."""
    media_error = JobInputError(415, "unsupported_media_type", "Use one application/json Content-Type header.")
    if content_type(request, error=media_error) != "application/json":
        raise media_error
    raw = bytearray()
    async for chunk in bounded_stream(request, maximum=MAX_JOB_REQUEST_BYTES,
            error=JobInputError(413, "request_too_large", "The job request exceeds the 256 KiB limit.")):
        raw.extend(chunk)
    return await to_thread.run_sync(_parse, raw, model)


def input_error(error):
    return error_response(error.status, error.code, error.message)
