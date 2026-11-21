-- Financeiro básico de exemplo de um modelo de área no ERP
-- (src/area-templates/erp-examples.ts): formas de pagamento, categorias
-- financeiras e a conta "Caixa". O ERP é outro objeto, então a aplicação do
-- modelo só registra aqui o que falta montar; o alarme da área monta na
-- primeira vez que o ERP responder e passa o que criou para a pegada
-- (area_template_footprints.examples_json). Só tabela nova.
CREATE TABLE IF NOT EXISTS area_template_erp_examples (
  profile_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  -- pendente | montado | falhou | cancelado
  state TEXT NOT NULL DEFAULT 'pendente',
  -- Administrador que aplicou o modelo (a montagem sai em nome dele).
  actor TEXT NOT NULL,
  -- O que montar (examples.ts, financeiro), fixado na aplicação.
  examples_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  note TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (profile_id, template_id)
);
CREATE INDEX IF NOT EXISTS area_template_erp_examples_pending ON area_template_erp_examples(profile_id, state, next_at);
