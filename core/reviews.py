"""기존 core.reviews import의 명시 호환 진입점.

실제 구현은 core.modules.reviews에 있으며 새 내부 소비자는 그 소유 모듈을
직접 참조한다. 같은 클래스/오류를 노출해 기존 외부 진입과 fixture를 보존한다.
"""
# 검토 구현은 modules/reviews/, JSON 변환은 common/을 재사용한다. 이 파일이 검토를 별도로 실행하지 않는다.
# 아래 as는 같은 함수에 예전 이름을 붙이는 표현이다. 새로운 인코더 함수를 만드는 것은 아니다.
from core.common.json_codec import (
    canonical_json_bytes as _encode, canonical_json_hash as _hash,
)
from core.modules.reviews.contracts import (
    MAX_HISTORY_ENTRIES, MAX_REVIEW_BYTES, MAX_REVIEW_EVENTS,
    _ACTIONS, _ACTOR_FIELDS, _COLLECTIONS, _DECISIONS, _EVENT_FIELDS,
    _HEX, _ID, _POLICY_ACTIONS, _POLICY_EVENT_FIELDS, _POLICY_PREFIX, _UUID,
    ReviewConflictError, ReviewCorruptError, ReviewLimitError, ReviewValidationError,
)
from core.modules.reviews.values import (
    _token, _reason, _actor, _input, _identity, _claim_id, _target_entities,
)
from core.modules.reviews.state import (
    _is_policy, _scope, _policy_context, _policy_key, _inactive_policy,
    _visible_state, _policy_visible, _epoch,
)
from core.modules.reviews.store import ReviewStore
