// Tempo do motor: timestamptz em microssegundos UTC (INTEGER), relógio
// monotônico (max(agora, último + 1)) e o dia em America/Sao_Paulo pelo
// Intl (o deslocamento fixo de src/business-time.ts não serve: houve horário
// de verão até 2019).

export class Clock {
  private last = 0n;
  constructor(last = 0n) {
    this.last = last;
  }
  /** clock_timestamp(): sempre maior que o anterior. */
  next(): bigint {
    const now = BigInt(Date.now()) * 1000n;
    this.last = now > this.last ? now : this.last + 1n;
    return this.last;
  }
  get latest() {
    return this.last;
  }
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** (clock_timestamp() at time zone 'America/Sao_Paulo')::date */
export const todaySaoPaulo = (at = Date.now()) => dayFormat.format(new Date(at));

/** Data válida AAAA-MM-DD (o tipo date do Postgres). */
export function validDate(text: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * Argumento do tipo date como o Postgres o recebe: formato errado → 22007;
 * formato certo e data inexistente (30/02) → 22008.
 */
export function dateArgError(text: string): { code: string; message: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    return { code: "22007", message: `invalid input syntax for type date: "${text}"` };
  if (!validDate(text)) return { code: "22008", message: `date/time field value out of range: "${text}"` };
  return null;
}

/** to_jsonb(timestamptz) com TimeZone UTC: "2026-11-16T14:03:12.12+00:00". */
export function jsonTimestamp(micros: bigint | number | string): string {
  const v = BigInt(micros);
  const frac = Number(((v % 1_000_000n) + 1_000_000n) % 1_000_000n);
  const seconds = (v - BigInt(frac)) / 1_000_000n;
  const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  const fraction = frac ? "." + String(frac).padStart(6, "0").replace(/0+$/, "") : "";
  return `${base}${fraction}+00:00`;
}
