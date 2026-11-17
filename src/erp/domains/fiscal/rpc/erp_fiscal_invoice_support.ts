// Fiscal, bloco F1: leituras de apoio do formulário da nota (versões finais no
// oráculo). public.erp_fiscal_invoice_context, _payment_methods,
// _product_groups e _contact_source, com erp_fiscal_invoices.invoice_preferences,
// contact_snapshot e seller_ref.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbArg } from "../../../engine/args.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgCompareText, pgLeft, pgLower } from "../../../engine/text.ts";
import { contactRequireVisible } from "../../catalog/public.ts";
import { preference, requireWrite, uuidInput, type Json } from "../core.ts";

const str = (v: unknown) => (typeof v === "string" ? v : null);
const bool = (v: unknown) => (v === null || v === undefined ? null : v === 1 || v === true);

/** erp_fiscal_invoices.invoice_preferences(modelo) */
export function invoicePreferences(db: SqlDriver, model: string): Json {
  const p = model === "65" ? "nfce" : "nfe";
  const pref = (key: string, type: string, fallback: unknown) => preference(db, key, type, fallback);
  const b = "boolean";
  // Só as linhas {document, name} bem formadas (11 ou 14 dígitos) chegam ao formulário, até a décima posição.
  const people = (pref(`${p}.autxml_pessoas`, "array", []) as unknown[])
    .map((x, i) => ({ x, n: i + 1 }))
    .filter(({ x, n }) => {
      if (n > 10 || jsonType(x) !== "object") return false;
      const o = x as Json;
      const doc = o.document === null || o.document === undefined ? null : typeof o.document === "string" ? o.document : jsonbText(o.document);
      return doc !== null && /^([0-9]{11}|[0-9]{14})$/.test(doc) && jsonType(o.name) === "string";
    })
    .map(({ x }) => {
      const o = x as Json;
      return { document: typeof o.document === "string" ? o.document : jsonbText(o.document), name: pgLeft(o.name as string, 60) };
    });
  const validation = pref("nfe.validacao_opcional", "array", []) as unknown[];
  const freight = pref("nfe.frete_por_conta", "string", "9") as string;
  const species = pref("nfe.especie_padrao", "string", "volumes") as string;
  const markup = pref("nfe.markup", "string", "0") as string;
  const volumes = pref("nfe.volume_padrao", "number", 0);
  return {
    show_totals: pref("nfe.exibir_totais", b, true),
    freight_by: ["0", "1", "2", "3", "4", "9"].includes(freight) ? freight : "9",
    species: ["outros", "volumes", "unidades", "caixas", "pacotes", "envelopes"].includes(species) ? species : "volumes",
    volume_quantity: /^[0-9]{1,5}$/.test(jsonbText(volumes)) ? volumes : 0,
    markup: /^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/.test(markup) ? markup : "0",
    sum_weight: pref("nfe.somar_peso", b, false),
    compute_volume: pref("nfe.calcular_volume", b, false),
    ipi_first_installment: pref("nfe.ipi_primeira_parcela", b, false),
    st_first_installment: pref("nfe.st_primeira_parcela", b, false),
    tracking_in_info: pref("nfe.rastreio_infcpl", b, false),
    purchase_order_in_info: pref("nfe.ordem_compra_infcpl", b, false),
    simples_credit_message: pref("nfe.mensagem_credito_simples", b, false),
    optional_installments: validation.some((x) => x === "parcelas"),
    fuel_group: pref(`${p}.grupo_combustiveis`, b, false),
    weapon_group: pref(`${p}.grupo_armamento`, b, false),
    vehicle_group: pref(`${p}.grupo_veiculos`, b, false),
    retention_group: model === "65" ? false : pref("nfe.grupo_retencao", b, false),
    autxml_carrier: pref(`${p}.autxml_transportadora`, b, false),
    autxml_people: people,
    block_edit_stock: pref("nfe.bloquear_edicao_estoque", b, false),
    block_edit_finance: pref("nfe.bloquear_edicao_contas", b, false),
  };
}

export function erpFiscalInvoiceContext(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireWrite(db, str(a.p_user_id));
  const model = str(a.p_model);
  if (model === null || !["55", "65"].includes(model)) raise("22023", "erp_fiscal_query_invalid");
  const c = one(
    db,
    `SELECT f.crt, json_extract(i.data,'$.state') state, json_extract(i.data,'$.cnpj') cnpj FROM "erp_company__identity" i
       LEFT JOIN "erp_company__fiscal" f ON f.singleton=i.singleton WHERE i.singleton=1`,
  );
  const company = c
    ? { crt: c.crt ?? null, regime_confirmed: c.crt !== null && c.crt !== undefined, state: c.state ?? null, cnpj_present: c.cnpj !== null && c.cnpj !== undefined && c.cnpj !== "" }
    : { crt: null, regime_confirmed: false, state: null, cnpj_present: false };
  const series = db
    .exec(`SELECT series, CAST(next_number AS TEXT) next_number, enabled FROM "erp_fiscal_numbering__series" WHERE model=? AND environment='2'`, model)
    .rows.map((s) => ({ series: Number(s.series), next_number: Number(s.next_number), enabled: s.enabled === 1 }))
    .sort((x, y) => x.series - y.series);
  const defaults: Json = {};
  for (const d of db
    .exec(
      `SELECT d.code, n.id, n.description FROM "erp_fiscal_invoices__nature_default" d JOIN "erp_fiscal_invoices__nature" n ON n.id=d.nature_id WHERE n.active=1`,
    )
    .rows.sort((x, y) => pgCompareText(String(x.code), String(y.code))))
    defaults[String(d.code)] = { id: d.id, description: d.description };
  return {
    company, series, defaults, preferences: invoicePreferences(db, model!),
    // 176: "Informar desconto individualmente nos itens", fora do bloco de preferências.
    item_discount: preference(db, "nfe.desconto_itens", "boolean", true),
    // 215: "Preencher manualmente Destino da Operação" (só NF-e; a NFC-e é sempre interna).
    operation_destination_manual: model === "55" && preference(db, "nfe.destino_manual", "boolean", false) === true,
    open_titles: { receivable: preference(db, "vendas.ver_contas_receber", "boolean", false), payable: preference(db, "compras.ver_contas_pagar", "boolean", false) },
    writable: true, emission_enabled: false, production_enabled: false, data_mode: "erp_native",
  };
}

export function erpFiscalInvoicePaymentMethods(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireWrite(db, str(a.p_user_id));
  const direction = str(a.p_direction);
  if (direction === null || !["0", "1"].includes(direction)) raise("22023", "erp_fiscal_query_invalid");
  const items = db
    .exec(
      `SELECT id, description, payment_type, card_brand, card_integration, card_cnpj FROM "erp_catalog__payment_method"
        WHERE deleted_at IS NULL AND active=1 AND applicable IN ('ambos', ?)`,
      direction === "1" ? "recebimentos" : "pagamentos",
    )
    .rows.map((m) => ({ m, key: pgLower(String(m.description)) }))
    .sort((x, y) => pgCompareText(x.key, y.key) || pgCompareText(String(x.m.id), String(y.m.id)))
    .slice(0, 200)
    .map(({ m }) => ({
      id: m.id, description: m.description, payment_type: m.payment_type ?? null, card_brand: m.card_brand ?? null, card_integration: m.card_integration ?? null,
      card_cnpj: m.card_cnpj ?? null,
    }));
  return { direction, data_mode: "erp_native", items };
}

export function erpFiscalInvoiceProductGroups(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireWrite(db, str(a.p_user_id));
  const ids = jsonbArg(a.p_product_ids);
  if (jsonType(ids) !== "array" || (ids as unknown[]).length < 1 || (ids as unknown[]).length > 100) raise("22023", "erp_fiscal_query_invalid");
  const unique = [...new Set((ids as unknown[]).map((x) => uuidInput(x)!))];
  const items = db
    .exec(
      `SELECT r.id, d.product_group_id FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id
        WHERE r.id IN (SELECT value FROM json_each(?)) AND r.entity='products'`,
      JSON.stringify(unique),
    )
    .rows.map((r) => ({ id: String(r.id), group_id: (r.product_group_id as string | null) ?? null }))
    .sort((x, y) => pgCompareText(x.id, y.id));
  return { items, data_mode: "erp_native" };
}

/** erp_fiscal_invoices.contact_snapshot(contato) */
export function contactSnapshot(db: SqlDriver, id: string): Json | null {
  const r = one(
    db,
    `SELECT r.id, r.name, r.code, r.active, c.trade_name, c.person_type, c.document, c.ie, c.email, c.phone, c.mobile, c.postal_code, c.street, c.number, c.complement,
            c.district, c.city, c.state, p.taxpayer, p.country, p.nfe_email
       FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id LEFT JOIN "erp_catalog__contact_profile" p ON p.record_id=r.id
      WHERE r.id=? AND r.entity='contacts'`,
    id,
  );
  if (!r) return null;
  const { id: rid, active, ...rest } = r;
  const out: Json = { contact_id: rid, active: bool(active) };
  for (const [k, v] of Object.entries(rest)) out[k] = v ?? null;
  return out;
}

/** erp_fiscal_invoices.seller_ref(vendedor) */
export function sellerRef(db: SqlDriver, seller: string | null): Json | null {
  const s = one(db, `SELECT s.id, r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=? AND r.active=1`, seller);
  return s ? { id: s.id, name: pgLeft(String(s.name), 200) } : null;
}

export function erpFiscalInvoiceContactSource(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id);
  const role = requireWrite(db, user);
  const contactId = str(a.p_contact_id);
  const direction = str(a.p_direction);
  if (contactId === null || direction === null || !["0", "1"].includes(direction)) raise("22023", "erp_fiscal_query_invalid");
  const contact = contactSnapshot(db, contactId!);
  if (!contact) raise("P0002", "erp_fiscal_invoice_contact_not_found");
  contactRequireVisible(db, user, contactId);
  const p = one(db, 'SELECT operation_nature_id, seller_id FROM "erp_catalog__contact_profile" WHERE record_id=?', contactId);
  const n = one(
    db,
    `SELECT id, description, crt FROM "erp_fiscal_invoices__nature" WHERE id=? AND direction=? AND active=1 AND deleted_at IS NULL`,
    (p?.operation_nature_id as string | null) ?? null,
    direction,
  );
  return {
    contact, nature: n ? { id: n.id, description: n.description, crt: n.crt } : null, seller: sellerRef(db, (p?.seller_id as string | null) ?? null),
    writable: ["admin", "fiscal"].includes(role), data_mode: "erp_native",
  };
}

registerRpc("erp_fiscal_invoice_context", erpFiscalInvoiceContext);
registerRpc("erp_fiscal_invoice_payment_methods", erpFiscalInvoicePaymentMethods);
registerRpc("erp_fiscal_invoice_product_groups", erpFiscalInvoiceProductGroups);
registerRpc("erp_fiscal_invoice_contact_source", erpFiscalInvoiceContactSource);
