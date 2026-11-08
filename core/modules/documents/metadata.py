"""Separate document metadata from its exact body without rewriting reads."""

from dataclasses import dataclass
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from hashlib import sha256
from threading import get_ident
import json
import re
from uuid import uuid4

_ID = re.compile(r"[0-9a-f]{32}")
_FIELDS = {"schema_version", "document_id", "title", "source", "tags", "description"}
_PARSE_REUSE = ContextVar("document_parse_reuse", default=None)
_MAX_PARSE_REUSE_ENTRIES = 256
_MAX_PARSE_REUSE_BYTES = 16 * 1024 * 1024


class DocumentMetadataError(ValueError):
    """Invalid metadata or an attempted client change to server-owned identity."""


@dataclass(frozen=True)
class ParsedDocument:
    metadata: dict
    body: str
    body_start_line: int
    body_revision: str
    document_id: str | None


def validate_metadata(value):
    if (type(value) is not dict or set(value) - _FIELDS
            or not {"schema_version", "document_id", "title", "tags"} <= set(value)
            or type(value["schema_version"]) is not int or value["schema_version"] != 1
            or type(value["document_id"]) is not str or not _ID.fullmatch(value["document_id"])):
        raise DocumentMetadataError("Invalid document metadata")
    if type(value["title"]) is not str or not value["title"].strip() or len(value["title"]) > 200:
        raise DocumentMetadataError("A title of 1 to 200 characters is required")
    tags = value["tags"]
    if (type(tags) is not list or len(tags) > 100
            or any(type(tag) is not str or not tag.strip() or len(tag) > 100 for tag in tags)
            or len(set(tags)) != len(tags)):
        raise DocumentMetadataError("Invalid document tags")
    if "description" in value and (type(value["description"]) is not str or len(value["description"]) > 4000):
        raise DocumentMetadataError("Invalid document description")
    if "source" in value:
        source = value["source"]
        if (type(source) is not dict or set(source) != {"id", "version"}
                or any(type(item) is not str or not _ID.fullmatch(item) for item in source.values())):
            raise DocumentMetadataError("Invalid original reference")
    return value


def _load(text):
    import yaml

    class Loader(yaml.SafeLoader):
        def compose_node(self, parent, index):
            if self.check_event(yaml.AliasEvent):
                raise DocumentMetadataError("YAML aliases are not allowed")
            self.depth = getattr(self, "depth", 0) + 1
            if self.depth > 5:
                raise DocumentMetadataError("Metadata nesting is too deep")
            try:
                return super().compose_node(parent, index)
            finally:
                self.depth -= 1

        def construct_mapping(self, node, deep=False):
            result = {}
            for key_node, value_node in node.value:
                key = self.construct_object(key_node, deep=deep)
                if type(key) is not str or key in result:
                    raise DocumentMetadataError("Metadata keys must be unique strings")
                result[key] = self.construct_object(value_node, deep=deep)
            return result

    try:
        return yaml.load(text, Loader=Loader)
    except (yaml.YAMLError, RecursionError, TypeError) as error:
        raise DocumentMetadataError("Invalid YAML metadata") from error


def _parse_document(content):
    if type(content) is not str:
        raise TypeError("content must be text")
    lines = content.splitlines(keepends=True)
    metadata, body, start = {}, content, 1
    if lines and lines[0].rstrip("\r\n") == "---":
        end = next((index for index in range(1, len(lines))
                    if lines[index].rstrip("\r\n") == "---"), None)
        if end is None:
            raise DocumentMetadataError("Front Matter is not closed")
        header = "".join(lines[1:end])
        if len(header.encode("utf-8")) > 65536:
            raise DocumentMetadataError("Front Matter is too large")
        metadata = validate_metadata(_load(header))
        body, start = "".join(lines[end + 1:]), end + 2
    return ParsedDocument(metadata, body, start, sha256(body.encode("utf-8")).hexdigest(),
                          metadata.get("document_id"))


@contextmanager
def reuse_parsed_documents():
    """Reuse successful pure parses within one bounded synchronous read only."""
    reuse = {"values": {}, "bytes": 0, "owner": get_ident(), "closed": False}
    token = _PARSE_REUSE.set(reuse)
    try:
        yield
    finally:
        reuse["closed"] = True
        reuse["values"].clear()
        reuse["bytes"] = 0
        _PARSE_REUSE.reset(token)


def _copy_parsed(value):
    return ParsedDocument(deepcopy(value.metadata), value.body, value.body_start_line,
                          value.body_revision, value.document_id)


def parse_document(content):
    reuse = _PARSE_REUSE.get()
    if (reuse is None or type(content) is not str or reuse["closed"]
            or reuse["owner"] != get_ident()):
        return _parse_document(content)
    # Full current bytes, not document identity/revision alone, select a parse.
    key = (content, _parse_document, _load, validate_metadata)
    try:
        previous = reuse["values"].get(key)
    except TypeError:
        return _parse_document(content)  # A non-hashable parser hook stays uncached.
    if previous is not None:
        return _copy_parsed(previous)
    parsed = _parse_document(content)
    if len(reuse["values"]) < _MAX_PARSE_REUSE_ENTRIES:
        try:
            size = (len(content.encode("utf-8")) + len(parsed.body.encode("utf-8"))
                    + len(json.dumps(parsed.metadata, ensure_ascii=False).encode("utf-8")))
            if reuse["bytes"] + size <= _MAX_PARSE_REUSE_BYTES:
                preserved = _copy_parsed(parsed)
                reuse["values"][key] = preserved
                reuse["bytes"] += size
        except (TypeError, ValueError, UnicodeError, RecursionError):
            pass  # Optional memo storage must not reject a successful parse.
    return parsed


def render_document(body, *, title, document_id=None, source=None, tags=None, description=None):
    """Server-side creation; source is the fixed original used by this conversion."""
    metadata = {"schema_version": 1, "document_id": document_id or uuid4().hex,
                "title": title, "tags": [] if tags is None else tags}
    if source is not None:
        metadata["source"] = source
    if description is not None:
        metadata["description"] = description
    validate_metadata(metadata)
    # JSON values are a YAML subset and keep strings such as dates/yes unambiguous.
    header = "\n".join(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in metadata.items())
    return f"---\n{header}\n---\n{body}"


def prepare_edit(document, content, previous_content=None):
    """Validate full-file client edits and add identity only at the server boundary."""
    submitted = parse_document(content)
    previous = parse_document(previous_content) if previous_content is not None else None
    if previous is not None and previous.document_id is not None:
        if (submitted.document_id != previous.document_id
                or submitted.metadata.get("source") != previous.metadata.get("source")):
            raise DocumentMetadataError("Document identity and original reference are server managed")
        return content
    if submitted.document_id is not None:
        raise DocumentMetadataError("New document identity is assigned by the server")
    from pathlib import PurePosixPath
    return render_document(content, title=PurePosixPath(document).stem)
