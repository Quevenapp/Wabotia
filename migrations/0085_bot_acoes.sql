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

-- Proposta de escrita do bot. Só a própria pessoa confirma, pela sessão dela,
-- até expires_at; a operação roda com Idempotency-Key "proposal:<id>".
CREATE TABLE IF NOT EXISTS bot_proposals (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Pessoa em nome de quem o bot propôs (users.id).
  actor TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  -- Mensagem da conversa interna que mostra a proposta.
  message_id TEXT NOT NULL,
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
