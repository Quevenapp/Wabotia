// Régua de cobrança e recorrência automática (Vinki, sem função no oráculo;
// structural.ts, "regua-cobranca"; regras em ../dunning.ts):
// - erp_finance_dunning_overview: o que vai sair hoje, o que saiu e o que
//   falhou, com os dias da régua (leitura; papel do Financeiro, inclusive Consulta);
// - erp_finance_dunning_round: a rodada do alarme da área (arruma a fila,
//   planeja as etapas do dia e toma as que podem sair agora, no horário);
// - erp_finance_dunning_report: o resultado do envio de uma etapa tomada;
// - erp_finance_recurrence_auto_list / _set: as recorrências automáticas.
// A configuração (ligada, canais, horário) vem do D1 da área em p_args.config:
// o Worker a lê e a manda em cada chamada (src/erp/regua/).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { bool, requireAccess, uuidArg, uuidValue } from "../internal.ts";
import {
  D_AUTO, D_RUN, D_STEP, PLAN_BATCH, STAGE_GRACE_DAYS, claimSteps, configChannels, dueToday, dunningRules, effectiveRules, nextOpening, nowMs, planToday,
  readConfig, reportStep, stageLabel, stepView, tidySteps, withinHours,
} from "../dunning.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";

const object = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    raise("22023", "erp_dunning_invalid_args");
  return value as Record<string, unknown>;
};
const isoOf = (micros: unknown) => (micros === null || micros === undefined ? null : new Date(Number(BigInt(String(micros)) / 1000n)).toISOString());

/** Leitura: a régua de hoje, os enviados e os que não saíram (últimos 30 dias). */
export function erpFinanceDunningOverview(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const role = requireAccess(db, uuidArg(a.p_user_id)!, false);
  const args = object(a.p_args ?? {}, ["config", "email_ready"]);
  const config = readConfig(args.config);
  const at = nowMs(ctx), today = todaySaoPaulo(at), rules = effectiveRules(db, config), preference = dunningRules(db);
  const channels = configChannels(config, args.email_ready === true);
  const since = (BigInt(at - 30 * 86_400_000) * 1000n).toString();
  const steps = (where: string, ...params: unknown[]) =>
    db.exec(`SELECT * FROM "${D_STEP}" WHERE ${where} ORDER BY updated_at DESC, id LIMIT 200`, ...params).rows.map((s) => stepView(db, s));
  // Hoje: o que já está na fila (inclusive o envio da conta da recorrência) e, com a régua ligada, o que ainda vai entrar.
  const queued = steps(`status IN ('pending','sending') AND planned_on <= ?`, today);
  const planned = new Set(db.exec(`SELECT title_id, stage, channel FROM "${D_STEP}"`).rows.map((r) => `${r.title_id}:${r.stage}:${r.channel}`));
  const upcoming = config.enabled ? dueToday(db, today, rules, PLAN_BATCH).flatMap((item) => channels
    .filter((channel) => !planned.has(`${item.title.id}:${item.stage}:${channel}`))
    .map((channel) => {
      const t = one(db, `SELECT t.description, t.contact_id, c.name FROM "erp_finance__title" t LEFT JOIN "erp_catalog__record" c ON c.id=t.contact_id WHERE t.id=?`, item.title.id)!;
      return {
        id: null, title_id: item.title.id, stage: item.stage, stage_label: stageLabel(item.stage, item.planned_on, String(item.title.due_on)), channel,
        channel_label: channel === "email" ? "E-mail" : "WhatsApp", origin: "regua", planned_on: item.planned_on, due_on: item.title.due_on,
        amount_cents: Number(item.title.amount_cents) - Number(item.title.settled_cents), status: "planned", status_label: "Vai sair hoje",
        attempts: 0, reason: null, send_ref: null, sent_at: null, updated_at: null,
        contact: t.contact_id ? { id: t.contact_id, name: t.name ?? null } : null, description: t.description ?? null,
      };
    })) : [];
  const count = (status: string) => Number(one(db, `SELECT count(*) n FROM "${D_STEP}" WHERE status=? AND updated_at >= ?`, status, since)!.n);
  return {
    scope: "finance_dunning", data_mode: "erp_native", today, now: new Date(at).toISOString(),
    rules: { before: rules.before, on_due: rules.on_due, after: rules.after, source: rules.source, grace_days: STAGE_GRACE_DAYS },
    preference_rules: { before: preference.before, on_due: preference.on_due, after: preference.after, source: preference.source },
    in_hours: withinHours(at, config), next_opening: new Date(nextOpening(at, config)).toISOString(), channels,
    today_items: [...queued, ...upcoming],
    sent: steps(`status='sent' AND updated_at >= ?`, since),
    not_sent: steps(`status IN ('failed','skipped','cancelled') AND updated_at >= ?`, since),
    counts: { sent: count("sent"), failed: count("failed"), skipped: count("skipped"), cancelled: count("cancelled") },
    can_write: role !== "consulta",
  };
}

/** A rodada do alarme: só quem escreve no Financeiro (o administrador que ligou a régua). */
export function erpFinanceDunningRound(ctx: RpcContext, a: RpcArgs) {
  requireAccess(ctx.db, uuidArg(a.p_user_id)!, true);
  const args = object(a.p_args, ["config", "email_ready", "limit"]);
  const config = readConfig(args.config);
  const limit = args.limit === undefined ? 5 : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 20) raise("22023", "erp_dunning_invalid_args");
  const at = nowMs(ctx), today = todaySaoPaulo(at);
  const tidy = tidySteps(ctx, at, today);
  // Desligada: nada novo entra e nada sai (a fila espera; o que passar do prazo fica como "não saiu").
  const channels = config.enabled ? configChannels(config, args.email_ready === true) : [];
  const planned = planToday(ctx, today, channels, effectiveRules(ctx.db, config));
  const open = withinHours(at, config);
  const claimed = open ? claimSteps(ctx, at, today, channels, limit) : [];
  const waiting = Number(one(ctx.db, `SELECT count(*) n FROM "${D_STEP}" WHERE status='pending' AND planned_on <= ?
    AND channel IN (SELECT value FROM json_each(?))`, today, JSON.stringify(channels))!.n);
  return {
    scope: "finance_dunning_round", data_mode: "erp_native", today, in_hours: open, next_opening: new Date(nextOpening(at, config)).toISOString(),
    tidy, planned, waiting, claimed: claimed.map((s) => stepView(ctx.db, s)),
  };
}

export function erpFinanceDunningReport(ctx: RpcContext, a: RpcArgs) {
  requireAccess(ctx.db, uuidArg(a.p_user_id)!, true);
  const data = object(a.p_data, ["id", "outcome", "reason", "send_ref"]);
  const id = uuidValue(data.id)!;
  const outcome = data.outcome;
  if (!["sent", "failed", "retry", "skipped"].includes(outcome as string)) raise("22023", "erp_dunning_invalid_args");
  const reason = data.reason === undefined || data.reason === null ? null : typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : raise("22023", "erp_dunning_invalid_args");
  const ref = data.send_ref === undefined || data.send_ref === null ? null
    : typeof data.send_ref === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(data.send_ref) ? data.send_ref : raise("22023", "erp_dunning_invalid_args");
  return { scope: "finance_dunning_step", data_mode: "erp_native", ...reportStep(ctx, id, outcome as "sent", reason, ref) };
}

const autoView = (ctx: RpcContext, id: string) => {
  const row = one(ctx.db, `SELECT * FROM "${D_AUTO}" WHERE recurrence_id=?`, id);
  const last = one(ctx.db, `SELECT * FROM "${D_RUN}" WHERE recurrence_id=? ORDER BY created_at DESC LIMIT 1`, id);
  return {
    recurrence_id: id, auto_generate: bool(row?.auto_generate), send_charge: bool(row?.send_charge), updated_at: isoOf(row?.updated_at),
    last_run: last ? { recurrence_on: last.recurrence_on, outcome: last.outcome, title_id: last.title_id ?? null, reason: last.reason ?? null, at: isoOf(last.created_at) } : null,
  };
};

/** As recorrências automáticas (todas as marcadas) e o que o alarme fez nos últimos períodos. */
export function erpFinanceRecurrenceAutoList(ctx: RpcContext, a: RpcArgs) {
  requireAccess(ctx.db, uuidArg(a.p_user_id)!, false);
  const args = object(a.p_args ?? {}, ["ids"]);
  const ids = args.ids === undefined ? null : Array.isArray(args.ids) && args.ids.length <= 100 ? args.ids.map((v) => uuidValue(v)!) : raise("22023", "erp_dunning_invalid_args");
  const list = ids ?? ctx.db.exec(`SELECT recurrence_id FROM "${D_AUTO}" WHERE auto_generate=1 ORDER BY recurrence_id`).rows.map((r) => String(r.recurrence_id));
  const runs = ctx.db.exec(`SELECT x.*, r.description, r.kind, c.name contact_name FROM "${D_RUN}" x JOIN "erp_finance__recurrence" r ON r.id=x.recurrence_id
    LEFT JOIN "erp_catalog__record" c ON c.id=r.contact_id ORDER BY x.created_at DESC LIMIT 30`).rows.map((x) => ({
    recurrence_id: x.recurrence_id, description: x.description, kind: x.kind, contact_name: x.contact_name ?? null, recurrence_on: x.recurrence_on,
    outcome: x.outcome, title_id: x.title_id ?? null, reason: x.reason ?? null, at: isoOf(x.created_at),
  }));
  return { scope: "finance_recurrence_auto", data_mode: "erp_native", items: list.map((id) => autoView(ctx, id)), runs };
}

/** Marca ou desmarca a recorrência como automática (e o envio da cobrança ao gerar, só a receber). */
export function erpFinanceRecurrenceAutoSet(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  requireAccess(ctx.db, user, true);
  const data = object(a.p_data, ["id", "auto_generate", "send_charge"]);
  const id = uuidValue(data.id)!;
  if (typeof data.auto_generate !== "boolean" || (data.send_charge !== undefined && typeof data.send_charge !== "boolean")) raise("22023", "erp_dunning_invalid_args");
  const rec = one(ctx.db, `SELECT id, kind FROM "erp_finance__recurrence" WHERE id=?`, id);
  if (!rec) raise("P0002", "erp_finance_not_found");
  const send = data.send_charge === true;
  if (send && !data.auto_generate) raise("22023", "erp_dunning_send_requires_auto");
  if (send && rec.kind !== "receivable") raise("22023", "erp_dunning_send_receivable_only");
  const at = ctx.clock.next().toString();
  ctx.db.exec(`INSERT INTO "${D_AUTO}"(recurrence_id, auto_generate, send_charge, updated_by, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(recurrence_id) DO UPDATE SET auto_generate=excluded.auto_generate, send_charge=excluded.send_charge, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
  id, data.auto_generate ? 1 : 0, send ? 1 : 0, user, at);
  return { scope: "finance_recurrence_auto", data_mode: "erp_native", item: autoView(ctx, id) };
}

registerRpc("erp_finance_dunning_overview", erpFinanceDunningOverview);
registerRpc("erp_finance_dunning_round", erpFinanceDunningRound);
registerRpc("erp_finance_dunning_report", erpFinanceDunningReport);
registerRpc("erp_finance_recurrence_auto_list", erpFinanceRecurrenceAutoList);
registerRpc("erp_finance_recurrence_auto_set", erpFinanceRecurrenceAutoSet);
