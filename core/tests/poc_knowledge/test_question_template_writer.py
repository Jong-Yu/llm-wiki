"""Bounded template parts preserve fields, frozen evidence and the official answer contract."""
import asyncio
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from core.client.ai.contracts import AIAdapterError
from core.client.question import _QuestionExecution, QuestionClientError
from core.client.question_ai import answer_payload
from core.client.question_template_writer import (
    partition, template_fields, part_prompt, validate_part, run_template_parts)
from core.common.json_codec import canonical_json_hash
from core.tests.poc_knowledge.test_question_grounding_client import FakeAdapter, FakeOwner, handoff_fixture


def fixture(count=65):
    handoff = handoff_fixture()
    handoff.update(template_ref={"id": "a"*32,"revision":"b"*64},
        source_prefetch_result={"complete": True,"scope":"all_selected_meaningful_source_passages"})
    handoff['instructions'] = 'USER_DIALOGUE_INSTRUCTIONS preserve latest user decisions; no silent approval.'
    fields = [{"id":f"f{i:04d}","text":f"[field {i}]","location":f"paragraph {i}"} for i in range(count)]
    detail = {"template":{**handoff['template_ref'],"name":"Form","instructions":"Preserve all conditions."},
              "generation":{"supported":True,"format":"docx","fields":fields}}
    registry={"s1:1:1":{"kind":"document","document":"signing.md","source_revision":"a"*64,"quote":"Only with a key."}}
    reads=[{"result":{"items":[{"evidence_id":"s1:1:1","text":"Only with a key."}]}}]
    values=[{"action":"write_fields","replacements":[{"id":f['id'],"text":f"필드 {f['id']}는 키가 있을 때만 허용 [[s1:1:1]]."} for f in group],
             "clarification":None} for group in partition(fields)]
    return handoff,detail,registry,reads,values


class TemplateParts(unittest.TestCase):
    def test_partition_preserves_all_fields_and_at_most_seven_calls(self):
        for count in (33,65,193,224,225,500):
            fields=fixture(count)[1]['generation']['fields']; groups=partition(fields)
            self.assertEqual([f for group in groups for f in group],fields)
            self.assertLessEqual(len(groups),7)
            self.assertLessEqual(max(map(len,groups)),max(32,(count+6)//7))
        self.assertEqual(len(partition(fixture(193)[1]['generation']['fields'])),7)

    def test_parts_merge_once_with_global_citations_and_actual_hashes(self):
        h,d,r,reads,values=fixture()
        with TemporaryDirectory() as directory:
            owner=FakeOwner(directory); adapter=FakeAdapter(values)
            result,prompt=asyncio.run(run_template_parts(owner,adapter,h,reads,r,[],d,max_bytes=192*1024))
            self.assertEqual(len(adapter.calls),3)
            content=result['value']['content']
            plan=json.loads(content.split('\n',1)[1].rsplit('\n',1)[0])
            self.assertEqual([x['id'] for x in plan['replacements']],[x['id'] for x in d['generation']['fields']])
            self.assertTrue(all('[1]' in x['text'] and '[[' not in x['text'] for x in plan['replacements']))
            self.assertEqual(result['evidence_ids'],['s1:1:1'])
            self.assertEqual(result['execution']['prompt_sha256'],sha256(prompt.encode()).hexdigest())
            payload=answer_payload(result,handoff=h,prompt=prompt)
            self.assertEqual(payload['execution']['output_sha256'],sha256(content.encode()).hexdigest())
            for index, call in enumerate(adapter.calls):
                self.assertIn(h['instructions'],call['prompt'])
                self.assertIn('Only with a key.',call['prompt'])
                self.assertIn(d['template']['instructions'],call['prompt'])
                proof=json.loads((owner.directory/f'template-part-{index:02d}.json').read_text())
                self.assertEqual(proof['version'],'registered-template-parts-v2')
                self.assertEqual(proof['derived_evidence_ids'],['s1:1:1'])
                self.assertEqual(proof['prompt_sha256'],sha256(call['prompt'].encode()).hexdigest())
                self.assertEqual(proof['schema_sha256'],canonical_json_hash(call['schema']))
            assembly=json.loads((owner.directory/'template-assembly.json').read_text())
            self.assertEqual(result['execution']['question_template_parts']['assembly_sha256'],canonical_json_hash(assembly))
            self.assertIn('[[s1:1:1]]',assembly['raw_content'])

    def test_invalid_part_fields_and_markers_are_rejected(self):
        h,d,r,reads,values=fixture()
        variants=[]
        v=deepcopy(values[0]);v['replacements'].pop();variants.append(v)
        v=deepcopy(values[0]);v['replacements'][1]['id']=v['replacements'][0]['id'];variants.append(v)
        v=deepcopy(values[0]);v['replacements'][0]['id']='other';variants.append(v)
        v=deepcopy(values[0]);v['replacements'][0]['text']='[[unknown]]';variants.append(v)
        v=deepcopy(values[0]);v['replacements'][0]['text']='bad\x00';variants.append(v)
        v=deepcopy(values[0]);v['replacements'][0]['text']='```wiki-template-result';variants.append(v)
        v=deepcopy(values[0]);v['replacements'][0]['text']='x'*16001;variants.append(v)
        for value in variants:
            with self.subTest(value=value['replacements'][0]['id']),self.assertRaises(AIAdapterError):
                validate_part(value,partition(d['generation']['fields'])[0],r)

    def test_v2_collects_raw_markers_without_weakening_citation_validation(self):
        h,d,r,reads,values=fixture()
        fields=partition(d['generation']['fields'])[0]
        invalid_markers=('[[unknown]]','[[[s1:1:1]]]','[[s1:1:1]','[s1:1:1]]',
                         '[[s1: 1:1]]','[[s1:1:1\n]]','[[]]','[[s1:1:1]]]',
                         '[[s1:1:1]] [[unfinished')
        for marker in invalid_markers:
            with self.subTest(marker=marker):
                value=deepcopy(values[0]);value['replacements'][0]['text']=marker
                with self.assertRaises(AIAdapterError):validate_part(value,fields,r)
                clarification={'action':'clarify','replacements':[],'clarification':'확인 '+marker}
                with self.assertRaises(AIAdapterError):validate_part(clarification,fields,r)
        old=deepcopy(values[0]);old['evidence_ids']=['s1:1:1']
        with self.assertRaises(AIAdapterError):validate_part(old,fields,r)
        many={f's1:{i}:1':next(iter(r.values())) for i in range(65)}
        value=deepcopy(values[0])
        value['replacements'][0]['text']=' '.join(f'[[{identifier}]]' for identifier in many)
        with self.assertRaises(AIAdapterError):validate_part(value,fields,many)
        valid=deepcopy(values[0]);valid['replacements'][0]['text']='조건 [[s1:1:1]] [[s1:1:1]]'
        self.assertEqual(validate_part(valid,fields,r),valid['replacements'])
        self.assertNotIn('evidence_ids',valid)

    def test_null_and_identical_original_fields_are_reviewed_but_not_replaced(self):
        h,d,r,reads,values=fixture()
        fields=d['generation']['fields']
        fields[0]['text']='```original code [[original-marker]]```'
        fields[1]['text']='긴 고정 설명 '*4000
        fields[2]['text']=''
        values[0]['replacements'][0]['text']=fields[0]['text']
        values[0]['replacements'][1]['text']=None
        values[0]['replacements'][2]['text']=None
        with TemporaryDirectory() as directory:
            owner=FakeOwner(directory);adapter=FakeAdapter(values)
            result,_=asyncio.run(run_template_parts(owner,adapter,h,reads,r,[],d,max_bytes=192*1024))
            content=result['value']['content']
            plan=json.loads(content.split('\n',1)[1].rsplit('\n',1)[0])
            self.assertEqual([item['id'] for item in plan['replacements']],[item['id'] for item in fields[3:]])
            assembly=json.loads((owner.directory/'template-assembly.json').read_text())
            reviewed=[{'id':field['id'],'text':field['text']} for field in fields[:3]]+[
                replacement for value in values for replacement in value['replacements']][3:]
            self.assertEqual(assembly['reviewed_fields_sha256'],canonical_json_hash(reviewed))
            self.assertEqual(assembly['changed_field_ids'],[item['id'] for item in fields[3:]])
            self.assertEqual(json.loads((owner.directory/'evidence-model-00.json').read_text())['value'],values[0])
        for value in values:
            for replacement in value['replacements']:replacement['text']=None
        with TemporaryDirectory() as directory:
            owner=FakeOwner(directory)
            with self.assertRaises(AIAdapterError):
                asyncio.run(run_template_parts(owner,FakeAdapter(values),h,reads,r,[],d,max_bytes=192*1024))
            self.assertFalse((owner.directory/'template-assembly.json').exists())

    def test_failure_or_cancel_preserves_raw_part_but_emits_no_assembly(self):
        for cancel in (False,True):
            h,d,r,reads,values=fixture()
            with TemporaryDirectory() as directory:
                owner=FakeOwner(directory)
                class CancelAdapter(FakeAdapter):
                    async def run(self,**kwargs):
                        result=await super().run(**kwargs)
                        owner.cancelled=True
                        return result
                adapter=CancelAdapter(values) if cancel else FakeAdapter(values,fail_at=2)
                with self.assertRaises((AIAdapterError,QuestionClientError)):
                    asyncio.run(run_template_parts(owner,adapter,h,reads,r,[],d,max_bytes=192*1024))
                self.assertFalse((owner.directory/'template-assembly.json').exists())
                self.assertTrue((owner.directory/'evidence-step-00/result.json').exists())
                self.assertFalse(any(kind=='answer_preview' for kind,_ in owner.events))

    def test_clarification_discards_partial_plan(self):
        h,d,r,reads,values=fixture()
        values[1]={"action":"clarify","replacements":[],"clarification":"어떤 승인 조건을 적용하나요 [[s1:1:1]]?"}
        with TemporaryDirectory() as directory:
            owner=FakeOwner(directory);adapter=FakeAdapter(values)
            result,_=asyncio.run(run_template_parts(owner,adapter,h,reads,r,[],d,max_bytes=192*1024))
            self.assertEqual(len(adapter.calls),2)
            self.assertNotIn('wiki-template-result',result['value']['content'])
            self.assertFalse(result['execution']['question_template_parts']['complete'])

    def test_global_citation_limit_and_rendered_text_limit_are_not_truncated(self):
        h,d,r,reads,values=fixture()
        r={f's1:{i}:1':next(iter(r.values())) for i in range(65)}
        number=0
        for value in values:
            for replacement in value['replacements']:
                identifier=f's1:{number}:1';number+=1
                replacement['text']=f'조건 [[{identifier}]]'
        with TemporaryDirectory() as directory:
            owner=FakeOwner(directory)
            with self.assertRaises(AIAdapterError):
                asyncio.run(run_template_parts(owner,FakeAdapter(values),h,reads,r,[],d,max_bytes=192*1024))
            self.assertFalse((owner.directory/'template-assembly.json').exists())
        h,d,r,reads,values=fixture(128)
        for value in values:
            for replacement in value['replacements']:
                replacement['text']='x'*385+' [[s1:1:1]]'
        with TemporaryDirectory() as directory:
            owner=FakeOwner(directory)
            with self.assertRaisesRegex(AIAdapterError,'ai_output_limit'):
                asyncio.run(run_template_parts(owner,FakeAdapter(values),h,reads,r,[],d,max_bytes=192*1024))
            self.assertFalse((owner.directory/'template-assembly.json').exists())

    def test_prompt_budget_fails_without_source_truncation(self):
        h,d,r,reads,values=fixture(); reads[0]['result']['items'][0]['text']='가'*70000
        before=deepcopy(reads)
        with self.assertRaisesRegex(AIAdapterError,'ai_input_limit'):
            part_prompt(h,reads,d,partition(d['generation']['fields']),0,[],192*1024)
        self.assertEqual(reads,before)

    def test_template_revision_and_field_uniqueness_are_bound(self):
        h,d,*_=fixture();d['template']['revision']='c'*64
        with self.assertRaisesRegex(AIAdapterError,'question_input_invalid'):template_fields(d,h['template_ref'])
        h,d,*_=fixture();d['generation']['fields'][1]['id']=d['generation']['fields'][0]['id']
        with self.assertRaisesRegex(AIAdapterError,'question_input_invalid'):template_fields(d,h['template_ref'])

    def test_authorized_template_get_preserves_profile_and_blocks_access_denial(self):
        h,d,*_=fixture()
        with TemporaryDirectory() as directory:
            owner=_QuestionExecution(None,base='http://localhost:8766',tenant='t',directory=Path(directory),profile='reviewer',
                on_event=None,cancel_event=None,poll_seconds=1,heartbeat_seconds=10)
            owner.state={'record':{'data':{'template_ref':h['template_ref']}}};owner.read=AsyncMock(return_value={});owner.check_active=lambda _:None
            with patch('core.client.question._call',new=AsyncMock(return_value=d)) as call:
                actual=asyncio.run(owner.read_registered_template(h['template_ref']))
                self.assertEqual(actual,d);self.assertTrue(call.call_args.args[2].endswith('/'+'b'*64+'?profile=reviewer'))
            with patch('core.client.question._call',new=AsyncMock(side_effect=QuestionClientError('access_denied'))):
                with self.assertRaisesRegex(QuestionClientError,'access_denied'):
                    asyncio.run(owner.read_registered_template(h['template_ref']))
            with self.assertRaisesRegex(QuestionClientError,'question_input_mismatch'):
                asyncio.run(owner.read_registered_template({'id':'c'*32,'revision':'b'*64}))

    def test_actual_template_api_parts_chat_storage_and_render_preserve_sources(self):
        from core.modules.templates.store import TemplateStore
        from core.tests.poc_templates.test_render import package, W
        from core.tests.poc_knowledge.test_question_template_sources import TemplateQuestionSourcesTests
        from core.tests.poc_knowledge.test_question_grounding import QuestionGroundingHTTPTests
        from core.client.question_grounding import run_grounded_model
        fixture = TemplateQuestionSourcesTests(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        original = package({'word/document.xml':
            f'<w:document xmlns:w="{W}"><w:body>' + ''.join(
                f'<w:p><w:r><w:t>[작성 {i}]</w:t></w:r></w:p>' for i in range(65))
            + '<w:sectPr/></w:body></w:document>'})
        template = TemplateStore(fixture.scope).save(request_id=uuid4().hex,name='큰 양식',instructions='조건 보존',
            filename='form.docx',content=original,before_commit=lambda:None)['template']
        fixture.template_ref = {key:template[key] for key in ('id','revision')}
        execution = fixture.start()
        detail = fixture.get(f"/templates/{template['id']}/versions/{template['revision']}")
        identifier = fixture.final_id(execution)
        values = [{'action':'write_fields','replacements':[{'id':item['id'],'text':f'조건 유지 [[{identifier}]].'} for item in group],
                   'clarification':None} for group in partition(detail['generation']['fields'])]
        before = QuestionGroundingHTTPTests.canonical_source_files(fixture)
        with TemporaryDirectory() as directory:
            owner = fixture.owner(directory,execution)
            async def read_registered(reference):
                self.assertEqual(reference,fixture.template_ref)
                return fixture.get(f"/templates/{reference['id']}/versions/{reference['revision']}")
            owner.read_registered_template = read_registered
            adapter = FakeAdapter(values)
            result,prompt = asyncio.run(run_grounded_model(owner,adapter,execution['handoff'],select_tools=True))
            self.assertEqual(len(adapter.calls),3)
            self.assertEqual(len(owner.queries),11)
            payload = answer_payload(result,handoff=execution['handoff'],prompt=prompt)
            fixture.submit(execution,{**payload,'request_id':uuid4().hex,
                'expected_state_revision':execution['active']['state_revision'],
                'run_id':execution['active']['runtime']['run_id'],
                'expected_conversation_revision':execution['conversation']['revision']})
        stored = fixture.get(f"/conversations/{execution['conversation']['record']['id']}")
        content = stored['record']['events'][-1]['content']
        self.assertEqual(content,payload['content'])
        response = fixture.client.post(fixture.base_url+f"/templates/{template['id']}/versions/{template['revision']}/render",
            json={'content':content},headers={'Authorization':'Bearer '+fixture.token})
        self.assertEqual(response.status_code,200,response.text if response.status_code!=200 else '')
        self.assertEqual(response.headers['x-content-sha256'],sha256(response.content).hexdigest())
        self.assertEqual(QuestionGroundingHTTPTests.canonical_source_files(fixture),before)
