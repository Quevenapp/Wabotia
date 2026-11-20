import { exec, one } from "../db";
import { erpBridge, resolveCustomer, enrichCustomer } from "../customer/ports";
import type { CustomerWrite } from "../customer/contracts";
import { customerAccess } from "../customer/local";
import { storedAccess } from "../security";
import type { Actor, Conversation, Env } from "../types";
import { readErpPartsState } from "../modules/erp/parts-state";
import type { CommercialSnapshot } from "./contracts";
import { ensureCommercialPolicy, requireIntegrationHuman } from "./policy";
import { canonical, hash, uuid5, F3_NAMESPACES } from "./keys";
import { IntegrationError } from "./privacy";

/** Os produtores com conversa usam as portas únicas da fase 1. */
export async function commercialCustomerRef(env: Env, conversation: Conversation) {
  const ref = await resolveCustomer(env, conversation);
  if (ref.profileId !== conversation.profile_id || ref.namespace !== "team" || ref.state !== "ready") throw new IntegrationError("customer_required");
  return { customer_ref: ref.contactId, contact_id: ref.erp?.id ?? null };
}
export const enrichCommercialCustomer = (env: Env, actor: Actor, conversation: Conversation, input: CustomerWrite) => enrichCustomer(env, actor, conversation, input);
export async function integrationPerson(env: Env, profile: string, id: string | null): Promise<Actor | undefined> {
  if (!id) return;
  const row = await one(env, "SELECT id,role,profiles,access FROM users WHERE id=? AND disabled=0", id);
  if (!row) return;
  const actor: Actor = { id: row.id, kind: "user", name: "Solicitante do cadastro", role: row.role, profiles: JSON.parse(row.profiles), access: storedAccess(row.access), scopes: [], bots: [], rate: 0, runLimit: 0 };
  try { customerAccess(actor, profile, true); } catch { return; }
  return actor;
}
async function promote(env: Env, profile: string, localId: string, actor?: Actor): Promise<string> {
  const row = await one(env, "SELECT id,name,version,erp_contact_id,erp_version FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active'", profile, localId);
  if (!row || !row.name.trim()) throw new IntegrationError("customer_required");
  if (row.erp_contact_id) return row.erp_contact_id;
  if (!actor) throw new IntegrationError("customer_promotion_required");
  const commandId = uuid5(F3_NAMESPACES.internal, canonical(["customer", profile, localId, row.version, actor.id]));
  const command = { profileId: profile, namespace: "team" as const, contactId: localId, commandId, actor,
    operation: "promote" as const, erpId: null, expectedErpVersion: null, expectedVersion: row.version, patch: {} };
  const result = await erpBridge.apply(env, { ...command, requestHash: hash({ commandId, contactId: localId, version: row.version }) });
  if (result.status !== "applied") throw new IntegrationError(result.status === "paused" && result.reason === "module_disabled" ? "part_disabled" : "customer_required", result.status === "paused" ? 409 : 422);
  return result.snapshot.erpId;
}
export async function ensureConsumer(env: Env, profile: string, actor?: Actor): Promise<string> {
  if (!(await readErpPartsState(env, profile)).snapshot.parts.customers) throw new IntegrationError("part_disabled", 409);
  const policy = await ensureCommercialPolicy(env, profile);
  if (policy.consumer_contact_id) {
    const row = await one(env, "SELECT id FROM contacts WHERE profile_id=? AND erp_contact_id=? AND namespace='team' AND identity_state='active'", profile, policy.consumer_contact_id);
    if (!row) throw new IntegrationError("customer_required");
    return policy.consumer_contact_id;
  }
  if (!actor) throw new IntegrationError("customer_promotion_required");
  requireIntegrationHuman(actor, profile); customerAccess(actor, profile, true);
  // Um único contato local por área, sem telefone, CPF ou outro dado fictício.
  const id = uuid5(F3_NAMESPACES.internal, canonical(["consumer", profile]));
  await exec(env, `INSERT OR IGNORE INTO contacts(id,profile_id,namespace,name,search_text,source,created_by,updated_by,created,updated)
    VALUES(?,?,'team','Consumidor','consumidor','manual',?,?,?,?)`, id, profile, actor.id, actor.id, Date.now(), Date.now());
  const creator = await one(env, "SELECT created_by FROM contacts WHERE id=? AND profile_id=?", id, profile);
  const erpId = await promote(env, profile, id, await integrationPerson(env, profile, creator.created_by));
  await exec(env, `UPDATE module_erp_policy SET config_json=json_set(config_json,'$.consumer_contact_id',?),version=version+1,updated_ms=?,updated_by=?
    WHERE profile_id=? AND json_extract(config_json,'$.consumer_contact_id') IS NULL`, erpId, Date.now(), actor.id, profile);
  return (await ensureCommercialPolicy(env, profile)).consumer_contact_id!;
}
export async function resolveCommercialCustomer(env: Env, snapshot: CommercialSnapshot, actor?: Actor): Promise<string> {
  if (!(await readErpPartsState(env, snapshot.source.profile)).snapshot.parts.customers) throw new IntegrationError("part_disabled", 409);
  if (snapshot.customer_ref) {
    const id = await promote(env, snapshot.source.profile, snapshot.customer_ref, actor);
    if (snapshot.contact_id && snapshot.contact_id !== id) throw new IntegrationError("customer_required");
    return id;
  }
  if (snapshot.contact_id) {
    const row = await one(env, "SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND identity_state='active' AND erp_contact_id=? AND trim(name)<>''", snapshot.source.profile, snapshot.contact_id);
    if (!row) throw new IntegrationError("customer_required");
    return snapshot.contact_id;
  }
  // Em Saúde/Ensino, o pagador adulto é obrigatório; não usar Consumidor.
  if (snapshot.privacy === "adult_payer_only") throw new IntegrationError("customer_required");
  return ensureConsumer(env, snapshot.source.profile, actor);
}
