import asyncio, importlib.util, json, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('wabotia_transport',Path(__file__).resolve().parents[1]/'connectors/hermes/__init__.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Response:
    def __init__(self,value):self.value=value
    def json(self):return self.value
class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();home=Path(self.tmp.name)
        (home/'wabotia-connector.json').write_text(json.dumps({'url':'https://example.com','connection_id':'test','token':'fake','platform':'whatsapp'}))
        self.worker=module.Transport(home);self.calls=[]
        async def request(route,**kwargs):self.calls.append((route,kwargs));return Response({'id':'media-id'})
        self.worker.request=request
    async def asyncTearDown(self):self.worker.close();self.worker.db.close();self.tmp.cleanup()
    async def test_group_is_consumed_without_fallthrough(self):
        result=await self.worker.receive({'platform':'whatsapp','chat_type':'group'},None)
        self.assertTrue(result);self.assertEqual(self.calls,[])
    async def test_preserves_provider_id_on_replay(self):
        msg={'platform':'whatsapp','chat_type':'dm','chat':'5511@s.whatsapp.net','user':'5511','message_id':'provider-id','text':'Teste'}
        await self.worker.receive(msg,None);await self.worker.receive(msg,None)
        self.assertEqual([c[1]['body']['message_id'] for c in self.calls],['provider-id','provider-id'])
    async def test_caches_uploaded_media_on_replay(self):
        file=Path(self.tmp.name)/'image.txt';file.write_text('Anexo')
        msg={'platform':'whatsapp','chat_type':'dm','chat':'5511','user':'5511','message_id':'id','text':'','media':[{'path':str(file)}]}
        await self.worker.receive(msg,None);await self.worker.receive(msg,None)
        self.assertEqual([c[0] for c in self.calls],['/media','/events','/events'])
        self.assertEqual(self.calls[-1][1]['body']['attachments'],['media-id'])
if __name__=='__main__':unittest.main()
