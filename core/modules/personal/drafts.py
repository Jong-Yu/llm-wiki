"""답변 당시 근거와 원래 서술을 보존하는 결과물 편집·위키 반영 서비스다.

초안 편집은 개인 기록에만 이벤트를 추가한다. apply에서만 WikiStore.save를
호출하며 저장 직전 권한·대상 본문·근거 관측 기준을 다시 확인한다.
"""

from core.common.json_codec import canonical_json_hash, canonical_json_bytes
from core.common.cleanup import cleanup_details
from core.modules.documents.store import RevisionConflictError, StorageBusyError
from core.modules.access.policy import AccessDenied, PolicyError
from core.modules.sources import files
from core.modules.personal.store import PersonalStore, PersonalConflictError
from . import workflow_io


def current_content(record):
    """원본 생성문은 data에 두고 마지막 편집 이벤트의 제목·본문만 현재 초안으로 읽는다."""
    edited = next((item for item in reversed(record["events"]) if item["operation"] == "edit"), None)
    return {key: (edited[key] if edited else record["data"][key]) for key in ("title", "content")}


class DraftStore:
    """현재 인증 사용자의 초안과 반영 요청만 관리한다."""

    def __init__(self, scope):
        self.scope, self.personal = scope, PersonalStore(scope)
        self.actor = {key: getattr(scope, key) for key in ("user_id", "tenant", "profile_id", "domain", "viewpoint", "policy_revision")}

    def create(self, request_id, saved_result_id, *, before_commit):
        """기존 저장 결과에서 당시 전체 근거와 원래 생성문을 그대로 고정한다."""
        payload = {"saved_result_id": saved_result_id}
        try:
            return self.personal.receipt("result-drafts", request_id, payload=payload)
        except FileNotFoundError:
            pass
        source = self.personal.read("saved-results", saved_result_id)
        data = source["record"]["data"]
        draft = {"source_result_id": saved_result_id, "source_result_revision": source["revision"],
            "title": data["title"], "content": data["content"], "original_generated_content": data["content"],
            "original_generated_title": data["title"], "basis": data["basis"], "origin": "client_reported",
            "human_approval": False, "answer_provenance": data.get("answer_provenance")}
        return self.personal.create("result-drafts", request_id, payload, draft, self.actor, before_commit=before_commit)

    def read(self, draft_id):
        """편집값·원래 생성문·고정 근거·현재 변경 여부를 구분해 반환한다."""
        result = self.personal.read("result-drafts", draft_id)
        rendered = self._render(result["record"])
        return {**result, "draft": current_content(result["record"]), "rendered_content": rendered,
            "rendered_size_bytes": len(rendered.encode("utf-8")), "can_apply_size": len(rendered.encode("utf-8")) <= 1024 * 1024,
            "basis_observation": workflow_io.observe_basis(self.scope.store, result["record"]["data"]["basis"], self.actor)}

    def edit(self, draft_id, *, request_id, expected_revision, title, content, before_commit):
        """초안 수정도 CAS와 새 이벤트로 남기며 이전 편집을 덮어쓰지 않는다."""
        payload = {"title": title, "content": content, "expected_revision": expected_revision}
        return self.personal.append("result-drafts", draft_id, request_id, expected_revision, payload,
            {"operation": "edit", "title": title, "content": content}, self.actor, before_commit=before_commit)

    def _render(self, record):
        """현재 본문 뒤에 당시 문서/주장/판본·고정 근거 지문을 함께 반영한다."""
        current = current_content(record)
        basis = record["data"]["basis"]
        appendix = {"draft_id": record["id"], "source_result_id": record["data"]["source_result_id"],
            "basis_snapshot_revision": basis["snapshot_revision"], "basis_sha256": canonical_json_hash(basis),
            "documents": [{"document": value["document"], **{key: value["knowledge"][key]
                for key in ("source_revision", "graph_revision", "state_revision", "history_revision")}}
                for value in basis["documents"]],
            "selected_claims": basis.get("selected_claims", []),
            "originals": [value["source_ref"] for value in basis.get("originals", [])],
            "profile": basis.get("scope", {}).get("profile"), "origin": "client_reported", "human_approval": False}
        # 선택 claim이 없어도 전체 원문/정책 이유/실제 인용·실행 계보가 빠지지 않아야 한다.
        # 최종 전체 크기가 1MiB를 넘으면 can_apply_size/Store 제한으로 거부하고 자르지 않는다.
        appendix.update(frozen_basis=basis, answer_provenance=record["data"].get("answer_provenance"),
                        original_generated_content=record["data"]["original_generated_content"])
        return "# " + current["title"] + "\n\n" + current["content"] + "\n\n## 작성 당시 근거\n\n```json\n" + canonical_json_bytes(appendix).decode("utf-8") + "```\n"

    def apply_receipt(self, draft_id, request_id):
        """쓰기 권한/최신 근거와 무관하게 자기 반영의 정확한 저장 증거를 조회한다."""
        with self.personal._coordination():
            self.personal._read("result-drafts", draft_id)
            return workflow_io.receipt(self.personal, "draft-applications", draft_id, request_id)

    def apply(self, draft_id, *, request_id, expected_revision, document, expected_document_revision,
              expected_basis_observation, acknowledge_changed_basis, authorize):
        """한 번의 명시 반영을 기록한다. 결과 미확인은 파일 hash로 성공 추정하지 않는다."""
        payload = {"draft_id": draft_id, "expected_revision": expected_revision, "document": document,
            "expected_document_revision": expected_document_revision, "expected_basis_observation": expected_basis_observation,
            "acknowledge_changed_basis": acknowledge_changed_basis}
        with self.personal._coordination(create=True):
            record = self.personal._read("result-drafts", draft_id)
            authorize()
            try:
                return workflow_io.receipt(self.personal, "draft-applications", draft_id, request_id, payload=payload)
            except FileNotFoundError:
                pass
            if canonical_json_hash(record) != expected_revision:
                raise PersonalConflictError()
            observation = workflow_io.observe_basis(self.scope.store, record["data"]["basis"], self.actor, coordination_locked=True)
            self._check_observation(observation, expected_basis_observation, acknowledge_changed_basis)
            content = self._render(record)
            # WikiStore는 UTF-8 1MiB 제한과 기존 전체 이력/CAS를 다시 검사한다.
            path, intent = workflow_io.start_request(self.personal, "draft-applications", draft_id, request_id,
                payload, {"document": document, "draft_revision": expected_revision})
            def guard():
                authorize()
                latest = workflow_io.observe_basis(self.scope.store, record["data"]["basis"], self.actor, wiki_locked=True, coordination_locked=True)
                self._check_observation(latest, expected_basis_observation, acknowledge_changed_basis)
            try:
                result = self.scope.store.save(document, content, expected_revision=expected_document_revision, before_commit=guard)
            except (RevisionConflictError, PersonalConflictError, AccessDenied, PolicyError, StorageBusyError, ValueError) as error:
                files.write_json(self.scope.store, path / "intent.json", {**intent, "state": "rejected", "saved": False})
                raise error
            except OSError:
                # 파일 교체 후 장애인지 구별하지 못하면 pending을 남기고 쓰기를 반복하지 않는다.
                return intent
            receipt = {"document": document, "source_revision": result.revision,
                "history_id": result.history_path.name if result.history_path else None, "changed": result.changed,
                "draft_id": draft_id, "draft_revision": expected_revision,
                "source_result_id": record["data"]["source_result_id"],
                "basis_snapshot_revision": record["data"]["basis"]["snapshot_revision"],
                "basis_observation": observation, "actor": self.actor}
            return workflow_io.saved_result(self.personal, path, intent, receipt,
                cleanup_failures=cleanup_details(self.scope.store.data_dir, result.cleanup_failures))

    @staticmethod
    def _check_observation(observation, expected, acknowledge):
        """현재 판본에 대한 명시 확인만 허용하고 재변경 뒤 오래된 확인을 재사용하지 않는다."""
        if observation["observation_revision"] != expected or observation["status"] == "unavailable":
            raise PersonalConflictError()
        if observation["status"] == "changed" and not acknowledge:
            raise PersonalConflictError()
