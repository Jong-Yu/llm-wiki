"""새 규약의 원문 보존·불변 발행·허용/철회 경계만 임시 자료에서 확인한다."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from jsonschema import Draft202012Validator

from core.modules.extraction_rules.content import SEMANTICS, examples
from core.modules.extraction_rules.contracts import (
    RulesetCompatibilityError, RulesetConfigurationError, RulesetConflictError,
    RulesetCorruptError, RulesetUnavailableError,
)
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry, reference, schema_bytes
from core.modules.ontology.validation import _graph
from core.modules.ontology.errors import OntologyValidationError
from core.modules.ontology.store import OntologyStore
from core.modules.documents.store import WikiStore
from core.runtime.extraction_schema import build_submission_schema, select_submission_schema


class ExtractionRulesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="llm-wiki-rules-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.tenants = self.root / "data"
        self.tenants.mkdir()
        self.releases = self.root / "releases"
        self.policy_file = self.root / "rules.json"
        self.schema = build_submission_schema()
        self.ref = {"ruleset_id": "llm-wiki", "ruleset_version": "1"}
        self.policy = {"version": 1, "tenants": {name: {
            "default": dict(self.ref), "allowed": [dict(self.ref)], "revoked": []}
            for name in ("alpha", "beta")}}

    def publish(self, **changes):
        return publish(self.releases, tenant_root=self.tenants, ruleset_id="llm-wiki",
                       ruleset_version="1", reason="개발용 규약 첫 발행", schema=self.schema,
                       expected_schema=self.schema, **changes)

    def registry(self, schema=None):
        self.policy_file.write_text(json.dumps(self.policy), encoding="utf-8")
        return RulesetRegistry(self.releases, self.policy_file, self.tenants,
                               expected_schema=self.schema if schema is None else schema)

    def test_shared_semantics_describe_supported_versions_and_explicit_qualifiers(self):
        # 공통 지침은 한 원본을 공유한다. 옛 의미 원문의 hash를 현재 계약으로 소급 인증하지 않는다.
        text = SEMANTICS.read_text()
        self.assertIn("schema_version=3,4,5,6", text)
        for name in ("source_anchor", "maps_to", "has_source_metadata", "has_source_history", "diagnostics.omissions"):
            self.assertIn(name, text)
        role = (SEMANTICS.parent / "wiki_ontology.toml").read_text()
        self.assertIn(".agent/ontology_semantics.md", role)
        self.assertNotIn("관계 방향과 의미:", role)
        self.assertEqual(self.schema["properties"]["schema_version"]["enum"], [3, 4, 5, 6])
        self.assertEqual(set(self.schema["$defs"]["QualifiersInput"]["required"]),
                         {"polarity", "modality", "condition", "scope", "time"})

    def test_versioned_examples_and_invalid_cross_version_forms_match_source_validator(self):
        validator = Draft202012Validator(self.schema)
        rows = examples()["examples"]
        for row in rows:
            with self.subTest(version=row["submission"]["schema_version"]):
                submission = row["submission"]
                validator.validate(submission)
                selected = select_submission_schema(self.schema, submission["schema_version"])
                Draft202012Validator(selected).validate(submission)
                _graph(row["document"], row["source_revision"], source=row["source"], **submission)
                # v3의 앵커, v3/v4의 maps_to, v3/v4/v5의 출처 관계는 두 검증 경로 모두 거부한다.
                for version in range(3, submission["schema_version"]):
                    invalid = {**submission, "schema_version": version}
                    self.assertFalse(validator.is_valid(invalid))
                    with self.assertRaises(OntologyValidationError):
                        _graph(row["document"], row["source_revision"], source=row["source"], **invalid)
        # 실제 발견한 v3 requires의 스키마 통과/저장 거부 차이를 고정한다.
        row = deepcopy(rows[0])
        row["submission"]["relations"][0]["predicate"] = "requires"
        self.assertFalse(validator.is_valid(row["submission"]))
        for version in (5, 6):
            row["submission"]["schema_version"] = version
            validator.validate(row["submission"])
            _graph(row["document"], row["source_revision"], source=row["source"], **row["submission"])
        self.assertEqual(self.schema["properties"]["schema_version"]["enum"], [3, 4, 5, 6])

    def test_mapping_source_record_qualifiers_and_candidate_boundaries_remain_explicit(self):
        validator = Draft202012Validator(self.schema)
        rows = examples()["examples"]
        invalid = []
        for mapping in (None, {"within": "a", "subject_cardinality": "many", "object_cardinality": "many"}):
            value = deepcopy(rows[0]["submission"])
            value["relations"][0]["mapping"] = mapping
            invalid.append(value)
        for change in ("missing_mapping", "null_mapping", "wrong_cardinality"):
            value = deepcopy(rows[2]["submission"])
            relation = value["relations"][0]
            if change == "missing_mapping":
                relation.pop("mapping")
            elif change == "null_mapping":
                relation["mapping"] = None
            else:
                relation["mapping"]["object_cardinality"] = "one"
            invalid.append(value)
        for name, wrong in (("subject", rows[3]["submission"]["relations"][0]["object"]),
                            ("object", "a"), ("qualifiers", {"polarity": "negative", "modality": "asserted",
                                                             "condition": None, "scope": None, "time": None})):
            value = deepcopy(rows[3]["submission"])
            value["relations"][0][name] = wrong
            invalid.append(value)
        value = deepcopy(rows[3]["submission"])
        relation = value["relations"].pop()
        value["relation_candidates"] = [{**relation, "id": "candidate", "reason": "합성 형식 경계", "question": "확인 필요"}]
        invalid.append(value)
        for value in invalid:
            self.assertFalse(validator.is_valid(value))
        legacy = deepcopy(self.schema)
        legacy.pop("anyOf")
        with self.assertRaises(RulesetCompatibilityError):
            schema_bytes(legacy)
        for version in (1, 2, 7, True, "3"):
            with self.assertRaises(ValueError):
                select_submission_schema(self.schema, version)

    def test_normative_text_and_factual_relation_round_trip_without_new_modality(self):
        # 합성 규약 예시의 저장 가능성과 무손실 왕복이다. 실제 모델의 의미 정확도 점수가 아니다.
        row = examples()["examples"][0]
        source, submission = row["source"], row["submission"]
        fact, rule = source.split("\n")
        (self.tenants / "alpha").mkdir()
        wiki = WikiStore(self.tenants / "alpha")
        saved = wiki.save(row["document"], source, expected_revision=None)
        ontology = OntologyStore(wiki)
        for version in (3, 4, 5, 6):
            with self.subTest(version=version):
                ontology.generate(row["document"], saved.revision, **{**submission, "schema_version": version})
                result = ontology.query(row["document"])
                self.assertEqual(result["status"], "ready")
                self.assertEqual(len(result["relations"]), 1)
                relation = result["relations"][0]
                self.assertEqual(relation["predicate"], "uses")
                self.assertEqual(relation["evidence"]["quote"], fact)
                self.assertEqual(relation["qualifiers"]["condition"], "승인된 경우에만")
                self.assertEqual(len(result["attributes"]), 1)
                attribute = result["attributes"][0]
                self.assertEqual(attribute["value"], rule)
                self.assertEqual(attribute["evidence"]["quote"], rule)
                self.assertEqual(attribute["qualifiers"], {
                    "polarity": "positive", "modality": "asserted", "condition": "점검 중에는",
                    "scope": None, "time": None})
                self.assertEqual(attribute["provenance"]["basis"], "사용해서는 안 된다")
                self.assertEqual(result["relation_candidates"], [])
        self.assertEqual(wiki.read(row["document"]).content, source)

    def test_normative_attribute_does_not_relax_vocabulary_quotes_or_value_limit(self):
        row = examples()["examples"][0]
        invalid_changes = (
            {"qualifiers": {**row["submission"]["attributes"][0]["qualifiers"], "modality": "prohibited"}},
            {"value": "점검 중에는 사용하지 않았다."},
            {"property": "원문에 없는 규칙명"},
            {"qualifiers": {**row["submission"]["attributes"][0]["qualifiers"], "condition": "허용되면"}},
        )
        for changes in invalid_changes:
            with self.subTest(changes=changes):
                submission = deepcopy(row["submission"])
                submission["attributes"][0].update(changes)
                with self.assertRaises(OntologyValidationError):
                    _graph(row["document"], row["source_revision"], source=row["source"], **submission)
        long_rule = "사용 금지 규칙: " + "가" * 501
        submission = deepcopy(row["submission"])
        submission["attributes"][0].update(value=long_rule, evidence=long_rule,
            qualifiers={"polarity": "positive", "modality": "asserted", "condition": None,
                        "scope": None, "time": None}, provenance={})
        source = row["source"] + "\n" + long_rule
        with self.assertRaises(OntologyValidationError):
            _graph(row["document"], sha256(source.encode()).hexdigest(), source=source, **submission)

    def test_independent_normative_branches_preserve_conditions_and_attribution(self):
        # if/unless/OR를 재작성하거나 두 규칙을 합치지 않는 기존 text 계약의 보존 검사다.
        rules = [
            "Policy Team states for the test network: Device A MUST NOT use Channel B if the safety lock is active.",
            "Policy Team states for the test network: Device A MUST NOT use Channel B unless the operator is present or a maintenance permit exists.",
        ]
        fact = "Monitor M observes Device A."
        source = "\n".join([*rules, fact])
        plain = {"polarity": "positive", "modality": "asserted", "condition": None, "scope": None, "time": None}
        submission = {"schema_version": 3,
            "entities": [{"id": identifier, "type": kind, "label": label, "evidence": quote}
                for identifier, kind, label, quote in (("device", "system", "Device A", rules[0]),
                    ("team", "organization", "Policy Team", rules[0]), ("monitor", "system", "Monitor M", fact))],
            "relations": [{"subject": "monitor", "predicate": "observes", "object": "device",
                           "evidence": fact, "qualifiers": dict(plain)}],
            "relation_candidates": [],
            "attributes": [{"id": f"rule_{i}", "subject": "device", "property": "MUST NOT",
                "datatype": "text", "value": rule, "unit": None, "evidence": rule,
                "qualifiers": {**plain, "condition": rule[rule.index(marker):-1], "scope": "test network"},
                "context": {"domain": "test network", "viewpoints": []},
                "provenance": {"source_entity": None, "attributed_to": "team", "basis": "MUST NOT"}}
                for i, (rule, marker) in enumerate(zip(rules, ("if ", "unless ")))]}
        Draft202012Validator(self.schema).validate(submission)
        graph = _graph("norms.md", sha256(source.encode()).hexdigest(), source=source, **submission)
        self.assertEqual(len(graph["relations"]), 1)
        self.assertEqual([attribute["value"] for attribute in graph["attributes"]], rules)
        for original, stored in zip(submission["attributes"], graph["attributes"]):
            for key in ("qualifiers", "context", "provenance"):
                self.assertEqual(stored[key], original[key])

    def test_prompt_revision_keeps_previous_release_bytes_and_default_policy(self):
        old_semantics = self.root / "old-semantics.md"
        old_semantics.write_text("이전 발행 규약의 고정된 합성 지침.\n", encoding="utf-8")
        with patch("core.modules.extraction_rules.content.SEMANTICS", old_semantics):
            self.publish()
        registry = self.registry()
        previous = registry.read("alpha")
        policy_before = self.policy_file.read_bytes()
        second = publish(self.releases, tenant_root=self.tenants, ruleset_id="llm-wiki",
            ruleset_version="2", reason="규범 의미 지침 개발 검증", schema=self.schema, expected_schema=self.schema)
        self.assertEqual(self.policy_file.read_bytes(), policy_before)
        self.assertEqual(registry.read("alpha"), previous)
        self.assertNotEqual(second["components"]["ontology.md"]["sha256"],
                            previous["components"]["ontology.md"]["sha256"])
        self.assertEqual(second["components"]["submission.schema.json"],
                         previous["components"]["submission.schema.json"])
        self.assertEqual(second["components"]["definitions.json"], previous["components"]["definitions.json"])

    def test_publication_is_immutable_and_two_users_read_identical_exact_bytes(self):
        issued = self.publish()
        registry = self.registry()
        alpha, beta = registry.read("alpha"), registry.read("beta")
        self.assertEqual(alpha, beta)
        self.assertEqual(alpha["ruleset_revision"], sha256(alpha["manifest_text"].encode()).hexdigest())
        self.assertEqual(alpha["components"]["ontology.md"]["content"].encode(), SEMANTICS.read_bytes())
        self.assertIn("diagnostics.schema.json", alpha["components"])
        self.assertEqual(registry.validate_reference("alpha", reference(issued))["ruleset_revision"], issued["ruleset_revision"])
        before = {p.relative_to(self.releases): p.read_bytes() for p in self.releases.rglob("*") if p.is_file()}
        with self.assertRaises(RulesetConflictError):
            self.publish()
        self.assertEqual(before, {p.relative_to(self.releases): p.read_bytes() for p in self.releases.rglob("*") if p.is_file()})

    def test_revocation_tampering_incompatible_schema_and_tenant_overlap_fail_closed(self):
        self.publish()
        registry = self.registry()
        self.policy["tenants"]["alpha"]["revoked"] = [dict(self.ref)]
        self.policy_file.write_text(json.dumps(self.policy))
        with self.assertRaises(RulesetUnavailableError):
            registry.read("alpha")
        self.assertEqual(registry.read("beta")["status"], "allowed")
        component = self.releases / "llm-wiki" / "1" / "ontology.md"
        original = component.read_bytes()
        component.write_bytes(original + b"tampered")
        with self.assertRaises(RulesetCorruptError):
            registry.read("beta")
        component.write_bytes(original)
        incompatible = deepcopy(self.schema)
        incompatible["title"] = "DifferentSubmission"
        with self.assertRaises(RulesetCompatibilityError):
            self.registry(incompatible).read("beta")
        with self.assertRaises(RulesetConfigurationError):
            RulesetRegistry(self.tenants / "forbidden", self.policy_file, self.tenants, expected_schema=self.schema)

    def test_old_release_and_diagnostics_mismatch_fail_closed_without_rewriting(self):
        self.publish()
        registry = self.registry()
        directory = self.releases / "llm-wiki" / "1"
        diagnostic = directory / "diagnostics.schema.json"
        original = diagnostic.read_bytes()
        diagnostic.unlink()
        legacy = {path.name: path.read_bytes() for path in directory.iterdir()}
        with self.assertRaises(RulesetCompatibilityError):
            registry.read("alpha")
        self.assertEqual(legacy, {path.name: path.read_bytes() for path in directory.iterdir()})
        diagnostic.write_bytes(original)
        changed = original.replace(b'"schema_version"', b'"unknown_version"')
        diagnostic.write_bytes(changed)
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["components"]["diagnostics.schema.json"] = {"sha256": sha256(changed).hexdigest(), "size_bytes": len(changed)}
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(RulesetCompatibilityError):
            registry.read("alpha")


if __name__ == "__main__":
    unittest.main()
