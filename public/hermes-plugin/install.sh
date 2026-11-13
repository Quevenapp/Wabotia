#!/usr/bin/env bash
# Instala o plugin Wabotia no Hermes Agent e pareia com uma instalação Wabotia.
# Uso: install.sh https://SUA_INSTALACAO wabp_CODIGO [perfil ...]
# Não reinicia serviços, não abre portas e não envia chaves do Hermes.
set -euo pipefail
umask 077

URL="${1:-}"
CODE="${2:-}"
[ "$#" -ge 2 ] && shift 2 || true
HERMES_BIN="${HERMES_BIN:-hermes}"
ROOT="${HERMES_HOME:-$HOME/.hermes}"
case "$ROOT" in */profiles/*) ROOT="$(dirname "$(dirname "$ROOT")")" ;; esac
DEST="$ROOT/plugins/wabotia"
ENV_FILE="$ROOT/.env"

fail() { echo "Não concluído: $*" >&2; exit 1; }
URL="${URL%/}"
printf '%s' "$URL" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' \
  || fail "informe o endereço https da instalação Wabotia, sem caminho."
printf '%s' "$CODE" | grep -Eq '^wabp_[0-9a-f-]{36}_[0-9a-f]{32}$' \
  || fail "código de pareamento inválido. Gere outro no painel, em Conexões."
command -v curl >/dev/null || fail "instale o curl."
command -v "$HERMES_BIN" >/dev/null || fail "Hermes não encontrado. Use HERMES_BIN=/caminho/do/hermes."
[ -d "$ROOT" ] || fail "pasta do Hermes não encontrada em $ROOT. Use HERMES_HOME."
for profile in "$@"; do
  printf '%s' "$profile" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,63}$' || fail "nome de perfil inválido: $profile"
done

echo "1/5 · Baixando o plugin de $URL"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
for file in plugin.yaml __init__.py adapter.py link.py; do
  curl -fsSL "$URL/hermes-plugin/$file" -o "$STAGE/$file" || fail "não foi possível baixar $file."
done
grep -q '^name: wabotia$' "$STAGE/plugin.yaml" || fail "o endereço não respondeu com o plugin Wabotia."

echo "2/5 · Pareando com o Wabotia"
HOST="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-100)"
RESPONSE="$(curl -sS -X POST -H 'Content-Type: application/json' \
  --data "{\"code\":\"$CODE\",\"host\":\"$HOST\",\"plugin_version\":\"1.0.0\"}" \
  "$URL/api/hermes-link/pair")" || fail "o Wabotia não respondeu ao pareamento."
TOKEN="$(printf '%s' "$RESPONSE" | grep -Eo '"link_token":"wabl_[0-9a-f_-]+"' | cut -d'"' -f4 || true)"
[ -n "$TOKEN" ] || fail "código recusado (usado ou expirado). Gere outro no painel."

echo "3/5 · Instalando em $DEST"
mkdir -p "$DEST"
cp "$STAGE"/plugin.yaml "$STAGE"/__init__.py "$STAGE"/adapter.py "$STAGE"/link.py "$DEST"/
set_env() {
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  { grep -v "^$1=" "$ENV_FILE" || true; printf '%s=%s\n' "$1" "$2"; } > "$STAGE/env"
  cat "$STAGE/env" > "$ENV_FILE"
}
set_env WABOTIA_URL "$URL"
set_env WABOTIA_LINK_TOKEN "$TOKEN"

echo "4/5 · Habilitando a API local do Hermes (somente 127.0.0.1)"
warn() { echo "  Atenção: $*" >&2; }
"$HERMES_BIN" config set gateway.api_server.enabled true >/dev/null || warn "habilite gateway.api_server.enabled manualmente."
"$HERMES_BIN" config set gateway.api_server.host 127.0.0.1 >/dev/null || warn "defina gateway.api_server.host como 127.0.0.1."
new_key() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
for profile in default "$@"; do
  if [ "$profile" = default ]; then file="$ROOT/.env"; else file="$ROOT/profiles/$profile/.env"; fi
  if [ "$profile" != default ] && [ ! -d "$ROOT/profiles/$profile" ]; then
    warn "perfil $profile não existe neste Hermes; ignorado."
    continue
  fi
  if grep -Eq '^(export +)?API_SERVER_KEY=.+' "$file" 2>/dev/null; then
    echo "  $profile: chave da API já existente, preservada."
  elif "$HERMES_BIN" -p "$profile" config set API_SERVER_KEY "$(new_key)" >/dev/null; then
    echo "  $profile: chave da API criada."
  else
    warn "não foi possível criar a API_SERVER_KEY do perfil $profile."
  fi
done

echo "5/5 · Ativando o plugin"
"$HERMES_BIN" plugins enable wabotia >/dev/null || warn "execute: hermes plugins enable wabotia"
"$HERMES_BIN" config set gateway.platforms.wabotia.enabled true >/dev/null \
  || warn "ative gateway.platforms.wabotia.enabled no config.yaml."

cat <<'DONE'

Pronto. Falta só:
  1. Reiniciar o gateway do Hermes pelo método que você já usa.
  2. No painel do Wabotia, no cartão da conexão: Testar conexão, Descobrir bots e Ativar.

Perfis sem API_SERVER_KEY não aparecem como bots. Para incluir outros perfis,
repita este comando com os nomes ao final (gere um código novo no painel).
DONE
