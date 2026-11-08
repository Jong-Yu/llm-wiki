"""실제 로컬 추출에서 관측한 AI 대화와 업무 범위를 보호 파일에 묶는다.

서버가 돌려준 대화 ID만으로 로컬 CLI를 재개하지 않는다. 기록은 불변이며
다른 범위나 폴더로 바꾸어 덮어쓰지 않는다. 토큰·대화 내용은 저장하지 않는다.
"""

from hashlib import sha256
import json
import os
from pathlib import Path
from uuid import UUID, uuid4

from core.common.json_codec import canonical_json_bytes
from core.runtime.client_platform import private_directory, read_private, open_new
from core.client.transport import AnalysisClientError


def registry_path(work_dir, selected=None):
    return Path(selected) if selected is not None else Path(work_dir) / "ai-session-refs"


def _directory(value, *, create=False):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or any(part.is_symlink() for part in (path, *path.parents)):
        raise AnalysisClientError("comparison_session_ref_unsafe")
    if not create and not path.is_dir():
        raise AnalysisClientError("comparison_session_directory_unavailable")
    try:
        return private_directory(path)
    except OSError as error:
        raise AnalysisClientError("comparison_session_ref_unsafe") from error


def binding(*, server, tenant, user_id, profile, document, job_id=None):
    from core.client.analysis import server_url
    values = dict(server=server_url(server), tenant=tenant, user_id=user_id, profile=profile,
                  document=document, job_id=job_id)
    if any(type(value) is not str or not value or len(value) > 4096
           for key, value in values.items() if key != "job_id"):
        raise AnalysisClientError("comparison_session_binding_invalid")
    if job_id is not None and (type(job_id) is not str or not job_id or len(job_id) > 128):
        raise AnalysisClientError("comparison_session_binding_invalid")
    return values


def _identity(provider, session_id):
    try:
        if provider not in {"codex", "claude"} or type(session_id) is not str or str(UUID(session_id)) != session_id:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise AnalysisClientError("comparison_session_ref_invalid") from None
    return sha256(canonical_json_bytes([provider, session_id])).hexdigest() + ".json"


class SessionRefs:
    def __init__(self, directory):
        self.directory = Path(directory).absolute()

    def _read(self, path):
        try:
            record = json.loads(read_private(path, 32768))
            if (type(record) is not dict or set(record) != {"version", "binding", "provider", "session_id", "session_directory"}
                    or record["version"] != 1 or type(record["binding"]) is not dict
                    or record["binding"] != binding(**record["binding"])
                    or type(record["session_directory"]) is not str):
                raise ValueError()
            _identity(record["provider"], record["session_id"])
            return record
        except FileNotFoundError:
            raise AnalysisClientError("comparison_session_ref_unknown") from None
        except (OSError, ValueError, TypeError, KeyError, AnalysisClientError) as error:
            raise AnalysisClientError("comparison_session_ref_invalid") from error

    def remember(self, *, scope, execution, invocation):
        """성공한 추출 어댑터의 관측만 받는다. 서버 응답으로 이 함수를 호출하지 않는다."""
        if execution.get("session_persisted") is not True:
            raise AnalysisClientError("comparison_session_ref_invalid")
        provider, session_id = execution.get("provider"), execution.get("session_id")
        name = _identity(provider, session_id)
        # Claude는 제공자가 실행한 원래 cwd, Codex는 실제 호출한 invocation을 기록한다.
        # Claude의 cwd가 없으면 새 작업 폴더로 추정하지 않는다.
        source = execution.get("session_directory") if provider == "claude" else str(Path(invocation).absolute())
        if type(source) is not str:
            raise AnalysisClientError("comparison_session_ref_invalid")
        record = {"version": 1, "binding": binding(**scope), "provider": provider, "session_id": session_id,
                  "session_directory": str(_directory(source))}
        root = _directory(self.directory, create=True)
        destination = root / name
        temporary = root / ("." + uuid4().hex + ".part")
        try:
            with os.fdopen(open_new(temporary), "wb") as stream:
                stream.write(canonical_json_bytes(record))
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, destination)
            except FileExistsError:
                if self._read(destination) != record:
                    raise AnalysisClientError("comparison_session_binding_mismatch") from None
        finally:
            temporary.unlink(missing_ok=True)
        return record

    def resolve(self, *, scope, provider, session_id):
        name = _identity(provider, session_id)
        if not self.directory.exists():
            raise AnalysisClientError("comparison_session_ref_unknown")
        root = _directory(self.directory)
        record = self._read(root / name)
        if (record["provider"] != provider or record["session_id"] != session_id
                or record["binding"] != binding(**scope)):
            raise AnalysisClientError("comparison_session_binding_mismatch")
        _directory(record["session_directory"])
        return record

    def restore(self, adapter, *, scope, provider, session_id):
        record = self.resolve(scope=scope, provider=provider, session_id=session_id)
        if provider == "claude":
            # 새 어댑터가 받은 서버 경로나 이번 결과 폴더를 cwd로 쓰지 않게 한다.
            adapter._session_directory = Path(record["session_directory"])
        return record
