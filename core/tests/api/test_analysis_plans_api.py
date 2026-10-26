"""원본 보존·범위 고정·분석/질문의 고정입력 연결에서 핵심 흐름만 검사한다."""

from copy import deepcopy
from hashlib import sha256
from io import BytesIO
from uuid import uuid4
from zipfile import ZipFile
import json
import unittest
from core.tests.api import test_analysis_inputs_protocol as fixture
from core.api.v1.knowledge.schemas import QuestionContextRequest
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_inputs.store import InputStore
from core.modules.analysis_inputs import files


class AnalysisPlanApiTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.AnalysisInputsProtocolTests.save_policy
    snapshot = fixture.AnalysisInputsProtocolTests.snapshot
    headers = fixture.AnalysisInputsProtocolTests.headers
    client = fixture.AnalysisInputsProtocolTests.client
    nothing = fixture.AnalysisInputsProtocolTests.nothing
    value = fixture.AnalysisInputsProtocolTests.value

    def setUp(self):
        """기존 격리 규약/정책 준비만 재사용하고 기존 검사를 중복 수집하지 않는다."""
        fixture.AnalysisInputsProtocolTests.setUp(self)
        self.base = "/api/v1/tenants/alpha"

    def source_ref(self, source):
        """이름 대신 원본 ID·판본·hash와 카탈로그 revision으로 출처를 고정한다."""
        return {key: source[key] for key in ("source_id", "source_version", "source_sha256", "registration_revision")}

    def location(self, kind="whole", **values):
        """시험의 위치도 API와 같은 명시 구조로 지정한다."""
        return {"kind": kind, "start": None, "end": None, "sheet": None, "cells": None, **values}

    def output(self, **values):
        """첫 분석 계획은 실제 저장할 문서와 목적을 별도 항목으로 보존한다."""
        return {"document": "새문서.md", "title": "업무 기준", "purpose": "선택 범위의 조건 정리", "outputs": ["wiki"], **values}

    def authorize(self, permission="source_write"):
        """내부 claim/input 호출도 임시 정책의 현재 인증 주체에서 actor를 얻는다."""
        from core.api.dependencies import access_value
        return access_value(self.policy.authorize(self.tokens["alice"], "alpha", permission))

    async def text_source(self, http, content="첫 줄\r\n둘째 줄\n셋째 줄\n"):
        return self.value(await http.post(self.base + "/sources", json={"request_id": uuid4().hex,
            "title": "텍스트 원본", "format": "txt", "content": content}), 201)

    async def test_binary_originals_and_reported_locations_keep_exact_original_bytes(self):
        """PDF/XLSX는 원시 바이트로 보존하고 변환 보고를 의미 승인과 구분한다."""
        workbook = BytesIO()
        with ZipFile(workbook, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("xl/workbook.xml", "<workbook/>")
        async with self.client() as http:
            for filename, raw, kind, method in (("자료.pdf", b"%PDF-1.7\n\x00\xffopaque", "pages", "pdf_text"),
                    ("자료.xlsx", workbook.getvalue(), "cells", "xlsx_values")):
                source = self.value(await http.post(self.base + "/sources", data={"request_id": uuid4().hex, "title": filename},
                    files={"file": (filename, raw, "application/octet-stream")}), 201)
                downloaded = await http.get(self.base + f"/sources/{source['source_id']}/versions/{source['source_version']}/file")
                self.assertEqual(downloaded.content, raw)
                self.assertEqual(downloaded.headers["x-source-sha256"], sha256(raw).hexdigest())
                self.value(await http.post(self.base + "/analysis-jobs", json={"request_id": uuid4().hex,
                    **{key: source[key] for key in ("source_id", "source_version", "source_sha256")},
                    "expected_registration_revision": source["registration_revision"], "targets": ["binary.md"], "outputs": ["wiki"]}), 422)
                location = self.location(kind, **({"start": 2, "end": 2} if kind == "pages" else {"sheet": "업무", "cells": "A1:B2"}))
                report = self.value(await http.post(self.base + "/analysis-conversions", json={"request_id": uuid4().hex,
                    "source_ref": self.source_ref(source), "method": method, "units": [{"unit_id": "selected", "location": location,
                    "content": "선택 범위의 실제 문자\r\n"}], "complete": True}), 201)
                self.assertEqual(report["manifest"]["origin"], "client_reported")
                self.assertEqual(report["manifest"]["semantic_validation"], "not_run")
                self.assertEqual(report["components"]["selected"], "선택 범위의 실제 문자\r\n")
                read = self.value(await http.get(self.base + "/analysis-conversions/" + report["manifest"]["id"]))
                self.assertEqual(read["revision"], report["revision"])
                listed = self.value(await http.get(self.base + "/documents"))
                self.assertTrue(any(item.get("format") == filename.split(".")[-1] for item in listed["items"]))
            self.value(await http.post(self.base + "/sources", json={"request_id": uuid4().hex,
                "title": "잘못된 직접 입력", "format": "pdf", "content": "binary"}), 422)

    async def test_selected_lines_multi_output_handoff_reaches_actual_frozen_input(self):
        """문서별 선택 문자·목적이 실제 기존 job과 고정 입력에 들어가는지 확인한다."""
        self.stores["alpha"].save("정의.md", "필수 정의와 예외\n", expected_revision=None)
        async with self.client() as http:
            source = await self.text_source(http)
            location = self.location("lines", start=2, end=2)
            body = {"request_id": uuid4().hex, "source_ref": self.source_ref(source), "locations": [location],
                "outputs": [self.output(locations=[location]), self.output(document="다른문서.md", title="두 번째 결과", locations=[location])],
                "context_documents": [{"document": "정의.md", "required": True, "reason": "정의/예외"}]}
            plan = self.value(await http.post(self.base + "/analysis-plans", json=body), 201)
            self.assertEqual(plan["components"]["output-0.txt"], "둘째 줄\n")
            self.assertTrue(plan["manifest"]["ready"])
            plan_id, revision, request_id = plan["manifest"]["id"], plan["revision"], uuid4().hex
            handoff = self.value(await http.post(self.base + f"/analysis-plans/{plan_id}/handoffs", json={
                "expected_plan_revision": revision, "request_id": request_id}))
            self.assertEqual(len(handoff["jobs"]), 2)
            self.assertFalse(handoff["execution_started"])
            jobs = JobStore(self.stores["alpha"], rulesets=self.rulesets)
            for job in handoff["jobs"]:
                claimed = jobs.claim(job["job_id"], tenant="alpha", user_id="alice", expected_job_revision=job["job_revision"],
                    authorize=self.authorize)
                inputs = InputStore(self.stores["alpha"], self.rulesets, jobs=jobs)
                prepared = inputs.prepare(job["job_id"], tenant="alpha", user_id="alice", run_id=claimed["run_id"],
                    expected_job_revision=claimed["job_revision"], stage="read_source", authorize=self.authorize)
                manifest, _, components = files.load(self.stores["alpha"], jobs.jobs_dir / job["job_id"] / "inputs" / prepared["bundle_id"])
                fixed_plan = json.loads(components["data/analysis-plan.json"])
                self.assertEqual(fixed_plan["plan_id"], plan_id)
                self.assertEqual(fixed_plan["output"]["purpose"], "선택 범위의 조건 정리")
                self.assertEqual(manifest["selection"][0]["document"], "정의.md")
            receipt = self.value(await http.get(self.base + f"/analysis-plans/{plan_id}/handoffs/{request_id}"))
            self.assertEqual([item["job_id"] for item in receipt["jobs"]], [item["job_id"] for item in handoff["jobs"]])

    async def test_wiki_source_and_changed_basis_or_range_and_owner_are_blocked(self):
        """원본 등록 없는 Wiki 참조를 허용하고 오래된 기준·범위·다른 tenant는 막는다."""
        self.stores["alpha"].save("기존.md", "기존 위키 원문\n", expected_revision=None)
        from core.modules.reviews.store import ReviewStore
        snapshot = ReviewStore(self.stores["alpha"]).query("기존.md")
        wiki = {"document": "기존.md", **{key: snapshot[key] for key in ("source_revision", "graph_revision", "state_revision")}}
        async with self.client() as http:
            body = {"request_id": uuid4().hex, "wiki_ref": wiki,
                "outputs": [self.output(document="기존.md", outputs=["ontology"])]}
            plan = self.value(await http.post(self.base + "/analysis-plans", json=body), 201)
            plan_id = plan["manifest"]["id"]
            self.value(await http.get(self.base + f"/analysis-plans/{plan_id}", headers=self.headers("bob")), 403)
            bad = deepcopy(body); bad["request_id"] = uuid4().hex
            bad["locations"] = [self.location("lines", start=2, end=1)]
            self.value(await http.post(self.base + "/analysis-plans", json=bad), 422)
            self.stores["alpha"].save("기존.md", "수정된 위키\n", expected_revision=snapshot["source_revision"])
            self.value(await http.post(self.base + f"/analysis-plans/{plan_id}/validate", json={"expected_plan_revision": plan["revision"]}), 409)
            stored = self.value(await http.get(self.base + f"/analysis-plans/{plan_id}"))
            self.assertEqual(stored["components"]["output-0.txt"], "기존 위키 원문\n")

    async def test_conversion_required_incomplete_and_permission_revocation_preserve_records(self):
        """변환이 아직 없거나 미독 범위가 남았으면 실행 인계를 허용하지 않는다."""
        async with self.client() as http:
            source = self.value(await http.post(self.base + "/sources", data={"request_id": uuid4().hex, "title": "읽기 전 원본"},
                files={"file": ("원본.pdf", b"%PDF-1.7\nbinary", "application/pdf")}), 201)
            body = {"request_id": uuid4().hex, "source_ref": self.source_ref(source), "outputs": [self.output()]}
            plan = self.value(await http.post(self.base + "/analysis-plans", json=body), 201)
            self.assertFalse(plan["manifest"]["ready"])
            self.value(await http.post(self.base + f"/analysis-plans/{plan['manifest']['id']}/handoffs", json={
                "expected_plan_revision": plan["revision"], "request_id": uuid4().hex}), 409)
            self.value(await http.post(self.base + "/analysis-conversions", json={"request_id": uuid4().hex,
                "source_ref": self.source_ref(source), "method": "ocr", "units": [{"unit_id": "p1", "location": self.location("pages", start=1, end=1),
                "content": "읽은 부분"}], "complete": True, "unread_ranges": ["2페이지"]}), 422)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            self.value(await http.post(self.base + "/analysis-plans", json={**body, "request_id": uuid4().hex}), 403)
            preserved = self.value(await http.get(self.base + f"/analysis-plans/{plan['manifest']['id']}"))
            self.assertEqual(preserved["revision"], plan["revision"])

    async def test_binary_conversion_reaches_frozen_question_basis_and_mismatch_is_visible(self):
        """바이너리의 보고 본문은 질문에 보존하고 누락/다른 원본/미독 보고는 제외한다."""
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"].append("conversation_write")
        self.save_policy()
        async with self.client() as http:
            source = self.value(await http.post(self.base + "/sources", data={"request_id": uuid4().hex, "title": "질문 원본"},
                files={"file": ("질문.pdf", b"%PDF-1.7\n\x00\xffbinary", "application/pdf")}), 201)
            reference = {key: source[key] for key in ("source_id", "source_version", "source_sha256")}
            url = self.base + "/question-context/prepare"
            missing = self.value(await http.post(url, json={"source_refs": [reference]}))
            self.assertFalse(missing["can_prepare"])
            self.assertEqual(missing["skipped"][0]["code"], "client_conversion_required")
            body = {"request_id": uuid4().hex, "source_ref": self.source_ref(source), "method": "ocr", "complete": True,
                "units": [{"unit_id": "page1", "location": self.location("pages", start=1, end=1), "content": "첫 페이지의 조건"},
                    {"unit_id": "page2", "location": self.location("pages", start=2, end=2), "content": "두 번째 페이지의 예외\r\n"}]}
            converted = self.value(await http.post(self.base + "/analysis-conversions", json=body), 201)
            conversion_ref = {"conversion_id": converted["manifest"]["id"], "conversion_revision": converted["revision"]}
            context_request = {"source_refs": [{**reference, "conversion_ref": conversion_ref}]}
            prepared = self.value(await http.post(url, json=context_request))
            self.assertTrue(prepared["can_prepare"])
            original = prepared["originals"][0]
            self.assertEqual(original["content"], "첫 페이지의 조건\n\n두 번째 페이지의 예외\r\n")
            self.assertEqual(original["conversion"]["manifest"], converted["manifest"])
            self.assertEqual(original["conversion"]["components"], converted["components"])
            self.assertEqual(original["conversion"]["manifest"]["coverage"], "reported_units_only")
            self.assertEqual(original["conversion"]["manifest"]["original_coverage"], "not_verified")
            self.assertEqual(original["conversion"]["manifest"]["components"]["page2"]["sha256"],
                sha256("두 번째 페이지의 예외\r\n".encode()).hexdigest())
            # 실제 개인 질문 원장에 같은 basis가 남아 이후 실행·인용이 이를 재사용한다.
            conversation = self.value(await http.post(self.base + "/conversations", json={"request_id": uuid4().hex, "title": "PDF 질문"}), 201)
            asked = self.value(await http.post(self.base + f"/conversations/{conversation['record']['id']}/turns", json={
                "request_id": uuid4().hex, "expected_revision": conversation["revision"], "role": "user",
                "content": "조건과 예외는?", "context_request": context_request}))
            self.assertEqual(asked["record"]["events"][0]["basis"]["originals"], prepared["originals"])
            # 질문 실행·답변 저장에서도 OCR 보고를 원시 파일의 직접 인용과 구별한다.
            run = self.value(await http.post(self.base + "/question-runs", json={"request_id": uuid4().hex,
                "conversation_id": asked["record"]["id"], "question_turn_id": asked["record"]["events"][0]["id"],
                "expected_conversation_revision": asked["revision"]}), 201)
            run_url = self.base + "/question-runs/" + run["record"]["id"]
            claimed = self.value(await http.post(run_url + "/claim", json={"request_id": uuid4().hex,
                "expected_state_revision": run["state_revision"]}))
            handoff = self.value(await http.get(run_url + "/input", params={"run_id": claimed["runtime"]["run_id"]}))
            answer = "첫 페이지의 조건"
            self.value(await http.post(run_url + "/answers", json={"request_id": uuid4().hex,
                "run_id": claimed["runtime"]["run_id"], "expected_state_revision": claimed["state_revision"],
                "expected_conversation_revision": asked["revision"], "content": answer,
                "citations": [{"kind": "source", **reference, "quote": answer}],
                "execution": {"provider": "fixture", "cli_version": "fixture", "input_sha256": handoff["input_sha256"],
                    "prompt_sha256": "a" * 64, "output_sha256": sha256(answer.encode()).hexdigest()}}))
            replied = self.value(await http.get(self.base + "/conversations/" + asked["record"]["id"]))
            citation = replied["record"]["events"][-1]["citations"][0]
            self.assertEqual(citation["layer"], "reported_conversion")
            self.assertEqual(citation["conversion_ref"], conversion_ref)
            self.assertEqual(citation["original_coverage"], "not_verified")
            wrong_revision = deepcopy(context_request)
            wrong_revision["source_refs"][0]["conversion_ref"]["conversion_revision"] = "0" * 64
            changed = self.value(await http.post(url, json=wrong_revision))
            self.assertFalse(changed["can_prepare"])
            self.assertEqual(changed["skipped"][0]["code"], "bundle_revision_conflict")
            incomplete = self.value(await http.post(self.base + "/analysis-conversions", json={**body,
                "request_id": uuid4().hex, "complete": False, "unread_ranges": ["이미지 표 미독"]}), 201)
            incomplete_context = {"source_refs": [{**reference, "conversion_ref": {
                "conversion_id": incomplete["manifest"]["id"], "conversion_revision": incomplete["revision"]}}]}
            blocked = self.value(await http.post(url, json=incomplete_context))
            self.assertFalse(blocked["can_prepare"])
            self.assertEqual(blocked["skipped"][0]["code"], "conversion_incomplete")
            text = await self.text_source(http)
            text_reference = {key: text[key] for key in ("source_id", "source_version", "source_sha256")}
            mismatched = self.value(await http.post(url, json={"source_refs": [{**text_reference, "conversion_ref": conversion_ref}]}))
            self.assertFalse(mismatched["can_prepare"])
            self.assertEqual(mismatched["skipped"][0]["code"], "conversion_source_changed")
            plain = self.value(await http.post(url, json={"source_refs": [text_reference]}))
            self.assertTrue(plain["can_prepare"])
            self.assertEqual(set(plain["originals"][0]), {"source_ref", "manifest", "content"})
            self.assertEqual(plain["originals"][0]["source_ref"], text_reference)
            # 저장 요청의 idempotency hash도 새 선택 항목을 생략하면 옛 구조를 유지한다.
            dumped = QuestionContextRequest.model_validate({"source_refs": [text_reference]}).model_dump()
            self.assertEqual(dumped["source_refs"], [text_reference])
