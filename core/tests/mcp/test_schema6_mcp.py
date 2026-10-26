"""Real authenticated transport for synthetic source-record relations only."""
from copy import deepcopy
import unittest
from core.tests.mcp import test_schema5_mcp as base
from core.tests.modules import test_schema6_records as fixtures

class Schema6StdioTests(unittest.IsolatedAsyncioTestCase):
 save_policy=base.Schema5StdioTests.save_policy
 payload=base.Schema5StdioTests.payload
 snapshot=base.Schema5StdioTests.snapshot
 write=base.Schema5StdioTests.write
 http_server=base.Schema5StdioTests.http_server
 http_client=base.Schema5StdioTests.http_client
 client=base.Schema5StdioTests.client
 setUp=base.Schema5StdioTests.setUp
 async def seed(self,c):
  saved=self.payload(await self.write(c,fixtures.SOURCE,document=fixtures.DOCUMENT));a=fixtures.request(saved['revision']);a['tenant']='acme';return saved,a
 async def query(self,c):return self.payload(await c.call_tool('ontology_review_query',{'tenant':'acme','document':fixtures.DOCUMENT,'profile':'all'}))
 async def test_actual_stdio6_record_roundtrip_state_and_schema_default(self):
  policy=self.config_path.read_bytes()
  async with self.client() as c:
   schema=next(t for t in (await c.list_tools()).tools if t.name=='ontology_generate').input_schema
   self.assertEqual(schema['properties']['schema_version']['enum'],[3,4,5,6]);self.assertEqual(schema['properties']['schema_version']['default'],3)
   saved,a=await self.seed(c);self.payload(await c.call_tool('ontology_generate',a));q=await self.query(c)
   self.assertEqual(q['machine_graph']['schema_version'],6);self.assertEqual(q['history'],[]);self.assertEqual(q['policies'],[])
   self.assertTrue(all(x['decision']=='unreviewed' for x in q['claims']));self.assertEqual(len(q['machine_graph']['relations']),2)
   ctx=self.payload(await c.call_tool('ontology_context',{'tenant':'acme','documents':[fixtures.DOCUMENT],'profile':'all'}));self.assertTrue(ctx['complete']);self.assertEqual(ctx['documents'][0]['ontology']['relations'],q['machine_graph']['relations'])
   source=self.payload(await c.call_tool('wiki_read',{'tenant':'acme','document':fixtures.DOCUMENT}));self.assertEqual(source['content'],fixtures.SOURCE);self.assertEqual(source['revision'],saved['revision'])
  self.assertEqual(policy,self.config_path.read_bytes())
 async def test_actual_stdio6_readonly_and_shape_denials_preserve_data(self):
  async with self.client() as alice,self.client('bob') as bob:
   _,a=await self.seed(alice);self.payload(await alice.call_tool('ontology_generate',a));before=self.snapshot()
   self.payload(await bob.call_tool('ontology_generate',a),code='access_denied')
   for version in [3,4,5]:
    bad=deepcopy(a);bad['schema_version']=version;self.payload(await alice.call_tool('ontology_generate',bad),code='invalid_ontology')
   for field,value in [('subject',a['relations'][0]['object']),('object','module'),('qualifiers',{'modality':'planned'})]:
    bad=deepcopy(a);bad['relations'][0][field]=value;self.payload(await alice.call_tool('ontology_generate',bad),code='invalid_ontology')
   self.assertEqual(before,self.snapshot())
 async def test_actual_authenticated_http6_records_not_review_approval(self):
  policy=self.config_path.read_bytes()
  async with self.http_server() as url:
   async with self.http_client(url,mode='auto') as c:
    context=self.payload(await c.call_tool('access_context',{}));self.assertEqual(context['user_id'],'alice')
    _,a=await self.seed(c);self.payload(await c.call_tool('ontology_generate',a));q=await self.query(c)
    self.assertEqual(q['machine_graph']['schema_version'],6);self.assertEqual(q['history'],[]);self.assertTrue(all(x['needs_review'] for x in q['claims']))
  self.assertEqual(policy,self.config_path.read_bytes())

if __name__=='__main__':unittest.main()
