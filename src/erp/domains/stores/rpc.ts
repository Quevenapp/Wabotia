// Lojas e filiais (motor; structural.ts, lojas; tabelas erp_store__*, versão 27).
// RPCs só do motor, todos da Base (Cadastros): cada seção que depende de outra
// parte (Vendas, Estoque, Financeiro, PDV) confere a parte e some quando ela
// está desligada.
// - erp_store_overview: lojas, a loja em uso e o limite da pessoa; para o
//   administrador, os depósitos, as contas (caixas) e as pessoas;
// - erp_store_save: cria ou altera a loja (dados, depósitos, contas, depósito
//   padrão e série); a primeira loja nasce sozinha com os dados da empresa;
// - erp_store_person_set: limita a pessoa a uma ou mais lojas (administrador);
// - erp_store_select: a loja em uso da pessoa (estreita listas e relatórios);
// - erp_store_assign: muda a loja de um documento ou de uma conta a pagar/receber;
// - erp_store_operations: as operações de uma loja (listas com filtro por loja);
// - erp_store_report: vendas, PDV, caixa, estoque e DRE por loja, lado a lado.
import { createHash } from "node:crypto";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { formatScaled } from "../../engine/dec.ts";
import { ErpError, raise } from "../../engine/errors.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { validDate } from "../../engine/time.ts";
import { permitted } from "../access/public.ts";
import * as documents from "../documents/public.ts";
import { dreCategories, dreParts, dreSummary } from "../finance/rpc/erp_finance_dre.ts";
import {
  STORE, STORE_ACCOUNT, STORE_AUDIT, STORE_COMMAND, STORE_DOCUMENT, STORE_PERSON, STORE_SELECTION, STORE_TITLE, STORE_WAREHOUSE,
  StoreResolver, allowedStores, defaultStore, mainStoreId, multiStore, personStores, roleOf, selectedStore, storeAllowed, storeRows,
} from "./public.ts";
import { ADDRESS_KEYS, OPERATION_KINDS, cleanAddress, cleanCnpj, cleanPhone, type OperationKind } from "./model.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (code = "erp_store_invalid"): never => raise("22023", code);
const parse = (v: unknown): any => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const now = (ctx: RpcContext) => ctx.clock.next().toString();
const left = (v: unknown, n: number) => (v === null || v === undefined ? null : [...String(v)].slice(0, n).join(""));

function argsOf(raw: unknown, allowed: readonly string[]) {
  const a = parse(raw ?? {});
  if (!a || typeof a !== "object" || Array.isArray(a) || JSON.stringify(a).length > 65536 || Object.keys(a).some((k) => !allowed.includes(k))) invalid();
  return a as Record<string, any>;
}
const uuidOf = (v: unknown, required = true): string | null => {
  if (v === undefined || v === null || v === "") return required ? invalid() : null;
  if (typeof v !== "string" || !UUID.test(v)) invalid();
  return (v as string).toLowerCase();
};
const idsOf = (v: unknown, max = 200): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max) invalid();
  return [...new Set((v as unknown[]).map((x) => uuidOf(x)!))];
};
const dayOf = (v: unknown, fallback: string | null = null): string | null => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" || !DAY.test(v) || !validDate(v)) invalid("erp_store_period_invalid");
  return v as string;
};
function commandOf(a: RpcArgs): string {
  const c = a.p_command_id;
  if (typeof c !== "string" || !UUID.test(c)) invalid("erp_store_command_missing");
  return (c as string).toLowerCase();
}
function replay(db: SqlDriver, command: string, user: string, hash: string) {
  const r = one(db, `SELECT actor, request_hash, result FROM "${STORE_COMMAND}" WHERE command_id=?`, command);
  if (!r) return null;
  if (r.actor !== user || r.request_hash !== hash) raise("40001", "erp_store_command_conflict");
  return { ...JSON.parse(String(r.result)), replayed: true };
}
function receipt(ctx: RpcContext, command: string, user: string, hash: string, action: string, target: string, before: unknown, result: Record<string, unknown>) {
  const at = now(ctx);
  ctx.db.exec(`INSERT INTO "${STORE_COMMAND}"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)`, command, user, hash, JSON.stringify(result), at);
  ctx.db.exec(`INSERT INTO "${STORE_AUDIT}"(command_id, actor, action, target, before_data, after_data, created_at) VALUES(?,?,?,?,?,?,?)`,
    command, user, action, target, before === null || before === undefined ? null : JSON.stringify(before), JSON.stringify(result), at);
  return { ...result, replayed: false };
}
const hashOf = (op: string, user: string, args: unknown) => sha256(JSON.stringify({ op, user, args }));

/** Pessoa ativa no ERP (qualquer papel lê); gravar o cadastro é do administrador. */
function requireMember(db: SqlDriver, user: string, admin = false): string {
  const role = roleOf(db, user);
  if (!role) raise("42501", "erp_store_access_denied");
  if (admin && role !== "admin") raise("42501", "erp_store_admin_only");
  return role!;
}

// ---------------------------------------------------------------------------
// A primeira loja

/** A loja principal, criada na primeira vez com os dados da empresa (nome fantasia, endereço e telefone). */
export function ensureMainStore(ctx: RpcContext, user: string): string {
  const existing = mainStoreId(ctx.db);
  if (existing) return existing;
  const company = parse(one(ctx.db, 'SELECT data FROM "erp_company__identity" WHERE singleton=1')?.data) ?? {};
  const name = left(String(company.trade_name || company.legal_name || "Loja principal").trim(), 80) || "Loja principal";
  const address = cleanAddress(Object.fromEntries(ADDRESS_KEYS.map((k) => [k, company[k] ?? null])), true);
  const phone = cleanPhone(company.phone, true);
  const id = crypto.randomUUID();
  const at = now(ctx);
  // Nome repetido (uma loja inativa com o nome da empresa): a principal leva o sufixo.
  const taken = one(ctx.db, `SELECT 1 x FROM "${STORE}" WHERE lower(name)=lower(?)`, name);
  ctx.db.exec(`INSERT INTO "${STORE}"(id, name, is_main, active, address, phone, cnpj, default_warehouse_id, fiscal_series, version, created_at, updated_at, updated_by)
    VALUES(?,?,1,1,?,?,NULL,?,NULL,1,?,?,?)`, id, taken ? left(`${name} (principal)`, 80) : name, JSON.stringify(address), phone,
    (one(ctx.db, 'SELECT warehouse_id FROM "erp_stock__warehouse_default" WHERE singleton=1')?.warehouse_id as string | undefined) ?? null, at, at, user);
  return id;
}

// ---------------------------------------------------------------------------
// Leitura do cadastro

function storeDto(db: SqlDriver, r: Row, detail: boolean) {
  const id = String(r.id);
  const main = Number(r.is_main) === 1;
  // A principal fica com tudo o que não tem vínculo.
  const warehouses = db.exec(`SELECT r.id, r.name, r.active FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id
    LEFT JOIN "${STORE_WAREHOUSE}" l ON l.warehouse_id=r.id WHERE ${main ? "(l.store_id IS NULL OR l.store_id=?)" : "l.store_id=?"} ORDER BY lower(r.name), r.id`, id).rows;
  const accounts = db.exec(`SELECT a.id, a.name, a.kind, a.active FROM "erp_finance__account" a LEFT JOIN "${STORE_ACCOUNT}" l ON l.account_id=a.id
    WHERE a.deleted_at IS NULL AND ${main ? "(l.store_id IS NULL OR l.store_id=?)" : "l.store_id=?"} ORDER BY lower(a.name), a.id`, id).rows;
  const dw = r.default_warehouse_id ? one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', r.default_warehouse_id) : null;
  return {
    id, name: String(r.name), is_main: main, active: Number(r.active) === 1, version: Number(r.version),
    ...(detail ? {
      address: parse(r.address) ?? {}, phone: r.phone ?? null, cnpj: r.cnpj ?? null, fiscal_series: r.fiscal_series ?? null,
      default_warehouse_id: r.default_warehouse_id ?? null, default_warehouse_name: dw ? String(dw.name) : null,
      warehouses: warehouses.map((w) => ({ id: String(w.id), name: String(w.name), active: Number(w.active) === 1 })),
      accounts: accounts.map((a) => ({ id: String(a.id), name: String(a.name), kind: String(a.kind), active: Number(a.active) === 1 })),
      people: Number(one(db, `SELECT count(*) n FROM "${STORE_PERSON}" WHERE store_id=?`, id)?.n ?? 0),
    } : {}),
  };
}

export function overview(ctx: RpcContext, user: string) {
  const db = ctx.db;
  const role = requireMember(db, user);
  ensureMainStore(ctx, user);
  const allowed = allowedStores(ctx, user);
  const all = db.exec(`SELECT * FROM "${STORE}" ORDER BY active DESC, is_main DESC, lower(name), id`).rows;
  const admin = role === "admin";
  const visible = all.filter((s) => (admin || Number(s.active) === 1) && storeAllowed(allowed, String(s.id)));
  const selected = selectedStore(db, user);
  const base = {
    scope: "erp_stores", data_mode: "erp_native", role, admin,
    multi: multiStore(db),
    me: {
      user_id: user, limited: personStores(db, user) !== null || ctx.identity?.store_scope !== undefined,
      allowed: allowed === null ? null : [...allowed],
      selected_store_id: selected && storeAllowed(allowed, selected) ? selected : null,
      default_store_id: defaultStore(ctx, user),
    },
    stores: visible.map((s) => storeDto(db, s, admin || storeAllowed(allowed, String(s.id)))),
  };
  if (!admin) return base;
  const r = new StoreResolver(db);
  return {
    ...base,
    warehouses: db.exec(`SELECT r.id, r.name, r.active FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id ORDER BY lower(r.name), r.id`).rows
      .map((w) => ({ id: String(w.id), name: String(w.name), active: Number(w.active) === 1, store_id: r.warehouse(w.id) })),
    accounts: db.exec(`SELECT id, name, kind, active FROM "erp_finance__account" WHERE deleted_at IS NULL ORDER BY lower(name), id`).rows
      .map((a) => ({ id: String(a.id), name: String(a.name), kind: String(a.kind), active: Number(a.active) === 1, store_id: r.account(a.id) })),
    people: db.exec(`SELECT m.user_id, m.role, p.name FROM "erp_access__membership" m LEFT JOIN "erp_access__profile" p ON p.user_id=m.user_id
      WHERE m.active=1 ORDER BY lower(coalesce(p.name, '')), m.user_id`).rows.map((p) => ({
        user_id: String(p.user_id), name: p.name ?? null, role: String(p.role),
        store_ids: db.exec(`SELECT store_id FROM "${STORE_PERSON}" WHERE user_id=? ORDER BY store_id`, p.user_id).rows.map((x) => String(x.store_id)),
      })),
  };
}

// ---------------------------------------------------------------------------
// Gravações

/** Antes de mudar a loja de um depósito ou de uma conta, o histórico fica na loja em que aconteceu. */
function freezeWarehouse(ctx: RpcContext, user: string, warehouse: string, r: StoreResolver, at: string) {
  const from = r.warehouse(warehouse);
  if (!from) return;
  ctx.db.exec(`INSERT INTO "${STORE_DOCUMENT}"(document_id, store_id, source, updated_by, updated_at)
    SELECT d.id, ?, 'warehouse', ?, ? FROM "erp_documents__document" d WHERE d.warehouse_id=? AND NOT EXISTS(SELECT 1 FROM "${STORE_DOCUMENT}" x WHERE x.document_id=d.id)`,
    from, user, at, warehouse);
}
function freezeAccount(ctx: RpcContext, user: string, account: string, r: StoreResolver, at: string) {
  const db = ctx.db;
  for (const t of db.exec(`SELECT id, group_id, account_id FROM "erp_finance__title" t WHERE account_id=? AND NOT EXISTS(SELECT 1 FROM "${STORE_TITLE}" x WHERE x.title_id=t.id)`, account).rows) {
    const store = r.title(t.id, t.account_id, t.group_id);
    if (store) db.exec(`INSERT INTO "${STORE_TITLE}"(title_id, store_id, source, updated_by, updated_at) VALUES(?,?,'account',?,?)`, t.id, store, user, at);
  }
  for (const s of db.exec(`SELECT DISTINCT document_id FROM "erp_pos__sale" s WHERE account_id=? AND document_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM "${STORE_DOCUMENT}" x WHERE x.document_id=s.document_id)`, account).rows) {
    const store = r.account(account);
    if (store) db.exec(`INSERT INTO "${STORE_DOCUMENT}"(document_id, store_id, source, updated_by, updated_at) VALUES(?,?,'account',?,?)`, s.document_id, store, user, at);
  }
}

const SAVE_KEYS = ["id", "expected_version", "name", "address", "phone", "cnpj", "default_warehouse_id", "fiscal_series", "active", "warehouse_ids", "account_ids"];

export function saveStore(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  requireMember(db, user, true);
  const a = argsOf(raw, SAVE_KEYS);
  const hash = hashOf("save", user, a);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const main = ensureMainStore(ctx, user);
  const id = uuidOf(a.id, false);
  const current = id ? one(db, `SELECT * FROM "${STORE}" WHERE id=?`, id) : null;
  if (id && !current) raise("P0002", "erp_store_not_found");
  if (current && Number(a.expected_version) !== Number(current.version)) raise("40001", "erp_store_version_conflict");
  const name = typeof a.name === "string" ? a.name.trim().replace(/\s+/g, " ") : current ? String(current.name) : "";
  if (!name || [...name].length > 80 || /[\u0000-\u001f\u007f]/.test(name)) invalid("erp_store_name_invalid");
  if (one(db, `SELECT 1 x FROM "${STORE}" WHERE lower(name)=lower(?) AND id<>?`, name, id ?? "")) raise("23505", "erp_store_name_taken");
  const address = a.address === undefined ? (current ? parse(current.address) : {}) : cleanAddress(a.address);
  const phone = a.phone === undefined ? (current?.phone ?? null) : cleanPhone(a.phone);
  const cnpj = a.cnpj === undefined ? (current?.cnpj ?? null) : cleanCnpj(a.cnpj);
  let series = a.fiscal_series === undefined ? (current?.fiscal_series ?? null) : a.fiscal_series;
  if (series === "" ) series = null;
  if (series !== null && (typeof series !== "number" || !Number.isInteger(series) || series < 0 || series > 999)) invalid("erp_store_series_invalid");
  const isMain = current ? Number(current.is_main) === 1 : false;
  const active = a.active === undefined ? (current ? Number(current.active) === 1 : true) : a.active;
  if (typeof active !== "boolean") invalid();
  if (isMain && !active) raise("22023", "erp_store_main_active");
  const storeId = id ?? crypto.randomUUID();
  const at = now(ctx);
  const before = current ? storeDto(db, current, true) : null;
  if (current) {
    db.exec(`UPDATE "${STORE}" SET name=?, address=?, phone=?, cnpj=?, fiscal_series=?, active=?, version=version+1, updated_at=?, updated_by=? WHERE id=?`,
      name, JSON.stringify(address), phone, cnpj, series, active ? 1 : 0, at, user, storeId);
  } else {
    db.exec(`INSERT INTO "${STORE}"(id, name, is_main, active, address, phone, cnpj, default_warehouse_id, fiscal_series, version, created_at, updated_at, updated_by)
      VALUES(?,?,0,?,?,?,?,NULL,?,1,?,?,?)`, storeId, name, active ? 1 : 0, JSON.stringify(address), phone, cnpj, series, at, at, user);
  }
  const r = new StoreResolver(db);
  // Depósitos e contas da loja: os listados passam para ela; os que saem voltam para a principal.
  const relink = (ids: string[] | undefined, table: string, key: string, exists: (x: string) => boolean, freeze: (x: string) => void) => {
    if (ids === undefined) return;
    for (const x of ids) if (!exists(x)) raise("P0002", key === "warehouse_id" ? "erp_store_warehouse_not_found" : "erp_store_account_not_found");
    const owned = db.exec(`SELECT ${key} k FROM "${table}" WHERE store_id=?`, storeId).rows.map((row) => String(row.k));
    for (const x of owned) if (!ids.includes(x) && storeId !== main) { freeze(x); db.exec(`DELETE FROM "${table}" WHERE ${key}=?`, x); }
    for (const x of ids) {
      const was = key === "warehouse_id" ? r.warehouse(x) : r.account(x);
      if (was === storeId) continue;
      freeze(x);
      if (storeId === main) db.exec(`DELETE FROM "${table}" WHERE ${key}=?`, x);
      else db.exec(`INSERT INTO "${table}"(${key}, store_id, updated_by, updated_at) VALUES(?,?,?,?) ON CONFLICT(${key}) DO UPDATE SET store_id=excluded.store_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, x, storeId, user, at);
    }
  };
  relink(idsOf(a.warehouse_ids), STORE_WAREHOUSE, "warehouse_id",
    (x) => !!one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id WHERE r.id=?', x),
    (x) => freezeWarehouse(ctx, user, x, r, at));
  relink(idsOf(a.account_ids), STORE_ACCOUNT, "account_id",
    (x) => !!one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND deleted_at IS NULL', x),
    (x) => freezeAccount(ctx, user, x, r, at));
  const after = new StoreResolver(db);
  // O depósito padrão da loja é um dos depósitos dela; o que saiu da loja deixa de ser o padrão.
  let dw = a.default_warehouse_id === undefined ? (current?.default_warehouse_id ?? null) : uuidOf(a.default_warehouse_id, false);
  if (dw !== null && a.default_warehouse_id !== undefined && after.warehouse(dw) !== storeId) raise("22023", "erp_store_default_warehouse_outside");
  if (dw !== null && after.warehouse(dw) !== storeId) dw = null;
  db.exec(`UPDATE "${STORE}" SET default_warehouse_id=? WHERE id=?`, dw, storeId);
  for (const other of db.exec(`SELECT id, default_warehouse_id FROM "${STORE}" WHERE id<>? AND default_warehouse_id IS NOT NULL`, storeId).rows)
    if (after.warehouse(other.default_warehouse_id) !== String(other.id)) db.exec(`UPDATE "${STORE}" SET default_warehouse_id=NULL WHERE id=?`, other.id);
  if (!active) db.exec(`DELETE FROM "${STORE_SELECTION}" WHERE store_id=?`, storeId);
  const saved = storeDto(db, one(db, `SELECT * FROM "${STORE}" WHERE id=?`, storeId)!, true);
  return receipt(ctx, command, user, hash, current ? "update" : "create", storeId, before, { entity: "store", action: current ? "update" : "create", store: saved });
}

export function setPerson(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  requireMember(db, user, true);
  const a = argsOf(raw, ["user_id", "store_ids"]);
  const target = uuidOf(a.user_id)!;
  const ids = idsOf(a.store_ids) ?? invalid();
  const hash = hashOf("person", user, a);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const role = roleOf(db, target);
  if (!role) raise("P0002", "erp_store_person_not_found");
  if (role === "admin" && ids.length) raise("22023", "erp_store_admin_unrestricted");
  ensureMainStore(ctx, user);
  for (const s of ids) if (!one(db, `SELECT 1 x FROM "${STORE}" WHERE id=? AND active=1`, s)) raise("P0002", "erp_store_not_found");
  const before = db.exec(`SELECT store_id FROM "${STORE_PERSON}" WHERE user_id=? ORDER BY store_id`, target).rows.map((x) => String(x.store_id));
  const at = now(ctx);
  db.exec(`DELETE FROM "${STORE_PERSON}" WHERE user_id=?`, target);
  for (const s of ids) db.exec(`INSERT INTO "${STORE_PERSON}"(user_id, store_id, updated_by, updated_at) VALUES(?,?,?,?)`, target, s, user, at);
  // A loja em uso fora do novo limite deixa de valer.
  const sel = one(db, `SELECT store_id FROM "${STORE_SELECTION}" WHERE user_id=?`, target)?.store_id as string | undefined;
  if (sel && ids.length && !ids.includes(sel)) db.exec(`DELETE FROM "${STORE_SELECTION}" WHERE user_id=?`, target);
  return receipt(ctx, command, user, hash, "person", target, { store_ids: before }, { entity: "store_person", user_id: target, store_ids: [...ids].sort() });
}

export function selectStore(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  requireMember(db, user);
  const a = argsOf(raw, ["store_id"]);
  const store = uuidOf(a.store_id, false);
  const allowed = allowedStores(ctx, user);
  if (store !== null) {
    if (!one(db, `SELECT 1 x FROM "${STORE}" WHERE id=? AND active=1`, store)) raise("P0002", "erp_store_not_found");
    if (!storeAllowed(allowed, store)) raise("42501", "erp_store_denied");
  }
  db.exec(`INSERT INTO "${STORE_SELECTION}"(user_id, store_id, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET store_id=excluded.store_id, updated_at=excluded.updated_at`,
    user, store, now(ctx));
  return { entity: "store_selection", selected_store_id: store, default_store_id: defaultStore(ctx, user) };
}

export function assignStore(ctx: RpcContext, user: string, command: string, raw: unknown) {
  const db = ctx.db;
  const role = requireMember(db, user);
  if (!["admin", "vendas", "financeiro", "estoque"].includes(role)) raise("42501", "erp_store_role_denied");
  const a = argsOf(raw, ["entity", "id", "store_id"]);
  if (!["document", "title"].includes(a.entity)) invalid();
  const id = uuidOf(a.id)!, store = uuidOf(a.store_id)!;
  const hash = hashOf("assign", user, a);
  const again = replay(db, command, user, hash);
  if (again) return again;
  if (!one(db, `SELECT 1 x FROM "${STORE}" WHERE id=? AND active=1`, store)) raise("P0002", "erp_store_not_found");
  const r = new StoreResolver(db);
  const exists = a.entity === "document"
    ? one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=? AND deleted_at IS NULL', id)
    : one(db, 'SELECT 1 x FROM "erp_finance__title" WHERE id=? AND deleted_at IS NULL', id);
  if (!exists) raise("P0002", "erp_store_record_not_found");
  const from = a.entity === "document" ? r.document(id) : r.title(id);
  const allowed = allowedStores(ctx, user);
  if (!storeAllowed(allowed, from) || !storeAllowed(allowed, store)) raise("42501", "erp_store_denied");
  const at = now(ctx);
  const [table, key] = a.entity === "document" ? [STORE_DOCUMENT, "document_id"] : [STORE_TITLE, "title_id"];
  db.exec(`INSERT INTO "${table}"(${key}, store_id, source, updated_by, updated_at) VALUES(?,?,'chosen',?,?)
    ON CONFLICT(${key}) DO UPDATE SET store_id=excluded.store_id, source='chosen', updated_by=excluded.updated_by, updated_at=excluded.updated_at`, id, store, user, at);
  return receipt(ctx, command, user, hash, "assign", id, { store_id: from }, { entity: "store_assignment", record: a.entity, id, store_id: store });
}

// ---------------------------------------------------------------------------
// Leituras por loja

/** Lojas que a consulta abrange: as pedidas (dentro do que a pessoa vê) ou todas as que ela vê. */
function scopeStores(ctx: RpcContext, user: string, requested: string[] | undefined) {
  const allowed = allowedStores(ctx, user);
  const rows = storeRows(ctx.db).filter((s) => storeAllowed(allowed, s.id));
  if (requested === undefined || !requested.length) return rows;
  for (const id of requested) if (!storeAllowed(allowed, id)) raise("42501", "erp_store_denied");
  return rows.filter((s) => requested.includes(s.id));
}

const cents = (v: unknown) => (v === null || v === undefined ? 0n : BigInt(String(v)));
const money2 = (v: bigint) => formatScaled(v, 2);
const DOC_LABEL: Record<string, string> = { sales_orders: "Pedido de venda", sales_proposals: "Proposta", purchase_orders: "Pedido de compra" };

export function operations(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  requireMember(db, user);
  const a = argsOf(raw, ["kind", "store_id", "from", "to", "page", "limit"]);
  const kind = a.kind as OperationKind;
  if (!OPERATION_KINDS.includes(kind)) invalid();
  const need = (ok: boolean) => { if (!ok) throw new ErpError("module_disabled", "Esta rotina depende de uma parte desligada."); };
  if (kind === "sales_orders" || kind === "sales_proposals") need(ctx.parts.sales);
  if (kind === "purchase_orders") need(ctx.parts.purchases);
  if (kind === "titles") need(ctx.parts.finance);
  if (kind === "stock_moves") need(ctx.parts.stock);
  if (kind === "pos_sales") need(ctx.parts.pos);
  const stores = scopeStores(ctx, user, a.store_id ? [uuidOf(a.store_id)!] : undefined);
  const wanted = new Set(stores.map((s) => s.id));
  const names = new Map(stores.map((s) => [s.id, s.name]));
  const from = dayOf(a.from), to = dayOf(a.to);
  if (from && to && from > to) invalid("erp_store_period_invalid");
  const page = a.page === undefined ? 1 : Number(a.page), limit = a.limit === undefined ? 50 : Number(a.limit);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
  const r = new StoreResolver(db);
  const inDay = (d: unknown) => typeof d === "string" && (!from || d >= from) && (!to || d <= to);
  let items: Record<string, unknown>[] = [];
  if (kind === "sales_orders" || kind === "sales_proposals" || kind === "purchase_orders") {
    // O papel decide se a pessoa vê o tipo (o mesmo cartão da lista de documentos).
    try { documents.requireAccess(db, user, kind, false); } catch { raise("42501", "erp_store_role_denied"); }
    for (const d of db.exec(`SELECT id, number, status, warehouse_id, contact_snapshot, json_extract(body, '$.date') day, CAST(total AS TEXT) total
        FROM "erp_documents__document" WHERE kind=? AND deleted_at IS NULL AND authority='brufap' ORDER BY json_extract(body, '$.date') DESC, number DESC`, kind).rows) {
      if (!inDay(d.day) && (from || to)) continue;
      const store = r.document(d.id, d.warehouse_id);
      if (!store || !wanted.has(store)) continue;
      items.push({ id: d.id, label: DOC_LABEL[kind], number: d.number === null ? null : String(d.number), status: d.status, date: d.day ?? null,
        contact_name: left(parse(d.contact_snapshot)?.name, 200), total: d.total === null ? null : money2(cents(d.total)), store_id: store, store_name: names.get(store) ?? null });
    }
  } else if (kind === "titles") {
    if (!["admin", "financeiro", "consulta"].includes(roleOf(db, user) ?? "")) raise("42501", "erp_store_role_denied");
    for (const t of db.exec(`SELECT id, kind, description, due_on, amount_cents, settled_cents, cancelled, group_id, account_id, installment, installments
        FROM "erp_finance__title" WHERE deleted_at IS NULL ORDER BY due_on DESC, id`).rows) {
      if (!inDay(t.due_on) && (from || to)) continue;
      const store = r.title(t.id, t.account_id, t.group_id);
      if (!store || !wanted.has(store)) continue;
      items.push({ id: t.id, label: t.kind === "receivable" ? "A receber" : "A pagar", description: Number(t.installments) > 1 ? `${t.description} ${t.installment}/${t.installments}` : t.description,
        date: t.due_on, total: money2(cents(t.amount_cents)), settled: money2(cents(t.settled_cents)), status: Number(t.cancelled) === 1 ? "cancelled" : cents(t.settled_cents) >= cents(t.amount_cents) ? "settled" : "open",
        store_id: store, store_name: names.get(store) ?? null });
    }
  } else if (kind === "stock_moves") {
    if (!["admin", "consulta", "vendas", "fiscal", "estoque"].includes(roleOf(db, user) ?? "")) raise("42501", "erp_store_role_denied");
    for (const m of db.exec(`SELECT m.id, m.kind, m.occurred_on, m.reason, e.warehouse_id, w.name warehouse_name, p.name product_name, CAST(e.quantity AS TEXT) quantity
        FROM "erp_stock__movement" m JOIN "erp_stock__entry" e ON e.movement_id=m.id LEFT JOIN "erp_catalog__record" w ON w.id=e.warehouse_id
        LEFT JOIN "erp_catalog__record" p ON p.id=e.product_id ORDER BY m.occurred_on DESC, m.created_at DESC, e.ordinal LIMIT 20000`).rows) {
      if (!inDay(m.occurred_on) && (from || to)) continue;
      const store = r.warehouse(m.warehouse_id);
      if (!store || !wanted.has(store)) continue;
      items.push({ id: m.id, label: m.kind === "transfer" ? "Transferência" : String(m.kind), description: `${m.product_name ?? ""} · ${m.warehouse_name ?? ""}`.trim(), date: m.occurred_on,
        quantity: formatScaled(BigInt(String(m.quantity)), 6), reason: left(m.reason, 200), store_id: store, store_name: names.get(store) ?? null });
    }
  } else {
    if (!["admin", "vendas", "consulta", "financeiro"].includes(roleOf(db, user) ?? "")) raise("42501", "erp_store_role_denied");
    for (const s of db.exec(`SELECT s.id, s.document_id, s.account_id, s.state, s.total_cents, s.created_at, d.number, json_extract(d.body, '$.date') day, a.name account_name
        FROM "erp_pos__sale" s LEFT JOIN "erp_documents__document" d ON d.id=s.document_id LEFT JOIN "erp_finance__account" a ON a.id=s.account_id
        ORDER BY s.created_at DESC`).rows) {
      if (!inDay(s.day) && (from || to)) continue;
      const store = s.document_id ? r.document(s.document_id) : r.account(s.account_id);
      if (!store || !wanted.has(store)) continue;
      items.push({ id: s.id, label: "Venda no caixa", number: s.number === null ? null : String(s.number), description: s.account_name ?? null, date: s.day ?? null, status: s.state,
        total: money2(cents(s.total_cents)), store_id: store, store_name: names.get(store) ?? null });
    }
  }
  const total = items.length;
  items = items.slice((page - 1) * limit, page * limit);
  return { scope: "erp_store_operations", data_mode: "erp_native", kind, page, limit, total, stores: stores.map((s) => ({ id: s.id, name: s.name })), items };
}

/** Relatório por loja: cada seção só com a parte ligada (e o DRE só com a permissão dele). */
export function report(ctx: RpcContext, user: string, raw: unknown) {
  const db = ctx.db;
  const role = requireMember(db, user);
  const a = argsOf(raw, ["from", "to", "store_ids", "basis"]);
  const from = dayOf(a.from) ?? invalid("erp_store_period_invalid");
  const to = dayOf(a.to) ?? invalid("erp_store_period_invalid");
  if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 1100) invalid("erp_store_period_invalid");
  const basis = a.basis === undefined ? "cash" : a.basis;
  if (!["cash", "competence"].includes(basis)) invalid();
  ensureMainStore(ctx, user);
  const stores = scopeStores(ctx, user, idsOf(a.store_ids, 50));
  const ids = stores.map((s) => s.id);
  const r = new StoreResolver(db);
  const blank = () => Object.fromEntries(ids.map((id) => [id, 0n])) as Record<string, bigint>;
  const sumOf = (m: Record<string, bigint>) => Object.values(m).reduce((t, x) => t + x, 0n);
  const out = (m: Record<string, bigint>, f = money2) => ({ by_store: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, f(v)])), total: f(sumOf(m)) });
  const result: Record<string, unknown> = { scope: "erp_store_report", data_mode: "erp_native", from, to, basis, role, stores: stores.map((s) => ({ id: s.id, name: s.name, is_main: s.is_main })) };
  const unavailable: string[] = [];

  // Vendas: pedidos de venda do período (sem os cancelados), com o que veio do caixa à parte.
  const sales = ctx.parts.sales && ["admin", "consulta", "vendas", "financeiro", "fiscal"].includes(role);
  if (sales) {
    const count = blank(), total = blank(), posCount = blank(), posTotal = blank();
    const fromPos = new Set(db.exec('SELECT document_id FROM "erp_pos__sale" WHERE document_id IS NOT NULL').rows.map((x) => String(x.document_id)));
    for (const d of db.exec(`SELECT id, warehouse_id, CAST(total AS TEXT) total FROM "erp_documents__document"
        WHERE kind='sales_orders' AND authority='brufap' AND deleted_at IS NULL AND status<>'cancelled' AND json_extract(body, '$.date') BETWEEN ? AND ?`, from, to).rows) {
      const store = r.document(d.id, d.warehouse_id);
      if (!store || !(store in count)) continue;
      count[store] += 1n; total[store] += cents(d.total);
      if (fromPos.has(String(d.id))) { posCount[store] += 1n; posTotal[store] += cents(d.total); }
    }
    const ticket = Object.fromEntries(ids.map((id) => [id, count[id] ? total[id] / count[id] : 0n]));
    result.sales = { orders: out(count, String), total: out(total), average_ticket: { by_store: Object.fromEntries(Object.entries(ticket).map(([k, v]) => [k, money2(v)])), total: money2(sumOf(count) ? sumOf(total) / sumOf(count) : 0n) },
      pos_orders: out(posCount, String), pos_total: out(posTotal) };
  } else unavailable.push("sales");

  // Caixa: entradas e saídas do período e o saldo de hoje das contas de cada loja; sessões do PDV abertas no período.
  const cash = ctx.parts.finance && ["admin", "financeiro", "consulta"].includes(role);
  if (cash) {
    const inflow = blank(), outflow = blank(), balance = blank(), sessions = blank(), open = blank();
    for (const m of db.exec(`SELECT m.account_id, m.delta_cents, m.posted_on FROM "erp_finance__movement" m JOIN "erp_finance__account" a ON a.id=m.account_id AND a.deleted_at IS NULL`).rows) {
      const store = r.account(m.account_id);
      if (!store || !(store in balance)) continue;
      const v = cents(m.delta_cents);
      balance[store] += v;
      if (String(m.posted_on) >= from && String(m.posted_on) <= to) { if (v > 0n) inflow[store] += v; else outflow[store] -= v; }
    }
    for (const s of db.exec(`SELECT account_id, state, opened_on FROM "erp_finance__cash_session" WHERE deleted_at IS NULL`).rows) {
      const store = r.account(s.account_id);
      if (!store || !(store in sessions)) continue;
      if (String(s.opened_on) >= from && String(s.opened_on) <= to) sessions[store] += 1n;
      if (s.state === "open") open[store] += 1n;
    }
    result.cash = { inflow: out(inflow), outflow: out(outflow), net: out(Object.fromEntries(ids.map((id) => [id, inflow[id] - outflow[id]]))), balance: out(balance),
      sessions: out(sessions, String), open_sessions: out(open, String) };
  } else unavailable.push("cash");

  // Estoque: o relatório financeiro do Estoque por depósito (a mesma conta de custo e venda), somado por loja.
  if (ctx.parts.stock && ["admin", "consulta", "vendas", "fiscal", "estoque"].includes(role)) {
    const qty = blank(), cost = blank(), sale = blank();
    let hidden = false;
    // Texto com as casas fixas ("12.500000", "30.00") → inteiro escalado.
    const q6 = (s: unknown) => (typeof s === "string" ? BigInt(s.replace(".", "")) : 0n);
    const m2 = q6;
    for (const w of db.exec(`SELECT r.id FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id`).rows) {
      const store = r.warehouse(w.id);
      if (!store || !(store in qty)) continue;
      try {
        const t = (invokeRpc(ctx, "erp_stock_report_financial", { p_user_id: user, p_warehouse_id: w.id, p_offset: 0, p_limit: 1 }) as { totals: Record<string, unknown> }).totals;
        qty[store] += q6(t.quantity); cost[store] += m2(t.cost_value); sale[store] += m2(t.sale_value);
      } catch (e) {
        if (!(e instanceof ErpError) || e.code !== "42501") throw e;
        hidden = true;
        const q = db.exec(`SELECT CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE warehouse_id=?`, w.id).rows;
        for (const b of q) qty[store] += BigInt(String(b.q));
      }
    }
    result.stock = { quantity: out(qty, (v) => formatScaled(v, 6)), ...(hidden ? { cost_hidden: true } : { cost_value: out(cost), sale_value: out(sale) }) };
  } else unavailable.push("stock");

  // DRE gerencial por loja: as mesmas partes do DRE, cada uma na loja da conta (caixa) ou da conta a pagar/receber.
  if (ctx.parts.finance && ["admin", "financeiro", "consulta"].includes(role) && permitted(db, user, "financas.caixas_bancos.dre")) {
    const parts = dreParts(db, basis as "cash" | "competence", from, to);
    const settlementAccount = new Map<string, unknown>(), entryAccount = new Map<string, unknown>();
    const storeOf = (p: (typeof parts)[number]): string | null => {
      if (p.source === "settlement" || p.source === "reversal") {
        if (!settlementAccount.has(p.ref)) settlementAccount.set(p.ref, one(db, 'SELECT account_id FROM "erp_finance__settlement" WHERE id=?', p.ref)?.account_id);
        return r.account(settlementAccount.get(p.ref));
      }
      if (p.source === "entry") {
        if (!entryAccount.has(p.ref)) entryAccount.set(p.ref, one(db, 'SELECT account_id FROM "erp_finance__cash_entry" WHERE id=?', p.ref)?.account_id);
        return r.account(entryAccount.get(p.ref));
      }
      return r.title(p.title_id);
    };
    const byStore = new Map(ids.map((id) => [id, [] as typeof parts]));
    for (const p of parts) byStore.get(storeOf(p) ?? "")?.push(p);
    const categories = dreCategories(db);
    const summaries = new Map(ids.map((id) => [id, dreSummary(categories, byStore.get(id)!, null)]));
    const line = (pick: (s: ReturnType<typeof dreSummary>) => string) => {
      const m = Object.fromEntries(ids.map((id) => [id, BigInt(pick(summaries.get(id)!))])) as Record<string, bigint>;
      return out(m);
    };
    const first = summaries.get(ids[0]);
    result.dre = {
      groups: (first?.groups ?? []).map((g, i) => ({ key: g.key, ...line((s) => s.groups[i].amount_cents) })),
      lines: (first?.lines ?? []).map((l, i) => ({ key: l.key, ...line((s) => s.lines[i].amount_cents) })),
      unclassified: line((s) => s.unclassified.amount_cents),
    };
  } else unavailable.push("dre");
  return { ...result, unavailable };
}

// ---------------------------------------------------------------------------
// Registro

const userOf = (a: RpcArgs) => uuidOf(a.p_user_id)!;
registerRpc("erp_store_overview", (ctx, a) => { argsOf(a.p_args, []); return overview(ctx, userOf(a)); });
registerRpc("erp_store_save", (ctx, a) => saveStore(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_store_person_set", (ctx, a) => setPerson(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_store_select", (ctx, a) => selectStore(ctx, userOf(a), a.p_args));
registerRpc("erp_store_assign", (ctx, a) => assignStore(ctx, userOf(a), commandOf(a), a.p_args));
registerRpc("erp_store_operations", (ctx, a) => operations(ctx, userOf(a), a.p_args));
registerRpc("erp_store_report", (ctx, a) => report(ctx, userOf(a), a.p_args));
