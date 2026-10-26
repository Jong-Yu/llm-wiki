"""검토/정책의 관점·세대·가시 상태를 계산하는 순수 함수다.

정책 적용 범위를 원문 검토와 구별하며 외부 자료나 잠금에 접근하지 않는다.
"""

# 이 파일의 작은 함수들은 파일을 읽지 않고 전달받은 dict에서 상태만 계산한다.
# epoch는 원문·그래프·전체 이력의 묶음이다. 정책 활성 여부와 조건이 실제로 충족됐는지는 구분한다.
from copy import deepcopy
from . import contracts


def _is_policy(event):
    return event.get("action") in contracts._POLICY_ACTIONS


def _scope(actor):
    return {"domain": actor["domain"], "viewpoint": actor["viewpoint"]}


def _policy_context(scope):
    return {"domain": scope["domain"], "viewpoints": [] if scope["viewpoint"] is None else [scope["viewpoint"]]}


def _policy_key(event):
    # 같은 주장이라도 업무 영역/관점이 다르면 다른 정책이므로 세 값을 묶어 키로 쓴다.
    return event["claim_id"], event["scope"]["domain"], event["scope"]["viewpoint"]


def _inactive_policy():
    return {"decision": "inactive", "value": None, "entities": []}


def _visible_state(state):
    # reject/defer는 현재 유효 주장 값을 숨기되, 기록된 원장 자체는 그대로 남긴다.
    return {"decision": state["decision"], "value": None if state["decision"] in {"reject", "defer"} else deepcopy(state["value"])}


def _policy_visible(state, source_state):
    return {"decision": "policy", "value": deepcopy(state["value"])} if state["decision"] == "active" else _visible_state(source_state)


def _epoch(event):
    # tuple은 순서 있는 값 묶음이다. 세 revision이 모두 같아야 같은 원문/그래프/이력 세대다.
    return tuple(event[name] for name in ("source_revision", "graph_revision", "history_revision"))

