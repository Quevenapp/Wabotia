import { all, batch, one } from "../db";
import { allows } from "../access";
import { canProfile, seal, unseal } from "../security";
import { boundAllows, isBound, visibleConversation } from "../visibility";
import { moduleStates } from "../modules/registry";
import { ApiError, type Actor, type Conversation, type Env, now } from "../types";
import type { CustomerMemory, CustomerRef, HistoryItem, HistoryPort, Statement } from "./contracts";
import type { CustomerModuleProvider } from "./profile-contracts";
import { identityPort, installHistoryPort, registerCustomerProvider, resolveCustomer } from "./ports";

const TASK = "history:v1";
// Convenções de customer_records (fontes sem contact_id):
// conversations/session → conversationId:session; tickets/ticket → ticket.id;
// queue/ticket → queue_tickets.id. O produtor deve gravar o vínculo no seu lote.
const namespaceOf = (c: Conversation) => c.external_namespace.startsWith("app:") ? c.external_namespace : "team";
// As duas chaves representam a mesma sessão. Conflito nunca escolhe um dono.
export const sessionRecords = `SELECT profile_id,record_id,min(conversation_id) conversation_id,
  min(contact_id) contact_id,min(occurred_at) occurred_at,
  count(DISTINCT contact_id)=1 AND count(DISTINCT conversation_id)=1 AND count(conversation_id)=count(*)
    AND min(substr(record_id,1,length(conversation_id)+1)=conversation_id||':') valid
  FROM customer_records WHERE (module_id='conversations' AND kind='session') OR (module_id='core' AND kind='conversation')
  GROUP BY profile_id,record_id`;

/** Continuidade de origem legada, sem usar telefone cadastral como credencial. */
export const legacyHistoryProof = (c: string, at: string, initialSession = true) => `
  (${c}.epoch=0 ${initialSession ? "" : `OR EXISTS(SELECT 1 FROM conversation_contacts l WHERE l.profile_id=${c}.profile_id AND l.conversation_id=${c}.id AND l.created<=${at})`}) AND ${c}.created<=${at}
  AND ${c}.chat_type<>'group' AND ${c}.customer_link_state NOT IN ('blocked','excluded','ambiguous')
  AND ${c}.connection_id IS NOT NULL AND ${c}.external_namespace='channel:'||${c}.connection_id
  AND NOT EXISTS(SELECT 1 FROM conversation_contacts l LEFT JOIN contacts p ON p.id=l.contact_id AND p.profile_id=l.profile_id
    WHERE l.profile_id=${c}.profile_id AND l.conversation_id=${c}.id AND (l.created>${at} OR p.identity_state<>'active'))
  AND (EXISTS(SELECT 1 FROM conversation_contacts l WHERE l.profile_id=${c}.profile_id AND l.conversation_id=${c}.id AND l.created<=${c}.created)
    OR EXISTS(SELECT 1 FROM messages m WHERE m.profile_id=${c}.profile_id AND m.conversation_id=${c}.id AND m.direction='in' AND m.created<=${at}))`;
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
    excluded = c.chat_type === "group" || ["blocked", "excluded", "ambiguous"].includes(ref.state) || ["blocked", "excluded", "ambiguous"].includes(c.customer_link_state ?? "pending");
    contactId = ref.state === "ready" ? ref.contactId : null;
    // Ambiguidade impede a leitura, mas continua sendo uma pendência de identidade.
    incomplete = c.chat_type !== "group" && (ref.state === "ambiguous" || c.customer_link_state === "ambiguous" || (ref.state !== "ready" && !excluded));
    // Um vínculo restrito não pode reaparecer como fallback legado.
    const historical = await customerTextScope(env, c, ref);
    excluded ||= historical?.allowed === false;
    if (historical?.restricted) incomplete = false;
    if (!contactId && historical?.proven) {
      contactId = historical.contactId;
      incomplete = false;
    }
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
    if (contact.identity_state !== "active") incomplete = false;
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
        FROM (${sessionRecords}) r JOIN conversations c ON c.id=r.conversation_id AND c.profile_id=r.profile_id
        JOIN contacts p ON p.id=r.contact_id AND p.profile_id=r.profile_id
        WHERE r.profile_id=? AND r.valid AND p.identity_state='active' AND p.namespace=?
        AND r.contact_id=? AND (? IS NULL OR c.id=?)
        AND p.namespace=CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END`;
      const sessionParams = [profile, scope.namespace, scope.contactId, scope.conversationId, scope.conversationId];
      if (scope.conversationId) {
        sessions += ` UNION ALL SELECT 'conversation','conversation:'||c.id||':'||c.session,c.created,c.state,c.id,'conversations','conversations'
          FROM conversations c WHERE c.profile_id=? AND c.id=? AND ${legacyHistoryProof("c", "c.created")}
          AND NOT EXISTS(SELECT 1 FROM (${sessionRecords}) r WHERE r.profile_id=c.profile_id AND (r.conversation_id=c.id OR r.record_id=c.id||':'||c.session))`;
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
      AND ((${contact}=? AND p.namespace=? AND p.identity_state='active') OR (${contact} IS NULL AND s.conversation_id=?
        AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=s.conversation_id AND c.profile_id=s.profile_id AND ${legacyHistoryProof("c", date, false)}
          AND NOT EXISTS(SELECT 1 FROM (${sessionRecords}) h WHERE h.profile_id=c.profile_id AND h.conversation_id=c.id AND (NOT h.valid OR h.contact_id IS NOT ?)))))
      AND (? IS NULL OR s.conversation_id=?)`,
    [profile, scope.contactId, scope.namespace, scope.conversationId, scope.contactId, scope.conversationId, scope.conversationId]);
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
      AND (? IS NULL OR conversation_id=?)) incomplete`, profile, TASK, profile, profile, profile, profile, profile, JSON.stringify(modules), cut,
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
  if (scope.excluded) return { items: [], nextCursor: null, incomplete: scope.incomplete };
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

const privateKeys = new Set(["answers", "checkin_answers", "checkinAnswers", "result_cipher", "payload_cipher", "identity_cipher", "local_patch_cipher", "notes", "internal_notes", "internalNotes", "paid_note", "medical_record", "medicalRecord", "prontuario", "customer_history", "customerHistory", "form_submissions", "web_steps", "web_step_id", "webStepId"]);
const privateModules = new Set(["saude", "ensino", "juridico"]);
const privateOrigin = (value: any, depth = 0): boolean => !!value && typeof value === "object" && (depth > 20 ||
  privateModules.has(value.module_id) || privateModules.has(value.module) || value.module_id === "forms" || value.module === "forms" ||
  value.private === true || value.direction === "note" || value.internal === true || value.internal === 1 ||
  Object.keys(value).some(key => privateKeys.has(key) || privateModules.has(key)) ||
  [value.source_key, value.sourceKey, value.automation, value.kind, value.source, value.origin, value.id, value.document_id].some(key => typeof key === "string" && /(?:^|:)(?:saude|ensino|juridico|forms|form|flow_reply|web_step)(?::|$)/.test(key)) ||
  [value.content, value.source, value.origin, value.metadata, value.target].some(entry => privateOrigin(entry, depth + 1))
);
/** Retira dados privados estruturados antes de qualquer máscara, inclusive com ela desligada. */
export function projectCustomerInput(input: string): string {
  // Uma projeção anterior pode ter copiado o mesmo texto para history/sources.
  // Recolhe valores privados antes de remover seus invólucros.
  const secrets = new Set<string>();
  const collect = (value: any, hidden = false, depth = 0): void => {
    if (depth > 20) return;
    if (typeof value === "string") {
      if (hidden && value.trim().length >= 4) secrets.add(value);
      if (/^\s*[\[{]/.test(value)) { try { collect(JSON.parse(value), hidden, depth + 1); } catch { /* texto comum */ } }
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) collect(entry, hidden || privateKeys.has(key) || privateModules.has(key) ||
      ((key === "text" || key === "result" || key === "body") && privateOrigin(value)), depth + 1);
  };
  const clean = (value: any, depth = 0): any => {
    if (depth > 20) return undefined;
    if (typeof value === "string") {
      // JSON serializado continua sujeito à mesma projeção.
      if (/^\s*[\[{]/.test(value)) { try { return JSON.stringify(clean(JSON.parse(value), depth + 1) ?? {}); } catch { /* texto comum */ } }
      if ([...secrets].some(secret => value.includes(secret))) return undefined;
      return value;
    }
    if (!value || typeof value !== "object") return value;
    if (privateModules.has(value.module_id) || privateModules.has(value.module) || value.private === true || value.direction === "note" || value.internal === true || value.internal === 1) return undefined;
    if (("text" in value || "body" in value || "result" in value) && privateOrigin(value)) return undefined;
    if (Array.isArray(value)) return value.map(entry => clean(entry, depth + 1)).filter(v => v !== undefined);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key) && !privateModules.has(key) && !/_(cipher|enc)$/.test(key)).map(([key, entry]) => [key, key === "customerMemory" || key === "customer_memory" ? projectCustomerMemory(entry) : clean(entry, depth + 1)]).filter(([, entry]) => entry !== undefined));
  };
  try { const value = JSON.parse(input); collect(value); return JSON.stringify(clean(value) ?? {}); } catch { return input; }
}

/** Releitura sem cache: associação e restrição podem mudar depois de criar um run. */
export async function customerTextScope(env: Env, c: Pick<Conversation, "id" | "profile_id">, resolved?: CustomerRef) {
  const row = await one(env, `SELECT c.*,l.contact_id linked_contact,l.created linked_at,p.identity_state,p.namespace contact_namespace,
    s.contact_id session_contact,s.occurred_at session_at,s.valid session_valid,
    EXISTS(SELECT 1 FROM (${sessionRecords}) h WHERE h.profile_id=c.profile_id AND h.conversation_id=c.id) has_sessions,
    (${legacyHistoryProof("c", "c.created")}) legacy
    FROM conversations c LEFT JOIN conversation_contacts l ON l.profile_id=c.profile_id AND l.conversation_id=c.id
    LEFT JOIN (${sessionRecords}) s ON s.profile_id=c.profile_id AND s.record_id=c.id||':'||c.session
    LEFT JOIN contacts p ON p.profile_id=c.profile_id AND p.id=coalesce(l.contact_id,c.customer_identity_proof,s.contact_id)
    WHERE c.profile_id=? AND c.id=?`, c.profile_id, c.id);
  if (!row) return null;
  const ref = resolved ?? await identityPort.resolve(env, row);
  // Grupos/aplicações sem cadastro continuam podendo fazer a interação atual.
  // "excluded" nesses canais significa que não participam da identidade pessoal.
  const nonCustomer = (row.chat_type === "group" || row.external_namespace.startsWith("app:")) && !row.linked_contact && !row.has_sessions;
  const denied = nonCustomer ? ["blocked", "ambiguous"] : ["blocked", "excluded", "ambiguous"];
  // A recusa por ambiguidade conserva a pendência; restrição do titular a encerra.
  const restricted = !!row.identity_state && row.identity_state !== "active";
  const allowed = ref.profileId === row.profile_id && ref.namespace === namespaceOf(row) &&
    !denied.includes(row.customer_link_state) && !denied.includes(ref.state) && !restricted;
  // Sessão persistida autoriza seu próprio histórico mesmo durante o backfill
  // telefônico. Isso não promove a identidade nem concede acesso a outro canal.
  const sessionOwner = row.session_valid && row.verified_phone && row.phone === row.verified_phone &&
    row.connection_id && row.external_namespace === `channel:${row.connection_id}` &&
    (!row.linked_contact || row.linked_contact === row.session_contact) && row.identity_state === "active" && row.contact_namespace === "team"
    ? row.session_contact : null;
  const contactId = ref.state === "ready" ? ref.contactId : sessionOwner;
  const proven = allowed && row.chat_type !== "group" && (row.session_contact
    ? !!row.session_valid && !!contactId && row.session_contact === contactId
    : !!row.legacy && !row.has_sessions && (!contactId || row.linked_contact === contactId));
  const since = row.session_at ?? row.created;
  // Também fixa associação pendente; trocar A por B invalida um run da mesma época.
  const proof = JSON.stringify([row.session, contactId, row.linked_contact, row.linked_at, row.session_contact, row.session_valid, since,
    row.customer_link_state, ref.state, row.identity_state]);
  return { allowed, proven, proof, since, contactId, restricted, conflict: !!row.session_contact && (!row.session_valid || row.session_contact !== contactId), conversation: row as Conversation };
}

/** Filtra procedência antes de selecionar texto e antes do LIMIT. */
export async function customerTextHistory(env: Env, c: Pick<Conversation, "id" | "profile_id">, scope?: Awaited<ReturnType<typeof customerTextScope>>, cut = now()) {
  scope ??= await customerTextScope(env, c);
  if (!scope?.proven) return [];
  const rows = await all(env, `SELECT m.direction,m.text FROM messages m
    WHERE m.profile_id=? AND m.conversation_id=? AND m.direction IN ('in','out','customer','agent','bot') AND m.created>=? AND m.created<=?
      AND (json_extract(m.content,'$.customerSession')=? OR (json_extract(m.content,'$.customerSession') IS NULL AND m.created>?))
      AND NOT EXISTS(SELECT 1 FROM json_tree(m.content) j WHERE j.key IN (SELECT value FROM json_each(?))
        OR (j.key IN ('module','module_id','automation','kind','type','source','origin') AND j.value IN ('saude','ensino','juridico','forms','form','flow_reply','web_step'))
        OR (j.key IN ('private','internal') AND j.value=1))
      AND coalesce(m.source_key,'') NOT GLOB '*saude:*' AND coalesce(m.source_key,'') NOT GLOB '*ensino:*'
      AND coalesce(m.source_key,'') NOT GLOB '*juridico:*' AND coalesce(m.source_key,'') NOT GLOB '*web_step:*'
    ORDER BY m.created DESC,m.rowid DESC LIMIT 12`, c.profile_id, c.id, scope.since, cut, scope.conversation.session, scope.since, JSON.stringify([...privateKeys, ...privateModules, "web_step_id"]));
  return JSON.parse(projectCustomerInput(JSON.stringify({ history: rows.reverse() }))).history;
}

/**
 * Reconstrução só por vínculo explícito preexistente, nunca por telefone.
 * A data do vínculo precisa anteceder o registro; reassociação posterior não
 * atribui fatos antigos ao novo contato. Sem prova, fica pendente e revisita.
 * O checkpoint e as atribuições condicionais pertencem ao mesmo lote D1.
 */
const legacySources = `
  SELECT 'conversations' module,'session' kind,r.record_id id,r.conversation_id,r.occurred_at at,r.contact_id,r.occurred_at linked_at,p.namespace,1 old_key,
    EXISTS(SELECT 1 FROM customer_records k WHERE k.profile_id=r.profile_id AND k.module_id='conversations' AND k.kind='session' AND k.record_id=r.record_id AND (k.contact_id<>r.contact_id OR k.conversation_id IS NOT r.conversation_id)) conflict
    FROM customer_records r JOIN contacts p ON p.id=r.contact_id AND p.profile_id=r.profile_id
    WHERE r.profile_id=? AND r.module_id='core' AND r.kind='conversation'
      AND NOT EXISTS(SELECT 1 FROM customer_records k WHERE k.profile_id=r.profile_id AND k.module_id='conversations' AND k.kind='session' AND k.record_id=r.record_id AND k.contact_id=r.contact_id AND k.conversation_id IS r.conversation_id)
  UNION ALL SELECT 'conversations','session',c.id||':'||c.session,c.id,c.created,cc.contact_id,cc.created,p.namespace,0,0
    FROM conversations c LEFT JOIN conversation_contacts cc ON cc.conversation_id=c.id AND cc.profile_id=c.profile_id LEFT JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id AND p.identity_state='active'
    WHERE c.profile_id=? AND c.chat_type<>'group' AND NOT EXISTS(SELECT 1 FROM (${sessionRecords}) r WHERE r.profile_id=c.profile_id AND r.record_id=c.id||':'||c.session)
  UNION ALL SELECT 'tickets','ticket',s.id,s.conversation_id,s.created,cc.contact_id,cc.created,p.namespace,0,0 FROM tickets s LEFT JOIN conversation_contacts cc ON cc.conversation_id=s.conversation_id AND cc.profile_id=s.profile_id LEFT JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id AND p.identity_state='active' WHERE s.profile_id=? AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=s.profile_id AND r.module_id='tickets' AND r.kind='ticket' AND r.record_id=s.id)
  UNION ALL SELECT 'queue','ticket',s.id,s.conversation_id,s.created_at,cc.contact_id,cc.created,p.namespace,0,0 FROM queue_tickets s LEFT JOIN conversation_contacts cc ON cc.conversation_id=s.conversation_id AND cc.profile_id=s.profile_id LEFT JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id AND p.identity_state='active' WHERE s.profile_id=? AND NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=s.profile_id AND r.module_id='queue' AND r.kind='ticket' AND r.record_id=s.id)
  UNION ALL SELECT 'forms','form',s.id,s.conversation_id,s.created,cc.contact_id,cc.created,p.namespace,0,0 FROM web_steps s LEFT JOIN conversation_contacts cc ON cc.conversation_id=s.conversation_id AND cc.profile_id=s.profile_id LEFT JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id AND p.identity_state='active' WHERE s.profile_id=? AND s.module_id='forms' AND s.kind='form' AND s.contact_id IS NULL`;

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
    let cursor = { key: "", unresolved: false, revisitAt: 0 };
    if (progress) { try { cursor = JSON.parse(progress.cursor_json); } catch { /* reinicia com segurança */ } }
    // Uma passagem terminada conserva pendências, mas só as revisita no cron.
    // Até lá continua após a última chave para alcançar novas origens.
    if (cursor.revisitAt && cursor.revisitAt <= now()) cursor = { key: "", unresolved: false, revisitAt: 0 };
    const rows = await all(env, `SELECT *,module||':'||kind||':'||id scan_key FROM (${legacySources}) WHERE module||':'||kind||':'||id>? ORDER BY scan_key LIMIT ?`, profile, profile, profile, profile, profile, cursor.key || "", max);
    const writes: Statement[] = [];
    for (const row of rows) {
      if (row.old_key) {
        if (row.conflict || !row.conversation_id || !row.id.startsWith(`${row.conversation_id}:`)) { cursor.unresolved = true; continue; }
        // Copia a prova original, inclusive data e autor; nunca resolve pelo vínculo atual.
        writes.push([`INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at)
          SELECT profile_id,'conversations','session',record_id,contact_id,conversation_id,linked_by,occurred_at
          FROM customer_records WHERE profile_id=? AND module_id='core' AND kind='conversation' AND record_id=?
          ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`, [profile, row.id]]);
        continue;
      }
      if (!row.namespace || !row.contact_id || row.linked_at > row.at) { cursor.unresolved = true; continue; }
      // Revalida vínculo e estado no próprio INSERT/UPDATE, inclusive após queda.
      // created é a abertura da conversa, não a data de uma sessão reaberta.
      // Sem data própria persistida, não inventar uma sessão do passado.
      const proof = `EXISTS(SELECT 1 FROM conversation_contacts cc JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id JOIN conversations c ON c.id=cc.conversation_id AND c.profile_id=cc.profile_id CROSS JOIN (SELECT ? at) origin WHERE cc.profile_id=? AND cc.conversation_id=? AND cc.contact_id=? AND cc.created<=origin.at AND p.identity_state='active' AND p.namespace=CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END AND ${legacyHistoryProof("c", "origin.at", row.module === "conversations")}
        AND NOT EXISTS(SELECT 1 FROM (${sessionRecords}) h WHERE h.profile_id=c.profile_id AND h.conversation_id=c.id AND (NOT h.valid OR h.contact_id<>cc.contact_id)) ${row.module === "conversations" ? "AND c.id||':'||c.session=?" : ""})`;
      const args = [row.at, profile, row.conversation_id, row.contact_id, ...(row.module === "conversations" ? [row.id] : [])];
      if (row.module === "forms") writes.push([`UPDATE web_steps SET contact_id=? WHERE profile_id=? AND id=? AND contact_id IS NULL AND ${proof}`, [row.contact_id, profile, row.id, ...args]]);
      else writes.push([`INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) SELECT ?,?,?,?,?,?,'history:legacy',? WHERE ${proof} ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`, [profile, row.module, row.kind, row.id, row.contact_id, row.conversation_id, row.at, ...args]]);
    }
    // O checkpoint avança até o último item examinado, mesmo sem atribuição.
    const next = { key: rows.at(-1)?.scan_key ?? cursor.key, unresolved: cursor.unresolved,
      revisitAt: cursor.revisitAt || (rows.length < max ? now() + 300000 : 0) };
    writes.push([`INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
      SELECT ?,'team',?,json_set(?,'$.unresolved',json(CASE WHEN incomplete THEN 'true' ELSE 'false' END)),1-incomplete,?
      FROM (SELECT EXISTS(SELECT 1 FROM (${legacySources})) incomplete) WHERE 1
      ON CONFLICT(profile_id,namespace,task) DO UPDATE SET cursor_json=excluded.cursor_json,complete=excluded.complete,updated=excluded.updated RETURNING complete`,
      [profile, TASK, JSON.stringify(next), now(), profile, profile, profile, profile, profile]]);
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
