// Prévia da conversão da proposta em pedido de venda ou ordem de serviço
// (sessão L, bloco B0): public.erp_document_conversion_preview, com o mesmo
// nome. Não grava nada: o corpo que o pedido teria. Abre com
// erp_document_mirror.require_visible(…, true), como no oráculo: proposta do
// espelho é só leitura (mirrorRequireVisible).
import { one } from "../../../engine/driver.ts";
import { boolIn } from "../../../engine/args.ts";
import { compareDec, formatScaled, fromColumn } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLeft } from "../../../engine/text.ts";
import { unitPriceNumeric } from "../../catalog/public.ts";
import { preference } from "../internal.ts";
import { contactUsable, mirrorRequireVisible, requireAccess } from "../public.ts";
import { saleBodyFromProposal } from "../views.ts";
import { jsonPathText, richTextPlain } from "./reads-common.ts";

type Obj = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const DROPPED = ["totals", "template_name", "valid_until", "next_contact", "template", "other_items", "commercial_conditions"];

/** public.erp_document_conversion_preview(p_user_id, p_kind, p_proposal_id) */
export function erpDocumentConversionPreview(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = str(a.p_user_id),
    kind = str(a.p_kind),
    proposal = str(a.p_proposal_id);
  mirrorRequireVisible(db, user, proposal, true);
  if (kind === null || !["sales_orders", "service_orders"].includes(kind)) raise("22023", "erp_document_query_invalid");
  requireAccess(db, user, "sales_proposals", true);
  requireAccess(db, user, kind, true);
  const v =
    proposal === null
      ? null
      : one(db, `SELECT id, number, version, status, contact_id, contact_snapshot, body FROM "erp_documents__document" WHERE id=? AND kind='sales_proposals'`, proposal);
  if (!v || !contactUsable(db, user, str(v.contact_id))) raise("P0002", "erp_document_not_found");
  if (one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE source_proposal_id=?', proposal)) raise("40001", "erp_proposal_already_converted");
  const source = JSON.parse(String(v.body)) as Obj;
  const template = arrow(source, "template");
  if (["cancelled", "completed"].includes(String(v.status)) || (template !== null && boolIn(template))) raise("22023", "erp_proposal_not_approved");
  const body: Obj = kind === "sales_orders" ? saleBodyFromProposal(db, source) : { ...source, template: false };
  for (const k of DROPPED) delete body[k];
  const installments = Array.isArray(body.installments) ? body.installments : body.installments === undefined || body.installments === null ? [] : null;
  body.installments = (installments ?? []).map((p) => {
    if (p === null || typeof p !== "object" || Array.isArray(p)) return p;
    const { position: _drop, ...rest } = p as Obj;
    return rest;
  });
  const sendDetail = !(kind === "sales_orders" && preference(db, "propostas.enviar_descricao_venda") === false);
  const items: Obj[] = db
    .exec(
      `SELECT position, product_id, data, product_snapshot, CAST(quantity AS TEXT) quantity, unit_price, discount_percent
         FROM "erp_documents__item" WHERE document_id=?`,
      proposal,
    )
    .rows.sort((x, y) => Number(x.position) - Number(y.position))
    .map((i) => {
      const data = JSON.parse(String(i.data)) as Obj;
      const snap = i.product_snapshot === null ? null : (JSON.parse(String(i.product_snapshot)) as Obj);
      const item: Obj = {
        id: null,
        product_id: i.product_id,
        description: data.description ?? null,
        code: data.code ?? null,
        unit: data.unit ?? null,
        quantity: i.quantity === null ? null : formatScaled(fromColumn(i.quantity), 6),
        unit_price: unitPriceNumeric(i.unit_price, 10),
        discount_percent: i.discount_percent === null ? null : formatScaled(fromColumn(i.discount_percent), 4),
        detailed_description: sendDetail ? (data.detailed_description ?? null) : null,
      };
      if (Object.prototype.hasOwnProperty.call(data, "list_price")) item.list_price = data.list_price;
      if (kind === "service_orders") Object.assign(item, { group: (snap === null ? null : arrow(snap, "kind")) === "S" ? "service" : "part", quote: false, done: false });
      return item;
    });
  const otherTotal = jsonPathText(source, ["other_items", "total"]);
  if (compareDec(otherTotal ?? "0", "0") > 0) {
    const content = source.other_items !== null && typeof source.other_items === "object" ? (source.other_items as Obj).content : undefined;
    const plain = richTextPlain(content);
    const detail = plain === null ? null : pgLeft(plain, 4000);
    items.push({
      id: null,
      product_id: null,
      description: "Outros itens ou serviços",
      code: null,
      unit: "UN",
      quantity: "1",
      unit_price: otherTotal,
      discount_percent: "0",
      detailed_description: detail === "" ? null : detail,
      ...(kind === "service_orders" ? { group: "service", quote: false, done: false } : {}),
    });
    if (arrow(body, "discount_mode") === "percent") {
      body.discount_mode = "amount";
      body.discount_value = jsonPathText(source, ["totals", "discount"]) ?? "0.00";
    }
  }
  const snapshot = JSON.parse(String(v.contact_snapshot)) as Obj;
  const name = arrow(snapshot, "name");
  const listId = arrow(body, "price_list_id");
  const list = listId === null ? null : one(db, 'SELECT name FROM "erp_pricing__price_list" WHERE id=?', listId); // l.id::text = texto exato
  return {
    source: { id: v.id, kind: "sales_proposals", number: v.number === null ? null : String(v.number), version: Number(v.version) },
    kind,
    data: { ...body, items },
    contact: { id: v.contact_id, name: name === null ? null : pgLeft(name, 200) },
    price_list_name: list ? pgLeft(String(list.name), 120) : null,
    persisted: false,
    data_mode: "erp_native",
    operational_effects: false,
  };
}

registerRpc("erp_document_conversion_preview", erpDocumentConversionPreview);
