import { legacyRoutineOwner } from "../agenda/customer-provider";
import { allows } from "../../access";
import { all, batch, one } from "../../db";
import { ApiError, now, type Actor } from "../../types";
import { seal, unseal } from "../../security";
import { normalizeCustomerPhone } from "../../customer/phone";
import type { CustomerModuleProvider } from "../../customer/profile-contracts";
import type { Statement } from "../../customer/contracts";
import type { ModuleContext } from "../api";
import { projectOrderForStaff } from "./privacy";
import { resolveWorkType, type WorkOrderRow } from "./public";
import { snapshotType } from "./work-types";
import { objectCustomerContribution } from "./os2-ports";

const task = "os:works:v1";
const missing = () => new ApiError(404, "not_found", "Trabalhos não encontrados.");
const invalidCursor = () => new ApiError(400, "invalid_cursor", "Cursor inválido.");

/** Confirmação explícita; nunca deduz cadastro a partir de extras ou conteúdo. */
export async function enrichConfirmedWorkCustomer(
  ctx: ModuleContext, actor: Actor, order: WorkOrderRow, value: unknown, commandId: string,
) {
  if (value === undefined) return;
  // Tipos personalizados podem representar menores ou domínios protegidos.
  if (order.type_id !== "service_order" || actor.kind !== "user" || actor.via ||
      actor.module || actor.credential || actor.id.startsWith("bot:"))
    throw new ApiError(403, "forbidden", "Confirmação cadastral não permitida neste trabalho.");
  const data = value as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      !Number.isSafeInteger(data.expectedVersion) || Number(data.expectedVersion) < 1 ||
      !(data.expectedErpVersion === null || (Number.isSafeInteger(data.expectedErpVersion) && Number(data.expectedErpVersion) > 0)) ||
      !["fill_empty", "replace_confirmed"].includes(String(data.mode)) ||
      !data.patch || typeof data.patch !== "object" || Array.isArray(data.patch) ||
      Object.keys(data.patch).some(key => !["name", "email", "document", "personType"].includes(key)))
    throw new ApiError(400, "invalid_customer_patch", "Informe somente dados administrativos confirmados e suas versões.");
  if (!order.conversation_id || !order.contact_id)
    throw new ApiError(422, "contact_required", "Vincule um contato antes de completar o cadastro.");
  const c = await ctx.conversation(order.conversation_id, actor);
  const ref = await ctx.customer(c);
  if (ref.state !== "ready" || ref.contactId !== order.contact_id)
    throw new ApiError(409, "contact_conflict", "A identidade do trabalho mudou.");
  await ctx.enrichCustomer(actor, c, {
    commandId, expectedVersion: Number(data.expectedVersion),
    expectedErpVersion: data.expectedErpVersion as number | null,
    mode: data.mode as "fill_empty" | "replace_confirmed",
    patch: data.patch as import("../../customer/contracts").CustomerPatch,
  });
}

export const workCustomerProvider: CustomerModuleProvider = {
  async list(ctx, actor, contactId, collectionId, query) {
    ctx.access(actor, "conversations:read");
    if (!allows(actor, "os")) throw new ApiError(403, "forbidden", "Sem acesso aos trabalhos.");
    await ctx.requireEnabled();
    if (collectionId === "objects") return objectCustomerContribution(ctx, actor, contactId, query);
    if (actor.kind !== "user" || actor.via || actor.module || actor.credential || actor.id.startsWith("bot:"))
      throw new ApiError(403, "forbidden", "A ficha exige uma pessoa autenticada.");
    if (collectionId !== "works") throw missing();
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
      throw new ApiError(400, "invalid_request", "Limite inválido.");
    const contact = await one<{ namespace: string }>(ctx.env,
      "SELECT namespace FROM contacts WHERE profile_id=? AND id=? AND identity_state='active'",
      ctx.profile, contactId);
    if (!contact || (contact.namespace !== "team" && !contact.namespace.startsWith("app:"))) throw missing();
    const scope = JSON.stringify(["os.works.v1", ctx.profile, contact.namespace, contactId,
      actor.id, actor.sessionId, actor.role, actor.access, actor.profiles, actor.scopes, query.limit]);
    let cut = now(), last: [number, string] | null = null;
    if (query.cursor) {
      try {
        if (query.cursor.length > 16000) throw invalidCursor();
        const saved = await unseal(ctx.env, atob(query.cursor));
        if (saved.scope !== scope || !Number.isSafeInteger(saved.cut) || saved.cut < 0 || saved.cut > cut ||
            !Array.isArray(saved.last) || saved.last.length !== 2 ||
            !Number.isSafeInteger(saved.last[0]) || saved.last[0] < 0 || saved.last[0] > saved.cut ||
            typeof saved.last[1] !== "string" || !saved.last[1]) throw invalidCursor();
        cut = saved.cut; last = saved.last;
      } catch { throw invalidCursor(); }
    }
    // Autoriza antes do LIMIT. A coleção permanece no namespace do contato.
    const rows = await all<WorkOrderRow>(ctx.env,
      `SELECT o.* FROM os_orders o WHERE o.profile_id=? AND o.contact_id=? AND o.created<=?
       AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.profile_id=o.profile_id AND c.id=o.conversation_id
         AND (CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END)<>?)
       ${last ? "AND (o.created<? OR (o.created=? AND o.id<?))" : ""}
       ORDER BY o.created DESC,o.id DESC LIMIT ?`,
      ctx.profile, contactId, cut, contact.namespace, ...(last ? [last[0], last[0], last[1]] : []), query.limit + 1);
    const page = rows.slice(0, query.limit);
    const items = [];
    for (const row of page) {
      const type = snapshotType(row) ?? await resolveWorkType(ctx, row.type_id);
      const view = projectOrderForStaff(ctx, actor, { row, type });
      // Não incluir item, relato, notas, extras nem filhos na ficha agregada.
      items.push({ id: view.id, cells: {
        id: view.display_number, status: view.stage_label || view.status_label,
        occurredAt: view.created, typeId: view.type_id, type: type.labels.singular,
      }, target: { module: "os", resource: "service-orders", id: view.id } });
    }
    const tail = page.at(-1);
    const pending = await one(ctx.env,
      `SELECT 1 FROM os_orders o LEFT JOIN conversations c ON c.id=o.conversation_id AND c.profile_id=o.profile_id
       WHERE o.profile_id=? AND o.contact_id IS NULL
       AND (CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END)=? LIMIT 1`,
      ctx.profile, contact.namespace);
    return { items, incomplete: !!pending, nextCursor: rows.length > query.limit && tail
      ? btoa(await seal(ctx.env, { scope, cut, last: [tail.created, tail.id] })) : null };
  },

  async maintain(env, profileId, budget) {
    const limit = Math.min(20, budget.remainingItems, budget.remainingStatements - 3);
    if (limit < 1) return { pending: true, statements: 0, items: 0 };
    // Sem retry implícito: cada instrução precisa caber no orçamento recebido.
    const progress = await env.DB.prepare(
      "SELECT cursor_json FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?")
      .bind(profileId, task).first<{ cursor_json: string }>();
    const after = progress ? JSON.parse(progress.cursor_json).after ?? 0 : 0;
    const { results: rows } = await env.DB.prepare(
      `SELECT o.*,c.external_namespace namespace FROM os_orders o
       LEFT JOIN conversations c ON c.profile_id=o.profile_id AND c.id=o.conversation_id
       WHERE o.profile_id=? AND (o.contact_id IS NULL OR o.conversation_id IS NULL) AND o.number>? ORDER BY o.number LIMIT ?`)
      .bind(profileId, after, limit).all<WorkOrderRow & { source: string; namespace: string | null }>();
    const statements: Statement[] = [];
    for (const row of rows) {
      const phone = normalizeCustomerPhone(row.phone, "international");
      // Sem inferir namespace de aplicações ou de uma conversa removida.
      if (!phone || (row.conversation_id ? !row.namespace || row.namespace.startsWith("app:") : !row.contact_id && row.source !== "panel")) continue;
      statements.push([
        // Materializa a prova uma vez na própria escrita: aninhá-la novamente
        // na seleção da conversa excede a profundidade de expressão do D1.
        `WITH owner AS MATERIALIZED (
          SELECT coalesce(contact_id,${legacyRoutineOwner("os_orders", "phone", "os")}) contact_id
          FROM os_orders WHERE profile_id=? AND id=?
        )
        UPDATE os_orders SET contact_id=(SELECT contact_id FROM owner),
          conversation_id=coalesce(conversation_id,(SELECT c.id FROM conversations c
            JOIN customer_phones p ON p.profile_id=c.profile_id AND p.namespace='team' AND p.phone=c.verified_phone AND p.state='ready'
            JOIN contacts k ON k.profile_id=p.profile_id AND k.id=p.contact_id AND k.namespace='team' AND k.identity_state='active'
            LEFT JOIN conversation_contacts l ON l.profile_id=c.profile_id AND l.conversation_id=c.id
            WHERE c.profile_id=os_orders.profile_id AND c.chat_type<>'group' AND c.customer_link_state='ready'
              AND c.external_namespace='channel:'||c.connection_id AND c.verified_phone=?
              AND p.contact_id=(SELECT contact_id FROM owner)
              AND (l.contact_id IS NULL OR l.contact_id=p.contact_id)
            ORDER BY c.last_customer DESC,c.id LIMIT 1))
          WHERE profile_id=? AND id=? AND contact_id IS ? AND phone=? AND conversation_id IS ? AND row_version=?`,
        [profileId, row.id, phone, profileId, row.id, row.contact_id, row.phone, row.conversation_id, row.row_version],
      ]);
    }
    // Atualizações e checkpoint juntos: queda não pula registros; repetição não
    // reaponta vínculos preenchidos. Pendências voltam na próxima varredura.
    statements.push([
      `INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
       VALUES(?,'team',?,?,?,?) ON CONFLICT(profile_id,namespace,task)
       DO UPDATE SET cursor_json=excluded.cursor_json,complete=excluded.complete,updated=excluded.updated`,
      [profileId, task, JSON.stringify({ after: rows.length === limit ? rows.at(-1)!.number : 0 }), Number(!rows.length && !after), now()],
    ]);
    await batch(env, statements);
    return { pending: rows.length > 0 || after > 0, statements: statements.length + 2, items: rows.length };
  },
};
