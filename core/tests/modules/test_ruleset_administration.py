"""Policy CAS/history/rollback and compatibility on isolated administrator paths."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from core.common.json_codec import canonical_json_bytes
from core.modules.extraction_rules import content
from core.modules.extraction_rules.administration import RulesetAdministration
from core.modules.extraction_rules.contracts import (RulesetConflictError, RulesetCompatibilityError,
    RulesetConfigurationError, RulesetBusyError, RulesetCorruptError)
from core.modules.extraction_rules.publish import publish
from core.tests.modules import test_extraction_rules as fixture


class RulesetAdministrationTests(unittest.TestCase):
    setUp = fixture.ExtractionRulesTests.setUp
    publish = fixture.ExtractionRulesTests.publish
    registry = fixture.ExtractionRulesTests.registry

    def admin(self):
        self.publish()
        admin = RulesetAdministration(self.registry())
        publish(self.releases, tenant_root=self.tenants, ruleset_id="llm-wiki", ruleset_version="2",
                reason="diagnostics rollout", schema=self.schema, expected_schema=self.schema)
        self.next_key = {"ruleset_id": "llm-wiki", "ruleset_version": "2"}
        return admin

    def plan(self, admin):
        return admin.plan(tenant="alpha", key=self.next_key, expected_revision=admin.snapshot()[2],
                          reason="Explicit default transition", make_default=True)

    def test_transition_and_exact_rollback_preserve_old_releases_other_tenant_and_raw_policy(self):
        admin = self.admin()
        before = self.policy_file.read_bytes()
        releases = {str(p): p.read_bytes() for p in self.releases.rglob("*") if p.is_file()}
        planned = self.plan(admin)
        self.assertEqual(self.policy_file.read_bytes(), before)
        changed = admin.apply(planned)
        self.assertEqual(admin.registry.read("alpha")["ruleset_version"], "2")
        self.assertEqual(admin.registry.read("alpha", "llm-wiki", "1")["ruleset_version"], "1")
        self.assertEqual(admin.registry.read("beta")["ruleset_version"], "1")
        self.assertEqual(admin.event(changed["event_id"])["before_text"].encode(), before)
        self.assertTrue(admin.status(changed["event_id"])["matches_after"])
        rollback = admin.rollback_plan(event_id=changed["event_id"], expected_revision=changed["policy_revision"], reason="Rollback")
        restored = admin.apply(rollback)
        self.assertTrue(restored["applied"])
        self.assertEqual(self.policy_file.read_bytes(), before)
        self.assertEqual(releases, {str(p): p.read_bytes() for p in self.releases.rglob("*") if p.is_file()})
        self.assertEqual(len(list(admin.history.iterdir())), 2)

    def test_competing_plans_apply_once_and_stale_plan_cannot_replace_current_policy(self):
        admin = self.admin()
        planned = self.plan(admin)
        def attempt():
            try:
                return admin.apply(planned)["applied"]
            except RulesetConflictError:
                return False
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(lambda _: attempt(), range(2))), [False, True])
        with self.assertRaises(RulesetConflictError):
            admin.apply(planned)

    def test_history_failure_cannot_change_policy_and_changed_release_blocks_plan(self):
        admin = self.admin()
        planned = self.plan(admin)
        before = self.policy_file.read_bytes()
        with patch("core.modules.extraction_rules.administration.write_new", side_effect=OSError("history unavailable")):
            with self.assertRaises(OSError):
                admin.apply(planned)
        self.assertEqual(self.policy_file.read_bytes(), before)
        changed = deepcopy(planned)
        changed["releases"][0]["ruleset_revision"] = "0" * 64
        with self.assertRaises(RulesetCompatibilityError):
            admin.apply(changed)
        self.assertEqual(self.policy_file.read_bytes(), before)

    def test_rollback_rejects_intervening_policy_and_revoked_release_is_not_reallowed(self):
        admin = self.admin()
        applied = admin.apply(self.plan(admin))
        raw, policy, _ = admin.snapshot()
        policy["tenants"]["alpha"]["revoked"] = [self.next_key]
        self.policy_file.write_bytes(canonical_json_bytes(policy))
        with self.assertRaises(RulesetConflictError):
            admin.rollback_plan(event_id=applied["event_id"], expected_revision=admin.snapshot()[2], reason="stale")
        with self.assertRaises(RulesetConfigurationError):
            self.plan(admin)

    def test_v1_release_is_readable_and_initial_policy_cli_round_trip(self):
        original = content.components
        def legacy(schema):
            return {**original(schema), "diagnostics.schema.json": canonical_json_bytes(content.diagnostics_schema(1))}
        with patch.object(content, "components", side_effect=legacy):
            self.publish()
        registry = self.registry()
        admin = RulesetAdministration(registry)
        self.assertEqual(admin.inspect("alpha", self.ref)["release"]["diagnostics_versions"], [1])
        # New path is explicit; the existing policy and release are never overwritten.
        new_policy = self.root / "new-policy.json"
        base = [sys.executable, "-B", "-m", "tools.transition_ruleset", "--root", str(self.releases),
                "--policy", str(new_policy), "--tenant-root", str(self.tenants)]
        plan_path = self.root / "plan.json"
        def run(*args):
            proc = subprocess.run([*base, *args], capture_output=True, text=True, check=True)
            return json.loads(proc.stdout)
        run("plan", "--tenant", "alpha", "--ruleset-id", "llm-wiki", "--version", "1",
            "--expected-policy-revision", "absent", "--reason", "Initial release", "--output", str(plan_path))
        self.assertFalse(new_policy.exists())
        changed = run("apply", "--plan", str(plan_path))
        self.assertTrue(run("status", "--event-id", changed["event_id"])["matches_after"])
        rollback = self.root / "rollback.json"
        run("rollback", "--event-id", changed["event_id"], "--expected-policy-revision", changed["policy_revision"],
            "--reason", "Undo initial allowance", "--output", str(rollback))
        run("apply", "--plan", str(rollback))
        self.assertEqual(json.loads(new_policy.read_bytes()), {"version": 1, "tenants": {}})

    def test_lock_busy_and_history_symlink_preserve_policy_and_same_plan_can_retry(self):
        admin = self.admin()
        planned = self.plan(admin)
        before = self.policy_file.read_bytes()
        with admin.path.with_name(admin.path.name + ".lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.assertRaises(RulesetBusyError):
                admin.apply(planned, lock_timeout=0)
        self.assertEqual(self.policy_file.read_bytes(), before)
        target = self.root / "unrelated"
        target.mkdir()
        admin.history.symlink_to(target, target_is_directory=True)
        with self.assertRaises(RulesetCorruptError):
            admin.apply(planned)
        self.assertEqual(list(target.iterdir()), [])
        self.assertEqual(self.policy_file.read_bytes(), before)
        admin.history.unlink()
        self.assertTrue(admin.apply(planned)["applied"])

    def test_post_replace_durability_warning_does_not_report_failure_or_repeat_write(self):
        admin = self.admin()
        from core.modules.extraction_rules import administration
        actual = administration.sync_directory
        parent_syncs = 0
        def sync(path):
            nonlocal parent_syncs
            if path == admin.path.parent:
                parent_syncs += 1
                if parent_syncs == 2:
                    raise OSError("directory sync failed after replace")
            actual(path)
        with patch.object(administration, "sync_directory", side_effect=sync):
            result = admin.apply(self.plan(admin))
        self.assertTrue(result["applied"])
        self.assertEqual(result["durability_warning"], "OSError")
        self.assertTrue(admin.status(result["event_id"])["matches_after"])


if __name__ == "__main__":
    unittest.main()
