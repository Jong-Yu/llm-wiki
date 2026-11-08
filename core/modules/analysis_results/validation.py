"""제출 형식을 확인하고 자동 검사 보고서를 만든다.

스키마(schema)는 JSON에 어떤 필드·자료형이 있어야 하는지 정한 규칙이다.
형식 검사는 할 수 있지만 문장의 의미가 정확한지, 사람이 승인했는지는 증명하지 않는다.
실제 원문 인용·그래프 구조 검사는 기존 OntologyStore의 검증기를 함께 사용한다.
"""

import re

from jsonschema import Draft202012Validator

from core.common.json_codec import canonical_json_bytes

from .contracts import ResultError
from . import rule_checks


def execution_report(value):
    """클라이언트가 신고한 실행 정보의 모양만 확인한다. 실제 모델 실행을 인증하지 않는다."""
    if value is None:
        return None
    required = {"provider", "cli_version", "prompt_sha256", "schema_sha256", "output_sha256"}
    optional = {"requested_model", "reported_model", "published_schema_sha256", "execution_config_sha256"}
    # 허용한 키만 받는다. 사용자 신원/시각/승인 여부는 서버가 관리하는 다른 기록의 책임이다.
    if (type(value) is not dict or not required <= value.keys() or set(value) - required - optional
            or value["provider"] not in ("codex", "claude") or len(canonical_json_bytes(value)) > 4096):
        raise ResultError("invalid_execution_report")
    for name in ("cli_version", "requested_model", "reported_model"):
        text = value.get(name)
        if name != "cli_version" and text is None:
            continue
        maximum = 100 if name == "cli_version" else 200
        if (type(text) is not str or not text.strip() or len(text) > maximum
                or any(ord(character) < 32 or ord(character) == 127 for character in text)):
            raise ResultError("invalid_execution_report")
    for name in ("prompt_sha256", "schema_sha256", "output_sha256", "published_schema_sha256", "execution_config_sha256"):
        if name in value and (type(value[name]) is not str or re.fullmatch(r"[0-9a-f]{64}", value[name]) is None):
            raise ResultError("invalid_execution_report")
    # 새 dict를 반환해 원래 제출값은 바꾸지 않는다. origin은 서버가 붙이는 출처 구분이지 승인 표시가 아니다.
    return {"origin": "client_reported", **value}


def report(stage, *, status="not_run", code=None):
    """화면/클라이언트에 보낼 검사 보고 dict를 만든다. 이 함수 자체가 검사를 실행하지는 않는다.

    stage는 위키 작성/그래프 추출 단계, status는 실제 실행 결과, code는 실패 코드다.
    R-Axx는 결정 문서에 정의된 검사 번호다. 의미 점검은 별도이므로 항상 구분해 표시한다.
    """
    graph = stage == "extract_ontology"
    checks = [{"rule_ids": ["R-A01", "R-A02", "R-A03", "R-A04"],
               "checker": "current_fixed_input_guard", "status": status},
              {"rule_ids": ["R-A05", "R-A06", "R-A07", "R-A09", "R-A10"] if graph else ["R-A05"],
               "checker": "existing_ontology_validator" if graph else "existing_wiki_store", "status": status}]
    if graph:
        checks.append({"rule_ids": ["R-A08"], "checker": "published_raw_submission_schema", "status": status})
    return {"automatic": status, "checks": checks, "error_code": code,
            "semantic": {"status": "not_run", "human_approval": False},
            "assurance": "specified_automatic_checks_only", "rule_results": rule_checks.initial(stage)}


def graph_submission(rulesets, submission):
    """현재 규약의 스키마로 원시 그래프 제출을 검사한다. 통과하면 반환값 없이 끝난다.

    실패하면 ResultError를 발생시켜 저장을 막는다. submission은 검사 중 수정하지 않는다.
    """
    schema = getattr(rulesets, "expected_schema", None)
    if type(schema) is not dict:
        raise ResultError("ruleset_incompatible")
    # MCP 모델의 기본값을 넣기 전에 검사한다. qualifier 키 생략과 명시적 null은 다르다.
    # iter_errors는 오류를 하나씩 내준다. next(..., None)은 첫 오류를 받거나,
    # 오류가 없으면 None을 받는다. 모든 오류를 한꺼번에 큰 목록으로 만들지 않는다.
    error = next(Draft202012Validator(schema).iter_errors(submission), None)
    if error is not None:
        # absolute_path는 잘못된 필드/배열 위치다. 응답에 넣을 경로 항목은 16개까지로 제한한다.
        raise ResultError("invalid_submission", submission_path=[str(part) for part in error.absolute_path][:16])
