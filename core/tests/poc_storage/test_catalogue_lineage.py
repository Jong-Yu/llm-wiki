"""등록 목록의 계보 묶기·판본·페이지 경계와 읽기 보존을 격리 자료로 검증한다."""

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile

from core.common.read_index import CanonicalIndexUnavailable
from core.modules.documents.listing import CatalogChangedError, InvalidCursorError
from core.modules.documents.metadata import parse_document, render_document
from core.modules.documents.store import WikiStore
from core.modules.knowledge.catalogue import list_catalogue, search_catalogue
from core.modules.sources.store import SourceStore
from core.tests.poc_mcp.test_server_integration import ServerFixture
from core.api.dependencies import access_value


ACTOR = {"user_id": "alice", "tenant": "tenant", "profile_id": "default",
         "domain": None, "viewpoint": None, "policy_revision": "a" * 64}


class CatalogueLineageTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = WikiStore(self.root)
        self.sources = SourceStore(self.store)

    def source(self, title="Original", previous=None):
        staged = self.sources.stage(BytesIO(f"{title} {uuid4().hex}".encode()),
                                    kind="text", title=title, format="txt")
        return self.sources.commit(staged, tenant="tenant", user_id="alice", request_id=uuid4().hex,
            source_id=previous["source_id"] if previous else None,
            expected_registration_revision=previous["registration_revision"] if previous else None,
            authorize=lambda: dict(ACTOR))

    def wiki(self, document, source=None, body="needle", title="Same title"):
        content = render_document(body, title=title, source=(
            {"id": source["source_id"], "version": source["source_version"]} if source else None))
        return self.store.save(document, content, expected_revision=None)

    def page(self, **kwargs):
        return list_catalogue(self.store, tenant="tenant", scope_key="scope", group_sources=True, **kwargs)

    def files(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes()
                for path in self.root.rglob("*") if path.is_file()
                and path.relative_to(self.root).parts[0] != "_index"}

    def test_opt_in_groups_before_pagination_and_keeps_all_results(self):
        source = self.source()
        saved = self.wiki("first.md", source)
        self.wiki("second.md", source)
        self.wiki("unrelated.md")
        before = self.files()
        legacy = list_catalogue(self.store, tenant="tenant", scope_key="scope")
        self.assertEqual(len(legacy["items"]), 4)
        first = self.page(limit=1)
        self.assertEqual(len(first["items"]), 1)
        documents = first["items"][0]["documents"]
        self.assertEqual([item["document"] for item in documents], ["first.md", "second.md"])
        self.assertEqual(documents[0]["revision"], saved.revision)
        self.assertEqual(documents[0]["metadata"]["source"]["id"], source["source_id"])
        second = self.page(limit=1, cursor=first["next_cursor"])
        self.assertEqual([item["document"] for item in second["items"]], ["unrelated.md"])
        self.assertTrue(second["complete"])
        self.assertEqual(before, self.files())
        self.assertEqual(self.sources.get_source(source["source_id"])["documents"], [])

    def test_old_versions_unknown_sources_and_same_titles_remain_independent(self):
        old = self.source("Same title")
        current = self.source("Same title", old)
        self.wiki("old.md", old)
        self.wiki("current.md", current)
        self.wiki("same-title.md")
        # 외부에서 들어온 미등록 계보 fixture이며 사용자 자료나 저장 계약을 우회하지 않는다.
        (self.store.wiki_dir / "unknown.md").write_text(render_document("needle", title="Same title",
            source={"id": uuid4().hex, "version": uuid4().hex}))
        items = self.page()["items"]
        self.assertEqual([item["document"] for item in items[0]["documents"]], ["current.md"])
        self.assertEqual({item["document"] for item in items[1:]}, {"old.md", "same-title.md", "unknown.md"})

    def test_cursor_binds_grouping_scope_and_changed_lineage(self):
        source = self.source()
        saved = self.wiki("a.md", source)
        self.wiki("b.md")
        cursor = self.page(limit=1)["next_cursor"]
        with self.assertRaises(CatalogChangedError):
            list_catalogue(self.store, tenant="tenant", scope_key="scope", cursor=cursor)
        with self.assertRaises(InvalidCursorError):
            list_catalogue(self.store, tenant="tenant", scope_key="other", cursor=cursor, group_sources=True)
        document_id = parse_document(self.store.read("a.md").content).document_id
        self.store.save("a.md", render_document("Changed", title="Unlinked", document_id=document_id),
                        expected_revision=saved.revision)
        with self.assertRaises(CatalogChangedError):
            self.page(cursor=cursor)
        self.assertEqual(self.page()["items"][0]["documents"], [])

    def test_warm_grouped_page_reads_only_its_documents_and_index_failure_is_equivalent(self):
        source = self.source()
        self.wiki("linked.md", source)
        for number in range(4):
            self.wiki(f"unrelated-{number}.md")
        expected = self.page(limit=1)
        with patch.object(self.store, "read", wraps=self.store.read) as read:
            self.assertEqual(self.page(limit=1), expected)
            self.assertEqual(read.call_count, 1)
        with patch("core.modules.knowledge.catalogue.read_index", side_effect=CanonicalIndexUnavailable("unavailable")):
            self.assertEqual(self.page(limit=1), expected)

    def test_failed_lineage_read_is_partial_and_retried_without_file_change(self):
        source = self.source()
        self.wiki("linked.md", source)
        original = self.store.read
        def failed(document):
            if document == "linked.md":
                raise OSError("temporary")
            return original(document)
        with patch.object(self.store, "read", side_effect=failed):
            result = self.page()
        self.assertFalse(result["complete"])
        self.assertIn({"document": "linked.md", "code": "read_failed"}, result["skipped"])
        recovered = self.page()
        self.assertTrue(recovered["complete"])
        self.assertEqual(recovered["items"][0]["documents"][0]["document"], "linked.md")

    def test_search_body_and_title_hits_group_without_hiding_other_versions(self):
        old = self.source("Original")
        current = self.source("Original", old)
        self.wiki("old.md", old)
        self.wiki("first.md", current)
        self.wiki("second.md", current, body="Different content")
        self.wiki("standalone.md")
        before = self.files()
        body = search_catalogue(self.store, "needle", 50, scope_key="scope")
        self.assertEqual({item["document"] for item in body["matches"]}, {"old.md", "standalone.md"})
        source = body["sources"]["matches"][0]
        self.assertEqual([item["document"] for item in source["documents"]], ["first.md", "second.md"])
        self.assertIn("snippet", source["documents"][0])
        self.assertNotIn("snippet", source["documents"][1])
        title = search_catalogue(self.store, "Original", 50, scope_key="scope")
        self.assertEqual(title["matches"], [])
        self.assertEqual(len(title["sources"]["matches"][0]["documents"]), 2)
        self.assertEqual(before, self.files())

    def test_search_keeps_existing_truncation_after_grouping(self):
        source = self.source()
        self.wiki("first.md", source)
        self.wiki("second.md", source)
        result = search_catalogue(self.store, "needle", 1, scope_key="scope")
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["sources"]["matches"]), 1)
        self.assertEqual(len(result["sources"]["matches"][0]["documents"]), 2)

    def test_search_enrichment_failure_keeps_matched_document_accessible(self):
        source = self.source()
        self.wiki("result.md", source)
        with patch("core.modules.knowledge.catalogue._wiki_item", side_effect=OSError("temporary")):
            result = search_catalogue(self.store, "needle", 50, scope_key="scope")
        self.assertEqual(result["matches"][0]["document"], "result.md")
        self.assertEqual(result["sources"]["matches"][0]["documents"], [])
        self.assertIn({"document": "result.md", "code": "read_failed"}, result["skipped"])


class CatalogueLineageHttpTests(ServerFixture):
    def test_uploaded_presentations_remain_listable_and_download_unchanged(self):
        """PPT/PPTX 등록 성공 뒤 목록 응답 계약과 원본 보존을 함께 확인한다."""
        package = BytesIO()
        with ZipFile(package, "w") as archive:
            archive.writestr("[Content_Types].xml",
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Override PartName="/ppt/presentation.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
                '</Types>')
            archive.writestr("_rels/.rels", "<Relationships/>")
            archive.writestr("ppt/presentation.xml", "<presentation/>")
        # 구형 PPT의 업로드 경계는 OLE 표식을 검사하며 실제 변환 가능성과 구별한다.
        originals = {"pptx": package.getvalue(), "ppt": b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"fixture"}
        prefix = f"/api/v1/tenants/{self.tenant}"
        registered = {}
        for format, content in originals.items():
            response = self.client.post(prefix + "/sources", headers=self.headers(),
                data={"request_id": uuid4().hex, "title": f"Synthetic {format}"},
                files={"file": (f"fixture.{format}", content, "application/octet-stream")})
            self.assertEqual(response.status_code, 201, response.text)
            registered[format] = response.json()["data"]
        for grouping in ("false", "true"):
            with self.subTest(group_sources=grouping):
                response = self.client.get(prefix + "/documents", headers=self.headers(),
                    params={"group_sources": grouping})
                self.assertEqual(response.status_code, 200, response.text)
                items = {item["format"]: item for item in response.json()["data"]["items"]}
                self.assertEqual(set(items), set(originals))
                for format, source in registered.items():
                    self.assertEqual(items[format]["source_id"], source["source_id"])
                    self.assertEqual(items[format]["source_version"], source["source_version"])
                    self.assertEqual(items[format]["source_sha256"], source["source_sha256"])
        for format, source in registered.items():
            response = self.client.get(prefix + f"/sources/{source['source_id']}/versions/{source['source_version']}/file",
                headers=self.headers())
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.content, originals[format])

    def test_opt_in_http_and_existing_default_share_access_and_documents(self):
        scope = self.policy.authorize(self.token, self.tenant, "write")
        sources = SourceStore(scope.store)
        staged = sources.stage(BytesIO(b"Original"), kind="text", title="Original", format="txt")
        source = sources.commit(staged, tenant=self.tenant, user_id=self.user["user_id"],
                                request_id=uuid4().hex, authorize=lambda: access_value(scope))
        scope.store.save("result.md", render_document("needle", title="Wiki", source={
            "id": source["source_id"], "version": source["source_version"]}), expected_revision=None)
        path = f"/api/v1/tenants/{self.tenant}/documents"
        legacy = self.client.get(path, headers=self.headers()).json()["data"]
        grouped_response = self.client.get(path, params={"group_sources": "true"}, headers=self.headers())
        self.assertEqual(grouped_response.status_code, 200, grouped_response.text)
        grouped = grouped_response.json()["data"]
        self.assertEqual(len(legacy["items"]), 2)
        self.assertEqual(len(grouped["items"]), 1)
        self.assertEqual(grouped["items"][0]["documents"][0]["document"], "result.md")
        self.assertEqual(grouped["access"], legacy["access"])
        for grouping, expected_count in (("false", 1), ("true", 0)):
            response = self.client.get(path + "/search", params={"query": "needle", "group_sources": grouping},
                                       headers=self.headers())
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(len(response.json()["data"]["matches"]), expected_count)
        self.assertEqual(self.client.get(path, params={"group_sources": "invalid"}, headers=self.headers()).status_code, 422)
        self.assertEqual(self.client.get(path, params={"group_sources": "true"}).status_code, 401)


if __name__ == "__main__":
    unittest.main()
