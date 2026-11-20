// OS4: contrato de manutenção (docs/ORDEM-DE-SERVICO.md, "Contrato de
// manutenção"). O contrato liga um cliente (e os objetos cobertos) a um
// plano da Mensalidade; a cobrança recorrente é a da assinatura, criada pelo
// fluxo da própria Mensalidade (src/modules/mensalidade/public.ts). Aqui:
// cobertura, uso do limite por período, ordem coberta e visitas programadas.
import { all, batch, one } from "../../../db";
import { ApiError, type Actor, now, uid } from "../../../types";
import type { ModuleContext } from "../../api";
import {
  createSubscriptionForContract,
  mensalidadeAvailable,
  planForContract,
  plansForContract,
  setSubscriptionForContract,
  subscriptionForContract,
  type ContractSubscriptionSummary,
} from "../../mensalidade/public";
import { authorizedOrder } from "../public";
import { createOrder, loadOrder, saveQuote } from "../store";
import { QUOTABLE, money, type QuoteItem } from "../model";
import { snapshotType } from "../work-types";
import { projectServiceObject } from "../objects/projection";
import {
  CONTRACT_STATUS_LABELS,
  EXCESS_LABELS,
  PERIOD_LABELS,
  addCivilMonths,
  brDate,
  civilToday,
  firstVisit,
  hoursToMinutes,
  inForce,
  nextVisit,
  percentText,
  periodKey,
  splitUsage,
  unitsLabel,
  usageText,
  validateContract,
  visitDue,
  visitRuleText,
  type ContractCoverage,
  type ContractStatus,
  type ValidContract,
  type VisitRule,
} from "./model";

type Row = Record<string, any>;

const notFound = () => new ApiError(404, "not_found", "Contrato não encontrado.");
const parse = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const human = (actor: Actor) => actor.kind === "user" && !actor.id.startsWith("bot:") && !actor.module && !actor.credential;

/** Contrato exige Ordem de Serviço e Mensalidade ligados (409 module_disabled diz qual ligar). */
export async function requireContracts(ctx: ModuleContext) {
  await ctx.requireEnabled();
  if (!(await mensalidadeAvailable(ctx.env, ctx.profile)))
    throw new ApiError(409, "module_disabled", "Contrato de manutenção usa a assinatura da Mensalidade. Ligue o módulo Mensalidade em Gestão → Módulos.");
}
export async function contractsAvailable(ctx: ModuleContext) {
  return (await ctx.enabled()) && (await mensalidadeAvailable(ctx.env, ctx.profile));
}

/** Escrita de contrato e cobertura: pessoa da equipe, ou a proposta do bot que ela confirmou. */
function requireContractWriter(actor: Actor) {
  const confirmed = actor.kind === "user" && !!actor.via?.proposal_id;
  if ((actor.via && !confirmed) || actor.module || actor.credential || actor.id.startsWith("bot:"))
    throw new ApiError(403, "forbidden", "Contrato e cobertura envolvem dinheiro: pelo bot, a pessoa precisa confirmar a proposta.");
}

async function typeIds(ctx: ModuleContext) {
  const settings = await ctx.settings();
  return ["service_order", ...((settings?.os_work_types ?? []) as { id: string }[]).map(t => t.id)];
}
async function typeLabels(ctx: ModuleContext) {
  const settings = await ctx.settings();
  const labels: Record<string, string> = { service_order: "Ordem de serviço" };
  for (const t of (settings?.os_work_types ?? []) as { id: string; labels?: { singular?: string } }[]) labels[t.id] = t.labels?.singular || t.id;
  return labels;
}

export async function loadContract(ctx: ModuleContext, id: unknown): Promise<Row> {
  if (typeof id !== "string" || !id) throw notFound();
  const row = await one(ctx.env, "SELECT * FROM os_contracts WHERE profile_id=? AND id=?", ctx.profile, id);
  if (!row) throw notFound();
  return row;
}
async function contractObjects(ctx: ModuleContext, ids: string[]) {
  if (!ids.length) return new Map<string, Row[]>();
  const rows = await all(ctx.env, `SELECT co.contract_id,o.* FROM os_contract_objects co JOIN os_objects o ON o.profile_id=co.profile_id AND o.id=co.object_id
    WHERE co.profile_id=? AND co.contract_id IN (SELECT value FROM json_each(?)) ORDER BY o.created`, ctx.profile, JSON.stringify(ids));
  const out = new Map<string, Row[]>();
  for (const row of rows) out.set(row.contract_id, [...(out.get(row.contract_id) ?? []), row]);
  return out;
}
function objectSummary(row: Row) {
  try {
    const view = projectServiceObject(row as any, { kind: "staff" } as any);
    return { id: row.id, type_id: row.type_id, type_label: view.type.labels.singular, identifier: view.identifier, archived: row.archived === 1 };
  } catch {
    return { id: row.id, type_id: row.type_id, type_label: row.type_id, identifier: `Objeto · ${String(row.id).slice(-6).toUpperCase()}`, archived: row.archived === 1 };
  }
}

export function stored(row: Row): ValidContract {
  return {
    contact_id: row.contact_id, customer_name: row.customer_name, object_ids: [], plan_id: row.plan_id,
    subscription_id: row.subscription_id ?? null, coverage: parse<ContractCoverage>(row.coverage_json, {} as ContractCoverage),
    starts_on: row.starts_on, ends_on: row.ends_on ?? null,
    adjustment: row.adjustment_bp === null || row.adjustment_bp === undefined ? null : { bp: row.adjustment_bp, on: row.adjustment_on },
    overdue_policy: row.overdue_policy, terms: row.terms ?? "", visits: parse<VisitRule | null>(row.visit_json, null),
  };
}

/** Já usado no período (ordens canceladas não contam: cancelar devolve). */
export async function usedUnits(ctx: ModuleContext, contractId: string, key: string) {
  const row = await one(ctx.env, `SELECT coalesce(sum(u.covered_units),0) used FROM os_contract_usage u
    JOIN os_orders o ON o.profile_id=u.profile_id AND o.id=u.order_id
    WHERE u.profile_id=? AND u.contract_id=? AND u.period_key=? AND u.state='active' AND o.status<>'cancelled'`, ctx.profile, contractId, key);
  return Number(row?.used ?? 0);
}

export interface ContractView {
  id: string; number: number; display_number: string; version: number;
  status: ContractStatus; status_label: string; in_force: boolean;
  customer: { contact_id: string; name: string; phone: string | null };
  objects: ReturnType<typeof objectSummary>[];
  plan: { id: string; name: string; amount_cents: number | null; period_label: string } | null;
  subscription: ContractSubscriptionSummary | null;
  coverage: ContractCoverage & { type_labels: string[]; text: string; excess_text: string };
  usage: { period_key: string; used: number; limit: number; remaining: number; text: string };
  starts_on: string; ends_on: string | null;
  adjustment: { percent: number; on: string; text: string; due: boolean; noticed_on: string | null } | null;
  overdue_policy: "warn" | "block";
  terms: string;
  visits: (VisitRule & { text: string; next_on: string | null; due: boolean }) | null;
  status_reason: string; status_changed_at: number | null;
  warnings: string[];
  created: number; updated: number;
}

/** Formato da API e do painel: cliente, objetos, plano, vencimentos, uso no período. */
export async function contractViews(ctx: ModuleContext, rows: Row[], at = now()): Promise<ContractView[]> {
  if (!rows.length) return [];
  const day = civilToday(at);
  const [objects, labels, contacts] = await Promise.all([
    contractObjects(ctx, rows.map(r => r.id)), typeLabels(ctx),
    all(ctx.env, "SELECT id,name,phone FROM contacts WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))", ctx.profile, JSON.stringify(rows.map(r => r.contact_id))),
  ]);
  const mensalidade = await mensalidadeAvailable(ctx.env, ctx.profile);
  return Promise.all(rows.map(async row => {
    const data = stored(row), coverage = data.coverage;
    const contact = contacts.find(c => c.id === row.contact_id);
    const [plan, subscription] = mensalidade ? await Promise.all([
      planForContract(ctx.env, ctx.profile, row.plan_id),
      row.subscription_id ? subscriptionForContract(ctx.env, ctx.profile, row.subscription_id, at) : null,
    ]) : [null, null];
    const key = periodKey(coverage.period, day), used = await usedUnits(ctx, row.id, key);
    const warnings: string[] = [];
    if (!mensalidade) warnings.push("A Mensalidade está desligada: ligue o módulo para ver os vencimentos da assinatura.");
    if (subscription?.overdue) warnings.push(`Assinatura em atraso (${money(subscription.overdue_cents)}). ${data.overdue_policy === "block" ? "Pela regra do contrato, a cobertura fica bloqueada até o pagamento." : "A cobertura continua, com aviso."}`);
    else if (subscription?.late_in_grace) warnings.push(`Parcela vencida dentro da carência de ${subscription.grace_days} dias.`);
    if (subscription && subscription.status !== "active" && row.status === "active") warnings.push(`A assinatura está ${subscription.status_label.toLowerCase()} na Mensalidade.`);
    if (row.status === "active" && !subscription && mensalidade) warnings.push("Contrato sem assinatura na Mensalidade: nada é cobrado.");
    const adjustmentDue = !!data.adjustment && data.adjustment.on <= day;
    if (data.adjustment && row.adjustment_noticed_on && addCivilMonths(row.adjustment_noticed_on, 1) >= day)
      warnings.push(`Reajuste de ${percentText(data.adjustment.bp)} previsto para ${brDate(row.adjustment_noticed_on)}: aplique no valor da assinatura na Mensalidade (o sistema não reajusta sozinho).`);
    const visitsDue = row.status === "active" && visitDue(data.visits, row.next_visit_on ?? null, day, data.ends_on);
    return {
      id: row.id, number: row.number, display_number: `Contrato nº ${row.number}`, version: row.row_version,
      status: row.status, status_label: CONTRACT_STATUS_LABELS[row.status as ContractStatus] ?? row.status,
      in_force: inForce(row as any, day),
      customer: { contact_id: row.contact_id, name: row.customer_name || contact?.name || "", phone: contact?.phone ?? null },
      objects: (objects.get(row.id) ?? []).map(objectSummary),
      plan: plan ? { id: plan.id, name: plan.name, amount_cents: plan.amount_cents, period_label: plan.period_label } : null,
      subscription,
      coverage: { ...coverage, type_labels: coverage.type_ids.length ? coverage.type_ids.map(id => labels[id] ?? id) : ["Todos os modelos"],
        text: `${unitsLabel(coverage.unit, coverage.limit)} ${PERIOD_LABELS[coverage.period].label}`, excess_text: EXCESS_LABELS[coverage.excess] },
      usage: { period_key: key, used, limit: coverage.limit, remaining: Math.max(0, coverage.limit - used), text: usageText(coverage, used) },
      starts_on: row.starts_on, ends_on: row.ends_on ?? null,
      adjustment: data.adjustment ? { percent: data.adjustment.bp / 100, on: data.adjustment.on, due: adjustmentDue, noticed_on: row.adjustment_noticed_on ?? null,
        text: `Reajuste anual informado de ${percentText(data.adjustment.bp)} em ${brDate(data.adjustment.on)}` } : null,
      overdue_policy: data.overdue_policy, terms: data.terms,
      visits: data.visits ? { ...data.visits, text: visitRuleText(data.visits), next_on: row.next_visit_on ?? null, due: visitsDue } : null,
      status_reason: row.status_reason ?? "", status_changed_at: row.status_changed_at ?? null,
      warnings, created: row.created, updated: row.updated,
    };
  }));
}
export async function contractView(ctx: ModuleContext, row: Row) {
  return (await contractViews(ctx, [row]))[0];
}

/** GET service-orders/contracts: situação, cliente, objeto e busca, por número decrescente. */
export async function listContracts(ctx: ModuleContext, query: Record<string, string>) {
  const where = ["c.profile_id=?"], args: unknown[] = [ctx.profile];
  const situation = query.situation || query.status;
  if (situation) {
    const statuses = situation.split(",").filter(Boolean);
    if (!statuses.every(s => ["active", "suspended", "ended"].includes(s))) throw new ApiError(400, "invalid_filter", "Situação: active, suspended ou ended.");
    where.push(`c.status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses);
  }
  if (query.contact_id) { where.push("c.contact_id=?"); args.push(query.contact_id); }
  if (query.object_id) { where.push("EXISTS(SELECT 1 FROM os_contract_objects co WHERE co.profile_id=c.profile_id AND co.contract_id=c.id AND co.object_id=?)"); args.push(query.object_id); }
  const q = (query.q || "").trim().slice(0, 100);
  if (q) {
    const like = "%" + q.toLowerCase().replace(/[%_\\]/g, m => "\\" + m) + "%";
    const digits = /^\d+$/.test(q) ? Number(q) : null;
    where.push(`(lower(c.customer_name) LIKE ? ESCAPE '\\'${digits ? " OR c.number=?" : ""})`);
    args.push(like, ...(digits ? [digits] : []));
  }
  const before = Number(query.cursor);
  if (Number.isInteger(before) && before > 0) { where.push("c.number<?"); args.push(before); }
  const limit = Math.min(Math.max(Math.trunc(Number(query.limit)) || 50, 1), 100);
  const rows = await all(ctx.env, `SELECT c.* FROM os_contracts c WHERE ${where.join(" AND ")} ORDER BY c.number DESC LIMIT ?`, ...args, limit + 1);
  const page = rows.slice(0, limit);
  const counts = Object.fromEntries((await all(ctx.env, "SELECT status,count(*) n FROM os_contracts WHERE profile_id=? GROUP BY status", ctx.profile)).map(r => [r.status, r.n]));
  return { data: await contractViews(ctx, page), next_cursor: rows.length > limit ? String(page.at(-1)!.number) : null, counts };
}

/** Contratos vigentes de um cliente ou objeto (ficha do cliente, tela do objeto, ordem). */
export async function contractsInForce(ctx: ModuleContext, filter: { contact_id?: string | null; object_id?: string | null; phone?: string | null }) {
  const day = civilToday(now());
  const or: string[] = [], args: unknown[] = [];
  if (filter.contact_id) { or.push("c.contact_id=?"); args.push(filter.contact_id); }
  if (filter.object_id) { or.push("EXISTS(SELECT 1 FROM os_contract_objects co WHERE co.profile_id=c.profile_id AND co.contract_id=c.id AND co.object_id=?)"); args.push(filter.object_id); }
  if (filter.phone) { or.push("EXISTS(SELECT 1 FROM contacts k WHERE k.profile_id=c.profile_id AND k.id=c.contact_id AND k.phone=?)"); args.push(filter.phone); }
  if (!or.length) return [];
  return all(ctx.env, `SELECT c.* FROM os_contracts c WHERE c.profile_id=? AND c.status IN ('active','suspended') AND c.starts_on<=? AND (c.ends_on IS NULL OR c.ends_on>=?)
    AND (${or.join(" OR ")}) ORDER BY c.number LIMIT 20`, ctx.profile, day, day, ...args);
}

// ---------------------------------------------------------------------------
// Criar, editar, suspender e encerrar

async function checkReferences(ctx: ModuleContext, data: ValidContract) {
  const contact = await one(ctx.env, "SELECT id,name,phone FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active'", ctx.profile, data.contact_id);
  if (!contact) throw new ApiError(422, "customer_required", "Escolha o cliente no cadastro de contatos (ativo).");
  if (data.object_ids.length) {
    const found = await all(ctx.env, "SELECT id,contact_id,archived FROM os_objects WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))", ctx.profile, JSON.stringify(data.object_ids));
    for (const id of data.object_ids) {
      const object = found.find(o => o.id === id);
      if (!object || object.contact_id !== data.contact_id) throw new ApiError(422, "object_not_owned", "Os objetos do contrato precisam ser do mesmo cliente.");
    }
  }
  const plan = await planForContract(ctx.env, ctx.profile, data.plan_id);
  if (!plan) throw new ApiError(422, "plan_required", "Escolha um plano da Mensalidade que exista.");
  if (data.subscription_id) {
    const sub = await subscriptionForContract(ctx.env, ctx.profile, data.subscription_id);
    if (!sub) throw new ApiError(422, "subscription_not_found", "Assinatura da Mensalidade não encontrada.");
  }
  return { contact, plan };
}

function history(ctx: ModuleContext, contractId: string, kind: string, actor: string, note: string, at: number): [string, unknown[]] {
  return ["INSERT INTO os_contract_history(id,profile_id,contract_id,kind,actor,note,created) VALUES(?,?,?,?,?,?,?)", [uid(), ctx.profile, contractId, kind, actor, note.slice(0, 500), at]];
}
function objectStatements(ctx: ModuleContext, contractId: string, ids: string[], at: number): [string, unknown[]][] {
  return [["DELETE FROM os_contract_objects WHERE profile_id=? AND contract_id=?", [ctx.profile, contractId]],
    ...ids.map(id => ["INSERT INTO os_contract_objects(profile_id,contract_id,object_id,created) VALUES(?,?,?,?)", [ctx.profile, contractId, id, at]] as [string, unknown[]])];
}

/** POST service-orders/contracts. Sem subscription_id, cria a assinatura pela Mensalidade. */
export async function createContract(ctx: ModuleContext, actor: Actor, input: Row, requestId: string) {
  requireContractWriter(actor);
  ctx.access(actor, "conversations:write");
  await requireContracts(ctx);
  const sourceKey = `${actor.id}:${requestId}`;
  const existing = await one(ctx.env, "SELECT * FROM os_contracts WHERE profile_id=? AND source_key=?", ctx.profile, sourceKey);
  if (existing) return contractView(ctx, existing);
  const data = validateContract(input, await typeIds(ctx));
  const { contact, plan } = await checkReferences(ctx, data);
  const name = data.customer_name || contact.name || "";
  if (!name) throw new ApiError(422, "customer_required", "Informe o nome do cliente do contrato.");
  let subscription = data.subscription_id;
  if (!subscription && input.create_subscription !== false) {
    if (!contact.phone) throw new ApiError(422, "phone_required", "A assinatura da Mensalidade precisa do telefone do cliente. Cadastre o telefone no contato ou escolha uma assinatura existente.");
    if (!plan.active) throw new ApiError(422, "plan_inactive", `O plano "${plan.name}" está desativado na Mensalidade.`);
    subscription = await createSubscriptionForContract(ctx.env, ctx.profile, {
      plan_id: data.plan_id, customer_name: name, phone: contact.phone, start_date: data.starts_on, end_date: data.ends_on,
      notes: "Contrato de manutenção", sourceKey: `os-contract:${ctx.profile}:${sourceKey}`, actor: actor.id,
    });
  }
  const id = uid(), at = now();
  const nextVisitOn = data.visits ? firstVisit(data.visits, data.starts_on) : null;
  await batch(ctx.env, [
    ["INSERT INTO os_contract_counters(profile_id,last) VALUES(?,1) ON CONFLICT(profile_id) DO UPDATE SET last=last+1", [ctx.profile]],
    [`INSERT INTO os_contracts(id,profile_id,number,contact_id,customer_name,plan_id,subscription_id,status,coverage_json,starts_on,ends_on,adjustment_bp,adjustment_on,overdue_policy,terms,visit_json,next_visit_on,source_key,created_by,created,updated)
      VALUES(?,?,(SELECT last FROM os_contract_counters WHERE profile_id=?),?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, ctx.profile, ctx.profile, data.contact_id, name, data.plan_id, subscription, JSON.stringify(data.coverage), data.starts_on, data.ends_on,
        data.adjustment?.bp ?? null, data.adjustment?.on ?? null, data.overdue_policy, data.terms, data.visits ? JSON.stringify(data.visits) : null, nextVisitOn,
        sourceKey, actor.id, at, at]],
    ...objectStatements(ctx, id, data.object_ids, at),
    history(ctx, id, "created", actor.id, `Contrato criado: plano ${plan.name}, ${unitsLabel(data.coverage.unit, data.coverage.limit)} ${PERIOD_LABELS[data.coverage.period].label}.`, at),
  ]);
  const row = await loadContract(ctx, id);
  await ctx.publish("os.contract.created", id, { contract_id: id, number: row.number, contact_id: row.contact_id, plan_id: row.plan_id, subscription_id: row.subscription_id }, { key: `contract:${id}:1` });
  return contractView(ctx, row);
}

function checkContractVersion(row: Row, version: unknown) {
  if (version === undefined) return;
  if (!Number.isSafeInteger(version) || version !== row.row_version) throw new ApiError(409, "version_conflict", "O contrato mudou enquanto isso. Atualize e tente de novo.");
}

/** PATCH service-orders/contracts/:id: cobertura, vigência, objetos, plano, reajuste, condições, visitas. */
export async function updateContract(ctx: ModuleContext, actor: Actor, id: string, input: Row) {
  requireContractWriter(actor);
  ctx.access(actor, "conversations:write");
  await requireContracts(ctx);
  const row = await loadContract(ctx, id);
  checkContractVersion(row, input.version);
  if (row.status === "ended") throw new ApiError(409, "contract_ended", "Contrato encerrado não muda. Crie outro contrato.");
  const { version: _v, id: _id, profile: _p, ...body } = input;
  const objects = (await all(ctx.env, "SELECT object_id FROM os_contract_objects WHERE profile_id=? AND contract_id=?", ctx.profile, id)).map(o => o.object_id);
  const data = validateContract(body, await typeIds(ctx), { ...stored(row), object_ids: objects });
  await checkReferences(ctx, data);
  const at = now();
  const visitChanged = JSON.stringify(data.visits) !== (row.visit_json ?? "null");
  const nextVisitOn = !data.visits ? null : visitChanged ? firstVisit(data.visits, data.starts_on) : row.next_visit_on;
  const changed = Object.keys(body).filter(k => k !== "create_subscription");
  const result = await batch(ctx.env, [
    [`UPDATE os_contracts SET customer_name=?,plan_id=?,subscription_id=?,coverage_json=?,starts_on=?,ends_on=?,adjustment_bp=?,adjustment_on=?,overdue_policy=?,terms=?,visit_json=?,next_visit_on=?,row_version=row_version+1,updated=?
      WHERE profile_id=? AND id=? AND row_version=?`,
      [data.customer_name || row.customer_name, data.plan_id, data.subscription_id, JSON.stringify(data.coverage), data.starts_on, data.ends_on,
        data.adjustment?.bp ?? null, data.adjustment?.on ?? null, data.overdue_policy, data.terms, data.visits ? JSON.stringify(data.visits) : null, nextVisitOn,
        at, ctx.profile, id, row.row_version]],
    ["SELECT CASE WHEN changes()=1 THEN 1 ELSE json('os_version_conflict') END", []],
    ...(Object.hasOwn(body, "object_ids") ? objectStatements(ctx, id, data.object_ids, at) : []),
    history(ctx, id, "updated", actor.id, `Alterado: ${changed.join(", ") || "nada"}.`, at),
  ]).catch(error => {
    if (/malformed JSON|os_version_conflict/i.test(String(error))) throw new ApiError(409, "version_conflict", "O contrato mudou enquanto isso. Atualize e tente de novo.");
    throw error;
  });
  void result;
  const next = await loadContract(ctx, id);
  await ctx.publish("os.contract.updated", id, { contract_id: id, version: next.row_version, changed }, { key: `contract:${id}:${next.row_version}` });
  return contractView(ctx, next);
}

/**
 * POST service-orders/contracts/:id/situation: suspender, reativar ou encerrar,
 * com motivo. subscription="follow" (padrão) pausa, retoma ou encerra a
 * assinatura junto; "keep" não mexe na Mensalidade.
 */
export async function setContractStatus(ctx: ModuleContext, actor: Actor, id: string, input: Row) {
  requireContractWriter(actor);
  ctx.access(actor, "conversations:write");
  await requireContracts(ctx);
  const row = await loadContract(ctx, id);
  const to = input.status as ContractStatus;
  if (!["active", "suspended", "ended"].includes(to)) throw new ApiError(400, "invalid_request", "Situação: active, suspended ou ended.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (to !== "active" && !reason) throw new ApiError(400, "reason_required", "Informe o motivo da suspensão ou do encerramento.");
  if (Array.from(reason).length > 500) throw new ApiError(400, "invalid_request", "Motivo: até 500 caracteres.");
  if (row.status === to) return contractView(ctx, row);
  checkContractVersion(row, input.version);
  const allowed: Record<ContractStatus, ContractStatus[]> = { active: ["suspended", "ended"], suspended: ["active", "ended"], ended: [] };
  if (!allowed[row.status as ContractStatus].includes(to))
    throw new ApiError(409, "invalid_transition", `Não é possível passar o contrato de "${CONTRACT_STATUS_LABELS[row.status as ContractStatus]}" para "${CONTRACT_STATUS_LABELS[to]}".`);
  const follow = input.subscription !== "keep";
  if (follow && row.subscription_id)
    await setSubscriptionForContract(ctx.env, ctx.profile, row.subscription_id, to === "active" ? "active" : to === "suspended" ? "paused" : "ended", actor.id);
  const at = now();
  const label = { active: "Contrato reativado", suspended: "Contrato suspenso", ended: "Contrato encerrado" }[to];
  await batch(ctx.env, [
    ["UPDATE os_contracts SET status=?,status_reason=?,status_changed_at=?,status_changed_by=?,ends_on=CASE WHEN ?='ended' AND (ends_on IS NULL OR ends_on>?) THEN ? ELSE ends_on END,row_version=row_version+1,updated=? WHERE profile_id=? AND id=? AND status=?",
      [to, reason, at, actor.id, to, civilToday(at), civilToday(at), at, ctx.profile, id, row.status]],
    ["SELECT CASE WHEN changes()=1 THEN 1 ELSE json('os_version_conflict') END", []],
    history(ctx, id, to, actor.id, `${label}${reason ? `: ${reason}` : ""}${follow && row.subscription_id ? " (assinatura acompanha)" : ""}.`, at),
  ]);
  const next = await loadContract(ctx, id);
  await ctx.publish(to === "ended" ? "os.contract.ended" : "os.contract.updated", id, { contract_id: id, status: to, version: next.row_version }, { key: `contract:${id}:${next.row_version}` });
  return contractView(ctx, next);
}

export async function contractHistory(ctx: ModuleContext, id: string) {
  await loadContract(ctx, id);
  return (await all(ctx.env, "SELECT id,kind,actor,note,created FROM os_contract_history WHERE profile_id=? AND contract_id=? ORDER BY created DESC,id LIMIT 100", ctx.profile, id));
}

/** Opções da tela: módulos, planos e modelos. */
export async function contractOptions(ctx: ModuleContext) {
  const os = await ctx.enabled(), mensalidade = await mensalidadeAvailable(ctx.env, ctx.profile);
  const labels = await typeLabels(ctx);
  return {
    modules: { os, mensalidade },
    missing: !os ? "Ligue o módulo Ordem de Serviço em Gestão → Módulos." : !mensalidade ? "Ligue o módulo Mensalidade em Gestão → Módulos para usar contratos de manutenção." : null,
    plans: mensalidade ? await plansForContract(ctx.env, ctx.profile) : [],
    types: Object.entries(labels).map(([id, label]) => ({ id, label })),
  };
}

// ---------------------------------------------------------------------------
// A ordem conhece o contrato

async function orderContracts(ctx: ModuleContext, order: Row) {
  return contractsInForce(ctx, { contact_id: order.contact_id, object_id: order.object_id, phone: order.contact_id ? null : order.phone || null });
}

/** GET service-orders/:id/contract: contratos que cobrem a ordem, uso do período e a marcação atual. */
export async function orderContractView(ctx: ModuleContext, actor: Actor, orderId: string) {
  const { row: order } = await authorizedOrder(ctx, actor, orderId);
  const available = await contractsAvailable(ctx);
  const usage = await one(ctx.env, "SELECT * FROM os_contract_usage WHERE profile_id=? AND order_id=? AND state='active'", ctx.profile, orderId);
  if (!available) return { available: false, missing: "Ligue o módulo Mensalidade em Gestão → Módulos para usar contratos de manutenção.", contracts: [], coverage: null };
  const rows = await orderContracts(ctx, order);
  if (usage && !rows.some(r => r.id === usage.contract_id)) {
    const marked = await one(ctx.env, "SELECT * FROM os_contracts WHERE profile_id=? AND id=?", ctx.profile, usage.contract_id);
    if (marked) rows.push(marked);
  }
  const views = await contractViews(ctx, rows);
  const contracts = views.map(view => {
    const blocked = !view.in_force ? view.status === "suspended" ? "Contrato suspenso." : "Contrato fora da vigência."
      : view.coverage.type_ids.length && !view.coverage.type_ids.includes(String(order.type_id ?? "service_order")) ? "Este modelo de ordem não está incluído no contrato."
      : view.subscription?.overdue && view.overdue_policy === "block" ? "Assinatura em atraso: a regra do contrato bloqueia a cobertura até o pagamento." : null;
    return { ...view, headline: `Coberto pelo contrato nº ${view.number}: ${view.usage.text}`, can_cover: !blocked && !usage && !["delivered", "cancelled"].includes(order.status), blocked_reason: blocked };
  });
  const marked = usage ? views.find(v => v.id === usage.contract_id) : null;
  return {
    available: true, missing: null, contracts,
    coverage: usage ? { contract_id: usage.contract_id, contract_number: marked?.number ?? null, period_key: usage.period_key,
      covered_units: usage.covered_units, excess_units: usage.excess_units, unit: marked?.coverage.unit ?? "visits",
      covered_text: marked ? unitsLabel(marked.coverage.unit, usage.covered_units) : "", excess_text: marked && usage.excess_units ? unitsLabel(marked.coverage.unit, usage.excess_units) : "",
      excess_rule: marked?.coverage.excess ?? "quote", counts: order.status !== "cancelled", created: usage.created } : null,
  };
}

/**
 * POST service-orders/:id/contract-coverage: marca a ordem como coberta.
 * Consome o limite do período; o que passar entra como excedente. Com o
 * orçamento editável, entra a linha "coberto pelo contrato" com valor zero e,
 * havendo preço do excedente, a linha excedente com preço.
 */
export async function coverOrder(ctx: ModuleContext, actor: Actor, orderId: string, input: Row, requestId: string) {
  requireContractWriter(actor);
  const { row: order } = await authorizedOrder(ctx, actor, orderId, { write: true });
  await requireContracts(ctx);
  const done = await one(ctx.env, "SELECT * FROM os_contract_usage WHERE profile_id=? AND order_id=? AND state='active'", ctx.profile, orderId);
  if (done) {
    if (done.id === `cover:${actor.id}:${requestId}` || done.contract_id === input.contract_id) return { ...(await orderContractView(ctx, actor, orderId)), warnings: [] };
    throw new ApiError(409, "already_covered", "Esta ordem já está marcada como coberta por outro contrato. Desmarque antes de trocar.");
  }
  if (input.version !== undefined && input.version !== (order.row_version ?? 1)) throw new ApiError(409, "version_conflict", "A ordem mudou enquanto isso. Atualize e tente de novo.");
  if (["delivered", "cancelled"].includes(order.status)) throw new ApiError(409, "order_closed", "Ordem encerrada não pode ser marcada como coberta.");
  const contract = await loadContract(ctx, input.contract_id);
  const candidates = await orderContracts(ctx, order);
  if (!candidates.some(c => c.id === contract.id)) throw new ApiError(409, "contract_not_covering", "Este contrato não é do cliente nem do objeto desta ordem, ou está fora da vigência.");
  const data = stored(contract), at = now(), day = civilToday(at);
  if (!inForce(contract as any, day)) throw new ApiError(409, "contract_suspended", contract.status === "suspended" ? "O contrato está suspenso. Reative o contrato para marcar ordens cobertas." : "O contrato está fora da vigência.");
  if (data.coverage.type_ids.length && !data.coverage.type_ids.includes(String(order.type_id ?? "service_order"))) throw new ApiError(409, "contract_not_covering", "Este modelo de ordem não está incluído no contrato.");
  const warnings: string[] = [];
  const subscription = contract.subscription_id ? await subscriptionForContract(ctx.env, ctx.profile, contract.subscription_id, at) : null;
  if (subscription?.overdue) {
    if (data.overdue_policy === "block") throw new ApiError(409, "contract_overdue", `A assinatura do contrato nº ${contract.number} está em atraso (${money(subscription.overdue_cents)}). Pela regra do contrato, a cobertura fica bloqueada até o pagamento: registre o pagamento na Mensalidade ou siga pelo orçamento normal.`);
    warnings.push(`Assinatura do contrato nº ${contract.number} em atraso (${money(subscription.overdue_cents)}). A regra do contrato só avisa: a cobertura foi marcada.`);
  }
  const units = data.coverage.unit === "visits" ? 1 : hoursToMinutes(input.hours, "Horas da ordem");
  const key = periodKey(data.coverage.period, day);
  const split = splitUsage(data.coverage, await usedUnits(ctx, contract.id, key), units);
  await batch(ctx.env, [[`INSERT INTO os_contract_usage(id,profile_id,contract_id,order_id,period_key,covered_units,excess_units,state,created_by,created) VALUES(?,?,?,?,?,?,?,'active',?,?)
    ON CONFLICT(profile_id,order_id) DO UPDATE SET id=excluded.id,contract_id=excluded.contract_id,period_key=excluded.period_key,covered_units=excluded.covered_units,
      excess_units=excluded.excess_units,state='active',created_by=excluded.created_by,created=excluded.created,released_at=NULL,released_by=NULL WHERE os_contract_usage.state='released'`,
    [`cover:${actor.id}:${requestId}`, ctx.profile, contract.id, orderId, key, split.covered, split.excess, actor.id, at]]]);
  if (split.excess) warnings.push(`${unitsLabel(data.coverage.unit, split.excess)} além do limite: excedente. ${EXCESS_LABELS[data.coverage.excess]}`);
  const lines: QuoteItem[] = [];
  const hours = (minutes: number) => Math.round(minutes / 60 * 100) / 100;
  if (split.covered) lines.push({ description: data.coverage.unit === "visits" ? `Visita coberta pelo contrato nº ${contract.number}` : `Horas cobertas pelo contrato nº ${contract.number}`,
    quantity: data.coverage.unit === "visits" ? 1 : hours(split.covered), unit_cents: 0, kind: "service", unit: data.coverage.unit === "visits" ? "UN" : "H", covered: true });
  if (split.excess && data.coverage.excess_unit_cents !== null) lines.push({ description: data.coverage.unit === "visits" ? `Visita excedente ao contrato nº ${contract.number}` : `Horas excedentes ao contrato nº ${contract.number}`,
    quantity: data.coverage.unit === "visits" ? split.excess : hours(split.excess), unit_cents: data.coverage.excess_unit_cents, kind: "service", unit: data.coverage.unit === "visits" ? "UN" : "H" });
  else if (split.excess) warnings.push("Informe o preço do excedente no orçamento da ordem.");
  const fresh = await loadOrder(ctx, orderId);
  const quotable = QUOTABLE.includes(fresh.status) && !(snapshotType(fresh) && !snapshotType(fresh)!.features?.quote);
  if (lines.length && quotable) {
    const current = (fresh.quote_items ? JSON.parse(fresh.quote_items) : []) as QuoteItem[];
    try {
      await saveQuote(ctx, fresh, { items: [...lines, ...current], version: fresh.row_version, note: fresh.quote_note ?? "",
        ...(fresh.quote_valid_days != null ? { valid_days: fresh.quote_valid_days } : {}) },
        actor.id, `os-cover:${actor.id}:${requestId}`, { notify: false, human: human(actor) });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      warnings.push(`A linha do contrato não entrou no orçamento (${error.message}) Ajuste o orçamento à mão.`);
    }
  } else if (lines.length) warnings.push("O orçamento desta ordem não pode mudar agora: a cobertura foi registrada sem alterar os itens.");
  await ctx.publish("os.contract.covered", orderId, { order_id: orderId, contract_id: contract.id, period_key: key, covered_units: split.covered, excess_units: split.excess }, { key: `cover:${orderId}:${at}` });
  return { ...(await orderContractView(ctx, actor, orderId)), warnings };
}

/** POST service-orders/:id/contract-coverage/release: desmarca (devolve o limite) com motivo. */
export async function releaseCoverage(ctx: ModuleContext, actor: Actor, orderId: string, input: Row) {
  requireContractWriter(actor);
  await authorizedOrder(ctx, actor, orderId, { write: true });
  await requireContracts(ctx);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || Array.from(reason).length > 500) throw new ApiError(400, "reason_required", "Informe o motivo para desmarcar a cobertura (até 500 caracteres).");
  const usage = await one(ctx.env, "SELECT * FROM os_contract_usage WHERE profile_id=? AND order_id=? AND state='active'", ctx.profile, orderId);
  if (!usage) return { ...(await orderContractView(ctx, actor, orderId)), warnings: [] };
  const at = now();
  await batch(ctx.env, [
    ["UPDATE os_contract_usage SET state='released',released_at=?,released_by=? WHERE profile_id=? AND order_id=? AND state='active'", [at, actor.id, ctx.profile, orderId]],
    history(ctx, usage.contract_id, "released", actor.id, `Cobertura da ordem desmarcada: ${reason}.`, at),
  ]);
  return { ...(await orderContractView(ctx, actor, orderId)), warnings: ["Cobertura desmarcada. Revise o orçamento: as linhas do contrato continuam até você editar."] };
}

// ---------------------------------------------------------------------------
// Visitas programadas: "Manutenções a abrir"

/** GET service-orders/maintenance-due: visitas dentro da antecedência, para a pessoa confirmar. */
export async function maintenanceDue(ctx: ModuleContext, at = now()) {
  const available = await contractsAvailable(ctx);
  if (!available) return { available: false, missing: "Ligue o módulo Mensalidade em Gestão → Módulos para usar contratos de manutenção.", data: [] };
  const day = civilToday(at);
  const rows = await all(ctx.env, `SELECT * FROM os_contracts WHERE profile_id=? AND status='active' AND visit_json IS NOT NULL AND next_visit_on IS NOT NULL
    AND (ends_on IS NULL OR next_visit_on<=ends_on) ORDER BY next_visit_on,number LIMIT 200`, ctx.profile);
  const due = rows.filter(r => visitDue(stored(r).visits, r.next_visit_on, day, r.ends_on ?? null) && r.starts_on <= addCivilMonths(day, 2));
  const views = await contractViews(ctx, due, at);
  const labels = await typeLabels(ctx);
  return {
    available: true, missing: null,
    data: views.map(view => ({
      contract: view, due_on: view.visits!.next_on!, overdue: view.visits!.next_on! < day,
      type_id: view.visits!.type_id, type_label: labels[view.visits!.type_id] ?? view.visits!.type_id, item: view.visits!.item,
      objects: view.objects.filter(o => !o.archived),
    })),
  };
}

/**
 * POST service-orders/contracts/:id/visits: confirma a visita proposta e abre
 * a ordem de manutenção (coberta pelo contrato), ou pula esta data
 * (action="skip"). A próxima data segue a série. Nunca abre sozinho.
 */
export async function openVisit(ctx: ModuleContext, actor: Actor, contractId: string, input: Row, requestId: string) {
  requireContractWriter(actor);
  ctx.access(actor, "conversations:write");
  await requireContracts(ctx);
  const contract = await loadContract(ctx, contractId);
  const data = stored(contract);
  if (contract.status !== "active" || !data.visits || !contract.next_visit_on) throw new ApiError(409, "no_visit_due", "Este contrato não tem visita programada a abrir.");
  if (input.due_on !== contract.next_visit_on) throw new ApiError(409, "version_conflict", "A visita já foi aberta ou pulada. Atualize a lista.");
  const at = now(), next = nextVisit(data.visits, contract.next_visit_on);
  const advance: [string, unknown[]] = ["UPDATE os_contracts SET next_visit_on=?,row_version=row_version+1,updated=? WHERE profile_id=? AND id=? AND next_visit_on=?", [next, at, ctx.profile, contractId, contract.next_visit_on]];
  if (input.action === "skip") {
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
    await batch(ctx.env, [advance, history(ctx, contractId, "visit_skipped", actor.id, `Visita de ${brDate(contract.next_visit_on)} pulada${reason ? `: ${reason}` : ""}. Próxima: ${brDate(next)}.`, at)]);
    return { order: null, contract: await contractView(ctx, await loadContract(ctx, contractId)), warnings: [] };
  }
  const type = data.visits.type_id;
  const settings = await ctx.settings();
  const custom = ((settings?.os_work_types ?? []) as any[]).find(t => t.id === type);
  if (type !== "service_order" && !custom) throw new ApiError(409, "type_not_found", "O modelo da visita programada não existe mais. Edite o contrato.");
  const contact = await one(ctx.env, "SELECT id,name,phone FROM contacts WHERE profile_id=? AND id=?", ctx.profile, contract.contact_id);
  let object: { mode: "existing"; id: string; version: number } | undefined;
  if (custom?.object_type_id) {
    const wanted = typeof input.object_id === "string" ? input.object_id : null;
    const candidates = await all(ctx.env, `SELECT o.id,o.row_version,o.type_id FROM os_contract_objects co JOIN os_objects o ON o.profile_id=co.profile_id AND o.id=co.object_id
      WHERE co.profile_id=? AND co.contract_id=? AND o.archived=0 AND o.type_id=?`, ctx.profile, contractId, custom.object_type_id);
    const chosen = wanted ? candidates.find(c => c.id === wanted) : candidates.length === 1 ? candidates[0] : null;
    if (!chosen) throw new ApiError(409, "object_required", candidates.length ? "Escolha qual objeto do contrato recebe esta visita." : "O modelo da visita usa objeto do serviço: inclua o objeto no contrato.");
    object = { mode: "existing", id: chosen.id, version: chosen.row_version };
  }
  const { order } = await createOrder(ctx, {
    type_id: type, contact_id: contract.contact_id, authority: actor, ...(object ? { object } : {}),
    customer_name: contract.customer_name || contact?.name || "", phone: object ? undefined : contact?.phone || undefined,
    item: data.visits.item, problem: `Manutenção programada do contrato nº ${contract.number} (${brDate(contract.next_visit_on)}).`,
    source: "panel", sourceKey: `os-visit:${contractId}:${contract.next_visit_on}`, actor: actor.id, notify: false,
  });
  await batch(ctx.env, [advance, history(ctx, contractId, "visit_opened", actor.id, `Visita de ${brDate(contract.next_visit_on)} aberta na ordem ${order.number}. Próxima: ${brDate(next)}.`, at)]);
  const warnings: string[] = [];
  try {
    const covered = await coverOrder(ctx, actor, order.id, { contract_id: contractId, ...(data.coverage.unit === "hours" ? { hours: 1 } : {}) }, `visit:${requestId}`);
    warnings.push(...covered.warnings);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    warnings.push(`A ordem foi aberta sem cobertura: ${error.message}`);
  }
  return { order: { id: order.id, number: order.number, type_id: order.type_id }, contract: await contractView(ctx, await loadContract(ctx, contractId)), warnings };
}

/** Rodada periódica: avisa o reajuste anual na data (só registra; não reajusta). */
export async function runContractsDue(ctx: ModuleContext, at: number) {
  if (!(await contractsAvailable(ctx))) return;
  const day = civilToday(at);
  const rows = await all(ctx.env, "SELECT * FROM os_contracts WHERE profile_id=? AND status='active' AND adjustment_on IS NOT NULL AND adjustment_on<=? LIMIT 50", ctx.profile, day);
  for (const row of rows) {
    const next = addCivilMonths(row.adjustment_on, 12);
    await batch(ctx.env, [
      ["UPDATE os_contracts SET adjustment_noticed_on=?,adjustment_on=?,updated=? WHERE profile_id=? AND id=? AND adjustment_on=?", [row.adjustment_on, next, at, ctx.profile, row.id, row.adjustment_on]],
      history(ctx, row.id, "adjustment_due", "system", `Reajuste anual informado de ${percentText(row.adjustment_bp)} chegou em ${brDate(row.adjustment_on)}. Aplique o novo valor na assinatura da Mensalidade; o sistema não reajusta sozinho. Próximo aviso: ${brDate(next)}.`, at),
    ]);
    await ctx.publish("os.contract.adjustment_due", row.id, { contract_id: row.id, number: row.number, percent: row.adjustment_bp / 100, on: row.adjustment_on }, { key: `adjustment:${row.id}:${row.adjustment_on}` });
  }
}
