"""개인 PC의 문자 변환. 원본을 수정하지 않고 실제 읽은 위치와 미독을 기록한다.

라이브러리는 해당 형식을 실행할 때만 import한다. 도구 부재·부분 실패도 결과이며,
문자 추출 성공을 원본 전체 또는 의미 정확성의 검증으로 표시하지 않는다.
"""

from importlib import metadata, util
from io import BytesIO
from pathlib import Path
import csv
import math
import re
import shutil
import subprocess
import tempfile
import time
from zipfile import ZipFile

MAX_TEXT = 4 * 1024 * 1024
MAX_UNITS = 1000
MAX_PAGES = 500
MAX_PIXELS = 40_000_000
PDF_OCR_DPI = 300
PACKAGES = {"pypdf": "pypdf", "pypdfium2": "pypdfium2", "openpyxl": "openpyxl",
            "python-docx": "docx", "Pillow": "PIL"}


def ocr_diagnostics(language="eng"):
    """실행파일과 요청한 언어를 분리해 진단한다. 원문이나 오류 원문은 출력하지 않는다."""
    executable = shutil.which("tesseract")
    value = {"available": bool(executable), "executable": executable, "version": None,
             "languages": [], "requested_languages": [], "missing_languages": [],
             "ready": False, "status": "executable_missing",
             "install": "Install Tesseract OCR and the requested language data; put tesseract on PATH.",
             "language_note": "--ocr-language eng; use kor+eng only when both language packs are installed. "
                              "TESSDATA_PREFIX selects the data directory. Readiness checks listed files, not OCR accuracy."}
    if not isinstance(language, str) or re.fullmatch(r"[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*", language) is None:
        value["status"] = "invalid_ocr_language"
        return value
    value["requested_languages"] = list(dict.fromkeys(language.split("+")))
    if not executable:
        return value
    try:
        version = subprocess.run([executable, "--version"], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=5, check=False, encoding="utf-8", errors="replace")
        match = re.search(r"^tesseract ([A-Za-z0-9.+_-]{1,80})", version.stdout)
        if version.returncode or not match:
            value["status"] = "probe_failed"
            return value
        value["version"] = match.group(1)
        languages = subprocess.run([executable, "--list-langs"], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=5, check=False, encoding="utf-8", errors="replace")
        if languages.returncode:
            value["status"] = "probe_failed"
            return value
        value["languages"] = sorted(set(line.strip() for line in languages.stdout.splitlines()
            if re.fullmatch(r"[A-Za-z0-9_/]+", line.strip())))[:1000]
        value["missing_languages"] = [name for name in value["requested_languages"] if name not in value["languages"]]
        value["ready"] = not value["missing_languages"]
        value["status"] = "ready" if value["ready"] else "language_missing"
    except subprocess.TimeoutExpired:
        value["status"] = "probe_timeout"
    except OSError:
        value["status"] = "probe_failed"
    return value


def diagnostics(language="eng"):
    """설치 여부를 조회할 뿐 설치하거나 로그인/정책을 바꾸지 않는다."""
    packages = {}
    for distribution, module in PACKAGES.items():
        try:
            version = metadata.version(distribution) if util.find_spec(module) else None
        except (ImportError, metadata.PackageNotFoundError):
            version = None
        packages[distribution] = {"available": version is not None, "version": version,
                                  "install": f"Install the personal runtime dependency: {distribution}"}
    return {"packages": packages, "tesseract": ocr_diagnostics(language)}


def location(kind, **kwargs):
    return {"kind": kind, **kwargs}


class Conversion:
    def __init__(self, format, checkpoint=None):
        self.result = {"format": format, "method": {"pdf": "pdf_text", "xlsx": "xlsx_values",
            "docx": "docx_text", "txt": "verbatim", "md": "verbatim"}.get(format, "ocr"),
            "units": [], "complete": False, "unread_ranges": [], "warnings": [],
            "diagnostics": [], "unit_methods": {}, "origin": "client_reported",
            "coverage": "reported_units_only", "original_coverage": "not_verified",
            "semantic_validation": "not_run", "state": "running"}
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


class OutputLimit(Exception):
    pass


class DependencyMissing(Exception):
    def __init__(self, name):
        self.name = name


class OcrFailure(Exception):
    """외부 OCR의 알려진 실패 종류만 보고에 노출한다."""


def require(module, package=None):
    if util.find_spec(module) is None:
        raise DependencyMissing(package or module)


def check_archive(path):
    """압축 해제 전에 총 크기/항목 수를 제한한다. 원본 ZIP은 수정하지 않는다."""
    with ZipFile(path) as archive:
        info = archive.infolist()
        if len(info) > 10000 or sum(item.file_size for item in info) > 128 * 1024 * 1024:
            raise OutputLimit()


def _ocr_attempt(image, engine, language, directory, deadline, *, psm=3):
    """문자는 txt 그대로 보존하고 TSV는 신뢰도 진단에만 사용한다."""
    input_path, output = Path(directory) / "input.png", Path(directory) / "output"
    image.save(input_path)
    for suffix in (".txt", ".tsv"):
        output.with_suffix(suffix).unlink(missing_ok=True)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise OcrFailure("ocr_timeout")
    try:
        run = subprocess.run([engine["executable"], str(input_path), str(output), "-l", language,
                              "--psm", str(psm), "txt", "tsv"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=remaining, check=False)
    except subprocess.TimeoutExpired:
        raise OcrFailure("ocr_timeout") from None
    if run.returncode:
        raise OcrFailure("ocr_engine_failed")
    if b"Failed loading language" in (run.stderr or b""):
        raise OcrFailure("ocr_language_load_failed")
    with output.with_suffix(".txt").open("rb") as stream:
        raw = stream.read(MAX_TEXT + 1)
    if len(raw) > MAX_TEXT:
        raise OutputLimit()
    text = raw.decode("utf-8")
    score, count, weak = None, 0, 0
    try:
        with output.with_suffix(".tsv").open("rb") as stream:
            raw = stream.read(MAX_TEXT * 4 + 1)
        if len(raw) > MAX_TEXT * 4:
            raise OutputLimit()
        weighted = 0.0
        for row in csv.DictReader(raw.decode("utf-8").splitlines(), delimiter="\t", quoting=csv.QUOTE_NONE):
            if row["level"] != "5" or not row["text"].strip():
                continue
            confidence = float(row["conf"])
            if not math.isfinite(confidence) or not 0 <= confidence <= 100:
                raise ValueError()
            size = len(row["text"].strip())
            weighted += confidence * size
            count += size
            weak += size if confidence < 60 else 0
        score = weighted / count if count else None
    except (OSError, ValueError, KeyError, TypeError, csv.Error):
        score, count, weak = None, 0, 0
    return text, score, count, weak, psm


def _ocr_fragmented_retry(value, image, engine, language, directory, deadline, note):
    # 한국어 가로 문장이 짧은 세로 조각으로 잘못 분할되는 경우만 단일 블록을 비교한다.
    # 표/다단 문서의 읽기 순서를 복원하는 알고리즘은 아니다.
    lines = [line.strip() for line in value[0].splitlines() if line.strip()]
    if len(lines) < 6 or sum(len(line) <= 3 for line in lines) < len(lines) * .4:
        return value
    try:
        candidate = _ocr_attempt(image, engine, language, directory, deadline, psm=6)
        if (candidate[1] is not None and candidate[1] >= 70 and candidate[2] >= max(12, value[2] * .8)
                and (value[1] is None or candidate[1] >= value[1] + 5)):
            note("ocr_single_block_candidate_preferred_reading_order_not_verified", unread=False)
            return candidate
    except (OcrFailure, OutputLimit, OSError, UnicodeError):
        note("ocr_segmentation_retry_failed_original_ocr_retained", unread=False)
    note("ocr_fragmented_layout_manual_review_required", unread=False)
    return value


def _ocr_orientation(image, engine, directory, deadline):
    """OSD의 시계방향 보정 제안만 반환한다. script로 요청 언어를 바꾸지 않는다."""
    if "osd" not in engine.get("languages", []):
        return None, None
    remaining = min(5, deadline - time.monotonic())
    if remaining <= 0:
        return None, None
    path = Path(directory) / "orientation.png"
    image.save(path)
    try:
        run = subprocess.run([engine["executable"], str(path), "stdout", "--psm", "0"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=remaining, check=False,
            encoding="utf-8", errors="replace")
        rotation = re.search(r"^Rotate: (0|90|180|270)$", run.stdout, re.M)
        confidence = re.search(r"^Orientation confidence: ([0-9]+(?:\.[0-9]+)?)$", run.stdout, re.M)
        if run.returncode == 0 and rotation and confidence:
            value = float(confidence.group(1))
            if math.isfinite(value):
                return int(rotation.group(1)), value
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None, None


def ocr_image(image, language, *, note=None):
    note = note or (lambda code, **kwargs: None)
    engine = ocr_diagnostics(language)
    if engine["status"] == "invalid_ocr_language":
        raise OcrFailure("invalid_ocr_language")
    if not engine["available"]:
        raise DependencyMissing("tesseract_and_language_data")
    if engine["missing_languages"]:
        # Tesseract은 kor가 없어도 eng만으로 성공 종료할 수 있다. 요청 일부의 묵시적 대체를 막는다.
        raise DependencyMissing("tesseract_languages:" + "+".join(engine["missing_languages"]))
    if not engine["ready"]:
        raise OcrFailure("ocr_" + engine["status"])
    if image.width * image.height > MAX_PIXELS:
        raise OutputLimit()
    # 셸 없이 실행한다. 부모 worker의 프로세스 그룹에 속해 취소 시 함께 종료된다.
    with tempfile.TemporaryDirectory(prefix="wiki-ocr-") as directory:
        from PIL import Image, ImageOps
        # 카메라의 방향 메타데이터를 적용하고 투명 영역은 종이색으로 합성한다.
        exif = image.getexif().get(274, 1)
        oriented = ImageOps.exif_transpose(image).convert("RGBA")
        background = Image.new("RGBA", oriented.size, "white")
        normalized = Image.alpha_composite(background, oriented).convert("RGB")
        deadline = time.monotonic() + 40
        selected = baseline = _ocr_attempt(normalized, engine, language, directory, deadline)
        rotation, confidence = _ocr_orientation(normalized, engine, directory, deadline)
        applied, candidate_score = 0, None
        if rotation:
            try:
                rotated = normalized.rotate(-rotation, expand=True)
                candidate = _ocr_attempt(rotated, engine, language, directory, deadline)
                candidate = _ocr_fragmented_retry(candidate, rotated, engine, language, directory, deadline, note)
                candidate_score = candidate[1]
                # 낮은 OSD라도 문자 신뢰도의 충분한 개선으로 뒷받침될 때만 보정한다.
                # 높은 신뢰도 역시 정확도 보증이 아니며 txt를 추측 교정하지 않는다.
                if (candidate_score is not None and candidate_score >= 70 and candidate[2] >= max(12, baseline[2] * .8)
                        and (baseline[1] is None or candidate_score >= baseline[1] + 5
                             or (confidence >= 15 and candidate_score >= baseline[1] - 2))):
                    selected, applied = candidate, rotation
                else:
                    note("ocr_orientation_candidate_rejected_manual_review_required", unread=False)
            except (OcrFailure, OutputLimit, OSError, UnicodeError):
                note("ocr_orientation_candidate_failed_original_ocr_retained", unread=False)
        else:
            selected = _ocr_fragmented_retry(baseline, normalized, engine, language, directory, deadline, note)
        if confidence is None or confidence < 15 or rotation != applied:
            note("ocr_orientation_uncertain_manual_review_required", unread=False)
        text, score, count, weak, psm = selected
        if text.strip() and (score is None or score < 60 or weak > count * .3):
            note("ocr_low_or_missing_confidence_text_retained_manual_review_required", unread=True)
        note(f"ocr_exif={exif if exif in range(1, 9) else 'unknown'};osd_clockwise={rotation};"
             f"osd_confidence={confidence};applied_clockwise={applied};psm={psm};"
             f"mean_word_confidence={None if score is None else round(score, 2)};"
             f"baseline_confidence={None if baseline[1] is None else round(baseline[1], 2)};"
             f"candidate_confidence={None if candidate_score is None else round(candidate_score, 2)};"
             "confidence_is_not_accuracy", unread=False)
        return text


def pdf(path, result, ocr, language):
    require("pypdf")
    from pypdf import PdfReader
    reader = PdfReader(path)
    if reader.is_encrypted:
        result.note("encrypted_pdf_not_read", "whole source")
        return
    count = len(reader.pages)
    result.result["total_units"] = count
    for index in range(min(count, MAX_PAGES)):
        page = reader.pages[index]
        scope = f"page {index + 1}"
        text, method = "", "pdf_text"
        try:
            text = page.extract_text() or ""
            images = bool(page.get("/Resources", {}).get("/XObject"))
            needs_ocr = not text.strip() or images
            if ocr == "always" or (ocr == "auto" and needs_ocr):
                require("pypdfium2")
                require("PIL", "Pillow")
                import pypdfium2
                with pypdfium2.PdfDocument(str(path)) as document:
                    rendered = document[index]
                    try:
                        width, height = rendered.get_size()
                        if width * height * 4 > MAX_PIXELS:
                            raise OutputLimit()
                        # 300 dpi 목표. 기존 144 dpi에서도 상한을 넘는 페이지는 계속 거부한다.
                        scale = min(PDF_OCR_DPI / 72, math.sqrt(MAX_PIXELS / (width * height)))
                        while math.ceil(width * scale) * math.ceil(height * scale) > MAX_PIXELS:
                            scale *= .999
                        result.ocr_note(scope, f"pdf_rotation_metadata={page.rotation};render_applies_metadata;"
                                        f"ocr_render_scale={scale:.4f};target_dpi={PDF_OCR_DPI}")
                        bitmap = rendered.render(scale=scale)
                        try:
                            converted = ocr_image(bitmap.to_pil(), language,
                                note=lambda code, **kwargs: result.ocr_note(scope, code, **kwargs))
                        finally:
                            bitmap.close()
                    finally:
                        rendered.close()
                if converted.strip():
                    text, method = converted, "ocr"
                    result.result["method"] = "ocr"
                else:
                    result.note("ocr_no_text_detected_manual_review_required", scope)
            elif needs_ocr:
                result.note("ocr_required_but_disabled", scope)
        except DependencyMissing as error:
            result.note("dependency_missing:" + error.name, scope)
        except OcrFailure as error:
            result.note(str(error), scope)
        except OutputLimit:
            result.note("page_render_or_text_limit", scope)
        except Exception:
            result.note("pdf_page_or_ocr_failed", scope)
        if not text.strip():
            result.note("no_text_detected_manual_review_required", scope)
        result.add(f"page-{index + 1}", location("pages", start=index + 1, end=index + 1), text, method)
    if count > MAX_PAGES:
        result.note("page_limit", f"pages {MAX_PAGES + 1}-{count}")
    result.note("layout_annotations_images_and_reading_order_not_verified", "PDF", unread=False)


def cell_text(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def xlsx(path, result):
    require("openpyxl")
    check_archive(path)
    from openpyxl import load_workbook
    # 서버의 검증된 작업 사본 이름은 확장자 없는 original이다. 바이트로 연다.
    raw = Path(path).read_bytes()
    formulas = load_workbook(BytesIO(raw), read_only=True, data_only=False, keep_links=False)
    values = load_workbook(BytesIO(raw), read_only=True, data_only=True, keep_links=False)
    try:
        for sheet_index, sheet in enumerate(formulas, 1):
            if len(sheet.title) > 200 or (sheet.max_row or 0) * (sheet.max_column or 0) > 1_000_000:
                result.note("worksheet_dimension_limit", f"sheet {sheet_index}")
                continue
            cached_rows = values[sheet.title].iter_rows()
            for row, cached_row in zip(sheet.iter_rows(), cached_rows):
                for cell, cached in zip(row, cached_row):
                    if cell.value is None:
                        continue
                    text = cell_text(cell.value)
                    if cell.data_type == "f":
                        text = "formula: " + text + "\ncached_value: " + (cell_text(cached.value) if cached.value is not None else "[unavailable]")
                        if cached.value is None:
                            result.note("formula_cached_value_unavailable", f"{sheet.title}!{cell.coordinate}")
                    result.add(f"sheet-{sheet_index}-{cell.coordinate}",
                        location("cells", sheet=sheet.title, cells=cell.coordinate), text, "xlsx_values")
        with ZipFile(path) as archive:
            if any(name.startswith(("xl/drawings/", "xl/charts/", "xl/media/", "xl/embeddings/", "xl/externalLinks/")) for name in archive.namelist()):
                result.note("embedded_images_charts_drawings_not_read", "workbook")
    finally:
        formulas.close()
        values.close()
    result.note("raw_values_and_formulas_only_no_recalculation_or_visual_layout", "workbook", unread=False)


def docx(path, result):
    require("docx", "python-docx")
    check_archive(path)
    from docx import Document
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    document = Document(path)
    paragraph_index, table_index = 0, 0
    for block in document.element.body.iterchildren():
        if block.tag == qn("w:p"):
            paragraph_index += 1
            paragraph = Paragraph(block, document)
            result.add(f"paragraph-{paragraph_index}", location("paragraphs", start=paragraph_index, end=paragraph_index),
                       paragraph.text, "docx_text")
        elif block.tag == qn("w:tbl"):
            table_index += 1
            table = Table(block, document)
            seen = set()
            for row_index, row in enumerate(table.rows, 1):
                for column_index, cell in enumerate(row.cells, row.grid_cols_before + 1):
                    if cell._tc in seen:
                        continue
                    seen.add(cell._tc)
                    result.add(f"table-{table_index}-{row_index}-{column_index}",
                        location("table_cells", table=table_index, row=row_index, column=column_index), cell.text, "docx_text")
                    if cell.tables:
                        result.note("nested_table_not_read", f"table {table_index} row {row_index} column {column_index}")
        elif block.tag != qn("w:sectPr"):
            result.note("unsupported_body_block", "DOCX body")
    with ZipFile(path) as archive:
        if any(re.match(r"word/(header\d|footer\d|footnotes|endnotes|comments|media/|embeddings/)", name) for name in archive.namelist()):
            result.note("headers_footers_notes_images_or_embedded_objects_not_read", "DOCX package")
    if document.element.xpath(".//w:txbxContent | .//w:del | .//w:ins | .//w:sym | .//w:altChunk"):
        result.note("textboxes_revision_markup_symbols_or_external_content_not_read", "DOCX body")
    result.note("body_order_and_table_coordinates_only_no_physical_page_mapping", "DOCX", unread=False)


def image(path, result, ocr, language):
    require("PIL", "Pillow")
    from PIL import Image
    if ocr == "never":
        result.note("ocr_required_but_disabled", "whole image")
        return
    with Image.open(path) as source:
        count = getattr(source, "n_frames", 1)
        result.result["total_units"] = count
        for index in range(min(count, MAX_PAGES)):
            text = ""
            try:
                source.seek(index)
                text = ocr_image(source, language,
                    note=lambda code, **kwargs: result.ocr_note(f"frame {index + 1}", code, **kwargs))
                if not text.strip():
                    result.note("ocr_no_text_detected_manual_review_required", f"frame {index + 1}")
            except DependencyMissing as error:
                result.note("dependency_missing:" + error.name, f"frame {index + 1}")
            except OcrFailure as error:
                result.note(str(error), f"frame {index + 1}")
            except Exception:
                result.note("image_ocr_failed_or_limit", f"frame {index + 1}")
            result.add(f"frame-{index + 1}", location("pages", start=index + 1, end=index + 1), text, "ocr")
        if count > MAX_PAGES:
            result.note("frame_limit", f"frames {MAX_PAGES + 1}-{count}")


def convert_file(path, format, *, ocr="auto", language="eng", checkpoint=None):
    """검증한 원본 사본을 읽으며 단위마다 부분 결과를 알린다."""
    result = Conversion(format, checkpoint)
    installed = diagnostics(language)
    versions = {name: value["version"] for name, value in installed["packages"].items() if value["available"]}
    result.result["execution"] = {"adapter": "llm-wiki-source-conversion-v1", "packages": versions,
                                  "ocr": ocr, "ocr_language": language, "pdf_render_scale": PDF_OCR_DPI / 72,
                                  "pdf_ocr_target_dpi": PDF_OCR_DPI,
                                  "tesseract_version": installed["tesseract"]["version"]}
    result.note("adapter=llm-wiki-source-conversion-v1", "tools", unread=False)
    for name, version in versions.items():
        result.note(f"{name}={version}", "tools", unread=False)
    result.note(f"ocr={ocr};language={language};pdf_ocr_target_dpi={PDF_OCR_DPI};ocr_psm=3", "settings", unread=False)
    if installed["tesseract"]["version"]:
        result.note("tesseract=" + installed["tesseract"]["version"], "tools", unread=False)
    try:
        if format == "pdf":
            pdf(path, result, ocr, language)
        elif format == "xlsx":
            xlsx(path, result)
        elif format == "docx":
            docx(path, result)
        elif format in {"png", "jpeg", "jpg", "tiff", "tif", "webp", "bmp", "gif"}:
            image(path, result, ocr, language)
        elif format in {"md", "txt"}:
            raw = Path(path).read_bytes()
            if len(raw) > MAX_TEXT:
                raise OutputLimit()
            result.add("whole", location("whole"), raw.decode("utf-8"), "verbatim")
        else:
            result.note("unsupported_format", "whole source")
    except DependencyMissing as error:
        result.note("dependency_missing:" + error.name, "remaining source")
    except OutputLimit:
        result.note("conversion_output_or_archive_limit", "remaining source")
    except Exception:
        result.note("parser_failed", "remaining source")
    if "ocr" in result.result["unit_methods"].values():
        result.note("ocr_characters_reading_order_and_orientation_not_verified_no_character_boxes", "OCR", unread=False)
    return result.finish()
