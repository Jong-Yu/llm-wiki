"""Keep bounded Codex failure facts without retaining provider error text or secrets."""
from hashlib import sha256
import json
import re

from .contracts import MAX_EVENTS
from .observations import reported_usage

_KINDS = frozenset(("thread.started", "turn.started", "turn.completed", "turn.failed", "error",
                    "item.started", "item.updated", "item.completed"))
_CODES = frozenset(("context_length_exceeded", "max_output_tokens", "rate_limit_exceeded",
                    "insufficient_quota", "usage_limit_reached", "invalid_api_key", "invalid_json_schema",
                    "invalid_request_error", "authentication_error", "permission_denied", "server_error",
                    "service_unavailable", "overloaded_error", "request_timeout", "connection_error"))
_SIGNALS = (
    ("stream_disconnected", r"stream (?:disconnected|closed)|connection (?:reset|closed)|incomplete stream"),
    ("context_limit", r"context (?:length|window)|maximum context|too many tokens"),
    ("output_limit", r"max(?:imum)?[_ ]output[_ ]tokens|output token (?:limit|budget)|response too (?:large|long)"),
    ("rate_limit", r"rate[_ ]limit|too many requests"),
    ("quota_limit", r"insufficient[_ ]quota|usage[_ ]limit|exceeded (?:your )?quota|usage cap"),
    ("authentication", r"invalid[_ ]api[_ ]key|authentication[_ ]error|not (?:logged|signed) in|unauthorized|token (?:has )?expired"),
    ("permission", r"permission[_ ]denied|forbidden"),
    ("invalid_schema", r"invalid[_ ]json[_ ]schema|invalid schema|schema (?:validation|is invalid)|schema.*not supported"),
    ("invalid_request", r"invalid[_ ]request|bad request"),
    ("provider_unavailable", r"server[_ ]error|service[_ ]unavailable|overloaded|internal server error"),
    ("timeout", r"timed? out|timeout"),
    ("network", r"connection[_ ]error|error sending request|network (?:error|unreachable)|dns|certificate|tls handshake"),
)
_MAX_ERRORS = 16


def _error_fact(value, *, origin):
    """Only fixed classification labels, bounded HTTP statuses and hashes may escape."""
    if isinstance(value, dict):
        message = value.get("message", "")
        code = value.get("code", value.get("type"))
        status = value.get("status_code", value.get("status"))
    else:
        message, code, status = value if isinstance(value, str) else "", None, None
    message = message if isinstance(message, str) else ""
    text = message.casefold()
    safe_code = code if isinstance(code, str) and code in _CODES else None
    labels = [label for label, pattern in _SIGNALS if re.search(pattern, text)]
    if safe_code is not None:
        labels.extend(label for label, pattern in _SIGNALS
                      if label not in labels and re.search(pattern, safe_code))
    statuses = {status} if type(status) is int and 400 <= status <= 599 else set()
    statuses.update(int(m) for m in re.findall(r"(?:http(?: status)?|status(?: code)?|unexpected status)[: =]+([45]\d\d)\b", text))
    raw = message.encode("utf-8", errors="backslashreplace")
    return {"origin": origin, "signals": labels or ["unclassified"], "provider_code": safe_code,
            "http_statuses": sorted(statuses), "message_bytes": len(raw),
            "message_sha256": sha256(raw).hexdigest()}


def failure_observation(stdout, stderr):
    """Best-effort observation never changes acceptance or the original adapter error.

    Raw messages/IDs/paths/URLs are deliberately excluded. Matching text is an
    observed signal, not a verified root cause. Usage is absent unless reported.
    """
    result = {"version": 1, "raw_error_text_stored": False, "event_counts": {}, "invalid_lines": 0,
              "error_count": 0, "errors": [], "usage_reports": [], "truncated": False}
    lines = stdout.splitlines()
    result["truncated"] = len(lines) > MAX_EVENTS
    for line in lines[:MAX_EVENTS]:
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError, RecursionError):
            result["invalid_lines"] += 1
            continue
        if not isinstance(event, dict):
            result["invalid_lines"] += 1
            continue
        kind = event.get("type")
        if not isinstance(kind, str) or kind not in _KINDS:
            result["invalid_lines"] += 1
            continue
        result["event_counts"][kind] = result["event_counts"].get(kind, 0) + 1
        if kind in {"turn.completed", "turn.failed"}:
            usage = reported_usage(event.get("usage"))
            if usage is not None:
                result["usage_reports"].append({"event": kind, **usage})
        item = event.get("item")
        if kind in {"error", "turn.failed"}:
            error = event.get("error", event)
        elif isinstance(item, dict) and item.get("type") == "error":
            error = item
        else:
            continue
        result["error_count"] += 1
        if len(result["errors"]) < _MAX_ERRORS:
            result["errors"].append(_error_fact(error, origin=kind))
        else:
            result["truncated"] = True
    if stderr:
        # stderr is not a structured event. Record only matching fixed signals,
        # its size/hash; never copy arbitrary text into the execution receipt.
        result["stderr"] = _error_fact(stderr.decode("utf-8", errors="replace"), origin="stderr")
    return result
