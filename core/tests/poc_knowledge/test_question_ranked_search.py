"""검색 페이지를 줄여도 약한 일치·한정 조건·정확한 인용으로 이어 읽는다."""

from copy import deepcopy
from hashlib import sha256
import unittest

from core.common.json_codec import canonical_json_bytes
from core.modules.knowledge.question_evidence import MAX_RESPONSE_BYTES, read_evidence, resolve_evidence_ids
from core.modules.personal.question_runs import QuestionRunStore
from core.tests.poc_knowledge.test_question_evidence import basis_fixture


def source_basis(content):
    basis = basis_fixture()
    basis["documents"][0].update(content=content, source_revision=sha256(content.encode()).hexdigest())
    return basis


CONTENT = ("Alpha beta rule.\n\nAlpha exception.\n\nUnrelated barrier.\n\n"
           "Alpha generic one.\n\nUnrelated barrier.\n\nBeta generic two.\n\n"
           "Unrelated barrier.\n\nGamma separate requirement.\n\nUnrelated barrier.\n\nAlpha generic tail.\n")


class RankedSearchTests(unittest.TestCase):
    def search(self, basis, text="alpha beta gamma", **kwargs):
        return read_evidence(basis, {"action": "search", "query": text, "limit": 10, **kwargs}, ranked_search=True)

    def test_primary_includes_term_breadth_and_adjacent_exception(self):
        basis = source_basis(CONTENT)
        result = self.search(basis)
        self.assertEqual([item["text"] for item in result["items"]],
                         ["Alpha beta rule.", "Alpha exception.", "Gamma separate requirement."])
        self.assertEqual(result["total_matches"], 6)
        self.assertEqual(result["next_offset"], 3)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        self.assertFalse(result["scope"]["absence_proven"])

    def test_pagination_recovers_every_legacy_candidate_once(self):
        basis = source_basis(CONTENT)
        query = {"action": "search", "query": "alpha beta gamma", "limit": 20}
        legacy = read_evidence(basis, query)
        for page_limit in (1, 2, 5, 20):
            offset, ids, texts = 0, [], {}
            while True:
                result = self.search(basis, offset=offset, limit=page_limit)
                ids.extend(result["evidence_ids"])
                texts.update({item["evidence_id"]: item for item in result["items"]})
                self.assertEqual(resolve_evidence_ids(basis, result["evidence_ids"]),
                                 [row["citation"] for row in result["citations"]])
                if result["next_offset"] is None:
                    self.assertTrue(result["complete"])
                    break
                self.assertGreater(result["next_offset"], offset)
                offset = result["next_offset"]
            self.assertEqual(set(ids), set(legacy["evidence_ids"]))
            self.assertEqual(len(ids), len(set(ids)))
            self.assertEqual(texts, {item["evidence_id"]: item for item in legacy["items"]})

    def test_adjacency_expands_only_once(self):
        basis = source_basis("Alpha beta rule.\n\nAlpha nearby.\n\nAlpha further.\n\nAlpha last.\n")
        result = self.search(basis, "alpha beta")
        self.assertEqual([item["text"] for item in result["items"]], ["Alpha beta rule.", "Alpha nearby."])
        self.assertEqual(result["next_offset"], 2)
        self.assertEqual(result["total_matches"], 4)

    def test_empty_single_term_low_coverage_and_all_primary_keep_old_bytes(self):
        for content, text in [(CONTENT, ""), (CONTENT, "alpha"),
                              ("Alpha only.\n\nBeta only.\n", "alpha beta"),
                              ("Alpha beta first.\n\nAlpha beta second.\n", "alpha beta")]:
            basis = source_basis(content)
            query = {"action": "search", "query": text, "limit": 10}
            self.assertEqual(canonical_json_bytes(read_evidence(basis, query)),
                             canonical_json_bytes(read_evidence(basis, query, ranked_search=True)))

    def test_overlarge_primary_does_not_hide_small_secondary(self):
        basis = source_basis("Alpha beta " + "界" * 6000 + "\n\nUnrelated barrier.\n\nAlpha small.\n")
        result = self.search(basis, "alpha beta")
        self.assertEqual([item["text"] for item in result["items"]], ["Alpha small."])
        self.assertEqual(result["total_matches"], 2)
        self.assertEqual(result["skipped"][0]["code"], "evidence_item_limit")
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        self.assertLessEqual(len(canonical_json_bytes(result)), MAX_RESPONSE_BYTES)

    def test_other_actions_and_default_false_preserve_results(self):
        basis = basis_fixture()
        for action in ("read", "claims", "history"):
            query = {"action": action, "material_id": "d1", "limit": 10}
            old = canonical_json_bytes(read_evidence(basis, query))
            self.assertEqual(old, canonical_json_bytes(read_evidence(basis, query, ranked_search=True)))
            self.assertEqual(old, canonical_json_bytes(read_evidence(basis, query, ranked_search=False)))

    def test_material_filter_and_original_web_sources_keep_positions(self):
        basis = source_basis(CONTENT)
        basis["originals"][0]["content"] = "Alpha beta original.\n\nUnrelated barrier.\n\nAlpha other.\n"
        basis["web"]["sources"][0]["content"] = "Alpha beta web.\n\nUnrelated barrier.\n\nBeta other.\n"
        for material, prefix in (("d1", "s1:"), ("o1", "o1:"), ("w1", "w1:")):
            result = self.search(basis, "alpha beta", material_id=material)
            self.assertTrue(all(item["material_id"] == material for item in result["items"]))
            self.assertTrue(all(identifier.startswith(prefix) for identifier in result["evidence_ids"]))
            self.assertEqual(resolve_evidence_ids(basis, result["evidence_ids"]),
                             [row["citation"] for row in result["citations"]])

    def test_normalization_canonical_positions_and_no_source_mutation(self):
        basis = source_basis("ＡＬＰＨＡ beta 선주.\r\n\r\n선주 안내.\r\n\r\nOther barrier.\r\n\r\nBeta extra.\r\n")
        saved = deepcopy(basis)
        result = self.search(basis, "alpha BETA 선주")
        self.assertEqual(result["items"][0]["text"], "ＡＬＰＨＡ beta 선주.")
        self.assertEqual(result["items"][0]["start_line"], 1)
        self.assertEqual(basis, saved)
        self.assertEqual(result, self.search(basis, "alpha BETA 선주"))

    def test_ranked_option_is_exact_bool_before_any_access(self):
        for value in (None, 0, 1, "true", []):
            with self.assertRaisesRegex(ValueError, "ranked_search"):
                read_evidence(None, {}, ranked_search=value)
            with self.assertRaisesRegex(ValueError, "ranked_search"):
                QuestionRunStore(None, ranked_search=value)

    def test_offsets_at_and_after_tier_boundary_are_recoverable(self):
        basis = source_basis(CONTENT)
        first = self.search(basis)
        tail = self.search(basis, offset=first["next_offset"])
        self.assertEqual(len(tail["items"]), 3)
        self.assertIsNone(tail["next_offset"])
        self.assertEqual(self.search(basis, offset=6)["items"], [])
        with self.assertRaises(ValueError):
            self.search(basis, offset=7)


if __name__ == "__main__":
    unittest.main()
