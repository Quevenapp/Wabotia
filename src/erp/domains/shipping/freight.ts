// Expedição › frete (motor; o serviço de frete do Worker fica em
// src/erp/frete/): o que a cotação e a etiqueta oficial precisam ler do
// pedido e o que elas gravam nele.
// - erp_shipping_freight_context (leitura): remetente (a empresa), destinatário
//   e endereço, volumes com peso e medidas, itens para a declaração de
//   conteúdo, a NF-e autorizada (chave) e se o frete do pedido ainda pode mudar;
// - erp_shipping_freight_apply (gravação com recibo): o valor do frete e o
//   prazo no pedido, pelo salvamento do próprio pedido (erp_document_save, com
//   todas as regras dele), e o código de rastreio na situação do pedido na
//   expedição (o que etiqueta, romaneio e tela já leem).
// Nenhuma tabela nova: as cotações, os envios e o rastreio ficam no D1 da área
// (migração 0255), com as credenciais no cofre do núcleo.
import { one, type Row } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import * as documents from "../documents/public.ts";
import {
  commandOf, companyOf, hashOf, orderPickLines, orderRow, orderSummary, recipientOf, receipt, replay, requireShipping, setOrder, shipStatus, subCommand, transportOf, volumeRows,
} from "./rpc.ts";

const parse = (v: unknown): any => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
const invalid = (code = "erp_shipping_invalid"): never => raise("22023", code);
/** Campos que o salvamento calcula (não entram de volta no corpo enviado). */
const ITEM_COMPUTED = ["gross", "discount", "total", "position"];

function argsOf(raw: unknown, allowed: readonly string[]) {
  const a = parse(raw ?? {});
  if (!a || typeof a !== "object" || Array.isArray(a) || JSON.stringify(a).length > 8192 || Object.keys(a).some((k) => !allowed.includes(k))) invalid();
  return a as Record<string, any>;
}
const docId = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : invalid());
/** "12.30" (reais) em centavos. */
const cents = (v: string) => { const [i, f = ""] = v.split("."); return BigInt(i) * 100n + BigInt(f.padEnd(2, "0")); };
const money = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;

/** O pedido ainda aceita outro valor de frete? Os motivos conhecidos, em código. */
function freightBlock(r: Row): string | null {
  const body = obj(parse(r.body));
  if (transportOf(r).freight_mode === "9") return "erp_shipping_freight_no_freight";
  if (!documents.editable(r.status)) return "erp_shipping_freight_locked";
  if (Array.isArray(body.installments) && body.installments.length) return "erp_shipping_freight_installments";
  return null;
}

/** erp_shipping_freight_context: o pedido como a cotação e a etiqueta oficial precisam (sem gravar nada). */
export function erpShippingFreightContext(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id);
  const role = requireShipping(db, user, false);
  const o = argsOf(a.p_args, ["id"]);
  const r = orderRow(db, user, docId(o.id));
  const id = String(r.id), body = obj(parse(r.body)), totals = obj(body.totals);
  const freight = typeof totals.freight === "string" ? totals.freight : typeof body.freight === "string" ? body.freight : "0.00";
  const total = r.total === null || r.total === undefined ? 0n : BigInt(String(r.total));
  const declared = total - (MONEY.test(freight) ? cents(freight) : 0n);
  const nfe = ctx.parts.fiscal ? one(db, `SELECT number, series, access_key FROM "erp_fiscal_vault__order_emission" WHERE document_id=? AND status='autorizada' ORDER BY fiscal_version DESC LIMIT 1`, id) : null;
  const block = freightBlock(r);
  const items = orderPickLines(ctx, id).map((l) => ({
    description: String(l.description ?? "Item"), quantity: String(l.quantity), unit: (l.unit as string | null) ?? null,
  }));
  const commercial = obj(obj(body.commercial).transport);
  const warehouses = new Map<string, string | null>();
  return {
    scope: "shipping_freight_context", data_mode: "erp_native", role, can_write: ["admin", "vendas", "estoque"].includes(role),
    order: {
      ...orderSummary(db, r, warehouses), ship_status: shipStatus(r), freight, delivery_days: typeof commercial.delivery_days === "string" ? commercial.delivery_days : null,
      declared_cents: (declared > 0n ? declared : 0n).toString(), freight_editable: block === null, freight_block: block,
    },
    sender: companyOf(db), recipient: recipientOf(r), volumes: volumeRows(db, id), items,
    invoice: nfe && nfe.access_key ? { number: nfe.number === null ? null : Number(nfe.number), series: nfe.series === null ? null : Number(nfe.series), key: String(nfe.access_key) } : null,
  };
}

/** O corpo salvo do pedido de volta na forma do salvamento (sem os totais e os campos calculados dos itens). */
function inputBody(ctx: RpcContext, r: Row): Record<string, any> {
  const { totals: _totals, ...body } = obj(parse(r.body));
  const items = ctx.db.exec('SELECT data FROM "erp_documents__item" WHERE document_id=? ORDER BY position', r.id).rows
    // Pedido com bloco comercial: o salvamento pede a descrição detalhada de cada item (vazia, se não houver).
    .map((i) => ({ detailed_description: null, ...Object.fromEntries(Object.entries(obj(parse(i.data))).filter(([k]) => !ITEM_COMPUTED.includes(k))) }));
  return { ...body, items };
}

/**
 * erp_shipping_freight_apply: grava no pedido o que veio do frete.
 * - freight ("23.50") e delivery_days ("3"): pelo salvamento do pedido; o
 *   pedido "sem frete", fechado (aprovado, atendido, cancelado) ou com
 *   parcelas recusa com o motivo, e nada muda;
 * - tracking_code: o rastreio do pedido na expedição (clear_tracking apaga,
 *   no cancelamento da etiqueta).
 */
export function erpShippingFreightApply(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db, user = String(a.p_user_id), command = commandOf(a);
  requireShipping(db, user, true);
  const o = argsOf(a.p_args, ["document_id", "freight", "delivery_days", "tracking_code", "clear_tracking"]);
  const hash = hashOf("freight_apply", user, o);
  const again = replay(db, command, user, hash);
  if (again) return again;
  const r = orderRow(db, user, docId(o.document_id));
  const id = String(r.id);
  const freight = o.freight === undefined || o.freight === null ? null : typeof o.freight === "string" && MONEY.test(o.freight) ? o.freight : invalid("erp_shipping_freight_value");
  const days = o.delivery_days === undefined || o.delivery_days === null ? null
    : typeof o.delivery_days === "string" && /^(0|[1-9][0-9]{0,3})$/.test(o.delivery_days) ? o.delivery_days : invalid("erp_shipping_freight_value");
  const tracking = o.tracking_code === undefined || o.tracking_code === null ? null
    : typeof o.tracking_code === "string" && /^[A-Za-z0-9-]{4,60}$/.test(o.tracking_code.trim()) ? o.tracking_code.trim() : invalid("erp_shipping_freight_tracking");
  if (o.clear_tracking !== undefined && typeof o.clear_tracking !== "boolean") invalid();
  if (o.clear_tracking === true && tracking !== null) invalid();
  let freightWritten = false;
  if (freight !== null || days !== null) {
    const block = freightBlock(r);
    if (block) raise("40001", block);
    const body = inputBody(ctx, r);
    const commercial = { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null, transport: null, ...obj(body.commercial) };
    const transport = { freight_mode: null, volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null, ...obj(commercial.transport) };
    const next = {
      ...body,
      ...(freight !== null ? { freight: money(cents(freight)) } : {}),
      ...(days !== null ? { commercial: { ...commercial, transport: { ...transport, delivery_days: days } } } : {}),
    };
    invokeRpc(ctx, "erp_document_save", { p_user_id: user, p_kind: "sales_orders", p_id: id, p_expected_version: Number(r.version), p_command_id: subCommand(command, "freight-save"), p_body: next });
    freightWritten = true;
  }
  let trackingWritten = false;
  if (tracking !== null || o.clear_tracking === true) {
    const current = orderRow(db, user, id);
    setOrder(ctx, user, id, shipStatus(current), { tracking_code: tracking });
    trackingWritten = true;
  }
  const warehouses = new Map<string, string | null>();
  return receipt(ctx, command, user, hash, {
    scope: "shipping_freight_apply", freight_written: freightWritten, tracking_written: trackingWritten,
    order: orderSummary(db, orderRow(db, user, id), warehouses),
  });
}

registerRpc("erp_shipping_freight_context", erpShippingFreightContext);
registerRpc("erp_shipping_freight_apply", erpShippingFreightApply);
