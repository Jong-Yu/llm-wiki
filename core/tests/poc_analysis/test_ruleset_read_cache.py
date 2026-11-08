"""Pure expected-schema caching never caches policy or published-file checks."""

from hashlib import sha256
import json
import unittest
from unittest.mock import patch

from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_results import diagnostics
from core.modules.extraction_rules import content, files, store
from core.modules.extraction_rules.contracts import (
    RulesetCompatibilityError, RulesetCorruptError, RulesetUnavailableError,
)
from core.tests.poc_analysis import test_registration as fixtures


class RulesetReadCacheTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.RegistrationTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.clear_cache)
        self.clear_cache()
        self.registry = self.fixture.rules
        self.directory = self.registry.root / "common/v1"

    @staticmethod
    def clear_cache():
        with store._diagnostics_guard:
            store._diagnostics_bytes.clear()

    def read(self):
        return self.registry.read("team")

    def snapshot(self):
        return {path.relative_to(self.fixture.root).as_posix(): path.read_bytes()
                for path in self.fixture.root.rglob("*") if path.is_file()}

    def diagnostics_bytes(self, raw):
        # Only this isolated fixture is changed to model an old immutable format.
        path = self.directory / "diagnostics.schema.json"
        path.write_bytes(raw)
        manifest = json.loads((self.directory / "manifest.json").read_bytes())
        manifest["components"][path.name] = {"sha256": sha256(raw).hexdigest(), "size_bytes": len(raw)}
        (self.directory / "manifest.json").write_bytes(canonical_json_bytes(manifest))

    def test_identical_reads_generate_three_schemas_once_and_preserve_all_results_and_bytes(self):
        schema = diagnostics.schema
        calls = []

        def counted(version=None):
            calls.append(version)
            return schema(version)

        before = self.snapshot()
        with patch.object(content, "diagnostics_schema", counted), patch.object(diagnostics, "schema", counted):
            first = self.read()
            second = self.read()
        self.assertEqual(calls, [None, 1, None])
        self.assertEqual(first, second)
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(all(type(value) is bytes for values in store._diagnostics_bytes.values() for value in values))

    def test_current_v1_and_legacy_diagnostics_keep_exact_supported_bytes(self):
        values = [canonical_json_bytes(diagnostics.schema()), canonical_json_bytes(diagnostics.schema(1)),
                  canonical_json_bytes(diagnostics.legacy_schema())]
        for raw in values:
            with self.subTest(digest=sha256(raw).hexdigest()):
                self.diagnostics_bytes(raw)
                before = self.snapshot()
                first = self.read()
                self.assertEqual(first["components"]["diagnostics.schema.json"]["content"].encode(), raw)
                self.assertEqual(self.read(), first)
                self.assertEqual(self.snapshot(), before)

    def test_public_result_and_incompatible_error_match_the_previous_uncached_tuple(self):
        def uncached():
            return (canonical_json_bytes(content.diagnostics_schema()),
                    canonical_json_bytes(content.diagnostics_schema(1)),
                    canonical_json_bytes(store.legacy_diagnostics_schema()))

        before = self.snapshot()
        with patch.object(store, "_expected_diagnostics_bytes", uncached):
            original = self.read()
        self.assertEqual(self.read(), original)
        self.assertEqual(self.snapshot(), before)
        self.diagnostics_bytes(canonical_json_bytes({"type": "object", "description": "unsupported fixture schema"}))
        before = self.snapshot()
        failures = []
        with patch.object(store, "_expected_diagnostics_bytes", uncached):
            with self.assertRaises(RulesetCompatibilityError) as caught:
                self.read()
            failures.append(caught.exception)
        with self.assertRaises(RulesetCompatibilityError) as caught:
            self.read()
        self.assertEqual(type(caught.exception), type(failures[0]))
        self.assertEqual(str(caught.exception), str(failures[0]))
        self.assertEqual(self.snapshot(), before)

    def test_returned_release_or_decoded_expected_schema_cannot_poison_immutable_memo(self):
        first = self.read()
        expected = first["components"]["diagnostics.schema.json"]["content"]
        first["components"]["diagnostics.schema.json"]["content"] = "poison"
        first["manifest"]["components"].clear()
        immutable = store._expected_diagnostics_bytes()
        decoded = json.loads(immutable[0])
        decoded.clear()
        self.assertEqual(store._expected_diagnostics_bytes(), immutable)
        self.assertEqual(self.read()["components"]["diagnostics.schema.json"]["content"], expected)

    def test_policy_manifest_components_and_running_validator_are_checked_on_every_read(self):
        self.read()
        with patch.object(files, "raw_file", wraps=files.raw_file) as raw, \
                patch.object(content, "validator_fingerprint", wraps=content.validator_fingerprint) as validator:
            first = self.read()
            second = self.read()
        self.assertEqual(first, second)
        self.assertEqual(validator.call_count, 2)
        paths = [call.args[0] for call in raw.call_args_list]
        self.assertEqual(paths.count(self.registry.policy_path), 2)
        self.assertEqual(paths.count(self.directory / "manifest.json"), 2)
        for name in store.limits.COMPONENTS:
            self.assertEqual(paths.count(self.directory / name), 2, name)

    def test_revoked_policy_is_not_reused_from_a_successful_read(self):
        self.read()
        path = self.registry.policy_path
        policy = json.loads(path.read_bytes())
        policy["tenants"]["team"]["revoked"] = list(policy["tenants"]["team"]["allowed"])
        path.write_bytes(canonical_json_bytes(policy))
        before = self.snapshot()
        with self.assertRaises(RulesetUnavailableError):
            self.read()
        self.assertEqual(self.snapshot(), before)

    def test_changed_component_schema_and_validator_fail_after_warm_memo(self):
        self.read()
        path = self.directory / "ontology.md"
        original = path.read_bytes()
        path.write_bytes(original + b"\nchanged fixture component\n")
        before = self.snapshot()
        with self.assertRaises(RulesetCorruptError):
            self.read()
        self.assertEqual(self.snapshot(), before)
        path.write_bytes(original)
        with patch.object(content, "validator_fingerprint", return_value="e" * 64), self.assertRaises(RulesetCompatibilityError):
            self.read()
        self.registry.expected_schema["description"] = "A changed caller-owned submission schema"
        with self.assertRaises(RulesetCompatibilityError):
            self.read()

    def test_replacing_current_or_legacy_builder_does_not_reuse_its_old_bytes(self):
        self.read()
        current, legacy = content.diagnostics_schema, store.legacy_diagnostics_schema
        for target, name, original in ((content, "diagnostics_schema", current),
                                        (store, "legacy_diagnostics_schema", legacy)):
            calls = []

            def replaced(*args):
                calls.append(args)
                return original(*args)

            with self.subTest(builder=name), patch.object(target, name, replaced):
                self.read()
                self.read()
            self.assertEqual(len(calls), 2 if name == "diagnostics_schema" else 1)

    def test_replacing_the_module_schema_used_by_legacy_invalidates_the_memo(self):
        self.read()
        original = diagnostics.schema
        calls = []

        def replaced(version=None):
            calls.append(version)
            return original(version)

        with patch.object(diagnostics, "schema", replaced):
            self.read()
            self.read()
        self.assertEqual(calls, [None])

    def test_builder_failures_keep_eager_order_original_causes_and_are_not_cached(self):
        original = content.diagnostics_schema
        calls = []
        failure = ValueError("isolated v1 builder failure")

        def broken(version=None):
            calls.append(version)
            if version == 1:
                raise failure
            return original(version)

        self.read()  # A different builder key must not hide the later error.
        with patch.object(content, "diagnostics_schema", broken):
            for _ in range(2):
                with self.assertRaises(RulesetCorruptError) as caught:
                    self.read()
                self.assertIs(caught.exception.__cause__, failure)
        self.assertEqual(calls, [None, 1, None, 1])
        runtime = RuntimeError("isolated legacy builder failure")
        with patch.object(store, "legacy_diagnostics_schema", side_effect=runtime):
            # The current format matches, but the original eager legacy error
            # must still be raised rather than skipped by a short-circuit.
            with self.assertRaises(RuntimeError) as caught:
                self.read()
        self.assertIs(caught.exception, runtime)

    def test_oversize_expected_bytes_are_not_cached_or_given_new_validation_semantics(self):
        original = diagnostics.schema
        calls = []

        def counted(version=None):
            calls.append(version)
            return original(version)

        with patch.object(store, "_DIAGNOSTICS_CACHE_ENTRY_BYTES", 1), \
                patch.object(content, "diagnostics_schema", counted), patch.object(diagnostics, "schema", counted):
            self.assertEqual(self.read(), self.read())
        self.assertEqual(calls, [None, 1, None] * 2)
        self.assertEqual(len(store._diagnostics_bytes), 0)

    def test_builder_identity_cache_has_a_bounded_number_of_entries(self):
        for number in range(store._DIAGNOSTICS_CACHE_ENTRIES + 3):
            def current(version=None, value=number):
                return {"value": value, "version": version}

            def legacy(value=number):
                return {"legacy": value}

            with patch.object(content, "diagnostics_schema", current), patch.object(store, "legacy_diagnostics_schema", legacy):
                store._expected_diagnostics_bytes()
        self.assertEqual(len(store._diagnostics_bytes), store._DIAGNOSTICS_CACHE_ENTRIES)
        self.assertTrue(all(sum(map(len, values)) <= store._DIAGNOSTICS_CACHE_ENTRY_BYTES
                            for values in store._diagnostics_bytes.values()))


if __name__ == "__main__":
    unittest.main()
