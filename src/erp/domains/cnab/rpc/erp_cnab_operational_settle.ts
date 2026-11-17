// CNAB, bloco C5: a baixa pelo retorno operacional (migrações 043 e 058,
// versões finais no oráculo). public.erp_cnab_operational_settle (o pagamento
// exato, ocorrência 06) e o crédito líquido do Itaú 109:
// erp_cnab_itau_net_credit_preview, _command e _settle, com
// erp_cnab.itau_net_credit_context e itau_net_credit_plan.
// O lançamento é do Financeiro (sessão O): execute (erp_finance_execute na
// mesma transação), insertCnabCashPlan (erp_finance.cnab_cash_plan e o
// gatilho adiado cnab_cash_plan_check), commandExists, settlementMovements e dto.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { commandExists, dto, execute, insertCnabCashPlan, settlementMovements } from "../../finance/public.ts";
import { bool, int, text, uuid } from "../args.ts";
import { audit, storageCheck } from "../commands.ts";
import { access, get, operationalSafety, parse, sha256, ts, txt, type Json } from "../core.ts";
import { operationalContextHash, operationalEventContext } from "../returns.ts";
import { lockOperationalEvent } from "./erp_cnab_operational_returns.ts";
import { returnFile, returnFileObjects } from "./erp_cnab_return_writes.ts";

const POLICY = "itau109-net-credit-v1";
const HASH = /^[a-f0-9]{64}$/;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
/** jsonb não nulo (nem ausente nem 'null'::jsonb) */
const present = (v: unknown) => v !== null && v !== undefined;

type Prior = { actor: string; request_hash: string; receipt: Json };
function priorSettlement(db: SqlDriver, command: string | null): Prior | null {
  const r = one(db, 'SELECT actor, request_hash, receipt FROM "erp_cnab__operational_settlement" WHERE command_id=?', command);
  return r ? { actor: String(r.actor), request_hash: String(r.request_hash), receipt: parse(r.receipt) as Json } : null;
}

function insertSettlement(ctx: RpcContext, event: string, billing: unknown, title: unknown, settlement: unknown, profile: string, file: string, line: number, command: string, actor: string, hash: string, receipt: Json) {
  ctx.db.exec(
    `INSERT INTO "erp_cnab__operational_settlement"(event_id, billing_title_id, title_id, settlement_id, profile_id, file_id, line, command_id, actor, request_hash, receipt, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    event, billing, title, settlement, profile, file, line, command, actor, hash, JSON.stringify(receipt), ctx.clock.next().toString(),
  );
}

export function erpCnabOperationalSettle(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const eventId = uuid(a, "p_event_id");
  const fileId = uuid(a, "p_file_id");
  const line = int(a, "p_line");
  const expected = int(a, "p_expected_approval");
  const commandId = uuid(a, "p_command_id");
  const hash = text(a, "p_context_hash");
  access(db, user, true);
  if (commandId === null || bool(a, "p_confirm") !== true || expected === null || expected < 1 || hash === null || !HASH.test(hash))
    raise("22023", "erp_cnab_operational_confirmation_required");
  const requestHash = sha256({ actor: user, event_id: eventId, file_id: fileId, line, approval_version: expected, context_hash: hash });
  const prior = priorSettlement(db, commandId);
  if (prior && (prior.actor !== user || prior.request_hash !== requestHash)) raise("40001", "erp_cnab_operational_command_conflict");
  if (!prior && commandExists(db, commandId!)) raise("40001", "erp_cnab_operational_command_conflict");
  const pid = lockOperationalEvent(db, eventId, fileId, line, expected);
  if (prior)
    return { purpose: "operational", originAuthenticated: false, bankTransmissionPerformed: false, financialMutationPerformed: true, replayed: true, receipt: prior.receipt };
  const c = operationalEventContext(ctx, eventId, fileId, line);
  if (operationalContextHash(c) !== hash || get(c, "settlement", "allowed") !== true) raise("40001", "erp_cnab_operational_review_changed");
  const f = returnFile(db, fileId)!;
  storageCheck(ctx, pid, "returns", f.hash, f.size, f.path);
  const result = execute(ctx, user!, commandId, "settle", {
    id: get(c, "title", "id"),
    expected_version: get(c, "title", "version"),
    account_id: get(c, "account", "id"),
    posted_on: get(c, "event", "credited_on"),
    principal_cents: get(c, "event", "paid_cents"),
    note: `CNAB operacional: evento ${eventId}`,
  });
  const settlementId = get(result, "settlement", "id");
  const receipt: Json = {
    command_id: commandId, event_id: eventId, event_hash: get(c, "event", "hash"), file_id: fileId, file_hash: f.hash, line, profile_id: pid,
    approval_version: expected, context_hash: hash, billing_title_id: get(c, "billing", "id"), title_id: get(c, "title", "id"), account_id: get(c, "account", "id"),
    settlement_id: settlementId, posted_on: get(c, "event", "credited_on"), principal_cents: get(c, "event", "paid_cents"), net_cash_cents: get(c, "event", "paid_cents"),
    created_at: ts(ctx.clock.next().toString()),
  };
  insertSettlement(ctx, eventId!, txt(c, "billing", "id"), txt(c, "title", "id"), settlementId, pid, fileId!, line!, commandId, user!, requestHash, receipt);
  audit(ctx, user!, commandId, "operational_settle", eventId!);
  return { purpose: "operational", originAuthenticated: false, bankTransmissionPerformed: false, financialMutationPerformed: true, replayed: false, receipt };
}

/** Texto para numeric: o cast do Postgres recusa o que não é número. */
function numeric(v: string): number {
  if (!/^\s*[+-]?(\d+(\.\d*)?|\.\d+)\s*$/.test(v)) raise("22P02", `invalid input syntax for type numeric: "${v}"`);
  return Number(v);
}

/** erp_cnab.itau_net_credit_plan(event, category, expected_category) */
export function itauNetCreditPlan(event: unknown, category: Json | null, expectedCategory: number): Json {
  const a = get(event, "adjustments");
  const adjusted = present(a);
  const issues: string[] = [];
  const bank = txt(event, "bank");
  const wallet = txt(event, "wallet");
  if ((bank !== null && bank !== "341") || (wallet !== null && wallet !== "109")) issues.push("ITAU109_REQUIRED");
  if (!adjusted || ["iof", "abatement", "discount", "otherCredits"].some((k) => txt(a, k) !== "0")) issues.push("NET_CREDIT_ADJUSTMENTS_UNSUPPORTED");
  if (adjusted && txt(a, "interest") !== "0") issues.push("MORA_PENALTY_UNSUPPORTED");
  const amount = txt(event, "amount_cents");
  const paid = txt(event, "paid_cents");
  const fee = txt(a, "fee");
  if (amount === "0" || paid === "0") issues.push("NET_CREDIT_AMOUNT_INVALID");
  if (adjusted && paid !== null && fee !== null && amount !== null && numeric(paid) + numeric(fee) !== numeric(amount)) issues.push("NET_CREDIT_EQUATION_DIFFERS");
  if (fee === "0") issues.push("FEE_REQUIRED");
  if (category === null || category.active !== true || !["payable", "both"].includes(String(category.kind))) issues.push("FEE_CATEGORY_NOT_READY");
  if (category !== null && Number(category.version) !== expectedCategory) issues.push("FEE_CATEGORY_VERSION_CHANGED");
  let posting: Json | null = null;
  if (issues.length === 0) {
    const { active: _active, ...snapshot } = category!;
    posting = {
      principal_cents: amount, interest_cents: "0", penalty_cents: "0", fee_cents: fee, gross_credit_cents: amount, net_cash_cents: paid, fee_category: snapshot,
      legs: [{ kind: "payment", delta_cents: amount }, { kind: "bank_fee", delta_cents: `-${fee}` }],
    };
  }
  return { policy: POLICY, issues, posting };
}

/** A categoria como o contexto a lê (id, version, name, kind, active). */
function feeCategory(db: SqlDriver, id: string): Json | null {
  const r = one(db, 'SELECT id, version, name, kind, active FROM "erp_finance__category" WHERE id=?', id);
  return r ? { id: String(r.id), version: Number(r.version), name: String(r.name), kind: String(r.kind), active: r.active === 1 || r.active === true } : null;
}

/** erp_cnab.itau_net_credit_context(event, file, line, category, expected_category) */
export function itauNetCreditContext(ctx: RpcContext, eventId: string | null, fileId: string | null, line: number | null, category: string | null, expectedCategory: number | null): Json {
  if (category === null || expectedCategory === null || expectedCategory < 1) raise("22023", "erp_cnab_fee_category_required");
  const b = operationalEventContext(ctx, eventId, fileId, line);
  const cat = feeCategory(ctx.db, category!);
  const plan = itauNetCreditPlan(b.event, cat, expectedCategory!);
  const base = ((get(b, "settlement", "issues") as unknown[]) ?? []).filter((x) => x !== "PAYMENT_AMOUNT_DIFFERS" && x !== "PAYMENT_ADJUSTMENTS_UNSUPPORTED");
  const issues = [...base, ...(plan.issues as unknown[])];
  return {
    policy: POLICY, base: b, category_selection: { id: category, expected_version: expectedCategory }, category: cat, plan,
    settlement: { allowed: issues.length === 0, issues },
  };
}

export function erpCnabItauNetCreditPreview(ctx: RpcContext, a: RpcArgs) {
  const eventId = uuid(a, "p_event_id");
  access(ctx.db, uuid(a, "p_user_id"), true);
  const c = itauNetCreditContext(ctx, eventId, uuid(a, "p_file_id"), int(a, "p_line"), uuid(a, "p_fee_category_id"), int(a, "p_expected_fee_category_version"));
  return { ...operationalSafety(), policy: POLICY, event_id: eventId, context: c, context_hash: operationalContextHash(c), bytes_verified: false };
}

export function erpCnabItauNetCreditCommand(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, uuid(a, "p_user_id"));
  const o = one(db, 'SELECT receipt, title_id, settlement_id FROM "erp_cnab__operational_settlement" WHERE command_id=?', uuid(a, "p_command_id"));
  const receipt = o ? (parse(o.receipt) as Json) : null;
  if (!o || txt(receipt, "policy") !== POLICY) raise("P0002", "erp_cnab_not_found");
  return {
    policy: POLICY, purpose: "operational", read_only: true, financialMutationPerformed: false, originAuthenticated: false, bankTransmissionPerformed: false,
    receipt,
    current_title: dto(db, "titles", String(o!.title_id)),
    current_account: dto(db, "accounts", txt(receipt, "account_id")),
    current_settlement: dto(db, "settlements", String(o!.settlement_id)),
  };
}

export function erpCnabItauNetCreditSettle(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const eventId = uuid(a, "p_event_id");
  const fileId = uuid(a, "p_file_id");
  const line = int(a, "p_line");
  const category = uuid(a, "p_fee_category_id");
  const categoryVersion = int(a, "p_expected_fee_category_version");
  const expected = int(a, "p_expected_approval");
  const commandId = uuid(a, "p_command_id");
  const hash = text(a, "p_context_hash");
  access(db, user, true);
  if (
    commandId === null || bool(a, "p_confirm") !== true || expected === null || expected < 1 || category === null || categoryVersion === null || categoryVersion < 1 ||
    hash === null || !HASH.test(hash)
  )
    raise("22023", "erp_cnab_net_credit_invalid");
  const h = sha256({
    policy: POLICY, actor: user, event_id: eventId, file_id: fileId, line, category_id: category, category_version: categoryVersion, approval_version: expected, context_hash: hash,
  });
  access(db, user, true);
  const prior = priorSettlement(db, commandId);
  if (prior && (prior.actor !== user || prior.request_hash !== h || txt(prior.receipt, "policy") !== POLICY)) raise("40001", "erp_cnab_operational_command_conflict");
  if (!prior && commandExists(db, commandId!)) raise("40001", "erp_cnab_operational_command_conflict");
  const pid = lockOperationalEvent(db, eventId, fileId, line, expected);
  access(db, user, true);
  if (prior)
    return { policy: POLICY, purpose: "operational", originAuthenticated: false, bankTransmissionPerformed: false, financialMutationPerformed: true, replayed: true, receipt: prior.receipt };
  const c = itauNetCreditContext(ctx, eventId, fileId, line, category, categoryVersion);
  if (operationalContextHash(c) !== hash || get(c, "settlement", "allowed") !== true) raise("40001", "erp_cnab_operational_review_changed");
  const b = c.base as Json;
  const p = get(c, "plan", "posting") as Json;
  const f = returnFile(db, fileId)!;
  storageCheck(ctx, pid, "returns", f.hash, f.size, f.path);
  insertCnabCashPlan(ctx, {
    command_id: commandId!, event_id: eventId!, title_id: txt(b, "title", "id")!, account_id: txt(b, "account", "id")!, actor: user!,
    principal_cents: Number(txt(p, "principal_cents")), fee_cents: Number(txt(p, "fee_cents")), net_cash_cents: Number(txt(p, "net_cash_cents")),
    category_id: category!, category_snapshot: p.fee_category,
  });
  const result = execute(ctx, user!, commandId, "settle", {
    id: get(b, "title", "id"), expected_version: get(b, "title", "version"), account_id: get(b, "account", "id"), posted_on: get(b, "event", "credited_on"),
    principal_cents: p.principal_cents, fee_cents: p.fee_cents, note: `CNAB Itaú109 net-credit: evento ${eventId}`,
  });
  const settlementId = get(result, "settlement", "id");
  const legs = settlementMovements(db, String(settlementId));
  const movements = legs.length === 0
    ? null
    : [...legs.filter((m) => m.kind === "payment"), ...legs.filter((m) => m.kind !== "payment")].map((m) => ({ id: m.id, kind: m.kind, delta_cents: String(m.delta_cents) }));
  const r: Json = {
    policy: POLICY, command_id: commandId, event_id: eventId, event_hash: get(b, "event", "hash"), file_id: fileId, file_hash: f.hash, line, profile_id: pid,
    approval_version: expected, context_hash: hash, billing_title_id: get(b, "billing", "id"), title_id: get(b, "title", "id"), account_id: get(b, "account", "id"),
    settlement_id: settlementId, posted_on: get(b, "event", "credited_on"), posting: p, movements, created_at: ts(ctx.clock.next().toString()),
  };
  insertSettlement(ctx, eventId!, txt(b, "billing", "id"), txt(b, "title", "id"), settlementId, pid, fileId!, line!, commandId, user!, h, r);
  audit(ctx, user!, commandId, "itau_net_credit_settle", eventId!);
  return { policy: POLICY, purpose: "operational", originAuthenticated: false, bankTransmissionPerformed: false, financialMutationPerformed: true, replayed: false, receipt: r };
}

registerRpc("erp_cnab_operational_settle", erpCnabOperationalSettle, { objects: returnFileObjects("p_file_id") });
registerRpc("erp_cnab_itau_net_credit_preview", erpCnabItauNetCreditPreview);
registerRpc("erp_cnab_itau_net_credit_command", erpCnabItauNetCreditCommand);
registerRpc("erp_cnab_itau_net_credit_settle", erpCnabItauNetCreditSettle, { objects: returnFileObjects("p_file_id") });
