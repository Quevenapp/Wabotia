// OS6: a ordem de serviço antiga do ERP com o módulo Ordem de Serviço ligado
// (docs/ORDEM-DE-SERVICO.md, "Ordens antigas do ERP"). No ERP ela fica só
// leitura; aqui a pessoa traz uma por vez para uma ordem nova, com prévia:
// cliente, itens e situação são copiados; as duas ficam ligadas e a antiga
// fica marcada como migrada (os_order_links, migração 0191). Só leitura do
// ERP (erp_document_get); nada é gravado no ERP.
import { all, batch, one } from "../../db";
import { ApiError, type Actor, now, uid } from "../../types";
import type { ModuleContext } from "../api";
import type { ErpLegacyPreview } from "./contracts";
import { humanReferenceRpc } from "../../integrations/policy";
import { createOrder, loadOrder, saveQuote } from "./store";
import { resolveWorkType } from "./public";
import { lineGross, QUOTE_ITEMS_LIMIT } from "./model";
import { effectiveStage, snapshotType, workOrderAdditions } from "./work-types";

const STATUS_LABELS: Record<string, string> = {
  open: "Em aberto", quoted: "Orçada", approved: "Aprovada", rejected: "Recusada", in_progress: "Em andamento",
  service_done: "Serviço concluído", finalized: "Finalizada", cancelled: "Cancelada",
};
/** Encerradas ficam no ERP para consulta. */
const CLOSED = ["finalized", "cancelled", "rejected"];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const clip = (value: unknown, max: number) => Array.from(String(value ?? "").trim()).slice(0, max).join("");
const cents = (value: unknown) => {
  const match = /^(-?\d+)(?:[.,](\d{1,6}))?$/.exec(String(value ?? "0").trim());
  if (!match) return 0;
  return Math.round(Number(`${match[1]}.${match[2] ?? "0"}`) * 100);
};

async function readDocument(ctx: ModuleContext, actor: Actor, documentId: string) {
  if (!UUID.test(documentId)) throw new ApiError(400, "invalid_request", "Documento do ERP inválido.");
  if (actor.kind !== "user" || actor.via || actor.module || actor.credential || actor.id.startsWith("bot:"))
    throw new ApiError(403, "forbidden", "Trazer ordem antiga do ERP é feito por uma pessoa da equipe no painel.");
  let response: any;
  try { response = await humanReferenceRpc(ctx.env, actor, ctx.profile, "erp_document_get", { p_kind: "service_orders", p_id: documentId }); }
  catch (error: any) {
    if (error?.code === "part_disabled") throw new ApiError(409, "module_disabled", "O ERP está desligado nesta área. Um administrador pode ligá-lo em Gestão → Módulos.");
    if (error?.status === 403 || error?.code === "forbidden") throw new ApiError(403, "forbidden", "Seu perfil no ERP não lê ordens de serviço. Peça acesso a um administrador.");
    throw new ApiError(404, "not_found", "Ordem de serviço do ERP não encontrada (ou sem acesso para você).");
  }
  const document = response?.document;
  if (!document || document.kind !== "service_orders") throw new ApiError(404, "not_found", "Ordem de serviço do ERP não encontrada.");
  return document;
}

async function previewOf(ctx: ModuleContext, actor: Actor, documentId: string): Promise<ErpLegacyPreview & { phone: string | null }> {
  const document = await readDocument(ctx, actor, documentId);
  const status = String(document.status ?? "open");
  const contactId = typeof document.contact_id === "string" ? document.contact_id : null;
  const contact = contactId ? await one(ctx.env, "SELECT id,name,phone FROM contacts WHERE profile_id=? AND erp_contact_id=? AND namespace='team' AND identity_state='active'", ctx.profile, contactId) : null;
  const items = (Array.isArray(document.items) ? document.items : []).filter((i: any) => i && clip(i.description, 200)).slice(0, QUOTE_ITEMS_LIMIT)
    .map((i: any) => {
      const quantity = Math.min(999, Math.round((Number(String(i.quantity ?? "1").replace(",", ".")) || 1) * 1e6) / 1e6);
      const unit = clip(i.unit, 12);
      return { description: clip(i.description, 200), quantity: quantity > 0 ? quantity : 1,
        unit_cents: Math.min(100_000_000, Math.max(0, cents(i.unit_price))), unit: /^[A-Za-z0-9²³%./_-]{1,12}$/.test(unit) ? unit : "UN" };
    });
  const linkedRow = await one(ctx.env, `SELECT 1 FROM module_erp_sources s, json_each(s.links_json) j WHERE s.profile_id=?
    AND json_extract(j.value,'$.kind')='document' AND json_extract(j.value,'$.id')=?`, ctx.profile, documentId);
  const migratedRow = await one(ctx.env, "SELECT order_id FROM os_order_links WHERE profile_id=? AND kind='erp_document' AND other_id=?", ctx.profile, documentId);
  let migrated: ErpLegacyPreview["migrated"] = null;
  if (migratedRow) {
    const order = await loadOrder(ctx, migratedRow.order_id).catch(() => null);
    migrated = { order_id: migratedRow.order_id, display_number: order ? workOrderAdditions(order).display_number : "" };
  }
  const blockers: string[] = [];
  if (linkedRow) blockers.push("Esta ordem do ERP já veio do módulo Ordem de Serviço: abra a ordem correspondente pelo aviso no ERP.");
  if (migrated) blockers.push(`Esta ordem do ERP já foi trazida para a ordem ${migrated.display_number}.`);
  if (CLOSED.includes(status)) blockers.push(`No ERP ela está "${STATUS_LABELS[status] ?? status}": ordens encerradas ficam no ERP só para consulta.`);
  if (!contact) blockers.push(contactId
    ? "O cliente desta ordem não está no cadastro de clientes da área. Abra o cliente no cadastro e tente de novo."
    : "Esta ordem do ERP não tem cliente. Informe o cliente no ERP antes de trazer.");
  else if (!contact.phone) blockers.push(`O cliente ${contact.name} não tem telefone no cadastro. Cadastre o telefone e tente de novo.`);
  const item = clip(document.equipment, 200) || `Ordem do ERP nº ${document.number ?? ""}`.trim();
  const problem = clip(document.defect, 2000) || clip(document.notes, 2000) || "Trazida da ordem de serviço do ERP.";
  return {
    document_id: documentId, number: document.number == null ? null : String(document.number), status, status_label: STATUS_LABELS[status] ?? status,
    date: typeof document.date === "string" ? document.date : null,
    customer: { contact_id: contact?.id ?? null, name: contact?.name ?? document.contact_snapshot?.name ?? null, found: !!contact },
    item, problem, items, total_cents: items.reduce((sum: number, i: { quantity: number; unit_cents: number }) => sum + lineGross(i), 0),
    migrated, can_import: !blockers.length, blockers, phone: contact?.phone ?? null,
  };
}

/** GET service-orders/erp-legacy/:document_id */
export async function erpLegacyPreview(ctx: ModuleContext, actor: Actor, documentId: string): Promise<ErpLegacyPreview> {
  ctx.access(actor, "conversations:write");
  await ctx.requireEnabled();
  const { phone: _phone, ...view } = await previewOf(ctx, actor, documentId);
  return view;
}

/** POST service-orders/erp-legacy/:document_id/import */
export async function importErpLegacy(ctx: ModuleContext, actor: Actor, documentId: string, data: { type_id?: unknown }) {
  ctx.access(actor, "conversations:write");
  await ctx.requireEnabled();
  const preview = await previewOf(ctx, actor, documentId);
  if (preview.migrated) return loadOrder(ctx, preview.migrated.order_id);
  if (!preview.can_import) throw new ApiError(409, "erp_legacy_blocked", preview.blockers.join(" "));
  const type = await resolveWorkType(ctx, typeof data.type_id === "string" && data.type_id ? data.type_id : undefined);
  if (type.object_type_id) throw new ApiError(409, "object_required", "Este modelo pede o objeto do serviço. Escolha um modelo sem objeto ou abra a ordem pelo painel.");
  const situation = `Trazida da ordem de serviço nº ${preview.number ?? "?"} do ERP (situação no ERP: ${preview.status_label}).`;
  const { order } = await createOrder(ctx, {
    type_id: type.id, authority: actor, customer_name: preview.customer.name ?? undefined, phone: preview.phone ?? undefined,
    item: preview.item, problem: preview.problem, notes: situation, source: "panel", sourceKey: `erp-legacy:${documentId}`,
    actor: actor.id, notify: false,
  });
  const at = now();
  await batch(ctx.env, [
    ["INSERT OR IGNORE INTO os_order_links(profile_id,order_id,kind,other_id,reason,actor,created) VALUES(?,?,'erp_document',?,?,?,?)", [ctx.profile, order.id, documentId, situation, actor.id, at]],
    ["INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,'edit',status,status,?,?,? FROM os_orders WHERE profile_id=? AND id=?",
      [uid(), ctx.profile, order.id, actor.id, situation, at, ctx.profile, order.id]],
  ]);
  const fresh = await loadOrder(ctx, order.id);
  const custom = snapshotType(fresh), policy = custom?.features.quote;
  if (!preview.items.length || (custom && (!policy || !policy.source_stages.includes(effectiveStage(fresh))))) return fresh;
  return saveQuote(ctx, fresh, { items: preview.items }, actor.id, `erp-legacy-quote:${documentId}`, { notify: false, human: true });
}

/** Ligações da ordem (reaberta, trazida do ERP) para o detalhe. */
export async function orderLinks(ctx: ModuleContext, id: string) {
  return all(ctx.env, "SELECT kind,other_id,reason,created FROM os_order_links WHERE profile_id=? AND order_id=? ORDER BY created", ctx.profile, id);
}
