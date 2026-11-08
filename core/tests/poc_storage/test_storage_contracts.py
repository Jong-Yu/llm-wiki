"""D-072/073 preservation, isolation and failure tests using temporary stores only."""
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.common import storage_layout as layout
from core.common.json_codec import canonical_json_bytes
from core.modules.documents.store import WikiStore, RevisionConflictError, DocumentTooLargeError, StorageBusyError
from core.modules.documents.metadata import parse_document, render_document, prepare_edit, DocumentMetadataError
from core.modules.documents import changes
from core.modules.documents.history import list_versions, read_version, save_content, restore_version
from core.modules.sources.store import SourceStore
from core.modules.sources import files
from core.modules.sources.contracts import SourceCorruptError, SourceConflictError, SourceLimitError
from core.modules.sources.validation import request_key
from core.modules.personal.store import PersonalStore, PersonalCorruptError, PersonalConflictError
from core.modules.personal import workflow_io


def actor(user='alice', access=True):
    value = dict(user_id=user, tenant='tenant', profile_id='general', domain='general',
                 viewpoint='general', policy_revision='a' * 64)
    if access:
        value['access_revision'] = 'b' * 64
    return value


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = WikiStore(self.root)
        self.sources = SourceStore(self.store)

    def source(self, content=b'original\r\n', *, request=None, user='alice', actor_access=True, **kw):
        staged = self.sources.stage(io.BytesIO(content), kind='text', title='Title', format='txt')
        return self.sources.commit(staged, tenant='tenant', user_id=user, request_id=request or uuid4().hex,
                                   authorize=lambda: actor(user, access=actor_access), **kw)

    def personal(self, user='alice'):
        return PersonalStore(SimpleNamespace(store=self.store, **actor(user)))

    def snapshot_files(self):
        # 원본·전체 이력의 보존을 비교하며 새로 생성되는 파생 조회 인덱스만 제외한다.
        return {p.relative_to(self.root).as_posix(): p.read_bytes() for p in self.root.rglob('*')
                if p.is_file() and p.relative_to(self.root).parts[0] != '_index'}

    def test_path_functions_are_pure_and_reject_traversal(self):
        before = self.snapshot_files()
        sid, vid, jid = [uuid4().hex for _ in range(3)]
        self.assertEqual(layout.source_version_root(self.root, sid, vid), self.root / '_sources' / sid / 'versions' / vid)
        self.assertEqual(layout.analysis_job_root(self.root, 'alice', jid), self.root / '_personal/alice/analysis' / jid)
        self.assertEqual(layout.analysis_request_root(self.root, 'alice'), self.root / '_personal/alice/_requests/analysis')
        self.assertEqual(layout.knowledge_root(self.root, 'reviews'), self.root / '_knowledge/reviews')
        self.assertEqual(self.snapshot_files(), before)
        for bad in ('../alice', '/alice', 'Alice', 'alice/a', '', 'a\\b'):
            with self.assertRaises(ValueError): layout.personal_root(self.root, bad)
        with self.assertRaises(ValueError): layout.knowledge_root(self.root, '../wiki')
        with self.assertRaises(ValueError): layout.source_root(self.root, 'title')

    def test_legacy_parser_preserves_empty_unicode_crlf(self):
        for content in ('', '\r\n', '# 제목\r\n\r\nbody 한글\r\n'):
            parsed = parse_document(content)
            self.assertEqual((parsed.metadata, parsed.body, parsed.body_start_line, parsed.document_id), ({}, content, 1, None))
            self.assertEqual(parsed.body_revision, sha256(content.encode()).hexdigest())

    def test_front_matter_body_coordinates_and_editable_metadata(self):
        content = render_document('# Body\r\nquote\r\n', title='yes: 날짜', tags=['tag'])
        parsed = parse_document(content)
        self.assertEqual(parsed.body, '# Body\r\nquote\r\n')
        self.assertEqual(content.splitlines()[parsed.body_start_line - 1], '# Body')
        other = content.replace('yes: 날짜', 'Changed title')
        self.assertEqual(parse_document(other).body_revision, parsed.body_revision)
        self.assertEqual(prepare_edit('a.md', other, content), other)
        self.assertNotEqual(sha256(content.encode()).hexdigest(), sha256(other.encode()).hexdigest())
        crlf = content.replace('\n', '\r\n')
        self.assertEqual(parse_document(crlf).document_id, parsed.document_id)

    def test_metadata_rejects_duplicate_yaml_alias_and_fake_identity(self):
        content = render_document('body', title='Title')
        for bad in (content.replace('title: "Title"', 'title: "Title"\ntitle: "Other"'),
                    content.replace('tags: []', 'tags: &x [*x]'),
                    content.replace('tags: []', 'tags: !!python/object/apply:os.system [whoami]'),
                    content.replace('schema_version: 1', 'schema_version: true'),
                    content.replace('tags: []', 'tags: [x, x]')):
            with self.assertRaises(DocumentMetadataError): parse_document(bad)
        with self.assertRaises(DocumentMetadataError): prepare_edit('a.md', content)
        with self.assertRaises(DocumentMetadataError): prepare_edit('a.md', 'removed header', content)
        changed = content.replace(parse_document(content).document_id, uuid4().hex)
        with self.assertRaises(DocumentMetadataError): prepare_edit('a.md', changed, content)

    def test_full_file_cas_history_and_authorship(self):
        first = render_document('본문\r\n', title='First')
        a = self.store.save('nested/a.md', first, expected_revision=None, actor=actor(), origin='human', reason='Create')
        second = first.replace('First', 'Second')
        b = self.store.save('nested/a.md', second, expected_revision=a.revision, actor=actor(), origin={'kind':'ai','tool':'analysis'})
        self.assertEqual(b.history_path.read_bytes(), first.encode())
        self.assertEqual(self.store.read('nested/a.md').content, second)
        self.assertEqual(parse_document(first).body_revision, parse_document(second).body_revision)
        before = self.snapshot_files()
        with self.assertRaises(RevisionConflictError): self.store.save('nested/a.md', second, expected_revision=a.revision)
        self.assertEqual(self.snapshot_files(), before)
        auth = changes.authorship(self.store, 'nested/a.md', b.revision)
        self.assertEqual(auth['created']['actor'], actor())
        self.assertEqual(auth['updated']['origin']['kind'], 'ai')
        versions = list_versions(self.store, 'nested/a.md', tenant='tenant', scope_key='scope')
        self.assertTrue(versions['complete'])
        self.assertEqual(versions['skipped'], [])
        self.assertEqual(versions['items'][0]['author'], actor())
        old = read_version(self.store, 'nested/a.md', b.history_path.name)
        self.assertEqual(old['content'], first)
        self.assertEqual(old['body'], '본문\r\n')

    def test_history_page_reuses_one_author_ledger_without_changing_projection(self):
        """페이지 크기가 커져도 같은 작성 원장을 항목마다 다시 읽지 않는다."""
        revision = None
        for index in range(12):
            result = self.store.save('a.md', f'Version {index}\n', expected_revision=revision,
                                     actor=actor(), origin='human', reason=f'Change {index}')
            revision = result.revision
        expected = list_versions(self.store, 'a.md', tenant='tenant', scope_key='scope', limit=10)
        before = self.snapshot_files()
        with patch('core.modules.documents.history.load_changes', wraps=changes.load) as loaded:
            actual = list_versions(self.store, 'a.md', tenant='tenant', scope_key='scope', limit=10)
            self.assertEqual(loaded.call_count, 0)
        self.assertEqual(actual, expected)
        self.assertEqual(self.snapshot_files(), before)

    def test_history_preserves_metadata_error_before_corrupt_author_ledger(self):
        """두 자료가 함께 손상돼도 기존 오류 우선순위와 파일을 보존한다."""
        first = self.store.save('a.md', 'First\n', expected_revision=None)
        self.store.save('a.md', 'Second\n', expected_revision=first.revision)
        (self.store.wiki_dir / 'a.md').write_text('---\ntitle: [\n---\nBody\n')
        (self.store.history_dir / 'a.md' / 'changes.json').write_text('{')
        before = self.snapshot_files()
        with self.assertRaises(DocumentMetadataError):
            list_versions(self.store, 'a.md', tenant='tenant', scope_key='scope')
        self.assertEqual(self.snapshot_files(), before)

    def test_read_does_not_rewrite_legacy_bytes_or_create_ledger(self):
        p = self.root / 'wiki/old.md'
        p.write_bytes(b'old\r\n')
        before = self.snapshot_files()
        snapshot = self.store.read('old.md')
        self.assertEqual(changes.document_fields(self.store, 'old.md', snapshot)['authorship']['status'], 'unknown')
        self.assertEqual(self.snapshot_files(), before)
        result = self.store.save('old.md', 'next\r\n', expected_revision=snapshot.revision)
        self.assertEqual(result.history_path.read_bytes(), b'old\r\n')
        auth = changes.authorship(self.store, 'old.md', result.revision)
        self.assertIsNone(auth['created'])
        self.assertEqual(auth['updated']['origin'], {'kind':'unknown'})

    def test_duplicate_document_id_and_identity_removal_are_rejected(self):
        content = render_document('body', title='Title')
        a = self.store.save('a.md', content, expected_revision=None)
        with self.assertRaises(DocumentMetadataError): self.store.save('b.md', content, expected_revision=None)
        with self.assertRaises(DocumentMetadataError): self.store.save('a.md', 'body', expected_revision=a.revision)
        self.assertFalse((self.root / 'wiki/b.md').exists())

    def test_invalid_source_reference_and_client_source_change_are_rejected(self):
        content = render_document('body', title='Title', source={'id':uuid4().hex,'version':uuid4().hex})
        with self.assertRaises(FileNotFoundError): self.store.save('a.md', content, expected_revision=None)
        source = self.source()
        content = render_document('body', title='Title', source={'id':source['source_id'],'version':source['source_version']})
        saved = self.store.save('a.md', content, expected_revision=None)
        changed = content.replace(source['source_version'], uuid4().hex)
        with self.assertRaises(DocumentMetadataError): prepare_edit('a.md', changed, content)
        self.assertEqual(self.store.read('a.md').revision, saved.revision)

    def test_archive_failure_preserves_document_and_ledger(self):
        a = self.store.save('a.md', 'old', expected_revision=None)
        before = self.snapshot_files()
        with patch.object(self.store, '_archive', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.store.save('a.md', 'new', expected_revision=a.revision)
        after = self.snapshot_files()
        # The durable pre-write intent may advance even though publication fails.
        # All document, complete history and authorship bytes remain unchanged.
        self.assertNotEqual(after.pop('.storage.lock'), before.pop('.storage.lock'))
        self.assertEqual(after, before)

    def test_audit_intent_failure_never_publishes_file(self):
        a = self.store.save('a.md', 'old', expected_revision=None)
        old_ledger = (self.root / '_history/a.md/changes.json').read_bytes()
        with patch.object(changes, '_write', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.store.save('a.md', 'new', expected_revision=a.revision)
        self.assertEqual(self.store.read('a.md').content, 'old')
        self.assertEqual((self.root / '_history/a.md/changes.json').read_bytes(), old_ledger)
        self.assertEqual([p.read_text() for p in (self.root / '_history/a.md').glob('*.md')], ['old'])

    def test_publish_failure_pending_observation_and_next_write_recovery(self):
        a = self.store.save('a.md', 'old', expected_revision=None)
        real_replace = os.replace
        def fail_current(src, dst):
            if Path(dst).resolve() == self.store.data_dir / 'wiki/a.md': raise OSError('publish failed')
            return real_replace(src, dst)
        with patch('os.replace', side_effect=fail_current):
            with self.assertRaises(OSError): self.store.save('a.md', 'new', expected_revision=a.revision)
        before = self.snapshot_files()
        self.assertEqual(self.store.read('a.md').content, 'old')
        self.assertEqual(changes.authorship(self.store, 'a.md', a.revision)['status'], 'pending_reconcile')
        self.assertEqual(self.snapshot_files(), before)
        b = self.store.save('a.md', 'next', expected_revision=a.revision)
        self.assertEqual([e['status'] for e in changes.load(self.store, 'a.md')['entries']], ['committed','aborted','committed'])
        self.assertEqual(self.store.read('a.md').revision, b.revision)

    def test_audit_finalize_failure_is_success_and_reconciles_without_repeat_history(self):
        with patch.object(changes, 'finish', side_effect=OSError('audit failed')):
            a = self.store.save('a.md', 'published', expected_revision=None)
        self.assertTrue(a.changed)
        self.assertEqual(a.audit_status, 'pending_reconcile')
        before = self.snapshot_files()
        self.assertEqual(changes.authorship(self.store, 'a.md', a.revision)['updated']['after_revision'], a.revision)
        self.assertEqual(self.snapshot_files(), before)
        b = WikiStore(self.root).save('a.md', 'published', expected_revision=a.revision)
        self.assertFalse(b.changed)
        self.assertEqual(changes.load(self.store, 'a.md')['entries'][0]['status'], 'committed')
        self.assertEqual(list((self.root / '_history/a.md').glob('*.md')), [])

    def test_unknown_pending_revision_and_corrupt_ledger_block_writes(self):
        with patch.object(changes, 'finish', side_effect=OSError()):
            self.store.save('a.md', 'one', expected_revision=None)
        (self.root / 'wiki/a.md').write_text('external')
        before = self.snapshot_files()
        with self.assertRaises(changes.AuthorshipCorruptError):
            self.store.save('a.md', 'next', expected_revision=self.store.read('a.md').revision)
        self.assertEqual(self.snapshot_files(), before)
        ledger = self.root / '_history/a.md/changes.json'
        ledger.write_text('{"schema_version":1,"schema_version":1}')
        before = self.snapshot_files()
        with self.assertRaises(changes.AuthorshipCorruptError):
            self.store.save('a.md', 'next', expected_revision=self.store.read('a.md').revision)
        self.assertEqual(self.snapshot_files(), before)

    def test_size_guard_and_concurrent_compare_and_swap(self):
        with self.assertRaises(DocumentTooLargeError): self.store.save('large.md', '한' * 400000, expected_revision=None)
        a = self.store.save('a.md', 'old', expected_revision=None)
        def save(value):
            try: return self.store.save('a.md', value, expected_revision=a.revision).changed
            except RevisionConflictError: return False
        with ThreadPoolExecutor(2) as pool:
            result = list(pool.map(save, ['one','two']))
        self.assertEqual(sorted(result), [False,True])
        self.assertEqual(len(list((self.root / '_history/a.md').glob('*.md'))), 1)

    def test_store_busy_keeps_basis_and_data(self):
        self.store.lock_timeout_seconds = 0
        with self.store._write_lock():
            with self.assertRaises(StorageBusyError): self.store.save('a.md','one',expected_revision=None)
        self.assertFalse((self.root / 'wiki/a.md').exists())

    def test_legacy_actor_bytes_survive_new_source_version(self):
        one = self.source(actor_access=False)
        old_path = layout.source_version_root(self.root,one['source_id'],one['source_version']) / 'manifest.json'
        before = old_path.read_bytes()
        two = self.source(b'next',source_id=one['source_id'],expected_registration_revision=one['registration_revision'])
        catalog = self.sources.get_source(one['source_id'])
        self.assertNotIn('access_revision',catalog['versions'][0]['actor'])
        self.assertIn('access_revision',catalog['versions'][1]['actor'])
        self.assertEqual(old_path.read_bytes(),before)

    def test_source_concurrent_versions_keep_one_winner_and_both_originals(self):
        one = self.source()
        def version(content):
            try:
                return self.source(content,source_id=one['source_id'],expected_registration_revision=one['registration_revision'])
            except SourceConflictError:
                return None
        with ThreadPoolExecutor(2) as pool:
            values = list(pool.map(version,[b'left',b'right']))
        self.assertEqual(sum(value is not None for value in values),1)
        self.assertEqual(len(self.sources.get_source(one['source_id'])['versions']),2)
        original,_ = self.sources.open_original(one['source_id'],one['source_version'])
        with original: self.assertEqual(original.read(),b'original\r\n')
        self.assertEqual(list((self.root / '_incoming').iterdir()),[])

    def test_denied_commit_preserves_data_and_same_title_creates_distinct_sources(self):
        one,two = self.source(),self.source()
        self.assertNotEqual(one['source_id'],two['source_id'])
        before = self.snapshot_files()
        staged = self.sources.stage(io.BytesIO(b'denied'),kind='text',title='Title',format='txt')
        from core.modules.access.policy import AccessDenied
        def denied(): raise AccessDenied()
        with self.assertRaises(AccessDenied):
            self.sources.commit(staged,tenant='tenant',user_id='alice',request_id=uuid4().hex,authorize=denied)
        self.assertEqual(self.snapshot_files(),before)

    def test_cleanup_failure_does_not_turn_saved_file_into_failed_write(self):
        original_unlink = Path.unlink
        def fail_temporary(path,*args,**kwargs):
            if path.suffix == '.tmp': raise OSError('temporary cleanup failed')
            return original_unlink(path,*args,**kwargs)
        with patch.object(Path,'unlink',fail_temporary):
            result = self.store.save('a.md','stored',expected_revision=None)
        self.assertTrue(result.changed)
        self.assertEqual(self.store.read('a.md').content,'stored')
        self.assertTrue(result.cleanup_failures)
        self.assertEqual(changes.authorship(self.store,'a.md',result.revision)['status'],'recorded')
        for failure in result.cleanup_failures:
            original_unlink(failure.path)

    def test_source_new_layout_fixed_versions_and_read_only_queries(self):
        one = self.source(b'first\r\n')
        self.assertEqual(one['state'], 'complete')
        self.assertFalse((self.root / '_registrations').exists())
        base = layout.source_root(self.root, one['source_id'])
        self.assertTrue((base / 'catalog.json').is_file())
        two = self.source(b'second', source_id=one['source_id'], expected_registration_revision=one['registration_revision'])
        before = self.snapshot_files()
        stream, manifest = self.sources.open_original(one['source_id'], one['source_version'])
        with stream: self.assertEqual(stream.read(), b'first\r\n')
        self.assertEqual(manifest['actor']['access_revision'], 'b' * 64)
        self.assertEqual(len(self.sources.get_source(one['source_id'])['versions']), 2)
        self.sources.list_sources(tenant='tenant',scope_key='s')
        self.sources.request_receipt(tenant='tenant',user_id='alice',request_id=two['request_id'])
        self.assertEqual(self.snapshot_files(), before)
        with self.assertRaises(SourceConflictError): self.source(b'third', source_id=one['source_id'], expected_registration_revision=one['registration_revision'])

    def legacy_source(self):
        value = self.source()
        sid, version = value['source_id'], value['source_version']
        base = layout.source_root(self.root, sid)
        (self.root / '_registrations').mkdir()
        (base / 'catalog.json').rename(self.root / '_registrations' / (sid + '.json'))
        (base / 'versions' / version).rename(base / version)
        (base / 'versions').rmdir()
        request = self.sources._request_path('tenant','alice',value['request_id'])
        (self.root / '_registrations/_requests').mkdir()
        request.rename(self.root / '_registrations/_requests' / request.name)
        return value

    def test_legacy_source_read_and_explicit_version_write_stay_in_layout(self):
        first = self.legacy_source()
        before = self.snapshot_files()
        self.sources.get_source(first['source_id'])
        self.sources.request_receipt(tenant='tenant',user_id='alice',request_id=first['request_id'])
        stream,_ = self.sources.open_original(first['source_id'], first['source_version'])
        stream.close()
        self.assertEqual(self.snapshot_files(), before)
        second = self.source(b'new',source_id=first['source_id'],expected_registration_revision=first['registration_revision'])
        base = layout.source_root(self.root, first['source_id'])
        self.assertTrue((base / second['source_version'] / 'original').exists())
        self.assertFalse((base / 'catalog.json').exists())
        self.assertEqual((base / first['source_version'] / 'original').read_bytes(), b'original\r\n')

    def test_receipt_limit_still_covers_legacy_and_other_users(self):
        one = self.legacy_source()
        with patch('core.modules.sources.contracts.MAX_REQUESTS',2):
            self.source(user='bob')
            before = self.snapshot_files()
            with self.assertRaises(SourceLimitError): self.source(user='charlie')
        self.assertEqual(self.snapshot_files(),before)

    def test_version_limit_counts_orphan_original_after_catalog_failure(self):
        one = self.source()
        with patch.object(self.sources,'_write_catalog',side_effect=OSError()):
            orphan = self.source(b'orphan',source_id=one['source_id'],expected_registration_revision=one['registration_revision'])
        self.assertEqual(orphan['state'],'pending_reconcile')
        before = self.snapshot_files()
        with patch('core.modules.sources.contracts.MAX_VERSIONS',2):
            with self.assertRaises(SourceLimitError):
                self.source(b'third',source_id=one['source_id'],expected_registration_revision=one['registration_revision'])
        self.assertEqual(self.snapshot_files(),before)

    def test_duplicate_source_catalog_and_version_fail_closed(self):
        first = self.legacy_source()
        base = layout.source_root(self.root, first['source_id'])
        old = self.root / '_registrations' / (first['source_id'] + '.json')
        shutil.copyfile(old, base / 'catalog.json')
        before = self.snapshot_files()
        with self.assertRaises(SourceCorruptError): self.sources.get_source(first['source_id'])
        self.assertEqual(self.snapshot_files(), before)
        (base / 'catalog.json').unlink()
        shutil.copytree(base / first['source_version'], base / 'versions' / first['source_version'])
        with self.assertRaises(SourceCorruptError): self.sources.open_original(first['source_id'],first['source_version'])

    def test_corrupt_source_and_original_hash_are_not_repaired(self):
        one = self.source()
        path = layout.source_version_root(self.root,one['source_id'],one['source_version']) / 'original'
        path.write_bytes(b'corrupt')
        before = self.snapshot_files()
        with self.assertRaises(SourceCorruptError): self.sources.open_original(one['source_id'],one['source_version'])
        self.assertEqual(self.snapshot_files(), before)

    def test_source_pending_receipt_replay_never_duplicates_original(self):
        request = uuid4().hex
        with patch.object(self.sources, '_write_catalog', side_effect=OSError('disk full')):
            one = self.source(request=request)
        self.assertEqual(one['state'], 'pending_reconcile')
        before = self.snapshot_files()
        two = self.source(request=request)
        self.assertEqual(two['source_id'], one['source_id'])
        self.assertTrue(two['replayed'])
        self.assertEqual(self.snapshot_files(), before)
        with self.assertRaises(FileNotFoundError): self.sources.request_receipt(tenant='tenant',user_id='bob',request_id=request)

    def test_source_receipt_confirmation_after_final_receipt_failure(self):
        original_write = self.sources._write_request
        def fail_final(path, value):
            if value['state'] == 'complete': raise OSError('receipt failure')
            return original_write(path, value)
        with patch.object(self.sources, '_write_request', side_effect=fail_final): value = self.source()
        self.assertEqual(value['state'], 'pending_reconcile')
        before = self.snapshot_files()
        receipt = self.sources.request_receipt(tenant='tenant',user_id='alice',request_id=value['request_id'])
        self.assertEqual(receipt['state'], 'complete')
        self.assertEqual(self.snapshot_files(), before)

    def test_analysis_request_id_collision_in_new_and_old_layouts(self):
        for root in (layout.analysis_request_root(self.root,'alice'), self.root / '_jobs/_requests'):
            request = uuid4().hex
            path = root / (request_key('tenant','alice',request) + '.json')
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text('{}')
            with self.assertRaises(SourceConflictError): self.source(request=request)
        self.assertFalse((self.root / '_sources').exists())

    def test_personal_new_and_legacy_paths_isolation_and_cas(self):
        person = self.personal()
        result = person.create('conversations',uuid4().hex,{}, {'title':'Private'},actor(),before_commit=lambda:None)
        record = result['record']['id']
        new = person.root / 'conversations' / (record+'.json')
        self.assertTrue(new.is_file())
        with self.assertRaises(FileNotFoundError): self.personal('bob').read('conversations',record)
        legacy = person.legacy_root / 'conversations' / new.name
        legacy.parent.mkdir(parents=True)
        new.rename(legacy)
        before = self.snapshot_files()
        person.read('conversations',record)
        person.list('conversations',scope_key='scope')
        self.assertEqual(self.snapshot_files(),before)
        updated = person.append('conversations',record,uuid4().hex,result['revision'],{}, {'role':'user','content':'Hi'},actor(),before_commit=lambda:None)
        self.assertTrue(legacy.is_file())
        self.assertFalse(new.exists())
        with self.assertRaises(PersonalConflictError): person.append('conversations',record,uuid4().hex,result['revision'],{}, {},actor(),before_commit=lambda:None)
        new.write_bytes(legacy.read_bytes())
        with self.assertRaises(PersonalCorruptError): person.read('conversations',record)
        with self.assertRaises(PersonalCorruptError): person.list('conversations',scope_key='scope')

    def test_personal_corruption_and_symlink_are_preserved(self):
        person = self.personal()
        value = person.create('saved-results',uuid4().hex,{}, {'title':'R'},actor(),before_commit=lambda:None)
        path = person._path('saved-results',value['record']['id'])
        path.write_text('{}')
        before = self.snapshot_files()
        with self.assertRaises(PersonalCorruptError): person.read('saved-results',value['record']['id'])
        self.assertEqual(self.snapshot_files(),before)
        (self.root / '_personal/bob').symlink_to(person.root,target_is_directory=True)
        with self.assertRaises(SourceCorruptError): self.personal('bob').read('saved-results',value['record']['id'])

    def test_workflow_requests_migrate_by_new_write_without_hiding_old_pending(self):
        person = self.personal()
        record,request = uuid4().hex,uuid4().hex
        with person._coordination(create=True):
            path,_ = workflow_io.start_request(person,'draft-applications',record,request,{})
        self.assertIn('_requests/draft-applications',path.as_posix())
        legacy = person.legacy_root / '_draft-applications' / record / request
        legacy.parent.mkdir(parents=True)
        path.rename(legacy)
        before = self.snapshot_files()
        self.assertEqual(workflow_io.request_ids(person,'draft-applications',record),[request])
        self.assertEqual(workflow_io.receipt(person,'draft-applications',record,request)['state'],'pending_reconcile')
        self.assertEqual(self.snapshot_files(),before)
        with person._coordination(create=True):
            with self.assertRaises(PersonalConflictError): workflow_io.start_request(person,'draft-applications',record,uuid4().hex,{})

    def test_personal_draft_apply_keeps_server_metadata_and_reports_ai_actor(self):
        from core.modules.personal.drafts import DraftStore
        scope = SimpleNamespace(store=self.store,**actor())
        person = PersonalStore(scope)
        basis = {'scope':{'profile':actor()},'snapshot_revision':'c'*64,'documents':[],'originals':[]}
        result = person.create('saved-results',uuid4().hex,{}, {'title':'Result','content':'Generated text',
            'basis':basis},actor(),before_commit=lambda:None)
        drafts = DraftStore(scope)
        draft = drafts.create(uuid4().hex,result['record']['id'],before_commit=lambda:None)
        first = self.store.save('a.md',render_document('Earlier body',title='Keep title',tags=['keep']),expected_revision=None)
        old = self.store.read('a.md')
        observed = workflow_io.observe_basis(self.store,basis,actor())
        receipt = drafts.apply(draft['record']['id'],request_id=uuid4().hex,expected_revision=draft['revision'],
            document='a.md',expected_document_revision=first.revision,expected_basis_observation=observed['observation_revision'],
            acknowledge_changed_basis=False,authorize=lambda:None)
        self.assertEqual(receipt['state'],'complete')
        now = self.store.read('a.md')
        self.assertEqual(parse_document(now.content).metadata,parse_document(old.content).metadata)
        self.assertIn('Generated text',parse_document(now.content).body)
        self.assertEqual(changes.authorship(self.store,'a.md',now.revision)['updated']['origin']['kind'],'ai')
        self.assertEqual(read_version(self.store,'a.md',receipt['receipt']['history_id'])['content'],old.content)
        changed_actor = {**actor(),'access_revision':'d'*64}
        self.assertEqual(workflow_io.observe_basis(self.store,basis,changed_actor)['status'],'changed')
        legacy_basis = {**basis,'scope':{'profile':actor(access=False)}}
        self.assertEqual(workflow_io.observe_basis(self.store,legacy_basis,changed_actor)['status'],'current')

    def test_http_edit_helper_and_legacy_restore_preserve_server_identity(self):
        old = self.store.save('a.md','old\r\n',expected_revision=None)
        saved = save_content(self.store,'a.md','new\r\n',old.revision,actor=actor(),origin='human',prepare_metadata=True)
        current = self.store.read('a.md')
        identity = parse_document(current.content).document_id
        result = restore_version(self.store,'a.md',saved['history_id'],saved['revision'],actor=actor())
        restored = parse_document(self.store.read('a.md').content)
        self.assertEqual(restored.document_id,identity)
        self.assertEqual(restored.body,'old\r\n')
        self.assertEqual((self.root / '_history/a.md' / saved['history_id']).read_bytes(),b'old\r\n')
        self.assertEqual(read_version(self.store,'a.md',result['history_id'])['content'],current.content)


if __name__ == '__main__': unittest.main()
