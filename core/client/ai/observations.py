"""입출력 크기·호출 시도와 제공자가 보고한 사용량을 구분한다. 토큰을 추정하지 않는다."""
from core.common.json_codec import canonical_json_bytes, canonical_json_hash


def reported_usage(value):
    if not isinstance(value, dict):
        return None
    keys = ("input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens",
            "cache_creation_input_tokens")
    counts = {key: value[key] for key in keys if type(value.get(key)) is int and value[key] >= 0}
    return {"origin": "provider_reported", "tokens": counts} if counts else None


def _call_token_counts(usage):
    """Claude의 호출 총계 또는 Codex의 완료 턴 보고를 한 번씩 합산한다.

    원시 usage는 바꾸지 않는다. tokens 총계와 reports가 함께 있으면 총계만
    사용한다. 서로 다른 턴의 수치가 같다는 이유로 실제 소비를 중복으로 지우지 않는다.
    """
    if not isinstance(usage, dict) or usage.get("origin") != "provider_reported":
        return None
    direct = reported_usage(usage.get("tokens"))
    if direct is not None:
        return direct["tokens"]
    reports = usage.get("reports")
    if not isinstance(reports, list):
        return None
    totals = {}
    for report in reports:
        if not isinstance(report, dict) or report.get("origin") != "provider_reported":
            continue
        normalized = reported_usage(report.get("tokens"))
        if normalized is not None:
            for key, value in normalized["tokens"].items():
                totals[key] = totals.get(key, 0) + value
    return totals or None


def execution_configuration(adapter, preflight, *, input_view, semantic_check):
    """선택된 제공자/버전/모델/실행 설정을 묶는다. 기본 모델의 실제 해석은 보증하지 않는다."""
    from .draft_validation import configuration
    info = preflight if isinstance(preflight, dict) else {}
    value = {"version": 1, "adapter": type(adapter).__module__ + "." + type(adapter).__qualname__,
             "provider": info.get("provider"), "cli_version": info.get("cli_version"),
             "cli": getattr(adapter, "cli", None), "requested_model": getattr(adapter, "model", None),
             "timeout_seconds": getattr(adapter, "timeout_seconds", None),
             "input_view": input_view, "semantic_check": semantic_check,
             "draft_validation": configuration()}
    if input_view != "full":
        from .input_view import reporting_configuration
        value["input_view_reporting"] = reporting_configuration(input_view)
    return value, canonical_json_hash(value)


class ObservedAdapter:
    """실제 어댑터 호출마다 한 기록을 추가한다. 실패/취소도 호출 시도로 남긴다."""
    def __init__(self, adapter):
        self.adapter, self.calls = adapter, []

    async def run(self, **kwargs):
        prompt, schema = kwargs["prompt"], kwargs.get("output_schema") or kwargs["schema"]
        directory = kwargs["directory"]
        observation = {"stage": directory.parent.name if directory.name == "invocation" else directory.name, "status": "started",
                       "prompt_utf8_bytes": len(prompt.encode("utf-8")), "prompt_characters": len(prompt),
                       "schema_utf8_bytes": len(canonical_json_bytes(schema)),
                       "result_json_utf8_bytes": None, "token_estimate": None, "token_usage": None}
        self.calls.append(observation)
        try:
            result = await self.adapter.run(**kwargs)
        except BaseException as error:
            observation.update(status="interrupted", error_type=type(error).__name__)
            raise
        observation.update(status="returned", result_json_utf8_bytes=len(canonical_json_bytes(result["value"])),
                           token_usage=result.get("execution", {}).get("token_usage"))
        return result

    def summary(self):
        reported = [counts for call in self.calls
                    if (counts := _call_token_counts(call["token_usage"])) is not None]
        totals = {}
        for counts in reported:
            for key, value in counts.items():
                totals[key] = totals.get(key, 0) + value
        return {"adapter_call_count": len(self.calls), "calls": self.calls,
                "token_usage_totals": {"origin": "provider_reported", "tokens": totals,
                    "reported_call_count": len(reported), "unreported_call_count": len(self.calls) - len(reported)}
                    if totals else None,
                "measurement": "client_observed_bytes_and_provider_reported_tokens",
                "model_execution_certified": False}
