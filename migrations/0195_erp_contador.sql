-- Para o contador (src/erp/contador): o cadastro do contador em Preferências
-- do Fiscal, com o envio automático (desligado por padrão) e o anexo do
-- Simples de cada natureza, e o registro de cada envio do pacote com o link
-- de 7 dias. O pacote em si fica no objeto do ERP da área (versão 22) e no R2.
-- Só tabelas novas; nada é apagado nem reescrito.
CREATE TABLE IF NOT EXISTS erp_contador_settings (
  profile_id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  -- Só dígitos, com DDI.
  phone TEXT,
  -- whatsapp | email
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  -- Linha de WhatsApp da área que envia (connections.id); null: a primeira ativa.
  connection_id TEXT,
  -- Envio automático do mês anterior no dia auto_day: desligado por padrão.
  auto_enabled INTEGER NOT NULL DEFAULT 0,
  auto_day INTEGER NOT NULL DEFAULT 5,
  -- AAAA-MM do último mês já tratado pelo envio automático (enviado ou falhou).
  auto_last_month TEXT,
  -- Natureza da operação (descrição) → anexo do Simples (I a V), JSON.
  annexes TEXT NOT NULL DEFAULT '{}',
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS erp_contador_sends (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Pacote no objeto do ERP (erp_contador__package.id) e o período dele.
  package_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  -- whatsapp | email
  channel TEXT NOT NULL,
  -- Destino mascarado e o nome do contador, fixados no envio.
  destination TEXT NOT NULL,
  contact_name TEXT,
  -- SHA-256 do código do link (o código só vai na mensagem) e a validade.
  token_hash TEXT NOT NULL UNIQUE,
  expires INTEGER NOT NULL,
  -- enviado | falhou
  status TEXT NOT NULL,
  error TEXT,
  conversation_id TEXT,
  -- 1: envio automático do mês anterior.
  auto INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  -- Bot que propôs (a pessoa confirmou), quando houver.
  via_bot TEXT,
  downloads INTEGER NOT NULL DEFAULT 0,
  last_download INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_contador_sends_profile ON erp_contador_sends(profile_id, created);
