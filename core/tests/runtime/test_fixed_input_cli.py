"""규약 발행→동일 서버 MCP 입력 준비→실제 CLI hash 검증을 한 흐름만 확인한다."""

import json
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

from core.client.inputs import receive_input
from core.client.transport import AnalysisClientError
from core.tests.runtime import test_analysis_cli as fixture
from core.modules.extraction_rules.publish import publish
from core.runtime.extraction_schema import build_submission_schema


class FixedInputCliTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.AnalysisCliTests.save_policy
    test_published_rules_and_fixed_input_reach_actual_cli = fixture.AnalysisCliTests.test_actual_cli_claims_fixed_original_and_preserves_existing_knowledge

    def setUp(self):
        fixture.AnalysisCliTests.setUp(self)
        schema = build_submission_schema()
        root = self.root / "rulesets"
        publish(root, tenant_root=self.tenant_root, ruleset_id="llm-wiki", ruleset_version="1",
                reason="Isolated fixed input connection", schema=schema, expected_schema=schema)
        policy = self.root / "ruleset-policy.json"
        release = {"ruleset_id": "llm-wiki", "ruleset_version": "1"}
        policy.write_text(json.dumps({"version": 1, "tenants": {"alpha": {
            "default": release, "allowed": [release], "revoked": []}}}))
        self.server_arguments = ["--ruleset-root", str(root), "--ruleset-policy", str(policy)]
        self.client_arguments = ["--prepare-input"]


class InputIntegrityTests(unittest.IsolatedAsyncioTestCase):
    async def test_tampered_manifest_content_and_page_offsets_are_rejected(self):
        content = "조건과 예외 🌱\r\n"
        metadata = {"sha256": sha256(content.encode()).hexdigest(), "size_bytes": len(content.encode())}
        manifest = {"job_id": "job", "run_id": "run", "stage": "read_source",
                    "components": {"data/context.txt": metadata}}
        text = json.dumps(manifest, ensure_ascii=False, indent=2)
        prepared = {"input_ready": True, "can_analyze_input": True,
                    "bundle_id": "bundle", "bundle_revision": sha256(text.encode()).hexdigest()}
        bundle = {"manifest_text": text, "manifest": manifest,
                  "components": {"data/context.txt": metadata}}
        page = {"content": content, "component_sha256": metadata["sha256"],
                "next_offset": None, "complete": True}
        changed_bundle = deepcopy(bundle)
        changed_bundle["manifest"]["job_id"] = "other-job"
        cases = [
            ({**bundle, "manifest_text": text + "\n"}, page, "bundle_hash_mismatch"),
            (changed_bundle, page, "bundle_hash_mismatch"),
            (bundle, {**page, "content": "바뀐 내용"}, "input_component_mismatch"),
            (bundle, {**page, "next_offset": 0, "complete": False}, "input_page_mismatch"),
        ]
        for incoming, component, code in cases:
            with self.subTest(code=code), TemporaryDirectory() as directory:
                replies = AsyncMock(side_effect=[prepared, incoming, component])
                with patch("core.client.inputs.tool_call", replies), self.assertRaises(AnalysisClientError) as error:
                    await receive_input(None, tenant="alpha", job_id="job", run_id="run",
                        expected_job_revision="revision", directory=Path(directory))
                self.assertEqual(error.exception.code, code)


if __name__ == "__main__":
    unittest.main()
