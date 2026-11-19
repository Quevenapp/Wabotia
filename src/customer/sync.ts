import { all, batch, exec, one } from "../db";
import { searchText } from "../contact-csv";
import { canonical, seal, unseal } from "../security";
import { ApiError, now, uid, type Actor, type Env } from "../types";
import type { BridgeSnapshot, CustomerMirror, MaintenanceBudget, MaintenanceResult, Statement } from "./contracts";
import { isFullCustomerEnabled } from "./feature";
import { erpBridge, identityPort } from "./ports";
import { cleanMirror, phoneSafetyStatements } from "./local";
import { auditStatement } from "../events";

export interface BridgeContact {
  id: string; profile_id: string; namespace: string; name: string; phone: string; email: string;
  document: string | null; person_type: "F" | "J" | "E" | null; company: string; notes: string; version: number;
  erp_contact_id: string | null; erp_version: number | null; mirror_json: string | null;
  local_patch_cipher: string | null; identity_state: string;
}
export interface BridgeJob {
  id: string; profile_id: string; namespace: string; contact_id: string | null; command_id: string;
  request_hash: string; state: string; cursor_json: string; created: number;
  payload_cipher?: string | null;
}
export const SCAN_TASK = "erp.contacts.scan.v1";
// Retira somente os caches de invocação; ativação precisa ser relida após uma ida remota.
export const freshCustomerEnv = (env: Env): Env => Object.fromEntries(Object.entries(env)) as unknown as Env;
export const customerEnabled = (env: Env, profile: string) => isFullCustomerEnabled(freshCustomerEnv(env), profile);
export const contactForBridge = (env: Env, profile: string, id: string) =>
  one<BridgeContact>(env, "SELECT * FROM contacts WHERE profile_id=? AND id=?", profile, id);
export const bridgeConflict = (code = "contact_conflict") => new ApiError(409, code, "O cadastro precisa de revisão antes de sincronizar.");

export function mirrorOf(contact: BridgeContact): CustomerMirror {
  return { name: contact.name, phones: contact.phone ? [contact.phone] : [], email: contact.email,
    document: contact.document, personType: contact.person_type };
}
function hasLocalChanges(contact: BridgeContact) {
  if (contact.local_patch_cipher || !contact.mirror_json) return true;
  const mirror = JSON.parse(contact.mirror_json) as CustomerMirror;
  // phone é a projeção curta; os demais telefones permanecem em mirror_json.
  return canonical({ ...mirrorOf(contact), phones: undefined }) !== canonical({ ...mirror, phones: undefined }) ||
    contact.phone !== (mirror.phones[0] ?? "");
}
function guard(id: string): Statement {
  return ["INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok", [id]];
}

/** Lote único: CAS do contato, índice e recibo. Qualquer guarda falha desfaz tudo. */
export async function mirrorStatements(
  env: Env, contact: BridgeContact, snapshot: BridgeSnapshot,
  job?: BridgeJob, source?: { version: number; localPatch: string | null },
): Promise<Statement[]> {
  if (contact.identity_state !== "active" || contact.namespace !== "team") throw bridgeConflict("customer_erasing");
  if (contact.erp_contact_id && contact.erp_contact_id !== snapshot.erpId) throw bridgeConflict();
  if (snapshot.erpVersion < (contact.erp_version ?? 0)) throw bridgeConflict();
  if (source ? contact.version !== source.version || contact.local_patch_cipher !== source.localPatch : hasLocalChanges(contact))
    throw bridgeConflict();
  const owner = await one<{ id: string }>(env,
    "SELECT id FROM contacts WHERE profile_id=? AND erp_contact_id=? AND id<>?", contact.profile_id, snapshot.erpId, contact.id);
  if (owner) throw bridgeConflict("namespace_conflict");
  const mirror = cleanMirror(snapshot.mirror);
  const intent = job?.payload_cipher ? await unseal(env, job.payload_cipher) : null;
  const local = intent?.localVersion ? null : intent?.local;
  const changed = contact.erp_contact_id !== snapshot.erpId || contact.erp_version !== snapshot.erpVersion ||
    contact.mirror_json !== JSON.stringify(mirror) || !!contact.local_patch_cipher ||
    (local?.company !== undefined && local.company !== contact.company) || (local?.notes !== undefined && local.notes !== contact.notes);
  if (!changed && !job) return [];
  const indexed = changed ? await identityPort.indexContact(env, {
    profileId: contact.profile_id, namespace: "team", contactId: contact.id, phones: mirror.phones, origin: "mirror",
  }) : [];
  const key = `erp:${job?.command_id ?? `${contact.id}:${snapshot.erpVersion}`}`;
  const statements: Statement[] = [[
    `UPDATE contacts SET name=?,phone=?,email=?,document=?,person_type=?,erp_contact_id=?,erp_version=?,mirror_json=?,
       local_patch_cipher=NULL,search_text=?,updated_by='system:contact-erp-link',updated=?,version=version+?
     WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active' AND version=?
       AND local_patch_cipher IS ? AND mirror_json IS ? AND erp_contact_id IS ? AND erp_version IS ?`,
    [mirror.name, mirror.phones[0] ?? "", mirror.email, mirror.document, mirror.personType, snapshot.erpId,
      snapshot.erpVersion, JSON.stringify(mirror), searchText([mirror.name, ...mirror.phones, mirror.email, mirror.document, local?.company ?? contact.company].join(" ")),
      now(), changed ? 1 : 0, contact.profile_id, contact.id, contact.version, contact.local_patch_cipher,
      contact.mirror_json, contact.erp_contact_id, contact.erp_version],
  ], guard(`${key}:contact`), ...indexed];
  if (local) statements.push([
    "UPDATE contacts SET company=?,notes=? WHERE profile_id=? AND id=?",
    [local.company ?? contact.company, local.notes ?? contact.notes, contact.profile_id, contact.id],
  ]);
  if (job) {
    const cursor = JSON.parse(job.cursor_json);
    // Endereço e corpo entregues deixam a intenção; fica só o fingerprint do recibo.
    cursor.customerErp = { fingerprint: cursor.customerErp.fingerprint, rpcCommandId: cursor.customerErp.rpcCommandId, done: true };
    delete cursor.missingFields;
    delete cursor.localApplied;
    cursor.compacted = 1;
    statements.push([
      "UPDATE customer_jobs SET state='done',cursor_json=?,result_cipher=?,payload_cipher=NULL,error_code=NULL,lease_until=NULL,updated=max(updated+1,?) WHERE profile_id=? AND id=? AND cursor_json=? AND state NOT IN ('cancelled','retained')",
      [JSON.stringify(cursor), await seal(env, { contactId: contact.id, version: contact.version + (changed ? 1 : 0) }), now(), job.profile_id, job.id, job.cursor_json],
    ], guard(`${key}:job`), ["DELETE FROM customer_assert WHERE id=?", [`${key}:job`]]);
    const { finishOfflineJobs } = await import("./jobs");
    statements.push(...await finishOfflineJobs(env, contact, job.id, contact.version + (changed ? 1 : 0)));
    if (intent?.actor) statements.push(auditStatement(intent.actor, contact.profile_id, "contact.sync", contact.id, job.command_id));
  }
  statements.push(["DELETE FROM customer_assert WHERE id=?", [`${key}:contact`]]);
  return statements;
}

export async function confirmBridgeSnapshot(
  env: Env, contact: BridgeContact, snapshot: BridgeSnapshot, job: BridgeJob,
  source: { version: number; localPatch: string | null },
): Promise<boolean> {
  const statements = await mirrorStatements(env, contact, snapshot, job, source);
  if (!await customerEnabled(env, contact.profile_id)) return false;
  await batch(env, statements);
  return true;
}

/** Associação por leitura autorizada: espelho novo, vínculo e recibo juntos. */
export async function confirmBridgeBinding(env: Env, id: string, snapshot: BridgeSnapshot, job: BridgeJob, actor: Actor) {
  const mirror = cleanMirror(snapshot.mirror);
  const existing = await one<BridgeContact>(env, "SELECT * FROM contacts WHERE profile_id=? AND erp_contact_id=?", job.profile_id, snapshot.erpId);
  if (existing && (existing.namespace !== "team" || existing.identity_state !== "active")) throw bridgeConflict("namespace_conflict");
  const contactId = existing?.id ?? id, version = existing?.version ?? 1, time = now();
  const cursor = JSON.parse(job.cursor_json);
  cursor.customerErp = { fingerprint: cursor.customerErp.fingerprint, rpcCommandId: cursor.customerErp.rpcCommandId, done: true };
  cursor.compacted = 1;
  const statements: Statement[] = existing ? [] : [...phoneSafetyStatements(job.profile_id, "team", mirror.phones, job.command_id), [
    `INSERT INTO contacts(id,profile_id,namespace,name,phone,email,document,person_type,erp_contact_id,erp_version,mirror_json,search_text,source,created_by,updated_by,created,updated)
      VALUES(?,?,'team',?,?,?,?,?,?,?,?,?,'erp',?,?,?,?)`,
    [id, job.profile_id, mirror.name, mirror.phones[0] ?? "", mirror.email, mirror.document, mirror.personType, snapshot.erpId, snapshot.erpVersion,
      JSON.stringify(mirror), searchText([mirror.name, ...mirror.phones, mirror.email].join(" ")), actor.id, actor.id, time, time],
  ], ...await identityPort.indexContact(env, { profileId: job.profile_id, namespace: "team", contactId: id, phones: mirror.phones, origin: "mirror" })];
  statements.push([
    `UPDATE customer_jobs SET contact_id=?,state='done',payload_cipher=NULL,result_cipher=?,cursor_json=?,error_code=NULL,lease_until=NULL,updated=max(updated+1,?)
      WHERE profile_id=? AND id=? AND cursor_json=? AND state NOT IN ('done','retained','cancelled')
        AND EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND id=? AND version=? AND identity_state='active' AND namespace='team')`,
    [contactId, await seal(env, { contactId, version }), JSON.stringify(cursor), time, job.profile_id, job.id, job.cursor_json, job.profile_id, contactId, version],
  ], guard(`bind:${job.id}`), ["DELETE FROM customer_assert WHERE id=?", [`bind:${job.id}`]], auditStatement(actor, job.profile_id, "contact.bind", contactId, job.command_id));
  if (!await customerEnabled(env, job.profile_id)) throw new ApiError(409, "module_disabled", "Cadastro completo desligado nesta área.");
  await batch(env, statements);
}

/** Antes de enviar uma escrita. Falha aqui impede envio, nunca fica só em memória. */
export async function markCustomerReconciliation(env: Env, profile: string): Promise<void> {
  if (!await customerEnabled(env, profile)) throw new ApiError(409, "module_disabled", "Cadastro completo desligado nesta área.");
  await exec(env, `INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
    VALUES(?,'team',?,?,0,?) ON CONFLICT(profile_id,namespace,task) DO UPDATE SET
    cursor_json=CASE WHEN customer_progress.complete=1 THEN excluded.cursor_json
      ELSE json_set(customer_progress.cursor_json,'$.again',1) END,complete=0,updated=excluded.updated`,
  profile, SCAN_TASK, JSON.stringify({ after: null, generation: uid() }), now());
}

/** Leitura direcionada é otimização. A marca de varredura só é consumida por maintain. */
export async function mirrorErpContact(env: Env, profile: string, snapshot: BridgeSnapshot): Promise<void> {
  if (!await customerEnabled(env, profile)) return;
  const contact = await one<BridgeContact>(env,
    "SELECT * FROM contacts WHERE profile_id=? AND erp_contact_id=? AND namespace='team' AND identity_state='active'", profile, snapshot.erpId);
  if (!contact || snapshot.erpVersion <= (contact.erp_version ?? 0)) return;
  if (await one(env, "SELECT 1 FROM customer_jobs WHERE profile_id=? AND contact_id=? AND state IN ('pending','running','paused','conflict') LIMIT 1", profile, contact.id)) return;
  const statements = await mirrorStatements(env, contact, snapshot);
  if (await customerEnabled(env, profile)) await batch(env, statements);
}

class BudgetEnd extends Error {}
/** Conta TODAS as instruções D1, inclusive ativação, identidade e índice da porta. */
function metered(env: Env, maximum: number) {
  let statements = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const debit = (n: number) => { if (statements + n > maximum) throw new BudgetEnd(); statements += n; };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, { get(target, key) {
      if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
      const value = Reflect.get(target, key);
      if (["first", "all", "run", "raw"].includes(String(key))) return (...args: unknown[]) => { debit(1); return value.apply(target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, stmt); return proxy;
  };
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
    if (key === "batch") return (stmts: D1PreparedStatement[]) => { debit(stmts.length); return target.batch(stmts.map((s) => originals.get(s) ?? s)); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { env: { ...freshCustomerEnv(env), DB }, used: () => statements };
}

/** Uma página por invocação. Checkpoint e espelho no mesmo lote; reinício periódico por ID. */
export async function maintainErpCustomers(env: Env, profile: string, budget: MaintenanceBudget): Promise<MaintenanceResult> {
  const maximum = Math.min(40, budget.remainingStatements);
  const meter = metered(env, maximum);
  const e = meter.env;
  let items = 0;
  let pending = true;
  try {
    if (!budget.remainingItems || !budget.remainingStatements) return { pending, items, statements: 0 };
    if (!await customerEnabled(e, profile)) return { pending: false, items, statements: meter.used() };
    // Recuperação de intenção existe também para quem chamou apply sem a fila externa.
    const jobs = await all<BridgeJob>(e, `SELECT * FROM customer_jobs WHERE profile_id=? AND namespace='team'
      AND (state IN ('pending','running') OR (state='paused' AND error_code='module_disabled') OR (state='conflict' AND json_extract(cursor_json,'$.customerErp.sent')=1 AND json_extract(cursor_json,'$.customerErp.outcome') IS NULL))
      AND retry_at<=? AND (lease_until IS NULL OR lease_until<=?)
      AND payload_cipher IS NULL AND json_extract(cursor_json,'$.customerErp.intent') IS NOT NULL ORDER BY created,id LIMIT 1`, profile, now(), now());
    if (jobs.length) {
      const { resumeBridgeJob } = await import("./erp-bridge");
      await resumeBridgeJob(e, jobs[0]);
      items++;
    } else {
      const progress = await one<{ cursor_json: string; complete: number; updated: number }>(e,
        "SELECT cursor_json,complete,updated FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?", profile, SCAN_TASK);
      if (progress?.complete && progress.updated > now() - 300_000) {
        pending = false;
      } else {
        if (!progress || progress.complete) { await markCustomerReconciliation(e, profile); }
        const current = !progress || progress.complete ? await one<{ cursor_json: string }>(e,
          "SELECT cursor_json FROM customer_progress WHERE profile_id=? AND namespace='team' AND task=?", profile, SCAN_TASK) : progress;
        const cursor = JSON.parse(current!.cursor_json);
        const page = await erpBridge.scan(e, profile, cursor.after ?? null, Math.min(20, budget.remainingItems));
        const checkpoint = (after: string | null, end: boolean, failed: boolean): Statement[] => [[
          `UPDATE customer_progress SET
            cursor_json=json_set(cursor_json,'$.after',?, '$.again',CASE WHEN ?=1 THEN 1 WHEN ?=1 THEN 0 ELSE coalesce(json_extract(cursor_json,'$.again'),0) END),
            complete=CASE WHEN ?=1 AND ?=0 AND coalesce(json_extract(cursor_json,'$.again'),0)=0 THEN 1 ELSE 0 END,updated=?
            WHERE profile_id=? AND namespace='team' AND task=? AND json_extract(cursor_json,'$.generation') IS ? AND json_extract(cursor_json,'$.after') IS ?`,
          [after, failed ? 1 : 0, end ? 1 : 0, end ? 1 : 0, failed ? 1 : 0, now(), profile, SCAN_TASK, cursor.generation ?? null, cursor.after ?? null],
        ], guard(`erp-scan:${profile}`), ["DELETE FROM customer_assert WHERE id=?", [`erp-scan:${profile}`]]];
        if (!page.items.length) {
          if (meter.used() + 4 <= maximum && await customerEnabled(e, profile)) {
            await batch(e, checkpoint(null, true, false)); pending = !!cursor.again;
          }
        }
        for (let index = 0; index < page.items.length; index++) {
          if (meter.used() + 5 > maximum) break;
          const snapshot = page.items[index];
          let statements: Statement[] = [], failed = false;
          const contact = await one<BridgeContact>(e, "SELECT * FROM contacts WHERE profile_id=? AND erp_contact_id=?", profile, snapshot.erpId);
          if (contact?.namespace === "team" && contact.identity_state === "active" && snapshot.erpVersion > (contact.erp_version ?? 0)) {
            // Reserva uma etapa inteira, inclusive índice, CAS e checkpoint.
            if (meter.used() + 18 > maximum) break;
            try {
              const busy = await one(e, "SELECT 1 FROM customer_jobs WHERE profile_id=? AND contact_id=? AND state IN ('pending','running','paused','conflict') LIMIT 1", profile, contact.id);
              if (!busy) {
                if (hasLocalChanges(contact)) {
                  const command = `erp-review:${contact.id}:${snapshot.erpVersion}:${contact.version}`;
                  statements.push([`INSERT OR IGNORE INTO customer_jobs(profile_id,id,namespace,contact_id,kind,state,command_id,request_hash,error_code,retry_at,created,updated)
                    VALUES(?,?,'team',?,'sync','conflict',?,?,'contact_conflict',?,?,?)`,
                  [profile, uid(), contact.id, command, command, now(), now(), now()]]);
                } else statements = await mirrorStatements(e, contact, snapshot);
              }
            } catch (error) {
              if (error instanceof BudgetEnd) throw error;
              // Erro individual não reinicia a página. A próxima passagem tenta
              // outra vez; nenhuma mensagem arbitrária/dado privado vai ao cursor.
              failed = true; statements = [];
            }
          }
          const end = index === page.items.length - 1 && page.nextCursor === null;
          const after = end ? null : snapshot.erpId;
          const writes = [...statements, ...checkpoint(after, end, failed)];
          if (meter.used() + writes.length + 1 > maximum) break;
          if (!await customerEnabled(e, profile)) break;
          await batch(e, writes);
          cursor.after = after;
          cursor.again ||= failed;
          items++;
          pending = !end || !!cursor.again;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetEnd) && !(error instanceof ApiError && [409, 503].includes(error.status))) throw error;
  }
  return { pending, items, statements: meter.used() };
}
