// erp_catalog_contact_timeline (Wabotia, linha do tempo da ficha do cliente,
// src/customer/timeline.ts): uma fonte por chamada, paginada por (data, chave)
// com o corte aplicado antes do limite.
//   p_source 'sales':    pedidos de venda nativos do contato (sem o teto de 10
//                        do cartão Vendas), com a mesma barreira de tipo de
//                        documento de erp_catalog_contact_history;
//   p_source 'invoices': notas fiscais emitidas pelo cofre (NF-e do pedido e
//                        NFC-e do balcão) dos documentos do contato, só
//                        autorizadas ou canceladas, com o papel fiscal de leitura.
// Só leitura; não muda nada do Fiscal (src/erp/domains/fiscal fica intocado).
import { one } from "../../../engine/driver.ts";
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { ErpError, raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess as documentAccess } from "../../documents/public.ts";
import { requireCom1Access } from "../../fiscal/comnfe/access.ts";
import { COM1_MODEL_TABLES } from "../../fiscal/comnfe/model.ts";
import { requireAccess } from "../access.ts";
import { contactRequireVisible } from "../contact.ts";
import { erpEntityRequirement } from "../../../parts-requirements.ts";
import { erpRequirementMet } from "../../../parts.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const denied = (e: unknown) => e instanceof ErpError && (e.code === "42501" || e.code === "55000");
/** Milissegundos: as colunas INTEGER do cofre podem vir em segundos. */
const ms = (value: unknown) => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null; };

interface Row { key: string; at: number; date_only: boolean; [k: string]: unknown }
/** Corte (at, key) e limite+1, a mesma regra das outras fontes da linha do tempo. */
function page(rows: Row[], before: number, key: string | null, limit: number) {
  const after = (r: Row) => key === null ? r.at < before : r.at < before || (r.at === before && r.key < key);
  const sorted = rows.filter(after).sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return sorted.slice(0, limit + 1);
}

export function erpCatalogContactTimeline(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = (a.p_user_id ?? null) as string | null;
  const contact = (a.p_contact_id ?? null) as string | null;
  const source = a.p_source;
  const before = Number(a.p_before), key = a.p_key === undefined || a.p_key === null || a.p_key === "" ? null : String(a.p_key);
  const limit = Number(a.p_limit ?? 20);
  requireAccess(db, user, "contacts", false);
  if (!["sales", "invoices"].includes(String(source)) || !Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
      (key !== null && key.length > 200)) raise("22023", "erp_catalog_invalid_query");
  if (contact === null || !one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, contact)) raise("P0002", "erp_catalog_not_found");
  contactRequireVisible(db, user, contact);
  const salesRequirement = erpEntityRequirement("sales_orders");
  if (salesRequirement === null || !erpRequirementMet(ctx.parts, salesRequirement))
    return { scope: "contact_timeline", source, data_mode: "erp_native", visible: false, items: [], unavailable_parts: ["sales"] };
  try { documentAccess(db, user, "sales_orders", false); }
  catch (e) { if (e instanceof ErpError && e.code === "42501") return { scope: "contact_timeline", source, data_mode: "erp_native", visible: false, items: [] }; throw e; }

  if (source === "sales") {
    const rows: Row[] = db.exec(`SELECT id, CAST(number AS TEXT) number, json_extract(body,'$.date') date, status, CAST(total AS TEXT) total
        FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders' AND contact_id=?`, contact).rows
      .filter(d => typeof d.date === "string" && DAY.test(String(d.date)))
      // Datas sem hora: meio-dia UTC, a mesma convenção da tela.
      .map(d => ({ key: `erp:${d.id}`, at: Date.parse(`${d.date}T12:00:00Z`), date_only: true, id: d.id, number: d.number ?? null, date: d.date, status: d.status,
        total: d.total === null || d.total === undefined ? null : formatScaled(fromColumn(d.total), 2) }));
    return { scope: "contact_timeline", source, data_mode: "erp_native", visible: true, items: page(rows, before, key, limit) };
  }

  if (!ctx.parts.fiscal) return { scope: "contact_timeline", source, data_mode: "erp_native", visible: false, items: [], unavailable_parts: ["fiscal"] };
  try { requireCom1Access(ctx, "read"); }
  catch (e) { if (denied(e)) return { scope: "contact_timeline", source, data_mode: "erp_native", visible: false, items: [] }; throw e; }
  const rows: Row[] = [];
  for (const [model, tables] of Object.entries(COM1_MODEL_TABLES)) {
    // Contato do documento (o pedido da NF-e ou a venda do balcão).
    for (const e of db.exec(`SELECT e.id, e.document_id, e.environment, e.status, e.series, e.number, e.access_key, e.authorized_at, e.issued_at, e.updated_at, e.total
        FROM "${tables.emission}" e JOIN "erp_documents__document" d ON d.id=e.document_id
        WHERE json_extract(d.body,'$.contact_id')=? AND e.status IN ('autorizada','cancelada')`, contact).rows) {
      const at = ms(e.authorized_at) ?? ms(e.issued_at) ?? ms(e.updated_at);
      if (at === null) continue;
      rows.push({ key: `nota:${model}:${e.id}`, at, date_only: false, id: e.id, model: model === "nfce" ? "65" : "55", document_id: e.document_id,
        environment: e.environment, status: e.status, series: e.series ?? null, number: e.number ?? null,
        total: e.total === null || e.total === undefined ? null : (Number(e.total) / 100).toFixed(2) });
    }
  }
  return { scope: "contact_timeline", source, data_mode: "erp_native", visible: true, items: page(rows, before, key, limit) };
}

registerRpc("erp_catalog_contact_timeline", erpCatalogContactTimeline);
