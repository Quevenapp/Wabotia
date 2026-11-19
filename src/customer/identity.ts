import { cachedOne, one } from "../db";
import { ApiError, now, uid, type Conversation, type Env } from "../types";
import type { CustomerRef, IdentityPort, InboundEvidence, LinkState, Namespace, Statement } from "./contracts";
import { normalizeCustomerPhone } from "./phone";
import { maintainIdentity } from "./backfill";

export const CONTACT_TASK = "identity.contacts.v1";
export const CONVERSATION_TASK = "identity.conversations.v1";
export const namespaceOf = (c: Conversation): Namespace =>
  c.external_namespace.startsWith("app:") ? c.external_namespace as Namespace : "team";

/** Só JIDs telefônicos; LID, grupos, nomes e números de dispositivo não são telefones. */
export function phoneFromJid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(/^([1-9][0-9]{7,14})(?::[0-9]+)?@s\.whatsapp\.net$/)?.[1] ?? null;
}

// A mesma leitura também fornece a configuração da linha na entrada. O cache
// é exclusivamente o da invocação, nunca uma prova enviada pela aplicação.
export function inboundConnection(env: Env, id: string) {
  return cachedOne(env, "SELECT * FROM connections WHERE id=?", id);
}

export function evidencePhone(evidence: InboundEvidence): string | null {
  const phone = normalizeCustomerPhone(evidence.phone, "international");
  if (evidence.provider === "zernio") return phone;
  if (evidence.provider !== "qr") return null;
  const jidPhone = phoneFromJid(evidence.phoneJid);
  return jidPhone && (!phone || phone === jidPhone) ? jidPhone : null;
}

export interface ContactSnapshot {
  id: string;
  version: number;
  phone: string;
  mirror_json: string | null;
  identity_state?: string;
}
export function contactPhones(row: ContactSnapshot): string[] {
  let mirror: unknown = [];
  try { mirror = JSON.parse(row.mirror_json || "{}").phones; } catch { /* legado inválido não é prova */ }
  return [...new Set([row.phone, ...(Array.isArray(mirror) ? mirror : [])]
    .map((p) => normalizeCustomerPhone(p, "international")).filter((p): p is string => !!p))];
}

/** Falha antes de qualquer escrita se a leitura usada pelo plano envelheceu. */
export function snapshotGuard(profile: string, namespace: Namespace, rows: ContactSnapshot[], guard: string, wholeNamespace = false, condition?: Statement): Statement {
  return [
    `INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN
       NOT EXISTS(SELECT 1 FROM json_each(?) s LEFT JOIN contacts c
         ON c.id=json_extract(s.value,'$.id') AND c.profile_id=? AND c.namespace=?
         WHERE c.id IS NULL OR c.version!=json_extract(s.value,'$.version')
           OR c.phone!=json_extract(s.value,'$.phone')
           OR c.mirror_json IS NOT json_extract(s.value,'$.mirror_json')
           OR (json_type(s.value,'$.identity_state') IS NOT NULL
             AND c.identity_state IS NOT json_extract(s.value,'$.identity_state')))
       ${wholeNamespace ? "AND (SELECT count(*) FROM contacts WHERE profile_id=? AND namespace=?)=json_array_length(?)" : ""}
       ${condition ? `AND (${condition[0]})` : ""}
       THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
    [guard, JSON.stringify(rows), profile, namespace,
      ...(wholeNamespace ? [profile, namespace, JSON.stringify(rows)] : []), ...(condition?.[1] ?? [])],
  ];
}

/** Recalcula inclusive números removidos (pending), mantendo sua versão. */
export function phoneIndexStatements(profile: string, namespace: Namespace, phones: readonly string[], invalidate = true): Statement[] {
  if (!phones.length) return [];
  const values = JSON.stringify([...new Set(phones)]);
  return [
    [
      `INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state)
       SELECT ?,?,j.value,CASE WHEN count(k.contact_id)=1 THEN min(k.contact_id) ELSE NULL END,
         CASE count(k.contact_id) WHEN 0 THEN 'pending' WHEN 1 THEN 'ready' ELSE 'ambiguous' END
       FROM json_each(?) j LEFT JOIN customer_phone_candidates k
         ON k.profile_id=? AND k.namespace=? AND k.phone=j.value
       WHERE 1 GROUP BY j.value
       ON CONFLICT(profile_id,namespace,phone) DO UPDATE SET
         contact_id=excluded.contact_id,state=excluded.state,version=customer_phones.version+1`,
      [profile, namespace, values, profile, namespace],
    ],
    ...(invalidate ? [[
      `UPDATE conversations SET customer_link_state='pending'
       WHERE profile_id=? AND customer_link_state NOT IN ('blocked','excluded')
         AND verified_phone IN (SELECT value FROM json_each(?))
         AND (CASE WHEN external_namespace LIKE 'app:%' THEN external_namespace ELSE 'team' END)=?`,
      [profile, values, namespace],
    ] as Statement] : []),
  ];
}

/** Nunca altera vínculos históricos; somente a associação atual da conversa. */
export function conversationIdentityStatements(profile: string, ids: readonly string[], observed?: { phone: string; invalidate: boolean; state: LinkState }): Statement[] {
  const list = JSON.stringify(ids);
  const phone = observed ? "(SELECT phone FROM observed)" : "conversations.verified_phone";
  return [
    [
      `WITH targets AS (SELECT value id FROM json_each(?)), observed AS (SELECT ? phone)
       UPDATE conversations SET ${observed ? `
         verified_phone=CASE WHEN id IN (SELECT id FROM targets) THEN ${phone} ELSE verified_phone END,
         phone=CASE WHEN id IN (SELECT id FROM targets) THEN ${phone} ELSE phone END,` : ""}
       customer_link_state=CASE
         WHEN id NOT IN (SELECT id FROM targets) THEN 'pending'
         WHEN customer_link_state='blocked' THEN 'blocked'
         WHEN chat_type='group' OR connection_id IS NULL OR external_namespace!='channel:'||connection_id THEN 'excluded'
         WHEN ${phone} IS NULL THEN 'pending'
         WHEN EXISTS(SELECT 1 FROM customer_phones p JOIN contacts c ON c.id=p.contact_id AND c.profile_id=p.profile_id AND c.namespace=p.namespace
           WHERE p.profile_id=conversations.profile_id AND p.namespace='team' AND p.phone=${phone} AND c.identity_state!='active') THEN 'excluded'
         ELSE coalesce((SELECT state FROM customer_phones p WHERE p.profile_id=conversations.profile_id AND p.namespace='team' AND p.phone=${phone}),'pending') END
       WHERE profile_id=? AND (id IN (SELECT id FROM targets) ${observed?.invalidate ? `OR (
         verified_phone=${phone} AND external_namespace NOT LIKE 'app:%'
         AND customer_link_state NOT IN ('blocked','excluded'))` : ""})`,
      [list, observed?.phone ?? null, profile],
    ],
    // O plano de entrada ready é protegido por versão/estado no guardião:
    // o UPSERT abaixo substitui a associação atual numa única instrução.
    ...(observed?.state === "ready" ? [] : [[
      `DELETE FROM conversation_contacts WHERE profile_id=? AND conversation_id IN
       (SELECT c.id FROM conversations c WHERE c.profile_id=? AND c.id IN (SELECT value FROM json_each(?))
         AND c.external_namespace NOT LIKE 'app:%' AND (
           (c.verified_phone IS NOT NULL AND c.customer_link_state IN ('ambiguous','excluded')) OR
           (c.customer_link_state='ready' AND conversation_contacts.contact_id IS NOT
             (SELECT p.contact_id FROM customer_phones p WHERE p.profile_id=c.profile_id AND p.namespace='team' AND p.phone=c.verified_phone))))`,
      [profile, profile, list],
    ] as Statement]),
    [
      `INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created)
       SELECT c.id,c.profile_id,p.contact_id,'identity',? FROM conversations c JOIN customer_phones p
         ON p.profile_id=c.profile_id AND p.namespace='team' AND p.phone=c.verified_phone AND p.state='ready'
       WHERE c.profile_id=? AND c.id IN (SELECT value FROM json_each(?)) AND c.customer_link_state='ready'
       ON CONFLICT(conversation_id) DO UPDATE SET contact_id=excluded.contact_id,
         linked_by=excluded.linked_by,created=excluded.created
         WHERE conversation_contacts.contact_id IS NOT excluded.contact_id`,
      [now(), profile, list],
    ],
    sessionStatement(profile, ids),
  ];
}

export function sessionStatement(profile: string, ids: readonly string[]): Statement {
  return [
    `INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at)
     SELECT c.profile_id,'core','conversation',c.id||':'||c.session,l.contact_id,c.id,'identity',?
       FROM conversations c JOIN conversation_contacts l ON l.conversation_id=c.id AND l.profile_id=c.profile_id
       JOIN contacts k ON k.id=l.contact_id AND k.profile_id=c.profile_id AND k.namespace='team' AND k.identity_state='active'
       WHERE c.profile_id=? AND c.id IN (SELECT value FROM json_each(?)) AND c.customer_link_state='ready'
       ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`,
    [now(), profile, JSON.stringify(ids)],
  ];
}

async function resolve(env: Env, c: Conversation): Promise<CustomerRef> {
  const namespace = namespaceOf(c);
  const ref: CustomerRef = { profileId: c.profile_id, namespace, state: "pending", contactId: null, verifiedPhone: null, version: null, erp: null };
  if (c.chat_type === "group") return { ...ref, state: "excluded" };
  const row = await one(env,
    `SELECT v.customer_link_state,v.verified_phone,v.connection_id,v.external_namespace,v.chat_type,
       k.id,k.version,k.identity_state,k.erp_contact_id,k.erp_version,p.contact_id phone_contact,p.state phone_state
     FROM conversations v LEFT JOIN conversation_contacts l ON l.conversation_id=v.id AND l.profile_id=v.profile_id
     LEFT JOIN contacts k ON k.id=l.contact_id AND k.profile_id=v.profile_id AND k.namespace=?
     LEFT JOIN customer_phones p ON p.profile_id=v.profile_id AND p.namespace=? AND p.phone=v.verified_phone
     WHERE v.id=? AND v.profile_id=? AND v.external_namespace=?`,
    namespace, namespace, c.id, c.profile_id, c.external_namespace);
  if (!row) return ref;
  ref.state = row.customer_link_state;
  ref.verifiedPhone = namespace === "team" ? normalizeCustomerPhone(row.verified_phone, "international") : null;
  if (row.chat_type === "group" || (row.id && row.identity_state !== "active"))
    return { ...ref, state: "excluded", verifiedPhone: null };
  if (ref.state !== "ready") return ref;
  if (!row.id || (namespace === "team" && (!row.connection_id ||
      row.external_namespace !== `channel:${row.connection_id}` || !ref.verifiedPhone ||
      row.phone_state !== "ready" || row.phone_contact !== row.id)))
    return { ...ref, state: "pending" };
  return { ...ref, contactId: row.id, version: row.version,
    erp: row.erp_contact_id && row.erp_version !== null ? { id: row.erp_contact_id, version: row.erp_version } : null };
}

async function prepareInbound(env: Env, c: Conversation, evidence: InboundEvidence) {
  const eligible = c.chat_type !== "group" && !!c.connection_id && c.external_namespace === `channel:${c.connection_id}`;
  const connection = eligible ? await inboundConnection(env, c.connection_id!) : null;
  const trusted = eligible && connection?.profile_id === c.profile_id &&
    connection.kind === evidence.provider && ["qr", "zernio"].includes(connection.kind);
  const phone = trusted ? evidencePhone(evidence) : null;
  const simple = (state: LinkState, verifiedPhone: string | null) => ({ state, verifiedPhone,
    statements: [["UPDATE conversations SET verified_phone=?,customer_link_state=? WHERE id=? AND profile_id=?",
      [verifiedPhone, state, c.id, c.profile_id]]] as Statement[] });
  if (c.customer_link_state === "blocked") return simple("blocked", phone);
  if (!trusted) return simple("excluded", null);
  if (!phone) return simple("pending", null);
  // A invalidação do índice ocorre no mesmo lote de quem o altera. O objeto
  // Coordinator serializa os comandos da área e só passa conversas relidas.
  if (c.customer_link_state === "ready" && c.verified_phone === phone)
    return { statements: [], state: "ready" as const, verifiedPhone: phone };

  const profile = c.profile_id, namespace: Namespace = "team";
  const snapshot = await one(env,
    `SELECT p.state,p.contact_id,p.version,
       (SELECT identity_state FROM contacts WHERE id=p.contact_id AND profile_id=p.profile_id AND namespace=p.namespace) contact_state,
       coalesce((SELECT complete FROM customer_progress WHERE profile_id=? AND namespace=? AND task=?),0) complete,
       (SELECT json_group_array(contact_id) FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND phone=?) candidates,
       CASE WHEN coalesce((SELECT complete FROM customer_progress WHERE profile_id=? AND namespace=? AND task=?),0)=0
         THEN (SELECT json_group_array(json_object('id',id,'version',version,'phone',phone,'mirror_json',mirror_json,'identity_state',identity_state)) FROM contacts WHERE profile_id=? AND namespace=?) ELSE '[]' END legacy
     FROM (SELECT 1) LEFT JOIN customer_phones p ON p.profile_id=? AND p.namespace=? AND p.phone=?`,
    profile, namespace, CONTACT_TASK, profile, namespace, phone,
    profile, namespace, CONTACT_TASK, profile, namespace, profile, namespace, phone);
  const legacy: ContactSnapshot[] = JSON.parse(snapshot.legacy);
  const existing: string[] = JSON.parse(snapshot.candidates);
  const missing = legacy.filter((r) => contactPhones(r).includes(phone) && !existing.includes(r.id));
  const guard = `identity:${c.id}:${c.session}:${phone}`;
  // Uma só asserção protege o legado, a versão do índice e a restrição do
  // contato escolhido, inclusive quando o preenchimento já terminou.
  const statements: Statement[] = [snapshotGuard(profile, namespace, legacy, guard, !snapshot.complete, [
    `(SELECT version FROM customer_phones WHERE profile_id=? AND namespace=? AND phone=?) IS ?
     AND (SELECT identity_state FROM contacts WHERE id=? AND profile_id=? AND namespace=?) IS ?`,
    [profile, namespace, phone, snapshot.version ?? null, snapshot.contact_id ?? null, profile, namespace, snapshot.contact_state ?? null],
  ])];
  if (missing.length) statements.push([
    `INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin)
     SELECT ?,?,?,value,'legacy' FROM json_each(?) WHERE 1 ON CONFLICT DO NOTHING`,
    [profile, namespace, phone, JSON.stringify(missing.map((r) => r.id))],
  ]);
  const create = !snapshot.contact_id && existing.length + missing.length === 0;
  if (create) {
    // O índice condicionado e a inbox garantem repetição, não um ID derivado
    // do telefone: um número removido pode passar a pertencer a outra pessoa.
    const id = uid();
    statements.push([
      `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
       VALUES(?,?,?,'',?,?,'automatic','identity','identity',?,?)`,
      [id, profile, namespace, phone, phone, now(), now()],
    ], [
      `INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin)
       VALUES(?,?,?,?,'observed') ON CONFLICT DO NOTHING`,
      [profile, namespace, phone, id],
    ]);
  }
  const total = existing.length + missing.length + (create ? 1 : 0);
  const recalculated = create || missing.length > 0 || !snapshot.state;
  let state: LinkState = recalculated ? (total > 1 ? "ambiguous" : total === 1 ? "ready" : "pending") : snapshot.state;
  const candidateState = missing.length === 1 && !existing.length ? missing[0].identity_state : snapshot.contact_state;
  if (state === "ready" && candidateState && candidateState !== "active") state = "excluded";
  // A invalidação das outras conversas e a resolução desta compartilham
  // um UPDATE no mesmo lote do índice, sem dispensar nenhuma invalidação.
  if (recalculated) statements.push(...phoneIndexStatements(profile, namespace, [phone], false));
  statements.push(...conversationIdentityStatements(profile, [c.id], { phone, invalidate: recalculated, state }), [
    "DELETE FROM customer_assert WHERE id=?", [guard],
  ]);
  return { statements, state, verifiedPhone: phone };
}

async function indexContact(env: Env, input: Parameters<IdentityPort["indexContact"]>[1]): Promise<Statement[]> {
  const { profileId, namespace, contactId, origin } = input;
  const phones = [...new Set(input.phones.map((value) => {
    const phone = normalizeCustomerPhone(value, "international");
    if (!phone) throw new ApiError(400, "invalid_customer_patch", "Telefone inválido.");
    return phone;
  }))];
  const old = await one(env,
    `SELECT json_group_array(phone) phones FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND contact_id=?`,
    profileId, namespace, contactId);
  const previous: string[] = JSON.parse(old.phones);
  if (previous.length === phones.length && phones.every((phone) => previous.includes(phone))) return [[
    `UPDATE conversations SET customer_link_state='pending' WHERE profile_id=?
      AND customer_link_state NOT IN ('blocked','excluded') AND id IN
      (SELECT l.conversation_id FROM conversation_contacts l JOIN contacts c
        ON c.id=l.contact_id AND c.profile_id=l.profile_id AND c.namespace=?
        WHERE l.profile_id=? AND l.contact_id=?)`,
    [profileId, namespace, profileId, contactId],
  ]];
  const affected = [...new Set<string>([...previous, ...phones])];
  return [
    ["DELETE FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND contact_id=?", [profileId, namespace, contactId]],
    [`INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin)
      SELECT c.profile_id,c.namespace,j.value,c.id,? FROM contacts c,json_each(?) j
      WHERE c.id=? AND c.profile_id=? AND c.namespace=?`,
    [origin, JSON.stringify(phones), contactId, profileId, namespace]],
    ...phoneIndexStatements(profileId, namespace, affected),
  ];
}

export const customerIdentity: IdentityPort = { resolve, prepareInbound, indexContact, maintain: maintainIdentity };
