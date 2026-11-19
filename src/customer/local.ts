import { one, batch } from "../db";
import { access } from "../security";
import { requireAccess } from "../access";
import { ApiError, type Actor, type Env } from "../types";
import { normalizeCustomerPhone } from "./phone";
import type { CustomerMirror, CustomerPatch, CustomerWrite, Namespace, Statement } from "./contracts";

export const namespaceFor = (actor: Actor): Namespace => actor.kind === "app" ? `app:${actor.id}` : "team";
export const isCustomerSelfActor = (actor: Actor) => actor.kind === "connector" && actor.id.startsWith("customer:") &&
  actor.role === "service" && actor.scopes.length === 1 && actor.scopes[0] === "contacts:self" && !actor.via && !actor.module && !actor.credential;
export async function validateCustomerSelfActor(env: Env, actor: Actor, profile: string, contactId: string) {
  if (!isCustomerSelfActor(actor) || actor.profiles.length !== 1 || actor.profiles[0] !== profile || !await one(env,
    `SELECT 1 FROM conversations c JOIN customer_phones p ON p.profile_id=c.profile_id AND p.namespace='team' AND p.phone=c.verified_phone AND p.state='ready'
     JOIN contacts k ON k.id=p.contact_id AND k.profile_id=p.profile_id AND k.identity_state='active'
     WHERE c.profile_id=? AND 'customer:'||c.id||':'||c.session=? AND p.contact_id=? AND c.customer_link_state='ready'
       AND c.phone=c.verified_phone AND c.connection_id IS NOT NULL AND c.external_namespace='channel:'||c.connection_id AND c.chat_type='direct'
       AND NOT EXISTS(SELECT 1 FROM cond_people cp JOIN cond_memberships cm ON cm.profile_id=cp.profile_id AND cm.person_id=cp.id WHERE cp.profile_id=k.profile_id AND cp.contact_id=k.id AND cm.role='dependente')
       AND NOT EXISTS(SELECT 1 FROM saude_contact_links s WHERE s.profile_id=k.profile_id AND s.contact_id=k.id AND s.relation='self')`, profile, actor.id, contactId))
    throw new ApiError(403, "forbidden", "Confirmação cadastral não pertence à sessão autenticada.");
}
export function customerAccess(actor: Actor, profile: string, write = false) {
  try {
    access(actor, profile, write ? "contacts:write" : "contacts:read");
    requireAccess(actor, "contacts");
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) throw new ApiError(403, "forbidden", "Acesso ao cadastro não permitido.");
    throw error;
  }
  if (actor.kind !== "user" && actor.kind !== "app" && !isCustomerSelfActor(actor))
    throw new ApiError(403, "forbidden", "Acesso ao cadastro não permitido.");
}
export function human(actor: Actor) {
  if (actor.kind !== "user" || actor.via)
    throw new ApiError(403, "forbidden", "Esta ação exige uma pessoa autenticada.");
}
export async function contactRow(env: Env, actor: Actor, profile: string, id: string, restricted = false) {
  const row = await one(env, "SELECT * FROM contacts WHERE profile_id=? AND id=? AND (?=1 OR namespace=?)", profile, id, actor.kind === "user" ? 1 : 0, namespaceFor(actor));
  if (!row || (!restricted && row.identity_state !== "active"))
    throw new ApiError(404, "not_found", "Contato não encontrado.");
  return row;
}
export function activeContact(row: any) {
  if (row.identity_state !== "active")
    throw new ApiError(409, "customer_erasing", "Este contato tem um pedido de exclusão.");
}
export function guard(command: string, step: string): Statement[] {
  const id = `customer:${command}:${step}`;
  return [
    ["INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)", [id]],
    ["DELETE FROM customer_assert WHERE id=?", [id]],
  ];
}
export async function guardedBatch(env: Env, statements: Statement[]) {
  try { return await batch(env, statements); }
  catch (error) {
    if (/CHECK constraint failed.*(?:ok|customer_assert)|UNIQUE constraint failed: customer_assert/i.test(String(error)))
      throw new ApiError(409, "contact_conflict", "O cadastro mudou. Reabra a ficha antes de salvar.");
    throw error;
  }
}
const invalid = (): never => { throw new ApiError(400, "invalid_customer_patch", "Dados cadastrais inválidos."); };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, any>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\ufffd]/.test(value)) return invalid();
  return value.trim();
}
export function validatePatch(value: unknown): CustomerPatch {
  const input = object(value), patch: CustomerPatch = {};
  const keys = ["name", "phones", "email", "document", "personType", "address"];
  if (Object.keys(input).some(k => !keys.includes(k))) return invalid();
  if ("name" in input) patch.name = text(input.name, 200);
  if ("phones" in input) {
    if (!Array.isArray(input.phones) || input.phones.length > 20) return invalid();
    patch.phones = [...new Set<string>(input.phones.map((p: unknown) => normalizeCustomerPhone(p, "international") ?? invalid()))];
  }
  if ("email" in input) {
    patch.email = text(input.email, 254).toLowerCase();
    if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) return invalid();
  }
  if ("document" in input) patch.document = input.document === null ? null : text(input.document, 40) || null;
  if ("personType" in input) {
    if (![null, "F", "J", "E"].includes(input.personType)) return invalid();
    patch.personType = input.personType;
  }
  if ("address" in input) {
    const address = object(input.address);
    const keys = ["street", "number", "complement", "district", "city", "state", "postalCode", "country"];
    if (Object.keys(address).some(k => !keys.includes(k))) return invalid();
    patch.address = Object.fromEntries(Object.entries(address).map(([k, v]) => [k, text(v, k === "street" || k === "complement" ? 200 : 100)]));
  }
  return patch;
}
export function validateWrite(input: CustomerWrite): CustomerWrite {
  object(input);
  if (typeof input.commandId !== "string" || !input.commandId || input.commandId.length > 200 ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      !(input.expectedErpVersion === null || (Number.isSafeInteger(input.expectedErpVersion) && input.expectedErpVersion > 0)) ||
      !["fill_empty", "replace_confirmed"].includes(input.mode)) return invalid();
  return { commandId: input.commandId, expectedVersion: input.expectedVersion, expectedErpVersion: input.expectedErpVersion, mode: input.mode, patch: validatePatch(input.patch) };
}
export function mirrorOf(row: any): CustomerMirror {
  const previous = row.mirror_json ? JSON.parse(row.mirror_json) : null;
  return { name: row.name, phones: previous?.phones ?? (row.phone ? [row.phone] : []), email: row.email,
    document: row.document ?? null, personType: row.person_type ?? null };
}
export function cleanMirror(value: CustomerMirror): CustomerMirror {
  const patch = validatePatch({ name: value.name, phones: value.phones, email: value.email, document: value.document, personType: value.personType });
  if (!patch.name && !patch.phones?.length) return invalid();
  return patch as CustomerMirror;
}
export const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const empty = (value: unknown) => value == null || value === "" || (Array.isArray(value) && !value.length);
/** Só campos declarados; endereço fica exclusivamente na intenção cifrada. */
export function mergePatch(base: CustomerMirror, patch: CustomerPatch, mode: CustomerWrite["mode"]) {
  const merged = { ...base }, conflicts: string[] = [];
  for (const key of ["name", "phones", "email", "document", "personType"] as const) {
    if (!(key in patch)) continue;
    if (mode === "fill_empty" && !empty(base[key]) && !same(base[key], patch[key])) conflicts.push(key);
    else Object.assign(merged, { [key]: patch[key] });
  }
  if (!merged.name && !merged.phones.length) invalid();
  return { mirror: merged, conflicts };
}
/** Comparação de três versões, sem considerar observações locais como dado ERP. */
export function reconcilePatch(base: CustomerMirror, local: CustomerPatch, remote: CustomerMirror) {
  const patch: CustomerPatch = {}, conflicts: string[] = [];
  for (const key of ["name", "phones", "email", "document", "personType"] as const) {
    if (!(key in local)) continue;
    if (!same(base[key], remote[key]) && !same(local[key], remote[key])) conflicts.push(key);
    else Object.assign(patch, { [key]: local[key] });
  }
  // O contrato de leitura não contém endereço; não inventar um estado remoto vazio.
  if (local.address) conflicts.push("address");
  return { patch, conflicts };
}

/** Não recria por telefone uma identidade que ainda está sob retenção. */
export function phoneSafetyStatements(profile: string, namespace: Namespace, phones: readonly string[], command: string): Statement[] {
  if (!phones.length) return [];
  const id = `customer:${command}:restricted-phone`;
  return [
    ["INSERT INTO customer_assert(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM contacts c WHERE c.profile_id=? AND c.namespace=? AND c.identity_state<>'active' AND (c.phone IN (SELECT value FROM json_each(?)) OR c.id IN (SELECT contact_id FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND phone IN (SELECT value FROM json_each(?))))) THEN 0 ELSE 1 END", [id, profile, namespace, JSON.stringify(phones), profile, namespace, JSON.stringify(phones)]],
    ["DELETE FROM customer_assert WHERE id=?", [id]],
  ];
}
