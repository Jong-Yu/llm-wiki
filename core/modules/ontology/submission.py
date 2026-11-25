"""온톨로지 입력 모델과 공통 분석 제출 스키마의 원본.

기존 직접 입력의 기본값과 분석 제출의 명시적 한정어 요구를 구별한다.
형식 검증은 원문 의미 판단이나 저장 권한을 대신하지 않는다.
"""

from copy import deepcopy
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, create_model

from . import constants


REVISION_PATTERN = r"^[0-9a-f]{64}$"
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


class ContextInput(BaseModel):
    # domain은 업무 영역, viewpoints는 업무/개발/구조 관점이다. tenant 접근 권한과는 별개다.
    # extra='forbid'는 알 수 없는 필드를 거부하고 strict=True는 자료형 자동 변환을 막는다.
    model_config = ConfigDict(extra="forbid", strict=True)

    domain: EvidenceInput | None = None
    # default_factory=list는 입력마다 새로운 빈 목록을 만들어 서로 섞이지 않게 한다.
    viewpoints: Annotated[list[ViewpointInput], Field(max_length=3)] = Field(default_factory=list)


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


def _relation_schema(template, version):
    """형식 버전별 관계를 만든다. 원문 인용/참조의 실제 유효성은 저장 검증기가 확인한다."""
    normal = deepcopy(template)
    normal["properties"].pop("mapping")
    normal["required"] = [name for name in normal["required"] if name != "mapping"]
    predicates = constants.RELATION_PREDICATES if version < 5 else constants.V5_RELATION_PREDICATES
    normal["properties"]["predicate"] = {"type": "string", "enum": sorted(predicates - {"maps_to"})}
    if version == 3:
        # v3 관계의 끝점은 문서 내부 개체 ID만 가능하다. v4부터 정확 원문 앵커를 허용한다.
        for endpoint in ("subject", "object"):
            choices = normal["properties"][endpoint]["anyOf"]
            normal["properties"][endpoint] = deepcopy(next(choice for choice in choices if choice.get("type") == "string"))
    if version < 5:
        return normal
    mapping = deepcopy(template)
    mapping["properties"]["predicate"] = {"type": "string", "enum": ["maps_to"]}
    mapping["properties"]["mapping"] = {"$ref": "#/$defs/MappingInput"}
    mapping["required"] = list(dict.fromkeys([*mapping["required"], "mapping"]))
    variants = [normal, mapping]
    if version == 6:
        record = deepcopy(normal)
        record["properties"]["predicate"] = {"type": "string", "enum": sorted(constants.V6_SOURCE_RECORD_PREDICATES)}
        record["properties"]["subject"] = deepcopy(next(
            choice for choice in template["properties"]["subject"]["anyOf"] if choice.get("type") == "string"))
        record["properties"]["object"] = {"$ref": "#/$defs/SourceAnchorInput"}
        # 출처 기재의 존재만 주장한다. 옛 질문/가정을 현재 사실·승인으로 바꾸지 않는다.
        record["properties"]["qualifiers"] = {"$ref": "#/$defs/SourceRecordQualifiers"}
        variants.append(record)
    return {"anyOf": variants}


def select_submission_schema(schema, schema_version=3):
    """발행된 전체 스키마에서 명시 버전 한 개를 선택한다. 원본/호출 인자를 변경하지 않는다."""
    if type(schema_version) is not int or schema_version not in (3, 4, 5, 6):
        raise ValueError("Unsupported submission schema version.")
    try:
        value = deepcopy(schema["$defs"][f"SubmissionV{schema_version}"])
        if value["properties"]["schema_version"] != {"type": "integer", "enum": [schema_version]}:
            raise ValueError()
        value["$defs"] = deepcopy(schema["$defs"])
        return value
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("The published schema has no matching version contract.") from error


# deepcopy한 JSON 스키마만 강화한다. 기존 MCP 입력 모델의 기본값이나 도구 인자는 변경하지 않는다.
def build_submission_schema():
    """기존 MCP의 기본값은 건드리지 않고 공통 제출에서만 다섯 키를 요구한다."""
    model = create_model(
        "ExtractionSubmission", __config__=ConfigDict(extra="forbid", strict=True),
        schema_version=(Literal[3, 4, 5, 6], ...),
        entities=(Annotated[list[EntityInput], Field(max_length=constants.MAX_ENTITIES)], ...),
        relations=(Annotated[list[RelationInput], Field(max_length=constants.MAX_RELATIONS)], ...),
        relation_candidates=(Annotated[list[RelationCandidateInput], Field(max_length=constants.MAX_RELATION_CANDIDATES)], ...),
        attributes=(Annotated[list[AttributeInput], Field(max_length=constants.MAX_ATTRIBUTES)], ...),
    )
    schema = deepcopy(model.model_json_schema())
    qualifiers = schema["$defs"]["QualifiersInput"]
    qualifiers["required"] = ["polarity", "modality", "condition", "scope", "time"]
    for field in qualifiers["properties"].values():
        field.pop("default", None)
    for name in ("RelationInput", "RelationCandidateInput", "AttributeInput"):
        required = schema["$defs"][name].setdefault("required", [])
        if "qualifiers" not in required:
            required.append("qualifiers")
    template = deepcopy(schema["$defs"]["RelationInput"])
    source_qualifiers = deepcopy(qualifiers)
    for name, value in constants._QUALIFIER_DEFAULTS.items():
        source_qualifiers["properties"][name] = (
            {"type": "null"} if value is None else {"type": "string", "enum": [value]})
    schema["$defs"]["SourceRecordQualifiers"] = source_qualifiers
    # 전체 형식의 공통 RelationInput도 mapping:null 같은 저장 불가 입력을 허용하지 않는다.
    schema["$defs"]["RelationInput"] = {"$ref": "#/$defs/RelationV6"}
    for version in (3, 4, 5, 6):
        schema["$defs"][f"RelationV{version}"] = _relation_schema(template, version)
        branch = {key: deepcopy(value) for key, value in schema.items() if key != "$defs"}
        branch["properties"]["schema_version"] = {"type": "integer", "enum": [version]}
        branch["properties"]["relations"]["items"] = {"$ref": f"#/$defs/RelationV{version}"}
        schema["$defs"][f"SubmissionV{version}"] = branch
    schema["anyOf"] = [{"$ref": f"#/$defs/SubmissionV{version}"} for version in (3, 4, 5, 6)]
    return schema
