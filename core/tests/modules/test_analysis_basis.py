"""작업 전체 규약·맥락 고정과 명시 재준비를 실제 불변 규약/격리 자료에서 검증한다."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.modules.analysis_inputs import basis
from core.modules.analysis_inputs.contracts import InputConflictError, InputValidationError
from core.modules.analysis_jobs import records
from core.modules.analysis_results.store import ResultStore
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.modules.extraction_rules.contracts import RulesetUnavailableError
from core.runtime.extraction_schema import build_submission_schema
from core.tests.modules import test_analysis_inputs as fixture


class AnalysisBasisTests(unittest.TestCase):
    authorize = fixture.AnalysisInputTests.authorize
    current = fixture.AnalysisInputTests.current
    prepare = fixture.AnalysisInputTests.prepare
    read = fixture.AnalysisInputTests.read
    snapshot = fixture.AnalysisInputTests.snapshot

    def setUp(self):
        fixture.AnalysisInputTests.setUp(self)
        temporary = tempfile.TemporaryDirectory(prefix="wiki-job-basis-rules-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        schema = build_submission_schema()
        self.refs = [{"ruleset_id": "shared", "ruleset_version": version} for version in ("1", "2")]
        for reference in self.refs:
            publish(root / "rules", tenant_root=self.store.data_dir, reason="격리 기준 검증",
                    schema=schema, expected_schema=schema, **reference)
        self.policy_file = root / "policy.json"
        self.policy = {"version": 1, "tenants": {"alpha": {
            "default": self.refs[0], "allowed": self.refs, "revoked": []}}}
        self.policy_file.write_text(json.dumps(self.policy), encoding="utf-8")
        self.rules = RulesetRegistry(root / "rules", self.policy_file, self.store.data_dir, expected_schema=schema)
        self.inputs.rulesets = self.rules
        self.jobs.rulesets = self.rules
        self.selected = [{"document": "definition.md", "required": True, "reason": "필수 예외"}]

    def submit(self, bundle):
        return self.inputs.submit_extraction(self.job_id, tenant="alpha", user_id="alice", run_id=self.run_id,
            expected_job_revision=bundle["job_revision"], bundle_id=bundle["bundle_id"],
            bundle_revision=bundle["bundle_revision"], request_id=uuid4().hex,
            content=self.original, method="verbatim", authorize=self.authorize)

    def test_stages_inherit_exact_basis_and_reclaim_cannot_change_it(self):
        first = self.prepare(context_documents=self.selected)
        extraction = self.submit(first)
        self.policy["tenants"]["alpha"]["default"] = self.refs[1]
        self.policy_file.write_text(json.dumps(self.policy), encoding="utf-8")
        wiki = self.prepare("prepare_wiki", extraction_id=extraction["extraction_id"])
        self.assertEqual(wiki["ruleset_ref"], first["ruleset_ref"])
        self.assertEqual(wiki["analysis_basis_revision"], first["analysis_basis_revision"])
        manifest = self.read(wiki)["manifest"]
        self.assertIn(self.selected[0], manifest["selection"])
        for change in ({"context_documents": []}, {"ruleset_id": "shared", "ruleset_version": "2"}):
            before = self.snapshot()
            with self.assertRaises(InputConflictError) as caught:
                self.prepare(**change)
            self.assertEqual(caught.exception.code, "analysis_basis_changed")
            self.assertEqual(self.snapshot(), before)
        stopped = self.jobs.update(self.job_id, tenant="alpha", user_id="alice", run_id=self.run_id,
            expected_job_revision=self.current()["job_revision"], reported_status="stopped", authorize=self.authorize)
        reclaimed = self.jobs.claim(self.job_id, tenant="alpha", user_id="alice", reclaim=True,
            expected_job_revision=stopped["job_revision"], authorize=self.authorize)
        self.run_id = reclaimed["run_id"]
        renewed = self.prepare()
        self.assertEqual(renewed["analysis_basis_revision"], first["analysis_basis_revision"])
        self.assertEqual(renewed["ruleset_ref"], first["ruleset_ref"])

    def test_rebase_requires_cas_and_reason_and_keeps_old_artifacts_unusable(self):
        first = self.prepare(context_documents=self.selected)
        extraction = self.submit(first)
        old_bundle = self.store.data_dir / "_jobs" / self.job_id / "inputs" / first["bundle_id"]
        before = {p.name: p.read_bytes() for p in old_bundle.iterdir()}
        for invalid in ({"rebase": True}, {"rebase": True, "rebase_reason": "다른 단계", "stage": "prepare_wiki"}):
            with self.assertRaises(InputValidationError):
                self.prepare(**invalid)
        with self.assertRaises(InputConflictError) as caught:
            self.inputs.prepare(self.job_id, tenant="alpha", user_id="alice", run_id=self.run_id,
                expected_job_revision=first["job_revision"], stage="read_source", rebase=True,
                rebase_reason="지난 판본의 재준비 요청", authorize=self.authorize)
        self.assertEqual(caught.exception.code, "conflict")
        self.policy["tenants"]["alpha"]["revoked"] = [self.refs[0]]
        self.policy_file.write_text(json.dumps(self.policy), encoding="utf-8")
        with self.assertRaises(RulesetUnavailableError):
            self.prepare()
        newer = self.prepare(rebase=True, rebase_reason="철회된 규약 대신 새 규약과 전체 맥락을 검토함",
            ruleset_id="shared", ruleset_version="2", context_documents=[])
        self.assertNotEqual(newer["analysis_basis_revision"], first["analysis_basis_revision"])
        with self.assertRaises(InputConflictError) as caught:
            self.prepare("prepare_wiki", extraction_id=extraction["extraction_id"])
        self.assertEqual(caught.exception.code, "analysis_basis_changed")
        replacement = self.submit(newer)
        self.assertTrue(self.prepare("prepare_wiki", extraction_id=replacement["extraction_id"])["input_ready"])
        self.assertEqual({p.name: p.read_bytes() for p in old_bundle.iterdir()}, before)
        self.assertEqual(self.store.read("target.md").revision, self.target.revision)

    def test_context_and_profile_changes_require_rebase_and_failed_publish_keeps_basis(self):
        first = self.prepare(context_documents=self.selected)
        changed = self.store.save("definition.md", "새 예외\n", expected_revision=self.context.revision)
        self.store.save("definition.md", "조건 A\n", expected_revision=changed.revision)
        with self.assertRaises(InputConflictError):
            self.prepare()
        state_path = records.state_path(self.jobs, self.job_id)
        state = state_path.read_bytes()
        with patch("core.modules.analysis_inputs.files.publish", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                self.prepare(rebase=True, rebase_reason="A→B→A 이력까지 대조함")
        self.assertEqual(state_path.read_bytes(), state)
        newer = self.prepare(rebase=True, rebase_reason="A→B→A 이력까지 대조함")
        self.assertNotEqual(newer["analysis_basis_revision"], first["analysis_basis_revision"])
        self.actor["viewpoint"] = "business"
        with self.assertRaises(InputConflictError):
            self.prepare()
        self.assertEqual(self.current()["analysis_basis_ref"]["profile"]["viewpoint"], None)

    def test_legacy_input_is_preserved_but_needs_explicit_new_basis(self):
        first = self.prepare(context_documents=self.selected)
        state = records.owned_state(self.jobs, self.job_id, "alpha", "alice")
        for event in state["events"]:
            for key in ("analysis_basis", "analysis_basis_revision", "previous_basis_revision", "rebase_reason"):
                event["details"].pop(key, None)
        records.write(self.jobs, records.state_path(self.jobs, self.job_id), state)
        self.assertTrue(self.current()["legacy_rebase_required"])
        self.assertIsNone(basis.active(state))
        with self.assertRaises(InputConflictError) as caught:
            self.prepare()
        self.assertEqual(caught.exception.code, "analysis_basis_required")
        newer = self.prepare(rebase=True, rebase_reason="이전 작업을 새 공통 기준으로 재준비", context_documents=self.selected)
        self.assertFalse(self.current()["legacy_rebase_required"])
        self.assertTrue(newer["input_ready"])
        with self.assertRaises(InputConflictError):
            self.read(first)

    def test_output_targets_cannot_hide_required_context_or_ontology_only_changes(self):
        for index, (targets, contexts, changed_document) in enumerate((
                (["target.md", "definition.md"], [{"document": "definition.md", "required": True,
                    "reason": "B 문서는 출력인 동시에 A의 필수 맥락"}], "definition.md"),
                (["target.md"], [], "target.md"))):
            with self.subTest(targets=targets):
                if index:
                    self.setUp()
                source = self.current()["source_ref"]
                created = self.jobs.create(tenant="alpha", user_id="alice", request_id=uuid4().hex,
                    source_id=source["source_id"], source_version=source["source_version"],
                    source_sha256=source["source_sha256"], expected_registration_revision=source["registration_revision"],
                    targets=targets, outputs=["ontology"], authorize=self.authorize)
                self.job_id = created["job_id"]
                claimed = self.jobs.claim(self.job_id, tenant="alpha", user_id="alice",
                    expected_job_revision=created["job_revision"], authorize=self.authorize)
                self.run_id = claimed["run_id"]
                self.prepare(context_documents=contexts)
                prior = self.store.read(changed_document)
                self.store.save(changed_document, prior.content + "외부에서 변경한 조건\n", expected_revision=prior.revision)
                before = self.snapshot()
                with self.assertRaises(InputConflictError) as caught:
                    self.prepare("extract_ontology", target_document="target.md")
                self.assertEqual(caught.exception.code, "analysis_basis_changed")
                self.assertEqual(self.snapshot(), before)

    def test_post_save_observation_cannot_adopt_external_source_round_trip(self):
        first = self.prepare(context_documents=self.selected)
        extraction = self.submit(first)
        prepared = self.prepare("prepare_wiki", extraction_id=extraction["extraction_id"])
        results = ResultStore(self.store, self.rules, jobs=self.jobs)
        observe = results._observe

        def external_round_trip(receipt, actor):
            # 저장 잠금 해제 뒤 관측 전에 다른 작성자가 A→B→A로 변경한 상황이다.
            current = self.store.read("target.md")
            changed = self.store.save("target.md", "외부 임시 변경\n", expected_revision=current.revision)
            self.store.save("target.md", current.content, expected_revision=changed.revision)
            return observe(receipt, actor)

        with patch.object(results, "_observe", side_effect=external_round_trip):
            saved = results.write_wiki(self.job_id, tenant="alpha", user_id="alice", run_id=self.run_id,
                expected_job_revision=prepared["job_revision"], bundle_id=prepared["bundle_id"],
                bundle_revision=prepared["bundle_revision"], request_id=uuid4().hex, document="target.md",
                expected_revision=self.target.revision, content="자기 작업이 저장한 본문\n", authorize=self.authorize)
        self.assertTrue(saved["saved"])
        self.assertIsNotNone(saved["receipt"]["history_entry"])
        before = self.snapshot()
        with self.assertRaises(InputConflictError) as caught:
            self.prepare("extract_ontology", target_document="target.md")
        self.assertEqual(caught.exception.code, "analysis_basis_changed")
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
