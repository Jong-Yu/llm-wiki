"""채팅에 첨부한 파일을 개인 PC에서 AI 입력용 글자로 읽는다.

서버·위키에 저장하지 않고, 등록용 변환(원본 판본·보고 계약)과도 무관하다. 문서·PDF·그림은 기존 변환기를 재사용하고
표(XLSX)는 사람이 읽는 줄 단위 글로 만든다. 읽지 못한 부분은 notes의 고정 코드로 알린다.
"""

from datetime import date, datetime
from pathlib import Path

MAX_FILE_BYTES = 20 * 1024 * 1024
IMAGE_FORMATS = {"png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"}
FORMATS = {"docx", "xlsx", "pdf", "md", "txt"} | IMAGE_FORMATS


class AttachmentError(Exception):
    """원문 오류 대신 고정 코드만 호출자에게 전달한다."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _cell(value):
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _xlsx_text(path, limit):
    """시트마다 제목과 줄 단위 값을 만든다. 수식은 저장된 계산 결과만 읽고 다시 계산하지 않는다."""
    from openpyxl import load_workbook
    workbook = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    parts, size, notes = [], 0, set()
    try:
        for sheet in workbook.worksheets:
            parts.append("## 시트: " + sheet.title)
            for row in sheet.iter_rows(values_only=True):
                cells = [_cell(value) for value in row]
                while cells and cells[-1] == "":
                    cells.pop()
                if not cells:
                    continue
                line = "\t".join(cells)
                parts.append(line)
                size += len(line) + 1
                if size > limit:
                    # 한도를 넘는 것이 확인되면 더 읽지 않는다. 전체 길이는 알 수 없으므로 호출자가 일부로 표시한다.
                    notes.add("rows_stopped_at_limit")
                    return "\n".join(parts), notes
    finally:
        workbook.close()
    return "\n".join(parts), notes


def _docx_text(units):
    """본문 순서를 지키며 표 셀은 같은 행끼리 " | "로 이어 한 줄로 만든다."""
    lines, row, row_key = [], [], None
    def flush():
        nonlocal row, row_key
        if row:
            lines.append(" | ".join(row))
        row, row_key = [], None
    for unit in units:
        location = unit["location"]
        text = unit["content"]
        if location["kind"] == "table_cells":
            key = (location["table"], location["row"])
            if key != row_key:
                flush()
                row_key = key
            row.append(text.replace("\n", " "))
        else:
            flush()
            lines.append(text)
    flush()
    return "\n".join(lines)


def _converted_text(path, fmt, ocr, language):
    from core.client.source_conversion_formats import convert_file
    result = convert_file(path, fmt, ocr=ocr, language=language)
    units = result["units"]
    if fmt == "docx":
        text = _docx_text(units)
    elif fmt == "pdf":
        text = "\n\n".join(f"[쪽 {unit['location']['start']}]\n{unit['content']}" for unit in units if unit["content"].strip())
    else:
        text = "\n\n".join(unit["content"] for unit in units if unit["content"].strip())
    # 읽지 못한 범위는 "위치: 코드" 모양이다. 위치(원문 내용 일부일 수 있음)는 버리고 코드만 전달한다.
    codes = {str(item).rsplit(": ", 1)[-1][:120] for item in result.get("unread_ranges", [])}
    # 변환 자체가 실패한 파일(깨진 문서)은 "글자 없음"이 아니라 "읽을 수 없음"으로 구분한다.
    if not text.strip() and "parser_failed" in codes:
        raise AttachmentError("file_unreadable")
    return text, codes


def read_attachment(path, extension, *, limit, ocr="auto", language="kor+eng"):
    """첨부 파일에서 글자를 읽어 {text, total_chars, truncated, notes}로 돌려준다."""
    fmt = extension.lower().lstrip(".")
    if fmt not in FORMATS:
        raise AttachmentError("unsupported_format")
    path = Path(path)
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            raise AttachmentError("file_too_large")
        if fmt in {"md", "txt"}:
            text, notes = path.read_bytes().decode("utf-8", errors="replace").lstrip("﻿"), set()
        elif fmt == "xlsx":
            text, notes = _xlsx_text(path, limit)
        else:
            text, notes = _converted_text(path, "jpeg" if fmt == "jpg" else fmt, ocr, language)
    except AttachmentError:
        raise
    except Exception as error:
        raise AttachmentError("file_unreadable") from error
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise AttachmentError("no_text_found")
    cut = len(text) > limit
    return {"text": text[:limit], "total_chars": len(text), "truncated": cut or "rows_stopped_at_limit" in notes,
            "notes": sorted(notes)}
