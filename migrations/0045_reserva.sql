-- Reserva e check-in (módulo "reserva", docs/RESERVA.md): cadastros da área.
-- Unidades reserváveis (quarto, chalé, quadra, salão) e bloqueios manuais.
CREATE TABLE IF NOT EXISTS reserva_units (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- room | house | court | hall | other (só para o ícone e o texto)
  kind TEXT NOT NULL DEFAULT 'room',
  description TEXT NOT NULL DEFAULT '',
  -- Pessoas que a unidade comporta.
  capacity INTEGER NOT NULL DEFAULT 1,
  -- Endereços HTTPS das fotos, em JSON (lista).
  photos TEXT NOT NULL DEFAULT '[]',
  -- daily: entrada e saída em dias; hourly: início e duração.
  mode TEXT NOT NULL,
  -- Preço da diária (daily) ou da hora (hourly), em centavos.
  price_cents INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  -- Excluída pela equipe: some das listas, continua nas reservas antigas.
  archived INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reserva_units_profile ON reserva_units(profile_id, archived, position);

-- Bloqueio manual: intervalo [starts, ends) em ms Unix (dias inteiros de
-- Brasília quando feito por datas). Sem unidade, vale para todas.
CREATE TABLE IF NOT EXISTS reserva_blocks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  unit_id TEXT,
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reserva_blocks_range ON reserva_blocks(profile_id, starts, ends);
