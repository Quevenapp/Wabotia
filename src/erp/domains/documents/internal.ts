// Documentos (erp_documents): funções internas. Portado de
// erp_documents.auto_products, a parte de erp_document_save que chama o
// catálogo (outro domínio) com o comando do documento.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { ERP_PART_KEYS, type ErpPartKey } from "../../parts.ts";
import { intIn } from "../../engine/args.ts";
import { pgBtrim, pgHasCntrl, pgLeft, pgLength } from "../../engine/text.ts";
import { jsonTimestamp, validDate } from "../../engine/time.ts";
import { notPorted, raise } from "../../engine/errors.ts";
import { arrow, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { autoProductKey, documentProduct } from "../catalog/public.ts";
import { projectCatalogRecord } from "../catalog/part-projection.ts";
import * as preferences from "../preferences/public.ts";
import { active as receiptsActive } from "../stock/public.ts";
import { transitions } from "./preferences.ts";
import { mirrorDetail } from "./mirror.ts";
import { originEffects } from "../sync/public.ts";

/** erp_documents.auto_products(p_user_id, p_kind, p_command, p_items) */
export function autoProducts(ctx: RpcContext, user: string, kind: string | null, command: string | null, items: unknown) {
  const list = () => {
    if (jsonType(items) !== "array")
      raise("22023", `cannot extract elements from ${jsonType(items) === "object" ? "an object" : "a scalar"}`);
    return items as unknown[];
  };
  if (
    preferences.get(ctx.db, autoProductKey(kind)) !== true ||
    !list().some((i) => arrow(i, "product_id") === null) ||
    (kind === "sales_orders" &&
      one(ctx.db, 'SELECT 1 x FROM "erp_catalog__seller" WHERE user_id=? AND allow_unregistered_products=0', user))
  )
    return items;
  return list().map((raw) => {
    if (arrow(raw, "product_id") !== null) return raw;
    const item = raw as Record<string, unknown>;
    const id = documentProduct(
      ctx,
      user,
      kind,
      command,
      kind === "service_orders" && arrow(item, "group") === "service" ? { ...item, kind: "S" } : item,
    );
    return id === null ? raw : { ...item, product_id: id };
  });
}

// ---------------------------------------------------------------------------
// Ajudantes do Documentos (sessão O, dona do domínio): leitura de valores do
// corpo, preferências, decimais e aprovação de desconto. Usados pelas
// leituras (sessão L, documents/rpc/reads-*.ts) e pelos escritores: ninguém
// escreve segunda versão; mudança aqui passa pela O.

/** erp_documents.preference(chave): erp_preferences.get */
export const preference = (db: SqlDriver, key: string) => preferences.get(db, key);

/** erp_documents.text_value(valor, máx, obrigatório=false, várias_linhas=false) */
export function textValue(value: unknown, max: number, required = false, multiline = false): string | null {
  let v: string | null;
  if (value === undefined || value === null) v = null;
  else if (jsonType(value) !== "string") raise("22023", "erp_document_text_invalid");
  else v = pgBtrim(value as string) || null;
  if (
    (required && v! === null) ||
    (v! !== null && (pgLength(v!) > max || pgHasCntrl.test(multiline ? v!.replace(/[\n\r\t]/g, "") : v!)))
  )
    raise("22023", "erp_document_text_invalid");
  return v!;
}

/** erp_documents.decimal_value(valor, casas, dígitos): o texto validado (numeric exato). */
export function decimalValue(value: unknown, precision: number, digits: number): string {
  if (value === undefined || value === null || jsonType(value) !== "string") raise("22023", "erp_document_decimal_invalid");
  const v = value as string;
  if (!new RegExp(`^(0|[1-9][0-9]{0,${digits - 1}})(\\.[0-9]{1,${precision}})?$`).test(v)) raise("22023", "erp_document_decimal_invalid");
  return v;
}

/** erp_documents.date_value(valor, obrigatório=false) */
export function dateValue(value: unknown, required = false): string | null {
  const v = textValue(value, 10, required);
  if (v === null) return null;
  if (!/^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(v) || !validDate(v)) raise("22023", "erp_document_date_invalid");
  return v;
}

/** erp_documents.uuid_value(valor, obrigatório=false) */
export function uuidValue(value: unknown, required = false): string | null {
  const v = textValue(value, 36, required);
  if (v !== null && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)) raise("22023", "erp_document_id_invalid");
  return v === null ? null : v.toLowerCase();
}

/** erp_documents.price_decimals(preço): casas depois de tirar os zeros à direita. */
export const priceDecimals = (price: string | null) => (price === null ? 0 : (price.split(".")[1] ?? "").replace(/0+$/, "").length);

/** erp_documents.quantity_decimals(): empresa.decimais_quantidade entre 0 e 6 (padrão 6). */
export function quantityDecimals(db: SqlDriver): number {
  const p = preference(db, "empresa.decimais_quantidade");
  const n = typeof p === "number" ? Number(intIn(String(p), "integer")) : 6;
  return Math.min(Math.max(n, 0), 6);
}

/** erp_documents.discount_approver(usuário, tipo): admin, ou o cartão do documento com limite_desconto. */
export function discountApprover(db: SqlDriver, user: string | null, kind: string | null): boolean {
  if (user === null) return false;
  if (one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, user)) return true;
  const module = kind === "sales_orders" ? "vendas.pedidos_venda" : kind === "sales_proposals" ? "vendas.propostas" : null;
  if (module === null) return false;
  const c = one(db, 'SELECT permissions FROM "erp_access__user_control" WHERE user_id=?', user);
  if (!c || c.permissions === null) return false;
  const list = JSON.parse(String(c.permissions)) as (string | null)[];
  return list.includes(module) && list.includes(`${module}.limite_desconto`);
}

/** erp_documents.approval_situations(): as situações de aprovação (pedidos de venda em rascunho), na ordem gravada. */
export function approvalSituations(db: SqlDriver): string[] {
  const a = one(db, 'SELECT situation_ids FROM "erp_documents__discount_approval" WHERE singleton=1');
  if (!a) return [];
  return (JSON.parse(String(a.situation_ids)) as string[]).filter(
    (id) => !!one(db, `SELECT 1 x FROM "erp_preferences__situation" WHERE id=? AND kind='sales_orders' AND base_status='draft'`, id),
  );
}

// ---------------------------------------------------------------------------
// Núcleo da leitura do documento (B3): document_view, dto, effect_flags,
// proposal_version_json, situation_json, situation_adopted e
// document_situation_json. Documento do Origin (authority 'origin'): erp_document_mirror.detail
// (documents/mirror.ts), a leitura do espelho.

const parse = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
/** ->> de um campo de objeto jsonb (texto; null quando falta ou não é objeto) */
const fieldText = (o: unknown, k: string): string | null => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const v = (o as Record<string, unknown>)[k];
  return v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
};

/** erp_documents.situation_adopted(kind) */
export const situationAdopted = (db: SqlDriver, kind: string | null) =>
  kind !== null && ["sales_orders", "purchase_orders", "service_orders"].includes(kind) && !!one(db, 'SELECT 1 x FROM "erp_preferences__situation_adoption" WHERE kind=? LIMIT 1', kind);

/** erp_documents.situation_json(kind, status, situação) */
export function situationJson(db: SqlDriver, kind: string | null, status: string | null, situation: string | null) {
  if (!situationAdopted(db, kind)) return null;
  if (situation === null)
    return {
      key: status, base_status: status, name: status === null ? null : preferences.situationBaseLabel(kind!, status),
      color: status === null ? "#607d8b" : preferences.situationBaseColor(status), default: true,
    };
  const s = one(db, 'SELECT id, base_status, name, color FROM "erp_preferences__situation" WHERE id=? AND kind=?', situation, kind);
  return s ? { key: s.id, base_status: s.base_status, name: s.name, color: s.color, default: false } : null;
}

/** erp_documents.document_situation_json(id) */
export function documentSituationJson(db: SqlDriver, id: string) {
  const d = one(db, 'SELECT kind, status FROM "erp_documents__document" WHERE id=?', id);
  if (!d) return null;
  const s = one(db, 'SELECT situation_id FROM "erp_documents__document_situation" WHERE document_id=?', id);
  return situationJson(db, d.kind as string | null, d.status as string | null, (s?.situation_id as string | null | undefined) ?? null);
}

/** Metadados somente quando alguma capacidade está suspensa. */
export function unavailableParts(ctx: Pick<RpcContext, "parts">, keys: readonly ErpPartKey[] = ERP_PART_KEYS) {
  const unavailable = keys.filter(key => !ctx.parts[key]);
  return unavailable.length ? { unavailable_parts: unavailable } : {};
}

/** erp_documents.effect_flags(id) */
export function effectFlags(ctx: RpcContext, id: string) {
  const e = originEffects(ctx, id);
  const db = ctx.db;
  return {
    finance_active: !!one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, id),
    stock_active: !!one(db, `SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, id) || receiptsActive(db, id),
    origin_finance: e.finance,
    origin_invoice: e.invoice,
  };
}

/** erp_documents.proposal_version_json(id): as versões da proposta (269); null com uma versão só. */
export function proposalVersionJson(db: SqlDriver, id: string) {
  const d = one(db, `SELECT id FROM "erp_documents__document" WHERE id=? AND kind='sales_proposals'`, id);
  if (!d) return null;
  const v = one(db, 'SELECT base_id, version_seq FROM "erp_documents__proposal_version" WHERE document_id=?', id);
  const base = (v?.base_id as string | undefined) ?? id;
  const seq = Number(v?.version_seq ?? 1);
  const family = db
    .exec('SELECT document_id, version_seq FROM "erp_documents__proposal_version" WHERE base_id=?', base)
    .rows.map((r) => ({ id: String(r.document_id), seq: Number(r.version_seq) }));
  family.push({ id: base, seq: 1 });
  if (family.length < 2) return null;
  const b = one(db, 'SELECT number FROM "erp_documents__document" WHERE id=?', base);
  if (!b) return null;
  const latest = family.reduce((x, y) => (y.seq > x.seq ? y : x));
  const number = b.number === null ? null : String(b.number);
  const label = (n: number) => (number === null ? null : n === 1 ? number : `${number}-${n}`);
  return {
    base_id: base, base_number: number, seq, label: label(seq), versions: family.length, superseded: seq < latest.seq,
    latest: { id: latest.id, label: label(latest.seq) },
  };
}

/** erp_documents.dto(id) */
export function documentDto(ctx: RpcContext, id: string): Record<string, unknown> | null {
  const db = ctx.db;
  const d = one(db, 'SELECT * FROM "erp_documents__document" WHERE id=?', id);
  if (!d) return null;
  if (d.authority === "origin") { const value = mirrorDetail(db, id); return value ? projectDocument(ctx, value) : value; }
  const body = parse(d.body);
  if (body === null) return null;
  const items = db
    .exec('SELECT data, product_snapshot FROM "erp_documents__item" WHERE document_id=? ORDER BY position', id)
    .rows.map((i) => {
      const data = parse(i.data);
      return data === null ? null : { ...data, product_snapshot: parse(i.product_snapshot) };
    });
  return projectDocument(ctx, Object.assign({}, body, {
    id: d.id, kind: d.kind, number: d.number === null ? null : String(d.number), status: d.status, version: d.version,
    effect_flags: effectFlags(ctx, id), contact_snapshot: parse(d.contact_snapshot), source_proposal_id: d.source_proposal_id,
    created_at: d.created_at === null ? null : jsonTimestamp(d.created_at as bigint), updated_at: d.updated_at === null ? null : jsonTimestamp(d.updated_at as bigint),
    items, origin: d.origin, authority: d.authority, readonly: false, ...unavailableParts(ctx),
  }));
}

/** erp_documents.document_view(id): o dto com situação, nomes e versões da proposta. */
export function documentView(ctx: RpcContext, id: string): Record<string, unknown> | null {
  const db = ctx.db;
  const d = one(db, 'SELECT kind, body, origin, authority FROM "erp_documents__document" WHERE id=?', id);
  if (!d) return null;
  if (d.authority === "origin") { const value = mirrorDetail(db, id); return value ? projectDocument(ctx, value) : value; }
  const dto = documentDto(ctx, id);
  if (dto === null) return null;
  const body = parse(d.body);
  const name = (sql: string, key: string, max: number) => {
    const ref = fieldText(body, key);
    if (ref === null) return null;
    const r = one(db, sql, ref);
    return r ? pgLeft(String(r.name), max) : null;
  };
  const installments = () => {
    const list = body.installments ?? [];
    if (jsonType(list) !== "array") raise("22023", `cannot extract elements from ${jsonType(list) === "object" ? "an object" : "a scalar"}`);
    return list as unknown[];
  };
  const methods: Record<string, string> = {};
  const wantedMethods = new Set(installments().map((p) => fieldText(p, "payment_method_id")).filter((x) => x !== null));
  for (const f of db.exec('SELECT id, description FROM "erp_catalog__payment_method"').rows)
    if (wantedMethods.has(String(f.id))) methods[String(f.id)] = pgLeft(String(f.description), 100);
  const accounts: Record<string, string> = {};
  // p#>>'{details,account_id}'
  const details = (p: unknown) => (p !== null && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>).details : null);
  const wantedAccounts = new Set(installments().map((p) => fieldText(details(p), "account_id")).filter((x) => x !== null));
  if (ctx.parts.finance) for (const a of db.exec('SELECT id, name FROM "erp_finance__account"').rows)
    if (wantedAccounts.has(String(a.id))) accounts[String(a.id)] = pgLeft(String(a.name), 200);
  return projectDocument(ctx, Object.assign(
    dto,
    {
      situation: documentSituationJson(db, id),
      seller_name: name('SELECT r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=?', "seller_id", 200),
      category_name: ctx.parts.finance ? name('SELECT name FROM "erp_finance__category" WHERE id=?', "category_id", 200) : null,
      carrier_name: name('SELECT name FROM "erp_catalog__record" WHERE id=?', "carrier_id", 200),
      price_list_name: name('SELECT name FROM "erp_pricing__price_list" WHERE id=?', "price_list_id", 120),
      payment_account_name: ctx.parts.finance ? name('SELECT name FROM "erp_finance__account" WHERE id=?', "payment_account_id", 200) : null,
      payment_method_names: methods,
      ...(ctx.parts.finance ? { payment_account_names: accounts } : {}),
    },
    d.kind === "sales_proposals" ? { proposal_version: proposalVersionJson(db, id) } : {},
    { origin: d.origin, authority: d.authority, readonly: false },
  ));
}

/** erp_documents.situation_key_valid(kind, chave): status do tipo ou situação própria do tipo. */
export function situationKeyValid(db: SqlDriver, kind: string | null, key: string | null): boolean {
  if (kind === null || key === null) return false;
  const map = transitions()[kind];
  if (map && Object.prototype.hasOwnProperty.call(map, key)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key) && !!one(db, 'SELECT 1 x FROM "erp_preferences__situation" WHERE id=? AND kind=? LIMIT 1', key, kind);
}

/** Projeção comum de leituras e recibos; nunca modifica o corpo persistido. */
export function projectDocument(ctx: Pick<RpcContext, "parts">, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value, ...unavailableParts(ctx) };
  const omit = (row: Record<string, unknown>, keys: string[]) => keys.forEach(key => delete row[key]);
  const snapshot = (entity: string, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? projectCatalogRecord(ctx.parts, entity, value as Record<string, unknown>) : value;
  if (Object.hasOwn(out, "contact_snapshot")) out.contact_snapshot = snapshot("contacts", out.contact_snapshot);
  if (Array.isArray(out.items)) out.items = out.items.map(item => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const row = { ...item };
    if (Object.hasOwn(row, "product_snapshot")) row.product_snapshot = snapshot("products", row.product_snapshot);
    if (!ctx.parts.stock) delete row.lots;
    return row;
  });
  if (!ctx.parts.stock) {
    omit(out, ["warehouse_id", "warehouse_name"]);
  }
  if (!ctx.parts.finance) {
    omit(out, ["category_id", "category_name", "payment_account_id", "payment_account_name", "payment_account_names"]);
    if (Array.isArray(out.installments)) out.installments = out.installments.map(part => {
      if (!part.details) return { ...part };
      const details = { ...part.details };
      omit(details, ["account_id", "fee_amount", "commission_fee_amount"]);
      return { ...part, details };
    });
  }
  return out;
}
