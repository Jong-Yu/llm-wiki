"""지도 탐색은 전체 문서 지식과 구분한 판본 참조·경량 페이지로 전달한다."""

from typing import Annotated, Literal
from pydantic import Field, model_validator
from core.api.schemas import Access, Model
from .schemas import ProfileRequest


Revision = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Text = Annotated[str, Field(min_length=1, max_length=4096)]
Cursor = Annotated[str, Field(min_length=1, max_length=16384)]


class OntologySearchRequest(ProfileRequest):
    """빈 검색은 최근 항목을, 문서 지정은 그 문서의 실제 개념을 찾는다."""
    text: str = Field("", max_length=200)
    kind: Literal["all", "concept", "document"] = "all"
    document: Text | None = None
    cursor: Cursor | None = None
    limit: int = Field(20, ge=1, le=50)


class OntologyNeighborsRequest(ProfileRequest):
    """선택 당시 state를 고정해 다른 판본의 이웃을 조용히 섞지 않는다."""
    document: Text
    entity_id: Text
    expected_state_revision: Revision
    cursor: Cursor | None = None
    limit: int = Field(20, ge=1, le=50)


class OntologyDocumentRef(Model):
    document: Text
    kind: Literal["document"]
    reference: Text
    source_revision: Revision | None
    graph_revision: Revision | None
    review_revision: Revision | None
    history_revision: Revision | None
    state_revision: Revision | None
    status: Text


class OntologyEntityRef(Model):
    document: Text
    entity_id: Text


class OntologyMapConcept(OntologyEntityRef):
    name: Text
    type: Text
    attribute_count: int = Field(ge=0)
    ref: OntologyDocumentRef


class OntologyAnchorRef(Model):
    document: Text
    anchor_id: Revision


class OntologyMapSourceAnchor(OntologyAnchorRef):
    """원문 인용을 복사하지 않고 현재 문서의 정확한 위치만 전달한다."""
    source_revision: Revision
    start_line: int = Field(ge=1, le=1024 * 1024)
    end_line: int = Field(ge=1, le=1024 * 1024)
    occurrence: int = Field(ge=0, le=1024 * 1024)
    ref: OntologyDocumentRef

    @model_validator(mode="after")
    def current_source(self):
        if (self.document != self.ref.document or self.document != self.ref.reference
                or self.source_revision != self.ref.source_revision or self.start_line > self.end_line):
            raise ValueError("Source anchor summaries must match their current document and source position")
        return self


class OntologyMapEdge(Model):
    key: Text
    document: Text
    subject: OntologyEntityRef | OntologyAnchorRef
    object: OntologyEntityRef | OntologyAnchorRef
    label: Text
    origin: Literal["machine", "reviewed", "policy", "independent"]
    collection: Text
    original_collection: Text
    claim_id: Revision | None
    collection_index: int | None = Field(ge=0)
    polarity: Text | None
    modality: Text | None
    conditional: bool
    ref: OntologyDocumentRef


class OntologyMapPreview(Model):
    label: Text
    other_name: Text
    direction: Literal["incoming", "outgoing"]
    origin: Literal["machine", "reviewed", "policy", "independent"]
    polarity: Text | None
    modality: Text | None
    conditional: bool


class OntologyConceptItem(Model):
    kind: Literal["concept"]
    concept: OntologyMapConcept
    concept_count: int = Field(ge=0)
    relation_count: int = Field(ge=0)
    previews: list[OntologyMapPreview] = Field(max_length=2)


class OntologyDocumentItem(Model):
    kind: Literal["document"]
    ref: OntologyDocumentRef
    title: Text
    concept_count: int = Field(ge=0)
    relation_count: int = Field(ge=0)
    concepts: list[OntologyMapConcept] = Field(max_length=5)
    previews: list[OntologyMapPreview] = Field(max_length=2)


class OntologySkipped(Model):
    document: Text
    code: Text


class OntologyCoverage(Model):
    complete: bool
    skipped: list[OntologySkipped]
    truncated: bool


class OntologyProjectionPage(Model):
    index_revision: Revision
    next_cursor: Cursor | None
    total: int = Field(ge=0)
    coverage: OntologyCoverage
    access: Access


class OntologySearchPage(OntologyProjectionPage):
    items: list[Annotated[OntologyConceptItem | OntologyDocumentItem, Field(discriminator="kind")]] = Field(max_length=50)


class OntologyNeighborPage(OntologyProjectionPage):
    document: OntologyDocumentRef
    entity_id: Text
    concepts: list[OntologyMapConcept]
    anchors: list[OntologyMapSourceAnchor] = Field(max_length=100)
    edges: list[OntologyMapEdge] = Field(max_length=50)

    @model_validator(mode="after")
    def anchor_endpoints(self):
        identifiers = {anchor.anchor_id for anchor in self.anchors}
        endpoints = [endpoint for edge in self.edges for endpoint in (edge.subject, edge.object)
                     if isinstance(endpoint, OntologyAnchorRef)]
        if (len(identifiers) != len(self.anchors)
                or identifiers != {endpoint.anchor_id for endpoint in endpoints}
                or any(endpoint.document != self.document.document for endpoint in endpoints)
                or any(anchor.ref != self.document for anchor in self.anchors)):
            raise ValueError("Source anchor endpoints must match the current bounded relation page")
        return self
