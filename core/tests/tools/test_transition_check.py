"""D-041 inspections use disposable fixtures, never operational settings/data."""
from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from core.modules.documents.store import WikiStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.correspondences.store import CorrespondenceStore
from core.tests.modules.test_correspondences import correspondence_actor, correspondence_fixture
from tools.transition_check import check_transition
import tools.transition_check as checker


def contents(root):
    return {p.relative_to(root).as_posix(): ("directory" if p.is_dir() else p.read_bytes())
            for p in root.rglob("*") if not p.is_symlink()}


class TransitionCheckTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-transition-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "source"
        self.source.mkdir()
        self.target = self.root / "tenants" / "acme"
        self.report = self.root / "inspection.json"

    def seed(self, *, review=True, correspondence=True, history=True):
        store = WikiStore(self.source)
        actor = correspondence_actor()
        document, text = "private/비밀문서.md", "상품은 할인에 사용된다.\n"
        source = store.save(document, text, expected_revision=None)
        if history:
            changed = store.save(document, text + "수정 시험.\n", expected_revision=source.revision)
            store.save(document, text, expected_revision=changed.revision)
        if review:
            ontology = OntologyStore(store)
            ontology.generate(document, store.read(document).revision,
                              [{"id": "product", "label": "상품", "type": "concept", "evidence": text.strip()},
                               {"id": "discount", "label": "할인", "type": "concept", "evidence": text.strip()}],
                              [{"subject": "product", "predicate": "uses", "object": "discount", "evidence": text.strip()}])
            reviews = ReviewStore(store)
            snapshot = reviews.query(document)
            reviews.review(document, action="accept", claim_id=snapshot["claims"][0]["claim_id"],
                           expected_state_revision=snapshot["state_revision"], reason="합성 모의 검토", actor=actor)
        if correspondence:
            corr = CorrespondenceStore(store, actor)
            draft = correspondence_fixture(store)
            prepared = corr.query(draft=draft)
            result = corr.propose(prepared["correspondence_id"], prepared["draft"], prepared["state_revision"], "모의 제안")
            corr.review(result["correspondence_id"], "accept", corr.query(result["correspondence_id"])["state_revision"], "모의 수용")
        (self.source / "unknown-empty").mkdir()
        (self.source / "preserve-me.bin").write_bytes(b"unknown bytes\x00\xff")
        return store, document

    def copy(self):
        self.target.parent.mkdir(exist_ok=True)
        shutil.copytree(self.source, self.target)

    def check(self, **kwargs):
        return check_transition(self.source, tenant="acme", **kwargs)

    def policy(self):
        value = {"version": 1, "tenants": {"acme": {"profiles": {"all": {"domain": None, "viewpoint": None}}}},
                 "users": {"alice": {"token_sha256": sha256(b"synthetic token only").hexdigest(),
                     "memberships": {"acme": {"permissions": ["read"], "profiles": ["all"], "default_profile": "all"}}}}}
        path = self.root / "access.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_empty_read_creates_no_wiki_history_lock_or_report(self):
        before = contents(self.source)
        with patch.object(WikiStore, "__init__", side_effect=AssertionError("mutating constructor")), \
             patch.object(ReviewStore, "query", side_effect=AssertionError("public query lock")), \
             patch.object(CorrespondenceStore, "query", side_effect=AssertionError("public query lock")):
            result = self.check()
        self.assertTrue(result["ok"])
        self.assertFalse(result["ready_for_cutover"])
        self.assertEqual(result["data_reuse_verified"], "not_applicable_empty")
        self.assertEqual(before, contents(self.source))
        self.assertFalse(self.report.exists())
        self.assertTrue(all(value == "unverified" for value in result["manual_gates"].values()))

    def test_complete_independent_copy_preserves_whole_history_ledgers_and_empty_dirs(self):
        self.seed()
        self.copy()
        before_source, before_target = contents(self.source), contents(self.target)
        result = self.check(target=self.target, report=self.report)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["comparison"], {"status": "matched", "content_equal": True, "independent_inodes": True})
        self.assertEqual(result["source"]["history_files"], 2)
        self.assertEqual(result["source"]["reviews"], 1)
        self.assertEqual(result["source"]["correspondences"], 1)
        self.assertEqual(result["source"]["unknown_files"], 1)
        self.assertEqual(before_source, contents(self.source))
        self.assertEqual(before_target, contents(self.target))
        self.assertEqual(stat.S_IMODE(self.report.stat().st_mode), 0o600)
        details = json.loads(self.report.read_bytes())
        self.assertIn({"path": "unknown-empty", "type": "directory", "empty": True}, details["trees"]["source"]["manifest"])
        self.assertEqual(details["trees"]["source"]["actor_tenants"], {"acme": 3})

    def test_snapshot_does_not_create_missing_lock_even_with_real_readers(self):
        self.seed()
        (self.source / ".storage.lock").unlink()
        before = contents(self.source)
        with patch.object(WikiStore, "_write_lock", side_effect=AssertionError("lock")), \
             patch.object(WikiStore, "_mkdir", side_effect=AssertionError("mkdir")):
            result = self.check()
        self.assertTrue(result["ok"], result)
        self.assertEqual(before, contents(self.source))

    def test_copy_byte_change_and_history_loss_block_without_repair(self):
        store, document = self.seed()
        self.copy()
        history = next((self.target / "_history" / document).iterdir())
        history.unlink()
        changed = self.target / "wiki" / document
        changed.write_bytes(changed.read_bytes() + b"changed\n")
        before = contents(self.target)
        result = self.check(target=self.target)
        self.assertFalse(result["ok"])
        self.assertFalse(result["comparison"]["content_equal"])
        self.assertIn("copy_preservation_failed", result["blockers"])
        self.assertEqual(before, contents(self.target))

    def test_missing_empty_directory_also_fails_copy_comparison(self):
        self.seed(review=False, correspondence=False)
        self.copy()
        (self.target / "unknown-empty").rmdir()
        self.assertFalse(self.check(target=self.target)["comparison"]["content_equal"])

    def test_hardlink_and_overlapping_target_block(self):
        _, document = self.seed(review=False, correspondence=False)
        self.copy()
        copied = self.target / "wiki" / document
        copied.unlink()
        os.link(self.source / "wiki" / document, copied)
        result = self.check(target=self.target)
        self.assertFalse(result["ok"])
        self.assertTrue(result["comparison"]["content_equal"])
        self.assertFalse(result["comparison"]["independent_inodes"])
        result = self.check(target=self.source)
        self.assertIn("overlapping_datasets", result["blockers"])

    def test_symlink_and_fifo_are_not_followed_or_opened(self):
        outside = self.root / "outside-secret"
        outside.write_text("do not read", encoding="utf-8")
        (self.source / "alias").symlink_to(outside)
        os.mkfifo(self.source / "fifo")
        result = self.check()
        self.assertFalse(result["ok"])
        self.assertIn("source:symbolic_link", result["blockers"])
        self.assertIn("source:not_regular_file", result["blockers"])
        self.assertEqual(outside.read_text(), "do not read")

    def test_ancestor_symlink_source_is_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        result = check_transition(alias, tenant="acme")
        self.assertFalse(result["ok"])
        self.assertIn("source:inventory_unavailable", result["blockers"])

    def test_rejected_source_never_allows_a_report_inside_its_resolved_dataset(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        inside = self.source / "report.json"
        result = check_transition(alias, tenant="acme", report=inside)
        self.assertFalse(result["report_written"])
        self.assertFalse(inside.exists())

    def test_directory_replaced_by_symlink_never_reads_the_foreign_target(self):
        directory = self.source / "wiki"
        directory.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "foreign.md").write_text("foreign source", encoding="utf-8")
        scandir = checker.os.scandir
        moved = [False]
        def swap_before_scandir(path):
            # The child is already anchored by its no-follow fd. Swapping its
            # filesystem name cannot redirect the inspection to another tree.
            if isinstance(path, int) and not moved[0] and os.fstat(path).st_ino == directory.stat().st_ino:
                directory.rmdir()
                directory.symlink_to(outside, target_is_directory=True)
                moved[0] = True
            return scandir(path)
        with patch.object(checker.os, "scandir", side_effect=swap_before_scandir):
            result = self.check()
        self.assertTrue(moved[0])
        self.assertEqual(result["source"]["documents"], 0)
        self.assertFalse(result["ok"])

    def test_document_actor_mismatch_and_correspondence_tenant_mismatch_both_block(self):
        self.seed()
        before = contents(self.source)
        result = check_transition(self.source, tenant="beta", report=self.report)
        self.assertFalse(result["ok"])
        self.assertFalse(result["source"]["tenant_match"])
        self.assertIn("source:tenant_mismatch", result["blockers"])
        self.assertIn("source:correspondence_reader_invalid", result["blockers"])
        self.assertEqual(before, contents(self.source))
        self.assertEqual(json.loads(self.report.read_bytes())["trees"]["source"]["actor_tenants"], {"acme": 3})

    def test_corrupt_every_reader_is_preserved_and_never_initialized(self):
        self.seed()
        for directory in ("_ontology", "_reviews", "_reviews/correspondences"):
            path = next((self.source / directory).glob("*.json"))
            path.write_bytes(b'{"version":1,"version":1}')
        before = contents(self.source)
        result = self.check()
        self.assertFalse(result["source"]["reader_valid"])
        self.assertIn("source:graph_reader_invalid", result["blockers"])
        self.assertIn("source:review_reader_invalid", result["blockers"])
        self.assertIn("source:correspondence_reader_invalid", result["blockers"])
        self.assertEqual(before, contents(self.source))

    def test_source_history_utf8_and_size_limits_fail_without_trimming(self):
        self.seed(review=False, correspondence=False)
        path = self.source / "wiki" / "oversized.md"
        for raw in (b"\xff", b"x" * (1024 * 1024 + 1)):
            path.write_bytes(raw)
            before = contents(self.source)
            self.assertFalse(self.check()["ok"])
            self.assertEqual(before, contents(self.source))

    def test_all_inventory_budgets_block_partial_capture(self):
        self.seed()
        for budget in ("capture_bytes", "entries", "files", "directories", "history_entries"):
            with self.subTest(budget=budget):
                result = self.check(limits={budget: 0})
                self.assertFalse(result["ok"], result)
                self.assertFalse(result["complete"])

    def test_baseline_detects_source_aba_even_when_source_hash_returns(self):
        store, document = self.seed(review=False, correspondence=False)
        initial = self.check(report=self.report)
        self.assertTrue(initial["ok"])
        self.assertTrue(self.check(baseline=self.report)["baseline"]["unchanged"])
        old = store.read(document)
        second = store.save(document, old.content + "ABA\n", expected_revision=old.revision)
        store.save(document, old.content, expected_revision=second.revision)
        self.assertEqual(store.read(document).revision, old.revision)
        result = self.check(baseline=self.report)
        self.assertFalse(result["ok"])
        self.assertEqual(result["baseline"]["status"], "changed")

    def test_baseline_can_gain_copy_target_but_cannot_drop_prior_target(self):
        self.seed()
        self.assertTrue(self.check(report=self.report)["ok"])
        self.copy()
        next_report = self.root / "with-target.json"
        result = self.check(target=self.target, baseline=self.report, report=next_report)
        self.assertTrue(result["ok"], result)
        self.assertFalse(self.check(baseline=next_report)["ok"])

    def test_report_new_private_no_clobber_and_no_dataset_report(self):
        self.seed()
        self.report.write_bytes(b"existing private report")
        result = self.check(report=self.report)
        self.assertFalse(result["ok"])
        self.assertEqual(self.report.read_bytes(), b"existing private report")
        inside = self.source / "new-report.json"
        self.assertFalse(self.check(report=inside)["ok"])
        self.assertFalse(inside.exists())

    def test_report_parent_swap_cannot_redirect_a_write_into_the_dataset(self):
        reports = self.root / "reports"
        reports.mkdir()
        opened = checker.os.open
        swapped = [False]
        def swap_parent(path, flags, *args, **kwargs):
            if path == "reports" and flags & os.O_DIRECTORY and not swapped[0]:
                reports.rmdir()
                reports.symlink_to(self.source, target_is_directory=True)
                swapped[0] = True
            return opened(path, flags, *args, **kwargs)
        before = contents(self.source)
        with patch.object(checker.os, "open", side_effect=swap_parent):
            result = self.check(report=reports / "report.json")
        self.assertTrue(swapped[0])
        self.assertFalse(result["report_written"])
        self.assertEqual(before, contents(self.source))

    def test_explicit_external_parent_swap_cannot_read_the_foreign_file(self):
        selected = self.root / "external"
        outside = self.root / "outside"
        selected.mkdir()
        outside.mkdir()
        (selected / "config.toml").write_text("selected=1\n", encoding="utf-8")
        (outside / "config.toml").write_text("foreign_secret=1\n", encoding="utf-8")
        opened = checker.os.open
        swapped, foreign_reads = [False], []
        def swap_parent(path, flags, *args, **kwargs):
            if path == "external" and flags & os.O_DIRECTORY and not swapped[0]:
                selected.rename(self.root / "selected-original")
                selected.symlink_to(outside, target_is_directory=True)
                swapped[0] = True
            directory_fd = kwargs.get("dir_fd")
            if path == "config.toml" and directory_fd is not None and os.fstat(directory_fd).st_ino == outside.stat().st_ino:
                foreign_reads.append(path)
            return opened(path, flags, *args, **kwargs)
        with patch.object(checker.os, "open", side_effect=swap_parent):
            result = self.check(config=selected / "config.toml")
        self.assertTrue(swapped[0])
        self.assertFalse(result["ok"])
        self.assertEqual(foreign_reads, [])

    def test_failed_and_nonprivate_reports_cannot_be_used_as_a_passing_baseline(self):
        (self.source / "alias").symlink_to(self.root / "unread")
        self.assertFalse(self.check(report=self.report)["ok"])
        result = self.check(baseline=self.report)
        self.assertEqual(result["baseline"]["status"], "blocked")
        (self.source / "alias").unlink()
        self.report.unlink()
        self.assertTrue(self.check(report=self.report)["ok"])
        self.report.chmod(0o644)
        self.assertEqual(self.check(baseline=self.report)["baseline"]["status"], "blocked")

    def test_report_publication_failure_keeps_dataset_and_cleans_own_temp(self):
        self.seed()
        before = contents(self.source)
        with patch.object(checker.os, "fsync", side_effect=OSError("synthetic failure")):
            result = self.check(report=self.report)
        self.assertFalse(result["ok"])
        self.assertFalse(self.report.exists())
        self.assertEqual(list(self.root.glob(".transition-report-*")), [])
        self.assertEqual(before, contents(self.source))

    def test_successful_report_cleanup_warning_does_not_invite_rewrite(self):
        self.seed()
        unlink = checker.os.unlink
        def fail_report_temp(path, *args, **kwargs):
            if str(Path(path).name).startswith(".transition-report-"):
                raise OSError("synthetic cleanup failure")
            return unlink(path, *args, **kwargs)
        with patch.object(checker.os, "unlink", side_effect=fail_report_temp):
            result = self.check(report=self.report)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["report_written"])
        self.assertTrue(result["report_cleanup_warning"])
        saved = self.report.read_bytes()
        self.assertFalse(self.check(report=self.report)["ok"])
        self.assertEqual(saved, self.report.read_bytes())
        for path in self.root.glob(".transition-report-*"):
            path.unlink()

    def test_changed_during_check_is_blocked_after_frozen_reader_validation(self):
        self.seed()
        inspect = checker._inspect
        def change_after_inspection(tree, tenant):
            result = inspect(tree, tenant)
            (tree.root / "unexpected").write_bytes(b"concurrent mutation")
            return result
        with patch.object(checker, "_inspect", side_effect=change_after_inspection):
            result = self.check()
        self.assertFalse(result["ok"])
        self.assertIn("source:changed_during_check", result["blockers"])

    def test_policy_validation_reuses_reader_without_issuing_tokens_or_store(self):
        self.seed()
        self.copy()
        policy = self.policy()
        config = self.root / "config.toml"
        config.write_text('[mcp_servers.llm_wiki]\ncommand="placeholder"\n', encoding="utf-8")
        before = contents(self.target)
        with patch.object(WikiStore, "__init__", side_effect=AssertionError("mutating constructor")):
            result = self.check(target=self.target, policy=policy, tenant_root=self.target.parent, config=config)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["policy"]["status"], "validated")
        self.assertEqual(result["config"]["status"], "parsed_only")
        self.assertFalse(result["ready_for_cutover"])
        self.assertEqual(before, contents(self.target))

    def test_policy_wrong_target_inside_root_and_config_errors_never_fallback(self):
        self.seed()
        self.copy()
        policy = self.policy()
        self.assertFalse(self.check(policy=policy, tenant_root=self.target.parent)["ok"])
        inside = self.target.parent / "access.json"
        shutil.copyfile(policy, inside)
        self.assertFalse(self.check(target=self.target, policy=inside, tenant_root=self.target.parent)["ok"])
        invalid = self.root / "invalid.toml"
        invalid.write_bytes(b"[broken")
        self.assertFalse(self.check(config=invalid)["ok"])

    def test_python310_without_tomllib_keeps_data_checks_and_blocks_only_explicit_config(self):
        config = self.root / "config.toml"
        config.write_text('[mcp_servers.llm_wiki]\ncommand="placeholder"\n', encoding="utf-8")
        with patch.object(checker, "tomllib", None):
            self.assertTrue(self.check()["ok"])
            result = self.check(config=config)
        self.assertFalse(result["ok"])
        self.assertEqual(result["config"]["status"], "parser_unavailable")

    def test_explicit_paths_cannot_silently_default_to_current_working_directory(self):
        for source in (None, "", 0, {}):
            with self.subTest(source=source), self.assertRaises(checker.TransitionCheckError):
                check_transition(source, tenant="acme")

    def test_missing_correspondence_dependency_blocks_full_reader_verification(self):
        self.seed()
        (self.source / "wiki" / "d.md").unlink()
        before = contents(self.source)
        result = self.check()
        self.assertFalse(result["ok"])
        self.assertIn("source:missing_dependency", result["blockers"])
        self.assertEqual(before, contents(self.source))

    def test_possible_or_confirmed_writes_always_forbid_old_data_auth_and_legacy_restore(self):
        for state in ("unknown", "succeeded", "none_confirmed"):
            result = self.check(write_state=state)
            rollback = result["rollback"]
            self.assertFalse(rollback["restore_old_copy_allowed"])
            self.assertFalse(rollback["legacy_fallback_allowed"])
            self.assertFalse(rollback["restore_old_authorization_allowed"])
            self.assertEqual(rollback["evidence"], "operator_declared")
            self.assertFalse(result["ready_for_cutover"])
        self.assertIn("preserve_latest", self.check()["rollback"]["classification"])

    def test_cli_public_stdout_hides_paths_contents_tokens_urls_and_tenant_values(self):
        store, _ = self.seed()
        secret = "TOKEN_SYNTHETIC_NO_REAL_SECRET_https://private.invalid/path"
        store.save("secret-name.md", secret, expected_revision=None)
        process = subprocess.run([sys.executable, "-B", "-m", "tools.transition_check", "--source", str(self.source),
                                  "--tenant", "acme", "--report", str(self.report)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        for private in (str(self.source), "secret-name.md", "비밀문서", secret, "acme", "private.invalid"):
            self.assertNotIn(private, process.stdout)
            self.assertNotIn(private, process.stderr)
        self.assertTrue(json.loads(process.stdout)["report_written"])
        self.assertIn("secret-name.md", self.report.read_text())

    def test_cli_argument_error_does_not_echo_unknown_private_values(self):
        private = "synthetic-secret-https://private.invalid/credential"
        process = subprocess.run([sys.executable, "-B", "-m", "tools.transition_check", private], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        self.assertFalse(json.loads(process.stdout)["ok"])
        self.assertNotIn(private, process.stdout + process.stderr)


if __name__ == "__main__":
    unittest.main()
