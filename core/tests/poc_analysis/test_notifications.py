"""Isolated synthetic approval/concurrency/storage contracts; no user documents."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
import json
from unittest.mock import patch
from uuid import uuid4
import unittest

from core.api.v1.analysis_plans.schemas import CreateConversion
from core.api.v1.notifications.schemas import Approve, Claim, CreateWorkflow, Execution, PageDecisions, ReadFlags, ReportedEvent
from core.modules.analysis_jobs.contracts import JobConflictError, JobValidationError
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_plans.store import PlanStore
from core.modules.notifications.store import LOW, NotificationStore, identity, review_pages
from core.tests.poc_analysis.test_registration import RegistrationTest


class NotificationTest(unittest.TestCase):
    setUp = RegistrationTest.setUp
    auth = RegistrationTest.auth
    new = RegistrationTest.new
    query = RegistrationTest.query
    claim = RegistrationTest.claim
    prepare = RegistrationTest.prepare
    save_markdown = RegistrationTest.save_markdown
    graph_args = RegistrationTest.graph_args

    def service(self, actor=None):
        return NotificationStore(self.store, actor or self.actor, rulesets=self.rules)

    def conversion(self):
        staged = self.sources.stage(BytesIO(b'%PDF-1.4\n% synthetic approval fixture\n%%EOF\n'),
                                    kind='file', title='PDF', format='pdf', filename='fixture.pdf')
        registered = self.sources.commit(staged, **self.scope, request_id=uuid4().hex, authorize=self.auth)
        catalog = self.sources.get_source(registered['receipt']['source_id'])
        original = catalog['versions'][-1]
        self.source = {key: original[key] for key in ('source_id', 'source_version', 'source_sha256')}
        self.source['registration_revision'] = catalog['registration_revision']
        self.conversion_body = CreateConversion(request_id=uuid4().hex, source_ref=self.source, method='ocr', complete=False,
            unread_ranges=[f'page 1: {LOW}', f'page 2: {LOW}'], warnings=[LOW], units=[
                dict(unit_id='page1', location=dict(kind='pages', start=1, end=1), content='Synthetic retained text one.'),
                dict(unit_id='page2', location=dict(kind='pages', start=2, end=2), content='Synthetic retained text two.')])
        result = PlanStore(self.store, self.actor, rulesets=self.rules).conversion(self.conversion_body, self.auth)
        self.reference = dict(conversion_id=result['manifest']['id'], conversion_revision=result['revision'])
        self.workflow_id = result['manifest']['id']
        self.request.update(source_ref=self.source, conversion_ref=self.reference)
        return result

    def detail(self):
        return self.service().detail(self.workflow_id)['workflow']

    def mutate(self, operation, model, **kwargs):
        body = model(request_id=uuid4().hex, expected_revision=self.detail()['revision'], **kwargs)
        return self.service().mutate(self.workflow_id, operation, body, self.auth)['workflow']

    def approve(self):
        self.mutate('pages', PageDecisions, decisions=[dict(page=p, state='usable') for p in (1, 2)])
        return self.mutate('approve', Approve, device_id='1' * 32, device_name='Approval PC', target_document='pump.md')

    def grant(self):
        return self.mutate('claim', Claim, device_id='2' * 32, device_name='Execution PC')

    def link(self, workflow):
        self.request['request_id'] = workflow['resume_request_id']
        registered = self.jobs.create_registration(**self.request)
        self.job_id = registered['job_id']
        linked = self.service().mutate(self.workflow_id, 'execution', Execution(request_id=uuid4().hex,
            expected_revision=workflow['revision'], claim_id=workflow['execution']['claim_id'], job_id=self.job_id), self.auth)['workflow']
        return linked

    def test_read_page_hold_final_approval_and_exactly_one_executor(self):
        original = self.conversion()
        notices = self.service().list()
        self.assertEqual((notices['unread_count'], notices['approval_count']), (1, 1))
        self.service().read_flags(ReadFlags(notification_ids=[notices['items'][0]['notification_id']], read=True), self.auth)
        self.assertEqual(self.detail()['state'], 'review')
        with self.assertRaises(JobConflictError):
            self.jobs.create_registration(**self.request)
        self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='held'), dict(page=2, state='usable')])
        with self.assertRaises(JobConflictError):
            self.mutate('approve', Approve, device_id='1' * 32, device_name='A', target_document='pump.md')
        approved = self.approve()
        self.assertEqual(self.service().list()['approval_count'], 0)
        with self.assertRaises(JobConflictError):
            self.jobs.create_registration(**self.request)  # must share stable resume ID
        granted = self.grant()
        linked = self.link(granted)
        job = self.jobs.query(self.job_id, **self.scope)
        args = dict(**self.scope, expected_job_revision=job['job_revision'], authorize=self.auth)
        with self.assertRaises(JobConflictError):
            self.jobs.claim(self.job_id, **args)
        with self.assertRaises(JobConflictError):
            self.jobs.claim(self.job_id, **args, execution_claim_id='f' * 32)
        claimed = self.jobs.claim(self.job_id, **args, execution_claim_id=linked['execution']['claim_id'])
        self.assertIsNotNone(claimed['run_id'])
        with self.assertRaises(JobConflictError) as replay:
            self.jobs.claim(self.job_id, **args, execution_claim_id=linked['execution']['claim_id'])
        self.assertEqual(replay.exception.code, 'execution_claim_consumed')
        preserved = PlanStore(self.store, self.actor).read('conversions', self.workflow_id)
        self.assertEqual(preserved['manifest'], original['manifest'])
        self.assertEqual(preserved['components'], original['components'])
        self.assertFalse(preserved['manifest']['complete'])
        self.assertNotEqual(approved['approval']['device_id'], self.detail()['execution']['device_id'])

    def test_two_pc_cas_approval_and_grant(self):
        self.conversion()
        self.mutate('pages', PageDecisions, decisions=[dict(page=p, state='usable') for p in (1, 2)])
        def compete(operation, model, extra):
            revision = self.detail()['revision']
            def submit(index):
                try:
                    return self.service().mutate(self.workflow_id, operation, model(request_id=uuid4().hex,
                        expected_revision=revision, device_id=str(index + 1) * 32, device_name=f'PC{index}', **extra), self.auth)
                except JobConflictError as error:
                    return error.code
            with ThreadPoolExecutor(max_workers=2) as workers:
                results = list(workers.map(submit, (0, 1)))
            self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        compete('approve', Approve, dict(target_document='pump.md'))
        compete('claim', Claim, {})

    def test_failed_notification_write_preserves_conversion_and_reconciles_once(self):
        with patch.object(NotificationStore, 'database', side_effect=OSError('simulated notification disk error')):
            converted = self.conversion()
        original = PlanStore(self.store, self.actor).read('conversions', self.workflow_id)
        self.assertEqual(original['revision'], converted['revision'])
        notices = self.service().list()
        self.assertEqual(len(notices['items']), 1)
        self.assertEqual(len(self.service().list()['items']), 1)
        directory = self.service().root / 'outbox' / identity(*self.service().scope)
        self.assertEqual(list(directory.iterdir()), [])

    def test_failed_approval_transaction_keeps_draft_and_history(self):
        self.conversion()
        before = self.detail()
        with patch.object(NotificationStore, '_event', side_effect=OSError('simulated transaction write failure')):
            with self.assertRaises(OSError):
                self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='usable')])
        self.assertEqual(self.detail(), before)

    def test_current_access_profile_user_and_stale_report(self):
        self.conversion()
        for actor in (dict(self.actor, user_id='bob'), dict(self.actor, profile_id='other'), dict(self.actor, tenant='other')):
            self.assertEqual(self.service(actor).list()['items'], [])
            with self.assertRaises(FileNotFoundError):
                self.service(actor).detail(self.workflow_id)
        self.actor['access_revision'] = 'c' * 64
        with self.assertRaises(JobConflictError) as stale:
            self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='usable')])
        self.assertEqual(stale.exception.code, 'access_basis_changed')
        with self.assertRaises(Exception):
            self.service().create(CreateWorkflow(request_id=uuid4().hex, source_ref=self.source,
                conversion_ref=dict(self.reference, conversion_revision='d' * 64), title='PDF'), self.auth)

    def test_mutation_replay_conflict_and_restart(self):
        self.conversion()
        body = PageDecisions(request_id=uuid4().hex, expected_revision=self.detail()['revision'],
                             decisions=[dict(page=1, state='usable')])
        first = self.service().mutate(self.workflow_id, 'pages', body, self.auth)
        restarted = self.service().mutate(self.workflow_id, 'pages', body, self.auth)
        self.assertEqual(first['workflow'], restarted['workflow'])
        self.assertTrue(restarted['replayed'])
        with self.assertRaises(JobConflictError):
            self.service().mutate(self.workflow_id, 'pages', body.model_copy(update={
                'decisions': PageDecisions(request_id=body.request_id, expected_revision=body.expected_revision,
                    decisions=[dict(page=2, state='held')]).decisions}), self.auth)

    def test_hard_errors_or_missing_text_are_not_approvable(self):
        report = self.conversion()
        manifest = deepcopy(report['manifest'])
        manifest['unread_ranges'].append('remaining source: conversion_checkpoint_read_failed')
        self.assertEqual(review_pages(manifest, report['components']), [])
        self.assertEqual(review_pages(report['manifest'], dict(report['components'], page1=' ')), [])

    def test_index_pagination_isolation_and_no_text_copy(self):
        self.conversion()
        service = self.service()
        with service.sources._coordination_lock():
            with service.database() as db:
                value = service._get(db, self.workflow_id)
                for index in range(150):
                    service._event(db, value, 'failed', identity('event', str(index)), notify=True)
                plan = db.execute('EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE tenant=? AND user_id=? '
                    'AND profile=? AND sequence<? ORDER BY sequence DESC LIMIT 30', (*service.scope, 999999)).fetchall()
                self.assertTrue(any('notification_page' in row[3] for row in plan))
        first = service.list(limit=30)
        second = service.list(limit=30, cursor=first['next_cursor'])
        self.assertEqual(len(first['items']), 30)
        self.assertFalse({v['notification_id'] for v in first['items']} & {v['notification_id'] for v in second['items']})
        data = (service.root / 'notifications.sqlite3').read_bytes()
        self.assertNotIn(b'Synthetic retained text one', data)

    def test_txt_completion_and_failure_are_receipt_based(self):
        self.new(); self.claim()
        job = self.query()
        self.jobs.update(self.job_id, **self.scope, run_id=job['run_id'], expected_job_revision=job['job_revision'],
            reported_status='failed', message='fixture failure', authorize=self.auth)
        notices = self.service().list()['items']
        self.assertEqual([v['kind'] for v in notices], ['failed'])
        self.claim(reclaim=True); self.save_markdown()
        self.assertNotIn('completed', [v['kind'] for v in self.service().list()['items']])
        args, _ = self.graph_args()
        self.results.generate_ontology(self.job_id, **args)
        notices = self.service().list()['items']
        self.assertEqual([v['kind'] for v in notices], ['completed', 'failed'])
        self.assertIsNone(notices[0]['conversion_ref'])

    def test_client_failure_is_labeled_and_cannot_claim_completion(self):
        payload = ReportedEvent(request_id=uuid4().hex, source_ref=self.source, title='Local conversion stopped',
                                kind='stopped', device_id='1' * 32, device_name='A')
        self.service().reported_event(payload, self.auth)
        self.service().reported_event(payload, self.auth)
        notice = self.service().list()['items'][0]
        self.assertEqual(notice['origin'], 'client_reported')
        self.assertEqual(len(self.service().list()['items']), 1)

    def test_resolved_approval_filter_and_independent_event_change_watermarks(self):
        self.conversion()
        before = self.service().list()
        self.approve()
        self.assertEqual(self.service().list(filter='approval')['items'], [])
        self.assertEqual(self.service().list()['items'][0]['state'], 'approved')
        self.assertEqual(self.service().list(after_seq=before['latest_sequence'])['items'], [])
        changed = self.service().list(after_change_seq=before['latest_change_sequence'])['items']
        self.assertEqual(len(changed), 1)
        self.assertEqual(changed[0]['sequence'], before['items'][0]['sequence'])

    def test_new_report_invalidates_old_approval_without_modifying_old_report(self):
        old = self.conversion()
        self.approve()
        fresh = self.conversion_body.model_copy(update={'request_id': uuid4().hex})
        PlanStore(self.store, self.actor, rulesets=self.rules).conversion(fresh, self.auth)
        with self.assertRaises(JobConflictError) as stale:
            self.grant()
        self.assertEqual(stale.exception.code, 'conversion_basis_changed')
        self.assertEqual(PlanStore(self.store, self.actor).read('conversions', self.workflow_id)['manifest'], old['manifest'])

    def test_claim_write_failure_requires_explicit_reclaim_and_no_old_grant_reuse(self):
        self.conversion(); self.approve()
        granted = self.link(self.grant())
        old_claim = granted['execution']['claim_id']
        job = self.query()
        original_write = self.jobs._write
        def fail_lease(path, value):
            if path.parent.name == 'leases':
                raise OSError('simulated lease write interruption')
            return original_write(path, value)
        with patch.object(self.jobs, '_write', side_effect=fail_lease):
            with self.assertRaises(OSError):
                self.jobs.claim(self.job_id, **self.scope, expected_job_revision=job['job_revision'],
                                authorize=self.auth, execution_claim_id=old_claim)
        with self.assertRaises(JobConflictError):
            self.jobs.claim(self.job_id, **self.scope, expected_job_revision=job['job_revision'],
                            authorize=self.auth, execution_claim_id=old_claim)
        reclaimed = self.mutate('claim', Claim, reclaim=True, device_id='3' * 32, device_name='Recovery PC')
        self.assertNotEqual(reclaimed['execution']['claim_id'], old_claim)
        self.assertEqual(reclaimed['execution']['job_id'], self.job_id)
        execution = self.jobs.claim(self.job_id, **self.scope, expected_job_revision=job['job_revision'],
                         authorize=self.auth, execution_claim_id=reclaimed['execution']['claim_id'])
        self.assertEqual(execution['state'], 'claimed')

    def test_page_decision_history_keeps_actual_prior_decisions(self):
        self.conversion()
        self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='held')])
        self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='usable')])
        events = self.service().detail(self.workflow_id)['events']
        self.assertEqual([event['details']['decisions'][0]['state'] for event in events if event['kind'] == 'pages'],
                         ['held', 'usable'])


    def test_saved_results_survive_notification_failure_and_deliver_once(self):
        self.new(); self.claim(); self.save_markdown()
        args, _ = self.graph_args()
        with patch.object(NotificationStore, 'database', side_effect=OSError('simulated delivery outage')):
            saved = self.results.generate_ontology(self.job_id, **args)
        self.assertTrue(saved['saved'])
        self.assertEqual(saved['state'], 'complete')
        revision = self.store.read('pump.md').revision
        self.assertEqual([n['kind'] for n in self.service().list()['items']], ['completed'])
        self.assertEqual([n['kind'] for n in self.service().list()['items']], ['completed'])
        self.assertEqual(self.store.read('pump.md').revision, revision)

    def test_two_process_claim_calls_consume_one_grant(self):
        self.conversion(); self.approve()
        linked = self.link(self.grant())
        revision = self.query()['job_revision']
        def start(_):
            try:
                return JobStore(self.store, rulesets=self.rules).claim(self.job_id, **self.scope,
                    expected_job_revision=revision, authorize=self.auth, execution_claim_id=linked['execution']['claim_id'])
            except JobConflictError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as workers:
            attempts = list(workers.map(start, (0, 1)))
        self.assertEqual(sum(isinstance(result, dict) for result in attempts), 1)
        self.assertIn('execution_claim_consumed', attempts)

    def test_existing_report_explicit_initialization_preserves_manifest(self):
        with patch('core.modules.notifications.store.review_pages', return_value=[]):
            original = self.conversion()
        self.assertNotIn('approval_workflow_id', original['manifest'])
        self.assertEqual(self.service().list()['items'], [])
        initialized = self.service().create(CreateWorkflow(request_id=uuid4().hex, source_ref=self.source,
            conversion_ref=self.reference, title='Old report', target_document='pump.md'), self.auth)
        self.assertGreaterEqual(initialized['workflow']['created_at'], original['manifest']['created_at'])
        events = self.service().detail(self.workflow_id)['events']
        self.assertEqual(events[0]['details']['initialization'], 'existing_report')
        self.assertEqual(PlanStore(self.store, self.actor).read('conversions', self.workflow_id)['manifest'], original['manifest'])

    def test_expiry_notification_is_observed_once_and_requires_explicit_new_grant(self):
        from datetime import timedelta
        self.conversion(); self.approve()
        linked = self.link(self.grant())
        self.jobs.claim(self.job_id, **self.scope, expected_job_revision=self.query()['job_revision'],
            authorize=self.auth, execution_claim_id=linked['execution']['claim_id'])
        later = self.jobs._now() + timedelta(minutes=6)
        service = NotificationStore(self.store, self.actor, rulesets=self.rules, clock=lambda: later)
        first = service.list()
        self.assertEqual([n['kind'] for n in first['items']], ['stopped', 'approval_required'])
        self.assertEqual(service.detail(self.workflow_id)['workflow']['state'], 'stopped')
        self.assertEqual(len(service.list()['items']), 2)
        self.assertEqual(self.query()['run_id'], self.detail()['execution']['run_id'])


    def test_new_report_delivery_failure_still_blocks_old_approval(self):
        self.conversion(); self.approve()
        fresh = self.conversion_body.model_copy(update={'request_id': uuid4().hex})
        with patch.object(NotificationStore, 'database', side_effect=OSError('simulated delivery outage')):
            PlanStore(self.store, self.actor, rulesets=self.rules).conversion(fresh, self.auth)
        with patch.object(NotificationStore, 'reconcile_locked', return_value=None):
            with self.assertRaises(JobConflictError) as stale:
                self.grant()
        self.assertEqual(stale.exception.code, 'conversion_basis_changed')


    def test_new_report_settles_old_review_and_preserves_approval_history(self):
        original = self.conversion(); approved = self.approve()
        before = self.service().list()['latest_sequence']
        fresh = self.conversion_body.model_copy(update={'request_id': uuid4().hex})
        new = PlanStore(self.store, self.actor, rulesets=self.rules).conversion(fresh, self.auth)
        listing = self.service().list(filter='approval')
        self.assertEqual(listing['approval_count'], 1)
        self.assertEqual([item['workflow_id'] for item in listing['items']], [new['manifest']['id']])
        old = self.service().detail(self.workflow_id)
        self.assertEqual(old['workflow']['state'], 'stopped')
        self.assertEqual(old['workflow']['blocked_reason'], 'report_changed')
        self.assertEqual(old['workflow']['approval'], approved['approval'])
        self.assertEqual(old['workflow']['pages'], approved['pages'])
        self.assertEqual(old['conversion']['manifest'], original['manifest'])
        obsolete = [event for event in old['events'] if event['kind'] == 'approval_obsolete']
        self.assertEqual(len(obsolete), 1)
        self.assertEqual(obsolete[0]['details']['blocked_reason'], 'report_changed')
        self.assertEqual([item['workflow_id'] for item in self.service().list(after_seq=before)['items']], [new['manifest']['id']])
        self.assertEqual(len([event for event in self.service().detail(self.workflow_id)['events']
                              if event['kind'] == 'approval_obsolete']), 1)

    def test_new_source_settles_review_without_touching_report_or_running_job(self):
        original = self.conversion()
        staged = self.sources.stage(BytesIO(b'%PDF-1.4\n% replacement fixture\n%%EOF\n'), kind='file',
                                    title='PDF revision', format='pdf', filename='fixture.pdf')
        self.sources.commit(staged, **self.scope, request_id=uuid4().hex, source_id=self.source['source_id'],
            expected_registration_revision=self.source['registration_revision'], authorize=self.auth)
        listing = self.service().list(filter='approval')
        self.assertEqual((listing['approval_count'], listing['items']), (0, []))
        old = self.service().detail(self.workflow_id)
        self.assertEqual((old['workflow']['state'], old['workflow']['blocked_reason']), ('stopped', 'source_changed'))
        self.assertEqual(old['conversion']['manifest'], original['manifest'])

    def test_delayed_obsolete_outbox_is_retained_settled_and_not_retried(self):
        with patch.object(NotificationStore, 'database', side_effect=OSError('simulated disconnected metadata')):
            original = self.conversion()
        old_id = self.workflow_id
        service = self.service()
        old_path = service.pending_path('conversion', old_id)
        original_pointer = json.loads(old_path.read_text())
        fresh = self.conversion_body.model_copy(update={'request_id': uuid4().hex})
        new = PlanStore(self.store, self.actor, rulesets=self.rules).conversion(fresh, self.auth)
        first = service.list()
        self.assertEqual(first['approval_count'], 1)
        old_notice = next(item for item in first['items'] if item['workflow_id'] == old_id)
        self.assertEqual(old_notice['blocked_reason'], 'report_changed')
        archive = service.root / 'outbox_settled' / identity(*service.scope) / old_path.name
        settled = json.loads(archive.read_text())
        self.assertEqual(settled['outbox'], original_pointer)
        self.assertEqual((settled['delivery_state'], settled['blocked_reason']), ('obsolete', 'report_changed'))
        self.assertFalse(old_path.exists())
        before = archive.read_bytes()
        with patch.object(NotificationStore, '_deliver', side_effect=AssertionError('settled work was retried')):
            after = service.list(after_seq=first['latest_sequence'])
        self.assertEqual(after['items'], [])
        self.assertEqual(archive.read_bytes(), before)
        self.assertEqual(service.detail(old_id)['conversion']['manifest'], original['manifest'])
        self.assertEqual([item['workflow_id'] for item in service.list(filter='approval')['items']], [new['manifest']['id']])

    def test_expired_unlinked_claim_is_shared_stopped_and_another_pc_can_reclaim(self):
        from datetime import timedelta
        self.conversion(); self.approve()
        granted = self.grant()
        later = self.jobs._now() + timedelta(minutes=6)
        service = NotificationStore(self.store, self.actor, rulesets=self.rules, clock=lambda: later)
        stopped = service.detail(self.workflow_id)
        self.assertEqual(stopped['workflow']['state'], 'stopped')
        self.assertIsNone(stopped['workflow']['execution']['job_id'])
        self.assertEqual(len([event for event in stopped['events'] if event['kind'] == 'stopped']), 1)
        self.assertEqual(len([event for event in service.detail(self.workflow_id)['events'] if event['kind'] == 'stopped']), 1)
        body = Claim(request_id=uuid4().hex, expected_revision=stopped['workflow']['revision'], reclaim=True,
                     device_id='3' * 32, device_name='Another PC')
        new = service.mutate(self.workflow_id, 'claim', body, self.auth)['workflow']
        self.assertEqual((new['state'], new['execution']['device_id']), ('claimed', '3' * 32))
        self.assertNotEqual(new['execution']['claim_id'], granted['execution']['claim_id'])

    def test_new_report_does_not_retroactively_stop_running_approved_job(self):
        self.conversion(); self.approve(); linked = self.link(self.grant())
        claimed = self.jobs.claim(self.job_id, **self.scope, expected_job_revision=self.query()['job_revision'],
            authorize=self.auth, execution_claim_id=linked['execution']['claim_id'])
        fresh = self.conversion_body.model_copy(update={'request_id': uuid4().hex})
        PlanStore(self.store, self.actor, rulesets=self.rules).conversion(fresh, self.auth)
        old = self.service().detail(self.workflow_id)['workflow']
        self.assertEqual(old['state'], 'running')
        self.assertNotIn('blocked_reason', old)
        self.assertEqual(self.query()['run_id'], claimed['run_id'])
        staged = self.sources.stage(BytesIO(b'%PDF-1.4\n% newer source fixture\n%%EOF\n'), kind='file',
                                    title='PDF replacement', format='pdf', filename='fixture.pdf')
        self.sources.commit(staged, **self.scope, request_id=uuid4().hex, source_id=self.source['source_id'],
            expected_registration_revision=self.source['registration_revision'], authorize=self.auth)
        self.assertEqual(self.service().detail(self.workflow_id)['workflow']['state'], 'running')
        self.assertEqual(self.query()['run_id'], claimed['run_id'])


    def test_delayed_source_changed_outbox_settles_without_repeated_delivery(self):
        with patch.object(NotificationStore, 'database', side_effect=OSError('simulated offline delivery')):
            original = self.conversion()
        service = self.service()
        pending = service.pending_path('conversion', self.workflow_id)
        pointer = pending.read_bytes()
        staged = self.sources.stage(BytesIO(b'%PDF-1.4\n% changed fixture\n%%EOF\n'), kind='file',
                                    title='PDF changed', format='pdf', filename='fixture.pdf')
        self.sources.commit(staged, **self.scope, request_id=uuid4().hex, source_id=self.source['source_id'],
            expected_registration_revision=self.source['registration_revision'], authorize=self.auth)
        listed = service.list()
        self.assertEqual(listed['approval_count'], 0)
        self.assertEqual(listed['items'][0]['blocked_reason'], 'source_changed')
        archive = service.root / 'outbox_settled' / identity(*service.scope) / pending.name
        record = json.loads(archive.read_text())
        self.assertEqual(record['outbox'], json.loads(pointer))
        self.assertEqual(record['blocked_reason'], 'source_changed')
        self.assertFalse(pending.exists())
        with patch.object(NotificationStore, '_deliver', side_effect=AssertionError('obsolete intent retried')):
            self.assertEqual(service.list(after_seq=listed['latest_sequence'])['items'], [])
        self.assertEqual(service.detail(self.workflow_id)['conversion']['manifest'], original['manifest'])


    def test_expired_linked_but_unstarted_claim_is_also_recoverable(self):
        from datetime import timedelta
        self.conversion(); self.approve(); linked = self.link(self.grant())
        later = self.jobs._now() + timedelta(minutes=6)
        service = NotificationStore(self.store, self.actor, rulesets=self.rules, clock=lambda: later)
        stopped = service.detail(self.workflow_id)['workflow']
        self.assertEqual(stopped['state'], 'stopped')
        self.assertEqual(stopped['execution']['job_id'], self.job_id)
        reclaimed = service.mutate(self.workflow_id, 'claim', Claim(request_id=uuid4().hex,
            expected_revision=stopped['revision'], reclaim=True, device_id='3' * 32, device_name='Another PC'), self.auth)['workflow']
        self.assertEqual(reclaimed['execution']['job_id'], linked['execution']['job_id'])
        self.assertNotEqual(reclaimed['execution']['claim_id'], linked['execution']['claim_id'])


class NotificationAPITest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from core.tests.poc_analysis.test_source_preview import SourcePreviewTests
        await SourcePreviewTests.asyncSetUp(self)
        self.base = f'/api/v1/tenants/{self.tenant}'
        source_ref = {key: self.source[key] for key in ('source_id', 'source_version', 'source_sha256')}
        source_ref['registration_revision'] = self.query['registration_revision']
        response = await self.http.post(self.base + '/analysis-conversions', json=dict(request_id=uuid4().hex,
            source_ref=source_ref, method='ocr', complete=False, unread_ranges=[f'page 1: {LOW}'], warnings=[LOW],
            units=[dict(unit_id='p1', location=dict(kind='pages', start=1, end=1), content='Synthetic page text')]))
        self.assertEqual(response.status_code, 201, response.text)
        self.workflow_id = response.json()['data']['manifest']['id']

    async def test_authenticated_route_read_flags_cas_and_strict_body(self):
        listed = await self.http.get(self.base + '/notifications', params={'limit': '30', 'after_seq': '0'})
        self.assertEqual(listed.status_code, 200, listed.text)
        data = listed.json()['data']
        item = data['items'][0]
        detail = await self.http.get(self.base + '/notification-workflows/' + self.workflow_id)
        workflow = detail.json()['data']['workflow']
        read = await self.http.post(self.base + '/notifications/read', json=dict(notification_ids=[item['notification_id']], read=True))
        self.assertEqual(read.status_code, 200, read.text)
        page = await self.http.post(self.base + '/notification-workflows/' + self.workflow_id + '/pages',
            json=dict(request_id=uuid4().hex, expected_revision=workflow['revision'], decisions=[dict(page=1, state='usable')]))
        self.assertEqual(page.status_code, 200, page.text)
        forged = await self.http.post(self.base + '/notification-workflows/' + self.workflow_id + '/approve',
            json=dict(request_id=uuid4().hex, expected_revision=page.json()['data']['workflow']['revision'],
                      device_id='1' * 32, device_name='A', target_document='test.md', user_id='someone-else'))
        self.assertEqual(forged.status_code, 422)
        denied = await self.http.get(self.base + '/notifications', headers={'Authorization': 'Bearer invalid'})
        self.assertEqual(denied.status_code, 401)
