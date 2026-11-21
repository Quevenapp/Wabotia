// Régua de cobrança e contas recorrentes automáticas (structural.ts,
// "regua-cobranca"; tabelas da versão 34 em engine-tables.ts).
//
// Régua: os dias são os da régua (configuração do D1) e, nos que ela deixou em
// branco, as preferências que já existiam em Preferências › Contas a receber
// (financas.boletos_dias_antes, _no_vencimento e _dias_apos). Cada
// conta a receber em aberto tem no máximo uma etapa por vez: a última cujo dia
// chegou, por até STAGE_GRACE_DAYS dias e nunca depois do começo da seguinte
// (o aviso de antes não sai no dia do vencimento). Cada etapa sai uma vez só
// por conta e canal (chave única). Quem envia é o alarme da área
// (src/erp/regua/sender.ts), pelo envio de conta da conversa; aqui ficam o
// plano, o horário comercial e a situação.
//
// Recorrência automática: a recorrência marcada como automática gera a conta
// do período na data de emissão dela (o vencimento menos a antecedência que a
// recorrência guarda), pela mesma recurrenceTitle de Gerar contas, uma vez por
// período; com "enviar a cobrança", a conta entra na régua como etapa "issue".
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { saoPauloLocal, saoPauloParts, todaySaoPaulo } from "../../engine/time.ts";
import { raise } from "../../engine/errors.ts";
import { bool, writeRow } from "./internal.ts";
import { addDays, daysBetween, isBusinessDay, recurrenceNext, recurrenceTitle } from "./recurrence.ts";

export const D_STEP = "erp_finance__dunning_step";
export const D_AUTO = "erp_finance__recurrence_auto";
export const D_RUN = "erp_finance__recurrence_run";

/** Dias em que uma etapa ainda sai depois do dia dela (alarme parado, fora do horário). */
export const STAGE_GRACE_DAYS = 3;
/** Tentativas de envio de uma etapa antes de ficar como falha. */
export const MAX_SEND_ATTEMPTS = 3;
/** Posse de quem está enviando: passou disso sem resposta, volta para a fila. */
export const SEND_LEASE_MS = 10 * 60_000;
/** Recorrências geradas por unidade do alarme. */
export const RECURRING_BATCH = 20;
/** Contas planejadas por chamada (a sobra fica para a próxima). */
export const PLAN_BATCH = 500;

export type DunningStage = "before" | "due" | "after" | "issue";
export type DunningChannel = "whatsapp" | "email";
export type DunningStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "cancelled";

/** Os dias da régua: os da própria régua ou, em branco, os das preferências de Contas a receber. */
export interface DunningRules { before: number; on_due: boolean; after: number; source: "regua" | "preference" | "default" }
/**
 * O que o administrador ligou (guardado no D1 da área e enviado em cada
 * chamada). Os dias em branco (null) são os das preferências de Contas a
 * receber: elas são da Cobrança bancária (boleto por e-mail) e só se gravam
 * com ela ligada; a régua pelo WhatsApp é do Financeiro e tem os seus.
 */
export interface DunningConfig {
  enabled: boolean; whatsapp: boolean; email: boolean; hour_from: number; hour_to: number; business_days: boolean;
  before: number | null; on_due: boolean | null; after: number | null;
}

export const DUNNING_PREFERENCES = {
  before: "financas.boletos_dias_antes", on_due: "financas.boletos_no_vencimento", after: "financas.boletos_dias_apos",
} as const;

export const STATUS_LABELS: Readonly<Record<DunningStatus, string>> = {
  pending: "A enviar", sending: "Enviando", sent: "Enviada", failed: "Falhou", skipped: "Não saiu", cancelled: "Saiu da régua",
};
export const CHANNEL_LABELS: Readonly<Record<DunningChannel, string>> = { whatsapp: "WhatsApp", email: "E-mail" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export function stageLabel(stage: DunningStage, planned: string, due: string): string {
  if (stage === "issue") return "Conta nova da recorrência";
  if (stage === "due") return "No dia do vencimento";
  const days = Math.abs(daysBetween(planned, due));
  return stage === "before" ? `${plural(days, "dia", "dias")} antes do vencimento` : `${plural(days, "dia", "dias")} depois do vencimento`;
}

/** Valor JSON guardado da preferência, conferido; fora do esperado vale o padrão (desligado). */
export function dunningRules(db: SqlDriver): DunningRules {
  const rows = db.exec(`SELECT key, value FROM "erp_preferences__company_value" WHERE key IN (?,?,?)`,
    DUNNING_PREFERENCES.before, DUNNING_PREFERENCES.on_due, DUNNING_PREFERENCES.after).rows;
  const value = (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return undefined;
    try { return JSON.parse(String(row.value)); } catch { return undefined; }
  };
  const days = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 365 ? v : 0);
  const before = value(DUNNING_PREFERENCES.before), onDue = value(DUNNING_PREFERENCES.on_due), after = value(DUNNING_PREFERENCES.after);
  return { before: days(before), on_due: onDue === true, after: days(after), source: rows.length ? "preference" : "default" };
}

/** Os dias que valem: os da régua e, nos que ela deixou em branco, os das preferências. */
export function effectiveRules(db: SqlDriver, config: Pick<DunningConfig, "before" | "on_due" | "after">): DunningRules {
  const preference = dunningRules(db);
  if (config.before === null && config.on_due === null && config.after === null) return preference;
  return { before: config.before ?? preference.before, on_due: config.on_due ?? preference.on_due, after: config.after ?? preference.after, source: "regua" };
}

/** As etapas de uma conta, na ordem: a de antes, a do dia e a de depois (as ligadas). */
export function dunningStages(due: string, rules: Pick<DunningRules, "before" | "on_due" | "after">): { stage: DunningStage; planned_on: string }[] {
  const stages: { stage: DunningStage; planned_on: string }[] = [];
  if (rules.before > 0) stages.push({ stage: "before", planned_on: addDays(due, -rules.before) });
  if (rules.on_due) stages.push({ stage: "due", planned_on: due });
  if (rules.after > 0) stages.push({ stage: "after", planned_on: addDays(due, rules.after) });
  return stages;
}

/** A etapa da conta neste dia, ou null: a última que chegou, enquanto não passou do prazo nem começou a seguinte. */
export function currentStage(due: string, today: string, rules: Pick<DunningRules, "before" | "on_due" | "after">) {
  const stages = dunningStages(due, rules);
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i];
    if (s.planned_on > today) continue;
    let end = addDays(s.planned_on, STAGE_GRACE_DAYS);
    const next = stages[i + 1]?.planned_on;
    if (next && next < end) end = next;
    // O aviso de antes nunca sai no dia do vencimento nem depois.
    if (s.stage === "before" && due < end) end = due;
    return today < end ? s : null;
  }
  return null;
}

const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
/** Configuração vinda do Worker (p_args.config): conferida campo a campo. */
export function readConfig(value: unknown): DunningConfig {
  const c = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const days = (v: unknown) => v === undefined || v === null || int(v, 0, 365);
  if (!c || Object.keys(c).some((k) => !["enabled", "whatsapp", "email", "hour_from", "hour_to", "business_days", "before", "on_due", "after"].includes(k)) ||
      typeof c.enabled !== "boolean" || typeof c.whatsapp !== "boolean" || typeof c.email !== "boolean" || typeof c.business_days !== "boolean" ||
      !int(c.hour_from, 0, 23) || !int(c.hour_to, 1, 24) || (c.hour_to as number) <= (c.hour_from as number) ||
      !days(c.before) || !days(c.after) || !(c.on_due === undefined || c.on_due === null || typeof c.on_due === "boolean"))
    raise("22023", "erp_dunning_invalid_config");
  return { ...(c as unknown as DunningConfig), before: (c.before as number | undefined) ?? null, on_due: (c.on_due as boolean | undefined) ?? null, after: (c.after as number | undefined) ?? null };
}

/** Dentro do horário comercial (São Paulo; dia útil com os feriados nacionais, se pedido)? */
export function withinHours(at: number, config: Pick<DunningConfig, "hour_from" | "hour_to" | "business_days">): boolean {
  const p = saoPauloParts(BigInt(at) * 1000n);
  const hour = Number(p.hm.slice(0, 2));
  if (config.business_days && !isBusinessDay(p.date)) return false;
  return hour >= config.hour_from && hour < config.hour_to;
}

/** O próximo instante (ms) dentro do horário, a partir de `at` (o próprio, se já estiver). */
export function nextOpening(at: number, config: Pick<DunningConfig, "hour_from" | "hour_to" | "business_days">): number {
  if (withinHours(at, config)) return at;
  let date = saoPauloParts(BigInt(at) * 1000n).date;
  for (let i = 0; i < 20; i++, date = addDays(date, 1)) {
    if (config.business_days && !isBusinessDay(date)) continue;
    const open = Number(saoPauloLocal(date, config.hour_from * 3600) / 1000n);
    if (open > at) return open;
  }
  return at + 24 * 3_600_000;
}

const OPEN_TITLE = `t.kind='receivable' AND t.cancelled=0 AND t.deleted_at IS NULL AND t.settled_cents < t.amount_cents`;
export const nowMs = (ctx: RpcContext) => Number(ctx.clock.next() / 1000n);

function insertStep(ctx: RpcContext, t: Row, stage: DunningStage, planned: string, channel: DunningChannel, origin: "regua" | "recurrence"): boolean {
  const at = ctx.clock.next().toString();
  return ctx.db.exec(`INSERT INTO "${D_STEP}"(id, title_id, stage, channel, origin, planned_on, due_on, amount_cents, status, attempts, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,'pending',0,?,?) ON CONFLICT(title_id, stage, channel) DO NOTHING`,
  crypto.randomUUID(), t.id, stage, channel, origin, planned, t.due_on, Number(t.amount_cents) - Number(t.settled_cents), at, at).rowsWritten > 0;
}

/** Canais que a régua usa agora: WhatsApp e, quando o canal de e-mail existe e foi ligado, e-mail. */
export const configChannels = (config: DunningConfig, emailReady: boolean): DunningChannel[] =>
  [...(config.whatsapp ? ["whatsapp" as const] : []), ...(config.email && emailReady ? ["email" as const] : [])];

/** As contas em aberto que estão numa etapa neste dia (para planejar ou para a prévia). */
export function dueToday(db: SqlDriver, today: string, rules: DunningRules, limit = PLAN_BATCH) {
  const stages = dunningStages("2000-01-01", rules);
  if (!stages.length) return [];
  const rows = db.exec(`SELECT t.id, t.due_on, t.amount_cents, t.settled_cents FROM "erp_finance__title" t
    WHERE ${OPEN_TITLE} AND t.due_on BETWEEN ? AND ? ORDER BY t.due_on, t.id LIMIT ?`,
  addDays(today, -(rules.after + STAGE_GRACE_DAYS)), addDays(today, rules.before), limit).rows;
  return rows.flatMap((t) => {
    const s = currentStage(String(t.due_on), today, rules);
    return s ? [{ title: t, ...s }] : [];
  });
}

/**
 * Arruma a fila antes de planejar ou enviar: posse vencida volta (ou falha
 * depois das tentativas), conta paga ou cancelada sai da régua, etapa que
 * passou do prazo sem sair fica como "não saiu". Devolve o que mudou.
 */
export function tidySteps(ctx: RpcContext, at: number, today: string) {
  const db = ctx.db, stamp = ctx.clock.next().toString(), lease = (BigInt(at) * 1000n).toString();
  const failed = db.exec(`UPDATE "${D_STEP}" SET status='failed', lease_until=NULL, updated_at=?, reason=?
    WHERE status='sending' AND lease_until < ? AND attempts >= ?`, stamp,
  `O envio não foi confirmado depois de ${MAX_SEND_ATTEMPTS} tentativas. Confira a conversa do cliente e envie pela conta, se precisar.`, lease, MAX_SEND_ATTEMPTS).rowsWritten;
  const released = db.exec(`UPDATE "${D_STEP}" SET status='pending', lease_until=NULL, updated_at=? WHERE status='sending' AND lease_until < ?`, stamp, lease).rowsWritten;
  const cancelled = db.exec(`UPDATE "${D_STEP}" SET status='cancelled', updated_at=?, reason='A conta foi paga, baixada ou cancelada antes do envio.'
    WHERE status='pending' AND NOT EXISTS (SELECT 1 FROM "erp_finance__title" t WHERE t.id="${D_STEP}".title_id AND ${OPEN_TITLE})`, stamp).rowsWritten;
  const skipped = db.exec(`UPDATE "${D_STEP}" SET status='skipped', updated_at=?, reason=?
    WHERE status='pending' AND planned_on <= ?`, stamp,
  `Passaram ${STAGE_GRACE_DAYS} dias sem um horário de envio (régua desligada, fora do horário comercial ou sem canal).`, addDays(today, -STAGE_GRACE_DAYS)).rowsWritten;
  return { failed, released, cancelled, skipped };
}

/** Cria as etapas do dia (uma por conta e canal, nunca repetida). */
export function planToday(ctx: RpcContext, today: string, channels: readonly DunningChannel[], rules: DunningRules): number {
  if (!channels.length) return 0;
  let created = 0;
  for (const item of dueToday(ctx.db, today, rules))
    for (const channel of channels) if (insertStep(ctx, item.title, item.stage, item.planned_on, channel, "regua")) created++;
  return created;
}

/** Toma as etapas a enviar agora (posse de SEND_LEASE_MS). */
export function claimSteps(ctx: RpcContext, at: number, today: string, channels: readonly DunningChannel[], limit: number): Row[] {
  if (!channels.length) return [];
  const rows = ctx.db.exec(`SELECT s.id FROM "${D_STEP}" s WHERE s.status='pending' AND s.planned_on <= ?
      AND s.channel IN (SELECT value FROM json_each(?)) ORDER BY s.planned_on, s.created_at, s.id LIMIT ?`,
  today, JSON.stringify(channels), limit).rows;
  const stamp = ctx.clock.next().toString(), lease = (BigInt(at + SEND_LEASE_MS) * 1000n).toString();
  for (const r of rows)
    ctx.db.exec(`UPDATE "${D_STEP}" SET status='sending', attempts=attempts+1, lease_until=?, updated_at=? WHERE id=? AND status='pending'`, lease, stamp, r.id);
  return rows.map((r) => one(ctx.db, `SELECT * FROM "${D_STEP}" WHERE id=?`, r.id)!);
}

const isoOf = (micros: unknown) => (micros === null || micros === undefined ? null : new Date(Number(BigInt(String(micros)) / 1000n)).toISOString());

/** A etapa como a tela e o Worker a leem. */
export function stepView(db: SqlDriver, s: Row) {
  const t = one(db, `SELECT t.id, t.description, t.contact_id, t.amount_cents, t.settled_cents, c.name contact_name FROM "erp_finance__title" t
    LEFT JOIN "erp_catalog__record" c ON c.id=t.contact_id WHERE t.id=?`, s.title_id);
  const stage = s.stage as DunningStage, status = s.status as DunningStatus;
  return {
    id: s.id, title_id: s.title_id, stage, stage_label: stageLabel(stage, String(s.planned_on), String(s.due_on)),
    channel: s.channel, channel_label: CHANNEL_LABELS[s.channel as DunningChannel], origin: s.origin,
    planned_on: s.planned_on, due_on: s.due_on, amount_cents: Number(s.amount_cents),
    status, status_label: STATUS_LABELS[status], attempts: Number(s.attempts), reason: s.reason ?? null, send_ref: s.send_ref ?? null,
    sent_at: isoOf(s.sent_at), updated_at: isoOf(s.updated_at),
    contact: t?.contact_id ? { id: t.contact_id, name: t.contact_name ?? null } : null, description: t?.description ?? null,
  };
}

/** Resultado do envio que o Worker fez com a etapa tomada. */
export function reportStep(ctx: RpcContext, id: string, outcome: "sent" | "failed" | "retry" | "skipped", reason: string | null, ref: string | null) {
  const s = one(ctx.db, `SELECT * FROM "${D_STEP}" WHERE id=?`, id);
  if (!s) raise("P0002", "erp_dunning_step_not_found");
  if (s.status !== "sending") return { step: stepView(ctx.db, s), changed: false };
  const stamp = ctx.clock.next().toString();
  const text = reason ? Array.from(reason).slice(0, 500).join("") : null;
  if (outcome === "sent")
    ctx.db.exec(`UPDATE "${D_STEP}" SET status='sent', lease_until=NULL, sent_at=?, updated_at=?, reason=NULL, send_ref=? WHERE id=?`, stamp, stamp, ref, id);
  else if (outcome === "retry" && Number(s.attempts) < MAX_SEND_ATTEMPTS)
    ctx.db.exec(`UPDATE "${D_STEP}" SET status='pending', lease_until=NULL, updated_at=?, reason=? WHERE id=?`, stamp, text, id);
  else
    ctx.db.exec(`UPDATE "${D_STEP}" SET status=?, lease_until=NULL, updated_at=?, reason=? WHERE id=?`,
      outcome === "skipped" ? "skipped" : "failed", stamp, text ?? "O envio não saiu.", id);
  return { step: stepView(ctx.db, one(ctx.db, `SELECT * FROM "${D_STEP}" WHERE id=?`, id)!), changed: true };
}

// ---------------------------------------------------------------------------
// Recorrência automática

const dueRecurrences = (db: SqlDriver, today: string, limit: number) => db.exec(
  `SELECT r.*, a.send_charge FROM "erp_finance__recurrence" r JOIN "${D_AUTO}" a ON a.recurrence_id=r.id AND a.auto_generate=1
   WHERE r.active=1 AND r.next_on IS NOT NULL AND (r.end_on IS NULL OR r.next_on <= r.end_on)
     AND (r.installments IS NULL OR r.generated < r.installments)
     AND date(r.next_on, '-' || r.lead_days || ' days') <= ?
     AND NOT EXISTS (SELECT 1 FROM "${D_RUN}" x WHERE x.recurrence_id=r.id AND x.recurrence_on=r.next_on)
   ORDER BY r.next_on, r.id LIMIT ?`, today, limit).rows;

const errorText = (error: unknown) => {
  const code = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    erp_finance_invalid_category: "A categoria da recorrência está inativa. Troque a categoria na recorrência.",
    erp_finance_invalid_account: "A conta financeira da recorrência está inativa. Troque a conta na recorrência.",
    erp_finance_invalid_contact: "O contato da recorrência está inativo. Reative o cadastro do contato.",
    module_disabled: "Uma parte do ERP de que a conta depende está desligada.",
  };
  return (known[code] ?? `A conta deste período não foi gerada (${code.slice(0, 120)}). Gere à mão em Contas recorrentes.`).slice(0, 500);
};

/**
 * Uma unidade do alarme: gera a conta do período das recorrências
 * automáticas cuja data de emissão chegou. Uma vez por período: o registro do
 * período (gerado ou falhou) e o índice único da conta por recorrência e data.
 * Devolve true se ainda há o que gerar (outra unidade).
 */
export function recurringAutoStep(ctx: RpcContext, today: string): boolean {
  const due = dueRecurrences(ctx.db, today, RECURRING_BATCH);
  for (const rec of due) {
    const id = String(rec.id), nominal = String(rec.next_on), at = ctx.clock.next().toString();
    try {
      // Savepoint: a conta e o avanço da recorrência entram juntos, ou nada.
      ctx.db.transaction(() => {
        const title = recurrenceTitle(ctx, rec, nominal);
        writeRow(ctx, "erp_finance__recurrence", "id", id, {
          next_on: recurrenceNext(String(rec.frequency), rec.due_day as number | null, rec.second_day as number | null, nominal),
          generated: Number(rec.generated) + 1, version: Number(rec.version) + 1, updated_at: ctx.clock.next().toString(),
        });
        ctx.db.exec(`INSERT INTO "${D_RUN}"(id, recurrence_id, recurrence_on, title_id, outcome, reason, created_at) VALUES (?,?,?,?,'generated',NULL,?)`,
          crypto.randomUUID(), id, nominal, title, at);
        if (bool(rec.send_charge) && rec.kind === "receivable") {
          const t = one(ctx.db, `SELECT id, due_on, amount_cents, settled_cents FROM "erp_finance__title" WHERE id=?`, title)!;
          insertStep(ctx, t, "issue", today, "whatsapp", "recurrence");
        }
      });
    } catch (error) {
      ctx.db.exec(`INSERT INTO "${D_RUN}"(id, recurrence_id, recurrence_on, title_id, outcome, reason, created_at) VALUES (?,?,?,NULL,'failed',?,?)
        ON CONFLICT(recurrence_id, recurrence_on) DO NOTHING`, crypto.randomUUID(), id, nominal, errorText(error), at);
    }
  }
  return due.length > 0 && dueRecurrences(ctx.db, today, 1).length > 0;
}

/** Hoje em São Paulo pelo relógio do motor. */
export const engineToday = (ctx: RpcContext) => todaySaoPaulo(nowMs(ctx));
