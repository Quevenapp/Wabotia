import { all, one } from "../db";
import { seal, unseal, canonical, access } from "../security";
import { auditStatement } from "../events";
import { ApiError, now, type Actor, type Env } from "../types";
import { moduleEnabled } from "../modules/registry";
import { requireAccess } from "../access";
import { historyPort, profilePort, customerRetention } from "./ports";
import { isFullCustomerEnabled } from "./feature";
import { normalizeCustomerPhone } from "./phone";
import { activeContact, contactRow, customerAccess, guard, guardedBatch, human, namespaceFor } from "./local";
import { jobInsert, jobView, replayJob, requestHash } from "./jobs";
import type { Namespace, Statement } from "./contracts";
import type { SectionWrite } from "./profile-contracts";

export function pageQuery(query: Record<string, string | undefined>, fallback: number, maximum: number) {
  if (query.limit !== undefined && (!/^\d+$/.test(query.limit) || Number(query.limit) < 1))
    throw new ApiError(400, "invalid_request", "Limite inválido.");
  return { limit: Math.min(maximum, Number(query.limit) || fallback), ...(query.cursor ? { cursor: query.cursor } : {}) };
}
export async function requireCustomerModule(env: Env, actor: Actor, profile: string, module: string) {
  human(actor); access(actor, profile, "contacts:read");
  requireAccess(actor, module);
  if (!(module === "erp" ? await isFullCustomerEnabled(env, profile) : await moduleEnabled(env, profile, module)))
    throw new ApiError(409, "module_disabled", "Este módulo está desligado nesta área.");
}
export async function customerRead(env: Env, actor: Actor, profile: string, id: string, kind: string, query: Record<string, string | undefined>, module = "", contribution = "") {
  human(actor);
  if (kind === "conversation-history") {
    access(actor, profile, "conversations:read");
    requireAccess(actor, "conversations");
    return historyPort.read(env, actor, profile, { conversationId: id }, pageQuery(query, 20, 50));
  }
  // A ficha autoriza cada contribuição: um papel de extensão não precisa do
  // cadastro comum para chegar à própria seção.
  if (kind === "profile") return profilePort.view(env, actor, profile, id);
  if (kind === "history") customerAccess(actor, profile);
  else await requireCustomerModule(env, actor, profile, module);
  await contactRow(env, actor, profile, id);
  if (kind === "history") return historyPort.read(env, actor, profile, { contactId: id }, pageQuery(query, 20, 50));
  if (kind === "collection") return profilePort.collection(env, actor, profile, id, module, contribution, pageQuery(query, 25, 100));
  return profilePort.section(env, actor, profile, id, module, contribution);
}
export async function saveCustomerSection(env: Env, actor: Actor, profile: string, data: any, command: string) {
  await requireCustomerModule(env, actor, profile, data.module);
  await contactRow(env, actor, profile, data.id);
  const input: SectionWrite = { commandId: command, expectedVersion: data.expectedVersion, data: data.data };
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new ApiError(400, "invalid_request", "Informe a versão da seção.");
  return profilePort.saveSection(env, actor, profile, data.id, data.module, data.section, input);
}
function namespace(value: unknown, actor: Actor): Namespace {
  if (typeof value !== "string" || !(value === "team" || /^app:[^\s]{1,190}$/.test(value)))
    throw new ApiError(400, "invalid_request", "Contexto inválido.");
  if (actor.kind !== "user" && value !== namespaceFor(actor)) throw new ApiError(404, "not_found", "Identidade não encontrada.");
  return value as Namespace;
}
function reason(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\u0000-\u001f]/.test(value))
    throw new ApiError(400, "invalid_request", "Informe um motivo administrativo de até 500 caracteres.");
  return value.trim();
}
export async function resolvePhone(env: Env, actor: Actor, profile: string, data: any, command: string) {
  human(actor); customerAccess(actor, profile, true);
  const ns = namespace(data.namespace, actor), phone = normalizeCustomerPhone(data.phone, "international");
  const why = reason(data.reason);
  if (!phone || !Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 1 || typeof data.contactId !== "string")
    throw new ApiError(400, "invalid_request", "Informe telefone, contato e versão da identidade.");
  const hash = await requestHash(actor, { operation: "resolve_phone", data });
  const replay = await replayJob(env, profile, command, hash);
  if (replay) return unseal(env, replay.result_cipher);
  const candidate = await one(env, "SELECT c.* FROM customer_phone_candidates p JOIN contacts c ON c.id=p.contact_id AND c.profile_id=p.profile_id AND c.namespace=p.namespace WHERE p.profile_id=? AND p.namespace=? AND p.phone=? AND p.contact_id=? AND c.identity_state='active'", profile, ns, phone, data.contactId);
  if (!candidate) throw new ApiError(404, "not_found", "Candidato não encontrado.");
  // Escolha administrativa não é prova. Só conserva continuidade de canal
  // já persistida, sem criar procedência observed ou trocar proprietários.
  const proofSql = `EXISTS(SELECT 1 FROM customer_phone_candidates k JOIN conversations v
    ON v.profile_id=k.profile_id AND v.verified_phone=k.phone AND v.phone=v.verified_phone
    JOIN connections cn ON cn.id=v.connection_id AND cn.profile_id=v.profile_id
    JOIN customer_records r ON r.profile_id=v.profile_id AND r.conversation_id=v.id AND r.contact_id=k.contact_id
      AND ((r.module_id='conversations' AND r.kind='session') OR (r.module_id='core' AND r.kind='conversation'))
      AND r.record_id=v.id||':'||v.session
    WHERE k.profile_id=? AND k.namespace='team' AND k.phone=? AND k.contact_id=? AND k.origin='observed'
      AND cn.kind IN ('meta','qr','zernio') AND v.external_namespace='channel:'||cn.id AND v.chat_type='direct'
      AND v.customer_link_state NOT IN ('blocked','excluded')
      AND NOT EXISTS(SELECT 1 FROM customer_phone_candidates other WHERE other.profile_id=k.profile_id
        AND other.namespace=k.namespace AND other.phone=k.phone AND other.contact_id<>k.contact_id AND other.origin='observed'))`;
  const proof = ns === "team" && !!await one(env, `SELECT 1 WHERE ${proofSql}`, profile, phone, candidate.id);
  const state = proof ? "ready" : "ambiguous";
  const result = { namespace: ns, phone, contactId: proof ? candidate.id : null, version: data.expectedVersion + 1, state };
  const job = jobInsert(profile, ns, candidate.id, "resolve_phone", command, hash, await seal(env, { actor, reason: why, phone, expectedVersion: data.expectedVersion }), candidate.version, candidate.erp_version);
  await guardedBatch(env, [job.statement,
    [`UPDATE customer_phones SET contact_id=?,state=?,version=version+1 WHERE profile_id=? AND namespace=? AND phone=? AND version=? AND EXISTS(SELECT 1 FROM customer_phone_candidates k JOIN contacts c ON c.id=k.contact_id AND c.profile_id=k.profile_id AND c.namespace=k.namespace WHERE k.profile_id=? AND k.namespace=? AND k.phone=? AND k.contact_id=? AND c.identity_state='active') AND (?=0 OR ${proofSql})`, [result.contactId, state, profile, ns, phone, data.expectedVersion, profile, ns, phone, candidate.id, proof ? 1 : 0, profile, phone, candidate.id]],
    ...guard(command, "resolve-phone"),
    // Invalida só o marcador; referências e históricos antigos não são reapontados.
    ["UPDATE conversations SET customer_link_state='pending' WHERE profile_id=? AND verified_phone=? AND (CASE WHEN external_namespace LIKE 'app:%' THEN external_namespace ELSE 'team' END)=? AND customer_link_state NOT IN ('blocked','excluded')", [profile, phone, ns]],
    ["UPDATE customer_jobs SET state='done',payload_cipher=NULL,result_cipher=?,cursor_json=?,updated=max(updated+1,?) WHERE profile_id=? AND id=?", [await seal(env, result), JSON.stringify({ reason: why, selectedContactId: candidate.id }), now(), profile, job.id]],
    auditStatement(actor, profile, "contact.resolve_phone", candidate.id, command),
  ]);
  return result;
}
export async function eraseContact(env: Env, actor: Actor, profile: string, id: string, data: any, command: string) {
  human(actor); customerAccess(actor, profile, true);
  if (actor.role !== "admin") throw new ApiError(403, "forbidden", "A exclusão exige um administrador.");
  const why = reason(data.reason);
  if (data.confirm !== true || !Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 1)
    throw new ApiError(400, "invalid_request", "Confirme o pedido e informe a versão do contato.");
  const hash = await requestHash(actor, { operation: "erase", id, data });
  const replay = await replayJob(env, profile, command, hash);
  if (replay) return jobView(replay);
  const row = await contactRow(env, actor, profile, id, true);
  const previous = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND contact_id=? AND kind='erase' ORDER BY created,id LIMIT 1", profile, id);
  if (previous) return jobView(previous);
  activeContact(row);
  if (row.version !== data.expectedVersion) throw new ApiError(409, "contact_conflict", "O contato mudou. Reabra a ficha.");
  const impediments = await customerRetention(env, profile, id);
  const errorCode = impediments[0] ?? "retention_inventory_incomplete";
  const job = jobInsert(profile, row.namespace, id, "erase", command, hash, await seal(env, { actor, reason: why, impediments }), row.version, row.erp_version);
  const statements: Statement[] = [job.statement,
    ["UPDATE contacts SET identity_state='restricted',local_patch_cipher=NULL,version=version+1,updated=?,updated_by=? WHERE profile_id=? AND id=? AND version=? AND identity_state='active'", [now(), actor.id, profile, id, row.version]],
    ...guard(command, "restrict"),
    ["UPDATE customer_jobs SET state='cancelled',lease_until=NULL,payload_cipher=NULL,error_code='customer_erasing',updated=max(updated+1,?) WHERE profile_id=? AND contact_id=? AND id<>? AND state NOT IN ('done','retained','cancelled')", [now(), profile, id, job.id]],
    ["UPDATE conversations SET customer_link_state='excluded' WHERE profile_id=? AND (id IN (SELECT conversation_id FROM conversation_contacts WHERE profile_id=? AND contact_id=?) OR (verified_phone IN (SELECT phone FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND contact_id=?) AND (CASE WHEN external_namespace LIKE 'app:%' THEN external_namespace ELSE 'team' END)=?))", [profile, profile, id, profile, row.namespace, id, row.namespace]],
    // Candidatos e telefone ficam como tombstone: um novo inbound não recria a pessoa.
    ["UPDATE customer_jobs SET state='retained',error_code=?,updated=max(updated+1,?) WHERE profile_id=? AND id=?", [errorCode, now(), profile, job.id]],
    auditStatement(actor, profile, "contact.erasure", id, command),
  ];
  await guardedBatch(env, statements);
  return jobView(await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, job.id));
}
export async function contactConflicts(env: Env, actor: Actor, profile: string, query: Record<string, string | undefined>) {
  human(actor); customerAccess(actor, profile);
  const page = pageQuery(query, 25, 100);
  const context = canonical({ profile, actor: actor.id, access: actor.access ?? null, kind: "contact-conflicts" });
  let after = "", cut = now();
  if (page.cursor) {
    try {
      const decoded = await unseal(env, atob(page.cursor));
      if (decoded.context !== context || typeof decoded.after !== "string" || !Number.isSafeInteger(decoded.cut)) throw Error();
      after = decoded.after; cut = decoded.cut;
    } catch { throw new ApiError(400, "invalid_cursor", "Cursor inválido."); }
  }
  const rows = await all(env, `SELECT * FROM (
    SELECT 'phone:'||namespace||':'||phone key,'identity' kind,namespace,phone,NULL id,NULL contact_id,version,NULL error_code FROM customer_phones p WHERE profile_id=? AND state='ambiguous' AND EXISTS(SELECT 1 FROM customer_phone_candidates k JOIN contacts c ON c.id=k.contact_id AND c.profile_id=k.profile_id AND c.namespace=k.namespace WHERE k.profile_id=p.profile_id AND k.namespace=p.namespace AND k.phone=p.phone AND c.identity_state='active')
    UNION ALL SELECT 'job:'||j.id key,'job' kind,j.namespace,NULL phone,j.id,j.contact_id,NULL version,j.error_code FROM customer_jobs j JOIN contacts c ON c.id=j.contact_id AND c.profile_id=j.profile_id AND c.namespace=j.namespace WHERE j.profile_id=? AND j.state='conflict' AND j.created<=? AND c.identity_state='active'
  ) WHERE key>? ORDER BY key LIMIT ?`, profile, profile, cut, after, page.limit + 1);
  const more = rows.length > page.limit; rows.splice(page.limit);
  const items = [];
  for (const row of rows) {
    if (row.kind === "job") items.push({ kind: "job", id: row.id, contactId: row.contact_id, errorCode: row.error_code });
    else {
      const candidates = await all(env, "SELECT c.id,c.name,c.phone FROM customer_phone_candidates k JOIN contacts c ON c.id=k.contact_id AND c.profile_id=k.profile_id AND c.namespace=k.namespace WHERE k.profile_id=? AND k.namespace=? AND k.phone=? AND c.identity_state='active' ORDER BY c.id", profile, row.namespace, row.phone);
      items.push({ kind: "identity", namespace: row.namespace, phone: row.phone, version: row.version, candidates });
    }
  }
  return { items, nextCursor: more ? btoa(await seal(env, { context, cut, after: rows.at(-1)!.key })) : null, incomplete: false };
}
/** Converte apenas sucesso durável pendente; mantém os códigos de erro do Coordinator. */
export async function customerResponse(response: Response, operation: string): Promise<Response> {
  if (!response.ok) return response;
  const value: any = await response.clone().json();
  const pending = value?.pending === true || value?.result?.pending === true;
  const status = operation === "contact.promote" || operation === "contact.erasure" || pending ? 202 : response.status;
  return new Response(response.body, { status, headers: response.headers });
}
