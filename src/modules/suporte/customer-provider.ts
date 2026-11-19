import { all, batch, one } from "../../db";
import { ApiError, type Conversation } from "../../types";
import { customerRecordStatements } from "../../customer/ports";
import type { Statement } from "../../customer/contracts";
import type { CustomerModuleProvider } from "../../customer/profile-contracts";
import type { ModuleContext } from "../api";
import { customerCollection, progressStatement } from "../mensalidade/customer-provider";

export type SupportCustomerKind = "sessions" | "purchases" | "releases";
export const supportSessionKey = (conversationId: string, sessionId: string) => `${conversationId}:${sessionId}`;

/** A sessão preserva quem conversava naquele momento, mesmo após nova associação. */
export async function supportCustomerStatements(
  ctx: ModuleContext, c: Conversation, kind: SupportCustomerKind,
  id: string, at: number, linkedBy: string, sessionId?: string | null,
): Promise<Statement[]> {
  if (c.profile_id !== ctx.profile) throw new ApiError(404, "not_found", "Conversa não encontrada.");
  if (c.chat_type === "group" || c.external_namespace.startsWith("app:")) return [];
  let contactId: string | null = null;
  if (sessionId) {
    // Nunca troca o interlocutor histórico pelo titular de payer_id ou por
    // documento digitado. A compra confirma a intenção do interlocutor.
    const link = await one(ctx.env, `SELECT l.contact_id FROM customer_records l
      JOIN suporte_sessions s ON s.profile_id=l.profile_id AND l.record_id=s.conversation_id||':'||s.id
      JOIN contacts t ON t.id=l.contact_id AND t.profile_id=l.profile_id AND t.namespace='team' AND t.identity_state='active'
      WHERE l.profile_id=? AND l.module_id='suporte' AND l.kind='sessions' AND s.id=? AND s.conversation_id=?`,
    ctx.profile, sessionId, c.id);
    contactId = link?.contact_id ?? null;
  } else {
    const ref = await ctx.customer(c);
    if (ref.profileId === ctx.profile && ref.namespace === "team" && ref.state === "ready") contactId = ref.contactId;
  }
  if (!contactId) return [];
  const guard = `support-customer:${ctx.profile}:${kind}:${id}`;
  const links = customerRecordStatements({ profileId: ctx.profile, contactId, moduleId: "suporte", kind,
    recordId: kind === "sessions" ? supportSessionKey(c.id, id) : id,
    conversationId: c.id, linkedBy, occurredAt: at });
  // O INSERT da origem deve vir antes destas instruções no mesmo lote.
  // Se outra tentativa ganhou a source_key, não deixar um vínculo órfão.
  return [
    [`INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN EXISTS(
      SELECT 1 FROM ${sources[kind]} r JOIN contacts t ON t.profile_id=r.profile_id
      WHERE r.profile_id=? AND r.id=? AND r.conversation_id=?
        AND t.id=? AND t.namespace='team' AND t.identity_state='active'
    ) THEN 1 ELSE 0 END)`, [guard, ctx.profile, id, c.id, contactId]],
    ...links,
    ["DELETE FROM customer_assert WHERE id=?", [guard]],
  ];
}

const sources = {
  sessions: "suporte_sessions", purchases: "suporte_purchases", releases: "suporte_releases",
} as const;

export const suporteCustomerProvider: CustomerModuleProvider = {
  async list(ctx, actor, contactId, collectionId, query) {
    if (!Object.hasOwn(sources, collectionId)) throw new ApiError(404, "not_found", "Coleção não encontrada.");
    const kind = collectionId as SupportCustomerKind, table = sources[kind];
    const key = kind === "sessions" ? "r.conversation_id||':'||r.id" : "r.id";
    return customerCollection(ctx, actor, contactId, "suporte", kind, query, {
      from: `${table} r JOIN customer_records l ON l.profile_id=r.profile_id AND l.module_id='suporte' AND l.kind='${kind}' AND l.record_id=${key}`,
      where: "l.contact_id=?", args: [contactId],
      cells: () => ({ relation: kind === "purchases" ? "Comprador" : "Interlocutor" }),
      incomplete: `SELECT 1 FROM ${table} r WHERE r.profile_id=? AND NOT EXISTS(
        SELECT 1 FROM customer_records l WHERE l.profile_id=r.profile_id AND l.module_id='suporte' AND l.kind='${kind}' AND l.record_id=${key}) LIMIT 1`,
      incompleteArgs: [ctx.profile],
    });
  },
  async maintain(env, profileId, budget) {
    // 2 leituras + até 3 comandos por vínculo + checkpoint no mesmo lote.
    const limit = Math.min(20, budget.remainingItems, Math.floor((budget.remainingStatements - 3) / 3));
    if (limit < 1) return { pending: true, statements: 0, items: 0 };
    const progress = await one(env, "SELECT cursor_json,complete FROM customer_progress WHERE profile_id=? AND namespace='team' AND task='suporte.records.v1'", profileId);
    const cursor = progress && !progress.complete ? JSON.parse(progress.cursor_json).id ?? "" : "";
    // Legado: vínculo humano criado antes da origem é evidência histórica.
    // Uma associação posterior da conversa não reclassifica atendimentos.
    // Compras/liberações herdam apenas o vínculo já persistido da sessão.
    const rows = await all(env, `SELECT r.*,t.id AS contact_id FROM (
        SELECT 'purchases:'||id AS scan_id,'purchases' AS kind,id,profile_id,conversation_id,session_id,created FROM suporte_purchases
        UNION ALL SELECT 'releases:'||id,'releases',id,profile_id,conversation_id,session_id,created FROM suporte_releases
        UNION ALL SELECT 'sessions:'||id,'sessions',id,profile_id,conversation_id,NULL,created FROM suporte_sessions
      ) r LEFT JOIN customer_records l ON l.profile_id=r.profile_id AND l.module_id='suporte'
        AND l.kind='sessions' AND l.record_id=r.conversation_id||':'||r.session_id
      LEFT JOIN conversation_contacts legacy ON r.kind='sessions' AND legacy.profile_id=r.profile_id
        AND legacy.conversation_id=r.conversation_id AND legacy.created<=r.created
        AND EXISTS(SELECT 1 FROM users u WHERE u.id=legacy.linked_by)
      LEFT JOIN contacts t ON t.id=CASE WHEN r.kind='sessions' THEN legacy.contact_id ELSE l.contact_id END
        AND t.profile_id=r.profile_id AND t.namespace='team' AND t.identity_state='active'
      JOIN conversations c ON c.profile_id=r.profile_id AND c.id=r.conversation_id
        AND c.external_namespace NOT LIKE 'app:%' AND c.chat_type<>'group'
      WHERE r.profile_id=? AND r.scan_id>? AND NOT EXISTS(
        SELECT 1 FROM customer_records old WHERE old.profile_id=r.profile_id AND old.module_id='suporte'
        AND old.kind=r.kind AND old.record_id=CASE WHEN r.kind='sessions' THEN r.conversation_id||':'||r.id ELSE r.id END)
      ORDER BY r.scan_id LIMIT ?`, profileId, cursor, limit);
    const statements: Statement[] = [];
    for (const row of rows) {
      // Sessões legadas sem prova humana anterior continuam pendentes;
      // telefones e documentos não participam desta decisão.
      if (!row.contact_id) continue;
      statements.push(...customerRecordStatements({ profileId, contactId: row.contact_id,
        moduleId: "suporte", kind: row.kind,
        recordId: row.kind === "sessions" ? supportSessionKey(row.conversation_id, row.id) : row.id,
        conversationId: row.conversation_id,
        linkedBy: row.kind === "sessions" ? "backfill:legacy-human" : "backfill:suporte-session", occurredAt: row.created }));
    }
    statements.push(progressStatement(profileId, "suporte.records.v1", rows.at(-1)?.scan_id ?? cursor, rows.length < limit));
    await batch(env, statements);
    return { pending: rows.length > 0 || cursor !== "", statements: 2 + statements.length, items: rows.length };
  },
};
