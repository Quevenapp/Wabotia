import { all, one, exec, batch } from "../db";
import { canonical, seal, sha, unseal } from "../security";
import { auditStatement } from "../events";
import { ApiError, now, uid, type Actor, type Env } from "../types";
import { searchText } from "../contact-csv";
import { erpBridge, identityPort, maintainCustomers } from "./ports";
import { isFullCustomerEnabled } from "./feature";
import type { BridgeCommand, CustomerJobView, CustomerMirror, CustomerWrite, CustomerWriteResult, JobState, MaintenanceBudget, MaintenanceResult, Namespace, Statement } from "./contracts";
import { activeContact, cleanMirror, contactRow, customerAccess, guard, guardedBatch, human, mergePatch, mirrorOf, namespaceFor, reconcilePatch, validateWrite, phoneSafetyStatements } from "./local";

interface Intent {
  actor: Actor;
  input: CustomerWrite;
  base: CustomerMirror;
  operation: "enrich" | "promote" | "bind";
  local?: { company: string; notes: string };
  localVersion?: number;
  bridge?: BridgeCommand;
  bridgeVersion?: number;
  erpId?: string;
  newContactId?: string;
}
export const CUSTOMER_LEASE_MS = 60_000;
const terminal = (state: JobState) => ["done", "retained", "cancelled"].includes(state);
// Uma leitura nova é deliberada: o retorno ERP pode chegar depois de desligar o módulo.
const enabled = (env: Env, profile: string) => isFullCustomerEnabled(Object.fromEntries(Object.entries(env)) as unknown as Env, profile);
export const requestHash = (actor: Actor, body: unknown) => sha(canonical({ actor, body }));
export function jobView(row: any): CustomerJobView {
  const cursor = JSON.parse(row.cursor_json || "{}");
  return { id: row.id, contactId: row.contact_id, state: row.state, errorCode: row.error_code,
    missingFields: Array.isArray(cursor.missingFields) ? cursor.missingFields.filter((v: unknown) => typeof v === "string" && ["name", "phones", "email", "document", "personType", "address"].includes(v)) : [] };
}
export async function readJob(env: Env, actor: Actor, profile: string, id: string) {
  customerAccess(actor, profile);
  const row = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=? AND (?=1 OR namespace=?)", profile, id, actor.kind === "user" ? 1 : 0, namespaceFor(actor));
  if (!row) throw new ApiError(404, "not_found", "Solicitação não encontrada.");
  return jobView(row);
}
export async function replayJob(env: Env, profile: string, command: string, hash: string) {
  const job = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", profile, command);
  if (job && job.request_hash !== hash) throw new ApiError(409, "idempotency_conflict", "Este comando já foi usado com outro conteúdo ou ator.");
  return job;
}
export function jobInsert(profile: string, namespace: Namespace, contact: string | null, kind: string, command: string, hash: string, cipher: string, version: number | null, erpVersion: number | null, id = uid()): { id: string; statement: Statement } {
  const time = now();
  return { id, statement: ["INSERT INTO customer_jobs(profile_id,id,namespace,contact_id,kind,command_id,request_hash,expected_version,expected_erp_version,payload_cipher,retry_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [profile, id, namespace, contact, kind, command, hash, version, erpVersion, cipher, time, time, time]] };
}
export async function writeResult(env: Env, job: any): Promise<CustomerWriteResult> {
  const saved = job.result_cipher ? await unseal(env, job.result_cipher) : null;
  const intent = job.payload_cipher && (!job.contact_id || saved?.version === undefined) ? await unseal(env, job.payload_cipher) : null;
  return { contactId: job.contact_id ?? saved?.contactId ?? intent?.newContactId ?? "", version: saved?.version ?? intent?.localVersion ?? job.expected_version ?? 1,
    jobId: job.id, state: job.state, pending: !terminal(job.state) };
}
export async function enrichLocal(env: Env, actor: Actor, profile: string, id: string, raw: CustomerWrite,
  operation: "enrich" | "promote" = "enrich", local?: Intent["local"], legacy = false, requestBody?: unknown): Promise<CustomerWriteResult> {
  customerAccess(actor, profile, true);
  const input = validateWrite(raw);
  if (input.mode === "replace_confirmed" && !legacy) human(actor);
  const hash = await requestHash(actor, requestBody ?? { id, operation, input: raw, local: local ?? null });
  const previous = await replayJob(env, profile, input.commandId, hash);
  if (previous) return writeResult(env, previous);
  const row = await contactRow(env, actor, profile, id, true);
  activeContact(row);
  if (row.version !== input.expectedVersion || row.erp_version !== input.expectedErpVersion)
    throw new ApiError(409, "contact_conflict", "O cadastro mudou. Reabra a ficha antes de salvar.");
  const intent: Intent = { actor, input, base: row.mirror_json ? JSON.parse(row.mirror_json) : mirrorOf(row), operation, ...(local ? { local } : {}) };
  const job = jobInsert(profile, row.namespace, id, operation, input.commandId, hash, await seal(env, intent), row.version, row.erp_version);
  try { await batch(env, [job.statement]); }
  catch (error) {
    const replay = await replayJob(env, profile, input.commandId, hash);
    if (replay) return writeResult(env, replay);
    throw error;
  }
  // A intenção já está durável. Indisponibilidade posterior nunca perde o pedido.
  await tryJob(env, profile, job.id);
  try { return await writeResult(env, await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, job.id)); }
  catch { return { contactId: id, version: row.version, jobId: job.id, state: "pending", pending: true }; }
}
const headPredicate = `NOT EXISTS(SELECT 1 FROM customer_jobs earlier WHERE earlier.profile_id=customer_jobs.profile_id AND earlier.contact_id=customer_jobs.contact_id AND earlier.state NOT IN ('done','retained','cancelled') AND (earlier.created<customer_jobs.created OR (earlier.created=customer_jobs.created AND earlier.id<customer_jobs.id)))`;
async function finishState(env: Env, job: any, state: JobState, code: string | null, fields: readonly string[] = [], details?: unknown) {
  await exec(env, "UPDATE customer_jobs SET state=?,error_code=?,cursor_json=?,result_cipher=coalesce(?,result_cipher),lease_until=NULL,retry_at=?,updated=? WHERE profile_id=? AND id=? AND state='running' AND attempts=?", state, code, JSON.stringify({ missingFields: fields }), details === undefined ? null : await seal(env, details), now() + 60_000, now(), job.profile_id, job.id, job.attempts);
}
function finishStatement(job: any, state: JobState, cipher: string, payload: string | null = null): Statement[] {
  return [["UPDATE customer_jobs SET state=?,result_cipher=?,payload_cipher=?,error_code=NULL,cursor_json='{}',lease_until=NULL,updated=? WHERE profile_id=? AND id=? AND state='running' AND attempts=?", [state, cipher, payload, now(), job.profile_id, job.id, job.attempts]], ...guard(job.command_id, "finish")];
}
async function applyLocal(env: Env, job: any, intent: Intent, row: any) {
  if (intent.localVersion) return finishState(env, job, "paused", "module_disabled");
  const merged = mergePatch(mirrorOf(row), intent.input.patch, intent.input.mode);
  if (merged.conflicts.length) return finishState(env, job, "conflict", "field_conflict", merged.conflicts);
  const pending = !!row.erp_contact_id || !!intent.input.patch.address || intent.operation === "promote";
  const mirror = merged.mirror;
  intent.localVersion = row.version + 1;
  const cipher = await seal(env, intent);
  const { address: _address, ...localFields } = intent.input.patch;
  const localPatch = pending ? await seal(env, { base: intent.base, patch: localFields }) : null;
  const statements: Statement[] = [
    ...phoneSafetyStatements(job.profile_id, row.namespace, mirror.phones, job.command_id),
    ["UPDATE contacts SET name=?,phone=?,email=?,document=?,person_type=?,company=?,notes=?,search_text=?,mirror_json=?,local_patch_cipher=?,version=version+1,updated=?,updated_by=? WHERE profile_id=? AND id=? AND version=? AND identity_state='active'",
      [mirror.name, mirror.phones[0] ?? "", mirror.email, mirror.document, mirror.personType, intent.local?.company ?? row.company, intent.local?.notes ?? row.notes, searchText([mirror.name, ...mirror.phones, mirror.email, intent.local?.company ?? row.company].join(" ")), row.erp_contact_id ? row.mirror_json : JSON.stringify(mirror), localPatch, now(), intent.actor.id, job.profile_id, row.id, row.version]],
    ...guard(job.command_id, "local"),
    ...await identityPort.indexContact(env, { profileId: job.profile_id, namespace: row.namespace, contactId: row.id, phones: mirror.phones, origin: "local" }),
    ...finishStatement(job, pending ? "paused" : "done", await seal(env, { contactId: row.id, version: row.version + 1 }), pending ? cipher : null),
    auditStatement(intent.actor, job.profile_id, "contact.enrich", row.id, job.command_id),
  ];
  await guardedBatch(env, statements);
}
async function applyErp(env: Env, job: any, intent: Intent, row: any) {
  if (!intent.bridge) {
    let patch = intent.input.patch;
    let expectedErpVersion = intent.input.expectedErpVersion;
    if (row?.erp_contact_id) {
      const remote = await erpBridge.read(env, intent.actor, job.profile_id, row.erp_contact_id);
      if (remote.erpId !== row.erp_contact_id) throw new ApiError(503, "dependency_unavailable", "Resposta cadastral incompatível.");
      const mirror = cleanMirror(remote.mirror);
      if (intent.localVersion) {
        const reconciled = reconcilePatch(intent.base, patch, mirror);
        if (reconciled.conflicts.length) return finishState(env, job, "conflict", "field_conflict", reconciled.conflicts);
        patch = reconciled.patch;
      } else {
        if (remote.erpVersion !== expectedErpVersion) return finishState(env, job, "conflict", "contact_conflict");
        const merged = mergePatch(mirror, patch, intent.input.mode);
        if (merged.conflicts.length) return finishState(env, job, "conflict", "field_conflict", merged.conflicts);
      }
      expectedErpVersion = remote.erpVersion;
    } else if (row) {
      const merged = mergePatch(mirrorOf(row), patch, intent.localVersion ? "replace_confirmed" : intent.input.mode);
      if (merged.conflicts.length) return finishState(env, job, "conflict", "field_conflict", merged.conflicts);
      patch = { ...merged.mirror, ...(patch.address ? { address: patch.address } : {}) };
    }
    const command: BridgeCommand = {
      profileId: job.profile_id, namespace: job.namespace, contactId: row?.id ?? intent.newContactId!,
      commandId: job.command_id, requestHash: job.request_hash, actor: intent.actor,
      operation: intent.operation === "bind" ? "bind" : row?.erp_contact_id ? "patch" : "promote",
      erpId: row?.erp_contact_id ?? intent.erpId ?? null, expectedErpVersion, patch,
    };
    intent.bridge = command;
    intent.bridgeVersion = row?.version;
    await guardedBatch(env, [
      ["UPDATE customer_jobs SET payload_cipher=?,updated=? WHERE profile_id=? AND id=? AND state='running' AND attempts=?", [await seal(env, intent), now(), job.profile_id, job.id, job.attempts]],
      ...guard(job.command_id, "bridge-intent"),
    ]);
  }
  if (!await enabled(env, job.profile_id)) return finishState(env, job, "paused", "module_disabled");
  const result = await erpBridge.apply(env, intent.bridge);
  if (!await enabled(env, job.profile_id)) return finishState(env, job, "paused", "module_disabled");
  if (result.status === "paused") return finishState(env, job, "paused", result.reason);
  if (result.status === "needs_data") return finishState(env, job, "paused", "contact_required", result.fields);
  if (result.status === "conflict") return finishState(env, job, "conflict", "customer_ambiguous", [], { candidateIds: result.candidateIds });
  const snapshot = result.snapshot, mirror = cleanMirror(snapshot.mirror);
  if (!snapshot.erpId || !Number.isSafeInteger(snapshot.erpVersion) || snapshot.erpVersion < 1 ||
      (intent.bridge.erpId && intent.bridge.erpId !== snapshot.erpId))
    throw new ApiError(503, "dependency_unavailable", "Resposta cadastral incompatível.");
  const id = row?.id ?? intent.newContactId!, version = (intent.bridgeVersion ?? 0) + 1;
  const time = now();
  const statements: Statement[] = row ? [
    ["UPDATE contacts SET name=?,phone=?,email=?,document=?,person_type=?,erp_contact_id=?,erp_version=?,mirror_json=?,local_patch_cipher=NULL,company=?,notes=?,search_text=?,version=version+1,updated=?,updated_by=? WHERE profile_id=? AND id=? AND version=? AND identity_state='active'",
      [mirror.name, mirror.phones[0] ?? "", mirror.email, mirror.document, mirror.personType, snapshot.erpId, snapshot.erpVersion, JSON.stringify(mirror), intent.local?.company ?? row.company, intent.local?.notes ?? row.notes, searchText([mirror.name, ...mirror.phones, mirror.email, intent.local?.company ?? row.company].join(" ")), time, intent.actor.id, job.profile_id, id, intent.bridgeVersion]],
    ...guard(job.command_id, "mirror"),
  ] : [
    ["INSERT INTO contacts(id,profile_id,namespace,name,phone,email,document,person_type,erp_contact_id,erp_version,mirror_json,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, job.profile_id, job.namespace, mirror.name, mirror.phones[0] ?? "", mirror.email, mirror.document, mirror.personType, snapshot.erpId, snapshot.erpVersion, JSON.stringify(mirror), searchText([mirror.name, ...mirror.phones, mirror.email].join(" ")), "erp", intent.actor.id, intent.actor.id, time, time]],
    ["UPDATE customer_jobs SET contact_id=? WHERE profile_id=? AND id=? AND state='running' AND attempts=?", [id, job.profile_id, job.id, job.attempts]],
    ...guard(job.command_id, "bind"),
  ];
  statements.unshift(...phoneSafetyStatements(job.profile_id, job.namespace, mirror.phones, job.command_id));
  statements.push(...await identityPort.indexContact(env, { profileId: job.profile_id, namespace: job.namespace, contactId: id, phones: mirror.phones, origin: "mirror" }),
    ...finishStatement(job, "done", await seal(env, { contactId: id, version })),
    auditStatement(intent.actor, job.profile_id, "contact.sync", id, job.command_id));
  await guardedBatch(env, statements);
}
export async function processJob(env: Env, profile: string, id: string) {
  const time = now();
  const claimed = await one(env, `UPDATE customer_jobs SET state='running',attempts=attempts+1,lease_until=?,updated=? WHERE profile_id=? AND id=? AND kind IN ('enrich','promote','bind') AND ((state IN ('pending','paused') AND retry_at<=?) OR (state='running' AND lease_until<=?)) AND ${headPredicate} RETURNING *`, time + CUSTOMER_LEASE_MS, time, profile, id, time, time);
  if (!claimed) return;
  try {
    const intent: Intent = await unseal(env, claimed.payload_cipher);
    const row = claimed.contact_id ? await contactRow(env, intent.actor, profile, claimed.contact_id, true) : null;
    if (!row && intent.operation === "bind") {
      const existing = await one(env, "SELECT * FROM contacts WHERE profile_id=? AND erp_contact_id=?", profile, intent.erpId);
      if (existing) {
        activeContact(existing);
        if (existing.namespace !== claimed.namespace) return finishState(env, claimed, "conflict", "namespace_conflict");
        if (!await enabled(env, profile)) return finishState(env, claimed, "paused", "module_disabled");
        await erpBridge.read(env, intent.actor, profile, intent.erpId!);
        await guardedBatch(env, [
          ["UPDATE customer_jobs SET contact_id=? WHERE profile_id=? AND id=? AND state='running' AND attempts=? AND EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND id=? AND identity_state='active')", [existing.id, profile, claimed.id, claimed.attempts, profile, existing.id]],
          ...guard(claimed.command_id, "existing-bind"),
          ...finishStatement(claimed, "done", await seal(env, { contactId: existing.id, version: existing.version })),
        ]);
        return;
      }
    }
    if (row) {
      activeContact(row);
      if (row.version !== (intent.bridgeVersion ?? intent.localVersion ?? intent.input.expectedVersion))
        return finishState(env, claimed, "conflict", "contact_conflict");
    }
    if (row && intent.operation === "enrich" && intent.local && !Object.keys(intent.input.patch).length) {
      await guardedBatch(env, [
        ["UPDATE contacts SET company=?,notes=?,search_text=?,version=version+1,updated=?,updated_by=? WHERE profile_id=? AND id=? AND version=? AND identity_state='active'", [intent.local.company, intent.local.notes, searchText([row.name, row.phone, row.email, intent.local.company].join(" ")), now(), intent.actor.id, profile, row.id, row.version]],
        ...guard(claimed.command_id, "local-notes"),
        ...finishStatement(claimed, "done", await seal(env, { contactId: row.id, version: row.version + 1 })),
        auditStatement(intent.actor, profile, "contact.enrich", row.id, claimed.command_id),
      ]);
      return;
    }
    if (!await enabled(env, profile)) {
      if (!row || intent.operation === "bind" || intent.bridge) return finishState(env, claimed, "paused", "module_disabled");
      return await applyLocal(env, claimed, intent, row);
    }
    await applyErp(env, claimed, intent, row);
  } catch (error) {
    if (error instanceof BudgetExhausted) throw error;
    const code = error instanceof ApiError ? error.code : "dependency_unavailable";
    await finishState(env, claimed, ["contact_conflict", "customer_erasing", "forbidden"].includes(code) ? "conflict" : "pending", code);
  }
}
async function tryJob(env: Env, profile: string, id: string) {
  try { await processJob(env, profile, id); } catch { /* lease e intenção permitem retomada */ }
}
export async function bindFromErp(env: Env, actor: Actor, profile: string, erpId: string, command: string): Promise<CustomerWriteResult> {
  customerAccess(actor, profile, true); human(actor);
  if (typeof erpId !== "string" || !erpId || erpId.length > 200) throw new ApiError(400, "invalid_request", "Informe o identificador do ERP.");
  const hash = await requestHash(actor, { erpId, operation: "bind" });
  const replay = await replayJob(env, profile, command, hash);
  if (replay) return writeResult(env, replay);
  const existing = await one(env, "SELECT * FROM contacts WHERE profile_id=? AND erp_contact_id=?", profile, erpId);
  if (existing) {
    activeContact(existing);
    if (existing.namespace !== "team") throw new ApiError(409, "namespace_conflict", "O cadastro pertence a outro contexto.");
    await erpBridge.read(env, actor, profile, erpId);
    return { contactId: existing.id, version: existing.version, jobId: null, state: "done", pending: false };
  }
  const intent: Intent = { actor, operation: "bind", erpId, newContactId: uid(),
    base: { name: "", phones: [], email: "", document: null, personType: null },
    input: { commandId: command, expectedVersion: 1, expectedErpVersion: null, patch: {}, mode: "fill_empty" } };
  const job = jobInsert(profile, "team", null, "bind", command, hash, await seal(env, intent), null, null);
  await batch(env, [job.statement]);
  // Associação sempre devolve a intenção; não cria uma pessoa no ERP.
  return { contactId: intent.newContactId!, version: 1, jobId: job.id, state: "pending", pending: true };
}

class BudgetExhausted extends Error {}
/** Conta também leituras feitas pelas portas, e reserva o lote inteiro antes de enviá-lo. */
function meteredEnv(env: Env, maximum: number) {
  let count = 0;
  const spend = (n: number) => { if (count + n > maximum) throw new BudgetExhausted(); count += n; };
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrapped = (statement: D1PreparedStatement): D1PreparedStatement => {
    const result = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args: any[]) => wrapped(target.bind(...args));
      if (["first", "all", "run", "raw"].includes(String(key)))
        return (...args: any[]) => { spend(1); return (target as any)[key](...args); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(result, statement);
    return result;
  };
  const prepare = (sql: string) => wrapped(env.DB.prepare(sql));
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return prepare;
    if (key === "batch") return (statements: D1PreparedStatement[]) => { spend(statements.length); return target.batch(statements.map(s => originals.get(s) ?? s)); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { env: { ...env, DB: db }, count: () => count };
}
export async function maintainJobs(env: Env, profile: string, budget: MaintenanceBudget): Promise<MaintenanceResult> {
  if (!budget.remainingItems || budget.remainingStatements < 2) return { pending: true, statements: 0, items: 0 };
  const meter = meteredEnv(env, budget.remainingStatements);
  let items = 0, pending = false;
  try {
    const jobs = await all(meter.env, `SELECT id FROM customer_jobs WHERE profile_id=? AND kind IN ('enrich','promote','bind') AND ((state IN ('pending','paused') AND retry_at<=?) OR (state='running' AND lease_until<=?)) AND ${headPredicate} ORDER BY created,id LIMIT ?`, profile, now(), now(), budget.remainingItems);
    pending = jobs.length === budget.remainingItems;
    for (const job of jobs) {
      items++;
      await processJob(meter.env, profile, job.id);
    }
    const left = await one(meter.env, "SELECT 1 present FROM customer_jobs WHERE profile_id=? AND state NOT IN ('done','retained','cancelled') LIMIT 1", profile);
    pending ||= !!left;
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    pending = true;
  }
  return { pending, statements: meter.count(), items };
}
/** Dispatcher invocado por um comando dedicado no Coordinator existente. */
export const dispatchCustomerMaintenance = (env: Env, profile: string, budget: MaintenanceBudget = { remainingStatements: 30, remainingItems: 20 }) => maintainCustomers(env, profile, budget);
