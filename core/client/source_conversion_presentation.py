"""개인 PC에서 프레젠테이션의 읽은 문자·슬라이드 순서와 미독을 보존한다.

PPTX는 ZIP 안의 XML만 읽고 외부 관계를 따라가지 않는다. 구형 PPT는 설치된
LibreOffice가 있을 때만 격리된 임시 사본을 PPTX로 변환하며 원본은 바꾸지 않는다.
"""

from contextlib import contextmanager
from pathlib import Path
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import unquote
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape
from zipfile import BadZipFile, ZipFile

from core.runtime.client_process import no_window_options
from . import source_conversion_relations as relations_view
from .source_conversion_report import MAX_TEXT, OutputLimit

P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DGM = "{http://schemas.openxmlformats.org/drawingml/2006/diagram}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
MAX_XML = 8 * 1024 * 1024
MAX_SLIDES = 500
# 슬라이드 그림 OCR(D-159): 슬라이드 면적의 이 비율보다 작은 그림(로고·아이콘)은 읽지 않는다.
PICTURE_OCR_MIN_FRACTION = .01
MAX_PICTURE_BYTES = 32 * 1024 * 1024
LOW_CONFIDENCE = "ocr_low_or_missing_confidence_text_retained_manual_review_required"


class _NoDoctype(ET.TreeBuilder):
    def doctype(self, name, pubid, system):
        raise ValueError("Document types are not accepted in presentation XML")


def _xml(archive, name):
    """압축 해제 크기를 먼저 검사하고 XML의 외부 선언을 허용하지 않는다."""
    item = archive.getinfo(name)
    if item.file_size > MAX_XML:
        raise OutputLimit()
    if item.flag_bits & 1 or item.is_dir():
        raise ValueError("Encrypted or missing XML part")
    with archive.open(item) as stream:
        raw = stream.read(MAX_XML + 1)
    if len(raw) > MAX_XML:
        raise OutputLimit()
    root = ET.fromstring(raw, parser=ET.XMLParser(target=_NoDoctype()))
    # Strict OOXML도 같은 문자/위치 모델로 읽고 원본 XML은 다시 쓰지 않는다.
    namespaces = {
        "{http://purl.oclc.org/ooxml/presentationml/main}": P,
        "{http://purl.oclc.org/ooxml/drawingml/main}": A,
        "{http://purl.oclc.org/ooxml/drawingml/diagram}": DGM,
        "{http://purl.oclc.org/ooxml/officeDocument/relationships}": R,
    }
    for node in root.iter():
        for old, new in namespaces.items():
            if node.tag.startswith(old):
                node.tag = new + node.tag[len(old):]
            for key in list(node.attrib):
                if key.startswith(old):
                    node.attrib[new + key[len(old):]] = node.attrib.pop(key)
    return root


def _relationships(archive, part):
    """관계는 패키지 안의 정규화된 경로로만 해석한다."""
    name = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if name not in archive.namelist():
        return {}
    root = _xml(archive, name)
    if root.tag != REL + "Relationships":
        raise ValueError("Invalid relationships root")
    result = {}
    for node in root:
        if node.tag != REL + "Relationship":
            continue
        key = node.get("Id")
        if not key or key in result:
            raise ValueError("Missing or duplicate relationship ID")
        target = unquote(node.get("Target", ""))
        external = node.get("TargetMode") == "External"
        path = None
        if not external:
            if not target or "\\" in target or ":" in target or "\x00" in target:
                raise ValueError("Invalid internal relationship")
            path = posixpath.normpath(target.lstrip("/") if target.startswith("/")
                                     else posixpath.join(posixpath.dirname(part), target))
            if path == ".." or path.startswith("../"):
                raise ValueError("Relationship escapes the package")
        result[key] = (node.get("Type", "").rsplit("/", 1)[-1], path)
    return result


def _paragraphs(body, *, notes=False):
    """문단·명시 줄바꿈·필드의 표시 문자열을 원래 순서대로 보존한다."""
    paragraphs = []
    for paragraph in body.findall(A + "p"):
        fragments = []
        for node in paragraph:
            # pPr/tabLst는 탭 위치 서식이며 본문의 탭 문자가 아니다.
            if node.tag in {A + "r", A + "fld"}:
                if notes and node.tag == A + "fld" and node.get("type") == "slidenum":
                    continue
                fragments.extend(text.text or "" for text in node.findall(A + "t"))
            elif node.tag == A + "br":
                fragments.append("\n")
            elif node.tag == A + "tab":
                fragments.append("\t")
        paragraphs.append("".join(fragments))
    return "\n".join(paragraphs)


def _attributes(node, keys):
    """원본 속성을 한 줄에 인용해 이름·ID 안의 줄바꿈도 구별한다."""
    if node is None:
        return ""
    return ", ".join(f"{key}={json.dumps(node.get(key), ensure_ascii=False)}"
                     for key in keys if node.get(key) is not None)


def _shape_identity(node):
    for tag in ("nvSpPr", "nvCxnSpPr", "nvGrpSpPr", "nvGraphicFramePr", "nvPicPr"):
        identity = node.find(P + tag + "/" + P + "cNvPr")
        if identity is not None:
            return identity
    return None


def _shape_details(node):
    """좌표는 그룹 내부의 원값이며 절대 배치나 읽기 순서로 해석하지 않는다."""
    details = []
    transform = next((value for path in (P + "spPr/" + A + "xfrm",
                                        P + "grpSpPr/" + A + "xfrm", P + "xfrm")
                      if (value := node.find(path)) is not None), None)
    if transform is not None:
        values = [_attributes(transform, ("rot", "flipH", "flipV"))]
        for tag, keys in (("off", ("x", "y")), ("ext", ("cx", "cy")),
                          ("chOff", ("x", "y")), ("chExt", ("cx", "cy"))):
            value = _attributes(transform.find(A + tag), keys)
            if value:
                values.append(f"{tag}({value})")
        details.append("원본 좌표·변환 (좌표는 EMU, rot·flip은 원본 속성값, 슬라이드 또는 상위 그룹 기준): "
                       + "; ".join(filter(None, values)))
    geometry = node.find(P + "spPr/" + A + "prstGeom")
    if geometry is not None:
        details.append("도형 종류: " + _attributes(geometry, ("prst",)))
    return details


def _geometry_numbers(node, names, *, positive=False):
    """수식·누락·범위 밖 값을 해석하지 않고 명시된 정수 좌표만 허용한다."""
    for name in names:
        raw = node.get(name, "")
        if len(raw) > 20 or re.fullmatch(r"-?[0-9]+", raw) is None:
            return False
        value = int(raw)
        if not -(2 ** 63) <= value < 2 ** 63 or (positive and value <= 0):
            return False
    return True


def _custom_geometry(geometry, emit):
    """숫자 직선 경로 전체를 먼저 확인하고 원값·명령 순서를 보존한다. 의미는 판정하지 않는다."""
    order = {A + name: index for index, name in enumerate(
        ("avLst", "gdLst", "ahLst", "cxnLst", "rect", "pathLst"))}
    children = list(geometry)
    if geometry.attrib or not children or children[-1].tag != A + "pathLst":
        return False
    tags = [child.tag for child in children]
    if any(tag not in order for tag in tags) or len(set(tags)) != len(tags):
        return False
    if [order[tag] for tag in tags] != sorted(order[tag] for tag in tags):
        return False
    if any((node.text or "").strip() or (node.tail or "").strip() for node in geometry.iter()):
        return False
    for child in children[:-1]:
        if child.tag == A + "rect":
            if list(child) or set(child.attrib) != {"l", "t", "r", "b"} or not _geometry_numbers(
                    child, ("l", "t", "r", "b")):
                return False
        elif child.attrib or list(child):
            return False  # 빈 보조 목록만 허용해 가이드 수식·조정점·연결점을 버리지 않는다.
    paths = children[-1]
    if paths.attrib or not list(paths):
        return False
    path_attributes = ("w", "h", "fill", "stroke", "extrusionOk")
    for path in paths:
        if (path.tag != A + "path" or set(path.attrib) - set(path_attributes)
                or not _geometry_numbers(path, ("w", "h"), positive=True)):
            return False
        if path.get("fill", "norm") not in {"none", "norm", "lighten", "lightenLess", "darken", "darkenLess"}:
            return False
        if any(path.get(key, "true") not in {"true", "false", "0", "1"} for key in ("stroke", "extrusionOk")):
            return False
        active = False
        has_line = False
        for command in path:
            if command.attrib:
                return False
            if command.tag == A + "close":
                if list(command) or not active or not has_line:
                    return False
                active = False
                continue
            if command.tag not in {A + "moveTo", A + "lnTo"} or len(command) != 1:
                return False
            point = command[0]
            if (point.tag != A + "pt" or list(point) or set(point.attrib) != {"x", "y"}
                    or not _geometry_numbers(point, ("x", "y"))):
                return False
            if command.tag == A + "moveTo":
                if active and not has_line:
                    return False
                active, has_line = True, False
            else:
                if not active:
                    return False
                has_line = True
        if not has_line:
            return False
    # 지원 밖의 명령이 뒤에 있으면 앞부분도 읽었다고 게시하지 않는다. 출력은 기존 전체 한도를 거친다.
    emit("사용자 정의 도형 직선 경로 (경로 내부 좌표·원본 명령, 시각·업무 의미 미검증)")
    rectangle = geometry.find(A + "rect")
    if rectangle is not None:
        emit("문자 영역 rect: " + _attributes(rectangle, ("l", "t", "r", "b")))
    for index, path in enumerate(paths, 1):
        emit(f"직선 경로 {index}: " + _attributes(path, path_attributes))
        for command in path:
            name = command.tag[len(A):]
            emit(name if name == "close" else name + ": " + _attributes(command[0], ("x", "y")))
    return True


def _smartart_text(node, archive, relations, result, scope):
    """SmartArt 데이터의 문자·명시 관계만 읽고 시각적 의미는 추정하지 않는다."""
    reference = node.find(".//" + DGM + "relIds")
    if reference is None:
        return None
    output = ["### SmartArt 데이터 (화면 배치·화살표 의미 미검증)"]
    output_bytes = len(output[0].encode("utf-8"))

    def append(value):
        nonlocal output_bytes
        output_bytes += len(value.encode("utf-8")) + 2
        if result.total_bytes + output_bytes > MAX_TEXT:
            raise OutputLimit()
        output.append(value)

    try:
        kind, target = relations[reference.get(R + "dm")]
        if kind != "diagramData" or target is None or archive is None:
            raise ValueError("Missing internal diagram data")
        try:
            root = _xml(archive, target)
        except OutputLimit:
            # 새 객체의 XML 한도 때문에 기존 본문과 다음 슬라이드를 버리지 않는다.
            result.note("smartart_data_xml_limit", scope)
            return output
        if root.tag != DGM + "dataModel":
            raise ValueError("Invalid diagram data root")
        points = root.findall(DGM + "ptLst/" + DGM + "pt")
        ids = [point.get("modelId") for point in points]
        known_ids = set(ids)
        if None in known_ids or len(ids) != len(known_ids):
            result.note("smartart_node_identity_not_resolved", scope)
        for point in points:
            append("SmartArt 항목: " + _attributes(point, ("modelId", "type")))
            body = point.find(DGM + "t")
            if body is not None:
                append(_paragraphs(body))
        for connection in root.findall(DGM + "cxnLst/" + DGM + "cxn"):
            append("SmartArt 원본 관계 (업무 관계로 해석하지 않음): " + _attributes(
                connection, ("modelId", "type", "srcId", "destId", "srcOrd", "destOrd",
                             "parTransId", "sibTransId", "presId")))
            if any(connection.get(key) not in known_ids or not connection.get(key)
                   for key in ("srcId", "destId")):
                result.note("smartart_connection_not_resolved", scope)
        # 데이터 문자열이 있어도 렌더링·그림·색으로만 표현된 의미를 읽은 것은 아니다.
        result.note("smartart_layout_and_visual_content_not_read", scope)
    except (KeyError, ValueError, ET.ParseError, BadZipFile, OSError, NotImplementedError):
        result.note("smartart_data_not_read", scope)
    return output


def _picture_fraction(node, slide_size):
    """그림이 슬라이드 넓이에서 차지하는 비율. 크기를 모르면 1(작다고 보지 않음)."""
    extent = node.find(P + "spPr/" + A + "xfrm/" + A + "ext")
    if not slide_size or extent is None:
        return 1.0
    try:
        return int(extent.get("cx")) * int(extent.get("cy")) / (slide_size[0] * slide_size[1])
    except (TypeError, ValueError):
        return 1.0


def _picture_text(node, archive, relations, result, scope, picture_text, slide_size):
    """그림 파일만 꺼내 문자를 읽는다. 읽은 문자는 OCR 표시와 함께 돌려주고 원래 문자는 바꾸지 않는다."""
    blip = node.find(".//" + A + "blip")
    target = relations.get(blip.get(R + "embed")) if blip is not None else None
    if target is None or target[0] != "image" or target[1] is None:
        result.note("picture_content_not_read", scope)
        return []
    extent = node.find(P + "spPr/" + A + "xfrm/" + A + "ext")
    if slide_size and extent is not None:
        try:
            fraction = int(extent.get("cx")) * int(extent.get("cy")) / (slide_size[0] * slide_size[1])
        except (TypeError, ValueError):
            fraction = None
        if fraction is not None and fraction < PICTURE_OCR_MIN_FRACTION:
            result.note("small_picture_not_ocr", scope, unread=False)
            return []
    try:
        item = archive.getinfo(target[1])
        if item.file_size > MAX_PICTURE_BYTES or item.flag_bits & 1:
            raise OutputLimit()
        with archive.open(item) as stream:
            raw = stream.read(MAX_PICTURE_BYTES + 1)
        if len(raw) > MAX_PICTURE_BYTES:
            raise OutputLimit()
    except OutputLimit:
        result.note("picture_too_large_not_read", scope)
        return []
    except (KeyError, OSError, BadZipFile):
        result.note("picture_content_not_read", scope)
        return []
    found = picture_text(raw)
    # 복구 템플릿의 내부 표식은 원문 문자와 분리된 그림 슬롯 전체를 가리킨다.
    if isinstance(found, dict) and "_recovery_slot" in found:
        return [found["_recovery_slot"]]
    if found is None:
        result.note("picture_without_readable_text", scope, unread=False)
        return []
    for code in found.get("warnings", []):
        result.note(code, scope, unread=False)
    if "failure" in found:
        result.note(found["failure"], scope)
        return []
    if found["low_confidence"]:
        result.note(LOW_CONFIDENCE, scope)
    label = "AI 전사 후보" if found.get("origin") == "ai_image_recovery_candidate" else "OCR"
    return [f"[그림 속 글자 · {label}]\n" + found["text"]]


RELATION_NOTES = {"estimated": "diagram_relations_estimated_by_position",
                  "unresolved": "diagram_relation_endpoints_unresolved",
                  "review": "pptx_diagram_relations_need_review"}


def _shape_text(tree, result, scope, *, notes=False, archive=None, relations=None, picture_text=None,
                slide_size=None, relation_slides=None):
    """도형·그룹·명시 연결을 보존한다. XML 순서를 시각적 읽기 순서로 주장하지 않는다."""
    output = []
    table_number = 0
    output_bytes = 0
    identities = {}

    def emit(*values):
        nonlocal output_bytes
        output_bytes += sum(len(value.encode("utf-8")) + 2 for value in values)
        if result.total_bytes + output_bytes > MAX_TEXT:
            raise OutputLimit()
        output.extend(values)

    def selected_nodes(parent, depth=0):
        if depth > 64:
            raise OutputLimit()
        for child in parent:
            if child.tag == MC + "AlternateContent":
                # Requires의 namespace 지원을 추정해 Choice를 고르지 않는다.
                fallback = child.find(MC + "Fallback")
                if fallback is None:
                    result.note("unsupported_slide_object_not_read", scope)
                else:
                    result.note("alternate_content_fallback_used_visual_equivalence_not_verified", scope)
                    yield from selected_nodes(fallback, depth + 1)
            else:
                children = list(selected_nodes(child, depth + 1)) if child.tag == P + "grpSp" else []
                identity = _shape_identity(child)
                if identity is not None and identity.get("id"):
                    key = identity.get("id")
                    identities[key] = identities.get(key, 0) + 1
                yield child, children

    def visit(node, children):
        nonlocal table_number
        identity = _attributes(_shape_identity(node), ("id", "name", "descr"))
        if node.tag == P + "grpSp":
            emit("### 그룹 시작" + (": " + identity if identity else ""), *_shape_details(node))
            for child, descendants in children:
                visit(child, descendants)
            emit("### 그룹 끝" + (": " + identity if identity else ""))
        elif node.tag in {P + "sp", P + "cxnSp"}:
            placeholder = node.find(".//" + P + "ph")
            if notes and placeholder is not None and placeholder.get("type") in {"sldImg", "sldNum", "hdr", "ftr", "dt"}:
                return
            if not notes:
                label = "연결선" if node.tag == P + "cxnSp" else "도형"
                emit(f"### {label}" + (": " + identity if identity else ""), *_shape_details(node))
                geometries = node.findall(P + "spPr/" + A + "custGeom")
                if geometries:
                    if (len(geometries) != 1 or node.find(P + "spPr/" + A + "prstGeom") is not None
                            or not _custom_geometry(geometries[0], emit)):
                        result.note("custom_shape_geometry_not_read", scope)
                    else:
                        result.note("custom_shape_path_preserved_visual_meaning_not_verified", scope, unread=False)
            if node.tag == P + "cxnSp":
                for tag, label in (("stCxn", "시작"), ("endCxn", "끝")):
                    endpoint = node.find(P + "nvCxnSpPr/" + P + "cNvCxnSpPr/" + A + tag)
                    emit(f"연결선 {label} 도형 참조: " + (_attributes(endpoint, ("id", "idx")) or "없음"))
                    # 파일의 연결 참조가 없거나 깨졌을 때, 슬라이드 크기가 있으면 아래 관계 정리가 위치로 끝을 찾고
                    # 못 찾으면 AI 해석 후보로 알린다(D-167). 슬라이드 크기가 없을 때만 미독이다.
                    if slide_size is None and identities.get(endpoint.get("id") if endpoint is not None else None) != 1:
                        result.note("connector_endpoint_not_resolved", scope)
                for tag in ("headEnd", "tailEnd"):
                    end = node.find(P + "spPr/" + A + "ln/" + A + tag)
                    if end is not None:
                        emit(f"선 끝 장식 {tag}: " + _attributes(end, ("type", "w", "len")))
            body = node.find(P + "txBody")
            if body is not None:
                emit(_paragraphs(body, notes=notes))
        elif node.tag == P + "graphicFrame":
            if identity:
                emit("### 그래픽: " + identity)
            emit(*_shape_details(node))
            table = node.find(".//" + A + "tbl")
            if table is None:
                diagram = _smartart_text(node, archive, relations or {}, result, scope)
                if diagram is None:
                    result.note("chart_smartart_or_embedded_object_not_read", scope)
                else:
                    emit(*diagram)
                return
            table_number += 1
            emit(f"### 표 {table_number}")
            for row_number, row in enumerate(table.findall(A + "tr"), 1):
                for column_number, cell in enumerate(row.findall(A + "tc"), 1):
                    body = cell.find(A + "txBody")
                    text = _paragraphs(body) if body is not None else ""
                    merge = ", ".join(f"{key}={cell.get(key)}" for key in ("gridSpan", "rowSpan", "hMerge", "vMerge") if cell.get(key) is not None)
                    emit(f"행 {row_number} · 열 {column_number}" + (f" ({merge})" if merge else "") + "\n" + text)
        elif node.tag == P + "pic":
            if identity:
                emit("### 그림: " + identity, *_shape_details(node))
            if picture_text is None or notes or archive is None:
                result.note("picture_content_not_read", scope)
            else:
                emit(*_picture_text(node, archive, relations or {}, result, scope, picture_text, slide_size))
        elif node.tag not in {P + "nvGrpSpPr", P + "grpSpPr"}:
            result.note("unsupported_slide_object_not_read", scope)
    selected = list(selected_nodes(tree))
    for node, children in selected:
        visit(node, children)
    if slide_size and not notes:
        # 연결선이 있으면 상자 사이 관계를 사람이 읽는 문장으로 정리한다(D-160). 끝을 못 찾은 연결이나 이름 없는
        # 상자가 많으면 PDF와 같이 붙이지 않고 AI 해석 후보로만 알린다. 글자는 위에서 모두 보존했으므로
        # 관계를 정하지 못한 것은 미독이 아니다(D-167).
        nodes, lines = relations_view.pptx_shapes(tree, _paragraphs)
        block, estimated, unresolved = relations_view.pptx_relation_lines(nodes, lines, slide_size)
        status = relations_view.review_status(block, unresolved)
        if status == "added":
            emit("\n".join(block))
        found = [kind for kind, present in (("estimated", status == "added" and estimated),
                 ("unresolved", status == "added" and unresolved), ("review", status == "review")) if present]
        for kind in found:
            # 슬라이드마다 경고를 늘리지 않고 PDF처럼 슬라이드 번호를 묶어서 남긴다(D-169).
            if relation_slides is None:
                result.note(RELATION_NOTES[kind], scope, unread=False, reserved=kind == "review")
            else:
                relation_slides[0][kind].append(relation_slides[1])
    return output


def _inherited_content(archive, part, relations, result, scope, visited=None, *, picture_text=None, slide_size=None,
                       literal_text_guard=None):
    """공통 문자는 표시 여부를 단정하지 않고 보존한다.

    슬라이드 레이아웃·마스터의 그림(p:pic)은 슬라이드 그림과 같은 규칙이다(D-159·D-167). 작은 그림(로고 등)은
    경고만 남기고, 큰 그림은 그림 파일의 문자를 읽어 덧붙인다. 도형 채우기·배경 그림·표/차트 틀과 노트 마스터의
    그래픽은 기존처럼 미독이다.
    """
    visited = set() if visited is None else visited
    output = []
    for kind, target in relations.values():
        if kind not in {"slideLayout", "slideMaster", "notesMaster"}:
            continue
        # slideMaster는 자신이 소유한 모든 slideLayout을 역참조한다. 현재 슬라이드의
        # 레이아웃에서 마스터로 올라간 뒤 다른 레이아웃까지 읽지 않는다.
        if target in visited or (visited and kind == "slideLayout"):
            continue
        if target is None or len(visited) >= 8:
            result.note("layout_or_master_reference_not_read", scope)
            continue
        visited.add(target)
        try:
            root = _xml(archive, target)
            if literal_text_guard is not None:
                literal_text_guard(root)
            try:
                target_relations = _relationships(archive, target)
            except (KeyError, ValueError, ET.ParseError):
                target_relations = None   # 공통 문자는 먼저 보존하고, 아래에서 기존처럼 미독으로 알린다.
            pictures = list(root.iter(P + "pic")) if kind != "notesMaster" and slide_size else []
            picture_blips = sum(len(picture.findall(".//" + A + "blip")) for picture in pictures)
            if len(root.findall(".//" + A + "blip")) > picture_blips or root.findall(".//" + P + "graphicFrame"):
                result.note("layout_or_master_graphics_not_read", scope)
            picture_output = []
            for picture in pictures:
                if picture_text is not None:
                    picture_output.extend(_picture_text(picture, archive, target_relations or {}, result, scope,
                                                        picture_text, slide_size))
                elif _picture_fraction(picture, slide_size) < PICTURE_OCR_MIN_FRACTION:
                    result.note("small_picture_not_ocr", scope, unread=False)
                else:
                    result.note("layout_or_master_graphics_not_read", scope)
            shared_text = []
            for shape in [*root.findall(".//" + P + "sp"), *root.findall(".//" + P + "cxnSp")]:
                placeholder = shape.find(".//" + P + "ph")
                # 제목/본문 placeholder의 지시 예시는 표시 본문이 아니다. 머리말·바닥글·
                # 날짜의 저장된 문자/필드는 표시 여부를 판정하지 않고 따로 보존한다.
                if placeholder is not None and placeholder.get("type", "obj") not in {"hdr", "ftr", "dt"}:
                    continue
                body = shape.find(P + "txBody")
                if body is not None:
                    text = _paragraphs(body)
                    if text.strip():
                        shared_text.append(text)
            if shared_text:
                label = {"slideLayout": "슬라이드 레이아웃", "slideMaster": "슬라이드 마스터", "notesMaster": "노트 마스터"}[kind]
                output.extend([f"### {label} 공통 문자 (표시 여부 미검증)", *shared_text])
                result.note("inherited_text_and_cached_fields_preserved_display_visibility_not_verified", scope, unread=False)
            if picture_output:
                label = {"slideLayout": "슬라이드 레이아웃", "slideMaster": "슬라이드 마스터"}[kind]
                output.extend([f"### {label} 그림 속 글자 (표시 여부 미검증)", *picture_output])
            if target_relations is None:
                raise ValueError("Unreadable layout or master relationships")
            output.extend(_inherited_content(archive, target, target_relations, result, scope, visited,
                                             picture_text=picture_text, slide_size=slide_size,
                                             literal_text_guard=literal_text_guard))
        except OutputLimit:
            raise
        except (KeyError, ValueError, ET.ParseError):
            result.note("layout_or_master_xml_not_read", scope)
    return output


def pptx(path, result, *, picture_text=None, selected_slides=None, literal_text_guard=None):
    """슬라이드 파일명 대신 presentation의 관계 목록 순서로 읽는다."""
    with ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 10000 or sum(item.file_size for item in entries) > 128 * 1024 * 1024:
            raise OutputLimit()
        if len(set(names)) != len(names):
            raise ValueError("Duplicate package parts")
        presentation = _xml(archive, "ppt/presentation.xml")
        if presentation.tag != P + "presentation":
            raise ValueError("Invalid presentation root")
        relations = _relationships(archive, "ppt/presentation.xml")
        slides = presentation.findall(P + "sldIdLst/" + P + "sldId")
        # 선택 재인식도 원본의 슬라이드 번호를 유지하며 범위 밖 요청은 부분 결과로 숨기지 않는다.
        if selected_slides is not None:
            if (not isinstance(selected_slides, (list, tuple, set, frozenset)) or not selected_slides
                    or any(type(number) is not int or not 1 <= number <= min(len(slides), MAX_SLIDES)
                           for number in selected_slides)
                    or len(set(selected_slides)) != len(selected_slides)):
                raise ValueError("Invalid selected slides")
            selected_slides = frozenset(selected_slides)
        size = presentation.find(P + "sldSz")
        try:
            slide_size = (int(size.get("cx")), int(size.get("cy"))) if size is not None else None
        except (TypeError, ValueError):
            slide_size = None
        if slide_size is not None and min(slide_size) <= 0:
            slide_size = None
        result.result["total_units"] = len(slides)
        relation_summary = {kind: [] for kind in RELATION_NOTES}
        for index, reference in enumerate(slides[:MAX_SLIDES], 1):
            if selected_slides is not None and index not in selected_slides:
                continue
            scope = f"slide {index}"
            try:
                kind, part = relations[reference.get(R + "id")]
                if kind != "slide" or part is None:
                    raise ValueError("Missing internal slide relationship")
                slide = _xml(archive, part)
                if literal_text_guard is not None:
                    literal_text_guard(slide)
                if slide.tag != P + "sld":
                    raise ValueError("Invalid slide root")
                tree = slide.find(P + "cSld/" + P + "spTree")
                if tree is None:
                    raise ValueError("Missing slide shape tree")
                try:
                    slide_relations = _relationships(archive, part)
                except (KeyError, ValueError, ET.ParseError):
                    result.note("slide_relationships_not_read", scope)
                    slide_relations = {}
                text = [f"## 슬라이드 {index}", *_shape_text(
                    tree, result, scope, archive=archive, relations=slide_relations,
                    picture_text=picture_text, slide_size=slide_size, relation_slides=(relation_summary, index))]
                if slide.get("show") == "0":
                    result.note("hidden_slide_included", scope, unread=False)
                blips = len(slide.findall(".//" + A + "blip"))
                if picture_text is not None:
                    # 그림(p:pic)의 그림 파일은 위에서 읽었다. 도형 채우기·배경 그림만 남는다.
                    blips -= sum(len(picture.findall(".//" + A + "blip")) for picture in slide.iter(P + "pic"))
                if blips:
                    result.note("picture_or_shape_fill_content_not_read", scope)
                text.extend(_inherited_content(archive, part, slide_relations, result, scope,
                                               picture_text=picture_text, slide_size=slide_size,
                                               literal_text_guard=literal_text_guard))
                for relation, target in slide_relations.values():
                    if relation == "notesSlide":
                        if target is None:
                            result.note("external_notes_not_read", scope)
                            continue
                        try:
                            notes = _xml(archive, target)
                            if literal_text_guard is not None:
                                literal_text_guard(notes)
                            notes_tree = notes.find(P + "cSld/" + P + "spTree")
                            if notes_tree is None or notes.tag != P + "notes":
                                raise ValueError("Missing notes shape tree")
                            notes_relations = _relationships(archive, target)
                            note_text = _shape_text(notes_tree, result, scope + " notes", notes=True,
                                                    archive=archive, relations=notes_relations)
                            note_text.extend(_inherited_content(archive, target, notes_relations, result, scope + " notes",
                                                                literal_text_guard=literal_text_guard))
                            if any(value.strip() for value in note_text):
                                text.extend(["### 발표자 노트", *note_text])
                        except (KeyError, ValueError, ET.ParseError):
                            result.note("notes_xml_not_read", scope)
                    elif relation in {"comments", "threadedComments", "oleObject", "audio", "video"}:
                        result.note("comments_media_or_embedded_object_not_read", scope)
                result.add(f"slide-{index}", {"kind": "slides", "start": index, "end": index}, "\n\n".join(text), "pptx_text")
            except OutputLimit:
                raise
            except (KeyError, ValueError, ET.ParseError):
                result.note("slide_or_notes_xml_failed", scope)
        if selected_slides is None and len(slides) > MAX_SLIDES:
            result.note("slide_limit", f"slides {MAX_SLIDES + 1}-{len(slides)}")
        for kind, numbers in relation_summary.items():
            for offset in range(0, len(numbers), 40):
                result.note(RELATION_NOTES[kind], "slides " + ",".join(map(str, numbers[offset:offset + 40])),
                            unread=False, reserved=kind == "review")
        result.note("shape_ids_groups_coordinates_and_explicit_connections_preserved_reading_order_and_rendering_not_verified", "PPTX", unread=False)


def _libreoffice():
    """PATH 및 운영체제의 일반 설치 위치만 확인하며 설치를 실행하지 않는다."""
    executable = shutil.which("soffice") or shutil.which("libreoffice")
    if executable:
        return executable
    candidates = [Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")]
    if os.name == "nt":
        for key in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
            root = os.environ.get(key)
            if root:
                candidates.append(Path(root) / "LibreOffice/program/soffice.exe")
    return next((str(path) for path in candidates if path.is_file()), None)


@contextmanager
def libreoffice_converted(path, suffix, convert_to, output_suffix, *, timeout=90):
    """설치된 LibreOffice로 원본의 임시 사본을 변환한다. (변환 파일 또는 None, 문제 코드 또는 None)을 준다.

    문제 코드는 "missing"·"timeout"·"failed"다. 원본은 바꾸지 않고 임시 폴더는 블록을 나갈 때 지운다.
    """
    executable = _libreoffice()
    if executable is None:
        yield None, "missing"
        return
    with tempfile.TemporaryDirectory(prefix="llm-wiki-office-") as directory:
        root = Path(directory)
        original = root / ("source" + suffix)
        shutil.copyfile(path, original)
        profile = root / "profile"
        profile.mkdir()
        # 새 전용 프로필의 높은 매크로 보안 수준을 명시한다.
        (profile / "user").mkdir()
        (profile / "user/registrymodifications.xcu").write_text(
            '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>'
            '</oor:items>', encoding="utf-8")
        output = root / "output"
        output.mkdir()
        environment = None
        if sys.platform == "darwin" and "FONTCONFIG_FILE" not in os.environ:
            # fontconfig를 쓰는 macOS LibreOffice(예: Homebrew)는 설정이 없으면 시스템 글꼴을 못 찾아 한글을
            # 빈칸으로 그린다. 이번 실행에만 macOS 글꼴 폴더를 알려 준다(D-169). 사용자 설정은 바꾸지 않는다.
            folders = ("/System/Library/Fonts", "/Library/Fonts", str(Path.home() / "Library/Fonts"))
            (root / "fonts.conf").write_text(
                '<?xml version="1.0"?><fontconfig>' + "".join(f"<dir>{escape(folder)}</dir>" for folder in folders)
                + f"<cachedir>{escape(str(root / 'font-cache'))}</cachedir></fontconfig>", encoding="utf-8")
            environment = {**os.environ, "FONTCONFIG_FILE": str(root / "fonts.conf")}
        try:
            process = subprocess.run([executable, "-env:UserInstallation=" + profile.as_uri(),
                "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to",
                convert_to, "--outdir", str(output), str(original)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                env=environment, **no_window_options())
        except subprocess.TimeoutExpired:
            yield None, "timeout"
            return
        converted = output / ("source" + output_suffix)
        if process.returncode != 0 or not converted.is_file():
            yield None, "failed"
            return
        yield converted, None


def ppt(path, result, *, picture_text=None):
    """구형 PPT는 별도 개인 도구가 있을 때만 임시 PPTX로 바꿔 읽는다."""
    with libreoffice_converted(path, ".ppt", "pptx:Impress MS PowerPoint 2007 XML", ".pptx") as (converted, problem):
        if problem == "missing":
            result.note("legacy_ppt_requires_libreoffice_or_pptx", "whole source")
            return
        if problem is not None:
            result.note(f"legacy_ppt_conversion_{problem}", "whole source")
            return
        result.note("legacy_ppt_converted_by_libreoffice_original_unchanged", "tools", unread=False)
        pptx(converted, result, picture_text=picture_text)
