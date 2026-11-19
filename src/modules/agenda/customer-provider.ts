import { all, batch, one } from "../../db";
import { allows } from "../../access";
import { seal, unseal } from "../../security";
import { ApiError, type Actor, type Conversation } from "../../types";
import { jobInsert, requestHash } from "../../customer/jobs";
import type { ModuleContext } from "../api";
import type { CustomerRef, CustomerWrite, Statement } from "../../customer/contracts";
import type { CustomerModuleProvider } from "../../customer/profile-contracts";
import { normalizeCustomerPhone, customerPhoneVariants as phoneVariants } from "../../customer/phone";

/** Consulta pública legada por credencial do canal; texto/API não fornece phone. */
export async function routineCustomerScope(ctx: ModuleContext, c: Conversation, phoneColumn: "phone" | "customer_phone") {
  const ref = await ctx.customer(c);
  const namespace = c.external_namespace.startsWith("app:") ? c.external_namespace : "team";
  if (c.profile_id !== ctx.profile || ref.profileId !== ctx.profile || ref.namespace !== namespace)
    throw new ApiError(404, "not_found", "Contato não encontrado.");
  if (["blocked", "excluded", "ambiguous"].includes(ref.state))
    return { sql: "contact_id IS NULL AND conversation_id=?", params: [c.id] as unknown[] };
  const phone = ctx.verifiedPhone(c);
  return {
    sql: `(contact_id=? OR (contact_id IS NULL AND (conversation_id=? OR ${phoneColumn} IN (SELECT value FROM json_each(?)))))`,
    params: [ref.state === "ready" ? ref.contactId : null, c.id, JSON.stringify(phone ? phoneVariants(phone) : [])],
  };
}

/** Utilitários compartilhados apenas pelas três rotinas desta frente. */
export async function routineCustomer(ctx: ModuleContext, c: Conversation) {
  if (c.profile_id !== ctx.profile)
    throw new ApiError(404, "not_found", "Conversa não encontrada.");
  const ref = await ctx.customer(c);
  const namespace = c.external_namespace.startsWith("app:") ? c.external_namespace : "team";
  if (ref.profileId !== ctx.profile || ref.namespace !== namespace)
    throw new ApiError(404, "not_found", "Contato não encontrado.");
  if (c.chat_type === "group" || ref.state !== "ready" || !ref.contactId) return null;
  const contact = await one(ctx.env,
    "SELECT id,name,phone,email,document,person_type,mirror_json FROM contacts WHERE profile_id=? AND namespace=? AND id=? AND identity_state='active'",
    ctx.profile, namespace, ref.contactId);
  if (!contact) throw new ApiError(404, "not_found", "Contato não encontrado.");
  return { ref, name: contact.name as string, phone: ref.verifiedPhone || "", snapshot: contact };
}

/** Nome confirmado no carrinho; intenção no lote do pedido, processada na manutenção. */
export async function selfCustomerStatements(ctx: ModuleContext, c: Conversation, customer: NonNullable<Awaited<ReturnType<typeof routineCustomer>>>, source: string, name: string): Promise<Statement[]> {
  if (!name.trim() || customer.ref.namespace !== "team" || !customer.ref.verifiedPhone || name === customer.name) return [];
  const actor: Actor = { id: `customer:${c.id}:${c.session}`, kind: "connector", name: "Cliente da conversa", role: "service", profiles: [ctx.profile], scopes: ["contacts:self"], bots: [], rate: 0, runLimit: 0 };
  const input: CustomerWrite = { commandId: `self:${source}`, expectedVersion: customer.ref.version!, expectedErpVersion: customer.ref.erp?.version ?? null, mode: "fill_empty", patch: { name: name.trim() } };
  const row = customer.snapshot;
  const base = row.mirror_json ? JSON.parse(row.mirror_json) : { name: row.name, phones: row.phone ? [row.phone] : [], email: row.email, document: row.document, personType: row.person_type };
  const hash = await requestHash(actor, { source, contactId: customer.ref.contactId, name: name.trim() });
  const job = jobInsert(ctx.profile, "team", customer.ref.contactId, "enrich", input.commandId, hash, await seal(ctx.env, { actor, input, base, operation: "enrich" }), input.expectedVersion, input.expectedErpVersion);
  return [[job.statement[0] + " ON CONFLICT(profile_id,command_id) DO NOTHING", job.statement[1]]];
}

type Confirmation = { actor: Actor; name?: unknown; input?: Pick<CustomerWrite, "expectedVersion" | "expectedErpVersion" | "patch"> };
const CONFIRMATION = Symbol("routineCustomerConfirmation");
type ConfirmedContext = ModuleContext & { [CONFIRMATION]?: Confirmation };

/** `customer` é confirmação cadastral explícita, separada dos snapshots da rotina. */
export function withCustomerConfirmation(ctx: ModuleContext, actor: Actor, input: unknown, name?: unknown): ModuleContext {
  if (input === undefined) return Object.assign({}, ctx, { [CONFIRMATION]: { actor, name } });
  const value = input as Confirmation["input"];
  if (!value || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1 ||
      !(value.expectedErpVersion === null || (Number.isSafeInteger(value.expectedErpVersion) && value.expectedErpVersion! >= 1)) ||
      !value.patch || typeof value.patch !== "object" || Array.isArray(value.patch) ||
      Object.keys(value.patch).some((key) => !["name", "email", "document", "personType", "phones"].includes(key)))
    throw new ApiError(400, "invalid_customer_patch", "Confirme os dados cadastrais e suas versões. Endereços e respostas pertencem à rotina.");
  ctx.access(actor, "contacts:write");
  if (!allows(actor, "contacts")) throw new ApiError(403, "forbidden", "Sem permissão para completar o contato.");
  return Object.assign({}, ctx, { [CONFIRMATION]: { actor, input: value } });
}

export async function confirmRoutineCustomer(
  ctx: ModuleContext, c: Conversation | null, ref: CustomerRef | null,
  moduleId: string, sourceId: string, persistedContactId?: string | null,
) {
  const confirmation = (ctx as ConfirmedContext)[CONFIRMATION];
  if (!confirmation) return;
  const name = typeof confirmation.name === "string" ? confirmation.name.trim() : "";
  // Somente o nome informado pelo executor autenticado; nunca título do canal,
  // nome deduzido pelo bot, endereço de entrega ou respostas de check-in.
  if (!confirmation.input && (!name || confirmation.actor.kind !== "user" || confirmation.actor.via)) return;
  if (!confirmation.input && (!c || !ref?.contactId)) return;
  if (c && !ref) {
    const unresolved = await ctx.customer(c);
    if (unresolved.state === "ambiguous")
      throw new ApiError(409, "customer_ambiguous", "Resolva a identidade antes de completar o contato.");
    if (unresolved.state === "excluded")
      throw new ApiError(404, "not_found", "Contato não encontrado.");
  }
  if (!c || !ref?.contactId || (persistedContactId !== undefined && persistedContactId !== ref.contactId))
    throw new ApiError(422, "contact_required", "Confirme a identidade do contato antes de completar o cadastro.");
  const commandId = `routine:${JSON.stringify([ctx.profile, moduleId, sourceId])}`;
  let input = confirmation.input;
  if (!input) {
    ctx.access(confirmation.actor, "contacts:write");
    if (!allows(confirmation.actor, "contacts")) return;
    // A intenção já persistida fixa as versões até quando o recibo da rotina
    // ainda não foi fechado. Não regenerar um comando diferente depois da queda.
    const job = await one(ctx.env,
      "SELECT expected_version,expected_erp_version FROM customer_jobs WHERE profile_id=? AND command_id=?",
      ctx.profile, commandId);
    input = {
      expectedVersion: job?.expected_version ?? ref.version!,
      expectedErpVersion: job ? job.expected_erp_version : ref.erp?.version ?? null,
      patch: { name },
    };
  }
  // Versões e corpo vêm da confirmação original, nunca da versão relida no retry.
  // A porta persiste a intenção antes do ERP. Nenhum endereço da operação entra aqui.
  await ctx.enrichCustomer(confirmation.actor, c, {
    commandId,
    expectedVersion: input.expectedVersion,
    expectedErpVersion: input.expectedErpVersion,
    patch: input.patch,
    mode: "fill_empty",
  });
}

type Routine = { moduleId: string; collectionId: string; table: string; phone: string; checkin?: boolean };

/** Fontes fixas compiladas, sem nomes de tabela vindos da requisição. */
export function routineProvider(source: Routine): CustomerModuleProvider {
  const { moduleId, collectionId, table } = source;
  const task = `routine:${moduleId}:${collectionId}`;
  return {
    async list(ctx, actor, contactId, requested, query) {
      if (actor.kind !== "user" || actor.module || actor.credential || !allows(actor, moduleId) || !allows(actor, "contacts"))
        throw new ApiError(403, "forbidden", "Sem permissão para consultar esta lista.");
      ctx.access(actor, "conversations:read");
      ctx.access(actor, "contacts:read");
      if (ctx.module.id !== moduleId || requested !== collectionId)
        throw new ApiError(404, "not_found", "Lista não encontrada.");
      await ctx.requireEnabled();
      const contact = await one(ctx.env,
        "SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND id=? AND identity_state='active'",
        ctx.profile, contactId);
      if (!contact) throw new ApiError(404, "not_found", "Contato não encontrado.");
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
        throw new ApiError(400, "invalid_request", "Limite de 1 a 100 registros.");
      const scope = JSON.stringify([ctx.profile, "team", contactId, moduleId, collectionId, actor.id, actor.sessionId || null, query.limit]);
      let cutoff = Date.now(), last: { created: number; id: string } | null = null;
      if (query.cursor) {
        try {
          if (query.cursor.length > 16000) throw new Error();
          const cursor = await unseal(ctx.env, atob(query.cursor));
          if (cursor.scope !== scope || !Number.isSafeInteger(cursor.cutoff) || cursor.cutoff > cutoff ||
              !Number.isSafeInteger(cursor.last?.created) || cursor.last.created > cursor.cutoff || typeof cursor.last.id !== "string") throw new Error();
          cutoff = cursor.cutoff;
          last = cursor.last;
        } catch { throw new ApiError(400, "invalid_cursor", "Cursor inválido para esta lista."); }
      }
      // Vínculo e área filtrados ANTES do limite; created é imutável, starts não é.
      const rows = await all(ctx.env,
        `SELECT id,status,created${source.checkin ? ",checkin_status" : ""} FROM ${table}
         WHERE profile_id=? AND contact_id=? AND created<=?
         ${last ? "AND (created<? OR (created=? AND id<?))" : ""}
         ORDER BY created DESC,id DESC LIMIT ?`,
        ctx.profile, contactId, cutoff, ...(last ? [last.created, last.created, last.id] : []), query.limit + 1);
      const more = rows.length > query.limit;
      const visible = rows.slice(0, query.limit);
      const tail = visible.at(-1);
      const pending = await one(ctx.env, `SELECT 1 FROM ${table} r WHERE r.profile_id=? AND r.contact_id IS NULL
        AND ((r.conversation_id IS NULL AND r.source<>'api') OR EXISTS (
          SELECT 1 FROM conversations c WHERE c.profile_id=r.profile_id AND c.id=r.conversation_id
            AND c.external_namespace NOT LIKE 'app:%' AND c.chat_type<>'group')) LIMIT 1`, ctx.profile);
      return {
        items: visible.map((row) => ({
          id: row.id,
          cells: { id: row.id, status: row.status, occurredAt: row.created,
            ...(source.checkin ? { checkinStatus: row.checkin_status } : {}) },
          target: { module: moduleId, resource: collectionId, id: row.id },
        })),
        nextCursor: more && tail ? btoa(await seal(ctx.env, { scope, cutoff, last: { created: tail.created, id: tail.id } })) : null,
        incomplete: !!pending,
      };
    },
    async maintain(env, profileId, budget) {
      // Até cinco itens por rotina deixam saldo para as outras participantes.
      // Duas leituras e checkpoint no mesmo lote dos vínculos.
      const limit = Math.min(5, budget.remainingItems, budget.remainingStatements - 3);
      if (limit < 1) return { pending: true, statements: 0, items: 0 };
      const progress = await one(env,
        "SELECT cursor_json FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?", profileId, task);
      // O cursor percorre a fonte da área inteira; cada linha conserva seu namespace.
      const cursor = progress ? JSON.parse(progress.cursor_json) : {};
      const rows = await all(env, `SELECT r.id,r.created,r.${source.phone} snapshot_phone,
          c.id conversation_id,c.external_namespace,c.verified_phone,c.customer_link_state,
          cc.contact_id,ct.namespace,ct.identity_state,p.state phone_state,p.contact_id phone_contact
        FROM ${table} r
        LEFT JOIN conversations c ON c.profile_id=r.profile_id AND c.id=r.conversation_id AND c.chat_type<>'group'
        LEFT JOIN conversation_contacts cc ON cc.profile_id=c.profile_id AND cc.conversation_id=c.id
        LEFT JOIN contacts ct ON ct.profile_id=cc.profile_id AND ct.id=cc.contact_id
        LEFT JOIN customer_phones p ON p.profile_id=c.profile_id AND p.namespace=ct.namespace AND p.phone=c.verified_phone
        WHERE r.profile_id=? AND r.contact_id IS NULL
        ${cursor.id ? "AND (r.created>? OR (r.created=? AND r.id>?))" : ""}
        ORDER BY r.created,r.id LIMIT ?`, profileId,
        ...(cursor.id ? [cursor.created, cursor.created, cursor.id] : []), limit);
      const statements: Statement[] = [];
      for (const row of rows) {
        const namespace = row.external_namespace?.startsWith("app:") ? row.external_namespace : "team";
        const snapshot = normalizeCustomerPhone(row.snapshot_phone, "international");
        if (!row.contact_id || row.identity_state !== "active" || row.namespace !== namespace || row.customer_link_state !== "ready" ||
            (namespace === "team" && (row.phone_state !== "ready" || row.phone_contact !== row.contact_id ||
              !snapshot || snapshot !== row.verified_phone))) continue;
        statements.push([
          `UPDATE ${table} SET contact_id=? WHERE profile_id=? AND id=? AND contact_id IS NULL
           AND EXISTS (SELECT 1 FROM conversation_contacts cc JOIN contacts ct ON ct.id=cc.contact_id AND ct.profile_id=cc.profile_id
             JOIN conversations c ON c.id=cc.conversation_id AND c.profile_id=cc.profile_id
             WHERE cc.profile_id=? AND cc.conversation_id=? AND cc.contact_id=? AND ct.namespace=? AND ct.identity_state='active'
               AND c.customer_link_state='ready' AND c.external_namespace=? AND c.verified_phone IS ?
               AND (?<>'team' OR EXISTS (SELECT 1 FROM customer_phones p WHERE p.profile_id=cc.profile_id
                 AND p.namespace=ct.namespace AND p.phone=c.verified_phone AND p.state='ready' AND p.contact_id=ct.id)))`,
          [row.contact_id, profileId, row.id, profileId, row.conversation_id, row.contact_id, namespace,
            row.external_namespace, row.verified_phone, namespace],
        ]);
      }
      const tail = rows.at(-1);
      // Ao terminar a passagem, recomeça: identidades antes ambíguas podem ter sido resolvidas.
      const next = rows.length === limit && tail ? { created: tail.created, id: tail.id } : {};
      statements.push([
        `INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated) VALUES(?,'team',?,?,?,?)
         ON CONFLICT(profile_id,namespace,task) DO UPDATE SET cursor_json=excluded.cursor_json,complete=excluded.complete,updated=excluded.updated`,
        [profileId, task, JSON.stringify(next), !rows.length && !cursor.id ? 1 : 0, Date.now()],
      ]);
      await batch(env, statements);
      return { pending: rows.length > 0 || !!cursor.id, statements: statements.length + 2, items: rows.length };
    },
  };
}

export const agendaCustomerProvider = routineProvider({
  moduleId: "agenda", collectionId: "appointments", table: "agenda_appointments", phone: "customer_phone",
});
