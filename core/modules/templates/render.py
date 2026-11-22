"""원본 패키지를 실행하지 않고 허용된 텍스트 영역만 바꾸는 템플릿 렌더러.

Office XML의 비대상 바이트와 ZIP 항목은 재직렬화하지 않는다. 모델에는 순번 ID만
공개하고, 파일 경로·수식·마스터·관계 파일은 모델이 지정하거나 수정하지 못한다.
"""

from dataclasses import dataclass, field
from io import BytesIO
import json
import math
import posixpath
import re
import stat
from typing import Any
from urllib.parse import unquote, urlsplit
from xml.parsers import expat
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile
from zlib import error as ZlibError

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_PART_BYTES = 16 * 1024 * 1024
MAX_ENTRIES = 4096
MAX_FIELDS = 500
MAX_SOURCE_CHARS = 24000
MAX_ANSWER_CHARS = 65536
MAX_RESULT_CHARS = 48000
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main}"
SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
TEXT_FORMATS = {"txt", "md", "markdown", "html", "htm", "csv"}
OFFICE_FORMATS = {"docx", "pptx", "xlsx"}
INVALID_XML_TEXT = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
RESULT_BLOCK = re.compile(r"^```wiki-template-result[ \t]*\r?\n(.*?)\r?\n```[ \t]*$", re.MULTILINE | re.DOTALL)


class TemplateRenderError(ValueError):
    """API가 경로·원문 없이 공개할 수 있는 오류 코드와 안내다."""

    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code = code
        self.message = message


def _invalid() -> TemplateRenderError:
    return TemplateRenderError("template_invalid", "템플릿 파일의 구조를 확인할 수 없습니다. 원래 프로그램에서 다시 저장한 파일을 선택해 주세요.")


def _limit() -> TemplateRenderError:
    return TemplateRenderError("template_input_limit", "템플릿의 작성 영역이 너무 큽니다. 텍스트 24,000자·500개 영역 이내인 양식을 선택해 주세요.")


@dataclass
class _Node:
    """유효성 검사를 마친 XML 노드의 원본 바이트 범위를 보존한다."""

    tag: str
    attrs: dict[str, str]
    start: int
    open_end: int
    parent: "_Node | None"
    end_start: int = 0
    end: int = 0
    text: str = ""
    text_chunks: list[str] = field(default_factory=list)
    children: list["_Node"] = field(default_factory=list)


@dataclass
class _Field:
    """모델용 순번과 내부 작성 위치를 분리한다."""

    id: str
    text: str
    part: str = ""
    kind: str = "text"
    node: _Node | None = None
    runs: list[_Node] = field(default_factory=list)
    rich_part: str | None = None
    rich_node: _Node | None = None
    location: str = "문서 전체"


@dataclass
class _Prepared:
    format: str
    original: bytes
    fields: list[_Field]
    parts: dict[str, bytes] = field(default_factory=dict)
    bom: bool = False


def _tag_end(raw: bytes, start: int) -> int:
    """인용부호 안의 >를 구별하며 태그의 끝을 찾는다."""
    quote = 0
    for index in range(start, len(raw)):
        char = raw[index]
        if quote:
            if char == quote:
                quote = 0
        elif char in (34, 39):
            quote = char
        elif char == 62:
            return index + 1
    raise _invalid()


def _xml(raw: bytes) -> _Node:
    """DTD·외부 개체를 금지하고 깊이/노드 한도를 검사한 UTF-8 트리를 읽는다."""
    if len(raw) > MAX_PART_BYTES or b"\x00" in raw:
        raise _invalid()
    stack: list[_Node] = []
    roots: list[_Node] = []
    count = 0
    parser = expat.ParserCreate(namespace_separator="}")

    def deny(*_args: Any) -> None:
        raise _invalid()

    def declaration(_version: str, encoding: str | None, _standalone: int) -> None:
        if encoding and encoding.lower().replace("-", "") != "utf8":
            raise _invalid()

    def start(tag: str, attrs: dict[str, str]) -> None:
        nonlocal count
        count += 1
        if count > 100000 or len(stack) >= 100:
            raise _invalid()
        offset = parser.CurrentByteIndex
        node = _Node(tag, attrs, offset, _tag_end(raw, offset), stack[-1] if stack else None)
        (stack[-1].children if stack else roots).append(node)
        stack.append(node)

    def end(_tag: str) -> None:
        node = stack.pop()
        node.text = "".join(node.text_chunks)
        node.text_chunks.clear()
        if raw[node.start:node.open_end].rstrip().endswith(b"/>"):
            node.end_start = node.end = node.open_end
        else:
            node.end_start = parser.CurrentByteIndex
            node.end = _tag_end(raw, node.end_start)

    def text(value: str) -> None:
        if stack:
            stack[-1].text_chunks.append(value)

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    parser.XmlDeclHandler = declaration
    parser.StartDoctypeDeclHandler = deny
    parser.EntityDeclHandler = deny
    parser.ExternalEntityRefHandler = deny
    try:
        parser.Parse(raw, True)
    except (expat.ExpatError, UnicodeError) as error:
        raise _invalid() from error
    if len(roots) != 1:
        raise _invalid()
    return roots[0]


def _walk(node: _Node) -> list[_Node]:
    """이미 깊이 제한한 트리를 문서 순서로 펼친다."""
    result = [node]
    for child in node.children:
        result.extend(_walk(child))
    return result


def _natural(value: str) -> list[tuple[int, str | int]]:
    return [(1, int(item)) if item.isdigit() else (0, item) for item in re.split(r"(\d+)", value)]


def _package(original: bytes) -> dict[str, bytes]:
    """추출 없이 ZIP 경로·압축·크기·중복·특수파일을 확인한다."""
    try:
        with ZipFile(BytesIO(original)) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > MAX_ENTRIES:
                raise _invalid()
            total = 0
            names: set[str] = set()
            parts: dict[str, bytes] = {}
            for entry in entries:
                name = entry.filename
                pieces = name.rstrip("/").split("/")
                if (not name or len(name) > 512 or name.startswith("/") or "\\" in name or "\x00" in name
                        or ":" in name or any(piece in {"", ".", ".."} for piece in pieces)
                        or name.rstrip("/").lower() in names or entry.orig_filename != name or entry.flag_bits & 1
                        or entry.compress_type not in {ZIP_STORED, ZIP_DEFLATED}
                        or stat.S_IFMT(entry.external_attr >> 16) not in {0, stat.S_IFREG, stat.S_IFDIR}
                        or entry.file_size > MAX_PART_BYTES
                        or (entry.file_size > 1024 * 1024 and entry.file_size > max(1, entry.compress_size) * 200)):
                    raise _invalid()
                names.add(name.rstrip("/").lower())
                total += entry.file_size
                if total > MAX_EXPANDED_BYTES:
                    raise _invalid()
                value = archive.read(entry)
                if len(value) != entry.file_size:
                    raise _invalid()
                parts[name] = value
            if "[Content_Types].xml" not in parts:
                raise _invalid()
            _xml(parts["[Content_Types].xml"])
            return parts
    except (BadZipFile, RuntimeError, OSError, ValueError, EOFError, ZlibError) as error:
        if isinstance(error, TemplateRenderError):
            raise
        raise _invalid() from error


def _part_labels(parts: dict[str, bytes], extension: str) -> tuple[list[str], dict[str, str]]:
    """Office 관계를 데이터로만 읽고 시트 이름·슬라이드 표시 순서를 보존한다."""
    root_part = "xl/workbook.xml" if extension == "xlsx" else "ppt/presentation.xml"
    relationships = "xl/_rels/workbook.xml.rels" if extension == "xlsx" else "ppt/_rels/presentation.xml.rels"
    if relationships not in parts:
        return [], {}
    by_id: dict[str, str] = {}
    for relation in _xml(parts[relationships]).children:
        target = relation.attrs.get("Target", "")
        expected_kind = "/worksheet" if extension == "xlsx" else "/slide"
        if not relation.attrs.get("Type", "").endswith(expected_kind):
            continue
        parsed = urlsplit(target)
        if (relation.attrs.get("TargetMode") == "External" or parsed.scheme or parsed.netloc
                or parsed.query or parsed.fragment or "\\" in target):
            continue
        decoded = unquote(parsed.path)
        path = posixpath.normpath(decoded.lstrip("/") if decoded.startswith("/")
                                 else posixpath.join(posixpath.dirname(root_part), decoded))
        if path in parts:
            by_id[relation.attrs.get("Id", "")] = path
    relation_namespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    names: dict[str, str] = {}
    order: list[str] = []
    for node in _walk(_xml(parts[root_part])):
        if (extension == "xlsx" and node.tag != SHEET + "sheet") or (extension == "pptx" and not node.tag.endswith("}sldId")):
            continue
        name = by_id.get(node.attrs.get(relation_namespace, ""))
        if name is None:
            continue
        if name in order or len(node.attrs.get("name", "")) > 200:
            raise _invalid()
        order.append(name)
        names[name] = node.attrs.get("name", f"시트 {len(order)}") if extension == "xlsx" else f"슬라이드 {len(order)}"
    return order, names


def _paragraph_runs(paragraph: _Node, namespace: str) -> list[_Node]:
    """중첩 텍스트 상자의 문단과 자동 필드 내용을 현재 문단에서 제외한다."""
    nodes: list[_Node] = []

    def visit(node: _Node) -> None:
        for child in node.children:
            if child.tag == namespace + "p":
                continue
            nodes.append(child)
            visit(child)

    visit(paragraph)
    protected = {WORD + "instrText", WORD + "fldChar", WORD + "fldSimple", DRAW + "fld"}
    if any(node.tag in protected for node in nodes):
        return []
    return [node for node in nodes if node.tag == namespace + "t"
            and (namespace != DRAW or (node.parent and node.parent.tag == DRAW + "r"))]


def _empty_paragraph(node: _Node, namespace: str) -> bool:
    """그림·자동 필드를 건드리지 않고 빈 텍스트 자리만 작성 가능하게 한다."""
    allowed_children = {namespace + "pPr", namespace + "r", namespace + "endParaRPr"}
    for child in node.children:
        if child.tag not in allowed_children:
            return False
        if child.tag == namespace + "r" and any(item.tag != namespace + "rPr" for item in child.children):
            return False
    return True


def _paragraph_location(node: _Node, label: str, index: int) -> str:
    """표의 행/열과 슬라이드 도형 이름을 원문 위치 설명에 덧붙인다."""
    ancestor = node.parent
    while ancestor is not None:
        if ancestor.tag == WORD + "tc" and ancestor.parent is not None:
            row = ancestor.parent
            cells = [child for child in row.children if child.tag == WORD + "tc"]
            rows = [child for child in row.parent.children if child.tag == WORD + "tr"] if row.parent else [row]
            if ancestor in cells and row in rows:
                return f"{label} · 표 행 {rows.index(row) + 1} 열 {cells.index(ancestor) + 1} · 문단 {index}"
        if ancestor.tag == "http://schemas.openxmlformats.org/presentationml/2006/main}sp":
            properties = next((item for item in _walk(ancestor) if item.tag.endswith("}cNvPr")), None)
            if properties is not None and 0 < len(properties.attrs.get("name", "")) <= 100:
                return f"{label} · {properties.attrs['name']} · 문단 {index}"
        ancestor = ancestor.parent
    return f"{label} · 문단 {index}"


def _prepare(filename: str, original: bytes) -> _Prepared:
    """지원 여부와 모든 작성 영역을 한 번의 동일한 해석으로 결정한다."""
    if not isinstance(filename, str) or not isinstance(original, bytes) or len(original) > MAX_FILE_BYTES:
        raise _invalid()
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in TEXT_FORMATS | OFFICE_FORMATS:
        raise TemplateRenderError("template_unsupported", "이 형식은 보관할 수 있지만 양식을 적용한 파일 생성은 아직 지원하지 않습니다. DOCX·PPTX·XLSX 또는 UTF-8 텍스트 양식을 선택해 주세요.")
    if extension in TEXT_FORMATS:
        try:
            text = original.decode("utf-8-sig")
        except UnicodeError as error:
            raise TemplateRenderError("template_unsupported", "텍스트 템플릿은 UTF-8로 저장한 파일을 선택해 주세요.") from error
        if INVALID_XML_TEXT.search(text):
            raise _invalid()
        if len(text) > MAX_SOURCE_CHARS:
            raise _limit()
        if not text.strip():
            raise TemplateRenderError("template_empty", "양식의 내용을 찾지 못했습니다. 작성할 구조나 예시가 포함된 파일을 선택해 주세요.")
        return _Prepared(extension, original, [_Field("f0001", text)], bom=original.startswith(b"\xef\xbb\xbf"))

    parts = _package(original)
    required = {"docx": "word/document.xml", "pptx": "ppt/presentation.xml", "xlsx": "xl/workbook.xml"}[extension]
    expected_root = {"docx": WORD + "document",
                     "pptx": "http://schemas.openxmlformats.org/presentationml/2006/main}presentation",
                     "xlsx": SHEET + "workbook"}[extension]
    if required not in parts or _xml(parts[required]).tag != expected_root:
        raise _invalid()
    fields: list[_Field] = []
    total = 0

    def add(text: str, part: str, kind: str, node: _Node, runs: list[_Node] | None = None,
            rich_part: str | None = None, rich_node: _Node | None = None,
            location: str = "문서 전체") -> None:
        nonlocal total
        total += len(text)
        if len(location) > 200:
            raise _invalid()
        if len(fields) >= MAX_FIELDS or total > MAX_SOURCE_CHARS:
            raise _limit()
        fields.append(_Field(f"f{len(fields) + 1:04d}", text, part, kind, node, runs or [], rich_part, rich_node, location))

    if extension in {"docx", "pptx"}:
        expression = (r"word/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml"
                      if extension == "docx" else r"ppt/slides/slide\d+\.xml")
        namespace = WORD if extension == "docx" else DRAW
        order, labels = _part_labels(parts, "pptx") if extension == "pptx" else ([], {})
        names = order + [name for name in sorted(parts, key=_natural) if name not in order]
        for name in names:
            if name not in order and not re.fullmatch(expression, name):
                continue
            paragraph_index = 0
            for node in _walk(_xml(parts[name])):
                if node.tag != namespace + "p":
                    continue
                runs = _paragraph_runs(node, namespace)
                if runs or _empty_paragraph(node, namespace):
                    paragraph_index += 1
                    stem = name.rsplit("/", 1)[-1].removesuffix(".xml")
                    label = labels.get(name)
                    if label is None:
                        label = ("본문" if stem == "document" else "각주" if stem == "footnotes"
                                 else "미주" if stem == "endnotes" else stem.replace("header", "머리말 ").replace("footer", "꼬리말 ").replace("slide", "슬라이드 "))
                    add("".join(item.text for item in runs), name, extension, node, runs,
                        location=_paragraph_location(node, label, paragraph_index))
    else:
        strings: list[tuple[str, _Node]] = []
        if "xl/sharedStrings.xml" in parts:
            strings_root = _xml(parts["xl/sharedStrings.xml"])
            if strings_root.tag != SHEET + "sst":
                raise _invalid()
            for item in strings_root.children:
                if item.tag == SHEET + "si":
                    strings.append(("".join(node.text for node in _walk(item) if node.tag == SHEET + "t"), item))
        order, labels = _part_labels(parts, "xlsx")
        names = order + [name for name in sorted(parts, key=_natural) if name not in order]
        for name in names:
            if name not in order and not re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name):
                continue
            root = _xml(parts[name])
            if root.tag != SHEET + "worksheet":
                raise _invalid()
            for node in _walk(root):
                if node.tag != SHEET + "c" or any(child.tag == SHEET + "f" for child in node.children):
                    continue
                value = next((child.text for child in node.children if child.tag == SHEET + "v"), "")
                rich_part, rich_node = None, None
                if node.attrs.get("t") == "s":
                    try:
                        if not re.fullmatch(r"\d+", value):
                            raise ValueError()
                        value, rich_node = strings[int(value)]
                        rich_part = "xl/sharedStrings.xml"
                    except (ValueError, IndexError) as error:
                        raise _invalid() from error
                elif node.attrs.get("t") == "inlineStr":
                    value = "".join(item.text for item in _walk(node) if item.tag == SHEET + "t")
                    rich_node = next((child for child in node.children if child.tag == SHEET + "is"), None)
                    rich_part = name
                sheet_label = labels.get(name, name.rsplit("/", 1)[-1].removesuffix(".xml").replace("sheet", "시트 "))
                address = node.attrs.get("r", "입력 셀")
                if "r" in node.attrs and not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}", address):
                    raise _invalid()
                add(value, name, "xlsx", node, rich_part=rich_part, rich_node=rich_node,
                    location=f"{sheet_label} · {address}")
    if not fields:
        raise TemplateRenderError("template_empty", "수정할 텍스트 영역이 없는 양식입니다. 텍스트나 입력 셀이 포함된 파일을 선택해 주세요.")
    return _Prepared(extension, original, fields, parts)


def inspect_template(filename: str, content: bytes) -> dict[str, Any]:
    """등록은 막지 않고 생성 지원 여부와 빠짐없는 작성 영역만 돌려준다."""
    try:
        prepared = _prepare(filename, content)
        return {"supported": True, "format": prepared.format, "reason": None,
                "fields": [{"id": item.id, "text": item.text, "location": item.location} for item in prepared.fields]}
    except TemplateRenderError as error:
        return {"supported": False, "format": None, "reason": error.message, "fields": []}


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def _replacements(answer: str, fields: list[_Field]) -> dict[str, str]:
    """실제 AI 답변의 한 결과 블록만 파싱하고 미등록 영역을 거부한다."""
    error = TemplateRenderError("template_result_invalid", "답변의 양식 작성 결과를 확인하지 못했습니다. 템플릿을 선택하고 다시 작성을 요청해 주세요.")
    if not isinstance(answer, str) or len(answer) > MAX_ANSWER_CHARS:
        raise error
    # 결과 블록을 두 개 반환하거나 코드블록 안에 숨긴 결과를 선택하지 않는다.
    if len(re.findall(r"^```wiki-template-result(?:[ \t]*\r?$)", answer, re.MULTILINE)) != 1:
        raise error
    found = RESULT_BLOCK.search(answer)
    if found is None or "```" in found.group(1):
        raise error
    if len(re.findall(r"^```[^\n]*$", answer[:found.start()], re.MULTILINE)) % 2:
        raise error
    try:
        value = json.loads(found.group(1), object_pairs_hook=_unique_object)
        if not isinstance(value, dict) or set(value) != {"version", "replacements"} or type(value["version"]) is not int or value["version"] != 1:
            raise ValueError()
        items = value["replacements"]
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_FIELDS:
            raise ValueError()
        known = {item.id: item for item in fields}
        result: dict[str, str] = {}
        total = 0
        for item in items:
            if not isinstance(item, dict) or set(item) != {"id", "text"}:
                raise ValueError()
            identifier, text = item["id"], item["text"]
            if not isinstance(identifier, str) or identifier not in known or identifier in result or not isinstance(text, str) or INVALID_XML_TEXT.search(text):
                raise ValueError()
            total += len(text)
            if total > MAX_RESULT_CHARS:
                raise ValueError()
            result[identifier] = text
        if all(known[identifier].text == text for identifier, text in result.items()):
            raise TemplateRenderError("template_no_change", "답변에 템플릿을 변경할 내용이 없습니다. 작성할 내용을 구체적으로 요청해 주세요.")
        return result
    except (TypeError, ValueError, RecursionError) as caught:
        if isinstance(caught, TemplateRenderError):
            raise
        raise error from caught


def _escape(value: str) -> bytes:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\r", "&#13;").encode("utf-8")


def _qname(raw: bytes, node: _Node) -> bytes:
    found = re.match(rb"<([^\s/>]+)", raw[node.start:node.open_end])
    if found is None:
        raise _invalid()
    return found.group(1)


def _open(raw: bytes, node: _Node) -> bytes:
    tag = raw[node.start:node.open_end]
    return re.sub(rb"/\s*>$", b">", tag)


def _text_markup(raw: bytes, node: _Node, value: str, namespace: str) -> bytes:
    """기존 텍스트 노드의 태그와 공백 보존 속성을 유지한다."""
    start = _open(raw, node)
    if re.search(rb"\bxml:space\s*=", start):
        start = re.sub(rb"\bxml:space\s*=\s*([\"']).*?\1", b'xml:space="preserve"', start)
    else:
        start = start[:-1] + b' xml:space="preserve">'
    name = _qname(raw, node)
    close = b"</" + name + b">"
    if namespace == WORD:
        prefix = name.rsplit(b":", 1)[0] + b":" if b":" in name else b""
        separator = close + b"<" + prefix + b"br/>" + start
        return start + separator.join(_escape(line) for line in value.split("\n")) + close
    return start + _escape(value) + close


def _empty_paragraph_edit(raw: bytes, item: _Field, value: str) -> tuple[int, int, bytes]:
    """빈 문단의 스타일을 이어 받아 텍스트 run만 추가한다."""
    node = item.node
    if node is None:
        raise _invalid()
    name = _qname(raw, node)
    prefix = name.rsplit(b":", 1)[0] + b":" if b":" in name else b""
    namespace = WORD if item.kind == "docx" else DRAW
    style = next((child for child in node.children if child.tag == namespace + "endParaRPr"), None)
    run_properties = b""
    if style is not None:
        style_name = _qname(raw, style)
        new_name = prefix + b"rPr"
        run_properties = raw[style.start:style.end].replace(b"<" + style_name, b"<" + new_name, 1).replace(b"</" + style_name + b">", b"</" + new_name + b">")
    elif namespace == WORD:
        properties = next((child for child in node.children if child.tag == WORD + "pPr"), None)
        style = next((child for child in properties.children if child.tag == WORD + "rPr"), None) if properties else None
        if style is not None:
            run_properties = raw[style.start:style.end]
    text_start = b"<" + prefix + b't xml:space="preserve">'
    text_end = b"</" + prefix + b"t>"
    run_start = b"<" + prefix + b"r>" + run_properties
    run_end = b"</" + prefix + b"r>"
    if namespace == DRAW:
        insertion = (b"<" + prefix + b"br/>").join(run_start + text_start + _escape(line) + text_end + run_end for line in value.split("\n"))
    else:
        insertion = run_start + text_start + (text_end + b"<" + prefix + b"br/>" + text_start).join(_escape(line) for line in value.split("\n")) + text_end + run_end
    if node.end == node.open_end:
        return node.start, node.end, _open(raw, node) + insertion + b"</" + name + b">"
    before_end_style = next((child for child in node.children if child.tag == DRAW + "endParaRPr"), None)
    at = before_end_style.start if before_end_style else node.end_start
    return at, at, insertion


def _paragraph_edits(raw: bytes, item: _Field, value: str) -> list[tuple[int, int, bytes]]:
    """원래 run 경계와 서식을 남기고 텍스트를 같은 순서의 run에 나눈다."""
    if not item.runs:
        return [_empty_paragraph_edit(raw, item, value)]
    edits: list[tuple[int, int, bytes]] = []
    remaining = value
    for index, node in enumerate(item.runs):
        chunk = remaining if index == len(item.runs) - 1 else remaining[:len(node.text)]
        remaining = remaining[len(chunk):]
        namespace = WORD if item.kind == "docx" else DRAW
        if namespace == DRAW and "\n" in chunk:
            run = node.parent
            if run is None or run.tag != DRAW + "r" or len([child for child in run.children if child.tag == DRAW + "t"]) != 1:
                raise _invalid()
            name = _qname(raw, run)
            prefix = name.rsplit(b":", 1)[0] + b":" if b":" in name else b""
            fragments = [raw[run.start:node.start] + _text_markup(raw, node, line, DRAW) + raw[node.end:run.end]
                         for line in chunk.split("\n")]
            edits.append((run.start, run.end, (b"<" + prefix + b"br/>").join(fragments)))
        else:
            edits.append((node.start, node.end, _text_markup(raw, node, chunk, namespace)))
    return edits


def _namespace_attributes(raw: bytes, node: _Node) -> bytes:
    """옮겨 넣는 rich string에 원래의 namespace 선언을 함께 전달한다."""
    declarations: dict[bytes, bytes] = {}
    ancestors: list[_Node] = []
    current: _Node | None = node
    while current is not None:
        ancestors.append(current)
        current = current.parent
    expression = rb"\s+(xmlns(?::[\w.-]+)?)\s*=\s*(?:\"[^\"]*\"|'[^']*')"
    for ancestor in reversed(ancestors):
        for match in re.finditer(expression, raw[ancestor.start:ancestor.open_end]):
            declarations[match.group(1)] = match.group(0)
    return b"".join(declarations.values())


def _rich_string(raw: bytes, node: _Node, value: str) -> bytes:
    """공유 문자열을 셀별 복사하면서 기존 run의 글꼴·강조를 유지한다."""
    runs = [item for item in _walk(node) if item.tag == SHEET + "t"]
    remaining = value
    edits: list[tuple[int, int, bytes]] = []
    for index, item in enumerate(runs):
        chunk = remaining if index == len(runs) - 1 else remaining[:len(item.text)]
        remaining = remaining[len(chunk):]
        edits.append((item.start - node.open_end, item.end - node.open_end, _text_markup(raw, item, chunk, SHEET)))
    body = raw[node.open_end:node.end_start]
    for start, end, replacement in reversed(edits):
        body = body[:start] + replacement + body[end:]
    declarations = _namespace_attributes(raw, node)
    local_prefix = b"wikiTemplate"
    while b"xmlns:" + local_prefix + b"=" in declarations.replace(b" ", b""):
        local_prefix += b"x"
    declarations += b' xmlns:' + local_prefix + b'="' + SHEET[:-1].encode("ascii") + b'"'
    local_prefix += b":"
    if not runs:
        body = b"<" + local_prefix + b't xml:space="preserve">' + _escape(value) + b"</" + local_prefix + b"t>"
    return b"<" + local_prefix + b"is" + declarations + b">" + body + b"</" + local_prefix + b"is>"


def _cell_edit(raw: bytes, item: _Field, value: str, parts: dict[str, bytes]) -> tuple[int, int, bytes]:
    """대상 셀만 inline string으로 바꾸고 다른 공유 문자열과 수식은 건드리지 않는다."""
    node = item.node
    if node is None:
        raise _invalid()
    name = _qname(raw, node)
    prefix = name.rsplit(b":", 1)[0] + b":" if b":" in name else b""
    start = _open(raw, node)
    cell_type = "inlineStr"
    original_type = node.attrs.get("t", "n")
    if original_type in {"n", "b"} and re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", value):
        try:
            if math.isfinite(float(value)):
                cell_type = "b" if original_type == "b" and value in {"0", "1"} else "n"
        except (OverflowError, ValueError):
            pass
    if len(value) > 32767:
        raise TemplateRenderError("template_result_limit", "Excel 셀의 텍스트가 32,767자를 넘었습니다. 작성 범위를 줄여 주세요.")
    type_attribute = b' t="' + cell_type.encode("ascii") + b'"'
    if re.search(rb"\s+t\s*=", start):
        start = re.sub(rb"(\s+t\s*=\s*)([\"']).*?\2", type_attribute, start)
    else:
        start = start[:-1] + type_attribute + b">"
    preserved = b"".join(raw[child.start:child.end] for child in node.children if child.tag not in {SHEET + "v", SHEET + "is"})
    if cell_type != "inlineStr":
        content = b"<" + prefix + b"v>" + _escape(value) + b"</" + prefix + b"v>"
    else:
        content = b"<" + prefix + b"is><" + prefix + b't xml:space="preserve">' + _escape(value) + b"</" + prefix + b"t></" + prefix + b"is>"
        if item.rich_node is not None and item.rich_part is not None:
            content = _rich_string(parts[item.rich_part], item.rich_node, value)
    return node.start, node.end, start + content + preserved + b"</" + name + b">"


def _apply(raw: bytes, edits: list[tuple[int, int, bytes]]) -> bytes:
    """중첩 수정이 없는지 검사한 뒤 원본 바이트 구간을 역순으로 바꾼다."""
    edits = sorted(edits)
    if any(left[1] > right[0] for left, right in zip(edits, edits[1:])):
        raise _invalid()
    for start, end, replacement in reversed(edits):
        raw = raw[:start] + replacement + raw[end:]
    _xml(raw)
    return raw


def render_template(filename: str, original: bytes, content: str) -> bytes:
    """고정된 템플릿과 검증한 작성 결과로 실제 파일 바이트를 만든다."""
    prepared = _prepare(filename, original)
    replacements = _replacements(content, prepared.fields)
    if prepared.format in TEXT_FORMATS:
        text = replacements.get("f0001", prepared.fields[0].text)
        result = (b"\xef\xbb\xbf" if prepared.bom else b"") + text.encode("utf-8")
    else:
        changes: dict[str, list[tuple[int, int, bytes]]] = {}
        for item in prepared.fields:
            if item.id not in replacements or replacements[item.id] == item.text:
                continue
            raw = prepared.parts[item.part]
            edits = [_cell_edit(raw, item, replacements[item.id], prepared.parts)] if item.kind == "xlsx" else _paragraph_edits(raw, item, replacements[item.id])
            changes.setdefault(item.part, []).extend(edits)
        updated = {name: _apply(prepared.parts[name], edits) for name, edits in changes.items()}
        output = BytesIO()
        with ZipFile(BytesIO(original)) as source, ZipFile(output, "w") as target:
            target.comment = source.comment
            for entry in source.infolist():
                target.writestr(entry, updated.get(entry.filename, prepared.parts[entry.filename]))
        result = output.getvalue()
    if len(result) > MAX_FILE_BYTES:
        raise TemplateRenderError("template_result_limit", "생성 결과가 파일 크기 제한을 넘었습니다. 작성 범위를 줄여 주세요.")
    return result
