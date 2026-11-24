"""Explicit user decisions; no client-supplied tenant or user identity."""
from typing import Literal
from pydantic import Field
from core.api.schemas import Model
from core.api.v1.analysis_plans.schemas import Profile, SourceRef, ConversionRef


class Listing(Profile):
    filter: Literal['all', 'unread', 'approval'] = 'all'
    limit: int = Field(30, ge=1, le=100, strict=False)
    cursor: str | None = Field(None, max_length=4096)
    after_seq: int | None = Field(None, ge=0, le=9223372036854775806, strict=False)
    after_change_seq: int | None = Field(None, ge=0, le=9223372036854775806, strict=False)


class CreateWorkflow(Profile):
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    source_ref: SourceRef
    conversion_ref: ConversionRef
    title: str = Field(min_length=1, max_length=200)
    target_document: str | None = Field(None, min_length=1, max_length=4096)


class ReadFlags(Profile):
    notification_ids: list[str] = Field(min_length=1, max_length=100)
    read: bool


class Mutation(Profile):
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    expected_revision: str = Field(pattern=r'^[a-f0-9]{64}$')


class Decision(Model):
    page: int = Field(ge=1, le=1000000)
    state: Literal['pending', 'usable', 'held']


class PageDecisions(Mutation):
    decisions: list[Decision] = Field(min_length=1, max_length=100)


class Device(Mutation):
    device_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    device_name: str = Field(min_length=1, max_length=80)


class Approve(Device):
    target_document: str | None = Field(None, min_length=1, max_length=4096)


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
