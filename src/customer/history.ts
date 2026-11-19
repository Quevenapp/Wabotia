import { all, batch, one } from "../db";
import { allows } from "../access";
import { canProfile, seal, unseal } from "../security";
import { boundAllows, isBound, visibleConversation } from "../visibility";
import { moduleStates } from "../modules/registry";
import { ApiError, type Actor, type Conversation, type Env, now } from "../types";
import type { CustomerMemory, HistoryItem, HistoryPort, Statement } from "./contracts";
import type { CustomerModuleProvider } from "./profile-contracts";
import { installHistoryPort, registerCustomerProvider, resolveCustomer } from "./ports";

const TASK = "history:v1";
// Convenções de customer_records (fontes sem contact_id):
// conversations/session → conversationId:session; tickets/ticket → ticket.id;
// queue/ticket → queue_tickets.id. O produtor deve gravar o vínculo no seu lote.
const namespaceOf = (c: Conversation) => c.external_namespace.startsWith("app:") ? c.external_namespace : "team";
const emptyMemory = (): CustomerMemory => ({ previousInteractions: 0, pendingActions: 0, lastInteractionAt: null, topicCode: null });
function fail(status: number, code: string): never { throw new ApiError(status, code, "Histórico indisponível para esta consulta."); }
const permitted = (actor: Actor, item: string, scope = `${item}:read`) => actor.kind === "user"
  ? allows(actor, item) : actor.kind === "app" && actor.scopes.includes(scope);

async function authorize(env: Env, actor: Actor, profile: string, target: { contactId: string } | { conversationId: string }, collection = false) {
  if (!actor?.id) fail(401, "unauthorized");
  if (actor.kind === "connector" || actor.module || actor.credential) fail(403, "forbidden");
  if (!canProfile(actor, profile)) fail(404, "not_found");
  let c: Conversation | null = null;
  let contactId: string | null = null;
  let namespace: string;
  let incomplete = false;
  let excluded = false;
  if ("conversationId" in target) {
    if (!permitted(actor, "conversations")) fail(403, "forbidden");
    c = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", profile, target.conversationId);
    if (!c || !visibleConversation(actor, c) || !(await boundAllows(env, actor, c))) fail(404, "not_found");
    // Mesmo o atalho de namespace de boundAllows não amplia a execução de um bot.
    if (actor.via && !(await one(env, "SELECT 1 FROM bot_runs WHERE id=? AND profile_id=? AND conversation_id=? AND bot_id=? AND epoch=? AND (json_extract(context,'$.session') IS NULL OR json_extract(context,'$.session')=?)", actor.via.run_id, profile, c.id, actor.via.bot_id, c.epoch, c.session))) fail(404, "not_found");
    namespace = namespaceOf(c);
    const ref = await resolveCustomer(env, c);
    if (ref.profileId !== profile || ref.namespace !== namespace) fail(404, "not_found");
    excluded = c.chat_type === "group" || ["blocked", "excluded"].includes(ref.state);
    contactId = ref.state === "ready" ? ref.contactId : null;
    incomplete = ref.state !== "ready" && !excluded;
    // Um vínculo restrito não pode reaparecer como fallback legado.
    const restricted = await one(env, `SELECT 1 FROM conversation_contacts l JOIN contacts p ON p.id=l.contact_id AND p.profile_id=l.profile_id WHERE l.profile_id=? AND l.conversation_id=? AND p.identity_state<>'active'`, profile, c.id);
    excluded ||= !!restricted;
  } else {
    if (isBound(actor) || actor.via || (collection && actor.kind !== "user")) fail(403, "forbidden");
    if (!permitted(actor, "contacts")) fail(403, "forbidden");
    contactId = target.contactId;
    namespace = "team";
  }
  if (contactId) {
    const contact = await one(env, "SELECT namespace,identity_state FROM contacts WHERE profile_id=? AND id=?", profile, contactId);
    if (!contact || (c && contact.namespace !== namespace!) || (actor.kind === "app" && !isBound(actor) && contact.namespace !== `app:${actor.id}`)) fail(404, "not_found");
    namespace = contact.namespace;
    excluded ||= contact.identity_state !== "active";
  }
  return { contactId, namespace: namespace!, conversationId: c?.id ?? null, session: c?.session ?? null, incomplete, excluded };
}

type Scope = Awaited<ReturnType<typeof authorize>>;
type Source = "conversation" | "ticket" | "queue" | "form" | "checkin";
async function sourcesFor(env: Env, actor: Actor, profile: string, scope: Scope) {
  const states = await moduleStates(env, profile);
  const bound = isBound(actor) && !!scope.conversationId;
  return ([
    permitted(actor, "conversations") && "conversation",
    (permitted(actor, "tickets") || bound) && "ticket",
    states.queue && (permitted(actor, "queue") || bound) && "queue",
    states.forms && (permitted(actor, "conversations") || bound) && "form",
    states.reserva && (permitted(actor, "reserva") || bound) && "checkin",
  ] as const).filter((value): value is Source => !!value);
}

/** Apenas colunas administrativas. O filtro de autorização integra cada ramo antes do LIMIT. */
function sourceQuery(profile: string, scope: Scope, sources: Source[]): Statement {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, values: unknown[]) => { parts.push(sql); params.push(...values); };
  for (const source of sources) {
    if (source === "conversation") {
      let sessions = `SELECT 'conversation' kind,'conversation:'||r.record_id sourceKey,r.occurred_at occurredAt,
        CASE WHEN r.record_id=c.id||':'||c.session THEN c.state ELSE 'closed' END status,c.id id,'conversations' module,'conversations' resource
        FROM customer_records r JOIN conversations c ON c.id=r.conversation_id AND c.profile_id=r.profile_id
        JOIN contacts p ON p.id=r.contact_id AND p.profile_id=r.profile_id
        WHERE r.profile_id=? AND r.module_id='conversations' AND r.kind='session' AND p.identity_state='active' AND p.namespace=?
        AND r.contact_id=? AND (? IS NULL OR c.id=?)
        AND p.namespace=CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END`;
      const sessionParams = [profile, scope.namespace, scope.contactId, scope.conversationId, scope.conversationId];
      if (scope.conversationId) {
        sessions += ` UNION ALL SELECT 'conversation','conversation:'||c.id||':'||c.session,c.created,c.state,c.id,'conversations','conversations'
          FROM conversations c WHERE c.profile_id=? AND c.id=? AND c.epoch=0 AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=c.profile_id AND r.module_id='conversations' AND r.kind='session' AND r.record_id=c.id||':'||c.session)`;
        sessionParams.push(profile, scope.conversationId);
      }
      // O D1 limita cada SELECT composto a cinco termos. Sessão persistida e
      // fallback são variantes da mesma fonte: ficam juntas em uma subconsulta,
      // preservando as cinco fontes e um único corte/ORDER BY/LIMIT externos.
      add(`SELECT * FROM (${sessions})`, sessionParams);
      continue;
    }
    const linked = source === "ticket" || source === "queue";
    const table = ({ ticket: "tickets", queue: "queue_tickets", form: "web_steps", checkin: "reserva_bookings" })[source];
    const module = ({ ticket: "tickets", queue: "queue", form: "forms", checkin: "reserva" })[source];
    const resource = ({ ticket: "tickets", queue: "tickets", form: "submissions", checkin: "bookings" })[source];
    const date = ({ ticket: "s.created", queue: "s.created_at", form: "s.completed_at", checkin: "s.checkin_at" })[source];
    const contact = linked ? "r.contact_id" : "s.contact_id";
    const join = linked ? `LEFT JOIN customer_records r ON r.profile_id=s.profile_id AND r.module_id='${module}' AND r.kind='ticket' AND r.record_id=s.id` : "";
    add(`SELECT '${source}' kind,'${source}:'||s.id sourceKey,${date} occurredAt,${source === "checkin" ? "s.checkin_status" : "s.status"} status,s.id id,'${module}' module,'${resource}' resource
      FROM ${table} s ${join} LEFT JOIN contacts p ON p.id=${contact} AND p.profile_id=s.profile_id
      WHERE s.profile_id=? AND ${date} IS NOT NULL
      ${source === "form" ? "AND s.module_id='forms' AND s.kind='form' AND s.status='completed'" : ""}
      ${source === "checkin" ? "AND s.checkin_status='completed'" : ""}
      AND ((${contact}=? AND p.namespace=? AND p.identity_state='active') OR (${contact} IS NULL AND s.conversation_id=?))
      AND (? IS NULL OR s.conversation_id=?)`,
    [profile, scope.contactId, scope.namespace, scope.conversationId, scope.conversationId, scope.conversationId]);
  }
  return [parts.join(" UNION ALL "), params];
}

const statuses: Record<Source, readonly string[]> = {
  conversation: ["ai", "human", "queued", "closed", "waiting", "bot"],
  ticket: ["open", "pending", "in_progress", "waiting_customer", "waiting_third", "resolved", "closed", "cancelled"],
  queue: ["waiting", "called", "serving", "done", "no_show", "cancelled"],
  form: ["completed"], checkin: ["completed"],
};
function itemOf(row: any): HistoryItem {
  const kind = row.kind as Source;
  const status = statuses[kind].includes(row.status) ? row.status as string : "unknown";
  return { kind, sourceKey: row.sourceKey, occurredAt: row.occurredAt, status,
    topicCode: ["open", "pending", "in_progress", "waiting_customer", "waiting_third", "waiting", "called", "serving", "queued"].includes(status) ? "pending_action" : "previous_service",
    target: { module: row.module, resource: row.resource, id: row.id } };
}

async function pending(env: Env, profile: string, scope: Scope, sources: Source[], cut: number) {
  const modules = sources.map(s => ({ conversation: "conversations", ticket: "tickets", queue: "queue", form: "forms", checkin: "reserva" })[s]);
  // Mesmo após completar o legado, uma nova origem ainda sem vínculo não
  // permite afirmar completude. Nada de busca por telefone para preencher a lacuna.
  const row = await one(env, `SELECT
    coalesce((SELECT complete FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?),0)=0
    OR EXISTS(SELECT 1 FROM (${legacySources}) WHERE module IN (SELECT value FROM json_each(?)) AND at<=?
      AND ((? IS NOT NULL AND contact_id=?) OR (? IS NOT NULL AND conversation_id=?))
      AND (? IS NULL OR conversation_id=?)) incomplete`, profile, TASK, profile, profile, profile, profile, JSON.stringify(modules), cut,
    scope.contactId, scope.contactId, scope.conversationId, scope.conversationId, scope.conversationId, scope.conversationId);
  return !!row?.incomplete;
}

async function page(env: Env, actor: Actor, profile: string, target: { contactId: string } | { conversationId: string }, query: { limit?: number; cursor?: string }, only?: Source) {
  const limit = query.limit ?? (only ? 25 : 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > (only ? 100 : 50)) fail(400, "invalid_request");
  const scope = await authorize(env, actor, profile, target, !!only);
  const allowed = await sourcesFor(env, actor, profile, scope);
  const sources = only ? allowed.filter(s => s === only) : allowed;
  if (only && !sources.length) {
    const states = await moduleStates(env, profile);
    fail(states[only === "form" ? "forms" : "queue"] ? 403 : 409, states[only === "form" ? "forms" : "queue"] ? "forbidden" : "module_disabled");
  }
  const binding = JSON.stringify([profile, scope.namespace, scope.contactId, scope.conversationId, scope.session, actor.id, actor.kind, actor.sessionId ?? null, actor.via?.run_id ?? null, sources, only ?? "history", limit]);
  let cut = now(), last: { at: number; key: string } | null = null;
  if (query.cursor) {
    try {
      if (query.cursor.length > 16000) throw new Error();
      const cursor = await unseal(env, atob(query.cursor));
      if (cursor.v !== 1 || cursor.binding !== binding || !Number.isSafeInteger(cursor.cut) || cursor.cut > cut || !Number.isSafeInteger(cursor.last?.at) || cursor.last.at > cursor.cut || typeof cursor.last.key !== "string") throw new Error();
      cut = cursor.cut; last = cursor.last;
    } catch { fail(400, "invalid_cursor"); }
  }
  if (scope.excluded) return { items: [], nextCursor: null, incomplete: false };
  const incomplete = scope.incomplete || await pending(env, profile, scope, sources, cut);
  if (!sources.length) return { items: [], nextCursor: null, incomplete };
  const [sql, args] = sourceQuery(profile, scope, sources);
  const rows = await all(env, `SELECT * FROM (${sql}) WHERE occurredAt<=? ${last ? "AND (occurredAt<? OR (occurredAt=? AND sourceKey<?))" : ""} ORDER BY occurredAt DESC,sourceKey DESC LIMIT ?`, ...args, cut, ...(last ? [last.at, last.at, last.key] : []), limit + 1);
  const items = rows.slice(0, limit).map(itemOf);
  const tail = items.at(-1);
  return { items, nextCursor: rows.length > limit && tail ? btoa(await seal(env, { v: 1, binding, cut, last: { at: tail.occurredAt, key: tail.sourceKey } })) : null, incomplete };
}

/** Whitelist também na fronteira da IA: nunca espalhar objetos de fornecedores. */
export function projectCustomerMemory(value: unknown): CustomerMemory {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? Math.min(50, v) : 0;
  return { previousInteractions: count(data.previousInteractions), pendingActions: count(data.pendingActions),
    lastInteractionAt: typeof data.lastInteractionAt === "number" && Number.isSafeInteger(data.lastInteractionAt) && data.lastInteractionAt >= 0 ? data.lastInteractionAt : null,
    topicCode: data.topicCode === "previous_service" ? "previous_service" : null };
}

const privateKeys = new Set(["answers", "checkin_answers", "checkinAnswers", "result_cipher", "payload_cipher", "identity_cipher", "local_patch_cipher", "notes", "internal_notes", "internalNotes", "paid_note", "medical_record", "medicalRecord", "prontuario", "customer_history", "customerHistory", "form_submissions", "web_steps"]);
const privateModules = new Set(["saude", "ensino", "juridico"]);
/** Retira dados privados estruturados antes de qualquer máscara, inclusive com ela desligada. */
export function projectCustomerInput(input: string): string {
  const clean = (value: any, depth = 0): any => {
    if (depth > 20) return undefined;
    if (!value || typeof value !== "object") return value;
    if (privateModules.has(value.module_id) || privateModules.has(value.module) || value.private === true || value.direction === "note" || value.internal === true || value.internal === 1) return undefined;
    if (value.module_id === "forms" && ("result" in value || "answers" in value)) return undefined;
    if (Array.isArray(value)) return value.map(entry => clean(entry, depth + 1)).filter(v => v !== undefined);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key) && !privateModules.has(key) && !/_(cipher|enc)$/.test(key)).map(([key, entry]) => [key, key === "customerMemory" || key === "customer_memory" ? projectCustomerMemory(entry) : clean(entry, depth + 1)]).filter(([, entry]) => entry !== undefined));
  };
  try { return JSON.stringify(clean(JSON.parse(input)) ?? {}); } catch { return input; }
}

/**
 * Reconstrução só por vínculo explícito preexistente, nunca por telefone.
 * A data do vínculo precisa anteceder o registro; reassociação posterior não
 * atribui fatos antigos ao novo contato. Sem prova, fica pendente e revisita.
 * O checkpoint e as atribuições condicionais pertencem ao mesmo lote D1.
 */
const legacySources = `
  SELECT 'conversations' module,'session' kind,c.id||':'||c.session id,c.id conversation_id,c.created at,cc.contact_id,cc.created linked_at,p.namespace
    FROM conversations c LEFT JOIN conversation_contacts cc ON cc.conversation_id=c.id AND cc.profile_id=c.profile_id LEFT JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id AND p.identity_state='active'
    WHERE c.profile_id=? AND c.chat_type<>'group' AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=c.profile_id AND r.module_id='conversations' AND r.kind='session' AND r.record_id=c.id||':'||c.session)
  UNION ALL SELECT 'tickets','ticket',s.id,s.conversation_id,s.created,cc.contact_id,cc.created,p.namespace FROM tickets s LEFT JOIN conversation_contacts cc ON cc.conversation_id=s.conversation_id AND cc.profile_id=s.profile_id LEFT JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id AND p.identity_state='active' WHERE s.profile_id=? AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=s.profile_id AND r.module_id='tickets' AND r.kind='ticket' AND r.record_id=s.id)
  UNION ALL SELECT 'queue','ticket',s.id,s.conversation_id,s.created_at,cc.contact_id,cc.created,p.namespace FROM queue_tickets s LEFT JOIN conversation_contacts cc ON cc.conversation_id=s.conversation_id AND cc.profile_id=s.profile_id LEFT JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id AND p.identity_state='active' WHERE s.profile_id=? AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=s.profile_id AND r.module_id='queue' AND r.kind='ticket' AND r.record_id=s.id)
  UNION ALL SELECT 'forms','form',s.id,s.conversation_id,s.created,cc.contact_id,cc.created,p.namespace FROM web_steps s LEFT JOIN conversation_contacts cc ON cc.conversation_id=s.conversation_id AND cc.profile_id=s.profile_id LEFT JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id AND p.identity_state='active' WHERE s.profile_id=? AND s.module_id='forms' AND s.kind='form' AND s.contact_id IS NULL`;

export const customerHistory: HistoryPort = {
  read: (env, actor, profile, target, query) => page(env, actor, profile, target, query),
  async memory(env, actor, conversation) {
    if (!isBound(actor) || !actor.via || actor.via.bot_id === "" || !actor.bots.includes(actor.via.bot_id)) fail(403, "forbidden");
    const result = await page(env, actor, conversation.profile_id, { conversationId: conversation.id }, { limit: 50 });
    if (!result.items.length) return emptyMemory();
    return projectCustomerMemory({ previousInteractions: result.items.length, pendingActions: result.items.filter(i => i.topicCode === "pending_action").length, lastInteractionAt: result.items[0].occurredAt, topicCode: "previous_service" });
  },
  async maintain(env, profile, budget) {
    const max = Math.min(20, budget.remainingItems, budget.remainingStatements - 3);
    if (max < 1) return { pending: true, statements: 0, items: 0 };
    const progress = await one(env, "SELECT cursor_json FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?", profile, TASK);
    let cursor = { key: "", unresolved: false };
    if (progress) { try { cursor = JSON.parse(progress.cursor_json); } catch { /* reinicia com segurança */ } }
    const rows = await all(env, `SELECT *,module||':'||kind||':'||id scan_key FROM (${legacySources}) WHERE module||':'||kind||':'||id>? ORDER BY scan_key LIMIT ?`, profile, profile, profile, profile, cursor.key, max);
    const writes: Statement[] = [];
    for (const row of rows) {
      if (!row.namespace || !row.contact_id || row.linked_at > row.at) { cursor.unresolved = true; continue; }
      // Revalida vínculo e estado no próprio INSERT/UPDATE, inclusive após queda.
      // created é a abertura da conversa, não a data de uma sessão reaberta.
      // Sem data própria persistida, não inventar uma sessão do passado.
      const proof = `EXISTS(SELECT 1 FROM conversation_contacts cc JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id JOIN conversations c ON c.id=cc.conversation_id AND c.profile_id=cc.profile_id WHERE cc.profile_id=? AND cc.conversation_id=? AND cc.contact_id=? AND cc.created<=? AND p.identity_state='active' AND p.namespace=CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END AND c.customer_link_state NOT IN ('blocked','excluded','ambiguous') ${row.module === "conversations" ? "AND c.epoch=0 AND c.id||':'||c.session=?" : ""})`;
      const args = [profile, row.conversation_id, row.contact_id, row.at, ...(row.module === "conversations" ? [row.id] : [])];
      if (row.module === "forms") writes.push([`UPDATE web_steps SET contact_id=? WHERE profile_id=? AND id=? AND contact_id IS NULL AND ${proof}`, [row.contact_id, profile, row.id, ...args]]);
      else writes.push([`INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) SELECT ?,?,?,?,?,?,'history:legacy',? WHERE ${proof} ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`, [profile, row.module, row.kind, row.id, row.contact_id, row.conversation_id, row.at, ...args]]);
    }
    // Uma volta vazia confirma as escritas; registros sem prova mantêm incomplete.
    const complete = rows.length === 0 && !cursor.unresolved;
    const next = rows.length < max ? { key: "", unresolved: false } : { key: rows.at(-1)!.scan_key, unresolved: cursor.unresolved };
    writes.push([`INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
      VALUES(?,'team',?,?,CASE WHEN ?=1 AND NOT EXISTS(SELECT 1 FROM (${legacySources})) THEN 1 ELSE 0 END,?)
      ON CONFLICT(profile_id,namespace,task) DO UPDATE SET cursor_json=excluded.cursor_json,complete=excluded.complete,updated=excluded.updated RETURNING complete`,
      [profile, TASK, JSON.stringify(next), complete ? 1 : 0, profile, profile, profile, profile, now()]]);
    const results = await batch(env, writes);
    return { pending: !(results.at(-1)?.results[0] as any)?.complete, statements: writes.length + 2, items: rows.length };
  },
};

function provider(module: "queue" | "forms", collection: string, source: Source): CustomerModuleProvider {
  return { async list(ctx, actor, contactId, collectionId, query) {
    if (collectionId !== collection) fail(404, "not_found");
    const result = await page(ctx.env, actor, ctx.profile, { contactId }, query, source);
    return { ...result, items: result.items.map(item => ({ id: item.sourceKey.slice(item.kind.length + 1), cells: { id: item.sourceKey.slice(item.kind.length + 1), status: item.status, occurredAt: item.occurredAt }, target: { module, resource: collection, id: item.sourceKey.slice(item.kind.length + 1) } })) };
  } };
}

installHistoryPort(customerHistory, { default: true });
registerCustomerProvider("queue", provider("queue", "tickets", "queue"));
registerCustomerProvider("forms", provider("forms", "submissions", "form"));
