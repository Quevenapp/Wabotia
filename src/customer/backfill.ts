import { batch } from "../db";
import { now, type Env } from "../types";
import type { MaintenanceBudget, MaintenanceResult, Namespace, Statement } from "./contracts";
import {
  CONTACT_TASK, CONVERSATION_TASK, PROOF_TASK, contactPhones, conversationIdentityStatements,
  phoneIndexStatements, snapshotGuard, type ContactSnapshot,
} from "./identity";

/** Uma página por invocação. O checkpoint e todos os efeitos formam um lote.
 * Não transforma o telefone legado de uma conversa em prova autenticada. */
export async function maintainIdentity(env: Env, profileId: string, budget: MaintenanceBudget): Promise<MaintenanceResult> {
  const limit = Math.min(20, budget.remainingItems);
  // Pior caso: duas leituras e até dez escritas; não consumir o saldo de outro
  // participante quando não há espaço para confirmar a página inteira.
  if (limit < 1 || budget.remainingStatements < 12)
    return { pending: true, statements: 0, items: 0 };
  // Sem repetição automática de leitura: um erro encerra a rodada, mantendo
  // o checkpoint. Assim o consumo informado inclui cada instrução executada
  // e uma tentativa adicional não invade o saldo dos demais participantes.
  const read = async <T = any>(sql: string, ...args: unknown[]): Promise<T[]> =>
    (await env.DB.prepare(sql).bind(...args).all<T>()).results;
  const task = (await read(
    `WITH namespaces AS (
       SELECT namespace FROM contacts WHERE profile_id=?
       UNION SELECT CASE WHEN external_namespace LIKE 'app:%' THEN external_namespace ELSE 'team' END
         FROM conversations WHERE profile_id=?
     ), tasks AS (SELECT ? task,0 priority UNION ALL SELECT ?,1 UNION ALL SELECT ?,2)
     SELECT n.namespace,t.task,p.cursor_json FROM namespaces n CROSS JOIN tasks t
       LEFT JOIN customer_progress p ON p.profile_id=? AND p.namespace=n.namespace AND p.task=t.task
       WHERE coalesce(p.complete,0)=0 ORDER BY t.priority,n.namespace LIMIT 1`,
    profileId, profileId, CONTACT_TASK, PROOF_TASK, CONVERSATION_TASK, profileId))[0];
  if (!task) return { pending: false, statements: 1, items: 0 };
  const namespace = task.namespace as Namespace;
  const cursor = JSON.parse(task.cursor_json || "{}").id || "";
  const guard = `identity-backfill:${JSON.stringify([profileId, namespace, task.task])}`;
  const statements: Statement[] = [[
    `INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN
      (SELECT cursor_json FROM customer_progress WHERE profile_id=? AND namespace=? AND task=?) IS ?
      THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
    [guard, profileId, namespace, task.task, task.cursor_json ?? null],
  ]];
  let ids: string[];
  if (task.task === CONTACT_TASK) {
    const rows = await read<ContactSnapshot & { indexed_phones: string }>(
      `SELECT id,version,phone,mirror_json,identity_state,source,
         (SELECT json_group_array(phone) FROM customer_phone_candidates p
           WHERE p.profile_id=c.profile_id AND p.namespace=c.namespace AND p.contact_id=c.id) AS indexed_phones
       FROM (SELECT id,profile_id,namespace,version,phone,identity_state,source,
         CASE WHEN mirror_json IS NULL THEN NULL ELSE json_object('phones',json_extract(mirror_json,'$.phones')) END mirror_json
         FROM contacts) c WHERE profile_id=? AND namespace=? AND id>? ORDER BY id LIMIT ?`,
      profileId, namespace, cursor, limit);
    ids = rows.map((row) => row.id);
    if (rows.length) {
      statements.push(snapshotGuard(profileId, namespace, rows, `${guard}:rows`));
      const candidates = rows.flatMap((row) => contactPhones(row)
        .filter((phone) => !(JSON.parse(row.indexed_phones) as string[]).includes(phone))
        .map((phone) => ({ id: row.id, phone })));
      const phones = [...new Set(candidates.map((c) => c.phone))];
      // Preserva provas observadas: a coluna curta phone pode ter apenas um
      // dos telefones do contato. O preenchimento adiciona legado, não edita.
      statements.push([
        `INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin)
         SELECT ?,?,json_extract(value,'$.phone'),json_extract(value,'$.id'),'legacy'
         FROM json_each(?) WHERE 1 ON CONFLICT DO NOTHING`,
        [profileId, namespace, JSON.stringify(candidates)],
      ], ...phoneIndexStatements(profileId, namespace, phones));
    }
  } else if (task.task === PROOF_TASK) {
    const rows = await read<{ phone: string; version: number }>(
      `SELECT phone,version FROM customer_phones WHERE profile_id=? AND namespace=? AND phone>? ORDER BY phone LIMIT ?`,
      profileId, namespace, cursor, limit);
    ids = rows.map(row => row.phone);
    if (ids.length) {
      // Só recupera a prova que já nasceu de uma entrada: candidato observado,
      // ficha automática original, mensagem de canal e dono da sessão coincidem.
      // Local/mirror e escolhas administrativas isoladas jamais são promovidos.
      statements.push([
        `INSERT INTO customer_phone_proofs(profile_id,namespace,phone,contact_id,conversation_id,created,revoked)
         SELECT p.profile_id,p.namespace,p.phone,r.contact_id,min(v.id),min(v.updated),1
         FROM customer_phones p JOIN conversations v ON v.profile_id=p.profile_id AND v.verified_phone=p.phone
           AND v.external_namespace='channel:'||v.connection_id AND v.customer_link_state='blocked'
         JOIN customer_records r ON r.profile_id=v.profile_id AND r.record_id=v.id||':'||v.session
           AND ((r.module_id='conversations' AND r.kind='session') OR (r.module_id='core' AND r.kind='conversation'))
         JOIN contacts c ON c.id=r.contact_id AND c.profile_id=p.profile_id AND c.namespace=p.namespace
         WHERE p.profile_id=? AND p.namespace=? AND p.phone IN (SELECT value FROM json_each(?))
         GROUP BY p.phone,r.contact_id ON CONFLICT(profile_id,namespace,phone,contact_id) DO UPDATE SET revoked=1`,
        [profileId, namespace, JSON.stringify(ids)],
      ], [
        `INSERT INTO customer_phone_proofs(profile_id,namespace,phone,contact_id,conversation_id,created)
         SELECT p.profile_id,p.namespace,p.phone,k.contact_id,min(v.id),min(m.created)
         FROM customer_phones p JOIN customer_phone_candidates k ON k.profile_id=p.profile_id AND k.namespace=p.namespace AND k.phone=p.phone AND (p.contact_id IS NULL OR k.contact_id=p.contact_id) AND k.origin='observed'
         JOIN contacts c ON c.id=k.contact_id AND c.profile_id=p.profile_id AND c.namespace=p.namespace AND c.source='automatic' AND c.created_by='identity'
         JOIN conversations v ON v.profile_id=p.profile_id AND v.verified_phone=p.phone AND v.phone=p.phone
           AND v.chat_type='direct' AND v.external_namespace='channel:'||v.connection_id AND v.customer_link_state NOT IN ('blocked','excluded','ambiguous')
         JOIN messages m ON m.id=(SELECT id FROM messages WHERE conversation_id=v.id AND direction='customer' ORDER BY created,id LIMIT 1) AND m.profile_id=v.profile_id AND instr(m.author,'customer:'||v.external_namespace||':')=1
         JOIN customer_records r ON r.profile_id=v.profile_id AND r.record_id=v.id||':'||v.session AND r.contact_id=c.id
           AND ((r.module_id='conversations' AND r.kind='session') OR (r.module_id='core' AND r.kind='conversation'))
         WHERE p.profile_id=? AND p.namespace=? AND p.phone IN (SELECT value FROM json_each(?)) AND p.state!='ambiguous'
           AND c.phone=p.phone AND c.updated<=m.created
         GROUP BY p.phone,k.contact_id ON CONFLICT DO NOTHING`,
        [profileId, namespace, JSON.stringify(ids)],
      ], [
        `UPDATE customer_phones SET state='ready',contact_id=(SELECT q.contact_id FROM customer_phone_proofs q
           WHERE q.profile_id=customer_phones.profile_id AND q.namespace=customer_phones.namespace AND q.phone=customer_phones.phone AND q.revoked=0 LIMIT 1),version=version+1
         WHERE profile_id=? AND namespace=? AND phone IN (SELECT value FROM json_each(?)) AND state='pending'
           AND (SELECT count(*) FROM (SELECT contact_id FROM customer_phone_candidates k WHERE k.profile_id=customer_phones.profile_id
             AND k.namespace=customer_phones.namespace AND k.phone=customer_phones.phone LIMIT 2))=1
           AND EXISTS(SELECT 1 FROM customer_phone_proofs q JOIN customer_phone_candidates k ON k.profile_id=q.profile_id AND k.namespace=q.namespace AND k.phone=q.phone AND k.contact_id=q.contact_id
             WHERE q.profile_id=customer_phones.profile_id AND q.namespace=customer_phones.namespace AND q.phone=customer_phones.phone AND q.revoked=0)`,
        [profileId, namespace, JSON.stringify(ids)],
      ], [
        `UPDATE customer_phones SET state='pending',contact_id=NULL,version=version+1
         WHERE profile_id=? AND namespace=? AND phone IN (SELECT value FROM json_each(?)) AND state='ready'
           AND NOT EXISTS(SELECT 1 FROM customer_phone_proofs q WHERE q.profile_id=customer_phones.profile_id AND q.namespace=customer_phones.namespace
             AND q.phone=customer_phones.phone AND q.contact_id=customer_phones.contact_id AND q.revoked=0)`,
        [profileId, namespace, JSON.stringify(ids)],
      ]);
    }
  } else {
    const rows = await read<{ id: string }>(
      `SELECT id FROM conversations WHERE profile_id=?
         AND (CASE WHEN external_namespace LIKE 'app:%' THEN external_namespace ELSE 'team' END)=?
         AND id>? ORDER BY id LIMIT ?`, profileId, namespace, cursor, limit);
    ids = rows.map((row) => row.id);
    // Aplicações recuperam apenas a associação explícita ativa do mesmo namespace.
    if (ids.length) statements.push(...conversationIdentityStatements(profileId, ids));
  }
  statements.push([
    `INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
     VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,namespace,task) DO UPDATE SET
       cursor_json=excluded.cursor_json,complete=excluded.complete,updated=excluded.updated`,
    [profileId, namespace, task.task, JSON.stringify({ id: ids.at(-1) || cursor }), ids.length < limit ? 1 : 0, now()],
  ], ["DELETE FROM customer_assert WHERE id IN (?,?)", [guard, `${guard}:rows`]]);
  await batch(env, statements);
  // Há possivelmente outra fase/namespace. A próxima invocação confirma o fim
  // com uma única leitura; não gastar mais uma só para responder pending=false.
  return { pending: true, statements: 2 + statements.length, items: ids.length };
}
