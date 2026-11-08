"""Published prompt boundaries and synthetic example contracts, not semantic accuracy."""
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import tomllib
import unittest
from unittest.mock import patch

from jsonschema import Draft202012Validator

from core.modules.extraction_rules import content
from core.modules.extraction_rules.contracts import RulesetConflictError
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import read_release
from core.modules.ontology.validation import _graph
from core.runtime.extraction_schema import build_submission_schema


class ExtractionPolicyContracts(unittest.TestCase):
    def test_release_has_semantics_without_operational_tool_instructions(self):
        schema = build_submission_schema()
        packaged = content.components(schema)
        self.assertEqual(packaged["ontology.md"], content.SEMANTICS.read_bytes())
        role = tomllib.loads((content.SEMANTICS.parent / "wiki_ontology.toml").read_text())
        instructions = role["developer_instructions"]
        # Actual CLI assembly forbids tool calls; operational commands belong only to the role.
        for command in ("wiki_read", "ontology_generate", "ontology_query", "expected_revision", "save=false"):
            with self.subTest(command=command):
                self.assertNotIn(command, packaged["ontology.md"].decode())
                self.assertIn(command, instructions)

    def test_all_packaged_examples_validate_against_schema_and_exact_source(self):
        schema = build_submission_schema()
        validator = Draft202012Validator(schema)
        examples = json.loads(content.components(schema)["examples.json"])["examples"]
        self.assertEqual({item["submission"]["schema_version"] for item in examples}, {3, 4, 5, 6})
        self.assertTrue(any(item["submission"]["relation_candidates"] for item in examples))
        for example in examples:
            with self.subTest(version=example["submission"]["schema_version"], source=example["source"]):
                self.assertEqual(example["source_revision"], sha256(example["source"].encode()).hexdigest())
                validator.validate(example["submission"])
                normalized = _graph(document=example["document"], revision=example["source_revision"],
                                    source=example["source"], **example["submission"])
                self.assertEqual(len(normalized["relations"]), len(example["submission"]["relations"]))
                self.assertEqual(len(normalized["relation_candidates"]), len(example["submission"]["relation_candidates"]))

    def test_prompt_edit_requires_new_immutable_release(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "data").mkdir()
            prompt_path = root / "semantics.md"
            first = content.SEMANTICS.read_bytes()
            prompt_path.write_bytes(first)
            schema = build_submission_schema()
            fingerprint = content.validator_fingerprint()
            arguments = dict(tenant_root=root / "data", ruleset_id="policy", reason="isolated prompt contract",
                             schema=schema, expected_schema=schema)
            with patch.object(content, "SEMANTICS", prompt_path):
                original = publish(root / "rules", ruleset_version="v1", **arguments)
                original_manifest = (root / "rules/policy/v1/manifest.json").read_bytes()
                changed = first + b"\nSynthetic publication boundary check.\n"
                prompt_path.write_bytes(changed)
                with self.assertRaises(RulesetConflictError):
                    publish(root / "rules", ruleset_version="v1", **arguments)
                updated = publish(root / "rules", ruleset_version="v2", **arguments)
                reread = read_release(root / "rules", "policy", "v1", expected_schema=schema,
                                      validator_revision=fingerprint)
            self.assertEqual(reread["components"]["ontology.md"]["content"].encode(), first)
            self.assertEqual(updated["components"]["ontology.md"]["content"].encode(), changed)
            self.assertEqual((root / "rules/policy/v1/manifest.json").read_bytes(), original_manifest)
            self.assertEqual(original["manifest"]["validator_revision"], updated["manifest"]["validator_revision"])
            self.assertNotEqual(original["manifest"]["components"]["ontology.md"]["sha256"],
                                updated["manifest"]["components"]["ontology.md"]["sha256"])


if __name__ == "__main__":
    unittest.main()
