"""추출안 실행 저장 계약을 전송 계층 없이 격리 자료에서 검증한다."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.modules.access.policy import AccessDenied
from core.modules.analysis_inputs import contracts as limits
from core.modules.analysis_jobs.store import JobStore
from core.modules.analysis_jobs.contracts import JobConflictError
from core.modules.analysis_proposals import executions as module
from core.modules.analysis_proposals.executions import ProposalExecutionStore
from core.modules.analysis_proposals.store import ProposalStore
from core.modules.analysis_results.diagnostics import empty_report
from core.modules.analysis_results.contracts import ResultError
from core.modules.reviews.store import ReviewStore
from core.tests.api import test_analysis_proposal_executions as fixture
from core.tests.api.test_analysis_proposals_api import GRAPH


class ProposalExecutionStoreTests(unittest.TestCase):
    setUp = fixture.ProposalExecutionTests.setUp
    save_policy = fixture.ProposalExecutionTests.save_policy
    authorize = fixture.ProposalExecutionTests.authorize
    current = fixture.ProposalExecutionTests.current
    graph_bytes = fixture.ProposalExecutionTests.graph_bytes
    result = fixture.ProposalExecutionTests.result

    def seed_execution(self):
        service = ProposalExecutionStore(self.store, self.authorize(), rulesets=self.rulesets)
        current = self.current()
        proposal = service.proposals.prepare(uuid4().hex, 'target.md', current['source_revision'],
            current['state_revision'], [], submission=None, before_commit=self.authorize)
        execution_id = uuid4().hex
        execution = service.start(proposal['proposal_id'], execution_id, proposal['state_revision'], None,
                                  'module contract test', authorize=self.authorize)
        proposal = service.proposals.read(proposal['proposal_id'])
        return service, proposal, execution

    def link(self, service, proposal, execution, ref, **extra):
        return service.link(proposal['proposal_id'], uuid4().hex, proposal['state_revision'],
            None if proposal['candidate_ref'] is None else proposal['candidate_ref']['candidate_revision'],
            execution['execution_id'], extra.pop('mode', 'candidate'), ref, [], [], authorize=self.authorize, **extra)

    def test_expired_and_reclaimed_runs_reject_attachment_but_keep_exact_report(self):
        service, proposal, execution = self.seed_execution()
        ref, prepared, _ = self.result(execution, diagnostics=empty_report())
        service.jobs.clock = lambda: datetime.now(timezone.utc) + timedelta(hours=1)
        with self.assertRaises(JobConflictError) as expired:
            self.link(service, proposal, execution, ref)
        self.assertEqual(expired.exception.code, 'lease_expired')
        service.jobs.claim(execution['job_id'], tenant='alpha', user_id='alice',
            expected_job_revision=prepared['job_revision'], authorize=self.authorize, reclaim=True)
        with self.assertRaises(limits.InputConflictError) as reclaimed:
            self.link(service, proposal, execution, ref)
        self.assertEqual(reclaimed.exception.code, 'proposal_result_run_changed')
        receipt = service.results.query(execution['job_id'], tenant='alpha', user_id='alice',
                                        request_id=ref['request_id'], authorize=self.authorize)
        self.assertEqual(receipt['state'], 'draft')

    def test_tampered_payload_and_commit_permission_loss_do_not_publish_candidate(self):
        service, proposal, execution = self.seed_execution()
        ref, _, _ = self.result(execution)
        original = self.graph_bytes()
        def denied():
            raise AccessDenied()
        with self.assertRaises(AccessDenied):
            service.link(proposal['proposal_id'], uuid4().hex, proposal['state_revision'], None,
                execution['execution_id'], 'candidate', ref, [], [], authorize=denied)
        self.assertIsNone(service.proposals.read(proposal['proposal_id'])['candidate_ref'])
        directory = service.jobs.jobs_dir / execution['job_id'] / 'results' / ref['request_id']
        component = directory / 'component-0.txt'
        component.write_text('tampered payload')
        with self.assertRaises((ResultError, ValueError)):
            self.link(service, proposal, execution, ref)
        self.assertEqual(original, self.graph_bytes())

    def test_current_report_becomes_historical_after_cancel_or_candidate_change(self):
        service, proposal, execution = self.seed_execution()
        ref, prepared, _ = self.result(execution, diagnostics=empty_report())
        linked = self.link(service, proposal, execution, ref)
        self.assertEqual(len(linked['current_reports']), 1)
        service.jobs.cancel(execution['job_id'], tenant='alpha', user_id='alice',
            expected_job_revision=prepared['job_revision'], authorize=self.authorize)
        cancelled = service.proposals.read(proposal['proposal_id'])
        self.assertEqual(cancelled['result_links'][0]['currentness'], 'job_cancelled')
        self.assertEqual(cancelled['current_reports'], [])
        changed = service.proposals.submit(proposal['proposal_id'], uuid4().hex, cancelled['state_revision'],
            {**deepcopy(GRAPH), 'relations': []}, [], before_commit=self.authorize)
        self.assertEqual(changed['result_links'][0]['currentness'], 'candidate_changed')
        self.assertEqual(changed['current_reports'], [])
        receipt = service.proposals.receipt(proposal['proposal_id'], linked['result_links'][0]['request_id'])
        self.assertEqual(receipt['state'], 'complete')
        self.assertIsNotNone(receipt['report']['diagnostics'])

    def test_execution_and_report_capacity_preserve_existing_files(self):
        service, proposal, execution = self.seed_execution()
        with patch.object(module, 'MAX_EVENTS', 1):
            with self.assertRaises(limits.InputLimitError):
                service.start(proposal['proposal_id'], uuid4().hex, proposal['state_revision'], None,
                              'another execution', authorize=self.authorize)
        self.assertEqual(service.read(proposal['proposal_id'], execution['execution_id'])['state'], 'ready')
        ref, _, _ = self.result(execution, diagnostics=empty_report())
        # 보고 한도 거부 뒤 불변 후보는 공개됐다면 지우지 않고 정확 요청으로 복구한다.
        request_id = uuid4().hex
        original = self.graph_bytes()
        with patch.object(module, 'MAX_REPORT_TOTAL_BYTES', 1):
            with self.assertRaises(limits.InputLimitError):
                service.link(proposal['proposal_id'], request_id, proposal['state_revision'], None,
                    execution['execution_id'], 'candidate', ref, [], [], authorize=self.authorize)
        self.assertEqual(original, self.graph_bytes())
        receipt = service.proposals.receipt(proposal['proposal_id'], request_id)
        self.assertEqual(receipt['operation'], 'result_link')
        self.assertEqual(receipt['result_ref']['payload_hash'], ref['payload_hash'])
        linked = service.link(proposal['proposal_id'], request_id, proposal['state_revision'], None,
            execution['execution_id'], 'candidate', ref, [], [], authorize=self.authorize)
        self.assertIsNotNone(linked['candidate_ref'])
        self.assertEqual(original, self.graph_bytes())

    def test_same_plan_different_handoff_job_is_not_this_execution(self):
        service, proposal, execution = self.seed_execution()
        handoff = service.plans.handoff(execution['plan_ref']['plan_id'], execution['plan_ref']['plan_revision'],
                                       uuid4().hex, self.authorize)
        foreign_job = {**execution, **{key: handoff['jobs'][0][key] for key in ('job_id', 'job_revision')}}
        with self.assertRaises(ResultError) as rejected:
            self.result(foreign_job)
        self.assertEqual(rejected.exception.code, 'proposal_result_scope_mismatch')
        self.assertIsNone(service.proposals.read(proposal['proposal_id'])['candidate_ref'])

    def test_ruleset_revocation_keeps_execution_and_report_readable(self):
        service, proposal, execution = self.seed_execution()
        ref, _, _ = self.result(execution, diagnostics=empty_report())
        linked = self.link(service, proposal, execution, ref)
        self.rules_config['tenants']['alpha']['revoked'] = [self.reference]
        self.rules_policy.write_text(json.dumps(self.rules_config))
        observed = service.read(proposal['proposal_id'], execution['execution_id'])
        self.assertEqual(observed['state'], 'basis_changed')
        read = service.proposals.read(proposal['proposal_id'])
        self.assertEqual(read['current_reports'], [])
        receipt = service.proposals.receipt(proposal['proposal_id'], linked['result_links'][0]['request_id'])
        self.assertEqual(receipt['state'], 'complete')
