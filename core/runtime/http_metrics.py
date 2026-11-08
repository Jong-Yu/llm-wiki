"""일반 API·MCP의 HTTP 요청을 고정 경로 템플릿과 시간으로만 기록한다.

ASGI 메시지를 수정하거나 본문·헤더를 읽지 않는다. 전용 INFO logger를 켠
경우에만 수집하며 완료 시 JSON 한 줄을 남긴다. 실패해도 원래 전송을 유지한다.
"""

import json
import logging
from time import perf_counter

from starlette.routing import compile_path

from core.common.read_metrics import collect


LOGGER = logging.getLogger("core.read_metrics")
_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"})


def enable_logging():
    """명시 CLI 옵션에서 전용 stderr JSON logger만 켠다. 다른 로그 설정은 유지한다."""
    try:
        if not any(handler.name == "read_metrics_json" for handler in LOGGER.handlers):
            handler = logging.StreamHandler()
            handler.set_name("read_metrics_json")
            handler.setFormatter(logging.Formatter("%(message)s"))
            LOGGER.addHandler(handler)
        LOGGER.setLevel(logging.INFO)
        LOGGER.propagate = False
    except Exception:
        pass


class HttpMetricsMiddleware:
    """ContextVar를 끊지 않는 순수 ASGI 측정 계층. 인가는 기존 계층이 소유한다."""

    def __init__(self, app, *, route_templates):
        self.app = app
        self._route_templates = route_templates
        self._patterns = None

    def _template(self, scope):
        if self._patterns is None:
            # 서버가 선언한 OpenAPI 템플릿만 사용한다. literal 요청 경로를 저장하지 않는다.
            templates = self._route_templates()
            self._patterns = tuple((compile_path(template)[0], template) for template in templates)
        for pattern, template in self._patterns:
            if pattern.fullmatch(scope.get("path", "")):
                return template
        return "<unmatched>"

    async def __call__(self, scope, receive, send):
        try:
            enabled = scope["type"] == "http" and LOGGER.isEnabledFor(logging.INFO)
        except Exception:
            enabled = False
        if not enabled:
            await self.app(scope, receive, send)
            return
        status = 500
        failed = False

        async def measured_send(message):
            nonlocal status
            try:
                if message["type"] == "http.response.start":
                    observed = message["status"]
                    if isinstance(observed, int) and not isinstance(observed, bool) and 100 <= observed <= 599:
                        status = int(observed)
            except Exception:
                pass
            await send(message)

        # collect()가 수집기를 만들지 못해도 같은 receive/send로 업무를 실행한다.
        with collect() as metrics:
            started = None
            try:
                started = perf_counter()
            except Exception:
                pass
            try:
                await self.app(scope, receive, measured_send)
            except BaseException:
                failed = True
                raise
            finally:
                try:
                    snapshot = metrics.finish() if metrics is not None else None
                    if snapshot is not None and started is not None:
                        duration = max(0.0, (perf_counter() - started) * 1000)
                        method = scope.get("method")
                        event = {"event": "http_request_metrics", **snapshot,
                            "method": method if type(method) is str and method in _METHODS else "OTHER",
                            "route": self._template(scope), "status": status,
                            "duration_ms": round(duration, 3), "failed": failed}
                        LOGGER.info(json.dumps(event, ensure_ascii=True, separators=(",", ":"), allow_nan=False))
                except Exception:
                    # 측정·직렬화·로그 실패를 응답이나 이미 발생한 업무 예외로 바꾸지 않는다.
                    pass
