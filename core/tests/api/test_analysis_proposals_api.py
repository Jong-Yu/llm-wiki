"""전체 초안의 무쓰기·명시 적용·미발견 복구와 실제 영수증만 핵심 검증한다."""

from copy import deepcopy
from hashlib import sha256
import secrets
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.tests.api import test_read_api as fixture
from core.api.dependencies import access_value
from core.modules.analysis_proposals.store import ProposalStore
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.sources import files as source_files

SOURCE = "모델은 센서를 사용한다.\n모델은 신호를 사용한다.\n"
QUALIFIERS = {"polarity": "positive", "modality": "asserted", "condition": None, "scope": None, "time": None}
CONTEXT = {"domain": None, "viewpoints": []}
PROVENANCE = {"source_entity": None, "attributed_to": None, "basis": None}
GRAPH = {"schema_version": 3,
    "entities": [{"id": identifier, "type": kind, "label": label, "evidence": label,
                  "context": CONTEXT, "identifiers": []}
                 for identifier, kind, label in (("model", "system", "모델"), ("sensor", "physical_object", "센서"), ("signal", "concept", "신호"))],
    "relations": [{"subject": "model", "predicate": "uses", "object": target, "evidence": line,
                   "qualifiers": QUALIFIERS, "context": CONTEXT, "provenance": PROVENANCE}
                  for target, line in (("sensor", SOURCE.splitlines()[0]), ("signal", SOURCE.splitlines()[1]))],
    "relation_candidates": [], "attributes": []}


class AnalysisProposalApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.ReadApiTests.save_policy
    headers = fixture.ReadApiTests.headers
    client = fixture.ReadApiTests.client
    nothing = fixture.ReadApiTests.nothing

    def setUp(self):
        """원본 등록 권한 없이도 Wiki 자체의 전체 재추출을 준비할 수 있게 한다."""
        fixture.ReadApiTests.setUp(self)
        membership = self.config["users"]["alice"]["memberships"]["alpha"]
        membership["permissions"] = ["read", "ontology_write", "ontology_review", "write"]
        self.tokens["carol"] = secrets.token_urlsafe(32)
        self.config["users"]["carol"] = {"token_sha256": sha256(self.tokens["carol"].encode()).hexdigest(),
            "memberships": {"alpha": {"permissions": ["read"], "profiles": ["all"], "default_profile": "all"}}}
        self.save_policy()
        self.store = self.stores["alpha"]
        source = self.store.save("target.md", SOURCE, expected_revision=None)
        OntologyStore(self.store).generate("target.md", source.revision, **GRAPH)
        self.base = "/api/v1/tenants/alpha"

    def value(self, response, status=200):
        """실제 응답 상태와 비밀·절대 경로 비노출을 함께 확인한다."""
        self.assertEqual(response.status_code, status, response.text[:700])
        for token in self.tokens.values():
            self.assertNotIn(token, response.text)
        self.assertNotIn(str(self.root), response.text)
        return response.json()["data" if status < 400 else "error"]

    def current(self):
        """현재 검토 상태를 서버와 같은 Store에서 읽는다."""
        return ReviewStore(self.store).query("target.md")

    def graph_bytes(self):
        """초안 단계에서 canonical 그래프가 바뀌지 않았는지 원시 바이트로 확인한다."""
        return OntologyStore(self.store)._path("target.md").read_bytes()

    async def prepare(self, http, graph):
        """실제 읽은 source/state 판본과 전체 제출값으로 초안을 준비한다."""
        snapshot = self.current()
        body = {"request_id": uuid4().hex, "document": "target.md", "expected_source_revision": snapshot["source_revision"],
                "expected_state_revision": snapshot["state_revision"], "submission": graph}
        return self.value(await http.post(self.base + "/analysis-proposals", json=body), 201)

    async def apply(self, http, proposal):
        """읽은 전체 초안 판본만 명시 적용한다."""
        body = {"request_id": uuid4().hex, "expected_state_revision": proposal["state_revision"],
                "candidate_revision": proposal["candidate_ref"]["candidate_revision"]}
        url = self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/apply"
        return self.value(await http.post(url, json=body)), body

    async def read(self, http, proposal_id):
        """새 적용을 하지 않고 현재 제안 상태만 읽는다."""
        return self.value(await http.get(self.base + "/analysis-proposals/" + proposal_id))

    async def decide(self, http, proposal, old_claim_id, action, **extra):
        """판본에 묶인 명시 미발견 판단을 제출한다."""
        body = {"request_id": uuid4().hex, "expected_state_revision": proposal["state_revision"],
                "candidate_revision": proposal["candidate_ref"]["candidate_revision"],
                "old_claim_id": old_claim_id, "action": action, "reason": "합성 시험의 명시 판단", **extra}
        return self.value(await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/missing-decisions", json=body))

    async def test_prepare_does_not_write_and_identical_apply_creates_new_unreviewed_generation(self):
        async with self.client() as http:
            snapshot = self.current()
            row = snapshot["claims"][0]
            self.value(await http.post(self.base + "/documents/reviews", json={"document": "target.md",
                "claim_id": row["claim_id"], "expected_state_revision": snapshot["state_revision"],
                "action": "accept", "reason": "합성 시험의 기존 판단"}))
            before = self.graph_bytes()
            proposal = await self.prepare(http, GRAPH)
            self.assertEqual(self.graph_bytes(), before)
            checked = self.value(await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/validation", json={}))
            self.assertEqual(checked["automatic"], "passed")
            self.assertFalse(checked["human_approval"])
            self.assertEqual(self.graph_bytes(), before)
            applied, body = await self.apply(http, proposal)
            self.assertTrue(applied["saved"])
            self.assertEqual(applied["state"], "complete")
            self.assertNotEqual(self.graph_bytes(), before)
            self.assertTrue(self.current()["pending_history"])
            self.assertTrue(all(claim["decision"] == "unreviewed" for claim in self.current()["claims"]))
            self.assertEqual(self.store.read("target.md").content, SOURCE)
            after = self.graph_bytes()
            repeated = self.value(await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/apply", json=body))
            self.assertTrue(repeated["replayed"])
            self.assertEqual(after, self.graph_bytes())

    async def test_scope_source_cas_unknown_fields_and_owner_preserve_canonical(self):
        async with self.client() as http:
            before = self.graph_bytes()
            proposal = await self.prepare(http, GRAPH)
            self.value(await http.get(self.base + "/analysis-proposals/" + proposal["proposal_id"], headers=self.headers("carol")), 404)
            self.value(await http.get(self.base + "/analysis-proposals/" + proposal["proposal_id"], headers=self.headers("bob")), 403)
            self.value(await http.post(self.base + "/analysis-proposals", json={"actor": "forged"}), 422)
            previous = self.store.read("target.md")
            self.store.save("target.md", SOURCE + "원문 변경\n", expected_revision=previous.revision)
            body = {"request_id": uuid4().hex, "expected_state_revision": proposal["state_revision"],
                    "candidate_revision": proposal["candidate_ref"]["candidate_revision"]}
            self.value(await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/apply", json=body), 409)
            unchanged = await self.read(http, proposal["proposal_id"])
            self.assertEqual(unchanged["basis"]["documents"][0]["source"]["content"], SOURCE)
            self.assertEqual(unchanged["basis_status"], "changed_or_unavailable")
            self.assertEqual(before, self.graph_bytes())

    async def test_stale_previous_graph_and_actual_old_source_are_preserved_for_comparison(self):
        """본문 변경으로 숨겨진 옛 그래프도 과거 근거로만 캡처하고 실제 이력 본문을 복원한다."""
        previous = self.store.read("target.md")
        self.store.save("target.md", SOURCE + "새 문단입니다.\n", expected_revision=previous.revision)
        self.assertEqual(self.current()["claims"], [])
        async with self.client() as http:
            proposal = await self.prepare(http, {**deepcopy(GRAPH), "relations": []})
            self.assertEqual(proposal["previous_restoration"], "restored_history")
            self.assertEqual(proposal["basis"]["previous"]["source"]["content"], SOURCE)
            self.assertEqual(len(proposal["missing_claims"]), 2)
            self.assertEqual(proposal["basis"]["previous"]["graph"]["source_revision"], previous.revision)

    async def test_missing_exclusion_recovery_draft_and_actual_new_claim_review(self):
        empty = {**deepcopy(GRAPH), "relations": []}
        old = self.current()["claims"]
        async with self.client() as http:
            before = self.graph_bytes()
            proposal = await self.prepare(http, empty)
            self.assertEqual(len(proposal["missing_claims"]), 2)
            proposal = await self.decide(http, proposal, old[0]["claim_id"], "exclude", checked_whole=True)
            proposal = await self.decide(http, proposal, old[1]["claim_id"], "keep", evidence=GRAPH["relations"][1]["evidence"], replacement=GRAPH["relations"][1])
            self.assertEqual(before, self.graph_bytes())
            self.assertEqual(len(proposal["submission"]["relations"]), 1)
            # 후보 전체가 바뀌었으므로 이전 후보에 한 제외를 새 후보에 명시 재확인한다.
            proposal = await self.decide(http, proposal, old[0]["claim_id"], "exclude", checked_whole=True)
            applied, _ = await self.apply(http, proposal)
            self.assertTrue(applied["saved"])
            proposal = await self.read(http, proposal["proposal_id"])
            current = self.current()
            body = {"request_id": uuid4().hex, "expected_state_revision": proposal["state_revision"],
                "expected_review_state_revision": current["state_revision"], "reason": "새 관계 실제 검토 확인"}
            url = self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/completions"
            self.value(await http.post(url, json=body), 422)
            recovered = current["claims"][0]
            reviewed = self.value(await http.post(self.base + "/documents/reviews", json={"document": "target.md",
                "claim_id": recovered["claim_id"], "expected_state_revision": current["state_revision"],
                "action": "accept", "reason": "합성 시험의 복구 새 세대 검토"}))
            body["expected_review_state_revision"] = reviewed["state_revision"]
            completed = self.value(await http.post(url, json=body))
            self.assertEqual(completed["events"][-1]["kind"], "comparison_completed")
            self.assertFalse(completed["events"][-1]["other_claims_approved"])
            self.assertEqual(len(completed["decisions"]), 3)

    async def test_reextract_link_and_saved_receipt_survive_state_failure_and_write_revocation(self):
        empty = {**deepcopy(GRAPH), "relations": []}
        async with self.client() as http:
            proposal = await self.prepare(http, empty)
            old_id = proposal["missing_claims"][0]["claim_id"]
            proposal = await self.decide(http, proposal, old_id, "reextract")
            decision_id = proposal["decisions"][-1]["decision_id"]
            updated = deepcopy(GRAPH)
            # 인용 범위가 달라져 새 claim_id가 된 정상 결과도 옛 ID를 이식하지 않고 연결한다.
            updated["relations"][0]["evidence"] = SOURCE.strip()
            preview = self.value(await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/submissions",
                json={"request_id": uuid4().hex, "expected_state_revision": proposal["state_revision"], "submission": updated}))
            new_id = next(item["claim_id"] for item in preview["preview_claims"] if item["value"]["object"] == "sensor")
            self.assertNotEqual(new_id, old_id)
            submitted = self.value(await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/submissions",
                json={"request_id": uuid4().hex, "expected_state_revision": preview["state_revision"],
                      "submission": updated, "resolution_bindings": [{"decision_id": decision_id,
                          "new_claim_id": new_id, "reason": "새 인용에 대한 명시 대응"}]}))
            original = ProposalStore._write
            def fail_final(service, path, state):
                if any(entry["saved"] is True for entry in state["applications"].values()):
                    raise OSError("injected final linkage failure")
                return original(service, path, state)
            with patch.object(ProposalStore, "_write", fail_final):
                applied, body = await self.apply(http, submitted)
            self.assertEqual(applied["state"], "pending_reconcile")
            self.assertTrue(applied["saved"])
            before = self.graph_bytes()
            current = self.current()
            reviewed = self.value(await http.post(self.base + "/documents/reviews", json={"document": "target.md",
                "claim_id": new_id, "expected_state_revision": current["state_revision"], "action": "accept",
                "reason": "옛 승인 이식 없이 새 인용 주장 별도 확인"}))
            latest = await self.read(http, proposal["proposal_id"])
            completed = self.value(await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/completions",
                json={"request_id": uuid4().hex, "expected_state_revision": latest["state_revision"],
                    "expected_review_state_revision": reviewed["state_revision"], "reason": "새 주장 대응 완료"}))
            self.assertIn(new_id, completed["events"][-1]["reviewed_claim_ids"])
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            receipt = self.value(await http.get(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/requests/" + body["request_id"]))
            self.assertTrue(receipt["saved"])
            self.assertEqual(receipt["receipt"]["candidate_ref"], submitted["candidate_ref"])
            self.assertEqual(before, self.graph_bytes())

    async def test_unlinked_candidate_is_retained_counted_and_exact_request_can_reconcile(self):
        """불변 후보 공개 후 상태 기록 실패가 새 후보의 무제한 보관으로 이어지지 않아야 한다."""
        from core.modules.analysis_proposals import store as proposal_module
        async with self.client() as http:
            proposal = await self.prepare(http, GRAPH)
            before = self.graph_bytes()
            request_id = uuid4().hex
            body = {"request_id": request_id, "expected_state_revision": proposal["state_revision"],
                    "submission": {**deepcopy(GRAPH), "relations": []}}
            original = ProposalStore._write
            def fail_link(service, path, state):
                if request_id in state["requests"]:
                    raise OSError("injected candidate link failure")
                return original(service, path, state)
            url = self.base + "/analysis-proposals/" + proposal["proposal_id"]
            with patch.object(ProposalStore, "_write", fail_link):
                self.value(await http.post(url + "/submissions", json=body), 500)
            receipt = self.value(await http.get(url + "/requests/" + request_id))
            self.assertEqual(receipt["state"], "published_unlinked")
            self.assertFalse(receipt["saved"])
            own = self.store.data_dir / "_analysis_proposals" / sha256(b"alice").hexdigest() / proposal["proposal_id"] / "candidates"
            snapshots = {str(path.relative_to(own)): path.read_bytes() for path in own.rglob("*") if path.is_file()}
            self.value(await http.post(url + "/submissions", json={**body, "request_id": uuid4().hex}), 409)
            self.assertEqual(snapshots, {str(path.relative_to(own)): path.read_bytes() for path in own.rglob("*") if path.is_file()})
            recovered = self.value(await http.post(url + "/submissions", json=body))
            self.assertEqual(recovered["candidate_ref"], receipt["candidate_ref"])
            with patch.object(proposal_module, "MAX_CANDIDATE_TOTAL_BYTES", 1):
                self.value(await http.post(url + "/submissions", json={"request_id": uuid4().hex,
                    "expected_state_revision": recovered["state_revision"], "submission": GRAPH}), 413)
            self.assertEqual(before, self.graph_bytes())
            self.assertEqual(snapshots, {str(path.relative_to(own)): path.read_bytes() for path in own.rglob("*") if path.is_file()})

    async def test_initial_state_failure_reconnects_only_the_exact_current_request(self):
        """완성 입력/후보는 보존하고 정확한 요청만 현재 권한·근거에서 최초 상태를 연결한다."""
        own = self.store.data_dir / "_analysis_proposals" / sha256(b"alice").hexdigest()

        def body_for(submission=None):
            current = self.current()
            return {"request_id": uuid4().hex, "document": "target.md", "submission": submission,
                "expected_source_revision": current["source_revision"], "expected_state_revision": current["state_revision"]}

        def path_for(body):
            return own / sha256(("alpha:alice:" + body["request_id"]).encode()).hexdigest()[:32]

        def frozen(path):
            return {str(item.relative_to(path)): item.read_bytes() for item in path.rglob("*")
                if item.is_file() and item.name != "state.json"}

        async with self.client() as http:
            url = self.base + "/analysis-proposals"
            for submission in (None, GRAPH):
                with self.subTest(initial_submission=submission is not None):
                    body = body_for(submission)
                    with patch.object(ProposalStore, "_write", side_effect=OSError("initial linkage failure")):
                        self.value(await http.post(url, json=body), 500)
                    path = path_for(body)
                    before = frozen(path)
                    self.assertTrue((path / "input" / "manifest.json").exists())
                    self.assertFalse((path / "state.json").exists())
                    self.value(await http.post(url, json={**body, "expected_source_revision": "0" * 64}), 409)
                    self.assertEqual(before, frozen(path))
                    restored = self.value(await http.post(url, json=body))
                    self.assertTrue(restored["replayed"])
                    self.assertEqual(len(restored["events"]), 1)
                    self.assertEqual(before, frozen(path))
                    # 존재하는 손상 상태를 '미연결'로 간주해 초기화하지 않는다.
                    (path / "state.json").write_bytes(b"invalid state")
                    self.value(await http.post(url, json=body), 500)
                    self.assertEqual((path / "state.json").read_bytes(), b"invalid state")
            partial = body_for(GRAPH)
            with patch.object(ProposalStore, "_write", side_effect=OSError("initial linkage failure")):
                self.value(await http.post(url, json=partial), 500)
            path = path_for(partial)
            (path / "candidates" / partial["request_id"] / "component-0.txt").write_bytes(b"broken candidate")
            before = frozen(path)
            self.value(await http.post(url, json=partial), 500)
            self.assertFalse((path / "state.json").exists())
            self.assertEqual(before, frozen(path))
            changed = body_for()
            with patch.object(ProposalStore, "_write", side_effect=OSError("initial linkage failure")):
                self.value(await http.post(url, json=changed), 500)
            path, before = path_for(changed), frozen(path_for(changed))
            self.store.save("target.md", SOURCE + "원문 변경\n", expected_revision=changed["expected_source_revision"])
            self.value(await http.post(url, json=changed), 409)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            self.value(await http.post(url, json=changed), 403)
            self.assertFalse((path / "state.json").exists())
            self.assertEqual(before, frozen(path))

    async def test_successive_recoveries_require_every_retained_claim_review(self):
        """기존/새 인용의 두 연속 복구가 앞 판단을 잃거나 검토 없이 완료되지 않아야 한다."""
        async with self.client() as http:
            for changed_quote in (False, True):
                with self.subTest(changed_quote=changed_quote):
                    proposal = await self.prepare(http, {**deepcopy(GRAPH), "relations": []})
                    for old in proposal["basis"]["previous"]["claims"]:
                        replacement = deepcopy(next(item for item in GRAPH["relations"]
                            if item["object"] == old["value"]["object"]))
                        if changed_quote:
                            replacement["evidence"] = SOURCE.strip()
                        proposal = await self.decide(http, proposal, old["claim_id"], "keep",
                            evidence=replacement["evidence"], replacement=replacement)
                    decisions = deepcopy(proposal["decisions"])
                    self.assertNotEqual(decisions[0]["candidate_ref"], proposal["candidate_ref"])
                    if changed_quote:
                        self.assertTrue(all(item["old_claim_id"] != item["new_claim_id"] for item in decisions))
                    applied, _ = await self.apply(http, proposal)
                    self.assertTrue(applied["saved"])
                    proposal = await self.read(http, proposal["proposal_id"])
                    current = self.current()
                    self.assertTrue(all(item["decision"] == "unreviewed" for item in current["claims"]))
                    for index in (1, 0):
                        reviewed = self.value(await http.post(self.base + "/documents/reviews", json={
                            "document": "target.md", "claim_id": decisions[index]["new_claim_id"],
                            "expected_state_revision": current["state_revision"], "action": "accept",
                            "reason": "합성 시험의 복구 새 세대 검토"}))
                        current = self.current()
                        body = {"request_id": uuid4().hex, "expected_state_revision": proposal["state_revision"],
                            "expected_review_state_revision": reviewed["state_revision"], "reason": "모든 복구 주장 검토"}
                        response = await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/completions", json=body)
                        if index == 1:
                            self.value(response, 422)
                        else:
                            complete = self.value(response)
                    event = complete["events"][-1]
                    self.assertEqual(set(event["reviewed_claim_ids"]), {item["new_claim_id"] for item in decisions})
                    self.assertEqual(len(event["recovery_bindings"]), 2)
                    self.assertEqual(complete["decisions"], decisions)
                    for binding in event["recovery_bindings"]:
                        decision = next(item for item in decisions if item["decision_id"] == binding["decision_id"])
                        self.assertEqual(binding["decision_candidate_ref"], decision["candidate_ref"])
                        self.assertEqual(binding["final_candidate_ref"], proposal["candidate_ref"])
                        self.assertFalse(binding["review_approval_copied"])
