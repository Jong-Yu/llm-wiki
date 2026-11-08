"""질문 대화의 AI 세션을 이 PC에 기억해 다음 질문을 resume으로 이어 가게 한다.

서버는 대화 기록의 정본이고, 여기에는 이 PC에서 관측한 AI 세션 ID만 둔다. 세션은 이 PC의 AI
도구에만 있으므로 서버로 보내지 않는다. 조건이 하나라도 어긋나면 조용히 이어 가지 않고
호출자가 전체 대화를 다시 넣는 새 세션으로 시작하게 한다. 토큰·대화 내용은 저장하지 않는다.
"""

import json
import os
from pathlib import Path
import re
from uuid import UUID, uuid4

from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import private_directory, read_private, open_new
from core.client.session_refs import SessionRefs, binding
from core.client.transport import AnalysisClientError

_ID = re.compile(r"^[0-9a-f]{32}$")
_FIELDS = {"version", "conversation_id", "provider", "session_id", "turns_seen", "basis_sha256"}


def pointer_name(conversation_id, provider):
    """앱 메인이 같은 이름으로 존재 여부를 확인하므로 이 규칙을 바꾸면 함께 바꾼다."""
    if _ID.fullmatch(conversation_id or "") is None or provider not in {"codex", "claude"}:
        raise AnalysisClientError("question_session_invalid")
    return f"{conversation_id}.{provider}.json"


class QuestionSessions:
    def __init__(self, root):
        self.root = Path(root).absolute()
        self.pointers = self.root / "pointers"
        self.refs = SessionRefs(self.root / "refs")

    @staticmethod
    def _scope(*, server, tenant, user_id, profile, conversation_id):
        # 기존 세션 기록의 묶음 규칙을 재사용하되 대상은 문서가 아니라 대화다.
        return binding(server=server, tenant=tenant, user_id=user_id, profile=profile,
                       document="conversation:" + conversation_id)

    def lookup(self, adapter, *, server, tenant, user_id, profile, conversation_id, provider,
               preceding_turns, basis_sha256):
        """이어 갈 수 있으면 (세션 ID, 세션이 이미 본 턴 수)를, 아니면 None을 돌려준다. 어떤 실패도 오류로 올리지 않는다.

        대화 기록은 뒤에 덧붙기만 하므로 세션이 본 턴 수가 지금 앞선 턴 수 이하이면 앞부분이 같다.
        모르는 턴만 호출자가 이어 붙인다(다른 AI나 다른 PC에서 대화가 진행된 경우).
        """
        try:
            raw = json.loads(read_private(self.pointers / pointer_name(conversation_id, provider), 4096))
            if (type(raw) is not dict or set(raw) != _FIELDS or raw["version"] != 1
                    or raw["conversation_id"] != conversation_id or raw["provider"] != provider
                    or type(raw["turns_seen"]) is not int or not 0 < raw["turns_seen"] <= preceding_turns
                    or raw["basis_sha256"] != basis_sha256):
                return None
            session_id = str(UUID(raw["session_id"]))
            scope = self._scope(server=server, tenant=tenant, user_id=user_id, profile=profile,
                                conversation_id=conversation_id)
            self.refs.restore(adapter, scope=scope, provider=provider, session_id=session_id)
            return session_id, raw["turns_seen"]
        except (OSError, ValueError, TypeError, KeyError, AnalysisClientError):
            return None

    def remember(self, *, server, tenant, user_id, profile, conversation_id, execution, invocation,
                 turns_seen, basis_sha256, new_session):
        """성공한 실행의 관측만 기록한다. 같은 대화의 포인터는 새 세션이나 늘어난 대화로 갱신한다.

        이어 간 실행은 세션 위치 기록을 바꾸지 않는다(처음 기록한 위치가 정본).
        """
        provider = execution.get("provider")
        scope = self._scope(server=server, tenant=tenant, user_id=user_id, profile=profile,
                            conversation_id=conversation_id)
        if new_session:
            self.refs.remember(scope=scope, execution=execution, invocation=invocation)
        record = {"version": 1, "conversation_id": conversation_id, "provider": provider,
                  "session_id": execution["session_id"], "turns_seen": turns_seen, "basis_sha256": basis_sha256}
        root = private_directory(self.pointers)
        temporary = root / ("." + uuid4().hex + ".part")
        try:
            with os.fdopen(open_new(temporary), "wb") as stream:
                stream.write(canonical_json_bytes(record))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, root / pointer_name(conversation_id, provider))
        finally:
            temporary.unlink(missing_ok=True)
        return record
