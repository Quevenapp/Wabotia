import { all, batch, one } from "../../db";
import { allows } from "../../access";
import { seal, unseal } from "../../security";
import { ApiError, type Actor, type Conversation } from "../../types";
import { jobInsert, requestHash } from "../../customer/jobs";
import type { ModuleContext } from "../api";
import type { CustomerRef, CustomerWrite, Statement } from "../../customer/contracts";
import type { CustomerModuleProvider } from "../../customer/profile-contracts";

// Nomes compilados; nenhum identificador SQL vem do cliente.
const sources = {
  agenda: ["agenda_appointments", "customer_phone", "appointments"],
  pedido: ["pedido_orders", "phone", "orders"],
  reserva: ["reserva_bookings", "customer_phone", "bookings"],
  os: ["os_orders", "phone", "works"],
  mensalidade: ["mensalidade_subscriptions", "phone", "subscriptions"],
} as const;

const digitsSql = (column: string) => `replace(replace(replace(replace(replace(replace(trim(${column}),'+',''),' ',''),'.',''),'-',''),'(',''),')','')`;

/** Sem snapshot original, uma edição do destinatário exige revisão no domínio. */
function unchangedRecipient(table: string, moduleId: string) {
  if (moduleId === "os") return `NOT EXISTS(SELECT 1 FROM os_history h WHERE h.profile_id=${table}.profile_id
    AND h.order_id=${table}.id AND ((h.kind='edit' AND h.note LIKE 'Alterado:%phone%')
      OR EXISTS(SELECT 1 FROM json_each(h.changed_fields_json) field WHERE field.value='phone')))`;
  if (moduleId === "reserva") return `(${table}.conversation_id IS NOT NULL OR ${table}.changes=0)`;
  if (moduleId === "mensalidade") return `(${table}.conversation_id IS NOT NULL OR ${table}.updated=${table}.created)`;
  return "1";
}

/** Índice original inequívoco ou vínculo de aplicação; nunca variantes locais. */
export function legacyRoutineOwner(table: string, phoneColumn: string, moduleId: string) {
  const phone = digitsSql(`${table}.${phoneColumn}`);
  // Uma OS de balcão pode preceder a primeira conversa vinculada pela equipe.
  // Nesse caso, a sessão inicial dessa conversa também prova a origem. Sessões
  // posteriores continuam insuficientes; os vetos a outro titular, edição do
  // telefone, colisão e índice revisado permanecem abaixo.
  const originTime = moduleId === "os" ? `max(${table}.created,coalesce((SELECT origin.created FROM conversations origin
    WHERE origin.profile_id=${table}.profile_id AND origin.id=${table}.conversation_id
      AND ${table}.source IN ('panel','staff','agent')),${table}.created))` : `${table}.created`;
  return `(SELECT k.id FROM contacts k WHERE k.profile_id=${table}.profile_id AND k.identity_state='active'
    AND ${unchangedRecipient(table, moduleId)}
    AND NOT EXISTS(SELECT 1 FROM customer_records h WHERE h.profile_id=${table}.profile_id
      AND h.module_id='${moduleId}' AND h.record_id=${table}.id AND h.contact_id<>k.id)
    AND NOT EXISTS(SELECT 1 FROM customer_records h WHERE h.profile_id=${table}.profile_id
      AND h.conversation_id=${table}.conversation_id AND h.module_id IN ('conversations','core') AND h.contact_id<>k.id)
    AND (NOT EXISTS(SELECT 1 FROM customer_records h WHERE h.profile_id=${table}.profile_id
      AND h.conversation_id=${table}.conversation_id AND h.module_id IN ('conversations','core'))
      OR EXISTS(SELECT 1 FROM customer_records h WHERE h.profile_id=${table}.profile_id
        AND h.conversation_id=${table}.conversation_id AND h.module_id IN ('conversations','core')
        AND h.contact_id=k.id AND h.occurred_at<=${originTime}))
    AND (
      (k.namespace='team' AND EXISTS(SELECT 1 FROM customer_phones p
        WHERE p.profile_id=k.profile_id AND p.namespace=k.namespace AND p.phone=${phone}
          AND p.contact_id=k.id AND p.state='ready' AND p.version=1
          AND NOT EXISTS(SELECT 1 FROM customer_phone_candidates x WHERE x.profile_id=p.profile_id
            AND x.namespace=p.namespace AND x.phone=p.phone AND (x.contact_id<>k.id OR x.origin IN ('local','mirror')))
          AND NOT EXISTS(SELECT 1 FROM contacts x WHERE x.profile_id=k.profile_id AND x.namespace=k.namespace
            AND x.id<>k.id AND ${digitsSql('x.phone')}=p.phone))
        AND ((${table}.conversation_id IS NULL ${moduleId === 'mensalidade' ? '' : `AND ${table}.source IN ('panel','staff','agent')`}) OR EXISTS(SELECT 1 FROM conversations c
          LEFT JOIN conversation_contacts l ON l.profile_id=c.profile_id AND l.conversation_id=c.id
          WHERE c.profile_id=k.profile_id AND c.id=${table}.conversation_id AND c.chat_type<>'group'
            AND c.external_namespace NOT LIKE 'app:%' AND c.customer_link_state NOT IN ('blocked','excluded','ambiguous')
            AND (l.contact_id IS NULL OR l.contact_id=k.id)
            AND ((c.customer_link_state='ready' AND EXISTS(SELECT 1 FROM customer_phones verified
                WHERE verified.profile_id=c.profile_id AND verified.namespace='team' AND verified.phone=c.verified_phone
                  AND verified.state='ready' AND verified.contact_id=k.id)) OR
              (c.connection_id IS NOT NULL AND c.external_namespace='channel:'||c.connection_id
                AND c.verified_phone=${phone} AND EXISTS(SELECT 1 FROM messages m
                  WHERE m.profile_id=c.profile_id AND m.conversation_id=c.id AND m.direction='inbound'
                    AND m.external_id IS NOT NULL AND m.created<=${table}.created)) OR EXISTS(
              SELECT 1 FROM customer_records h WHERE h.profile_id=c.profile_id AND h.conversation_id=c.id
                AND h.module_id IN ('conversations','core') AND h.contact_id=k.id)))))
      OR (k.namespace LIKE 'app:%' AND EXISTS(SELECT 1 FROM conversations c JOIN conversation_contacts l
        ON l.profile_id=c.profile_id AND l.conversation_id=c.id WHERE c.profile_id=k.profile_id
          AND c.id=${table}.conversation_id AND c.external_namespace=k.namespace AND c.chat_type<>'group'
          AND c.customer_link_state='ready' AND l.contact_id=k.id))
    ) LIMIT 1)`;
}

/** Proprietário persistido prevalece; legado local não contorna vínculo anterior. */
export async function routineCustomerScope(ctx: ModuleContext, c: Conversation, _phoneColumn: "phone" | "customer_phone", moduleId = ctx.module.id) {
  const source = sources[moduleId as keyof typeof sources];
  if (!source) throw new ApiError(404, "not_found", "Rotina não encontrada.");
  const [table, phoneColumn] = source;
  const ref = await ctx.customer(c);
  const namespace = c.external_namespace.startsWith("app:") ? c.external_namespace : "team";
  if (c.profile_id !== ctx.profile || ref.profileId !== ctx.profile || ref.namespace !== namespace)
    throw new ApiError(404, "not_found", "Contato não encontrado.");
  const contactId = ref.state === "ready" ? ref.contactId : null;
  const owner = `coalesce(${table}.contact_id,(SELECT h.contact_id FROM customer_records h
    WHERE h.profile_id=${table}.profile_id AND h.module_id='${moduleId}' AND h.record_id=${table}.id LIMIT 1))`;
  // O fallback publicado conserva somente a origem sem proprietário, sem
  // sessão histórica de outra pessoa e sem atravessar linhas por telefone.
  const local = `(${unchangedRecipient(table, moduleId)} AND ${table}.conversation_id=? AND ${table}.created>=?
    AND (${digitsSql(`${table}.${phoneColumn}`)}=? OR ? LIKE 'app:%') AND NOT EXISTS(SELECT 1 FROM customer_records h
    WHERE h.profile_id=${table}.profile_id AND h.conversation_id=${table}.conversation_id
      AND h.module_id IN ('conversations','core') AND (? IS NULL OR h.contact_id<>?))
    AND (NOT EXISTS(SELECT 1 FROM customer_records h WHERE h.profile_id=${table}.profile_id
      AND h.conversation_id=${table}.conversation_id AND h.module_id IN ('conversations','core'))
      OR EXISTS(SELECT 1 FROM customer_records h WHERE h.profile_id=${table}.profile_id
        AND h.conversation_id=${table}.conversation_id AND h.module_id IN ('conversations','core')
        AND h.contact_id=? AND h.occurred_at<=${table}.created)))`;
  return {
    sql: c.chat_type === "group" ? "0" : `(NOT EXISTS(SELECT 1 FROM customer_records h
      WHERE h.profile_id=${table}.profile_id AND h.module_id='${moduleId}' AND h.record_id=${table}.id
        AND h.contact_id<>${owner}) AND (${owner}=? OR (${owner} IS NULL AND (${local}
      OR (? IS NOT NULL AND ${legacyRoutineOwner(table, phoneColumn, moduleId)}=?)))))`,
    params: c.chat_type === "group" ? [] : [contactId, c.id, c.created, ref.verifiedPhone || ctx.verifiedPhone(c) || c.phone, namespace, contactId, contactId, contactId, contactId, contactId] as unknown[],
    ref,
  };
}

export async function routineCustomerAllows(ctx: ModuleContext, c: Conversation, row: { id: string }, moduleId = ctx.module.id) {
  const source = sources[moduleId as keyof typeof sources];
  const scope = await routineCustomerScope(ctx, c, source[1], moduleId);
  return !!await one(ctx.env, `SELECT id FROM ${source[0]} WHERE profile_id=? AND id=? AND ${scope.sql}`,
    ctx.profile, row.id, ...scope.params);
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
  return { ref, name: contact.name as string, phone: ref.verifiedPhone || (namespace.startsWith("app:") ? contact.phone : "") || "", snapshot: contact };
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
  // jobInsert termina o SELECT com WHERE: sem ele, SQLite interpreta o ON
  // como condição de JOIN e recusa o lote inteiro do pedido.
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
      if (actor.kind !== "user" || actor.via || actor.id.startsWith("bot:") || actor.module || actor.credential || !allows(actor, moduleId))
        throw new ApiError(403, "forbidden", "Sem permissão para consultar esta lista.");
      ctx.access(actor, "conversations:read");
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
      const rows = await all(env, `SELECT id,created,contact_id,conversation_id,${source.phone} snapshot_phone FROM ${table}
        WHERE profile_id=? AND contact_id IS NULL
        ${cursor.id ? "AND (created>? OR (created=? AND id>?))" : ""}
        ORDER BY created,id LIMIT ?`, profileId,
        ...(cursor.id ? [cursor.created, cursor.created, cursor.id] : []), limit);
      const statements: Statement[] = rows.map(row => [
        `UPDATE ${table} SET contact_id=${legacyRoutineOwner(table, source.phone, moduleId)}
          WHERE profile_id=? AND id=? AND contact_id IS NULL AND conversation_id IS ? AND ${source.phone}=?`,
        [profileId, row.id, row.conversation_id, row.snapshot_phone],
      ]);
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
