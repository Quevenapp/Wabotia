-- Bot age em nome da pessoa na conversa interna (src/bot-actions, docs/API.md
-- "Ações pelo bot"). Faixa reservada: 0085 a 0089.

-- Mensagens estruturadas na conversa interna: proposta de ação do bot e o
-- resultado. `text` continua com um texto de reserva legível para quem não
-- conhece o tipo (apps antigos).
ALTER TABLE internal_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE internal_messages ADD COLUMN payload TEXT;

-- Auditoria: a pessoa agiu pelo bot ({kind:"bot", bot_id, run_id,
-- proposal_id}); nulo nas ações feitas pela tela.
ALTER TABLE audit ADD COLUMN via TEXT;

-- Proposta de escrita do bot, até expires_at; a operação roda com
-- Idempotency-Key "proposal:<id>". Modo "team": a pessoa da conversa interna
-- confirma pela sessão dela. Modo "customer": o cliente da conversa do
-- WhatsApp confirma pelo botão, na própria conversa.
CREATE TABLE IF NOT EXISTS bot_proposals (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- team | customer
  mode TEXT NOT NULL DEFAULT 'team',
  -- Pessoa em nome de quem o bot propôs (users.id), ou "customer:<conversa>".
  actor TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- Conversa interna (modo team) e a mensagem que mostra a proposta.
  chat_id TEXT,
  message_id TEXT,
  -- Conversa do cliente (modo customer).
  conversation_id TEXT,
  -- Operação do catálogo (op do comando) e a chamada que ela faz.
  operation TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  -- Operação sensível: exige sessão com segundo fator ao confirmar.
  sensitive INTEGER NOT NULL DEFAULT 0,
  -- pending | running | done | failed | cancelled | expired
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_proposals_run ON bot_proposals(run_id, created);
CREATE INDEX IF NOT EXISTS bot_proposals_open ON bot_proposals(profile_id, status, expires_at);
CREATE INDEX IF NOT EXISTS bot_proposals_conversation ON bot_proposals(conversation_id, status, created);
