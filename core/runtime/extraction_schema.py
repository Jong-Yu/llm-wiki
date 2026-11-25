"""공통 제출 스키마의 기존 import 경로를 보존한다. 구현은 업무 모듈이 소유한다."""

from core.modules.ontology.submission import (
    _relation_schema,
    build_submission_schema,
    select_submission_schema,
)
