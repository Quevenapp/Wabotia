// As verificações e os pequenos auxiliares do erp_document_save (e do transition e das
// conversões): check_preference_rules, seller_rules, approval_target, require_seller,
// check_links (sem o check_custom_fields, que vem do normalize.ts da sessão L),
// check_payment_links, require_os_permission, check_credit_limit, number_editable,
// category_usable, carrier_usable, editable, proposal_superseded, command_replay,
// project_result_flags, next_number, initial_status, current_version, record_occurrence,
// record_situation_occurrence e situation_snapshot.
import { exact } from "../../engine/dec.ts";
import { driverContext } from "../../engine/module-origin.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { requireErpParts } from "../../engine/parts-gate.ts";
import { normalizeErpParts, type ErpParts } from "../../parts.ts";
import { erpFieldRequirement, erpRequirementMet } from "../../parts-requirements.ts";
import { saoPauloParts, todaySaoPaulo } from "../../engine/time.ts";
import { validNow } from "../catalog/public.ts";
import { approvalSituations, discountApprover, effectFlags, projectDocument, unavailableParts, preference, priceDecimals, quantityDecimals } from "./internal.ts";
import { osPermitted } from "./reads-g.ts";

type Row = Record<string, unknown>;
type Data = Record<string, unknown>;

const object = (v: unknown): Data => v && typeof v === "object" && !Array.isArray(v) ? v as Data : {};
const own = (v: Data, key: string) => Object.hasOwn(v, key);
const optionalFields = { warehouse_id: "warehouse_id", category_id: "category_id", payment_account_id: "account_id" };
const paymentFields = { account_id: "account_id", fee_amount: "fee", commission_fee_amount: "commission" };
const meaningful = (v: unknown): boolean => v != null && (!Array.isArray(v) || v.length > 0);
const same = (a: unknown, b: unknown) => jsonbText(a ?? null) === jsonbText(b ?? null);
const optionalValue = (field: string, value: unknown): unknown => {
  if (value == null) return null;
  if (["fee", "commission", "quantity"].includes(field) && typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return exact(value).toString();
  if (field.endsWith("_id") && typeof value === "string") return value.toLowerCase();
  if (field === "lots" && Array.isArray(value)) return value.map(v => ({ ...object(v), lot_id: optionalValue("lot_id", object(v).lot_id), quantity: optionalValue("quantity", object(v).quantity) }));
  return value;
};

/** Campos suspensos: completar omissões antes do normalize, sem mudar o corpo usado no hash. */
export function preserveUnavailableFields(ctx: Pick<RpcContext, "parts">, input: Data, before: Data | null): Data {
  const fields = (next: Data, old: Data, map: Record<string, string>) => {
    const out = { ...next };
    for (const [key, field] of Object.entries(map)) {
      const req = erpFieldRequirement(field);
      if (erpRequirementMet(ctx.parts, req)) continue;
      if (own(next, key) && !same(optionalValue(field, next[key]), optionalValue(field, old[key])) && (meaningful(next[key]) || meaningful(old[key]))) requireErpParts(ctx, req);
      if (own(old, key)) out[key] = old[key];
    }
    return out;
  };
  const old = before ?? {};
  const out = fields(input, old, optionalFields);
  if (!ctx.parts.stock && own(input, "items") && !Array.isArray(input.items) && elements(old.items).some(i => meaningful(object(i).lots)))
    requireErpParts(ctx, erpFieldRequirement("lots"));
  if (!ctx.parts.stock && Array.isArray(input.items)) {
    const previous = elements(old.items).map(object);
    out.items = input.items.map(value => {
      const item = object(value);
      const prior = previous.find(i => i.id != null && same(i.id, optionalValue("item_id", item.id))) ?? {};
      // Um lote continua pertencendo ao mesmo produto, mesmo sem movimentação ativa.
      if (meaningful(prior.lots) && !same(optionalValue("product_id", item.product_id), prior.product_id)) requireErpParts(ctx, erpFieldRequirement("lots"));
      return fields(item, prior, { lots: "lots" });
    });
    if (previous.some(i => meaningful(i.lots) && !(input.items as unknown[]).some(n => same(i.id, optionalValue("item_id", object(n).id)))))
      requireErpParts(ctx, erpFieldRequirement("lots"));
  }
  if (!ctx.parts.finance) {
    const previous = elements(old.installments).map(object);
    const linked = (p: Data) => Object.keys(paymentFields).some(k => meaningful(object(p.details)[k]));
    if (own(input, "installments") && !Array.isArray(input.installments) && previous.some(linked)) requireErpParts(ctx, erpFieldRequirement("account_id"));
    if (!own(input, "installments") && previous.some(linked)) out.installments = previous.map(({ position: _position, ...p }) => p);
    if (Array.isArray(input.installments)) {
      out.installments = input.installments.map((value, index) => {
        const p = object(value), prior = previous[index] ?? {};
        const oldDetails = object(prior.details);
        if (!own(p, "details")) return own(prior, "details") ? { ...p, details: prior.details } : p;
        if (p.details === null) {
          if (linked(prior)) requireErpParts(ctx, erpFieldRequirement("account_id"));
          return p;
        }
        const details = fields(object(p.details), oldDetails, paymentFields);
        // O normalizador exige as três chaves, inclusive quando não há vínculo.
        for (const k of Object.keys(paymentFields)) if (!own(details, k)) details[k] = null;
        return { ...p, details };
      });
      if (previous.slice(input.installments.length).some(linked)) requireErpParts(ctx, erpFieldRequirement("account_id"));
    }
  }
  return out;
}

/** Um documento novo não herda vínculos indisponíveis de sua origem. */
export function withoutUnavailableLinks(ctx: Pick<RpcContext, "parts">, input: Data): Data {
  const out = { ...input };
  for (const [key, field] of Object.entries(optionalFields)) if (!erpRequirementMet(ctx.parts, erpFieldRequirement(field))) out[key] = null;
  if (!ctx.parts.stock && Array.isArray(out.items)) out.items = out.items.map(value => {
    const item = { ...object(value) }; delete item.lots; return item;
  });
  if (!ctx.parts.finance && Array.isArray(out.installments)) out.installments = out.installments.map(value => {
    const p = { ...object(value) };
    if (p.details != null) {
      p.details = { ...object(p.details) };
      for (const k of Object.keys(paymentFields)) (p.details as Data)[k] = null;
    }
    return p;
  });
  return out;
}

/** Restaura somente campos já conferidos por preserveUnavailableFields, após normalizar o comercial. */
export function restoreUnavailableFields(ctx: Pick<RpcContext, "parts">, normalized: Data, preserved: Data): Data {
  const out = { ...normalized };
  for (const [key, field] of Object.entries(optionalFields)) {
    if (erpRequirementMet(ctx.parts, erpFieldRequirement(field))) continue;
    if (own(preserved, key)) out[key] = preserved[key];
    else if (key !== "warehouse_id") delete out[key];
  }
  if (!ctx.parts.stock && Array.isArray(out.items)) out.items = out.items.map((v, index) => {
    const lots = object(elements(preserved.items)[index]).lots;
    return Array.isArray(lots) && lots.length ? { ...object(v), lots } : v;
  });
  if (!ctx.parts.finance && Array.isArray(out.installments)) out.installments = out.installments.map((v, index) => {
    const p = object(v);
    if (p.details == null) return v;
    const prior = object(object(elements(preserved.installments)[index]).details);
    return { ...p, details: { ...object(p.details), ...Object.fromEntries(Object.keys(paymentFields).map(k => [k, prior[k] ?? null])) } };
  });
  return out;
}

/** Defesa para escritores comerciais que chegam diretamente à camada de linha. */
export function guardUnavailableFields(ctx: Pick<RpcContext, "parts">, data: Data, before: Data | null) {
  if (ctx.parts.stock && ctx.parts.finance) return;
  const preserved = preserveUnavailableFields(ctx, data, before);
  // Aqui o corpo já foi normalizado: uma omissão não pode apagar o valor anterior.
  if (!same(preserved, data)) requireErpParts(ctx, erpFieldRequirement(!ctx.parts.finance ? "account_id" : "warehouse_id"));
}

/** ->> de um campo (texto; null quando falta, é null ou o pai não é objeto) */
export const fieldText = (o: unknown, k: string): string | null => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const v = (o as Data)[k];
  return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
};
/** #>> de um caminho */
export const pathText = (o: unknown, path: string[]): string | null => {
  let v: unknown = o;
  for (const p of path) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    v = (v as Data)[p];
  }
  return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
};
/** jsonb_array_elements(coalesce(x,'[]')): null vira lista vazia; o que não é array dá o erro do Postgres. */
export function elements(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  raise("22023", `cannot extract elements from ${typeof v === "object" ? "an object" : "a scalar"}`);
}
/** (texto)::boolean do Postgres */
function boolText(t: string | null): boolean | null {
  if (t === null) return null;
  const s = t.trim().toLowerCase();
  if (["t", "true", "y", "yes", "on", "1"].includes(s) || ("true".startsWith(s) && s.length > 0) || ("yes".startsWith(s) && s.length > 0)) return true;
  if (["f", "false", "n", "no", "off", "0"].includes(s) || ("false".startsWith(s) && s.length > 0) || ("no".startsWith(s) && s.length > 0)) return false;
  raise("22P02", `invalid input syntax for type boolean: "${t}"`);
}
/** (texto)::numeric em escala 30, com o erro do Postgres para texto inválido */
function num(t: string): bigint {
  if (!/^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(t)) raise("22P02", `invalid input syntax for type numeric: "${t}"`);
  return exact(t.trim().replace(/^\+/, "").replace(/^(-?)\./, "$10."));
}
const isTrue = (v: unknown) => v === true;
const isFalse = (v: unknown) => v === false;
const items = (data: Data) => elements(data.items);

/** erp_documents.editable(status) */
export const editable = (status: unknown) =>
  status !== null && status !== undefined && !["approved", "completed", "fulfilled", "finalized", "no_repair", "cancelled", "rejected", "service_done", "partially_invoiced"].includes(String(status));

/** erp_documents.initial_status(kind) */
export const initialStatus = (kind: string) => (kind === "sales_proposals" ? "draft" : "open");

/** erp_documents.current_version(id) */
export const currentVersion = (db: SqlDriver, id: string) => (one(db, 'SELECT version FROM "erp_documents__document" WHERE id=?', id)?.version as number | undefined) ?? null;

/** erp_documents.proposal_superseded(id) */
export function proposalSuperseded(db: SqlDriver, id: string) {
  const me = one(db, 'SELECT base_id, version_seq FROM "erp_documents__proposal_version" WHERE document_id=?', id);
  const base = (me?.base_id as string | undefined) ?? id;
  const seq = Number(me?.version_seq ?? 1);
  return !!one(db, 'SELECT 1 x FROM "erp_documents__proposal_version" WHERE base_id=? AND version_seq>? LIMIT 1', base, seq);
}

/** erp_documents.next_number(kind) */
export function nextNumber(db: SqlDriver, kind: string): number {
  const r = one(db, 'SELECT last_number FROM "erp_documents__numbering" WHERE kind=? AND last_number<9999999999', kind);
  if (!r) raise("40001", "erp_document_number_exhausted");
  const v = Number(r.last_number) + 1;
  db.exec('UPDATE "erp_documents__numbering" SET last_number=? WHERE kind=?', v, kind);
  return v;
}

/** erp_documents.number_editable(kind) */
export const numberEditable = (db: SqlDriver, kind: string) => {
  const key = { sales_orders: "vendas.editar_numero", sales_proposals: "propostas.editar_numero", service_orders: "os.editar_numero", purchase_orders: "compras.editar_numero" }[kind];
  return key !== undefined && isTrue(preference(db, key));
};

/** erp_documents.check_preference_rules(kind, dados) */
export function checkPreferenceRules(db: SqlDriver, kind: string, data: Data, parts: Readonly<ErpParts> = normalizeErpParts()) {
  const list = items(data);
  if (kind === "sales_orders" && !driverContext(db) && isFalse(preference(db, "vendas.produtos_nao_cadastrados")) && list.some((i) => fieldText(i, "product_id") === null))
    raise("22023", "erp_document_product_required");
  if (kind === "service_orders" && isFalse(preference(db, "os.itens_repetidos"))) {
    const seen = new Set<string>();
    for (const i of list) {
      const p = fieldText(i, "product_id");
      if (p === null) continue;
      if (seen.has(p)) raise("22023", "erp_document_item_repeated");
      seen.add(p);
    }
  }
  const template = () => boolText(fieldText(data, "template")) ?? false;
  if (kind === "sales_proposals" && isTrue(preference(db, "propostas.proximo_contato_obrigatorio")) && !template() && fieldText(data, "next_contact") === null)
    raise("22023", "erp_document_next_contact_required");
  if (kind === "purchase_orders" && fieldText(data, "seller_id") !== null) raise("22023", "erp_document_seller_invalid");
  if (
    fieldText(data, "seller_id") === null &&
    ((kind === "sales_orders" && isTrue(preference(db, "vendas.vendedor_obrigatorio"))) ||
      (kind === "sales_proposals" && isTrue(preference(db, "propostas.vendedor_obrigatorio")) && !template()) ||
      (kind === "service_orders" && isTrue(preference(db, "os.vendedor_obrigatorio"))))
  )
    raise("22023", "erp_document_seller_required");
  const pref = preference(db, kind === "purchase_orders" ? "empresa.decimais_preco_entrada" : "empresa.decimais_preco_saida");
  const prefText = pref === null || pref === undefined ? null : typeof pref === "string" ? pref : jsonbText(pref);
  const decimals = prefText === null ? 10 : intText(prefText);
  if (list.some((i) => priceDecimals(fieldText(i, "unit_price")) > decimals)) raise("22023", "erp_document_price_decimals");
  const q = quantityDecimals(db) as number;
  if (list.some((i) => priceDecimals(fieldText(i, "quantity")) > q || (parts.stock && elements((i as Data)?.lots ?? null).some((l) => priceDecimals(fieldText(l, "quantity")) > q))))
    raise("22023", "erp_document_quantity_decimals");
}
/** (texto)::integer do Postgres */
function intText(t: string): number {
  const s = t.trim();
  if (!/^[-+]?\d+$/.test(s)) raise("22P02", `invalid input syntax for type integer: "${t}"`);
  const v = Number(s);
  if (v > 2147483647 || v < -2147483648) raise("22003", "value \"" + t + "\" is out of range for type integer");
  return v;
}

/** erp_documents.approval_target(): a primeira situação de aprovação ativa. */
export function approvalTarget(db: SqlDriver): string | null {
  for (const id of approvalSituations(db) as string[]) if (one(db, 'SELECT 1 x FROM "erp_preferences__situation" WHERE id=? AND active=1', id)) return id;
  return null;
}

/** erp_documents.seller_rules(usuário, kind, dados): a situação de aprovação do desconto, ou null. */
export function sellerRules(db: SqlDriver, user: string, kind: string, data: Data): string | null {
  if (!["sales_orders", "sales_proposals", "service_orders"].includes(kind)) return null;
  const s = one(db, 'SELECT allow_unregistered_products, discount_limit FROM "erp_catalog__seller" WHERE user_id=?', user);
  if (!s) return null;
  const list = items(data);
  if (kind === "sales_orders" && Number(s.allow_unregistered_products) !== 1 && list.some((i) => fieldText(i, "product_id") === null))
    raise("22023", "erp_document_seller_product_required");
  const limit = BigInt(String(s.discount_limit)) * 10n ** 26n; // escala 4 → 30
  if (limit > 0n && !discountApprover(db, user, kind)) {
    const totals = (t: string) => {
      const x = pathText(data, ["totals", t]);
      return x === null ? null : num(x);
    };
    const gross = totals("gross");
    const lineDiscount = totals("line_discount"),
      discount = totals("discount");
    const v = lineDiscount === null || discount === null ? null : lineDiscount + discount;
    const over =
      list.some((i) => {
        const d = fieldText(i, "discount_percent");
        return d !== null && num(d) > limit;
      }) ||
      (gross !== null && v !== null && gross > 0n && v * 100n * 10n ** 30n > limit * gross);
    if (over) {
      const target = kind === "sales_orders" ? approvalTarget(db) : null;
      if (target === null) raise("22023", "erp_document_seller_discount_limit");
      return target;
    }
  }
  return null;
}

/** erp_documents.require_seller(vendedor) */
export function requireSeller(db: SqlDriver, seller: string | null) {
  if (seller !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=? AND r.active=1', seller))
    raise("22023", "erp_document_seller_unavailable");
}

/** erp_documents.category_usable(kind, id em texto) */
export const categoryUsable = (db: SqlDriver, kind: string, id: string | null) =>
  ["sales_orders", "purchase_orders", "service_orders"].includes(kind) &&
  id !== null &&
  !!one(db, 'SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1 AND deleted_at IS NULL AND kind=?', id, kind === "purchase_orders" ? "payable" : "receivable");

/** erp_documents.carrier_usable(id em texto) */
export const carrierUsable = (db: SqlDriver, id: string | null) =>
  id !== null && !!one(db, 'SELECT 1 x FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.id=? AND r.active=1', id);

/** (texto)::uuid do Postgres */
function uuidText(t: string): string {
  if (!/^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(t)) raise("22P02", `invalid input syntax for type uuid: "${t}"`);
  const h = t.replace(/[{}-]/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * erp_documents.check_links(kind, dados, corpo anterior), sem a última linha (o
 * check_custom_fields da OS), que o save chama logo depois.
 */
export function checkLinks(db: SqlDriver, kind: string, data: Data, before: Data | null, parts: Readonly<ErpParts> = normalizeErpParts()) {
  guardUnavailableFields({ parts }, data, before);
  const category = fieldText(data, "category_id");
  if (kind === "sales_proposals" && category !== null) raise("22023", "erp_document_category_invalid");
  if (category !== null && (before === null || fieldText(before, "category_id") !== category) && !categoryUsable(db, kind, category))
    raise("22023", "erp_document_category_unavailable");
  const carrier = fieldText(data, "carrier_id");
  if (carrier !== null && (before === null || fieldText(before, "carrier_id") !== carrier) && !carrierUsable(db, carrier)) raise("22023", "erp_document_carrier_unavailable");
  if (parts.stock) for (const i of elements(data.items ?? null))
    for (const l of elements((i as Data | null)?.lots ?? null)) {
      const lot = fieldText(l, "lot_id"),
        product = fieldText(i, "product_id");
      const lotId = lot === null ? null : uuidText(lot),
        productId = product === null ? null : uuidText(product);
      if (lotId === null || productId === null || !one(db, 'SELECT 1 x FROM "erp_stock__lot" WHERE id=? AND product_id=?', lotId, productId))
        raise("22023", "erp_document_item_lot_unavailable");
    }
}

/** erp_documents.check_payment_links(kind, dados, corpo anterior) */
export function checkPaymentLinks(db: SqlDriver, kind: string, data: Data, before: Data | null, enabled: Readonly<ErpParts> = normalizeErpParts()) {
  guardUnavailableFields({ parts: enabled }, data, before);
  const applicable = kind === "purchase_orders" ? "pagamentos" : "recebimentos";
  const list = fieldText(data, "price_list_id");
  if (list !== null && (before === null || fieldText(before, "price_list_id") !== list)) {
    const l = one(db, 'SELECT starts_on, ends_on, considers_datetime, start_time, end_time FROM "erp_pricing__price_list" WHERE id=?', uuidText(list));
    const valid =
      !!l &&
      validNow({
        starts_on: (l.starts_on as string | null) ?? null, ends_on: (l.ends_on as string | null) ?? null, considers_datetime: Number(l.considers_datetime) === 1,
        start_time: (l.start_time as string | null) ?? null, end_time: (l.end_time as string | null) ?? null,
      } as Parameters<typeof validNow>[0]);
    if (!valid) raise("22023", "erp_document_price_list_unavailable");
  }
  const beforeParts = before === null ? [] : elements(before.installments ?? null);
  const accounts = new Set<string>();
  for (const p of beforeParts) {
    const a = pathText(p, ["details", "account_id"]);
    if (a !== null) accounts.add(uuidText(a));
  }
  const pa = before === null ? null : fieldText(before, "payment_account_id");
  if (pa !== null) accounts.add(uuidText(pa));
  const parts = elements(data.installments ?? null);
  const wanted = [fieldText(data, "payment_account_id"), ...parts.map((p) => pathText(p, ["details", "account_id"]))];
  if (enabled.finance) for (const x of wanted) {
    if (x === null) continue;
    const id = uuidText(x);
    if (!accounts.has(id) && !one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1', id)) raise("22023", "erp_document_payment_account_unavailable");
  }
  const methods = new Set<string>();
  for (const p of beforeParts) {
    const m = fieldText(p, "payment_method_id");
    if (m !== null) methods.add(uuidText(m));
  }
  for (const p of parts) {
    const m = fieldText(p, "payment_method_id");
    if (m === null) continue;
    const id = uuidText(m);
    if (methods.has(id) && one(db, 'SELECT 1 x FROM "erp_catalog__payment_method" WHERE id=?', id)) continue;
    if (!one(db, `SELECT 1 x FROM "erp_catalog__payment_method" WHERE id=? AND active=1 AND deleted_at IS NULL AND applicable IN ('ambos', ?)`, id, applicable))
      raise("22023", "erp_document_payment_method_unavailable");
  }
}

/** erp_documents.require_os_permission(usuário, kind, chave) */
export function requireOsPermission(db: SqlDriver, user: string, kind: string, key: string) {
  if (kind === "service_orders" && !osPermitted(db, user, key)) raise("42501", "erp_document_permission_denied");
}

/** erp_documents.check_credit_limit(usuário, kind, dados, corpo anterior com contact_id) */
export function checkCreditLimit(db: SqlDriver, user: string, kind: string, data: Data, before: Data | null, parts: Readonly<ErpParts> = normalizeErpParts()) {
  if (!parts.finance) return;
  if (kind !== "sales_proposals" || (boolText(fieldText(data, "template")) ?? false)) return;
  if (!isTrue(preference(db, "propostas.bloquear_limite_credito"))) return;
  if (one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, user)) return;
  const contact = fieldText(data, "contact_id");
  const p = contact === null ? undefined : one(db, 'SELECT credit_limit_mode, credit_limit FROM "erp_catalog__contact_profile" WHERE record_id=?', uuidText(contact));
  const mode = (p?.credit_limit_mode as string | undefined) ?? "unlimited";
  if (mode === "unlimited") return;
  const sum = (parts: unknown[]) => parts.reduce<bigint>((s, x) => {
    const a = fieldText(x, "amount");
    return a === null ? s : s + num(a);
  }, 0n);
  const planned = sum(elements(data.installments ?? null));
  if (planned === 0n || (before !== null && fieldText(before, "contact_id") === contact && planned <= sum(elements(before.installments ?? null)))) return;
  let open = 0n;
  for (const t of db.exec(`SELECT amount_cents, settled_cents FROM "erp_finance__title" WHERE contact_id=? AND kind='receivable' AND cancelled=0 AND deleted_at IS NULL`, uuidText(contact!)).rows)
    open += BigInt(String(t.amount_cents)) - BigInt(String(t.settled_cents));
  // centavos/100.0 na escala 30
  const openScaled = open * 10n ** 28n;
  const limit = mode === "zero" ? 0n : p!.credit_limit === null ? null : BigInt(String(p!.credit_limit)) * 10n ** 28n;
  if (limit !== null && planned + openScaled > limit) raise("22023", "erp_document_credit_limit");
}

/** erp_documents.command_replay(ator, comando, hash) */
export function commandReplay(ctx: RpcContext, actor: string, command: string | null, hash: string) {
  if (command === null) raise("22023", "erp_document_command_required");
  const v = one(ctx.db, 'SELECT actor, request_hash, result FROM "erp_documents__command" WHERE command_id=?', command);
  if (!v) return null;
  if (v.actor !== actor || v.request_hash !== hash) raise("40001", "erp_document_command_conflict");
  return { ...projectResultFlags(ctx, JSON.parse(String(v.result))), replayed: true };
}

/** erp_documents.project_result_flags(resultado): effect_flags atual de cada documento do recibo. */
export function projectResultFlags(ctx: RpcContext, result: Data): Data {
  const out: Data = { ...result, ...unavailableParts(ctx) };
  for (const key of ["document", "proposal", "sale", "service_order"]) {
    const v = out[key];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const id = fieldText(v, "id");
      out[key] = projectDocument(ctx, { ...(v as Data), effect_flags: effectFlags(ctx, id === null ? null! : uuidText(id)) });
    }
  }
  return out;
}

/** erp_documents.situation_snapshot(situação) */
export const situationSnapshot = (p: unknown) =>
  p === null || p === undefined ? null : { key: fieldText(p, "key"), name: fieldText(p, "name"), color: fieldText(p, "color") };

/** Os valores que o set_config('erp_documents.occurrence_*') pode trazer (a ocorrência manual). */
export type OccurrenceOverrides = { on?: string | null; time?: string | null; text?: string | null; next_contact?: string | null };

/**
 * erp_documents.record_occurrence e record_situation_occurrence: a ocorrência com a
 * próxima sequência, a data e a hora de São Paulo e o papel do ator.
 */
export function recordOccurrence(
  ctx: RpcContext,
  a: { document: string; actor: string; command: string; version: number | null; before: unknown; after: unknown; text: string | null; situationBefore?: unknown; situationAfter?: unknown },
  given?: OccurrenceOverrides,
) {
  // set_config('erp_documents.occurrence_*'): a ocorrência manual (erp_document_occurrence_add) passa data, hora, texto e próximo contato.
  const setting = (k: string) => { const v = ctx.settings.get(`erp_documents.occurrence_${k}`); return v === undefined || v === "" ? null : v; };
  const overrides: OccurrenceOverrides = given ?? { on: setting("on"), time: setting("time"), text: setting("text"), next_contact: setting("next_contact") };
  const db = ctx.db;
  const role = (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', a.actor)?.role as string | undefined) ?? "desconhecido";
  const seq = Number(one(db, 'SELECT coalesce(max(sequence),0)+1 n FROM "erp_documents__occurrence" WHERE document_id=?', a.document)!.n);
  const now = ctx.clock.next();
  const sp = saoPauloParts(now);
  const snap = (s: unknown) => { const v = situationSnapshot(s); return v === null ? null : JSON.stringify(v); };
  db.exec(
    `INSERT INTO "erp_documents__occurrence"(id, document_id, sequence, occurred_on, occurred_time, text, status_before, status_after, next_contact, actor_id, actor_role,
       command_id, document_version, recorded_at, situation_before, situation_after) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    crypto.randomUUID(), a.document, seq, overrides.on || sp.date || todaySaoPaulo(), overrides.time || sp.hm, overrides.text || a.text, a.before ?? null, a.after ?? null,
    overrides.next_contact || null, a.actor, role, a.command, a.version, now.toString(),
    snap(a.situationBefore), snap(a.situationAfter),
  );
}

/** erp_documents.finance_category(kind, categoria) */
export function financeCategory(db: SqlDriver, kind: string, category: string | null): string | null {
  if (category !== null) return category;
  const key = { sales_orders: "sale", service_orders: "service", purchase_orders: "purchase" }[kind];
  if (key === undefined) return null;
  return (one(db, 'SELECT d.category_id FROM "erp_finance__category_default" d JOIN "erp_finance__category" c ON c.id=d.category_id WHERE d.key=? AND c.active=1 AND c.deleted_at IS NULL', key)?.category_id as string | undefined) ?? null;
}

/** erp_documents.document_finance_category(documento, categoria) */
export function documentFinanceCategory(db: SqlDriver, d: Data, category: string | null): string | null {
  if (category !== null) return category;
  const body = JSON.parse(String(d.body));
  const own = fieldText(body, "category_id");
  if (categoryUsable(db, String(d.kind), own)) return own;
  return financeCategory(db, String(d.kind), null);
}
