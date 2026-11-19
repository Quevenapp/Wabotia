// Financeiro (erp_finance): funções internas e os gatilhos das tabelas, que no
// SQLite viram a "camada de tabela" (quem escreve na tabela chama a guarda).
// Portado das migrações do Fagoo (versões finais no catálogo do oráculo); os
// gatilhos que só lançam erro já estão em SQL gerado (src/erp/schema).
//
// Regras de texto do oráculo (collation "C", ctype "C.UTF-8"):
// - ordem de texto = ordem dos pontos de código (cmpText);
// - lower() é Unicode, sem a regra do sigma final (pgLower);
// - [[:cntrl:]] pega C0, DEL e C1 (CNTRL);
// - btrim() sem segundo argumento tira só espaços.
import { createHash } from "node:crypto";
import { originAccess, driverContext, systemScope } from "../../engine/module-origin.ts";
import { formatScaled, fromColumn } from "../../engine/dec.ts";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { ERP_TABLES } from "../../schema/columns.generated.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import { pgHasCntrl, pgLower as enginePgLower } from "../../engine/text.ts";
import { defer, type RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp, todaySaoPaulo, validDate } from "../../engine/time.ts";
import { activeRole, permitted } from "../access/public.ts";
import * as sync from "../sync/public.ts";

// ---------------------------------------------------------------------------
// Texto, ordem e tipos

/** [[:cntrl:]] do oráculo (engine/text.ts, provado em todo o Unicode). */
export const CNTRL = pgHasCntrl;
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const btrim = (s: string) => s.replace(/^ +| +$/g, "");
/** length() do Postgres: caracteres (pontos de código). */
export const charLength = (s: string) => [...s].length;
/** lower() do oráculo (engine/text.ts). */
export const pgLower = enginePgLower;
/** Ordem de texto na collation "C": pontos de código. */
export function cmpText(a: string, b: string) {
  if (a === b) return 0;
  const x = [...a],
    y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const c = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (c) return c;
  }
  return x.length - y.length;
}
/** order by lower(campo), id */
export const byLowerThenId =
  <T extends Row>(field: string) =>
  (a: T, b: T) =>
    cmpText(pgLower(String(a[field])), pgLower(String(b[field]))) || cmpText(String(a.id), String(b.id));

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** octet_length(jsonb::text) */
export const jsonBytes = (value: unknown) => new TextEncoder().encode(jsonbText(value)).length;
export const bool = (v: unknown) => v === 1 || v === true || v === "1";
export const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(v as number));
export const lowerUuid = (v: string) => v.toLowerCase();

/** Argumento uuid do RPC: canônico em minúsculas; inválido → 22P02 (antes do corpo). */
export function uuidArg(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !UUID_RE.test(value))
    raise("22P02", `invalid input syntax for type uuid: "${String(value)}"`);
  return value.toLowerCase();
}

/**
 * Argumento com DEFAULT na assinatura do Postgres: ausente vale o padrão;
 * null explícito continua null (pg_get_function_arguments do oráculo).
 */
/** Argumento jsonb do RPC (a API manda objeto; o texto também vale). */
export const jsonArg = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);

/**
 * to_jsonb(linha) do Postgres a partir da linha do SQLite, pelo codec de cada
 * coluna: tempo no texto do jsonb, date como texto, bool, números, json e
 * arrays decodificados; decimais escalados viram número, como o numeric do
 * jsonb chega ao cliente (pglite e erp-api fazem JSON.parse).
 */
export function toJsonb(table: string, row: Row): Record<string, unknown> {
  const info = ERP_TABLES[table as keyof typeof ERP_TABLES] as {
    columns: Record<string, { codec: string; scale?: number }>;
  };
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(info.columns)) {
    if (c.codec === "fold" || c.codec === "computed") continue;
    const v = row[name];
    if (v === undefined || v === null) out[name] = null;
    else if (c.codec === "timestamp_us") out[name] = jsonTimestamp(v as number);
    else if (c.codec === "bool") out[name] = bool(v);
    else if (c.codec === "json" || c.codec.startsWith("array:")) out[name] = JSON.parse(String(v));
    else if (c.codec === "dec" || c.codec === "dec_i64") out[name] = Number(formatScaled(fromColumn(v), c.scale ?? 0));
    else if (c.codec === "dec_text") out[name] = Number(v);
    else if (c.codec === "int" || c.codec === "int53") out[name] = Number(v);
    else out[name] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validadores de p_data (erp_finance.keys, uuid_value, expected, txt, …)

type Data = Record<string, unknown>;
const has = (data: Data, key: string) => Object.prototype.hasOwnProperty.call(data, key);
/** p_data->'key' (undefined quando falta) */
export const field = (data: unknown, key: string) =>
  data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Data)[key] : undefined;
/** p_data ? 'key' */
export const hasKey = (data: unknown, key: string) =>
  data !== null && typeof data === "object" && !Array.isArray(data) && has(data as Data, key);

/** erp_finance.require_access: papel ativo admin/financeiro/consulta (consulta só lê). */
export function requireAccess(db: SqlDriver, actor: string, write: boolean): string {
  const role = activeRole(db, actor);
  if (originAccess(db, actor, ["title_create", "title_settle", "title_cancel", "settlement_reverse"]) && systemScope(driverContext(db)!)) return role!;
  if (!role || !["admin", "financeiro", "consulta"].includes(role) || (write && role === "consulta"))
    raise("42501", "erp_finance_access_denied");
  return role;
}

/** erp_finance.keys */
export function keys(data: unknown, allowed: readonly string[]) {
  if (
    data === null ||
    data === undefined ||
    jsonType(data) !== "object" ||
    jsonBytes(data) > 65536 ||
    Object.keys(data as Data).some((k) => !allowed.includes(k))
  )
    raise("22023", "erp_finance_invalid_data");
}

/** erp_finance.uuid_value */
export function uuidValue(value: unknown, required = true): string | null {
  if ((value === undefined || value === null) && !required) return null;
  if (jsonType(value) !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value as string))
    raise("22023", "erp_finance_invalid_id");
  return (value as string).toLowerCase();
}

/** erp_finance.expected */
export function expected(value: unknown, create = false): number {
  if (jsonType(value) !== "number" || !/^[0-9]{1,10}$/.test(jsonbText(value)))
    raise("22023", "erp_finance_invalid_version");
  const v = value as number;
  if (v > 2147483647) raise("22023", "erp_finance_invalid_version");
  if ((create && v !== 0) || (!create && v < 1)) raise("22023", "erp_finance_invalid_version");
  return v;
}

/** erp_finance.txt */
export function txt(data: unknown, key: string, limit: number, required = false): string | null {
  const value = field(data, key);
  if (hasKey(data, key) && !["string", "null"].includes(jsonType(value)!)) raise("22023", "erp_finance_invalid_text");
  // p_data->>p_key: o texto como está; null quando falta
  const raw = value === undefined || value === null ? null : String(value);
  const v = raw === null ? null : btrim(raw) || null;
  if ((required && v === null) || (v !== null && charLength(v) > limit)) raise("22023", "erp_finance_invalid_text");
  return v;
}

/** erp_finance.account_text */
export function accountText(data: unknown, key: string, pattern: RegExp): string | null {
  const v = txt(data, key, 80);
  if (v !== null && !pattern.test(v)) raise("22023", "erp_finance_invalid_text");
  return v;
}

/** erp_finance.day */
export function day(value: unknown, past = false): string {
  if (jsonType(value) !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value as string))
    raise("22023", "erp_finance_invalid_date");
  const v = value as string;
  if (!validDate(v)) raise("22023", "erp_finance_invalid_date");
  if (v < "1900-01-01" || v > "2100-12-31" || (past && v > todaySaoPaulo()))
    raise("22023", "erp_finance_invalid_date");
  return v;
}

/** erp_finance.cents (bigint em centavos; o Fagoo limita a 15 dígitos, cabe em number) */
export function cents(value: unknown, zero = true, signed = false): number {
  const re = signed ? /^-?[0-9]{1,15}$/ : /^[0-9]{1,15}$/;
  if (jsonType(value) !== "string" || !re.test(value as string)) raise("22023", "erp_finance_invalid_cents");
  const v = Number(value as string);
  if (!zero && v <= 0) raise("22023", "erp_finance_invalid_cents");
  return v;
}

// ---------------------------------------------------------------------------
// Comando (recibo) e auditoria

/** Hash do pedido: sha256(jsonb_build_object('actor','action','data')::text) */
export const requestHash = (actor: string, action: string, data: unknown) =>
  sha256(jsonbText({ actor, action, data }));

/** Recibo gravado: mesmo ator e hash devolve o resultado com replayed=true; senão 40001. */
export function replayed(db: SqlDriver, command: string, actor: string, hash: string) {
  const row = one(db, 'SELECT actor, request_hash, result FROM "erp_finance__command" WHERE id=?', command);
  if (!row) return null;
  if (row.actor !== actor || row.request_hash !== hash) raise("40001", "erp_finance_command_conflict");
  return { ...JSON.parse(String(row.result)), replayed: true };
}

const reservedCommands = new WeakMap<RpcContext, Set<string>>();
/** Recibo reservado nesta transação e ainda sem resultado: no Postgres ele ainda não existe (FK adiada). */
export const isReserved = (ctx: RpcContext, id: string) => !!reservedCommands.get(ctx)?.has(id);
/**
 * Reserva o recibo antes do fim do RPC, para as tabelas cuja FK para
 * erp_finance.command é DEFERRABLE INITIALLY DEFERRED no Postgres (transfer,
 * cnab_cash_plan): no SQLite não há FK adiada (docs/ERP-FASE0.md, regra 3).
 * O resultado provisório '{}' não aciona os gatilhos de imutabilidade do
 * recibo; insertCommand grava o resultado final no fim.
 */
export function reserveCommand(ctx: RpcContext, id: string, actor: string, hash: string) {
  let set = reservedCommands.get(ctx);
  if (!set) reservedCommands.set(ctx, (set = new Set()));
  if (set.has(id)) return;
  // Um recibo de outra transação já satisfaz a FK: nada a reservar.
  if (one(ctx.db, 'SELECT 1 x FROM "erp_finance__command" WHERE id=?', id)) return;
  set.add(id);
  ctx.db.exec(
    'INSERT INTO "erp_finance__command"(id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    id,
    actor,
    hash,
    "{}",
    ctx.clock.next().toString(),
  );
}

export function insertCommand(ctx: RpcContext, id: string, actor: string, hash: string, result: unknown) {
  const set = reservedCommands.get(ctx);
  if (set?.has(id)) {
    // A reserva pode ter vindo de outra escrita (cnab_cash_plan): o recibo final é deste comando.
    ctx.db.exec('UPDATE "erp_finance__command" SET actor=?, request_hash=?, result=? WHERE id=?', actor, hash, JSON.stringify(result), id);
    set.delete(id);
    return;
  }
  ctx.db.exec(
    'INSERT INTO "erp_finance__command"(id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    id,
    actor,
    hash,
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
}

/** INSERT em audit com o gatilho audit_permission (BEFORE INSERT). */
export function insertAudit(
  ctx: RpcContext,
  actor: string,
  command: string,
  action: string,
  before: unknown,
  after: unknown,
) {
  const key = permissionKey(action, after);
  if (key !== null && !permitted(ctx.db, actor, key)) raise("42501", "erp_finance_permission_denied");
  ctx.db.exec(
    'INSERT INTO "erp_finance__audit"(actor, command_id, action, before_data, after_data, created_at) VALUES(?,?,?,?,?,?)',
    actor,
    command,
    action,
    before === null || before === undefined ? null : JSON.stringify(before),
    JSON.stringify(after),
    ctx.clock.next().toString(),
  );
}

/** #>> de um caminho no jsonb (texto; null quando falta). */
function pathText(value: unknown, path: (string | number)[]): string | null {
  let v: unknown = value;
  for (const p of path) {
    if (v === null || typeof v !== "object") return null;
    v = (v as Record<string, unknown>)[p as string];
  }
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : jsonbText(v);
}

/** erp_finance.permission_key */
export function permissionKey(action: string, after: unknown): string | null {
  if (action.startsWith("document_")) {
    const k = pathText(after, ["posting", "kind"]);
    return k === "sales_orders"
      ? "vendas.pedidos_venda.lancar_contas"
      : k === "purchase_orders"
        ? "suprimentos.pedidos_compra.lancar_contas"
        : k === "service_orders"
          ? "financas.contas_receber.ie"
          : null;
  }
  if (action.startsWith("invoice_")) {
    const d = pathText(after, ["posting", "direction"]);
    return d === "receivable"
      ? "vendas.notas_fiscais.lancar_contas"
      : d === "payable"
        ? "suprimentos.notas_entrada.lancar_contas"
        : null;
  }
  const entity = pathText(after, ["entity"]);
  const items = field(after, "items");
  const kind =
    (entity === "titles" || entity === "recurrences" ? pathText(after, ["record", "kind"]) : null) ??
    (Array.isArray(items) ? (pathText(after, ["items", 0, "kind"]) ?? pathText(after, ["items", 0, "title", "kind"])) : null) ??
    pathText(after, ["title", "kind"]) ??
    (entity === "financial_import" ? pathText(after, ["kind"]) : null);
  const side = kind === "receivable" ? "financas.contas_receber" : kind === "payable" ? "financas.contas_pagar" : null;
  const sideKey = (suffix: string) => (side === null ? null : side + suffix);
  const like = (prefix: string) => action.startsWith(prefix);
  if (action === "records_import" && kind === "cash") return "financas.caixas_bancos.ie";
  if (["title_create", "title_create_group", "title_edit", "title_update", "records_import"].includes(action) || like("recurrence_"))
    return sideKey(".ie");
  if (action === "title_delete") return sideKey(".ex");
  if (action === "title_cancel") return sideKey(".cancelar");
  if (["settle", "settle_batch", "reverse"].includes(action) || like("bordero")) return sideKey(".baixar");
  if (["account_delete", "entry_delete", "transfer_delete"].includes(action)) return "financas.caixas_bancos.ex";
  if (like("account_") || ["opening", "entry_save", "entry_restore", "balance_adjust", "line_categorize"].includes(action))
    return "financas.caixas_bancos.ie";
  if (like("statement_") || like("line_")) return "financas.conciliacao";
  if (action.includes("transfer")) return "financas.caixas_bancos.transferencia";
  if (action === "category_delete") return "financas.categorias.ex";
  if (like("category_")) return "financas.categorias.ie";
  if (like("grouped_billing_")) return "financas.faturamento_agrupado";
  if (like("commission_")) return "vendas.comissoes";
  if (action === "session_delete") return "vendas.controle_caixa.ex";
  if (like("session_")) return "vendas.controle_caixa.ie";
  return null;
}

// ---------------------------------------------------------------------------
// Verificações adiadas (gatilhos DEFERRABLE INITIALLY DEFERRED do Postgres): a fila do
// motor (engine/registry.ts, defer), que roda no fim da transação, antes do COMMIT,
// também quando outro domínio chama o Financeiro.
export { defer };

/**
 * erp_finance.document_command_start: recibo dos lançamentos de documentos e notas
 * (tabela document_command). Devolve o resultado gravado com replayed=true, ou null.
 */
export function documentCommandStart(db: SqlDriver, actor: string, id: string | null, action: string, data: unknown) {
  requireAccess(db, actor, true);
  if (id === null) raise("22023", "erp_document_finance_command_required");
  const c = one(db, 'SELECT actor, request_hash, result FROM "erp_finance__document_command" WHERE id=?', id);
  if (!c) return null;
  if (c.actor !== actor || c.request_hash !== requestHash(actor, action, data)) raise("40001", "erp_document_finance_command_conflict");
  return { ...JSON.parse(String(c.result)), replayed: true };
}

/** erp_finance.document_command_finish */
export function documentCommandFinish(ctx: RpcContext, actor: string, id: string, action: string, data: unknown, result: Record<string, unknown>) {
  const r = { ...result, action, data_mode: "erp_native", replayed: false, cash_movement_performed: false };
  ctx.db.exec(
    'INSERT INTO "erp_finance__document_command"(id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    id, actor, requestHash(actor, action, data), JSON.stringify(r), ctx.clock.next().toString(),
  );
  return r;
}

/** erp_finance.require_permission: 42501 sem a chave de permissão. */
export function requirePermission(db: SqlDriver, user: string, key: string) {
  if (!permitted(db, user, key)) raise("42501", "erp_finance_permission_denied");
}

/** set_config(nome, valor, true) / current_setting(nome, true) */
export const setFlag = (ctx: RpcContext, name: string, value: string) => ctx.settings.set(name, value);
export const flag = (ctx: RpcContext, name: string) => ctx.settings.get(name) ?? null;

// ---------------------------------------------------------------------------
// Conta (erp_finance.account)

const ACCOUNT_COLS =
  "id, name, kind, active, opening_recorded, version, created_at, updated_at, account_type, institution_code, institution_name, agency, account_number, account_digit, start_on, default_movements, default_boleto, deleted_at, deleted_by";

export const accountRow = (db: SqlDriver, id: string) =>
  one(db, `SELECT ${ACCOUNT_COLS} FROM "erp_finance__account" WHERE id=?`, id);

const kindType = (kind: string) => (kind === "bank" ? "checking" : kind === "cash" ? "cash" : "other");

/** INSERT em account com o gatilho account_defaults. Devolve o id. */
export function insertAccount(ctx: RpcContext, a: Record<string, unknown>) {
  const id = (a.id as string) ?? crypto.randomUUID();
  const now = ctx.clock.next().toString();
  const accountType = (a.account_type as string | null) ?? kindType(String(a.kind));
  ctx.db.exec(
    `INSERT INTO "erp_finance__account"(id, name, kind, account_type, institution_code, institution_name, agency, account_number, account_digit, start_on, opening_recorded, default_movements, default_boleto, active, version, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    id,
    a.name,
    a.kind,
    accountType,
    a.institution_code ?? null,
    a.institution_name ?? null,
    a.agency ?? null,
    a.account_number ?? null,
    a.account_digit ?? null,
    a.start_on ?? null,
    a.opening_recorded ? 1 : 0,
    a.default_movements ? 1 : 0,
    a.default_boleto ? 1 : 0,
    a.active === false ? 0 : 1,
    now,
    now,
  );
  return id;
}

/**
 * UPDATE em account (uma linha) com o gatilho account_defaults: conta
 * excluída não muda (40001); o tipo acompanha a natureza quando só ela muda.
 * `set` traz os novos valores (colunas → valor; booleanos como boolean).
 */
export function updateAccount(ctx: RpcContext, id: string, set: Record<string, unknown>) {
  const old = accountRow(ctx.db, id);
  if (!old) return;
  if (old.deleted_at !== null) raise("40001", "erp_finance_deleted_account");
  const next = { ...set };
  if ("kind" in next && next.kind !== old.kind && (!("account_type" in next) || next.account_type === old.account_type))
    next.account_type = kindType(String(next.kind));
  writeRow(ctx, "erp_finance__account", "id", id, { ...next, version: Number(old.version) + 1, updated_at: ctx.clock.next().toString() });
}

/** UPDATE genérico de uma linha (booleanos viram 0/1). */
export function writeRow(ctx: RpcContext, table: string, key: string, id: unknown, set: Record<string, unknown>) {
  const cols = Object.keys(set);
  if (!cols.length) return;
  ctx.db.exec(
    `UPDATE "${table}" SET ${cols.map((c) => `"${c}"=?`).join(", ")} WHERE "${key}"=?`,
    ...cols.map((c) => (typeof set[c] === "boolean" ? (set[c] ? 1 : 0) : set[c])),
    id,
  );
}

/** erp_finance.account_view (null se não existe ou foi excluída). */
export function accountView(db: SqlDriver, id: string) {
  const a = one(db, `SELECT ${ACCOUNT_COLS} FROM "erp_finance__account" WHERE id=? AND deleted_at IS NULL`, id);
  if (!a) return null;
  const profile = one(db, 'SELECT id, identity FROM "erp_cnab__profile" WHERE account_id=?', id);
  const openings = db.exec(
    `SELECT CAST(delta_cents AS TEXT) d FROM "erp_finance__movement" WHERE account_id=? AND kind='opening'`,
    id,
  ).rows;
  if (openings.length > 1) raise("21000", "more than one row returned by a subquery used as an expression");
  const sums = one(
    db,
    `SELECT CAST(coalesce(sum(delta_cents),0) AS TEXT) balance, min(posted_on) first FROM "erp_finance__movement" WHERE account_id=?`,
    id,
  )!;
  const exists = (sql: string) => !!one(db, sql, id);
  const inUse =
    exists(`SELECT 1 x FROM "erp_finance__movement" WHERE account_id=? AND kind<>'opening' LIMIT 1`) ||
    exists('SELECT 1 x FROM "erp_finance__title" WHERE account_id=? LIMIT 1') ||
    profile !== null ||
    exists('SELECT 1 x FROM "erp_finance__bordero" WHERE account_id=? LIMIT 1') ||
    exists('SELECT 1 x FROM "erp_finance__recurrence" WHERE account_id=? LIMIT 1') ||
    exists('SELECT 1 x FROM "erp_finance__cash_entry" WHERE account_id=? LIMIT 1') ||
    exists('SELECT 1 x FROM "erp_finance__bank_statement" WHERE account_id=? LIMIT 1') ||
    exists('SELECT 1 x FROM "erp_finance__commission_entry" WHERE account_id=? LIMIT 1') ||
    exists('SELECT 1 x FROM "erp_catalog__payment_method" WHERE account_id=? AND deleted_at IS NULL LIMIT 1') ||
    exists('SELECT 1 x FROM "erp_finance__cash_session" WHERE account_id=? LIMIT 1');
  const identity = profile ? JSON.parse(String(profile.identity)) : null;
  const idText = (k: string) => {
    const v = identity?.[k];
    return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
  };
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    account_type: a.account_type,
    institution_code: a.institution_code,
    institution_name: a.institution_name,
    agency: a.agency,
    account_number: a.account_number,
    account_digit: a.account_digit,
    start_on: a.start_on,
    active: bool(a.active),
    default_movements: bool(a.default_movements),
    default_boleto: bool(a.default_boleto),
    boleto: bool(a.default_boleto) ? "default" : profile ? "active" : "none",
    opening_recorded: bool(a.opening_recorded),
    opening_cents: openings[0]?.d ?? null,
    balance_cents: sums.balance,
    first_movement_on: sums.first ?? null,
    in_use: inUse,
    cnab: profile
      ? { bank: idText("bank"), agency: idText("agency"), account: idText("account"), account_digit: idText("accountDigit") }
      : null,
    version: a.version,
    created_at: ts(a.created_at),
    updated_at: ts(a.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Movimento (erp_finance.movement)

export interface MovementInput {
  account_id: string;
  kind: string;
  delta_cents: number;
  posted_on: string;
  note: string | null;
  actor: string;
  command_id: string;
  settlement_id?: string | null;
  transfer_id?: string | null;
  category_id?: string | null;
  entry_id?: string | null;
  compensates_id?: string | null;
}

/** INSERT em movement com os gatilhos (início da conta, perna de transferência, baixa adiada). */
export function insertMovement(ctx: RpcContext, m: MovementInput) {
  const db = ctx.db;
  // movement_account_start
  if (one(db, `SELECT 1 x FROM "erp_finance__account" WHERE id=? AND start_on IS NOT NULL AND ?<start_on`, m.account_id, m.posted_on))
    raise("22023", "erp_finance_before_account_start");
  transferLegCheck(db, m);
  const id = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_finance__movement"(id, account_id, settlement_id, kind, delta_cents, posted_on, note, actor, command_id, created_at, transfer_id, category_id, entry_id, compensates_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    m.account_id,
    m.settlement_id ?? null,
    m.kind,
    m.delta_cents,
    m.posted_on,
    m.note,
    m.actor,
    m.command_id,
    ctx.clock.next().toString(),
    m.transfer_id ?? null,
    m.category_id ?? null,
    m.entry_id ?? null,
    m.compensates_id ?? null,
  );
  // settlement_movement_check (adiado)
  if (m.settlement_id) {
    const sid = m.settlement_id;
    defer(ctx, () => assertSettlementPostings(db, sid));
  }
  return id;
}

/** erp_finance.transfer_leg_check (BEFORE INSERT OR UPDATE em movement) */
function transferLegCheck(db: SqlDriver, m: MovementInput) {
  if (!m.transfer_id) return;
  const t = one(
    db,
    'SELECT from_account_id, to_account_id, amount_cents, posted_on, in_posted_on, actor, command_id, note FROM "erp_finance__transfer" WHERE id=?',
    m.transfer_id,
  );
  if (
    !t ||
    m.actor !== t.actor ||
    m.command_id !== t.command_id ||
    m.note !== t.note ||
    !(
      (m.kind === "transfer_out" &&
        m.account_id === t.from_account_id &&
        m.delta_cents === -Number(t.amount_cents) &&
        m.posted_on === t.posted_on) ||
      (m.kind === "transfer_in" &&
        m.account_id === t.to_account_id &&
        m.delta_cents === Number(t.amount_cents) &&
        m.posted_on === (t.in_posted_on ?? t.posted_on))
    )
  )
    raise("22023", "erp_finance_transfer_leg_invalid");
}

/** erp_finance.cnab_plan_for_settlement: o plano CNAB da baixa (ou do original do estorno). */
export function cnabPlanForSettlement(db: SqlDriver, settlement: string) {
  return one(
    db,
    `SELECT p.command_id, p.title_id, p.account_id, CAST(p.principal_cents AS TEXT) principal_cents, CAST(p.fee_cents AS TEXT) fee_cents, CAST(p.net_cash_cents AS TEXT) net_cash_cents, p.actor
       FROM "erp_finance__settlement" s
       LEFT JOIN "erp_finance__settlement" original ON original.id=s.reverses_id
       JOIN "erp_finance__cnab_cash_plan" p ON p.command_id=CASE WHEN s.kind='payment' THEN s.command_id ELSE original.command_id END
      WHERE s.id=?`,
    settlement,
  );
}

/** erp_finance.assert_settlement_postings */
export function assertSettlementPostings(db: SqlDriver, id: string) {
  const s = one(
    db,
    'SELECT id, title_id, kind, account_id, posted_on, actor, command_id, note, principal_cents, interest_cents, penalty_cents, discount_cents, fee_cents, net_cash_cents FROM "erp_finance__settlement" WHERE id=?',
    id,
  );
  if (!s) raise("22023", "erp_finance_posting_missing");
  const titleKind = one(db, 'SELECT kind FROM "erp_finance__title" WHERE id=?', s.title_id)?.kind;
  let direction = titleKind === "receivable" ? 1 : -1;
  if (s.kind === "reversal") direction = -direction;
  const plan = cnabPlanForSettlement(db, id);
  const agg = one(db, 'SELECT count(*) n, coalesce(sum(delta_cents),0) total FROM "erp_finance__movement" WHERE settlement_id=?', id)!;
  const n = Number(agg.n),
    total = Number(agg.total);
  const bad = one(
    db,
    `SELECT 1 x FROM "erp_finance__movement" m WHERE m.settlement_id=? AND (m.account_id IS NOT ? OR m.posted_on IS NOT ? OR m.actor IS NOT ? OR m.command_id IS NOT ? OR m.note IS NOT ? OR m.transfer_id IS NOT NULL) LIMIT 1`,
    id,
    s.account_id,
    s.posted_on,
    s.actor,
    s.command_id,
    s.note,
  );
  if (bad) raise("22023", "erp_finance_posting_binding_invalid");
  const movementOf = (kind: string, delta?: number) =>
    !!one(
      db,
      `SELECT 1 x FROM "erp_finance__movement" WHERE settlement_id=? AND kind=?${delta === undefined ? "" : " AND delta_cents=?"} LIMIT 1`,
      ...(delta === undefined ? [id, kind] : [id, kind, delta]),
    );
  if (!plan) {
    if (n !== 1 || total !== direction * Number(s.net_cash_cents) || !movementOf(String(s.kind)))
      raise("22023", "erp_finance_posting_incomplete");
  } else {
    const main = s.kind === "payment" ? "payment" : "reversal";
    const fee = s.kind === "payment" ? "bank_fee" : "bank_fee_reversal";
    const receivable = !!one(db, `SELECT 1 x FROM "erp_finance__title" WHERE id=? AND kind='receivable'`, s.title_id);
    if (
      s.title_id !== plan.title_id ||
      s.account_id !== plan.account_id ||
      Number(s.principal_cents) !== Number(plan.principal_cents) ||
      Number(s.fee_cents) !== Number(plan.fee_cents) ||
      Number(s.net_cash_cents) !== Number(plan.net_cash_cents) ||
      Number(s.interest_cents) !== 0 ||
      Number(s.penalty_cents) !== 0 ||
      Number(s.discount_cents) !== 0 ||
      !receivable ||
      (s.kind === "payment" && s.actor !== plan.actor) ||
      n !== 2 ||
      total !== direction * Number(plan.net_cash_cents) ||
      !movementOf(main, direction * Number(plan.principal_cents)) ||
      !movementOf(fee, -direction * Number(plan.fee_cents))
    )
      raise("22023", "erp_finance_cnab_posting_invalid");
  }
}

/**
 * UPDATE de category_id em movement, só na reclassificação (category_move,
 * line_categorize): gatilhos cnab_movement_immutable (sempre), e a
 * imutabilidade de lançamento de caixa e de transferência, que deixam passar
 * a troca de categoria com erp_finance.reclassify ligado.
 */
export function reclassifyMovements(ctx: RpcContext, where: string, params: unknown[], category: string | null) {
  const db = ctx.db;
  const rows = db.exec(`SELECT id, settlement_id, entry_id, transfer_id FROM "erp_finance__movement" WHERE ${where}`, ...params).rows;
  for (const r of rows) {
    if (r.settlement_id && cnabPlanForSettlement(db, String(r.settlement_id))?.command_id != null)
      raise("42501", "erp_finance_cnab_cash_immutable");
    if (r.entry_id && flag(ctx, "erp_finance.reclassify") !== "on") raise("55000", "erp_finance_entry_immutable");
    if (r.transfer_id && flag(ctx, "erp_finance.reclassify") !== "on") raise("55000", "erp_finance_transfer_immutable");
    // transfer_leg_check no UPDATE: só a categoria muda, a perna continua válida.
    db.exec('UPDATE "erp_finance__movement" SET category_id=? WHERE id=?', category, r.id);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Categoria (erp_finance.category)

const CATEGORY_COLS = "id, name, kind, active, version, created_at, updated_at, parent_id, dre_group, deleted_at, deleted_by";
export const categoryRow = (db: SqlDriver, id: string) =>
  one(db, `SELECT ${CATEGORY_COLS} FROM "erp_finance__category" WHERE id=?`, id);

/** erp_finance.category_depth (até 10 níveis) */
export function categoryDepth(db: SqlDriver, id: string): number | null {
  // with recursive up (… depth+1 … where up.depth<10) select max(depth)
  let depth = 0;
  let current: string | null = id;
  while (current !== null && depth < 10) {
    const row = one(db, 'SELECT parent_id FROM "erp_finance__category" WHERE id=?', current);
    if (!row) break;
    depth++;
    current = (row.parent_id as string | null) ?? null;
  }
  return depth || null;
}

/** erp_finance.category_in_use */
export const categoryInUse = (db: SqlDriver, id: string) =>
  ["title", "bordero", "bordero_item", "movement", "cnab_cash_plan", "recurrence"].some(
    (t) => !!one(db, `SELECT 1 x FROM "erp_finance__${t}" WHERE category_id=? LIMIT 1`, id),
  );

/** erp_finance.category_subtree (a categoria e as não excluídas abaixo dela) */
export function categorySubtree(db: SqlDriver, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++)
    for (const r of db.exec('SELECT id FROM "erp_finance__category" WHERE parent_id=? AND deleted_at IS NULL', out[i]).rows)
      out.push(String(r.id));
  return out;
}

/** erp_finance.category_view (null se não existe ou foi excluída). */
export function categoryView(db: SqlDriver, id: string) {
  const c = one(db, `SELECT ${CATEGORY_COLS} FROM "erp_finance__category" WHERE id=? AND deleted_at IS NULL`, id);
  if (!c) return null;
  const defaults = db
    .exec('SELECT key FROM "erp_finance__category_default" WHERE category_id=?', id)
    .rows.map((r) => String(r.key))
    .sort(cmpText);
  const children = one(db, 'SELECT count(*) n FROM "erp_finance__category" WHERE parent_id=? AND deleted_at IS NULL', id)!.n;
  return {
    id: c.id,
    parent_id: c.parent_id,
    name: c.name,
    kind: c.kind,
    dre_group: c.dre_group,
    active: bool(c.active),
    depth: categoryDepth(db, id),
    defaults,
    children: Number(children),
    in_use: categoryInUse(db, id),
    version: c.version,
    updated_at: ts(c.updated_at),
  };
}

/** erp_finance.category_tree_guard, para INSERT (old=null) e UPDATE. */
function categoryTreeGuard(db: SqlDriver, old: Row | null, next: Row) {
  if (old) {
    if (next.parent_id !== old.parent_id) raise("40001", "erp_finance_category_parent_locked");
    if (
      next.kind !== old.kind &&
      (next.parent_id !== null ||
        !!one(db, 'SELECT 1 x FROM "erp_finance__category" WHERE parent_id=? LIMIT 1', next.id) ||
        categoryInUse(db, String(next.id)) ||
        !!one(db, 'SELECT 1 x FROM "erp_finance__category_default" WHERE category_id=? LIMIT 1', next.id))
    )
      raise("40001", "erp_finance_category_in_use");
    if (old.deleted_at !== null) raise("40001", "erp_finance_deleted_category");
  }
  if (next.parent_id !== null && next.parent_id !== undefined) {
    const p = one(db, 'SELECT kind, deleted_at FROM "erp_finance__category" WHERE id=?', next.parent_id);
    if (!p || p.kind !== next.kind || p.deleted_at !== null) raise("22023", "erp_finance_invalid_parent");
    if ((categoryDepth(db, String(next.parent_id)) ?? 0) + 1 > (next.kind === "payable" ? 3 : 2))
      raise("22023", "erp_finance_category_depth");
  }
}

export function insertCategory(
  ctx: RpcContext,
  c: { name: string; kind: string; parent_id: string | null; dre_group: string | null; active?: boolean },
) {
  const id = crypto.randomUUID();
  categoryTreeGuard(ctx.db, null, { id, ...c });
  const now = ctx.clock.next().toString();
  ctx.db.exec(
    'INSERT INTO "erp_finance__category"(id, name, kind, parent_id, dre_group, active, version, created_at, updated_at) VALUES(?,?,?,?,?,?,1,?,?)',
    id,
    c.name,
    c.kind,
    c.parent_id,
    c.dre_group,
    c.active === false ? 0 : 1,
    now,
    now,
  );
  return id;
}

/** UPDATE de uma categoria com o category_tree_guard; sobe a versão. */
export function updateCategory(ctx: RpcContext, id: string, set: Record<string, unknown>) {
  const old = categoryRow(ctx.db, id);
  if (!old) return;
  categoryTreeGuard(ctx.db, old, { ...old, ...set });
  writeRow(ctx, "erp_finance__category", "id", id, {
    ...set,
    version: Number(old.version) + 1,
    updated_at: ctx.clock.next().toString(),
  });
}

/** erp_finance.category_siorigin_taken: nome já usado entre as irmãs (sem diferença de caixa). */
export function categorySiblingTaken(db: SqlDriver, kind: string, parent: string | null, name: string, except: string | null) {
  const target = pgLower(name);
  return db
    .exec(
      `SELECT id, name FROM "erp_finance__category" WHERE kind=? AND parent_id IS ? AND deleted_at IS NULL`,
      kind,
      parent,
    )
    .rows.some((r) => pgLower(String(r.name)) === target && r.id !== except);
}

/** erp_finance.category_name */
export function categoryName(data: unknown, key: string) {
  const v = txt(data, key, 100, true)!;
  if (CNTRL.test(v)) raise("22023", "erp_finance_invalid_text");
  return v;
}

/** erp_finance.category_dre */
export function categoryDre(value: unknown, kind: string, top: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (!top || jsonType(value) !== "string") raise("22023", "erp_finance_invalid_dre_group");
  const v = value as string;
  const ok =
    (kind === "receivable" && ["none", "gross_revenue", "financial_revenue", "other_revenue"].includes(v)) ||
    (kind === "payable" &&
      ["none", "revenue_deductions", "operating_expenses", "financial_expenses", "other_expenses", "income_taxes"].includes(v));
  if (!ok) raise("22023", "erp_finance_invalid_dre_group");
  return v;
}

/** erp_finance.category_default_kind */
export const categoryDefaultKind = (key: string) =>
  ["receipt_additions", "receipt_interest", "payment_discounts", "sale", "service", "transfer_in"].includes(key)
    ? "receivable"
    : ["receipt_discounts", "receipt_fees", "payment_additions", "payment_interest", "purchase"].includes(key)
      ? "payable"
      : null;

// ---------------------------------------------------------------------------
// Conta a pagar/receber (erp_finance.title): gatilhos de UPDATE

/**
 * Guardas de UPDATE em title (protect_*, title_history_guard,
 * title_long_history) e o zz_origin_sync. `set` traz só as colunas que mudam.
 * Devolve o set efetivo (title_long_history pode limpar o histórico).
 */
export function titleUpdateGuards(ctx: RpcContext, old: Row, set: Record<string, unknown>) {
  const db = ctx.db;
  const next = { ...old, ...set };
  const changed = (cols: string[]) => cols.some((c) => c in set && set[c] !== old[c]);
  const lifecycle = () =>
    (next.cancelled !== old.cancelled && bool(next.cancelled) !== bool(old.cancelled)) ||
    (next.deleted_at === null) !== (old.deleted_at === null);
  // protect_finance_document_source
  if (one(db, 'SELECT 1 x FROM "erp_finance__document_title" WHERE title_id=? LIMIT 1', old.id))
    if (changed(["id", "group_id", "installment", "installments", "kind", "contact_id", "issued_on", "amount_cents"]))
      raise("40001", "erp_finance_source_locked");
  // protect_grouped_billing_title
  if (one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_title" WHERE title_id=? LIMIT 1', old.id)) {
    if (changed(["group_id", "installment", "installments", "kind", "contact_id", "issued_on", "amount_cents"]))
      raise("40001", "erp_finance_source_locked");
    if (lifecycle() && flag(ctx, "erp_finance.grouped_owner") !== "on") raise("40001", "erp_finance_source_locked");
  }
  // protect_invoice_title
  const posting = one(db, 'SELECT posting_id FROM "erp_finance__invoice_title" WHERE title_id=?', old.id)?.posting_id ?? null;
  if (posting !== null) {
    if (changed(["group_id", "installment", "installments", "kind", "contact_id", "issued_on", "amount_cents"]))
      raise("40001", "erp_finance_source_locked");
    if (lifecycle() && flag(ctx, "erp_finance.invoice_owner") !== String(posting)) raise("40001", "erp_finance_source_locked");
  }
  // protect_origin_import_title
  if (one(db, 'SELECT 1 x FROM "erp_finance__origin_import_origin" WHERE title_id=? LIMIT 1', old.id))
    if (changed(["id", "group_id", "installment", "installments", "kind", "contact_id", "issued_on", "amount_cents", "source_reference"]))
      raise("40001", "erp_origin_import_title_locked");
  // title_history_guard
  if (old.deleted_at !== null) raise("40001", "erp_finance_deleted_title");
  if (changed(["original_due_on"])) raise("40001", "erp_finance_original_due_locked");
  // title_long_history
  const out = { ...set };
  if ("description" in set && set.description !== old.description && (!("history" in set) || set.history === old.history))
    out.history = null;
  return out;
}

/** zz_origin_sync de title e settlement (erp_sync.capture_finance): com o Origin desligado não grava. */
export function captureFinance(ctx: RpcContext, entity: "title" | "settlement", id: string) {
  if (!sync.enabled(ctx) || sync.applying(ctx)) return;
  raise("0A000", `rpc_not_ported:erp_sync.capture_finance(${entity})`);
}

/**
 * UPDATE em bordero/bordero_item só da categoria, com erp_finance.reclassify
 * ligado (bordero_immutable deixa passar só isso).
 */
export function reclassifyBorderos(ctx: RpcContext, ids: string[], target: string | null) {
  const list = JSON.stringify(ids);
  const count = (table: string) =>
    Number(
      one(ctx.db, `SELECT count(*) n FROM "${table}" WHERE category_id IN (SELECT value FROM json_each(?))`, list)!.n,
    );
  const borderos = count("erp_finance__bordero");
  const items = count("erp_finance__bordero_item");
  ctx.db.exec(
    `UPDATE "erp_finance__bordero" SET category_id=? WHERE category_id IN (SELECT value FROM json_each(?))`,
    target,
    list,
  );
  ctx.db.exec(
    `UPDATE "erp_finance__bordero_item" SET category_id=? WHERE category_id IN (SELECT value FROM json_each(?))`,
    target,
    list,
  );
  return { borderos, items };
}
