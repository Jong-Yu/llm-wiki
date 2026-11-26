"""개인 PC의 문자 변환. 원본을 수정하지 않고 실제 읽은 위치와 미독을 기록한다.

라이브러리는 해당 형식을 실행할 때만 import한다. 도구 부재·부분 실패도 결과이며,
문자 추출 성공을 원본 전체 또는 의미 정확성의 검증으로 표시하지 않는다.
"""

from hashlib import sha256
from importlib import metadata, util
from io import BytesIO
from pathlib import Path
import csv
import json
import math
import re
import shutil
import subprocess
import tempfile
import time
import unicodedata
from zipfile import ZipFile
from xml.etree import ElementTree

from core.runtime.client_process import no_window_options

from . import source_conversion_xlsx as xlsx_view
from . import source_conversion_presentation as presentation_view
from . import source_conversion_relations as relations_view
from .source_conversion_report import Conversion, OutputLimit, MAX_TEXT, MAX_UNITS

MAX_PAGES = 500
MAX_PIXELS = 40_000_000
PDF_OCR_DPI = 300
# 내장 문자 판독 신호(D-157). 대체·사용자 정의·제어 문자가 이 비율 이상이거나,
# 글자·숫자가 이 비율 미만이면 깨진 내장 문자로 보고 OCR한다.
PDF_TEXT_MAX_ODD = .3
PDF_TEXT_MIN_ALNUM = .3
# 정상 내장 문자가 있는 쪽은 그림 영역만 따로 읽어 덧붙인다(D-159). 쪽 면적의 이 비율보다 작은
# 그림(로고·아이콘)은 읽지 않고, 읽은 결과도 글자 수·신뢰도가 기준 미만이면 배경 잡음으로 버린다.
PDF_IMAGE_OCR_MIN_FRACTION = .01
PDF_IMAGE_OCR_MAX_PER_PAGE = 12
PDF_IMAGE_TEXT_MIN_CHARS = 8
PDF_IMAGE_TEXT_MIN_CONFIDENCE = 50
LOW_CONFIDENCE = "ocr_low_or_missing_confidence_text_retained_manual_review_required"
# kor+eng 읽기에서 한국어 단어가 영문 조각("결함을"→"SHS")으로 읽힌 경우만 그 단어를 kor로 다시 읽는다(D-161).
HANGUL = re.compile("[가-힣]")
LATIN_FRAGMENT = re.compile("^[A-Za-z]{2,}[^가-힣]*$")
REREAD_MAX_SOURCE_CONFIDENCE = 80
REREAD_MIN_CONFIDENCE = 70
REREAD_MIN_HANGUL_SHARE = .6
REREAD_MAX_WORDS = 60
PACKAGES ={"pypdf": "pypdf", "pypdfium2": "pypdfium2", "openpyxl": "openpyxl",
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
            stderr=subprocess.DEVNULL, timeout=5, check=False, encoding="utf-8", errors="replace",
            **no_window_options())
        match = re.search(r"^tesseract ([A-Za-z0-9.+_-]{1,80})", version.stdout)
        if version.returncode or not match:
            value["status"] = "probe_failed"
            return value
        value["version"] = match.group(1)
        languages = subprocess.run([executable, "--list-langs"], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=5, check=False, encoding="utf-8", errors="replace",
            **no_window_options())
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
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=remaining, check=False,
            **no_window_options())
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
    score, count, weak, words = None, 0, 0, []
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
            words.append({"text": row["text"].strip(), "confidence": confidence,
                          "line": (row["block_num"], row["par_num"], row["line_num"]),
                          "box": tuple(int(row[key]) for key in ("left", "top", "width", "height"))})
        score = weighted / count if count else None
    except (OSError, ValueError, KeyError, TypeError, csv.Error):
        score, count, weak, words = None, 0, 0, []
    attempt = _Attempt((text, score, count, weak, psm))
    attempt.words = words
    return attempt


class _Attempt(tuple):
    """(문자, 평균 신뢰도, 글자 수, 약한 글자 수, psm). words는 TSV 단어의 문자·신뢰도·줄·위치다."""
    words = ()


def _reread_hangul_words(attempt, image, engine, language, directory, deadline):
    """한국어 줄 안의 영문 조각 단어만 kor 단독으로 다시 읽어 바꾼 문자와 바꾼 단어 수를 돌려준다(D-161).

    kor+eng 읽기는 한국어 단어를 "SHS"·"BAS" 같은 영문 조각으로 읽는 경우가 있다. 사전이나 추측으로 고치지 않고,
    그 단어 위치의 그림만 다시 읽는다. 다시 읽은 결과가 대부분 한글이고 신뢰도가 70 이상이며 원래보다 높을 때만
    바꾼다. txt 줄과 TSV 줄이 어긋나면 그 줄부터는 바꾸지 않는다.
    """
    text = attempt[0]
    parts = language.split("+")
    if "kor" not in parts or len(parts) < 2 or not getattr(attempt, "words", ()):
        return text, 0
    lines = {}
    for word in attempt.words:
        lines.setdefault(word["line"], []).append(word)
    replacements = {}
    for words in lines.values():
        if not any(HANGUL.search(word["text"]) for word in words):
            continue
        for word in words:
            if len(replacements) >= REREAD_MAX_WORDS or deadline - time.monotonic() < 1:
                break
            if not LATIN_FRAGMENT.match(word["text"]) or word["confidence"] >= REREAD_MAX_SOURCE_CONFIDENCE:
                continue
            left, top, width, height = word["box"]
            pad = max(4, height // 4)
            crop = image.crop((max(0, left - pad), max(0, top - pad), min(image.width, left + width + pad),
                               min(image.height, top + height + pad)))
            try:
                candidate = _ocr_attempt(crop, engine, "kor", directory, deadline, psm=7)
            except (OcrFailure, OutputLimit, OSError, UnicodeError):
                break
            found = "".join(item["text"] for item in getattr(candidate, "words", ()))
            confidence = min((item["confidence"] for item in getattr(candidate, "words", ())), default=0)
            if (found and len(HANGUL.findall(found)) >= len(found) * REREAD_MIN_HANGUL_SHARE
                    and confidence >= max(REREAD_MIN_CONFIDENCE, word["confidence"])):
                replacements[id(word)] = found
    if not replacements:
        return text, 0
    output, order, changed = text.split("\n"), list(lines.values()), 0
    cursor = 0
    for index, line in enumerate(output):
        # 한국어는 TSV가 글자 단위로 나누고 txt는 붙여 쓰는 경우가 있어, 공백을 뺀 글자 순서로 줄을 맞춘다.
        positions = [offset for offset, char in enumerate(line) if not char.isspace()]
        if not positions:
            continue
        if cursor >= len(order) or "".join(line[offset] for offset in positions) != "".join(
                word["text"] for word in order[cursor]):
            break
        spans, start = [], 0
        for word in order[cursor]:
            spans.append((positions[start], positions[start + len(word["text"]) - 1] + 1, word))
            start += len(word["text"])
        for begin, end, word in reversed(spans):
            if id(word) in replacements:
                line = line[:begin] + replacements[id(word)] + line[end:]
                changed += 1
        output[index] = line
        cursor += 1
    return "\n".join(output), changed


def _ocr_fragmented_retry(value, image, engine, language, directory, deadline, note):
    # 한국어 가로 문장이 짧은 세로 조각으로 잘못 분할되는 경우만 단일 블록을 비교한다.
    # 표/다단 문서의 읽기 순서를 복원하는 알고리즘은 아니다.
    lines = [line.strip() for line in value[0].splitlines() if line.strip()]
    # 잘못 나뉜 세로 조각 사이의 정렬 공백을 글자로 세면 가로 문장으로 오인한다.
    if len(lines) < 6 or sum(len("".join(line.split())) <= 3 for line in lines) < len(lines) * .4:
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
            encoding="utf-8", errors="replace", **no_window_options())
        rotation = re.search(r"^Rotate: (0|90|180|270)$", run.stdout, re.M)
        confidence = re.search(r"^Orientation confidence: ([0-9]+(?:\.[0-9]+)?)$", run.stdout, re.M)
        if run.returncode == 0 and rotation and confidence:
            value = float(confidence.group(1))
            if math.isfinite(value):
                return int(rotation.group(1)), value
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None, None


def ocr_engine(language):
    """OCR 실행 전 엔진·요청 언어를 확인한다. 준비되지 않으면 알려진 실패로 멈춘다."""
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
    return engine


def _white_background(image):
    from PIL import Image
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    return Image.alpha_composite(background, rgba).convert("RGB")


def ocr_region_text(image, engine, language):
    """그림 한 장의 문자를 읽는다(D-159). 신뢰도·글자 수가 기준 미만인 잡음은 None으로 버린다.

    방향 보정은 하지 않는다. 화면 캡처·도식 그림은 바로 선 것으로 보고, 문자를 사전·추측으로 교정하지 않는다.
    한국어 줄 속 영문 조각 단어만 그 위치를 kor로 다시 읽는다(D-161).
    """
    if image.width * image.height > MAX_PIXELS:
        raise OutputLimit()
    if image.width < 16 or image.height < 8:
        return None
    normalized = _white_background(image)
    warnings = []
    with tempfile.TemporaryDirectory(prefix="wiki-ocr-") as directory:
        deadline = time.monotonic() + 40
        best = _ocr_attempt(normalized, engine, language, directory, deadline)
        if best[2] < PDF_IMAGE_TEXT_MIN_CHARS or best[1] is None or best[1] < PDF_IMAGE_TEXT_MIN_CONFIDENCE:
            # 테두리 상자 안 문자처럼 자동 단락 나누기가 놓친 경우만 한 덩어리로 다시 읽는다.
            candidate = _ocr_attempt(normalized, engine, language, directory, deadline, psm=6)
            if candidate[1] is not None and (best[1] is None or candidate[1] > best[1]):
                best = candidate
        # 그림 안 가로 문장을 세로 조각으로 읽은 경우에도 전체 쪽과 같은 재시도 기준을 쓴다.
        # 정상·고신뢰 결과는 건드리지 않으며, 재시도 실패/내용 급감 때는 첫 결과를 보존한다.
        elif best[4] == 3 and (best[1] is None or best[1] < 60 or best[3] > best[2] * .3):
            best = _ocr_fragmented_retry(best, normalized, engine, language, directory, deadline,
                                        lambda code, **kwargs: warnings.append(code))
        text, score, count, weak, psm = best
        if not text.strip() or count < PDF_IMAGE_TEXT_MIN_CHARS or score is None or score < PDF_IMAGE_TEXT_MIN_CONFIDENCE:
            return None
        text, reread = _reread_hangul_words(best, normalized, engine, language, directory, deadline)
    return {"text": text.strip(), "score": score, "count": count, "weak": weak, "psm": psm,
            "low_confidence": score < 60 or weak > count * .3, "reread_words": reread,
            "warnings": warnings}


def ocr_image(image, language, *, note=None):
    note = note or (lambda code, **kwargs: None)
    engine = ocr_engine(language)
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
        selected_image = normalized
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
                    selected, applied, selected_image = candidate, rotation, rotated
                else:
                    note("ocr_orientation_candidate_rejected_manual_review_required", unread=False)
            except (OcrFailure, OutputLimit, OSError, UnicodeError):
                note("ocr_orientation_candidate_failed_original_ocr_retained", unread=False)
        else:
            selected = _ocr_fragmented_retry(baseline, normalized, engine, language, directory, deadline, note)
        if confidence is None or confidence < 15 or rotation != applied:
            note("ocr_orientation_uncertain_manual_review_required", unread=False)
        if not selected[0].strip():
            # 자동 단락 나누기(psm 3)가 테두리 상자 안 문자를 통째로 놓치는 경우가 있다(D-159).
            # 한 덩어리 읽기 결과는 충분한 신뢰도일 때만 쓴다.
            try:
                source = normalized.rotate(-applied, expand=True) if applied else normalized
                candidate = _ocr_attempt(source, engine, language, directory, deadline, psm=6)
                if candidate[1] is not None and candidate[1] >= 70 and candidate[2] >= 12:
                    note("ocr_single_block_used_after_empty_page_layout", unread=False)
                    selected, selected_image = candidate, source
            except (OcrFailure, OutputLimit, OSError, UnicodeError):
                note("ocr_single_block_retry_failed_empty_result_retained", unread=False)
        text, score, count, weak, psm = selected
        if text.strip():
            text, reread = _reread_hangul_words(selected, selected_image, engine, language, directory, deadline)
            if reread:
                note(f"ocr_hangul_words_reread_with_korean_model={reread}", unread=False)
        if text.strip() and (score is None or score < 60 or weak > count * .3):
            note("ocr_low_or_missing_confidence_text_retained_manual_review_required", unread=True)
        note(f"ocr_exif={exif if exif in range(1, 9) else 'unknown'};osd_clockwise={rotation};"
             f"osd_confidence={confidence};applied_clockwise={applied};psm={psm};"
             f"mean_word_confidence={None if score is None else round(score, 2)};"
             f"baseline_confidence={None if baseline[1] is None else round(baseline[1], 2)};"
             f"candidate_confidence={None if candidate_score is None else round(candidate_score, 2)};"
             "confidence_is_not_accuracy", unread=False)
        return text


def picture_reader(language):
    """슬라이드 그림 파일의 문자를 읽는 함수(D-159). 같은 그림은 한 번만 읽고, 실패는 알려진 코드로 돌려준다."""
    state = {"cache": {}}

    def read(raw):
        key = sha256(raw).hexdigest()
        if key in state["cache"]:
            return state["cache"][key]
        from PIL import Image
        try:
            with Image.open(BytesIO(raw)) as source:
                if source.width * source.height > MAX_PIXELS:
                    return {"failure": "picture_too_large_not_read"}
                picture = source.convert("RGBA")
        except (OSError, ValueError, Image.DecompressionBombError):
            # EMF·WMF·SVG 등 그림 형식을 읽지 못하면 미독으로 남긴다.
            return {"failure": "picture_format_not_read"}
        try:
            if "engine" not in state:
                state["engine"] = ocr_engine(language)
            found = ocr_region_text(picture, state["engine"], language)
        except DependencyMissing as error:
            return {"failure": "dependency_missing:" + error.name}
        except OcrFailure as error:
            return {"failure": str(error)}
        except OutputLimit:
            return {"failure": "picture_too_large_not_read"}
        state["cache"][key] = found
        return found
    return read


def pdf_text_problem(text):
    """내장 문자의 판독 불가 신호만 본다. 읽을 수 있다고 판정해도 정확도를 보증하지 않는다."""
    visible = [char for char in text if not char.isspace()]
    if not visible:
        return "pdf_text_empty"
    odd = sum(char == "\ufffd" or unicodedata.category(char) in ("Co", "Cc", "Cs", "Cn") for char in visible)
    if odd >= max(3, len(visible) * PDF_TEXT_MAX_ODD):
        return "pdf_text_replacement_private_or_control_characters"
    if len(visible) >= 10 and sum(char.isalnum() for char in visible) < len(visible) * PDF_TEXT_MIN_ALNUM:
        return "pdf_text_mostly_symbols"
    return None


def pdf_image_regions(document, index, minimum=PDF_IMAGE_OCR_MIN_FRACTION):
    """쪽 안 그림 객체(서식 묶음 안 포함)의 쪽 면적 비율과 위치. 쪽 밖으로 나간 부분은 뺀다.

    minimum 이상인 그림만 원본 해상도 그림을 꺼낸다. 위치는 쪽 왼쪽 위 기준 백분율이다.
    """
    import pypdfium2.raw as pdfium_c
    page = document[index]
    try:
        left, bottom, right, top = page.get_bbox()
        width, height = right - left, top - bottom
        if width <= 0 or height <= 0:
            raise ValueError("empty page box")
        regions = []
        for item in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,)):
            x0, y0, x1, y1 = item.get_bounds()
            shown_width = max(0.0, min(x1, right) - max(x0, left))
            shown_height = max(0.0, min(y1, top) - max(y0, bottom))
            region = {"fraction": shown_width * shown_height / (width * height),
                      "box": tuple(round(value * 100) for value in ((max(x0, left) - left) / width,
                          (top - min(y1, top)) / height, shown_width / width, shown_height / height))}
            if region["fraction"] >= minimum:
                # PDFium이 소유한 원본 그림 버퍼이므로 직접 닫지 않고 복사본만 쓴다.
                region["image"] = item.get_bitmap(render=False).to_pil().convert("RGBA")
            regions.append(region)
        return regions
    finally:
        page.close()


def pdf_image_fractions(document, index):
    return [region["fraction"] for region in pdf_image_regions(document, index, minimum=2)]


def pdf(path, result, ocr, language, *, selected_page=None):
    require("pypdf")
    from pypdf import PdfReader
    reader = PdfReader(path)
    state = {"cache": {}}

    def regions(index):
        require("pypdfium2")
        import pypdfium2
        if "document" not in state:
            state["document"] = pypdfium2.PdfDocument(str(path))
        return pdf_image_regions(state["document"], index)

    def read_region(image):
        # 같은 그림(장 구분 배경 등)은 문서 안에서 한 번만 읽는다.
        key = sha256(image.tobytes()).hexdigest() + f":{image.size}"
        if key not in state["cache"]:
            if "engine" not in state:
                state["engine"] = ocr_engine(language)
            state["cache"][key] = ocr_region_text(image, state["engine"], language)
        return state["cache"][key]
    def relations(index):
        require("pypdfium2")
        import pypdfium2
        if "document" not in state:
            state["document"] = pypdfium2.PdfDocument(str(path))
        return relations_view.pdf_page_relations(state["document"], index)
    try:
        _pdf_pages(path, reader, result, ocr, language, selected_page, regions, read_region, relations)
    finally:
        if "document" in state:
            state["document"].close()


def _pdf_pages(path, reader, result, ocr, language, selected_page, regions, read_region, relations):
    if reader.is_encrypted:
        result.note("encrypted_pdf_not_read", "whole source")
        return
    count = len(reader.pages)
    result.result["total_units"] = count
    if selected_page is not None:
        if not 1 <= selected_page <= count:
            result.note("selected_pdf_page_out_of_range", "PDF")
            return
        # 후보를 전체 문서 변환 완료로 오인하지 않도록 건드리지 않은 범위를 남긴다.
        result.note("selected_pdf_page_ocr_candidate", f"page {selected_page}", unread=False)
        if selected_page > 1:
            result.note("not_selected_for_page_ocr", f"pages 1-{selected_page - 1}")
        if selected_page < count:
            result.note("not_selected_for_page_ocr", f"pages {selected_page + 1}-{count}")
    indices = [selected_page - 1] if selected_page is not None else range(min(count, MAX_PAGES))
    summary = {"small": [], "added": [], "no_text": [], "relations": [], "review": [], "relation_failed": []}
    for index in indices:
        page = reader.pages[index]
        scope = f"page {index + 1}"
        text, method, problem, image_regions = "", "pdf_text", None, None
        try:
            # 선택 쪽 재인식에서는 깨진 내장 문자 추출 때문에 OCR까지 막지 않는다.
            if selected_page is None:
                text = page.extract_text() or ""
                problem = pdf_text_problem(text)
                needs_ocr = problem is not None
                # 정상 내장 문자를 기본으로 쓰고 그림은 영역만 따로 읽어 덧붙인다(D-157·D-159).
                if not needs_ocr and ocr == "auto" and page.get("/Resources", {}).get("/XObject"):
                    try:
                        image_regions = regions(index)
                    except DependencyMissing:
                        raise
                    except Exception:
                        # 그림 위치를 재지 못하면 그림 안 문자를 놓치지 않도록 전체 쪽 OCR을 유지한다.
                        result.note("pdf_image_size_unknown_whole_page_ocr_kept", scope, unread=False)
                        needs_ocr = True
            else:
                needs_ocr = True
            if selected_page is not None or ocr == "always" or (ocr == "auto" and needs_ocr):
                if problem and problem != "pdf_text_empty":
                    result.ocr_note(scope, problem + "_ocr_used")
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
            elif image_regions:
                text = _with_image_text(text, image_regions, read_region, result, scope, summary, index + 1)
        except DependencyMissing as error:
            result.note("dependency_missing:" + error.name, scope)
        except OcrFailure as error:
            result.note(str(error), scope)
        except OutputLimit:
            result.note("page_render_or_text_limit", scope)
        except Exception:
            result.note("pdf_page_or_ocr_failed", scope)
        if selected_page is None and method == "pdf_text" and text.strip():
            # 도식이 있으면 상자·선 위치로 추정한 관계를 덧붙인다(D-160). 실패해도 쪽 변환은 계속한다.
            try:
                block, status = relations(index)
            except Exception:
                summary["relation_failed"].append(index + 1)
            else:
                if status == "added":
                    text = text.rstrip() + "\n\n" + block + "\n"
                    summary["relations"].append(index + 1)
                elif status == "review":
                    summary["review"].append(index + 1)
        if not text.strip():
            result.note("no_text_detected_manual_review_required", scope)
        result.add(f"page-{index + 1}", location("pages", start=index + 1, end=index + 1), text, method)
    if selected_page is None and count > MAX_PAGES:
        result.note("page_limit", f"pages {MAX_PAGES + 1}-{count}")
    # 쪽마다 경고를 늘리지 않고 쪽 번호를 묶어서 남긴다.
    for code, numbers in (("pdf_text_kept_small_images_not_ocr", summary["small"]),
                          ("pdf_image_text_added_marked_as_ocr", summary["added"]),
                          ("pdf_images_without_readable_text", summary["no_text"]),
                          ("pdf_diagram_relations_added_estimated_by_position", summary["relations"]),
                          ("pdf_diagram_relations_need_review", summary["review"]),
                          ("pdf_diagram_relations_failed", summary["relation_failed"])):
        for offset in range(0, len(numbers), 40):
            # AI 해석 후보 목록은 분석 단계가 쪽 그림을 붙일 때 읽으므로 상한에 밀리지 않게 남긴다(D-169).
            result.note(code, "pages " + ",".join(map(str, numbers[offset:offset + 40])), unread=False,
                        reserved=code == "pdf_diagram_relations_need_review")
    result.note("layout_annotations_images_and_reading_order_not_verified", "PDF", unread=False)


def _with_image_text(text, regions, read_region, result, scope, summary, number):
    """내장 문자 뒤에 그림 영역의 OCR 문자를 위치와 함께 덧붙인다. 내장 문자는 바꾸지 않는다."""
    readable = sorted((region for region in regions if "image" in region), key=lambda region: region["box"][1::-1])
    if len(readable) < len(regions):
        summary["small"].append(number)
    if len(readable) > PDF_IMAGE_OCR_MAX_PER_PAGE:
        result.note("pdf_image_ocr_limit_remaining_images_not_read", scope)
        largest = sorted(readable, key=lambda region: -region["fraction"])[:PDF_IMAGE_OCR_MAX_PER_PAGE]
        readable = [region for region in readable if any(region is chosen for chosen in largest)]
    sections, low = [], False
    for region in readable:
        try:
            found = read_region(region["image"])
        except OutputLimit:
            result.note("pdf_image_too_large_not_read", scope)
            continue
        except OcrFailure as error:
            result.note(str(error), scope)
            continue
        if found is None:
            continue
        for code in found.get("warnings", []):
            result.note(code, scope, unread=False)
        left, top, width, height = region["box"]
        sections.append(f"[그림 속 글자 {len(sections) + 1} · 쪽 안 위치: 왼쪽 {left}% 위 {top}% "
                        f"크기 {width}%×{height}% · OCR]\n{found['text']}")
        low = low or found["low_confidence"]
    if not sections:
        if readable:
            summary["no_text"].append(number)
        return text
    summary["added"].append(number)
    if low:
        # 기존 저신뢰 검토·등록 계속 흐름(D-153·D-154)이 그대로 다루는 같은 표시를 쓴다.
        result.note(LOW_CONFIDENCE, scope)
    return text.rstrip() + "\n\n" + "\n\n".join(sections) + "\n"


def cell_text(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def preserve_xlsx_cell_blocks(result):
    cells = [unit for unit in result.result["units"] if unit["location"]["kind"] == "cells"]
    contents = xlsx_view.cell_blocks(cells)
    size = sum(len(value.encode("utf-8")) for value in contents)
    other = sum(len(unit["content"].encode("utf-8")) for unit in result.result["units"] if unit["location"]["kind"] != "cells")
    if size + other > MAX_TEXT:
        result.note("cell_literal_blocks_output_limit", "workbook")
        return
    for unit, content in zip(cells, contents):
        unit["content"] = content
    result.total_bytes = size + other


def xlsx(path, result):
    require("openpyxl")
    check_archive(path)
    from openpyxl import load_workbook
    # 서버의 검증된 작업 사본 이름은 확장자 없는 original이다. 바이트로 연다.
    raw = Path(path).read_bytes()
    formulas = load_workbook(BytesIO(raw), read_only=True, data_only=False, keep_links=False)
    values = load_workbook(BytesIO(raw), read_only=True, data_only=True, keep_links=False)
    raw_formulas = {}
    structure, structure_text = None, ""
    safe_view = True
    result.result["execution"]["converter"] = "openpyxl"
    try:
        try:
            raw_formulas = xlsx_view.raw_formula_cells(path)
        except (OSError, ValueError, KeyError, ElementTree.ParseError, StopIteration):
            result.note("original_formula_cache_metadata_not_read", "workbook")
            safe_view = False
        try:
            structure = xlsx_view.read_structure(path)
            structure_text = xlsx_view.structure_markdown(structure)
            for issue in structure["issues"]:
                result.note(issue["code"], issue["scope"])
                safe_view = False
        except (OSError, ValueError, KeyError, ElementTree.ParseError, StopIteration):
            result.note("original_workbook_structure_not_read", "workbook")
            safe_view = False
        for sheet_index, sheet in enumerate(formulas, 1):
            if len(sheet.title) > 200 or (sheet.max_row or 0) * (sheet.max_column or 0) > 1_000_000:
                result.note("worksheet_dimension_limit", f"sheet {sheet_index}")
                safe_view = False
                continue
            cached_rows = values[sheet.title].iter_rows()
            for row, cached_row in zip(sheet.iter_rows(), cached_rows):
                for cell, cached in zip(row, cached_row):
                    if cell.value is None:
                        continue
                    text = cell_text(cell.value)
                    if cell.data_type == "f":
                        original = raw_formulas.get((sheet.title, cell.coordinate))
                        formula = cell.value if isinstance(cell.value, str) else getattr(cell.value, "text", None)
                        if formula is None:
                            formula = "=" + (original["formula"] if original else "")
                            result.note("formula_representation_not_verified", f"{sheet.title}!{cell.coordinate}")
                        empty_string = original is not None and original["cached_type"] == "str" and original["cached_raw"] == ""
                        text = "formula: " + formula + "\ncached_value: " + (cell_text(cached.value) if cached.value is not None
                                                                                   else '""' if empty_string else "[unavailable]")
                        if original is not None:
                            text += "\ncached_raw: " + json.dumps(original["cached_raw"], ensure_ascii=False)
                            text += "\ncached_type: " + original["cached_type"]
                            text += "\nformula_raw: " + json.dumps(original["formula"], ensure_ascii=False)
                            if original["attributes"]:
                                text += "\nformula_attributes: " + json.dumps(original["attributes"], ensure_ascii=False, sort_keys=True)
                            if original["cached_type"] == "e":
                                result.note("formula_cached_error_retained_not_recalculated", f"{sheet.title}!{cell.coordinate}", unread=False)
                        if cached.value is None and not empty_string:
                            result.note("formula_cached_value_unavailable", f"{sheet.title}!{cell.coordinate}")
                    result.add(f"sheet-{sheet_index}-{cell.coordinate}",
                        location("cells", sheet=sheet.title, cells=cell.coordinate), text, "xlsx_values")
        with ZipFile(path) as archive:
            if any(name.startswith(("xl/drawings/", "xl/charts/", "xl/media/", "xl/embeddings/", "xl/externalLinks/")) for name in archive.namelist()):
                result.note("embedded_images_charts_drawings_not_read", "workbook")
    finally:
        formulas.close()
        values.close()
    if structure is not None:
        for issue in xlsx_view.non_anchor_issues(structure, result.result["units"]):
            result.note(issue["code"], issue["scope"])
    result.note("raw_values_and_formulas_only_no_recalculation_or_visual_layout", "workbook", unread=False)
    # 구조 설명을 맨 앞에 두고, 정확한 셀 기록은 코드 블록에 보존해 원문의 Markdown 기호가 문법으로 사라지지 않게 한다.
    if structure_text:
        result.add("workbook-structure", location("whole"), structure_text, "xlsx_structure")
        result.result["units"].insert(0, result.result["units"].pop())
    preserve_xlsx_cell_blocks(result)


def docx(path, result):
    """본문 순서와 표 좌표로 문단·셀을 읽는다. 쪽 위치는 제공하지 않는다."""
    result.result["execution"]["converter"] = "python-docx"
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


def convert_file(path, format, *, ocr="auto", language="eng", checkpoint=None, selected_page=None):
    """검증한 원본 사본을 읽으며 단위마다 부분 결과를 알린다."""
    if selected_page is not None:
        if format != "pdf" or type(selected_page) is not int or not 1 <= selected_page <= 1_000_000:
            raise ValueError("invalid_page_conversion_options")
        ocr = "always"
    result = Conversion(format, checkpoint)
    installed = diagnostics(language)
    versions = {name: value["version"] for name, value in installed["packages"].items() if value["available"]}
    result.result["execution"] = {"adapter": "llm-wiki-source-conversion-v1", "packages": versions,
                                  "ocr": ocr, "ocr_language": language, "pdf_render_scale": PDF_OCR_DPI / 72,
                                  "pdf_ocr_target_dpi": PDF_OCR_DPI,
                                  "tesseract_version": installed["tesseract"]["version"],
                                  }
    result.note("adapter=llm-wiki-source-conversion-v1", "tools", unread=False)
    for name, version in versions.items():
        result.note(f"{name}={version}", "tools", unread=False)
    result.note(f"ocr={ocr};language={language};pdf_ocr_target_dpi={PDF_OCR_DPI};ocr_psm=3", "settings", unread=False)
    if installed["tesseract"]["version"]:
        result.note("tesseract=" + installed["tesseract"]["version"], "tools", unread=False)
    try:
        if format == "pdf":
            pdf(path, result, ocr, language, selected_page=selected_page)
        elif format == "xlsx":
            xlsx(path, result)
        elif format == "docx":
            docx(path, result)
        elif format == "pptx":
            presentation_view.pptx(path, result, picture_text=picture_reader(language) if ocr != "never" else None)
        elif format == "ppt":
            presentation_view.ppt(path, result, picture_text=picture_reader(language) if ocr != "never" else None)
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
