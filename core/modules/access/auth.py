"""소규모 이름 로그인과 복구 가능한 단일 토큰. 정책 확정이 가입의 commit 지점이다."""

from contextlib import contextmanager
import errno
import fcntl
from hashlib import sha256
import json
import logging
import os
from pathlib import Path
import secrets
import stat
import tempfile
import time
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken

from core.common.json_codec import canonical_json_bytes
from core.modules.access.policy import (
    AccessPolicy, PolicyError, MAX_POLICY_BYTES, _PERMISSIONS, _TOKEN, _id, _object,
    normalize_name,
)
from core.modules.documents.store import StorageBusyError

_LOGGER = logging.getLogger(__name__)


class AuthError(Exception):
    """HTTP에 공개해도 되는 고정 오류만 보관한다."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _read_private(path, maximum):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError("Invalid private file")
        value = stream.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError("Private file too large")
    return value


def _publish(path, content, *, replace=False):
    """전체 파일 fsync 후 게시한다. 신규 파일은 기존 이름을 덮어쓰지 않는다."""
    descriptor, temporary = tempfile.mkstemp(prefix=".auth-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
        _sync_directory(path.parent)
    finally:
        # 공개 후 임시 파일 정리 실패 때문에 새 가입/토큰을 만들도록 유도하지 않는다.
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        except OSError:
            _LOGGER.warning("Authentication temporary file cleanup is pending.")


class AuthService:
    def __init__(self, policy: AccessPolicy, *, key_path=None):
        self.policy = policy
        policy.validate()
        self.directory = policy.config_path.parent.resolve(strict=True)
        self.credentials = self.directory / "credentials"
        self.pending = self.directory / ".signup.pending.json"
        self.key_path = Path(key_path or os.environ.get("LLM_WIKI_CREDENTIAL_KEY_FILE")
                             or self.directory / "credential.key").absolute()
        with self._guard():
            policy.validate()
            if self.directory.is_relative_to(policy._root):
                raise ValueError("Private files must be outside data")
            if self.credentials.is_symlink():
                raise ValueError("Aliased credentials")
            self.credentials.mkdir(mode=0o700, exist_ok=True)
            if not self.credentials.is_dir() or self.credentials.stat().st_mode & 0o077:
                raise ValueError("Unprotected credentials")
            key_location = self.key_path.resolve(strict=False)
            if (self.key_path.is_symlink() or key_location.is_relative_to(policy._root)
                    or key_location.is_relative_to(self.credentials)
                    or key_location in {policy.config_path.resolve(), self.pending,
                                        self.directory / ".auth.lock"}):
                raise ValueError("Invalid key location")
            if not self.key_path.exists():
                # 예전 개인 런처의 평문 .token은 이 키로 암호화한 자료가 아니다.
                # 이관/삭제 없이 보존하되 암호문·미완료 가입·알 수 없는 항목은 키 손실로 막는다.
                if (any(path.suffix != ".token" or not stat.S_ISREG(path.lstat().st_mode)
                        for path in self.credentials.iterdir())
                        or self.pending.exists() or self.pending.is_symlink()):
                    raise ValueError("Missing existing key")
                _publish(self.key_path, Fernet.generate_key())
            key = _read_private(self.key_path, 128).strip()
            self._cipher = Fernet(key)
            self._key_digest = sha256(key).hexdigest()
            self._recover()
            # 잘못 교체된 키로 새 가입만 성공시키지 않는다. 기존 사용자 토큰 변경 자체는
            # 관리자 정책의 권한이며 현재 해시와의 일치는 로그인 때 별도로 검사한다.
            for path in self.credentials.glob("*.enc"):
                self._cipher.decrypt(_read_private(path, 4096))

    @contextmanager
    def _guard(self):
        try:
            with self._lock():
                if self.credentials.is_symlink():
                    raise ValueError("Aliased credentials")
                if hasattr(self, "_key_digest") and not secrets.compare_digest(
                    sha256(_read_private(self.key_path, 128).strip()).hexdigest(), self._key_digest
                ):
                    raise ValueError("Credential key changed")
                yield
        except StorageBusyError:
            raise
        except (OSError, ValueError, TypeError, RuntimeError, InvalidToken, RecursionError):
            raise PolicyError() from None

    @contextmanager
    def _lock(self):
        descriptor = os.open(self.directory / ".auth.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ValueError("Invalid lock")
            deadline = time.monotonic() + self.policy.lock_timeout_seconds
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as error:
                    if error.errno not in {errno.EAGAIN, errno.EWOULDBLOCK}:
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise StorageBusyError(self.policy.lock_timeout_seconds) from None
                    time.sleep(min(0.05, remaining))
            yield
        finally:
            os.close(descriptor)

    def _credential_path(self, user_id):
        _id(user_id)
        return self.credentials / (user_id + ".enc")

    def _encrypt(self, user_id, token):
        return self._cipher.encrypt(canonical_json_bytes({"user_id": user_id, "token": token}))

    def _decode(self, content, user_id):
        value = json.loads(self._cipher.decrypt(content), object_pairs_hook=_object)
        if (type(value) is not dict or set(value) != {"user_id", "token"}
                or value["user_id"] != user_id or type(value["token"]) is not str
                or _TOKEN.fullmatch(value["token"]) is None):
            raise ValueError("Invalid credential")
        return value["token"]

    def _decrypt(self, content, user_id, policy):
        token = self._decode(content, user_id)
        if (user_id not in policy["users"]
                or not secrets.compare_digest(sha256(token.encode("ascii")).hexdigest(),
                                               policy["users"][user_id]["token_sha256"])):
            raise ValueError("Credential does not match policy")
        return token

    def _recover(self):
        """내구성 있는 가입 의도는 같은 ID/암호문으로 완료한다. 관리자 변경은 덮어쓰지 않는다."""
        if not self.pending.exists() and not self.pending.is_symlink():
            return
        pending = json.loads(_read_private(self.pending, 2 * MAX_POLICY_BYTES), object_pairs_hook=_object)
        if (type(pending) is not dict or set(pending) != {
                "base_revision", "policy", "user_id", "credential", "new_tenant"}
                or type(pending["new_tenant"]) is not bool
                or type(pending["credential"]) is not str
                or type(pending["base_revision"]) is not str):
            raise ValueError("Invalid pending signup")
        desired = pending["policy"]
        self.policy._validate_policy(desired, pending_tenants={"sdv-platform"} if pending["new_tenant"] else ())
        encoded = canonical_json_bytes(desired)
        if len(encoded) > MAX_POLICY_BYTES:
            raise ValueError("Policy too large")
        user_id = pending["user_id"]
        path = self._credential_path(user_id)
        encrypted = pending["credential"].encode("ascii")
        self._decrypt(encrypted, user_id, desired)
        current, revision = self.policy._load()
        committed = revision == sha256(encoded).hexdigest()
        if not committed and revision != pending["base_revision"]:
            raise ValueError("Policy changed during signup")
        if not committed and pending["new_tenant"]:
            directory = self.policy._root / "sdv-platform"
            if "sdv-platform" in current["tenants"]:
                raise ValueError("Workspace changed during signup")
            if directory.exists():
                if directory.is_symlink() or not directory.is_dir() or any(directory.iterdir()):
                    raise ValueError("Unowned workspace content")
            else:
                directory.mkdir(mode=0o700)
            _sync_directory(self.policy._root)
        self.policy._validate_policy(desired)
        if path.exists() or path.is_symlink():
            if _read_private(path, 4096) != encrypted:
                raise ValueError("Credential changed during signup")
        else:
            _publish(path, encrypted)
        if not committed:
            self._commit_policy(encoded)
        try:
            self.pending.unlink()
            _sync_directory(self.directory)
        except OSError:
            # 정책 확정 뒤에는 이미 성공이다. 다음 호출에서 같은 기록을 재확인/정리한다.
            _LOGGER.warning("Signup committed; recovery record cleanup is pending.")

    def _commit_policy(self, encoded):
        _publish(self.policy.config_path, encoded, replace=True)

    @staticmethod
    def _name(name):
        try:
            return normalize_name(name)
        except ValueError:
            raise AuthError(422, "invalid_name", "Use a name of 1 to 80 visible characters.") from None

    def signup(self, name):
        name = self._name(name)
        with self._guard():
            self._recover()
            policy, revision = self.policy._load()
            if any(user.get("display_name", uid) == name for uid, user in policy["users"].items()):
                raise AuthError(409, "name_conflict", "This name is already registered; log in instead.")
            if len(policy["users"]) >= 5:
                raise AuthError(409, "user_limit", "This PoC supports at most five users.")
            if self.pending.exists():
                raise PolicyError()
            tenant = "sdv-platform"
            new_tenant = tenant not in policy["tenants"]
            if new_tenant:
                directory = self.policy._root / tenant
                # 기존 자료를 새 workspace에 임의 편입하지 않는다.
                if directory.exists() or directory.is_symlink():
                    raise PolicyError()
                policy["tenants"][tenant] = {"display_name": "SDV 플랫폼",
                    "profiles": {"default": {"domain": None, "viewpoint": None}}}
            profiles = sorted(policy["tenants"][tenant]["profiles"])
            user_id, token = "user-" + uuid4().hex, secrets.token_urlsafe(48)
            policy["users"][user_id] = {
                "display_name": name, "token_sha256": sha256(token.encode("ascii")).hexdigest(),
                "auth_generation": 0, "default_tenant": tenant,
                "memberships": {tenant: {"permissions": sorted(_PERMISSIONS), "profiles": profiles,
                    "default_profile": "default" if "default" in profiles else profiles[0]}},
            }
            self.policy._validate_policy(policy, pending_tenants={tenant} if new_tenant else ())
            if len(canonical_json_bytes(policy)) > MAX_POLICY_BYTES:
                raise PolicyError()
            pending = {"base_revision": revision, "policy": policy, "user_id": user_id,
                       "credential": self._encrypt(user_id, token).decode("ascii"), "new_tenant": new_tenant}
            _publish(self.pending, canonical_json_bytes(pending))
            self._recover()
            return {"token": token, **self.policy.describe(token)}

    def login(self, name):
        name = self._name(name)
        with self._guard():
            self._recover()
            policy, revision = self.policy._load()
            for user_id, user in policy["users"].items():
                if user.get("display_name", user_id) == name:
                    token = self._decrypt(_read_private(self._credential_path(user_id), 4096), user_id, policy)
                    return {"token": token, **self.policy._describe_user(policy, revision, user_id)}
            raise AuthError(401, "login_failed", "The name is not registered.")

    def enroll_existing_token(self, user_id, token):
        """현재 정책 해시와 일치하는 관리자 보유 토큰만 등록/교체한다. 정책은 바꾸지 않는다."""
        with self._guard():
            self._recover()
            policy, _ = self.policy._load()
            if self.policy._authenticate(policy, token) != user_id:
                raise PolicyError()
            path = self._credential_path(user_id)
            if path.exists() or path.is_symlink():
                if self._decode(_read_private(path, 4096), user_id) != token:
                    _publish(path, self._encrypt(user_id, token), replace=True)
            else:
                _publish(path, self._encrypt(user_id, token))


def initialize_auth(policy: AccessPolicy, *, key_path=None) -> AuthService:
    """서버 조립용 진입점. 기존 정책/자료 검증 없이 자동 초기화하지 않는다."""
    try:
        return AuthService(policy, key_path=key_path)
    except StorageBusyError:
        raise
    except (OSError, ValueError, TypeError, RuntimeError):
        raise PolicyError() from None
