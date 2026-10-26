# 기존 MCP 모델을 바탕으로 공통 분석 제출의 JSON 형식 규칙을 만든다.
# 스키마는 JSON의 허용 필드/자료형/필수 항목을 설명하며, 본문의 의미가 옳다는 판정은 아니다.

"""현행 MCP 모델에서 새 공통 제출의 명시적 한정어 스키마를 조립한다."""

from typing import Annotated, Literal
from copy import deepcopy
from pydantic import ConfigDict, Field, create_model

from core.mcp.schemas import AttributeInput, EntityInput, RelationCandidateInput, RelationInput
from core.modules.ontology import constants


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
