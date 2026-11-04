#!/usr/bin/env bash
# cURL + Python 3 (somente para ler IDs do JSON).
set -euo pipefail
: "${WABOTIA_URL:?Defina WABOTIA_URL}" "${WABOTIA_KEY:?Defina WABOTIA_KEY}" "${WABOTIA_PROFILE:?Defina WABOTIA_PROFILE}"
call() {
  local method="$1" route="$2" body="${3:-}" operation
  operation="$(python3 -c 'import uuid;print(uuid.uuid4())')"
  # Em uma repetição por falha de rede, preserve a mesma operação e o mesmo corpo.
  # Este exemplo não faz retentativas automáticas.
  if [[ "$method" == GET ]]; then
    curl --fail-with-body --silent --show-error "$WABOTIA_URL/api/v1$route" -H "Authorization: Bearer $WABOTIA_KEY"
  else
    curl --fail-with-body --silent --show-error -X "$method" "$WABOTIA_URL/api/v1$route" -H "Authorization: Bearer $WABOTIA_KEY" -H 'Content-Type: application/json' -H "Idempotency-Key: $operation" --data "$body"
  fi
}
call GET /profiles
customer="$(python3 -c 'import uuid;print(uuid.uuid4())')"
p="/profiles/$WABOTIA_PROFILE"
conversation="$(call POST "$p/conversations" "{\"external_id\":\"exemplo-$customer\",\"message_id\":\"1\",\"text\":\"Preciso de atendimento.\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["conversation_id"])')"
call POST "$p/conversations/$conversation/actions" '{"action":"claim"}'
call POST "$p/conversations/$conversation/actions" '{"action":"reply","text":"Solicitação recebida."}'
call POST "$p/tickets" "{\"conversation_id\":\"$conversation\",\"title\":\"Solicitação pelo sistema externo\"}"
if [[ -n "${WABOTIA_BOT:-}" ]]; then
  run="$(call POST /bot-runs "{\"profile_id\":\"$WABOTIA_PROFILE\",\"bot_id\":\"$WABOTIA_BOT\",\"input\":\"Retorne uma saudação curta, sem usar ferramentas.\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
  call GET "/bot-runs/$run"
fi
