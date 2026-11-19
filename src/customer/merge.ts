import { batch, one } from "../db";
import { auditStatement } from "../events";
import { access, canonical, seal, sha, unseal } from "../security";
import { searchText } from "../contact-csv";
import { ApiError, now, type Actor, type Env } from "../types";
import type { ContactMergePreview, ContactMergePreviewRequest, ContactMergeRequest, ContactMergeResult, ContactMergeUndoRequest, MergeField, MergeFieldDifference } from "../channel-contracts";
import type { Statement } from "./contracts";
import { customerAccess, guard, human } from "./local";
import { invalidateCustomerResolution } from "./ports";
import { assertManifest, cloneManifest, manifestHash, manifestRows, mergeChanged, planRelationMerge, readMergeManifest, relationStatements, restoreConversationLinks, updateStatement, type MergeManifest, type RelationChange } from "./merge-relations";

const TTL = 10 * 60_000;
// Instalação Paid (docs/LIMITES.md): reserva margem para as leituras,
// reautorização e recibo, dentro das 1.000 instruções da invocação D1.
const MAX_MERGE_BATCH_STATEMENTS = 800;
const fields: Record<Exclude<MergeField, "address">, string> = { name: "name", phone: "phone", email: "email", document: "document", personType: "person_type" };
interface Snapshot {
  version: 1; requestedSource: string; requestedTarget: string; conversationIds: string[];
  changes: RelationChange[]; contacts: { id: string; fields: Record<string, any> }[];
  conversations: { id: string; proof: string | null; state: string }[];
  links: Record<string, any>[];
}
function authorize(actor: Actor, profile: string) {
  human(actor); customerAccess(actor, profile); customerAccess(actor, profile, true); access(actor, profile, "contacts:merge");
  if (actor.module || actor.credential || (actor.role !== "admin" && !actor.access?.includes("contacts:merge")))
    throw new ApiError(403, "forbidden", "A junção exige a permissão explícita de juntar contatos.");
}
function commandKey(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new ApiError(400, "invalid_request", "Informe uma chave idempotente válida.");
}
const requestHash = (actor: Actor, operation: string, source: string, input: unknown) => sha(canonical({ actor: actor.id, operation, source, input }));
const invalid = (): never => { throw new ApiError(400, "invalid_request", "Pedido de junção inválido."); };
async function pair(env: Env, actor: Actor, profile: string, sourceId: string, targetId: string) {
  authorize(actor, profile);
  if (!sourceId || typeof targetId !== "string" || !targetId || sourceId === targetId) invalid();
  const rows = await Promise.all([sourceId, targetId].map(id => one(env, "SELECT * FROM contacts WHERE profile_id=? AND id=?", profile, id)));
  if (rows.some(r => !r) || rows[0].namespace !== rows[1].namespace) throw new ApiError(404, "not_found", "Contatos não encontrados na mesma área e contexto.");
  return rows as [any, any];
}
function blockers(source: any, target: any, manifest: MergeManifest): ContactMergePreview["blockers"] {
  const result: { code: "merge_restricted" | "merge_changed" | "merge_jobs_pending" | "merge_erp_conflict" | "merge_relation_conflict"; message: string }[] = [];
  if ([source, target].some(r => r.identity_state !== "active")) result.push({ code: "merge_restricted", message: "Contato com restrição de dados." });
  if ([source, target].some(r => r.merged_into)) result.push({ code: "merge_changed", message: "Uma das fichas já foi juntada. Abra a ficha sobrevivente." });
  if (source.erp_contact_id && target.erp_contact_id && source.erp_contact_id !== target.erp_contact_id) result.push({ code: "merge_erp_conflict", message: "As fichas têm cadastros ERP diferentes. Concilie os cadastros no ERP." });
  if (source.local_patch_cipher || target.local_patch_cipher || manifestRows(manifest, "customer_jobs").some(r => !["done", "retained", "cancelled"].includes(r.state)))
    result.push({ code: "merge_jobs_pending", message: "Há solicitações ou alterações cadastrais pendentes de conciliação." });
  // Usa ambos os lados para também reservar o desfazer e as colisões idênticas.
  const writes = manifest.tables.filter(t => !["contacts", "messages", "outbox", "customer_jobs"].includes(t.table)).reduce((n, t) => n + t.rows.length, 0)
    + manifestRows(manifest, "conversation_contacts").length + 4 * manifest.tables.length + 20;
  if (writes > MAX_MERGE_BATCH_STATEMENTS) result.push({ code: "merge_relation_conflict", message: "O conjunto de relações excede o limite de uma junção atômica. Solicite uma revisão administrativa." });
  return result;
}
const summary = (row: any) => ({ id: row.id, version: row.version, name: row.name, phone: row.phone || null, email: row.email, document: row.document, erpId: row.erp_contact_id });
const empty = (v: unknown) => v === null || v === undefined || v === "";
function differences(source: any, target: any, survivor: string): MergeFieldDifference[] {
  return Object.entries(fields).filter(([, column]) => source[column] !== target[column]).map(([field, column]) => {
    const preferred = survivor === source.id ? "source" : "target", alternative = preferred === "source" ? "target" : "source";
    const values = { source: source[column] ?? null, target: target[column] ?? null };
    return { field: field as MergeField, ...values, defaultChoice: empty(values[preferred]) ? alternative : preferred, requiresConfirmation: !empty(values.source) && !empty(values.target) };
  });
}
function survivor(source: any, target: any) { return source.erp_contact_id && !target.erp_contact_id ? source.id : target.id; }
export async function previewContactMerge(env: Env, actor: Actor, profile: string, sourceId: string, input: ContactMergePreviewRequest): Promise<ContactMergePreview> {
  const [source, target] = await pair(env, actor, profile, sourceId, input?.targetId);
  const manifest = await readMergeManifest(env, profile, [source.id, target.id]), survivorId = survivor(source, target);
  const problems = [...blockers(source, target, manifest)];
  try { planRelationMerge(cloneManifest(manifest), survivorId === source.id ? target.id : source.id, survivorId, now()); }
  catch (error) { if (error instanceof ApiError && error.code === "merge_relation_conflict") problems.push({ code: "merge_relation_conflict", message: error.message }); else throw error; }
  const expiresAt = now() + TTL, diff = differences(source, target, survivorId);
  const token = await seal(env, { kind: "contact-merge", profile, actor: actor.id, source: source.id, target: target.id, sourceVersion: source.version, targetVersion: target.version, survivorId, manifest: await manifestHash(manifest), expiresAt });
  return { source: summary(source), target: summary(target), survivorId, differences: diff, relationCounts: Object.fromEntries(manifest.tables.filter(t => !["contacts", "messages", "bot_runs", "outbox", "customer_jobs"].includes(t.table)).map(t => [t.table, t.rows.length])), blockers: problems, previewToken: btoa(token), expiresAt };
}
function result(row: any, duplicate = false, undo = row.state === "undone"): ContactMergeResult {
  return { id: row.id, sourceId: row.source_id, targetId: row.target_id, sourceVersion: row.source_version + (undo ? 1 : 0), targetVersion: row.target_version + (undo ? 1 : 0), state: undo ? "undone" : "applied", duplicate };
}
async function receipt(env: Env, actor: Actor, profile: string, command: string, hash: string, undo: boolean) {
  authorize(actor, profile);
  const row = await one(env, "SELECT * FROM customer_merges WHERE profile_id=? AND (command_id=? OR undo_command_id=?)", profile, command, command);
  if (!row) return null;
  if ((undo ? row.undo_command_id : row.command_id) !== command || (undo ? row.undo_request_hash : row.request_hash) !== hash || row.actor_id !== actor.id && !undo)
    throw new ApiError(409, "idempotency_conflict", "Esta chave já foi usada com outro pedido.");
  const members = await pair(env, actor, profile, row.source_id, row.target_id);
  if (members.some(r => r.identity_state !== "active")) throw new ApiError(409, "merge_restricted", "Este contato tem restrição de dados.");
  return result(row, true, undo);
}
async function commit(env: Env, statements: Statement[]) {
  if (statements.length > MAX_MERGE_BATCH_STATEMENTS)
    throw new ApiError(409, "merge_relation_conflict", "O conjunto de relações excede o limite de uma junção atômica.");
  try { await batch(env, statements); }
  catch (error) {
    if (/CHECK constraint failed.*(?:ok|customer_assert)|UNIQUE constraint failed|FOREIGN KEY constraint failed/i.test(String(error))) mergeChanged();
    throw error;
  } finally { invalidateCustomerResolution(env); }
}
function invalidateBots(manifest: MergeManifest, at: number): Statement[] {
  const statements: Statement[] = [];
  for (const row of manifestRows(manifest, "bot_runs")) {
    const next = { context: "{}", ...( ["queued", "starting", "running"].includes(row.status) ? { status: row.remote_id ? "cancelling" : "cancelled", updated: at } : {}) };
    Object.assign(row, next); statements.push(updateStatement("bot_runs", row.profile_id, { id: row.id }, next));
  }
  return statements;
}
export async function mergeContacts(env: Env, actor: Actor, profile: string, sourceId: string, command: string, input: ContactMergeRequest): Promise<ContactMergeResult> {
  authorize(actor, profile); commandKey(command);
  if (!input || !Number.isSafeInteger(input.sourceVersion) || !Number.isSafeInteger(input.targetVersion) || typeof input.previewToken !== "string" || !input.fieldChoices || typeof input.fieldChoices !== "object" || Array.isArray(input.fieldChoices)) invalid();
  if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 500 || /[\u0000-\u001f]/.test(input.reason))) invalid();
  const hash = await requestHash(actor, "merge", sourceId, input), replay = await receipt(env, actor, profile, command, hash, false); if (replay) return replay;
  const [requestedSource, requestedTarget] = await pair(env, actor, profile, sourceId, input.targetId);
  const before = await readMergeManifest(env, profile, [sourceId, input.targetId]);
  const problems = blockers(requestedSource, requestedTarget, before);
  if (problems.length) {
    const concurrent = await receipt(env, actor, profile, command, hash, false); if (concurrent) return concurrent;
    throw new ApiError(409, problems[0].code, problems[0].message);
  }
  let token: any;
  try { token = await unseal(env, atob(input.previewToken)); } catch { invalid(); }
  if (token.kind !== "contact-merge" || token.profile !== profile || token.actor !== actor.id || token.source !== sourceId || token.target !== input.targetId || token.expiresAt < now() || token.sourceVersion !== input.sourceVersion || token.targetVersion !== input.targetVersion || input.sourceVersion !== requestedSource.version || input.targetVersion !== requestedTarget.version || token.manifest !== await manifestHash(before)) {
    const concurrent = await receipt(env, actor, profile, command, hash, false); if (concurrent) return concurrent;
    mergeChanged();
  }
  const targetId = survivor(requestedSource, requestedTarget), archivedId = targetId === sourceId ? input.targetId : sourceId;
  const after = cloneManifest(before), source = manifestRows(after, "contacts").find(r => r.id === archivedId)!, target = manifestRows(after, "contacts").find(r => r.id === targetId)!;
  const at = now(), id = `merge:${await sha(canonical([profile, command]))}`;
  const changes = planRelationMerge(after, archivedId, targetId, at);
  const patch: Record<string, any> = {}, diff = differences(requestedSource, requestedTarget, targetId);
  for (const [key, choice] of Object.entries(input.fieldChoices)) if (!diff.some(d => d.field === key) || !["source", "target"].includes(choice)) invalid();
  for (const d of diff) {
    const choice = input.fieldChoices[d.field] ?? d.defaultChoice;
    const column = fields[d.field as Exclude<MergeField, "address">]; patch[column] = (choice === "source" ? requestedSource : requestedTarget)[column];
  }
  patch.version = target.version + 1; patch.updated = at; patch.updated_by = actor.id;
  patch.search_text = searchText([patch.name ?? target.name, patch.phone ?? target.phone, patch.email ?? target.email, target.company].join(" "));
  // O backfill legado ainda percorre aliases. Retira só os candidatos
  // telefônicos da origem arquivada; provas e índices já foram reapontados.
  // O snapshot conserva os valores exatos para o desfazer, sem restringir a ficha.
  const sourcePatch = { merged_into: targetId, merge_id: id, phone: "",
    mirror_json: source.mirror_json ? JSON.stringify({ ...JSON.parse(source.mirror_json), phones: [] }) : null,
    version: source.version + 1, updated: at, updated_by: actor.id };
  const snapshot: Snapshot = { version: 1, requestedSource: sourceId, requestedTarget: input.targetId, conversationIds: before.conversationIds, changes,
    contacts: [{ id: source.id, fields: Object.fromEntries(Object.keys(sourcePatch).map(k => [k, source[k]])) }, { id: target.id, fields: Object.fromEntries(Object.keys(patch).map(k => [k, target[k]])) }],
    conversations: manifestRows(before, "conversations").map(c => ({ id: c.id, proof: c.customer_identity_proof, state: c.customer_link_state })),
    links: manifestRows(before, "conversation_contacts") };
  Object.assign(source, sourcePatch); Object.assign(target, patch);
  const statements = [...assertManifest(before, command), ...relationStatements(profile, changes), updateStatement("contacts", profile, { id: archivedId, version: requestedSource.id === archivedId ? requestedSource.version : requestedTarget.version }, sourcePatch), ...guard(command, "merge-source"), updateStatement("contacts", profile, { id: targetId, version: targetId === requestedSource.id ? requestedSource.version : requestedTarget.version }, patch), ...guard(command, "merge-target")];
  for (const c of manifestRows(after, "conversations")) {
    const next = { customer_identity_proof: c.customer_identity_proof === archivedId ? targetId : c.customer_identity_proof, customer_link_state: c.customer_link_state, epoch: c.epoch + 1, updated: at };
    Object.assign(c, next); statements.push(updateStatement("conversations", profile, { id: c.id }, next));
  }
  statements.push(...restoreConversationLinks(manifestRows(after, "conversation_contacts")), ...invalidateBots(after, at));
  const afterHash = await manifestHash(after), cipher = await seal(env, snapshot);
  statements.push(...assertManifest(after, `${command}:after`), ["INSERT INTO customer_merges(profile_id,id,namespace,source_id,target_id,command_id,request_hash,actor_id,reason,state,before_cipher,after_hash,source_version,target_version,created) VALUES(?,?,?,?,?,?,?,?,?,'applied',?,?,?,?,?)", [profile, id, source.namespace, archivedId, targetId, command, hash, actor.id, input.reason?.trim() ?? "", cipher, afterHash, source.version, target.version, at]], auditStatement(actor, profile, "contact.merge", id, command));
  try { await commit(env, statements); } catch (error) { const concurrent = await receipt(env, actor, profile, command, hash, false); if (concurrent) return concurrent; throw error; }
  return { id, sourceId: archivedId, targetId, sourceVersion: source.version, targetVersion: target.version, state: "applied", duplicate: false };
}
export async function undoContactMerge(env: Env, actor: Actor, profile: string, sourceId: string, command: string, input: ContactMergeUndoRequest): Promise<ContactMergeResult> {
  authorize(actor, profile); commandKey(command);
  if (!input || typeof input.mergeId !== "string") invalid();
  const hash = await requestHash(actor, "undo-merge", sourceId, input), replay = await receipt(env, actor, profile, command, hash, true); if (replay) return replay;
  const row = await one(env, "SELECT * FROM customer_merges WHERE profile_id=? AND id=? AND (source_id=? OR target_id=?)", profile, input.mergeId, sourceId, sourceId);
  if (!row) throw new ApiError(404, "not_found", "Junção não encontrada.");
  const [source, target] = await pair(env, actor, profile, row.source_id, row.target_id);
  if ([source, target].some(r => r.identity_state !== "active") || !row.before_cipher) throw new ApiError(409, "merge_restricted", "Não é possível desfazer uma junção com restrição de dados.");
  if (row.state !== "applied" || source.merged_into !== target.id || source.merge_id !== row.id || target.merged_into || source.version !== row.source_version || target.version !== row.target_version || input.sourceVersion !== undefined && input.sourceVersion !== source.version || input.targetVersion !== undefined && input.targetVersion !== target.version) {
    const concurrent = await receipt(env, actor, profile, command, hash, true); if (concurrent) return concurrent;
    mergeChanged();
  }
  let snapshot: Snapshot; try { snapshot = await unseal(env, row.before_cipher); } catch { mergeChanged(); }
  if (snapshot.version !== 1) mergeChanged();
  const before = await readMergeManifest(env, profile, [source.id, target.id], snapshot.conversationIds);
  if (await manifestHash(before) !== row.after_hash) {
    const concurrent = await receipt(env, actor, profile, command, hash, true); if (concurrent) return concurrent;
    mergeChanged();
  }
  const at = now(), statements = [...assertManifest(before, command), ...relationStatements(profile, snapshot.changes, true)];
  for (const entry of snapshot.contacts) statements.push(updateStatement("contacts", profile, { id: entry.id }, { ...entry.fields, version: (entry.id === source.id ? source.version : target.version) + 1, updated: at, updated_by: actor.id }));
  for (const c of snapshot.conversations) {
    const current = manifestRows(before, "conversations").find(r => r.id === c.id)!;
    statements.push(updateStatement("conversations", profile, { id: c.id }, { customer_identity_proof: c.proof, customer_link_state: c.state, epoch: current.epoch + 1, updated: at }));
  }
  statements.push(...restoreConversationLinks(snapshot.links), ...invalidateBots(before, at),
    ["UPDATE customer_merges SET state='undone',undone_at=?,undone_by=?,undo_command_id=?,undo_request_hash=? WHERE profile_id=? AND id=? AND state='applied' AND after_hash=?", [at, actor.id, command, hash, profile, row.id, row.after_hash]], ...guard(command, "merge-undo"), auditStatement(actor, profile, "contact.merge.undo", row.id, command));
  try { await commit(env, statements); } catch (error) { const concurrent = await receipt(env, actor, profile, command, hash, true); if (concurrent) return concurrent; throw error; }
  return result({ ...row, state: "undone" });
}
