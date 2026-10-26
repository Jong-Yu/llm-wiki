"""분석 계획에서 기존 입력·저장까지 연결할 때 옛 승인이 새 실행에 붙지 않는지 확인한다."""

import unittest
from copy import deepcopy
from uuid import uuid4
from core.tests.api import test_analysis_plans_api as fixture
from core.tests.runtime import test_personal_ai_workflow as ai_fixture
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_inputs.store import InputStore
from core.modules.analysis_results.store import ResultStore
from core.modules.analysis_plans.store import PlanStore
from core.modules.analysis_inputs.contracts import InputConflictError
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore


class PlannedExecutionTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.AnalysisPlanApiTests.setUp
    save_policy = fixture.AnalysisPlanApiTests.save_policy
    headers = fixture.AnalysisPlanApiTests.headers
    client = fixture.AnalysisPlanApiTests.client
    nothing = fixture.AnalysisPlanApiTests.nothing
    value = fixture.AnalysisPlanApiTests.value
    authorize = fixture.AnalysisPlanApiTests.authorize

    async def test_target_context_follows_only_own_saved_results_and_rejects_external_changes(self):
        """출력과 필수 맥락이 겹쳐도 자기 저장만 이어가고 계획/외부 기준은 보존한다."""
        store = self.stores["alpha"]
        initial = store.save("target.md", ai_fixture.SOURCE + "기존 메모\n", expected_revision=None)
        content = ai_fixture.SOURCE + "이번 작업에서 작성한 메모\n"
        async with self.client() as http:
            source = await fixture.AnalysisPlanApiTests.text_source(self, http, content)
            reference = fixture.AnalysisPlanApiTests.source_ref(self, source)
            plan = self.value(await http.post(self.base + "/analysis-plans", json={"request_id": uuid4().hex,
                "source_ref": reference,
                "outputs": [{"document": "target.md", "title": "기존 문서 갱신", "purpose": "기존 본문을 참고해 갱신",
                    "outputs": ["wiki", "ontology"]}],
                "context_documents": [{"document": "target.md", "required": True, "reason": "이전 본문 확인"}]}), 201)
            handoff = self.value(await http.post(self.base + f"/analysis-plans/{plan['manifest']['id']}/handoffs", json={
                "request_id": uuid4().hex, "expected_plan_revision": plan["revision"]}))
        job = handoff["jobs"][0]
        jobs = JobStore(store, rulesets=self.rulesets)
        claimed = jobs.claim(job["job_id"], tenant="alpha", user_id="alice", expected_job_revision=job["job_revision"], authorize=self.authorize)
        common = {"tenant": "alpha", "user_id": "alice", "run_id": claimed["run_id"], "authorize": self.authorize}
        inputs = InputStore(store, self.rulesets, jobs=jobs)
        read = inputs.prepare(job["job_id"], **common, expected_job_revision=claimed["job_revision"], stage="read_source")
        extracted = inputs.submit_extraction(job["job_id"], **common, expected_job_revision=read["job_revision"],
            bundle_id=read["bundle_id"], bundle_revision=read["bundle_revision"], request_id=uuid4().hex,
            content=content, method="verbatim")
        wiki = inputs.prepare(job["job_id"], **common, expected_job_revision=extracted["job_revision"], stage="prepare_wiki",
            extraction_id=extracted["extraction_id"], target_document="target.md")
        results = ResultStore(store, self.rulesets, jobs=jobs)
        saved = results.write_wiki(job["job_id"], **common, expected_job_revision=wiki["job_revision"],
            bundle_id=wiki["bundle_id"], bundle_revision=wiki["bundle_revision"], request_id=uuid4().hex,
            document="target.md", expected_revision=initial.revision, content=content)
        self.assertTrue(saved["saved"])
        # 외부 validate/handoff는 생성 당시 계획을 사용하므로 자기 저장 뒤에도 완화하지 않는다.
        plans = PlanStore(store, self.authorize())
        with self.assertRaises(InputConflictError) as strict:
            plans.validate(plan["manifest"]["id"], plan["revision"])
        self.assertEqual(strict.exception.code, "plan_context_changed")
        graph = inputs.prepare(job["job_id"], **common, expected_job_revision=saved["job_revision"],
            stage="extract_ontology", target_document="target.md")
        generated = results.generate_ontology(job["job_id"], **common, expected_job_revision=graph["job_revision"],
            bundle_id=graph["bundle_id"], bundle_revision=graph["bundle_revision"], request_id=uuid4().hex,
            document="target.md", expected_revision=saved["receipt"]["source_revision"], submission=deepcopy(ai_fixture.GRAPH))
        self.assertTrue(generated["saved"])
        self.assertEqual(plans.read("plans", plan["manifest"]["id"])["revision"], plan["revision"])
        # 정책이 바뀌면 같은 문서와 같은 run이라도 예전 계획을 계속 사용하지 않는다.
        membership = self.config["users"]["alice"]["memberships"]["alpha"]
        membership["permissions"].append("ontology_review")
        self.save_policy()
        with self.assertRaises(InputConflictError) as policy:
            inputs.prepare(job["job_id"], **common, expected_job_revision=generated["job_revision"], stage="read_source")
        self.assertEqual(policy.exception.code, "plan_profile_changed")
        membership["permissions"].remove("ontology_review")
        self.save_policy()
        # 이력까지 확인하므로 외부 수정 뒤 내용이 돌아와도 자기 저장으로 간주하지 않는다.
        current = store.read("target.md")
        changed = store.save("target.md", content + "외부 변경\n", expected_revision=current.revision)
        store.save("target.md", content, expected_revision=changed.revision)
        with self.assertRaises(InputConflictError) as external:
            inputs.prepare(job["job_id"], **common, expected_job_revision=generated["job_revision"], stage="read_source")
        self.assertEqual(external.exception.code, "analysis_basis_changed")

    async def test_plan_handoff_same_graph_creates_new_generation_without_old_approval(self):
        """실제 계획→job→고정 입력→전체 그래프 저장 경로를 한 번만 수행한다."""
        membership = self.config["users"]["alice"]["memberships"]["alpha"]
        membership["permissions"].append("ontology_review")
        self.save_policy()
        store = self.stores["alpha"]
        content, graph = ai_fixture.SOURCE, deepcopy(ai_fixture.GRAPH)
        source = store.save("target.md", content, expected_revision=None)
        OntologyStore(store).generate("target.md", source.revision, **graph)
        reviews = ReviewStore(store)
        before = reviews.query("target.md")
        claim = next(item for item in before["claims"] if item["collection"] == "relations")
        reviews.review("target.md", action="accept", claim_id=claim["claim_id"], expected_state_revision=before["state_revision"],
            reason="합성 검사의 명시 검토", actor=self.authorize("ontology_review"))
        old = reviews.query("target.md")
        async with self.client() as http:
            body = {"request_id": uuid4().hex,
                "wiki_ref": {"document": "target.md", "source_revision": source.revision,
                    "graph_revision": old["graph_revision"], "state_revision": old["state_revision"]},
                "outputs": [{"document": "target.md", "title": "현재 위키 재추출", "purpose": "원문 전체 대조", "outputs": ["ontology"]}]}
            self.value(await http.post(self.base + "/analysis-plans", json={**body,
                "locations": [{"kind": "lines", "start": 1, "end": 1}]}), 422)
            plan = self.value(await http.post(self.base + "/analysis-plans", json=body), 201)
            handoff = self.value(await http.post(self.base + f"/analysis-plans/{plan['manifest']['id']}/handoffs", json={
                "request_id": uuid4().hex, "expected_plan_revision": plan["revision"]}))
        job = handoff["jobs"][0]
        jobs = JobStore(store, rulesets=self.rulesets)
        claimed = jobs.claim(job["job_id"], tenant="alpha", user_id="alice", expected_job_revision=job["job_revision"], authorize=self.authorize)
        common = {"tenant": "alpha", "user_id": "alice", "run_id": claimed["run_id"], "authorize": self.authorize}
        inputs = InputStore(store, self.rulesets, jobs=jobs)
        read = inputs.prepare(job["job_id"], **common, expected_job_revision=claimed["job_revision"], stage="read_source")
        extracted = inputs.submit_extraction(job["job_id"], **common, expected_job_revision=read["job_revision"],
            bundle_id=read["bundle_id"], bundle_revision=read["bundle_revision"], request_id=uuid4().hex,
            content=content, method="verbatim")
        # 그래프 추출 단계는 현재 Wiki 전체를 사용하며 문자 추출 참조를 따로 받지 않는다.
        fixed = inputs.prepare(job["job_id"], **common, expected_job_revision=extracted["job_revision"], stage="extract_ontology",
            target_document="target.md")
        result = ResultStore(store, self.rulesets, jobs=jobs).generate_ontology(job["job_id"], **common,
            expected_job_revision=fixed["job_revision"], bundle_id=fixed["bundle_id"], bundle_revision=fixed["bundle_revision"],
            request_id=uuid4().hex, document="target.md", expected_revision=source.revision,
            expected_state_revision=old["state_revision"], submission=graph)
        self.assertTrue(result["saved"])
        current = reviews.query("target.md")
        self.assertNotEqual(current["graph_revision"], old["graph_revision"])
        self.assertTrue(current["pending_history"])
        self.assertEqual(next(item for item in current["claims"] if item["claim_id"] == claim["claim_id"])["decision"], "unreviewed")
