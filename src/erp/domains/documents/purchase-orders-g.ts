// Pedido da G (F7 do Fiscal, notas recebidas pelo cofre): os pedidos de compra de um fornecedor que
// ainda podem receber, com os itens. Sem RPC no Fagoo; o critério é o do recebimento de compra
// (erp_stock.receive, ação 'receive'): erp_stock.document_eligible e nenhum lançamento de estoque do
// documento inteiro (purchase_receipt_legacy_mode). Fora a lixeira. A quantidade restante de cada
// item é do erp_purchase_receipts.current, da N.
import type { SqlDriver } from "../../engine/driver.ts";
import { formatScaled, fromColumn } from "../../engine/dec.ts";
import { jsonbText } from "../../engine/json.ts";
import { documentEligible } from "../stock/public.ts";

type Row = Record<string, unknown>;
const parse = (v: unknown): Row | null => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : (v as Row));
const text = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v));
const dec = (v: unknown, scale: number) => (v === null || v === undefined ? null : formatScaled(fromColumn(v), scale));

export type OpenPurchaseOrder = {
  id: string;
  number: string | null;
  version: number;
  date: string | null;
  status: string;
  total: string | null;
  items: { id: string; position: number; product_id: string | null; description: string | null; unit: string | null; quantity: string; unit_price: string }[];
};

/** Pedidos de compra do fornecedor que ainda podem receber nota, por data, número e id. */
export function openPurchaseOrders(db: SqlDriver, supplierContactId: string | null): OpenPurchaseOrder[] {
  if (supplierContactId === null) return [];
  const docs = db.exec(
    `SELECT d.id, CAST(d.number AS TEXT) number, d.version, d.status, d.body, CAST(d.total AS TEXT) total
       FROM "erp_documents__document" d
      WHERE d.kind='purchase_orders' AND d.contact_id=? AND d.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM "erp_stock__document_posting" p WHERE p.document_id=d.id)`,
    supplierContactId,
  ).rows;
  return docs
    .filter((d) => documentEligible("purchase_orders", d.status))
    .map((d) => ({
      id: String(d.id),
      number: d.number === null ? null : String(d.number),
      version: Number(d.version),
      date: text(parse(d.body)?.date),
      status: String(d.status),
      total: dec(d.total, 2),
      items: db
        .exec(
          `SELECT id, position, product_id, data, CAST(quantity AS TEXT) quantity, unit_price
             FROM "erp_documents__item" WHERE document_id=? ORDER BY position`,
          d.id,
        )
        .rows.map((i) => {
          const data = parse(i.data);
          return {
            id: String(i.id),
            position: Number(i.position),
            product_id: i.product_id === null ? null : String(i.product_id),
            description: text(data?.description),
            unit: text(data?.unit),
            quantity: dec(i.quantity, 6)!,
            // numeric sem escala (202610160057): guardado como o texto do Postgres.
            unit_price: String(i.unit_price),
          };
        }),
    }))
    .sort((x, y) => (x.date ?? "￿").localeCompare(y.date ?? "￿") || Number(x.number ?? Infinity) - Number(y.number ?? Infinity) || x.id.localeCompare(y.id));
}
