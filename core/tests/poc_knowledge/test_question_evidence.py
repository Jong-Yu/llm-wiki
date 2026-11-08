"""고정 근거의 부분 읽기가 원문·판단·과거 사건을 바꾸거나 혼동하지 않는다."""

from copy import deepcopy
from hashlib import sha256
import unittest

from core.common.json_codec import canonical_json_bytes
from core.modules.knowledge.question_evidence import read_evidence, resolve_evidence_ids, MAX_RESPONSE_BYTES
from core.modules.personal.question_runs import QuestionRunStore


def basis_fixture():
    content = ("# Signing\r\nMender Client verifies the Artifact with the public key.\r\n"
               "If ArtifactVerifyKey(s) is configured, unsigned Artifacts abort.\r\n"
               "It does not mean every device enables verification.\r\n\r\n"
               "# 개념\r\n선박과 선주는 다르다.\r\n")
    raw = {"subject": "client", "predicate": "uses", "object": "public_key",
        "evidence": {"quote": "Mender Client verifies the Artifact with the public key.", "start_line": 2, "end_line": 2},
        "qualifiers": {"condition": None, "modality": "asserted", "polarity": "positive", "scope": None, "time": None},
        "provenance": {"source_entity": None, "attributed_to": None, "basis": None}}
    edited = deepcopy(raw)
    edited["qualifiers"]["condition"] = "If ArtifactVerifyKey(s) is configured"
    first = {"claim_id": "a" * 64, "collection": "relations", "value": raw,
             "reviewed_value": edited, "decision": "edit", "needs_review": False, "review_event_id": "2" * 32}
    rejected = {**deepcopy(first), "claim_id": "b" * 64, "decision": "reject", "review_event_id": "4" * 32}
    deferred = {**deepcopy(first), "claim_id": "c" * 64, "decision": "defer", "needs_review": True,
                "review_event_id": "5" * 32}
    actor = {"user_id": "alice", "tenant": "test", "profile_id": "default", "origin": "ai"}
    history = [
        {"id": "1" * 32, "action": "accept", "claim_id": first["claim_id"], "reason": "Earlier source judgment",
         "actor": actor, "before": {"decision": "unreviewed"}, "after": {"decision": "accept", "value": raw}},
        {"id": "2" * 32, "action": "edit", "claim_id": first["claim_id"], "reason": "Preserve configuration condition",
         "actor": actor, "before": {"decision": "accept", "value": raw}, "after": {"decision": "edit", "value": edited}},
        {"id": "3" * 32, "action": "policy", "reason": "Named scope policy", "actor": actor},
        {"id": "4" * 32, "action": "reject", "claim_id": rejected["claim_id"], "reason": "Unsupported identity",
         "actor": actor, "after": {"decision": "reject"}},
        {"id": "5" * 32, "action": "defer", "claim_id": deferred["claim_id"], "reason": "Need actual configuration",
         "actor": actor, "after": {"decision": "defer"}},
    ]
    entities = [{"id": "client", "label": "Mender Client", "type": "system"},
                {"id": "public_key", "label": "corresponding public key", "type": "concept"}]
    knowledge = {"status": "ready", "state_revision": "e" * 64, "graph_revision": "f" * 64,
        "source_revision": sha256(content.encode()).hexdigest(),
        "claims": [first, rejected, deferred], "history": history, "current_pending_history": ["5" * 32],
        "machine_graph": {"entities": entities}, "effective_graph": {"entities": entities},
        "policies": [{"status": "active", "event_id": "3" * 32, "scope": {"profile_id": "default"},
                      "value": {"condition": "only in the explicitly assessed scope"}}]}
    document = {"document": "signing.md", "source_revision": sha256(content.encode()).hexdigest(),
                "content": content, "knowledge": knowledge}
    original_content = "Original paragraph.\nNext source line.\n"
    web_content = "External source reports a capability.\nIt does not prove installation."
    return {"kind": "question_context", "snapshot_revision": "d" * 64, "complete": True,
        "documents": [document], "originals": [{"source_ref": {"source_id": "6" * 32,
            "source_version": "7" * 32, "source_sha256": sha256(original_content.encode()).hexdigest()},
            "content": original_content}],
        "web": {"status": "complete", "sources": [{"url": "https://example.org/capability", "title": "Capability",
            "content": web_content, "content_sha256": sha256(web_content.encode()).hexdigest(),
            "retrieved_at": "2026-11-06T00:00:00Z"}]}}


class QuestionEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.basis = basis_fixture()

    def test_read_preserves_crlf_and_exact_source_positions(self):
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1", "start_line": 2, "line_count": 2})
        self.assertEqual(result["evidence_ids"], ["s1:2:3"])
        quote = result["items"][0]["text"]
        self.assertIn("\r\n", quote)
        self.assertEqual(result["items"][0]["start_line"], 2)
        self.assertTrue(result["items"][0]["context_limited"])
        self.assertIn(quote, self.basis["documents"][0]["content"])
        self.assertEqual(resolve_evidence_ids(self.basis, result["evidence_ids"]),
                         [row["citation"] for row in result["citations"]])

    def test_search_normalizes_case_width_and_keeps_korean(self):
        first = read_evidence(self.basis, {"action": "search", "query": "ｍｅｎｄｅｒ"})
        second = read_evidence(self.basis, {"action": "search", "query": "MENDER"})
        self.assertEqual(first["evidence_ids"], second["evidence_ids"])
        korean = read_evidence(self.basis, {"action": "search", "query": "선주"})
        self.assertTrue(any("선박과 선주" in item["text"] for item in korean["items"]))

    def test_empty_and_missing_search_never_prove_absence(self):
        missing = read_evidence(self.basis, {"action": "search", "query": "not-present-zxy"})
        self.assertEqual(missing["items"], [])
        self.assertTrue(missing["complete"])
        self.assertFalse(missing["scope"]["absence_proven"])
        self.assertEqual(missing["scope"]["coverage"], "query_result_only")
        browse = read_evidence(self.basis, {"action": "search", "query": "", "limit": 1})
        self.assertEqual(len(browse["items"]), 1)
        self.assertTrue(browse["truncated"])

    def test_unicode_separator_is_not_a_new_source_line(self):
        self.basis["documents"][0]["content"] = "A\u2028B\nSecond\n"
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1", "start_line": 1, "line_count": 1})
        self.assertEqual(result["items"][0]["text"], "A\u2028B")
        self.assertEqual(result["evidence_ids"], ["s1:1:1"])

    def test_claims_keep_edit_reject_defer_and_conditions(self):
        result = read_evidence(self.basis, {"action": "claims", "material_id": "d1", "limit": 10})
        claims = [item for item in result["items"] if item["kind"] == "claim"]
        self.assertEqual([item["decision"] for item in claims], ["edit", "reject", "defer"])
        self.assertIsNone(claims[0]["source_value"]["qualifiers"]["condition"])
        self.assertIn("ArtifactVerifyKey", claims[0]["reviewed_value"]["qualifiers"]["condition"])
        self.assertTrue(claims[2]["needs_review"])
        self.assertEqual(claims[0]["entities"][0]["label"], "Mender Client")
        self.assertEqual(claims[0]["review_evidence_id"], "h1:2")
        self.assertNotEqual(claims[0]["evidence_id"], claims[1]["evidence_id"])

    def test_claim_source_anchor_is_preserved_without_entity_hashing(self):
        anchor = {"kind": "source_anchor", "document": "signing.md", "quote": "Mender Client"}
        self.basis["documents"][0]["knowledge"]["claims"][0]["value"]["subject"] = anchor
        result = read_evidence(self.basis, {"action": "claims", "material_id": "d1", "limit": 1})
        self.assertEqual(result["items"][0]["source_value"]["subject"], anchor)

    def test_review_events_preserve_old_and_current_without_policy_promotion(self):
        result = read_evidence(self.basis, {"action": "history", "material_id": "d1", "limit": 10})
        old, current = result["items"][:2]
        self.assertFalse(old["is_current_judgment"])
        self.assertTrue(current["is_current_judgment"])
        self.assertEqual(current["event"]["before"]["decision"], "accept")
        self.assertEqual(current["event"]["after"]["decision"], "edit")
        self.assertEqual(current["event"]["actor"]["origin"], "ai")
        citation = resolve_evidence_ids(self.basis, ["h1:2"])[0]
        self.assertEqual(citation["kind"], "review")
        self.assertEqual(citation["ledger"], "review")
        self.assertNotIn("quote", citation)
        self.assertEqual(citation["event_id"], "2" * 32)
        self.assertTrue(result["items"][4]["pending"])

    def test_policy_keeps_applicability_and_requires_actual_active_event(self):
        result = read_evidence(self.basis, {"action": "claims", "material_id": "d1", "query": "assessed scope"})
        self.assertEqual(result["items"][0]["kind"], "policy")
        self.assertTrue(result["items"][0]["applicability_not_automatically_proven"])
        self.assertEqual(resolve_evidence_ids(self.basis, ["p1:1"])[0]["kind"], "policy")
        self.basis["documents"][0]["knowledge"]["policies"][0]["status"] = "inactive"
        with self.assertRaises(ValueError):
            resolve_evidence_ids(self.basis, ["p1:1"])

    def test_policy_falls_back_to_its_actual_creation_event(self):
        self.basis["documents"][0]["knowledge"]["policies"][0]["decision_event_id"] = "9" * 32
        self.assertEqual(resolve_evidence_ids(self.basis, ["p1:1"])[0]["event_id"], "3" * 32)

    def relation(self, *, status="active", kind="source"):
        knowledge = self.basis["documents"][0]["knowledge"]
        value = deepcopy(knowledge["claims"][0]["value"])
        if kind == "policy":
            value["evidence"] = None
            value["provenance"] = {"kind": "expert_policy", "event_id": "1" * 32}
        event = {"id": "1" * 32, "action": "relation_create", "kind": kind, "claim_id": "9" * 64,
                 "value": value, "reason": "Independent addition", "scope": {"viewpoint": "business"},
                 "actor": {"user_id": "alice", "origin": "ai"}}
        knowledge["relation_history"] = [event]
        knowledge["authored_relations"] = [{"event_id": event["id"], "claim_id": event["claim_id"], "kind": kind,
                                           "status": status, "scope": event["scope"], "value": value}]
        return knowledge

    def test_independent_relation_is_readable_and_same_event_id_does_not_mix_ledgers(self):
        self.relation()
        claims = read_evidence(self.basis, {"action": "claims", "material_id": "d1", "limit": 10})
        independent = next(item for item in claims["items"] if item["kind"] == "authored_relation")
        self.assertEqual(independent["origin"], "independent_relation")
        self.assertEqual(independent["evidence_id"], "h1:6")
        self.assertIn("h1:6", claims["evidence_ids"])
        history = read_evidence(self.basis, {"action": "history", "material_id": "d1", "limit": 10})
        self.assertFalse(history["items"][0]["is_current_judgment"])
        self.assertTrue(history["items"][5]["is_current_judgment"])
        first, independent_citation = resolve_evidence_ids(self.basis, ["h1:1", "h1:6"])
        self.assertEqual(first["event_id"], independent_citation["event_id"])
        self.assertEqual(first["ledger"], "review")
        self.assertEqual(independent_citation["ledger"], "relation")

    def test_independent_policy_is_not_promoted_to_an_original_source_claim(self):
        self.relation(kind="policy")
        result = read_evidence(self.basis, {"action": "claims", "material_id": "d1", "query": "Independent", "limit": 10})
        item = next(row for row in result["items"] if row["kind"] == "authored_relation")
        self.assertTrue(item["applicability_not_automatically_proven"])
        citation = resolve_evidence_ids(self.basis, [item["evidence_id"]])[0]
        self.assertEqual((citation["kind"], citation["ledger"]), ("review", "relation"))
        self.assertNotIn("quote", citation)

    def test_pending_and_undone_independent_relations_remain_distinct(self):
        knowledge = self.relation(status="pending")
        result = read_evidence(self.basis, {"action": "history", "material_id": "d1", "limit": 10})
        self.assertTrue(result["items"][5]["pending"])
        self.assertFalse(result["items"][5]["is_current_judgment"])
        knowledge["authored_relations"][0]["status"] = "inactive"
        knowledge["relation_history"].append({"id": "8" * 32, "action": "relation_undo", "undo_of": "1" * 32,
                                               "reason": "Withdraw addition", "kind": "source"})
        result = read_evidence(self.basis, {"action": "history", "material_id": "d1", "limit": 10})
        self.assertFalse(result["items"][5]["is_current_judgment"])
        self.assertTrue(result["items"][6]["is_current_judgment"])
        self.assertEqual(result["items"][6]["event"]["undo_of"], "1" * 32)

    def test_source_and_current_policy_decisions_are_kept_separately(self):
        claim = self.basis["documents"][0]["knowledge"]["claims"][0]
        claim.update(source_decision="defer", source_reviewed_value=deepcopy(claim["value"]), decision="policy",
                     policy_event_id="3" * 32)
        result = read_evidence(self.basis, {"action": "claims", "material_id": "d1", "limit": 1})
        item = result["items"][0]
        self.assertEqual((item["decision"], item["source_decision"]), ("policy", "defer"))
        self.assertEqual(item["origin"], "expert_policy")
        self.assertIn("source_reviewed_value", item)

    def test_exact_existing_citation_validator_accepts_source_claim_policy_original_web(self):
        for identifier in ["s1:2:3", "c1:1", "p1:1", "o1:1:2", "w1:1:2"]:
            citations = resolve_evidence_ids(self.basis, [identifier])
            validated = QuestionRunStore._validate_citations(self.basis, citations)
            self.assertEqual(len(validated), 1)

    def test_original_and_web_have_exact_provenance(self):
        original = read_evidence(self.basis, {"action": "read", "material_id": "o1"})
        web = read_evidence(self.basis, {"action": "read", "material_id": "w1"})
        self.assertEqual(original["citations"][0]["citation"]["source_id"], "6" * 32)
        self.assertEqual(web["items"][0]["origin"], "client_reported")
        self.assertEqual(web["items"][0]["retrieval_verification"], "not_independently_verified")
        self.assertEqual(web["citations"][0]["citation"]["url"], "https://example.org/capability")

    def test_reported_original_conversion_is_not_verified_binary_coverage(self):
        self.basis["originals"][0]["conversion"] = {"conversion_ref": {"conversion_id": "9" * 32},
                                                    "manifest": {"method": "client_pdf_text"}}
        result = read_evidence(self.basis, {"action": "read", "material_id": "o1"})
        self.assertEqual(result["items"][0]["original_coverage"], "not_verified")
        self.assertEqual(result["items"][0]["conversion_method"], "client_pdf_text")

    def test_source_pagination_is_deterministic_and_does_not_rewrite_ranges(self):
        self.basis["documents"][0]["content"] = "\n\n".join(f"Paragraph {i}." for i in range(20))
        query = {"action": "read", "material_id": "d1", "start_line": 1, "line_count": 100, "limit": 2}
        first = read_evidence(self.basis, query)
        second = read_evidence(self.basis, {**query, "offset": first["next_offset"]})
        self.assertEqual(first, read_evidence(self.basis, query))
        self.assertEqual(first["next_offset"], 2)
        self.assertTrue(set(first["evidence_ids"]).isdisjoint(second["evidence_ids"]))

    def content(self, value):
        """문서명이나 도메인 정답과 관계없는 원문 범위 fixture를 만든다."""
        self.basis["documents"][0]["content"] = value
        self.basis["documents"][0]["source_revision"] = sha256(value.encode()).hexdigest()

    def test_read_window_reports_actual_ranges_when_requested_lines_are_not_all_served(self):
        self.content("\n\n".join(f"Independent paragraph {i}." for i in range(12)))
        query = {"action": "read", "material_id": "d1", "start_line": 1, "line_count": 100, "limit": 2}
        result = read_evidence(self.basis, query)
        window = result["read_window"]
        self.assertEqual(window["requested_range"], [1, 100])
        self.assertEqual(window["available_range"], [1, 23])
        self.assertEqual(window["returned_ranges"], [[1, 1], [3, 3]])
        self.assertEqual(window["remaining_ranges"][0], [5, 5])
        self.assertEqual(window["next_start_line"], 5)
        self.assertEqual(result["next_offset"], 2)
        self.assertEqual(result["scope"]["completion_scope"], "requested_source_window")

    def test_read_window_page_offset_does_not_reintroduce_earlier_ranges(self):
        self.content("\n\n".join(f"Separate instruction {i}." for i in range(8)))
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1", "line_count": 100,
                                            "limit": 2, "offset": 2})
        window = result["read_window"]
        self.assertEqual(window["returned_ranges"], [[5, 5], [7, 7]])
        self.assertEqual(window["remaining_ranges"], [[9, 9], [11, 11], [13, 13], [15, 15]])
        self.assertEqual(window["next_start_line"], 9)
        self.assertEqual(result["next_offset"], 4)

    def test_next_start_line_continuation_covers_new_windows_and_boundary_exceptions(self):
        paragraphs = [f"Section {i}.\nCondition {i} applies only within its own section." for i in range(60)]
        paragraphs[35] += "\nException: the following instruction overrides this section."
        source = "\n\n".join(paragraphs)
        self.content(source)
        expected = {index for index, line in enumerate(source.split("\n"), 1) if line.strip()}
        observed, start, calls = set(), 1, 0
        while start is not None:
            result = read_evidence(self.basis, {"action": "read", "material_id": "d1", "start_line": start,
                                                "line_count": 100, "limit": 2})
            for item in result["items"]:
                positions = set(range(item["start_line"], item["end_line"] + 1))
                self.assertTrue(observed.isdisjoint(positions))
                observed.update(positions)
                self.assertIn(item["text"], source)
            following = result["read_window"]["next_start_line"]
            self.assertTrue(following is None or following > start)
            start = following
            calls += 1
            self.assertLess(calls, 100)
        self.assertEqual(observed, expected)
        exception_line = source[:source.index("Exception:")].count("\n") + 1
        self.assertGreater(exception_line, 100)
        self.assertIn(exception_line, observed)

    def test_next_start_line_advances_after_the_requested_window_is_exhausted(self):
        self.content("First.\nSecond.\nThird.\nFourth.\nLast.\n")
        start, ranges = 1, []
        while start is not None:
            result = read_evidence(self.basis, {"action": "read", "material_id": "d1", "start_line": start,
                                                "line_count": 2, "limit": 20})
            self.assertIsNone(result["next_offset"])
            self.assertEqual(result["read_window"]["remaining_ranges"], [])
            ranges.extend(result["read_window"]["returned_ranges"])
            start = result["read_window"]["next_start_line"]
        self.assertEqual(ranges, [[1, 2], [3, 4], [5, 5]])

    def test_offset_at_end_returns_no_ranges_without_claiming_previous_page_was_read(self):
        self.content("First.\n\nLast.\n")
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1", "offset": 2})
        self.assertEqual(result["items"], [])
        self.assertEqual(result["read_window"]["returned_ranges"], [])
        self.assertEqual(result["read_window"]["remaining_ranges"], [])
        self.assertIsNone(result["read_window"]["next_start_line"])

    def test_empty_material_has_no_available_range_or_continuation(self):
        self.content("")
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1"})
        window = result["read_window"]
        self.assertEqual(window["requested_range"], [1, 60])
        self.assertIsNone(window["available_range"])
        self.assertEqual(window["total_lines"], 0)
        self.assertEqual(window["returned_ranges"], [])
        self.assertEqual(window["remaining_ranges"], [])
        self.assertIsNone(window["next_start_line"])
        self.assertFalse(result["scope"]["absence_proven"])

    def test_unreadable_source_lines_are_explicit_ranges_without_cutting_text(self):
        self.content("x" * 10001 + "\n\n" + "한" * 5000 + "\n\nReadable final line.\n")
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1"})
        self.assertEqual(result["read_window"]["returned_ranges"], [[5, 5]])
        self.assertEqual(result["read_window"]["unavailable_ranges"], [[1, 1], [3, 3]])
        self.assertEqual({item["code"] for item in result["skipped"]},
                         {"source_line_quote_limit", "evidence_item_limit"})
        self.assertFalse(result["complete"])
        self.assertLessEqual(len(canonical_json_bytes(result)), MAX_RESPONSE_BYTES)

    def test_read_window_metadata_is_counted_in_byte_limited_pages(self):
        self.content("\n\n".join(("가나다" * 300) + str(i) for i in range(30)))
        query = {"action": "read", "material_id": "d1", "line_count": 100, "limit": 20}
        offset, positions, calls = 0, set(), 0
        while offset is not None:
            result = read_evidence(self.basis, {**query, "offset": offset})
            self.assertLessEqual(len(canonical_json_bytes(result)), MAX_RESPONSE_BYTES)
            self.assertEqual(result["skipped"], [])
            for item in result["items"]:
                self.assertNotIn(item["start_line"], positions)
                positions.add(item["start_line"])
            offset = result["next_offset"]
            calls += 1
            self.assertLess(calls, 30)
        self.assertEqual(positions, set(range(1, 60, 2)))

    def test_read_window_preserves_crlf_and_unicode_line_coordinates(self):
        self.content("Header.\r\n\r\nCondition\u2028on the same line.\r\nAlternative.\r\n\r\nException.\r\n")
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1", "start_line": 3,
                                            "line_count": 2})
        self.assertEqual(result["read_window"]["returned_ranges"], [[3, 4]])
        self.assertEqual(result["read_window"]["next_start_line"], 5)
        self.assertEqual(result["items"][0]["text"], "Condition\u2028on the same line.\r\nAlternative.")
        self.assertEqual(result["evidence_ids"], ["s1:3:4"])

    def test_search_completion_only_describes_matching_passages(self):
        result = read_evidence(self.basis, {"action": "search", "query": "선주"})
        self.assertTrue(result["complete"])
        self.assertEqual(result["scope"]["completion_scope"], "matching_passages")
        self.assertNotIn("read_window", result)
        self.assertFalse(result["scope"]["absence_proven"])

    def test_long_line_is_not_silently_cut_and_later_line_remains_readable(self):
        self.basis["documents"][0]["content"] = "x" * 10001 + "\nReadable next line.\n"
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1", "line_count": 2})
        self.assertEqual(result["evidence_ids"], ["s1:2:2"])
        self.assertEqual(result["skipped"][0]["code"], "source_line_quote_limit")
        self.assertFalse(result["complete"])
        with self.assertRaises(ValueError):
            resolve_evidence_ids(self.basis, ["s1:1:1"])

    def test_oversized_item_skips_whole_text_and_respects_response_budget(self):
        self.basis["documents"][0]["content"] = "한" * 5000 + "\n\nSmall later paragraph."
        result = read_evidence(self.basis, {"action": "read", "material_id": "d1"})
        self.assertEqual(result["items"][0]["text"], "Small later paragraph.")
        self.assertEqual(result["skipped"][0]["code"], "evidence_item_limit")
        self.assertLessEqual(len(canonical_json_bytes(result)), MAX_RESPONSE_BYTES)

    def test_byte_budget_pages_whole_passages_without_dropping_unserved_items(self):
        self.basis["documents"][0]["content"] = "\n\n".join(("가나다" * 300) + str(i) for i in range(20))
        query = {"action": "read", "material_id": "d1", "line_count": 100, "limit": 20}
        first = read_evidence(self.basis, query)
        self.assertIsNotNone(first["next_offset"])
        self.assertEqual(first["skipped"], [])
        self.assertLessEqual(len(canonical_json_bytes(first)), MAX_RESPONSE_BYTES)
        second = read_evidence(self.basis, {**query, "offset": first["next_offset"]})
        self.assertEqual(len(first["items"]), first["next_offset"])
        self.assertTrue(set(first["evidence_ids"]).isdisjoint(second["evidence_ids"]))

    def test_same_name_in_another_document_remains_a_separate_material(self):
        other = deepcopy(self.basis["documents"][0])
        other["document"] = "another-installation.md"
        self.basis["documents"].append(other)
        result = read_evidence(self.basis, {"action": "read", "material_id": "d2", "start_line": 2, "line_count": 1})
        self.assertEqual(result["evidence_ids"], ["s2:2:2"])
        self.assertEqual(result["citations"][0]["citation"]["document"], "another-installation.md")

    def test_uncitable_candidate_stays_visible_without_fabricated_quote(self):
        claim = self.basis["documents"][0]["knowledge"]["claims"][0]
        claim["value"]["evidence"] = None
        result = read_evidence(self.basis, {"action": "claims", "material_id": "d1", "limit": 1})
        self.assertEqual(result["items"][0]["citation_status"], "no_exact_source_or_applicable_event")
        self.assertEqual(result["citations"], [])

    def test_big_history_is_not_cut_into_a_fake_reason(self):
        self.basis["documents"][0]["knowledge"]["history"][0]["reason"] = "reason" * 10000
        result = read_evidence(self.basis, {"action": "history", "material_id": "d1"})
        self.assertTrue(any(item["code"] == "evidence_item_limit" for item in result["skipped"]))
        self.assertNotIn("h1:1", result["evidence_ids"])
        self.assertFalse(result["complete"])

    def test_partial_basis_and_missing_knowledge_remain_explicit(self):
        self.basis["complete"] = False
        self.basis["documents"][0]["knowledge"]["status"] = "missing"
        result = read_evidence(self.basis, {"action": "search", "query": "not-present-zxy"})
        self.assertFalse(result["complete"])
        self.assertFalse(result["scope"]["basis_complete"])
        self.assertEqual(result["scope"]["knowledge_status"]["d1"], "missing")

    def test_no_function_mutates_frozen_basis_and_results_are_detached(self):
        original = deepcopy(self.basis)
        for action in ["search", "read", "claims", "history"]:
            result = read_evidence(self.basis, {"action": action, "material_id": "d1"})
            if result["items"]:
                result["items"][0]["material_id"] = "changed"
        self.assertEqual(self.basis, original)

    def test_ids_cannot_inject_paths_or_select_another_material(self):
        for identifier in ["../x", "s0:1:2", "s01:1:2", "s2:1:2", "s1:0:2", "s1:3:2", "c1:0", "h1:99",
                           "o1:1:1000", "w1:1:3", "s1:1:2/../../", "c1:1:2"]:
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                resolve_evidence_ids(self.basis, [identifier])
        with self.assertRaises(ValueError):
            resolve_evidence_ids(self.basis, ["s1:2:2", "s1:2:2"])
        with self.assertRaises(ValueError):
            resolve_evidence_ids(self.basis, ["s1:2:2"] * 101)

    def test_invalid_query_types_and_ranges_are_rejected(self):
        for query in [{"action": "delete"}, {"action": []}, {"action": "read"}, {"action": "search", "path": "x"},
                      {"action": "search", "query": False}, {"action": "read", "material_id": "d9"},
                      {"action": "read", "material_id": "d1", "line_count": 101},
                      {"action": "read", "material_id": "d1", "start_line": 1000},
                      {"action": "claims", "material_id": "o1"}, {"action": "history", "material_id": "d1", "limit": True},
                      {"action": "search", "query": "x" * 201}, {"action": "search", "offset": 99999}]:
            with self.subTest(query=query), self.assertRaises(ValueError):
                read_evidence(self.basis, query)


if __name__ == "__main__":
    unittest.main()
