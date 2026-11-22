"""Lossless citation references, bounded admission and real receipt compatibility."""

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.client.ai.contracts import AIAdapterError
from core.client.question_ai import assemble_question
from core.client.question_grounding import _append_evidence, run_grounded_model
from core.client.transport import AnalysisClientError
from core.common.evidence_transport import (INITIAL_CITATION_ENCODING, compact_initial_citations,
    expand_initial_citations, initial_citation_encoding)
from core.common.json_codec import canonical_json_bytes, canonical_json_hash
from core.modules.knowledge.aggregation import prepare_question
from core.modules.knowledge.question_evidence import initial_evidence, resolve_evidence_ids
from core.modules.ontology.store import OntologyStore
from core.modules.personal.question_runs import QuestionRunStore
from core.tests.poc_knowledge.test_question_grounding_client import (FakeAdapter, FakeOwner, handoff_fixture,
    record_for, step)
from core.tests.poc_knowledge import test_question_prefetch as prefetch_tests
from core.tests.poc_knowledge.test_storage import ACTOR, ENTITIES, RELATIONS, KnowledgeFixture
from core.tests.poc_mcp.test_server_integration import ServerFixture


def response_fixture(text=None):
    text = text or "앞말😀e\u0301\u2028" + "exact 조건 and exceptions remain verbatim. " * 15
    citation = {"kind": "document", "document": "source.md", "source_revision": "a" * 64, "quote": text}
    source = {"kind": "source", "material_id": "d1", "evidence_id": "s1:2:2", "document": "source.md",
        "source_revision": "a" * 64, "start_line": 2, "end_line": 2, "text": text, "context_limited": False}
    claim_quote = text[7:]
    claim = {"kind": "claim", "document": "source.md", "source_revision": "a" * 64,
        "state_revision": "b" * 64, "graph_revision": "c" * 64, "claim_id": "d" * 64, "quote": claim_quote}
    return {"kind": "question_evidence", "action": "initial", "items": [source,
        {"kind": "claim", "item_id": "c1:1", "evidence_id": "c1:1", "source_evidence_ids": ["s1:2:2"],
         "source_value": {"condition": "Preserve the exact condition."}}],
        "evidence_ids": ["s1:2:2", "c1:1"],
        "citations": [{"evidence_id": "s1:2:2", "citation": citation}, {"evidence_id": "c1:1", "citation": claim}],
        "scope": {"absence_proven": False}, "complete": False, "truncated": True,
        "skipped": [{"code": "fixture_incomplete"}], "omitted_count": 1}


class CitationCodecTests(unittest.TestCase):
    def test_unicode_round_trip_preserves_every_nontransport_value_without_mutation(self):
        original = response_fixture()
        before = deepcopy(original)
        wire = compact_initial_citations(original)
        self.assertEqual(original, before)
        self.assertEqual(wire["citation_encoding"], INITIAL_CITATION_ENCODING)
        self.assertEqual(wire["citations"][1]["citation"]["quote_ref"]["start"], 7)
        self.assertEqual(expand_initial_citations(wire, expected_encoding=INITIAL_CITATION_ENCODING), original)
        self.assertLess(len(canonical_json_bytes(wire)), len(canonical_json_bytes(original)))
        self.assertEqual(wire["items"], original["items"])

    def test_short_response_keeps_legacy_wire_even_with_negotiated_policy(self):
        original = response_fixture("A uses B.")
        wire = compact_initial_citations(original)
        self.assertEqual(wire, original)
        self.assertEqual(expand_initial_citations(wire, expected_encoding=INITIAL_CITATION_ENCODING), original)

    def test_nonexact_or_other_document_revision_claim_quote_stays_literal(self):
        for changed in [{"quote": "not in source"}, {"document": "other.md"}, {"source_revision": "f" * 64}]:
            with self.subTest(changed=changed):
                original = response_fixture()
                original["citations"][1]["citation"].update(changed)
                wire = compact_initial_citations(original)
                self.assertEqual(wire["citations"][1], original["citations"][1])
                self.assertEqual(expand_initial_citations(wire, expected_encoding=INITIAL_CITATION_ENCODING), original)

    def test_policy_review_original_and_web_quotes_are_not_reference_targets(self):
        original = response_fixture()
        for index, kind in enumerate(["policy", "review", "source", "web"], 1):
            identifier = f"p1:{index}"
            citation = {"kind": kind, "document": "source.md", "source_revision": "a" * 64,
                        "quote": original["items"][0]["text"]}
            original["citations"].append({"evidence_id": identifier, "citation": citation})
            original["evidence_ids"].append(identifier)
        wire = compact_initial_citations(original)
        self.assertEqual(wire["citations"][2:], original["citations"][2:])

    def test_unknown_policy_encoding_and_unnegotiated_refs_reject(self):
        wire = compact_initial_citations(response_fixture())
        for encoding in [None, "future", False]:
            with self.subTest(encoding=encoding), self.assertRaises(ValueError):
                expand_initial_citations(wire, expected_encoding=encoding)
        for value in [None, "future", False]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                initial_citation_encoding({"initial_citation_encoding": value})
        unknown = deepcopy(wire); unknown["citation_encoding"] = "future"
        with self.assertRaises(ValueError):
            expand_initial_citations(unknown, expected_encoding=INITIAL_CITATION_ENCODING)
        missing = deepcopy(wire); missing.pop("citation_encoding")
        with self.assertRaises(ValueError):
            expand_initial_citations(missing, expected_encoding=INITIAL_CITATION_ENCODING)

    def test_bad_ranges_cross_source_nested_and_dual_references_reject(self):
        wire = compact_initial_citations(response_fixture())
        changes = [lambda r: r.update(start=True), lambda r: r.update(end=1.5),
            lambda r: r.update(start=-1), lambda r: r.update(end=100000), lambda r: r.update(end=0),
            lambda r: r.update(evidence_id="s2:2:2"), lambda r: r.update(evidence_id="c1:1"),
            lambda r: r.update(extra="unknown"), lambda r: r.update(evidence_id={"quote_ref": "s1:2:2"})]
        for change in changes:
            bad = deepcopy(wire); change(bad["citations"][1]["citation"]["quote_ref"])
            with self.subTest(change=change), self.assertRaises(ValueError):
                expand_initial_citations(bad, expected_encoding=INITIAL_CITATION_ENCODING)
        for change in [lambda c: c.update(document="other.md"), lambda c: c.update(source_revision="f" * 64),
                       lambda c: c.update(quote="literal and reference"), lambda c: c.update(kind="web")]:
            bad = deepcopy(wire); change(bad["citations"][1]["citation"])
            with self.assertRaises(ValueError):
                expand_initial_citations(bad, expected_encoding=INITIAL_CITATION_ENCODING)

    def test_missing_duplicate_mismatched_source_items_and_citations_reject(self):
        wire = compact_initial_citations(response_fixture())
        changes = [lambda r: r["items"].pop(0), lambda r: r["items"].append(deepcopy(r["items"][0])),
            lambda r: r["evidence_ids"].append(r["evidence_ids"][0]), lambda r: r["citations"].reverse(),
            lambda r: r["items"][0].update(material_id="d2"), lambda r: r["items"][0].update(start_line=True),
            lambda r: r["items"][0].update(text="short"),
            lambda r: r["citations"][0]["citation"]["quote_ref"].update(start=1),
            lambda r: r.update(action="read")]
        for change in changes:
            bad = deepcopy(wire); change(bad)
            with self.subTest(change=change), self.assertRaises(ValueError):
                expand_initial_citations(bad, expected_encoding=INITIAL_CITATION_ENCODING)

    def test_registry_and_model_view_are_identical_for_same_items(self):
        original = response_fixture(); wire = compact_initial_citations(original)
        legacy_registry, legacy_reads, compact_registry, compact_reads = {}, [], {}, []
        _append_evidence({"action": "initial"}, original, legacy_registry, legacy_reads)
        _append_evidence({"action": "initial"}, wire, compact_registry, compact_reads,
                         citation_encoding=INITIAL_CITATION_ENCODING)
        self.assertEqual((legacy_registry, legacy_reads), (compact_registry, compact_reads))
        with self.assertRaises(AIAdapterError):
            _append_evidence({"action": "read"}, wire, {}, [])


class CitationAdmissionTests(KnowledgeFixture, unittest.TestCase):
    def rich_basis(self):
        quotes = [f"A uses B{n}. " + (f"detail{n} " * count) for n, count in enumerate([45, 210, 40], 1)]
        source = self.document(body="\n\n".join(quotes) + "\n", plain=True)
        entities = [{"id": "a", "label": "A", "type": "system", "evidence": quotes[0]}]
        entities += [{"id": f"b{n}", "label": f"B{n}", "type": "system", "evidence": q[:980].rstrip()} for n, q in enumerate(quotes, 1)]
        relations = [{"subject": "a", "predicate": "uses", "object": f"b{n}", "evidence": q[:980].rstrip()}
                     for n, q in enumerate(quotes, 1)]
        self.ontology.generate("a.md", source.revision, entities, relations)
        return prepare_question(self.wiki, ACTOR, documents=["a.md"], required_documents=[], claims=[],
            source_refs=[], retrieval_scope="selected", lookup_question="A B1 B2 B3")

    def test_group_admission_preserves_baseline_items_and_atomic_source_groups(self):
        basis = self.rich_basis(); before = self.tree()
        added = 0
        for limit in [7000, 9000, 11000, 13000, 17000, 24576]:
            with self.subTest(limit=limit), patch("core.modules.knowledge.question_evidence.MAX_RESPONSE_BYTES", limit):
                old = initial_evidence(basis, "A B1 B2 B3")
                wire = initial_evidence(basis, "A B1 B2 B3", compact_citations=True)
                new = expand_initial_citations(wire, expected_encoding=INITIAL_CITATION_ENCODING)
                old_items = {i.get("item_id", i.get("evidence_id")): i for i in old["items"]}
                new_items = {i.get("item_id", i.get("evidence_id")): i for i in new["items"]}
                self.assertTrue(old_items.keys() <= new_items.keys())
                for key, item in old_items.items(): self.assertEqual(item, new_items[key])
                for item in new["items"]:
                    if item["kind"] == "claim":
                        self.assertTrue(set(item["source_evidence_ids"]) <= set(new["evidence_ids"]))
                self.assertEqual([c["citation"] for c in new["citations"]], resolve_evidence_ids(basis, new["evidence_ids"]))
                self.assertLessEqual(len(canonical_json_bytes(wire)), limit)
                added += len(new_items) - len(old_items)
        self.assertGreater(added, 0)
        self.assertEqual(before, self.tree())

    def test_default_false_is_exact_and_invalid_options_reject(self):
        basis = self.rich_basis()
        self.assertEqual(initial_evidence(basis, "A"), initial_evidence(basis, "A", compact_citations=False))
        for value in [1, None, "true"]:
            with self.assertRaises(ValueError): initial_evidence(basis, "A", compact_citations=value)

    def test_new_earlier_group_must_not_displace_an_existing_later_group(self):
        from core.modules.knowledge import question_evidence as module
        basis = self.rich_basis(); proposals = []
        append = module._append_initial_group
        def capture(*args):
            result = append(*args)
            proposals.append(deepcopy(result[0]))
            return result
        with patch.object(module, "MAX_RESPONSE_BYTES", 11000):
            with patch.object(module, "_append_initial_group", side_effect=capture):
                baseline = initial_evidence(basis, "A B1 B2 B3")
            # A naive compressed greedy pass would accept this earlier pair and
            # leave too little room for baseline's third claim.
            earlier = next(r for r in proposals if [i["evidence_id"] for i in r["items"] if i["kind"] == "claim"] == ["c1:1", "c1:2"])
            self.assertLessEqual(len(canonical_json_bytes(compact_initial_citations(earlier))), 11000 - 4096)
            self.assertEqual([i["evidence_id"] for i in baseline["items"] if i["kind"] == "claim"], ["c1:1", "c1:3"])
            wire = initial_evidence(basis, "A B1 B2 B3", compact_citations=True)
            self.assertEqual([i["evidence_id"] for i in wire["items"] if i["kind"] == "claim"], ["c1:1", "c1:3"])

    def test_added_claim_keeps_existing_passage_context_limit_and_full_item(self):
        # The legacy budget omits the large claim group but admits its source
        # passage. Compaction admits the earlier claim group containing the
        # same source ID, whose raw item has a less conservative context flag.
        first_line = "A uses B. " + "x" * 9000
        source = self.document(body=first_line + "\nEXCEPTION: the following condition is not in the passage.\n", plain=True)
        quote = first_line[:980]
        self.ontology.generate("a.md", source.revision,
            [{**entity, "evidence": quote} for entity in ENTITIES], [{**RELATIONS[0], "evidence": quote}])
        basis = prepare_question(self.wiki, ACTOR, documents=["a.md"], required_documents=[], claims=[],
            source_refs=[], retrieval_scope="selected", lookup_question="A B")
        before = self.tree()
        old = initial_evidence(basis, "A B")
        self.assertEqual([(i["evidence_id"], i.get("context_limited")) for i in old["items"]], [("s1:1:1", True)])
        wire = initial_evidence(basis, "A B", compact_citations=True)
        new = expand_initial_citations(wire, expected_encoding=INITIAL_CITATION_ENCODING)
        self.assertIn("c1:1", new["evidence_ids"])
        self.assertLess(new["omitted_count"], old["omitted_count"])
        new_items = {i.get("item_id", i.get("evidence_id")): i for i in new["items"]}
        for item in old["items"]:
            self.assertEqual(item, new_items[item.get("item_id", item.get("evidence_id"))])
        new_citations = {row["evidence_id"]: row for row in new["citations"]}
        for row in old["citations"]:
            self.assertEqual(row, new_citations[row["evidence_id"]])
        self.assertTrue(new_items["s1:1:1"]["context_limited"])
        self.assertEqual(self.tree(), before)


class CitationTransportClientTests(unittest.IsolatedAsyncioTestCase):
    def handoff(self, wire):
        handoff = handoff_fixture()
        handoff.update(contract_version="personal-question-v6", initial_evidence={"action": "initial",
            "sha256": canonical_json_hash(wire), "citation_encoding": INITIAL_CITATION_ENCODING})
        handoff["input_sha256"] = canonical_json_hash({k:v for k,v in handoff.items() if k != "input_sha256"})
        return handoff

    async def test_wire_hash_checked_before_decode_and_no_model_on_bad_hash(self):
        wire = compact_initial_citations(response_fixture()); handoff = self.handoff(wire)
        handoff["initial_evidence"]["sha256"] = "0" * 64
        with TemporaryDirectory() as directory:
            owner = FakeOwner(directory, [wire]); adapter = FakeAdapter([])
            with patch("core.client.question_grounding.expand_initial_citations", side_effect=AssertionError("decode before hash")):
                with self.assertRaises(AIAdapterError): await run_grounded_model(owner, adapter, handoff)
            self.assertFalse(adapter.calls)

    async def test_actual_answer_keeps_full_quote_raw_wire_hash_and_usage_with_aliases_off(self):
        original = response_fixture(); wire = compact_initial_citations(original); handoff = self.handoff(wire)
        with TemporaryDirectory() as directory:
            owner = FakeOwner(directory, [wire]); adapter = FakeAdapter([step("answer", content="Conditions remain [[c1:1]].", evidence_ids=["c1:1"])])
            result, _ = await run_grounded_model(owner, adapter, handoff, select_tools=True, compact_versions=False)
            self.assertEqual(result["value"]["citations"], [original["citations"][1]["citation"]])
            self.assertEqual(len(adapter.calls), 1)
            self.assertNotIn("quote_ref", adapter.calls[0]["prompt"])
            self.assertNotIn("citation_encoding", adapter.calls[0]["prompt"])
            self.assertNotIn("question_version_aliases", result["execution"])
            self.assertEqual(result["execution"]["question_automatic_reads"][0]["evidence_sha256"], canonical_json_hash(wire))

    async def test_expanded_context_limit_is_still_enforced(self):
        wire = compact_initial_citations(response_fixture()); handoff = self.handoff(wire)
        with TemporaryDirectory() as directory, patch("core.client.question_grounding.MAX_CONTEXT_BYTES", 1000):
            owner = FakeOwner(directory, [wire]); adapter = FakeAdapter([])
            with self.assertRaises(AIAdapterError): await run_grounded_model(owner, adapter, handoff)
            self.assertFalse(adapter.calls)

    def test_handoff_policy_is_pinned_and_old_record_or_unknown_policy_is_rejected(self):
        wire = compact_initial_citations(response_fixture()); handoff = self.handoff(wire)
        record = record_for(handoff); record["data"]["initial_evidence_sha256"] = canonical_json_hash(wire)
        with self.assertRaises(AnalysisClientError): assemble_question(handoff, record)
        record["data"]["initial_citation_encoding"] = INITIAL_CITATION_ENCODING
        assemble_question(handoff, record)
        for value in [None, "future"]:
            record["data"]["initial_citation_encoding"] = value
            with self.assertRaises(AnalysisClientError): assemble_question(handoff, record)


class CitationTransportHTTPTests(ServerFixture):
    def setUp(self):
        super().setUp()
        from core.api.dependencies import access_value
        self.scope = self.policy.authorize(self.token, self.tenant, "read")
        self.store = self.scope.store; self.actor = access_value(self.scope)
        self.body = "A uses B. " + "The exact source condition remains available. " * 20 + "\nB is a pump.\n"
        source = self.store.save("a.md", self.body, expected_revision=None)
        OntologyStore(self.store).generate("a.md", source.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        self.base_url = f"/api/v1/tenants/{self.tenant}"
        self.context = {"documents": ["a.md"], "required_documents": ["a.md"], "mode": "on_demand",
                        "retrieval_scope": "selected", "lookup_question": "A B"}

    post = prefetch_tests.QuestionPrefetchHTTPTests.post
    get = prefetch_tests.QuestionPrefetchHTTPTests.get
    conversation = prefetch_tests.QuestionPrefetchHTTPTests.conversation
    append = prefetch_tests.QuestionPrefetchHTTPTests.append
    evidence_payload = prefetch_tests.QuestionPrefetchHTTPTests.evidence_payload
    evidence = prefetch_tests.QuestionPrefetchHTTPTests.evidence
    answer_payload = prefetch_tests.QuestionPrefetchHTTPTests.answer_payload
    submit = prefetch_tests.QuestionPrefetchHTTPTests.submit

    def start(self, *, compact=True):
        factory = lambda scope, **options: QuestionRunStore(scope, compact_initial_citations=compact, **options)
        with patch("core.api.v1.personal.workflows_router.QuestionRunStore", side_effect=factory):
            return prefetch_tests.QuestionPrefetchHTTPTests.start(self, context=self.context, text="Does A use B?")

    def test_create_delivery_replay_restart_and_submission_use_exact_source(self):
        execution = self.start()
        record = execution["active"]["record"]
        self.assertEqual(record["data"]["initial_citation_encoding"], INITIAL_CITATION_ENCODING)
        assemble_question(execution["handoff"], record)
        request, receipt = self.evidence(execution, action="initial")
        wire = receipt["evidence"]
        self.assertEqual(canonical_json_hash(wire), execution["handoff"]["initial_evidence"]["sha256"])
        self.assertEqual(wire["citation_encoding"], INITIAL_CITATION_ENCODING)
        replay = self.post(f"/question-runs/{execution['run_id']}/evidence", request)
        self.assertTrue(replay["replayed"]); self.assertEqual(replay["evidence"], wire)
        restarted = QuestionRunStore(self.scope).evidence_receipt(execution["run_id"], request["request_id"])
        self.assertEqual(restarted["evidence"], wire)
        expanded = expand_initial_citations(wire, expected_encoding=INITIAL_CITATION_ENCODING)
        self.submit(execution, self.answer_payload(execution, {"evidence": expanded}))
        self.assertEqual(self.store.read("a.md").content, self.body)

    def test_end_to_end_client_expands_before_saved_answer(self):
        execution = self.start(); fixture = self
        wire = execution["active"]["record"]["data"]["initial_evidence"]
        identifier = next(c["evidence_id"] for c in wire["citations"] if "quote_ref" in c["citation"])
        class HttpOwner(FakeOwner):
            async def query_evidence(owner, query):
                owner.queries.append(deepcopy(query)); return fixture.evidence(execution, **query)[1]["evidence"]
        with TemporaryDirectory() as directory:
            owner = HttpOwner(directory); adapter = FakeAdapter([step("answer", content=f"A uses B [[{identifier}]].", evidence_ids=[identifier])])
            result, _ = asyncio.run(run_grounded_model(owner, adapter, execution["handoff"], select_tools=True, compact_versions=False))
            payload = self.answer_payload(execution, {"evidence": wire}, ids=result["evidence_ids"], citations=result["value"]["citations"])
            payload["content"] = result["value"]["content"]
            payload["execution"]["output_sha256"] = sha256(payload["content"].encode()).hexdigest()
            self.submit(execution, payload)

    def test_legacy_default_and_create_request_replay_do_not_change_frozen_policy(self):
        execution = self.start(compact=False)
        self.assertNotIn("initial_citation_encoding", execution["active"]["record"]["data"])
        self.assertNotIn("citation_encoding", execution["handoff"]["initial_evidence"])
        record = execution["active"]["record"]
        store = QuestionRunStore(self.scope, compact_initial_citations=True)
        request_id = next(iter(record["requests"]))
        payload = {"request_id": request_id, "conversation_id": record["data"]["conversation_id"],
            "question_turn_id": record["data"]["question_turn_id"],
            "expected_conversation_revision": execution["conversation"]["revision"]}
        replay = store.create(**payload, before_commit=lambda: None)
        self.assertTrue(replay["replayed"])
        self.assertNotIn("initial_citation_encoding", replay["record"]["data"])

    def test_initial_encoding_does_not_bypass_read_cap_staleness_or_revocation(self):
        execution = self.start(); self.evidence(execution, action="initial")
        for _ in range(5): self.evidence(execution)
        self.post(f"/question-runs/{execution['run_id']}/evidence", self.evidence_payload(execution), 413)
        current = self.start(); source = self.store.read("a.md")
        self.store.save("a.md", source.content + "changed\n", expected_revision=source.revision)
        self.post(f"/question-runs/{current['run_id']}/evidence", self.evidence_payload(current, action="initial"), 409)
        self.change_policy(lambda p: p["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=["read"]))
        self.post(f"/question-runs/{current['run_id']}/evidence", self.evidence_payload(current, action="initial"), 403)

    def test_new_lease_requires_new_delivery_and_old_citation_cannot_be_reused(self):
        execution = self.start(); _, served = self.evidence(execution, action="initial")
        expanded = expand_initial_citations(served["evidence"], expected_encoding=INITIAL_CITATION_ENCODING)
        with patch("core.modules.personal.question_runs._now", return_value=datetime.now(timezone.utc) + timedelta(seconds=301)):
            reclaimed = self.post(f"/question-runs/{execution['run_id']}/claim", {"request_id": uuid4().hex,
                "expected_state_revision": execution["active"]["state_revision"], "reclaim": True})
        execution["active"] = reclaimed
        self.post(f"/question-runs/{execution['run_id']}/answers", self.answer_payload(execution, {"evidence": expanded}), 422)
        self.evidence(execution, action="initial")

    def test_server_rejects_wrong_exact_substring_and_corrupt_policy(self):
        execution = self.start(); record = deepcopy(execution["active"]["record"])
        store = QuestionRunStore(self.scope)
        bad = deepcopy(record["data"]["initial_evidence"])
        claim = next(c for c in bad["citations"] if c["citation"]["kind"] == "claim")
        claim["citation"].pop("quote", None)
        source = next(i for i in bad["items"] if i["kind"] == "source")
        claim["citation"]["quote_ref"] = {"evidence_id": source["evidence_id"], "start": 1, "end": 8}
        with self.assertRaises(ValueError): store._check_initial_transport(record, bad)
        record["data"]["initial_citation_encoding"] = "unknown"
        with self.assertRaises(ValueError): store._input(record)
        with self.assertRaises(ValueError): store._check_initial_transport(record, bad)

    def test_small_wire_fallback_retains_pinned_handoff_and_exact_submission(self):
        source = self.store.read("a.md")
        self.store.save("a.md", "A uses B.\n", expected_revision=source.revision)
        execution = self.start()
        self.assertEqual(execution["handoff"]["initial_evidence"]["citation_encoding"], INITIAL_CITATION_ENCODING)
        _, receipt = self.evidence(execution, action="initial")
        self.assertNotIn("citation_encoding", receipt["evidence"])
        expanded = expand_initial_citations(receipt["evidence"], expected_encoding=INITIAL_CITATION_ENCODING)
        self.assertEqual(expanded, receipt["evidence"])
        self.submit(execution, self.answer_payload(execution, {"evidence": expanded}))

    def test_tampered_retained_receipt_cannot_replay_or_validate_submission(self):
        execution = self.start(); request, receipt = self.evidence(execution, action="initial")
        expanded = expand_initial_citations(receipt["evidence"], expected_encoding=INITIAL_CITATION_ENCODING)
        payload = self.answer_payload(execution, {"evidence": expanded})
        store = QuestionRunStore(self.scope)
        for mode in ["hash", "reference", "policy"]:
            with self.subTest(mode=mode):
                record = deepcopy(receipt["record"])
                event = next(e for e in record["events"] if e["id"] == request["request_id"])
                if mode == "policy":
                    record["data"]["initial_citation_encoding"] = "future"
                else:
                    row = next(r for r in event["evidence"]["citations"] if "quote_ref" in r["citation"])
                    row["citation"]["quote_ref"]["start"] += 1
                    if mode == "reference": event["evidence_sha256"] = canonical_json_hash(event["evidence"])
                with self.assertRaises(ValueError):
                    store._evidence_receipt(record, request["request_id"], replayed=True)
                with self.assertRaises(ValueError):
                    store._grounded_citations(record, payload)

    def test_constructor_rejects_nonboolean_and_nonprefetch_use(self):
        for value in [None, 1, "true"]:
            with self.assertRaises(ValueError): QuestionRunStore(self.scope, compact_initial_citations=value)
        with patch.dict(self.context, {"retrieval_scope": None}):
            # The explicit developer option must not silently change v5 behavior.
            conversation, qid = self.append(self.conversation(), context={k:v for k,v in self.context.items()
                if k not in {"retrieval_scope", "lookup_question"}})
            with self.assertRaises(ValueError):
                QuestionRunStore(self.scope, compact_initial_citations=True).create(request_id=uuid4().hex,
                    conversation_id=conversation["record"]["id"], question_turn_id=qid,
                    expected_conversation_revision=conversation["revision"], before_commit=lambda: None)
