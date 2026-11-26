"""검증한 로컬 사본만 정적 PNG로 렌더한다. 원본·서버·AI에는 쓰지 않는다."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import posixpath
from io import BytesIO
import subprocess
import sys
from zipfile import ZipFile, ZIP_DEFLATED
from urllib.parse import unquote

from core.runtime.client_process import no_window_options
from core.client.office_runtime import find_libreoffice, office_environment

MAX_EDGE = 1600
MAX_PNG = 8 * 1024 * 1024
OFFICE = {"docx", "xlsx", "pptx", "ppt"}
IMAGES = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"}


class PreviewError(Exception):
    """본문·파일 경로를 공개하지 않는 오류 코드다."""


def office_binary() -> str:
    """앱 번들 또는 기존 설치를 찾으며 설치·다운로드를 수행하지 않는다."""
    binary = find_libreoffice(platform=sys.platform)
    if binary:
        return binary
    raise PreviewError("office_preview_unavailable")


def sanitize_package(original: Path, target: Path) -> bool:
    """표시용 사본에서 동적 참조·수식·필드·매크로·포함 개체를 제거한다."""
    from lxml import etree

    blocked = ("vbaproject", "vbadata", "activex", "embeddings/", "externallinks/",
               "connections.xml", "querytables/", "customui/", "attachedtemplate",
               ".svg", ".wmf", ".emf", ".bin")
    changed = False
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    with ZipFile(original) as source, ZipFile(target, "x", ZIP_DEFLATED) as output:
        entries = source.infolist()
        if len(entries) > 20000 or sum(item.file_size for item in entries) > 256 * 1024 * 1024:
            raise PreviewError("preview_document_too_complex")
        names = [item.filename for item in entries]
        name_set = set(names)
        if len(name_set) != len(names):
            raise PreviewError("preview_document_invalid")
        # 확장자만 PNG로 바꾼 SVG/외부 이미지도 Office 이미지 로더에 넘기지 않는다.
        from PIL import Image
        safe_media = set()
        for item in entries:
            if Path(item.filename).suffix.lower().lstrip(".") not in IMAGES:
                continue
            try:
                with Image.open(BytesIO(source.read(item))) as image:
                    image.verify()
                safe_media.add(item.filename)
            except Exception:
                pass
        for item in entries:
            name = item.filename
            if name.startswith("/") or ".." in Path(name).parts or "\\" in name:
                raise PreviewError("preview_document_invalid")
            if any(part in name.lower() for part in blocked):
                changed = True
                continue
            content = source.read(item)
            if name.endswith((".xml", ".rels")):
                if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
                    raise PreviewError("preview_document_invalid")
                root = etree.fromstring(content, parser)
                for element in list(root.iter()):
                    local = etree.QName(element).localname
                    remove = local in {"f", "formula", "formula1", "formula2", "definedNames", "definedName",
                                       "conditionalFormatting", "dataValidations", "calculatedColumnFormula", "totalsRowFormula",
                                       "instrText", "fldChar", "externalReferences", "externalData",
                                       "oleObject", "oleObj", "control", "controls", "altChunk"}
                    if local == "Relationship":
                        rel_type = element.get("Type", "").lower()
                        destination = element.get("Target", "").lower()
                        target = unquote(element.get("Target", "").split("#", 1)[0])
                        owner_dir = "" if name == "_rels/.rels" else posixpath.dirname(name).removesuffix("/_rels")
                        package_target = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(owner_dir, target))
                        remove = (element.get("TargetMode", "").lower() == "external"
                                  or ":" in destination or "\\" in destination or package_target not in name_set
                                  or (rel_type.endswith("/image") and package_target not in safe_media)
                                  or any(part in destination or part in rel_type for part in blocked)
                                  or any(rel_type.endswith("/" + part) for part in ("oleobject", "package", "vbaproject", "attachedtemplate")))
                    if local == "Override":
                        remove = any(part in element.get("PartName", "").lower() for part in blocked)
                    if local == "fldSimple":
                        # 표시된 필드 결과는 남기고 실행할 명령만 제거한다.
                        for key in list(element.attrib):
                            if etree.QName(key).localname == "instr":
                                del element.attrib[key]
                                changed = True
                    for key in list(element.attrib):
                        # VML 등 관계 파일을 거치지 않는 외부 이미지·개체 주소도 제거한다.
                        if etree.QName(key).localname.lower() in {"src", "href", "link", "movie", "codebase"}:
                            del element.attrib[key]
                            changed = True
                    if local == "calcPr":
                        element.set("calcMode", "manual")
                        element.set("fullCalcOnLoad", "0")
                        element.set("forceFullCalc", "0")
                    if remove and element.getparent() is not None:
                        element.getparent().remove(element)
                        changed = True
                content = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            output.writestr(name, content)
    return changed


def network_guard(work: Path) -> list[str]:
    """격리를 실제 확인한 경우에만 외부 참조를 제거할 수 없는 구형 PPT를 연다."""
    if sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").is_file():
        readable = [str(work), "/Applications/LibreOffice.app", "/System", "/Library",
                    "/usr", "/private/etc", "/private/var/db", "/dev", str(Path.home() / "Library/Fonts")]
        directories = sorted({str(parent) for path in readable for parent in Path(path).parents})
        profile = ('(version 1)(allow default)'
                   '(deny network-outbound (remote ip "*:*"))(deny network-inbound (local ip "*:*"))'
                   '(deny file-read-data (require-all '
                   + " ".join('(require-not (literal ' + json.dumps(path) + '))' for path in directories) + ' '
                   + " ".join('(require-not (subpath ' + json.dumps(path) + '))' for path in readable) + '))'
                   '(deny file-write* (require-all (require-not (subpath ' + json.dumps(str(work)) + ')) (require-not (subpath "/dev"))))')
        command = ["/usr/bin/sandbox-exec", "-p", profile]
        result = subprocess.run([*command, "/usr/bin/true"], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=5, check=False)
        if result.returncode == 0:
            return command
    raise PreviewError("legacy_office_preview_unavailable")


def prepare(work: Path, format: str) -> dict:
    """보호 작업 폴더 안에서만 렌더 파일과 페이지 개수를 만든다."""
    source = work / ("source." + format)
    if format in IMAGES:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 40_000_000
        with Image.open(source) as image:
            count = getattr(image, "n_frames", 1)
            if count > 10000:
                raise PreviewError("preview_document_too_complex")
        return {"pageCount": count, "kind": "image", "limited": False}
    if format not in OFFICE:
        raise PreviewError("preview_format_unsupported")
    binary = office_binary()
    guard = network_guard(work) if format == "ppt" else []
    input_file = source
    limited = False
    if format != "ppt":
        input_file = work / ("preview." + format)
        limited = sanitize_package(source, input_file)
    expected_slides = None
    if format == "pptx":
        from lxml import etree
        with ZipFile(input_file) as package:
            root = etree.fromstring(package.read("ppt/presentation.xml"),
                                    etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False))
        expected_slides = len(root.findall("{*}sldIdLst/{*}sldId"))
        if expected_slides < 1:
            raise PreviewError("preview_document_invalid")
    profile = work / "profile"
    user = profile / "user"
    user.mkdir(parents=True, mode=0o700)
    # 전용 프로필은 기존 사용자 설정·신뢰 위치를 읽지 않는다. 매크로는 전면 금지한다.
    (user / "registrymodifications.xcu").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>'
        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>'
        '<item oor:path="/org.openoffice.Office.Common/Load">'
        '<prop oor:name="UpdateLinks" oor:op="fuse"><value>false</value></prop></item>'
        '<item oor:path="/org.openoffice.Office.Calc/Content/Update">'
        '<prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>'
        '</oor:items>', encoding="utf-8")
    output = work / "rendered"
    output.mkdir(mode=0o700)
    temporary = work / "temporary"
    temporary.mkdir(mode=0o700)
    # 숨김 슬라이드도 포함해야 원본 슬라이드 번호와 화면의 위치가 일치한다.
    export = ('pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'
              if format == "pptx" else "pdf")
    result = subprocess.run(
        [*guard, binary, "-env:UserInstallation=" + profile.as_uri(), "--headless", "--nologo",
         "--nodefault", "--norestore", "--convert-to", export, "--outdir", str(output), str(input_file)],
        # 시간 제한·취소는 main의 같은 프로세스 그룹/Windows Job이 자식까지 회수한다.
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        env={**office_environment(work), "SAL_DISABLE_OPENCL": "1", "SAL_USE_VCLPLUGIN": "svp",
             "TMPDIR": str(temporary), "TEMP": str(temporary), "TMP": str(temporary),
             "XDG_CACHE_HOME": str(work / "cache")},
        **no_window_options())
    pdf = output / (input_file.stem + ".pdf")
    if result.returncode != 0 or not pdf.is_file() or pdf.stat().st_size > 128 * 1024 * 1024:
        raise PreviewError("legacy_office_preview_unavailable" if format == "ppt" else "office_preview_failed")
    pdf.rename(work / "preview.pdf")
    import pypdfium2
    with pypdfium2.PdfDocument(work / "preview.pdf") as document:
        count = len(document)
    if not 1 <= count <= 100000:
        raise PreviewError("preview_document_too_complex")
    if expected_slides is not None and count != expected_slides:
        raise PreviewError("preview_page_count_mismatch")
    return {"pageCount": count, "kind": "office", "limited": limited or format == "ppt"}


def render(work: Path, format: str, page: int) -> None:
    """페이지 번호만 받아 네트워크 참조 없는 PNG 한 장을 만든다."""
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 40_000_000
    if page < 1:
        raise PreviewError("preview_page_not_found")
    if format in IMAGES:
        with Image.open(work / ("source." + format)) as source:
            try:
                source.seek(page - 1)
            except EOFError as error:
                raise PreviewError("preview_page_not_found") from error
            image = ImageOps.exif_transpose(source).convert("RGBA")
            image.thumbnail((MAX_EDGE, MAX_EDGE))
    else:
        import pypdfium2
        with pypdfium2.PdfDocument(work / "preview.pdf") as document:
            if page > len(document):
                raise PreviewError("preview_page_not_found")
            item = document[page - 1]
            try:
                size = item.get_size()
                bitmap = item.render(scale=min(2, MAX_EDGE / max(size)))
                try:
                    image = bitmap.to_pil().copy()
                finally:
                    bitmap.close()
            finally:
                item.close()
    try:
        image.save(work / "page.png", format="PNG")
    finally:
        image.close()
    if (work / "page.png").stat().st_size > MAX_PNG:
        raise PreviewError("preview_image_too_large")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("prepare", "render"))
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--format", choices=sorted(OFFICE | IMAGES), required=True)
    parser.add_argument("--page", type=int, default=1)
    args = parser.parse_args()
    try:
        work = args.work_dir.resolve(strict=True)
        if args.operation == "prepare":
            result = prepare(work, args.format)
        else:
            render(work, args.format, args.page)
            result = {"rendered": True}
        print(json.dumps({"ok": True, "data": result}))
        return 0
    except PreviewError as error:
        print(json.dumps({"ok": False, "code": str(error)}))
    except Exception:
        print(json.dumps({"ok": False, "code": "source_preview_failed"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
