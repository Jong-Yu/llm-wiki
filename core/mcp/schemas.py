"""MCP에 공개하는 입력 모델·타입·설명. 업무 검증을 대신하지 않는다."""

# 공통 온톨로지 입력은 업무 모듈의 같은 객체를 공개하고 MCP 전용 입력·안내만 여기서 정의한다.
# 실제 인용·버전·저장 검사는 각 업무 모듈에서 수행한다.
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StrictStr

from core.modules.ontology.submission import (
    REVISION_PATTERN, SourceRevisionInput, EntityId, EvidenceInput, PredicateInput, ViewpointInput,
    ContextInput, IdentifierInput, ProvenanceInput, EntityInput, QualifiersInput,
    SourceAnchorInput, MappingInput, RelationInput, RelationCandidateInput, AttributeInput,
)


# revision은 내용에서 계산한 지문이다. | None은 값이 없을 수 있다는 뜻이며
# None을 허용하지 않는 SourceRevisionInput은 반드시 실제 원문 버전을 받아야 한다.
RevisionInput = Annotated[StrictStr, Field(pattern=REVISION_PATTERN)] | None
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


class ImpactBaselineInput(BaseModel):
    # 변경 전 관측한 네 버전이다. 영향 조회의 비교 기준이지 저장 허가나 현재 버전으로 쓰지 않는다.
    model_config = ConfigDict(extra="forbid", strict=True)

    source_revision: SourceRevisionInput
    graph_revision: RevisionInput
    review_revision: RevisionInput
    history_revision: SourceRevisionInput
