"""Access-policy tests use only disposable administrator and tenant fixtures."""

from concurrent.futures import ThreadPoolExecutor
import copy
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.access.policy import AccessDenied, AccessPolicy, MAX_POLICY_BYTES, PolicyError
from core.modules.documents.store import RevisionConflictError


class AccessPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-access-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.tenants = self.root / "tenants"
        self.tenants.mkdir()
        for name in ("acme", "beta"):
            (self.tenants / name).mkdir()
        self.config = self.root / "access.json"
        self.alice = "alice_" + "a" * 40
        self.bob = "bob_" + "b" * 40
        self.carol = "carol_" + "c" * 40
        profiles = {
            "business": {"domain": "catalog", "viewpoint": "business"},
            "developer": {"domain": "catalog", "viewpoint": "developer"},
            "all": {"domain": None, "viewpoint": None},
        }
        self.document = {
            "version": 1,
            "tenants": {
                "acme": {"profiles": copy.deepcopy(profiles)},
                "beta": {"profiles": copy.deepcopy(profiles)},
            },
            "users": {
                "alice": {
                    "token_sha256": sha256(self.alice.encode()).hexdigest(),
                    "memberships": {
                        "acme": {
                            "permissions": ["read", "write", "ontology_write"],
                            "profiles": ["business", "developer", "all"],
                            "default_profile": "business",
                        }
                    },
                },
                "bob": {
                    "token_sha256": sha256(self.bob.encode()).hexdigest(),
                    "memberships": {
                        "acme": {
                            "permissions": ["read"],
                            "profiles": ["business", "developer"],
                            "default_profile": "developer",
                        }
                    },
                },
                "carol": {
                    "token_sha256": sha256(self.carol.encode()).hexdigest(),
                    "memberships": {
                        "beta": {
                            "permissions": ["read", "write", "ontology_write"],
                            "profiles": ["all"],
                            "default_profile": "all",
                        }
                    },
                },
            },
        }
        self.write_policy()
        self.policy = AccessPolicy(self.config, self.tenants)

    def write_policy(self, document=None):
        replacement = self.root / "access.new"
        replacement.write_text(json.dumps(self.document if document is None else document), encoding="utf-8")
        replacement.replace(self.config)

    def test_validation_and_authentication_do_not_create_storage(self):
        self.policy.validate()
        self.assertEqual(self.policy.authenticate(self.alice), "alice")
        self.assertEqual(self.policy.authenticate(self.bob), "bob")
        self.assertEqual(list((self.tenants / "acme").iterdir()), [])
        self.assertEqual(list((self.tenants / "beta").iterdir()), [])

    def test_description_contains_only_own_memberships_and_allowed_profiles(self):
        result = self.policy.describe(self.bob)
        self.assertEqual(result["user_id"], "bob")
        self.assertEqual(set(result["memberships"]), {"acme"})
        member = result["memberships"]["acme"]
        self.assertEqual(member["permissions"], ["read"])
        self.assertEqual(set(member["profiles"]), {"business", "developer"})
        self.assertEqual(member["default_profile"], "developer")
        encoded = json.dumps(result)
        for secret in (self.bob, "token_sha256", "carol", "beta", str(self.root)):
            self.assertNotIn(secret, encoded)
        self.assertEqual(result["policy_revision"], sha256(self.config.read_bytes()).hexdigest())

    def test_review_permission_is_explicit_independent_and_revocable(self):
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.alice, "acme", "ontology_review")
        member = self.document["users"]["bob"]["memberships"]["acme"]
        member["permissions"] = ["read", "ontology_review"]
        self.write_policy()
        self.assertEqual(self.policy.authorize(self.bob, "acme", "ontology_review").user_id, "bob")
        for permission in ("write", "ontology_write"):
            with self.assertRaises(AccessDenied):
                self.policy.authorize(self.bob, "acme", permission)
        member["permissions"] = ["read"]
        self.write_policy()
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.bob, "acme", "ontology_review")

    def test_profiles_switch_within_membership_without_changing_store(self):
        default = self.policy.authorize(self.alice, "acme", "read")
        switched = self.policy.authorize(self.alice, "acme", "read", "developer")
        again = self.policy.authorize(self.alice, "acme", "read")
        other_user = self.policy.authorize(self.bob, "acme", "read")
        self.assertEqual((default.profile_id, switched.profile_id, again.profile_id), ("business", "developer", "business"))
        self.assertEqual(default.domain, "catalog")
        self.assertEqual(default.viewpoint, "business")
        self.assertEqual(other_user.profile_id, "developer")
        self.assertEqual(default.store.data_dir, switched.store.data_dir)
        self.assertEqual(switched.store.data_dir, other_user.store.data_dir)
        unfiltered = self.policy.authorize(self.alice, "acme", "read", "all")
        self.assertIsNone(unfiltered.domain)
        self.assertIsNone(unfiltered.viewpoint)

    def test_expert_policy_permission_is_separate_requires_read_and_is_revocable(self):
        for token in (self.alice, self.bob):
            with self.assertRaises(AccessDenied):
                self.policy.authorize(token, "acme", "ontology_policy")
        member = self.document["users"]["bob"]["memberships"]["acme"]
        member["permissions"] = ["read", "ontology_review"]
        self.write_policy()
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.bob, "acme", "ontology_policy")
        member["permissions"] = ["read", "ontology_policy"]
        self.write_policy()
        scope = self.policy.authorize(self.bob, "acme", "ontology_policy", "business")
        self.assertEqual((scope.user_id, scope.tenant, scope.profile_id), ("bob", "acme", "business"))
        for permission in ("write", "ontology_write", "ontology_review"):
            with self.assertRaises(AccessDenied):
                self.policy.authorize(self.bob, "acme", permission)
        member["permissions"] = ["ontology_policy"]
        self.write_policy()
        with self.assertRaises(PolicyError):
            self.policy.authorize(self.bob, "acme", "ontology_policy")
        member["permissions"] = ["read"]
        self.write_policy()
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.bob, "acme", "ontology_policy")

    def test_denied_tenant_permission_and_profile_never_construct_store(self):
        with patch("core.modules.access.policy.WikiStore") as store:
            attempts = [
                (self.alice, "beta", "read", None),
                (self.alice, "missing", "read", None),
                (self.alice, "../beta", "read", None),
                (self.bob, "acme", "write", None),
                (self.bob, "acme", "ontology_write", None),
                (self.bob, "acme", "read", "all"),
                (self.alice, "acme", "admin", None),
                (self.alice, ["acme"], "read", None),
                (self.alice, "acme", ["read"], None),
                (self.alice, "acme", "read", ["business"]),
                (self.alice, "acme", "read", ""),
            ]
            for args in attempts:
                with self.subTest(args=args[1:]), self.assertRaisesRegex(AccessDenied, r"^Access denied\.$"):
                    self.policy.authorize(*args)
            store.assert_not_called()

    def test_invalid_or_unknown_tokens_are_rejected_without_echo(self):
        for token in (None, 12, [], {}, "x" * 31, "x" * 257, "a" * 31 + " ", "한" * 40, "x" * 40):
            with self.subTest(kind=type(token).__name__), self.assertRaisesRegex(AccessDenied, r"^Access denied\.$"):
                self.policy.authenticate(token)

    def test_token_length_boundaries(self):
        for count in (32, 256):
            token = "a" * count
            self.document["users"]["alice"]["token_sha256"] = sha256(token.encode()).hexdigest()
            self.write_policy()
            self.assertEqual(self.policy.authenticate(token), "alice")

    def test_each_public_call_uses_exactly_one_policy_snapshot(self):
        with patch.object(self.policy, "_load", wraps=self.policy._load) as loader:
            for action in (
                self.policy.validate,
                lambda: self.policy.authenticate(self.alice),
                lambda: self.policy.describe(self.alice),
                lambda: self.policy.authorize(self.alice, "acme", "read"),
            ):
                loader.reset_mock()
                action()
                self.assertEqual(loader.call_count, 1)

    def test_token_rotation_and_permission_revocation_apply_on_next_call(self):
        old = self.policy.authorize(self.alice, "acme", "write")
        self.document["users"]["alice"]["memberships"]["acme"]["permissions"] = ["read"]
        self.write_policy()
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.alice, "acme", "write")
        current = self.policy.authorize(self.alice, "acme", "read")
        self.assertNotEqual(old.policy_revision, current.policy_revision)
        new_token = "replacement_" + "z" * 40
        self.document["users"]["alice"]["token_sha256"] = sha256(new_token.encode()).hexdigest()
        self.write_policy()
        with self.assertRaises(AccessDenied):
            self.policy.authenticate(self.alice)
        self.assertEqual(self.policy.authenticate(new_token), "alice")

    def test_membership_profile_and_user_revocation_apply_on_next_call(self):
        self.policy.authorize(self.bob, "acme", "read", "business")
        membership = self.document["users"]["bob"]["memberships"]["acme"]
        membership["profiles"] = ["developer"]
        self.write_policy()
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.bob, "acme", "read", "business")
        self.document["users"]["bob"]["memberships"] = {}
        self.write_policy()
        self.assertEqual(self.policy.describe(self.bob)["memberships"], {})
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.bob, "acme", "read")
        del self.document["users"]["bob"]
        self.write_policy()
        with self.assertRaises(AccessDenied):
            self.policy.authenticate(self.bob)

    def test_profile_definition_changes_are_not_cached(self):
        first = self.policy.authorize(self.alice, "acme", "read")
        self.document["tenants"]["acme"]["profiles"]["business"] = {"domain": "delivery", "viewpoint": "architecture"}
        self.write_policy()
        second = self.policy.authorize(self.alice, "acme", "read")
        self.assertEqual(first.domain, "catalog")
        self.assertEqual((second.domain, second.viewpoint), ("delivery", "architecture"))
        self.assertNotEqual(first.policy_revision, second.policy_revision)

    def test_multiple_memberships_still_select_explicit_tenant(self):
        self.document["users"]["alice"]["memberships"]["beta"] = copy.deepcopy(self.document["users"]["carol"]["memberships"]["beta"])
        self.write_policy()
        a = self.policy.authorize(self.alice, "acme", "write")
        b = self.policy.authorize(self.alice, "beta", "write")
        self.assertNotEqual(a.store.data_dir, b.store.data_dir)
        self.assertEqual(set(self.policy.describe(self.alice)["memberships"]), {"acme", "beta"})
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.alice, None, "read")

    def test_simultaneous_authorizations_do_not_share_user_tenant_or_profile(self):
        inputs = [(self.alice, "acme", "business"), (self.bob, "acme", "developer"), (self.carol, "beta", "all")] * 8
        def authorize(args):
            token, tenant, profile = args
            scoped = self.policy.authorize(token, tenant, "read", profile)
            return scoped.user_id, scoped.tenant, scoped.profile_id, scoped.store.data_dir
        with ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(authorize, inputs))
        for index, result in enumerate(results):
            user, tenant, profile = (("alice", "acme", "business"), ("bob", "acme", "developer"), ("carol", "beta", "all"))[index % 3]
            self.assertEqual(result, (user, tenant, profile, self.tenants / tenant))

    def test_tenant_store_reuses_full_history_and_conflict_protection(self):
        a = self.policy.authorize(self.alice, "acme", "write").store
        b = self.policy.authorize(self.carol, "beta", "write").store
        a1 = a.save("Guide.md", "ACME one\n", expected_revision=None)
        b1 = b.save("Guide.md", "BETA one\n", expected_revision=None)
        a2 = a.save("Guide.md", "ACME two\n", expected_revision=a1.revision)
        a3 = a.save("Guide.md", "ACME three\n", expected_revision=a2.revision)
        with self.assertRaises(RevisionConflictError):
            a.save("Guide.md", "old edit\n", expected_revision=a1.revision)
        self.assertEqual(a.read("Guide.md").revision, a3.revision)
        self.assertEqual(a2.history_path.read_text(), "ACME one\n")
        self.assertEqual(a3.history_path.read_text(), "ACME two\n")
        self.assertEqual(b.read("Guide.md").revision, b1.revision)
        self.assertEqual(b.read("Guide.md").content, "BETA one\n")
        self.assertEqual(list(b.history_dir.rglob("*.md")), [])

    def test_history_failure_keeps_authorized_source_and_other_tenant(self):
        a = self.policy.authorize(self.alice, "acme", "write").store
        b = self.policy.authorize(self.carol, "beta", "write").store
        prior = a.save("Guide.md", "ACME\n", expected_revision=None)
        b.save("Guide.md", "BETA\n", expected_revision=None)
        with patch.object(a, "_archive", side_effect=OSError("injected history failure")):
            with self.assertRaises(OSError):
                a.save("Guide.md", "changed\n", expected_revision=prior.revision)
        self.assertEqual(a.read("Guide.md").content, "ACME\n")
        self.assertEqual(b.read("Guide.md").content, "BETA\n")
        self.assertEqual(list(self.tenants.rglob(".wiki-*.tmp")), [])

    def test_invalid_json_deleted_and_oversized_policy_fail_closed(self):
        self.policy.authenticate(self.alice)
        for raw in (b"{", b"\xff", b"[]", b"null", b" " * (MAX_POLICY_BYTES + 1), b"[" * 2000):
            self.config.write_bytes(raw)
            with self.subTest(size=len(raw)), self.assertRaisesRegex(PolicyError, r"^Access policy is unavailable\.$"):
                self.policy.authorize(self.alice, "acme", "read")
        self.config.unlink()
        with self.assertRaises(PolicyError):
            self.policy.authenticate(self.alice)

    def test_duplicate_json_keys_rejected_at_every_nesting_level(self):
        text = json.dumps(self.document)
        variants = [
            text.replace('"version": 1', '"version": 1, "version": 1'),
            text.replace('"domain": "catalog"', '"domain": "catalog", "domain": null', 1),
        ]
        for text in variants:
            self.config.write_text(text)
            with self.assertRaises(PolicyError):
                self.policy.validate()

    def test_unknown_fields_and_invalid_types_are_rejected(self):
        paths = [(), ("tenants", "acme"), ("tenants", "acme", "profiles", "business"), ("users", "alice"), ("users", "alice", "memberships", "acme")]
        for path in paths:
            document = copy.deepcopy(self.document)
            target = document
            for key in path:
                target = target[key]
            target["unexpected"] = "not accepted"
            self.write_policy(document)
            with self.subTest(path=path), self.assertRaises(PolicyError):
                self.policy.validate()
        replacements = [
            (("version",), True), (("version",), 2),
            (("tenants",), []), (("users",), []),
            (("tenants", "acme", "profiles"), []),
            (("tenants", "acme", "profiles"), {}),
            (("tenants", "acme", "profiles", "business", "domain"), []),
            (("tenants", "acme", "profiles", "business", "domain"), " catalog "),
            (("tenants", "acme", "profiles", "business", "domain"), ""),
            (("tenants", "acme", "profiles", "business", "domain"), "a" * 1001),
            (("tenants", "acme", "profiles", "business", "viewpoint"), []),
            (("tenants", "acme", "profiles", "business", "viewpoint"), "marketing"),
            (("users", "alice", "token_sha256"), "short"),
            (("users", "alice", "memberships"), []),
        ]
        for path, value in replacements:
            document = copy.deepcopy(self.document)
            target = document
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            self.write_policy(document)
            with self.subTest(path=path), self.assertRaises(PolicyError):
                self.policy.validate()

    def test_source_write_is_independent_and_revocation_uses_current_policy(self):
        member = self.document["users"]["bob"]["memberships"]["acme"]
        member["permissions"] = ["read", "source_write"]
        self.write_policy()
        scope = self.policy.authorize(self.bob, "acme", "source_write")
        self.assertEqual(scope.user_id, "bob")
        self.assertEqual(self.policy.describe(self.bob)["memberships"]["acme"]["permissions"],
                         ["read", "source_write"])
        for permission in ("write", "ontology_write", "ontology_review", "ontology_policy"):
            with self.subTest(permission=permission), self.assertRaises(AccessDenied):
                self.policy.authorize(self.bob, "acme", permission)
        member["permissions"] = ["read"]
        self.write_policy()
        with self.assertRaises(AccessDenied):
            self.policy.authorize(self.bob, "acme", "source_write")

    def test_invalid_memberships_permissions_profiles_and_duplicate_tokens_rejected(self):
        variants = []
        for field, value in (
            ("permissions", ["write"]), ("permissions", ["ontology_write"]), ("permissions", ["source_write"]),
            ("permissions", ["ontology_review"]), ("permissions", ["ontology_policy"]),
            ("permissions", ["read", "admin"]), ("permissions", ["read", "read"]),
            ("permissions", "read"), ("permissions", [True]),
            ("profiles", []), ("profiles", ["business", "business"]),
            ("profiles", ["missing"]), ("profiles", "business"),
            ("default_profile", "missing"), ("default_profile", []),
        ):
            document = copy.deepcopy(self.document)
            document["users"]["alice"]["memberships"]["acme"][field] = value
            variants.append(document)
        unknown = copy.deepcopy(self.document)
        unknown["users"]["alice"]["memberships"]["missing"] = unknown["users"]["alice"]["memberships"].pop("acme")
        variants.append(unknown)
        duplicate = copy.deepcopy(self.document)
        duplicate["users"]["bob"]["token_sha256"] = duplicate["users"]["alice"]["token_sha256"]
        variants.append(duplicate)
        for index, document in enumerate(variants):
            self.write_policy(document)
            with self.subTest(case=index), self.assertRaises(PolicyError):
                self.policy.validate()

    def test_unsafe_registry_ids_are_rejected(self):
        for identifier in ("../acme", "Acme", "a/b", ".", "a" * 65, "한글"):
            for path in (("users",), ("tenants",), ("tenants", "acme", "profiles")):
                document = copy.deepcopy(self.document)
                target = document
                for key in path:
                    target = target[key]
                existing = next(iter(target))
                target[identifier] = target.pop(existing)
                self.write_policy(document)
                with self.subTest(identifier=identifier, path=path), self.assertRaises(PolicyError):
                    self.policy.validate()

    def test_missing_tenant_directory_is_not_created(self):
        (self.tenants / "beta").rmdir()
        with self.assertRaises(PolicyError):
            self.policy.validate()
        self.assertFalse((self.tenants / "beta").exists())

    def test_tenant_symlink_to_another_tenant_is_rejected(self):
        (self.tenants / "beta").rmdir()
        (self.tenants / "beta").symlink_to(self.tenants / "acme", target_is_directory=True)
        with self.assertRaises(PolicyError):
            self.policy.validate()
        self.assertEqual(list((self.tenants / "acme").iterdir()), [])

    def test_root_symlink_and_changed_root_are_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.tenants, target_is_directory=True)
        with self.assertRaises(PolicyError):
            AccessPolicy(self.config, alias)
        saved = self.root / "saved-tenants"
        self.tenants.rename(saved)
        self.tenants.symlink_to(saved, target_is_directory=True)
        with self.assertRaises(PolicyError):
            self.policy.validate()

    def test_policy_must_be_regular_external_file_not_symlink_or_fifo(self):
        inside = self.tenants / "acme" / "policy.json"
        inside.write_bytes(self.config.read_bytes())
        with self.assertRaises(PolicyError):
            AccessPolicy(inside, self.tenants).validate()
        alias = self.root / "alias-policy"
        alias.symlink_to(self.config)
        with self.assertRaises(PolicyError):
            AccessPolicy(alias, self.tenants).validate()
        fifo = self.root / "fifo-policy"
        os.mkfifo(fifo)
        with self.assertRaises(PolicyError):
            AccessPolicy(fifo, self.tenants).validate()

    def test_invalid_lock_timeout_fails_before_storage_is_created(self):
        for timeout in (-1, True, None, float("nan"), float("inf"), "5"):
            with self.subTest(timeout=timeout), self.assertRaises(PolicyError):
                AccessPolicy(self.config, self.tenants, lock_timeout_seconds=timeout)
        self.assertEqual(list((self.tenants / "acme").iterdir()), [])

    def test_store_construction_errors_do_not_expose_paths(self):
        with patch("core.modules.access.policy.WikiStore", side_effect=OSError(str(self.root))):
            with self.assertRaisesRegex(PolicyError, r"^Access policy is unavailable\.$"):
                self.policy.authorize(self.alice, "acme", "read")


if __name__ == "__main__":
    unittest.main()
