"""이전 대화를 고정 입력에 포함하고 최신 근거·소유권·옛 계약과 구별한다."""
from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4
import unittest

from core.tests.poc_knowledge.test_storage import KnowledgeFixture, ACTOR
from core.modules.personal.store import PersonalStore, PersonalConflictError
from core.modules.personal.question_runs import QuestionRunStore
from core.modules.knowledge.aggregation import prepare_question
from core.client.question_ai import assemble_question, question_answer_schema
from core.client.transport import AnalysisClientError
from core.common.json_codec import canonical_json_hash


class QuestionContextTests(KnowledgeFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.document(); self.generate()
        self.scope = SimpleNamespace(store=self.wiki, **ACTOR)
        self.personal = PersonalStore(self.scope)
        self.runs = QuestionRunStore(self.scope)
        self.basis = prepare_question(self.wiki, ACTOR, documents=['a.md'], required_documents=[], claims=[], source_refs=[])
        self.conversation = self.personal.create('conversations', uuid4().hex, {},
            {'title':'연속 질문'}, ACTOR, before_commit=lambda:None)

    def turn(self, role, content, reply_to=None):
        request_id = uuid4().hex
        event = {'role':role,'content':content,'basis':self.basis,'reply_to':reply_to,'status':'complete'}
        self.conversation = self.personal.append('conversations', self.conversation['record']['id'], request_id,
            self.conversation['revision'], event, event, ACTOR, before_commit=lambda:None)
        return request_id

    def create(self, question, revision=None):
        return self.runs.create(request_id=uuid4().hex, conversation_id=self.conversation['record']['id'],
            question_turn_id=question, expected_conversation_revision=revision or self.conversation['revision'],
            before_commit=lambda:None)

    def test_empty_selection_is_rejected_unless_explicitly_allowed(self):
        with self.assertRaises(ValueError):
            prepare_question(self.wiki, ACTOR, documents=[], required_documents=[], claims=[], source_refs=[])
        basis = prepare_question(self.wiki, ACTOR, documents=[], required_documents=[], claims=[], source_refs=[],
                                 allow_empty=True)
        self.assertTrue(basis['can_prepare']); self.assertTrue(basis['complete'])
        self.assertEqual((basis['documents'], basis['originals'], basis['skipped']), ([], [], []))
        self.assertEqual(basis['scope']['empty_selection'], 'no_matching_documents')
        # 문서를 고른 요청은 allow_empty와 무관하며 근거 묶음의 모양도 그대로다.
        chosen = prepare_question(self.wiki, ACTOR, documents=['a.md'], required_documents=[], claims=[], source_refs=[],
                                  allow_empty=True)
        self.assertNotIn('empty_selection', chosen['scope'])
        self.assertEqual(chosen['snapshot_revision'], self.basis['snapshot_revision'])

    def test_request_body_keeps_the_old_shape_unless_allow_empty_is_set(self):
        from core.api.v1.knowledge.schemas import QuestionContextRequest
        self.assertNotIn('allow_empty', QuestionContextRequest(documents=['a.md']).model_dump())
        self.assertEqual(QuestionContextRequest(allow_empty=True).model_dump(exclude={'profile'})['allow_empty'], True)

    def test_question_without_matching_documents_runs_with_no_citable_reference(self):
        self.basis = prepare_question(self.wiki, ACTOR, documents=[], required_documents=[], claims=[], source_refs=[],
                                      allow_empty=True)
        question = self.turn('user', '위키에 없는 내용을 묻는다.')
        made = self.create(question)
        handoff = self.runs._input(made['record'])
        self.assertEqual(handoff['output']['citation_references'], [])
        self.assertEqual(question_answer_schema(handoff)['properties']['citations']['maxItems'], 0)
        self.assertEqual(handoff['basis']['documents'], [])
        self.assertIn('위키에 없는 내용을 묻는다.', assemble_question(handoff, made['record']))

    def test_prefix_is_frozen_and_later_turns_are_not_injected(self):
        first=self.turn('user','내 비교 대상은 A다.')
        self.turn('assistant','A의 속성을 비교하겠습니다.',first)
        follow=self.turn('user','그 대상은 무엇을 사용하는가?')
        made=self.create(follow)
        handoff=self.runs._input(made['record'])
        self.assertEqual(handoff['contract_version'],'personal-question-v3')
        self.assertEqual([t['role'] for t in handoff['conversation_context']['turns']],['user','assistant'])
        self.assertEqual(handoff['conversation_context']['purpose'],'dialogue_context_only')
        prompt=assemble_question(handoff,made['record'])
        self.assertIn('내 비교 대상은 A다.',prompt)
        self.assertNotIn('"basis":',str(handoff['conversation_context']))
        self.turn('user','나중에 다른 질문')
        current=self.runs.read(made['record']['id'])
        self.assertEqual(self.runs._input(current['record']),handoff)
        self.assertNotIn('나중에 다른 질문',assemble_question(handoff,current['record']))
        self.assertTrue(question_answer_schema(handoff))

    def test_context_tamper_is_rejected_and_old_contract_is_unchanged(self):
        self.turn('user','처음 질문')
        made=self.create(self.turn('user','이어서 질문'))
        handoff=self.runs._input(made['record'])
        changed=deepcopy(handoff)
        changed['conversation_context']['turns'][0]['content']='tampered'
        with self.assertRaises(AnalysisClientError): assemble_question(changed,made['record'])
        legacy=deepcopy(made['record'])
        legacy['data'].pop('conversation_context')
        legacy['data']['input_contract_version']='personal-question-v2'
        previous=self.runs._input(legacy)
        self.assertNotIn('conversation_context',previous)
        self.assertEqual(previous['input_sha256'],canonical_json_hash({k:v for k,v in previous.items() if k!='input_sha256'}))
        self.assertTrue(assemble_question(previous,legacy))

    def test_stale_conversation_and_other_owner_are_rejected(self):
        first=self.turn('user','처음 질문')
        revision=self.conversation['revision']
        self.turn('user','새 질문')
        with self.assertRaises(PersonalConflictError): self.create(first,revision)
        made=self.create(first)
        other=QuestionRunStore(SimpleNamespace(store=self.wiki,**{**ACTOR,'user_id':'bob'}))
        with self.assertRaises(FileNotFoundError): other.read(made['record']['id'])


if __name__ == '__main__':
    unittest.main()
