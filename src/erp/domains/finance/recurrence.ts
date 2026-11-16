// Contas recorrentes (SQL 138 e a parcelada da 172): dias úteis com os feriados
// nacionais e a Páscoa, a próxima data de cada frequência, a conta gerada e a
// visão da recorrência.
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { bool, ts } from "./internal.ts";
import { insertTitle } from "./titles.ts";

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fmt(new Date(toDate(d).getTime() + n * 86400000));
export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86400000);
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
/** date_trunc('month', d) + n meses */
function monthStart(d: string, n: number) {
  const x = toDate(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, 1));
}
const onDay = (start: Date, day: number) =>
  fmt(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), Math.min(day, daysInMonth(start.getUTCFullYear(), start.getUTCMonth() + 1)))));

/** erp_finance.easter (algoritmo de Meeus, divisão inteira) */
export function easter(year: number) {
  const a = year % 19, b = Math.trunc(year / 100), c = year % 100;
  const d = Math.trunc(b / 4), e = b % 4, f = Math.trunc((b + 8) / 25), g = Math.trunc((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.trunc(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.trunc((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return fmt(new Date(Date.UTC(year, Math.trunc(n / 31) - 1, (n % 31) + 1)));
}

/** erp_finance.is_business_day */
export function isBusinessDay(d: string) {
  const dow = toDate(d).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const md = d.slice(5);
  const year = Number(d.slice(0, 4));
  if (["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "12-25"].includes(md) || (md === "11-20" && year >= 2024)) return false;
  const e = easter(year);
  return ![addDays(e, -48), addDays(e, -47), addDays(e, -2), addDays(e, 60)].includes(d);
}

/** erp_finance.next_business_day (até 15 dias adiante) */
export function nextBusinessDay(d: string) {
  let v = d;
  for (let n = 0; !isBusinessDay(v) && n < 15; n++) v = addDays(v, 1);
  return v;
}

/** erp_finance.recurrence_next(frequência, dia, 2º dia, a partir de) */
export function recurrenceNext(frequency: string, dueDay: number | null, secondDay: number | null, from: string): string | null {
  if (frequency === "weekly") return addDays(from, 7);
  if (frequency === "biweekly") {
    const days = [Math.min(dueDay!, secondDay!), Math.max(dueDay!, secondDay!)];
    for (let k = 0; k <= 2; k++) {
      const month = monthStart(from, k);
      for (const step of days) {
        const candidate = onDay(month, step);
        if (candidate > from) return candidate;
      }
    }
    return null;
  }
  const step = { monthly: 1, installments: 1, bimonthly: 2, quarterly: 3, semiannual: 6 }[frequency] ?? 12;
  return onDay(monthStart(from, step), dueDay!);
}

/** erp_finance.recurrence_title: a conta da data nominal (dia útil seguinte, se pedido). */
export function recurrenceTitle(ctx: RpcContext, rec: Row, nominal: string) {
  const due = bool(rec.business_days) ? nextBusinessDay(nominal) : nominal;
  const number = Number(one(ctx.db, 'SELECT count(*) n FROM "erp_finance__title" WHERE recurrence_id=?', rec.id)!.n) + 1;
  const issued = addDays(due, -Number(rec.lead_days));
  const parcelled = rec.installments !== null;
  return insertTitle(ctx, {
    group_id: parcelled ? rec.id : crypto.randomUUID(),
    installment: parcelled ? number : 1,
    installments: parcelled ? Number(rec.installments) : 1,
    kind: rec.kind,
    contact_id: rec.contact_id,
    category_id: rec.category_id,
    description: rec.description,
    source_reference: rec.source_reference,
    issued_on: issued,
    due_on: due,
    amount_cents: Number(rec.amount_cents),
    competence_on: issued,
    account_id: rec.account_id,
    bank_number: rec.bank_number,
    interest_month_bp: Number(rec.interest_month_bp),
    penalty_bp: Number(rec.penalty_bp),
    original_due_on: due,
    recurrence_id: rec.id,
    recurrence_on: nominal,
    payment_method_id: rec.payment_method_id,
  });
}

/** erp_finance.recurrence_view (null se não existe) */
export function recurrenceView(db: SqlDriver, id: string) {
  const r = one(
    db,
    `SELECT r.*, c.name contact_name, g.name category_name FROM "erp_finance__recurrence" r JOIN "erp_catalog__record" c ON c.id=r.contact_id
       LEFT JOIN "erp_finance__category" g ON g.id=r.category_id WHERE r.id=?`,
    id,
  );
  if (!r) return null;
  const active = bool(r.active);
  const open = one(db, 'SELECT count(*) n FROM "erp_finance__title" t WHERE t.recurrence_id=? AND t.cancelled=0 AND t.settled_cents<t.amount_cents', id)!.n;
  return {
    id: r.id,
    kind: r.kind,
    contact_id: r.contact_id,
    contact_name: r.contact_name,
    category_id: r.category_id,
    category_name: r.category_name ?? null,
    account_id: r.account_id,
    description: r.description,
    amount_cents: String(r.amount_cents),
    frequency: r.frequency,
    due_day: r.due_day,
    second_day: r.second_day,
    weekday: r.weekday,
    business_days: bool(r.business_days),
    end_on: r.end_on,
    next_on:
      active && (r.end_on === null || (r.next_on !== null && String(r.next_on) <= String(r.end_on))) && (r.installments === null || Number(r.generated) < Number(r.installments))
        ? r.next_on
        : null,
    installments: r.installments,
    generated: r.generated,
    active,
    open_titles: Number(open),
    version: r.version,
    created_at: ts(r.created_at),
  };
}
