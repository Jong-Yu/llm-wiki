"""One-summary immutable input reuse keeps canonical evidence and errors."""

import unittest
from unittest.mock import patch

from core.common.json_codec import canonical_json_bytes
from core.modules.analysis_inputs import contracts as limits, files
from core.modules.analysis_jobs import records
from core.modules.analysis_results import repository
from core.modules.analysis_results.contracts import ResultError
from core.modules.documents.store import WikiStore
from core.tests.poc_analysis import test_registration as fixtures


class ResultSummaryReuseTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.RegistrationTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.new()
        self.fixture.claim()
        self.arguments, self.receipt = self.fixture.save_markdown()
        self.job = records.owned_state(self.fixture.jobs, self.fixture.job_id, **self.fixture.scope)
        self.parent = self.fixture.jobs.job_root(self.fixture.job_id) / "inputs"
        self.bundle = self.parent / self.arguments["bundle_id"]
        self.revision = self.arguments["bundle_revision"]

    def snapshot(self):
        return {path.relative_to(self.fixture.root).as_posix(): path.read_bytes()
                for path in self.fixture.root.rglob("*") if path.is_file()
                and path.relative_to(self.fixture.root).parts[0] != "_index"}

    def summary(self, *, original=False):
        with self.fixture.sources._coordination_lock():
            if original:
                with patch.object(repository, "_summary_input_loader", return_value=files.load):
                    return repository.summary(self.fixture.jobs, self.job)
            return repository.summary(self.fixture.jobs, self.job)

    def loader(self):
        return repository._summary_input_loader(self.fixture.store, self.parent)

    @staticmethod
    def value(label="value"):
        manifest = {"label": label, "components": {}}
        return manifest, canonical_json_bytes(manifest).decode(), {"text": "Entire original.\r\n한글"}

    def test_summary_matches_original_and_loads_the_preserved_input_once(self):
        before = self.snapshot()
        with patch.object(files, "load", wraps=files.load) as original:
            expected = self.summary(original=True)
        with patch.object(files, "load", wraps=files.load) as reused:
            actual = self.summary()
        self.assertEqual(actual, expected)
        self.assertEqual(sum(call.args[1] == self.bundle for call in original.call_args_list), 2)
        self.assertEqual(sum(call.args[1] == self.bundle for call in reused.call_args_list), 1)
        self.assertEqual(len(original.call_args_list), 3)
        self.assertEqual(len(reused.call_args_list), 2)
        self.assertEqual(self.snapshot(), before)

    def test_reuse_ends_with_each_summary_and_default_external_load_stays_uncached(self):
        with patch.object(files, "load", wraps=files.load) as loaded:
            first = self.summary()
            self.assertEqual(self.summary(), first)
        self.assertEqual(sum(call.args[1] == self.bundle for call in loaded.call_args_list), 2)
        with patch.object(files, "load", wraps=files.load) as loaded:
            first = repository.load(self.fixture.results, self.job, self.arguments["request_id"])
            self.assertEqual(repository.load(self.fixture.results, self.job, self.arguments["request_id"]), first)
        inputs = [call for call in loaded.call_args_list if call.args[1] == self.bundle]
        self.assertEqual(len(inputs), 2)
        self.assertTrue(all(call.kwargs == {"expected_revision": self.revision} for call in inputs))

    def test_optional_loader_only_receives_the_fixed_input_and_preserves_keywords(self):
        before = self.snapshot()
        with patch.object(files, "load", wraps=files.load) as fixed:
            actual = repository.load(self.fixture.results, self.job, self.arguments["request_id"], input_loader=fixed)
        self.assertEqual(actual, repository.load(self.fixture.results, self.job, self.arguments["request_id"]))
        # The result submission is read normally; only its preserved input is
        # routed through the optional loader (the wrapper also observes the normal call).
        inputs = [call for call in fixed.call_args_list if call.args[1] == self.bundle]
        self.assertEqual(len(inputs), 1)
        self.assertEqual(inputs[0].kwargs, {"expected_revision": self.revision})
        self.assertEqual(self.snapshot(), before)

    def test_manifest_and_component_mutation_cannot_poison_reused_values(self):
        load = self.loader()
        before = self.snapshot()
        expected = files.load(self.fixture.store, self.bundle, expected_revision=self.revision)
        first = load(self.fixture.store, self.bundle, expected_revision=self.revision)
        first[0]["components"].clear()
        first[2].clear()
        second = load(self.fixture.store, self.bundle, expected_revision=self.revision)
        self.assertEqual(second, expected)
        second[0].clear()
        second[2]["poison"] = "caller data"
        self.assertEqual(load(self.fixture.store, self.bundle, expected_revision=self.revision), expected)
        self.assertEqual(self.snapshot(), before)

    def test_default_and_explicit_current_maximum_share_only_equivalent_options(self):
        load = self.loader()
        with patch.object(files, "load", wraps=files.load) as loaded:
            expected = load(self.fixture.store, self.bundle, expected_revision=self.revision)
            self.assertEqual(load(self.fixture.store, self.bundle, expected_revision=self.revision,
                                  maximum=limits.MAX_BUNDLE_BYTES), expected)
        self.assertEqual(loaded.call_count, 1)
        self.assertEqual(loaded.call_args.kwargs, {"expected_revision": self.revision})
        with patch.object(limits, "MAX_BUNDLE_BYTES", 1), self.assertRaises(limits.InputLimitError):
            load(self.fixture.store, self.bundle, expected_revision=self.revision)

    def test_revision_limit_root_and_invalid_option_types_do_not_collide(self):
        load = self.loader()
        value = self.value()
        with patch.object(files, "load", return_value=value) as loaded:
            options = {"expected_revision": self.revision, "maximum": 1}
            load(self.fixture.store, self.bundle, **options)
            load(self.fixture.store, self.bundle, **options)
            self.assertEqual(loaded.call_count, 1)
            for maximum in (True, 1.0):
                for _ in range(2):
                    load(self.fixture.store, self.bundle, expected_revision=self.revision, maximum=maximum)
            self.assertEqual(loaded.call_count, 5)
            load(self.fixture.store, self.bundle, expected_revision="e" * 64, maximum=1)
            load(self.fixture.store, self.bundle, expected_revision=self.revision, maximum=2)
            other_job = self.parent.parent.parent / ("a" * 32) / "inputs" / self.bundle.name
            for _ in range(2):
                load(self.fixture.store, other_job, **options)
                load(self.fixture.store, self.bundle, maximum=1)
            other_store = WikiStore(self.fixture.store.data_dir)
            load(other_store, self.bundle, **options)
            load(other_store, self.bundle, **options)
            self.assertEqual(loaded.call_count, 13)
        with self.assertRaises(TypeError):
            load(self.fixture.store, self.bundle, expected_revision=self.revision, unsupported=True)

    def test_smaller_limit_and_wrong_revision_keep_the_original_loader_errors(self):
        load = self.loader()
        load(self.fixture.store, self.bundle, expected_revision=self.revision)
        for options in ({"expected_revision": "e" * 64},
                        {"expected_revision": self.revision, "maximum": 1}):
            failures = []
            for reader in (files.load, load):
                with self.assertRaises((limits.InputConflictError, limits.InputLimitError)) as caught:
                    reader(self.fixture.store, self.bundle, **options)
                failures.append(caught.exception)
            self.assertEqual(type(failures[0]), type(failures[1]))
            self.assertEqual(str(failures[0]), str(failures[1]))

    def test_failed_load_is_not_cached_and_success_can_be_reused_after_retry(self):
        load = self.loader()
        failure = OSError("isolated read failure")
        value = self.value()
        with patch.object(files, "load", side_effect=[failure, value]) as loaded:
            with self.assertRaises(OSError) as caught:
                load(self.fixture.store, self.bundle, expected_revision=self.revision)
            self.assertIs(caught.exception, failure)
            self.assertEqual(load(self.fixture.store, self.bundle, expected_revision=self.revision), value)
            self.assertEqual(load(self.fixture.store, self.bundle, expected_revision=self.revision), value)
        self.assertEqual(loaded.call_count, 2)

    def test_entry_and_total_byte_limits_bound_reuse_without_changing_success(self):
        first, second = self.parent / ("a" * 32), self.parent / ("b" * 32)
        value = self.value()
        with patch.object(repository, "_SUMMARY_INPUT_CACHE_ENTRIES", 1):
            load = self.loader()
            with patch.object(files, "load", return_value=value) as loaded:
                for path in (first, second, first):
                    self.assertEqual(load(self.fixture.store, path, expected_revision=self.revision), value)
            self.assertEqual(loaded.call_count, 3)
        with patch.object(repository, "_SUMMARY_INPUT_CACHE_BYTES", 1):
            load = self.loader()
            with patch.object(files, "load", return_value=value) as loaded:
                self.assertEqual(load(self.fixture.store, first, expected_revision=self.revision), value)
                self.assertEqual(load(self.fixture.store, first, expected_revision=self.revision), value)
            self.assertEqual(loaded.call_count, 2)
        raw_size = len(value[1].encode()) + sum(len(name.encode()) + len(text.encode()) for name, text in value[2].items())
        with patch.object(repository, "_SUMMARY_INPUT_CACHE_BYTES", raw_size):
            load = self.loader()
            with patch.object(files, "load", return_value=value) as loaded:
                for path in (first, second, first):
                    self.assertEqual(load(self.fixture.store, path, expected_revision=self.revision), value)
            self.assertEqual(loaded.call_count, 3)

    def test_optional_memo_encoding_does_not_add_validation_to_a_successful_custom_loader(self):
        for value in (({}, "\ud800", {}), ({}, "{}", {"text": "\ud800"}),
                      ({"different": True}, "{}", {})):
            with self.subTest(value_type=type(value)):
                load = self.loader()
                with patch.object(files, "load", return_value=value) as loaded:
                    self.assertIs(load(self.fixture.store, self.bundle, expected_revision=self.revision), value)
                    self.assertIs(load(self.fixture.store, self.bundle, expected_revision=self.revision), value)
                self.assertEqual(loaded.call_count, 2)

    def test_corruption_after_a_summary_is_not_hidden_and_keeps_original_error_order(self):
        expected = self.summary()
        self.assertEqual(expected, self.summary(original=True))
        component = next(self.bundle.glob("component-*.txt"))
        original = component.read_bytes()
        component.write_bytes(original + b"\ncorrupt fixture component\n")
        before = self.snapshot()
        failures = []
        for original_mode in (True, False):
            with self.assertRaises(ResultError) as caught:
                self.summary(original=original_mode)
            failures.append(caught.exception)
        self.assertEqual([error.code for error in failures], ["result_corrupt", "result_corrupt"])
        self.assertEqual(type(failures[0].__cause__), type(failures[1].__cause__))
        self.assertEqual(str(failures[0].__cause__), str(failures[1].__cause__))
        self.assertEqual(self.snapshot(), before)
        component.write_bytes(original)
        self.assertEqual(self.summary(), expected)

    def test_missing_fixed_input_keeps_the_original_error_and_preserves_all_other_files(self):
        held = self.parent / "held-input-fixture"
        self.bundle.rename(held)
        before = self.snapshot()
        failures = []
        for original in (True, False):
            with self.assertRaises(FileNotFoundError) as caught:
                self.summary(original=original)
            failures.append(caught.exception)
        self.assertEqual(failures[0].errno, failures[1].errno)
        self.assertEqual(failures[0].filename, failures[1].filename)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
