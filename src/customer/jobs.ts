import { all, one, exec, batch } from "../db";
import { canonical, seal, sha, unseal } from "../security";
import { localModuleWake } from "../modules/local-wake";
import { auditStatement } from "../events";
import { ApiError, now, uid, type Actor, type Env } from "../types";
import { searchText, type ContactValues } from "../contact-csv";
import { erpBridge, identityPort, maintainCustomers, profilePort } from "./ports";
import { isFullCustomerEnabled } from "./feature";
import type { BridgeCommand, CustomerJobView, CustomerMirror, CustomerWrite, CustomerWriteResult, JobState, MaintenanceBudget, MaintenanceResult, Namespace, Statement } from "./contracts";
import { activeContact, cleanMirror, contactRow, customerAccess, guard, guardedBatch, human, mergePatch, mirrorOf, namespaceFor, reconcilePatch, validateWrite, phoneSafetyStatements, isCustomerSelfActor, validateCustomerSelfActor } from "./local";

interface Intent {
  actor: Actor;
  input: CustomerWrite;
  base: CustomerMirror;
  operation: "enrich" | "promote" | "bind";
  local?: { company?: string; notes?: string };
  localVersion?: number;
  bridge?: BridgeCommand;
  bridgeVersion?: number;
  erpId?: string;
  newContactId?: string;
}
export const CUSTOMER_LEASE_MS = 60_000;
export const CUSTOMER_QUEUE_LIMIT = 20;
const terminal = (state: JobState) => ["done", "retained", "cancelled"].includes(state);
// Uma leitura nova é deliberada: o retorno ERP pode chegar depois de desligar o módulo.
const enabled = (env: Env, profile: string) => isFullCustomerEnabled(Object.fromEntries(Object.entries(env)) as unknown as Env, profile);
export const requestHash = (actor: Actor, body: unknown) => sha(canonical({ actor, body }));
export function jobView(row: any): CustomerJobView {
  const cursor = JSON.parse(row.cursor_json || "{}");
  const fields = cursor.missingFields?.length ? cursor.missingFields : cursor.customerErp?.result?.fields ?? [];
  const names: Record<string, string> = { postal_code: "address.postalCode", person_type: "personType", phone: "phones", mobile: "phones", celular: "phones", telefone: "phones",
    street: "address.street", number: "address.number", complement: "address.complement", district: "address.district", city: "address.city", state: "address.state", country: "address.country" };
  const allowed = ["name", "phones", "email", "document", "personType", "address", "address.postalCode", "address.street", "address.number", "address.city", "address.state", "address.district", "address.country", "address.complement"];
  return { id: row.id, contactId: row.contact_id, state: row.state, errorCode: row.error_code,
    reason: cursor.reason ?? row.error_code ?? null, updated: row.updated,
    missingFields: Array.isArray(fields) ? [...new Set<string>(fields.filter((v: unknown) => typeof v === "string").map((v: string) => names[v] ?? v).filter((v: string) => allowed.includes(v)))] : [],
    ...(cursor.import ? { progress: cursor.import } : {}) };
}
export async function readJob(env: Env, actor: Actor, profile: string, id: string) {
  const row = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=? AND (?=1 OR namespace=?)", profile, id, actor.kind === "user" ? 1 : 0, namespaceFor(actor));
  if (!row) throw new ApiError(404, "not_found", "Solicitação não encontrada.");
  if (row.kind === "section") {
    const cursor = JSON.parse(row.cursor_json);
    const resource = cursor.resource ?? (row.id.startsWith("cond-units:") ? { module: "condominio", section: "units" } : null);
    if (!resource || typeof resource.module !== "string" || typeof resource.section !== "string" || !row.contact_id)
      throw new ApiError(403, "forbidden", "Origem da solicitação não identificada.");
    customerAccess(actor, profile, false, resource.module);
    await contactRow(env, actor, profile, row.contact_id);
    await profilePort.section(env, actor, profile, row.contact_id, resource.module, resource.section);
  } else if (row.kind === "bind") {
    customerAccess(actor, profile, false, "erp");
    if (row.namespace !== "team" || row.kind !== "bind") throw new ApiError(403, "forbidden", "Solicitação fora do seu acesso.");
    const contact = row.contact_id ? await contactRow(env, actor, profile, row.contact_id) : null;
    const intent = row.payload_cipher ? await unseal(env, row.payload_cipher) : null;
    const metadata = JSON.parse(row.cursor_json);
    const bridge = metadata.customerErp?.intent ? await unseal(env, metadata.customerErp.intent) : null;
    const erpId = contact?.erp_contact_id ?? intent?.erpId ?? bridge?.command?.erpId ?? metadata.erpId;
    if (!erpId) throw new ApiError(403, "forbidden", "Solicitação fora do seu acesso.");
    await erpBridge.read(env, actor, profile, erpId);
  } else {
    customerAccess(actor, profile);
    if (row.contact_id) await contactRow(env, actor, profile, row.contact_id, row.kind === "erase");
    if (isCustomerSelfActor(actor)) await validateCustomerSelfActor(env, actor, profile, row.contact_id ?? "");
  }
  return jobView(row);
}
export async function replayJob(env: Env, profile: string, command: string, hash: string) {
  const job = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", profile, command);
  if (job && job.request_hash !== hash) throw new ApiError(409, "idempotency_conflict", "Este comando já foi usado com outro conteúdo ou ator.");
  return job;
}
export function jobInsert(profile: string, namespace: Namespace, contact: string | null, kind: string, command: string, hash: string, cipher: string | null, version: number | null, erpVersion: number | null, id: string = uid(), cursor: unknown = {}): { id: string; statement: Statement } {
  const time = now();
  return { id, statement: [`INSERT INTO customer_jobs(profile_id,id,namespace,contact_id,kind,command_id,request_hash,expected_version,expected_erp_version,payload_cipher,retry_at,created,updated,state,error_code,cursor_json)
    SELECT ?,?,?,?,?,?,?,?,?,CASE WHEN n<? THEN ? ELSE NULL END,?,?,?,CASE WHEN n<? THEN 'pending' ELSE 'retained' END,CASE WHEN n<? THEN NULL ELSE 'customer_queue_full' END,CASE WHEN n<${CUSTOMER_QUEUE_LIMIT} THEN ? ELSE '{}' END
    FROM (SELECT count(*) n FROM customer_jobs WHERE profile_id=? AND namespace=? AND contact_id IS ? AND state NOT IN ('done','retained','cancelled'))`,
    [profile, id, namespace, contact, kind, command, hash, version, erpVersion, CUSTOMER_QUEUE_LIMIT, cipher, time, time, time, CUSTOMER_QUEUE_LIMIT, CUSTOMER_QUEUE_LIMIT, JSON.stringify(cursor), profile, namespace, contact]] };
}
function accepted(job: any) {
  if (job?.error_code === "customer_queue_full") throw new ApiError(429, "customer_queue_full", "Há solicitações pendentes demais para este cadastro. Conclua ou cancele as anteriores.");
}
export async function writeResult(env: Env, job: any): Promise<CustomerWriteResult> {
  accepted(job);
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
  if (row.namespace.startsWith("app:") && (operation === "promote" || input.patch.address))
    throw new ApiError(400, "invalid_customer_patch", "Este campo exige um cadastro da equipe.");
  if (row.version !== input.expectedVersion || row.erp_version !== input.expectedErpVersion)
    throw new ApiError(409, "contact_conflict", "O cadastro mudou. Reabra a ficha antes de salvar.");
  const current = mirrorOf(row);
  if (row.local_patch_cipher) current.phones = (await unseal(env, row.local_patch_cipher)).patch?.phones ?? current.phones;
  mergePatch(current, input.patch, input.mode, row.source === "automatic");
  if (row.namespace === "team" && await enabled(env, profile)) {
    const { dataOf } = await import("./erp-bridge");
    dataOf(input.patch);
  }
  const intent: Intent = { actor, input, base: row.mirror_json ? JSON.parse(row.mirror_json) : mirrorOf(row), operation, ...(local ? { local } : {}) };
  const job = jobInsert(profile, row.namespace, id, operation, input.commandId, hash, await seal(env, intent), row.version, row.erp_version, uid(), { owner: "write" });
  try { await batch(env, [job.statement]); }
  catch (error) {
    const replay = await replayJob(env, profile, input.commandId, hash);
    if (replay) return writeResult(env, replay);
    throw error;
  }
  // A intenção já está durável. Indisponibilidade posterior nunca perde o pedido.
  accepted(await one(env, "SELECT error_code FROM customer_jobs WHERE profile_id=? AND id=?", profile, job.id));
  // O comando serializado só pode executar a etapa local. Transporte remoto
  // pertence ao processamento dedicado, inclusive leituras de associação.
  await tryJob(env, profile, job.id, !!localModuleWake(env, profile));
  try { return await writeResult(env, await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, job.id)); }
  catch { return { contactId: id, version: row.version, jobId: job.id, state: "pending", pending: true }; }
}
const headPredicate = `NOT EXISTS(SELECT 1 FROM customer_jobs earlier WHERE earlier.profile_id=customer_jobs.profile_id AND earlier.namespace=customer_jobs.namespace AND earlier.contact_id IS customer_jobs.contact_id AND earlier.state NOT IN ('done','retained','cancelled') AND (earlier.created<customer_jobs.created OR (earlier.created=customer_jobs.created AND earlier.id<customer_jobs.id)))`;
async function finishState(env: Env, job: any, state: JobState, code: string | null, fields?: readonly string[]) {
  await exec(env, "UPDATE customer_jobs SET state=?,error_code=?,cursor_json=CASE WHEN ? IS NULL THEN cursor_json ELSE json_set(cursor_json,'$.missingFields',json(?)) END,lease_until=NULL,retry_at=?,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND state='running' AND attempts=?", state, code, fields ? JSON.stringify(fields) : null, fields ? JSON.stringify(fields) : null, code ? now() + 60_000 : 0, now(), job.profile_id, job.id, job.attempts);
}
function finishStatement(job: any, state: JobState, cipher: string, payload: string | null = null): Statement[] {
  return [["UPDATE customer_jobs SET state=?,result_cipher=?,payload_cipher=?,error_code=NULL,cursor_json=json_set(json_remove(cursor_json,'$.missingFields'),'$.compacted',?),lease_until=NULL,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND state='running' AND attempts=?", [state, cipher, payload, terminal(state) ? 1 : 0, now(), job.profile_id, job.id, job.attempts]], ...guard(job.command_id, "finish")];
}
async function applyLocal(env: Env, job: any, intent: Intent, row: any) {
  if (intent.localVersion) return finishState(env, job, "paused", "module_disabled");
  const previous = row.local_patch_cipher ? await unseal(env, row.local_patch_cipher) : null;
  const current = mirrorOf(row);
  current.phones = previous?.patch?.phones ?? current.phones;
  const merged = mergePatch(current, intent.input.patch, intent.input.mode, row.source === "automatic");
  if (merged.conflicts.length) return finishState(env, job, "conflict", "field_conflict", merged.conflicts);
  const pending = row.namespace === "team" && (!!row.erp_contact_id || !!intent.input.patch.address || intent.operation === "promote");
  const mirror = merged.mirror;
  intent.localVersion = row.version + 1;
  const cipher = await seal(env, intent);
  const patch = { ...previous?.patch, ...intent.input.patch,
    ...(previous?.patch?.address || intent.input.patch.address ? { address: { ...previous?.patch?.address, ...intent.input.patch.address } } : {}) };
  const localPatch = pending ? await seal(env, { base: previous?.base ?? intent.base, patch, jobs: [...(previous?.jobs ?? []), job.id], version: row.version + 1 }) : null;
  const statements: Statement[] = [
    ...phoneSafetyStatements(job.profile_id, row.namespace, mirror.phones, job.command_id),
    ["UPDATE contacts SET name=?,phone=?,email=?,document=?,person_type=?,company=?,notes=?,search_text=?,mirror_json=?,local_patch_cipher=?,version=version+1,updated=?,updated_by=? WHERE profile_id=? AND id=? AND version=? AND identity_state='active'",
      [mirror.name, mirror.phones[0] ?? "", mirror.email, mirror.document, mirror.personType, intent.local?.company ?? row.company, intent.local?.notes ?? row.notes, searchText([mirror.name, ...mirror.phones, mirror.email, intent.local?.company ?? row.company].join(" ")), row.erp_contact_id ? row.mirror_json : JSON.stringify(mirror), localPatch, now(), intent.actor.id, job.profile_id, row.id, row.version]],
    ...guard(job.command_id, "local"),
    ...await identityPort.indexContact(env, { profileId: job.profile_id, namespace: row.namespace, contactId: row.id, phones: mirror.phones, origin: "local" }),
    ...finishStatement(job, pending ? previous?.jobs?.length ? "pending" : "paused" : "done", await seal(env, { contactId: row.id, version: row.version + 1 }), pending ? cipher : null),
    ...(pending ? [["UPDATE customer_jobs SET cursor_json=json_set(cursor_json,'$.localApplied',1),error_code='module_disabled' WHERE profile_id=? AND id=?", [job.profile_id, job.id]] as Statement] : []),
    auditStatement(intent.actor, job.profile_id, "contact.enrich", row.id, job.command_id),
  ];
  await guardedBatch(env, statements);
}
async function applyErp(env: Env, job: any, intent: Intent, row: any) {
  if (!intent.bridge) {
    let patch = intent.input.patch;
    let expectedErpVersion = intent.input.expectedErpVersion;
    const offline = intent.localVersion && row?.local_patch_cipher ? await unseal(env, row.local_patch_cipher) : null;
    if (offline?.jobs?.includes(job.id)) patch = offline.patch;
    if (row?.erp_contact_id) {
      const remote = await erpBridge.read(env, intent.actor, job.profile_id, row.erp_contact_id);
      if (remote.erpId !== row.erp_contact_id) throw new ApiError(503, "dependency_unavailable", "Resposta cadastral incompatível.");
      const mirror = cleanMirror(remote.mirror);
      if (intent.localVersion || remote.erpVersion !== expectedErpVersion) {
        const reconciled = reconcilePatch(offline?.base ?? intent.base, patch, mirror);
        if (reconciled.conflicts.length) return finishState(env, job, "conflict", "field_conflict", reconciled.conflicts);
        patch = reconciled.patch;
      } else {
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
      baseErpVersion: row?.erp_version ?? null, expectedVersion: row?.version,
    };
    intent.bridge = command;
    intent.bridgeVersion = row?.version;
    await guardedBatch(env, [
      ["UPDATE customer_jobs SET payload_cipher=?,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND state='running' AND attempts=?", [await seal(env, intent), now(), job.profile_id, job.id, job.attempts]],
      ...guard(job.command_id, "bridge-intent"),
    ]);
  }
  if (!await enabled(env, job.profile_id)) return finishState(env, job, "paused", "module_disabled");
  const result = !row && intent.operation === "bind"
    ? { status: "applied" as const, snapshot: await erpBridge.read(env, intent.actor, job.profile_id, intent.erpId!), replayed: false }
    : await erpBridge.apply(env, intent.bridge);
  // A ponte real confirma espelho, índice e job no mesmo lote. Adaptadores que
  // só devolvem snapshot continuam usando a confirmação abaixo, uma única vez.
  const committed = await one(env, "SELECT state,cursor_json FROM customer_jobs WHERE profile_id=? AND id=?", job.profile_id, job.id);
  if (committed?.state === "done" && JSON.parse(committed.cursor_json).customerErp?.done) return;
  if (!JSON.parse(committed?.cursor_json ?? "{}").customerErp) await exec(env,
    "UPDATE customer_jobs SET cursor_json=json_set(cursor_json,'$.executorOutcome',?),updated=max(updated+1,?) WHERE profile_id=? AND id=? AND state='running' AND attempts=?",
    result.status, now(), job.profile_id, job.id, job.attempts);
  if (!await enabled(env, job.profile_id)) return finishState(env, job, "paused", "module_disabled");
  if (result.status === "paused") return finishState(env, job, "paused", result.reason);
  if (result.status === "needs_data") return finishState(env, job, "paused", "contact_required", result.fields);
  if (result.status === "conflict") return finishState(env, job, "conflict", "customer_ambiguous");
  const snapshot = result.snapshot, mirror = cleanMirror(snapshot.mirror);
  if (!snapshot.erpId || !Number.isSafeInteger(snapshot.erpVersion) || snapshot.erpVersion < 1 ||
      (intent.bridge.erpId && intent.bridge.erpId !== snapshot.erpId))
    throw new ApiError(503, "dependency_unavailable", "Resposta cadastral incompatível.");
  const id = row?.id ?? intent.newContactId!, version = (intent.bridgeVersion ?? 0) + 1;
  const time = now();
  const statements: Statement[] = row ? [
    ["UPDATE contacts SET name=?,phone=?,email=?,document=?,person_type=?,erp_contact_id=?,erp_version=?,mirror_json=?,local_patch_cipher=NULL,company=?,notes=?,search_text=?,version=version+1,updated=?,updated_by=? WHERE profile_id=? AND id=? AND version=? AND identity_state='active'",
      [mirror.name, mirror.phones[0] ?? "", mirror.email, mirror.document, mirror.personType, snapshot.erpId, snapshot.erpVersion, JSON.stringify(mirror), (!intent.localVersion ? intent.local?.company : undefined) ?? row.company, (!intent.localVersion ? intent.local?.notes : undefined) ?? row.notes, searchText([mirror.name, ...mirror.phones, mirror.email, (!intent.localVersion ? intent.local?.company : undefined) ?? row.company].join(" ")), time, intent.actor.id, job.profile_id, id, intent.bridgeVersion]],
    ...guard(job.command_id, "mirror"),
  ] : [
    ["INSERT INTO contacts(id,profile_id,namespace,name,phone,email,document,person_type,erp_contact_id,erp_version,mirror_json,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, job.profile_id, job.namespace, mirror.name, mirror.phones[0] ?? "", mirror.email, mirror.document, mirror.personType, snapshot.erpId, snapshot.erpVersion, JSON.stringify(mirror), searchText([mirror.name, ...mirror.phones, mirror.email].join(" ")), "erp", intent.actor.id, intent.actor.id, time, time]],
    ["UPDATE customer_jobs SET contact_id=? WHERE profile_id=? AND id=? AND state='running' AND attempts=?", [id, job.profile_id, job.id, job.attempts]],
    ...guard(job.command_id, "bind"),
  ];
  statements.unshift(...phoneSafetyStatements(job.profile_id, job.namespace, mirror.phones, job.command_id));
  statements.push(...await identityPort.indexContact(env, { profileId: job.profile_id, namespace: job.namespace, contactId: id, phones: mirror.phones, origin: "mirror" }),
    ...finishStatement(job, "done", await seal(env, { contactId: id, version })),
    ...await finishOfflineJobs(env, row, job.id, version),
    auditStatement(intent.actor, job.profile_id, "contact.sync", id, job.command_id));
  await guardedBatch(env, statements);
}
export async function finishOfflineJobs(env: Env, row: any, owner: string, version: number): Promise<Statement[]> {
  const offline = row?.local_patch_cipher ? await unseal(env, row.local_patch_cipher) : null;
  if (!offline?.jobs?.length) return [];
  return [[`UPDATE customer_jobs SET state='done',payload_cipher=NULL,result_cipher=?,error_code=NULL,lease_until=NULL,
    cursor_json=json_set(json_remove(cursor_json,'$.missingFields','$.localApplied'),'$.compacted',1),updated=max(updated+1,?)
    WHERE profile_id=? AND contact_id=? AND id<>? AND id IN (SELECT value FROM json_each(?))
      AND state IN ('pending','paused') AND json_extract(cursor_json,'$.localApplied')=1`,
  [await seal(env, { contactId: row.id, version }), now(), row.profile_id, row.id, owner, JSON.stringify(offline.jobs)]]];
}
export async function processJob(env: Env, profile: string, id: string, localOnly = false) {
  const time = now();
  const full = await enabled(env, profile);
  const ordering = !full ? `NOT EXISTS(SELECT 1 FROM customer_jobs earlier WHERE earlier.profile_id=customer_jobs.profile_id AND earlier.contact_id IS customer_jobs.contact_id AND earlier.namespace=customer_jobs.namespace AND earlier.state NOT IN ('done','retained','cancelled') AND (earlier.created<customer_jobs.created OR (earlier.created=customer_jobs.created AND earlier.id<customer_jobs.id)) AND (coalesce(json_extract(earlier.cursor_json,'$.localApplied'),0)<>1 OR earlier.state='conflict'))` : headPredicate;
  const claimed = await one(env, `UPDATE customer_jobs SET state='running',attempts=attempts+1,lease_until=?,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND kind IN ('enrich','promote','bind','sync') AND (((state='pending' OR (state='paused' AND coalesce(error_code,'module_disabled')='module_disabled') OR (state='conflict' AND json_extract(cursor_json,'$.customerErp.sent')=1 AND json_extract(cursor_json,'$.customerErp.outcome') IS NULL)) AND retry_at<=?) OR (state='running' AND lease_until<=?)) AND ${ordering} RETURNING *`, time + CUSTOMER_LEASE_MS, time, profile, id, time, time);
  if (!claimed) return;
  try {
    const cursor = JSON.parse(claimed.cursor_json);
    if (cursor.owner === "import") return await processImportRow(env, claimed);
    if (cursor.customerErp?.intent) {
      if (localOnly) return finishState(env, claimed, "pending", null);
      const { resumeBridgeJob } = await import("./erp-bridge");
      await resumeBridgeJob(env, claimed);
      return;
    }
    if (!claimed.payload_cipher) return finishState(env, claimed, "conflict", "missing_intent");
    const intent: Intent = await unseal(env, claimed.payload_cipher);
    const row = claimed.contact_id ? await contactRow(env, intent.actor, profile, claimed.contact_id, true) : null;
    if (row?.local_patch_cipher && intent.localVersion && !intent.bridge) {
      const offline = await unseal(env, row.local_patch_cipher);
      if (!offline.jobs && row.version === intent.localVersion) {
        const tracked = await seal(env, { ...offline, jobs: [claimed.id], version: row.version });
        await guardedBatch(env, [
          ["UPDATE contacts SET local_patch_cipher=? WHERE profile_id=? AND id=? AND version=? AND local_patch_cipher=?", [tracked, profile, row.id, row.version, row.local_patch_cipher]],
          ...guard(claimed.command_id, "legacy-local"),
          ["UPDATE customer_jobs SET cursor_json=json_set(cursor_json,'$.localApplied',1) WHERE profile_id=? AND id=? AND state='running' AND attempts=?", [profile, claimed.id, claimed.attempts]],
          ...guard(claimed.command_id, "legacy-job"),
        ]);
        row.local_patch_cipher = tracked;
      }
    }
    if (isCustomerSelfActor(intent.actor)) {
      if (intent.operation !== "enrich" || intent.input.mode !== "fill_empty" || intent.local ||
          Object.keys(intent.input.patch).some(key => !["name", "email", "document", "personType"].includes(key)))
        throw new ApiError(403, "forbidden", "Confirmação cadastral fora do escopo.");
      await validateCustomerSelfActor(env, intent.actor, profile, claimed.contact_id);
    }
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
      const offline = intent.localVersion && row.local_patch_cipher ? await unseal(env, row.local_patch_cipher) : null;
      if (!intent.bridge && row.version !== (intent.localVersion ?? intent.input.expectedVersion) &&
          !(intent.localVersion && !intent.bridge && offline?.version === row.version && offline?.jobs?.includes(claimed.id)))
        return finishState(env, claimed, "conflict", "contact_conflict");
    }
    if (row && intent.operation === "enrich" && intent.local && !Object.keys(intent.input.patch).length) {
      const offline = row.local_patch_cipher ? await unseal(env, row.local_patch_cipher) : null;
      await guardedBatch(env, [
        ["UPDATE contacts SET company=?,notes=?,search_text=?,local_patch_cipher=?,version=version+1,updated=?,updated_by=? WHERE profile_id=? AND id=? AND version=? AND identity_state='active'", [intent.local.company ?? row.company, intent.local.notes ?? row.notes, searchText([row.name, row.phone, row.email, intent.local.company ?? row.company].join(" ")), offline ? await seal(env, { ...offline, version: row.version + 1 }) : null, now(), intent.actor.id, profile, row.id, row.version]],
        ...guard(claimed.command_id, "local-notes"),
        ...finishStatement(claimed, "done", await seal(env, { contactId: row.id, version: row.version + 1 })),
        auditStatement(intent.actor, profile, "contact.enrich", row.id, claimed.command_id),
      ]);
      return;
    }
    if (row?.namespace.startsWith("app:")) {
      if (intent.operation !== "enrich" || intent.input.patch.address)
        return finishState(env, claimed, "conflict", "invalid_customer_patch", intent.input.patch.address ? ["address"] : []);
      return await applyLocal(env, claimed, intent, row);
    }
    if (!full) {
      if (!row || intent.operation === "bind" || intent.bridge) return finishState(env, claimed, "paused", "module_disabled");
      return await applyLocal(env, claimed, intent, row);
    }
    if (localOnly) return finishState(env, claimed, "pending", null);
    await applyErp(env, claimed, intent, row);
  } catch (error) {
    if (error instanceof BudgetExhausted) throw error;
    const code = error instanceof ApiError ? error.code : "dependency_unavailable";
    await finishState(env, claimed, error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429 ? "conflict" : "pending", code);
  }
}
async function tryJob(env: Env, profile: string, id: string, localOnly = false) {
  try { await processJob(env, profile, id, localOnly); } catch { /* lease e intenção permitem retomada */ }
}
export async function bindFromErp(env: Env, actor: Actor, profile: string, erpId: string, command: string): Promise<CustomerWriteResult> {
  customerAccess(actor, profile, false, "erp"); human(actor);
  if (typeof erpId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(erpId))
    throw new ApiError(400, "invalid_request", "Informe o identificador do ERP.");
  const hash = await requestHash(actor, { erpId, operation: "bind" });
  const replay = await replayJob(env, profile, command, hash);
  if (replay) return writeResult(env, replay);
  const intent: Intent = { actor, operation: "bind", erpId, newContactId: uid(),
    base: { name: "", phones: [], email: "", document: null, personType: null },
    input: { commandId: command, expectedVersion: 1, expectedErpVersion: null, patch: {}, mode: "fill_empty" } };
  const job = jobInsert(profile, "team", null, "bind", command, hash, await seal(env, intent), null, null, uid(), { owner: "write", erpId });
  try { await batch(env, [job.statement]); }
  catch (error) {
    const previous = await replayJob(env, profile, command, hash);
    if (previous) return writeResult(env, previous);
    throw error;
  }
  accepted(await one(env, "SELECT error_code FROM customer_jobs WHERE profile_id=? AND id=?", profile, job.id));
  // Associação sempre devolve a intenção; não cria uma pessoa no ERP.
  return { contactId: intent.newContactId!, version: 1, jobId: job.id, state: "pending", pending: true };
}

interface ImportIntent {
  actor: Actor;
  rows: { id: string; fingerprint: string; values: ContactValues }[];
}
async function sealImport(env: Env, value: ImportIntent) {
  const cipher = JSON.parse(await seal(env, value));
  let bytes = "";
  for (let start = 0; start < cipher.data.length; start += 4096) bytes += String.fromCharCode(...cipher.data.slice(start, start + 4096));
  // CSV de 1 MB continua cabendo no valor D1: base64 evita a expansão da
  // representação decimal do array cifrado. O conteúdo permanece AES-GCM.
  return JSON.stringify({ iv: cipher.iv, base64: btoa(bytes) });
}
async function unsealImport(env: Env, cipher: string): Promise<ImportIntent> {
  const stored = JSON.parse(cipher);
  if (typeof stored.base64 !== "string") return unseal(env, cipher);
  return unseal(env, JSON.stringify({ iv: stored.iv, data: Array.from(atob(stored.base64), char => char.charCodeAt(0)) }));
}
export async function importResult(env: Env, job: any) {
  accepted(job);
  if (job.state === "conflict")
    throw new ApiError(409, job.error_code ?? "contact_conflict", "A importação encontrou um conflito. Consulte a solicitação antes de tentar novamente.");
  if (job.state === "done" && job.result_cipher) return unseal(env, job.result_cipher);
  const view = jobView(job);
  if (job.state === "done" && view.progress) return { imported: view.progress.imported, skipped: view.progress.skipped, total: view.progress.total };
  return { ...view.progress, jobId: job.id, state: job.state, pending: !terminal(job.state), errorCode: job.error_code };
}
export async function enqueueImport(env: Env, actor: Actor, profile: string, namespace: Namespace, command: string, hash: string,
  rows: { fingerprint: string; values: ContactValues }[], skipped: number, total: number) {
  const previous = await replayJob(env, profile, command, hash);
  if (previous) return importResult(env, previous);
  const intent: ImportIntent = { actor, rows: rows.map(row => ({ ...row, id: uid() })) };
  const progress = { processed: skipped, imported: 0, skipped, total };
  const job = jobInsert(profile, namespace, null, "enrich", command, hash, await sealImport(env, intent), null, null, uid(), { owner: "import", offset: 0, import: progress });
  try { await guardedBatch(env, [job.statement]); }
  catch (error) {
    const replay = await replayJob(env, profile, command, hash);
    if (replay) return importResult(env, replay);
    throw error;
  }
  const saved = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, job.id);
  accepted(saved);
  // Conserva a importação atômica publicada. INSERTs de até vinte linhas e
  // índice em conjunto cabem em quarenta instruções, inclusive a intenção.
  // Se a chamada cair, o mesmo job retoma em etapas menores na manutenção.
  try { await completeImport(env, saved, intent); }
  catch (error) {
    // Um conflito de integridade não é indisponibilidade transitória. O lote
    // foi desfeito e a intenção fica visível, sem retomar linhas isoladamente.
    const conflict = error instanceof ApiError && error.status < 500;
    await exec(env, "UPDATE customer_jobs SET state=?,error_code=?,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND state='pending' AND attempts=0",
      conflict ? "conflict" : "pending", conflict ? error.code : "dependency_unavailable", now(), profile, job.id);
  }
  return importResult(env, await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, job.id));
}
async function completeImport(env: Env, job: any, intent: ImportIntent) {
  const cursor = JSON.parse(job.cursor_json), statements: Statement[] = [];
  const phones = [...new Set(intent.rows.map(row => row.values.phone).filter(Boolean))];
  statements.push(...phoneSafetyStatements(job.profile_id, job.namespace, phones, job.command_id));
  for (let start = 0; start < intent.rows.length; start += 20) {
    statements.push([`INSERT INTO contacts(id,profile_id,namespace,name,phone,email,company,notes,search_text,source,import_fingerprint,created_by,updated_by,created,updated)
      SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.values.name'),json_extract(value,'$.values.phone'),json_extract(value,'$.values.email'),
        json_extract(value,'$.values.company'),json_extract(value,'$.values.notes'),json_extract(value,'$.search'),'csv',json_extract(value,'$.fingerprint'),?,?,?,?
      FROM json_each(?) WHERE 1 ON CONFLICT(profile_id,namespace,import_fingerprint) DO NOTHING`,
    [job.profile_id, job.namespace, intent.actor.id, intent.actor.id, now(), now(), JSON.stringify(intent.rows.slice(start, start + 20).map(entry => ({ ...entry, search: searchText([entry.values.name, entry.values.phone, entry.values.email, entry.values.company].join(" ")) })))]]);
  }
  const ids = JSON.stringify(intent.rows.map(row => row.id));
  // Até quatro linhas, o índice individual cabe no orçamento junto com os
  // guardiões e o recibo. Conserva o contrato da porta no caminho simples;
  // arquivos maiores usam o índice em conjunto abaixo para aceitar 500 linhas.
  if (intent.rows.length <= 4) for (const entry of intent.rows) {
    statements.push(...await identityPort.indexContact(env, {
      profileId: job.profile_id, namespace: job.namespace, contactId: entry.id,
      phones: entry.values.phone ? [entry.values.phone] : [], origin: "local",
    }));
  }
  if (phones.length) statements.push([
    `INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin)
      SELECT profile_id,namespace,phone,id,'local' FROM contacts WHERE profile_id=? AND namespace=? AND phone<>'' AND id IN (SELECT value FROM json_each(?))
      ON CONFLICT(profile_id,namespace,phone,contact_id) DO NOTHING`, [job.profile_id, job.namespace, ids],
  ], [
    // Telefone importado é apenas candidato. Nunca vira credencial de canal.
    `INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state)
      SELECT ?,?,p.value,NULL,CASE WHEN count(k.contact_id)>1 THEN 'ambiguous' ELSE 'pending' END FROM json_each(?) p
      LEFT JOIN customer_phone_candidates k ON k.profile_id=? AND k.namespace=? AND k.phone=p.value WHERE 1 GROUP BY p.value
      ON CONFLICT(profile_id,namespace,phone) DO UPDATE SET contact_id=NULL,state=excluded.state,version=customer_phones.version+1`,
    [job.profile_id, job.namespace, JSON.stringify(phones), job.profile_id, job.namespace],
  ], [
    `UPDATE conversations SET customer_link_state='pending' WHERE profile_id=? AND customer_link_state NOT IN ('blocked','excluded')
      AND verified_phone IN (SELECT value FROM json_each(?)) AND (CASE WHEN external_namespace LIKE 'app:%' THEN external_namespace ELSE 'team' END)=?`,
    [job.profile_id, JSON.stringify(phones), job.namespace],
  ]);
  statements.push([
    `UPDATE customer_jobs SET state='done',payload_cipher=NULL,error_code=NULL,updated=max(updated+1,?),cursor_json=json_set(cursor_json,
      '$.compacted',1,'$.offset',?,'$.import.processed',?,'$.import.imported',(SELECT count(*) FROM contacts WHERE profile_id=? AND namespace=? AND id IN (SELECT value FROM json_each(?))),
      '$.import.skipped',?-(SELECT count(*) FROM contacts WHERE profile_id=? AND namespace=? AND id IN (SELECT value FROM json_each(?))))
      WHERE profile_id=? AND id=? AND state='pending' AND attempts=0 AND cursor_json=?`,
    [now(), intent.rows.length, cursor.import.total, job.profile_id, job.namespace, ids, cursor.import.total, job.profile_id, job.namespace, ids, job.profile_id, job.id, job.cursor_json],
  ], ...guard(job.command_id, "import-complete"));
  await guardedBatch(env, statements);
}
async function processImportRow(env: Env, job: any) {
  const intent = await unsealImport(env, job.payload_cipher);
  const cursor = JSON.parse(job.cursor_json), entry = intent.rows[cursor.offset];
  const statements: Statement[] = [];
  if (entry) {
    const duplicate = await one(env, "SELECT id FROM contacts WHERE profile_id=? AND namespace=? AND import_fingerprint=?", job.profile_id, job.namespace, entry.fingerprint);
    if (!duplicate) {
      const v = entry.values;
      statements.push(...phoneSafetyStatements(job.profile_id, job.namespace, v.phone ? [v.phone] : [], job.command_id),
        ["INSERT INTO contacts(id,profile_id,namespace,name,phone,email,company,notes,search_text,source,import_fingerprint,created_by,updated_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,'csv',?,?,?,?,?)",
          [entry.id, job.profile_id, job.namespace, v.name, v.phone, v.email, v.company, v.notes, searchText([v.name, v.phone, v.email, v.company].join(" ")), entry.fingerprint, intent.actor.id, intent.actor.id, now(), now()]],
        ...await identityPort.indexContact(env, { profileId: job.profile_id, namespace: job.namespace, contactId: entry.id, phones: v.phone ? [v.phone] : [], origin: "local" }));
      cursor.import.imported++;
    } else cursor.import.skipped++;
    cursor.offset++;
    cursor.import.processed++;
  }
  const done = cursor.offset >= intent.rows.length;
  const result = done ? await seal(env, { imported: cursor.import.imported, skipped: cursor.import.skipped, total: cursor.import.total }) : null;
  statements.push([`UPDATE customer_jobs SET state=?,cursor_json=?,payload_cipher=CASE WHEN ?=1 THEN NULL ELSE payload_cipher END,
    result_cipher=?,error_code=NULL,lease_until=NULL,retry_at=0,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND state='running' AND attempts=? AND cursor_json=?`,
    [done ? "done" : "pending", JSON.stringify(cursor), done ? 1 : 0, result, now(), job.profile_id, job.id, job.attempts, job.cursor_json]], ...guard(job.command_id, "import-row"));
  await guardedBatch(env, statements);
}

/** Revisão humana substitui a intenção em conflito, sem editar o corpo de um replay. */
export async function resolveCustomerJob(env: Env, actor: Actor, profile: string, id: string, raw: CustomerWrite, command: string) {
  human(actor); customerAccess(actor, profile, true);
  const input = validateWrite({ ...raw, commandId: command });
  const hash = await requestHash(actor, { operation: "resolve-job", id, input });
  const replay = await replayJob(env, profile, command, hash);
  if (replay) return writeResult(env, replay);
  const old = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, id);
  if (!old?.contact_id) throw new ApiError(404, "not_found", "Solicitação não encontrada.");
  const row = await contactRow(env, actor, profile, old.contact_id);
  const cursor = JSON.parse(old.cursor_json);
  // Um save ERP enviado precisa ser reconciliado pela mesma intenção; não criar
  // um novo recibo capaz de duplicar a pessoa após uma resposta perdida.
  if (old.state !== "conflict" || cursor.customerErp?.sent || !["enrich", "promote"].includes(old.kind))
    throw new ApiError(409, "sync_pending", "Concilie a intenção já enviada ao ERP antes de substituí-la.");
  if (row.version !== input.expectedVersion || row.erp_version !== input.expectedErpVersion)
    throw new ApiError(409, "contact_conflict", "O cadastro mudou. Reabra a ficha.");
  const intent: Intent = { actor, input, base: mirrorOf(row), operation: old.kind };
  const next = jobInsert(profile, row.namespace, row.id, old.kind, command, hash, await seal(env, intent), row.version, row.erp_version, `${old.id}:r`);
  // Mantém a posição (created,id) anterior aos comandos que ela bloqueava.
  next.statement[1][12] = old.created;
  await guardedBatch(env, [
    ["UPDATE customer_jobs SET state='cancelled',payload_cipher=NULL,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND state='conflict' AND cursor_json=?", [now(), profile, id, old.cursor_json]],
    ...guard(command, "resolve-job"), next.statement,
    auditStatement(actor, profile, "contact.resolve-job", row.id, command),
  ]);
  await tryJob(env, profile, next.id, true);
  return writeResult(env, await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, next.id));
}

/** Encerra somente a intenção escolhida, com CAS humano e recibo de auditoria. */
export async function cancelCustomerJob(env: Env, actor: Actor, profile: string, id: string,
  data: { expectedUpdated: number; expectedVersion: number; reason: string }, command: string) {
  human(actor); customerAccess(actor, profile, true);
  if (!Number.isSafeInteger(data.expectedUpdated) || !Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 1 ||
      typeof data.reason !== "string" || !data.reason.trim() || data.reason.length > 500 || /[\u0000-\u001f]/.test(data.reason))
    throw new ApiError(400, "invalid_request", "Informe versão, atualização e motivo do cancelamento.");
  const row = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, id);
  if (!row) throw new ApiError(404, "not_found", "Solicitação não encontrada.");
  const hash = await requestHash(actor, { operation: "contact.job-cancel", id, data });
  const cursor = JSON.parse(row.cursor_json);
  if (cursor.cancel?.command === command) {
    if (cursor.cancel.hash !== hash) throw new ApiError(409, "idempotency_conflict", "O comando de cancelamento mudou.");
    return jobView(row);
  }
  const contact = row.contact_id ? await contactRow(env, actor, profile, row.contact_id) : null;
  if (terminal(row.state) || row.updated !== data.expectedUpdated || (contact?.version ?? row.expected_version ?? 1) !== data.expectedVersion)
    throw new ApiError(409, "contact_conflict", "A solicitação mudou. Reabra a ficha.");
  const intent = row.payload_cipher && cursor.owner !== "import" ? await unseal(env, row.payload_cipher) : null;
  if ((row.state === "running" && row.lease_until > now()) ||
      (cursor.customerErp?.sent && !cursor.customerErp?.outcome) ||
      (intent?.bridge && !cursor.customerErp && !cursor.executorOutcome))
    throw new ApiError(409, "sync_pending", "O resultado do envio ao ERP precisa ser conciliado antes do cancelamento.");
  cursor.cancel = { command, hash, actor: actor.id };
  cursor.reason = data.reason.trim();
  if (cursor.customerErp) cursor.customerErp = { fingerprint: cursor.customerErp.fingerprint, rpcCommandId: cursor.customerErp.rpcCommandId, outcome: cursor.customerErp.outcome, remote: cursor.customerErp.remote };
  const local: Statement[] = [];
  const offline = contact?.local_patch_cipher ? await unseal(env, contact.local_patch_cipher) : null;
  if (offline?.jobs?.includes(id)) {
    const remaining = await all(env, "SELECT id,payload_cipher FROM customer_jobs WHERE profile_id=? AND contact_id=? AND id<>? AND id IN (SELECT value FROM json_each(?)) AND state NOT IN ('done','retained','cancelled') ORDER BY created,id", profile, contact.id, id, JSON.stringify(offline.jobs));
    const patch = {};
    for (const job of remaining) if (job.payload_cipher) Object.assign(patch, (await unseal(env, job.payload_cipher)).input?.patch);
    local.push(["UPDATE contacts SET local_patch_cipher=? WHERE profile_id=? AND id=? AND version=? AND local_patch_cipher=?",
      [remaining.length ? await seal(env, { ...offline, patch, jobs: remaining.map(job => job.id) }) : null, profile, contact.id, data.expectedVersion, contact.local_patch_cipher]], ...guard(command, "cancel-local"));
  }
  await guardedBatch(env, [
    ["UPDATE customer_jobs SET state='cancelled',payload_cipher=NULL,result_cipher=?,cursor_json=?,lease_until=NULL,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND updated=? AND state=? AND (? IS NULL OR EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND id=? AND version=? AND identity_state='active'))",
      [await seal(env, { contactId: row.contact_id, version: contact?.version ?? 1 }), JSON.stringify(cursor), now(), profile, id, data.expectedUpdated, row.state, row.contact_id, profile, row.contact_id, data.expectedVersion]],
    ...guard(command, "cancel"),
    ...local,
    auditStatement(actor, profile, "contact.job-cancel", id, command),
  ]);
  return jobView(await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND id=?", profile, id));
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
  const maximum = Math.min(40, budget.remainingStatements);
  const meter = meteredEnv(env, maximum);
  let items = 0, pending = false;
  try {
    const limit = Math.min(20, budget.remainingItems);
    const jobs = await all(meter.env, `SELECT id FROM customer_jobs WHERE profile_id=? AND kind IN ('enrich','promote','bind','sync') AND (((state='pending' OR (state='paused' AND coalesce(error_code,'module_disabled')='module_disabled') OR (state='conflict' AND json_extract(cursor_json,'$.customerErp.sent')=1 AND json_extract(cursor_json,'$.customerErp.outcome') IS NULL)) AND retry_at<=?) OR (state='running' AND lease_until<=?)) AND ${headPredicate} ORDER BY created,id LIMIT ?`, profile, now(), now(), limit);
    pending = jobs.length === limit;
    for (const job of jobs) {
      if (meter.count() + 20 > maximum) { pending = true; break; }
      items++;
      await processJob(meter.env, profile, job.id);
    }
    if (!jobs.length && meter.count() + 3 <= maximum) {
      const old = await one(meter.env, `SELECT * FROM customer_jobs WHERE profile_id=? AND state IN ('done','cancelled','retained')
        AND kind IN ('enrich','promote','bind','sync') AND coalesce(json_extract(cursor_json,'$.compacted'),0)=0
        AND json_extract(cursor_json,'$.receipt') IS NULL ORDER BY created,id LIMIT 1`, profile);
      if (old) {
        const cursor = JSON.parse(old.cursor_json), saved = old.result_cipher ? await unseal(meter.env, old.result_cipher) : {};
        if (cursor.customerErp) cursor.customerErp = { fingerprint: cursor.customerErp.fingerprint, rpcCommandId: cursor.customerErp.rpcCommandId,
          done: old.state === "done", outcome: cursor.customerErp.outcome, ...(old.state === "cancelled" ? { remote: cursor.customerErp.remote } : {}) };
        cursor.compacted = 1;
        const receipt = cursor.owner === "import" ? { imported: saved.imported, skipped: saved.skipped, total: saved.total }
          : { contactId: old.contact_id ?? saved.contactId ?? null, version: saved.version ?? old.expected_version ?? 1 };
        await exec(meter.env, "UPDATE customer_jobs SET cursor_json=?,result_cipher=?,payload_cipher=NULL WHERE profile_id=? AND id=? AND state=? AND updated=?", JSON.stringify(cursor), await seal(meter.env, receipt), profile, old.id, old.state, old.updated);
        items++; pending = true;
      }
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
