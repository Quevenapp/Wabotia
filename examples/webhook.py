import hashlib, hmac, json, time
def verify_webhook(secret, headers, raw_body, now=None):
    timestamp=headers.get('Wabotia-Timestamp','')
    if not timestamp.isdigit() or abs((now or time.time())-int(timestamp))>300:return None
    expected='v1='+hmac.new(secret.encode(),timestamp.encode()+b'.'+raw_body,hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected,headers.get('Wabotia-Signature','')):return None
    event=json.loads(raw_body)
    return event if str(event['id'])==headers.get('Wabotia-Event-Id') else None
# Persista o ID com restrição UNIQUE e o trabalho a executar na mesma transação.
# Confirme o webhook com 2xx somente após persistir. Duplicatas recebem 2xx.
