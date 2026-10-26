"""Bounded v4 source-endpoint behavior using synthetic temporary data only."""
from copy import deepcopy
from hashlib import sha256
import json
import importlib.util
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
from core.modules.ontology.snapshots import (
    _stored_graph,
)
from core.modules.documents.store import WikiStore, RevisionConflictError


def anchor_fixture(source=None):
    source = source or '정의 문서의 뜻은 업로드 기준이다.\r\n육상 앱은 개발 공간에서 실행·시험 가능(검토 기록).\n'
    revision = sha256(source.encode()).hexdigest()
    def anchor(quote, occurrence=0):
        return {'kind':'source_anchor','document':'A.md','source_revision':revision,
                'quote':quote,'start_line':2,'end_line':2,'occurrence':occurrence}
    entities = [{'id':'note','type':'concept','label':'정의','evidence':'정의 문서의 뜻은 업로드 기준이다.'}]
    relations = [{'subject':anchor('개발 공간'),'predicate':'enables','object':anchor('실행·시험'),
                  'evidence':'육상 앱은 개발 공간에서 실행·시험 가능(검토 기록).',
                  'qualifiers':{'modality':'capability','scope':'육상 앱'},'provenance':{'basis':'검토 기록'}}]
    attributes = [{'id':'definition','subject':'note','property':'뜻','datatype':'text',
                   'value':'업로드 기준','unit':None,'evidence':entities[0]['evidence']}]
    return source, entities, relations, attributes


class AnchorOntologyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=WikiStore(Path(self.tmp.name));self.ontology=OntologyStore(self.store)
        self.source,self.entities,self.relations,self.attributes=anchor_fixture()
        self.revision=self.store.save('A.md',self.source,expected_revision=None).revision

    def generate(self, relations=None, version=4, **kwargs):
        return self.ontology.generate('A.md',self.revision,self.entities,
            self.relations if relations is None else relations,attributes=self.attributes,schema_version=version,**kwargs)

    def files(self):
        return {str(p.relative_to(self.store.data_dir)):p.read_bytes() for p in self.store.data_dir.rglob('*') if p.is_file()}

    def test_roundtrip_and_full_context_preserve_mentions(self):
        self.generate();q=self.ontology.query('A.md')
        self.assertEqual(q['schema_version'],4);self.assertFalse(q['needs_reextraction'])
        self.assertEqual(q['relations'][0]['subject'],self.relations[0]['subject'])
        self.assertEqual(q['relations'][0]['qualifiers']['modality'],'capability')
        self.assertEqual(q['relations'][0]['provenance']['basis'],'검토 기록')
        self.assertEqual(q['attributes'][0]['value'],'업로드 기준')
        self.assertEqual(len(q['entities']),1)

    def test_default_v3_does_not_accept_anchor(self):
        with self.assertRaises(OntologyValidationError):self.generate(version=3)

    def test_candidates_are_not_widened(self):
        candidate={**self.relations[0],'id':'candidate','reason':'모의','question':'근거?'}
        with self.assertRaises(OntologyValidationError):
            self.ontology.generate('A.md',self.revision,self.entities,[],[candidate],schema_version=4)

    def test_attribute_subject_is_still_entity_id(self):
        self.attributes[0]['subject']=self.relations[0]['subject']
        with self.assertRaises(OntologyValidationError):self.generate()

    def test_provenance_cannot_be_an_anchor(self):
        self.relations[0]['provenance']['source_entity']=self.relations[0]['subject']
        with self.assertRaises(OntologyValidationError):self.generate()

    def test_binding_errors_preserve_existing_graph(self):
        self.generate();before=self.files()
        for field,value in [('document','B.md'),('document','../A.md'),('source_revision','0'*64)]:
            with self.subTest(field=field,value=value):
                relations=deepcopy(self.relations);relations[0]['subject'][field]=value
                with self.assertRaises(OntologyValidationError):self.generate(relations)
                self.assertEqual(self.files(),before)

    def test_unknown_fields_or_kinds_rejected(self):
        for delta in [{'kind':'entity'},{'graph_ref':{}},{'approval':True}]:
            with self.subTest(delta=delta):
                relations=deepcopy(self.relations);relations[0]['subject'].update(delta)
                with self.assertRaises(OntologyValidationError):self.generate(relations)

    def test_position_shape_is_strict(self):
        for field,value in [('start_line',True),('start_line',0),('end_line',1),('occurrence',True),('occurrence',-1)]:
            with self.subTest(field=field,value=value):
                r=deepcopy(self.relations);r[0]['subject'][field]=value
                with self.assertRaises(OntologyValidationError):self.generate(r)

    def test_nonexistent_occurrence_is_not_silently_rematched(self):
        self.relations[0]['subject']['occurrence']=1
        with self.assertRaises(OntologyValidationError):self.generate()

    def test_wrong_declared_line_rejected(self):
        self.relations[0]['subject'].update(start_line=1,end_line=1)
        with self.assertRaises(OntologyValidationError):self.generate()

    def test_endpoint_must_be_inside_relation_quote(self):
        self.relations[0]['subject'].update(quote='정의',start_line=1,end_line=1)
        with self.assertRaises(OntologyValidationError):self.generate()

    def test_same_line_occurrence_outside_evidence_rejected(self):
        source='앞 개발 공간 끝. 육상 앱은 개발 공간에서 실행·시험 가능(검토 기록).\n'
        revision=self.store.save('B.md',source,expected_revision=None).revision
        r=deepcopy(self.relations)
        for e in [r[0]['subject'],r[0]['object']]:e.update(document='B.md',source_revision=revision,start_line=1,end_line=1)
        with self.assertRaises(OntologyValidationError):self.ontology.generate('B.md',revision,[],r,schema_version=4)
        r[0]['subject']['occurrence']=1
        self.ontology.generate('B.md',revision,[],r,schema_version=4)

    def test_ambiguous_whole_relation_evidence_rejected(self):
        source=self.source+self.relations[0]['evidence']+'\n'
        revision=self.store.save('B.md',source,expected_revision=None).revision
        r=deepcopy(self.relations)
        for e in [r[0]['subject'],r[0]['object']]:e.update(document='B.md',source_revision=revision)
        with self.assertRaises(OntologyValidationError):self.ontology.generate('B.md',revision,self.entities,r,schema_version=4)

    def test_both_document_and_revision_bound_under_lock(self):
        self.generate();self.store.save('A.md',self.source+'추가\n',expected_revision=self.revision);before=self.files()
        with self.assertRaises(RevisionConflictError):self.generate()
        self.assertEqual(self.files(),before)

    def test_stale_graph_hides_old_anchor_claims(self):
        self.generate();self.store.save('A.md',self.source+'추가\n',expected_revision=self.revision)
        q=self.ontology.query('A.md');self.assertEqual(q['status'],'stale');self.assertEqual(q['relations'],[])

    def test_structurally_valid_but_wrong_stored_position_is_corrupt(self):
        self.generate();path=self.ontology._path('A.md');raw=json.loads(path.read_text())
        raw['relations'][0]['subject'].update(start_line=1,end_line=1)
        path.write_text(json.dumps(raw,ensure_ascii=False))
        with self.assertRaises(OntologyCorruptError):self.ontology.query('A.md')

    def test_duplicate_anchor_relation_rejected(self):
        with self.assertRaises(OntologyValidationError):self.generate(self.relations*2)

    def test_repeated_generation_is_noop_and_reads_do_not_write(self):
        self.generate();before=self.files();self.assertFalse(self.generate()['changed'])
        self.ontology.query('A.md');self.assertEqual(self.files(),before)

    def test_v4_does_not_raise_any_collection_limit(self):
        for field,count in [('entities',101),('relations',201),('attributes',201)]:
            with self.subTest(field=field):
                args={'entities':self.entities,'relations':self.relations,'attributes':self.attributes}
                args[field]=[deepcopy(args[field][0]) for _ in range(count)]
                with self.assertRaises(OntologyValidationError):
                    self.ontology.generate('A.md',self.revision,args['entities'],args['relations'],attributes=args['attributes'],schema_version=4)

    def test_stored_anchor_source_binding_is_checked_without_current_source(self):
        self.generate();path=self.ontology._path('A.md');raw=json.loads(path.read_text())
        raw['relations'][0]['subject']['source_revision']='0'*64
        with self.assertRaises(OntologyCorruptError):_stored_graph(json.dumps(raw).encode(),'A.md')

    def test_unsupported_version_is_explicit(self):
        with self.assertRaises(OntologyValidationError):self.generate(version=7)

    def test_publish_failure_preserves_preceding_v3_graph_and_source(self):
        self.ontology.generate('A.md',self.revision,self.entities,[],attributes=self.attributes)
        before=self.files()
        with patch('core.modules.ontology.store.os.replace',side_effect=OSError('synthetic publish failure')):
            with self.assertRaises(OSError):self.generate()
        self.assertEqual(self.files(),before)
        self.assertEqual(self.ontology.query('A.md')['schema_version'],3)

    def test_mixed_string_and_anchor_endpoints_do_not_create_entities(self):
        r=deepcopy(self.relations);r[0]['subject']='note'
        self.generate(r);q=self.ontology.query('A.md')
        self.assertEqual(q['relations'][0]['subject'],'note')
        self.assertEqual(q['relations'][0]['object'],r[0]['object'])
        self.assertEqual(len(q['entities']),1)

    def test_old_reader_rejects_new_format_without_changing_data(self):
        self.generate();before=self.files()
        legacy_path=Path(__file__).resolve().parents[1] / 'fixtures' / 'ontology_v3.py'
        spec=importlib.util.spec_from_file_location('legacy_ontology_readonly',legacy_path)
        legacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(legacy)
        with self.assertRaises(legacy.OntologyCorruptError):
            legacy._stored_graph(self.ontology._path('A.md').read_bytes(),'A.md')
        self.assertEqual(self.files(),before)


if __name__=='__main__':unittest.main()
