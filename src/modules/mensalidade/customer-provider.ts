// A ficha distingue titular do pagamento e interlocutor. Nenhuma consulta
// deste provedor usa telefone como identidade ou chama o motor ERP.
import { all, batch, one } from "../../db";
import { allows } from "../../access";
import { seal, unseal } from "../../security";
import { ApiError, type Actor, now } from "../../types";
import type { Statement } from "../../customer/contracts";
import type { ContactPage, CustomerModuleProvider } from "../../customer/profile-contracts";
import type { ModuleContext } from "../api";
import { requireModule } from "../registry";
import { parseDocument } from "./model";

/** Documento apenas associa cadastros; não autoriza o telefone nem confirma o pagador. */
export function payerDocumentStatement(profile: string, id: string, document: unknown): Statement[] {
  const doc = parseDocument(document);
  if (!doc) return [];
  return [[`UPDATE mensalidade_payers SET contact_id=(
    SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND document=? AND identity_state='active'
  ) WHERE profile_id=? AND id=? AND contact_id IS NULL AND document=?
    AND (SELECT count(*) FROM contacts WHERE profile_id=? AND namespace='team' AND document=?)=1`,
  [profile, doc.document, profile, id, doc.document, profile, doc.document]]];
}

/** Escolha explícita da equipe, sem transferir um vínculo já existente. */
export async function payerChoice(
  ctx: ModuleContext, contactId: unknown, actor?: Actor,
): Promise<string> {
  if (!actor || actor.kind !== "user" || actor.id.startsWith("bot:") ||
      !allows(actor, "contacts") || !allows(actor, "mensalidade"))
    throw new ApiError(403, "forbidden", "Somente uma pessoa autorizada pode escolher o contato do pagador.");
  ctx.access(actor, "contacts:write");
  const contact = typeof contactId === "string" && await one(ctx.env,
    "SELECT id FROM contacts WHERE id=? AND profile_id=? AND namespace='team' AND identity_state='active'",
    contactId, ctx.profile);
  if (!contact) throw new ApiError(404, "not_found", "Contato não encontrado.");
  return contact.id;
}

export function payerChoiceStatements(profile: string, id: string, contactId: string): Statement[] {
  const guard = `payer-contact:${profile}:${id}:${contactId}`;
  return [
    [`UPDATE mensalidade_payers SET contact_id=? WHERE profile_id=? AND id=? AND (contact_id IS NULL OR contact_id=?)
      AND EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND namespace='team' AND id=? AND identity_state='active')`,
    [contactId, profile, id, contactId, profile, contactId]],
    ["INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)", [guard]],
    ["DELETE FROM customer_assert WHERE id=?", [guard]],
  ];
}

// Compartilhado com Suporte: o cursor cifrado autentica todo o escopo e o
// corte temporal. As fontes e os predicados abaixo são constantes internas.
export async function customerCollection(
  ctx: ModuleContext, actor: Actor, contactId: string, moduleId: string,
  collectionId: string, query: { limit: number; cursor?: string },
  source: {
    from: string; where: string; args: unknown[]; incomplete: string; incompleteArgs: unknown[];
    select?: string; cells?: (row: any) => ContactPage["items"][number]["cells"];
  },
): Promise<ContactPage> {
  if (actor.kind !== "user" || actor.via || actor.module || actor.credential || actor.id.startsWith("bot:") ||
      !allows(actor, moduleId))
    throw new ApiError(403, "forbidden", "Sem acesso a esta coleção do cliente.");
  ctx.access(actor, "conversations:read");
  await requireModule(ctx.env, ctx.profile, moduleId);
  if (!await one(ctx.env, "SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND id=? AND identity_state='active'", ctx.profile, contactId))
    throw new ApiError(404, "not_found", "Contato não encontrado.");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
    throw new ApiError(400, "invalid_request", "Limite inválido.");
  const scope = JSON.stringify([1, ctx.profile, "team", contactId, moduleId, collectionId, actor.id, "all"]);
  let cut = now(), last: { at: number; id: string } | null = null;
  if (query.cursor) {
    try {
      const cursor = await unseal(ctx.env, query.cursor);
      if (cursor.scope !== scope || !Number.isSafeInteger(cursor.cut) || cursor.cut < 0 ||
          cursor.cut > cut || !Number.isSafeInteger(cursor.last?.at) || cursor.last.at < 0 || cursor.last.at > cursor.cut ||
          typeof cursor.last.id !== "string" || !cursor.last.id)
        throw new Error("cursor");
      cut = cursor.cut; last = cursor.last;
    } catch {
      throw new ApiError(400, "invalid_cursor", "Cursor inválido para esta coleção.");
    }
  }
  const rows = await all(ctx.env, `SELECT r.id,r.status,r.created${source.select ? `,${source.select}` : ""} FROM ${source.from}
    WHERE r.profile_id=? AND ${source.where} AND r.created<=?
    ${last ? "AND (r.created<? OR (r.created=? AND r.id<?))" : ""}
    ORDER BY r.created DESC,r.id DESC LIMIT ?`,
    ctx.profile, ...source.args, cut, ...(last ? [last.at, last.at, last.id] : []), query.limit + 1);
  const page = rows.slice(0, query.limit);
  const tail = page.at(-1);
  const incomplete = !!await one(ctx.env, source.incomplete, ...source.incompleteArgs);
  return {
    items: page.map((r) => ({ id: r.id, cells: { id: r.id, status: r.status, occurredAt: r.created, ...source.cells?.(r) },
      target: { module: moduleId, resource: collectionId, id: r.id } })),
    nextCursor: rows.length > query.limit && tail
      ? await seal(ctx.env, { scope, cut, last: { at: tail.created, id: tail.id } }) : null,
    incomplete,
  };
}

export const mensalidadeCustomerProvider: CustomerModuleProvider = {
  async list(ctx, actor, contactId, collectionId, query) {
    if (collectionId !== "subscriptions" && collectionId !== "installments")
      throw new ApiError(404, "not_found", "Coleção não encontrada.");
    const subscriptions = collectionId === "subscriptions";
    // Assinatura aponta o interlocutor; o pagador tem seu próprio contact_id.
    // A ficha da equipe pode mostrar ambas as relações, sem autorizar o chat.
    return customerCollection(ctx, actor, contactId, "mensalidade", collectionId, query, {
      from: subscriptions
        ? "mensalidade_subscriptions r LEFT JOIN mensalidade_payers p ON p.id=r.payer_id AND p.profile_id=r.profile_id"
        : "mensalidade_installments r JOIN mensalidade_subscriptions s ON s.id=r.subscription_id AND s.profile_id=r.profile_id LEFT JOIN mensalidade_payers p ON p.id=s.payer_id AND p.profile_id=s.profile_id",
      where: subscriptions ? "(r.contact_id=? OR p.contact_id=?)" : "(s.contact_id=? OR p.contact_id=?)",
      args: [contactId, contactId],
      select: `${subscriptions ? "r" : "s"}.contact_id AS interlocutor_id,p.contact_id AS payer_contact_id`,
      cells: (row) => ({ relation: row.payer_contact_id === contactId
        ? (row.interlocutor_id === contactId ? "Pagador e interlocutor" : "Pagador") : "Interlocutor" }),
      incomplete: `SELECT 1 FROM mensalidade_payers WHERE profile_id=? AND contact_id IS NULL
        UNION ALL SELECT 1 FROM mensalidade_subscriptions WHERE profile_id=? AND contact_id IS NULL LIMIT 1`,
      incompleteArgs: [ctx.profile, ctx.profile],
    });
  },
  async maintain(env, profileId, budget) {
    // Leitura do checkpoint + página + checkpoint escrito; cada item pode
    // gastar mais uma instrução. Nunca excede o saldo compartilhado.
    const limit = Math.min(10, budget.remainingItems, budget.remainingStatements - 3);
    if (limit < 1) return { pending: true, statements: 0, items: 0 };
    const progress = await one(env, "SELECT cursor_json,complete FROM customer_progress WHERE profile_id=? AND namespace='team' AND task='mensalidade.payers.v1'", profileId);
    const cursor = progress && !progress.complete ? JSON.parse(progress.cursor_json).id ?? "" : "";
    const rows = await all(env, "SELECT id,document FROM mensalidade_payers WHERE profile_id=? AND contact_id IS NULL AND id>? ORDER BY id LIMIT ?", profileId, cursor, limit);
    const statements = rows.flatMap((r) => payerDocumentStatement(profileId, r.id, r.document));
    statements.push(progressStatement(profileId, "mensalidade.payers.v1", rows.at(-1)?.id ?? cursor, rows.length < limit));
    await batch(env, statements);
    // Os sem prova continuam pendentes e serão reconsiderados na próxima rodada.
    return { pending: rows.length > 0 || cursor !== "", statements: 2 + statements.length, items: rows.length };
  },
};

export function progressStatement(profileId: string, task: string, id: string, complete: boolean): Statement {
  return [`INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated) VALUES(?,'team',?,?,?,?)
    ON CONFLICT(profile_id,namespace,task) DO UPDATE SET cursor_json=excluded.cursor_json,complete=excluded.complete,updated=excluded.updated`,
  [profileId, task, JSON.stringify({ id }), complete ? 1 : 0, now()]];
}
