"""기존 Python 저장 뒤 색인 준비·실패·경쟁·현재 권한을 격리 자료에서 검증한다."""

from copy import deepcopy
import json
import http.client
from pathlib import Path
import socket
import subprocess
import sys
import time
from unittest.mock import patch

from fastapi.testclient import TestClient

from core.common.access import access_basis, access_dict
from core.common.read_index import CanonicalIndexUnavailable
from core.modules.access.policy import AccessDenied, AccessPolicy, PolicyError
from core.modules.documents.store import RevisionConflictError
from core.modules.knowledge.concepts import ConceptStore
from core.modules.knowledge import ontology_exploration as exploration
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.runtime.application import create_application
from core.runtime.ontology_index import OntologyIndexPreparer
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.tests.poc_mcp.test_server_integration import ServerFixture


class OntologyIndexPreparationTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.tracked = AccessPolicy(self.config, self.root, tracked_reads=True)
        self.scope = self.tracked.authorize(self.token, self.tenant, "read")
        self.store = self.scope.store
        self.actor = access_dict(self.scope)
        self.service = ConceptStore(self.store, self.actor)
        self.worker = OntologyIndexPreparer(self.tracked, interval=0.02)
        self.addCleanup(self.worker.close)
        self.ontology = OntologyStore(self.store)
        for document in ("a.md", "b.md"):
            result = self.store.save(document, "A uses B.\n", expected_revision=None)
            self.ontology.generate(document, result.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))

    def canonical(self):
        return {str(path.relative_to(self.store.data_dir)): path.read_bytes()
                for path in self.store.data_dir.rglob("*")
                if path.is_file() and "_index" not in path.relative_to(self.store.data_dir).parts}

    def wait_prepared(self, previous):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.worker.status()["prepared"] > previous:
                return
            time.sleep(0.01)
        self.fail(f"index was not prepared: {self.worker.status()}")

    def test_startup_prepares_before_first_exact_screen_and_restart_reuses_sqlite(self):
        before = self.canonical()
        for attempt in range(2):
            app = create_application(self.tracked)
            with patch.object(exploration, "_project", wraps=exploration._project) as captured:
                with TestClient(app, base_url="http://127.0.0.1:8766") as client:
                    self.assertEqual(captured.call_count, 2 if attempt == 0 else 0)
                    self.assertTrue(app.state.ontology_index_preparer.status()["initial_finished"])
                    with patch.object(exploration, "_project", side_effect=AssertionError("first query must use the ready index")):
                        response = client.post(f"/api/v1/tenants/{self.tenant}/ontology/search",
                            headers=self.headers(), json={"text": "", "kind": "document", "cursor": None, "limit": 5})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(len(response.json()["data"]["items"]), 2)
            self.assertFalse(app.state.ontology_index_preparer.status()["running"])
        self.assertEqual(self.canonical(), before)

    def test_real_loopback_first_exact_screen_has_no_canonical_capture(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        log = self.base / "isolated-server.log"
        command = [sys.executable, "-B", "-m", "core.runtime.http_cli", "--access-config", str(self.config),
                   "--tenant-root", str(self.root), "--port", str(port), "--tracked-read-index", "--read-metrics"]
        with log.open("w") as output:
            process = subprocess.Popen(command, cwd=Path(__file__).resolve().parents[3],
                                       stdout=subprocess.DEVNULL, stderr=output)
            client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try:
                        client.request("GET", "/api/v1/access-context", headers=self.headers())
                        response = client.getresponse()
                        response.read()
                        if response.status == 200:
                            break
                    except (OSError, http.client.HTTPException):
                        client.close()
                    self.assertIsNone(process.poll(), "isolated server exited")
                    time.sleep(0.02)
                else:
                    self.fail("isolated server startup timeout")
                client.request("POST", f"/api/v1/tenants/{self.tenant}/ontology/search",
                    headers={**self.headers(), "Content-Type": "application/json"},
                    body=json.dumps({"text": "", "kind": "document", "cursor": None, "limit": 5}))
                response = client.getresponse()
                body = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(body["data"]["total"], 2)
            finally:
                client.close()
                process.terminate()
                process.wait(timeout=10)
        metrics = []
        for line in log.read_text().splitlines():
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if value.get("route", "").endswith("/ontology/search"):
                metrics.append(value)
        self.assertEqual(len(metrics), 1)
        self.assertEqual(metrics[0]["status"], 200)
        self.assertEqual(metrics[0]["counters"].get("canonical_reads", 0), 0)
        self.assertEqual(metrics[0]["stage_calls"].get("index_sync", 0), 0)
        marker = '{"event": "ontology_index_prepared"'
        prepared = [json.loads(line[line.index(marker):]) for line in log.read_text().splitlines()
                    if marker in line]
        self.assertTrue(prepared)
        self.assertGreaterEqual(prepared[0]["documents_updated"], 2)
        self.assertNotIn(self.token, log.read_text())

    def test_source_graph_review_and_whole_history_changes_prepare_only_that_document(self):
        self.worker.run_once()
        before = self.store.read("a.md")
        saved = self.store.save("a.md", before.content + "Changed.\n", expected_revision=before.revision)
        expected = self.canonical()
        with patch.object(exploration, "_project", wraps=exploration._project) as captured:
            self.worker.run_once()
        self.assertEqual([call.args[1] for call in captured.call_args_list], ["a.md"])
        self.assertEqual(expected, self.canonical())
        self.assertEqual(Path(saved.history_path).read_bytes(), before.content.encode())
        with self.assertRaises(RevisionConflictError):
            self.store.save("a.md", "stale overwrite", expected_revision=before.revision)
        self.assertEqual(self.store.read("a.md").revision, saved.revision)

        self.ontology.generate("a.md", saved.revision, deepcopy(ENTITIES), deepcopy(RELATIONS))
        with patch.object(exploration, "_project", wraps=exploration._project) as captured:
            self.worker.run_once()
        self.assertEqual([call.args[1] for call in captured.call_args_list], ["a.md"])
        reviews = ReviewStore(self.store)
        current = reviews.query("a.md")
        reviews.review("a.md", action="accept", claim_id=current["claims"][0]["claim_id"],
            expected_state_revision=current["state_revision"], reason="isolated preparation test", actor=self.actor)
        expected = self.canonical()
        with patch.object(exploration, "_project", wraps=exploration._project) as captured:
            self.worker.run_once()
        self.assertEqual([call.args[1] for call in captured.call_args_list], ["a.md"])
        with patch.object(exploration, "_project", side_effect=AssertionError("read should not rebuild")):
            self.service.explore_search(kind="document", limit=5)
        self.assertEqual(expected, self.canonical())

    def test_other_python_process_write_is_observed_without_a_query_or_model(self):
        self.worker.start()
        self.assertTrue(self.worker.wait_initial(5))
        prepared = self.worker.status()["prepared"]
        code = """import sys
from core.modules.documents.store import WikiStore
s=WikiStore(sys.argv[1]); before=s.read('a.md')
s.save('a.md', before.content+'Other Python writer.\\n', expected_revision=before.revision)
"""
        subprocess.run([sys.executable, "-B", "-c", code, str(self.store.data_dir)], check=True,
                       cwd=Path(__file__).resolve().parents[3], capture_output=True)
        self.wait_prepared(prepared)
        self.worker.close()
        with patch.object(exploration, "_project", side_effect=AssertionError("writer should already be indexed")):
            result = self.service.explore_search(kind="document", document="a.md")
        self.assertEqual(result["items"][0]["ref"]["status"], "stale")

    def test_busy_write_is_deferred_and_next_pass_reads_committed_bytes(self):
        self.worker.run_once()
        before = self.store.read("a.md")
        self.store.save("a.md", before.content + "New.\n", expected_revision=before.revision)
        with self.store._write_lock():
            self.worker.run_once()
        self.assertEqual(self.worker.status()["busy"], 1)
        self.worker.run_once()
        with patch.object(exploration, "_project", side_effect=AssertionError("deferred preparation incomplete")):
            self.service.explore_search(kind="document", limit=5)

    def test_change_just_after_preparation_is_not_marked_as_already_prepared(self):
        self.worker.run_once()
        original = self.store.read("a.md")
        self.store.save("a.md", original.content + "First.\n", expected_revision=original.revision)
        prepare = exploration.prepare_index
        def racing(owner, **options):
            stamp = prepare(owner, **options)
            current = self.store.read("b.md")
            self.store.save("b.md", current.content + "After preparation.\n", expected_revision=current.revision)
            return stamp
        with patch("core.runtime.ontology_index.prepare_index", side_effect=racing):
            self.worker.run_once()
        with patch.object(exploration, "_project", wraps=exploration._project) as captured:
            self.worker.run_once()
        self.assertEqual([call.args[1] for call in captured.call_args_list], ["b.md"])

    def test_scope_enumeration_rechecks_policy_before_each_profile(self):
        def add_profile(policy):
            policy["tenants"][self.tenant]["profiles"]["other"] = {"domain": None, "viewpoint": "developer"}
            policy["users"][self.user["user_id"]]["memberships"][self.tenant]["profiles"].append("other")
        self.change_policy(add_profile)
        scopes = self.tracked.index_scopes()
        self.assertEqual(next(scopes).profile_id, "default")
        self.change_policy(lambda policy: policy["users"][self.user["user_id"]]["memberships"][self.tenant].update(profiles=["default"]))
        self.assertEqual(list(scopes), [])

    def test_unchanged_background_pass_does_no_capture_or_metadata_scan(self):
        self.worker.run_once()
        with patch.object(exploration, "_project", side_effect=AssertionError("unchanged capture")), \
                patch("core.modules.knowledge.ontology_exploration_index._scan", side_effect=AssertionError("unchanged inventory")):
            self.worker.run_once()
            self.worker.run_once()
        self.assertEqual(self.worker.status()["prepared"], 1)

    def test_index_failure_does_not_change_save_receipt_or_history_and_retries_later(self):
        self.worker.run_once()
        before = self.store.read("a.md")
        saved = self.store.save("a.md", before.content + "Saved.\n", expected_revision=before.revision)
        expected = self.canonical()
        with patch("core.runtime.ontology_index.prepare_index", side_effect=CanonicalIndexUnavailable("private detail")):
            with self.assertLogs("core.ontology_index", level="WARNING") as logs:
                self.worker.run_once()
            self.worker.run_once()
        self.assertEqual(self.worker.status()["failed"], 1)
        self.assertNotIn("private detail", "\n".join(logs.output))
        self.assertEqual(self.canonical(), expected)
        self.assertEqual(self.store.read("a.md").revision, saved.revision)
        self.assertEqual(Path(saved.history_path).read_bytes(), before.content.encode())
        # A subsequent actual change bypasses the failure delay without replaying the save.
        self.store.save("b.md", "A uses B.\nAnother.\n", expected_revision=self.store.read("b.md").revision)
        self.worker.run_once()
        with patch.object(exploration, "_project", side_effect=AssertionError("recovery should be prepared")):
            self.service.explore_search(kind="document", limit=5)

    def test_current_policy_profiles_revocation_and_missing_policy_fail_closed(self):
        self.assertEqual(access_basis(next(self.tracked.index_scopes())), access_basis(self.scope))
        self.worker.run_once()
        self.change_policy(lambda policy: policy["users"][self.user["user_id"]]["memberships"][self.tenant].update(permissions=[]))
        with patch("core.runtime.ontology_index.prepare_index", side_effect=AssertionError("revoked read")):
            self.worker.run_once()
        self.assertEqual(self.worker.status()["scopes"], 0)
        self.assertEqual(list(self.tracked.index_scopes()), [])
        with self.assertRaises(AccessDenied):
            self.tracked.authorize(self.token, self.tenant, "read")
        self.assertEqual(self.client.post(f"/api/v1/tenants/{self.tenant}/ontology/search",
            headers=self.headers(), json={"kind": "document", "limit": 5}).status_code, 403)
        self.config.rename(self.config.with_suffix(".preserved"))
        with self.assertRaises(PolicyError):
            self.worker.run_once()
        self.assertFalse(self.config.exists())

    def test_profile_scope_is_separate_and_no_credentials_are_retained(self):
        def add_profile(policy):
            policy["tenants"][self.tenant]["profiles"]["other"] = {"domain": None, "viewpoint": "developer"}
            policy["users"][self.user["user_id"]]["memberships"][self.tenant]["profiles"].append("other")
        self.change_policy(add_profile)
        scopes = list(self.tracked.index_scopes())
        self.assertEqual({scope.profile_id for scope in scopes}, {"default", "other"})
        self.worker.run_once()
        self.assertEqual(self.worker.status()["scopes"], 2)
        for scope in scopes:
            with patch.object(exploration, "_project", side_effect=AssertionError("profile not prepared")):
                ConceptStore(scope.store, access_dict(scope)).explore_search(kind="document", limit=5)
        self.assertNotIn(self.token, repr(vars(self.worker)))
        self.assertNotIn(self.token, json.dumps(self.worker.status()))

    def test_cooperative_shutdown_preserves_partial_projection_and_next_run_finishes(self):
        before = self.canonical()
        count = 0
        def cancelled():
            nonlocal count
            count += 1
            return count >= 3
        with self.assertRaises(exploration.IndexPreparationStopped):
            exploration.prepare_index(self.service, should_stop=cancelled)
        self.assertEqual(before, self.canonical())
        self.worker.run_once()
        with patch.object(exploration, "_project", side_effect=AssertionError("partial preparation not resumed")):
            self.assertEqual(self.service.explore_search(kind="document")["total"], 2)
