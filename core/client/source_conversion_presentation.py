"""개인 PC에서 프레젠테이션의 읽은 문자·슬라이드 순서와 미독을 보존한다.

PPTX는 ZIP 안의 XML만 읽고 외부 관계를 따라가지 않는다. 구형 PPT는 설치된
LibreOffice가 있을 때만 격리된 임시 사본을 PPTX로 변환하며 원본은 바꾸지 않는다.
"""

from pathlib import Path
import os
import posixpath
import shutil
import subprocess
import tempfile
from urllib.parse import unquote
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from core.runtime.client_process import no_window_options
from .source_conversion_report import OutputLimit

P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
MAX_XML = 8 * 1024 * 1024
MAX_SLIDES = 500


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


def _shape_text(tree, result, scope, *, notes=False):
    """도형 순서와 표 셀 좌표를 표시하고 그림·차트·확장 객체는 미독으로 남긴다."""
    output = []
    table_number = 0
    for node in tree:
        if node.tag == P + "grpSp":
            output.extend(_shape_text(node, result, scope, notes=notes))
        elif node.tag in {P + "sp", P + "cxnSp"}:
            placeholder = node.find(".//" + P + "ph")
            if notes and placeholder is not None and placeholder.get("type") in {"sldImg", "sldNum", "hdr", "ftr", "dt"}:
                continue
            body = node.find(P + "txBody")
            if body is not None:
                output.append(_paragraphs(body, notes=notes))
        elif node.tag == P + "graphicFrame":
            table = node.find(".//" + A + "tbl")
            if table is None:
                result.note("chart_smartart_or_embedded_object_not_read", scope)
                continue
            table_number += 1
            output.append(f"### 표 {table_number}")
            for row_number, row in enumerate(table.findall(A + "tr"), 1):
                for column_number, cell in enumerate(row.findall(A + "tc"), 1):
                    body = cell.find(A + "txBody")
                    text = _paragraphs(body) if body is not None else ""
                    merge = ", ".join(f"{key}={cell.get(key)}" for key in ("gridSpan", "rowSpan", "hMerge", "vMerge") if cell.get(key) is not None)
                    output.append(f"행 {row_number} · 열 {column_number}" + (f" ({merge})" if merge else "") + "\n" + text)
        elif node.tag == P + "pic":
            result.note("picture_content_not_read", scope)
        elif node.tag not in {P + "nvGrpSpPr", P + "grpSpPr"}:
            result.note("unsupported_slide_object_not_read", scope)
    return output


def _inherited_content(archive, part, relations, result, scope, visited=None):
    """공통 문자는 표시 여부를 단정하지 않고 보존하며 그림·그래픽은 미독으로 남긴다."""
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
            if root.findall(".//" + A + "blip") or root.findall(".//" + P + "graphicFrame"):
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
            output.extend(_inherited_content(archive, target, _relationships(archive, target), result, scope, visited))
        except OutputLimit:
            raise
        except (KeyError, ValueError, ET.ParseError):
            result.note("layout_or_master_xml_not_read", scope)
    return output


def pptx(path, result):
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
        result.result["total_units"] = len(slides)
        for index, reference in enumerate(slides[:MAX_SLIDES], 1):
            scope = f"slide {index}"
            try:
                kind, part = relations[reference.get(R + "id")]
                if kind != "slide" or part is None:
                    raise ValueError("Missing internal slide relationship")
                slide = _xml(archive, part)
                if slide.tag != P + "sld":
                    raise ValueError("Invalid slide root")
                tree = slide.find(P + "cSld/" + P + "spTree")
                if tree is None:
                    raise ValueError("Missing slide shape tree")
                text = [f"## 슬라이드 {index}", *_shape_text(tree, result, scope)]
                if slide.get("show") == "0":
                    result.note("hidden_slide_included", scope, unread=False)
                if slide.findall(".//" + A + "blip"):
                    result.note("picture_or_shape_fill_content_not_read", scope)
                try:
                    slide_relations = _relationships(archive, part)
                except (KeyError, ValueError, ET.ParseError):
                    result.note("slide_relationships_not_read", scope)
                    slide_relations = {}
                text.extend(_inherited_content(archive, part, slide_relations, result, scope))
                for relation, target in slide_relations.values():
                    if relation == "notesSlide":
                        if target is None:
                            result.note("external_notes_not_read", scope)
                            continue
                        try:
                            notes = _xml(archive, target)
                            notes_tree = notes.find(P + "cSld/" + P + "spTree")
                            if notes_tree is None or notes.tag != P + "notes":
                                raise ValueError("Missing notes shape tree")
                            note_text = _shape_text(notes_tree, result, scope + " notes", notes=True)
                            note_text.extend(_inherited_content(archive, target, _relationships(archive, target), result, scope + " notes"))
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
        if len(slides) > MAX_SLIDES:
            result.note("slide_limit", f"slides {MAX_SLIDES + 1}-{len(slides)}")
        result.note("shape_order_and_table_coordinates_only_layout_and_master_rendering_not_verified", "PPTX", unread=False)


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


def ppt(path, result):
    """구형 PPT는 별도 개인 도구가 있을 때만 임시 PPTX로 바꿔 읽는다."""
    executable = _libreoffice()
    if executable is None:
        result.note("legacy_ppt_requires_libreoffice_or_pptx", "whole source")
        return
    with tempfile.TemporaryDirectory(prefix="llm-wiki-ppt-") as directory:
        root = Path(directory)
        original = root / "source.ppt"
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
        try:
            process = subprocess.run([executable, "-env:UserInstallation=" + profile.as_uri(),
                "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to",
                "pptx:Impress MS PowerPoint 2007 XML", "--outdir", str(output), str(original)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90, check=False,
                **no_window_options())
        except subprocess.TimeoutExpired:
            result.note("legacy_ppt_conversion_timeout", "whole source")
            return
        converted = output / "source.pptx"
        if process.returncode != 0 or not converted.is_file():
            result.note("legacy_ppt_conversion_failed", "whole source")
            return
        result.note("legacy_ppt_converted_by_libreoffice_original_unchanged", "tools", unread=False)
        pptx(converted, result)
