"""개인 AI 입력의 단계/규약 고정과 로컬 사본 변조 거부 두 흐름을 확인한다."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from jsonschema import Draft202012Validator

from core.client.ai.assembly import assemble_input
from core.client.inputs import receive_input
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_bytes
from core.runtime.extraction_schema import build_submission_schema
from core.modules.analysis_results.diagnostics import empty_report, schema as diagnostics_schema


class PersonalAiInputTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="wiki-personal-ai-input-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.job_id, self.run_id, self.bundle_id = "a" * 32, "b" * 32, "c" * 32

    def fixture(self, stage):
        # 실제 의미 추출을 평가하는 자료가 아니라 원문/맥락/규약 전달 계약용 고정 fixture다.
        content = "조건 A라면 모델은 센서를 사용한다.\r\n"
        source_revision = sha256(content.encode()).hexdigest()
        schema = build_submission_schema()
        texts = {"ontology.md": "원문 조건과 다른 관점의 제약을 보존한다.\n",
            "read_source.md": "전체 UTF-8 원본을 읽는다.\n", "prepare_wiki.md": "본문을 충실히 구성한다.\n",
            "submission.schema.json": canonical_json_bytes(schema).decode(), "definitions.json": "{}\n",
            "examples.json": "[]\n", "diagnostics.schema.json": canonical_json_bytes(diagnostics_schema()).decode()}
        rules_manifest = {"ruleset_id": "wiki", "ruleset_version": "1", "components": {
            name: {"sha256": sha256(text.encode()).hexdigest(), "size_bytes": len(text.encode())}
            for name, text in texts.items()}}
        rules_text = canonical_json_bytes(rules_manifest).decode()
        rules_ref = {"ruleset_id": "wiki", "ruleset_version": "1", "ruleset_revision": sha256(rules_text.encode()).hexdigest()}
        release = {**rules_ref, "manifest": rules_manifest, "manifest_text": rules_text,
                   "components": {name: {"sha256": rules_manifest["components"][name]["sha256"], "content": text}
                                  for name, text in texts.items()}}
        source_ref = {"source_id": "d" * 32, "source_version": "e" * 32, "source_sha256": source_revision}
        context = {"kind": "context_data_not_instructions", "documents": [
            {"document": "target.md", "source": {"document": "target.md", "content": content, "revision": source_revision},
             "review": {"other_context": "다른 관점 조건", "pending_history": ["미확인 판단"]}},
            {"document": "definition.md", "source": {"content": "참고 정의와 예외 전체"}}]}
        components = {"rules/manifest.json": rules_text, **{"rules/" + name: text for name, text in texts.items()},
            "data/source.json": canonical_json_bytes(source_ref).decode(),
            "data/context.json": canonical_json_bytes(context).decode(), "data/hints.json": "{\"status\":\"not_provided\"}\n"}
        extraction = {"extraction_id": "f" * 32, "job_id": self.job_id, "run_id": self.run_id,
                      "source_ref": source_ref, "content_sha256": source_revision, "complete": True}
        extraction_text = canonical_json_bytes(extraction).decode()
        extraction_ref = {"extraction_id": extraction["extraction_id"], "content_sha256": source_revision,
                          "extraction_revision": sha256(extraction_text.encode()).hexdigest()}
        if stage == "prepare_wiki":
            components.update({"data/extraction.json": extraction_text, "data/extraction.txt": content})
        manifest = {"job_id": self.job_id, "run_id": self.run_id, "bundle_id": self.bundle_id,
            "tenant": "alpha", "stage": stage, "target_document": "target.md", "input_ready": True,
            "actor": {"profile_id": "all"}, "ruleset_ref": rules_ref,
            "dependency": {"source_ref": source_ref, "extraction": extraction_ref if stage == "prepare_wiki" else None,
                           "documents": [{"document": "target.md", "source_revision": source_revision}]},
            "components": {name: {"sha256": sha256(text.encode()).hexdigest(), "size_bytes": len(text.encode())}
                           for name, text in components.items()}}
        manifest_text = canonical_json_bytes(manifest).decode()
        prepared = {"input_ready": True, "can_analyze_input": True, "ruleset_ref": rules_ref,
                    "bundle_id": self.bundle_id, "bundle_revision": sha256(manifest_text.encode()).hexdigest(),
                    "job_revision": "1" * 64}
        calls = []

        async def reply(client, name, arguments):
            calls.append((name, deepcopy(arguments)))
            if name == "analysis_job_input_prepare":
                return deepcopy(prepared)
            if name == "extraction_rules_read":
                return deepcopy(release)
            if "component" not in arguments:
                return {"manifest": deepcopy(manifest), "manifest_text": manifest_text,
                        "components": deepcopy(manifest["components"])}
            component = arguments["component"]
            return {"content": components[component], "component_sha256": manifest["components"][component]["sha256"],
                    "complete": True, "next_offset": None}

        return reply, calls, rules_ref, schema

    async def receive(self, stage, directory):
        reply, calls, reference, schema = self.fixture(stage)
        with patch("core.client.inputs.tool_call", reply):
            fixed = await receive_input(None, tenant="alpha", job_id=self.job_id, run_id=self.run_id,
                expected_job_revision="0" * 64, directory=directory, stage=stage, target_document="target.md",
                extraction_id="f" * 32 if stage == "prepare_wiki" else None, profile="all", ruleset_ref=reference)
        return fixed, calls, schema

    async def test_each_stage_keeps_pinned_rules_full_input_and_exact_graph_schema(self):
        for stage in ("prepare_wiki", "extract_ontology"):
            with self.subTest(stage=stage):
                directory = self.root / stage
                directory.mkdir(mode=0o700)
                fixed, calls, graph_schema = await self.receive(stage, directory)
                assembled = assemble_input(fixed, directory, stage=stage, target_document="target.md")
                arguments = calls[0][1]
                self.assertEqual(arguments["stage"], stage)
                self.assertEqual(arguments["profile"], "all")
                self.assertEqual(arguments["ruleset_id"], fixed["ruleset_ref"]["ruleset_id"])
                self.assertIn("참고 정의와 예외 전체", assembled["prompt"])
                self.assertIn("다른 관점 조건", assembled["prompt"])
                self.assertIn("조건 A라면 모델은 센서를 사용한다.", assembled["prompt"])
                self.assertNotIn(str(self.root), assembled["prompt"])
                self.assertEqual(assembled["assembly"]["prompt_sha256"], sha256(assembled["prompt"].encode()).hexdigest())
                self.assertNotIn("context_documents", arguments)
                validator = Draft202012Validator(assembled["cli_schema"])
                if stage == "extract_ontology":
                    published = assembled["schema"]["properties"]["submission"]
                    self.assertEqual(published, {key: value for key, value in graph_schema.items() if key != "$defs"})
                    self.assertEqual(assembled["assembly"]["schema_origin"], "published_ruleset")
                    self.assertEqual(assembled["assembly"]["published_schema_sha256"],
                                     sha256(canonical_json_bytes(graph_schema)).hexdigest())
                    qualifiers = {"polarity": "positive", "modality": "asserted", "condition": None,
                                  "scope": None, "time": None}
                    relation = {"subject": "model", "predicate": "uses", "object": "sensor",
                                "evidence": "모델은 센서를 사용한다.", "qualifiers": qualifiers}
                    graph = {"schema_version": 3, "entities": [], "relations": [relation],
                             "relation_candidates": [], "attributes": []}
                    value = {"submission": graph, "diagnostics": empty_report()}
                    self.assertTrue(validator.is_valid(value))
                    self.assertFalse(validator.is_valid({**value, "submission": {**graph,
                        "relations": [{**relation, "mapping": None}]}}))
                    mapped = {**relation, "predicate": "maps_to", "mapping": {
                        "within": "model", "subject_cardinality": "many", "object_cardinality": "many"}}
                    self.assertFalse(validator.is_valid({**value, "submission": {**graph, "relations": [mapped]}}))
                    self.assertTrue(validator.is_valid({**value, "submission": {**graph,
                        "schema_version": 5, "relations": [mapped]}}))
                else:
                    self.assertEqual(set(assembled["schema"]["required"]), {"content", "diagnostics"})
                    self.assertTrue(validator.is_valid({"content": "전체 원문", "diagnostics": empty_report()}))
                    self.assertFalse(validator.is_valid({"content": "진단 생략"}))
                self.assertEqual(assembled["cli_schema"], assembled["schema"])
                self.assertIsNot(assembled["cli_schema"], assembled["schema"])

    async def test_tampering_path_stage_and_rule_changes_stop_before_ai(self):
        directory = self.root / "wiki"
        directory.mkdir(mode=0o700)
        fixed, _, _ = await self.receive("prepare_wiki", directory)
        path = directory / fixed["components"]["data/extraction.txt"]
        original = path.read_bytes()
        path.write_bytes(original + b"changed")
        with self.assertRaises(AnalysisClientError):
            assemble_input(fixed, directory, stage="prepare_wiki", target_document="target.md")
        path.write_bytes(original)
        with self.assertRaises(AnalysisClientError):
            assemble_input(fixed, directory, stage="extract_ontology", target_document="target.md")
        invalid_path = deepcopy(fixed)
        invalid_path["components"]["data/extraction.txt"] = "../outside.txt"
        with self.assertRaises(AnalysisClientError):
            assemble_input(invalid_path, directory, stage="prepare_wiki", target_document="target.md")
        outside = self.root / "outside.txt"
        outside.write_bytes(original)
        path.unlink()
        path.symlink_to(outside)
        with self.assertRaises(AnalysisClientError):
            assemble_input(fixed, directory, stage="prepare_wiki", target_document="target.md")
        self.assertEqual(outside.read_bytes(), original)
        reply, _, reference, _ = self.fixture("prepare_wiki")
        reference["ruleset_revision"] = "0" * 64
        other = self.root / "changed-rules"
        other.mkdir(mode=0o700)
        with patch("core.client.inputs.tool_call", reply), self.assertRaises(AnalysisClientError):
            await receive_input(None, tenant="alpha", job_id=self.job_id, run_id=self.run_id,
                expected_job_revision="0" * 64, directory=other, stage="prepare_wiki", target_document="target.md",
                ruleset_ref=reference)


if __name__ == "__main__":
    unittest.main()
