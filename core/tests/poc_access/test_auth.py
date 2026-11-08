"""D-071 계약 검증. 모든 정책·자료·키는 임시 디렉터리에만 생성한다."""

from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from hashlib import sha256
import fcntl
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from core.modules.access.auth import AuthError, initialize_auth
from core.modules.access.policy import AccessDenied, AccessPolicy, PolicyError, _PERMISSIONS
from core.modules.documents.store import StorageBusyError
from core.runtime.application import create_application
from core.runtime.http_security import HttpAccessMiddleware
from starlette.applications import Starlette
import core.modules.access.auth as auth_module


def signup_worker(config, root, name):
    service = initialize_auth(AccessPolicy(config, root))
    try:
        return service.signup(name)
    except AuthError as error:
        return error.code


def login_worker(config, root, name):
    return initialize_auth(AccessPolicy(config, root)).login(name)


class AuthFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "data"
        self.root.mkdir()
        self.private = self.base / "tenancy"
        self.private.mkdir(mode=0o700)
        self.config = self.private / "policy.json"
        self.save_policy({"version": 1, "tenants": {}, "users": {}})
        self.policy = AccessPolicy(self.config, self.root)
        self.auth = initialize_auth(self.policy)

    def save_policy(self, value):
        self.config.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def load_policy(self):
        return json.loads(self.config.read_text())

    def restart(self):
        return initialize_auth(AccessPolicy(self.config, self.root))


class AccessTests(AuthFixture):
    def test_token_survives_separate_server_processes(self):
        context = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(max_workers=1, mp_context=context) as pool:
            first = pool.submit(signup_worker, str(self.config), str(self.root), "프로세스 재시작").result()
        with ProcessPoolExecutor(max_workers=1, mp_context=context) as pool:
            second = pool.submit(login_worker, str(self.config), str(self.root), "프로세스 재시작").result()
        self.assertEqual(first, second)

    def test_signup_login_restart_response_loss_and_secret_storage(self):
        first = self.auth.signup(" 홍길동 ")
        second = self.restart().login("홍길동")
        self.assertEqual(first, second)
        self.assertEqual(set(first), {"token", "user_id", "display_name", "memberships", "default_tenant",
                                      "policy_revision", "access_revision"})
        self.assertEqual(first["display_name"], "홍길동")
        self.assertEqual(first["default_tenant"], "sdv-platform")
        self.assertEqual(first["memberships"]["sdv-platform"]["display_name"], "SDV 플랫폼")
        self.assertEqual(set(first["memberships"]["sdv-platform"]["permissions"]), _PERMISSIONS)
        with self.assertRaises(AuthError) as caught:
            self.auth.signup("홍길동")
        self.assertEqual(caught.exception.code, "name_conflict")
        self.assertEqual(len(self.load_policy()["users"]), 1)
        for path in self.private.rglob("*"):
            if path.is_file():
                self.assertNotIn(first["token"].encode(), path.read_bytes())
        credential = self.private / "credentials" / (first["user_id"] + ".enc")
        self.assertEqual(credential.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.private / "credential.key").stat().st_mode & 0o777, 0o600)
        self.assertNotIn("token", self.policy.describe(first["token"]))

    def test_duplicate_signup_across_processes_has_one_token(self):
        context = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(max_workers=4, mp_context=context) as pool:
            results = list(pool.map(signup_worker, [str(self.config)] * 4,
                                    [str(self.root)] * 4, ["동시 가입"] * 4))
        successes = [value for value in results if isinstance(value, dict)]
        self.assertEqual(len(successes), 1)
        self.assertEqual(results.count("name_conflict"), 3)
        self.assertEqual(self.restart().login("동시 가입")["token"], successes[0]["token"])

    def test_concurrent_distinct_signups_respect_capacity(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: signup_worker(self.config, self.root, f"사용자 {i}"), range(8)))
        self.assertEqual(sum(isinstance(value, dict) for value in results), 5)
        self.assertEqual(results.count("user_limit"), 3)
        self.assertEqual(len(self.load_policy()["users"]), 5)
        self.assertEqual(len(list((self.private / "credentials").glob("*.enc"))), 5)

    def test_access_revision_ignores_other_users_names_and_json_formatting(self):
        first = self.auth.signup("첫째")
        self.auth.signup("둘째")
        current = self.policy.describe(first["token"])
        self.assertEqual(first["access_revision"], current["access_revision"])
        self.assertNotEqual(first["policy_revision"], current["policy_revision"])
        policy = self.load_policy()
        policy["users"][first["user_id"]]["display_name"] = "표시 이름 변경"
        policy["tenants"]["sdv-platform"]["display_name"] = "워크스페이스 표시"
        policy["users"][first["user_id"]]["memberships"]["sdv-platform"]["permissions"].reverse()
        self.config.write_text(json.dumps(policy, indent=4, ensure_ascii=False))
        self.assertEqual(first["access_revision"], self.policy.describe(first["token"])["access_revision"])

    def test_own_permissions_profiles_generation_and_token_change_revision(self):
        first = self.auth.signup("본인")
        baseline = first["access_revision"]
        policy = self.load_policy()
        user = policy["users"][first["user_id"]]
        user["memberships"]["sdv-platform"]["permissions"].remove("write")
        self.save_policy(policy)
        with self.assertRaises(AccessDenied):
            self.policy.authorize(first["token"], "sdv-platform", "write")
        revision = self.policy.describe(first["token"])["access_revision"]
        self.assertNotEqual(baseline, revision)
        policy["tenants"]["sdv-platform"]["profiles"]["default"]["domain"] = "새 의미"
        self.save_policy(policy)
        updated = self.policy.describe(first["token"])["access_revision"]
        self.assertNotEqual(revision, updated)
        user["auth_generation"] += 1
        self.save_policy(policy)
        revision = self.policy.describe(first["token"])["access_revision"]
        self.assertNotEqual(revision, updated)
        replacement = "R" * 48
        user["token_sha256"] = sha256(replacement.encode()).hexdigest()
        self.save_policy(policy)
        with self.assertRaises(AccessDenied):
            self.policy.authenticate(first["token"])
        with self.assertRaises(PolicyError):
            self.auth.login("본인")
        self.assertNotEqual(revision, self.policy.describe(replacement)["access_revision"])

    def test_recover_policy_commit_failure_without_rotating_token(self):
        before = self.config.read_bytes()
        with patch.object(self.auth, "_commit_policy", side_effect=OSError("secret path")):
            with self.assertRaises(PolicyError):
                self.auth.signup("중단")
        self.assertEqual(before, self.config.read_bytes())
        pending = json.loads(self.auth.pending.read_bytes())
        credential = self.private / "credentials" / (pending["user_id"] + ".enc")
        saved_cipher = credential.read_bytes()
        recovered = self.restart().login("중단")
        self.assertEqual(recovered["user_id"], pending["user_id"])
        self.assertEqual(saved_cipher, credential.read_bytes())
        self.assertEqual(self.auth._decrypt(saved_cipher, recovered["user_id"], self.load_policy()), recovered["token"])
        self.assertFalse(self.auth.pending.exists())

    def test_recover_credential_write_failure(self):
        original = auth_module._publish
        def fail_credential(path, content, **kwargs):
            if path.suffix == ".enc":
                raise OSError("credential unavailable")
            return original(path, content, **kwargs)
        with patch.object(auth_module, "_publish", side_effect=fail_credential):
            with self.assertRaises(PolicyError):
                self.auth.signup("암호문 실패")
        self.assertEqual(self.load_policy()["users"], {})
        self.assertEqual(self.restart().login("암호문 실패")["display_name"], "암호문 실패")

    def test_failure_before_journal_keeps_workspace_and_policy_unchanged(self):
        original = auth_module._publish
        def fail_pending(path, content, **kwargs):
            if path == self.auth.pending:
                raise OSError("no space")
            return original(path, content, **kwargs)
        with patch.object(auth_module, "_publish", side_effect=fail_pending):
            with self.assertRaises(PolicyError):
                self.auth.signup("재시도")
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.load_policy()["users"], {})
        self.assertEqual(self.auth.signup("재시도")["display_name"], "재시도")

    def test_recover_commit_succeeded_but_response_was_lost(self):
        original = self.auth._commit_policy
        def commit_then_fail(encoded):
            original(encoded)
            raise OSError("process interrupted after commit")
        with patch.object(self.auth, "_commit_policy", side_effect=commit_then_fail):
            with self.assertRaises(PolicyError):
                self.auth.signup("응답 유실")
        saved = self.config.read_bytes()
        result = self.restart().login("응답 유실")
        self.assertEqual(saved, self.config.read_bytes())
        self.assertEqual(len(self.load_policy()["users"]), 1)
        self.assertEqual(result["token"], self.auth.login("응답 유실")["token"])

    def test_pending_recovery_never_overwrites_admin_policy_change(self):
        with patch.object(self.auth, "_commit_policy", side_effect=OSError()):
            with self.assertRaises(PolicyError):
                self.auth.signup("보류")
        self.config.write_text('{ "version": 1, "tenants": {}, "users": {} }')
        saved = self.config.read_bytes()
        with self.assertRaises(PolicyError):
            self.restart()
        self.assertEqual(self.config.read_bytes(), saved)
        self.assertTrue(self.auth.pending.exists())

    def test_existing_version1_users_workspace_ids_and_personal_files_preserved(self):
        tenant = self.root / "old-workspace"
        tenant.mkdir()
        personal = tenant / "_personal" / "existing-user"
        personal.mkdir(parents=True)
        (personal / "keep.json").write_bytes(b"user owned")
        token = "E" * 48
        policy = {"version": 1, "tenants": {"old-workspace": {"profiles": {
            "business": {"domain": None, "viewpoint": "business"}}}}, "users": {
            "existing-user": {"token_sha256": sha256(token.encode()).hexdigest(), "memberships": {
                "old-workspace": {"permissions": ["read"], "profiles": ["business"], "default_profile": "business"}}}}}
        self.save_policy(policy)
        self.assertEqual(self.policy.authenticate(token), "existing-user")
        with self.assertRaises(PolicyError):
            self.auth.login("existing-user")
        self.auth.enroll_existing_token("existing-user", token)
        self.assertEqual(self.auth.login("existing-user")["token"], token)
        self.auth.signup("새 사람")
        self.assertEqual(self.load_policy()["users"]["existing-user"], policy["users"]["existing-user"])
        self.assertEqual(self.load_policy()["tenants"]["old-workspace"], policy["tenants"]["old-workspace"])
        self.assertEqual((personal / "keep.json").read_bytes(), b"user owned")

    def test_existing_sdv_workspace_profiles_are_not_replaced(self):
        (self.root / "sdv-platform").mkdir()
        tenant = {"profiles": {"architecture": {"domain": "기존", "viewpoint": "architecture"}}}
        self.save_policy({"version": 1, "tenants": {"sdv-platform": tenant}, "users": {}})
        result = self.auth.signup("연결")
        self.assertEqual(self.load_policy()["tenants"]["sdv-platform"], tenant)
        self.assertEqual(result["memberships"]["sdv-platform"]["default_profile"], "architecture")

    def test_unregistered_existing_workspace_is_not_adopted(self):
        target = self.root / "sdv-platform"
        target.mkdir()
        (target / "existing.md").write_text("preserve")
        with self.assertRaises(PolicyError):
            self.auth.signup("보존")
        self.assertEqual((target / "existing.md").read_text(), "preserve")
        self.assertEqual(self.load_policy()["users"], {})

    def test_missing_key_wrong_key_tampering_and_symlink_fail_closed(self):
        user = self.auth.signup("키 검증")
        key_path = self.private / "credential.key"
        key = key_path.read_bytes()
        key_path.unlink()
        with self.assertRaises(PolicyError):
            self.restart()
        self.assertFalse(key_path.exists())
        key_path.write_bytes(Fernet.generate_key())
        key_path.chmod(0o600)
        with self.assertRaises(PolicyError):
            self.restart().login("키 검증")
        key_path.write_bytes(key)
        credential = self.private / "credentials" / (user["user_id"] + ".enc")
        credential.write_bytes(b"tampered")
        with self.assertRaises(PolicyError):
            self.auth.login("키 검증")
        credential.unlink()
        credential.symlink_to(key_path)
        with self.assertRaises(PolicyError):
            self.auth.login("키 검증")

    def test_missing_key_does_not_replace_unknown_credentials_or_pending_records(self):
        cases = ("encrypted", "unknown", "directory", "symlink", "dangling", "fifo",
                 "pending", "pending_symlink")
        for case in cases:
            with self.subTest(case=case):
                private = self.base / case
                private.mkdir(mode=0o700)
                credentials = private / "credentials"
                credentials.mkdir(mode=0o700)
                config = private / "policy.json"
                original = self.config.read_bytes()
                config.write_bytes(original)
                target = credentials / "user.token"
                if case == "encrypted":
                    (credentials / "user.enc").write_bytes(b"existing ciphertext")
                elif case == "unknown":
                    (credentials / "unknown.backup").write_bytes(b"preserve")
                elif case == "directory":
                    target.mkdir()
                elif case == "symlink":
                    target.symlink_to(config)
                elif case == "dangling":
                    target.symlink_to(private / "absent")
                elif case == "fifo":
                    os.mkfifo(target)
                elif case == "pending":
                    (private / ".signup.pending.json").write_bytes(b"preserve pending")
                else:
                    (private / ".signup.pending.json").symlink_to(private / "absent")
                with self.assertRaises(PolicyError):
                    initialize_auth(AccessPolicy(config, self.root))
                self.assertFalse(os.path.lexists(private / "credential.key"))
                self.assertEqual(config.read_bytes(), original)

    def test_invalid_policy_does_not_create_replacement_data_or_credentials(self):
        self.config.write_text("invalid")
        before = sorted(str(p) for p in self.base.rglob("*"))
        with self.assertRaises(PolicyError):
            self.restart()
        self.assertEqual(before, sorted(str(p) for p in self.base.rglob("*")))
        with self.assertRaises(PolicyError):
            AccessPolicy(self.config, self.base / "missing")
        self.assertFalse((self.base / "missing").exists())

    def test_lock_timeout_keeps_policy_and_user_count(self):
        self.policy.lock_timeout_seconds = 0
        with (self.private / ".auth.lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(StorageBusyError):
                self.auth.signup("경쟁")
        self.assertEqual(self.load_policy()["users"], {})
        self.assertEqual(self.auth.signup("경쟁")["display_name"], "경쟁")

    def test_cleanup_failure_after_commit_is_success_and_retry_is_duplicate(self):
        original = Path.unlink
        def fail_pending(path, *args, **kwargs):
            if path == self.auth.pending:
                raise OSError("cleanup only")
            return original(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_pending), self.assertLogs(auth_module._LOGGER, level="WARNING") as logs:
            first = self.auth.signup("정리 실패")
        self.assertTrue(self.auth.pending.exists())
        self.assertNotIn(first["token"], "".join(logs.output))
        self.assertEqual(self.restart().login("정리 실패")["token"], first["token"])
        with self.assertRaises(AuthError) as caught:
            self.auth.signup("정리 실패")
        self.assertEqual(caught.exception.code, "name_conflict")
        self.assertFalse(self.auth.pending.exists())

    def test_admin_replacement_only_accepts_current_hash_and_preserves_identity(self):
        user = self.auth.signup("관리자 교체")
        replacement = "N" * 48
        with self.assertRaises(AccessDenied):
            self.auth.enroll_existing_token(user["user_id"], replacement)
        policy = self.load_policy()
        policy["users"][user["user_id"]]["token_sha256"] = sha256(replacement.encode()).hexdigest()
        policy["users"][user["user_id"]]["auth_generation"] += 1
        self.save_policy(policy)
        self.restart().enroll_existing_token(user["user_id"], replacement)
        updated = self.restart().login("관리자 교체")
        self.assertEqual(updated["user_id"], user["user_id"])
        self.assertEqual(updated["token"], replacement)
        self.assertNotEqual(updated["access_revision"], user["access_revision"])
        with self.assertRaises(AccessDenied):
            self.policy.authenticate(user["token"])

    def test_unallowed_profile_and_other_user_generation_do_not_change_revision(self):
        user = self.auth.signup("나")
        other = self.auth.signup("남")
        policy = self.load_policy()
        policy["tenants"]["sdv-platform"]["profiles"]["unallowed"] = {"domain": "다른 범위", "viewpoint": None}
        policy["users"][other["user_id"]]["auth_generation"] += 1
        self.save_policy(policy)
        self.assertEqual(user["access_revision"], self.policy.describe(user["token"])["access_revision"])

    def test_credential_swapping_and_runtime_key_change_are_rejected(self):
        first, second = self.auth.signup("하나"), self.auth.signup("둘")
        first_path = self.auth._credential_path(first["user_id"])
        first_cipher = first_path.read_bytes()
        first_path.write_bytes(self.auth._credential_path(second["user_id"]).read_bytes())
        with self.assertRaises(PolicyError):
            self.auth.login("하나")
        first_path.write_bytes(first_cipher)
        key = self.private / "credential.key"
        key.write_bytes(Fernet.generate_key())
        with self.assertRaises(PolicyError):
            self.auth.signup("잘못된 키 가입")
        self.assertEqual(len(self.load_policy()["users"]), 2)

    def test_name_normalization_no_auto_signup_and_no_sensitive_errors(self):
        self.auth.signup("é")
        with self.assertRaises(AuthError) as caught:
            self.auth.signup("e\u0301")
        self.assertEqual(caught.exception.code, "name_conflict")
        with self.assertRaises(AuthError):
            self.auth.login("없는 이름")
        for name in [None, "\u0000", "  ", "A" * 81]:
            with self.assertRaises(AuthError):
                self.auth.signup(name)
        self.assertEqual(len(self.load_policy()["users"]), 1)

    def test_explicit_key_configuration_uses_protected_file(self):
        # 초기 빈 key는 기존 fixture 소유다. 지정 키 선택이 기본 키를 변경하지 않음을 확인한다.
        existing_key = (self.private / "credential.key").read_bytes()
        configured = self.base / "separate.key"
        with patch.dict(os.environ, {"LLM_WIKI_CREDENTIAL_KEY_FILE": str(configured)}):
            service = initialize_auth(self.policy)
            first = service.signup("별도 키")
            self.assertEqual(initialize_auth(self.policy).login("별도 키")["token"], first["token"])
        self.assertEqual((self.private / "credential.key").read_bytes(), existing_key)
        self.assertEqual(configured.stat().st_mode & 0o777, 0o600)

    def test_bad_pending_record_never_discloses_contents_or_changes_policy(self):
        self.auth.pending.write_text('{"base_revision": null,"credential": 42,"new_tenant": false,"policy": {},"user_id": "secret-name"}')
        self.auth.pending.chmod(0o600)
        previous = self.config.read_bytes()
        with self.assertRaises(PolicyError) as caught:
            self.auth.login("secret-name")
        self.assertNotIn("secret-name", str(caught.exception))
        self.assertEqual(previous, self.config.read_bytes())


class HttpTests(AuthFixture):
    def test_shared_token_mode_has_no_public_auth_exceptions(self):
        app = HttpAccessMiddleware(Starlette(), token="T" * 48)
        with TestClient(app, base_url="http://127.0.0.1:8766") as client:
            for path in ("/api/v1/auth/signup", "/api/v1/auth/login"):
                self.assertEqual(client.post(path, json={"name": "거부"}).status_code, 401)

    def test_http_permission_revocation_and_sensitive_failures(self):
        app = create_application(self.policy, auth=self.auth)
        with TestClient(app, base_url="http://127.0.0.1:8766", raise_server_exceptions=False) as client:
            user = client.post("/api/v1/auth/signup", json={"name": "권한"}).json()["data"]
            headers = {"Authorization": "Bearer " + user["token"]}
            policy = self.load_policy()
            policy["users"][user["user_id"]]["memberships"]["sdv-platform"]["permissions"] = []
            self.save_policy(policy)
            response = client.get("/api/v1/tenants/sdv-platform/documents", headers=headers)
            self.assertEqual(response.status_code, 403, response.text)
            self.auth._credential_path(user["user_id"]).write_bytes(b"secret contents")
            response = client.post("/api/v1/auth/login", json={"name": "권한"})
            self.assertEqual(response.status_code, 503)
            for value in (str(self.base), "secret contents", user["token"], "token_sha256"):
                self.assertNotIn(value, response.text)
            self.assertEqual(response.headers["cache-control"], "no-store")

    def test_http_flat_contract_exact_routes_host_origin_and_limits(self):
        app = create_application(self.policy, auth=self.auth)
        with TestClient(app, base_url="http://127.0.0.1:8766", raise_server_exceptions=False) as client:
            response = client.post("/api/v1/auth/signup", json={"name": "API 사용자"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["cache-control"], "no-store")
            result = response.json()["data"]
            self.assertEqual(client.post("/api/v1/auth/login", json={"name": "API 사용자"}).json()["data"], result)
            headers = {"Authorization": "Bearer " + result["token"]}
            context = client.get("/api/v1/access-context", headers=headers)
            self.assertEqual(context.status_code, 200, context.text)
            self.assertEqual(context.json()["data"], {k: v for k, v in result.items() if k != "token"})
            for method, path in [("GET", "/api/v1/auth/login"), ("OPTIONS", "/api/v1/auth/signup"),
                    ("POST", "/api/v1/auth/signup/"), ("POST", "/api/v1/auth/login/child"),
                    ("POST", "/api/v1/auth/%6cogin"), ("POST", "/mcp"),
                    ("GET", "/api/v1/access-context"), ("GET", "/openapi.json")]:
                with self.subTest(method=method, path=path):
                    self.assertEqual(client.request(method, path).status_code, 401)
            self.assertEqual(client.post("/api/v1/auth/signup", json={"name": "API 사용자"}).status_code, 409)
            missing = client.post("/api/v1/auth/login", json={"name": "없음"})
            self.assertEqual(missing.status_code, 401)
            self.assertEqual(len(self.load_policy()["users"]), 1)
            for key, value, status in [("host", "attacker.invalid", 421), ("origin", "https://attacker.invalid", 403)]:
                self.assertEqual(client.post("/api/v1/auth/login", headers={key: value}, json={"name": "API 사용자"}).status_code, status)
            for payload in [{"name": "A", "token": "private"}, {"name": 42}, {"name": "\u0000"}]:
                response = client.post("/api/v1/auth/signup", json=payload)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn("private", response.text)
            self.assertEqual(client.post("/api/v1/auth/login", content=b"x" * 4097,
                headers={"Content-Type": "application/json"}).status_code, 413)
            self.assertEqual(client.post("/api/v1/auth/login", content='{"name":"A","name":"B"}',
                headers={"Content-Type": "application/json"}).status_code, 422)
            self.assertEqual(client.post("/api/v1/auth/login?name=else", json={"name": "API 사용자"}).status_code, 422)
            response = client.post("/api/v1/auth/login", json={"name": "API 사용자"},
                                   headers=[("host", "127.0.0.1"), ("host", "127.0.0.1")])
            self.assertEqual(response.status_code, 421)


if __name__ == "__main__":
    unittest.main()
