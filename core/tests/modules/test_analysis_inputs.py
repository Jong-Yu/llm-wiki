"""고정 입력의 실제 연결·변경 차단·실패 보존 세 흐름만 검사한다."""

from copy import deepcopy
from hashlib import sha256
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common.json_codec import canonical_json_bytes
from core.modules.access.policy import AccessDenied
from core.modules.analysis_inputs.contracts import InputConflictError, InputLimitError
from core.modules.analysis_inputs.store import InputStore
from core.modules.analysis_jobs.store import JobStore
from core.modules.documents.store import WikiStore
from core.modules.sources.store import SourceStore


class FixedRules:
    def __init__(self):
        self.allowed = True
        text = canonical_json_bytes({"id": "test-rules", "version": "1"}).decode()
        self.release = {"ruleset_id": "test-rules", "ruleset_version": "1", "manifest_text": text,
            "manifest": json.loads(text), "ruleset_revision": sha256(text.encode()).hexdigest(),
            "policy_revision": "a" * 64, "components": {"ontology.md": {
                "content": "조건과 전체 원문을 보존한다.\n", "sha256": sha256("조건과 전체 원문을 보존한다.\n".encode()).hexdigest()}}}

    def read(self, tenant, ruleset_id=None, ruleset_version=None):
        if not self.allowed:
            raise ValueError("ruleset_revoked")
        return deepcopy(self.release)

    def validate_reference(self, tenant, reference):
        value = self.read(tenant)
        if any(value[key] != reference[key] for key in reference):
            raise ValueError("ruleset_changed")
        return value


class AnalysisInputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wiki-fixed-inputs-")
        self.addCleanup(temporary.cleanup)
        self.store = WikiStore(temporary.name)
        self.rules = FixedRules()
        self.actor = {"user_id": "alice", "tenant": "alpha", "profile_id": "all",
                      "domain": None, "viewpoint": None, "policy_revision": "a" * 64}
        self.allow = True
        self.original = "# 원문\r\n조건과 예외 🌱\r\n"
        self.target = self.store.save("target.md", "기존 전체 본문\n", expected_revision=None)
        self.context = self.store.save("definition.md", "조건 A\n", expected_revision=None)
        sources = SourceStore(self.store)
        staged = sources.stage(io.BytesIO(self.original.encode()), kind="text", title="원본", format="md")
        source = sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                                authorize=lambda: self.actor)
        self.jobs = JobStore(self.store, rulesets=self.rules)
        created = self.jobs.create(tenant="alpha", user_id="alice", request_id=uuid4().hex,
            source_id=source["source_id"], source_version=source["source_version"], source_sha256=source["source_sha256"],
            expected_registration_revision=source["registration_revision"], targets=["target.md"],
            outputs=["wiki", "ontology"], authorize=lambda: self.actor)
        self.job_id = created["job_id"]
        claimed = self.jobs.claim(self.job_id, tenant="alpha", user_id="alice",
            expected_job_revision=created["job_revision"], authorize=lambda: self.actor)
        self.run_id = claimed["run_id"]
        self.inputs = InputStore(self.store, self.rules, jobs=self.jobs)

    def authorize(self, permission=None):
        if not self.allow:
            raise AccessDenied()
        return dict(self.actor)

    def current(self):
        return self.jobs.query(self.job_id, tenant="alpha", user_id="alice")

    def prepare(self, stage="read_source", **kwargs):
        return self.inputs.prepare(self.job_id, tenant="alpha", user_id="alice", run_id=self.run_id,
            expected_job_revision=self.current()["job_revision"], stage=stage, authorize=self.authorize, **kwargs)

    def read(self, bundle, **kwargs):
        return self.inputs.read(self.job_id, tenant="alpha", user_id="alice", run_id=self.run_id,
            bundle_id=bundle["bundle_id"], bundle_revision=bundle["bundle_revision"], authorize=self.authorize, **kwargs)

    def snapshot(self):
        return {p.relative_to(self.store.data_dir).as_posix(): p.read_bytes()
                for p in self.store.data_dir.rglob("*") if p.is_file()}

    def test_three_stage_inputs_and_immutable_text_submission_keep_full_source_and_context(self):
        bundle = self.prepare(context_documents=[{"document": "definition.md", "required": True, "reason": "조건 정의"}])
        before = self.snapshot()
        manifest = self.read(bundle)
        self.assertEqual(sha256(manifest["manifest_text"].encode()).hexdigest(), bundle["bundle_revision"])
        self.assertEqual(self.snapshot(), before)
        chunks, offset = [], 0
        while True:
            page = self.read(bundle, component="data/context.json", offset=offset, limit=11)
            chunks.append(page["content"])
            if page["next_offset"] is None:
                break
            offset = page["next_offset"]
        context = json.loads("".join(chunks))["documents"][0]
        self.assertEqual(context["source"]["content"], "조건 A\n")
        self.assertIn("pending_history", context["review"])
        submit = dict(tenant="alpha", user_id="alice", run_id=self.run_id,
            expected_job_revision=bundle["job_revision"], bundle_id=bundle["bundle_id"],
            bundle_revision=bundle["bundle_revision"], request_id=uuid4().hex,
            content=self.original, method="verbatim", authorize=self.authorize)
        extraction = self.inputs.submit_extraction(self.job_id, **submit)
        self.assertTrue(extraction["complete"])
        replay = self.inputs.submit_extraction(self.job_id, **submit)
        self.assertEqual(extraction["extraction_id"], replay["extraction_id"])
        self.assertTrue(replay["replayed"])
        wiki = self.prepare("prepare_wiki", extraction_id=extraction["extraction_id"])
        self.assertTrue(wiki["input_ready"])
        self.assertEqual(self.read(wiki, component="data/extraction.txt")["content"], self.original)
        ontology = self.prepare("extract_ontology", target_document="target.md")
        rows = json.loads(self.read(ontology, component="data/context.json")["content"])["documents"]
        full = next(item for item in rows if item["document"] == "target.md")
        self.assertEqual(full["source"]["revision"], self.target.revision)
        self.assertEqual(self.store.read("target.md").content, "기존 전체 본문\n")
        self.assertFalse(self.current()["execution_ready"])

    def test_old_input_rejects_history_profile_rules_or_permission_change_without_rewriting(self):
        selected = [{"document": "definition.md", "required": True, "reason": "조건"}]
        bundle = self.prepare(context_documents=selected)
        path = self.store.data_dir / "_jobs" / self.job_id / "inputs" / bundle["bundle_id"] / "manifest.json"
        fixed = path.read_bytes()
        changed = self.store.save("definition.md", "조건 B\n", expected_revision=self.context.revision)
        self.store.save("definition.md", "조건 A\n", expected_revision=changed.revision)
        with self.assertRaises(InputConflictError):
            self.read(bundle)
        self.assertEqual(path.read_bytes(), fixed)
        newer = self.prepare(context_documents=selected, rebase=True, rebase_reason="변경한 전체 맥락을 대조한 뒤 새 기준 준비")
        self.actor["viewpoint"] = "business"
        with self.assertRaises(InputConflictError):
            self.read(newer)
        self.actor["viewpoint"] = None
        self.rules.allowed = False
        with self.assertRaises(ValueError):
            self.read(newer)
        self.rules.allowed = True
        self.allow = False
        with self.assertRaises(AccessDenied):
            self.read(newer)

    def test_missing_prerequisite_limits_and_publication_failure_preserve_originals(self):
        with self.assertRaises(InputConflictError):
            self.prepare("prepare_wiki")
        original_state = (self.store.data_dir / "_jobs" / self.job_id / "state.json").read_bytes()
        with patch("core.modules.analysis_inputs.contracts.MAX_BUNDLE_BYTES", 10), self.assertRaises(InputLimitError):
            self.prepare()
        self.assertEqual((self.store.data_dir / "_jobs" / self.job_id / "state.json").read_bytes(), original_state)
        actual = self.jobs._write
        def fail_state(path, value):
            if path.name == "state.json":
                raise OSError("injected metadata failure")
            return actual(path, value)
        with patch.object(self.jobs, "_write", side_effect=fail_state), self.assertRaises(InputConflictError) as caught:
            self.prepare()
        self.assertEqual(caught.exception.code, "input_pending_reconcile")
        self.assertEqual((self.store.data_dir / "_jobs" / self.job_id / "state.json").read_bytes(), original_state)
        self.assertEqual(self.store.read("target.md").revision, self.target.revision)
        self.assertEqual(self.store.read("definition.md").revision, self.context.revision)


if __name__ == "__main__":
    unittest.main()
