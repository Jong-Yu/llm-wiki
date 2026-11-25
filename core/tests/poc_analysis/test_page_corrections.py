"""보류 해결의 불변 보정·충돌·실패·고정 입력을 합성 자료로 검증한다."""
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch
from uuid import uuid4

from pydantic import ValidationError

from core.api.v1.analysis_jobs.schemas import CreateRegistration
from core.api.v1.analysis_plans.schemas import CreateConversion
from core.api.dependencies import access_value
from core.api.v1.notifications.schemas import Approve, PageCorrection, PageDecisions
from core.modules.analysis_inputs.contracts import InputConflictError, InputCorruptError, InputLimitError
from core.modules.analysis_jobs import records, registration
from core.modules.analysis_jobs.contracts import JobConflictError, JobValidationError
from core.modules.analysis_plans import corrections
from core.modules.analysis_plans.store import PlanStore, stable_id
from core.modules.notifications.store import LOW, NotificationStore
from core.tests.poc_analysis import test_notifications as notification_cases
from core.tests.poc_analysis import test_registration as registration_cases
from core.tests.poc_analysis import test_source_preview as preview_cases


class PageCorrectionTests(unittest.TestCase):
    setUp = registration_cases.RegistrationTest.setUp
    auth = registration_cases.RegistrationTest.auth
    service = notification_cases.NotificationTest.service
    conversion = notification_cases.NotificationTest.conversion
    detail = notification_cases.NotificationTest.detail
    mutate = notification_cases.NotificationTest.mutate
    grant = notification_cases.NotificationTest.grant
    link = notification_cases.NotificationTest.link

    def body(self, **changes):
        return PageCorrection(**dict(request_id=uuid4().hex, expected_revision=self.detail()['revision'],
            page=1, content='Corrected synthetic page one. 보존할 문자.', method='manual', **changes))

    def correct(self, body=None):
        return self.service().mutate(self.workflow_id, 'corrections', body or self.body(), self.auth)

    def approve(self):
        pages = self.detail()['pages']
        self.mutate('pages', PageDecisions, decisions=[dict(page=page['page'], state='usable',
            **({'correction_ref': page['correction_ref']} if page.get('correction_ref') else {})) for page in pages])
        return self.mutate('approve', Approve, device_id='1' * 32, device_name='Approval PC', target_document='pump.md',
            correction_refs=[dict(page=page['page'], correction_ref=page['correction_ref']) for page in pages if page.get('correction_ref')])

    def original_bytes(self):
        root = PlanStore(self.store, self.actor)._path('conversions', self.workflow_id)
        return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob('*') if path.is_file()}

    def test_hold_correct_recheck_approve_preserves_original_and_prior_corrections(self):
        original = self.conversion(); before = self.original_bytes()
        self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='held'), dict(page=2, state='usable')])
        body = self.body()
        saved = self.correct(body)['workflow']
        self.assertEqual([page['state'] for page in saved['pages']], ['pending', 'usable'])
        self.assertIsNone(saved['approval'])
        detail = self.service().detail(self.workflow_id)
        self.assertEqual(detail['corrections'][0]['content'], body.content)
        self.assertEqual(detail['corrections'][0]['request_id'], body.request_id)
        self.assertEqual(detail['conversion']['manifest'], original['manifest'])
        first_ref = detail['corrections'][0]['correction_ref']
        first = PlanStore(self.store, self.actor).read('corrections', first_ref['correction_id'], first_ref['correction_revision'])
        self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='usable', correction_ref=first_ref)])
        self.assertEqual(self.detail()['pages'][0]['correction_ref'], first_ref)
        second = self.body().model_copy(update={'content': 'Second corrected synthetic page.', 'method': 'ocr', 'warnings': ['low confidence remains']})
        self.correct(second)
        self.assertEqual(self.detail()['pages'][0]['state'], 'pending')
        self.assertEqual(PlanStore(self.store, self.actor).read('corrections', first_ref['correction_id']), first)
        self.assertEqual(self.original_bytes(), before)
        approved = self.approve()
        self.assertEqual(approved['approval']['pages'], approved['pages'])
        with self.assertRaises(JobConflictError):
            self.correct()
        self.assertFalse(detail['conversion']['manifest']['complete'])
        with self.service().database() as db:
            for table in ('workflows', 'events', 'notifications', 'requests'):
                self.assertNotIn('Corrected synthetic page one.', '\n'.join(str(tuple(row)) for row in db.execute(f'SELECT * FROM {table}')))

    def test_database_failure_retains_unapplied_record_and_exact_retry(self):
        self.conversion(); before = self.detail(); original = self.original_bytes(); body = self.body()
        with patch.object(NotificationStore, '_event', side_effect=OSError('synthetic DB write failure')):
            with self.assertRaises(OSError):
                self.correct(body)
        self.assertEqual(self.detail(), before)
        self.assertEqual(self.service().detail(self.workflow_id)['corrections'], [])
        correction_id = stable_id('corrections', self.actor['tenant'], self.actor['user_id'], body.request_id)
        plans = PlanStore(self.store, self.actor)
        orphan = plans.read('corrections', correction_id)
        with self.assertRaises(InputConflictError):
            self.correct(body.model_copy(update={'content': 'Different text under the same request.'}))
        result = self.correct(body)
        self.assertEqual(result['workflow']['pages'][0]['correction_ref']['correction_revision'], orphan['revision'])
        self.assertEqual(plans.read('corrections', correction_id), orphan)
        replay = self.correct(body)
        self.assertTrue(replay['replayed'])
        with self.assertRaises(JobConflictError):
            self.correct(body.model_copy(update={'method': 'ocr'}))
        self.assertEqual(self.original_bytes(), original)

    def test_publish_failure_and_reauthorization_denial_keep_workflow(self):
        self.conversion(); before = self.detail(); body = self.body()
        with patch('core.modules.analysis_plans.store.inputs_files.publish', side_effect=OSError('synthetic file publish failure')):
            with self.assertRaises(OSError):
                self.correct(body)
        self.assertEqual(self.detail(), before)
        denied = iter([self.auth(), PermissionError('synthetic permission revocation')])
        def authorize():
            current = next(denied)
            if isinstance(current, Exception):
                raise current
            return current
        with self.assertRaises(PermissionError):
            self.service().mutate(self.workflow_id, 'corrections', body, authorize)
        self.assertEqual(self.detail(), before)
        path = PlanStore(self.store, self.actor)._path('corrections', stable_id('corrections', *self.service().scope[:2], body.request_id))
        self.assertFalse(path.exists())

    def test_two_pc_corrections_compete_without_silent_overwrite(self):
        self.conversion(); revision = self.detail()['revision']
        def write(index):
            body = PageCorrection(request_id=uuid4().hex, expected_revision=revision, page=1,
                                  method='manual', content=f'PC {index} corrected text.')
            try:
                return self.correct(body)
            except JobConflictError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(write, (1, 2)))
        self.assertEqual(sum(isinstance(value, dict) for value in results), 1)
        self.assertEqual(results.count('conflict'), 1)
        detail = self.service().detail(self.workflow_id)
        self.assertEqual(len(detail['corrections']), 1)
        self.assertEqual(len([event for event in detail['events'] if event['kind'] == 'corrections']), 1)

    def test_scope_page_and_current_report_are_required(self):
        self.conversion(); body = self.body(); before = self.detail()
        with self.assertRaises(JobValidationError):
            self.correct(body.model_copy(update={'page': 3}))
        for changed in ({'user_id': 'bob'}, {'profile_id': 'other'}, {'tenant': 'other'}):
            actor = dict(self.actor, **changed)
            with self.assertRaises(FileNotFoundError):
                self.service(actor).mutate(self.workflow_id, 'corrections', body, lambda: actor)
        self.assertEqual(self.detail(), before)
        new = self.conversion_body.model_copy(update={'request_id': uuid4().hex})
        PlanStore(self.store, self.actor, rulesets=self.rules).conversion(new.model_dump(exclude={"profile"}), self.auth)
        with self.assertRaises(JobConflictError):
            self.correct(body)

    def test_input_validation_and_response_limit_preserve_data(self):
        self.conversion(); before = self.detail()
        for content in ('', ' \n', '\0', '한' * (4 * 1024 * 1024 // 3 + 1)):
            with self.assertRaises(ValidationError):
                PageCorrection(request_id=uuid4().hex, expected_revision=before['revision'], page=1, method='manual', content=content)
        with self.assertRaises(ValidationError):
            self.body(warnings=['a' * 1025])
        body = self.body()
        with patch.object(NotificationStore, '_check_detail_size', side_effect=InputLimitError('synthetic response boundary')):
            with self.assertRaises(InputLimitError):
                self.correct(body)
        self.assertEqual(self.detail(), before)

    def test_registration_freezes_only_server_approved_corrections_and_replays(self):
        self.conversion(); original = self.original_bytes(); body = self.body(); self.correct(body)
        approved = self.approve(); granted = self.grant(); self.link(granted)
        job = records.owned_state(self.jobs, self.job_id, **self.scope)
        fixed = registration.registration(job)
        self.assertEqual(fixed['approval_ref']['request_id'], approved['approval']['request_id'])
        self.assertEqual(fixed['approved_corrections'][0]['correction_ref'], approved['pages'][0]['correction_ref'])
        with patch.object(NotificationStore, '_get', side_effect=AssertionError('Live workflow must not be reread')):
            markdown, report = registration.materialize(self.jobs, job, self.actor)
        self.assertIn(body.content, markdown)
        self.assertNotIn('Synthetic retained text one.', markdown)
        self.assertIn('Synthetic retained text two.', markdown)
        self.assertEqual(report['unread_ranges'], self.conversion_body.unread_ranges)
        self.assertEqual(report['warnings'], self.conversion_body.warnings)
        self.assertFalse(report['complete'])
        self.assertEqual(report['approved_corrections'][0]['request_id'], body.request_id)
        replay = self.jobs.create_registration(**self.request)
        self.assertTrue(replay['replayed']); self.assertEqual(replay['job_id'], self.job_id)
        self.assertEqual(self.original_bytes(), original)
        with self.assertRaises(JobValidationError):
            registration.validate(fixed)  # direct job create cannot inject a trusted snapshot
        request = {key: value for key, value in self.request.items() if key not in ('tenant', 'user_id', 'authorize')}
        with self.assertRaises(ValidationError):
            CreateRegistration(**request, approved_corrections=fixed['approved_corrections'])

    def test_fixed_input_bundle_and_saved_markdown_use_correction(self):
        self.conversion(); body = self.body(); self.correct(body); self.approve(); linked = self.link(self.grant())
        job = self.jobs.query(self.job_id, **self.scope)
        self.jobs.claim(self.job_id, **self.scope, expected_job_revision=job['job_revision'],
                        authorize=self.auth, execution_claim_id=linked['execution']['claim_id'])
        # 기존 입력 묶음의 동적 참조 복원도 저장 당시 job snapshot을 사용한다.
        args, manifest, parts = registration_cases.RegistrationTest.prepare(self, 'prepare_wiki')
        self.assertIn(body.content, parts['data/registration.md'])
        result = self.results.write_wiki(self.job_id, **args, content=parts['data/registration.md'], expected_revision=None)
        self.assertTrue(result['saved'])
        self.assertIn(body.content, self.store.read('pump.md').content)

    query = registration_cases.RegistrationTest.query

    def test_correction_reference_cannot_change_page_unit_or_scope(self):
        original = self.conversion(); saved = self.correct()['workflow']; ref = saved['pages'][0]['correction_ref']
        plans = PlanStore(self.store, self.actor)
        report = dict(manifest=original['manifest'], components=original['components'])
        arguments = dict(workflow_id=self.workflow_id, source_ref=self.source, conversion_ref=self.reference, page=1, report=report)
        with self.assertRaises(InputCorruptError):
            corrections.load(plans, ref, **dict(arguments, page=2))
        with self.assertRaises(InputCorruptError):
            corrections.load(PlanStore(self.store, dict(self.actor, profile_id='other')), ref, **arguments)
        with self.assertRaises(InputCorruptError):
            corrections.load(plans, ref, **dict(arguments, source_ref=dict(self.source, source_sha256='e' * 64)))
        changed = dict(report, components=dict(report['components'], page1='A different original unit.'))
        with self.assertRaises(InputCorruptError):
            corrections.load(plans, ref, **dict(arguments, report=changed))

    def test_older_clients_cannot_approve_correction_they_did_not_display(self):
        self.conversion(); saved = self.correct()['workflow']
        ref = saved['pages'][0]['correction_ref']
        with self.assertRaises(JobConflictError) as failure:
            self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='usable')])
        self.assertEqual(failure.exception.code, 'correction_basis_changed')
        self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='usable', correction_ref=ref), dict(page=2, state='usable')])
        with self.assertRaises(JobConflictError) as failure:
            self.mutate('approve', Approve, device_id='1' * 32, device_name='Old PC', target_document='pump.md')
        self.assertEqual(failure.exception.code, 'correction_basis_changed')
        self.approve()


class PageCorrectionAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = preview_cases.SourcePreviewTests.asyncSetUp

    def fixture(self):
        scope = self.policy.authorize(self.user['token'], self.tenant, 'source_write')
        source = {key: self.source[key] for key in ('source_id', 'source_version', 'source_sha256')}
        source['registration_revision'] = self.query['registration_revision']
        body = CreateConversion(request_id=uuid4().hex, source_ref=source, method='ocr', complete=False,
            unread_ranges=[f'page 1: {LOW}'], warnings=[LOW], units=[
                dict(unit_id='p1', location=dict(kind='pages', start=1, end=1), content='Original synthetic text.'),
                dict(unit_id='p2', location=dict(kind='pages', start=2, end=2), content='Unchanged second page.')])
        result = PlanStore(scope.store, access_value(scope)).conversion(body.model_dump(exclude={"profile"}), lambda: access_value(scope))
        workflow = NotificationStore(scope.store, access_value(scope)).detail(result['manifest']['id'])['workflow']
        return workflow, f"/api/v1/tenants/{self.tenant}/notification-workflows/{workflow['workflow_id']}"

    async def test_real_route_preserves_original_and_reconciles_same_request(self):
        workflow, endpoint = self.fixture()
        body = dict(request_id=uuid4().hex, expected_revision=workflow['revision'], page=1,
                    method='manual', content='Corrected via the real API.', warnings=[])
        bad = await self.http.post(endpoint + '/corrections', json=dict(body, source_ref=workflow['source_ref']))
        self.assertEqual(bad.status_code, 422)
        response = await self.http.post(endpoint + '/corrections', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        value = response.json()['data']['workflow']
        self.assertEqual(value['pages'][0]['state'], 'pending')
        detail = (await self.http.get(endpoint)).json()['data']
        self.assertEqual(detail['conversion']['components']['p1'], 'Original synthetic text.')
        self.assertEqual(detail['corrections'][0]['content'], body['content'])
        self.assertEqual(detail['corrections'][0]['request_id'], body['request_id'])
        repeated = await self.http.post(endpoint + '/corrections', json=body)
        self.assertEqual(repeated.status_code, 200)
        self.assertTrue(repeated.json()['data']['replayed'])
        wrong = await self.http.post(endpoint + '/corrections', json=dict(body, content='Different replay.'))
        self.assertEqual(wrong.status_code, 409)

    async def test_read_only_and_unknown_token_cannot_save_correction(self):
        workflow, endpoint = self.fixture()
        body = dict(request_id=uuid4().hex, expected_revision=workflow['revision'], page=1,
                    method='manual', content='Must not be stored.')
        rejected = await self.http.post(endpoint + '/corrections', json=body,
                                       headers={'Authorization': 'Bearer ' + 'a' * 64})
        self.assertEqual(rejected.status_code, 401)
        from core.common.json_codec import canonical_json_bytes
        from core.modules.access.auth import _publish
        value, _ = self.policy._load()
        value['users'][self.user['user_id']]['memberships'][self.tenant]['permissions'] = ['read']
        _publish(self.policy.config_path, canonical_json_bytes(value), replace=True)
        response = await self.http.post(endpoint + '/corrections', json=body)
        self.assertEqual(response.status_code, 403)
        detail = await self.http.get(endpoint)
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()['data']['corrections'], [])


if __name__ == '__main__':
    unittest.main()
