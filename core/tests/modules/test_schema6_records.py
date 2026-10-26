"""Synthetic source-record annotations, bounded opt-in and historical compatibility."""
from copy import deepcopy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from core.modules.ontology.store import OntologyStore
from core.modules.ontology.errors import OntologyValidationError, OntologyCorruptError
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.contracts import ReviewConflictError, ReviewValidationError
from core.modules.reviews.values import _input
from core.modules.documents.store import WikiStore, RevisionConflictError
from core.modules.knowledge.concepts import ConceptStore
from core.modules.correspondences.store import CorrespondenceStore
from core.modules.knowledge.impact import ImpactStore
from tools.transition_check import check_transition
from tools.verify_ontology import response_schema, validate_v2_phase
from core.tests.modules.test_correspondences import correspondence_actor, correspondence_fixture
from core.tests.modules import test_schema5_ontology as v5

DOCUMENT='synthetic/records.md'
SOURCE=('요구A\n'
        '### Metadata\n'
        'Seq 1 · 모듈 육상 · 분류 기능 · 상태 검토중.\n'
        '### History\n'
        '[10.13 내부 검토] 질문: 배포 범위 확인 필요.\n')
def request(revision):
 def anchor(line):
  return {'kind':'source_anchor','document':DOCUMENT,'source_revision':revision,
          'quote':SOURCE.splitlines()[line-1],'start_line':line,'end_line':line,'occurrence':0}
 return {'document':DOCUMENT,'expected_revision':revision,'schema_version':6,
  'entities':[{'id':'req','type':'concept','label':'요구A','evidence':'요구A'},
              {'id':'module','type':'concept','label':'모듈','evidence':SOURCE.splitlines()[2]}],
  'relations':[{'subject':'req','predicate':pred,'object':anchor(line),'evidence':SOURCE.splitlines()[line-1]}
               for pred,line in [('has_source_metadata',3),('has_source_history',5)]]}
class SourceRecordTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.store=WikiStore(self.temp.name);self.onto=OntologyStore(self.store);self.reviews=ReviewStore(self.store)
  self.revision=self.store.save(DOCUMENT,SOURCE,expected_revision=None).revision
  self.args=request(self.revision);self.actor=correspondence_actor(domain=None,viewpoint=None)
 def files(self):return {str(p.relative_to(self.store.data_dir)):p.read_bytes() for p in self.store.data_dir.rglob('*') if p.is_file()}
 def generate(self,a=None):return self.onto.generate(**(self.args if a is None else a))
 def query(self):return self.reviews.query(DOCUMENT)
 def test_both_records_roundtrip_unreviewed_no_history_or_property_additions(self):
  self.generate();q=self.query();g=q['machine_graph']
  self.assertEqual(g['schema_version'],6);self.assertEqual(len(g['relations']),2)
  self.assertEqual(g['attributes'],[]);self.assertEqual(q['history'],[]);self.assertEqual(q['policies'],[])
  self.assertTrue(all(c['decision']=='unreviewed' for c in q['claims']))
  for r in g['relations']:self.assertEqual(r['qualifiers'],{'polarity':'positive','modality':'asserted','condition':None,'scope':None,'time':None})
  before=self.files();self.assertFalse(self.generate()['changed']);self.assertEqual(before,self.files())
 def test_legacy_versions_and_default_reject_new_predicates(self):
  for version in [1,2,3,4,5,None]:
   a=deepcopy(self.args)
   if version is None:a.pop('schema_version')
   else:a['schema_version']=version
   with self.subTest(version=version),self.assertRaises(OntologyValidationError):self.generate(a)
  self.assertFalse(self.onto._path(DOCUMENT).exists())
 def test_record_shape_and_all_nonliteral_qualifiers_rejected_without_mutation(self):
  self.generate();before=self.files();bad=[]
  a=deepcopy(self.args);a['relations'][0]['subject']=a['relations'][0]['object'];bad.append(a)
  a=deepcopy(self.args);a['relations'][0]['object']='module';bad.append(a)
  for k,v in [('polarity','negative'),('modality','planned'),('modality','possible'),('modality','capability'),('modality','hypothetical'),('condition','모듈'),('scope','모듈'),('time','모듈')]:
   a=deepcopy(self.args);a['relations'][0]['qualifiers']={k:v};bad.append(a)
  for a in bad:
   with self.subTest(relation=a['relations'][0]),self.assertRaises(OntologyValidationError):self.generate(a)
  self.assertEqual(before,self.files())
 def test_candidates_cannot_carry_record_predicates(self):
  for pred in ['has_source_metadata','has_source_history']:
   a=deepcopy(self.args);a['relations']=[];a['relation_candidates']=[{'id':'c','subject':'req','predicate':pred,'object':'module','evidence':SOURCE,'reason':'simulation','question':'pending'}]
   with self.assertRaises(OntologyValidationError):self.generate(a)
 def test_no_new_fields_and_anchor_source_binding_fail_closed(self):
  self.generate();before=self.files()
  for field,value in [('mapping',None),('actor','human'),('approval',True)]:
   a=deepcopy(self.args);a['relations'][0][field]=value
   with self.assertRaises(OntologyValidationError):self.generate(a)
  for field,value in [('source_revision','0'*64),('document','other.md'),('quote','invented'),('start_line',1)]:
   a=deepcopy(self.args);a['relations'][0]['object'][field]=value
   with self.assertRaises(OntologyValidationError):self.generate(a)
  self.assertEqual(before,self.files())
 def test_old_v5_reader_explicitly_rejects6_and_preserves_files(self):
  self.generate();before=self.files();p=Path(__file__).parents[1]/'fixtures/ontology_v5.py'
  spec=importlib.util.spec_from_file_location('old_v5_reader',p);old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
  with self.assertRaises(old.OntologyCorruptError):old._stored_graph(self.onto._path(DOCUMENT).read_bytes(),DOCUMENT)
  self.assertEqual(before,self.files())
 def test_v5_features_ids_and_populated_ledger_remain_exact_in6(self):
  revision=self.store.save(v5.DOCUMENT,v5.SOURCE,expected_revision=None).revision;a=v5.request(revision)
  p=Path(__file__).parents[1]/'fixtures/ontology_v5.py';spec=importlib.util.spec_from_file_location('old_v5_writer',p);old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
  old.OntologyStore(self.store).generate(**a);before=self.reviews.query(v5.DOCUMENT)
  accepted=self.reviews.review(v5.DOCUMENT,action='accept',claim_id=before['claims'][0]['claim_id'],expected_state_revision=before['state_revision'],reason='Synthetic simulation only',actor=self.actor)
  path=self.reviews._path(v5.DOCUMENT);ledger=path.read_bytes();digest=sha256(ledger).hexdigest()
  a['schema_version']=6;a['expected_state_revision']=accepted['state_revision'];self.onto.generate(**a);after=self.reviews.query(v5.DOCUMENT)
  self.assertEqual(before['claims'],after['claims']);self.assertEqual(before['machine_graph']['relations'],after['machine_graph']['relations'])
  self.assertEqual(path.read_bytes(),ledger);self.assertEqual(sha256(path.read_bytes()).hexdigest(),digest)
  self.assertEqual(after['history'],accepted['history']);self.assertTrue(after['pending_history'])
 def test_new_record_review_edit_undo_and_history_are_source_not_business_approval(self):
  self.generate();q=self.query();c=q['claims'][0]
  accepted=self.reviews.review(DOCUMENT,action='accept',claim_id=c['claim_id'],expected_state_revision=q['state_revision'],reason='Synthetic test, not a person approval',actor=self.actor)
  self.assertEqual(accepted['claims'][0]['decision'],'accept')
  undone=self.reviews.undo(DOCUMENT,event_id=accepted['event_id'],expected_state_revision=accepted['state_revision'],reason='Synthetic undo',actor=self.actor)
  self.assertEqual(undone['effective_graph']['relations'],q['machine_graph']['relations'])
  replacement=_input(c['value']);replacement['qualifiers']['modality']='planned';before=self.files()
  with self.assertRaises(OntologyValidationError):self.reviews.review(DOCUMENT,action='edit',claim_id=c['claim_id'],expected_state_revision=undone['state_revision'],reason='Synthetic invalid record edit',replacement=replacement,actor=self.actor)
  self.assertEqual(before,self.files())
 def test_expert_policy_cannot_manufacture_source_record_relation(self):
  self.generate();q=self.query();before=self.files()
  value={'subject':'req','predicate':'has_source_history','object':'module','qualifiers':{'polarity':'positive','modality':'asserted','condition':None,'scope':None,'time':None},'context':{'domain':None,'viewpoints':[]}}
  with self.assertRaises(ReviewValidationError):self.reviews.policy(DOCUMENT,claim_id=q['claims'][0]['claim_id'],replacement=value,expected_state_revision=q['state_revision'],reason='Synthetic unsupported predicate',actor=self.actor)
  self.assertEqual(before,self.files())
 def test_record_history_epoch_remains_readable_after_source_changes(self):
  self.generate();q=self.query();accepted=self.reviews.review(DOCUMENT,action='accept',claim_id=q['claims'][1]['claim_id'],expected_state_revision=q['state_revision'],reason='Synthetic source review',actor=self.actor)
  p=self.reviews._path(DOCUMENT);old=p.read_bytes();self.store.save(DOCUMENT,SOURCE+'추가 근거.\n',expected_revision=self.revision)
  current=self.query();self.assertEqual(current['status'],'stale');self.assertEqual(current['history'],accepted['history']);self.assertEqual(p.read_bytes(),old)
 def test_state_and_source_conflicts_preserve_files(self):
  self.generate();q=self.query();self.reviews.review(DOCUMENT,action='defer',claim_id=q['claims'][0]['claim_id'],expected_state_revision=q['state_revision'],reason='Synthetic defer',actor=self.actor)
  before=self.files()
  with self.assertRaises(ReviewConflictError):self.generate({**self.args,'expected_state_revision':q['state_revision']})
  self.assertEqual(before,self.files())
  self.store.save(DOCUMENT,SOURCE+'changed\n',expected_revision=self.revision);before=self.files()
  with self.assertRaises(RevisionConflictError):self.generate()
  self.assertEqual(before,self.files())
 def test_publication_failure_and_fresh_generation_restore(self):
  self.generate();before=self.files();a=deepcopy(self.args);a['relations']=a['relations'][:1]
  with patch('core.modules.ontology.store.os.replace',side_effect=OSError('synthetic publication fail')):
   with self.assertRaises(OSError):self.generate(a)
  self.assertEqual(before,self.files());self.generate(a);first=self.query()['graph_revision'];self.generate();self.assertNotEqual(first,self.query()['graph_revision'])
 def test_attribute200_limit_and_ontology_byte_limit_still_apply(self):
  source='項目\n'+'\n'.join('項目%d 値%d'%(i,i) for i in range(201));rev=self.store.save('limits.md',source,expected_revision=None).revision
  entities=[{'id':'item','type':'concept','label':'項目','evidence':'項目'}]
  attrs=[{'id':'a%d'%i,'subject':'item','property':'項目%d'%i,'datatype':'text','value':'値%d'%i,'unit':None,'evidence':'項目%d 値%d'%(i,i)} for i in range(201)]
  self.onto.generate('limits.md',rev,entities,[],attributes=attrs[:200],schema_version=6);before=self.files()
  with self.assertRaises(OntologyValidationError):self.onto.generate('limits.md',rev,entities,[],attributes=attrs,schema_version=6)
  self.assertEqual(before,self.files())
  with patch('core.modules.ontology.constants.MAX_ONTOLOGY_BYTES',10):
   with self.assertRaises(OntologyValidationError):self.generate()
  self.assertEqual(before,self.files())
 def test_consumers_context_concept_impact_connections_transition_preserve_record(self):
  self.generate();g=self.onto.query(DOCUMENT);before=self.files();ctx=self.onto.context([DOCUMENT]);self.assertTrue(ctx['complete']);self.assertEqual(ctx['documents'][0]['ontology']['relations'],g['relations'])
  concepts=ConceptStore(self.store,actor=self.actor);found=concepts.find('req',documents=[DOCUMENT],limit=100);target=next(x['target_ref'] for x in found['matches'] if x['target_ref'].get('kind')=='document_claim' and x['target_ref']['layer']=='machine')
  detail=concepts.query(target,documents=[DOCUMENT]);self.assertTrue(detail['complete']);self.assertEqual(detail['documents'][0]['machine_graph']['relations'],g['relations'])
  self.assertFalse(ImpactStore(self.store).query(DOCUMENT)['truncated']);self.assertFalse(self.onto.connections(DOCUMENT)['truncated']);self.assertTrue(check_transition(self.store.data_dir,tenant='synthetic')['ok']);self.assertEqual(before,self.files())
 def test_correspondence_snapshot_preserves_new_record(self):
  self.generate();q=self.query();claim=q['claims'][0];draft=correspondence_fixture(self.store,basis='candidate')
  draft['condition']={'document':DOCUMENT,'source_revision':self.revision,'quote':SOURCE.splitlines()[2],'start_line':3,'end_line':3,'graph_ref':{'graph_revision':q['graph_revision'],'state_revision':q['state_revision'],'collection':'relations','layer':'machine','claim_id':claim['claim_id'],'snapshot':deepcopy(claim['value'])}}
  corr=CorrespondenceStore(self.store,self.actor);prepared=corr.query(draft=draft);cid=prepared['correspondence_id'];corr.propose(cid,prepared['draft'],prepared['state_revision'],'Synthetic source metadata reference');detail=corr.query(cid)
  self.assertTrue(detail['complete']);self.assertEqual(detail['source_proposal']['value']['condition']['graph_ref']['snapshot'],claim['value'])
 def test_response_schema_and_structure_evaluator_have_only_explicit6_source_links(self):
  self.generate();g=self.onto.query(DOCUMENT);output={'id':'fixture',**{k:_input(g[k]) for k in ['entities','relations','attributes','relation_candidates']},'omissions':[]};case={'id':'fixture','document':DOCUMENT,'source':SOURCE,'split':'dev'}
  result=validate_v2_phase([case],{'cases':[output]},schema_version=6);self.assertEqual(result['overall']['invalid_graphs'],0,result);self.assertIsNone(result['semantic_acceptance'])
  shape=response_schema(6)['properties']['cases']['items']['properties'];self.assertIn('has_source_history',shape['relations']['items']['properties']['predicate']['enum']);self.assertNotIn('has_source_history',shape['relation_candidates']['items']['properties']['predicate']['enum'])
  self.assertEqual(len(shape['relations']['items']['allOf']),2)

if __name__=='__main__':unittest.main()
