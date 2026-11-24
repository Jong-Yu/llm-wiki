"""보관 형식을 식별한다. 문서/이미지를 변환하거나 전체 내용을 검증하지 않는다."""

import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile
import zlib

from .contracts import UnsupportedSourceError


MAX_DOCX_ENTRIES = 10000
MAX_CONTENT_TYPES_BYTES = 256 * 1024
DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
PPTX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"


class _NoDoctype(ET.TreeBuilder):
    def doctype(self, name, pubid, system):
        raise ValueError("Document types are not accepted in package metadata")


def _ooxml(stream, format):
    # 압축을 풀어 파일로 쓰지 않는다. DOCX 식별 표식만 제한된 크기로 읽는다.
    # XLSX/일반 ZIP를 .docx로 바꾼 경우를 구분하되 본문 정확성/안전을 보증하지 않는다.
    part, content_type = ("word/document.xml", DOCX_CONTENT_TYPE) if format == "docx" else ("ppt/presentation.xml", PPTX_CONTENT_TYPE)
    with ZipFile(stream) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > MAX_DOCX_ENTRIES or len(set(names)) != len(names):
            raise ValueError("Invalid package directory")
        for name in ("[Content_Types].xml", "_rels/.rels", part):
            info = archive.getinfo(name)
            if info.is_dir() or info.flag_bits & 1 or info.file_size == 0:
                raise ValueError("Missing or encrypted document marker")
        info = archive.getinfo("[Content_Types].xml")
        if info.file_size > MAX_CONTENT_TYPES_BYTES:
            raise ValueError("Package metadata exceeds the validation limit")
        with archive.open(info) as source:
            raw = source.read(MAX_CONTENT_TYPES_BYTES + 1)
        if len(raw) > MAX_CONTENT_TYPES_BYTES:
            raise ValueError("Package metadata exceeds the validation limit")
        root = ET.fromstring(raw, parser=ET.XMLParser(target=_NoDoctype()))
        namespace = "{http://schemas.openxmlformats.org/package/2006/content-types}"
        if root.tag != namespace + "Types":
            raise ValueError("Invalid package content types")
        document_types = [node.attrib.get("ContentType") for node in root
            if node.tag == namespace + "Override" and node.attrib.get("PartName") == "/" + part]
        if document_types != [content_type]:
            raise ValueError("The package does not match its document format")


def validate_binary(stream, format):
    """확장자와 실제 파일 표식을 대조한다. 원본 스트림은 읽기만 한다."""
    header = stream.read(16)
    signatures = {
        "pdf": header.startswith(b"%PDF-"),
        "xlsx": header.startswith(b"PK\x03\x04"),
        "docx": header.startswith(b"PK\x03\x04"),
        "pptx": header.startswith(b"PK\x03\x04"),
        # 구형 PPT는 OLE 컨테이너 표식만 확인한다. 문서 해석은 개인 변환기가 맡는다.
        "ppt": header.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"),
        "png": header.startswith(b"\x89PNG\r\n\x1a\n"),
        "jpg": header.startswith(b"\xff\xd8\xff"),
        "jpeg": header.startswith(b"\xff\xd8\xff"),
        "gif": header.startswith((b"GIF87a", b"GIF89a")),
        "webp": header[:4] == b"RIFF" and header[8:12] == b"WEBP" and header[12:16] in (b"VP8 ", b"VP8L", b"VP8X"),
        "bmp": header.startswith(b"BM"),
        "tif": header.startswith((b"II\x2a\x00", b"MM\x00\x2a")),
        "tiff": header.startswith((b"II\x2a\x00", b"MM\x00\x2a")),
    }
    if not signatures.get(format, False):
        raise UnsupportedSourceError("The binary file signature does not match its format.")
    if format in {"docx", "pptx"}:
        try:
            stream.seek(0)
            _ooxml(stream, format)
        except (BadZipFile, KeyError, ValueError, RuntimeError, NotImplementedError, EOFError, zlib.error, ET.ParseError):
            raise UnsupportedSourceError("The file does not contain supported " + format.upper() + " package markers.") from None
