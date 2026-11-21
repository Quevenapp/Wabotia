// Conciliação bancária e de cartões (motor; structural.ts, conciliacao; tabelas
// erp_reconciliation__*, versão 30). RPCs só do motor, da parte Financeiro.
// O Financeiro continua dono da linha do extrato, dos vínculos, da baixa e do
// lançamento: aqui só se chama o que ele já tem (erp_finance_reconciliation_execute
// para importar, conciliar, baixar, lançar, ocultar e desfazer; erp_finance_execute
// para baixar a conta do cartão com a taxa), no mesmo comando e transação.
// - erp_reconciliation_overview: contas, modelos de planilha, regras e taxas;
// - erp_reconciliation_preview: lê o arquivo sem gravar (colunas achadas e as primeiras linhas);
// - erp_reconciliation_bank_import: OFX ou planilha numa conta (sem duplicar);
// - erp_reconciliation_bank_lines: linhas com sugestões e grau de confiança, e o saldo por dia;
// - erp_reconciliation_bank_action: confirmar, baixar, lançar (pela regra ou na hora), ignorar com motivo, desfazer;
// - erp_reconciliation_rule_save / erp_reconciliation_layout_save: regras e modelos de colunas;
// - erp_reconciliation_card_import / _card_lines / _card_action / _card_receive / _card_rate_save:
//   o extrato da adquirente, o casamento com as vendas do PDV e dos pedidos,
//   taxa cobrada x contratada, o que vai cair e o recebimento na conta.
import { createHash } from "node:crypto";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { todaySaoPaulo, validDate } from "../../engine/time.ts";
import { requireAccess } from "../finance/public.ts";
import { bankLineDto, candidateLine } from "../finance/reconciliation.ts";
import { statementLines } from "../finance/rpc/erp_finance_statement_page.ts";
import {
  ACQUIRERS, BRANDS, BRAND_BY_CODE, BRAND_LABEL, ReconciliationFileError, addDays, brl, cardDedupSource, cardScore, chargedRateBp, confidenceLabel, dayDiff,
  expectedFee, movementScore, nameMatch, parseBankCsv, parseCardCsv, parseOfx, plain, rateFor, ruleMatches, titleScore,
  type BankFile, type CardLine, type Mapping,
} from "./model.ts";

export const LAYOUT = "erp_reconciliation__layout", RULE = "erp_reconciliation__rule", BANK_LINE = "erp_reconciliation__bank_line";
export const BALANCE = "erp_reconciliation__bank_balance", RATE = "erp_reconciliation__card_rate", IMPORT = "erp_reconciliation__card_import";
export const CARD_LINE = "erp_reconciliation__card_line", COMMAND = "erp_reconciliation__command", AUDIT = "erp_reconciliation__audit";
const FIN_LINE = "erp_finance__bank_statement_line";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Linhas do extrato numa consulta; acima disso, filtre o período. */
export const BANK_LINES_LIMIT = 500;
export const CARD_LINES_LIMIT = 1000;
const invalid = (code = "erp_reconciliation_invalid"): never => raise("22023", code);
const parse = (v: unknown): any => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const now = (ctx: RpcContext) => ctx.clock.next().toString();
const left = (v: unknown, n: number) => (v === null || v === undefined ? null : [...String(v)].slice(0, n).join(""));
const bool = (v: unknown) => v === 1 || v === true || v === "1";

function argsOf(raw: unknown, allowed: readonly string[], max = 65536) {
  const a = parse(raw ?? {});
  if (!a || typeof a !== "object" || Array.isArray(a) || JSON.stringify(a).length > max || Object.keys(a).some((k) => !allowed.includes(k))) invalid();
  return a as Record<string, any>;
}
const uuidOf = (v: unknown, required = true): string | null => {
  if (v === undefined || v === null || v === "") return required ? invalid() : null;
  if (typeof v !== "string" || !UUID.test(v)) invalid();
  return (v as string).toLowerCase();
};
const dayOf = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !DAY.test(v) || !validDate(v)) invalid("erp_reconciliation_period_invalid");
  return v as string;
};
const textOf = (v: unknown, max: number, min = 0, code = "erp_reconciliation_invalid"): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") invalid(code);
  const t = (v as string).trim();
  if (!t) return min > 0 ? invalid(code) : null;
  if ([...t].length > max || [...t].length < min || /[\u0000-\u001f\u007f]/.test(t)) invalid(code);
  return t;
};
const intOf = (v: unknown, lo: number, hi: number, code = "erp_reconciliation_invalid"): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) invalid(code);
  return v as number;
};
const versionOf = (v: unknown) => intOf(v, 0, 2147483647, "erp_reconciliation_version_conflict");
const centsOf = (v: unknown, code = "erp_reconciliation_invalid"): bigint => {
  const t = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof t !== "string" || !/^[0-9]{1,15}$/.test(t)) invalid(code);
  return BigInt(t as string);
};

/** Comando derivado estável (a mesma gravação repetida gera os mesmos comandos internos). */
export function subCommand(command: string, label: string): string {
  const h = sha256(`${command}:${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function commandOf(a: RpcArgs): string {
  const c = a.p_command_id;
  if (typeof c !== "string" || !UUID.test(c)) invalid("erp_reconciliation_command_missing");
  return (c as string).toLowerCase();
}
const userOf = (a: RpcArgs) => String(a.p_user_id);
const hashOf = (op: string, user: string, args: unknown) => sha256(JSON.stringify({ op, user, args }));
function replay(db: SqlDriver, command: string, user: string, hash: string) {
  const r = one(db, `SELECT actor, request_hash, result FROM "${COMMAND}" WHERE command_id=?`, command);
  if (!r) return null;
  if (r.actor !== user || r.request_hash !== hash) raise("40001", "erp_reconciliation_command_conflict");
  return { ...JSON.parse(String(r.result)), replayed: true };
}
function receipt(ctx: RpcContext, command: string, user: string, hash: string, action: string, target: string, before: unknown, result: Record<string, unknown>) {
  const at = now(ctx);
  ctx.db.exec(`INSERT INTO "${COMMAND}"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)`, command, user, hash, JSON.stringify(result), at);
  ctx.db.exec(`INSERT INTO "${AUDIT}"(command_id, actor, action, target, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?)`,
    command, user, action, target, before === null || before === undefined ? null : JSON.stringify(before), JSON.stringify(result), at);
  return { ...result, replayed: false };
}

/** Papel do Financeiro: consultar (administrador, financeiro e consulta); gravar (administrador e financeiro). */
function access(db: SqlDriver, user: string, write: boolean): string {
  return requireAccess(db, user, write);
}
const canWrite = (role: string) => role === "admin" || role === "financeiro";
const financeCall = (ctx: RpcContext, name: string, args: RpcArgs) => invokeRpc(ctx, name, args) as Record<string, any>;
const execute = (ctx: RpcContext, user: string, command: string, label: string, action: string, data: Record<string, unknown>) =>
  financeCall(ctx, "erp_finance_reconciliation_execute", { p_user_id: user, p_command_id: subCommand(command, label), p_action: action, p_data: data });

function fileError(error: unknown): never {
  if (error instanceof ReconciliationFileError) raise("22023", `erp_reconciliation_file:${error.code}:${error.message}`);
  throw error;
}
const recordName = (db: SqlDriver, id: unknown) =>
  typeof id === "string" ? left(one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', id)?.name, 200) : null;
const categoryRow = (db: SqlDriver, id: unknown) =>
  typeof id === "string" ? one(db, 'SELECT id, name, kind FROM "erp_finance__category" WHERE id=? AND deleted_at IS NULL', id) : null;
function accountRow(db: SqlDriver, id: string) {
  const a = one(db, 'SELECT id, name, kind, account_type, active, deleted_at FROM "erp_finance__account" WHERE id=?', id);
  if (!a || a.deleted_at !== null) raise("P0002", "erp_reconciliation_account_not_found");
  return a!;
}
const acquirerOf = (v: unknown): string => {
  const t = textOf(v, 30, 2, "erp_reconciliation_acquirer_invalid")!;
  const id = plain(t).replace(/ /g, "");
  if (!/^[a-z0-9]{2,30}$/.test(id)) invalid("erp_reconciliation_acquirer_invalid");
  return id;
};
const acquirerName = (id: string) => ACQUIRERS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/** O modelo de colunas recebido (ou o salvo): só as chaves conhecidas, nomes curtos. */
function mappingOf(v: unknown, kind: "bank" | "card"): Mapping | undefined {
  if (v === undefined || v === null) return undefined;
  const m = parse(v);
  if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).some((k) => !["columns", "separator", "decimal", "date_format", "invert"].includes(k))) invalid("erp_reconciliation_mapping_invalid");
  const fields = kind === "bank" ? ["date", "description", "amount", "credit", "debit", "balance", "id", "type"]
    : ["sold_on", "expected_on", "brand", "product", "installment", "installments", "gross", "fee", "net", "rate", "nsu", "authorization", "description"];
  const columns: Record<string, string> = {};
  const raw = m.columns ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) invalid("erp_reconciliation_mapping_invalid");
  for (const [k, value] of Object.entries(raw)) {
    if (!fields.includes(k)) invalid("erp_reconciliation_mapping_invalid");
    if (value === null || value === "") continue;
    columns[k] = textOf(value, 80, 1, "erp_reconciliation_mapping_invalid")!;
  }
  if (m.separator !== undefined && ![";", ",", "\t"].includes(m.separator)) invalid("erp_reconciliation_mapping_invalid");
  if (m.decimal !== undefined && ![",", ".", "auto"].includes(m.decimal)) invalid("erp_reconciliation_mapping_invalid");
  if (m.date_format !== undefined && !["dmy", "ymd", "mdy"].includes(m.date_format)) invalid("erp_reconciliation_mapping_invalid");
  if (m.invert !== undefined && typeof m.invert !== "boolean") invalid("erp_reconciliation_mapping_invalid");
  return { columns, ...(m.separator ? { separator: m.separator } : {}), ...(m.decimal ? { decimal: m.decimal } : {}),
    ...(m.date_format ? { date_format: m.date_format } : {}), ...(m.invert ? { invert: true } : {}) };
}
function layoutOf(db: SqlDriver, id: unknown, kind: "bank" | "card"): Row | null {
  const v = uuidOf(id, false);
  if (!v) return null;
  const r = one(db, `SELECT * FROM "${LAYOUT}" WHERE id=? AND kind=? AND active=1`, v, kind);
  if (!r) raise("P0002", "erp_reconciliation_layout_not_found");
  return r!;
}

// ---------------------------------------------------------------------------
// Modelos de colunas

function layoutDto(db: SqlDriver, r: Row) {
  return { id: r.id, kind: r.kind, name: r.name, acquirer: r.acquirer, acquirer_name: r.acquirer ? acquirerName(String(r.acquirer)) : null,
    account_id: r.account_id, account_name: r.account_id ? left(one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', r.account_id)?.name, 200) : null,
    mapping: parse(r.mapping), active: bool(r.active), version: Number(r.version) };
}

/** Grava (ou cria) um modelo: nome único por tipo entre os ativos. */
function storeLayout(ctx: RpcContext, user: string, input: { id: string | null; expected: number | null; kind: "bank" | "card"; name: string; acquirer: string | null;
  account: string | null; mapping: Mapping; active: boolean }): string {
  const db = ctx.db, at = now(ctx);
  const clash = input.active
    ? one(db, `SELECT id FROM "${LAYOUT}" WHERE kind=? AND lower(name)=lower(?) AND active=1 AND id<>coalesce(?, '')`, input.kind, input.name, input.id)
    : null;
  if (clash) raise("23505", "erp_reconciliation_layout_name_taken");
  if (input.account) accountRow(db, input.account);
  if (input.id) {
    const old = one(db, `SELECT * FROM "${LAYOUT}" WHERE id=?`, input.id);
    if (!old || old.kind !== input.kind) raise("P0002", "erp_reconciliation_layout_not_found");
    if (input.expected !== null && Number(old!.version) !== input.expected) raise("40001", "erp_reconciliation_version_conflict");
    db.exec(`UPDATE "${LAYOUT}" SET name=?, acquirer=?, account_id=?, mapping=?, active=?, version=version+1, updated_at=?, updated_by=? WHERE id=?`,
      input.name, input.acquirer, input.account, JSON.stringify(input.mapping), input.active ? 1 : 0, at, user, input.id);
    return input.id;
  }
  const id = crypto.randomUUID();
  db.exec(`INSERT INTO "${LAYOUT}"(id, kind, name, acquirer, account_id, mapping, active, version, created_at, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,1,?,?,?)`,
    id, input.kind, input.name, input.acquirer, input.account, JSON.stringify(input.mapping), input.active ? 1 : 0, at, at, user);
  return id;
}

function layoutSave(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, true);
  const a = argsOf(raw, ["id", "expected_version", "kind", "name", "acquirer", "account_id", "mapping", "active"]);
  const hash = hashOf("layout_save", user, a);
  const previous = replay(db, command, user, hash);
  if (previous) return previous;
  const kind = a.kind === "card" ? "card" : a.kind === "bank" ? "bank" : invalid();
  const id = uuidOf(a.id, false);
  const before = id ? one(db, `SELECT * FROM "${LAYOUT}" WHERE id=?`, id) : null;
  const saved = storeLayout(ctx, user, {
    id, expected: id ? versionOf(a.expected_version) : null, kind, name: textOf(a.name, 80, 1, "erp_reconciliation_layout_name")!,
    acquirer: kind === "card" ? acquirerOf(a.acquirer) : null, account: kind === "bank" ? uuidOf(a.account_id, false) : null,
    mapping: mappingOf(a.mapping, kind) ?? { columns: {} }, active: a.active === undefined ? true : a.active === true,
  });
  return receipt(ctx, command, user, hash, "layout_save", saved, before ? layoutDto(db, before) : null, { layout: layoutDto(db, one(db, `SELECT * FROM "${LAYOUT}" WHERE id=?`, saved)!) });
}

// ---------------------------------------------------------------------------
// Regras ("tarifa do banco" → Despesas bancárias)

function ruleDto(db: SqlDriver, r: Row) {
  const category = categoryRow(db, r.category_id);
  return { id: r.id, name: r.name, pattern: r.pattern, direction: r.direction, account_id: r.account_id, category_id: r.category_id,
    category_name: category?.name ?? null, category_kind: category?.kind ?? null, contact_id: r.contact_id, contact_name: recordName(db, r.contact_id),
    note: r.note, active: bool(r.active), version: Number(r.version) };
}

function ruleSave(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, true);
  const a = argsOf(raw, ["id", "expected_version", "name", "pattern", "direction", "account_id", "category_id", "contact_id", "note", "active"]);
  const hash = hashOf("rule_save", user, a);
  const previous = replay(db, command, user, hash);
  if (previous) return previous;
  const id = uuidOf(a.id, false);
  const pattern = textOf(a.pattern, 120, 2, "erp_reconciliation_rule_pattern")!;
  const name = textOf(a.name, 80, 1, "erp_reconciliation_rule_name") ?? pattern.slice(0, 80);
  const direction = a.direction === undefined || a.direction === null ? "any" : ["in", "out", "any"].includes(a.direction) ? String(a.direction) : invalid();
  const account = uuidOf(a.account_id, false);
  if (account) accountRow(db, account);
  const category = categoryRow(db, uuidOf(a.category_id, true));
  if (!category || !one(db, 'SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1', category.id)) raise("22023", "erp_reconciliation_rule_category");
  if ((direction === "in" && category!.kind !== "receivable") || (direction === "out" && category!.kind !== "payable")) raise("22023", "erp_reconciliation_rule_category_kind");
  const contact = uuidOf(a.contact_id, false);
  if (contact && !one(db, 'SELECT 1 x FROM "erp_catalog__record" WHERE id=?', contact)) raise("22023", "erp_reconciliation_rule_contact");
  const note = textOf(a.note, 500);
  const active = a.active === undefined ? true : a.active === true;
  const at = now(ctx);
  let target = id;
  let before: unknown = null;
  if (id) {
    const old = one(db, `SELECT * FROM "${RULE}" WHERE id=?`, id);
    if (!old) raise("P0002", "erp_reconciliation_rule_not_found");
    if (Number(old!.version) !== versionOf(a.expected_version)) raise("40001", "erp_reconciliation_version_conflict");
    before = ruleDto(db, old!);
    db.exec(`UPDATE "${RULE}" SET name=?, pattern=?, direction=?, account_id=?, category_id=?, contact_id=?, note=?, active=?, version=version+1, updated_at=?, updated_by=? WHERE id=?`,
      name, pattern, direction, account, category!.id, contact, note, active ? 1 : 0, at, user, id);
  } else {
    target = crypto.randomUUID();
    db.exec(`INSERT INTO "${RULE}"(id, name, pattern, direction, account_id, category_id, contact_id, note, active, version, created_at, updated_at, updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)`, target, name, pattern, direction, account, category!.id, contact, note, active ? 1 : 0, at, at, user);
  }
  return receipt(ctx, command, user, hash, "rule_save", target!, before, { rule: ruleDto(db, one(db, `SELECT * FROM "${RULE}" WHERE id=?`, target)!) });
}

// ---------------------------------------------------------------------------
// Visão geral

const rateDto = (r: Row) => ({
  id: r.id, acquirer: r.acquirer, acquirer_name: acquirerName(String(r.acquirer)), brand: r.brand, brand_label: BRAND_LABEL[r.brand as keyof typeof BRAND_LABEL] ?? r.brand,
  product: r.product, installments_from: Number(r.installments_from), installments_to: Number(r.installments_to), rate_bp: Number(r.rate_bp),
  fixed_cents: String(r.fixed_cents), settle_days: Number(r.settle_days), active: bool(r.active), version: Number(r.version),
});

function overview(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  const role = access(db, user, false);
  argsOf(raw, []);
  const accounts = db.exec(`SELECT id, name, kind, account_type FROM "erp_finance__account" WHERE deleted_at IS NULL AND active=1 ORDER BY name, id`).rows.map((a) => {
    const counts = one(db, `SELECT sum(state='pending') pending, sum(state='reconciled') reconciled, sum(state='hidden') hidden, max(posted_on) last_on
      FROM "${FIN_LINE}" WHERE account_id=? AND deleted_at IS NULL`, a.id)!;
    return { id: a.id, name: left(a.name, 200), kind: a.kind, account_type: a.account_type, pending: Number(counts.pending ?? 0), reconciled: Number(counts.reconciled ?? 0),
      ignored: Number(counts.hidden ?? 0), last_line_on: counts.last_on ?? null };
  });
  const categories = db.exec(`SELECT id, name, kind FROM "erp_finance__category" WHERE active=1 AND deleted_at IS NULL ORDER BY kind, name, id`).rows
    .map((c) => ({ id: c.id, name: left(c.name, 200), kind: c.kind }));
  return {
    role, can_write: canWrite(role),
    accounts, categories,
    layouts: db.exec(`SELECT * FROM "${LAYOUT}" WHERE active=1 ORDER BY kind, name, id`).rows.map((r) => layoutDto(db, r)),
    rules: db.exec(`SELECT * FROM "${RULE}" ORDER BY active DESC, name, id`).rows.map((r) => ruleDto(db, r)),
    rates: db.exec(`SELECT * FROM "${RATE}" ORDER BY active DESC, acquirer, brand, product, installments_from, id`).rows.map(rateDto),
    acquirers: Object.entries(ACQUIRERS).map(([id, name]) => ({ id, name })),
    brands: BRANDS.map((id) => ({ id, label: BRAND_LABEL[id] })),
    parts: { pos: ctx.parts.pos !== false, sales: ctx.parts.sales !== false },
  };
}

// ---------------------------------------------------------------------------
// Leitura do arquivo (prévia, sem gravar)

function readBankFile(format: unknown, content: unknown, mapping: Mapping | undefined): BankFile & { header?: string[]; mapped?: Partial<Record<string, number>> } {
  if (typeof content !== "string") invalid("erp_reconciliation_file_missing");
  try {
    if (format === "ofx") return parseOfx(content as string);
    if (format === "csv") return parseBankCsv(content as string, mapping);
  } catch (error) { fileError(error); }
  return invalid("erp_reconciliation_format_invalid");
}

function preview(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, false);
  const a = argsOf(raw, ["target", "kind", "format", "content", "mapping", "layout_id"], 2_400_000);
  if (a.target === "bank") {
    const layout = layoutOf(db, a.layout_id, "bank");
    const mapping = mappingOf(a.mapping, "bank") ?? (layout ? parse(layout.mapping) : undefined);
    const file = readBankFile(a.format, a.content, mapping);
    return { target: "bank", format: a.format, period_from: file.period_from, period_to: file.period_to, total: file.lines.length,
      credits_cents: file.lines.reduce((s, l) => s + (BigInt(l.amount_cents) > 0n ? BigInt(l.amount_cents) : 0n), 0n).toString(),
      debits_cents: file.lines.reduce((s, l) => s + (BigInt(l.amount_cents) < 0n ? -BigInt(l.amount_cents) : 0n), 0n).toString(),
      balances: file.balances.length, header: file.header ?? null, mapped: file.mapped ?? null, lines: file.lines.slice(0, 20) };
  }
  if (a.target === "card") {
    const kind = a.kind === "receivables" ? "receivables" : a.kind === "sales" ? "sales" : invalid();
    const layout = layoutOf(db, a.layout_id, "card");
    const mapping = mappingOf(a.mapping, "card") ?? (layout ? parse(layout.mapping) : undefined);
    if (typeof a.content !== "string") invalid("erp_reconciliation_file_missing");
    let file: ReturnType<typeof parseCardCsv>;
    try { file = parseCardCsv(a.content, kind, mapping); } catch (error) { fileError(error); }
    return { target: "card", kind, total: file!.lines.length, skipped: file!.skipped, header: file!.header, mapped: file!.mapped,
      gross_cents: file!.lines.reduce((s, l) => s + BigInt(l.gross_cents), 0n).toString(), lines: file!.lines.slice(0, 20) };
  }
  return invalid();
}

// ---------------------------------------------------------------------------
// Extrato do banco: importar

/** Chave da linha sem identificador do banco: data, valor e descrição (a mesma linha vinda por OFX ou planilha). */
const looseKey = (posted: unknown, amount: unknown, memo: unknown) => `${posted}|${amount}|${plain(memo).slice(0, 120)}`;

function bankImport(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, true);
  const a = argsOf(raw, ["account_id", "format", "file_name", "content", "layout_id", "mapping", "save_layout"], 2_400_000);
  const contentHash = typeof a.content === "string" ? sha256(a.content) : invalid("erp_reconciliation_file_missing");
  const hash = hashOf("bank_import", user, { ...a, content: contentHash });
  const previous = replay(db, command, user, hash);
  if (previous) return previous;
  const accountId = uuidOf(a.account_id)!;
  const account = accountRow(db, accountId);
  if (!bool(account.active)) raise("22023", "erp_reconciliation_account_inactive");
  const format = a.format === "ofx" || a.format === "csv" ? String(a.format) : invalid("erp_reconciliation_format_invalid");
  const fileName = textOf(a.file_name, 200, 1) ?? (format === "ofx" ? "extrato.ofx" : "extrato.csv");
  let layout = format === "csv" ? layoutOf(db, a.layout_id, "bank") : null;
  const mapping = format === "csv" ? (mappingOf(a.mapping, "bank") ?? (layout ? parse(layout.mapping) : undefined)) : undefined;
  const file = readBankFile(format, a.content, mapping);
  // Modelo de colunas salvo pelo banco: na importação, com o nome dado.
  if (format === "csv" && a.save_layout !== undefined && a.save_layout !== null) {
    const s = argsOf(a.save_layout, ["name"]);
    const name = textOf(s.name, 80, 1, "erp_reconciliation_layout_name")!;
    const existing = one(db, `SELECT * FROM "${LAYOUT}" WHERE kind='bank' AND lower(name)=lower(?) AND active=1`, name);
    const id = storeLayout(ctx, user, { id: (existing?.id as string | undefined) ?? null, expected: null, kind: "bank", name, acquirer: null, account: accountId,
      mapping: mapping ?? { columns: {} }, active: true });
    layout = one(db, `SELECT * FROM "${LAYOUT}" WHERE id=?`, id);
  }
  const base = { file_name: fileName, period_from: file.period_from, period_to: file.period_to, total: file.lines.length };
  // O mesmo arquivo de novo: nada a importar.
  if (one(db, 'SELECT 1 x FROM "erp_finance__bank_statement" WHERE account_id=? AND file_hash=? AND deleted_at IS NULL', accountId, contentHash))
    return receipt(ctx, command, user, hash, "bank_import", accountId, null, { ...base, statement_id: null, new_lines: 0, skipped: file.lines.length, duplicate_file: true, balances: 0 });
  // Sem duplicar: o FITID do banco; sem ele, data + valor + descrição (contando as repetidas).
  const existing = db.exec(`SELECT fitid, posted_on, amount_cents, memo FROM "${FIN_LINE}" WHERE account_id=? AND deleted_at IS NULL AND posted_on BETWEEN ? AND ?`,
    accountId, addDays(file.period_from, -1), addDays(file.period_to, 1)).rows;
  const fitids = new Set(existing.map((r) => String(r.fitid)));
  const loose = new Map<string, number>();
  for (const r of existing) loose.set(looseKey(r.posted_on, r.amount_cents, r.memo), (loose.get(looseKey(r.posted_on, r.amount_cents, r.memo)) ?? 0) + 1);
  const used = new Map<string, number>();
  const fresh = file.lines.filter((l) => {
    const synthetic = l.fitid.startsWith("sem-id:") || l.fitid.startsWith("doc:");
    const key = looseKey(l.posted_on, l.amount_cents, l.memo);
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    if (fitids.has(l.fitid)) return false;
    // A linha com FITID do banco vale por si; a sem identificador entra só além das iguais (data, valor e descrição) que já existem.
    return !synthetic || n > (loose.get(key) ?? 0);
  });
  let statement: string | null = null;
  if (fresh.length) {
    const result = execute(ctx, user, command, "import", "statement_import", {
      account_id: accountId, file_name: fileName, file_hash: contentHash, period_from: file.period_from, period_to: file.period_to,
      lines: fresh.map((l) => ({ fitid: l.fitid, posted_on: l.posted_on, amount_cents: l.amount_cents, memo: l.memo, trntype: l.trntype })),
    });
    statement = String(result.record.id);
    const at = now(ctx);
    for (const l of db.exec(`SELECT id FROM "${FIN_LINE}" WHERE statement_id=?`, statement).rows)
      db.exec(`INSERT INTO "${BANK_LINE}"(line_id, source, layout_id, updated_at) VALUES(?,?,?,?)`, l.id, format, (layout?.id as string | undefined) ?? null, at);
  }
  // Saldo do banco por dia: só com um extrato gravado para apontar (o arquivo repetido não muda o saldo).
  let balances = 0;
  const anchor = statement ?? null;
  if (anchor) for (const b of file.balances) {
    db.exec(`INSERT INTO "${BALANCE}"(account_id, day, balance_cents, statement_id, created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id, day) DO UPDATE SET balance_cents=excluded.balance_cents, statement_id=excluded.statement_id, created_at=excluded.created_at`,
    accountId, b.day, b.balance_cents, anchor, now(ctx));
    balances++;
  }
  return receipt(ctx, command, user, hash, "bank_import", accountId, null, {
    ...base, statement_id: statement, new_lines: fresh.length, skipped: file.lines.length - fresh.length, duplicate_file: false, balances,
    layout: layout ? layoutDto(db, layout) : null,
  });
}

// ---------------------------------------------------------------------------
// Extrato do banco: linhas, sugestões e saldo por dia

interface Suggestion {
  type: "movement" | "title" | "card" | "rule";
  confidence: number;
  level: string;
  label: string;
  detail: string | null;
  links?: { kind: "entry" | "movement"; id: string }[];
  titles?: { id: string; version: number; balance_cents: string }[];
  rule_id?: string;
  category_id?: string;
}

interface BankContext {
  account: string;
  movements: Row[];
  titles: Row[];
  rules: Row[];
  cards: { day: string; net: bigint; links: { kind: "movement"; id: string }[]; count: number }[];
}

function bankContext(db: SqlDriver, account: string, lines: Row[]): BankContext {
  const days = lines.map((l) => String(l.posted_on)).sort();
  const from = days.length ? addDays(days[0], -5) : todaySaoPaulo(), to = days.length ? addDays(days.at(-1)!, 5) : todaySaoPaulo();
  const amounts = new Set(lines.map((l) => String(l.amount_cents)));
  const movements = statementLines(db, account, from, to, false).filter((l) => amounts.has(String(l.amount_cents)) && candidateLine(db, l));
  const abs = new Set(lines.map((l) => String(Math.abs(Number(l.amount_cents)))));
  const titles = days.length ? db.exec(
    `SELECT t.id, t.kind, t.version, t.contact_id, t.description, t.due_on, t.amount_cents, t.settled_cents, t.installment, t.installments, r.name contact_name
       FROM "erp_finance__title" t JOIN "erp_catalog__record" r ON r.id=t.contact_id
      WHERE t.cancelled=0 AND t.deleted_at IS NULL AND t.settled_cents<t.amount_cents AND t.due_on BETWEEN ? AND ?`,
    addDays(days[0], -45), addDays(days.at(-1)!, 45)).rows.filter((t) => abs.has(String(Number(t.amount_cents) - Number(t.settled_cents)))) : [];
  const rules = db.exec(`SELECT * FROM "${RULE}" WHERE active=1 AND (account_id IS NULL OR account_id=?) ORDER BY name, id`, account).rows;
  // Recebimentos de cartão já baixados nesta conta e ainda sem a linha do banco: somados por dia.
  const byDay = new Map<string, { net: bigint; links: { kind: "movement"; id: string }[]; count: number }>();
  for (const c of db.exec(`SELECT c.received_on, c.net_cents, m.id movement_id FROM "${CARD_LINE}" c
      JOIN "erp_finance__movement" m ON m.settlement_id=c.settlement_id AND m.kind='payment'
     WHERE c.state='received' AND c.account_id=? AND c.received_on BETWEEN ? AND ?
       AND NOT EXISTS(SELECT 1 FROM "erp_finance__reconciliation_link" k WHERE k.movement_id=m.id AND k.undone_at IS NULL)`, account, from, to).rows) {
    const d = byDay.get(String(c.received_on)) ?? { net: 0n, links: [], count: 0 };
    d.net += BigInt(String(c.net_cents));
    d.links.push({ kind: "movement", id: String(c.movement_id) });
    d.count++;
    byDay.set(String(c.received_on), d);
  }
  return { account, movements, titles, rules, cards: [...byDay].map(([day, d]) => ({ day, ...d })) };
}

const KIND_LABEL: Record<string, string> = { entry: "Lançamento de caixa", transfer: "Transferência", settlement: "Baixa de conta" };

function suggestionsFor(db: SqlDriver, line: Row, c: BankContext): Suggestion[] {
  const out: Suggestion[] = [];
  const amount = BigInt(String(line.amount_cents));
  const posted = String(line.posted_on), memo = line.memo;
  const dismissed = (kind: string, id: unknown) => !!one(db, 'SELECT 1 x FROM "erp_finance__bank_line_dismissal" WHERE line_id=? AND target_kind=? AND target_id=?', line.id, kind, id);
  for (const m of c.movements) {
    if (String(m.amount_cents) !== amount.toString()) continue;
    const days = dayDiff(String(m.posted_on), posted);
    if (days > 5) continue;
    const kind = m.line_kind === "entry" ? "entry" : "movement";
    const id = String(m.line_kind === "entry" ? m.entry_id : m.line_id);
    if (dismissed(kind, id)) continue;
    const contact = recordName(db, m.contact_id);
    const confidence = movementScore(days, Math.max(nameMatch(memo, contact), nameMatch(memo, m.note)));
    out.push({ type: "movement", confidence, level: confidenceLabel(confidence), label: `${KIND_LABEL[String(m.line_kind)] ?? "Lançamento"} de ${brl(m.amount_cents as string)} em ${String(m.posted_on).split("-").reverse().join("/")}`,
      detail: [contact, left(m.note, 120)].filter(Boolean).join(" · ") || null, links: [{ kind, id }] });
  }
  const kind = amount > 0n ? "receivable" : "payable";
  for (const t of c.titles) {
    if (t.kind !== kind) continue;
    const balance = BigInt(String(t.amount_cents)) - BigInt(String(t.settled_cents));
    if (balance !== (amount < 0n ? -amount : amount)) continue;
    const days = dayDiff(String(t.due_on), posted);
    const ratio = nameMatch(memo, t.contact_name);
    if (days > 15 && ratio < 0.5) continue;
    const confidence = titleScore(true, days, ratio);
    out.push({ type: "title", confidence, level: confidenceLabel(confidence),
      label: `${kind === "receivable" ? "Receber" : "Pagar"} ${left(t.contact_name, 80)}: ${brl(balance)}, vence ${String(t.due_on).split("-").reverse().join("/")}`,
      detail: `${left(t.description, 120)}${Number(t.installments) > 1 ? ` (parcela ${t.installment}/${t.installments})` : ""}`,
      titles: [{ id: String(t.id), version: Number(t.version), balance_cents: balance.toString() }] });
  }
  if (amount > 0n) for (const d of c.cards) {
    const days = dayDiff(d.day, posted);
    if (d.net !== amount || days > 3) continue;
    const confidence = Math.max(70, 94 - days * 6);
    out.push({ type: "card", confidence, level: confidenceLabel(confidence), label: `Recebimento de cartão de ${d.day.split("-").reverse().join("/")}: ${d.count} venda${d.count > 1 ? "s" : ""}, ${brl(d.net)}`,
      detail: null, links: d.links });
  }
  for (const r of c.rules) {
    if ((r.direction === "in" && amount < 0n) || (r.direction === "out" && amount > 0n)) continue;
    if (!ruleMatches(memo, String(r.pattern))) continue;
    const category = categoryRow(db, r.category_id);
    if (!category || category.kind !== kind) continue;
    out.push({ type: "rule", confidence: 88, level: confidenceLabel(88), label: `Regra "${left(r.name, 60)}": lançar em ${left(category.name, 80)}`,
      detail: r.contact_id ? recordName(db, r.contact_id) : null, rule_id: String(r.id), category_id: String(r.category_id) });
  }
  return out.sort((x, y) => y.confidence - x.confidence || x.type.localeCompare(y.type)).slice(0, 5);
}

function bankLineView(db: SqlDriver, line: Row, c: BankContext | null) {
  const dto = bankLineDto(db, String(line.id), false);
  const extra = one(db, `SELECT source, layout_id, ignored_reason, ignored_at FROM "${BANK_LINE}" WHERE line_id=?`, line.id);
  const state = line.state === "hidden" ? "ignored" : String(line.state);
  return {
    id: dto.id, statement_id: dto.statement_id, posted_on: dto.posted_on, amount_cents: dto.amount_cents, memo: dto.memo, trntype: dto.trntype,
    state, version: Number(dto.version), source: (extra?.source as string | undefined) ?? "ofx",
    ignored_reason: state === "ignored" ? ((extra?.ignored_reason as string | null | undefined) ?? null) : null,
    links: dto.links.filter(Boolean),
    suggestions: c && line.state === "pending" ? suggestionsFor(db, line, c) : [],
  };
}

/** Saldo do sistema (Caixas e bancos) x saldo do banco (extrato importado), no fim de cada dia do período. */
export function dailyBalances(db: SqlDriver, account: string, from: string, to: string) {
  const all = statementLines(db, account, null, to, false);
  const byDay = new Map<string, bigint>();
  let before = 0n;
  for (const l of all) {
    const d = String(l.posted_on), v = BigInt(String(l.amount_cents));
    if (d < from) before += v;
    else byDay.set(d, (byDay.get(d) ?? 0n) + v);
  }
  const bank = db.exec(`SELECT day, balance_cents FROM "${BALANCE}" WHERE account_id=? AND day<=? ORDER BY day`, account, to).rows;
  const lineDays = db.exec(`SELECT DISTINCT posted_on FROM "${FIN_LINE}" WHERE account_id=? AND deleted_at IS NULL AND posted_on BETWEEN ? AND ?`, account, from, to).rows
    .map((r) => String(r.posted_on));
  const days = [...new Set([...byDay.keys(), ...lineDays, ...bank.filter((b) => String(b.day) >= from).map((b) => String(b.day))])].sort();
  let system = before;
  let bi = 0;
  let lastBank: bigint | null = null;
  const firstBank = bank.length ? String(bank[0].day) : null;
  const out: { day: string; system_cents: string; bank_cents: string | null; difference_cents: string | null }[] = [];
  for (const d of days) {
    system += byDay.get(d) ?? 0n;
    while (bi < bank.length && String(bank[bi].day) <= d) { lastBank = BigInt(String(bank[bi].balance_cents)); bi++; }
    const known = firstBank !== null && d >= firstBank ? lastBank : null;
    out.push({ day: d, system_cents: system.toString(), bank_cents: known === null ? null : known.toString(), difference_cents: known === null ? null : (known - system).toString() });
  }
  return out;
}

function bankLines(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  const role = access(db, user, false);
  const a = argsOf(raw, ["account_id", "state", "from", "to", "search"]);
  const accountId = uuidOf(a.account_id)!;
  const account = accountRow(db, accountId);
  const state = a.state === undefined || a.state === null || a.state === "" ? "pending" : String(a.state);
  if (!["pending", "reconciled", "ignored", "all"].includes(state)) invalid();
  let from = dayOf(a.from), to = dayOf(a.to);
  if (from && to && from > to) invalid("erp_reconciliation_period_invalid");
  const search = textOf(a.search, 100);
  const finState = state === "ignored" ? "hidden" : state;
  const rows = db.exec(
    `SELECT * FROM "${FIN_LINE}" WHERE account_id=? AND deleted_at IS NULL AND (?='all' OR state=?) AND (? IS NULL OR posted_on>=?) AND (? IS NULL OR posted_on<=?)
     ORDER BY posted_on, fitid, id`, accountId, finState, finState, from, from, to, to,
  ).rows.filter((l) => !search || plain(l.memo).includes(plain(search)) || brl(String(Math.abs(Number(l.amount_cents)))).includes(search.replace(/^R\$\s*/, "")));
  const shown = rows.slice(0, BANK_LINES_LIMIT);
  const context = shown.some((l) => l.state === "pending") ? bankContext(db, accountId, shown.filter((l) => l.state === "pending")) : null;
  const counts = one(db, `SELECT sum(state='pending') pending, sum(state='reconciled') reconciled, sum(state='hidden') ignored FROM "${FIN_LINE}" WHERE account_id=? AND deleted_at IS NULL`, accountId)!;
  // Saldo por dia: o período pedido, ou o das linhas mostradas (no máximo 120 dias para trás).
  const days = shown.map((l) => String(l.posted_on)).sort();
  const lastLine = one(db, `SELECT max(posted_on) d FROM "${FIN_LINE}" WHERE account_id=? AND deleted_at IS NULL`, accountId)?.d as string | null;
  // Até o último dia com linha ou com saldo do banco (o fim do extrato importado).
  const lastBalance = one(db, `SELECT max(day) d FROM "${BALANCE}" WHERE account_id=?`, accountId)?.d as string | null;
  to ??= [days.at(-1) ?? lastLine, lastBalance].filter((d): d is string => !!d).sort().at(-1) ?? todaySaoPaulo();
  from ??= days[0] && days[0] >= addDays(to!, -120) ? days[0] : addDays(to!, -30);
  const statements = db.exec(`SELECT id, file_name, created_at, period_from, period_to, new_lines FROM "erp_finance__bank_statement" WHERE account_id=? AND deleted_at IS NULL
    ORDER BY created_at DESC, id LIMIT 20`, accountId).rows.map((s) => ({ id: s.id, file_name: s.file_name, period_from: s.period_from, period_to: s.period_to, new_lines: Number(s.new_lines) }));
  return {
    role, can_write: canWrite(role),
    account: { id: account.id, name: left(account.name, 200), kind: account.kind },
    state, counts: { pending: Number(counts.pending ?? 0), reconciled: Number(counts.reconciled ?? 0), ignored: Number(counts.ignored ?? 0) },
    lines: shown.map((l) => bankLineView(db, l, context)), truncated: rows.length > shown.length,
    balances: dailyBalances(db, accountId, from!, to!), period: { from, to }, statements,
  };
}

// ---------------------------------------------------------------------------
// Extrato do banco: ações

const BANK_ACTIONS = ["confirm", "settle", "rule_entry", "create_entry", "ignore", "unignore", "undo"];

function bankAction(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, true);
  const a = argsOf(raw, ["line_id", "expected_version", "action", "links", "titles", "rule_id", "category_id", "contact_id", "note", "reason", "reverse"]);
  const hash = hashOf("bank_action", user, a);
  const previous = replay(db, command, user, hash);
  if (previous) return previous;
  const action = BANK_ACTIONS.includes(a.action) ? String(a.action) : invalid("erp_reconciliation_action_invalid");
  const lineId = uuidOf(a.line_id)!;
  const line = one(db, `SELECT * FROM "${FIN_LINE}" WHERE id=? AND deleted_at IS NULL`, lineId);
  if (!line) raise("P0002", "erp_reconciliation_line_not_found");
  const expected = versionOf(a.expected_version);
  if (Number(line!.version) !== expected) raise("40001", "erp_reconciliation_version_conflict");
  const before = bankLineView(db, line!, null);
  const amount = BigInt(String(line!.amount_cents));
  const base = { line_id: lineId, expected_version: expected };
  const at = now(ctx);
  if (action === "confirm") {
    if (!Array.isArray(a.links) || a.links.length < 1 || a.links.length > 50) invalid("erp_reconciliation_links_invalid");
    const links = (a.links as unknown[]).map((k) => {
      const o = argsOf(k, ["kind", "id"]);
      return { kind: o.kind === "entry" ? "entry" : o.kind === "movement" ? "movement" : invalid("erp_reconciliation_links_invalid"), id: uuidOf(o.id)! };
    });
    execute(ctx, user, command, "reconcile", "line_reconcile", { ...base, links });
  } else if (action === "settle") {
    if (!Array.isArray(a.titles) || a.titles.length < 1 || a.titles.length > 50) invalid("erp_reconciliation_titles_invalid");
    let remaining = amount < 0n ? -amount : amount;
    const items = (a.titles as unknown[]).map((raw) => {
      const o = argsOf(raw, ["id", "expected_version", "amount_cents"]);
      const id = uuidOf(o.id)!;
      const t = one(db, 'SELECT id, version, amount_cents, settled_cents FROM "erp_finance__title" WHERE id=?', id);
      if (!t) raise("P0002", "erp_reconciliation_title_not_found");
      const balance = BigInt(String(t!.amount_cents)) - BigInt(String(t!.settled_cents));
      const value = o.amount_cents === undefined || o.amount_cents === null ? (balance < remaining ? balance : remaining) : centsOf(o.amount_cents, "erp_reconciliation_titles_invalid");
      remaining -= value;
      return { id, expected_version: o.expected_version === undefined ? Number(t!.version) : versionOf(o.expected_version), principal_cents: value.toString() };
    });
    execute(ctx, user, command, "settle", "line_settle_titles", { ...base, items });
  } else if (action === "rule_entry" || action === "create_entry") {
    let category = uuidOf(a.category_id, false), contact = uuidOf(a.contact_id, false);
    let note = textOf(a.note, 2000);
    if (action === "rule_entry") {
      const rule = one(db, `SELECT * FROM "${RULE}" WHERE id=? AND active=1`, uuidOf(a.rule_id));
      if (!rule) raise("P0002", "erp_reconciliation_rule_not_found");
      category = String(rule!.category_id);
      contact = (rule!.contact_id as string | null) ?? contact;
      note = note ?? (rule!.note ? `${rule!.note} - Criado via conciliação` : null);
    }
    if (!category) invalid("erp_reconciliation_category_missing");
    const c = categoryRow(db, category);
    if (!c) raise("22023", "erp_reconciliation_rule_category");
    if (c!.kind !== (amount > 0n ? "receivable" : "payable")) raise("22023", "erp_reconciliation_category_kind");
    execute(ctx, user, command, "entry", "line_create_entry", { ...base, category_id: category, contact_id: contact, note });
  } else if (action === "ignore") {
    const reason = textOf(a.reason, 500, 3, "erp_reconciliation_reason_required")!;
    execute(ctx, user, command, "hide", "line_hide", base);
    db.exec(`INSERT INTO "${BANK_LINE}"(line_id, source, layout_id, ignored_reason, ignored_by, ignored_at, updated_at) VALUES(?, 'ofx', NULL, ?, ?, ?, ?)
      ON CONFLICT(line_id) DO UPDATE SET ignored_reason=excluded.ignored_reason, ignored_by=excluded.ignored_by, ignored_at=excluded.ignored_at, updated_at=excluded.updated_at`,
    lineId, reason, user, at, at);
  } else if (action === "unignore") {
    execute(ctx, user, command, "show", "line_show", base);
    db.exec(`UPDATE "${BANK_LINE}" SET ignored_reason=NULL, ignored_by=NULL, ignored_at=NULL, updated_at=? WHERE line_id=?`, at, lineId);
  } else {
    if (a.reverse !== undefined && typeof a.reverse !== "boolean") invalid();
    execute(ctx, user, command, "undo", "line_unreconcile", { ...base, reverse: a.reverse === true });
  }
  const fresh = one(db, `SELECT * FROM "${FIN_LINE}" WHERE id=?`, lineId)!;
  return receipt(ctx, command, user, hash, `bank_${action}`, lineId, before, { action, line: bankLineView(db, fresh, null) });
}

// ---------------------------------------------------------------------------
// Cartão: taxas contratadas

function rateSave(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, true);
  const a = argsOf(raw, ["id", "expected_version", "acquirer", "brand", "product", "installments_from", "installments_to", "rate_bp", "fixed_cents", "settle_days", "active"]);
  const hash = hashOf("rate_save", user, a);
  const previous = replay(db, command, user, hash);
  if (previous) return previous;
  const id = uuidOf(a.id, false);
  const acquirer = acquirerOf(a.acquirer);
  const brand = (BRANDS as readonly string[]).includes(a.brand) ? String(a.brand) : invalid("erp_reconciliation_rate_invalid");
  const product = a.product === "debit" || a.product === "credit" ? String(a.product) : invalid("erp_reconciliation_rate_invalid");
  const from = intOf(a.installments_from ?? 1, 1, 99, "erp_reconciliation_rate_invalid"), to = intOf(a.installments_to ?? from, from, 99, "erp_reconciliation_rate_invalid");
  if (product === "debit" && (from !== 1 || to !== 1)) raise("22023", "erp_reconciliation_rate_debit_installments");
  const rate = intOf(a.rate_bp, 0, 10000, "erp_reconciliation_rate_invalid");
  const fixed = Number(centsOf(a.fixed_cents ?? "0", "erp_reconciliation_rate_invalid"));
  if (fixed > 100000) invalid("erp_reconciliation_rate_invalid");
  const days = intOf(a.settle_days ?? (product === "debit" ? 1 : 30), 0, 400, "erp_reconciliation_rate_invalid");
  const active = a.active === undefined ? true : a.active === true;
  const overlap = active ? one(db, `SELECT id FROM "${RATE}" WHERE active=1 AND acquirer=? AND brand=? AND product=? AND installments_from<=? AND installments_to>=? AND id<>coalesce(?, '')`,
    acquirer, brand, product, to, from, id) : null;
  if (overlap) raise("23505", "erp_reconciliation_rate_overlap");
  const at = now(ctx);
  let target = id, before: unknown = null;
  if (id) {
    const old = one(db, `SELECT * FROM "${RATE}" WHERE id=?`, id);
    if (!old) raise("P0002", "erp_reconciliation_rate_not_found");
    if (Number(old!.version) !== versionOf(a.expected_version)) raise("40001", "erp_reconciliation_version_conflict");
    before = rateDto(old!);
    db.exec(`UPDATE "${RATE}" SET acquirer=?, brand=?, product=?, installments_from=?, installments_to=?, rate_bp=?, fixed_cents=?, settle_days=?, active=?, version=version+1,
      updated_at=?, updated_by=? WHERE id=?`, acquirer, brand, product, from, to, rate, fixed, days, active ? 1 : 0, at, user, id);
  } else {
    target = crypto.randomUUID();
    db.exec(`INSERT INTO "${RATE}"(id, acquirer, brand, product, installments_from, installments_to, rate_bp, fixed_cents, settle_days, active, version, created_at, updated_at, updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)`, target, acquirer, brand, product, from, to, rate, fixed, days, active ? 1 : 0, at, at, user);
  }
  return receipt(ctx, command, user, hash, "rate_save", target!, before, { rate: rateDto(one(db, `SELECT * FROM "${RATE}" WHERE id=?`, target)!) });
}

// ---------------------------------------------------------------------------
// Cartão: casamento com as vendas do PDV e dos pedidos

/**
 * Forma de pagamento da conta a receber: a da conta (pedidos) ou a do pagamento
 * da venda do PDV (o PDV guarda a forma em erp_pos__sale_payment, não na conta).
 */
const CARD_METHOD_JOIN = `LEFT JOIN "erp_catalog__payment_method" m ON m.id=t.payment_method_id
  LEFT JOIN "erp_pos__sale_payment" pp ON pp.title_id=t.id LEFT JOIN "erp_catalog__payment_method" pm ON pm.id=pp.payment_method_id`;
const CARD_METHOD_WHERE = `(coalesce(m.payment_type, pp.payment_type) IN ('03','04') OR coalesce(m.card_brand, pm.card_brand) IS NOT NULL)`;
/** Contas a receber de cartão (forma de pagamento crédito ou débito, ou com bandeira) perto das datas das linhas. */
function cardTitles(db: SqlDriver, from: string, to: string): Row[] {
  return db.exec(
    `SELECT t.id, t.group_id, t.version, t.contact_id, t.description, t.source_reference, t.history, t.issued_on, t.due_on, t.amount_cents, t.settled_cents,
            t.installment, t.installments, coalesce(m.payment_type, pp.payment_type) payment_type, coalesce(m.card_brand, pm.card_brand) card_brand,
            coalesce(m.description, pp.method_name) method_name
       FROM "erp_finance__title" t ${CARD_METHOD_JOIN}
      WHERE t.kind='receivable' AND t.cancelled=0 AND t.deleted_at IS NULL AND t.issued_on BETWEEN ? AND ? AND ${CARD_METHOD_WHERE}`, from, to).rows;
}
const titleProduct = (t: Row) => (t.payment_type === "04" ? "debit" : t.payment_type === "03" ? "credit" : null);
const titleBrand = (t: Row) => (typeof t.card_brand === "string" ? BRAND_BY_CODE[t.card_brand] ?? "outros" : null);
const referenced = (t: Row, line: { nsu: string | null; authorization: string | null }) => {
  const text = [t.source_reference, t.history, t.description].filter(Boolean).join(" ");
  return (!!line.nsu && line.nsu.length >= 4 && text.includes(line.nsu)) || (!!line.authorization && line.authorization.length >= 4 && text.includes(line.authorization));
};

/** Contas de cartão por dia de emissão e de vencimento (a busca olha só cinco dias para cada lado). */
export class CardTitleIndex {
  private readonly issued = new Map<string, Row[]>();
  private readonly due = new Map<string, Row[]>();
  constructor(titles: Row[]) {
    for (const t of titles) {
      this.issued.set(String(t.issued_on), [...(this.issued.get(String(t.issued_on)) ?? []), t]);
      this.due.set(String(t.due_on), [...(this.due.get(String(t.due_on)) ?? []), t]);
    }
  }
  near(day: string | null, by: "issued" | "due"): Row[] {
    if (!day) return [];
    const map = by === "issued" ? this.issued : this.due;
    const out: Row[] = [];
    for (let n = -5; n <= 5; n++) out.push(...(map.get(addDays(day, n)) ?? []));
    return out;
  }
}

/** A melhor conta (recebível) ou o melhor grupo de contas (venda) para a linha, com a confiança; null abaixo de 50. */
type CardMatch = { title_id: string | null; group_id: string | null; confidence: number };
function bestCardMatch(line: CardLine, index: CardTitleIndex, taken: Set<string>): CardMatch | null {
  const [best] = cardCandidates(line, index, taken);
  return best && best.confidence >= 50 ? best : null;
}
/** As contas (ou grupos) possíveis para a linha, da mais provável para a menos. */
function cardCandidates(line: CardLine, index: CardTitleIndex, taken: Set<string>): CardMatch[] {
  const titles = line.sold_on ? index.near(line.sold_on, "issued") : index.near(line.expected_on, "due");
  const gross = BigInt(line.gross_cents);
  const out: CardMatch[] = [];
  const consider = (title: string | null, group: string | null, score: number) => {
    if (score > 0) out.push({ title_id: title, group_id: group, confidence: score });
  };
  if (line.kind === "receivable") {
    for (const t of titles) {
      if (taken.has(String(t.id))) continue;
      const amount = BigInt(String(t.amount_cents));
      const diff = amount > gross ? amount - gross : gross - amount;
      const brand = titleBrand(t), product = titleProduct(t);
      consider(String(t.id), String(t.group_id), cardScore({
        amountEqual: diff === 0n, amountNear: diff <= BigInt(line.installments), days: line.sold_on ? dayDiff(String(t.issued_on), line.sold_on) : line.expected_on ? Math.max(0, dayDiff(String(t.due_on), line.expected_on) - 2) : null,
        brandKnown: !!brand && line.brand !== "outros", brandEqual: brand === line.brand, installmentsEqual: Number(t.installments) === line.installments,
        installmentEqual: Number(t.installment) === line.installment, productEqual: product === null ? null : product === line.product, referenceEqual: referenced(t, line),
      }));
    }
  } else {
    const groups = new Map<string, Row[]>();
    for (const t of titles) groups.set(String(t.group_id), [...(groups.get(String(t.group_id)) ?? []), t]);
    for (const [group, items] of groups) {
      if (items.some((t) => taken.has(`g:${group}`))) continue;
      const amount = items.reduce((s, t) => s + BigInt(String(t.amount_cents)), 0n);
      const diff = amount > gross ? amount - gross : gross - amount;
      const first = items[0], brand = titleBrand(first), product = titleProduct(first);
      const single = items.length === 1 && line.installments === 1;
      consider(single ? String(first.id) : null, group, cardScore({
        amountEqual: diff === 0n, amountNear: diff <= BigInt(line.installments), days: line.sold_on ? dayDiff(String(first.issued_on), line.sold_on) : null,
        brandKnown: !!brand && line.brand !== "outros", brandEqual: brand === line.brand, installmentsEqual: Number(first.installments) === line.installments,
        installmentEqual: null, productEqual: product === null ? null : product === line.product, referenceEqual: items.some((t) => referenced(t, line)),
      }));
    }
  }
  return out.sort((x, y) => y.confidence - x.confidence || String(x.title_id ?? x.group_id).localeCompare(String(y.title_id ?? y.group_id)));
}
const rowToCardLine = (r: Row) => ({
  kind: r.kind, sold_on: r.sold_on, expected_on: r.expected_on, brand: r.brand, product: r.product, installment: Number(r.installment), installments: Number(r.installments),
  gross_cents: String(r.gross_cents), fee_cents: String(r.fee_cents), net_cents: String(r.net_cents), nsu: r.nsu, authorization: r.authorization, description: r.description,
}) as CardLine;

/** Outras vendas possíveis para a linha da adquirente (para casar à mão). */
function cardCandidatesRead(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, false);
  const a = argsOf(raw, ["line_id"]);
  const r = one(db, `SELECT * FROM "${CARD_LINE}" WHERE id=?`, uuidOf(a.line_id));
  if (!r) raise("P0002", "erp_reconciliation_card_line_not_found");
  const line = rowToCardLine(r!);
  const day = line.sold_on ?? line.expected_on!;
  const index = new CardTitleIndex(cardTitles(db, addDays(day, line.sold_on ? -6 : -400), addDays(day, 6)));
  const list = cardCandidates(line, index, takenTitles(db, line.kind, String(r!.id))).slice(0, 15);
  return { line_id: r!.id, candidates: list.map((c) => ({ confidence: c.confidence, level: confidenceLabel(c.confidence), title: c.title_id ? titleView(db, c.title_id, ctx.parts) : null,
    group: c.title_id ? null : groupView(db, c.group_id) })) };
}

/** Lançamentos e contas para conciliar a linha do banco à mão (a busca do Financeiro, no mês em volta da data). */
function bankCandidates(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, false);
  const a = argsOf(raw, ["line_id", "search", "from", "to"]);
  const line = one(db, `SELECT * FROM "${FIN_LINE}" WHERE id=? AND deleted_at IS NULL`, uuidOf(a.line_id));
  if (!line) raise("P0002", "erp_reconciliation_line_not_found");
  const posted = String(line!.posted_on);
  const from = dayOf(a.from) ?? addDays(posted, -30), to = dayOf(a.to) ?? addDays(posted, 30);
  if (from > to) invalid("erp_reconciliation_period_invalid");
  return financeCall(ctx, "erp_finance_reconciliation_candidates", { p_user_id: user, p_account: line!.account_id, p_from: from, p_to: to,
    p_query: textOf(a.search, 120), p_amount_cents: null });
}
/** Contas (e grupos) já casadas com outra linha confirmada do mesmo tipo. */
function takenTitles(db: SqlDriver, kind: "sale" | "receivable", except: string | null = null) {
  const set = new Set<string>();
  for (const r of db.exec(`SELECT title_id, group_id FROM "${CARD_LINE}" WHERE kind=? AND state IN ('matched','received') AND id<>coalesce(?, '')`, kind, except).rows) {
    if (kind === "receivable" && r.title_id) set.add(String(r.title_id));
    if (kind === "sale" && r.group_id) set.add(`g:${r.group_id}`);
  }
  return set;
}

function cardImport(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, true);
  const a = argsOf(raw, ["acquirer", "kind", "file_name", "content", "layout_id", "mapping", "save_layout"], 2_400_000);
  const contentHash = typeof a.content === "string" ? sha256(a.content) : invalid("erp_reconciliation_file_missing");
  const hash = hashOf("card_import", user, { ...a, content: contentHash });
  const previous = replay(db, command, user, hash);
  if (previous) return previous;
  const acquirer = acquirerOf(a.acquirer);
  const kind = a.kind === "receivables" ? "receivables" : a.kind === "sales" ? "sales" : invalid();
  const fileName = textOf(a.file_name, 200, 1) ?? `${acquirer}-${kind}.csv`;
  let layout = layoutOf(db, a.layout_id, "card");
  const mapping = mappingOf(a.mapping, "card") ?? (layout ? parse(layout.mapping) : undefined);
  let file: ReturnType<typeof parseCardCsv>;
  try { file = parseCardCsv(a.content as string, kind, mapping); } catch (error) { fileError(error); }
  if (a.save_layout !== undefined && a.save_layout !== null) {
    const s = argsOf(a.save_layout, ["name"]);
    const name = textOf(s.name, 80, 1, "erp_reconciliation_layout_name")!;
    const existing = one(db, `SELECT * FROM "${LAYOUT}" WHERE kind='card' AND lower(name)=lower(?) AND active=1`, name);
    const id = storeLayout(ctx, user, { id: (existing?.id as string | undefined) ?? null, expected: null, kind: "card", name, acquirer, account: null, mapping: mapping ?? { columns: {} }, active: true });
    layout = one(db, `SELECT * FROM "${LAYOUT}" WHERE id=?`, id);
  }
  if (one(db, `SELECT 1 x FROM "${IMPORT}" WHERE acquirer=? AND kind=? AND file_hash=?`, acquirer, kind, contentHash))
    return receipt(ctx, command, user, hash, "card_import", acquirer, null, { acquirer, kind, total: file!.lines.length, new_lines: 0, duplicate_file: true, matched: 0 });
  const id = crypto.randomUUID(), at = now(ctx);
  db.exec(`INSERT INTO "${IMPORT}"(id, acquirer, kind, file_name, file_hash, layout_id, lines, new_lines, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,0,?,?,?)`,
    id, acquirer, kind, fileName, contentHash, (layout?.id as string | undefined) ?? null, file!.lines.length, user, command, at);
  const seen = new Map<string, number>();
  const days = file!.lines.flatMap((l) => [l.sold_on, l.expected_on]).filter((d): d is string => !!d).sort();
  // Contas emitidas até 400 dias antes (o recebível de 12x cai um ano depois da venda).
  const index = new CardTitleIndex(days.length ? cardTitles(db, addDays(days[0], -400), addDays(days.at(-1)!, 5)) : []);
  const lineKind = kind === "sales" ? "sale" : "receivable";
  const taken = takenTitles(db, lineKind);
  let fresh = 0, suggested = 0;
  for (const l of file!.lines) {
    const dedup = sha256(cardDedupSource(l, seen));
    if (one(db, `SELECT 1 x FROM "${CARD_LINE}" WHERE acquirer=? AND kind=? AND dedup_key=?`, acquirer, l.kind, dedup)) continue;
    const match = bestCardMatch(l, index, taken);
    if (match) suggested++;
    db.exec(`INSERT INTO "${CARD_LINE}"(id, import_id, kind, acquirer, dedup_key, sold_on, expected_on, brand, product, installment, installments, gross_cents, fee_cents, net_cents,
      nsu, "authorization", description, state, title_id, group_id, confidence, version, created_at, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,1,?,?,?)`,
    crypto.randomUUID(), id, l.kind, acquirer, dedup, l.sold_on, l.expected_on, l.brand, l.product, l.installment, l.installments, l.gross_cents, l.fee_cents, l.net_cents,
    l.nsu, l.authorization, l.description, match?.title_id ?? null, match?.group_id ?? null, match?.confidence ?? null, at, at, user);
    fresh++;
  }
  db.exec(`UPDATE "${IMPORT}" SET new_lines=? WHERE id=?`, fresh, id);
  return receipt(ctx, command, user, hash, "card_import", id, null, {
    import_id: id, acquirer, kind, total: file!.lines.length, new_lines: fresh, skipped: file!.lines.length - fresh, ignored_rows: file!.skipped, duplicate_file: false,
    suggested, layout: layout ? layoutDto(db, layout) : null,
  });
}

function titleView(db: SqlDriver, id: unknown, parts: RpcContext["parts"]) {
  if (typeof id !== "string") return null;
  const t = one(db, `SELECT t.id, t.version, t.description, t.issued_on, t.due_on, t.amount_cents, t.settled_cents, t.installment, t.installments, t.contact_id, t.group_id
    FROM "erp_finance__title" t WHERE t.id=?`, id);
  if (!t) return null;
  const pos = parts.pos !== false ? one(db, `SELECT s.document_id, d.number FROM "erp_pos__sale_payment" p JOIN "erp_pos__sale" s ON s.id=p.sale_id
    JOIN "erp_documents__document" d ON d.id=s.document_id WHERE p.title_id=? LIMIT 1`, id) : null;
  const doc = !pos && parts.sales !== false ? one(db, `SELECT d.kind, d.number FROM "erp_finance__document_title" l JOIN "erp_finance__document_posting" p ON p.id=l.posting_id
    JOIN "erp_documents__document" d ON d.id=p.document_id WHERE l.title_id=? LIMIT 1`, id) : null;
  return {
    id: t.id, version: Number(t.version), description: left(t.description, 200), contact_name: recordName(db, t.contact_id), issued_on: t.issued_on, due_on: t.due_on,
    amount_cents: String(t.amount_cents), balance_cents: (BigInt(String(t.amount_cents)) - BigInt(String(t.settled_cents))).toString(),
    installment: Number(t.installment), installments: Number(t.installments),
    origin: pos ? `Venda do PDV nº ${pos.number}` : doc ? `${doc.kind === "sales_orders" ? "Pedido de venda" : "Documento"} nº ${doc.number}` : null,
  };
}
function groupView(db: SqlDriver, group: unknown) {
  if (typeof group !== "string") return null;
  const rows = db.exec(`SELECT id, contact_id, description, issued_on, amount_cents, settled_cents FROM "erp_finance__title" WHERE group_id=? AND deleted_at IS NULL ORDER BY installment`, group).rows;
  if (!rows.length) return null;
  return { id: group, contact_name: recordName(db, rows[0].contact_id), description: left(rows[0].description, 200), issued_on: rows[0].issued_on, installments: rows.length,
    amount_cents: rows.reduce((s, r) => s + BigInt(String(r.amount_cents)), 0n).toString() };
}

function cardLineView(db: SqlDriver, r: Row, rates: Row[], parts: RpcContext["parts"]) {
  const gross = BigInt(String(r.gross_cents)), fee = BigInt(String(r.fee_cents));
  const rate = rateFor(rates.map((x) => ({ ...x, acquirer: String(x.acquirer), brand: String(x.brand), product: String(x.product), installments_from: Number(x.installments_from),
    installments_to: Number(x.installments_to), rate_bp: Number(x.rate_bp), fixed_cents: Number(x.fixed_cents), settle_days: Number(x.settle_days) })),
  String(r.acquirer), String(r.brand), String(r.product), Number(r.installments));
  const expected = rate ? expectedFee(gross, rate.rate_bp, rate.fixed_cents) : null;
  const diff = expected === null ? null : fee - expected;
  const contractedDay = rate && r.sold_on ? addDays(String(r.sold_on), rate.settle_days * (r.kind === "receivable" ? Number(r.installment) : 1)) : null;
  return {
    id: r.id, kind: r.kind, acquirer: r.acquirer, acquirer_name: acquirerName(String(r.acquirer)), sold_on: r.sold_on, expected_on: r.expected_on,
    brand: r.brand, brand_label: BRAND_LABEL[r.brand as keyof typeof BRAND_LABEL] ?? r.brand, product: r.product, installment: Number(r.installment), installments: Number(r.installments),
    gross_cents: gross.toString(), fee_cents: fee.toString(), net_cents: String(r.net_cents), nsu: r.nsu, authorization: r.authorization, description: r.description,
    state: r.state, version: Number(r.version), confidence: r.confidence === null ? null : Number(r.confidence), level: r.confidence === null ? null : confidenceLabel(Number(r.confidence)),
    title: titleView(db, r.title_id, parts), group: r.title_id ? null : groupView(db, r.group_id),
    fee: {
      charged_rate_bp: chargedRateBp(gross, fee), contracted_rate_bp: rate ? rate.rate_bp : null, contracted_fixed_cents: rate ? String(rate.fixed_cents) : null,
      expected_cents: expected === null ? null : expected.toString(), difference_cents: diff === null ? null : diff.toString(),
      above_contract: diff !== null && diff > 1n, contracted_day: contractedDay,
      late: !!contractedDay && !!r.expected_on && String(r.expected_on) > contractedDay,
    },
    received: r.settlement_id ? { settlement_id: r.settlement_id, account_id: r.account_id, received_on: r.received_on } : null,
    ignored_reason: r.ignored_reason,
  };
}

function cardLines(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  const role = access(db, user, false);
  const a = argsOf(raw, ["kind", "state", "acquirer", "from", "to", "search", "divergent"]);
  const kind = a.kind === undefined || a.kind === null || a.kind === "" || a.kind === "all" ? null : a.kind === "sale" || a.kind === "receivable" ? String(a.kind) : invalid();
  const state = a.state === undefined || a.state === null || a.state === "" || a.state === "all" ? null
    : ["pending", "matched", "received", "ignored", "open"].includes(a.state) ? String(a.state) : invalid();
  const acquirer = a.acquirer ? acquirerOf(a.acquirer) : null;
  const from = dayOf(a.from), to = dayOf(a.to);
  const search = textOf(a.search, 60);
  const rates = db.exec(`SELECT * FROM "${RATE}" WHERE active=1`).rows;
  const rows = db.exec(`SELECT * FROM "${CARD_LINE}" WHERE (? IS NULL OR kind=?) AND (? IS NULL OR acquirer=?)
      AND (? IS NULL OR (?='open' AND state IN ('pending','matched')) OR state=?)
      AND (? IS NULL OR coalesce(sold_on, expected_on)>=?) AND (? IS NULL OR coalesce(sold_on, expected_on)<=?)
    ORDER BY coalesce(sold_on, expected_on) DESC, expected_on DESC, id LIMIT ${CARD_LINES_LIMIT + 1}`,
  kind, kind, acquirer, acquirer, state, state, state, from, from, to, to).rows
    .filter((r) => !search || [r.nsu, r.authorization, r.description, brl(String(r.gross_cents))].some((v) => v && String(v).includes(search)));
  let lines = rows.slice(0, CARD_LINES_LIMIT).map((r) => cardLineView(db, r, rates, ctx.parts));
  if (a.divergent === true) lines = lines.filter((l) => l.fee.above_contract || l.fee.late);
  // O que ainda vai cair: recebíveis da adquirente sem recebimento, por dia; e as contas de cartão em aberto no sistema, por vencimento.
  const today = todaySaoPaulo();
  const coming = db.exec(`SELECT expected_on day, count(*) n, sum(gross_cents) gross, sum(net_cents) net FROM "${CARD_LINE}"
    WHERE kind='receivable' AND state IN ('pending','matched') AND expected_on>=? AND (? IS NULL OR acquirer=?) GROUP BY expected_on ORDER BY expected_on LIMIT 120`, today, acquirer, acquirer).rows
    .map((r) => ({ day: r.day, count: Number(r.n), gross_cents: String(r.gross), net_cents: String(r.net) }));
  const late = one(db, `SELECT count(*) n, coalesce(sum(net_cents),0) net FROM "${CARD_LINE}" WHERE kind='receivable' AND state IN ('pending','matched') AND expected_on<? AND (? IS NULL OR acquirer=?)`,
    today, acquirer, acquirer)!;
  const open = db.exec(`SELECT t.due_on day, count(*) n, sum(t.amount_cents - t.settled_cents) balance FROM "erp_finance__title" t ${CARD_METHOD_JOIN}
     WHERE t.kind='receivable' AND t.cancelled=0 AND t.deleted_at IS NULL AND t.settled_cents<t.amount_cents AND ${CARD_METHOD_WHERE}
     GROUP BY t.due_on ORDER BY t.due_on LIMIT 120`).rows.map((r) => ({ day: r.day, count: Number(r.n), balance_cents: String(r.balance) }));
  const totals = lines.reduce((s, l) => ({ gross: s.gross + BigInt(l.gross_cents), fee: s.fee + BigInt(l.fee_cents), expected: s.expected + BigInt(l.fee.expected_cents ?? l.fee_cents),
    above: s.above + (l.fee.above_contract ? 1 : 0) }), { gross: 0n, fee: 0n, expected: 0n, above: 0 });
  const imports = db.exec(`SELECT id, acquirer, kind, file_name, lines, new_lines, created_at FROM "${IMPORT}" ORDER BY created_at DESC, id LIMIT 20`).rows
    .map((r) => ({ id: r.id, acquirer: r.acquirer, acquirer_name: acquirerName(String(r.acquirer)), kind: r.kind, file_name: r.file_name, lines: Number(r.lines), new_lines: Number(r.new_lines) }));
  return {
    role, can_write: canWrite(role), lines, truncated: rows.length > CARD_LINES_LIMIT,
    summary: { gross_cents: totals.gross.toString(), fee_cents: totals.fee.toString(), expected_fee_cents: totals.expected.toString(), above_contract: totals.above,
      coming, late: { count: Number(late.n), net_cents: String(late.net) }, open_titles: open },
    imports, rates: db.exec(`SELECT * FROM "${RATE}" ORDER BY active DESC, acquirer, brand, product, installments_from, id`).rows.map(rateDto),
    accounts: db.exec(`SELECT id, name FROM "erp_finance__account" WHERE deleted_at IS NULL AND active=1 ORDER BY name, id`).rows.map((r) => ({ id: r.id, name: left(r.name, 200) })),
  };
}

const CARD_ACTIONS = ["confirm", "match", "unmatch", "ignore", "unignore", "confirm_all", "rematch", "unreceive"];

function cardAction(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, true);
  const a = argsOf(raw, ["action", "line_id", "expected_version", "title_id", "group_id", "reason", "min_confidence"]);
  const hash = hashOf("card_action", user, a);
  const previous = replay(db, command, user, hash);
  if (previous) return previous;
  const action = CARD_ACTIONS.includes(a.action) ? String(a.action) : invalid("erp_reconciliation_action_invalid");
  const at = now(ctx);
  const rates = db.exec(`SELECT * FROM "${RATE}" WHERE active=1`).rows;
  if (action === "confirm_all") {
    const min = intOf(a.min_confidence ?? 90, 70, 100);
    let confirmed = 0;
    const takenR = takenTitles(db, "receivable"), takenS = takenTitles(db, "sale");
    for (const r of db.exec(`SELECT * FROM "${CARD_LINE}" WHERE state='pending' AND confidence>=? AND (title_id IS NOT NULL OR group_id IS NOT NULL) ORDER BY confidence DESC, id`, min).rows) {
      const key = r.kind === "receivable" ? String(r.title_id) : `g:${r.group_id}`;
      const taken = r.kind === "receivable" ? takenR : takenS;
      if (taken.has(key)) continue;
      taken.add(key);
      db.exec(`UPDATE "${CARD_LINE}" SET state='matched', version=version+1, updated_at=?, updated_by=? WHERE id=?`, at, user, r.id);
      confirmed++;
    }
    return receipt(ctx, command, user, hash, "card_confirm_all", "card", null, { action, confirmed });
  }
  if (action === "rematch") {
    // Procurar de novo as linhas sem casamento confirmado (vendas lançadas depois da importação).
    const pending = db.exec(`SELECT * FROM "${CARD_LINE}" WHERE state='pending' ORDER BY coalesce(sold_on, expected_on), id LIMIT 5000`).rows;
    const days = pending.flatMap((r) => [r.sold_on, r.expected_on]).filter((d): d is string => typeof d === "string").sort();
    const index = new CardTitleIndex(days.length ? cardTitles(db, addDays(days[0], -400), addDays(days.at(-1)!, 5)) : []);
    const taken = { sale: takenTitles(db, "sale"), receivable: takenTitles(db, "receivable") };
    let suggested = 0;
    for (const r of pending) {
      const line = rowToCardLine(r);
      const match = bestCardMatch(line, index, taken[line.kind]);
      if (match) suggested++;
      if ((match?.title_id ?? null) !== r.title_id || (match?.group_id ?? null) !== r.group_id || (match?.confidence ?? null) !== (r.confidence === null ? null : Number(r.confidence)))
        db.exec(`UPDATE "${CARD_LINE}" SET title_id=?, group_id=?, confidence=?, version=version+1, updated_at=?, updated_by=? WHERE id=?`,
          match?.title_id ?? null, match?.group_id ?? null, match?.confidence ?? null, at, user, r.id);
    }
    return receipt(ctx, command, user, hash, "card_rematch", "card", null, { action, checked: pending.length, suggested });
  }
  const id = uuidOf(a.line_id)!;
  const line = one(db, `SELECT * FROM "${CARD_LINE}" WHERE id=?`, id);
  if (!line) raise("P0002", "erp_reconciliation_card_line_not_found");
  if (Number(line!.version) !== versionOf(a.expected_version)) raise("40001", "erp_reconciliation_version_conflict");
  const before = cardLineView(db, line!, rates, ctx.parts);
  const set = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db.exec(`UPDATE "${CARD_LINE}" SET ${keys.map((k) => `"${k}"=?`).join(", ")}, version=version+1, updated_at=?, updated_by=? WHERE id=?`, ...keys.map((k) => fields[k]), at, user, id);
  };
  if (action === "confirm" || action === "match") {
    if (line!.state === "received" || line!.state === "ignored") raise("40001", "erp_reconciliation_card_state");
    let title = line!.title_id as string | null, group = line!.group_id as string | null;
    if (action === "match") {
      title = uuidOf(a.title_id, false);
      group = uuidOf(a.group_id, false);
      if (!title && !group) invalid("erp_reconciliation_card_match_missing");
      if (title) {
        const t = one(db, `SELECT id, group_id, kind, cancelled, deleted_at FROM "erp_finance__title" WHERE id=?`, title);
        if (!t || t.kind !== "receivable" || bool(t.cancelled) || t.deleted_at !== null) raise("22023", "erp_reconciliation_card_title_invalid");
        group = String(t!.group_id);
      } else if (!one(db, `SELECT 1 x FROM "erp_finance__title" WHERE group_id=? AND kind='receivable' AND deleted_at IS NULL`, group)) raise("22023", "erp_reconciliation_card_title_invalid");
    }
    if (!title && !group) raise("40001", "erp_reconciliation_card_no_suggestion");
    const taken = takenTitles(db, line!.kind as "sale" | "receivable", id);
    if (line!.kind === "receivable" ? !title || taken.has(title) : taken.has(`g:${group}`)) raise("40001", "erp_reconciliation_card_title_taken");
    set({ state: "matched", title_id: title, group_id: group, confidence: action === "match" ? 100 : line!.confidence });
  } else if (action === "unmatch") {
    if (line!.state !== "matched") raise("40001", "erp_reconciliation_card_state");
    set({ state: "pending", title_id: null, group_id: null, confidence: null });
  } else if (action === "ignore") {
    if (line!.state === "received") raise("40001", "erp_reconciliation_card_state");
    set({ state: "ignored", ignored_reason: textOf(a.reason, 500, 3, "erp_reconciliation_reason_required") });
  } else if (action === "unignore") {
    if (line!.state !== "ignored") raise("40001", "erp_reconciliation_card_state");
    set({ state: "pending", ignored_reason: null });
  } else {
    // Desfazer o recebimento: o estorno da baixa pelo Financeiro (com a linha do banco já conciliada, desfaça lá antes).
    if (line!.state !== "received") raise("40001", "erp_reconciliation_card_state");
    const movement = one(db, `SELECT m.id FROM "erp_finance__movement" m WHERE m.settlement_id=? AND m.kind='payment'`, line!.settlement_id);
    if (movement && one(db, `SELECT 1 x FROM "erp_finance__reconciliation_link" WHERE movement_id=? AND undone_at IS NULL`, movement.id))
      raise("40001", "erp_reconciliation_card_bank_linked");
    const s = one(db, `SELECT title_id, posted_on FROM "erp_finance__settlement" WHERE id=?`, line!.settlement_id)!;
    const t = one(db, `SELECT version FROM "erp_finance__title" WHERE id=?`, s.title_id)!;
    financeCall(ctx, "erp_finance_execute", { p_user_id: user, p_command_id: subCommand(command, "reverse"), p_action: "reverse",
      p_data: { id: s.title_id, expected_version: Number(t.version), settlement_id: line!.settlement_id, posted_on: s.posted_on, note: "Recebimento de cartão desfeito na conciliação" } });
    set({ state: "matched", settlement_id: null, account_id: null, received_on: null });
  }
  return receipt(ctx, command, user, hash, `card_${action}`, id, before, { action, line: cardLineView(db, one(db, `SELECT * FROM "${CARD_LINE}" WHERE id=?`, id)!, rates, ctx.parts) });
}

/** Receber na conta: baixa cada conta do cartão pelo bruto com a taxa da adquirente (o líquido entra na conta) e, se pedido, concilia com a linha do banco. */
function cardReceive(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  access(db, user, true);
  const a = argsOf(raw, ["line_ids", "account_id", "received_on", "bank_line_id", "bank_line_version"]);
  const hash = hashOf("card_receive", user, a);
  const previous = replay(db, command, user, hash);
  if (previous) return previous;
  if (!Array.isArray(a.line_ids) || a.line_ids.length < 1 || a.line_ids.length > 200) invalid("erp_reconciliation_card_lines_invalid");
  const ids = [...new Set((a.line_ids as unknown[]).map((x) => uuidOf(x)!))].sort();
  const accountId = uuidOf(a.account_id)!;
  accountRow(db, accountId);
  const chosenDay = dayOf(a.received_on);
  const today = todaySaoPaulo();
  const movements: { kind: "movement"; id: string }[] = [];
  let net = 0n;
  const rates = db.exec(`SELECT * FROM "${RATE}" WHERE active=1`).rows;
  const done: unknown[] = [];
  for (const id of ids) {
    const line = one(db, `SELECT * FROM "${CARD_LINE}" WHERE id=?`, id);
    if (!line) raise("P0002", "erp_reconciliation_card_line_not_found");
    if (line!.state === "received" || line!.state === "ignored") raise("40001", "erp_reconciliation_card_state");
    if (!line!.title_id) raise("40001", "erp_reconciliation_card_no_title");
    const day = chosenDay ?? (line!.expected_on as string | null) ?? today;
    if (day > today) raise("22023", "erp_reconciliation_card_future");
    const t = one(db, `SELECT id, version, amount_cents, settled_cents, cancelled, deleted_at FROM "erp_finance__title" WHERE id=?`, line!.title_id)!;
    if (bool(t.cancelled) || t.deleted_at !== null) raise("40001", "erp_reconciliation_card_title_invalid");
    const balance = BigInt(String(t.amount_cents)) - BigInt(String(t.settled_cents));
    const gross = BigInt(String(line!.gross_cents)), lineNet = BigInt(String(line!.net_cents));
    // Diferença de centavos do arredondamento das parcelas: vale o saldo da conta.
    const principal = gross <= balance ? gross : gross - balance <= BigInt(line!.installments as number) ? balance : raise("40001", "erp_reconciliation_card_overpayment");
    const fee = principal - lineNet > 0n ? principal - lineNet : 0n;
    const result = financeCall(ctx, "erp_finance_execute", { p_user_id: user, p_command_id: subCommand(command, `settle:${id}`), p_action: "settle", p_data: {
      id: t.id, expected_version: Number(t.version), account_id: accountId, posted_on: day, principal_cents: principal.toString(), fee_cents: fee.toString(),
      note: left(`Recebimento ${acquirerName(String(line!.acquirer))} ${BRAND_LABEL[line!.brand as keyof typeof BRAND_LABEL] ?? ""} ${line!.installment}/${line!.installments}${line!.nsu ? ` NSU ${line!.nsu}` : ""}`.replace(/\s+/g, " "), 500),
    } });
    const settlement = String(result.settlement.id);
    db.exec(`UPDATE "${CARD_LINE}" SET state='received', settlement_id=?, account_id=?, received_on=?, version=version+1, updated_at=?, updated_by=? WHERE id=?`,
      settlement, accountId, day, now(ctx), user, id);
    const m = one(db, `SELECT id, delta_cents FROM "erp_finance__movement" WHERE settlement_id=? AND kind='payment'`, settlement);
    if (m) { movements.push({ kind: "movement", id: String(m.id) }); net += BigInt(String(m.delta_cents)); }
    done.push(cardLineView(db, one(db, `SELECT * FROM "${CARD_LINE}" WHERE id=?`, id)!, rates, ctx.parts));
  }
  let bank: unknown = null;
  const bankLine = uuidOf(a.bank_line_id, false);
  if (bankLine) {
    const l = one(db, `SELECT * FROM "${FIN_LINE}" WHERE id=? AND deleted_at IS NULL`, bankLine);
    if (!l || l.account_id !== accountId) raise("22023", "erp_reconciliation_card_bank_line");
    if (BigInt(String(l!.amount_cents)) !== net) raise("22023", "erp_reconciliation_card_bank_amount");
    execute(ctx, user, command, "card-bank", "line_reconcile", { line_id: bankLine, expected_version: a.bank_line_version === undefined ? Number(l!.version) : versionOf(a.bank_line_version), links: movements });
    bank = bankLineView(db, one(db, `SELECT * FROM "${FIN_LINE}" WHERE id=?`, bankLine)!, null);
  }
  return receipt(ctx, command, user, hash, "card_receive", accountId, null, { received: done.length, net_cents: net.toString(), lines: done, bank_line: bank });
}

registerRpc("erp_reconciliation_overview", (ctx, a) => overview(ctx, userOf(a), a.p_args));
registerRpc("erp_reconciliation_preview", (ctx, a) => preview(ctx, userOf(a), a.p_args));
registerRpc("erp_reconciliation_bank_import", (ctx, a) => bankImport(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_reconciliation_bank_lines", (ctx, a) => bankLines(ctx, userOf(a), a.p_args));
registerRpc("erp_reconciliation_bank_action", (ctx, a) => bankAction(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_reconciliation_rule_save", (ctx, a) => ruleSave(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_reconciliation_layout_save", (ctx, a) => layoutSave(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_reconciliation_card_import", (ctx, a) => cardImport(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_reconciliation_card_lines", (ctx, a) => cardLines(ctx, userOf(a), a.p_args));
registerRpc("erp_reconciliation_card_action", (ctx, a) => cardAction(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_reconciliation_card_receive", (ctx, a) => cardReceive(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_reconciliation_card_rate_save", (ctx, a) => rateSave(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_reconciliation_card_candidates", (ctx, a) => cardCandidatesRead(ctx, userOf(a), a.p_args));
registerRpc("erp_reconciliation_bank_candidates", (ctx, a) => bankCandidates(ctx, userOf(a), a.p_args));
