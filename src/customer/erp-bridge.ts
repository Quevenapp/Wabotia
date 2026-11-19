import { all, exec, one } from "../db";
import { access, canonical, seal, sha, unseal } from "../security";
import { ApiError, now, uid, type Actor, type Env } from "../types";
import { erpIdentity, erpSystemIdentity } from "../modules/erp/identity";
import { CUSTOMER_BRIDGE_SCAN, type IdentityPort as ErpIdentity } from "../erp/engine/identity";
import { localFetch } from "../erp/api/local-fetch";
import type { BridgeCommand, BridgeResult, BridgeSnapshot, CustomerErpBridge, CustomerPatch } from "./contracts";
import { normalizeCustomerPhone } from "./phone";
import { isCustomerSelfActor, validateCustomerSelfActor } from "./local";
import { bridgeConflict, confirmBridgeSnapshot, contactForBridge, customerEnabled, freshCustomerEnv,
  markCustomerReconciliation, type BridgeContact, type BridgeJob } from "./sync";

const SYSTEM = "contact-erp-link";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new ApiError(400, "invalid_customer_patch", "Informe somente dados administrativos válidos.");
async function erpCommandId(value: string) {
  if (UUID.test(value)) return value;
  const hash = await sha(`customer-erp:${value}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function requireCustomerPerson(actor: Actor): void {
  if (actor.kind !== "user" || actor.via || actor.credential || actor.module || actor.id.startsWith("bot:"))
    throw new ApiError(403, "forbidden", "A ficha completa exige uma pessoa autenticada.");
}
class RpcFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export function snapshotOf(record: any): BridgeSnapshot {
  if (!record || typeof record.id !== "string" || !UUID.test(record.id) || !Number.isSafeInteger(record.version) || record.version < 1 || typeof record.name !== "string")
    throw new ApiError(503, "dependency_unavailable", "Resposta cadastral inválida.");
  const phones = [...new Set([record.phone, record.mobile].map((p) => normalizeCustomerPhone(p, "international")).filter((p): p is string => p !== null))];
  return { erpId: record.id, erpVersion: record.version, mirror: { name: record.name, phones,
    email: typeof record.email === "string" ? record.email : "", document: typeof record.document === "string" ? record.document : null,
    personType: ["F", "J", "E"].includes(record.person_type) ? record.person_type : null } };
}
function dataOf(patch: CustomerPatch): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
      Object.keys(patch).some((k) => !["name", "phones", "email", "document", "personType", "address"].includes(k))) throw invalid();
  const data: Record<string, unknown> = {};
  for (const [key, limit] of [["name", 200], ["email", 254], ["document", 30]] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!(key === "document" && value === null) && (typeof value !== "string" || value.length > limit || /[\u0000-\u001f]/.test(value))) throw invalid();
    data[key] = value;
  }
  if (patch.personType !== undefined) {
    if (patch.personType !== null && !["F", "J", "E"].includes(patch.personType)) throw invalid();
    data.person_type = patch.personType;
  }
  if (patch.phones !== undefined) {
    if (!Array.isArray(patch.phones) || patch.phones.length > 2) throw invalid();
    const phones = patch.phones.map((p) => normalizeCustomerPhone(p, "international"));
    if (phones.some((p) => p === null)) throw invalid();
    data.phone = phones[0] ?? "";
    // Um telefone no atendimento não apaga o mobile cadastrado no ERP.
    if (phones.length > 1) data.mobile = phones[1];
  }
  if (patch.address !== undefined) {
    const address = patch.address;
    const fields = { street: "street", number: "number", complement: "complement", district: "district", city: "city", state: "state", postalCode: "postal_code", country: "country" };
    if (!address || typeof address !== "object" || Array.isArray(address) || Object.keys(address).some((k) => !(k in fields))) throw invalid();
    for (const [key, field] of Object.entries(fields)) {
      const value = address[key as keyof typeof address];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw invalid();
      data[field] = value;
    }
  }
  return data;
}

export async function customerRpc(env: Env, profile: string, actor: Actor, identity: ErpIdentity, name: string, args: Record<string, unknown>) {
  if (!await customerEnabled(env, profile)) throw new ApiError(409, "module_disabled", "Cadastro completo desligado nesta área.");
  let response: Response;
  try {
    response = await localFetch(env, profile, actor, identity, { read: !name.endsWith("_save"), gate: { denied: null }, trackCustomers: false })(
      `https://erp.wabotia.invalid/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
  } catch (error) {
    if ((error as { code?: string })?.code === "erp_unavailable")
      throw new ApiError(503, "dependency_unavailable", "ERP temporariamente indisponível.");
    throw error;
  }
  const body = await response.json<any>().catch(() => { throw new ApiError(503, "dependency_unavailable", "Resposta ERP inválida."); });
  if (!response.ok) {
    if (response.status === 403 || body.code === "42501") throw new ApiError(403, "forbidden", "Seu acesso não permite esta operação no ERP.");
    if (response.status >= 500) throw new ApiError(503, "dependency_unavailable", "ERP temporariamente indisponível.");
    if (["erp_catalog_not_found", "erp_finance_not_found"].includes(body.message)) throw new ApiError(404, "not_found", "Contato não encontrado.");
    throw new RpcFailure(typeof body.message === "string" ? body.message : "erp_unavailable", response.status);
  }
  return body;
}
async function systemRpc(env: Env, profile: string, actor: Actor) {
  const identity = await erpSystemIdentity(freshCustomerEnv(env), profile, SYSTEM);
  return (name: string, args: Record<string, unknown>) => customerRpc(env, profile, actor, identity, name, args);
}
type Rpc = Awaited<ReturnType<typeof systemRpc>>;
const technicalActor = (profile: string): Actor => ({ id: SYSTEM, kind: "connector", name: "Sistema · Cadastro", role: "service", profiles: [profile], scopes: [], bots: [], rate: 0, runLimit: 0 });

interface Intent {
  command: BridgeCommand;
  fingerprint: string;
  data: Record<string, unknown>;
  source: { version: number; localPatch: string | null };
}
interface Metadata { fingerprint: string; intent?: string; sent?: boolean; done?: boolean; result?: BridgeResult }
const metadata = (job: BridgeJob): Metadata | undefined => JSON.parse(job.cursor_json).customerErp;
async function updateJob(env: Env, job: BridgeJob, value: Metadata, state = job.state, code: string | null = null) {
  const cursor = { ...JSON.parse(job.cursor_json), customerErp: value };
  const next = JSON.stringify(cursor);
  const result = await exec(env, `UPDATE customer_jobs SET cursor_json=?,state=?,error_code=?,updated=?,retry_at=?,lease_until=NULL
    WHERE profile_id=? AND id=? AND cursor_json=? AND state NOT IN ('done','cancelled','retained')`,
  next, state, code, now(), now() + 1000, job.profile_id, job.id, job.cursor_json);
  if (result.meta.changes !== 1) throw bridgeConflict("sync_pending");
  job.cursor_json = next; job.state = state;
}

async function duplicateCandidates(env: Env, contact: BridgeContact, data: Record<string, unknown>, rpc: Rpc, erpId: string | null) {
  const phones = [...new Set([data.phone, data.mobile].map((p) => normalizeCustomerPhone(p, "international")).filter((p): p is string => !!p))];
  const candidates = new Set<string>();
  let incomplete = false;
  if (phones.length) {
    // O legado ainda não totalmente indexado também conta, somente dentro de team.
    const local = await all<{ id: string; phone: string; mirror_json: string | null }>(env,
      `SELECT id,phone,mirror_json FROM contacts WHERE profile_id=? AND namespace='team' AND id<>? AND identity_state='active'
       AND (replace(replace(replace(replace(replace(replace(phone,'+',''),' ',''),'.',''),'-',''),'(',''),')','')
         IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM json_each(mirror_json,'$.phones')
         WHERE value IN (SELECT value FROM json_each(?)))) ORDER BY id LIMIT 101`,
      contact.profile_id, contact.id, JSON.stringify(phones), JSON.stringify(phones));
    incomplete ||= local.length > 100;
    for (const row of local) {
      const others = [row.phone, ...(row.mirror_json ? JSON.parse(row.mirror_json).phones ?? [] : [])];
      if (others.some((p) => phones.includes(normalizeCustomerPhone(p, "international") ?? ""))) candidates.add(row.id);
    }
    for (const phone of phones) {
      let page = 1, total = 0;
      do {
        const result = await rpc("erp_catalog_contact_page", { p_page: page, p_size: 100, p_sort: "created_desc", p_situation: "all", p_phone: phone });
        if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total)) throw new Error("erp_invalid_page");
        for (const other of result.items)
          if (other.id !== erpId && [other.phone, other.mobile].some((p) => normalizeCustomerPhone(p, "international") === phone)) candidates.add(other.id);
        total = result.total;
        // Nunca deduz ausência de uma consulta truncada. Filtro muito amplo
        // (por exemplo, fax/substring) fica para revisão em vez de abrir laço ilimitado.
        if (page >= 5 && page * 100 < total) { incomplete = true; break; }
      } while (page++ * 100 < total);
    }
  }
  // roles pertence apenas à criação. Depois do save, conferir a ficha existente
  // deve preservar sua classificação atual e respeitar a capacidade estreita.
  // A cópia mantém intacto o corpo persistido que será usado em qualquer replay.
  const checkData = { ...data };
  if (erpId !== null) delete checkData.roles;
  const checked = await rpc("erp_catalog_contact_check", { p_id: erpId, p_data: checkData });
  if (!Array.isArray(checked.warnings)) throw new Error("erp_invalid_warnings");
  for (const warning of checked.warnings)
    if (warning.code === "duplicate_document") for (const other of warning.matches ?? []) if (other.id !== erpId) candidates.add(other.id);
  // IDs ERP já reservados em app/restritos nunca viram candidatos visíveis de team.
  const hidden = candidates.size ? await all<{ erp_contact_id: string }>(env,
    "SELECT erp_contact_id FROM contacts WHERE profile_id=? AND erp_contact_id IN (SELECT value FROM json_each(?)) AND (namespace<>'team' OR identity_state<>'active')",
    contact.profile_id, JSON.stringify([...candidates])) : [];
  const excluded = new Set(hidden.map((r) => r.erp_contact_id));
  return { conflict: incomplete || candidates.size > 0 || checked.warnings.length > 0, candidateIds: [...candidates].filter((id) => !excluded.has(id)).slice(0, 100) };
}

async function deliver(env: Env, job: BridgeJob, intent: Intent): Promise<BridgeResult> {
  const command = intent.command;
  const m = metadata(job)!;
  if (!await customerEnabled(env, command.profileId)) {
    await updateJob(env, job, m, "paused", "module_disabled");
    return { status: "paused", reason: "module_disabled" };
  }
  const contact = await contactForBridge(env, command.profileId, command.contactId);
  if (!contact || contact.namespace !== "team" || contact.identity_state !== "active") throw bridgeConflict("customer_erasing");
  if (isCustomerSelfActor(command.actor)) await validateCustomerSelfActor(env, command.actor, command.profileId, command.contactId);
  const finish = async (result: BridgeResult, state: string, code: string) => {
    await updateJob(env, job, { ...m, result }, state, code); return result;
  };
  try {
    if (contact.version !== intent.source.version || contact.local_patch_cipher !== intent.source.localPatch)
      return finish({ status: "conflict", candidateIds: [] }, "conflict", "contact_conflict");
    if (command.operation === "promote" && !String(intent.data.name ?? "").trim())
      return finish({ status: "needs_data", fields: ["name"] }, "paused", "contact_required");
    const earlier = await one(env, `SELECT 1 FROM customer_jobs WHERE profile_id=? AND contact_id=? AND id<>?
      AND state IN ('pending','running','paused','conflict') AND (created<? OR (created=? AND id<?)) LIMIT 1`,
    job.profile_id, job.contact_id, job.id, job.created, job.created, job.id);
    if (earlier) throw bridgeConflict("sync_pending");
    const rpc = await systemRpc(env, command.profileId, command.actor);
    let snapshot: BridgeSnapshot;
    let replayed = !!m.sent;
    if (command.operation === "bind") {
      // Associação explícita sempre teve sua leitura humana autorizada no prepare.
      snapshot = snapshotOf((await rpc("erp_catalog_contact_get", { p_id: command.erpId })).record);
      if (command.expectedErpVersion !== null && snapshot.erpVersion !== command.expectedErpVersion)
        return finish({ status: "conflict", candidateIds: [] }, "conflict", "contact_conflict");
    } else {
      if (!m.sent) {
        const found = await duplicateCandidates(env, contact, intent.data, rpc, command.erpId);
        if (found.conflict) return finish({ status: "conflict", candidateIds: found.candidateIds }, "conflict", "possible_duplicate");
        // sent é durável ANTES da chamada: a recuperação não refaz preflight de criação.
        m.sent = true;
        await updateJob(env, job, m);
      }
      await markCustomerReconciliation(env, command.profileId);
      const saved = await rpc("erp_catalog_contact_save", { p_id: command.erpId,
        p_expected_version: command.operation === "promote" ? 0 : command.expectedErpVersion,
        p_command_id: await erpCommandId(command.commandId), p_data: intent.data, p_acknowledged: [] });
      replayed ||= saved.replayed === true;
      // Recibo do comando é antigo. Só GET atual pode produzir o espelho.
      snapshot = snapshotOf((await rpc("erp_catalog_contact_get", { p_id: saved.record.id })).record);
      // Preflight + save não são transação. Detecta a janela sem fundir nem apagar.
      if (command.operation === "promote") {
        const found = await duplicateCandidates(env, contact, intent.data, rpc, snapshot.erpId);
        if (found.conflict) return finish({ status: "conflict", candidateIds: found.candidateIds }, "conflict", "possible_duplicate_after_save");
      }
    }
    if (!await customerEnabled(env, command.profileId)) return finish({ status: "paused", reason: "module_disabled" }, "paused", "module_disabled");
    const current = await contactForBridge(env, command.profileId, command.contactId);
    if (!current || current.version !== intent.source.version || current.local_patch_cipher !== intent.source.localPatch)
      return finish({ status: "conflict", candidateIds: [] }, "conflict", "contact_conflict");
    if (!await confirmBridgeSnapshot(env, current, snapshot, job, intent.source))
      return finish({ status: "paused", reason: "module_disabled" }, "paused", "module_disabled");
    return { status: "applied", snapshot, replayed };
  } catch (error) {
    if (error instanceof RpcFailure) {
      const missing = /^erp_catalog_contact_required:(.+)$/.exec(error.code)?.[1] ?? (error.code === "erp_catalog_name_required" ? "name" : null);
      if (missing) return finish({ status: "needs_data", fields: [missing] }, "paused", "contact_required");
      if (/version_conflict|command_conflict|warning_unacknowledged/.test(error.code))
        return finish({ status: "conflict", candidateIds: [] }, "conflict", error.code);
    }
    if (error instanceof ApiError && error.code === "module_disabled")
      return finish({ status: "paused", reason: "module_disabled" }, "paused", "module_disabled");
    if (error instanceof ApiError && ["contact_conflict", "namespace_conflict", "customer_erasing"].includes(error.code))
      return finish({ status: "conflict", candidateIds: [] }, "conflict", error.code);
    // Não armazena erro arbitrário, que pode conter dados pessoais de validação.
    // A intenção e o comando sobrevivem inclusive a falha deste UPDATE.
    if (!(error instanceof ApiError && error.code === "sync_pending"))
      await updateJob(env, job, m, "pending", "dependency_unavailable");
    throw error;
  }
}

export async function resumeBridgeJob(env: Env, job: BridgeJob): Promise<BridgeResult> {
  const m = metadata(job);
  if (!m?.intent) throw bridgeConflict("sync_pending");
  return deliver(env, job, await unseal(env, m.intent) as Intent);
}

export const customerErpBridge: CustomerErpBridge = {
  async apply(env, command) {
    if (!await customerEnabled(env, command.profileId)) {
      await exec(env, `UPDATE customer_jobs SET state='paused',error_code='module_disabled',lease_until=NULL,updated=?
        WHERE profile_id=? AND command_id=? AND state IN ('pending','running') AND json_extract(cursor_json,'$.customerErp.intent') IS NOT NULL`,
      now(), command.profileId, command.commandId);
      return { status: "paused", reason: "module_disabled" };
    }
    if (command.namespace !== "team" || command.actor.kind === "app") return { status: "paused", reason: "awaiting_proof" };
    access(command.actor, command.profileId, "contacts:write");
    if (!command.commandId || command.commandId.length > 200 || !command.requestHash || !["promote", "patch", "bind"].includes(command.operation)) throw invalid();
    const patch = dataOf(command.patch);
    const fingerprint = await sha(canonical({ ...command, actor: { id: command.actor.id, kind: command.actor.kind } }));
    let job = await one<BridgeJob>(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", command.profileId, command.commandId);
    if (job && (job.request_hash !== command.requestHash || job.contact_id !== command.contactId || job.namespace !== command.namespace)) throw bridgeConflict("idempotency_conflict");
    if (job && metadata(job)) {
      const m = metadata(job)!;
      if (m.fingerprint !== fingerprint) throw bridgeConflict("idempotency_conflict");
      if (job.state === "cancelled" || job.state === "retained") throw bridgeConflict("customer_erasing");
      if (m.done) {
        const contact = await contactForBridge(env, command.profileId, command.contactId);
        if (!contact || contact.identity_state !== "active" || !contact.erp_contact_id || !contact.mirror_json) throw bridgeConflict();
        return { status: "applied", replayed: true, snapshot: { erpId: contact.erp_contact_id, erpVersion: contact.erp_version!, mirror: JSON.parse(contact.mirror_json) } };
      }
      if (job.state === "conflict" || (job.state === "paused" && m.result?.status === "needs_data")) return m.result!;
      return resumeBridgeJob(env, job);
    }
    const contact = await contactForBridge(env, command.profileId, command.contactId);
    if (!contact || contact.namespace !== "team" || contact.identity_state !== "active") throw new ApiError(404, "not_found", "Contato não encontrado.");
    if (command.operation === "promote" ? command.erpId !== null || contact.erp_contact_id !== null :
      !command.erpId || !UUID.test(command.erpId) || (contact.erp_contact_id !== null && contact.erp_contact_id !== command.erpId) ||
      (command.operation === "patch" && (contact.erp_contact_id !== command.erpId || command.expectedErpVersion !== contact.erp_version))) throw bridgeConflict();
    if (command.operation === "bind") {
      requireCustomerPerson(command.actor);
      await this.read(env, command.actor, command.profileId, command.erpId!);
    }
    if (command.operation === "patch") {
      // Editar a ficha completa conserva a permissão própria e o portão humano.
      // A identidade técnica só executa o corpo autorizado e seu replay.
      if (isCustomerSelfActor(command.actor)) await validateCustomerSelfActor(env, command.actor, command.profileId, command.contactId);
      else requireCustomerPerson(command.actor);
      const identity = isCustomerSelfActor(command.actor)
        ? await erpSystemIdentity(freshCustomerEnv(env), command.profileId, SYSTEM)
        : await erpIdentity(freshCustomerEnv(env), command.actor, command.profileId, "POST");
      await customerRpc(env, command.profileId, command.actor, identity, "erp_catalog_contact_check", { p_id: command.erpId, p_data: patch });
    }
    const data = command.operation === "promote" ? { name: contact.name, phone: contact.phone, email: contact.email,
      document: contact.document, person_type: contact.person_type, ...patch, roles: ["customer"] } : patch;
    const safeActor = { id: command.actor.id, kind: command.actor.kind, profiles: [command.profileId], role: command.actor.role,
      name: "Solicitante do cadastro", scopes: isCustomerSelfActor(command.actor) ? ["contacts:self"] : [], bots: [], rate: 0, runLimit: 0 } as Actor;
    const intent: Intent = { command: { ...command, actor: safeActor }, fingerprint, data, source: { version: contact.version, localPatch: contact.local_patch_cipher } };
    const m: Metadata = { fingerprint, intent: await seal(env, intent) };
    if (!job) {
      const at = now();
      await exec(env, `INSERT OR IGNORE INTO customer_jobs(profile_id,id,namespace,contact_id,kind,command_id,request_hash,
        expected_version,expected_erp_version,cursor_json,retry_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      command.profileId, uid(), "team", command.contactId, command.operation === "patch" ? "sync" : command.operation,
      command.commandId, command.requestHash, contact.version, command.expectedErpVersion, JSON.stringify({ customerErp: m }), at, at, at);
      // Concorrência reservou o mesmo comando? Nunca enviar o corpo desta chamada sem reler.
      return this.apply(env, command);
    }
    await updateJob(env, job, m);
    return deliver(env, job, intent);
  },
  async read(env, actor, profileId, erpId) {
    if (!await customerEnabled(env, profileId)) throw new ApiError(409, "module_disabled", "Cadastro completo desligado nesta área.");
    if (!isCustomerSelfActor(actor)) requireCustomerPerson(actor);
    access(actor, profileId, "contacts:read");
    const link = await one<{ id: string; namespace: string; identity_state: string }>(env,
      "SELECT id,namespace,identity_state FROM contacts WHERE profile_id=? AND erp_contact_id=?", profileId, erpId);
    if (link && (link.namespace !== "team" || link.identity_state !== "active")) throw new ApiError(404, "not_found", "Contato não encontrado.");
    if (isCustomerSelfActor(actor)) await validateCustomerSelfActor(env, actor, profileId, link?.id ?? "");
    const identity = isCustomerSelfActor(actor) ? await erpSystemIdentity(freshCustomerEnv(env), profileId, SYSTEM) : await erpIdentity(freshCustomerEnv(env), actor, profileId);
    return snapshotOf((await customerRpc(env, profileId, actor, identity, "erp_catalog_contact_get", { p_id: erpId })).record);
  },
  async scan(env, profileId, cursor, limit) {
    if (!await customerEnabled(env, profileId)) throw new ApiError(409, "module_disabled", "Cadastro completo desligado nesta área.");
    if ((cursor !== null && !UUID.test(cursor)) || !Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new ApiError(400, "invalid_cursor", "Cursor cadastral inválido.");
    const rpc = await systemRpc(env, profileId, technicalActor(profileId));
    const result = await rpc(CUSTOMER_BRIDGE_SCAN, { p_after: cursor, p_limit: limit });
    if (!Array.isArray(result.items) || (result.nextCursor !== null && !UUID.test(result.nextCursor))) throw new Error("erp_invalid_scan");
    return { items: result.items.map(snapshotOf), nextCursor: result.nextCursor };
  },
};
