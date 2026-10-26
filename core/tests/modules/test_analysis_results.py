"""고정 입력 결과의 실제 저장·충돌·부분 실패를 임시 저장소 세 흐름으로 확인한다."""

import io
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.modules.access.policy import AccessDenied
from core.modules.analysis_results.contracts import ResultError
from core.modules.analysis_results.diagnostics import empty_report
from core.modules.analysis_inputs.contracts import InputConflictError
from core.modules.analysis_results.store import ResultStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.runtime.extraction_schema import build_submission_schema
from core.tests.modules import test_analysis_inputs as fixture


class AnalysisResultTests(unittest.TestCase):
    # 테스트 클래스를 상속하지 않아 기존 입력 검사 전체를 다시 수집하지 않는다.
    authorize = fixture.AnalysisInputTests.authorize
    current = fixture.AnalysisInputTests.current
    prepare = fixture.AnalysisInputTests.prepare

    def setUp(self):
        fixture.AnalysisInputTests.setUp(self)
        self.rules.expected_schema = build_submission_schema()
        self.results = ResultStore(self.store, self.rules, jobs=self.jobs)
        self.extraction_id = None

    def protected(self):
        roots = {"wiki", "_history", "_ontology", "_reviews", "_sources", "_registrations"}
        return {path.relative_to(self.store.data_dir).as_posix(): path.read_bytes()
                for path in self.store.data_dir.rglob("*") if path.is_file()
                and path.relative_to(self.store.data_dir).parts[0] in roots}

    def wiki_bundle(self):
        if self.extraction_id is None:
            source = self.prepare(context_documents=[{"document": "definition.md", "required": True, "reason": "조건 정의"}])
            extraction = self.inputs.submit_extraction(self.job_id, tenant="alpha", user_id="alice",
                run_id=self.run_id, expected_job_revision=source["job_revision"], bundle_id=source["bundle_id"],
                bundle_revision=source["bundle_revision"], request_id=uuid4().hex, content=self.original,
                method="verbatim", authorize=self.authorize)
            self.extraction_id = extraction["extraction_id"]
        return self.prepare("prepare_wiki", extraction_id=self.extraction_id,
            context_documents=[{"document": "definition.md", "required": True, "reason": "조건 정의"}])

    def arguments(self, bundle):
        return {"tenant": "alpha", "user_id": "alice", "run_id": self.run_id,
            "expected_job_revision": bundle["job_revision"], "bundle_id": bundle["bundle_id"],
            "bundle_revision": bundle["bundle_revision"], "request_id": uuid4().hex,
            "document": "target.md", "expected_revision": self.store.read("target.md").revision,
            "authorize": self.authorize}

    def write(self, content="모델은 센서를 사용한다.\n"):
        arguments = {**self.arguments(self.wiki_bundle()), "content": content}
        return self.results.write_wiki(self.job_id, **arguments), arguments

    def receipt(self, request_id):
        return self.results.query(self.job_id, tenant="alpha", user_id="alice", request_id=request_id,
                                  authorize=self.authorize)

    def test_codex_and_claude_execution_receipts_preserve_provider_and_full_history(self):
        for provider in ("codex", "claude"):
            with self.subTest(provider=provider):
                before = self.store.read("target.md")
                execution = {"provider": provider, "cli_version": "fixture", "requested_model": None,
                    "prompt_sha256": "1" * 64, "schema_sha256": "2" * 64, "output_sha256": "3" * 64}
                diagnostic = {**empty_report(), "reviewer_kind": "ai_self_check"}
                args = self.arguments(self.wiki_bundle())
                result = self.results.write_wiki(self.job_id, **args, content=provider + " result\n",
                    execution=execution, diagnostics=diagnostic)
                self.assertTrue(result["saved"])
                self.assertEqual(result["receipt"]["execution"], {"origin": "client_reported", **execution})
                self.assertEqual(self.receipt(args["request_id"])["receipt"], result["receipt"])
                self.assertEqual(result["diagnostics"]["report"], diagnostic)
                self.assertFalse(result["diagnostics"]["human_approval"])
                history = next(self.store.history_dir.rglob(result["receipt"]["history_entry"]))
                self.assertEqual(history.read_bytes(), before.content.encode())
                self.assertNotIn("origin", execution)

    def test_unknown_execution_provider_is_rejected_and_cannot_change_source(self):
        args = self.arguments(self.wiki_bundle())
        before = self.protected()
        for provider in ("unknown", "Claude", "", None, ["claude"]):
            with self.subTest(provider=provider):
                request = {**args, "request_id": uuid4().hex}
                execution = {"provider": provider, "cli_version": "fixture", "prompt_sha256": "1" * 64,
                             "schema_sha256": "2" * 64, "output_sha256": "3" * 64}
                with self.assertRaises(ResultError) as caught:
                    self.results.write_wiki(self.job_id, **request, content="rejected", execution=execution)
                self.assertEqual(caught.exception.code, "invalid_execution_report")
                self.assertFalse(self.receipt(request["request_id"])["saved"])
                self.assertEqual(self.protected(), before)

    @staticmethod
    def submission():
        # 저장/인용 계약용 합성 fixture이며 실제 의미 추출 정확도의 증거가 아니다.
        return {"schema_version": 3, "entities": [
            {"id": "model", "type": "system", "label": "모델", "evidence": "모델"},
            {"id": "sensor", "type": "physical_object", "label": "센서", "evidence": "센서"}],
            "relations": [{"subject": "model", "predicate": "uses", "object": "sensor",
                "evidence": "모델은 센서를 사용한다.", "qualifiers": {"polarity": "positive",
                    "modality": "asserted", "condition": None, "scope": None, "time": None}}],
            "relation_candidates": [], "attributes": []}

    def test_changed_inputs_permissions_and_rules_block_save_and_preserve_existing_data(self):
        def context_round_trip():
            changed = self.store.save("definition.md", "조건 B\n", expected_revision=self.context.revision)
            self.store.save("definition.md", "조건 A\n", expected_revision=changed.revision)

        def source_change():
            self.store.save("target.md", "외부에서 바뀐 본문\n",
                            expected_revision=self.store.read("target.md").revision)

        def state_change():
            OntologyStore(self.store).generate("target.md", self.store.read("target.md").revision, [], [])

        def registered_original_change():
            reference = self.current()["source_ref"]
            staged = self.jobs.sources.stage(io.BytesIO(b"changed original\n"), kind="text", title="새 판본", format="txt")
            self.jobs.sources.commit(staged, tenant="alpha", user_id="alice", request_id=uuid4().hex,
                source_id=reference["source_id"], expected_registration_revision=reference["registration_revision"],
                authorize=lambda: self.actor)

        cases = [("context A-B-A", context_round_trip), ("source", source_change), ("state", state_change),
            ("profile", lambda: self.actor.update(viewpoint="business")),
            ("rules revoked", lambda: setattr(self.rules, "allowed", False)),
            ("permission revoked", lambda: setattr(self, "allow", False)),
            ("registered original", registered_original_change)]
        for name, mutate in cases:
            with self.subTest(change=name):
                # 서로 다른 실패 유형은 독립 job에서 확인한다. 앞 사례의 맥락 변경을
                # 다음 사례에서 기준값만 바꿔 조용히 받아들이는 fixture를 만들지 않는다.
                if name != cases[0][0]:
                    self.setUp()
                arguments = {**self.arguments(self.wiki_bundle()), "content": "이전 입력에서 만든 초안\n"}
                mutate()
                before = self.protected()
                try:
                    with self.assertRaises((ResultError, AccessDenied)):
                        self.results.write_wiki(self.job_id, **arguments)
                    self.assertEqual(self.protected(), before)
                finally:
                    self.actor["viewpoint"] = None
                    self.rules.allowed = True
                    self.allow = True

    def test_wiki_replay_and_missing_final_receipt_never_repeat_successful_storage(self):
        saved, arguments = self.write()
        self.assertTrue(saved["saved"])
        self.assertEqual(saved["state"], "complete")
        self.assertEqual(saved["receipt"]["source_revision"], self.store.read("target.md").revision)
        self.assertRegex(saved["receipt"]["state_revision"], r"^[0-9a-f]{64}$")
        self.assertEqual(saved["receipt"]["state_revision_basis"], "post_save_snapshot")
        before = self.protected()
        replay = self.results.write_wiki(self.job_id, **arguments)
        self.assertTrue(replay["saved"])
        self.assertTrue(replay["replayed"])
        with self.assertRaises(ResultError):
            self.results.write_wiki(self.job_id, **{**arguments, "content": "다른 제출"})
        self.assertEqual(self.protected(), before)
        next_arguments = {**self.arguments(self.wiki_bundle()), "content": "모델은 센서를 사용한다.\n새 본문\n"}
        write_receipt = self.results._write_receipt
        def fail_final_receipt(path, record):
            if record["state"] == "complete":
                raise OSError("injected final receipt failure")
            return write_receipt(path, record)
        with patch.object(self.results, "_write_receipt", side_effect=fail_final_receipt):
            pending = self.results.write_wiki(self.job_id, **next_arguments)
        self.assertTrue(pending["saved"])
        self.assertEqual(pending["state"], "pending_reconcile")
        committed = self.protected()
        with patch.object(self.store, "save", side_effect=AssertionError("A successful save must never repeat")):
            confirmed = self.receipt(next_arguments["request_id"])
            repeated = self.results.write_wiki(self.job_id, **next_arguments)
        self.assertTrue(confirmed["saved"])
        self.assertTrue(repeated["saved"])
        self.assertEqual(confirmed["receipt"]["source_revision"], self.store.read("target.md").revision)
        self.assertEqual(self.protected(), committed)

    def test_invalid_graph_preserves_wiki_graph_and_reviews_then_valid_graph_completes_job(self):
        ontology, reviews = OntologyStore(self.store), ReviewStore(self.store)
        old_entities = [{"id": "old", "type": "concept", "label": "기존", "evidence": "기존"},
                        {"id": "body", "type": "concept", "label": "본문", "evidence": "본문"}]
        ontology.generate("target.md", self.target.revision, old_entities,
                          [{"subject": "old", "predicate": "related_to", "object": "body", "evidence": "기존 전체 본문"}])
        initial = reviews.query("target.md")
        reviews.review("target.md", action="accept", claim_id=initial["claims"][0]["claim_id"],
            expected_state_revision=initial["state_revision"], reason="고정 fixture의 모의 승인", actor=self.actor)
        prior_history = reviews.query("target.md")["history"]
        self.prepare(rebase=True, rebase_reason="접수 뒤 만든 기존 그래프와 모의 검토를 새 기준으로 대조",
            context_documents=[{"document": "definition.md", "required": True, "reason": "조건 정의"}])
        self.write()
        graph = self.prepare("extract_ontology", target_document="target.md")
        arguments = {**self.arguments(graph), "expected_state_revision": reviews.query("target.md")["state_revision"]}
        invalid = self.submission()
        invalid["relations"][0]["evidence"] = "원문에 없는 인용"
        before = self.protected()
        with self.assertRaises(ResultError):
            self.results.generate_ontology(self.job_id, submission=invalid, **arguments)
        self.assertEqual(self.protected(), before)
        rejected = self.receipt(arguments["request_id"])
        self.assertFalse(rejected["saved"])
        self.assertEqual(self.current()["result_summary"]["status"], "partial")
        self.assertEqual(self.current()["result_summary"]["saved_count"], 1)
        graph = self.prepare("extract_ontology", target_document="target.md")
        corrected = {**self.arguments(graph), "expected_state_revision": reviews.query("target.md")["state_revision"]}
        saved = self.results.generate_ontology(self.job_id, submission=self.submission(), **corrected)
        self.assertTrue(saved["saved"])
        self.assertEqual(saved["state"], "complete")
        self.assertEqual(saved["receipt"]["graph_revision"], ontology.query("target.md")["graph_revision"])
        self.assertEqual(self.current()["result_summary"]["status"], "complete")
        after = reviews.query("target.md")
        self.assertEqual(after["history"], prior_history)
        self.assertTrue(after["pending_history"])
        self.assertTrue(all(claim["decision"] == "unreviewed" for claim in after["claims"]))
        # 성공한 본문과 같은 hash로 돌아와도 외부 A→B→A 이력은 자기 저장의 계보가 아니다.
        current = self.store.read("target.md")
        external = self.store.save("target.md", "외부 수정\n", expected_revision=current.revision)
        self.store.save("target.md", current.content, expected_revision=external.revision)
        protected = self.protected()
        with self.assertRaises(InputConflictError) as error:
            self.prepare("extract_ontology", target_document="target.md")
        self.assertEqual(error.exception.code, "analysis_basis_changed")
        self.assertEqual(self.protected(), protected)


if __name__ == "__main__":
    unittest.main()
