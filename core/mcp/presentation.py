"""MCP 클라이언트에 보이는 도구 이름(title)·동작 표시·스키마 정리를 한곳에서 관리한다.

여기의 값은 클라이언트의 승인 창·재시도 판단을 돕는 안내일 뿐이며, 실제 권한과 저장 규칙은
각 도구의 서버 검사가 결정한다.
"""

from mcp.types import ToolAnnotations


# 기존 자료를 지우거나 덮지 않고 새 기록·상태만 더하는 변경이다.
ADDITIVE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
# 같은 request_id와 같은 입력을 다시 보내면 저장된 영수증을 그대로 돌려주는 추가형 변경이다.
ADDITIVE_REPLAYABLE = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True,
                                      open_world_hint=False)
# 기존 결과를 바꾸거나 되돌리지만, 같은 request_id 재전송은 다시 적용하지 않고 영수증을 돌려준다.
REPLAYABLE_MUTATION = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True,
                                      open_world_hint=False)

# 승인 창 등에 보이는 짧은 한국어 이름. 확정한 화면 용어(버전·검토·반영·되돌리기 등)와
# 앱 화면의 기능 이름(Clean Up·관계 추가)을 그대로 쓴다.
TOOL_TITLES = {
    "access_context": "내 접근 권한 확인",
    "wiki_guidance": "작업 안내 보기",
    "wiki_read": "위키 문서 읽기",
    "wiki_write": "위키 문서 저장",
    "wiki_search": "위키 문서 검색",
    "wiki_list": "위키 문서 목록",
    "wiki_history_query": "문서 변경 이력 조회",
    "wiki_versions": "문서 버전 목록",
    "wiki_version_read": "문서 이전 버전 읽기",
    "wiki_restore": "문서 이전 버전 복원",
    "ontology_validate_draft": "추출 결과 초안 검사",
    "ontology_generate": "문서 온톨로지 저장",
    "ontology_query": "온톨로지 조회",
    "ontology_context": "원문과 온톨로지 함께 읽기",
    "ontology_connections": "문서 간 연결 후보 조회",
    "ontology_impact": "변경 영향 문서 찾기",
    "ontology_review_query": "검토 반영 결과 조회",
    "ontology_review_queue": "검토 대기 목록",
    "ontology_review": "검토 판단 기록",
    "ontology_review_undo": "검토 판단 되돌리기",
    "ontology_policy": "전문가 정책 기록",
    "ontology_policy_undo": "전문가 정책 되돌리기",
    "ontology_relation_create": "관계 추가",
    "ontology_relation_undo": "관계 추가 되돌리기",
    "ontology_relation_request": "관계 추가 저장 확인",
    "ontology_cleanup_preview": "Clean Up 미리보기",
    "ontology_cleanup_apply": "Clean Up 반영",
    "ontology_cleanup_undo": "Clean Up 되돌리기",
    "ontology_cleanup_history": "Clean Up 이력",
    "ontology_cleanup_request": "Clean Up 저장 확인",
    "ontology_correspondence_find": "문서 간 대응 찾기",
    "ontology_correspondence_query": "문서 간 대응 조회",
    "ontology_correspondence_prepare": "대응 변경 준비",
    "ontology_correspondence_propose": "대응 제안 등록",
    "ontology_correspondence_review": "대응 검토 판단 기록",
    "ontology_correspondence_review_undo": "대응 검토 판단 되돌리기",
    "ontology_correspondence_policy": "대응 정책 기록",
    "ontology_correspondence_policy_undo": "대응 정책 되돌리기",
    "ontology_concept_find": "개념 찾기",
    "ontology_concept_query": "개념 지식 조회",
    "ontology_glossary_query": "용어 설명 조회",
    "knowledge_lookup": "지식 한 번에 찾기",
    "knowledge_context_prepare": "답변 근거 준비",
    "analysis_registration_create": "원본 기본 등록",
    "analysis_job_list": "분석 작업 목록",
    "analysis_job_query": "분석 작업 조회",
    "analysis_job_claim": "분석 작업 실행 시작",
    "analysis_job_heartbeat": "분석 작업 진행 알림",
    "analysis_job_update": "분석 작업 상태 보고",
    "analysis_job_cancel": "분석 작업 취소",
    "source_read": "원본 읽기",
    "extraction_rules_read": "추출 규약 읽기",
    "analysis_job_input_prepare": "분석 입력 준비",
    "analysis_job_input_read": "분석 입력 읽기",
    "source_extraction_submit": "원본 읽기 결과 제출",
    "analysis_job_wiki_write": "분석 결과 위키 저장",
    "analysis_job_ontology_generate": "분석 결과 온톨로지 저장",
    "analysis_job_result_query": "분석 결과 저장 확인",
}

# 값이 하위 스키마인 키워드. 이 맵의 키는 속성·정의 이름이므로 "title"이라는 이름도 보존한다.
_SCHEMA_MAPS = frozenset({"properties", "$defs", "definitions", "patternProperties", "dependentSchemas"})
# 값이 스키마가 아닌 실제 데이터인 키워드. 안의 "title" 키를 지우지 않는다.
_DATA_KEYWORDS = frozenset({"default", "const", "enum", "examples"})


def without_schema_titles(node):
    """Pydantic이 자동으로 붙인 스키마 title만 뺀 새 사본을 반환한다. 원본 스키마는 바꾸지 않는다."""
    if isinstance(node, list):
        return [without_schema_titles(value) for value in node]
    if not isinstance(node, dict):
        return node
    result = {}
    for key, value in node.items():
        if key == "title" and isinstance(value, str):
            continue
        if key in _SCHEMA_MAPS and isinstance(value, dict):
            result[key] = {name: without_schema_titles(child) for name, child in value.items()}
        elif key in _DATA_KEYWORDS:
            result[key] = value
        else:
            result[key] = without_schema_titles(value)
    return result
