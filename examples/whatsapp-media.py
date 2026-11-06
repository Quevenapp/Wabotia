"""Python 3; uses only the standard library. Sends to an authorized conversation."""
import json, os, sys, urllib.request, urllib.error
from pathlib import Path
base = os.environ['WABOTIA_URL'].rstrip('/') + '/api/v1/profiles/' + os.environ['WABOTIA_PROFILE']
token, intent, conversation = (os.environ[k] for k in ('WABOTIA_KEY', 'WABOTIA_REQUEST_ID', 'WABOTIA_CONVERSATION'))
file = Path(sys.argv[1]); mime = sys.argv[2] if len(sys.argv)>2 else 'application/pdf'
kind = sys.argv[3] if len(sys.argv)>3 else 'document'
caption = sys.argv[4] if len(sys.argv)>4 else ''
def request(path, data, step, binary=False, method='POST'):
    req = urllib.request.Request(base+path, method=method, data=data if binary else json.dumps(data).encode(), headers={
        'Authorization':'Bearer '+token, 'Content-Type':'application/octet-stream' if binary else 'application/json', 'Idempotency-Key':intent+':'+step})
    try:
        with urllib.request.urlopen(req, timeout=120) as response: return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{error.code}: {error.read().decode()}. Preserve REQUEST_ID e os mesmos dados antes de repetir.') from None
upload = request('/media/uploads', {'name':file.name,'type':mime,'size':file.stat().st_size}, 'upload')
with file.open('rb') as stream:
    for number in range(1, upload['parts']+1):
        request(f"/media/uploads/{upload['id']}/parts/{number}",stream.read(upload['part_size']),f'part-{number}',True,'PUT')
request(f"/media/uploads/{upload['id']}/complete",{},'complete')
request(f'/conversations/{conversation}/actions',{'action':'claim'},'claim')
print(json.dumps(request(f'/conversations/{conversation}/actions',{'action':'reply','text':caption,'attachments':[upload['id']],'content':{'type':kind}},'reply')))
