"""요청마다 현재 정책으로 접근을 판단한다. 관점 프로필은 조회 방식이며 권한이 아니다."""

# 읽는 순서: AccessPolicy.authorize → _load/_validate_policy → _authenticate.
# tenant는 자료를 나누는 작업 공간, profile은 같은 자료를 보는 업무 관점이다.
# AccessScope는 이번 호출에 허용된 사용자·저장소·관점을 묶은 값이며 다음 호출의 허가증으로 재사용하지 않는다.

from dataclasses import dataclass
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
from typing import Optional, Union

from core.modules.documents.store import DEFAULT_LOCK_TIMEOUT_SECONDS, WikiStore


MAX_POLICY_BYTES = 1024 * 1024
_ID = re.compile(r"[a-z][a-z0-9_-]{0,63}", re.ASCII)
_TOKEN = re.compile(r"[A-Za-z0-9_-]{32,256}", re.ASCII)
_DIGEST = re.compile(r"[0-9a-f]{64}", re.ASCII)
_PERSONAL_WRITES = frozenset({"conversation_write", "result_write", "comparison_write"})
# 새 개인 기록도 명시적으로 부여한 권한이 필요하다. 기존 write 권한에서 자동 상속하지 않는다.
_PERMISSIONS = frozenset({"read", "source_write", "write", "ontology_write", "ontology_review", "ontology_policy"}) | _PERSONAL_WRITES
_VIEWPOINTS = frozenset({"business", "developer", "architecture"})


class AccessDenied(Exception):
    """인증 실패와 권한 거부를 같은 메시지로 처리해 내부 구분을 노출하지 않는다."""

    def __init__(self):
        super().__init__("Access denied.")


class PolicyError(Exception):
    """정책 오류에 설정 내용·경로·tenant 존재 여부를 담지 않는다."""

    def __init__(self):
        super().__init__("Access policy is unavailable.")


@dataclass(frozen=True)
class AccessScope:
    user_id: str
    tenant: str
    profile_id: str
    domain: Optional[str]
    viewpoint: Optional[str]
    policy_revision: str
    store: WikiStore


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate policy key")
        result[key] = value
    return result


def _fields(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        raise ValueError("Invalid policy object")


def _id(value):
    if type(value) is not str or _ID.fullmatch(value) is None:
        raise ValueError("Invalid policy identifier")


def _unique_list(value):
    if type(value) is not list or any(type(item) is not str for item in value):
        raise ValueError("Invalid policy list")
    if len(value) != len(set(value)):
        raise ValueError("Duplicate policy list entry")


class AccessPolicy:
    """공개 호출마다 정책을 새로 읽고 검증해 권한 변경·토큰 폐기를 반영한다.

    승인은 해당 호출의 실행에 유효하며 실행 중 계속 재검사하지 않는다. 현재 사용자나
    tenant, 권한 캐시는 보관하지 않는다. 관리자는 정책을 원자적으로 교체해야 임시
    파싱 실패를 피할 수 있다. 권한 있는 로컬 프로세스의 파일시스템 변경까지 막는
    운영체제 격리 기능은 아니다.
    """

    def __init__(
        self,
        config_path: Union[str, Path],
        tenant_root: Union[str, Path],
        *,
        lock_timeout_seconds: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
    ):
        try:
            if isinstance(lock_timeout_seconds, bool) or not isinstance(
                lock_timeout_seconds, (int, float)
            ):
                raise ValueError("Invalid lock timeout")
            timeout = float(lock_timeout_seconds)
            if not math.isfinite(timeout) or timeout < 0:
                raise ValueError("Invalid lock timeout")
            self.config_path = Path(config_path).absolute()
            self.tenant_root = Path(tenant_root).absolute()
            if self.tenant_root.is_symlink() or not self.tenant_root.is_dir():
                raise ValueError("Invalid tenant root")
            self._root = self.tenant_root.resolve(strict=True)
            self.lock_timeout_seconds = timeout
        except (OSError, ValueError, TypeError, OverflowError, RuntimeError):
            raise PolicyError() from None

    def _load(self):
        # 현재 설정 파일을 바이트 한도 안에서 읽고 구조를 검증한 뒤 (정책, 정책 지문)을 반환한다.
        try:
            if (
                self.tenant_root.is_symlink()
                or self.tenant_root.resolve(strict=True) != self._root
                or not self._root.is_dir()
            ):
                raise ValueError("Tenant root changed")
            config = self.config_path.resolve(strict=True)
            if self.config_path.is_symlink() or config.is_relative_to(self._root):
                raise ValueError("Policy must be outside tenant storage")
            # 경로 검사 뒤 최종 파일이 링크/FIFO로 바뀌어도 따라가거나 읽기를 대기하지 않는다.
            descriptor = os.open(
                self.config_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            )
            with os.fdopen(descriptor, "rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise ValueError("Policy is not a regular file")
                raw = source.read(MAX_POLICY_BYTES + 1)
            if len(raw) > MAX_POLICY_BYTES:
                raise ValueError("Policy is too large")
            policy = json.loads(raw.decode("utf-8"), object_pairs_hook=_object)
            self._validate_policy(policy)
            return policy, sha256(raw).hexdigest()
        except (OSError, ValueError, TypeError, RuntimeError, RecursionError):
            raise PolicyError() from None

    def _validate_policy(self, policy):
        # 설정의 모든 사용자/tenant/관점을 검사한다. 존재하지 않는 소속이나 중복 토큰으로 권한을 추정하지 않는다.
        _fields(policy, {"version", "tenants", "users"})
        if type(policy["version"]) is not int or policy["version"] != 1:
            raise ValueError("Unsupported access policy")
        tenants = policy["tenants"]
        users = policy["users"]
        if type(tenants) is not dict or type(users) is not dict:
            raise ValueError("Invalid tenant or user registry")
        directory_ids = set()
        for tenant_id, tenant in tenants.items():
            _id(tenant_id)
            _fields(tenant, {"profiles"})
            directory = self._root / tenant_id
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError("Invalid tenant directory")
            if directory.resolve(strict=True) != directory:
                raise ValueError("Aliased tenant directory")
            info = directory.stat()
            identity = (info.st_dev, info.st_ino)
            if identity in directory_ids:
                raise ValueError("Aliased tenant directory")
            directory_ids.add(identity)
            profiles = tenant["profiles"]
            if type(profiles) is not dict or not profiles:
                raise ValueError("Invalid profiles")
            for profile_id, profile in profiles.items():
                _id(profile_id)
                _fields(profile, {"domain", "viewpoint"})
                domain = profile["domain"]
                if domain is not None and (
                    type(domain) is not str
                    or not domain.strip()
                    or domain != domain.strip()
                    or len(domain) > 1000
                ):
                    raise ValueError("Invalid profile domain")
                viewpoint = profile["viewpoint"]
                if viewpoint is not None and (
                    type(viewpoint) is not str or viewpoint not in _VIEWPOINTS
                ):
                    raise ValueError("Invalid profile viewpoint")
        digests = set()
        for user_id, user in users.items():
            _id(user_id)
            _fields(user, {"token_sha256", "memberships"})
            digest = user["token_sha256"]
            if type(digest) is not str or _DIGEST.fullmatch(digest) is None:
                raise ValueError("Invalid token digest")
            if digest in digests:
                raise ValueError("Ambiguous token ownership")
            digests.add(digest)
            memberships = user["memberships"]
            if type(memberships) is not dict:
                raise ValueError("Invalid memberships")
            for tenant_id, membership in memberships.items():
                if tenant_id not in tenants:
                    raise ValueError("Unknown membership tenant")
                _fields(membership, {"permissions", "profiles", "default_profile"})
                permissions = membership["permissions"]
                _unique_list(permissions)
                if not set(permissions) <= _PERMISSIONS:
                    raise ValueError("Unknown permission")
                if (({"source_write", "write", "ontology_write", "ontology_review", "ontology_policy"} | _PERSONAL_WRITES) & set(permissions)) and "read" not in permissions:
                    raise ValueError("Writers require read permission")
                allowed = membership["profiles"]
                _unique_list(allowed)
                if not allowed or not set(allowed) <= set(tenants[tenant_id]["profiles"]):
                    raise ValueError("Unknown allowed profile")
                default = membership["default_profile"]
                if type(default) is not str or default not in allowed:
                    raise ValueError("Invalid default profile")

    @staticmethod
    def _authenticate(policy, token):
        # 원문 토큰을 저장된 지문과 비교해 user_id를 반환한다. 토큰 내용은 조회 응답에 넣지 않는다.
        if type(token) is not str or _TOKEN.fullmatch(token) is None:
            raise AccessDenied()
        digest = sha256(token.encode("ascii")).hexdigest()
        matched = None
        # 원문 토큰 대신 해시를 비교하고, 일치 위치에서 조기 반환하지 않는다.
        for user_id, user in policy["users"].items():
            if secrets.compare_digest(digest, user["token_sha256"]):
                matched = user_id
        if matched is None:
            raise AccessDenied()
        return matched

    def validate(self):
        """저장소를 만들지 않고 정책과 기존 루트 디렉터리만 검증한다."""
        self._load()

    def authenticate(self, token: str) -> str:
        policy, _ = self._load()
        return self._authenticate(policy, token)

    def describe(self, token: str) -> dict:
        # 인증된 본인의 소속/권한/허용 관점만 새 dict로 반환한다. 다른 사용자 목록을 돌려주지 않는다.
        policy, revision = self._load()
        user_id = self._authenticate(policy, token)
        memberships = {}
        for tenant, membership in policy["users"][user_id]["memberships"].items():
            memberships[tenant] = {
                "permissions": list(membership["permissions"]),
                "profiles": {
                    name: dict(policy["tenants"][tenant]["profiles"][name])
                    for name in membership["profiles"]
                },
                "default_profile": membership["default_profile"],
            }
        return {"user_id": user_id, "memberships": memberships, "policy_revision": revision}

    def authorize(self, token, tenant, permission, profile=None) -> AccessScope:
        # 자료를 읽기 전에 사용자 → 소속 → 행동 권한 → 선택 관점을 확인하고 그 저장소를 담은 AccessScope를 만든다.
        policy, revision = self._load()
        user_id = self._authenticate(policy, token)
        memberships = policy["users"][user_id]["memberships"]
        if (
            type(tenant) is not str
            or type(permission) is not str
            or permission not in _PERMISSIONS
            or tenant not in memberships
        ):
            raise AccessDenied()
        membership = memberships[tenant]
        if permission not in membership["permissions"]:
            raise AccessDenied()
        selected = membership["default_profile"] if profile is None else profile
        if type(selected) is not str or selected not in membership["profiles"]:
            raise AccessDenied()
        definition = policy["tenants"][tenant]["profiles"][selected]
        # 소속·행동 권한·허용 관점을 확인한 뒤에만 tenant 저장소를 만들고 본문에 접근한다.
        try:
            store = WikiStore(
                self._root / tenant, lock_timeout_seconds=self.lock_timeout_seconds
            )
        except (OSError, ValueError, TypeError, RuntimeError):
            raise PolicyError() from None
        return AccessScope(
            user_id=user_id,
            tenant=tenant,
            profile_id=selected,
            domain=definition["domain"],
            viewpoint=definition["viewpoint"],
            policy_revision=revision,
            store=store,
        )
