-- Passo web (docs/MODULOS.md): link curto de uso único, amarrado a uma
-- conversa, que leva o cliente do WhatsApp a uma página leve e o traz de volta.
CREATE TABLE IF NOT EXISTS web_steps (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- Módulo dono do passo ("forms" no formulário do administrador).
  module_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- Registro do módulo ligado ao passo (o formulário, um pedido, uma reserva).
  ref_id TEXT,
  -- SHA-256 do código curto do link; o código em si nunca é guardado.
  code_hash TEXT NOT NULL UNIQUE,
  -- sent | opened | completed | expired | cancelled
  status TEXT NOT NULL DEFAULT 'sent',
  title TEXT NOT NULL,
  -- Cópia do que a página mostra (campos, textos), fixada no envio.
  spec TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  ticket_id TEXT,
  contact_id TEXT,
  -- menu | agent | bot | module
  trigger TEXT NOT NULL,
  actor TEXT NOT NULL,
  source_key TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  opened_at INTEGER,
  completed_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS web_steps_conversation ON web_steps(conversation_id, created);
CREATE INDEX IF NOT EXISTS web_steps_open ON web_steps(profile_id, status, expires_at);
-- Endereço público da instalação, visto nas requisições ao painel e à API.
-- O alarme do Coordinator usa este valor para montar links enviados ao cliente.
CREATE TABLE IF NOT EXISTS instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL
);
