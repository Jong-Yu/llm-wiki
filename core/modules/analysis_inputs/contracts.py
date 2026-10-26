"""고정 입력의 별도 한도와 공개 실패를 정의한다."""

# 단계마다 필요한 권한이 다르다. 입력 준비 권한이 위키/그래프 전체의 쓰기 허가를 뜻하지 않는다.
# 바이트 한도와 문자 페이지 한도를 구분해 한글·이모지의 크기를 잘못 계산하지 않게 한다.

from core.modules.analysis_jobs.contracts import identifier, revision

STAGES = {"read_source": "source_write", "prepare_wiki": "write", "extract_ontology": "ontology_write"}
MAX_BUNDLE_BYTES = 8 * 1024 * 1024
MAX_EXTRACTION_BYTES = 4 * 1024 * 1024
MAX_BUNDLES = 100
MAX_EXTRACTIONS = 100
MAX_CONTEXT_DOCUMENTS = 8
MAX_PAGE_CHARACTERS = 65536


class InputValidationError(ValueError):
    """입력 선택이나 제출 형식이 계약과 다르다."""


class InputCorruptError(ValueError):
    """불변 입력/추출물과 hash·계보가 맞지 않는다."""


class InputLimitError(ValueError):
    """기존 자료를 보존하고 입력/출력 한도에서 멈춘다."""


class InputConflictError(Exception):
    def __init__(self, code="input_basis_changed", **details):
        self.code, self.details = code, details
        super().__init__("Read the current inputs and reconcile the changed basis.")


def stage_permission(stage):
    # 알려진 단계 이름만 받아 해당 행동 권한 이름을 돌려준다. 임의 단계/권한으로 바꾸지 않는다.
    if type(stage) is not str or stage not in STAGES:
        raise InputValidationError("Select a supported extraction stage.")
    return STAGES[stage]


def text_list(value):
    # 경고/누락 사유는 짧은 문자열 목록만 허용한다. 받은 목록을 복사해 반환한다.
    if type(value) is not list or len(value) > 100 or any(type(item) is not str or len(item) > 1000 for item in value):
        raise InputValidationError("Use bounded text warnings and omissions.")
    return list(value)
