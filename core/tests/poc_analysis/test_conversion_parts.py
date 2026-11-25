"""큰 보고의 부분 전송·전체 지문·중단 복구를 합성 원본과 임시 서버에서 검증한다."""
from copy import deepcopy
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx2

from core.client.source_conversion_parts import needs_parts, parts, submit, ReportRejected
from core.modules.analysis_plans.store import PlanStore
from core.tests.poc_analysis import test_source_preview as preview_tests


class ConversionTransportPolicyTests(unittest.TestCase):
    def body(self, texts):
        return {'units': [{'unit_id': f'p{index}', 'content': text,
                           'location': {'kind': 'pages', 'start': index, 'end': index}}
                          for index, text in enumerate(texts, 1)]}

    def test_unit_count_boundary_preserves_every_unit(self):
        body = self.body(['원문'] * 1000)
        self.assertFalse(needs_parts(body))
        body = self.body(['원문'] * 1000 + ['추가'])
        self.assertTrue(needs_parts(body))
        groups = parts(body)
        self.assertEqual([len(group) for group in groups], [1000, 1])
        self.assertEqual([unit for group in groups for unit in group], body['units'])

    def test_text_budget_counts_utf8_bytes(self):
        body = self.body(['한' * (4 * 1024 * 1024 // 3), 'a'])
        self.assertFalse(needs_parts(body))
        body['units'][1]['content'] = '한'
        self.assertTrue(needs_parts(body))
        self.assertEqual(len(parts(body)), 2)

    def test_json_escaping_can_require_parts_before_text_limit(self):
        body = self.body(['"' * (1200 * 1024)] * 3)
        self.assertTrue(needs_parts(body))
        groups = parts(body)
        self.assertEqual([len(group) for group in groups], [2, 1])
        self.assertEqual([unit for group in groups for unit in group], body['units'])

    def test_an_oversized_unit_is_rejected_without_truncation(self):
        body = self.body(['"' * (4 * 1024 * 1024)])
        self.assertTrue(needs_parts(body))
        with self.assertRaises(ReportRejected) as raised:
            parts(body)
        self.assertEqual(raised.exception.code, 'conversion_unit_transport_limit')
        self.assertEqual(len(body['units'][0]['content']), 4 * 1024 * 1024)


class ConversionPartsTest(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = preview_tests.SourcePreviewTests.asyncSetUp

    async def test_no_checkpoint_failed_attempt_is_preserved_and_can_receive_explicit_whole_input(self):
        from core.client.source_conversion import convert_source
        from core.client.source_conversion_report import empty_conversion
        from core.client.source_conversion_resume import resume_report
        body = self.body(count=1)
        source = body['source_ref']
        base = f'/api/v1/tenants/{self.tenant}'
        async def failed_worker(path, format, result_path, **options):
            self.assertTrue(path.is_file())
            self.assertFalse(result_path.exists())
            value = empty_conversion(format, 'conversion_worker_exception')
            value['worker_failure'] = {'code': 'conversion_worker_exception'}
            return value
        with patch('core.client.source_conversion.run_worker', side_effect=failed_worker):
            result = await convert_source(base_url='http://127.0.0.1:8766', tenant=self.tenant,
                token=self.user['token'], source_ref=source, work_dir=Path(self.temporary.name).resolve() / 'failed-work',
                request_id=body['request_id'], submit=True, http=self.http)
        self.assertFalse(result['ok'])
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(result['receipt']['state'], 'saved')
        self.assertEqual(result['conversion']['units'], [])
        self.assertEqual(result['conversion']['method'], 'pdf_text')
        self.assertFalse(result['conversion']['complete'])
        self.assertIn('conversion_attempt_no_text', result['conversion']['warnings'])
        self.assertEqual(result['error']['code'], 'conversion_worker_exception')
        self.assertFalse(Path(result['work_dir'], 'conversion.json').exists())
        stored_path = base + '/analysis-conversions/' + result['receipt']['conversion_ref']['conversion_id']
        stored = (await self.http.get(stored_path)).json()['data']
        workflow_path = base + '/notification-workflows/' + stored['manifest']['id']
        workflow = (await self.http.get(workflow_path)).json()['data']['workflow']
        self.assertEqual(workflow['pages'], [dict(whole_document=True, state='pending', input_required=True)])
        async def mutate(operation, **values):
            current = (await self.http.get(workflow_path)).json()['data']['workflow']
            response = await self.http.post(workflow_path + '/' + operation, json=dict(request_id=uuid4().hex,
                expected_revision=current['revision'], **values))
            return response
        refused = await mutate('pages', decisions=[dict(whole_document=True, state='usable')])
        self.assertEqual(refused.status_code, 409)
        corrected = await mutate('corrections', whole_document=True, method='manual', content='직접 입력한 전체 합성 문서입니다.')
        self.assertEqual(corrected.status_code, 200, corrected.text)
        reference = corrected.json()['data']['workflow']['pages'][0]['correction_ref']
        accepted = await mutate('pages', decisions=[dict(whole_document=True, state='usable', correction_ref=reference)])
        self.assertEqual(accepted.status_code, 200, accepted.text)
        approved = await mutate('approve', device_id='1' * 32, device_name='Synthetic owner',
            target_document='manual.md', correction_refs=[dict(whole_document=True, correction_ref=reference)])
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual((await self.http.get(stored_path)).json()['data']['manifest'], stored['manifest'])
        with patch('core.client.source_conversion.run_worker', side_effect=AssertionError('must not retry conversion')):
            resumed = await resume_report(base_url='http://127.0.0.1:8766', tenant=self.tenant,
                token=self.user['token'], source_ref=source, work_dir=Path(self.temporary.name).resolve() / 'failed-work',
                request_id=body['request_id'], report_sha256=result['report_sha256'], http=self.http)
        self.assertFalse(resumed['ok'])
        self.assertEqual(resumed['state'], 'failed')
        self.assertEqual(resumed['receipt']['state'], 'saved')
        for invalid in (dict(complete=True), dict(warnings=[]), dict(unread_ranges=[])):
            rejected = await self.http.post(base + '/analysis-conversions', json={**body, 'units': [],
                'complete': False, 'unread_ranges': ['whole source: no_readable_units'],
                'warnings': ['conversion_attempt_no_text'], **invalid})
            self.assertGreaterEqual(rejected.status_code, 400)

    def body(self, *, count=1001, text='합성 원문'):
        source = {key: self.source[key] for key in ('source_id', 'source_version', 'source_sha256')}
        source['registration_revision'] = self.query['registration_revision']
        return dict(request_id=uuid4().hex, source_ref=source, method='pdf_text', complete=True,
            unread_ranges=[], warnings=[], units=[dict(unit_id=f'p{page}',
                location=dict(kind='pages', start=page, end=page, sheet=None, cells=None),content=text)
                for page in range(1,count+1)])

    async def test_units_and_utf8_bytes_split_without_changing_original_positions(self):
        base=f'/api/v1/tenants/{self.tenant}'
        for body in (self.body(), self.body(count=3,text='한'*(750*1024))):
            grouped=parts(body)
            self.assertEqual([unit for group in grouped for unit in group],body['units'])
            self.assertGreater(len(grouped),1)
            saved=await submit(self.http,base,'',body,self.user['user_id'],lambda *args,**kwargs:None)
            self.assertEqual(saved['state'],'saved',saved)
            final=(await self.http.get(base+'/analysis-conversions/'+saved['conversion_ref']['conversion_id'])).json()['data']
            self.assertNotIn('units',final['manifest'])
            self.assertEqual(final['components'],{})
            self.assertEqual(final['manifest']['unit_count'],len(body['units']))
            read=[]
            for reference in final['manifest']['parts']:
                part=(await self.http.get(base+'/analysis-conversion-parts/'+reference['part_id'])).json()['data']
                self.assertEqual(part['revision'],reference['part_revision'])
                read.extend({**unit,'content':part['components'][unit['unit_id']]} for unit in part['manifest']['units'])
            self.assertEqual(read,body['units'])
            # 새 서버 저장 형태는 기존 내부 변환 소비자에 전체 단위 순서로 복원된다.
            from core.common.access import access_dict
            scope=self.policy.authorize(self.user['token'],self.tenant,'read')
            loaded=PlanStore(scope.store,access_dict(scope)).read('conversions',saved['conversion_ref']['conversion_id'])
            self.assertEqual(len(loaded['manifest']['units']),len(body['units']))

    async def test_lost_part_response_is_read_and_never_reposted(self):
        body=self.body()
        http=self.http
        counts=[]
        events=[]
        class Lost:
            def __getattr__(self,name): return getattr(http,name)
            async def post(self,url,**kwargs):
                if not counts:
                    assert events and events[0] == ('submit', {'completed': 0, 'total': 3})
                counts.append(url)
                await http.post(url,**kwargs)
                raise httpx2.ReadError('synthetic response loss')
        result=await submit(Lost(),f'/api/v1/tenants/{self.tenant}','',body,self.user['user_id'],
            lambda stage,**values:events.append((stage,values)))
        self.assertEqual(result['state'],'saved')
        self.assertEqual(len(counts),3)
        repeated=await submit(Lost(),f'/api/v1/tenants/{self.tenant}','',body,self.user['user_id'],lambda *args,**kwargs:None)
        self.assertEqual(repeated['state'],'saved')
        self.assertEqual(len(counts),3)

    async def test_part_order_and_content_collision_rejected_without_overwriting(self):
        body=self.body()
        base=f'/api/v1/tenants/{self.tenant}'
        saved=await submit(self.http,base,'',body,self.user['user_id'],lambda *args,**kwargs:None)
        self.assertEqual(saved['state'],'saved')
        final=saved['manifest']
        invalid={key:body[key] for key in body if key!='units'}|{'parts':list(reversed(final['parts']))}
        rejected=await self.http.post(base+'/analysis-conversions/complete-parts',json=invalid)
        self.assertGreaterEqual(rejected.status_code,400)
        stable=(await self.http.get(base+'/analysis-conversions/'+final['id'])).json()['data']
        self.assertEqual(stable['revision'],saved['revision'])
        changed=deepcopy(body)
        changed['units'][0]['content']='different'
        result=await submit(self.http,base,'',changed,self.user['user_id'],lambda *args,**kwargs:None)
        self.assertNotEqual(result['state'],'saved')

    async def test_interrupted_upload_resumes_saved_report_without_download_or_conversion(self):
        from core.client.source_conversion import convert_source
        from core.client.source_conversion_resume import resume_report
        from core.client.source_conversion_worker import atomic_json
        body=self.body()
        conversion={key:body[key] for key in ('method','units','complete','warnings','unread_ranges')}
        conversion.update(format='pdf',state='complete',origin='client_reported',coverage='reported_units_only',
            original_coverage='not_verified',semantic_validation='not_run',diagnostics=[],unit_methods={})
        source=body['source_ref']
        http=self.http
        writes=[]
        downloads=[]
        class Interrupted:
            def __getattr__(self,name): return getattr(http,name)
            def stream(self,method,url,**kwargs):
                downloads.append(url)
                return http.stream(method,url,**kwargs)
            async def post(self,url,**kwargs):
                writes.append(url)
                if len(writes)>1:raise httpx2.ReadError('synthetic network interruption')
                return await http.post(url,**kwargs)
        async def worker(path,format,result_path,**kwargs):
            atomic_json(result_path,conversion)
            return deepcopy(conversion)
        work=Path(self.temporary.name).resolve()/'work'
        with patch('core.client.source_conversion.run_worker',side_effect=worker) as call:
            first=await convert_source(base_url='http://127.0.0.1:8766',tenant=self.tenant,token=self.user['token'],
                source_ref=source,work_dir=work,request_id=body['request_id'],submit=True,http=Interrupted())
            self.assertEqual(first['receipt']['state'],'unconfirmed')
            self.assertEqual(call.call_count,1)
        original_report=Path(first['report_file']).read_bytes()
        with patch('core.client.source_conversion.run_worker',side_effect=AssertionError('must not reconvert')):
            resumed=await resume_report(base_url='http://127.0.0.1:8766',tenant=self.tenant,token=self.user['token'],
                source_ref=source,work_dir=work,request_id=body['request_id'],report_sha256=first['report_sha256'],http=http)
        self.assertEqual(resumed['receipt']['state'],'saved')
        self.assertEqual(len(downloads),1)
        self.assertEqual(Path(first['report_file']).read_bytes(),original_report)
        self.assertEqual(resumed['conversion']['units'],body['units'])
        from core.client.transport import AnalysisClientError
        with self.assertRaises(AnalysisClientError):
            await resume_report(base_url='http://127.0.0.1:8766',tenant=self.tenant,token=self.user['token'],
                source_ref=source,work_dir=work,request_id=body['request_id'],report_sha256='0'*64,http=http)
