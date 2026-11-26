"""Explicit user decisions; no client-supplied tenant or user identity."""
from typing import Annotated, Literal
from pydantic import Field, field_validator, model_validator
from core.api.schemas import Model
from core.api.v1.analysis_plans.schemas import Profile, SourceRef, ConversionRef


class Listing(Profile):
    filter: Literal['all', 'unread', 'approval'] = 'all'
    limit: int = Field(30, ge=1, le=100, strict=False)
    cursor: str | None = Field(None, max_length=4096)
    after_seq: int | None = Field(None, ge=0, le=9223372036854775806, strict=False)
    after_change_seq: int | None = Field(None, ge=0, le=9223372036854775806, strict=False)


class DetailQuery(Profile):
    include_content: bool = Field(True, strict=False)


class CreateWorkflow(Profile):
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    source_ref: SourceRef
    conversion_ref: ConversionRef
    title: str = Field(min_length=1, max_length=200)
    target_document: str | None = Field(None, min_length=1, max_length=4096)


class ReadFlags(Profile):
    notification_ids: list[str] = Field(min_length=1, max_length=100)
    read: bool


class Dismiss(Profile):
    notification_ids: list[str] = Field(min_length=1, max_length=100)


class Mutation(Profile):
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    expected_revision: str = Field(pattern=r'^[a-f0-9]{64}$')


class CorrectionRef(Model):
    correction_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    correction_revision: str = Field(pattern=r'^[a-f0-9]{64}$')


class ContentTarget(Model):
    page: int | None = Field(None, ge=1, le=1000000)
    unit_id: str | None = Field(None, pattern=r'^[a-zA-Z0-9_-]{1,64}$')
    whole_document: Literal[True] | None = None

    @model_validator(mode='after')
    def one_target(self):
        if sum(value is not None for value in (self.page, self.unit_id, self.whole_document)) != 1:
            raise ValueError('Select exactly one preserved unit, page, or whole document.')
        return self


class CorrectionSelection(ContentTarget):
    correction_ref: CorrectionRef


class ContentQuery(Profile, ContentTarget):
    expected_revision: str = Field(pattern=r'^[a-f0-9]{64}$')
    variant: Literal['original', 'selected'] = 'selected'
    offset: int = Field(0, ge=0, le=32 * 1024 * 1024, strict=False)
    limit: int = Field(65536, ge=1, le=65536, strict=False)

    @field_validator('page', mode='before')
    @classmethod
    def query_page(cls, value):
        return int(value) if isinstance(value, str) and value.isascii() and value.isdigit() else value

    @field_validator('whole_document', mode='before')
    @classmethod
    def query_whole(cls, value):
        return True if value == 'true' else value


class Decision(ContentTarget):
    state: Literal['pending', 'usable', 'held']
    correction_ref: CorrectionRef | None = None


class PageDecisions(Mutation):
    decisions: list[Decision] = Field(min_length=1, max_length=100)


class PageCorrection(Mutation, ContentTarget):
    method: Literal['manual', 'ocr', 'blank']
    content: str = Field(max_length=4 * 1024 * 1024)
    warnings: list[Annotated[str, Field(max_length=1024)]] = Field(default_factory=list, max_length=100)

    @field_validator('content')
    @classmethod
    def bounded_text(cls, value):
        if '\0' in value or len(value.encode('utf-8')) > 4 * 1024 * 1024:
            raise ValueError('A bounded correction is required.')
        return value

    @model_validator(mode='after')
    def explicit_blank(self):
        if self.method == 'blank':
            if self.content != '' or self.whole_document:
                raise ValueError('A blank confirmation needs an empty single page or unit.')
        elif not self.content.strip():
            raise ValueError('A nonempty correction is required unless blank is explicitly confirmed.')
        return self


class Device(Mutation):
    device_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    device_name: str = Field(min_length=1, max_length=80)


class Approve(Device):
    target_document: str | None = Field(None, min_length=1, max_length=4096)
    correction_refs: list[CorrectionSelection] | None = Field(None, max_length=1000)
    corrections_revision: str | None = Field(None, pattern=r'^[a-f0-9]{64}$')


class Claim(Device):
    reclaim: bool = False


class Execution(Mutation):
    claim_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    job_id: str = Field(pattern=r'^[a-f0-9]{32}$')


class ReportedEvent(Profile):
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    source_ref: SourceRef
    conversion_ref: ConversionRef | None = None
    job_id: str | None = Field(None, pattern=r'^[a-f0-9]{32}$')
    kind: Literal['failed', 'stopped']
    title: str = Field(min_length=1, max_length=200)
    device_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    device_name: str = Field(min_length=1, max_length=80)
    diagnostic_codes: list[Annotated[str, Field(pattern=r'^[a-zA-Z0-9_.-]{1,128}$')]] | None = Field(None, max_length=100)
