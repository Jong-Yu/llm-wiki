"""현재 개체의 원문 문맥과 유효 주장을 묶는 선택 조회 계약."""

from typing import Literal
from pydantic import Field, JsonValue
from core.api.schemas import Access, Model
from .schemas import ProfileRequest
from .exploration_schemas import OntologyCoverage, OntologyDocumentRef, Revision, Text


class GlossaryRequest(ProfileRequest):
    document: Text
    entity_id: Text
    expected_state_revision: Revision
    limit: int = Field(10, ge=1, le=20)


class GlossaryPassage(Model):
    quote: str
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    source_revision: Revision


class GlossaryClaim(Model):
    claim_id: Revision
    collection: Literal["attributes", "relations", "relation_candidates"]
    original_collection: Literal["attributes", "relations", "relation_candidates"]
    origin: Literal["machine", "reviewed", "policy", "independent"]
    decision: Literal["unreviewed", "accept", "edit", "policy"]
    value: dict[str, JsonValue]
    provenance: dict[str, JsonValue]


class GlossaryTotals(Model):
    attributes: int = Field(ge=0)
    relations: int = Field(ge=0)


class GlossaryCard(Model):
    document: OntologyDocumentRef
    entity: dict[str, JsonValue]
    source_passage: GlossaryPassage | None
    source_passage_status: Literal["available", "no_source_evidence", "limited"]
    attributes: list[GlossaryClaim] = Field(max_length=20)
    relations: list[GlossaryClaim] = Field(max_length=20)
    totals: GlossaryTotals
    coverage: OntologyCoverage
    access: Access
