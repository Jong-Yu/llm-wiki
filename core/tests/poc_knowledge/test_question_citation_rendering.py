"""자료 내용에 기대지 않고 근거 ID와 표시 번호의 연결·코드 보존을 확인한다."""

from copy import deepcopy
import unittest

from core.client.ai.contracts import AIAdapterError
from core.client.question_citations import render_evidence_citations


class EvidenceCitationRenderingTests(unittest.TestCase):
    def setUp(self):
        self.registry = {"s7:19:24": {"kind": "document", "quote": "first exact passage"},
                         "c3:6": {"kind": "claim", "quote": "second exact passage"},
                         "h9:11": {"kind": "review", "event_id": "event-fixture"}}

    def reject(self, content, identifiers, registry=None):
        with self.assertRaises(AIAdapterError) as caught:
            render_evidence_citations(content, identifiers, self.registry if registry is None else registry)
        self.assertEqual(caught.exception.code, "ai_invalid_result")

    def test_first_appearance_reorders_declared_list_and_citations_together(self):
        result = render_evidence_citations("두 번째 [[c3:6]], 첫 번째 [[s7:19:24]].", ["s7:19:24", "c3:6"], self.registry)
        self.assertEqual(result, {"content": "두 번째 [1], 첫 번째 [2].",
            "citations": [self.registry["c3:6"], self.registry["s7:19:24"]],
            "evidence_ids": ["c3:6", "s7:19:24"]})

    def test_repeated_reference_reuses_exact_number(self):
        result = render_evidence_citations("A[[s7:19:24]] B[[h9:11]] A[[s7:19:24]]", ["h9:11", "s7:19:24"], self.registry)
        self.assertEqual(result["content"], "A[1] B[2] A[1]")
        self.assertEqual(result["evidence_ids"], ["s7:19:24", "h9:11"])
        self.assertEqual(len(result["citations"]), 2)

    def test_arbitrary_actual_record_and_span_ids_do_not_change_rule(self):
        identifiers = ["s213:678:790", "o4:1:2", "w5:7:9", "c22:450", "h19:38", "p8:63"]
        registry = {value: {"ref": value} for value in identifiers}
        content = "\n".join(f"관찰 [[{value}]]" for value in reversed(identifiers))
        result = render_evidence_citations(content, identifiers, registry)
        self.assertEqual(result["evidence_ids"], list(reversed(identifiers)))
        self.assertEqual(result["content"], "\n".join(f"관찰 [{number}]" for number in range(1, 7)))

    def test_plain_answer_with_no_declared_citations_is_unchanged(self):
        content = "# 상태\r\n\r\n  확인할 근거가 없습니다.\t\n"
        self.assertEqual(render_evidence_citations(content, [], self.registry),
                         {"content": content, "citations": [], "evidence_ids": []})

    def test_missing_undeclared_and_unserved_ids_are_rejected(self):
        for content, identifiers in [("누락", ["c3:6"]), ("[[c3:6]]", []),
                                     ("[[s1:1:1]]", ["s1:1:1"]),
                                     ("[[c3:6]]", ["c3:6", "h9:11"])]:
            with self.subTest(content=content, identifiers=identifiers):
                self.reject(content, identifiers)

    def test_duplicate_declared_ids_are_rejected(self):
        self.reject("[[c3:6]]", ["c3:6", "c3:6"])

    def test_malformed_markers_cannot_be_partially_rendered(self):
        for content in ["[[c3:6]", "[c3:6]]", "[[[c3:6]]]", "[[c3:6]]]", "[[[c3:6]]",
                        "[[]]", "[[ c3:6]]", "[[c3:6 ]]", "[[c3:\n6]]", "[[c3:6]][[broken"]:
            with self.subTest(content=content):
                self.reject(content, ["c3:6"])

    def test_manual_numeric_citations_in_prose_are_rejected(self):
        for content in ["설명[1]", "설명 [2]", "claim[21]", "[0]", "[01]", "[1, 2]", "[2–4]",
                        "[[c3:6]] [1]", "value[1] outside code"]:
            with self.subTest(content=content):
                self.reject(content, ["c3:6"] if "[[c3:6]]" in content else [])

    def test_inline_code_preserves_numeric_arrays_and_indexing(self):
        for code in ["`items[1]`", "`[1]`", "`[1, 2]`", "``array[1] and `literal` ``", "`items[1]\n+ items[2]`"]:
            with self.subTest(code=code):
                content = f"예제 {code}는 그대로 둡니다. [[c3:6]]"
                result = render_evidence_citations(content, ["c3:6"], self.registry)
                self.assertEqual(result["content"], content.replace("[[c3:6]]", "[1]"))

    def test_fenced_code_preserves_numeric_literals_and_all_whitespace(self):
        for fence in ["```", "~~~~", "   `````"]:
            with self.subTest(fence=fence):
                closing = fence.strip()
                content = f"코드:\n{fence}python\n  values = [1, 2]\n\tprint(values[1])\n{closing}\n근거 [[c3:6]]\n"
                result = render_evidence_citations(content, ["c3:6"], self.registry)
                self.assertEqual(result["content"], content.replace("[[c3:6]]", "[1]"))

    def test_crlf_and_cr_fences_preserve_original_newlines(self):
        for newline in ["\r\n", "\r"]:
            content = newline.join(["~~~", "values[1]", "~~~", "근거 [[c3:6]]", ""])
            self.assertEqual(render_evidence_citations(content, ["c3:6"], self.registry)["content"],
                             content.replace("[[c3:6]]", "[1]"))

    def test_shorter_fence_does_not_close_a_longer_fence(self):
        content = "````\n```\n[1]\n````\n[[c3:6]]"
        self.assertEqual(render_evidence_citations(content, ["c3:6"], self.registry)["content"],
                         content.replace("[[c3:6]]", "[1]"))
        self.reject(content + "\nprose [3]", ["c3:6"])

    def test_code_exception_does_not_hide_numeric_citations_after_it(self):
        for content in ["`items[1]` prose [2]", "```\n[1]\n```\n[2]", "~~~\n[1]\n~~~\n[2]"]:
            with self.subTest(content=content):
                self.reject(content, [])

    def test_unmatched_backtick_is_not_a_numeric_citation_escape(self):
        self.reject("`unfinished code [1]", [])

    def test_unclosed_fence_matches_markdown_code_to_end(self):
        content = "```python\nitems = [1]\n"
        self.assertEqual(render_evidence_citations(content, [], self.registry)["content"], content)

    def test_indented_code_and_html_are_not_silently_treated_as_backtick_code(self):
        for content in ["    items[1]", "<code>items[1]</code>"]:
            with self.subTest(content=content):
                self.reject(content, [])

    def test_escaped_backticks_do_not_hide_prose_citations(self):
        self.reject("\\`not code [1]\\`", [])
        content = "\\\\`items[1]` [[c3:6]]"
        self.assertEqual(render_evidence_citations(content, ["c3:6"], self.registry)["content"],
                         content.replace("[[c3:6]]", "[1]"))

    def test_evidence_markers_in_code_use_the_same_contract(self):
        content = "`[[c3:6]]`\n```\n[[h9:11]]\n```"
        result = render_evidence_citations(content, ["h9:11", "c3:6"], self.registry)
        self.assertEqual(result["content"], "`[1]`\n```\n[2]\n```")
        self.assertEqual(result["evidence_ids"], ["c3:6", "h9:11"])
        self.reject("`[[not-served]]`", [])

    def test_citation_limit_is_enforced_without_dropping_items(self):
        registry = {f"c1:{number}": {"record": number} for number in range(1, 66)}
        identifiers = list(registry)[:64]
        result = render_evidence_citations(" ".join(f"[[{value}]]" for value in identifiers), identifiers, registry)
        self.assertEqual(len(result["citations"]), 64)
        self.assertTrue(result["content"].endswith("[64]"))
        identifiers = list(registry)
        self.reject(" ".join(f"[[{value}]]" for value in identifiers), identifiers, registry)

    def test_identifier_limit_is_explicit(self):
        identifier = "x" * 80
        self.assertEqual(render_evidence_citations(f"[[{identifier}]]", [identifier], {identifier: {}})["content"], "[1]")
        too_long = identifier + "x"
        self.reject(f"[[{too_long}]]", [too_long], {too_long: {}})

    def test_identifier_cannot_create_a_backtick_code_exception(self):
        registry = {"first`": {}, "second`": {}}
        self.reject("[[first`]] prose [1] [[second`]]", list(registry), registry)

    def test_long_unicode_content_is_preserved_except_the_marker(self):
        marker = "[[c3:6]]"
        prefix = "선박🙂\t\r\n" * 7000
        suffix = "가" * (65536 - len(prefix) - len(marker))
        content = prefix + marker + suffix
        self.assertEqual(len(content), 65536)
        result = render_evidence_citations(content, ["c3:6"], self.registry)
        self.assertEqual(result["content"], prefix + "[1]" + suffix)
        self.reject(content + "가", ["c3:6"])

    def test_invalid_types_use_the_fixed_adapter_error(self):
        for content, declared, registry in [(None, [], {}), ("", [], {}), ("plain", None, {}),
            ("plain", [False], {}), ("plain", [{}], {}), ("plain", [], []), ("[[c3:6]]", ["c3:6"], {"c3:6": []})]:
            with self.subTest(content=content, declared=declared, registry=registry):
                self.reject(content, declared, registry)

    def test_return_values_do_not_mutate_or_alias_registry_or_declared_order(self):
        registry, identifiers = deepcopy(self.registry), ["h9:11", "c3:6"]
        before = deepcopy(registry)
        result = render_evidence_citations("[[c3:6]] [[h9:11]]", identifiers, registry)
        result["citations"][0]["quote"] = "changed by caller"
        result["evidence_ids"].append("s7:19:24")
        self.assertEqual(registry, before)
        self.assertEqual(identifiers, ["h9:11", "c3:6"])


if __name__ == "__main__":
    unittest.main()
