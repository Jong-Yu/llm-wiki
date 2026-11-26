"""실제 누락·빈 페이지·일반 단위·전체 입력의 불변 선택 계약. 모두 격리 합성 자료다."""
from uuid import uuid4
from io import BytesIO
import unittest
from unittest.mock import patch

from pydantic import ValidationError
from core.api.v1.analysis_plans.schemas import CreateConversion, CreatePlan
from core.common.json_codec import canonical_json_hash
from core.api.v1.notifications.schemas import Approve, ContentQuery, CreateWorkflow, PageCorrection, PageDecisions
from core.modules.analysis_jobs import records, registration
from core.modules.analysis_jobs.contracts import JobConflictError, JobValidationError
from core.modules.analysis_inputs.contracts import InputLimitError
from core.modules.analysis_results.contracts import ResultError
from core.modules.analysis_plans import corrections
from core.modules.analysis_plans.store import PlanStore
from core.modules.notifications.store import LOW
from core.tests.poc_analysis import test_page_corrections as previous
from core.tests.poc_analysis import test_registration as registration_cases


class RegistrationContentTests(unittest.TestCase):
    setUp = previous.PageCorrectionTests.setUp
    auth = previous.PageCorrectionTests.auth
    service = previous.PageCorrectionTests.service
    conversion = previous.PageCorrectionTests.conversion
    detail = previous.PageCorrectionTests.detail
    mutate = previous.PageCorrectionTests.mutate
    grant = previous.PageCorrectionTests.grant
    link = previous.PageCorrectionTests.link
    original_bytes = previous.PageCorrectionTests.original_bytes
    query = registration_cases.RegistrationTest.query
    prepare = registration_cases.RegistrationTest.prepare

    def report(self, *, units, unread, complete=False, method='ocr', pdf=True):
        if pdf:
            self.conversion()
        body = CreateConversion(request_id=uuid4().hex, source_ref=self.source, method=method,
            complete=complete, unread_ranges=unread, warnings=['Original diagnostic retained.'], units=units)
        result = PlanStore(self.store, self.actor, rulesets=self.rules).conversion(body.model_dump(exclude={"profile"}), self.auth)
        self.reference = dict(conversion_id=result['manifest']['id'], conversion_revision=result['revision'])
        self.workflow_id = result['manifest']['id']
        self.request.update(conversion_ref=self.reference)
        if complete:
            self.service().create(CreateWorkflow(request_id=uuid4().hex, source_ref=self.source,
                conversion_ref=self.reference, title='Normal content edit', target_document='pump.md'), self.auth)
        return result

    def correct(self, *, content, method='manual', **selected):
        body = PageCorrection(request_id=uuid4().hex, expected_revision=self.detail()['revision'],
                              content=content, method=method, **selected)
        return self.service().mutate(self.workflow_id, 'corrections', body, self.auth)

    def approve(self):
        pages = self.detail()['pages']
        for offset in range(0, len(pages), 100):
            self.mutate('pages', PageDecisions, decisions=[dict(**corrections.target(item), state='usable',
                **({'correction_ref': item['correction_ref']} if item.get('correction_ref') else {}))
                for item in pages[offset:offset + 100]])
        return self.mutate('approve', Approve, device_id='1' * 32, device_name='Content owner',
            target_document='pump.md', corrections_revision=self.detail()['corrections_revision'])

    def frozen(self):
        self.approve(); self.link(self.grant())
        job = records.owned_state(self.jobs, self.job_id, **self.scope)
        return registration.materialize(self.jobs, job, self.actor)

    @staticmethod
    def page(number, content):
        return dict(unit_id='page' + str(number), location=dict(kind='pages', start=number, end=number), content=content)

    def test_missing_page_requires_content_then_saves_with_separate_resolution(self):
        unread = ['page 2: no_text_detected_manual_review_required']
        original = self.report(units=[self.page(1, 'First page retained.')], unread=unread)
        before = self.original_bytes()
        with self.assertRaises(JobConflictError) as error:
            self.mutate('pages', PageDecisions, decisions=[dict(page=2, state='usable')])
        self.assertEqual(error.exception.code, 'content_input_required')
        self.correct(page=2, content='User supplied the second page.')
        markdown, report = self.frozen()
        self.assertLess(markdown.index('First page retained.'), markdown.index('User supplied'))
        self.assertFalse(report['complete'])
        self.assertEqual(report['unread_ranges'], unread)
        self.assertEqual(report['units'], original['manifest']['units'])
        self.assertEqual(report['user_input_resolution'], dict(complete=True, resolved_ranges=unread, remaining_ranges=[]))
        self.assertEqual(len(report['effective_units']), 2)
        job = self.jobs.query(self.job_id, **self.scope)
        linked = self.detail()
        self.jobs.claim(self.job_id, **self.scope, expected_job_revision=job['job_revision'], authorize=self.auth,
                        execution_claim_id=linked['execution']['claim_id'])
        args, manifest, parts = registration_cases.RegistrationTest.prepare(self, 'prepare_wiki')
        self.assertTrue(manifest['completeness']['complete'])
        saved = self.results.write_wiki(self.job_id, **args, content=parts['data/registration.md'], expected_revision=None)
        self.assertTrue(saved['saved'])
        self.assertEqual(self.original_bytes(), before)

    def test_explicit_blank_page_is_distinct_from_empty_ocr(self):
        unread = ['page 2: ocr_no_text_detected_manual_review_required']
        self.report(units=[self.page(1, 'Text.'), self.page(2, '')], unread=unread)
        with self.assertRaises(ValidationError):
            self.correct(page=2, content='')
        with self.assertRaises(ValidationError):
            self.correct(page=2, method='blank', content='Not blank.')
        self.correct(page=2, method='blank', content='')
        markdown, report = self.frozen()
        self.assertIn('Text.', markdown)
        self.assertEqual(report['approved_corrections'][0]['method'], 'blank')
        self.assertTrue(report['user_input_resolution']['complete'])

    def test_missing_input_registration_completes_only_after_ontology_and_resumes_without_resaving_wiki(self):
        self.report(units=[self.page(1, 'Background retained.')],
            unread=['page 2: no_text_detected_manual_review_required'])
        before = self.original_bytes()
        self.correct(page=2, content=self.text)
        self.frozen()
        job = self.query()
        workflow = self.detail()
        self.jobs.claim(self.job_id, **self.scope, expected_job_revision=job['job_revision'], authorize=self.auth,
            execution_claim_id=workflow['execution']['claim_id'])
        args, manifest, parts = self.prepare('prepare_wiki')
        self.assertTrue(manifest['input_ready'])
        saved = self.results.write_wiki(self.job_id, **args, content=parts['data/registration.md'], expected_revision=None)
        self.assertTrue(saved['saved'])
        self.assertEqual(self.query()['result_summary']['status'], 'partial')
        self.assertNotEqual(self.detail()['state'], 'complete')
        wiki_revision = self.store.read('pump.md').revision
        graph_args, graph_manifest = registration_cases.RegistrationTest.graph_args(self)
        graph_args['submission']['entities'][0]['evidence'] = 'This evidence does not exist in the selected input.'
        with self.assertRaises(ResultError):
            self.results.generate_ontology(self.job_id, **graph_args)
        self.assertEqual(self.query()['result_summary']['status'], 'partial')
        graph_args, graph_manifest = registration_cases.RegistrationTest.graph_args(self)
        self.assertEqual(graph_manifest['previous_result']['source_revision'], wiki_revision)
        with patch.object(self.store, 'save', side_effect=AssertionError('The saved Wiki must not be written again.')):
            generated = self.results.generate_ontology(self.job_id, **graph_args)
        self.assertTrue(generated['saved'])
        self.assertEqual(generated['receipt']['source_revision'], wiki_revision)
        self.assertEqual(self.store.read('pump.md').revision, wiki_revision)
        self.assertEqual(self.query()['result_summary']['status'], 'complete')
        self.assertEqual(self.query()['result_summary']['saved_count'], 2)
        self.assertEqual(self.detail()['state'], 'complete')
        self.assertEqual(self.original_bytes(), before)

    def test_normal_page_can_be_edited_and_unchanged_pages_survive(self):
        self.report(units=[self.page(1, 'Low confidence text.'), self.page(2, 'Normal text.')],
                    unread=[f'page 1: {LOW}'])
        self.correct(page=2, content='Edited normal page.')
        self.assertEqual(len(self.detail()['pages']), 2)
        markdown, report = self.frozen()
        self.assertIn('Low confidence text.', markdown)
        self.assertIn('Edited normal page.', markdown)
        self.assertNotIn('Normal text.', markdown)
        self.assertFalse(report['complete'])

    def test_non_pdf_unit_edit_uses_original_location(self):
        self.report(pdf=False, method='verbatim', complete=True, unread=[], units=[
            dict(unit_id='lines1', location=dict(kind='lines', start=1, end=2), content=self.text)])
        self.correct(unit_id='lines1', content='Corrected text lines.')
        markdown, report = self.frozen()
        self.assertIn('Corrected text lines.', markdown)
        self.assertEqual(report['effective_units'][0]['location']['kind'], 'lines')
        self.assertEqual(report['approved_corrections'][0]['unit_id'], 'lines1')

    def slide_report(self, **changes):
        """실제 VOC와 같은 170단위·5쪽 경고를 합성 본문으로 재현한다."""
        from core.tests.poc_analysis.test_presentation_conversion import package
        staged = self.sources.stage(BytesIO(package()), kind='file', title='Synthetic PPT',
                                    format='pptx', filename='fixture.pptx')
        registered = self.sources.commit(staged, **self.scope, request_id=uuid4().hex, authorize=self.auth)
        catalog = self.sources.get_source(registered['receipt']['source_id'])
        original = catalog['versions'][-1]
        self.source = {key: original[key] for key in corrections.SOURCE_KEYS if key != 'registration_revision'}
        self.source['registration_revision'] = catalog['registration_revision']
        self.request.update(source_ref=self.source)
        values = dict(pdf=False, method='pptx_text', units=[
            dict(unit_id=f'slide-{number}', location=dict(kind='slides', start=number, end=number),
                 content=self.text if number == 1 else f'Synthetic slide {number}.')
            for number in range(1, 171)], unread=[f'slide {number}: {LOW}' for number in (121, 122, 124, 128, 136)])
        return self.report(**dict(values, **changes))

    def test_slide_confidence_review_reaches_registration_and_analysis_input(self):
        original = self.slide_report()
        before = self.original_bytes()
        pages = self.detail()['pages']
        self.assertEqual([item['unit_id'] for item in pages],
                         ['slide-121', 'slide-122', 'slide-124', 'slide-128', 'slide-136'])
        self.assertTrue(all(not item['input_required'] for item in pages))
        markdown, report = self.frozen()
        self.assertEqual(report['units'], original['manifest']['units'])
        self.assertFalse(report['complete'])
        self.assertEqual(report['unread_ranges'], original['manifest']['unread_ranges'])
        self.jobs.claim(self.job_id, **self.scope, expected_job_revision=self.query()['job_revision'],
                        authorize=self.auth, execution_claim_id=self.detail()['execution']['claim_id'])
        args, manifest, parts = self.prepare('prepare_wiki')
        self.assertTrue(manifest['input_ready'])
        self.assertIn('Synthetic slide 170.', parts['data/registration.md'])
        saved = self.results.write_wiki(self.job_id, **args, content=parts['data/registration.md'], expected_revision=None)
        self.assertTrue(saved['saved'])
        graph_args, graph_manifest = registration_cases.RegistrationTest.graph_args(self)
        generated = self.results.generate_ontology(self.job_id, **graph_args)
        self.assertTrue(generated['saved'])
        self.assertEqual(self.query()['result_summary']['status'], 'complete')
        self.assertEqual(self.original_bytes(), before)

    def test_slide_correction_resolves_only_its_original_range(self):
        original = self.slide_report()
        before = self.original_bytes()
        self.correct(unit_id='slide-122', content='Corrected synthetic slide.')
        markdown, report = self.frozen()
        self.assertIn('Corrected synthetic slide.', markdown)
        self.assertEqual(report['user_input_resolution']['resolved_ranges'], [f'slide 122: {LOW}'])
        self.assertEqual(len(report['user_input_resolution']['remaining_ranges']), 4)
        self.assertEqual(report['effective_units'], original['manifest']['units'])
        self.assertEqual(self.original_bytes(), before)

    def test_slide_gaps_and_ambiguous_locations_cannot_be_marked_usable(self):
        unit = dict(unit_id='custom-id', location=dict(kind='slides', start=121, end=121), content='Retained text.')
        for units, unread, selected in (
                ([dict(unit, content='')], [f'slide 121: {LOW}'], dict(unit_id='custom-id')),
                ([unit], ['slide 121: ocr_engine_failed'], dict(whole_document=True)),
                ([unit], ['slide 121: unsupported_picture_format'], dict(unit_id='custom-id')),
                ([dict(unit, location=dict(kind='slides', start=122, end=122))],
                 [f'slide 121: {LOW}'], dict(whole_document=True)),
                ([dict(unit, location=dict(kind='slides', start=121, end=122))],
                 [f'slide 121: {LOW}'], dict(whole_document=True)),
                ([unit, dict(unit, unit_id='overlap', location=dict(kind='slides', start=120, end=122))],
                 [f'slide 121: {LOW}'], dict(whole_document=True)),
                ([unit], [f'slide 121: {LOW}', 'remaining source: conversion_checkpoint_read_failed'],
                 dict(whole_document=True))):
            with self.subTest(unread=unread, units=units):
                self.slide_report(units=units, unread=unread)
                self.assertEqual([corrections.target(item) for item in self.detail()['pages']], [selected])
                with self.assertRaises(JobConflictError) as error:
                    self.mutate('pages', PageDecisions, decisions=[dict(**selected, state='usable')])
                self.assertEqual(error.exception.code, 'content_input_required')
        with self.assertRaisesRegex(ValueError, 'locations must be distinct'):
            self.slide_report(units=[unit, dict(unit, unit_id='other')], unread=[f'slide 121: {LOW}'])
        report = dict(manifest=dict(complete=False, units=[unit, dict(unit, unit_id='other')],
                                   unread_ranges=[f'slide 121: {LOW}']),
                      components={'custom-id': 'Retained text.', 'other': 'Duplicate text.'})
        self.assertEqual(corrections.review_targets(report['manifest'], report['components']),
                         [dict(whole_document=True)])

    def test_legacy_unjudged_slide_review_is_restored_once_without_reconversion(self):
        with patch('core.modules.notifications.store.review_targets', return_value=[dict(whole_document=True)]):
            self.slide_report()
            prior = self.detail()
        before = self.original_bytes()
        updated = self.service().detail(self.workflow_id)
        self.assertNotEqual(updated['workflow']['revision'], prior['revision'])
        self.assertEqual(len(updated['workflow']['pages']), 5)
        events = [item for item in updated['events'] if item['kind'] == 'review_targets_updated']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['details']['previous_pages'], prior['pages'])
        self.assertEqual(self.service().detail(self.workflow_id), updated)
        with self.assertRaises(JobConflictError) as error:
            self.service().mutate(self.workflow_id, 'pages', PageDecisions(request_id=uuid4().hex,
                expected_revision=prior['revision'], decisions=[dict(whole_document=True, state='held')]), self.auth)
        self.assertEqual(error.exception.code, 'conflict')
        self.assertEqual(self.original_bytes(), before)

    def test_legacy_user_decisions_and_whole_corrections_are_not_replaced(self):
        for mode in ('held', 'pending_again', 'corrected', 'approved'):
            with self.subTest(mode=mode):
                with patch('core.modules.notifications.store.review_targets', return_value=[dict(whole_document=True)]):
                    self.slide_report()
                    if mode in ('held', 'pending_again'):
                        self.mutate('pages', PageDecisions, decisions=[dict(whole_document=True, state='held')])
                        if mode == 'pending_again':
                            self.mutate('pages', PageDecisions, decisions=[dict(whole_document=True, state='pending')])
                    else:
                        self.correct(whole_document=True, content='Whole document supplied by the user.')
                        if mode == 'approved':
                            self.approve()
                    prior = self.service().detail(self.workflow_id)
                self.assertEqual(self.service().detail(self.workflow_id), prior)

    def test_review_target_repair_rolls_back_if_history_cannot_be_saved(self):
        from core.modules.notifications.store import NotificationStore
        with patch('core.modules.notifications.store.review_targets', return_value=[dict(whole_document=True)]):
            self.slide_report()
            prior = self.detail()
        with patch.object(NotificationStore, '_event', side_effect=OSError('History write failed')):
            with self.assertRaises(OSError):
                self.detail()
        with self.service().database() as db:
            self.assertEqual(self.service()._get(db, self.workflow_id), prior)
        self.assertEqual(len(self.detail()['pages']), 5)

    def test_frame_confidence_targets_use_preserved_id_and_require_actual_text(self):
        unit = dict(unit_id='retained-image', location=dict(kind='frames', start=2, end=2))
        manifest = dict(complete=False, units=[unit], unread_ranges=[f'frame 2: {LOW}'])
        report = dict(manifest=manifest, components={'retained-image': 'OCR text.'})
        selected = dict(unit_id='retained-image')
        self.assertEqual(corrections.review_targets(manifest, report['components']), [selected])
        self.assertFalse(corrections.needs_input(report, selected))
        report['components']['retained-image'] = ''
        self.assertTrue(corrections.needs_input(report, selected))

    def test_whole_document_replaces_selection_without_rewriting_original(self):
        self.report(units=[self.page(1, 'Original first page.')], unread=['PDF: unsupported embedded content'])
        before = self.original_bytes()
        self.correct(page=1, content='Intermediate page edit.')
        self.correct(whole_document=True, content='Complete user-entered document.')
        self.assertEqual(len(self.detail()['pages']), 1)
        self.assertTrue(self.detail()['pages'][0]['whole_document'])
        markdown, report = self.frozen()
        self.assertIn('Complete user-entered document.', markdown)
        self.assertNotIn('Intermediate page edit.', markdown)
        self.assertNotIn('Original first page.', markdown)
        self.assertEqual(report['effective_units'], [dict(unit_id='user_whole_document', location=dict(kind='whole'))])
        self.assertTrue(report['user_input_resolution']['complete'])
        self.assertEqual(self.original_bytes(), before)

    def test_unlisted_page_unit_and_overlapping_page_are_not_invented(self):
        self.report(units=[self.page(1, 'First page.')], unread=['page 2: no_text_detected_manual_review_required'])
        for selected in (dict(page=3), dict(unit_id='unknown'), dict(unit_id='page1')):
            with self.assertRaises(JobValidationError):
                self.correct(**selected, content='Must not be inserted.')
        self.report(units=[dict(unit_id='range', location=dict(kind='pages', start=1, end=3), content='Combined pages.')],
                    unread=['page 2: no_text_detected_manual_review_required'])
        with self.assertRaises(JobValidationError):
            self.correct(page=2, content='Ambiguous overlap.')

    def test_runtime_or_encrypted_failure_requires_explicit_whole_input(self):
        for code in ('encrypted_pdf_not_read', 'conversion_checkpoint_read_failed', 'dependency_missing:tesseract', 'page_limit'):
            self.report(units=[self.page(1, '')], unread=['whole source: ' + code])
            before = self.original_bytes()
            workflow = self.detail()
            self.assertEqual([corrections.target(item) for item in workflow['pages']], [dict(whole_document=True)])
            self.assertTrue(workflow['pages'][0]['input_required'])
            with self.assertRaises(JobValidationError):
                self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='usable')])
            with self.assertRaises(JobConflictError) as error:
                self.mutate('pages', PageDecisions, decisions=[dict(whole_document=True, state='usable')])
            self.assertEqual(error.exception.code, 'content_input_required')
            with self.assertRaises(JobConflictError):
                self.mutate('approve', Approve, device_id='1' * 32, device_name='PC', target_document='pump.md',
                    corrections_revision=workflow['corrections_revision'])
            self.correct(whole_document=True, content='User explicitly supplied the entire document for ' + code)
            markdown, report = self.frozen()
            self.assertIn('User explicitly supplied the entire document', markdown)
            self.assertFalse(report['complete'])
            self.assertEqual(report['unread_ranges'], ['whole source: ' + code])
            self.assertTrue(report['user_input_resolution']['complete'])
            self.assertEqual(self.original_bytes(), before)

    def test_checkpoint_failure_page_edit_does_not_resolve_unknown_remaining_source(self):
        unread = [f'page 1: {LOW}', 'remaining source: conversion_checkpoint_read_failed']
        self.report(units=[self.page(1, 'Retained first page.')], unread=unread)
        before = self.original_bytes()
        self.correct(page=1, content='A corrected first page still leaves the rest unknown.')
        workflow = self.detail()
        self.assertEqual(len(workflow['pages']), 2)
        whole = next(item for item in workflow['pages'] if item.get('whole_document'))
        page = next(item for item in workflow['pages'] if item.get('page') == 1)
        self.assertTrue(whole['input_required'])
        self.mutate('pages', PageDecisions, decisions=[dict(page=1, state='usable', correction_ref=page['correction_ref'])])
        with self.assertRaises(JobConflictError) as error:
            self.mutate('pages', PageDecisions, decisions=[dict(whole_document=True, state='usable')])
        self.assertEqual(error.exception.code, 'content_input_required')
        with self.assertRaises(JobConflictError):
            self.mutate('approve', Approve, device_id='1' * 32, device_name='PC', target_document='pump.md',
                corrections_revision=self.detail()['corrections_revision'])
        self.assertEqual(self.original_bytes(), before)
        self.correct(whole_document=True, content='Explicit complete replacement after the interrupted conversion.')
        markdown, report = self.frozen()
        self.assertIn('Explicit complete replacement', markdown)
        self.assertNotIn('Retained first page.', markdown)
        self.assertEqual(report['unread_ranges'], unread)
        self.assertFalse(report['complete'])
        self.assertEqual(report['user_input_resolution']['remaining_ranges'], [])
        self.assertEqual(self.original_bytes(), before)

    def test_selection_hash_guards_exact_content_and_legacy_clients(self):
        self.conversion()
        old_hash = self.detail()['corrections_revision']
        self.correct(page=1, content='Changed selected text.')
        pages = self.detail()['pages']
        self.mutate('pages', PageDecisions, decisions=[dict(**corrections.target(item), state='usable',
            **({'correction_ref': item['correction_ref']} if item.get('correction_ref') else {})) for item in pages])
        for fields in ({'corrections_revision': old_hash}, {}):
            with self.assertRaises(JobConflictError) as error:
                self.mutate('approve', Approve, device_id='1' * 32, device_name='PC', target_document='pump.md', **fields)
            self.assertEqual(error.exception.code, 'correction_basis_changed')
        self.approve()

    def test_large_text_summary_and_chunks_are_exact_and_revision_bound(self):
        text = ('한😀\n' * 9000) + 'end'
        self.report(units=[self.page(1, text)], unread=[f'page 1: {LOW}'])
        updated = text + '\nUser edit.'
        self.correct(page=1, content=updated)
        summary = self.service().detail(self.workflow_id, include_content=False)
        self.assertEqual(summary['conversion']['components'], {})
        self.assertNotIn('content', summary['corrections'][0])
        self.assertFalse(summary['content_included'])
        revision = summary['workflow']['revision']
        offset, chunks = 0, []
        while offset is not None:
            result = self.service().content(self.workflow_id, ContentQuery(page=1, expected_revision=revision, offset=offset, limit=1000))
            chunks.append(result['content']); offset = result['next_offset']
        self.assertEqual(''.join(chunks), updated)
        original = self.service().content(self.workflow_id, ContentQuery(page=1, expected_revision=revision, variant='original'))
        self.assertEqual(original['content'], text)
        self.correct(page=1, content='New version.')
        with self.assertRaises(JobConflictError):
            self.service().content(self.workflow_id, ContentQuery(page=1, expected_revision=revision))

    def test_full_response_limit_does_not_block_summary_or_losslessly_saved_text(self):
        large = '"' * (2 * 1024 * 1024)
        self.report(units=[self.page(1, large)], unread=[f'page 1: {LOW}'])
        self.correct(page=1, content=large + 'changed')
        with self.assertRaises(InputLimitError):
            self.service().detail(self.workflow_id)
        summary = self.service().detail(self.workflow_id, include_content=False)
        self.assertEqual(summary['corrections'][0]['total_characters'], len(large) + 7)

    def test_preserved_registration_over_one_megabyte_uses_existing_input_limit(self):
        text = 'x' * (1024 * 1024 + 1)
        self.report(units=[self.page(1, 'Small original.')], unread=[f'page 1: {LOW}'])
        self.correct(whole_document=True, content=text)
        markdown, report = self.frozen()
        self.assertIn(text, markdown)
        self.assertTrue(report['user_input_resolution']['complete'])


class RegistrationContentAPITests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = previous.PageCorrectionAPITests.asyncSetUp
    fixture = previous.PageCorrectionAPITests.fixture

    async def test_plan_api_passes_normalized_command_without_profile(self):
        workflow, _ = self.fixture()
        scope = self.policy.authorize(self.user['token'], self.tenant, 'source_write')
        base = f'/api/v1/tenants/{self.tenant}'
        conversion = await self.http.post(base + '/analysis-conversions', json=dict(
            request_id=uuid4().hex, profile=scope.profile_id, source_ref=workflow['source_ref'],
            method='ocr', complete=True, units=[dict(unit_id=f'p{page}',
                location=dict(kind='pages', start=page, end=page), content=f'Ready synthetic page {page}.')
                for page in (1, 2)]))
        self.assertEqual(conversion.status_code, 201, conversion.text)
        converted = conversion.json()['data']
        body = dict(request_id=uuid4().hex, profile=scope.profile_id,
            source_ref=workflow['source_ref'], conversion_ref=dict(conversion_id=converted['manifest']['id'],
                conversion_revision=converted['revision']),
            outputs=[dict(document='api-plan.md', title='Synthetic plan', purpose='Normalized input', outputs=['wiki'])])
        expected = CreatePlan(**body).model_dump(exclude={'profile'})
        endpoint = base + '/analysis-plans'
        response = await self.http.post(endpoint, json=body)
        self.assertEqual(response.status_code, 201, response.text)
        saved = response.json()['data']
        self.assertEqual(saved['manifest']['plan'], expected)
        self.assertEqual(saved['manifest']['payload_hash'], canonical_json_hash(expected))
        self.assertNotIn('profile', saved['manifest']['plan'])
        self.assertIsNone(saved['manifest']['plan']['wiki_ref'])
        self.assertEqual(saved['manifest']['plan']['locations'], [])
        self.assertEqual(saved['manifest']['plan']['outputs'][0]['locations'], [])
        replay = await self.http.post(endpoint, json=body)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()['data']['revision'], saved['revision'])

    async def test_summary_and_original_selected_chunks_share_exact_workflow_revision(self):
        workflow, endpoint = self.fixture()
        response = await self.http.get(endpoint, params=dict(include_content='false'))
        self.assertEqual(response.status_code, 200, response.text)
        summary = response.json()['data']
        self.assertFalse(summary['content_included'])
        self.assertEqual(summary['source_format'], 'pdf')
        self.assertEqual(summary['conversion']['components'], {})
        query = dict(expected_revision=workflow['revision'], page='1', variant='original', offset='0', limit='8')
        response = await self.http.get(endpoint + '/content', params=query)
        self.assertEqual(response.status_code, 200, response.text)
        part = response.json()['data']
        self.assertTrue(part['exists'])
        self.assertEqual(part['content'], 'Original')
        self.assertEqual(part['next_offset'], 8)
        whole = await self.http.get(endpoint + '/content', params=dict(expected_revision=workflow['revision'], whole_document='true'))
        self.assertEqual(whole.status_code, 200, whole.text)
        self.assertIn('Unchanged second page.', whole.json()['data']['content'])
        saved = await self.http.post(endpoint + '/corrections', json=dict(request_id=uuid4().hex,
            expected_revision=workflow['revision'], page=1, method='blank', content=''))
        self.assertEqual(saved.status_code, 200, saved.text)
        stale = await self.http.get(endpoint + '/content', params=query)
        self.assertEqual(stale.status_code, 409, stale.text)
        new_revision = saved.json()['data']['workflow']['revision']
        blank = await self.http.get(endpoint + '/content', params=dict(expected_revision=new_revision, page='1'))
        self.assertEqual(blank.status_code, 200, blank.text)
        self.assertEqual(blank.json()['data']['content'], '')
        self.assertTrue(blank.json()['data']['exists'])
        invalid = await self.http.get(endpoint + '/content', params=dict(expected_revision=new_revision, page='1', unit_id='p1'))
        self.assertEqual(invalid.status_code, 422)

    async def test_content_endpoint_denies_unknown_identity(self):
        workflow, endpoint = self.fixture()
        response = await self.http.get(endpoint + '/content', params=dict(expected_revision=workflow['revision'], page=1),
            headers={'Authorization': 'Bearer ' + 'a' * 64})
        self.assertEqual(response.status_code, 401)


if __name__ == '__main__':
    unittest.main()
