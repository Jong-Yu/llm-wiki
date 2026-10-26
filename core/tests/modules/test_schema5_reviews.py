"""Synthetic ledger, selectors and captured snapshot compatibility for v5."""
from copy import deepcopy
from hashlib import sha256
import unittest
from core.tests.modules import test_schema5_ontology as fixtures
from core.modules.reviews.contracts import ReviewConflictError
from core.modules.reviews.values import _input
from core.modules.knowledge.concepts import ConceptStore
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.knowledge.impact import ImpactStore
from tools.transition_check import check_transition
from tools.verify_ontology import response_schema, validate_v2_phase
from core.tests.modules.test_correspondences import correspondence_actor, correspondence_fixture

class Schema5ReviewTests(unittest.TestCase):
    files=fixtures.Schema5OntologyTests.files
    generate=fixtures.Schema5OntologyTests.generate
    def setUp(self):
        fixtures.Schema5OntologyTests.setUp(self)
        self.actor=correspondence_actor(domain=None,viewpoint=None)
    def query(self):return self.reviews.query(fixtures.DOCUMENT)
    def review(self,action,*,snapshot=None,replacement=None):
        q=snapshot or self.query();claim=q['claims'][0];args={}
        if replacement is not None:args.update(replacement=replacement)
        return self.reviews.review(fixtures.DOCUMENT,action=action,claim_id=claim['claim_id'],expected_state_revision=q['state_revision'],reason='Synthetic simulation, not human approval',actor=self.actor,**args)
    def test_accept_reject_defer_undo_keep_mapping_and_container(self):
        self.generate();original=self.query();accepted=self.review('accept')
        self.assertEqual(len(accepted['history'][0]['target']['entities']),3)
        self.assertEqual(accepted['claims'][0]['decision'],'accept')
        rejected=self.review('reject');self.assertEqual(len(rejected['effective_graph']['relations']),6)
        undone=self.reviews.undo(fixtures.DOCUMENT,event_id=rejected['event_id'],expected_state_revision=rejected['state_revision'],reason='Synthetic undo',actor=self.actor)
        self.assertEqual(undone['effective_graph']['relations'][0]['mapping'],original['machine_graph']['relations'][0]['mapping'])
        deferred=self.review('defer');self.assertEqual(deferred['claims'][0]['decision'],'defer')
        before=self.files();self.assertEqual(self.query()['history'],deferred['history']);self.assertEqual(before,self.files())
    def test_source_edit_mapping_keeps_target_and_new_container_snapshot(self):
        self.generate();q=self.query();replacement=_input(q['claims'][0]['value']);replacement['mapping']['within']='second';edited=self.review('edit',replacement=replacement)
        self.assertEqual(edited['effective_graph']['relations'][0]['mapping']['within'],'second')
        self.assertEqual({e['id'] for e in edited['history'][0]['target']['entities']},{'campaign','second','package','ship'})
        self.assertEqual(self.query()['effective_graph'],edited['effective_graph'])
    def test_policy_target_mapping_and_undo_preserve_source_fields(self):
        self.generate();q=self.query();replacement={'subject':'package','predicate':'related_to','object':'ship','qualifiers':{'polarity':'positive','modality':'asserted','condition':None,'scope':None,'time':None},'context':{'domain':None,'viewpoints':[]}}
        result=self.reviews.policy(fixtures.DOCUMENT,claim_id=q['claims'][0]['claim_id'],replacement=replacement,expected_state_revision=q['state_revision'],reason='Synthetic policy only',actor=self.actor)
        self.assertEqual(result['history'][0]['target']['claim']['mapping']['within'],'campaign')
        undone=self.reviews.policy_undo(fixtures.DOCUMENT,event_id=result['event_id'],expected_state_revision=result['state_revision'],reason='Synthetic policy undo',actor=self.actor)
        self.assertEqual(undone['effective_graph']['relations'],q['machine_graph']['relations'])
        self.assertEqual(self.query()['history'],undone['history'])
    def test_v3_populated_ledger_exact_after5_generation_and_pending(self):
        a=deepcopy(self.args);a['schema_version']=3;a['relations']=[{'subject':'package','predicate':'related_to','object':'ship','evidence':fixtures.SOURCE.splitlines()[0]}];self.generate(a)
        accepted=self.review('accept');p=self.reviews._path(fixtures.DOCUMENT);old=p.read_bytes();self.generate({**self.args,'expected_state_revision':accepted['state_revision']});q=self.query()
        self.assertEqual(p.read_bytes(),old);self.assertEqual(q['history'],accepted['history']);self.assertTrue(q['pending_history']);self.assertTrue(all(c['decision']=='unreviewed' for c in q['claims']))
    def test_v4_anchor_claim_id_value_and_ledger_bytes_exact_after5_generation(self):
        args=deepcopy(self.args);args['schema_version']=4
        relation=deepcopy(args['relations'][1]);relation['predicate']='related_to';args['relations']=[relation]
        self.generate(args);original=self.query();accepted=self.review('accept')
        path=self.reviews._path(fixtures.DOCUMENT);ledger=path.read_bytes();old_hash=sha256(ledger).hexdigest()
        args['schema_version']=5;args['expected_state_revision']=accepted['state_revision'];self.generate(args);current=self.query()
        self.assertEqual(current['claims'][0]['claim_id'],original['claims'][0]['claim_id'])
        self.assertEqual(current['claims'][0]['value'],original['claims'][0]['value'])
        self.assertNotIn('mapping',current['claims'][0]['value'])
        self.assertEqual(current['history'],accepted['history']);self.assertEqual(path.read_bytes(),ledger)
        self.assertEqual(sha256(path.read_bytes()).hexdigest(),old_hash);self.assertTrue(current['pending_history'])
        self.assertEqual(current['claims'][0]['decision'],'unreviewed')
    def test_v5_historical_snapshot_remains_readable_after_source_change(self):
        self.generate();accepted=self.review('accept');p=self.reviews._path(fixtures.DOCUMENT);old=p.read_bytes()
        self.store.save(fixtures.DOCUMENT,fixtures.SOURCE+'추가 근거.\n',expected_revision=self.revision);q=self.query()
        self.assertEqual(q['status'],'stale');self.assertEqual(q['history'],accepted['history']);self.assertEqual(p.read_bytes(),old);self.assertEqual(q['claims'],[])
    def test_review_cas_conflict_preserves_populated_v5_ledger(self):
        self.generate();q=self.query();self.review('accept');before=self.files()
        with self.assertRaises(ReviewConflictError):self.review('defer',snapshot=q)
        self.assertEqual(before,self.files())
    def test_concept_context_and_impact_preserve_mapping_container(self):
        self.generate();graph=self.onto.query(fixtures.DOCUMENT);before=self.files();concepts=ConceptStore(self.store,actor=self.actor)
        found=concepts.find('campaign',documents=[fixtures.DOCUMENT],limit=100)
        target=next(m['target_ref'] for m in found['matches'] if m['target_ref'].get('kind')=='document_claim' and m['target_ref']['layer']=='machine')
        self.assertEqual(target['snapshot']['mapping']['within'],'campaign')
        detail=concepts.query(target,documents=[fixtures.DOCUMENT]);self.assertTrue(detail['complete']);self.assertEqual(detail['documents'][0]['machine_graph']['relations'],graph['relations'])
        self.assertTrue(any(e['id']=='campaign' for node in detail['map_context']['nodes'] for e in node['entities']))
        context=self.onto.context([fixtures.DOCUMENT]);self.assertTrue(context['complete']);self.assertEqual(context['documents'][0]['ontology']['relations'],graph['relations'])
        self.assertFalse(ImpactStore(self.store).query(fixtures.DOCUMENT)['truncated']);self.assertFalse(self.onto.connections(fixtures.DOCUMENT)['truncated']);self.assertEqual(before,self.files())
    def test_correspondence_graph_snapshot_keeps_mapping_and_currentness(self):
        self.generate();q=self.query();claim=q['claims'][0];draft=correspondence_fixture(self.store,basis='candidate')
        anchor={'document':fixtures.DOCUMENT,'source_revision':self.revision,'quote':fixtures.SOURCE.splitlines()[0],'start_line':1,'end_line':1,'graph_ref':{'graph_revision':q['graph_revision'],'state_revision':q['state_revision'],'collection':'relations','layer':'machine','claim_id':claim['claim_id'],'snapshot':deepcopy(claim['value'])}}
        draft['condition']=anchor;corr=CorrespondenceStore(self.store,self.actor);prepared=corr.query(draft=draft);cid=prepared['correspondence_id'];corr.propose(cid,prepared['draft'],prepared['state_revision'],'Synthetic mapping reference')
        detail=corr.query(cid);self.assertEqual(detail['source_proposal']['value']['condition']['graph_ref']['snapshot']['mapping'],claim['value']['mapping'])
        self.assertTrue(detail['complete']);self.assertEqual(detail['source_proposal']['decision'],'unreviewed')
    def test_transition_and_structure_evaluator_support5_without_meaning_grade(self):
        self.generate();q=self.onto.query(fixtures.DOCUMENT);self.assertTrue(check_transition(self.store.data_dir,tenant='synthetic')['ok'])
        output={'id':'fixture',**{name:_input(q[name]) for name in ['entities','relations','attributes','relation_candidates']},'omissions':[]};case={'id':'fixture','document':fixtures.DOCUMENT,'source':fixtures.SOURCE,'split':'dev'}
        result=validate_v2_phase([case],{'cases':[output]},schema_version=5);self.assertEqual(result['overall']['invalid_graphs'],0,result);self.assertIsNone(result['semantic_acceptance'])
        shapes=response_schema(5)['properties']['cases']['items']['properties'];self.assertNotIn('mapping',shapes['relation_candidates']['items']['properties'])

if __name__=='__main__':unittest.main()
