"""파서·프로세스와 독립된 변환 보고의 누적, 상한, 부분 실패 상태를 관리한다.

읽은 문자와 위치는 보존하고 checkpoint는 호출자가 맡는다. 보고된 단위의
완료를 원본 전체 포함이나 의미 검증으로 표현하지 않는다.
"""

import re

MAX_TEXT = 4 * 1024 * 1024
MAX_UNITS = 1000


class OutputLimit(Exception):
    pass


def _new_report(format, method):
    return {"format": format, "method": method,
        "units": [], "complete": False, "unread_ranges": [], "warnings": [],
        "diagnostics": [], "unit_methods": {}, "origin": "client_reported",
        "coverage": "reported_units_only", "original_coverage": "not_verified",
        "semantic_validation": "not_run", "state": "running"}


class Conversion:
    def __init__(self, format, checkpoint=None):
        self.result = _new_report(format, {"pdf": "pdf_text", "xlsx": "xlsx_values",
            "docx": "docx_text", "txt": "verbatim", "md": "verbatim"}.get(format, "ocr"))
        self.checkpoint = checkpoint or (lambda result: None)
        self.total_bytes = 0
        self.checkpoint(self.result)

    def note(self, code, scope, *, unread=True):
        # 진단 상한에 닿으면 추가 미독이 있음을 마지막 항목에 명시한다.
        key = "unread_ranges" if unread else "warnings"
        value = f"{scope}: {code}"[:1000]
        if value not in self.result[key]:
            if len(self.result[key]) < 99:
                self.result[key].append(value)
            elif len(self.result[key]) == 99:
                self.result[key].append("remaining scopes: additional diagnostics exceed the report limit")
        if len(self.result["diagnostics"]) < 100:
            self.result["diagnostics"].append({"code": re.sub(r"[^a-zA-Z0-9_.-]", "_", code)[:128],
                                               "scope": scope[:300], "unread": unread})
        self.checkpoint(self.result)

    def add(self, unit_id, where, text, method):
        size = len(text.encode("utf-8"))
        if len(self.result["units"]) >= MAX_UNITS or self.total_bytes + size > MAX_TEXT:
            self.note("conversion_output_limit", "remaining source")
            raise OutputLimit()
        self.total_bytes += size
        self.result["units"].append({"unit_id": unit_id, "location": where, "content": text})
        self.result["unit_methods"][unit_id] = method
        self.checkpoint(self.result)

    def ocr_note(self, scope, code, *, unread=False):
        # 서버 경고의 기존 100항목 상한과 별도로 로컬 checkpoint에는 모든 처리 이력을 둔다.
        self.result.setdefault("ocr_processing", {}).setdefault(scope, []).append({"code": code, "unread": unread})
        self.note(code, scope, unread=unread)

    def finish(self):
        if not self.result["units"] and not self.result["unread_ranges"]:
            self.note("no_readable_units", "whole source")
        self.result["complete"] = not self.result["unread_ranges"] and bool(self.result["units"])
        self.result["state"] = "complete" if self.result["complete"] else "partial" if self.result["units"] else "failed"
        # 보고 모델의 단일 method를 보완하는 단위별 방법은 서버 warnings에도 보존한다.
        methods = {}
        for unit, method in self.result["unit_methods"].items():
            methods.setdefault(method, []).append(unit)
        for method, units in methods.items():
            for offset in range(0, len(units), 40):
                self.note("unit_method=" + method, ",".join(units[offset:offset + 40]), unread=False)
        self.checkpoint(self.result)
        return self.result


def empty_conversion(format, code):
    """worker가 보고를 만들기 전 실패한 경우에도 같은 범위·검증 표시를 유지한다."""
    value = _new_report(format, None)
    value.update(method=None, state="failed", unread_ranges=["whole source: " + code], diagnostics=[{"code": code}])
    return value


def interrupt_conversion(value, code, *, diagnostic=True):
    """이미 읽은 단위는 그대로 두고 남은 범위의 취소·시간 초과·실패를 덧붙인다."""
    value["complete"] = False
    value["state"] = "cancelled" if code == "conversion_cancelled" else "partial" if value["units"] else "failed"
    value["unread_ranges"] = value["unread_ranges"][:99] + ["remaining source: " + code]
    if diagnostic:
        value["diagnostics"] = value["diagnostics"][:99] + [{"code": code, "scope": "remaining source", "unread": True}]
    return value
