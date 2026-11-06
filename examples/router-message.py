"""Enfileira um pedido e consulta uma vez. Biblioteca padrão; nunca repete sozinho."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

if len(sys.argv) < 2:
    raise SystemExit("Uso: python3 router-message.py mensagem.json [--allow-paid]")
names = ("WABOTIA_URL", "WABOTIA_KEY", "WABOTIA_PROFILE", "WABOTIA_REQUEST_ID")
if not all(os.environ.get(key) for key in names):
    raise SystemExit("Configure " + ", ".join(names))
with open(sys.argv[1], encoding="utf-8") as source:
    body = json.load(source)
if body.get("template") and ("--allow-paid" not in sys.argv[2:] or body.get("allow_paid") is not True):
    raise SystemExit("Modelo pago: confirme allow_paid: true no JSON e --allow-paid para autorizar este envio.")
base = os.environ["WABOTIA_URL"].rstrip("/") + "/api/v1/profiles/" + urllib.parse.quote(os.environ["WABOTIA_PROFILE"], safe="") + "/router/messages"
headers = {"Authorization": "Bearer " + os.environ["WABOTIA_KEY"], "Content-Type": "application/json", "Idempotency-Key": os.environ["WABOTIA_REQUEST_ID"]}
try:
    request = urllib.request.Request(base, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=60) as response:
        result = json.load(response)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    request = urllib.request.Request(base + "/" + urllib.parse.quote(result["delivery_id"], safe=""), headers={"Authorization": headers["Authorization"]})
    with urllib.request.urlopen(request, timeout=15) as response:
        print(json.dumps(json.load(response), ensure_ascii=False, indent=2))
except urllib.error.HTTPError as error:
    raise SystemExit(error.read().decode()) from None
# Se POST foi aceito e GET falhou, consulte o delivery_id; não gere outro pedido.
