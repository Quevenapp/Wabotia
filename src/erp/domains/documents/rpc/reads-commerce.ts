// Acesso, pendências e comissão (sessão L, bloco B0): erp_document_access,
// _pendencies, _commission_operation e _seller_commission, com os mesmos
// nomes. erp_document_mirror.require_visible sai (Origin fora:
// docs/ERP-FASE0.md); "mirror_available" continua true, como no Fagoo.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { compareDec, formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { intIn } from "../../../engine/args.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgLeft, pgUpper } from "../../../engine/text.ts";
import { validCnpj, validCpf } from "../../catalog/public.ts";
import { commissionOperationView, commissionPolicy } from "../../finance/public.ts";
import { municipalityKnown } from "../../reference/public.ts";
import { approvalSituations, discountApprover, preference, quantityDecimals } from "../internal.ts";
import { allowed, contactUsable, osPermitted, requireAccess, transitions } from "../public.ts";
import { bool } from "./reads-common.ts";

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const NATIVE = { data_mode: "erp_native", operational_effects: false } as const;
/** x::numeric(7,4)::text */
const dec4 = (text: string | null) => (text === null ? null : formatScaled(toScaled(text, 4), 4));

/** erp_documents.kind_allowed(user, role, kind, write) */
const kindAllowed = (db: SqlDriver, user: string, role: string | null, kind: string, write: boolean) =>
  allowed(role, kind, write) && (kind !== "service_orders" || osPermitted(db, user, write ? "ie" : null));

/** (preference #>> '{}')::integer, ou o padrão quando a preferência é nula. */
const prefInt = (db: SqlDriver, key: string, fallback: number) => {
  const v = preference(db, key);
  if (v === null || v === undefined) return fallback;
  return Number(intIn(typeof v === "string" ? v : JSON.stringify(v), "integer"));
};

/** public.erp_document_access(p_user_id): tipos que o usuário lê e grava, preferências da tela, vendedor e permissões. */
export function erpDocumentAccess(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id);
  const m = user === null ? null : one(ctx.db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!m) raise("42501", "erp_document_access_denied");
  const role = str(m.role);
  const kinds = Object.keys(transitions()).sort(pgCompareText);
  const db = ctx.db;
  const wh = one(
    db,
    'SELECT r.id, r.name FROM "erp_stock__warehouse_default" x JOIN "erp_catalog__record" r ON r.id=x.warehouse_id WHERE r.active=1',
  );
  const seller = one(
    db,
    `SELECT s.id, r.name, s.allow_unregistered_products, s.view_stock, CAST(s.discount_limit AS TEXT) discount_limit
       FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.user_id=?`,
    user,
  );
  return {
    read: kinds.filter((k) => kindAllowed(db, user!, role, k, false)),
    write: kinds.filter((k) => kindAllowed(db, user!, role, k, true)),
    settings: {
      price_decimals_out: prefInt(db, "empresa.decimais_preco_saida", 10),
      price_decimals_in: prefInt(db, "empresa.decimais_preco_entrada", 10),
      weight_decimals: Math.min(Math.max(prefInt(db, "empresa.decimais_peso", 3), 0), 5),
      quantity_decimals: quantityDecimals(db),
      cross_docking_days: prefInt(db, "estoque.cross_docking_dias", 0),
      occurrence_date_editable: preference(db, "empresa.editar_data_ocorrencia") === true,
      stock_launch_date: preference(db, "estoque.data_lancamento") === "data_documento" ? "data_documento" : "data_atual",
      auto_products: {
        sales: preference(db, "produtos.cadastro_auto_vendas") === true,
        purchases: preference(db, "produtos.cadastro_auto_compras") === true,
        services: preference(db, "produtos.cadastro_auto_os") === true,
      },
      default_warehouse: wh ? { id: wh.id, name: pgLeft(String(wh.name), 200) } : null,
    },
    seller: seller
      ? {
          id: seller.id,
          name: pgLeft(String(seller.name), 200),
          allow_unregistered_products: bool(seller.allow_unregistered_products),
          view_stock: bool(seller.view_stock),
          discount_limit: formatScaled(fromColumn(seller.discount_limit), 4),
        }
      : null,
    permissions: {
      service_orders: {
        situations: osPermitted(db, user!, "situacoes"),
        stock: osPermitted(db, user!, "lancar_estoque"),
        finance: osPermitted(db, user!, "lancar_contas"),
        finance_history: osPermitted(db, user!, "historico_financeiro"),
        payment_method: osPermitted(db, user!, "forma_pagamento"),
      },
      sales_orders: { discount_approver: discountApprover(db, user, "sales_orders"), approval_situations: approvalSituations(db) },
    },
    ...NATIVE,
    mirror_available: true,
  };
}

const UFS = /^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/;
const blank = (v: unknown) => v === null || v === undefined || pgBtrim(String(v)) === "";
const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");

/** erp_documents.pendencies(p_id): o que falta no pedido de venda para emitir a nota. */
export function pendencies(db: SqlDriver, id: string) {
  const d = one(db, `SELECT id, contact_id, body FROM "erp_documents__document" WHERE id=? AND kind='sales_orders'`, id);
  if (!d) return [];
  const out: { o: number; section: string | null; message: string }[] = [];
  const c = one(
    db,
    `SELECT k.person_type, k.document, k.ie, k.street, k.number, k.district, k.city, k.state, k.postal_code, cp.taxpayer, cp.ie_exempt
       FROM "erp_catalog__contact" k LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=k.record_id WHERE k.record_id=?`,
    d.contact_id,
  );
  if (c) {
    const notForeign = (str(c.person_type) ?? "") !== "E";
    if (notForeign && blank(c.document)) out.push({ o: 1, section: "Cliente", message: "O campo CPF/CNPJ é obrigatório" });
    if (notForeign && !blank(c.document) && !validCpf(digits(c.document)) && !validCnpj(digits(c.document)))
      out.push({ o: 2, section: "Cliente", message: "O CPF/CNPJ informado é inválido" });
    if (c.taxpayer === "1" && blank(c.ie) && !bool(c.ie_exempt))
      out.push({ o: 3, section: "Cliente", message: "O campo Inscrição Estadual é obrigatório para contribuinte do ICMS" });
    if (blank(c.street)) out.push({ o: 4, section: "Cliente", message: "O campo Endereço é obrigatório" });
    if (blank(c.number)) out.push({ o: 5, section: "Cliente", message: "O campo Número é obrigatório" });
    if (blank(c.district)) out.push({ o: 6, section: "Cliente", message: "O campo Bairro é obrigatório" });
    if (blank(c.city)) out.push({ o: 7, section: "Cliente", message: "O campo Cidade é obrigatório" });
    if (blank(c.state)) out.push({ o: 8, section: "Cliente", message: "O campo UF é obrigatório" });
    if (!blank(c.state) && !UFS.test(pgUpper(pgBtrim(String(c.state))))) out.push({ o: 9, section: "Cliente", message: "A UF informada é inválida" });
    if (notForeign && !/^[0-9]{8}$/.test(digits(c.postal_code))) out.push({ o: 10, section: "Cliente", message: "O campo CEP é obrigatório" });
    if (notForeign && municipalityKnown(db, str(c.city), str(c.state)) === false)
      out.push({
        o: 11,
        section: "Cliente",
        message: "O município informado não consta na tabela do IBGE para a UF " + pgUpper(pgBtrim(String(c.state))),
      });
  }
  const body = JSON.parse(String(d.body)) as Record<string, unknown>;
  const transport = (body?.commercial as Record<string, unknown> | undefined)?.transport as Record<string, unknown> | undefined;
  const mode = transport && jsonType(transport) === "object" ? arrow(transport, "freight_mode") : null;
  const carrierRef = transport && jsonType(transport) === "object" ? transport.carrier_reference : undefined;
  if ((mode === "1" || mode === "2") && (carrierRef === undefined || carrierRef === null) && arrow(body, "carrier_id") === null)
    out.push({ o: 50, section: "Transportador", message: "O campo Transportador é obrigatório para o frete por conta do destinatário ou de terceiros" });
  const items = db.exec(
    `SELECT i.position, i.product_id, i.data, p.record_id p_id, p.ncm, p.origin FROM "erp_documents__item" i
       LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id WHERE i.document_id=?`,
    id,
  ).rows;
  for (const i of items) {
    const data = JSON.parse(String(i.data));
    const desc = arrow(data, "description");
    const section = desc === null ? null : "Produto " + desc;
    const o = 100 + Number(i.position);
    if (i.product_id === null) out.push({ o, section, message: "O item não está vinculado a um produto cadastrado" });
    else if (i.p_id !== null) {
      if (i.ncm === null || !/^[0-9]{8}$/.test(String(i.ncm))) out.push({ o, section, message: "O campo NCM é obrigatório" });
      if (i.origin === null) out.push({ o, section, message: "O campo Origem é obrigatório" });
      if (blank(arrow(data, "unit"))) out.push({ o, section, message: "O campo Unidade é obrigatório" });
    }
  }
  out.sort((x, y) => x.o - y.o || pgCompareText(x.message, y.message));
  return out.map(({ section, message }) => ({ section, message }));
}

/** public.erp_document_pendencies(p_user_id, p_kind, p_id) */
export function erpDocumentPendencies(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_id);
  requireAccess(ctx.db, user, kind, false);
  if (kind !== null && kind !== "sales_orders") raise("22023", "erp_document_query_invalid");
  const v = id === null || kind === null ? null : one(ctx.db, 'SELECT id, kind, number, status, version, contact_id FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind);
  if (!v || !contactUsable(ctx.db, user, str(v.contact_id))) raise("P0002", "erp_document_not_found");
  return {
    kind,
    document: { id: v.id, kind: v.kind, number: v.number === null ? null : String(v.number), status: v.status, version: Number(v.version) },
    pendencies: pendencies(ctx.db, id!),
    ...NATIVE,
  };
}

/** round(a/b) do numeric do Postgres: metade para longe do zero. */
function roundDiv(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n,
    ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad);
  return neg ? -q : q;
}

/** public.erp_document_commission_operation(p_user_id, p_kind, p_document_id): a comissão ativa do documento, rateada pelos itens. */
export function erpDocumentCommissionOperation(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    id = str(a.p_document_id);
  if (kind === null || !["sales_orders", "service_orders"].includes(kind) || id === null) raise("22023", "erp_document_query_invalid");
  requireAccess(ctx.db, user, kind, false);
  if (!one(ctx.db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=? AND kind=?', id, kind)) raise("P0002", "erp_document_not_found");
  const o = one(
    ctx.db,
    `SELECT id, CAST(items_cents AS TEXT) items_cents, CAST(base_cents AS TEXT) base_cents, CAST(estimated_cents AS TEXT) estimated_cents
       FROM "erp_finance__commission_operation" WHERE document_id=? AND state='active'`,
    id,
  );
  let items: Row[] = [];
  if (o) {
    const total = BigInt(String(o.items_cents)),
      base = BigInt(String(o.base_cents)),
      estimated = BigInt(String(o.estimated_cents));
    const rows = ctx.db
      .exec('SELECT position, data, product_snapshot, CAST(total AS TEXT) total FROM "erp_documents__item" WHERE document_id=?', id)
      .rows.sort((x, y) => Number(x.position) - Number(y.position));
    let running: bigint | null = null;
    items = rows.map((x) => {
      const data = JSON.parse(String(x.data));
      const snap = x.product_snapshot === null ? null : JSON.parse(String(x.product_snapshot));
      const cents = x.total === null ? null : fromColumn(x.total);
      if (cents !== null) running = (running ?? 0n) + cents;
      const upto = running;
      const before = upto === null || cents === null ? null : upto - cents;
      const share = (value: bigint) =>
        total === 0n ? "0" : upto === null || before === null ? null : String(roundDiv(value * upto, total) - roundDiv(value * before, total));
      return {
        position: Number(x.position),
        description: pgLeft(arrow(data, "description") ?? (snap === null ? null : arrow(snap, "name")) ?? "", 240),
        item_cents: cents === null ? null : String(cents),
        base_cents: share(base),
        commission_cents: share(estimated),
      };
    });
  }
  return { kind, document_id: id, operation: o ? commissionOperationView(ctx.db, String(o.id)) : null, items, ...NATIVE };
}

/** public.erp_document_seller_commission(p_user_id, p_kind, p_seller_id): regra de comissão do vendedor e as adições da política. */
export function erpDocumentSellerCommission(ctx: RpcContext, a: RpcArgs) {
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    sellerId = str(a.p_seller_id);
  if (kind === null || !["sales_orders", "service_orders"].includes(kind) || sellerId === null) raise("22023", "erp_document_query_invalid");
  requireAccess(ctx.db, user, kind, false);
  const s = one(
    ctx.db,
    'SELECT id, commission_mode, CAST(commission_rate AS TEXT) commission_rate, commission_bands FROM "erp_catalog__seller" WHERE id=?',
    sellerId,
  );
  if (!s) raise("22023", "erp_document_seller_unavailable");
  const bands = (JSON.parse(String(s.commission_bands)) as unknown[])
    .map((b) => ({ up: arrow(b, "discount_up_to"), rate: arrow(b, "rate") }))
    .sort((x, y) => (x.up === null || y.up === null ? (x.up === y.up ? 0 : x.up === null ? 1 : -1) : compareDec(x.up, y.up)))
    .map((b) => ({ discount_up_to: dec4(b.up), rate: dec4(b.rate) }));
  return {
    kind,
    seller_id: s.id,
    mode: s.commission_mode,
    rate: s.commission_rate === null ? null : formatScaled(fromColumn(s.commission_rate), 4),
    bands,
    additions: (commissionPolicy(ctx.db) as Record<string, unknown>).additions,
    ...NATIVE,
  };
}

registerRpc("erp_document_access", erpDocumentAccess);
registerRpc("erp_document_pendencies", erpDocumentPendencies);
registerRpc("erp_document_commission_operation", erpDocumentCommissionOperation);
registerRpc("erp_document_seller_commission", erpDocumentSellerCommission);

