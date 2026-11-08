"""Validated storage paths; calculating a path never creates a directory."""

from pathlib import Path
import re

_USER = re.compile(r"(?:[a-z][a-z0-9_-]{0,63}|[0-9a-f]{32})")
_ID = re.compile(r"[0-9a-f]{32}")


def _identifier(value, pattern):
    if type(value) is not str or not pattern.fullmatch(value):
        raise ValueError("Invalid storage identifier")
    return value


def personal_root(root, user_id):
    return Path(root) / "_personal" / _identifier(user_id, _USER)


def source_root(root, source_id):
    return Path(root) / "_sources" / _identifier(source_id, _ID)


def source_version_root(root, source_id, version_id):
    return source_root(root, source_id) / "versions" / _identifier(version_id, _ID)


def analysis_job_root(root, user_id, job_id):
    return personal_root(root, user_id) / "analysis" / _identifier(job_id, _ID)


def analysis_request_root(root, user_id):
    return personal_root(root, user_id) / "_requests" / "analysis"


def knowledge_root(root, kind):
    if kind not in {"graphs", "reviews", "correspondences"}:
        raise ValueError("Invalid knowledge storage kind")
    return Path(root) / "_knowledge" / kind
