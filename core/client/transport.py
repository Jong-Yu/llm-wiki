# API는 HTTP 상태와 data 객체를, MCP는 전송 결과와 업무 결과(ok)를 함께 검사한다.
# 여러 클라이언트 흐름이 같은 함수를 써서 성공/실패 판정이 달라지지 않게 한다.

"""CLI의 API·MCP 응답을 검증하고 서버 오류 원문 대신 고정 오류 코드를 전달한다."""


class AnalysisClientError(Exception):
    """토큰·주소가 섞일 수 있는 전송 예외를 사용자 출력에 그대로 노출하지 않는다."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def client_error_code(error):
    """SDK가 예외를 묶어 반환해도 알려진 오류 코드만 꺼낸다. 원문 오류는 노출하지 않는다."""
    pending, codes = [error], set()
    # 비동기 SDK의 정리 과정에서 ExceptionGroup 안에 원래 업무 오류가 들어갈 수 있다.
    # 전부 같은 알려진 오류일 때만 그 코드를 사용하며 알 수 없는 예외가 섞이면 일반 오류로 둔다.
    for _ in range(32):
        if not pending:
            return next(iter(codes)) if len(codes) == 1 else None
        current = pending.pop()
        if isinstance(current, AnalysisClientError):
            codes.add(current.code)
        else:
            children = getattr(current, "exceptions", None)
            if not isinstance(children, (tuple, list)) or not children:
                return None
            pending.extend(children)
    return None


async def api_call(http, method, path, body=None):
    """API 성공 응답의 data 객체를 반환한다. 저장 접수의 202도 성공으로 받는다."""
    response = await http.request(method, path, json=body)
    if response.status_code not in {200, 201, 202}:
        raise AnalysisClientError("api_request_failed")
    try:
        value = response.json()["data"]
        if type(value) is not dict:
            raise ValueError()
        return value
    except (ValueError, KeyError, TypeError):
        raise AnalysisClientError("invalid_api_result") from None


# HTTP/MCP 전송 성공만으로 업무 성공을 판단하지 않고 ok=True까지 확인한다.
async def tool_call(client, name, arguments):
    """MCP 전송 성공과 업무 성공을 모두 확인하고 전송용 필드를 제외한다."""
    result = await client.call_tool(name, arguments)
    value = result.structured_content
    if result.is_error or type(value) is not dict or value.get("ok") is not True:
        raise AnalysisClientError("mcp_request_failed")
    return {key: item for key, item in value.items() if key not in {"ok", "access"}}
