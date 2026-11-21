-- Bots nos módulos de área (Condomínio, Ensino, Jurídico e Saúde): o
-- bloqueio fixo virou opção do administrador, desligada por padrão
-- (src/bot-actions/area.ts).
-- * bot_area_grants: o que está ligado para cada bot na área. Sem linha,
--   desligado. kind 'operation' é a operação liberada; 'direct' é a execução
--   direta de uma escrita (sem a pessoa confirmar), que só vale junto da
--   operação; 'sensitive_fields' é "incluir campos sensíveis" do módulo
--   (operation guarda o id do módulo).
-- * bot_area_grant_log: registro de quem ligou ou desligou o quê, quando e
--   para qual bot, e de cada uso das operações pelo bot.
-- Só tabelas novas.

CREATE TABLE bot_area_grants (
  profile_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  module TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('operation', 'direct', 'sensitive_fields')),
  operation TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, bot_id, kind, operation)
);

CREATE TABLE bot_area_grant_log (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  module TEXT NOT NULL,
  kind TEXT NOT NULL,
  operation TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('on', 'off', 'used')),
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);

CREATE INDEX bot_area_grant_log_bot ON bot_area_grant_log (profile_id, bot_id, created);
