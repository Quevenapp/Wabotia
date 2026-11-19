import { one } from "../../db";
import { access, canonical, seal, sha, unseal } from "../../security";
import { ApiError, now } from "../../types";
import type { ContactPage, CustomerModuleProvider } from "../../customer/profile-contracts";
import { customerRpc, requireCustomerPerson } from "../../customer/erp-bridge";
import { customerEnabled, freshCustomerEnv, maintainErpCustomers } from "../../customer/sync";
import { erpIdentity } from "./identity";

interface PageCursor {
  scope: string; cutoff: number; last: string; keys: string[];
}
const encode = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
const cell = (v: unknown): string | number | null => typeof v === "string" || typeof v === "number" ? v : null;

export const erpCustomerProvider: CustomerModuleProvider = {
  maintain: maintainErpCustomers,
  async list(ctx, actor, contactId, collectionId, query): Promise<ContactPage> {
    requireCustomerPerson(actor);
    access(actor, ctx.profile, "contacts:read");
    if (!await customerEnabled(ctx.env, ctx.profile)) throw new ApiError(409, "module_disabled", "Cadastro completo desligado nesta área.");
    if (!["sales", "open_titles", "ledger"].includes(collectionId)) throw new ApiError(404, "not_found", "Lista não encontrada.");
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError(400, "invalid_request", "Limite inválido.");
    const contact = await one<{ erp_contact_id: string | null }>(ctx.env,
      "SELECT erp_contact_id FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active'", ctx.profile, contactId);
    if (!contact) throw new ApiError(404, "not_found", "Contato não encontrado.");
    // Sem identidade ERP: recusa mesmo quando o contato ainda é somente local.
    const identity = await erpIdentity(freshCustomerEnv(ctx.env), actor, ctx.profile);
    const scope = await sha(canonical({ profile: ctx.profile, namespace: "team", contactId, erpId: contact.erp_contact_id,
      collectionId, limit: query.limit, actor: actor.id, session: actor.sessionId ?? null, role: identity.actor?.erp_role, access: actor.access ?? null }));
    let cursor: PageCursor | null = null;
    if (query.cursor) {
      try {
        if (query.cursor.length > 60_000) throw new Error();
        cursor = await unseal(ctx.env, decode(query.cursor));
        if (!cursor || cursor.scope !== scope || !Number.isSafeInteger(cursor.cutoff) || cursor.cutoff > now() || cursor.cutoff < now() - 900_000 ||
          !Array.isArray(cursor.keys) || cursor.keys.length > 100 || typeof cursor.last !== "string") throw new Error();
      } catch { throw new ApiError(400, "invalid_cursor", "Cursor inválido ou expirado."); }
    }
    if (!contact.erp_contact_id) return { items: [], nextCursor: null, incomplete: false };
    const rpc = (name: string, args: Record<string, unknown>) => customerRpc(ctx.env, ctx.profile, actor, identity, name, args);
    // Também confere a carteira do vendedor; as consultas financeiras não têm
    // todas a mesma regra de visibilidade de contato.
    await rpc("erp_catalog_contact_get", { p_id: contact.erp_contact_id });
    const cutoff = cursor?.cutoff ?? now();
    let result: any;
    if (collectionId === "sales") result = await rpc("erp_catalog_contact_history", { p_contact_id: contact.erp_contact_id, p_kind: "sales_orders" });
    else if (collectionId === "open_titles") result = await rpc("erp_finance_contact_open_titles", { p_contact: contact.erp_contact_id, p_kind: "receivable" });
    else result = await rpc("erp_finance_contact_ledger_page", { p_contact: contact.erp_contact_id, p_scope: "all",
      p_from: new Date(cutoff - 3650 * 86400000).toISOString().slice(0, 10), p_to: new Date(cutoff).toISOString().slice(0, 10), p_page: 1, p_limit: 100 });
    if (result.visible === false) throw new ApiError(403, "forbidden", "Seu acesso não permite consultar esta lista.");
    if (!Array.isArray(result.items)) throw new ApiError(503, "dependency_unavailable", "Lista ERP indisponível.");
    const rows: ContactPage["items"] = result.items.map((row: any) => {
      const id = collectionId === "ledger" ? `${row.line_kind}:${row.ref_id}:${row.kind}:${row.day}` : String(row.id);
      const date = row.date ?? row.due_on ?? row.day;
      return { id, cells: { id: cell(row.number ?? row.ref_id ?? row.id), status: cell(row.status ?? row.situation ?? (row.overdue ? "overdue" : "open")),
        occurredAt: typeof date === "string" && Number.isFinite(Date.parse(date)) ? Date.parse(date) : null },
      target: { module: "erp", resource: collectionId === "sales" ? "sales_orders" : collectionId === "ledger" ? "contact_ledger" : "titles",
        id: collectionId === "ledger" ? contact.erp_contact_id! : String(row.id) } };
    });
    // Autoriza a fonte em TODA página. O cursor só fixa as chaves desta janela,
    // nunca congela permissões nem transporta notas/descrições financeiras.
    const keys = cursor?.keys ?? rows.map((r) => r.id);
    const available = rows.filter((r) => keys.includes(r.id) && (!cursor || r.id > cursor.last)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const items = available.slice(0, query.limit);
    const nextCursor = available.length > items.length ? encode(await seal(ctx.env, { scope, cutoff, keys, last: items.at(-1)!.id } satisfies PageCursor)) : null;
    if (!await customerEnabled(ctx.env, ctx.profile)) throw new ApiError(409, "module_disabled", "Cadastro completo desligado nesta área.");
    // A consulta comercial entrega só dez. Extrato tem janela de dez anos e
    // cem linhas; títulos entregam no máximo cinquenta. Nunca prometer totalidade.
    return { items, nextCursor, incomplete: collectionId !== "open_titles" || result.total > result.items.length };
  },
};
