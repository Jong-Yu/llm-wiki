"""공용화 전후의 저장 바이트와 정리 경고 표시 계약을 검증한다."""

from copy import deepcopy
from dataclasses import dataclass
import errno
from hashlib import sha256
import math
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from core.common.cleanup import cleanup_details
from core.common.json_codec import canonical_json_bytes, canonical_json_hash


class CanonicalJsonTests(unittest.TestCase):
    def test_unicode_nested_sorting_and_original_values_preserve_fixed_bytes(self):
        value = {"z": 2, "a": {"z": [True, None, 1.5], "a": "한글"}}
        original = deepcopy(value)
        expected = b'{"a":{"a":"\xed\x95\x9c\xea\xb8\x80","z":[true,null,1.5]},"z":2}\n'

        self.assertEqual(canonical_json_bytes(value), expected)
        self.assertEqual(value, original)
        self.assertEqual(list(value), ["z", "a"])
        self.assertEqual(list(value["a"]), ["z", "a"])

    def test_record_lf_is_distinct_from_escaped_content_newline(self):
        self.assertEqual(canonical_json_bytes({}), b"{}\n")
        self.assertEqual(canonical_json_bytes("first\nsecond"), b'"first\\nsecond"\n')

    def test_hash_uses_fixed_utf8_bytes_including_final_lf(self):
        value = {"z": 2, "a": {"z": [True, None, 1.5], "a": "한글"}}
        expected = b'{"a":{"a":"\xed\x95\x9c\xea\xb8\x80","z":[true,null,1.5]},"z":2}\n'

        self.assertEqual(canonical_json_hash(value), sha256(expected).hexdigest())
        self.assertNotEqual(canonical_json_hash(value), sha256(expected[:-1]).hexdigest())

    def test_nonfinite_values_are_rejected_by_default_for_bytes_and_hash(self):
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    canonical_json_bytes({"nested": [value]})
                with self.assertRaises(ValueError):
                    canonical_json_hash({"nested": [value]})

    def test_explicit_legacy_option_preserves_nonfinite_serialization(self):
        value = {"a": [math.nan, math.inf, -math.inf]}
        self.assertEqual(
            canonical_json_bytes(value, allow_nan=True),
            b'{"a":[NaN,Infinity,-Infinity]}\n',
        )
        with self.assertRaises(ValueError):
            canonical_json_bytes(value, allow_nan=False)


@dataclass(frozen=True)
class _Warning:
    path: Path
    error: OSError


class CleanupDetailsTests(unittest.TestCase):
    def test_relative_projection_preserves_warning_objects_and_errno(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            error = PermissionError(errno.EACCES, "private diagnostic", str(root / "secret"))
            warning = _Warning(root / "nested" / ".wiki-staged.tmp", error)
            warnings = [warning]
            original_args = error.args

            result = cleanup_details(root, warnings)

            self.assertEqual(result, [{
                "path": "nested/.wiki-staged.tmp",
                "error_type": "PermissionError",
                "errno": errno.EACCES,
            }])
            self.assertNotIn(str(root), repr(result))
            self.assertNotIn("private diagnostic", repr(result))
            self.assertIs(warnings[0], warning)
            self.assertIs(warning.error, error)
            self.assertEqual(error.args, original_args)
            self.assertEqual(error.filename, str(root / "secret"))

    def test_empty_input_and_missing_errno_keep_existing_shape(self):
        root = Path("/unused-data-root")
        self.assertEqual(cleanup_details(root, []), [])
        warning = _Warning(root / ".wiki-staged.tmp", OSError("cleanup failed"))
        self.assertEqual(cleanup_details(root, [warning]), [{
            "path": ".wiki-staged.tmp", "error_type": "OSError", "errno": None,
        }])

    def test_outside_path_raises_without_rewriting_original_warning(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / "data"
            warning = _Warning(Path(directory) / "outside.tmp", OSError(errno.EIO, "cleanup"))
            with self.assertRaises(ValueError):
                cleanup_details(root, [warning])
            self.assertEqual(warning.path, Path(directory) / "outside.tmp")
            self.assertEqual(warning.error.errno, errno.EIO)

    def test_projection_does_not_read_remove_or_resolve_files(self):
        root = Path("/unused-data-root")
        warning = _Warning(root / "not-created.tmp", OSError(errno.EIO, "cleanup"))
        with patch.object(Path, "open", side_effect=AssertionError("must not read")), \
                patch.object(Path, "unlink", side_effect=AssertionError("must not remove")), \
                patch.object(Path, "resolve", side_effect=AssertionError("must not resolve")):
            self.assertEqual(cleanup_details(root, [warning])[0]["path"], "not-created.tmp")


if __name__ == "__main__":
    unittest.main()
