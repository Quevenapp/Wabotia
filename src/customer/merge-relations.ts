import { all, one, reads } from "../db";
import { canonical, sha } from "../security";
import { ApiError, type Env } from "../types";
import type { Statement } from "./contracts";

type Row = Record<string, any>;
export interface MergeRelation { table: string; owner: string; keys: readonly string[] }
/** Allowlist fechada: somente propriedade, nunca papéis ou conteúdo de módulos. */
export const MERGE_RELATIONS: readonly MergeRelation[] = [
  { table: "conversation_contacts", owner: "contact_id", keys: ["conversation_id"] },
  ...["web_steps", "agenda_appointments", "os_orders", "pedido_orders", "reserva_bookings", "mensalidade_subscriptions", "os_people", "mensalidade_payers", "cond_people", "ensino_guardians"].map(table => ({ table, owner: "contact_id", keys: ["id"] })),
  { table: "ensino_enrollments", owner: "billing_contact_id", keys: ["id"] },
  { table: "saude_contact_links", owner: "contact_id", keys: ["profile_id", "subject_id", "contact_id", "relation"] },
  { table: "customer_records", owner: "contact_id", keys: ["profile_id", "module_id", "kind", "record_id"] },
  { table: "customer_sections", owner: "contact_id", keys: ["profile_id", "contact_id", "module_id", "section_id"] },
  { table: "customer_phones", owner: "contact_id", keys: ["profile_id", "namespace", "phone"] },
  { table: "customer_phone_candidates", owner: "contact_id", keys: ["profile_id", "namespace", "phone", "contact_id"] },
  { table: "customer_phone_proofs", owner: "contact_id", keys: ["profile_id", "namespace", "phone", "contact_id"] },
  { table: "customer_channel_ids", owner: "contact_id", keys: ["id"] },
];
export interface ManifestTable { table: string; columns: string[]; rows: Row[]; where: string; args: unknown[] }
export interface MergeManifest { tables: ManifestTable[]; conversationIds: string[] }
export interface RelationChange { table: string; keys: Row; before: Row; after: Row | null }
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const ordered = (rows: Row[]) => rows.sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
export function mergeChanged(): never { throw new ApiError(409, "merge_changed", "O cadastro ou suas relações mudaram. Gere uma nova prévia."); }

export async function resolveContactAlias(env: Env, profile: string, id: string, namespace?: string): Promise<any> {
  const seen = new Set<string>();
  while (!seen.has(id) && seen.size < 32) {
    seen.add(id);
    const row = await one(env, "SELECT * FROM contacts WHERE profile_id=? AND id=?", profile, id);
    if (!row || (namespace !== undefined && row.namespace !== namespace)) throw new ApiError(404, "not_found", "Contato não encontrado.");
    namespace ??= row.namespace;
    if (row.identity_state !== "active") throw new ApiError(409, "merge_restricted", "Este contato tem restrição de dados.");
    if (!row.merged_into) return row;
    id = row.merged_into;
  }
  throw new ApiError(409, "merge_changed", "Vínculo de contatos inválido.");
}

/** Inclui todo o conjunto, não só as referências conhecidas no momento da prévia. */
export async function readMergeManifest(env: Env, profile: string, ids: readonly string[], pinned: readonly string[] = []): Promise<MergeManifest> {
  const contacts = JSON.stringify(ids), pin = JSON.stringify(pinned);
  const relationQueries = MERGE_RELATIONS.map(r => ({ table: r.table, where: `profile_id=? AND ${q(r.owner)} IN (SELECT value FROM json_each(?))`, args: [profile, contacts] as unknown[] }));
  const conversationWhere = `profile_id=? AND (id IN (SELECT value FROM json_each(?)) OR customer_identity_proof IN (SELECT value FROM json_each(?))
    OR id IN (SELECT conversation_id FROM conversation_contacts WHERE profile_id=? AND contact_id IN (SELECT value FROM json_each(?)))
    OR id IN (SELECT conversation_id FROM customer_records WHERE profile_id=? AND contact_id IN (SELECT value FROM json_each(?)) AND conversation_id IS NOT NULL)
    OR id IN (SELECT conversation_id FROM customer_phone_proofs WHERE profile_id=? AND contact_id IN (SELECT value FROM json_each(?)))
    OR channel_identity_id IN (SELECT id FROM customer_channel_ids WHERE profile_id=? AND contact_id IN (SELECT value FROM json_each(?)))
    OR (external_namespace NOT LIKE 'app:%' AND verified_phone IN (SELECT phone FROM customer_phone_candidates WHERE profile_id=? AND namespace='team' AND contact_id IN (SELECT value FROM json_each(?))))
    OR (external_namespace NOT LIKE 'app:%' AND verified_phone IN (SELECT phone FROM customer_phones WHERE profile_id=? AND namespace='team' AND contact_id IN (SELECT value FROM json_each(?)))))`;
  const args = [profile, pin, contacts, profile, contacts, profile, contacts, profile, contacts, profile, contacts, profile, contacts, profile, contacts];
  const queries = [
    { table: "contacts", where: "profile_id=? AND (id IN (SELECT value FROM json_each(?)) OR merged_into IN (SELECT value FROM json_each(?)))", args: [profile, contacts, contacts] },
    ...relationQueries,
    { table: "conversations", where: conversationWhere, args },
    { table: "customer_jobs", where: "profile_id=? AND contact_id IN (SELECT value FROM json_each(?))", args: [profile, contacts] },
  ];
  const names = [...queries.map(r => r.table), "messages", "bot_runs", "outbox"];
  const schema = await all(env, "SELECT t.value table_name,p.name FROM json_each(?) t JOIN pragma_table_info(t.value) p", JSON.stringify(names));
  const columns = (table: string) => schema.filter(r => r.table_name === table).map(r => r.name as string).sort();
  const data = await reads(env, queries.map(r => ({ sql: `SELECT * FROM ${q(r.table)} WHERE ${r.where} LIMIT 2001`, args: r.args })));
  const tables: ManifestTable[] = queries.map((r, i) => ({ ...r, columns: columns(r.table), rows: data[i] }));
  const conversationIds = tables.find(r => r.table === "conversations")!.rows.map(r => r.id as string).sort();
  const extra = ["messages", "bot_runs", "outbox"].map(table => ({ table, where: "profile_id=? AND conversation_id IN (SELECT value FROM json_each(?))", args: [profile, JSON.stringify(conversationIds)] }));
  const more = await reads(env, extra.map(r => ({ sql: `SELECT * FROM ${q(r.table)} WHERE ${r.where} LIMIT 2001`, args: r.args })));
  extra.forEach((r, i) => tables.push({ ...r, columns: columns(r.table), rows: more[i] }));
  if (tables.some(t => !t.columns.length || t.rows.length > 2000) || JSON.stringify(tables.map(t => t.rows)).length > 1_000_000)
    throw new ApiError(409, "merge_relation_conflict", "Há relações demais para juntar com segurança neste lote.");
  return { tables, conversationIds };
}
export const manifestRows = (manifest: MergeManifest, table: string) => manifest.tables.find(t => t.table === table)!.rows;
export function cloneManifest(manifest: MergeManifest): MergeManifest { return structuredClone(manifest); }
export const manifestHash = (manifest: MergeManifest) => sha(canonical(manifest.tables.map(t => ({ table: t.table, rows: ordered([...t.rows]) }))));

function balancedAnd(terms: readonly string[]): string {
  if (!terms.length) return "1";
  if (terms.length === 1) return terms[0];
  const middle = Math.floor(terms.length / 2);
  return `(${balancedAnd(terms.slice(0, middle))} AND ${balancedAnd(terms.slice(middle))})`;
}

/** Assertions no mesmo lote detectam inserções, exclusões e qualquer alteração, inclusive mensagem nova. */
export function assertManifest(manifest: MergeManifest, command: string): Statement[] {
  return manifest.tables.flatMap(t => {
    // Comparação por valor evita depender da grafia JSON de REAL (1.0 vs 1),
    // ordem das propriedades e quantidade máxima de argumentos de json_object.
    // D1 limita a profundidade de expressão a 100. Balancear o AND mantém
    // todas as colunas, inclusive nas tabelas largas, com profundidade logarítmica.
    const matches = balancedAnd(t.columns.map(c => `actual.${q(c)} IS json_extract(expected.value,'$.${c}')`));
    const expected = JSON.stringify(t.rows.map(row => Object.fromEntries(t.columns.map(c => [c, row[c]]))));
    const id = `merge:${command}:${t.table}`;
    return [
      [`INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN count(*)=? AND coalesce(min(EXISTS(SELECT 1 FROM json_each(?) expected WHERE ${matches})),1)=1 THEN 1 ELSE 0 END FROM ${q(t.table)} actual WHERE ${t.where}`, [id, t.rows.length, expected, ...t.args]],
      ["DELETE FROM customer_assert WHERE id=?", [id]],
    ] as Statement[];
  });
}
function rowKey(r: Row, keys: readonly string[]) { return Object.fromEntries(keys.map(k => [k, r[k]])); }
function equalKey(a: Row, b: Row, keys: readonly string[]) { return keys.every(k => a[k] === b[k]); }
export function planRelationMerge(manifest: MergeManifest, source: string, target: string, at: number): RelationChange[] {
  const changes: RelationChange[] = [];
  // Provas movidas antes da exclusão de candidato duplicado: o trigger não pode revogá-las.
  const specs = [...MERGE_RELATIONS].sort((a, b) => Number(b.table === "customer_phone_proofs") - Number(a.table === "customer_phone_proofs"));
  for (const r of specs) {
    const rows = manifestRows(manifest, r.table);
    for (const row of [...rows].filter(v => v[r.owner] === source)) {
      const next = { ...row, [r.owner]: target };
      const collision = rows.find(other => other !== row && equalKey(other, next, r.keys));
      if (collision) {
        if (Object.keys(next).some(k => next[k] !== collision[k])) throw new ApiError(409, "merge_relation_conflict", `Relações incompatíveis em ${r.table}.`);
        changes.push({ table: r.table, keys: rowKey(row, r.keys), before: { ...row }, after: null });
        rows.splice(rows.indexOf(row), 1);
      } else {
        const before: Row = { [r.owner]: row[r.owner] }, after: Row = { [r.owner]: target };
        if (r.table === "customer_phones" || r.table === "customer_channel_ids") { before.version = row.version; after.version = row.version + 1; }
        if (r.table === "customer_channel_ids") { before.updated = row.updated; after.updated = at; }
        changes.push({ table: r.table, keys: rowKey(row, r.keys), before, after }); Object.assign(row, after);
      }
    }
  }
  return changes;
}
export function updateStatement(table: string, profile: string, keys: Row, fields: Row): Statement {
  const entries = Object.entries(fields), keyEntries = Object.entries(keys);
  return [`UPDATE ${q(table)} SET ${entries.map(([k]) => `${q(k)}=?`).join(",")} WHERE profile_id=? AND ${keyEntries.map(([k]) => `${q(k)} IS ?`).join(" AND ")}`, [...entries.map(([, v]) => v), profile, ...keyEntries.map(([, v]) => v)]];
}
export function relationStatements(profile: string, changes: RelationChange[], undo = false): Statement[] {
  const statements: Statement[] = [];
  for (const change of changes) {
    if (!change.after) {
      if (undo) {
        const keys = Object.keys(change.before);
        statements.push([`INSERT INTO ${q(change.table)}(${keys.map(q).join(",")}) VALUES(${keys.map(() => "?").join(",")})`, keys.map(k => change.before[k])]);
      } else {
        const keys = Object.keys(change.keys);
        statements.push([`DELETE FROM ${q(change.table)} WHERE profile_id=? AND ${keys.map(k => `${q(k)} IS ?`).join(" AND ")}`, [profile, ...keys.map(k => change.keys[k])]]);
      }
    } else {
      const keys = undo ? { ...change.keys, ...Object.fromEntries(Object.keys(change.keys).filter(k => k in change.after!).map(k => [k, change.after![k]])) } : change.keys;
      const fields = undo ? { ...change.before } : change.after;
      if (undo && "version" in fields) fields.version = change.after.version + 1;
      statements.push(updateStatement(change.table, profile, keys, fields));
    }
  }
  return statements;
}
/** Reconstitui só a associação após triggers telefônicos; nunca recria mensagem ou módulo. */
export function restoreConversationLinks(rows: Row[]): Statement[] {
  return rows.map(row => ["INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET contact_id=excluded.contact_id,linked_by=excluded.linked_by,created=excluded.created WHERE conversation_contacts.profile_id=excluded.profile_id", [row.conversation_id, row.profile_id, row.contact_id, row.linked_by, row.created]]);
}
