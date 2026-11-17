// Leituras do espelho do Origin nas leituras do Documentos (sessão L), portadas
// como leitura (ERP-PORTE.md, "Origin fora não é sem efeito"): sem documento
// espelhado elas devolvem o mesmo que a antiga constante; com ele, o harness
// compara (tests/erp/harness/origin-seed.test.mjs).
// - erp_document_mirror.report_coverage: quantos documentos espelhados o
//   relatório deixou de fora (a cobertura é só dos efeitos nativos);
// - o que a lista e a exportação leem de erp_documents.origin_mirror (número e
//   total da fonte, busca pela fonte).
// As guardas (require_visible, guard_*), visible, metadata e detail são da O
// (documents/mirror.ts e reads-g.ts).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { arrow, jsonbText } from "../../engine/json.ts";
import { pgLower } from "../../engine/text.ts";
import { permitted } from "../access/public.ts";
import { contactScope } from "../catalog/public.ts";
import { allowed, osPermitted } from "./public.ts";

const MODULE: Record<string, string> = {
  sales_orders: "vendas.pedidos_venda",
  sales_proposals: "vendas.propostas",
  purchase_orders: "suprimentos.pedidos_compra",
};
const KINDS = ["sales_orders", "sales_proposals", "purchase_orders", "service_orders"];

/**
 * erp_document_mirror.report_coverage(usuário, tipo, de, até, contato): os documentos
 * espelhados (não apagados na fonte) dos tipos que o usuário lê, no escopo de
 * vendedor dele, no período (texto da data do corpo) e do contato.
 */
export function reportCoverage(
  db: SqlDriver,
  user: string | null,
  kind: string | null,
  from: string | null = null,
  to: string | null = null,
  contact: string | null = null,
) {
  let count = 0;
  const reader = user === null ? undefined : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (reader) {
    const role = reader.role === null ? null : String(reader.role);
    const scope = contactScope(db, user);
    const kinds = KINDS.filter(
      (k) =>
        (kind === null || k === kind) &&
        allowed(role, k, false) &&
        (k === "service_orders" ? osPermitted(db, user!, null) : permitted(db, user!, MODULE[k])),
    );
    for (const d of db.exec(
      `SELECT d.kind, d.contact_id, d.body, cp.seller_id FROM "erp_documents__document" d
         JOIN "erp_documents__origin_mirror" m ON m.document_id=d.id
         LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=d.contact_id
        WHERE m.source_deleted=0`,
    ).rows) {
      if (!kinds.includes(String(d.kind))) continue;
      if (scope !== null && d.seller_id !== scope) continue;
      if (contact !== null && d.contact_id !== contact) continue;
      const date = arrow(JSON.parse(String(d.body)), "date");
      // d.body->>'date' >= p_from: texto, collation C; data nula não passa.
      if (from !== null && (date === null || date < from)) continue;
      if (to !== null && (date === null || date > to)) continue;
      count++;
    }
  }
  return { origin: "brufap", mirror_excluded_count: count, coverage: { partial: count > 0, reason: "native_effects_only" } };
}

export interface MirrorSource {
  source_id: string | null;
  source_number: string | null;
  source_status: string | null;
  source_status_label: string | null;
  /** reconciliation->>'source_total' */
  source_total: string | null;
}

/** A linha de erp_documents.origin_mirror do documento (o que a lista e a exportação leem da fonte). */
export function mirrorSource(db: SqlDriver, document: string): MirrorSource | null {
  const m = one(
    db,
    'SELECT source_id, source_number, source_status, source_status_label, reconciliation FROM "erp_documents__origin_mirror" WHERE document_id=?',
    document,
  );
  if (!m) return null;
  const rec = m.reconciliation === null ? null : (JSON.parse(String(m.reconciliation)) as Record<string, unknown>);
  const total = rec === null || typeof rec !== "object" || Array.isArray(rec) ? undefined : rec.source_total;
  return {
    source_id: m.source_id === null ? null : String(m.source_id),
    source_number: m.source_number === null ? null : String(m.source_number),
    source_status: m.source_status === null ? null : String(m.source_status),
    source_status_label: m.source_status_label === null ? null : String(m.source_status_label),
    source_total: total === undefined || total === null ? null : typeof total === "string" ? total : jsonbText(total),
  };
}

/**
 * A busca da lista pela fonte: source_id ou source_status iguais à busca, ou a
 * busca dentro do número ou do rótulo da situação na fonte (minúsculas).
 */
export function mirrorSourceMatches(source: MirrorSource | null, query: string): boolean {
  if (source === null) return false;
  return (
    source.source_id === query ||
    source.source_status === query ||
    pgLower(source.source_number ?? "").includes(query) ||
    pgLower(source.source_status_label ?? "").includes(query)
  );
}
