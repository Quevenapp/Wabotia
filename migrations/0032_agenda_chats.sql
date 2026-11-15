-- Agenda: pergunta aberta no WhatsApp (serviço, profissional, dia, horário,
-- confirmação, meus agendamentos, lembrete). Uma por conversa; `token` muda a
-- cada pergunta e vai nos ids dos botões e listas, para recusar toques em
-- mensagens antigas.
CREATE TABLE IF NOT EXISTS agenda_chats (
  conversation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agenda_chats_expires ON agenda_chats(profile_id, expires_at);
