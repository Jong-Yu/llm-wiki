"""Request-local pure parsing preserves exact text, validation and isolation."""

from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from hashlib import sha256
from threading import Barrier
import unittest
from unittest.mock import patch

from core.modules.documents import metadata


class MetadataParseReuseTests(unittest.TestCase):
    def setUp(self):
        self.content = metadata.render_document("첫 줄\r\nSecond line.\r\n", title="Title: yes 2026-11-06",
            document_id="d" * 32, source={"id": "a" * 32, "version": "b" * 32},
            tags=["base", "한글"], description="Full metadata")

    def test_exact_body_revision_coordinates_identity_crlf_and_plain_text(self):
        crlf = metadata.render_document("Body\nNext\n", title="CRLF", document_id="c" * 32).replace("\n", "\r\n")
        for content in ("", "\r\n", "Plain 한글\r\nnext\n", self.content, crlf):
            with self.subTest(content_length=len(content)):
                expected = metadata._parse_document(content)
                original = metadata._parse_document
                with patch.object(metadata, "_parse_document", wraps=original) as parsed, metadata.reuse_parsed_documents():
                    first = metadata.parse_document(content)
                    second = metadata.parse_document(content)
                    self.assertEqual(first, expected)
                    self.assertEqual(second, expected)
                    self.assertEqual(second.body_revision, sha256(expected.body.encode("utf-8")).hexdigest())
                    self.assertEqual(second.body_start_line, expected.body_start_line)
                    self.assertEqual(second.document_id, expected.document_id)
                self.assertEqual(parsed.call_count, 1)

    def test_first_and_hit_metadata_source_and_tags_never_alias_private_memo(self):
        expected = metadata._parse_document(self.content)
        with metadata.reuse_parsed_documents():
            first = metadata.parse_document(self.content)
            first.metadata["title"] = "caller title"
            first.metadata["tags"].append("caller tag")
            first.metadata["source"]["id"] = "e" * 32
            first.metadata.pop("document_id")
            second = metadata.parse_document(self.content)
            self.assertEqual(second, expected)
            second.metadata["tags"].clear()
            second.metadata["source"]["version"] = "f" * 32
            third = metadata.parse_document(self.content)
            self.assertEqual(third, expected)
            self.assertIsNot(second.metadata, third.metadata)
            self.assertIsNot(second.metadata["tags"], third.metadata["tags"])
            self.assertIsNot(second.metadata["source"], third.metadata["source"])
            self.assertIs(second.body, third.body)

    def test_exact_full_text_distinguishes_body_metadata_and_line_ending_changes(self):
        changed_title = self.content.replace("Title: yes 2026-11-06", "Changed title")
        changed_body = self.content + "New condition.\n"
        original = metadata._parse_document
        with patch.object(metadata, "_parse_document", wraps=original) as parsed, metadata.reuse_parsed_documents():
            first = metadata.parse_document(self.content)
            title = metadata.parse_document(changed_title)
            body = metadata.parse_document(changed_body)
            lf = metadata.parse_document(self.content.replace("\r\n", "\n"))
            self.assertEqual(title.body_revision, first.body_revision)
            self.assertNotEqual(title.metadata["title"], first.metadata["title"])
            self.assertNotEqual(body.body_revision, first.body_revision)
            self.assertNotEqual(lf.body_revision, first.body_revision)
            self.assertEqual(metadata.parse_document(self.content), first)
        self.assertEqual(parsed.call_count, 4)

    def test_scope_outside_and_next_scope_are_uncached(self):
        original = metadata._parse_document
        with patch.object(metadata, "_parse_document", wraps=original) as parsed:
            metadata.parse_document(self.content)
            metadata.parse_document(self.content)
            with metadata.reuse_parsed_documents():
                metadata.parse_document(self.content)
                metadata.parse_document(self.content)
            metadata.parse_document(self.content)
            with metadata.reuse_parsed_documents():
                metadata.parse_document(self.content)
                metadata.parse_document(self.content)
        self.assertEqual(parsed.call_count, 5)

    def test_failures_yaml_alias_duplicate_depth_tag_and_unclosed_headers_are_not_cached(self):
        invalid = [self.content.replace('tags: ["base", "한글"]', 'tags: &x [*x]'),
                   self.content.replace('tags: ["base", "한글"]', 'tags: []\ntags: []'),
                   self.content.replace('tags: ["base", "한글"]', 'tags: [[[[[["deep"]]]]]]'),
                   self.content.replace('tags: ["base", "한글"]', 'tags: !!python/object:forbidden {}'),
                   self.content.replace('tags: ["base", "한글"]', 'tags: [unclosed'),
                   "---\nnot closed\nBody", "---\n" + "#x" * 35000 + "\n---\nBody"]
        for content in invalid:
            with self.subTest(size=len(content)):
                with self.assertRaises(metadata.DocumentMetadataError) as expected:
                    metadata._parse_document(content)
                original = metadata._parse_document
                with patch.object(metadata, "_parse_document", wraps=original) as parsed, metadata.reuse_parsed_documents():
                    for _ in range(2):
                        with self.assertRaises(type(expected.exception)) as actual:
                            metadata.parse_document(content)
                        self.assertEqual(str(actual.exception), str(expected.exception))
                    self.assertEqual(len(metadata._PARSE_REUSE.get()["values"]), 0)
                self.assertEqual(parsed.call_count, 2)

    def test_wrong_types_and_body_surrogates_keep_original_validation_order(self):
        class TextSubclass(str):
            pass

        malformed_header = "---\ntitle: [unclosed\n---\n\ud800"
        for content in (None, 1, b"bytes", TextSubclass("text"), "\ud800", malformed_header):
            with self.subTest(kind=type(content)):
                try:
                    metadata._parse_document(content)
                except Exception as expected:
                    expected_type, expected_message = type(expected), str(expected)
                else:
                    self.fail("Invalid fixture unexpectedly parsed")
                with metadata.reuse_parsed_documents():
                    for _ in range(2):
                        with self.assertRaises(expected_type) as actual:
                            metadata.parse_document(content)
                        self.assertEqual(str(actual.exception), expected_message)

    def test_surrogate_metadata_that_parses_successfully_only_bypasses_optional_storage(self):
        content = self.content.replace('title: "Title: yes 2026-11-06"', 'title: "\\ud800"')
        expected = metadata._parse_document(content)
        self.assertEqual(expected.metadata["title"], "\ud800")
        original = metadata._parse_document
        with patch.object(metadata, "_parse_document", wraps=original) as parsed, metadata.reuse_parsed_documents():
            self.assertEqual(metadata.parse_document(content), expected)
            self.assertEqual(metadata.parse_document(content), expected)
            self.assertEqual(metadata._PARSE_REUSE.get()["values"], {})
        self.assertEqual(parsed.call_count, 2)

    def test_parser_loader_and_validator_identity_changes_run_fresh(self):
        for name in ("_parse_document", "_load", "validate_metadata"):
            original = getattr(metadata, name)
            with self.subTest(hook=name), metadata.reuse_parsed_documents():
                expected = metadata.parse_document(self.content)
                with patch.object(metadata, name, wraps=original) as changed:
                    self.assertEqual(metadata.parse_document(self.content), expected)
                    self.assertEqual(metadata.parse_document(self.content), expected)
                self.assertEqual(changed.call_count, 1)
                self.assertEqual(metadata.parse_document(self.content), expected)

    def test_changed_validation_failure_does_not_use_a_previous_success(self):
        failure = metadata.DocumentMetadataError("new validator rejected metadata")
        with metadata.reuse_parsed_documents():
            expected = metadata.parse_document(self.content)
            with patch.object(metadata, "validate_metadata", side_effect=failure) as changed:
                for _ in range(2):
                    with self.assertRaises(metadata.DocumentMetadataError) as actual:
                        metadata.parse_document(self.content)
                    self.assertIs(actual.exception, failure)
            self.assertEqual(changed.call_count, 2)
            self.assertEqual(metadata.parse_document(self.content), expected)

    def test_unhashable_parser_loader_and_validator_hooks_stay_uncached(self):
        for name in ("_parse_document", "_load", "validate_metadata"):
            original = getattr(metadata, name)

            class Hook:
                __hash__ = None

                def __init__(self):
                    self.calls = 0

                def __call__(self, *args, **kwargs):
                    self.calls += 1
                    return original(*args, **kwargs)

            hook = Hook()
            expected = metadata._parse_document(self.content)
            with self.subTest(hook=name), patch.object(metadata, name, hook), metadata.reuse_parsed_documents():
                self.assertEqual(metadata.parse_document(self.content), expected)
                self.assertEqual(metadata.parse_document(self.content), expected)
                self.assertEqual(metadata._PARSE_REUSE.get()["values"], {})
            self.assertEqual(hook.calls, 2)

    def test_entry_and_byte_bounds_oversize_bypass_without_truncating_parse_results(self):
        original = metadata._parse_document
        with patch.object(metadata, "_MAX_PARSE_REUSE_ENTRIES", 2), \
                patch.object(metadata, "_parse_document", wraps=original) as parsed, metadata.reuse_parsed_documents():
            for content in ("first", "second", "third", "third", "first"):
                self.assertEqual(metadata.parse_document(content), original(content))
            self.assertLessEqual(len(metadata._PARSE_REUSE.get()["values"]), 2)
        self.assertEqual(parsed.call_count, 4)
        with patch.object(metadata, "_MAX_PARSE_REUSE_BYTES", 12), \
                patch.object(metadata, "_parse_document", wraps=original) as parsed, metadata.reuse_parsed_documents():
            for content in ("abc", "def", "def", "abc"):
                self.assertEqual(metadata.parse_document(content), original(content))
            self.assertLessEqual(metadata._PARSE_REUSE.get()["bytes"], 12)
            self.assertEqual(len(metadata._PARSE_REUSE.get()["values"]), 1)
        self.assertEqual(parsed.call_count, 3)
        oversized = self.content + "Full content 한글\r\n" * 1000
        with patch.object(metadata, "_MAX_PARSE_REUSE_BYTES", 100), \
                patch.object(metadata, "_parse_document", wraps=original) as parsed, metadata.reuse_parsed_documents():
            expected = original(oversized)
            self.assertEqual(metadata.parse_document(oversized), expected)
            self.assertEqual(metadata.parse_document(oversized), expected)
            self.assertEqual(metadata._PARSE_REUSE.get()["values"], {})
        self.assertEqual(parsed.call_count, 2)

    def test_nested_scopes_restore_outer_and_clear_on_both_exception_paths(self):
        original = metadata._parse_document
        outer = inner = None
        with patch.object(metadata, "_parse_document", wraps=original) as parsed:
            with self.assertRaisesRegex(RuntimeError, "outer"):
                with metadata.reuse_parsed_documents():
                    outer = metadata._PARSE_REUSE.get()
                    expected = metadata.parse_document(self.content)
                    with self.assertRaisesRegex(ValueError, "inner"):
                        with metadata.reuse_parsed_documents():
                            inner = metadata._PARSE_REUSE.get()
                            self.assertIsNot(inner, outer)
                            self.assertEqual(metadata.parse_document(self.content), expected)
                            raise ValueError("inner")
                    self.assertIs(metadata._PARSE_REUSE.get(), outer)
                    self.assertFalse(outer["closed"])
                    self.assertTrue(inner["closed"])
                    self.assertEqual(inner["values"], {})
                    self.assertEqual(metadata.parse_document(self.content), expected)
                    raise RuntimeError("outer")
            self.assertIsNone(metadata._PARSE_REUSE.get())
            self.assertTrue(outer["closed"])
            self.assertEqual(outer["values"], {})
            self.assertEqual(outer["bytes"], 0)
            metadata.parse_document(self.content)
        self.assertEqual(parsed.call_count, 3)

    def test_threads_have_independent_scopes_and_returned_metadata(self):
        barrier = Barrier(2)
        original = metadata._parse_document

        def worker(label):
            with metadata.reuse_parsed_documents():
                first = metadata.parse_document(self.content)
                first.metadata["tags"].append(label)
                state = metadata._PARSE_REUSE.get()
                barrier.wait(timeout=5)
                return state["owner"], metadata.parse_document(self.content)

        with patch.object(metadata, "_parse_document", wraps=original) as parsed, ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(worker, ("one", "two")))
        self.assertEqual(parsed.call_count, 2)
        self.assertNotEqual(results[0][0], results[1][0])
        expected = original(self.content)
        self.assertEqual([value for _, value in results], [expected, expected])
        self.assertIsNone(metadata._PARSE_REUSE.get())

    def test_copied_context_cannot_reuse_on_another_thread_or_after_scope_exit(self):
        original = metadata._parse_document
        with patch.object(metadata, "_parse_document", wraps=original) as parsed:
            with metadata.reuse_parsed_documents():
                expected = metadata.parse_document(self.content)
                copied = copy_context()
                inherited = copied.get(metadata._PARSE_REUSE)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    self.assertEqual(pool.submit(copied.run, metadata.parse_document, self.content).result(), expected)
                self.assertEqual(parsed.call_count, 2)
                self.assertEqual(metadata.parse_document(self.content), expected)
                self.assertEqual(parsed.call_count, 2)
            self.assertTrue(inherited["closed"])
            self.assertEqual(inherited["values"], {})
            self.assertEqual(inherited["bytes"], 0)
            self.assertEqual(copied.run(metadata.parse_document, self.content), expected)
            self.assertEqual(parsed.call_count, 3)
            self.assertEqual(copied.get(metadata._PARSE_REUSE)["values"], {})


if __name__ == "__main__":
    unittest.main()
