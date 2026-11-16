// Datas de São Paulo usadas pelas preferências, home e plataforma.

const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", timeZoneName: "longOffset" });

/** Deslocamento de São Paulo no instante, em ms ("GMT-03:00" → -3 h). */
function offsetAt(ms: number) {
  const name = offsetFormat.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")!.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}

/**
 * (data)::timestamp at time zone 'America/Sao_Paulo' em microssegundos UTC.
 * Meia-noite que não existe (início do horário de verão até 2019) usa o
 * deslocamento de antes da virada, como o Postgres.
 */
export function saoPauloMidnight(date: string): bigint {
  const utc = Date.parse(`${date}T00:00:00Z`);
  return BigInt(utc - offsetAt(utc + 3 * 3_600_000 - 1)) * 1000n;
}
