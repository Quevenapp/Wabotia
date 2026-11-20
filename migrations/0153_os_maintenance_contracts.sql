-- Ordem de Serviço, parte 4 (docs/ORDEM-DE-SERVICO.md, "Contrato de
-- manutenção"): o contrato liga um cliente (e os objetos cobertos) a um plano
-- da Mensalidade. A cobrança recorrente é a da assinatura da Mensalidade
-- (subscription_id); aqui ficam só a cobertura, o uso e as visitas. Só
-- tabelas novas; nada é apagado nem reescrito.

CREATE TABLE os_contracts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  -- Numeração própria da área (1, 2, 3...), para "Contrato nº 3".
  number INTEGER NOT NULL CHECK (number > 0),
  contact_id TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  plan_id TEXT NOT NULL,
  subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'ended')),
  -- Cobertura (JSON): modelos incluídos, serviços em texto, unidade
  -- (visitas ou horas), limite por período, período e regra do excedente.
  coverage_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(coverage_json) AND json_type(coverage_json) = 'object'
    AND length(CAST(coverage_json AS BLOB)) <= 8192
  ),
  starts_on TEXT NOT NULL,
  ends_on TEXT,
  -- Reajuste anual informado, em centésimos de ponto percentual (550 = 5,5%).
  -- Só registrado e avisado na data; nunca muda o valor sozinho.
  adjustment_bp INTEGER CHECK (adjustment_bp IS NULL OR (adjustment_bp >= 0 AND adjustment_bp <= 10000)),
  adjustment_on TEXT,
  adjustment_noticed_on TEXT,
  -- Assinatura em atraso: 'warn' só avisa; 'block' recusa marcar ordem coberta.
  overdue_policy TEXT NOT NULL DEFAULT 'warn' CHECK (overdue_policy IN ('warn', 'block')),
  terms TEXT NOT NULL DEFAULT '',
  -- Visitas programadas (JSON): recorrência, antecedência, modelo e texto.
  visit_json TEXT CHECK (visit_json IS NULL OR (json_valid(visit_json) AND json_type(visit_json) = 'object')),
  next_visit_on TEXT,
  status_reason TEXT NOT NULL DEFAULT '',
  status_changed_at INTEGER,
  status_changed_by TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  source_key TEXT,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE (profile_id, number),
  UNIQUE (profile_id, source_key)
);
CREATE INDEX os_contracts_contact ON os_contracts(profile_id, contact_id, status);
CREATE INDEX os_contracts_status ON os_contracts(profile_id, status, number DESC);

CREATE TABLE os_contract_counters (
  profile_id TEXT PRIMARY KEY,
  last INTEGER NOT NULL DEFAULT 0
);

-- Objetos do serviço cobertos (equipamentos, veículos, imóveis).
CREATE TABLE os_contract_objects (
  profile_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (profile_id, contract_id, object_id)
);
CREATE INDEX os_contract_objects_object ON os_contract_objects(profile_id, object_id);

-- Uso do limite: uma linha por ordem marcada como coberta. units em
-- visitas (1) ou em minutos (horas). A ordem cancelada deixa de contar
-- (a consulta junta com os_orders), então cancelar devolve o limite.
CREATE TABLE os_contract_usage (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  covered_units INTEGER NOT NULL DEFAULT 0 CHECK (covered_units >= 0),
  excess_units INTEGER NOT NULL DEFAULT 0 CHECK (excess_units >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released')),
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  released_at INTEGER,
  released_by TEXT,
  UNIQUE (profile_id, order_id)
);
CREATE INDEX os_contract_usage_period ON os_contract_usage(profile_id, contract_id, period_key, state);

-- Histórico do contrato (criação, edição, suspensão, encerramento, reajuste
-- avisado, visitas abertas ou puladas), com quem fez e quando.
CREATE TABLE os_contract_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX os_contract_history_page ON os_contract_history(profile_id, contract_id, created DESC);
