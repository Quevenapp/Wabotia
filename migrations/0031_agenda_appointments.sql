-- Agenda: agendamentos. [starts, ends) em ms Unix. A reserva é um INSERT
-- condicionado à ausência de outro agendamento ativo no mesmo intervalo do
-- mesmo profissional, então dois pedidos simultâneos nunca ficam com o mesmo
-- horário (veja src/modules/agenda/appointments.ts).
CREATE TABLE IF NOT EXISTS agenda_appointments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  -- booked | confirmed | cancelled | no_show
  status TEXT NOT NULL DEFAULT 'booked',
  conversation_id TEXT,
  contact_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- whatsapp | panel | api
  source TEXT NOT NULL,
  -- Cópia do serviço no momento do agendamento.
  service_name TEXT NOT NULL,
  price_cents INTEGER,
  -- Último agendamento ou remarcação (base do lembrete).
  booked_at INTEGER NOT NULL,
  reminded_at INTEGER,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  no_show_at INTEGER,
  -- Quantas vezes foi remarcado.
  moves INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agenda_appointments_range ON agenda_appointments(profile_id, starts);
CREATE INDEX IF NOT EXISTS agenda_appointments_professional ON agenda_appointments(professional_id, status, starts);
CREATE INDEX IF NOT EXISTS agenda_appointments_conversation ON agenda_appointments(conversation_id, starts);
CREATE INDEX IF NOT EXISTS agenda_appointments_reminder ON agenda_appointments(profile_id, status, reminded_at, starts);
