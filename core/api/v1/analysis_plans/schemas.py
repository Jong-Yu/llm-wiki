"""분석 위치·산출물·근거를 명시하는 입력 계약이다.

Field는 허용 길이/숫자를 검사하고 Model은 모르는 항목을 거부한다. PDF/Excel의
문자 변환은 개인 PC가 수행하며 서버는 보고와 원본 hash의 연결을 보관한다.
"""

from typing import Literal
from pydantic import Field, model_validator
from core.api.schemas import Model


class Profile(Model):
    profile: str | None = Field(None, pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class SourceRef(Model):
    source_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_version: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    registration_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class WikiRef(Model):
    document: str = Field(min_length=1, max_length=4096)
    source_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    graph_revision: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    state_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class Location(Model):
    kind: Literal["whole", "pages", "lines", "cells", "blocks", "paragraphs"]
    start: int | None = Field(None, ge=1, le=1000000)
    end: int | None = Field(None, ge=1, le=1000000)
    sheet: str | None = Field(None, min_length=1, max_length=200)
    cells: str | None = Field(None, pattern=r"^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$")

    @model_validator(mode="after")
    def shape(self):
        """페이지/줄/DOCX 본문 블록은 닫힌 범위, 셀은 시트와 A1 범위다."""
        if self.kind in {"pages", "lines", "blocks", "paragraphs"}:
            if self.start is None or self.end is None or self.end < self.start or self.sheet is not None or self.cells is not None:
                raise ValueError("A page, line or block selection needs an ordered numeric range")
        elif self.kind == "cells":
            if self.sheet is None or self.cells is None or self.start is not None or self.end is not None:
                raise ValueError("A cell selection needs its sheet and cell range")
        elif any(value is not None for value in (self.start, self.end, self.sheet, self.cells)):
            raise ValueError("A whole-source location has no extra range fields")
        return self


class TableCellLocation(Model):
    """DOCX 본문 표/행/열은 각각 1부터 시작한다. Excel 시트와 구분한다."""
    kind: Literal["table_cells"]
    table: int = Field(ge=1, le=1000000)
    row: int = Field(ge=1, le=1000000)
    column: int = Field(ge=1, le=1000000)


SourceLocation = Location | TableCellLocation


class ConversionUnit(Model):
    unit_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    location: SourceLocation
    content: str = Field(max_length=4 * 1024 * 1024)


class CreateConversion(Profile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_ref: SourceRef
    method: Literal["verbatim", "pdf_text", "ocr", "xlsx_values", "docx_text"]
    units: list[ConversionUnit] = Field(min_length=1, max_length=1000)
    complete: bool
    unread_ranges: list[str] = Field(default_factory=list, max_length=100)
    warnings: list[str] = Field(default_factory=list, max_length=100)


class ConversionRef(Model):
    conversion_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    conversion_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class ContextDocument(Model):
    document: str = Field(min_length=1, max_length=4096)
    required: bool
    reason: str = Field(min_length=1, max_length=1000)


class PlannedOutput(Model):
    document: str = Field(min_length=1, max_length=4096)
    title: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1, max_length=1000)
    locations: list[SourceLocation] = Field(default_factory=list, max_length=100)
    outputs: list[Literal["wiki", "ontology"]] = Field(min_length=1, max_length=2)


class CreatePlan(Profile):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    source_ref: SourceRef | None = None
    wiki_ref: WikiRef | None = None
    conversion_ref: ConversionRef | None = None
    locations: list[SourceLocation] = Field(default_factory=list, max_length=100)
    outputs: list[PlannedOutput] = Field(min_length=1, max_length=8)
    context_documents: list[ContextDocument] = Field(default_factory=list, max_length=7)

    @model_validator(mode="after")
    def source_choice(self):
        """등록 원본과 기존 Wiki 중 실제 분석할 출처 하나만 지정한다."""
        if (self.source_ref is None) == (self.wiki_ref is None):
            raise ValueError("Select exactly one original or Wiki source")
        if self.wiki_ref is not None and self.conversion_ref is not None:
            raise ValueError("Wiki content does not use a binary conversion reference")
        return self


class ValidatePlan(Profile):
    expected_plan_revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class HandoffPlan(ValidatePlan):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
