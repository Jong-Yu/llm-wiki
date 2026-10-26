"""Explicit schema5 source contracts on synthetic isolated data only."""
from copy import deepcopy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core.modules.ontology.store import (
    OntologyStore,
)
from core.modules.ontology.errors import (
    OntologyValidationError, OntologyCorruptError,
)
from core.modules.ontology.validation import (
    _graph,
)
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.contracts import ReviewConflictError
from core.modules.reviews.values import _claim_id
from core.modules.documents.store import WikiStore, RevisionConflictError

DOCUMENT = 'synthetic/schema5.md'
SOURCE = ('캠페인과 두번째 캠페인에서 패키지와 선박은 N:M으로 대응한다.\n'
          '작업은 선박을 대상으로 작업 큐를 사용한다.\n'
          '첨부는 제안 이슈를 따른다.\n'
          '취득 목표는 절차가 필요하고 절차에 시험을 포함한다.\n'
          '문서는 수신처에 전달됐다.\n'
          '현업은 예상 시간 표시를 권고했다.\n')

def request(revision):
    entities = [{'id':i,'type':t,'label':label,'evidence':SOURCE.splitlines()[0]}
                for i,t,label in [('campaign','process','캠페인'),('second','process','두번째 캠페인'),
                                  ('package','concept','패키지'),('ship','physical_object','선박')]]
    def anchor(quote,line):
        return {'kind':'source_anchor','document':DOCUMENT,'source_revision':revision,'quote':quote,
                'start_line':line,'end_line':line,'occurrence':0}
    def relation(subject,predicate,obj,line,**extra):
        return {'subject':subject,'predicate':predicate,'object':obj,'evidence':SOURCE.splitlines()[line-1],**extra}
    relations = [
        relation('package','maps_to','ship',1,mapping={'within':'campaign','subject_cardinality':'many','object_cardinality':'many'}),
        relation(anchor('작업',2),'targets','ship',2,qualifiers={'modality':'planned'}),
        relation(anchor('첨부',3),'follows_reference',anchor('제안 이슈',3),3,qualifiers={'modality':'possible'}),
        relation(anchor('취득 목표',4),'requires',anchor('절차',4),4,qualifiers={'modality':'planned'}),
        relation(anchor('절차',4),'includes_step',anchor('시험',4),4,qualifiers={'modality':'planned'}),
        relation(anchor('문서',5),'delivered_to',anchor('수신처',5),5),
        relation(anchor('현업',6),'recommends',anchor('예상 시간 표시',6),6),
    ]
    return {'schema_version':5,'document':DOCUMENT,'expected_revision':revision,'entities':entities,'relations':relations}

class Schema5OntologyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=WikiStore(self.temp.name);self.onto=OntologyStore(self.store);self.reviews=ReviewStore(self.store)
        self.revision=self.store.save(DOCUMENT,SOURCE,expected_revision=None).revision
        self.args=request(self.revision)
    def files(self):
        return {str(p.relative_to(self.store.data_dir)):p.read_bytes() for p in self.store.data_dir.rglob('*') if p.is_file()}
    def generate(self,args=None):return self.onto.generate(**(self.args if args is None else args))
    def test_all_seven_predicates_and_mapping_roundtrip_no_approval(self):
        self.generate();q=self.onto.query(DOCUMENT);r=self.reviews.query(DOCUMENT)
        self.assertEqual(q['schema_version'],5);self.assertFalse(q['needs_reextraction'])
        self.assertEqual(len(q['relations']),7);self.assertEqual(q['relations'][0]['mapping'],self.args['relations'][0]['mapping'])
        self.assertEqual(r['machine_graph']['relations'],r['effective_graph']['relations'])
        self.assertTrue(all(c['decision']=='unreviewed' for c in r['claims']));self.assertEqual(r['history'],[])
        before=self.files();self.assertFalse(self.generate()['changed']);self.assertEqual(before,self.files())
    def test_new_predicates_and_mapping_rejected_by_legacy_versions(self):
        self.generate();before=self.files()
        for version in (1,2,3,4):
            for rel in self.args['relations']:
                args=deepcopy(self.args);args['schema_version']=version;args['relations']=[rel]
                with self.subTest(version=version,predicate=rel['predicate']):
                    with self.assertRaises(OntologyValidationError):self.generate(args)
        self.assertEqual(before,self.files())
    def test_default3_not_silently_upgraded(self):
        a=deepcopy(self.args);a.pop('schema_version')
        with self.assertRaises(OntologyValidationError):self.generate(a)
        self.assertFalse(self.onto._path(DOCUMENT).exists())
    def test_mapping_exact_shape_and_values_fail_closed(self):
        self.generate();before=self.files()
        invalid=[None,True,[],{}, {'within':'missing','subject_cardinality':'many','object_cardinality':'many'}]
        m=deepcopy(self.args['relations'][0]['mapping'])
        invalid += [{**m,'subject_cardinality':v} for v in (None,True,1,'one',[]) ]
        invalid += [{**m,'extra':1},{k:v for k,v in m.items() if k!='within'},{**m,'within':{'id':'campaign'}}]
        for mapping in invalid:
            args=deepcopy(self.args);args['relations'][0]['mapping']=mapping
            with self.subTest(mapping=mapping):
                with self.assertRaises(OntologyValidationError):self.generate(args)
        args=deepcopy(self.args);del args['relations'][0]['mapping']
        with self.assertRaises(OntologyValidationError):self.generate(args)
        self.assertEqual(before,self.files())
    def test_mapping_null_and_nonmapping_predicate_rejected(self):
        for version in (3,4,5):
            for value in (None,{'within':'campaign','subject_cardinality':'many','object_cardinality':'many'}):
                a=deepcopy(self.args);a['schema_version']=version;a['relations']=[{'subject':'package','predicate':'related_to','object':'ship','evidence':SOURCE.splitlines()[0],'mapping':value}]
                with self.assertRaises(OntologyValidationError):self.generate(a)
    def test_candidates_not_widened_or_given_mapping(self):
        for pred in ('maps_to','targets','requires'):
            a=deepcopy(self.args);a['relations']=[];a['relation_candidates']=[{'id':'c','subject':'package','predicate':pred,'object':'ship','evidence':SOURCE.splitlines()[0],'reason':'simulation','question':'pending'}]
            with self.assertRaises(OntologyValidationError):self.generate(a)
        a['relation_candidates'][0]['predicate']='related_to';a['relation_candidates'][0]['mapping']=self.args['relations'][0]['mapping']
        with self.assertRaises(OntologyValidationError):self.generate(a)
    def test_mapping_container_participates_in_identity_and_duplicate_key(self):
        a=deepcopy(self.args);a['relations']=[a['relations'][0],deepcopy(a['relations'][0])]
        with self.assertRaises(OntologyValidationError):self.generate(a)
        a['relations'][1]['mapping']['within']='second';self.generate(a);r=self.reviews.query(DOCUMENT)
        self.assertEqual(len(r['claims']),2);self.assertNotEqual(r['claims'][0]['claim_id'],r['claims'][1]['claim_id'])
    def test_legacy_claim_bytes_and_ids_unchanged_in_v5(self):
        legacy={'subject':'package','predicate':'related_to','object':'ship','evidence':SOURCE.splitlines()[0]}
        a=deepcopy(self.args);a['relations']=[legacy];a['schema_version']=3;self.generate(a);old=self.reviews.query(DOCUMENT)
        a['schema_version']=5;self.generate(a);new=self.reviews.query(DOCUMENT)
        self.assertEqual(old['claims'],new['claims']);self.assertNotIn('mapping',new['machine_graph']['relations'][0])
        self.assertEqual(old['machine_graph']['relations'],new['machine_graph']['relations'])
    def test_mapping_container_local_id_rename_keeps_semantic_claim_id(self):
        self.generate();q=self.onto.query(DOCUMENT);rel=q['relations'][0];entities=q['entities'];before=_claim_id('relations',rel,entities)
        changed=deepcopy(entities);next(e for e in changed if e['id']=='campaign')['id']='renamed';r=deepcopy(rel);r['mapping']['within']='renamed'
        self.assertEqual(before,_claim_id('relations',r,changed))
    def test_stored_invalid_mapping_is_unavailable_without_repair(self):
        self.generate();p=self.onto._path(DOCUMENT);g=json.loads(p.read_text());g['relations'][0]['mapping']['within']='absent';p.write_text(json.dumps(g));before=self.files()
        with self.assertRaises(OntologyCorruptError):self.onto.query(DOCUMENT)
        self.assertEqual(before,self.files())
    def test_old_v4_reader_rejects5_without_touching_files(self):
        self.generate();before=self.files();path=Path(__file__).parents[1]/'fixtures/ontology_v4.py'
        spec=importlib.util.spec_from_file_location('legacy_v4_isolated',path);old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
        with self.assertRaises(old.OntologyCorruptError):old._stored_graph(self.onto._path(DOCUMENT).read_bytes(),DOCUMENT)
        self.assertEqual(before,self.files())
    def test_strict_schema_integer_and_source_binding(self):
        self.generate();before=self.files()
        for version in (True,'5',5.0,None,0,7):
            a=deepcopy(self.args);a['schema_version']=version
            with self.assertRaises(OntologyValidationError):self.generate(a)
        a=deepcopy(self.args);a['relations'][1]['subject']['source_revision']='0'*64
        with self.assertRaises(OntologyValidationError):self.generate(a)
        self.assertEqual(before,self.files())
    def test_state_conflict_and_source_stale_preserve_data(self):
        self.generate();before=self.reviews.query(DOCUMENT);a=deepcopy(self.args);a['relations'][0]['mapping']['within']='second';a['expected_state_revision']=before['state_revision'];self.generate(a);saved=self.files()
        with self.assertRaises(ReviewConflictError):self.generate({**self.args,'expected_state_revision':before['state_revision']})
        self.assertEqual(saved,self.files())
        self.store.save(DOCUMENT,SOURCE+'추가 원문.\n',expected_revision=self.revision)
        q=self.onto.query(DOCUMENT);self.assertEqual(q['status'],'stale');self.assertEqual(q['relations'],[])
        saved=self.files()
        with self.assertRaises(RevisionConflictError):self.generate()
        self.assertEqual(saved,self.files())
    def test_publish_failure_preserves_previous_graph(self):
        self.generate();a=deepcopy(self.args);a['relations'][0]['mapping']['within']='second';before=self.files()
        with patch('core.modules.ontology.store.os.replace',side_effect=OSError('synthetic publication failure')):
            with self.assertRaises(OSError):self.generate(a)
        self.assertEqual(before,self.files())
    def test_attribute200_limit_is_unchanged(self):
        src='항목\n'+'\n'.join('항목%d 값%d'%(i,i) for i in range(201));rev=self.store.save('limits.md',src,expected_revision=None).revision
        entities=[{'id':'item','type':'concept','label':'항목','evidence':'항목'}]
        attrs=[{'id':'a%d'%i,'subject':'item','property':'항목%d'%i,'datatype':'text','value':'값%d'%i,'unit':None,'evidence':'항목%d 값%d'%(i,i)} for i in range(201)]
        self.onto.generate('limits.md',rev,entities,[],attributes=attrs[:200],schema_version=5);before=self.files()
        with self.assertRaises(OntologyValidationError):self.onto.generate('limits.md',rev,entities,[],attributes=attrs,schema_version=5)
        self.assertEqual(before,self.files())

if __name__=='__main__':unittest.main()
