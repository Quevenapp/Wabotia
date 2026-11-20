-- Ordem de Serviço, parte 4 (docs/ORDEM-DE-SERVICO.md, "Agendar a
-- execução"): a execução marcada da ordem. Com a Agenda ligada, aponta para
-- o agendamento (appointment_id); o horário vale o da Agenda, lido na hora,
-- então mexer pelo lado da Agenda reflete na ordem. Sem a Agenda, guarda só a
-- data e a hora combinadas, digitadas (mode='manual'). Tabela nova.

CREATE TABLE os_order_schedules (
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('agenda', 'manual')),
  appointment_id TEXT,
  service_id TEXT,
  professional_id TEXT,
  starts INTEGER NOT NULL CHECK (starts > 0),
  ends INTEGER,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cancelled')),
  note TEXT NOT NULL DEFAULT '',
  -- Data combinada: confirmação e lembrete pelo aviso da ordem.
  notified_at INTEGER,
  reminded_at INTEGER,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (profile_id, order_id)
);
CREATE INDEX os_order_schedules_starts ON os_order_schedules(profile_id, state, starts);
CREATE INDEX os_order_schedules_appointment ON os_order_schedules(profile_id, appointment_id);
