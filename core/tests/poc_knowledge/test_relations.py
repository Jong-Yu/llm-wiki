"""독립 추가의 격리 모의 판단: 원문·전체 그래프·이력·경쟁·실패 보존."""
import unittest
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4
from hashlib import sha256
import json
from core.common.json_codec import canonical_json_bytes
from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR
from core.modules.reviews.relations import RelationStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.modules.reviews.contracts import ReviewConflictError, ReviewCorruptError, ReviewLimitError
from core.modules.reviews.cleanup import CleanupStore
from core.modules.documents.store import CleanupFailure
from core.modules.knowledge.impact import ImpactStore
from core.modules.knowledge.impact_history import _review_prefix
from core.modules.access.policy import AccessDenied


class RelationTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document(body='A uses B.\nB depends on A.\n')
        self.generate()
        self.relations = RelationStore(self.wiki, ACTOR)

    def payload(self, kind='source'):
        state = self.reviews.query('a.md')
        value = _input(state['machine_graph']['relations'][0])
        value.update(subject='b', predicate='depends_on', object='a')
        if kind == 'source':
            value['evidence'] = 'B depends on A.'
        else:
            value.pop('evidence'); value.pop('provenance')
        return dict(kind=kind, replacement=value, request_id=uuid4().hex,
                    expected_state_revision=state['state_revision'], reason='isolated simulated addition')

    def test_source_create_receipt_replay_undo_preserves_originals(self):
        old = self.reviews.query('a.md')
        tree = self.tree()
        payload = self.payload()
        receipt = self.relations.create('a.md', **payload)
        current = ReviewStore(self.wiki).query('a.md')
        self.assertEqual(current['machine_graph'], old['machine_graph'])
        self.assertEqual(current['claims'], old['claims'])
        self.assertEqual(current['history'], old['history'])
        self.assertEqual(len(current['current_claims']), 2)
        self.assertEqual(len(current['effective_graph']['relations']), 2)
        self.assertEqual(current['state_revision'], receipt['state_revision'])
        self.assertEqual([name for name, value in tree.items() if self.tree()[name] != value], [])
        self.assertEqual(self.relations.request('a.md', request_id=payload['request_id'])['event_id'], receipt['event_id'])
        self.assertTrue(self.relations.create('a.md', **payload)['replayed'])
        self.relations.undo('a.md', kind='source', event_id=receipt['event_id'], request_id=uuid4().hex,
                            expected_state_revision=current['state_revision'], reason='simulation undo')
        after = self.reviews.query('a.md')
        self.assertEqual(after['effective_graph'], old['effective_graph'])
        self.assertEqual(len(after['relation_history']), 2)

    def test_policy_scope_and_source_evidence_are_distinct(self):
        payload = self.payload('policy')
        receipt = self.relations.create('a.md', **payload)
        own = self.reviews.query('a.md')
        self.assertEqual(own['effective_graph']['relations'][-1]['provenance'], {'kind':'expert_policy','event_id':receipt['event_id']})
        self.assertIsNone(own['effective_graph']['relations'][-1]['evidence'])
        other = self.reviews.query('a.md', viewpoint='business')
        self.assertEqual(other['authored_relations'][0]['status'], 'other_scope')
        self.assertEqual(len(other['effective_graph']['relations']), 1)
        with self.assertRaises(ValueError):
            RelationStore(self.wiki, {**ACTOR,'viewpoint':'business'}).undo('a.md', kind='policy', event_id=receipt['event_id'], request_id=uuid4().hex, expected_state_revision=other['state_revision'], reason='wrong scope')

    def test_bad_evidence_endpoint_failure_and_reauthorization_preserve_all_files(self):
        for change in ({'evidence':'fabricated'}, {'object':'missing'}):
            payload = self.payload(); payload['replacement'].update(change)
            tree = self.tree()
            with self.assertRaises(ValueError): self.relations.create('a.md', **payload)
            self.assertEqual(tree, self.tree())
        payload = self.payload(); tree = self.tree()
        with patch('core.modules.reviews.ledger.os.replace', side_effect=OSError('isolated failure')):
            with self.assertRaises(OSError): self.relations.create('a.md', **payload)
        self.assertEqual(tree, self.tree())
        def denied(): raise AccessDenied()
        with self.assertRaises(AccessDenied): self.relations.create('a.md', **payload, before_commit=denied)
        self.assertEqual(tree, self.tree())

    def test_stale_and_generation_guard_preserve_pending_history(self):
        self.relations.create('a.md', **self.payload())
        with self.assertRaises(ReviewConflictError): self.generate()
        payload = self.payload()
        before = self.wiki.read('a.md')
        self.wiki.save('a.md', before.content+'Changed.\n', expected_revision=before.revision)
        state = self.reviews.query('a.md')
        self.assertEqual(state['authored_relations'][0]['status'], 'pending')
        self.assertEqual(len(state['relation_history']), 1)
        payload['expected_state_revision'] = state['state_revision']
        with self.assertRaises(ValueError): self.relations.create('a.md', **payload)

    def test_concurrent_cas_only_one_creation_and_changed_replay_rejected(self):
        payload = self.payload(); barrier = Barrier(2)
        def submit(index):
            item=deepcopy(payload); item['request_id']=uuid4().hex
            barrier.wait()
            try: return self.relations.create('a.md', **item)
            except ReviewConflictError: return None
        with ThreadPoolExecutor(2) as pool: results=list(pool.map(submit, range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(len(self.reviews.query('a.md')['relation_history']), 1)
        replay=self.payload('policy'); self.relations.create('a.md', **replay)
        replay['reason']='changed'
        with self.assertRaises(ReviewConflictError): self.relations.create('a.md', **replay)

    def test_combined_limit_corrupt_journal_and_cleanup_warning(self):
        self.accept()
        payload = self.payload(); before = self.tree()
        with patch('core.modules.reviews.contracts.MAX_REVIEW_EVENTS', 1):
            with self.assertRaises(ReviewLimitError): self.relations.create('a.md', **payload)
        self.assertEqual(self.tree(), before)
        commit = ReviewStore._commit_locked
        def with_warning(owner, document, ledger, failures):
            result = commit(owner, document, ledger, failures)
            failures.append(CleanupFailure(self.root / '.wiki-simulated', OSError('simulated warning')))
            return result
        with patch.object(ReviewStore, '_commit_locked', with_warning):
            receipt = self.relations.create('a.md', **payload)
        self.assertTrue(receipt['saved'])
        self.assertEqual(len(receipt['cleanup_failures']), 1)
        self.assertTrue(self.relations.create('a.md', **payload)['replayed'])
        path = self.reviews._path('a.md')
        ledger = json.loads(path.read_bytes())
        ledger['relation_events'][0]['reason'] = 'tampered'
        path.write_bytes(canonical_json_bytes(ledger))
        before = self.tree()
        with self.assertRaises(ReviewCorruptError): self.reviews.query('a.md')
        with self.assertRaises(ReviewCorruptError): self.relations.create('a.md', **payload)
        self.assertEqual(self.tree(), before)

    def test_cleanup_and_addition_histories_coexist_and_old_prefix_is_restored(self):
        state = self.reviews.query('a.md')
        self.reviews.review('a.md', action='reject', claim_id=state['claims'][0]['claim_id'],
            expected_state_revision=state['state_revision'], reason='simulation', actor=ACTOR)
        cleanup = CleanupStore(self.wiki, ACTOR)
        preview = cleanup.preview('a.md')
        cleanup.apply('a.md', request_id=uuid4().hex, preview_revision=preview['preview_revision'],
            item_ids=[item['item_id'] for item in preview['items']], reason='simulation cleanup')
        created = self.relations.create('a.md', **self.payload())
        old_bytes = self.reviews._path('a.md').read_bytes()
        old = self.reviews.query('a.md')
        self.relations.undo('a.md', kind='source', event_id=created['event_id'], request_id=uuid4().hex,
            expected_state_revision=old['state_revision'], reason='simulation undo')
        latest = self.reviews.query('a.md')
        ledger = self.reviews._ledger(self.reviews._path('a.md').read_bytes(), 'a.md')
        self.assertEqual(_review_prefix(ledger, sha256(old_bytes).hexdigest()), 1)
        self.assertEqual(latest['current_claims'], [])
        self.assertEqual(latest['history'], old['history'])
        self.assertEqual(ledger['cleanup_events'], json.loads(old_bytes)['cleanup_events'])
        baseline = {key: old[key] for key in ('source_revision', 'graph_revision', 'review_revision', 'history_revision')}
        impact = ImpactStore(self.wiki).query('a.md', baseline=baseline)
        self.assertTrue(impact['restoration']['complete'])
        self.assertIn('authored_relation_events_include_baseline_history', impact['restoration']['limits'])

    def test_addition_only_prefix_survives_later_source_review(self):
        self.relations.create('a.md', **self.payload())
        old_bytes = self.reviews._path('a.md').read_bytes()
        self.accept()
        ledger = self.reviews._ledger(self.reviews._path('a.md').read_bytes(), 'a.md')
        self.assertEqual(_review_prefix(ledger, sha256(old_bytes).hexdigest()), 0)
