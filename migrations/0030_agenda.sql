-- Agenda (módulo "agenda", docs/AGENDA.md): cadastros da área. Serviços,
-- profissionais, horário de trabalho por profissional e dia da semana, folgas
-- e bloqueios. Horários em minutos desde a meia-noite, no horário de Brasília.
CREATE TABLE IF NOT EXISTS agenda_services (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL,
  -- Preço em centavos; NULL quando não é mostrado ao cliente.
  price_cents INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  -- Excluído pela equipe: some das listas, continua nos agendamentos antigos.
  archived INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agenda_services_profile ON agenda_services(profile_id, archived, position);

CREATE TABLE IF NOT EXISTS agenda_professionals (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Pessoa da equipe (users.id), opcional.
  user_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agenda_professionals_profile ON agenda_professionals(profile_id, archived, position);

-- Serviços que cada profissional atende.
CREATE TABLE IF NOT EXISTS agenda_professional_services (
  profile_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  PRIMARY KEY (professional_id, service_id)
);
CREATE INDEX IF NOT EXISTS agenda_professional_services_service ON agenda_professional_services(profile_id, service_id);

-- Horário de trabalho: um ou mais intervalos por dia da semana (0 = domingo).
CREATE TABLE IF NOT EXISTS agenda_hours (
  profile_id TEXT NOT NULL,
  professional_id TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  PRIMARY KEY (professional_id, weekday, start_minute)
);

-- Folgas e bloqueios: intervalo [starts, ends) em ms Unix. Sem profissional,
-- vale para todos (feriado da casa, reforma).
CREATE TABLE IF NOT EXISTS agenda_blocks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  professional_id TEXT,
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agenda_blocks_range ON agenda_blocks(profile_id, starts, ends);
