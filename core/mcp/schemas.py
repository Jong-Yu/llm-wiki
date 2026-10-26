"""MCP에 공개하는 입력 모델·타입·설명. 업무 검증을 대신하지 않는다."""

# 이 파일은 '받을 JSON의 모양'을 선언한다. 실제 인용·버전·저장 검사는 각 업무 모듈에서 한다.
# Annotated는 자료형에 길이/형식 조건을 붙이고, Literal은 허용한 값만 받게 한다.
# StrictStr/StrictInt는 문자열 "1"을 숫자 1로 자동 변환하는 식의 입력 보정을 허용하지 않는다.
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr


REVISION_PATTERN = r"^[0-9a-f]{64}$"
# revision은 내용에서 계산한 지문이다. | None은 값이 없을 수 있다는 뜻이며
# None을 허용하지 않는 SourceRevisionInput은 반드시 실제 원문 버전을 받아야 한다.
RevisionInput = Annotated[StrictStr, Field(pattern=REVISION_PATTERN)] | None
SourceRevisionInput = Annotated[StrictStr, Field(pattern=REVISION_PATTERN)]
EntityId = Annotated[StrictStr, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
EvidenceInput = Annotated[StrictStr, Field(min_length=1, max_length=1000)]
PredicateInput = Literal[
    "uses", "depends_on", "part_of", "implements", "related_to", "authored_by",
    "subclass_of", "instance_of", "composed_of", "located_in", "has_input",
    "has_output", "participates_in", "precedes", "causes", "enables", "prevents",
    "predicts", "supports_prediction", "measures", "observes",
    "view_of", "same_as", "different_from", "responsible_for", "approves",
]
ViewpointInput = Literal["business", "developer", "architecture"]
CORRESPONDENCE_TOOLS = frozenset({
    "ontology_correspondence_query", "ontology_correspondence_propose",
    "ontology_correspondence_review", "ontology_correspondence_review_undo",
    "ontology_correspondence_policy", "ontology_correspondence_policy_undo",
    "ontology_correspondence_find", "ontology_correspondence_prepare",
})
CONCEPT_TOOLS = frozenset({"ontology_concept_find", "ontology_concept_query"})
_CONCEPT_TARGET_GUIDE = (
    "One exact typed target_ref from ontology_concept_find; never a bare name or encoded JSON. "
    "Unknown fields are rejected. Discriminant kind is anchor/entity/document_claim/correspondence_endpoint. "
    "anchor={kind:'anchor',anchor:{document,source_revision,quote,start_line,end_line,optional occurrence,optional graph_ref},"
    "observation:{source_revision,history_revision}}. quote is exact source text; lines are 1-based, occurrence 0-based. "
    "observation revisions may be null only when discovery could not capture them; such targets are diagnostic and cannot expand. "
    "entity={kind:'entity',document,source_revision,graph_revision,state_revision,layer:'machine'|'reviewed',entity_id,snapshot,"
    "optional origin_ref,optional historical:bool}. document_claim={kind:'document_claim',document,source_revision,graph_revision,state_revision,"
    "original_collection:'relations'|'attributes'|'relation_candidates',claim_id,layer:'machine'|'reviewed',snapshot,"
    "optional selector:'subject'|'object'|'attribute_subject'|'value',optional origin_ref,optional historical:bool}. Use only selectors valid for that "
    "collection. A value selector denotes a claim position, not a new entity; it never triggers automatic correspondence expansion. "
    "For v4 source_anchor relation endpoints, subject/object select the exact quoted source position with its relation "
    "claim snapshot; they do not create entity IDs or broaden same-label entity candidates. "
    "correspondence_endpoint={kind:'correspondence_endpoint',correspondence_id,correspondence_revision,lane:'source'|'expert',"
    "judgment_id,latest_event_id,origin_event_id,endpoint:'condition'|'concept',snapshot,optional selected_event_id,optional historical:bool}. Source judgment_id is null. "
    "origin_ref={kind:'document_policy',document,original_collection,claim_id,latest_event_id,selected_event_id,decision_event_id,"
    "exact_scope:{domain:string|null,viewpoint:'business'|'developer'|'architecture'|null},state_revision,snapshot}. "
    "It identifies verified Action log snapshots, including pending/other-scope/historical values "
    "that are absent from effective_graph; no fake source quote is permitted. graph_ref in an anchor uses the complete D-038 "
    "graph_revision/state_revision/layer/collection/entity_id-or-claim_id/snapshot keys. Copy every returned key and snapshot "
    "unchanged. Revision values are lowercase SHA-256; event/correspondence/judgment IDs are server UUID4 hex. "
    "Changed versions are reported without silently selecting a new entity by its name. These refs and snapshot_revision/view_revision "
    "are read observations, never write CAS, access credentials or approval."
)
CorrespondenceReasonInput = Annotated[StrictStr, Field(min_length=1, max_length=2000)]
_CORRESPONDENCE_VALUE_GUIDE = (
    "Complete value object; all listed top-level keys are required, unknown keys are rejected. "
    "{condition:anchor, concept:anchor, statement:string, "
    "direction:'condition_to_concept'|'equivalent_definition', qualifiers:{quantity,conditions,exceptions}, "
    "business_scope:{axes:[axis],validity}, basis:{kind:'candidate'|'source'|'expert',reason:string,link_evidence:[anchor]}, "
    "references:[reference], questions:[string], related_to:[{correspondence_id,event_id}]}. "
    "anchor={document:relative .md path,source_revision:SHA256,quote:exact nonblank source text,start_line:int,end_line:int}; "
    "lines are 1-based. Optional occurrence is a 0-based int for repeated same-line quotes; optional graph_ref is below. "
    "quantity={status:'unknown'|'not_applicable',expression:string}, or "
    "{status:'specified',expression:string,subject:string,unit:string,lower:decimal string,upper:decimal string,"
    "lower_inclusive:bool,upper_inclusive:bool}. conditions/exceptions each={status:'unknown'|'none'|'specified',items:[string]}; "
    "only specified has nonempty items. axis={name:string,status:'unknown'|'unrestricted'|'specified',value:string|null,source:string|null}; "
    "specified needs a value, others use null. Source is required for unrestricted/specified. "
    "axes lists 1-50 explicitly identified business axes; the profile is not a business axis default. "
    "validity={status:'unknown'|'unrestricted',source:string|null}, or {status:'specified',source:string,start:offset-aware ISO8601,"
    "end:offset-aware ISO8601,start_inclusive:bool,end_inclusive:bool,timezone:IANA zone}. "
    "Unknown must stay unknown; no omitted-axis, no-exception, global-scope or reverse implication is inferred. "
    "Source basis requires nonempty actual linking evidence anchors, not merely endpoint quotations. Candidate basis has empty "
    "link_evidence and nonempty questions. Expert replacement uses kind='expert', empty link_evidence and Action log provenance; "
    "never supply actor, approval, hash or fabricated evidence. condition/concept documents stay fixed after first creation. "
    "graph_ref={graph_revision:SHA256,state_revision:SHA256,collection:'entities'|'relations'|'attributes'|'relation_candidates',"
    "layer:'machine'|'reviewed',snapshot:exact queried object,entity_id:string for entities OR claim_id:SHA256 otherwise}. "
    "reference shapes: {kind:'graph',document,graph_ref}; "
    "{kind:'review'|'policy',document,event_id,state_revision,snapshot,scope}; "
    "{kind:'correspondence',correspondence_id,event_id,correspondence_revision,snapshot,scope}. "
    "Review scope is null; policy scope is exact {domain:string|null,viewpoint:'business'|'developer'|'architecture'|null}; "
    "correspondence scope is its referenced exact policy scope or null for source. Copy actual snapshots/versions from current "
    "queries. Use [] when no references/precedents apply. related_to is a precedent, while an actual dependency must also be in "
    "references. IDs are server UUID4 lowercase 32-hex, revisions lowercase 64-hex. Quote limit1000, statements/reasons2000, "
    "conditions/exceptions/questions each at most50. Structural validation and quote existence do not prove semantic support."
)
_CORRESPONDENCE_CHANGE_GUIDE = (
    "Complete mutation arguments excluding tenant/profile/correspondence_id/expected_state_revision. "
    "review={action:'accept'|'reject'|'defer'|'edit',reason:string,optional replacement:complete value,optional decision:'accepted'|'deferred'}; "
    "edit requires both replacement and decision; other actions prohibit replacement/decision. "
    "review_undo or policy_undo={event_id:server UUID4 hex,reason:string}. "
    "policy={replacement:complete expert value,reason:string,optional judgment_id:server UUID4 hex|null,"
    "optional supersedes_event_id:server UUID4 hex|null}. Existing policy updates require judgment_id and latest supersedes_event_id. "
    "The prepared token binds the exact normalized operation and full change; it grants no mutation authority. "
    + _CORRESPONDENCE_VALUE_GUIDE
)


class ContextInput(BaseModel):
    # domain은 업무 영역, viewpoints는 업무/개발/구조 관점이다. tenant 접근 권한과는 별개다.
    # extra='forbid'는 알 수 없는 필드를 거부하고 strict=True는 자료형 자동 변환을 막는다.
    model_config = ConfigDict(extra="forbid", strict=True)

    domain: EvidenceInput | None = None
    # default_factory=list는 입력마다 새로운 빈 목록을 만들어 서로 섞이지 않게 한다.
    viewpoints: Annotated[list[ViewpointInput], Field(max_length=3)] = Field(default_factory=list)


class ImpactBaselineInput(BaseModel):
    # 변경 전 관측한 네 버전이다. 영향 조회의 비교 기준이지 저장 허가나 현재 버전으로 쓰지 않는다.
    model_config = ConfigDict(extra="forbid", strict=True)

    source_revision: SourceRevisionInput
    graph_revision: RevisionInput
    review_revision: RevisionInput
    history_revision: SourceRevisionInput


class IdentifierInput(BaseModel):
    # namespace는 식별자 발급 범위, value는 실제 값, evidence는 이를 뒷받침하는 원문 인용이다.
    model_config = ConfigDict(extra="forbid", strict=True)

    namespace: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    value: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    evidence: EvidenceInput


class ProvenanceInput(BaseModel):
    # 어떤 출처/발언 주체에 귀속되는 주장인지 보존한다. 전문가 정책의 승인 기록과 구분한다.
    model_config = ConfigDict(extra="forbid", strict=True)

    source_entity: EntityId | None = None
    attributed_to: EntityId | None = None
    basis: EvidenceInput | None = None


class EntityInput(BaseModel):
    # 원문에서 추출한 대상 하나다. id는 같은 문서의 관계/속성이 이 대상을 가리킬 때 사용한다.
    model_config = ConfigDict(extra="forbid", strict=True)

    id: EntityId
    type: Literal[
        "person", "organization", "system", "concept", "document",
        "process", "physical_object", "substance", "place",
    ]
    label: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    evidence: EvidenceInput
    context: ContextInput = Field(default_factory=ContextInput)
    identifiers: Annotated[list[IdentifierInput], Field(max_length=8)] = Field(default_factory=list)


class QualifiersInput(BaseModel):
    # 주장에 붙는 부정/가능성/조건/범위/시점이다. 기존 직접 저장에는 기본값이 있으며,
    # 새 분석 작업 경로는 기본값 적용 전에 다섯 키의 명시 여부를 별도로 검사한다.
    model_config = ConfigDict(extra="forbid", strict=True)

    polarity: Literal["positive", "negative"] = "positive"
    modality: Literal["asserted", "possible", "capability", "planned", "hypothetical"] = "asserted"
    condition: EvidenceInput | None = None
    scope: EvidenceInput | None = None
    time: EvidenceInput | None = None


class SourceAnchorInput(BaseModel):
    """Only relation endpoints may opt into a source-bound v4 anchor."""
    # 개체 ID 대신 정확한 원문 구절/줄 위치를 관계 끝점으로 지정하는 v4 입력이다.
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["source_anchor"]
    document: StrictStr
    source_revision: SourceRevisionInput
    quote: EvidenceInput
    start_line: Annotated[StrictInt, Field(ge=1)]
    end_line: Annotated[StrictInt, Field(ge=1)]
    occurrence: Annotated[StrictInt, Field(ge=0)]


class MappingInput(BaseModel):
    # 대응 관계의 적용 범위와 양쪽의 다대다 조건을 명시한다. 일반 관계의 임의 부가 필드는 아니다.
    model_config = ConfigDict(extra="forbid", strict=True)

    within: EntityId
    subject_cardinality: Literal["many"]
    object_cardinality: Literal["many"]


class RelationInput(BaseModel):
    # subject → predicate → object 형태의 관계 하나다. evidence는 그 관계의 실제 원문 근거다.
    model_config = ConfigDict(extra="forbid", strict=True)

    subject: EntityId | SourceAnchorInput
    predicate: PredicateInput | Literal["maps_to", "targets", "follows_reference", "requires", "includes_step", "delivered_to", "recommends", "has_source_metadata", "has_source_history"]
    object: EntityId | SourceAnchorInput
    evidence: EvidenceInput
    mapping: MappingInput | None = None
    qualifiers: QualifiersInput = Field(default_factory=QualifiersInput)
    context: ContextInput = Field(default_factory=ContextInput)
    provenance: ProvenanceInput = Field(default_factory=ProvenanceInput)


class RelationCandidateInput(BaseModel):
    # 아직 확정하지 않은 관계 제안이다. reason/question을 보존하고 근거 관계나 승인으로 승격하지 않는다.
    model_config = ConfigDict(extra="forbid", strict=True)

    id: EntityId
    subject: EntityId
    predicate: PredicateInput
    object: EntityId
    evidence: EvidenceInput | None = None
    qualifiers: QualifiersInput = Field(default_factory=QualifiersInput)
    reason: Annotated[StrictStr, Field(min_length=1, max_length=1000)]
    question: Annotated[StrictStr, Field(min_length=1, max_length=500)]
    context: ContextInput = Field(default_factory=ContextInput)
    provenance: ProvenanceInput = Field(default_factory=ProvenanceInput)


class AttributeInput(BaseModel):
    # 대상의 속성값 하나다. 값/단위를 원문의 문자열로 보존해 임의 계산이나 환산을 피한다.
    model_config = ConfigDict(extra="forbid", strict=True)

    id: EntityId
    subject: EntityId
    property: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    datatype: Literal["text", "number"]
    value: Annotated[StrictStr, Field(min_length=1, max_length=500)]
    unit: Annotated[StrictStr, Field(min_length=1, max_length=120)] | None = None
    evidence: EvidenceInput
    qualifiers: QualifiersInput = Field(default_factory=QualifiersInput)
    context: ContextInput = Field(default_factory=ContextInput)
    provenance: ProvenanceInput = Field(default_factory=ProvenanceInput)
