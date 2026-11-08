"""분석 계획과 개인 PC의 변환 보고를 불변 입력 묶음으로 보관한다.

계획은 원본을 덮어쓰지 않는다. 실행 인계 시 선택한 문자만 별도 UTF-8 원본으로
명시 등록하고 기존 JobStore를 재사용한다. 원래 PDF/Excel의 hash와 위치·변환
방법은 계획에 계속 남으며, 변환 정확도는 client_reported로 구분한다.
"""

from hashlib import sha256
from io import BytesIO
from core.common.json_codec import canonical_json_hash
from core.modules.analysis_inputs import files as inputs_files, capture
from core.modules.analysis_inputs.contracts import InputConflictError, InputLimitError, InputCorruptError
from core.modules.analysis_jobs.store import JobStore
from core.modules.reviews.store import ReviewStore
from core.modules.sources.store import SourceStore
from core.modules.sources import files
from core.modules.sources.contracts import IMAGE_FORMATS, identifier

MAX_TEXT_BYTES = 4 * 1024 * 1024
MAX_RECORDS = 1000


def stable_id(*values):
    """같은 명시 요청을 다시 확인해도 새 자원을 만들지 않도록 ID를 고정한다."""
    return sha256(":".join(values).encode()).hexdigest()[:32]


class PlanStore:
    """인증된 사용자의 원본·계획·변환 보고만 읽고 기록한다."""

    def __init__(self, store, actor, *, rulesets=None):
        self.store, self.actor, self.rulesets = store, actor, rulesets
        self.sources = SourceStore(store)
        owner = canonical_json_hash({"tenant": actor["tenant"], "user_id": actor["user_id"]})
        self.root = store.data_dir / "_analysis_plans" / owner

    def _path(self, kind, value):
        """사용자 입력 경로 대신 허용한 종류와 검증된 ID로만 위치를 계산한다."""
        identifier(value)
        if kind not in {"plans", "conversions"}:
            raise ValueError("Invalid analysis planning resource")
        return self.root / kind / value

    def _load_locked(self, kind, value, revision=None):
        """불변 파일과 구성별 크기/hash를 공통 입력 모듈에서 재검사한다."""
        manifest, text, components = inputs_files.load(self.store, self._path(kind, value),
            expected_revision=revision, maximum=8 * 1024 * 1024)
        if (manifest.get("tenant") != self.actor["tenant"] or manifest.get("user_id") != self.actor["user_id"]
                or manifest.get("id") != value or manifest.get("kind") != kind):
            raise InputCorruptError("The analysis planning record has a different owner")
        return manifest, inputs_files.digest(text.encode()), components

    def read(self, kind, value, revision=None):
        """조회는 복구나 재변환을 실행하지 않고 당시 묶음 전체를 반환한다."""
        with self.sources._coordination_lock():
            manifest, actual, components = self._load_locked(kind, value, revision)
            return {"manifest": manifest, "revision": actual, "components": components}

    def _publish_locked(self, kind, request_id, payload, manifest, components, authorize):
        """같은 요청은 입력 지문으로 확인하고, 처음 공개하는 완성 묶음만 추가한다."""
        value = stable_id(kind, self.actor["tenant"], self.actor["user_id"], request_id)
        path = self._path(kind, value)
        digest = canonical_json_hash(payload)
        try:
            old, revision, stored = self._load_locked(kind, value)
        except FileNotFoundError:
            old = None
        if old is not None:
            if old["payload_hash"] != digest:
                raise InputConflictError("request_conflict")
            return {"manifest": old, "revision": revision, "components": stored, "replayed": True}
        if len(files.entries(self.store, path.parent, maximum=MAX_RECORDS + 1)) >= MAX_RECORDS:
            raise InputLimitError("Analysis planning record count exceeded")
        value_manifest = {**manifest, "schema_version": 1, "kind": kind, "id": value,
            "tenant": self.actor["tenant"], "user_id": self.actor["user_id"], "actor": self.actor,
            "request_id": request_id, "payload_hash": digest, "components": inputs_files.descriptors(components)}
        authorize()
        revision = inputs_files.publish(self.store, path, value_manifest, components, maximum=8 * 1024 * 1024)
        return {"manifest": value_manifest, "revision": revision, "components": components, "replayed": False}

    def _original_locked(self, reference):
        """현재 원본 카탈로그와 요청한 불변 판본/hash를 함께 대조한다."""
        catalog = self.sources._get_source_locked(reference["source_id"])
        current = catalog["versions"][-1]
        if (catalog["current_version"] != reference["source_version"]
                or catalog["registration_revision"] != reference["registration_revision"]
                or current["source_sha256"] != reference["source_sha256"]):
            raise InputConflictError("source_basis_changed")
        from core.modules.analysis_jobs.registration import original_path
        stream = files.verify_original(self.store, original_path(self.sources, reference["source_id"], reference["source_version"]), current)
        return catalog, current, stream

    def conversion(self, body, authorize):
        """변환 문자를 원본 판본·위치와 연결한다. OCR 의미 정확도를 승인하지 않는다."""
        value = body.model_dump(exclude={"profile"})
        units = value["units"]
        if len({unit["unit_id"] for unit in units}) != len(units):
            raise ValueError("Conversion unit IDs must be distinct")
        if len({canonical_json_hash(unit["location"]) for unit in units}) != len(units):
            raise ValueError("Conversion locations must be distinct")
        if any(len(text) > 1000 for text in [*value["unread_ranges"], *value["warnings"]]):
            raise ValueError("Bounded warnings and unread ranges are required")
        if value["complete"] and value["unread_ranges"]:
            raise ValueError("Unread ranges must not be marked complete")
        components = {unit["unit_id"]: unit["content"] for unit in units}
        if sum(len(text.encode()) for text in components.values()) > MAX_TEXT_BYTES:
            raise InputLimitError("Converted text exceeds the complete byte limit")
        with self.sources._coordination_lock(create=True):
            _, original, stream = self._original_locked(value["source_ref"])
            stream.close()
            expected = {"pdf": {"pdf_text", "ocr"}, "xlsx": {"xlsx_values", "ocr"}, "md": {"verbatim"}, "txt": {"verbatim"},
                "docx": {"docx_text"}, **{format: {"ocr"} for format in IMAGE_FORMATS}}
            if value["method"] not in expected[original["format"]]:
                raise ValueError("The conversion method does not match the original format")
            locations = {"pdf": {"pages", "whole"}, "xlsx": {"cells", "whole"}, "md": {"lines", "whole"}, "txt": {"lines", "whole"},
                "docx": {"blocks", "paragraphs", "table_cells", "whole"}, **{format: {"pages", "whole"} for format in IMAGE_FORMATS}}
            if any(unit["location"]["kind"] not in locations[original["format"]] for unit in units):
                raise ValueError("The reported location does not match the original format")
            manifest = {"source_ref": value["source_ref"], "method": value["method"], "origin": "client_reported",
                "complete": value["complete"], "unread_ranges": value["unread_ranges"], "warnings": value["warnings"],
                "coverage": "reported_units_only", "original_coverage": "not_verified",
                "semantic_validation": "not_run", "units": [{k: v for k, v in unit.items() if k != "content"} for unit in units]}
            return self._publish_locked("conversions", value["request_id"], value, manifest, components, authorize)

    def _capture_locked(self, body, *, validate_context=None):
        """현재 원문과 필수 맥락의 실제 판본을 고정하고 원본 전체를 임의로 자르지 않는다."""
        source = body.get("source_ref")
        wiki = body.get("wiki_ref")
        conversion = body.get("conversion_ref")
        selected = capture.selection(self.store, body["context_documents"])
        if wiki:
            self.store._document_path(self.store.wiki_dir, wiki["document"])
            snapshot = ReviewStore(self.store).query(wiki["document"], domain=self.actor["domain"], viewpoint=self.actor["viewpoint"])
            if any(snapshot[key] != wiki[key] for key in ("source_revision", "graph_revision", "state_revision")):
                raise InputConflictError("wiki_basis_changed")
            content = self.store.read(wiki["document"]).content
            if inputs_files.digest(content.encode()) != wiki["source_revision"]:
                raise InputConflictError("wiki_basis_changed")
            origin = {"kind": "wiki", "reference": wiki}
            units = [{"unit_id": "whole", "location": {"kind": "whole", "start": None, "end": None, "sheet": None, "cells": None}, "content": content}]
        else:
            _, original, stream = self._original_locked(source)
            with stream:
                raw = stream.read(MAX_TEXT_BYTES + 1) if original["format"] in {"md", "txt"} else None
            origin = {"kind": "original", "reference": source, "format": original["format"]}
            if conversion:
                manifest, _, components = self._load_locked("conversions", conversion["conversion_id"], conversion["conversion_revision"])
                if manifest["source_ref"] != source:
                    raise InputConflictError("conversion_source_changed")
                if not manifest["complete"]:
                    raise InputConflictError("conversion_incomplete")
                units = [{**unit, "content": components[unit["unit_id"]]} for unit in manifest["units"]]
            elif raw is not None:
                if len(raw) > MAX_TEXT_BYTES:
                    raise InputLimitError("The source text exceeds the analysis byte limit")
                units = [{"unit_id": "whole", "location": {"kind": "whole", "start": None, "end": None, "sheet": None, "cells": None}, "content": raw.decode("utf-8")}]
            else:
                units = []
        if units and sum(len(unit["content"].encode()) for unit in units) > MAX_TEXT_BYTES:
            raise InputLimitError("The complete selected text exceeds its byte limit")
        with self.store._write_lock():
            contexts, dependencies, skipped = capture.documents_locked(self.store, selected, self.actor)
            # 실행 중 검사는 현재 맥락과 출력 대상이 같은 시점인지 확인한다.
            # 이 콜백은 이미 잡은 위키 잠금을 재사용하므로 다시 잠그면 안 된다.
            if validate_context is not None:
                validate_context(dependencies)
        if skipped:
            raise InputConflictError("context_unavailable")
        return origin, units, contexts, dependencies

    def _select(self, units, locations):
        """명시 위치를 보유한 변환 단위와 맞춘다. 줄 범위는 실제 문자에서 정확히 고른다."""
        if not units:
            return ""
        if not locations:
            return "\n\n".join(unit["content"] for unit in units)
        selected = []
        for location in locations:
            matches = [unit for unit in units if unit["location"] == location]
            if matches:
                selected.extend(unit["content"] for unit in matches)
            elif location["kind"] == "lines" and len(units) == 1 and units[0]["location"]["kind"] == "whole":
                lines = units[0]["content"].splitlines(keepends=True)
                if location["end"] > len(lines):
                    raise ValueError("The selected lines exceed the actual text")
                selected.append("".join(lines[location["start"] - 1:location["end"]]))
            elif location["kind"] == "pages":
                # 페이지별 보고가 있으면 2~4페이지처럼 연속 범위도 실제 보고 단위로만 조합한다.
                pages = {unit["location"]["start"]: unit["content"] for unit in units
                    if unit["location"]["kind"] == "pages" and unit["location"]["start"] == unit["location"]["end"]
                    and location["start"] <= unit["location"]["start"] <= location["end"]}
                if len(pages) != location["end"] - location["start"] + 1:
                    raise ValueError("Every selected page must have its own reported text")
                selected.extend(pages[number] for number in sorted(pages))
            else:
                raise ValueError("Select exact reported conversion locations")
        return "\n\n".join(selected)

    def create(self, body, authorize):
        """출처·범위·문서별 목적과 맥락을 불변 계획으로 만든다."""
        value = body.model_dump(exclude={"profile"})
        outputs = value["outputs"]
        for locations in [value["locations"], *[output["locations"] for output in outputs]]:
            if len({canonical_json_hash(location) for location in locations}) != len(locations):
                raise ValueError("Do not repeat selected source locations")
        if len({item["document"] for item in outputs}) != len(outputs):
            raise ValueError("Select distinct output documents")
        for output in outputs:
            self.store._document_path(self.store.wiki_dir, output["document"])
            if len(set(output["outputs"])) != len(output["outputs"]):
                raise ValueError("Do not repeat output types")
            if value["wiki_ref"] and output["document"] == value["wiki_ref"]["document"] and "wiki" in output["outputs"]:
                raise ValueError("Re-extract the same Wiki as ontology-only or choose a different output document")
            if value["wiki_ref"] and output["document"] == value["wiki_ref"]["document"] and any(
                    location["kind"] != "whole" for location in [*value["locations"], *output["locations"]]):
                # 일부 줄만 뽑은 그래프로 기존 전체 그래프를 교체하지 않는다.
                # 부분 자료는 별도 문서를 만들고 같은 Wiki는 전체 범위로 재추출한다.
                raise ValueError("Same-Wiki ontology replacement requires whole-source coverage")
            if value["locations"] and any(location not in value["locations"] for location in output["locations"]):
                raise ValueError("An output range must be within the declared analysis ranges")
        with self.sources._coordination_lock(create=True):
            origin, units, contexts, dependencies = self._capture_locked(value)
            # 원본 문자/변환 단위가 없으면 계획은 보존하되 실행 준비 완료로 표시하지 않는다.
            ready = bool(units)
            components = {"contexts.json": capture.encoded(contexts)}
            for index, output in enumerate(outputs):
                components[f"output-{index}.txt"] = self._select(units, output["locations"] or value["locations"])
            manifest = {"plan": value, "origin": origin, "context_dependencies": dependencies,
                "ready": ready, "blockers": [] if ready else ["client_conversion_required"],
                "conversion_accuracy": "client_reported_not_verified" if value["conversion_ref"] else "literal_text",
                "text_components": {output["document"]: f"output-{index}.txt" for index, output in enumerate(outputs)},
                "execution_started": False}
            return self._publish_locked("plans", value["request_id"], value, manifest, components, authorize)

    def validate_locked(self, plan_id, revision, *, input_store=None, job=None):
        """원래 판본·관점·필수 맥락이 바뀌면 기존 계획을 재라벨하지 않고 충돌로 돌린다."""
        manifest, actual, components = self._load_locked("plans", plan_id, revision)
        if (capture.profile(manifest["actor"]) != capture.profile(self.actor)
                or manifest["actor"].get("access_revision", manifest["actor"]["policy_revision"]) != self.actor.get("access_revision", self.actor["policy_revision"])):
            raise InputConflictError("plan_profile_changed")
        validate_context = None
        if input_store is not None and job is not None:
            from core.modules.analysis_inputs import basis
            fixed = basis.active(job)
            if fixed is not None:
                # 계획은 고치지 않는다. 최초 작업 기준도 계획 당시의 선택/판본과
                # 같아야 하며, 이후 변화는 같은 job/run의 실제 저장 증거만 인정한다.
                if (fixed["context_documents"] != manifest["plan"]["context_documents"]
                        or fixed["context_dependencies"] != manifest["context_dependencies"]):
                    raise InputConflictError("plan_context_changed")
                def validate_context(dependencies):
                    basis.validate_captured(input_store, job, fixed, fixed["context_documents"],
                        dependencies, basis.targets_locked(input_store, job))
        _, _, _, dependencies = self._capture_locked(manifest["plan"], validate_context=validate_context)
        if validate_context is None and dependencies != manifest["context_dependencies"]:
            raise InputConflictError("plan_context_changed")
        if not manifest["ready"]:
            raise InputConflictError("client_conversion_required")
        return manifest, actual, components

    def validate(self, plan_id, revision):
        """현재 준비 가능 여부만 확인하고 실행이나 원본 생성을 하지 않는다."""
        with self.sources._coordination_lock():
            manifest, actual, _ = self.validate_locked(plan_id, revision)
            return {"plan_id": plan_id, "plan_revision": actual, "ready": manifest["ready"], "execution_started": False}

    def handoff(self, plan_id, revision, request_id, authorize):
        """문서별 선택 문자와 목적을 기존 단일 대상 job에 각각 인계한다.

        기존 개인 어댑터가 단일 대상을 처리하므로 여러 산출물은 안정된 요청 ID를
        가진 개별 job으로 만든다. 저장 영수증은 각 job별로 유지하며 AI는 시작하지 않는다.
        """
        identifier(request_id)
        with self.sources._coordination_lock():
            manifest, actual, components = self.validate_locked(plan_id, revision)
        jobs = JobStore(self.store, rulesets=self.rulesets)
        results = []
        for output in manifest["plan"]["outputs"]:
            text = components[manifest["text_components"][output["document"]]]
            staged = self.sources.stage(BytesIO(text.encode()), kind="text", title=output["title"], format="txt")
            source_request = stable_id("plan-source", plan_id, request_id, output["document"])
            source = self.sources.commit(staged, tenant=self.actor["tenant"], user_id=self.actor["user_id"],
                request_id=source_request, authorize=authorize)
            if source["state"] != "complete":
                results.append({"document": output["document"], "state": "pending_reconcile", "source_receipt": source})
                break
            job_request = stable_id("plan-job", plan_id, request_id, output["document"])
            result = jobs.create(tenant=self.actor["tenant"], user_id=self.actor["user_id"], request_id=job_request,
                source_id=source["source_id"], source_version=source["source_version"], source_sha256=source["source_sha256"],
                expected_registration_revision=source["registration_revision"], targets=[output["document"]],
                outputs=output["outputs"], authorize=authorize,
                plan_ref={"plan_id": plan_id, "plan_revision": actual, "document": output["document"]})
            results.append({"document": output["document"], **result})
        return {"handoff_id": request_id, "plan_id": plan_id, "plan_revision": actual, "jobs": results,
            "state": "complete" if len(results) == len(manifest["plan"]["outputs"]) and all(item["state"] == "complete" for item in results) else "pending_reconcile",
            "execution_started": False, "job_request_ids": [stable_id("plan-job", plan_id, request_id, output["document"]) for output in manifest["plan"]["outputs"]]}

    def handoff_receipt(self, plan_id, request_id):
        """응답 유실 뒤 현재 출처가 바뀌어도 같은 인계 요청의 접수 결과를 읽는다."""
        identifier(request_id)
        with self.sources._coordination_lock():
            manifest, revision, _ = self._load_locked("plans", plan_id)
        jobs, results = JobStore(self.store, rulesets=self.rulesets), []
        for output in manifest["plan"]["outputs"]:
            child_request = stable_id("plan-job", plan_id, request_id, output["document"])
            try:
                receipt = jobs.request_receipt(tenant=self.actor["tenant"], user_id=self.actor["user_id"], request_id=child_request)
                if receipt["job_id"] is not None:
                    job = jobs.query(receipt["job_id"], tenant=self.actor["tenant"], user_id=self.actor["user_id"])
                    expected = {"plan_id": plan_id, "plan_revision": revision, "document": output["document"]}
                    if job["events"][0]["details"].get("analysis_plan") != expected:
                        raise InputCorruptError("The stored handoff request points to a different plan")
                results.append({"document": output["document"], **receipt})
            except FileNotFoundError:
                results.append({"document": output["document"], "request_id": child_request, "state": "not_received"})
        return {"handoff_id": request_id, "plan_id": plan_id, "plan_revision": revision,
                "jobs": results, "execution_started": False, "read_only": True}


def linked_plan(store, job, actor, *, input_store=None):
    """작업 생성 이벤트에 실제 고정한 계획만 읽어 입력 묶음으로 연결한다."""
    reference = job["events"][0]["details"].get("analysis_plan")
    if reference is None:
        return None
    service = PlanStore(store, actor)
    manifest, revision, components = service.validate_locked(reference["plan_id"], reference["plan_revision"],
        input_store=input_store, job=job)
    output = next((item for item in manifest["plan"]["outputs"] if item["document"] == reference["document"]), None)
    if output is None or [output["document"]] != [item["document"] for item in job["targets"]]:
        raise InputCorruptError("The planned output and job target differ")
    selected_hash = inputs_files.digest(components[manifest["text_components"][output["document"]]].encode())
    if job["source_ref"]["source_sha256"] != selected_hash:
        raise InputCorruptError("The execution source differs from the fixed selected text")
    return {"plan_id": reference["plan_id"], "plan_revision": revision, "origin": manifest["origin"],
        "conversion_ref": manifest["plan"]["conversion_ref"], "output": output,
        "context_documents": manifest["plan"]["context_documents"], "context_dependencies": manifest["context_dependencies"],
        "source_locations": output["locations"] or manifest["plan"]["locations"],
        "conversion_accuracy": manifest["conversion_accuracy"], "source_text_sha256": selected_hash}
