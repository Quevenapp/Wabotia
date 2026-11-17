// Escrito pela P para o Catálogo; dona: O (Documentos). Só leitura.
// salesInPeriodCondition: o filtro "Sem compras no período" de
// erp_catalog.contact_where (contact_page e contact_export).

/**
 * Condição SQL "o contato tem pedido de venda no período", para compor na
 * consulta de quem chama: EXISTS sobre erp_documents.document com
 * kind='sales_orders', body->>'date' entre from e to (texto AAAA-MM-DD; data
 * nula não entra) e status na lista, quando há lista (por json_each: um
 * parâmetro só). `contact` é a expressão SQL do id do contato na consulta de
 * fora (por exemplo "r.id").
 */
export function salesInPeriodCondition(
  contact: string,
  from: string | null,
  to: string | null,
  statuses: string[] | null,
): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS(SELECT 1 FROM "erp_documents__document" d WHERE d.kind='sales_orders' AND d.contact_id=${contact}
      AND (? IS NULL OR json_extract(d.body,'$.date')>=?) AND (? IS NULL OR json_extract(d.body,'$.date')<=?)
      AND (? IS NULL OR d.status IN (SELECT value FROM json_each(?))))`,
    params: [from, from, to, to, statuses === null ? null : 1, statuses === null ? null : JSON.stringify(statuses)],
  };
}