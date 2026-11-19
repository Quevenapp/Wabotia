import { cachedOne, one } from "../db";
import { ApiError, now, uid, type Conversation, type Env } from "../types";
import type { CustomerRef, IdentityPort, InboundEvidence, LinkState, Namespace, Statement } from "./contracts";
import { normalizeCustomerPhone, customerPhoneVariants, customerPhoneInputMode } from "./phone";
import { maintainIdentity } from "./backfill";

export const CONTACT_TASK = "identity.contacts.v1";
export const CONVERSATION_TASK = "identity.conversations.v2";
export const PROOF_TASK = "identity.proofs.v1";
export const LEGACY_PAGE = 20;
export const legacyPhoneSql = "replace(replace(replace(replace(replace(replace(phone,' ',''),'.',''),'-',''),'(',''),')',''),'+','')";
export const identityOwner = (c: Conversation) => (c as Conversation & { customer_identity_proof?: string | null }).customer_identity_proof ?? null;
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
  if (evidence.provider === "zernio" || evidence.provider === "meta") return phone;
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
  source?: string;
}
export function contactPhones(row: ContactSnapshot): string[] {
  let mirror: unknown = [];
  try { mirror = JSON.parse(row.mirror_json || "{}").phones; } catch { /* legado inválido não é prova */ }
  const mode = row.source !== "automatic" && !row.mirror_json ? customerPhoneInputMode(row.phone) : "international";
  return [...new Set([normalizeCustomerPhone(row.phone, mode),
    ...(Array.isArray(mirror) ? mirror.map(p => normalizeCustomerPhone(p, "international")) : [])]
    .filter((p): p is string => !!p))];
}

/** Falha antes de qualquer escrita se a leitura usada pelo plano envelheceu. */
export function snapshotGuard(profile: string, namespace: Namespace, rows: ContactSnapshot[], guard: string, _wholeNamespace = false, condition?: Statement): Statement {
  return [
    `INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN
       NOT EXISTS(SELECT 1 FROM json_each(?) s LEFT JOIN contacts c
         ON c.id=json_extract(s.value,'$.id') AND c.profile_id=? AND c.namespace=?
         WHERE c.id IS NULL OR c.version!=json_extract(s.value,'$.version')
           OR c.phone!=json_extract(s.value,'$.phone')
           OR json_extract(c.mirror_json,'$.phones') IS NOT json_extract(json_extract(s.value,'$.mirror_json'),'$.phones')
           OR (json_type(s.value,'$.identity_state') IS NOT NULL
             AND c.identity_state IS NOT json_extract(s.value,'$.identity_state')))
       AND NOT EXISTS(SELECT 1 FROM json_each(?) s,json_each(s.value,'$.proofs') q
         LEFT JOIN customer_phone_proofs p ON p.profile_id=? AND p.namespace=?
           AND p.contact_id=json_extract(s.value,'$.id') AND p.phone=json_extract(q.value,'$.phone')
         WHERE p.revoked IS NOT json_extract(q.value,'$.revoked'))
       ${condition ? `AND (${condition[0]})` : ""}
       THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
    [guard, JSON.stringify(rows), profile, namespace, JSON.stringify(rows), profile, namespace,
      ...(condition?.[1] ?? [])],
  ];
}

/** Candidato único só fica pronto quando já possui prova não revogada. */
export function phoneIndexStatements(profile: string, namespace: Namespace, phones: readonly string[], invalidate = true): Statement[] {
  if (!phones.length) return [];
  const values = JSON.stringify([...new Set(phones)]);
  return [[
    `WITH summary AS (
       SELECT j.value phone,
         (SELECT count(*) FROM (SELECT contact_id FROM customer_phone_candidates
           WHERE profile_id=? AND namespace=? AND phone=j.value LIMIT 2)) n,
         (SELECT contact_id FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND phone=j.value LIMIT 1) contact_id
       FROM json_each(?) j
     ) INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state)
     SELECT ?,?,s.phone,CASE WHEN s.n=1 AND q.contact_id IS NOT NULL THEN s.contact_id END,
       CASE WHEN s.n>1 THEN 'ambiguous' WHEN q.contact_id IS NOT NULL AND s.n=1 THEN 'ready' ELSE 'pending' END
       FROM summary s LEFT JOIN customer_phone_proofs q ON q.profile_id=? AND q.namespace=?
         AND q.phone=s.phone AND q.contact_id=s.contact_id AND q.revoked=0 WHERE 1
     ON CONFLICT(profile_id,namespace,phone) DO UPDATE SET
       contact_id=excluded.contact_id,state=excluded.state,version=customer_phones.version+1
       WHERE customer_phones.contact_id IS NOT excluded.contact_id OR customer_phones.state!=excluded.state`,
    [profile, namespace, profile, namespace, values, profile, namespace, profile, namespace],
  ], ...(invalidate ? [[
    `UPDATE conversations SET customer_link_state='pending',customer_identity_proof=NULL
     WHERE profile_id=? AND verified_phone IN (SELECT value FROM json_each(?))
       AND customer_link_state NOT IN ('blocked','excluded') AND external_namespace NOT LIKE 'app:%'`,
    [profile, values],
  ] as Statement] : [])];
}

/** Atualiza só o vínculo atual. Registros históricos nunca são reapontados. */
export function conversationIdentityStatements(profile: string, ids: readonly string[], observed?: { phone: string; invalidate: boolean; state: LinkState; session?: boolean }): Statement[] {
  const list = JSON.stringify(ids);
  return [[
    `UPDATE conversations SET
       ${observed ? "phone=?,verified_phone=?," : "verified_phone=CASE WHEN external_namespace LIKE 'app:%' THEN NULL ELSE verified_phone END,"}
       customer_identity_proof=CASE WHEN chat_type='direct' AND external_namespace='channel:'||connection_id AND customer_link_state NOT IN ('blocked','excluded') THEN (SELECT k.id FROM customer_phones p JOIN customer_phone_proofs q
         ON q.profile_id=p.profile_id AND q.namespace=p.namespace AND q.phone=p.phone AND q.contact_id=p.contact_id AND q.revoked=0
         JOIN contacts k ON k.id=p.contact_id AND k.profile_id=p.profile_id AND k.identity_state='active'
         WHERE p.profile_id=conversations.profile_id AND p.namespace='team' AND p.phone=${observed ? "?" : "conversations.verified_phone"} AND p.state='ready') ELSE NULL END,
       customer_link_state=CASE
         WHEN customer_link_state='blocked' THEN 'blocked'
         WHEN customer_link_state='excluded' THEN 'excluded'
         WHEN chat_type='group' THEN 'excluded'
         WHEN external_namespace LIKE 'app:%' THEN CASE
           WHEN EXISTS(SELECT 1 FROM conversation_contacts l JOIN contacts k ON k.id=l.contact_id AND k.profile_id=l.profile_id
             WHERE l.conversation_id=conversations.id AND l.profile_id=conversations.profile_id AND k.namespace=conversations.external_namespace AND k.identity_state='active')
             AND customer_link_state!='excluded' THEN 'ready' ELSE customer_link_state END
         WHEN connection_id IS NULL OR external_namespace!='channel:'||connection_id THEN 'excluded'
         ${observed ? `ELSE CASE WHEN ?='ready' THEN coalesce((SELECT 'ready' FROM customer_phones p
           JOIN customer_phone_proofs q ON q.profile_id=p.profile_id AND q.namespace=p.namespace AND q.phone=p.phone AND q.contact_id=p.contact_id AND q.revoked=0
           JOIN contacts k ON k.id=p.contact_id AND k.profile_id=p.profile_id AND k.identity_state='active'
           WHERE p.profile_id=conversations.profile_id AND p.namespace='team' AND p.phone=? AND p.state='ready'),'pending') ELSE ? END`
         : `WHEN verified_phone IS NULL THEN 'pending'
         ELSE coalesce((SELECT CASE WHEN k.identity_state!='active' THEN 'excluded'
             WHEN p.state='ready' AND q.contact_id IS NULL THEN 'pending' ELSE p.state END
           FROM customer_phones p LEFT JOIN customer_phone_proofs q ON q.profile_id=p.profile_id AND q.namespace=p.namespace AND q.phone=p.phone AND q.contact_id=p.contact_id AND q.revoked=0
           LEFT JOIN contacts k ON k.id=p.contact_id AND k.profile_id=p.profile_id
           WHERE p.profile_id=conversations.profile_id AND p.namespace='team' AND p.phone=conversations.verified_phone),'pending')`}
       END
     WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))`,
    [...(observed ? [observed.phone, observed.phone, observed.phone, observed.state, observed.phone, observed.state] : []), profile, list],
  ], ...(observed?.state === "ready" ? [] : [[
    `DELETE FROM conversation_contacts WHERE profile_id=? AND linked_by='identity'
       AND conversation_id IN (SELECT id FROM conversations WHERE profile_id=? AND id IN (SELECT value FROM json_each(?))
         AND external_namespace NOT LIKE 'app:%' AND (customer_link_state!='ready' OR customer_identity_proof IS NOT conversation_contacts.contact_id))`,
    [profile, profile, list],
  ] as Statement]), ...(observed?.session === false ? [] : [sessionStatement(profile, ids)])];
}

export function sessionStatement(profile: string, ids: readonly string[]): Statement {
  return [
    `INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at)
     SELECT c.profile_id,'conversations','session',c.id||':'||c.session,
       k.id,c.id,'identity',c.updated
       FROM conversations c LEFT JOIN conversation_contacts l ON l.conversation_id=c.id AND l.profile_id=c.profile_id
       JOIN contacts k ON k.id=CASE WHEN c.external_namespace LIKE 'app:%' THEN l.contact_id ELSE c.customer_identity_proof END
         AND k.profile_id=c.profile_id AND k.namespace=CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END AND k.identity_state='active'
       WHERE c.profile_id=? AND c.id IN (SELECT value FROM json_each(?)) AND c.customer_link_state='ready'
         AND NOT EXISTS(SELECT 1 FROM customer_records old WHERE old.profile_id=c.profile_id AND old.module_id='core'
           AND old.kind='conversation' AND old.record_id=c.id||':'||c.session)
       ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`,
    [profile, JSON.stringify(ids)],
  ];
}

async function resolve(env: Env, c: Conversation): Promise<CustomerRef> {
  const namespace = namespaceOf(c);
  const ref: CustomerRef = { profileId: c.profile_id, namespace, state: "pending", contactId: null, verifiedPhone: null, version: null, erp: null };
  if (c.chat_type === "group") return { ...ref, state: "excluded" };
  const row = await one(env,
    `SELECT v.customer_link_state,v.phone,v.verified_phone,v.connection_id,v.external_namespace,v.chat_type,
       l.contact_id explicit_contact,k.id,k.version,k.identity_state,k.erp_contact_id,k.erp_version,p.contact_id phone_contact,p.state phone_state,q.contact_id proof_contact
     FROM conversations v LEFT JOIN conversation_contacts l ON l.conversation_id=v.id AND l.profile_id=v.profile_id
     LEFT JOIN customer_phones p ON p.profile_id=v.profile_id AND p.namespace=? AND p.phone=v.verified_phone
     LEFT JOIN customer_phone_proofs q ON q.profile_id=p.profile_id AND q.namespace=p.namespace AND q.phone=p.phone AND q.contact_id=p.contact_id AND q.revoked=0
     LEFT JOIN contacts k ON k.id=CASE WHEN v.external_namespace LIKE 'app:%' OR v.connection_id IS NULL THEN l.contact_id ELSE p.contact_id END AND k.profile_id=v.profile_id
       AND (k.namespace=? OR (?='team' AND k.namespace='panel'))
     WHERE v.id=? AND v.profile_id=? AND v.external_namespace=?`,
    namespace, namespace, namespace, c.id, c.profile_id, c.external_namespace);
  if (!row) return ref;
  ref.state = row.customer_link_state;
  ref.verifiedPhone = namespace === "team" ? normalizeCustomerPhone(row.verified_phone, "international") : null;
  if (row.chat_type === "group" || (row.id && row.identity_state !== "active"))
    return { ...ref, state: "excluded", verifiedPhone: null };
  if (ref.state === "blocked" || ref.state === "excluded" || ref.state === "ambiguous") return { ...ref, verifiedPhone: null };
  if (namespace.startsWith("app:")) {
    if (!row.explicit_contact || !row.id) return { ...ref, state: "pending" };
    ref.state = "ready";
  } else {
    if (!row.connection_id || row.external_namespace !== `channel:${row.connection_id}` ||
        normalizeCustomerPhone(row.phone, "international") !== ref.verifiedPhone) ref.verifiedPhone = null;
    // Ligações explícitas sem canal continuam legíveis como cadastro, sem prova
    // telefônica. Em um canal real, apenas o proprietário comprovado é usado.
    if (row.explicit_contact && !row.connection_id && row.id) ref.state = "ready";
    else if (!row.proof_contact || row.proof_contact !== row.id || !ref.verifiedPhone || row.phone_state !== "ready")
      return { ...ref, state: "pending", verifiedPhone: null };
  }
  if (ref.state !== "ready" || !row.id) return ref;
  return { ...ref, contactId: row.id, version: row.version,
    erp: row.erp_contact_id && row.erp_version !== null ? { id: row.erp_contact_id, version: row.erp_version } : null };
}

async function prepareInbound(env: Env, c: Conversation, evidence: InboundEvidence) {
  const eligible = c.chat_type !== "group" && !!c.connection_id && c.external_namespace === `channel:${c.connection_id}`;
  const connection = eligible ? await inboundConnection(env, c.connection_id!) : null;
  const trusted = eligible && connection?.profile_id === c.profile_id &&
    connection.kind === evidence.provider && ["qr", "zernio", "meta"].includes(connection.kind);
  const phone = trusted ? evidencePhone(evidence) : null;
  const simple = (state: LinkState, verifiedPhone: string | null) => ({ state, verifiedPhone,
    statements: c.customer_link_state === state && (c.verified_phone ?? null) === verifiedPhone ? [] :
      [["UPDATE conversations SET verified_phone=?,customer_link_state=?,customer_identity_proof=NULL WHERE id=? AND profile_id=?",
        [verifiedPhone, state, c.id, c.profile_id]]] as Statement[] });
  if (c.customer_link_state === "blocked") return simple("blocked", phone);
  if (c.customer_link_state === "excluded") return simple("excluded", null);
  if (namespaceOf(c).startsWith("app:")) {
    const ref = await resolve(env, c);
    return simple(ref.state, null);
  }
  if (!trusted) return simple("excluded", null);
  if (!phone) return simple("pending", null);
  // O marcador só é instalado com prova; triggers o retiram quando há
  // revogação, restrição ou alteração do índice. Nome não altera o marcador.
  if (c.customer_link_state === "ready" && c.verified_phone === phone && identityOwner(c))
    return { statements: [], state: "ready" as const, verifiedPhone: phone };

  const profile = c.profile_id, namespace: Namespace = "team";
  const variants = customerPhoneVariants(phone, "international", true);
  // Índices por telefone localizam candidatos pertinentes. Só a recuperação
  // de mirrors antigos percorre uma página, com checkpoint durável e limite.
  // CROSS JOIN mantém selected como laço externo: o JOIN comum pode varrer
  // todos os contatos do namespace antes de filtrar os IDs da página.
  // O checkpoint completo zera o LIMIT antes de abrir o cursor de contatos;
  // um filtro por complete no WHERE pode descartar o namespace linha a linha.
  // O autor exige prefixo literal: LIKE interpreta curingas e seu padrão
  // com um ID de canal de 32 caracteres já ultrapassa o limite do D1.
  // A coleção de telefones de cada candidato usa o índice por contato:
  // o índice por namespace/telefone pode ler a base inteira para um único ID.
  const snapshot = await one(env,
    `WITH progress AS (SELECT cursor_json,complete FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?),
     indexed AS (SELECT contact_id id FROM customer_phone_candidates WHERE profile_id=? AND namespace='team'
       AND phone IN (SELECT value FROM json_each(?)) LIMIT 21),
     direct AS (SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND ${legacyPhoneSql} IN (SELECT value FROM json_each(?)) LIMIT 21),
     relevant AS (SELECT id FROM indexed UNION SELECT id FROM direct LIMIT 21), page AS (
       SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND id>coalesce((SELECT json_extract(cursor_json,'$.id') FROM progress),'')
         ORDER BY id LIMIT CASE WHEN coalesce((SELECT complete FROM progress),0)=0 THEN 20 ELSE 0 END
     ), selected AS (SELECT id FROM relevant UNION SELECT id FROM page)
     SELECT p.state,p.contact_id,p.version,
       (SELECT contact_id FROM customer_records WHERE profile_id=? AND record_id=? AND
         ((module_id='conversations' AND kind='session') OR (module_id='core' AND kind='conversation'))
         ORDER BY module_id DESC LIMIT 1) session_owner,
       (SELECT identity_state FROM contacts WHERE id=p.contact_id AND profile_id=p.profile_id) contact_state,
       (SELECT cursor_json FROM progress) cursor_json,coalesce((SELECT complete FROM progress),0) complete,
       (SELECT count(*) FROM relevant) relevant_count,(SELECT json_group_array(id) FROM relevant) relevant_ids,
       (SELECT json_group_array(id) FROM page) page_ids,
       (SELECT json_group_array(json_object('id',c.id,'version',c.version,'phone',c.phone,'mirror_json',CASE WHEN c.mirror_json IS NULL THEN NULL ELSE json_object('phones',json_extract(c.mirror_json,'$.phones')) END,
          'identity_state',c.identity_state,'source',c.source,'created',c.created,
          'denied',EXISTS(SELECT 1 FROM conversations v JOIN customer_records r
            ON r.profile_id=v.profile_id AND r.record_id=v.id||':'||v.session AND r.contact_id=c.id
              AND ((r.module_id='conversations' AND r.kind='session') OR (r.module_id='core' AND r.kind='conversation'))
            WHERE v.profile_id=c.profile_id AND v.customer_link_state='blocked' AND v.verified_phone IN (SELECT value FROM json_each(?))),
          'prior',(SELECT json_object('conversation',v.id,'created',m.created) FROM conversations v
            JOIN customer_records r ON r.profile_id=v.profile_id AND r.record_id=v.id||':'||v.session AND r.contact_id=c.id
              AND ((r.module_id='conversations' AND r.kind='session') OR (r.module_id='core' AND r.kind='conversation'))
            JOIN messages m ON m.id=(SELECT id FROM messages WHERE conversation_id=v.id AND direction='customer' ORDER BY created,id LIMIT 1)
            WHERE v.profile_id=c.profile_id AND v.verified_phone IN (SELECT value FROM json_each(?))
              AND v.phone=v.verified_phone AND v.phone=c.phone AND v.chat_type='direct'
              AND v.external_namespace='channel:'||v.connection_id AND v.customer_link_state NOT IN ('blocked','excluded','ambiguous')
              AND m.profile_id=v.profile_id AND instr(m.author,'customer:'||v.external_namespace||':')=1 AND c.updated<=m.created LIMIT 1),
          'candidates',(SELECT json_group_array(json_object('phone',k.phone,'origin',k.origin)) FROM (SELECT phone,origin FROM customer_phone_candidates INDEXED BY customer_phone_candidates_contact
            WHERE profile_id=c.profile_id AND namespace=c.namespace AND contact_id=c.id LIMIT 32) k),
          'proofs',(SELECT json_group_array(json_object('phone',q.phone,'revoked',q.revoked)) FROM customer_phone_proofs q
            WHERE q.profile_id=c.profile_id AND q.namespace=c.namespace AND q.contact_id=c.id AND q.phone IN (SELECT value FROM json_each(?)))))
         FROM selected CROSS JOIN contacts c ON c.id=selected.id AND c.profile_id=? AND c.namespace='team') legacy
     FROM (SELECT 1) LEFT JOIN customer_phones p ON p.profile_id=? AND p.namespace='team' AND p.phone=?`,
    profile, CONTACT_TASK, profile, JSON.stringify(variants), profile, JSON.stringify(variants), profile,
    profile, `${c.id}:${c.session}`, JSON.stringify(variants), JSON.stringify(variants), JSON.stringify(variants), profile, profile, phone);
  type Candidate = ContactSnapshot & { source: string; created: number; denied: number; prior: { conversation: string; created: number } | null;
    candidates: { phone: string; origin: string }[]; proofs: { phone: string; revoked: number }[] };
  const rows: Candidate[] = JSON.parse(snapshot.legacy).map((r: any) => ({ ...r,
    prior: typeof r.prior === "string" ? JSON.parse(r.prior) : r.prior,
    mirror_json: r.mirror_json && typeof r.mirror_json !== "string" ? JSON.stringify(r.mirror_json) : r.mirror_json,
    candidates: typeof r.candidates === "string" ? JSON.parse(r.candidates) : r.candidates,
    proofs: typeof r.proofs === "string" ? JSON.parse(r.proofs) : r.proofs,
  }));
  const pageIds: string[] = JSON.parse(snapshot.page_ids);
  const canonicalVariants = customerPhoneVariants(phone);
  const relevant = rows.filter(r => contactPhones(r).some(p => canonicalVariants.includes(p)) ||
    r.candidates.some(k => canonicalVariants.includes(k.phone)));
  const complete = !!snapshot.complete || pageIds.length < LEGACY_PAGE;
  const guard = `identity:${c.id}`;
  const statements: Statement[] = [snapshotGuard(profile, namespace, rows, guard, false, [
    `(SELECT version FROM customer_phones WHERE profile_id=? AND namespace='team' AND phone=?) IS ?
     AND (SELECT identity_state FROM contacts WHERE id=? AND profile_id=?) IS ?
     AND (SELECT cursor_json FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?) IS ?
     AND NOT EXISTS(SELECT 1 FROM (
       SELECT id FROM (SELECT contact_id id FROM customer_phone_candidates WHERE profile_id=? AND namespace='team'
         AND phone IN (SELECT value FROM json_each(?)) LIMIT 21)
       UNION SELECT id FROM (SELECT id FROM contacts WHERE profile_id=? AND namespace='team'
         AND ${legacyPhoneSql} IN (SELECT value FROM json_each(?)) LIMIT 21)
     ) new_targets WHERE id NOT IN (SELECT value FROM json_each(?)))`,
    [profile, phone, snapshot.version ?? null, snapshot.contact_id ?? null, profile, snapshot.contact_state ?? null,
      profile, CONTACT_TASK, snapshot.cursor_json ?? null,
      profile, JSON.stringify(variants), profile, JSON.stringify(variants), snapshot.relevant_ids],
  ])];
  const additions = rows.flatMap(r => contactPhones(r).filter(p => !r.candidates.some(k => k.phone === p))
    .map(p => ({ id: r.id, phone: p })));
  const unique = relevant.length === 1 ? relevant[0] : null;
  const proofs: { phone: string; revoked: number }[] = unique?.proofs ?? [];
  const candidates: { phone: string; origin: string }[] = unique?.candidates.filter(k => variants.includes(k.phone)) ?? [];
  // Legado intocado tem procedência distinta de importação/edição/espelho.
  // A primeira observação confirma somente o número persistido nesse legado.
  // Uma prova revogada nunca é recriada por coincidência cadastral.
  const authorized = !!unique && !unique.denied && !proofs.some(p => p.revoked) && (proofs.some(p => !p.revoked) ||
    (!!unique.prior && candidates.some(k => k.origin === "observed") && unique.source === "automatic") ||
    (complete && unique.version === 1 && ["manual", "conversation"].includes(unique.source) &&
      candidates.every(k => k.origin === "legacy")));
  const create = complete && !relevant.length && !snapshot.contact_id && snapshot.relevant_count === 0;
  const contactId = create ? uid() : authorized ? unique!.id : null;
  let state: LinkState = relevant.length > 1 || snapshot.relevant_count >= 21 ? "ambiguous" : contactId ? "ready" : "pending";
  if (unique?.identity_state !== undefined && unique.identity_state !== "active") state = "excluded";
  if (create) statements.push([
    `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
     VALUES(?,?,'team','',?,?,'automatic','identity','identity',?,?)`,
    [contactId, profile, phone, phone, now(), now()],
  ]);
  for (const row of relevant) if (!row.candidates.some(k => k.phone === phone)) additions.push({ id: row.id, phone });
  if (create) additions.push({ id: contactId!, phone });
  if (additions.length) statements.push([
    `INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin)
     SELECT ?,'team',json_extract(value,'$.phone'),json_extract(value,'$.id'),
       CASE WHEN json_extract(value,'$.id')=? AND json_extract(value,'$.phone')=? THEN 'observed' ELSE 'legacy' END
       FROM json_each(?) WHERE 1 ON CONFLICT DO NOTHING`,
    [profile, contactId, phone, JSON.stringify(additions)],
  ]);
  if (contactId && state === "ready") statements.push([
    `INSERT INTO customer_phone_proofs(profile_id,namespace,phone,contact_id,conversation_id,created)
     VALUES(?,'team',?,?,?,?) ON CONFLICT DO NOTHING`, [profile, phone, contactId, unique?.prior?.conversation ?? c.id, unique?.prior?.created ?? now()],
  ]);
  const affected = [...new Set([phone, ...additions.map(a => a.phone)])];
  statements.push(...phoneIndexStatements(profile, namespace, affected, false));
  if (!snapshot.complete) statements.push([
    `INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated) VALUES(?,'team',?,?,?,?)
     ON CONFLICT(profile_id,namespace,task) DO UPDATE SET cursor_json=excluded.cursor_json,complete=excluded.complete,updated=excluded.updated`,
    [profile, CONTACT_TASK, JSON.stringify({ id: pageIds.at(-1) || JSON.parse(snapshot.cursor_json || "{}").id || "" }), complete ? 1 : 0, now()],
  ]);
  const previousOwner = snapshot.session_owner || identityOwner(c);
  const sessionChanged = !!previousOwner && !!contactId && previousOwner !== contactId;
  statements.push(...conversationIdentityStatements(profile, [c.id], { phone, invalidate: true, state,
    // Uma troca não atribui retroativamente o intervalo anterior. A sessão
    // nova recebe sua marca nas mensagens; a próxima abertura gera o registro.
    session: !sessionChanged }));
  return { statements, state, verifiedPhone: phone, sessionChanged };
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
  // Conserva aliases já observados enquanto ainda representam o número atual.
  for (const oldPhone of previous) if (!phones.includes(oldPhone) && phones.some(p => customerPhoneVariants(p).includes(oldPhone))) phones.push(oldPhone);
  if (previous.length === phones.length && phones.every((phone) => previous.includes(phone))) return [];
  const affected = [...new Set<string>([...previous, ...phones])];
  return [
    ["DELETE FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND contact_id=? AND phone NOT IN (SELECT value FROM json_each(?))", [profileId, namespace, contactId, JSON.stringify(phones)]],
    [`INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin)
      SELECT c.profile_id,c.namespace,j.value,c.id,? FROM contacts c,json_each(?) j
      WHERE c.id=? AND c.profile_id=? AND c.namespace=? ON CONFLICT DO NOTHING`,
    [origin === "observed" ? "local" : origin, JSON.stringify(phones), contactId, profileId, namespace]],
    ...phoneIndexStatements(profileId, namespace, affected),
  ];
}

function recordLink(c: Conversation, link: Parameters<NonNullable<IdentityPort["recordLink"]>>[1]): Statement[] {
  if (c.profile_id !== link.profileId || c.id !== link.conversationId || c.chat_type === "group" || namespaceOf(c) !== "team") return [];
  return [[
    `INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at)
     SELECT v.profile_id,?,?,?,k.id,v.id,?,? FROM conversations v
       LEFT JOIN conversation_contacts cc ON cc.conversation_id=v.id AND cc.profile_id=v.profile_id
       LEFT JOIN customer_phones p ON p.profile_id=v.profile_id AND p.namespace='team' AND p.phone=v.verified_phone AND p.state='ready'
       JOIN contacts k ON k.id=v.customer_identity_proof AND k.id=p.contact_id AND k.profile_id=v.profile_id AND k.namespace='team' AND k.identity_state='active'
       WHERE v.profile_id=? AND v.id=? AND v.session=? AND v.customer_link_state='ready' AND v.chat_type<>'group'
         ${link.moduleId === "tickets" ? "AND EXISTS(SELECT 1 FROM tickets t WHERE t.profile_id=v.profile_id AND t.id=? AND t.conversation_id=v.id)" : ""}
         AND v.connection_id IS NOT NULL AND v.external_namespace='channel:'||v.connection_id
       ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`,
    [link.moduleId, link.kind, link.recordId, link.linkedBy, link.occurredAt, c.profile_id, c.id, c.session,
      ...(link.moduleId === "tickets" ? [link.recordId] : [])],
  ]];
}

export const customerIdentity: IdentityPort = { resolve, prepareInbound, indexContact, recordLink, maintain: maintainIdentity };
