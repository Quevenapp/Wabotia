-- O segmento primeiro (src/area-templates/footprint.ts): o que cada modelo de
-- área ligou e criou, para desfazer o modelo e trocar de ramo, e a escolha do
-- ramo no primeiro acesso ("Qual é o seu negócio?"). Só tabelas novas.

-- Pegada de um modelo aplicado. JSON:
--   modules_json:  módulos que estavam desligados e o modelo ligou.
--   items_json:    [{key,id,hash}] cadastros criados na configuração (hash do item como ficou salvo).
--   scalars_json:  [{path,hash}] textos e vocabulário preenchidos pelo modelo.
--   examples_json: [{kind,id,updated}] exemplos criados (serviço, profissional, plano).
--   report_json:   o que ficou na última vez que o modelo foi desfeito, e por quê.
CREATE TABLE IF NOT EXISTS area_template_footprints (
  profile_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  modules_json TEXT NOT NULL DEFAULT '[]',
  items_json TEXT NOT NULL DEFAULT '[]',
  scalars_json TEXT NOT NULL DEFAULT '[]',
  examples_json TEXT NOT NULL DEFAULT '[]',
  report_json TEXT NOT NULL DEFAULT '{}',
  applied_by TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  undone_by TEXT,
  undone_at INTEGER,
  PRIMARY KEY (profile_id, template_id)
);

-- Escolha do ramo: chosen (aplicou um modelo), skipped (pulou por enquanto).
-- reminder_dismissed: o lembrete discreto de quem pulou foi dispensado.
CREATE TABLE IF NOT EXISTS profile_segment_choice (
  profile_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  segment_id TEXT,
  template_id TEXT,
  reminder_dismissed INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
