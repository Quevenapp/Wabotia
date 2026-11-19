import { batch } from "../db";
import { now, type Env } from "../types";
import type { MaintenanceBudget, MaintenanceResult, Namespace, Statement } from "./contracts";
import {
  CONTACT_TASK, CONVERSATION_TASK, contactPhones, conversationIdentityStatements,
  phoneIndexStatements, snapshotGuard, type ContactSnapshot,
} from "./identity";

/** Uma página por invocação. O checkpoint e todos os efeitos formam um lote.
 * Não transforma o telefone legado de uma conversa em prova autenticada. */
export async function maintainIdentity(env: Env, profileId: string, budget: MaintenanceBudget): Promise<MaintenanceResult> {
  const limit = Math.min(20, budget.remainingItems);
  // Pior caso: duas leituras e sete escritas; não consumir o saldo de outro
  // participante quando não há espaço para confirmar a página inteira.
  if (limit < 1 || budget.remainingStatements < 9)
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
     ), tasks AS (SELECT ? task,0 priority UNION ALL SELECT ?,1)
     SELECT n.namespace,t.task,p.cursor_json FROM namespaces n CROSS JOIN tasks t
       LEFT JOIN customer_progress p ON p.profile_id=? AND p.namespace=n.namespace AND p.task=t.task
       WHERE coalesce(p.complete,0)=0 ORDER BY t.priority,n.namespace LIMIT 1`,
    profileId, profileId, CONTACT_TASK, CONVERSATION_TASK, profileId))[0];
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
      `SELECT id,version,phone,mirror_json,
         (SELECT json_group_array(phone) FROM customer_phone_candidates p
           WHERE p.profile_id=c.profile_id AND p.namespace=c.namespace AND p.contact_id=c.id) AS indexed_phones
       FROM contacts c WHERE profile_id=? AND namespace=? AND id>? ORDER BY id LIMIT ?`,
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
  } else {
    const rows = await read<{ id: string }>(
      `SELECT id FROM conversations WHERE profile_id=?
         AND (CASE WHEN external_namespace LIKE 'app:%' THEN external_namespace ELSE 'team' END)=?
         AND id>? ORDER BY id LIMIT ?`, profileId, namespace, cursor, limit);
    ids = rows.map((row) => row.id);
    // Aplicações não fornecem prova: a manutenção não altera seus vínculos
    // explícitos, mantidos pelos comandos de contatos no namespace próprio.
    if (ids.length && namespace === "team") statements.push(...conversationIdentityStatements(profileId, ids));
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
