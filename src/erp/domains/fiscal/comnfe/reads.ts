import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { containsRestrictedContact } from "../../../engine/identity.ts";
import type { RpcContext } from "../../../engine/registry.ts";
import type { CommercialNfeSlots, EmissionPage, EmissionView, ListInput, ReadInput } from "../../../commercial-nfe/contracts.ts";
import { contactScope, contactVisibleTo } from "../../catalog/contact.ts";
import { requireCom1Access } from "./access.ts";
import { COM1_TABLES as T, com1Uuid, getEmissionView } from "./store.ts";

/** Extensão de transporte interno. O HTTP projeta o DTO e jamais publica XML
 * junto ao JSON; a rota de arquivo usa somente este arquivo já arquivado. */
export interface StoredEmissionRead extends EmissionView { cancellation_xml: string | null }

export function requireCommercialReadParts(ctx: RpcContext): void {
  if (!ctx.parts.customers || !ctx.parts.fiscal) raise("55000", "module_disabled");
}

/** Vale também antes de claim: conhecer o UUID do pedido não abre seu cofre. */
export function requireCommercialEmissionVisible(ctx: RpcContext, view: EmissionView): void {
  const document = one(ctx.db, "SELECT body FROM erp_documents__document WHERE id=?", view.document_id);
  const body = document ? JSON.parse(String(document.body)) as Record<string, unknown> : null;
  const restricted = new Set(ctx.identity.customer_privacy?.restricted_contact_ids ?? []);
  const contact = typeof body?.contact_id === "string" ? body.contact_id : null;
  if (!document || containsRestrictedContact(view, restricted) || containsRestrictedContact(body, restricted) ||
      !contactVisibleTo(ctx.db, contactScope(ctx.db, ctx.identity.actor?.user_id ?? null), contact))
    raise("P0002", "com1_emission_not_found");
}

export function readCommercialEmission(ctx: RpcContext, input: ReadInput): StoredEmissionRead {
  requireCom1Access(ctx, "read");
  requireCommercialReadParts(ctx);
  com1Uuid(input.emission_id);
  const view = getEmissionView(ctx, input.emission_id);
  requireCommercialEmissionVisible(ctx, view);
  const event = one(ctx.db, `SELECT xml FROM ${T.cancel} WHERE emission_id=? AND xml_status='disponivel'`, view.id);
  return { ...view, cancellation_xml: event?.xml == null ? null : String(event.xml) };
}

export function listCommercialEmissions(ctx: RpcContext, input: ListInput): EmissionPage {
  requireCom1Access(ctx, "read");
  requireCommercialReadParts(ctx);
  if (!["homologacao", "producao"].includes(input.environment)) raise("22023", "com1_environment_required");
  if (input.document_id !== undefined) com1Uuid(input.document_id);
  if (input.status !== undefined && !["bloqueada", "preparada", "enviando", "processando", "incerta", "rejeitada", "autorizada", "denegada", "cancelada", "arquivada"].includes(input.status))
    raise("22023", "com1_status_invalid");
  const page = input.page ?? 1, per = input.per_page ?? 50;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(per) || per < 1 || per > 100 || !Number.isSafeInteger((page - 1) * per))
    raise("22023", "com1_invalid_page");
  const filters = ["e.environment=?"], values: unknown[] = [input.environment];
  if (input.document_id) { filters.push("e.document_id=?"); values.push(input.document_id); }
  if (input.status) { filters.push("e.status=?"); values.push(input.status); }
  const restricted = ctx.identity.customer_privacy?.restricted_contact_ids ?? [];
  if (restricted.length) {
    // O filtro precede COUNT/LIMIT: nem total, nem páginas vazias revelam
    // emissões de contatos restritos. Inclui referências em snapshots antigos.
    filters.push(`NOT EXISTS (SELECT 1 FROM json_each(?) p WHERE
      instr(lower(r.snapshot || r.tax_sources || COALESCE(r.body,'') || r.calculation || d.body || e.messages),lower(p.value))>0
      OR EXISTS (SELECT 1 FROM ${T.effect} f WHERE f.emission_id=e.id AND instr(lower(f.ids || COALESCE(f.result,'') || COALESCE(f.compensation_result,'')),lower(p.value))>0)
      OR EXISTS (SELECT 1 FROM ${T.cancel} c WHERE c.emission_id=e.id AND instr(lower(c.justification || c.messages),lower(p.value))>0))`);
    values.push(JSON.stringify(restricted));
  }
  const scope = contactScope(ctx.db, ctx.identity.actor?.user_id ?? null);
  if (scope !== null) {
    filters.push("EXISTS (SELECT 1 FROM erp_catalog__contact_profile cp WHERE cp.record_id=json_extract(d.body,'$.contact_id') AND cp.seller_id=?)");
    values.push(scope);
  }
  const from = `FROM ${T.emission} e JOIN ${T.revision} r ON r.emission_id=e.id AND r.body_revision=e.current_body_revision
    JOIN erp_documents__document d ON d.id=e.document_id WHERE ${filters.join(" AND ")}`;
  const total = Number(one(ctx.db, `SELECT count(*) n ${from}`, ...values)!.n);
  const rows = ctx.db.exec(`SELECT e.id ${from} ORDER BY e.updated_at DESC,e.id LIMIT ? OFFSET ?`, ...values, per, (page - 1) * per).rows;
  const items = rows.map(row => getEmissionView(ctx, String(row.id)));
  return { items, page, per_page: per, total };
}

export const commercialNfeReadSlots: Pick<CommercialNfeSlots, "read" | "list"> = {
  read: readCommercialEmission, list: listCommercialEmissions,
};
