"""전송 경계에서 검증·기본값 적용을 마친 분석 계획 입력의 업무 타입.

HTTP profile과 Pydantic 객체를 받지 않는다. 저장 검증과 권한 확인은
기존 업무 서비스가 유지하며 이 선언은 외부 입력 검증을 대신하지 않는다.
"""

from typing import Literal, NotRequired, TypedDict


class SourceRef(TypedDict):
    source_id: str
    source_version: str
    source_sha256: str
    registration_revision: str


class WikiRef(TypedDict):
    document: str
    source_revision: str
    graph_revision: str | None
    state_revision: str


class ConversionRef(TypedDict):
    conversion_id: str
    conversion_revision: str


class PartRef(TypedDict):
    part_id: str
    part_revision: str


class Location(TypedDict):
    kind: Literal["whole", "pages", "slides", "lines", "cells", "blocks", "paragraphs"]
    start: int | None
    end: int | None
    sheet: str | None
    cells: str | None


class TableCellLocation(TypedDict):
    kind: Literal["table_cells"]
    table: int
    row: int
    column: int


SourceLocation = Location | TableCellLocation


class ConversionUnit(TypedDict):
    unit_id: str
    location: SourceLocation
    content: str


class ConversionReport(TypedDict):
    request_id: str
    source_ref: SourceRef
    method: Literal["verbatim", "pdf_text", "ocr", "xlsx_values", "docx_text", "pptx_text"]
    complete: bool
    unread_ranges: list[str]
    warnings: list[str]


class ConversionCommand(ConversionReport):
    units: list[ConversionUnit]
    conversion_request_id: NotRequired[str]
    part_index: NotRequired[int]


class CompletePartsCommand(ConversionReport):
    parts: list[PartRef]


class PlannedOutput(TypedDict):
    document: str
    title: str
    purpose: str
    locations: list[SourceLocation]
    outputs: list[Literal["wiki", "ontology"]]


class ContextDocument(TypedDict):
    document: str
    required: bool
    reason: str


class PlanCommand(TypedDict):
    request_id: str
    source_ref: SourceRef | None
    wiki_ref: WikiRef | None
    conversion_ref: ConversionRef | None
    locations: list[SourceLocation]
    outputs: list[PlannedOutput]
    context_documents: list[ContextDocument]
