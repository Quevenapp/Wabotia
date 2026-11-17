-- Perguntas da ferramenta `decidir` dos bots internos ao JEV
-- (src/bot-actions/decide.ts, docs/JEV.md): várias por execução, ao
-- contrário de jev_decisions (uma decisão de rota por execução). Guarda a
-- pergunta (mascarada), a resposta, a probabilidade, o limiar e a ação que o
-- bot tomou depois. Aditiva: o código anterior não a lê.
CREATE TABLE jev_questions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sim_nao', 'escolha')),
  question TEXT NOT NULL,
  options TEXT,
  answer TEXT NOT NULL,
  probability REAL,
  confidence REAL,
  threshold REAL NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('acima_do_limiar', 'incerto')),
  reason TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  bot_action TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX jev_questions_run ON jev_questions(run_id);
CREATE INDEX jev_questions_profile ON jev_questions(profile_id, created);
