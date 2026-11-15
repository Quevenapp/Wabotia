-- Reserva e check-in: reservas. A ocupação é [starts, ends) em ms Unix: por
-- diária, da meia-noite (Brasília) do dia de entrada à meia-noite do dia de
-- saída, então a saída de um hóspede e a entrada do próximo no mesmo dia não
-- se sobrepõem; por hora, do início ao fim. A gravação é um INSERT/UPDATE
-- condicionado à ausência de outra reserva ativa da mesma unidade no
-- intervalo (src/modules/reserva/bookings.ts): dois pedidos simultâneos nunca
-- ficam com a mesma unidade.
CREATE TABLE IF NOT EXISTS reserva_bookings (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Número curto mostrado ao cliente (#12), sequencial na área.
  number INTEGER NOT NULL,
  unit_id TEXT NOT NULL,
  -- Cópia da unidade no momento da reserva (ou da última alteração).
  unit_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  -- Entrada e saída combinadas (horário de entrada/saída das regras, ou o
  -- início e o fim da reserva por hora).
  arrival_at INTEGER NOT NULL,
  departure_at INTEGER NOT NULL,
  guests INTEGER NOT NULL DEFAULT 1,
  -- pending_payment | confirmed | cancelled | expired | completed
  status TEXT NOT NULL,
  conversation_id TEXT,
  contact_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- whatsapp | panel | api
  source TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  -- Sinal (0 = sem sinal) e a cobrança dele (src/payments.ts).
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  payment_id TEXT,
  -- created | paid | expired | cancelled | refunded, como a cobrança
  payment_status TEXT,
  -- Código do erro ao cobrar (payments_not_configured, module_disabled…).
  payment_error TEXT,
  -- Até quando a unidade fica segura esperando o sinal.
  payment_due_at INTEGER,
  paid_at INTEGER,
  confirmed_at INTEGER,
  confirmed_by TEXT,
  -- Check-in: none | invited | sent | completed
  checkin_status TEXT NOT NULL DEFAULT 'none',
  checkin_step_id TEXT,
  checkin_sent_at INTEGER,
  checkin_at INTEGER,
  checkin_answers TEXT,
  reminded_at INTEGER,
  checkout_sent_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  -- Quantas vezes a reserva foi alterada (vai nas chaves de envio).
  changes INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reserva_bookings_number ON reserva_bookings(profile_id, number);
CREATE INDEX IF NOT EXISTS reserva_bookings_unit ON reserva_bookings(unit_id, status, starts);
CREATE INDEX IF NOT EXISTS reserva_bookings_range ON reserva_bookings(profile_id, starts);
CREATE INDEX IF NOT EXISTS reserva_bookings_status ON reserva_bookings(profile_id, status, arrival_at);
CREATE INDEX IF NOT EXISTS reserva_bookings_conversation ON reserva_bookings(conversation_id, starts);
CREATE INDEX IF NOT EXISTS reserva_bookings_payment ON reserva_bookings(payment_id);
