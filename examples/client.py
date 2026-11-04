"""Python 3, apenas biblioteca padrão. Execute no backend do sistema integrador."""
import json, os, uuid, urllib.request, urllib.error
BASE=os.environ['WABOTIA_URL'].rstrip('/')
TOKEN=os.environ['WABOTIA_KEY']
def request(path, body=None, method=None, idempotency_key=None):
    method=method or ('POST' if body is not None else 'GET')
    headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json','User-Agent':'Wabotia-Example/0.1 (+https://github.com/Quevenapp/Wabotia)'}
    if method!='GET':headers['Idempotency-Key']=idempotency_key or str(uuid.uuid4())
    req=urllib.request.Request(BASE+'/api/v1'+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
profile=os.environ.get('WABOTIA_PROFILE') or request('/profiles')[0]['id']
p='/profiles/'+profile
c=request(p+'/conversations',{'external_id':'exemplo-'+str(uuid.uuid4()),'message_id':str(uuid.uuid4()),'text':'Solicitação enviada por Python.'})
request(p+'/conversations/'+c['conversation_id']+'/actions',{'action':'claim'})
request(p+'/conversations/'+c['conversation_id']+'/actions',{'action':'reply','text':'Solicitação recebida.'})
t=request(p+'/tickets',{'conversation_id':c['conversation_id'],'title':'Solicitação do sistema externo'})
print({'conversation_id':c['conversation_id'],'ticket':t['number']})
if os.environ.get('WABOTIA_BOT'):
    r=request('/bot-runs',{'profile_id':profile,'bot_id':os.environ['WABOTIA_BOT'],'input':'Retorne uma saudação curta, sem usar ferramentas.'})
    print(request('/bot-runs/'+r['id']))
