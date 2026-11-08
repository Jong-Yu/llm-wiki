"""네 검토 HTTP 쓰기가 권한·관점·CAS·저장 직전 재확인을 유지하는지 확인한다."""

from unittest.mock import patch

from core.modules.reviews.store import ReviewStore
from core.tests.poc_mcp.test_server_integration import ServerFixture


class ReviewHttpTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.write("If ready, A uses B.\n")
        self.source = self.read()["revision"]
        self.qualifiers = dict(polarity="positive", modality="asserted", condition="If ready", scope=None, time=None)
        generated = self.mcp("ontology_generate", {
            "tenant": self.tenant, "document": "example.md", "expected_revision": self.source,
            "entities": [dict(id=name.lower(), label=name, type="system", evidence="A uses B.") for name in ("A", "B")],
            "relations": [dict(subject="a", predicate="uses", object="b", evidence="If ready, A uses B.", qualifiers=self.qualifiers)]})
        self.assertTrue(generated["ok"], generated)

    def state(self):
        return self.mcp("ontology_review_query", {"tenant": self.tenant, "document": "example.md"})

    def post(self, operation, fields):
        return self.client.post(f"/api/v1/tenants/{self.tenant}/documents/{operation}", headers=self.headers(),
                                json={"document": "example.md", "profile": "default", "reason": "simulation", **fields})

    def test_all_four_routes_preserve_scope_reasons_cas_and_complete_history(self):
        original = self.state()
        review = self.post("reviews", dict(profile=None, action="reject", claim_id=original["claims"][0]["claim_id"],
                                           expected_state_revision=original["state_revision"]))
        self.assertEqual(review.status_code, 200, review.text)
        review = review.json()["data"]
        self.assertEqual(review["retry_policy"], "read_and_reconcile")
        self.assertIsNone(review["mutation_receipt"])
        stale = self.post("reviews", dict(action="accept", claim_id=original["claims"][0]["claim_id"],
                                          expected_state_revision=original["state_revision"]))
        self.assertEqual(stale.status_code, 409)
        undo = self.post("review-undos", dict(event_id=review["event_id"], expected_state_revision=review["state_revision"]))
        self.assertEqual(undo.status_code, 200, undo.text)
        undo = undo.json()["data"]
        policy = self.post("policies", dict(claim_id=undo["claims"][0]["claim_id"], expected_state_revision=undo["state_revision"],
            replacement=dict(subject="a", predicate="uses", object="b", qualifiers=self.qualifiers,
                             context=dict(domain=None, viewpoints=[]))))
        self.assertEqual(policy.status_code, 200, policy.text)
        policy = policy.json()["data"]
        unpolicy = self.post("policy-undos", dict(event_id=policy["event_id"], expected_state_revision=policy["state_revision"]))
        self.assertEqual(unpolicy.status_code, 200, unpolicy.text)
        state = self.state()
        self.assertEqual(len(state["history"]), 4)
        self.assertEqual([item["reason"] for item in state["history"]], ["simulation"] * 4)
        for event in state["history"]:
            self.assertEqual(event["actor"]["user_id"], self.user["user_id"])
            self.assertEqual(event["actor"]["profile_id"], "default")
        self.assertEqual(state["policies"][0]["status"], "inactive")
        self.assertEqual(state["machine_graph"], original["machine_graph"])
        self.assertEqual(self.read()["revision"], self.source)

    def test_all_routes_check_their_permission_before_invalid_body_processing(self):
        before = self.state()
        for permission, allowed in ((None, set()), ("ontology_review", {"reviews", "review-undos"}),
                                    ("ontology_policy", {"policies", "policy-undos"})):
            permissions = ["read", *([permission] if permission else [])]
            self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=permissions))
            for operation in ("reviews", "review-undos", "policies", "policy-undos"):
                with self.subTest(permission=permission, operation=operation):
                    result = self.post(operation, {"expected_state_revision": "invalid"})
                    self.assertEqual(result.status_code, 422 if operation in allowed else 403)
        self.assertEqual(self.state()["history"], before["history"])
        self.assertEqual(self.read()["revision"], self.source)

    def test_review_rechecks_permission_at_commit_without_changing_any_layer(self):
        before = self.state()
        review = ReviewStore.review

        def revoked(store, *args, **kwargs):
            self.change_policy(lambda value: value["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
            return review(store, *args, **kwargs)

        with patch.object(ReviewStore, "review", revoked):
            result = self.post("reviews", dict(action="reject", claim_id=before["claims"][0]["claim_id"],
                                              expected_state_revision=before["state_revision"]))
        self.assertEqual(result.status_code, 403, result.text)
        current = self.state()
        for key in ("history", "state_revision", "machine_graph", "source_revision"):
            self.assertEqual(current[key], before[key])
