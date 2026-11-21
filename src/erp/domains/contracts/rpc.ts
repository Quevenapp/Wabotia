// Contratos de serviço (parte Contratos, src/erp/parts.ts; depende do
// Financeiro): sem função no oráculo (structural.ts, contratos; tabelas da
// versão 31 em schema/engine-tables.ts).
//
// O contrato tem o cliente, o objeto, os itens (serviços do catálogo, ou uma
// descrição, com quantidade e valor), a vigência (fim ou prazo
// indeterminado), a periodicidade do faturamento, o dia de vencimento, a
// forma de pagamento, a categoria, o vendedor e a situação (rascunho, ativo,
// suspenso, encerrado). As linhas têm validade: o aditivo e o reajuste fecham
// as de antes na véspera da data e abrem as novas, e o período é faturado
// pelas linhas válidas no começo dele.
//
// Faturamento: nasce desligado por contrato. Ligado e com o contrato ativo, a
// rotina diária (scheduler/routines.ts, contracts.daily) gera a conta a
// receber de cada período no Financeiro (insertTitle, como a conta
// recorrente) no começo do período; a fatura tem chave única (contrato,
// início do período): o alarme que repete não gera de novo. A cobrança pelo
// WhatsApp fica "a enviar" para a pessoa mandar pelo envio que existe
// (erp-conversa, conta); a NFS-e fica "a emitir" quando o fiscal de serviço
// está configurado, ou "sem configuração" (só a conta).
//
// Reajuste: o índice (IPCA, IGP-M, INPC, informado pela pessoa na tabela de
// índices, ou percentual fixo) e o mês de aniversário; a rotina avisa quando
// chega o mês e a pessoa aplica pela prévia. Renovação: aviso N dias antes do
// fim; renovar estende o fim pelo prazo. Tudo vai para o histórico.
import { createHash } from "node:crypto";
import { jsonbArg } from "../../engine/args.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo, validDate } from "../../engine/time.ts";
import { permitted } from "../access/public.ts";
import { insertTitle } from "../finance/titles.ts";
import { archiveAvailable, at, linkOf, object as isObject, sourceOf, text as rawText, type Json } from "../../bling/adoption-store.ts";
import { parseHistoricalPayload } from "../../bling/projection.ts";
import {
  INDEX_LABELS, INDICES, PERIODICITIES, PERIODICITY_LABELS, STATUS_ACTIONS, STATUS_LABELS, TABLE_INDICES,
  addDays, adjusted, dateLabel, dueDate, lineTotal, moneyText, monthLabel, nextAdjustmentMonth, parseMoney, parsePercent,
  parseQuantity, pctText, periodEnd, periodIndex, periodStart, qtyText, renewedEnd,
  type AdjustmentIndex, type ContractStatus, type Periodicity,
} from "./model.ts";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_VERSION = 2147483646;
const MAX_ITEMS = 50;
const MAX_QTY = 999999999999n * 10n ** 6n;
const READ_ROLES = ["admin", "financeiro", "consulta", "vendas"];
const WRITE_ROLES = ["admin", "financeiro"];
/** Períodos que uma rodada fatura de um contrato atrasado (o resto fica para a próxima). */
export const CATCH_UP_PERIODS = 12;
/** Contratos que a rotina diária trata por unidade (transação). */
export const DAILY_BATCH = 25;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : (raise("22023", "erp_contract_invalid"), {}));
const args = (v: unknown): Row => (v === null || v === undefined ? {} : obj(jsonbArg(v)));
const has = (o: Row, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const onlyKeys = (o: Row, keys: readonly string[]) => {
  if (Object.keys(o).some((k) => !keys.includes(k))) raise("22023", "erp_contract_invalid");
};
function uuidOf(v: unknown, optional = false): string | null {
  if ((v === null || v === undefined || v === "") && optional) return null;
  if (typeof v !== "string" || !UUID.test(v.toLowerCase())) raise("22023", "erp_contract_invalid");
  return v.toLowerCase();
}
function textOf(v: unknown, max: number, optional = true, code = "erp_contract_invalid"): string | null {
  if (v === null || v === undefined) return optional ? null : raise("22023", code);
  if (typeof v !== "string" || pgLength(v) > max || pgHasCntrl.test(v.replace(/[\n\r\t]/g, " "))) raise("22023", code);
  const t = pgBtrim(v.trim());
  return t === "" ? (optional ? null : raise("22023", code)) : t;
}
function dateOf(v: unknown, optional = true): string | null {
  if ((v === null || v === undefined || v === "") && optional) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !validDate(v) || v < "2000-01-01" || v > "2100-12-31") raise("22023", "erp_contract_invalid_date");
  return v;
}
function intOf(v: unknown, min: number, max: number, code = "erp_contract_invalid"): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) raise("22023", code);
  return v;
}
const versionOf = (v: unknown) => intOf(v, 1, MAX_VERSION);
const boolOf = (v: unknown) => (typeof v === "boolean" ? v : raise("22023", "erp_contract_invalid"));
const monthOf = (v: unknown) => (typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) && v >= "2000-01" && v <= "2100-12" ? v : raise("22023", "erp_contract_invalid_month"));
const today = (ctx: RpcContext) => todaySaoPaulo(Number(ctx.clock.next() / 1000n));
const fold = (s: string) => s.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "");
const clipText = (s: string, n: number) => (pgLength(s) > n ? [...s].slice(0, n - 1).join("") + "…" : s);
const money = (cents: number) => `R$ ${moneyText(cents).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

// ---------------------------------------------------------------------------
// Acesso: papéis do Financeiro (administrador e financeiro gravam; consulta e
// vendas leem). Gerar a conta a receber à mão pede também a permissão de
// incluir contas a receber.

function role(db: SqlDriver, user: string): string | null {
  return (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role as string | undefined) ?? null;
}
function requireAccess(db: SqlDriver, user: string, write: boolean): string {
  const r = role(db, user);
  if (!r || !READ_ROLES.includes(r)) raise("42501", "erp_contract_access_denied");
  if (write && !WRITE_ROLES.includes(r)) raise("42501", "erp_contract_write_denied");
  return r;
}
const canWrite = (db: SqlDriver, user: string) => WRITE_ROLES.includes(role(db, user) ?? "");

// ---------------------------------------------------------------------------
// Comandos: repetição devolve o mesmo resultado; outro pedido com o mesmo id recusa.

function replay(db: SqlDriver, command: string, user: string, action: string, hash: string): Row | null {
  const c = one(db, 'SELECT actor, action, request_hash, result FROM "erp_contract__command" WHERE id=?', command);
  if (!c) return null;
  if (c.actor !== user || c.action !== action || c.request_hash !== hash) raise("40001", "erp_contract_command_conflict");
  return { ...(JSON.parse(String(c.result)) as Row), replayed: true };
}
function remember(ctx: RpcContext, command: string, user: string, action: string, hash: string, result: Row) {
  ctx.db.exec('INSERT INTO "erp_contract__command"(id, actor, action, request_hash, result, created_at) VALUES(?,?,?,?,?,?)',
    command, user, action, hash, JSON.stringify(result), ctx.clock.next().toString());
  return { ...result, replayed: false };
}
const hashOf = (action: string, user: string, data: unknown) => sha256(jsonbText({ profile: "erp-contract-31", action, actor: user, data }));
/** Um comando de gravação: confere acesso, repete o resultado gravado ou roda e grava. */
function write(ctx: RpcContext, a: RpcArgs, action: string, run: (user: string, data: Row) => Row) {
  const user = uuidOf(a.p_user_id)!;
  const command = uuidOf(a.p_command_id)!;
  requireAccess(ctx.db, user, true);
  const data = args(a.p_data);
  const hash = hashOf(action, user, data);
  const previous = replay(ctx.db, command, user, action, hash);
  if (previous) return previous;
  return remember(ctx, command, user, action, hash, run(user, data));
}

// ---------------------------------------------------------------------------
// Leituras de apoio

function contactRef(db: SqlDriver, id: string | null) {
  if (!id) return null;
  const r = one(db, `SELECT r.id, r.name, r.active, c.document, c.mobile, c.phone, c.email FROM "erp_catalog__record" r
    LEFT JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.id=? AND r.entity='contacts'`, id);
  return r ? { id: String(r.id), name: String(r.name), active: !!r.active, document: (r.document as string | null) ?? null,
    phone: ((r.mobile ?? r.phone) as string | null) ?? null, email: (r.email as string | null) ?? null } : null;
}
function categoryRef(db: SqlDriver, id: string | null) {
  if (!id) return null;
  const r = one(db, 'SELECT id, name, active FROM "erp_finance__category" WHERE id=?', id);
  return r ? { id: String(r.id), name: String(r.name), active: !!r.active } : null;
}
function paymentRef(db: SqlDriver, id: string | null) {
  if (!id) return null;
  const r = one(db, 'SELECT id, description, active FROM "erp_catalog__payment_method" WHERE id=?', id);
  return r ? { id: String(r.id), name: String(r.description), active: !!r.active } : null;
}
function sellerRef(db: SqlDriver, id: string | null) {
  if (!id) return null;
  const r = one(db, 'SELECT s.id, r.name, r.active FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=?', id);
  return r ? { id: String(r.id), name: String(r.name), active: !!r.active } : null;
}
function requireContact(db: SqlDriver, id: string) {
  const r = one(db, `SELECT active FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, id);
  if (!r) raise("P0002", "erp_contract_contact_not_found");
  if (!r.active) raise("22023", "erp_contract_contact_inactive");
}
function requireCategory(db: SqlDriver, id: string | null) {
  if (!id) return;
  const r = one(db, 'SELECT kind, active, deleted_at FROM "erp_finance__category" WHERE id=?', id);
  if (!r) raise("P0002", "erp_contract_category_not_found");
  if (r.kind !== "receivable" || !r.active || r.deleted_at !== null) raise("22023", "erp_contract_category_invalid");
}
function requirePayment(db: SqlDriver, id: string | null) {
  if (!id) return;
  const r = one(db, 'SELECT active, deleted_at, applicable FROM "erp_catalog__payment_method" WHERE id=?', id);
  if (!r) raise("P0002", "erp_contract_payment_not_found");
  if (!r.active || r.deleted_at !== null || !["ambos", "recebimentos"].includes(String(r.applicable))) raise("22023", "erp_contract_payment_invalid");
}
function requireSeller(db: SqlDriver, id: string | null) {
  if (!id) return;
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=? AND r.active=1', id))
    raise("P0002", "erp_contract_seller_not_found");
}
/** A NFS-e está configurada: a parte Fiscal ligada e o serviço da nota de serviço preenchido. */
function nfseConfigured(ctx: RpcContext): boolean {
  if (!ctx.parts.fiscal) return false;
  try {
    return !!one(ctx.db, 'SELECT 1 x FROM "erp_fiscal_vault__service_settings" WHERE id=1 AND national_code IS NOT NULL');
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Contrato e linhas

function contractRow(db: SqlDriver, id: string): Row {
  return one(db, 'SELECT * FROM "erp_contract__contract" WHERE id=?', id) ?? raise("P0002", "erp_contract_not_found");
}
function requireVersion(c: Row, expected: number) {
  if (Number(c.version) !== expected) raise("40001", "erp_contract_version_conflict");
}
const label = (c: Row) => `Contrato ${c.number}`;
interface Line { id: string; position: number; product_id: string | null; description: string; quantity: bigint; unit_cents: number; valid_from: string; valid_until: string | null }
function linesOf(db: SqlDriver, contract: string): Line[] {
  return db.exec('SELECT * FROM "erp_contract__item" WHERE contract_id=? ORDER BY valid_from, position', contract).rows.map((r) => ({
    id: String(r.id), position: Number(r.position), product_id: (r.product_id as string | null) ?? null, description: String(r.description),
    quantity: parseQuantity(String(r.quantity)) ?? 0n, unit_cents: Number(r.unit_cents), valid_from: String(r.valid_from), valid_until: (r.valid_until as string | null) ?? null,
  }));
}
const validAt = (lines: Line[], day: string) => lines.filter((l) => l.valid_from <= day && (l.valid_until === null || l.valid_until >= day));
const totalOf = (lines: Line[]) => lines.reduce((sum, l) => sum + lineTotal(l.quantity, l.unit_cents), 0);
const lineView = (l: Line) => ({
  id: l.id, position: l.position, product_id: l.product_id, description: l.description, quantity: qtyText(l.quantity),
  unit_cents: l.unit_cents, unit_price: moneyText(l.unit_cents), total_cents: lineTotal(l.quantity, l.unit_cents), total: moneyText(lineTotal(l.quantity, l.unit_cents)),
  valid_from: l.valid_from, valid_until: l.valid_until,
});
interface LineInput { product_id: string | null; description: string; quantity: bigint; unit_cents: number }
/** Itens enviados: serviço do catálogo (o nome vem dele, se faltar a descrição) ou só a descrição. */
function itemsOf(db: SqlDriver, value: unknown): LineInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) raise("22023", "erp_contract_invalid_items");
  return value.map((raw) => {
    const i = obj(raw);
    onlyKeys(i, ["product_id", "description", "quantity", "unit_price"]);
    const product = uuidOf(i.product_id, true);
    let description = textOf(i.description, 400, true, "erp_contract_invalid_items");
    if (product) {
      const p = one(db, `SELECT r.name, r.active FROM "erp_catalog__record" r WHERE r.id=? AND r.entity='products'`, product);
      if (!p) raise("P0002", "erp_contract_product_not_found");
      if (!p.active) raise("22023", "erp_contract_product_inactive");
      description = description ?? String(p.name);
    }
    if (!description) raise("22023", "erp_contract_invalid_items");
    const quantity = parseQuantity(i.quantity ?? "1");
    if (quantity === null || quantity <= 0n || quantity > MAX_QTY) raise("22023", "erp_contract_invalid_quantity");
    const unit = parseMoney(i.unit_price);
    if (unit === null) raise("22023", "erp_contract_invalid_price");
    return { product_id: product, description, quantity, unit_cents: unit };
  });
}
function insertLines(ctx: RpcContext, contract: string, lines: readonly LineInput[], from: string, event: string | null) {
  lines.forEach((l, index) => ctx.db.exec(
    'INSERT INTO "erp_contract__item"(id, contract_id, position, product_id, description, quantity, unit_cents, valid_from, valid_until, event_id) VALUES(?,?,?,?,?,?,?,?,NULL,?)',
    crypto.randomUUID(), contract, index + 1, l.product_id, l.description, qtyText(l.quantity), l.unit_cents, from, event));
}
/**
 * Troca as linhas a partir de uma data (aditivo ou reajuste): as válidas na
 * data fecham na véspera (as que começam na própria data saem), e as novas
 * começam na data. Mudança agendada depois da data recusa.
 */
function replaceLinesFrom(ctx: RpcContext, contract: string, effective: string, lines: readonly LineInput[], event: string) {
  const all = linesOf(ctx.db, contract);
  if (all.some((l) => l.valid_from > effective)) raise("40001", "erp_contract_future_change");
  for (const l of validAt(all, effective)) {
    if (l.valid_from === effective) ctx.db.exec('DELETE FROM "erp_contract__item" WHERE id=?', l.id);
    else ctx.db.exec('UPDATE "erp_contract__item" SET valid_until=? WHERE id=?', addDays(effective, -1), l.id);
  }
  insertLines(ctx, contract, lines, effective, event);
}
function event(ctx: RpcContext, contract: string, kind: string, summary: string, actor: string | null, data: Row = {}, effective: string | null = null): string {
  const id = crypto.randomUUID();
  ctx.db.exec('INSERT INTO "erp_contract__event"(id, contract_id, kind, effective_on, summary, data, actor, created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, contract, kind, effective, clipText(summary, 600), JSON.stringify(data), actor, ctx.clock.next().toString());
  return id;
}
function bump(ctx: RpcContext, c: Row, user: string | null, set: Row) {
  const cols = Object.keys(set);
  ctx.db.exec(`UPDATE "erp_contract__contract" SET ${cols.map((k) => `"${k}"=?, `).join("")}version=version+1, updated_at=?, updated_by=? WHERE id=?`,
    ...cols.map((k) => (typeof set[k] === "boolean" ? (set[k] ? 1 : 0) : set[k])), ctx.clock.next().toString(), user ?? String(c.updated_by), c.id);
}
function notice(ctx: RpcContext, contract: string, kind: string, reference: string, message: string) {
  ctx.db.exec(`INSERT INTO "erp_contract__notice"(id, contract_id, kind, reference, message, status, created_at) VALUES(?,?,?,?,?,'pending',?)
    ON CONFLICT(contract_id, kind, reference) DO NOTHING`, crypto.randomUUID(), contract, kind, reference, clipText(message, 1000), ctx.clock.next().toString());
}
function closeNotices(ctx: RpcContext, contract: string, kind: string, user: string | null, reference?: string) {
  ctx.db.exec(`UPDATE "erp_contract__notice" SET status='done', closed_at=?, closed_by=? WHERE contract_id=? AND kind=? AND status='pending' AND (? IS NULL OR reference=?)`,
    ctx.clock.next().toString(), user, contract, kind, reference ?? null, reference ?? null);
}

// ---------------------------------------------------------------------------
// Faturamento

/** Início do período que a cobrança passa a gerar (o que contém o dia, a partir do início da vigência). */
function periodFrom(c: Row, day: string): string {
  const anchor = String(c.starts_on), periodicity = c.periodicity as Periodicity;
  return periodStart(anchor, periodicity, periodIndex(anchor, periodicity, day < anchor ? anchor : day));
}
const nextPeriod = (c: Row, start: string) => {
  const anchor = String(c.starts_on), periodicity = c.periodicity as Periodicity;
  return periodStart(anchor, periodicity, periodIndex(anchor, periodicity, start) + 1);
};
/** A conta a receber de um período, se ainda não existe. Devolve a fatura criada (ou null: já existia, ou sem valor). */
function billPeriod(ctx: RpcContext, c: Row, start: string, origin: "alarm" | "manual", actor: string | null, day: string): Row | null {
  if (one(ctx.db, 'SELECT 1 x FROM "erp_contract__invoice" WHERE contract_id=? AND period_start=?', c.id, start)) return null;
  const anchor = String(c.starts_on), periodicity = c.periodicity as Periodicity;
  const end = periodEnd(anchor, periodicity, start);
  const lines = validAt(linesOf(ctx.db, String(c.id)), start);
  const amount = totalOf(lines);
  if (amount <= 0) {
    event(ctx, String(c.id), "invoice", `Período de ${monthLabel(start)} sem valor nos itens: nenhuma conta a receber foi gerada.`, actor, { period_start: start, skipped: true }, start);
    return null;
  }
  const due = dueDate(start, Number(c.due_day));
  const issued = day <= due ? day : due;
  const contact = contactRef(ctx.db, String(c.contact_id));
  const title = insertTitle(ctx, {
    group_id: crypto.randomUUID(), installment: 1, installments: 1, kind: "receivable", contact_id: c.contact_id, category_id: c.category_id ?? null,
    description: clipText(`${label(c)} · ${monthLabel(start)} · ${String(c.object).split("\n")[0]}`, 200), source_reference: label(c),
    issued_on: issued, due_on: due, amount_cents: amount, competence_on: start, original_due_on: due,
    payment_method_id: c.payment_method_id ?? null, seller_id: c.seller_id ?? null,
    history: clipText(`Faturamento do ${label(c)} (${PERIODICITY_LABELS[periodicity].toLowerCase()}), período de ${dateLabel(start)} a ${dateLabel(end)}${contact ? `, ${contact.name}` : ""}.`, 400),
  });
  const id = crypto.randomUUID();
  const charge = Number(c.billing_send) === 1 ? "pending" : "none";
  const nfse = Number(c.billing_nfse) === 1 ? (nfseConfigured(ctx) ? "pending" : "not_configured") : "none";
  ctx.db.exec(`INSERT INTO "erp_contract__invoice"(id, contract_id, period_start, period_end, due_on, amount_cents, title_id, origin, charge_status, nfse_status, items, created_at, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, c.id, start, end, due, amount, title, origin, charge, nfse, JSON.stringify(lines.map(lineView)), ctx.clock.next().toString(), actor);
  event(ctx, String(c.id), "invoice", `Conta a receber de ${monthLabel(start)} gerada: ${money(amount)}, vence em ${dateLabel(due)}.${nfse === "not_configured" ? " A nota de serviço não está configurada: só a conta." : ""}`,
    actor, { invoice_id: id, title_id: title, period_start: start, amount_cents: amount, origin }, start);
  return { id, title_id: title, period_start: start, due_on: due, amount_cents: amount };
}
/**
 * Fatura os períodos vencidos de um contrato ativo com a cobrança ligada (até
 * CATCH_UP_PERIODS por vez), avançando o próximo período. O período cujo
 * começo ainda não chegou espera. Depois do fim da vigência, para.
 */
export function billDue(ctx: RpcContext, contractId: string, day: string, origin: "alarm" | "manual", actor: string | null): Row[] {
  const created: Row[] = [];
  for (let n = 0; n < CATCH_UP_PERIODS; n++) {
    const c = contractRow(ctx.db, contractId);
    const start = c.next_period_on as string | null;
    if (c.status !== "active" || Number(c.billing_enabled) !== 1 || !start || start > day) break;
    if (c.ends_on && start > String(c.ends_on)) break;
    const invoice = billPeriod(ctx, c, start, origin, actor, day);
    if (invoice) created.push(invoice);
    ctx.db.exec('UPDATE "erp_contract__contract" SET next_period_on=? WHERE id=?', nextPeriod(c, start), c.id);
  }
  return created;
}

/** Avisos da rotina: renovação perto do fim e mês de reajuste chegando. */
function dailyNotices(ctx: RpcContext, c: Row, day: string) {
  const id = String(c.id);
  if (c.ends_on && ["active", "suspended"].includes(String(c.status))) {
    const ends = String(c.ends_on), lead = Number(c.renewal_notice_days);
    if (addDays(ends, -lead) <= day && c.renewal_noticed_for !== ends) {
      const contact = contactRef(ctx.db, String(c.contact_id));
      const message = ends < day
        ? `${label(c)} (${contact?.name ?? "cliente"}) terminou em ${dateLabel(ends)} e não foi renovado. Renove ou encerre o contrato.`
        : `${label(c)} (${contact?.name ?? "cliente"}) termina em ${dateLabel(ends)}. Converse com o cliente e renove, se for o caso.`;
      notice(ctx, id, "renewal", ends, message);
      ctx.db.exec('UPDATE "erp_contract__contract" SET renewal_noticed_for=? WHERE id=?', ends, id);
      event(ctx, id, "renewal_notice", `Aviso de renovação: o contrato termina em ${dateLabel(ends)}.`, null, { ends_on: ends });
    }
  }
  if (c.adjustment_index && c.status === "active") {
    const ref = nextAdjustmentMonth(String(c.starts_on), Number(c.adjustment_month), (c.last_adjustment_month as string | null) ?? null);
    if (`${ref}-01` <= day && !one(ctx.db, `SELECT 1 x FROM "erp_contract__notice" WHERE contract_id=? AND kind='adjustment_due' AND reference=?`, id, ref)) {
      const index = c.adjustment_index as AdjustmentIndex;
      const rate = index === "fixed" ? null : one(ctx.db, 'SELECT percent FROM "erp_contract__index_rate" WHERE index_code=? AND month=?', index, ref);
      const message = index === "fixed"
        ? `${label(c)}: chegou o mês de reajuste (${monthLabel(`${ref}-01`)}), ${percentLabel(String(c.adjustment_percent))} fixo. Confira a prévia e aplique.`
        : rate ? `${label(c)}: chegou o mês de reajuste (${monthLabel(`${ref}-01`)}). O ${INDEX_LABELS[index]} já está na tabela (${percentLabel(String(rate.percent))}): confira a prévia e aplique.`
          : `${label(c)}: chegou o mês de reajuste (${monthLabel(`${ref}-01`)}). Informe o ${INDEX_LABELS[index]} de ${monthLabel(`${ref}-01`)} na tabela de índices e aplique o reajuste.`;
      notice(ctx, id, "adjustment_due", ref, message);
      event(ctx, id, "adjustment_notice", `Mês de reajuste: ${monthLabel(`${ref}-01`)} (${INDEX_LABELS[index]}).`, null, { reference: ref });
    }
  }
}
const percentLabel = (p: string) => `${(parsePercent(p) !== null ? pctText(parsePercent(p)!) : p).replace(/\.?0+$/, "").replace(".", ",")}%`;

/** Contratos com trabalho da rotina hoje: período a faturar, aviso de renovação ou de reajuste ainda não dado. */
function dailyPending(db: SqlDriver, day: string): string[] {
  return db.exec(`SELECT id, starts_on, adjustment_month, last_adjustment_month, status,
      (status='active' AND billing_enabled=1 AND next_period_on IS NOT NULL AND next_period_on<=? AND (ends_on IS NULL OR next_period_on<=ends_on)) billing,
      (ends_on IS NOT NULL AND renewal_noticed_for IS NOT ends_on AND date(ends_on, '-' || renewal_notice_days || ' days')<=?) renewal,
      adjustment_index
    FROM "erp_contract__contract" WHERE status IN ('active','suspended') ORDER BY number`, day, day).rows
    .filter((c) => {
      if (Number(c.billing) === 1 || Number(c.renewal) === 1) return true;
      if (!c.adjustment_index || c.status !== "active") return false;
      const ref = nextAdjustmentMonth(String(c.starts_on), Number(c.adjustment_month), (c.last_adjustment_month as string | null) ?? null);
      return `${ref}-01` <= day && !one(db, `SELECT 1 x FROM "erp_contract__notice" WHERE contract_id=? AND kind='adjustment_due' AND reference=?`, c.id, ref);
    })
    .map((c) => String(c.id));
}
/**
 * Uma unidade da rotina diária (scheduler/routines.ts): fatura e avisa até
 * DAILY_BATCH contratos com trabalho hoje. Devolve se sobrou trabalho. Sem
 * pessoa: as contas e o histórico ficam sem autor (o alarme). Rodar de novo
 * no mesmo dia não repete nada: o período faturado avança e o aviso dado fica
 * marcado.
 */
export function contractsDailyStep(ctx: RpcContext, day: string): boolean {
  const pending = dailyPending(ctx.db, day);
  for (const id of pending.slice(0, DAILY_BATCH)) {
    billDue(ctx, id, day, "alarm", null);
    dailyNotices(ctx, contractRow(ctx.db, id), day);
  }
  // Cada unidade avança (o período faturado anda, o aviso fica marcado): o que sobrar é de fato outra unidade.
  return pending.length > 0 && dailyPending(ctx.db, day).length > 0;
}

// ---------------------------------------------------------------------------
// Visões

function invoiceStatus(t: Row | undefined, day: string): { code: string; label: string } {
  if (!t) return { code: "missing", label: "Conta não encontrada" };
  if (Number(t.cancelled) === 1 || t.deleted_at) return { code: "cancelled", label: "Cancelada" };
  if (Number(t.settled_cents) >= Number(t.amount_cents)) return { code: "paid", label: "Paga" };
  if (String(t.due_on) < day) return { code: "overdue", label: "Vencida" };
  return { code: "open", label: Number(t.settled_cents) > 0 ? "Paga em parte" : "Em aberto" };
}
const CHARGE_LABELS: Record<string, string> = { none: "Sem envio", pending: "Cobrança a enviar", sent: "Cobrança enviada" };
const NFSE_LABELS: Record<string, string> = { none: "Sem nota", pending: "NFS-e a emitir", not_configured: "Nota de serviço não configurada (só a conta)", issued: "NFS-e emitida" };
function invoiceView(db: SqlDriver, i: Row, day: string) {
  const t = one(db, 'SELECT due_on, amount_cents, settled_cents, cancelled, deleted_at FROM "erp_finance__title" WHERE id=?', i.title_id) ?? undefined;
  const status = invoiceStatus(t, day);
  const c = one(db, 'SELECT number, contact_id FROM "erp_contract__contract" WHERE id=?', i.contract_id);
  return {
    id: i.id, contract_id: i.contract_id, contract_label: c ? `Contrato ${c.number}` : null, contact: c ? contactRef(db, String(c.contact_id)) : null,
    period_start: i.period_start, period_end: i.period_end, period_label: monthLabel(String(i.period_start)), due_on: t?.due_on ?? i.due_on,
    amount_cents: Number(i.amount_cents), amount: moneyText(Number(i.amount_cents)), settled_cents: t ? Number(t.settled_cents) : 0,
    title_id: i.title_id, status: status.code, status_label: status.label, origin: i.origin,
    charge_status: i.charge_status, charge_label: CHARGE_LABELS[String(i.charge_status)], charge_sent_at: i.charge_sent_at ? jsonTimestamp(i.charge_sent_at as number) : null,
    nfse_status: i.nfse_status, nfse_label: NFSE_LABELS[String(i.nfse_status)], items: JSON.parse(String(i.items)),
    created_at: jsonTimestamp(i.created_at as number),
  };
}
function contractView(ctx: RpcContext, id: string, user: string) {
  const db = ctx.db, c = contractRow(db, id), day = today(ctx);
  const lines = linesOf(db, id);
  const ref = day < String(c.starts_on) ? String(c.starts_on) : day;
  const current = validAt(lines, ref), scheduled = lines.filter((l) => l.valid_from > ref);
  const periodicity = c.periodicity as Periodicity, index = (c.adjustment_index as AdjustmentIndex | null) ?? null;
  const next = c.next_period_on as string | null;
  const adjustmentRef = index ? nextAdjustmentMonth(String(c.starts_on), Number(c.adjustment_month), (c.last_adjustment_month as string | null) ?? null) : null;
  const bling = one(db, 'SELECT source_id FROM "erp_contract__bling_link" WHERE contract_id=?', id);
  return {
    id, number: Number(c.number), label: label(c), contact: contactRef(db, String(c.contact_id)), object: c.object,
    starts_on: c.starts_on, ends_on: c.ends_on ?? null, indefinite: c.ends_on === null, term_months: c.term_months ?? null,
    periodicity, periodicity_label: PERIODICITY_LABELS[periodicity], due_day: Number(c.due_day),
    payment_method: paymentRef(db, (c.payment_method_id as string | null) ?? null), category: categoryRef(db, (c.category_id as string | null) ?? null),
    seller: sellerRef(db, (c.seller_id as string | null) ?? null),
    status: c.status, status_label: STATUS_LABELS[c.status as ContractStatus],
    billing: {
      enabled: Number(c.billing_enabled) === 1, send_whatsapp: Number(c.billing_send) === 1, emit_nfse: Number(c.billing_nfse) === 1, nfse_configured: nfseConfigured(ctx),
      next_period_on: next, next_due_on: next ? dueDate(next, Number(c.due_day)) : null,
      next_amount_cents: next ? totalOf(validAt(lines, next)) : null,
      after_end: !!(next && c.ends_on && next > String(c.ends_on)),
    },
    adjustment: index ? {
      index, index_label: INDEX_LABELS[index], percent: (c.adjustment_percent as string | null) ?? null, month: Number(c.adjustment_month),
      notify: Number(c.adjustment_notify) === 1, last_month: c.last_adjustment_month ?? null, next_month: adjustmentRef,
    } : null,
    renewal_notice_days: Number(c.renewal_notice_days), ended_on: c.ended_on ?? null, end_reason: c.end_reason ?? null, notes: c.notes ?? null, origin: c.origin,
    items: current.map(lineView), amount_cents: totalOf(current), amount: moneyText(totalOf(current)),
    scheduled_items: scheduled.map(lineView),
    history_items: lines.filter((l) => l.valid_until !== null && l.valid_until < ref).map(lineView),
    invoices: db.exec('SELECT * FROM "erp_contract__invoice" WHERE contract_id=? ORDER BY period_start DESC LIMIT 36', id).rows.map((i) => invoiceView(db, i, day)),
    events: db.exec('SELECT * FROM "erp_contract__event" WHERE contract_id=? ORDER BY created_at DESC LIMIT 100', id).rows.map((e) => ({
      id: e.id, kind: e.kind, summary: e.summary, effective_on: e.effective_on ?? null, data: JSON.parse(String(e.data)),
      actor: e.actor ?? null, by_alarm: e.actor === null, created_at: jsonTimestamp(e.created_at as number),
    })),
    attachments: db.exec('SELECT id, filename, size_bytes, created_at FROM "erp_contract__attachment" WHERE contract_id=? AND deleted_at IS NULL ORDER BY created_at', id).rows.map((f) => ({
      id: f.id, filename: f.filename, size_bytes: Number(f.size_bytes), created_at: jsonTimestamp(f.created_at as number),
    })),
    notices: db.exec(`SELECT id, kind, reference, message, created_at FROM "erp_contract__notice" WHERE contract_id=? AND status='pending' ORDER BY created_at`, id).rows.map(noticeView),
    bling_source_id: (bling?.source_id as string | undefined) ?? null,
    can_write: canWrite(db, user), version: Number(c.version),
    created_at: jsonTimestamp(c.created_at as number), updated_at: jsonTimestamp(c.updated_at as number),
  };
}
const NOTICE_LABELS: Record<string, string> = { renewal: "Renovação", adjustment_due: "Reajuste", customer_adjustment: "Avisar o cliente do reajuste" };
const noticeView = (n: Row) => ({ id: n.id, kind: n.kind, kind_label: NOTICE_LABELS[String(n.kind)], reference: n.reference, message: n.message, created_at: jsonTimestamp(n.created_at as number) });

// ---------------------------------------------------------------------------
// RPCs de leitura

/** Opções da tela: categorias de receita, formas de recebimento, vendedores e a busca de cliente ou serviço. */
function erpContractOptions(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["search", "kind"]);
  const db = ctx.db;
  if (p.search !== undefined) {
    const q = textOf(p.search, 120, false)!;
    const like = `%${fold(q)}%`;
    const kind = p.kind === "services" ? "services" : p.kind === "contacts" ? "contacts" : raise("22023", "erp_contract_invalid");
    const rows = kind === "contacts"
      ? db.exec(`SELECT r.id, r.name, r.code, c.document FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__contact" c ON c.record_id=r.id
          WHERE r.entity='contacts' AND r.active=1 ORDER BY r.name LIMIT 2000`).rows
      : db.exec(`SELECT r.id, r.name, r.code, p.price, p.kind FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
          WHERE r.entity='products' AND r.active=1 ORDER BY CASE WHEN p.kind='S' THEN 0 ELSE 1 END, r.name LIMIT 2000`).rows;
    const hits = rows.filter((r) => fold(`${r.name} ${r.code ?? ""} ${r.document ?? ""}`).includes(like.slice(1, -1))).slice(0, 20);
    return { items: hits.map((r) => kind === "contacts" ? { id: r.id, name: r.name, document: r.document ?? null }
      : { id: r.id, name: r.name, code: r.code ?? null, price: r.price ?? null, service: r.kind === "S" }) };
  }
  return {
    categories: db.exec(`SELECT id, name FROM "erp_finance__category" WHERE kind='receivable' AND active=1 AND deleted_at IS NULL ORDER BY name`).rows,
    payment_methods: db.exec(`SELECT id, description name FROM "erp_catalog__payment_method" WHERE active=1 AND deleted_at IS NULL AND applicable IN ('ambos','recebimentos') ORDER BY description`).rows,
    sellers: db.exec(`SELECT s.id, r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE r.active=1 ORDER BY r.name`).rows,
    periodicities: PERIODICITIES.map((id) => ({ id, label: PERIODICITY_LABELS[id] })),
    indices: INDICES.map((id) => ({ id, label: INDEX_LABELS[id] })),
    nfse_configured: nfseConfigured(ctx), fiscal_on: ctx.parts.fiscal,
    can_write: canWrite(db, user), can_bill: canWrite(db, user) && permitted(db, user, "financas.contas_receber.ie"),
    today: today(ctx),
  };
}

const STATUS_FILTER: Record<string, string[]> = { open: ["draft", "active", "suspended"], all: ["draft", "active", "suspended", "ended"], draft: ["draft"], active: ["active"], suspended: ["suspended"], ended: ["ended"] };
function erpContractList(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["status", "q", "contact_id", "page", "ending_within"]);
  const status = p.status === undefined ? "open" : typeof p.status === "string" && Object.hasOwn(STATUS_FILTER, p.status) ? p.status : raise("22023", "erp_contract_invalid_query");
  const page = p.page === undefined ? 1 : intOf(p.page, 1, 99999, "erp_contract_invalid_query");
  const contact = uuidOf(p.contact_id, true);
  const q = p.q === undefined ? null : textOf(p.q, 120);
  const ending = p.ending_within === undefined ? null : intOf(p.ending_within, 0, 3650, "erp_contract_invalid_query");
  const day = today(ctx);
  const rows = ctx.db.exec(`SELECT c.*, r.name contact_name FROM "erp_contract__contract" c JOIN "erp_catalog__record" r ON r.id=c.contact_id
    WHERE c.status IN (SELECT value FROM json_each(?)) AND (? IS NULL OR c.contact_id=?) ORDER BY c.number DESC`,
    JSON.stringify(STATUS_FILTER[status]), contact, contact).rows
    .filter((c) => !q || fold(`${c.number} ${c.contact_name} ${c.object}`).includes(fold(q)))
    .filter((c) => ending === null || (c.ends_on !== null && String(c.ends_on) <= addDays(day, ending)));
  const perPage = 50;
  const counts = Object.fromEntries(["draft", "active", "suspended", "ended"].map((s) => [s,
    Number(one(ctx.db, 'SELECT count(*) n FROM "erp_contract__contract" WHERE status=?', s)!.n)]));
  return {
    items: rows.slice((page - 1) * perPage, page * perPage).map((c) => {
      const lines = linesOf(ctx.db, String(c.id));
      const ref = day < String(c.starts_on) ? String(c.starts_on) : day;
      return {
        id: c.id, number: Number(c.number), label: label(c), contact: { id: c.contact_id, name: c.contact_name }, object: clipText(String(c.object), 160),
        starts_on: c.starts_on, ends_on: c.ends_on ?? null, periodicity: c.periodicity, periodicity_label: PERIODICITY_LABELS[c.periodicity as Periodicity],
        due_day: Number(c.due_day), amount_cents: totalOf(validAt(lines, ref)), status: c.status, status_label: STATUS_LABELS[c.status as ContractStatus],
        billing_enabled: Number(c.billing_enabled) === 1, next_period_on: c.next_period_on ?? null, version: Number(c.version),
      };
    }),
    total: rows.length, page, per_page: perPage, counts,
    notices: Number(one(ctx.db, `SELECT count(*) n FROM "erp_contract__notice" WHERE status='pending'`)!.n),
    pending_charges: Number(one(ctx.db, `SELECT count(*) n FROM "erp_contract__invoice" WHERE charge_status='pending'`)!.n),
    can_write: canWrite(ctx.db, user),
  };
}
function erpContractGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["id"]);
  return { contract: contractView(ctx, uuidOf(p.id)!, user) };
}
const INVOICE_FILTER = ["all", "open", "overdue", "paid", "cancelled", "charge_pending", "nfse_pending"];
function erpContractInvoices(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["contract_id", "status", "from", "to", "page"]);
  const contract = uuidOf(p.contract_id, true);
  const status = p.status === undefined ? "all" : typeof p.status === "string" && INVOICE_FILTER.includes(p.status) ? p.status : raise("22023", "erp_contract_invalid_query");
  const from = dateOf(p.from), to = dateOf(p.to);
  if (from && to && from > to) raise("22023", "erp_contract_invalid_query");
  const page = p.page === undefined ? 1 : intOf(p.page, 1, 99999, "erp_contract_invalid_query");
  const day = today(ctx);
  const items = ctx.db.exec(`SELECT * FROM "erp_contract__invoice" WHERE (? IS NULL OR contract_id=?) AND (? IS NULL OR due_on>=?) AND (? IS NULL OR due_on<=?)
    ORDER BY due_on DESC, created_at DESC`, contract, contract, from, from, to, to).rows.map((i) => invoiceView(ctx.db, i, day))
    .filter((i) => status === "all" || (status === "charge_pending" ? i.charge_status === "pending" : status === "nfse_pending" ? i.nfse_status === "pending"
      : status === "open" ? ["open", "overdue"].includes(i.status) : i.status === status));
  const perPage = 50;
  return { items: items.slice((page - 1) * perPage, page * perPage), total: items.length, page, per_page: perPage };
}
function erpContractRates(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["index"]);
  const index = p.index === undefined ? null : TABLE_INDICES.includes(p.index as AdjustmentIndex) ? String(p.index) : raise("22023", "erp_contract_invalid_index");
  return {
    items: ctx.db.exec(`SELECT index_code, month, percent, updated_at FROM "erp_contract__index_rate" WHERE (? IS NULL OR index_code=?) ORDER BY month DESC, index_code LIMIT 600`, index, index).rows
      .map((r) => ({ index: r.index_code, index_label: INDEX_LABELS[r.index_code as AdjustmentIndex], month: r.month, percent: r.percent, updated_at: jsonTimestamp(r.updated_at as number) })),
    indices: TABLE_INDICES.map((id) => ({ id, label: INDEX_LABELS[id] })), can_write: canWrite(ctx.db, user),
  };
}
function erpContractNotices(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["status"]);
  const status = p.status === undefined || p.status === "pending" ? "pending" : p.status === "all" ? "all" : raise("22023", "erp_contract_invalid_query");
  return {
    items: ctx.db.exec(`SELECT n.*, c.number FROM "erp_contract__notice" n JOIN "erp_contract__contract" c ON c.id=n.contract_id
      WHERE (?='all' OR n.status='pending') ORDER BY n.created_at DESC LIMIT 200`, status).rows
      .map((n) => ({ ...noticeView(n), contract_id: n.contract_id, contract_label: `Contrato ${n.number}`, status: n.status })),
  };
}

/** Prévia do próximo reajuste: o mês, o percentual (do índice informado ou o fixo) e as linhas antes e depois. */
function adjustmentPreview(ctx: RpcContext, c: Row, month?: string, effective?: string | null) {
  const index = (c.adjustment_index as AdjustmentIndex | null) ?? raise("22023", "erp_contract_adjustment_missing");
  const ref = nextAdjustmentMonth(String(c.starts_on), Number(c.adjustment_month), (c.last_adjustment_month as string | null) ?? null);
  if (month !== undefined && month !== ref) raise("40001", "erp_contract_adjustment_month_changed");
  const rate = index === "fixed" ? String(c.adjustment_percent) : (one(ctx.db, 'SELECT percent FROM "erp_contract__index_rate" WHERE index_code=? AND month=?', index, ref)?.percent as string | undefined) ?? null;
  const on = effective ?? `${ref}-01`;
  if (on < String(c.starts_on)) raise("22023", "erp_contract_invalid_date");
  const lines = validAt(linesOf(ctx.db, String(c.id)), on);
  const percent = rate === null ? null : parsePercent(rate)!;
  const after = percent === null ? [] : lines.map((l) => ({ ...l, unit_cents: adjusted(l.unit_cents, percent) }));
  return {
    contract_id: c.id, label: label(c), index, index_label: INDEX_LABELS[index], month: ref, month_label: monthLabel(`${ref}-01`), effective_on: on,
    percent: rate, missing_rate: rate === null, before: lines.map(lineView), after: after.map(lineView),
    before_cents: totalOf(lines), after_cents: percent === null ? null : totalOf(after),
    invoices_after: Number(one(ctx.db, 'SELECT count(*) n FROM "erp_contract__invoice" WHERE contract_id=? AND period_start>=?', c.id, on)!.n),
    future_change: linesOf(ctx.db, String(c.id)).some((l) => l.valid_from > on),
    notify: Number(c.adjustment_notify) === 1, too_early: `${ref}-01` > today(ctx),
    lines_after: after,
  };
}
function erpContractAdjustPreview(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["id", "effective_on"]);
  const { lines_after: _, ...preview } = adjustmentPreview(ctx, contractRow(ctx.db, uuidOf(p.id)!), undefined, dateOf(p.effective_on));
  return preview;
}
function erpContractAttachmentGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["id"]);
  const f = one(ctx.db, 'SELECT * FROM "erp_contract__attachment" WHERE id=? AND deleted_at IS NULL', uuidOf(p.id)) ?? raise("P0002", "erp_contract_attachment_not_found");
  return { id: f.id, contract_id: f.contract_id, filename: f.filename, size_bytes: Number(f.size_bytes), sha256: f.sha256, storage_key: f.storage_key };
}

// ---------------------------------------------------------------------------
// RPCs de gravação

const CONTRACT_FIELDS = ["id", "expected_version", "contact_id", "object", "starts_on", "ends_on", "term_months", "periodicity", "due_day", "payment_method_id",
  "category_id", "seller_id", "items", "adjustment", "renewal_notice_days", "notes"] as const;
/** Campos que definem os períodos e o valor: depois de ativar, só mudam por aditivo ou renovação. */
const LOCKED_AFTER_DRAFT = ["contact_id", "starts_on", "ends_on", "periodicity", "items"];
function adjustmentOf(value: unknown): Row {
  if (value === null) return { adjustment_index: null, adjustment_percent: null, adjustment_month: null, adjustment_notify: 0 };
  const v = obj(value);
  onlyKeys(v, ["index", "percent", "month", "notify"]);
  const index = typeof v.index === "string" && (INDICES as readonly string[]).includes(v.index) ? v.index : raise("22023", "erp_contract_invalid_index");
  const month = intOf(v.month, 1, 12, "erp_contract_invalid_adjustment");
  let percent: string | null = null;
  if (index === "fixed") {
    const p = parsePercent(v.percent);
    if (p === null || p <= 0n || p > 1000000n) raise("22023", "erp_contract_invalid_percent");
    percent = pctText(p);
  } else if (v.percent !== undefined && v.percent !== null) raise("22023", "erp_contract_invalid_adjustment");
  return { adjustment_index: index, adjustment_percent: percent, adjustment_month: month, adjustment_notify: v.notify === undefined ? 0 : boolOf(v.notify) ? 1 : 0 };
}
function erpContractSave(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "save", (user, d) => {
    onlyKeys(d, CONTRACT_FIELDS);
    const db = ctx.db, now = ctx.clock.next().toString();
    const set: Row = {};
    if (has(d, "contact_id")) { set.contact_id = uuidOf(d.contact_id)!; requireContact(db, set.contact_id as string); }
    if (has(d, "object")) set.object = textOf(d.object, 4000, false, "erp_contract_object_required");
    if (has(d, "starts_on")) set.starts_on = dateOf(d.starts_on, false);
    if (has(d, "ends_on")) set.ends_on = dateOf(d.ends_on);
    if (has(d, "term_months")) set.term_months = d.term_months === null ? null : intOf(d.term_months, 1, 600, "erp_contract_invalid_term");
    if (has(d, "periodicity")) set.periodicity = typeof d.periodicity === "string" && (PERIODICITIES as readonly string[]).includes(d.periodicity) ? d.periodicity : raise("22023", "erp_contract_invalid_periodicity");
    if (has(d, "due_day")) set.due_day = intOf(d.due_day, 1, 31, "erp_contract_invalid_due_day");
    if (has(d, "payment_method_id")) { set.payment_method_id = uuidOf(d.payment_method_id, true); requirePayment(db, set.payment_method_id as string | null); }
    if (has(d, "category_id")) { set.category_id = uuidOf(d.category_id, true); requireCategory(db, set.category_id as string | null); }
    if (has(d, "seller_id")) { set.seller_id = uuidOf(d.seller_id, true); requireSeller(db, set.seller_id as string | null); }
    if (has(d, "adjustment")) Object.assign(set, adjustmentOf(d.adjustment));
    if (has(d, "renewal_notice_days")) set.renewal_notice_days = intOf(d.renewal_notice_days, 0, 365, "erp_contract_invalid_notice_days");
    if (has(d, "notes")) set.notes = textOf(d.notes, 4000);
    const items = has(d, "items") ? itemsOf(db, d.items) : null;

    if (!has(d, "id")) {
      for (const k of ["contact_id", "object", "starts_on", "periodicity", "due_day"]) if (set[k] === undefined || set[k] === null) raise("22023", `erp_contract_${k}_required`);
      if (!items) raise("22023", "erp_contract_invalid_items");
      if (set.ends_on && String(set.ends_on) < String(set.starts_on)) raise("22023", "erp_contract_invalid_period");
      const id = crypto.randomUUID();
      const number = Number(one(db, 'SELECT coalesce(max(number),0)+1 n FROM "erp_contract__contract"')!.n);
      const row: Row = { renewal_notice_days: 30, adjustment_notify: 0, ...set };
      const cols = Object.keys(row);
      db.exec(`INSERT INTO "erp_contract__contract"(id, number, ${cols.map((k) => `"${k}"`).join(", ")}, status, billing_enabled, origin, version, created_at, created_by, updated_at, updated_by)
        VALUES(?, ?, ${cols.map(() => "?").join(", ")}, 'draft', 0, 'manual', 1, ?, ?, ?, ?)`, id, number, ...cols.map((k) => row[k]), now, user, now, user);
      const created = contractRow(db, id);
      insertLines(ctx, id, items, String(created.starts_on), null);
      event(ctx, id, "created", `${label(created)} criado como rascunho, ${money(totalOf(validAt(linesOf(db, id), String(created.starts_on))))} por período (${PERIODICITY_LABELS[created.periodicity as Periodicity].toLowerCase()}).`, user);
      return { contract: contractView(ctx, id, user) };
    }
    const id = uuidOf(d.id)!;
    const c = contractRow(db, id);
    requireVersion(c, versionOf(d.expected_version));
    if (c.status === "ended") raise("40001", "erp_contract_not_editable");
    if (c.status !== "draft") {
      for (const k of LOCKED_AFTER_DRAFT) {
        if (k === "items" ? items !== null : set[k] !== undefined && set[k] !== c[k]) raise("40001", "erp_contract_locked_field");
      }
    }
    const merged = { ...c, ...set };
    if (merged.ends_on && String(merged.ends_on) < String(merged.starts_on)) raise("22023", "erp_contract_invalid_period");
    const changed = Object.keys(set).filter((k) => set[k] !== c[k]);
    if (!changed.length && !items) return { contract: contractView(ctx, id, user) };
    if (changed.includes("starts_on") || changed.includes("periodicity")) set.next_period_on = null;
    bump(ctx, c, user, set);
    if (items) {
      db.exec('DELETE FROM "erp_contract__item" WHERE contract_id=?', id);
      insertLines(ctx, id, items, String(merged.starts_on), null);
    }
    event(ctx, id, "edited", `Dados do contrato alterados${items ? " (itens)" : ""}.`, user, { fields: changed });
    return { contract: contractView(ctx, id, user) };
  });
}

function erpContractStatus(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "status", (user, d) => {
    onlyKeys(d, ["id", "expected_version", "action", "reason", "ended_on"]);
    const c = contractRow(ctx.db, uuidOf(d.id)!);
    requireVersion(c, versionOf(d.expected_version));
    const action = typeof d.action === "string" && Object.hasOwn(STATUS_ACTIONS, d.action) ? d.action : raise("22023", "erp_contract_invalid");
    const rule = STATUS_ACTIONS[action];
    if (!rule.from.includes(c.status as ContractStatus)) raise("40001", "erp_contract_status_invalid");
    const id = String(c.id), day = today(ctx);
    const set: Row = { status: rule.to };
    let summary = "";
    if (action === "activate") {
      const lines = validAt(linesOf(ctx.db, id), String(c.starts_on));
      if (totalOf(lines) <= 0) raise("22023", "erp_contract_no_value");
      summary = `Contrato ativado. A cobrança ${Number(c.billing_enabled) === 1 ? "está ligada" : "continua desligada até você ligar"}.`;
    } else if (action === "suspend") {
      const reason = textOf(d.reason, 400);
      summary = `Contrato suspenso${reason ? `: ${reason}` : ""}. Nenhuma conta é gerada enquanto estiver suspenso.`;
    } else if (action === "resume") {
      summary = "Contrato reativado.";
      // Os períodos da suspensão não são cobrados: a cobrança volta no período de hoje.
      if (Number(c.billing_enabled) === 1 && c.next_period_on && String(c.next_period_on) < day) set.next_period_on = firstUnbilled(ctx, c, periodFrom(c, day));
    } else {
      const reason = textOf(d.reason, 400, false, "erp_contract_reason_required")!;
      if (pgLength(reason) < 3) raise("22023", "erp_contract_reason_required");
      const ended = dateOf(d.ended_on) ?? day;
      Object.assign(set, { end_reason: reason, ended_on: ended });
      summary = `Contrato encerrado em ${dateLabel(ended)}: ${reason}. As contas já geradas continuam no Financeiro.`;
      closeNotices(ctx, id, "renewal", user);
      closeNotices(ctx, id, "adjustment_due", user);
    }
    bump(ctx, c, user, set);
    event(ctx, id, action === "activate" ? "activated" : action === "suspend" ? "suspended" : action === "resume" ? "resumed" : "ended", summary, user,
      action === "suspend" && d.reason ? { reason: d.reason } : {});
    return { contract: contractView(ctx, id, user) };
  });
}
/** O primeiro período a partir de `start` que ainda não tem fatura. */
function firstUnbilled(ctx: RpcContext, c: Row, start: string): string {
  let p = start;
  for (let n = 0; n < 600 && one(ctx.db, 'SELECT 1 x FROM "erp_contract__invoice" WHERE contract_id=? AND period_start=?', c.id, p); n++) p = nextPeriod(c, p);
  return p;
}
function erpContractBilling(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "billing", (user, d) => {
    onlyKeys(d, ["id", "expected_version", "enabled", "send_whatsapp", "emit_nfse", "from"]);
    const c = contractRow(ctx.db, uuidOf(d.id)!);
    requireVersion(c, versionOf(d.expected_version));
    if (c.status === "ended") raise("40001", "erp_contract_not_editable");
    const enabled = boolOf(d.enabled);
    // Ligar autoriza contas a receber geradas sozinhas: pede a permissão de incluir contas a receber.
    if (enabled && !permitted(ctx.db, user, "financas.contas_receber.ie")) raise("42501", "erp_contract_bill_denied");
    const set: Row = { billing_enabled: enabled ? 1 : 0 };
    if (d.send_whatsapp !== undefined) set.billing_send = boolOf(d.send_whatsapp) ? 1 : 0;
    if (d.emit_nfse !== undefined) set.billing_nfse = boolOf(d.emit_nfse) ? 1 : 0;
    const day = today(ctx);
    if (enabled) {
      const from = dateOf(d.from);
      if (from) {
        if (from < String(c.starts_on) || periodFrom(c, from) !== from) raise("22023", "erp_contract_invalid_billing_start");
        if (c.ends_on && from > String(c.ends_on)) raise("22023", "erp_contract_invalid_billing_start");
        set.next_period_on = firstUnbilled(ctx, c, from);
      } else if (Number(c.billing_enabled) !== 1 || !c.next_period_on) set.next_period_on = firstUnbilled(ctx, c, periodFrom(c, day));
    } else if (d.from !== undefined && d.from !== null) raise("22023", "erp_contract_invalid");
    bump(ctx, c, user, set);
    const after = contractRow(ctx.db, String(c.id));
    const options = [Number(after.billing_send) === 1 ? "com a cobrança pelo WhatsApp" : null, Number(after.billing_nfse) === 1 ? "com a NFS-e" : null].filter(Boolean).join(" e ");
    event(ctx, String(c.id), "billing", enabled
      ? `Cobrança recorrente ligada${options ? ` ${options}` : ""}, a partir do período de ${monthLabel(String(after.next_period_on))}.`
      : "Cobrança recorrente desligada: nenhuma conta nova é gerada.", user, { enabled, send_whatsapp: Number(after.billing_send) === 1, emit_nfse: Number(after.billing_nfse) === 1, from: after.next_period_on });
    // Período que já começou: a conta sai agora, sem esperar o alarme.
    const created = enabled ? billDue(ctx, String(c.id), day, "manual", user) : [];
    return { contract: contractView(ctx, String(c.id), user), created };
  });
}
/** Gera agora a conta do próximo período (mesmo antes do começo dele), pela mão da pessoa. */
function erpContractBillNow(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "bill_now", (user, d) => {
    onlyKeys(d, ["id", "expected_version", "period_start"]);
    if (!permitted(ctx.db, user, "financas.contas_receber.ie")) raise("42501", "erp_contract_bill_denied");
    const c = contractRow(ctx.db, uuidOf(d.id)!);
    requireVersion(c, versionOf(d.expected_version));
    if (c.status !== "active") raise("40001", "erp_contract_not_active");
    const start = dateOf(d.period_start, false)!;
    if (periodFrom(c, start) !== start || start < String(c.starts_on) || (c.ends_on && start > String(c.ends_on))) raise("22023", "erp_contract_invalid_period_start");
    if (one(ctx.db, 'SELECT 1 x FROM "erp_contract__invoice" WHERE contract_id=? AND period_start=?', c.id, start)) raise("40001", "erp_contract_period_billed");
    const invoice = billPeriod(ctx, c, start, "manual", user, today(ctx));
    if (!invoice) raise("22023", "erp_contract_no_value");
    const set: Row = {};
    if (c.next_period_on && String(c.next_period_on) === start) set.next_period_on = firstUnbilled(ctx, c, start);
    bump(ctx, c, user, set);
    return { contract: contractView(ctx, String(c.id), user), invoice };
  });
}
function erpContractInvoiceMark(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "invoice_mark", (user, d) => {
    onlyKeys(d, ["id", "action"]);
    const i = one(ctx.db, 'SELECT * FROM "erp_contract__invoice" WHERE id=?', uuidOf(d.id)) ?? raise("P0002", "erp_contract_invoice_not_found");
    const at = ctx.clock.next().toString();
    if (d.action === "charge_sent") ctx.db.exec(`UPDATE "erp_contract__invoice" SET charge_status='sent', charge_sent_at=? WHERE id=?`, at, i.id);
    else if (d.action === "charge_pending") ctx.db.exec(`UPDATE "erp_contract__invoice" SET charge_status='pending', charge_sent_at=NULL WHERE id=?`, i.id);
    else if (d.action === "charge_none") ctx.db.exec(`UPDATE "erp_contract__invoice" SET charge_status='none', charge_sent_at=NULL WHERE id=?`, i.id);
    else if (d.action === "nfse_issued") {
      if (!["pending", "not_configured"].includes(String(i.nfse_status))) raise("40001", "erp_contract_invoice_state");
      ctx.db.exec(`UPDATE "erp_contract__invoice" SET nfse_status='issued' WHERE id=?`, i.id);
    } else raise("22023", "erp_contract_invalid");
    const text = { charge_sent: "Cobrança enviada ao cliente", charge_pending: "Cobrança marcada para enviar", charge_none: "Envio da cobrança dispensado", nfse_issued: "NFS-e marcada como emitida" }[String(d.action)];
    event(ctx, String(i.contract_id), "invoice", `${text} (${monthLabel(String(i.period_start))}).`, user, { invoice_id: i.id, action: d.action });
    return { invoice: invoiceView(ctx.db, one(ctx.db, 'SELECT * FROM "erp_contract__invoice" WHERE id=?', i.id)!, today(ctx)) };
  });
}
function erpContractRateSave(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "rate_save", (user, d) => {
    onlyKeys(d, ["index", "month", "percent"]);
    const index = TABLE_INDICES.includes(d.index as AdjustmentIndex) ? String(d.index) : raise("22023", "erp_contract_invalid_index");
    const month = monthOf(d.month);
    if (d.percent === null) {
      ctx.db.exec('DELETE FROM "erp_contract__index_rate" WHERE index_code=? AND month=?', index, month);
      return { index, month, percent: null };
    }
    const p = parsePercent(d.percent);
    if (p === null || p < -1000000n || p > 1000000n) raise("22023", "erp_contract_invalid_percent");
    ctx.db.exec(`INSERT INTO "erp_contract__index_rate"(index_code, month, percent, updated_at, updated_by) VALUES(?,?,?,?,?)
      ON CONFLICT(index_code, month) DO UPDATE SET percent=excluded.percent, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      index, month, pctText(p), ctx.clock.next().toString(), user);
    return { index, month, percent: pctText(p) };
  });
}
function erpContractAdjust(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "adjust", (user, d) => {
    onlyKeys(d, ["id", "expected_version", "month", "percent", "effective_on"]);
    const c = contractRow(ctx.db, uuidOf(d.id)!);
    requireVersion(c, versionOf(d.expected_version));
    if (!["active", "suspended"].includes(String(c.status))) raise("40001", "erp_contract_not_active");
    const preview = adjustmentPreview(ctx, c, monthOf(d.month), dateOf(d.effective_on));
    if (preview.missing_rate) raise("22023", "erp_contract_rate_missing");
    // A pessoa confirma o percentual que viu na prévia: mudou na tabela, recusa.
    if (parsePercent(d.percent) === null || pctText(parsePercent(d.percent)!) !== preview.percent) raise("40001", "erp_contract_rate_changed");
    if (preview.too_early) raise("22023", "erp_contract_adjustment_too_early");
    if (preview.future_change) raise("40001", "erp_contract_future_change");
    const id = String(c.id), percent = String(preview.percent);
    const summary = `Reajuste de ${monthLabel(`${preview.month}-01`)} pelo ${preview.index_label} (${percentLabel(percent)}): de ${money(preview.before_cents)} para ${money(preview.after_cents!)} por período, a partir de ${dateLabel(preview.effective_on)}.`;
    const ev = event(ctx, id, "adjustment", summary, user, {
      index: preview.index, month: preview.month, percent, effective_on: preview.effective_on, before_cents: preview.before_cents, after_cents: preview.after_cents,
      before: preview.before, after: preview.after,
    }, preview.effective_on);
    replaceLinesFrom(ctx, id, preview.effective_on, preview.lines_after, ev);
    bump(ctx, c, user, { last_adjustment_month: preview.month });
    closeNotices(ctx, id, "adjustment_due", user, preview.month);
    if (Number(c.adjustment_notify) === 1) {
      const contact = contactRef(ctx.db, String(c.contact_id));
      notice(ctx, id, "customer_adjustment", preview.month,
        `Olá${contact ? `, ${contact.name}` : ""}! Conforme o ${label(c)}, o valor passa de ${money(preview.before_cents)} para ${money(preview.after_cents!)} a partir de ${dateLabel(preview.effective_on)}, pelo reajuste anual (${preview.index_label} de ${percentLabel(percent)}). Qualquer dúvida, estamos à disposição.`);
    }
    return { contract: contractView(ctx, id, user) };
  });
}
function erpContractAmend(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "amend", (user, d) => {
    onlyKeys(d, ["id", "expected_version", "effective_on", "items", "ends_on", "reason"]);
    const c = contractRow(ctx.db, uuidOf(d.id)!);
    requireVersion(c, versionOf(d.expected_version));
    if (!["active", "suspended"].includes(String(c.status))) raise("40001", "erp_contract_not_active");
    const reason = textOf(d.reason, 400, false, "erp_contract_reason_required")!;
    if (pgLength(reason) < 3) raise("22023", "erp_contract_reason_required");
    const effective = dateOf(d.effective_on, false)!;
    if (effective < String(c.starts_on)) raise("22023", "erp_contract_invalid_date");
    const items = d.items === undefined ? null : itemsOf(ctx.db, d.items);
    const endsChange = d.ends_on !== undefined;
    const ends = endsChange ? dateOf(d.ends_on) : (c.ends_on as string | null);
    if (!items && (!endsChange || ends === c.ends_on)) raise("22023", "erp_contract_amendment_empty");
    if (ends && ends < String(c.starts_on)) raise("22023", "erp_contract_invalid_period");
    const id = String(c.id);
    const before = validAt(linesOf(ctx.db, id), effective);
    const parts: string[] = [];
    if (items) {
      const after = items.reduce((s, l) => s + lineTotal(l.quantity, l.unit_cents), 0);
      parts.push(`itens de ${money(totalOf(before))} para ${money(after)} por período, a partir de ${dateLabel(effective)}`);
    }
    if (endsChange && ends !== c.ends_on) parts.push(ends ? `fim da vigência ${c.ends_on ? `de ${dateLabel(String(c.ends_on))} ` : ""}para ${dateLabel(ends)}` : "prazo indeterminado (sem data de fim)");
    const ev = event(ctx, id, "amendment", `Aditivo: ${parts.join("; ")}. Motivo: ${reason}.`, user, {
      effective_on: effective, reason, before: before.map(lineView), after: items ? items.map((l, i) => lineView({ ...l, id: "", position: i + 1, valid_from: effective, valid_until: null })) : null,
      ends_before: c.ends_on ?? null, ends_after: ends,
    }, effective);
    if (items) replaceLinesFrom(ctx, id, effective, items, ev);
    bump(ctx, c, user, endsChange ? { ends_on: ends } : {});
    return { contract: contractView(ctx, id, user) };
  });
}
function erpContractRenew(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "renew", (user, d) => {
    onlyKeys(d, ["id", "expected_version", "ends_on"]);
    const c = contractRow(ctx.db, uuidOf(d.id)!);
    requireVersion(c, versionOf(d.expected_version));
    if (!["active", "suspended"].includes(String(c.status))) raise("40001", "erp_contract_not_active");
    if (!c.ends_on) raise("22023", "erp_contract_indefinite");
    const current = String(c.ends_on);
    const ends = dateOf(d.ends_on) ?? renewedEnd(String(c.starts_on), current, (c.term_months as number | null) ?? null);
    if (ends <= current) raise("22023", "erp_contract_invalid_renewal");
    const id = String(c.id);
    bump(ctx, c, user, { ends_on: ends });
    closeNotices(ctx, id, "renewal", user);
    event(ctx, id, "renewal", `Contrato renovado: a vigência ia até ${dateLabel(current)} e agora vai até ${dateLabel(ends)}.`, user, { ends_before: current, ends_after: ends }, addDays(current, 1));
    return { contract: contractView(ctx, id, user) };
  });
}
function erpContractNoticeClose(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "notice_close", (user, d) => {
    onlyKeys(d, ["id", "action"]);
    const n = one(ctx.db, 'SELECT * FROM "erp_contract__notice" WHERE id=?', uuidOf(d.id)) ?? raise("P0002", "erp_contract_notice_not_found");
    if (n.status !== "pending") return { id: n.id, status: n.status };
    const status = d.action === "done" ? "done" : d.action === "dismissed" ? "dismissed" : raise("22023", "erp_contract_invalid");
    ctx.db.exec('UPDATE "erp_contract__notice" SET status=?, closed_at=?, closed_by=? WHERE id=?', status, ctx.clock.next().toString(), user, n.id);
    return { id: n.id, status };
  });
}
function erpContractAttachmentAdd(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "attachment_add", (user, d) => {
    onlyKeys(d, ["contract_id", "filename", "size_bytes", "sha256", "storage_key"]);
    const c = contractRow(ctx.db, uuidOf(d.contract_id)!);
    const filename = textOf(d.filename, 200, false, "erp_contract_invalid_file")!;
    const size = intOf(d.size_bytes, 1, 10485760, "erp_contract_invalid_file");
    const hash = typeof d.sha256 === "string" && /^[0-9a-f]{64}$/.test(d.sha256) ? d.sha256 : raise("22023", "erp_contract_invalid_file");
    const key = typeof d.storage_key === "string" && d.storage_key.endsWith(`/contratos/${c.id}/${hash}.pdf`) && d.storage_key.length <= 400 ? d.storage_key : raise("22023", "erp_contract_invalid_file");
    const id = crypto.randomUUID();
    ctx.db.exec('INSERT INTO "erp_contract__attachment"(id, contract_id, filename, size_bytes, sha256, storage_key, created_at, created_by) VALUES(?,?,?,?,?,?,?,?)',
      id, c.id, filename, size, hash, key, ctx.clock.next().toString(), user);
    event(ctx, String(c.id), "attachment", `Anexo incluído: ${filename}.`, user, { attachment_id: id });
    return { attachment: { id, filename, size_bytes: size } };
  });
}
function erpContractAttachmentRemove(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "attachment_remove", (user, d) => {
    onlyKeys(d, ["id"]);
    const f = one(ctx.db, 'SELECT * FROM "erp_contract__attachment" WHERE id=? AND deleted_at IS NULL', uuidOf(d.id)) ?? raise("P0002", "erp_contract_attachment_not_found");
    ctx.db.exec('UPDATE "erp_contract__attachment" SET deleted_at=?, deleted_by=? WHERE id=?', ctx.clock.next().toString(), user, f.id);
    event(ctx, String(f.contract_id), "attachment", `Anexo retirado: ${f.filename}.`, user, { attachment_id: f.id });
    return { id: f.id, removed: true };
  });
}

// ---------------------------------------------------------------------------
// Contratos do acervo do Bling (fatia D: wb_bling_extra_raw, entity='contracts').
// O caminho do contrato de manutenção da OS continua o dele (src/erp/bling/
// extras.ts); aqui o mesmo contrato do Bling pode virar contrato genérico, em
// rascunho e com a cobrança desligada. Um contrato do Bling vira um contrato
// só: já ligado ao de manutenção (ou a um genérico), recusa.

const BLING_PERIODS: [RegExp, Periodicity][] = [
  [/bimestr|^2$/, "bimonthly"], [/trimestr|^3$|^t$/, "quarterly"], [/semestr|^6$|^s$/, "semiannual"], [/anual|^12$|^a$/, "annual"], [/mensal|^1$|^m$/, "monthly"],
];
const civil = (v: unknown): string | null => {
  const t = rawText(v);
  if (!t) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(t), br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const day = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : br ? `${br[3]}-${br[2]}-${br[1]}` : null;
  return day && day > "2000-01-01" && day < "2100-12-31" && validDate(day) ? day : null;
};
const moneyOfRaw = (v: unknown): number | null => {
  const t = rawText(v);
  if (!t || !/^\d{1,11}(\.\d{1,10})?$/.test(t)) return null;
  const [int, frac = ""] = t.split(".");
  return Number(roundHalf(BigInt(int + (frac + "000").slice(0, 3)), 10n));
};
const roundHalf = (n: bigint, d: bigint) => (n % d) * 2n >= d ? n / d + 1n : n / d;
function blingTablesReady(db: SqlDriver): boolean {
  try { return archiveAvailable(db); } catch { return false; }
}
function blingRaw(db: SqlDriver, source: string): { version: number; payload: Json; deleted: boolean } | null {
  const row = db.exec(`SELECT r.version, r.payload, CASE WHEN coalesce(m.deleted_observed,0)=1 THEN 1 ELSE 0 END AS deleted
    FROM wb_bling_extra_raw r LEFT JOIN wb_bling_record_version m ON m.entity=r.entity AND m.source_id=r.source_id AND m.version=r.version
    WHERE r.entity='contracts' AND r.source_id=?`, source).rows[0];
  if (!row) return null;
  let payload: Json;
  try { payload = parseHistoricalPayload(String(row.payload)).payload as Json; } catch { payload = {}; }
  return { version: Number(row.version), payload, deleted: Number(row.deleted) === 1 };
}
/** Prévia de um contrato do Bling como contrato genérico: o que vai virar e o que impede. */
export function blingContractPreview(db: SqlDriver, source: string) {
  const raw = blingRaw(db, source);
  if (!raw) return null;
  const p = raw.payload, problems: string[] = [];
  const contact = isObject(p.contato) ? p.contato as Json : isObject(p.cliente) ? p.cliente as Json : null;
  const contactSource = contact ? sourceOf(contact) : null;
  const contactId = contactSource ? linkOf(db, "contacts", contactSource)?.record_id ?? null : null;
  const starts = civil(p.dataInicio ?? p.dataInicial ?? p.inicio ?? p.dataContrato);
  const ends = civil(p.dataFim ?? p.dataFinal ?? p.fim ?? p.dataVencimento);
  const periodicityText = rawText(isObject(p.periodicidade) ? (p.periodicidade as Json).descricao ?? (p.periodicidade as Json).id : p.periodicidade ?? p.tipoPeriodicidade ?? p.frequencia);
  const periodicity = periodicityText ? BLING_PERIODS.find(([re]) => re.test(fold(periodicityText)))?.[1] ?? null : null;
  const dueDayRaw = Number(rawText(p.diaVencimento ?? p.diaCobranca) ?? NaN);
  const dueDay = Number.isInteger(dueDayRaw) && dueDayRaw >= 1 && dueDayRaw <= 31 ? dueDayRaw : starts ? Number(starts.slice(8, 10)) : null;
  const description = rawText(p.descricao ?? p.observacoes ?? p.objeto);
  const number = rawText(p.numero);
  const rawItems = Array.isArray(p.itens) ? p.itens : [];
  const items = rawItems.slice(0, MAX_ITEMS).map((it) => {
    const item = isObject(it) ? it as Json : {};
    const qty = parseQuantity(rawText(item.quantidade) ?? "1");
    return { description: clipText(rawText(item.descricao ?? at(item, "produto", "nome")) ?? "Serviço do contrato", 400), quantity: qty && qty > 0n ? qtyText(qty) : "1.000000",
      unit_cents: moneyOfRaw(item.valor ?? item.valorUnitario) };
  }).filter((it) => it.unit_cents !== null) as { description: string; quantity: string; unit_cents: number }[];
  const value = moneyOfRaw(p.valor ?? p.valorMensal ?? p.valorContrato);
  if (!items.length && value !== null) items.push({ description: clipText(description ?? `Contrato ${number ?? source} do Bling`, 400), quantity: "1.000000", unit_cents: value });
  if (!contact) problems.push("O contrato veio sem o cliente.");
  else if (!contactId) problems.push("O cliente deste contrato ainda não foi trazido do Bling. Adote os contatos em Receber dados do Bling antes.");
  if (!starts) problems.push("O contrato veio sem a data de início da vigência.");
  if (!items.length) problems.push("O contrato veio sem valor nem itens no formato esperado.");
  if (!periodicity) problems.push("A periodicidade não é conhecida: escolha mensal, bimestral, trimestral, semestral ou anual ao adotar.");
  if (raw.deleted) problems.push("O contrato foi excluído no Bling.");
  if (starts && ends && ends < starts) problems.push("A data final vem antes da inicial.");
  const generic = db.exec('SELECT l.contract_id, c.number FROM "erp_contract__bling_link" l JOIN "erp_contract__contract" c ON c.id=l.contract_id WHERE l.source_id=?', source).rows[0];
  let maintenance = false;
  try { maintenance = !!db.exec("SELECT 1 x FROM wb_bling_adoption_extra_link WHERE entity='contracts' AND source_id=?", source).rows[0]; } catch { maintenance = false; }
  if (maintenance) problems.push("Este contrato do Bling já virou contrato de manutenção da Ordem de Serviço. Para não cobrar duas vezes, ele não vira contrato genérico.");
  const contactRow = contactId ? contactRef(db, contactId) : null;
  return {
    source_id: source, version: String(raw.version), number: number ? clipText(number, 60) : null, description: description ? clipText(description, 400) : null,
    customer: { name: rawText(contact?.nome) ?? contactRow?.name ?? null, document: rawText(contact?.numeroDocumento) ?? contactRow?.document ?? null },
    contact_id: contactId, starts_on: starts, ends_on: ends, periodicity, periodicity_text: periodicityText ? clipText(periodicityText, 60) : null, due_day: dueDay,
    items: items.map((it) => ({ ...it, unit_price: moneyText(it.unit_cents) })), amount_cents: items.reduce((s, it) => s + lineTotal(parseQuantity(it.quantity)!, it.unit_cents), 0),
    situation: rawText(isObject(p.situacao) ? (p.situacao as Json).descricao ?? (p.situacao as Json).id : p.situacao),
    problems, linked: generic ? { contract_id: String(generic.contract_id), label: `Contrato ${generic.number}` } : null, maintenance,
    ready: !!contactId && !!starts && items.length > 0 && !raw.deleted && !maintenance && !generic && !(starts && ends && ends < starts),
  };
}
function erpContractBlingList(ctx: RpcContext, a: RpcArgs) {
  const user = uuidOf(a.p_user_id)!;
  requireAccess(ctx.db, user, false);
  const p = args(a.p_args);
  onlyKeys(p, ["cursor"]);
  const cursor = p.cursor === undefined ? null : typeof p.cursor === "string" && /^[1-9]\d{0,39}$/.test(p.cursor) ? p.cursor : raise("22023", "erp_contract_invalid_query");
  if (!blingTablesReady(ctx.db)) return { available: false, items: [], next_cursor: null };
  const limit = 25;
  const ids = ctx.db.exec("SELECT source_id FROM wb_bling_extra_raw WHERE entity='contracts' AND (? IS NULL OR source_id>?) ORDER BY source_id LIMIT ?", cursor, cursor, limit + 1).rows.map((r) => String(r.source_id));
  const items = ids.slice(0, limit).map((id) => blingContractPreview(ctx.db, id)).filter(Boolean);
  return { available: true, items, next_cursor: ids.length > limit ? ids[limit - 1] : null };
}
function erpContractBlingAdopt(ctx: RpcContext, a: RpcArgs) {
  return write(ctx, a, "bling_adopt", (user, d) => {
    onlyKeys(d, ["source_id", "version", "periodicity", "due_day", "category_id", "payment_method_id"]);
    if (!blingTablesReady(ctx.db)) raise("P0002", "erp_contract_bling_unavailable");
    const source = typeof d.source_id === "string" && /^[1-9]\d{0,39}$/.test(d.source_id) ? d.source_id : raise("22023", "erp_contract_invalid");
    const preview = blingContractPreview(ctx.db, source) ?? raise("P0002", "erp_contract_bling_not_found");
    if (String(d.version) !== preview.version) raise("40001", "erp_contract_bling_changed");
    if (preview.linked) raise("40001", "erp_contract_bling_linked");
    if (preview.maintenance) raise("40001", "erp_contract_bling_maintenance");
    const periodicity = d.periodicity !== undefined ? (typeof d.periodicity === "string" && (PERIODICITIES as readonly string[]).includes(d.periodicity) ? d.periodicity : raise("22023", "erp_contract_invalid_periodicity")) : preview.periodicity;
    if (!preview.contact_id || !preview.starts_on || !preview.items.length || !periodicity) raise("22023", "erp_contract_bling_incomplete");
    const dueDay = d.due_day !== undefined ? intOf(d.due_day, 1, 31, "erp_contract_invalid_due_day") : preview.due_day ?? 1;
    const category = uuidOf(d.category_id, true), payment = uuidOf(d.payment_method_id, true);
    requireCategory(ctx.db, category);
    requirePayment(ctx.db, payment);
    requireContact(ctx.db, preview.contact_id);
    const id = crypto.randomUUID(), now = ctx.clock.next().toString();
    const number = Number(one(ctx.db, 'SELECT coalesce(max(number),0)+1 n FROM "erp_contract__contract"')!.n);
    const object = clipText(preview.description ?? `Contrato ${preview.number ?? source} trazido do Bling`, 4000);
    ctx.db.exec(`INSERT INTO "erp_contract__contract"(id, number, contact_id, object, starts_on, ends_on, periodicity, due_day, payment_method_id, category_id, status, billing_enabled, origin, notes, version, created_at, created_by, updated_at, updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,'draft',0,'bling',?,1,?,?,?,?)`, id, number, preview.contact_id, object, preview.starts_on, preview.ends_on && preview.ends_on >= preview.starts_on ? preview.ends_on : null,
      periodicity, dueDay, payment, category, clipText(`Trazido do Bling (contrato ${preview.number ?? source}${preview.situation ? `, situação ${preview.situation}` : ""}).`, 4000), now, user, now, user);
    insertLines(ctx, id, preview.items.map((it) => ({ product_id: null, description: it.description, quantity: parseQuantity(it.quantity)!, unit_cents: it.unit_cents })), preview.starts_on, null);
    ctx.db.exec('INSERT INTO "erp_contract__bling_link"(source_id, contract_id, source_version, adopted_at, adopted_by) VALUES(?,?,?,?,?)', source, id, Number(preview.version), now, user);
    event(ctx, id, "bling", `Contrato ${number} criado a partir do contrato ${preview.number ?? source} do Bling, em rascunho e com a cobrança desligada. Confira e ative.`, user, { source_id: source, version: preview.version });
    return { contract: contractView(ctx, id, user) };
  });
}

registerRpc("erp_contract_options", erpContractOptions);
registerRpc("erp_contract_list", erpContractList);
registerRpc("erp_contract_get", erpContractGet);
registerRpc("erp_contract_save", erpContractSave);
registerRpc("erp_contract_status", erpContractStatus);
registerRpc("erp_contract_billing", erpContractBilling);
registerRpc("erp_contract_bill_now", erpContractBillNow);
registerRpc("erp_contract_invoices", erpContractInvoices);
registerRpc("erp_contract_invoice_mark", erpContractInvoiceMark);
registerRpc("erp_contract_rates", erpContractRates);
registerRpc("erp_contract_rate_save", erpContractRateSave);
registerRpc("erp_contract_adjust_preview", erpContractAdjustPreview);
registerRpc("erp_contract_adjust", erpContractAdjust);
registerRpc("erp_contract_amend", erpContractAmend);
registerRpc("erp_contract_renew", erpContractRenew);
registerRpc("erp_contract_notices", erpContractNotices);
registerRpc("erp_contract_notice_close", erpContractNoticeClose);
registerRpc("erp_contract_attachment_add", erpContractAttachmentAdd);
registerRpc("erp_contract_attachment_get", erpContractAttachmentGet);
registerRpc("erp_contract_attachment_remove", erpContractAttachmentRemove);
registerRpc("erp_contract_bling_list", erpContractBlingList);
registerRpc("erp_contract_bling_adopt", erpContractBlingAdopt);
