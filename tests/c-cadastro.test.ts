import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { defaults, now, uid, type Actor, type Env } from "../src/types";
import { seal, sha, unseal } from "../src/security";
import { countingEnv } from "./d1-counter";
import { setModule } from "./erp-module-helper";
import { contactCommand, contactDetail, getContact, listContacts, recoverContactCommand } from "../src/contacts";
import { contactChanges, parseContactCsv } from "../src/contact-csv";
import { customerIdentity } from "../src/customer/identity";
import { erpBridge, identityPort, installErpBridge, installIdentityPort } from "../src/customer/ports";
import { customerErpBridge, customerRpc, customerRpcCommandId, dataOf } from "../src/customer/erp-bridge";
import { bindFromErp, cancelCustomerJob, CUSTOMER_QUEUE_LIMIT, enrichLocal, jobInsert, jobView, maintainJobs, processJob, readJob } from "../src/customer/jobs";
import { customerRead, eraseContact, resolvePhone } from "../src/customer/http";
import { cleanMirror } from "../src/customer/local";
import { customerHistory } from "../src/customer/history";
import { maintainErpCustomers, markCustomerReconciliation, SCAN_TASK } from "../src/customer/sync";
import { withLocalModuleWake } from "../src/modules/local-wake";
import { erpIdentity } from "../src/modules/erp/identity";
import type { BridgeCommand, BridgeSnapshot, CustomerWrite } from "../src/customer/contracts";

type TestEnv = Env;
declare global { namespace Cloudflare { interface Env extends TestEnv {} } }

installIdentityPort(customerIdentity);
installErpBridge(customerErpBridge);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const profile = uid(), line = uid();
  await exec(env, "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)", profile, "Cadastro", JSON.stringify(defaults), now());
  await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active','{}',?)", line, profile, "Canal", now());
  const people: Actor[] = [];
  for (const role of ["admin", "operator"] as const) {
    const id = uid();
    await exec(env, "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)", id, `${id}@example.test`, id, "test", role, JSON.stringify([profile]), now());
    people.push({ id, name: id, kind: "user", role, profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 10 });
  }
  return { profile, line, admin: people[0], member: people[1] };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function contact(f: Fixture, extra: Record<string, unknown> = {}) {
  const id = uid();
  await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,email,company,notes,search_text,source,created_by,updated_by,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, f.profile, extra.namespace ?? "team", extra.name ?? "Ana", extra.phone ?? "", extra.email ?? "", "Empresa", "Nota local", "ana", extra.source ?? "manual", f.admin.id, f.admin.id, now(), now());
  return id;
}
const row = (id: string) => one(env, "SELECT * FROM contacts WHERE id=?", id);
const job = (id: string) => one(env, "SELECT * FROM customer_jobs WHERE id=?", id);
const input = (extra: Partial<CustomerWrite> = {}): CustomerWrite => ({ commandId: uid(), expectedVersion: 1, expectedErpVersion: null, mode: "replace_confirmed", patch: {}, ...extra });
const command = (f: Fixture, id: string, extra: Partial<BridgeCommand> = {}): BridgeCommand => ({ profileId: f.profile, namespace: "team", contactId: id, commandId: uid(), requestHash: uid(), actor: f.admin, operation: "promote", erpId: null, expectedErpVersion: null, patch: {}, ...extra });
const serial = (f: Fixture) => withLocalModuleWake(env, f.profile, async () => {});
async function run(f: Fixture, id: string, e = env) {
  await exec(env, "UPDATE customer_jobs SET retry_at=0,lease_until=0 WHERE id=?", id);
  await processJob(e, f.profile, id);
}
async function conversation(f: Fixture, namespace = `channel:${f.line}`) {
  const id = uid(), at = now();
  await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated)
    VALUES(?,?,?,?,?,'5511999990000',?,?,?,?)`, id, f.profile, namespace.startsWith("app:") ? null : f.line, namespace, uid(), uid(), at, at, at);
  return id;
}
async function remote(f: Fixture, data = { name: "Pessoa ERP", email: "a@example.com; b@example.com" }) {
  const identity = await erpIdentity(env, f.admin, f.profile, "POST");
  return (await customerRpc(env, f.profile, f.admin, identity, "erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: uid(), p_data: data, p_acknowledged: [] })).record;
}
function interrupted(stage: "before" | "after") {
  let fail = true;
  const saves: any[] = [];
  const COORDINATOR = new Proxy(env.COORDINATOR, { get(target, key) {
    if (key === "get") return (...args: any[]) => {
      const stub = (target.get as any)(...args);
      return new Proxy(stub, { get(s, prop) {
        if (prop === "fetch") return async (url: string | Request, init: any) => {
          const save = new URL(typeof url === "string" ? url : url.url).pathname.endsWith("/erp_catalog_contact_save");
          if (save) saves.push(JSON.parse(init.body));
          if (save && fail && stage === "before") { fail = false; throw Error("Interrupção antes do commit"); }
          const response = await s.fetch(url, init);
          if (save && fail && response.ok && stage === "after") { fail = false; await response.text(); throw Error("Resposta perdida após commit"); }
          return response;
        };
        const value = Reflect.get(s, prop); return typeof value === "function" ? value.bind(s) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { env: { ...env, COORDINATOR } as Env, saves };
}

it("S1: escolha administrativa sem origem autenticada conserva revisão e nunca fabrica observed", async () => {
  const f = await fixture(), a = await contact(f, { phone: "5511999990000" }), b = await contact(f, { phone: "5511999990000" });
  for (const id of [a, b]) await batch(env, await customerIdentity.indexContact(env, { profileId: f.profile, namespace: "team", contactId: id, phones: ["5511999990000"], origin: "local" }));
  const identity = await one(env, "SELECT * FROM customer_phones WHERE profile_id=?", f.profile);
  const data = { namespace: "team", phone: identity.phone, contactId: b, expectedVersion: identity.version, reason: "Escolha administrativa" }, key = uid();
  expect(await resolvePhone(env, f.admin, f.profile, data, key)).toMatchObject({ state: "ambiguous", contactId: null });
  expect(await resolvePhone(env, f.admin, f.profile, data, key)).toMatchObject({ state: "ambiguous" });
  expect((await all(env, "SELECT origin FROM customer_phone_candidates WHERE profile_id=?", f.profile)).map(r => r.origin)).toEqual(["local", "local"]);
  expect(await all(env, "SELECT * FROM customer_records WHERE profile_id=?", f.profile)).toEqual([]);
  await expect(resolvePhone(env, { ...f.member, access: ["erp:consulta"] }, f.profile, data, uid())).rejects.toMatchObject({ status: 403 });
});

it("S1: procedência observada e sessão persistida permitem conservar titularidade comprovada", async () => {
  const f = await fixture(), id = await contact(f, { phone: "5511999990000" }), c = await conversation(f);
  await batch(env, await customerIdentity.indexContact(env, { profileId: f.profile, namespace: "team", contactId: id, phones: ["5511999990000"], origin: "observed" }));
  await exec(env, "UPDATE conversations SET verified_phone=phone,customer_link_state='ready' WHERE id=?", c);
  const v = await one(env, "SELECT * FROM conversations WHERE id=?", c);
  await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'conversations','session',?,?,?,'identity',?)", f.profile, `${c}:${v.session}`, id, c, now());
  const identity = await one(env, "SELECT * FROM customer_phones WHERE profile_id=?", f.profile);
  expect(await resolvePhone(env, f.admin, f.profile, { namespace: "team", phone: identity.phone, contactId: id, expectedVersion: identity.version, reason: "Continuidade do canal" }, uid())).toMatchObject({ state: "ready", contactId: id });
  expect((await one(env, "SELECT contact_id FROM customer_records WHERE conversation_id=?", c)).contact_id).toBe(id);
});

it("S3: formulário de A não acompanha conversa reassociada a B; histórico sem respostas e detalhe autorizado preservados", async () => {
  const f = await fixture(), a = await contact(f), b = await contact(f), c = await conversation(f), step = uid();
  await setModule(f.profile, "forms", true, f.admin.id);
  await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)", c, f.profile, b, f.admin.id, now());
  await exec(env, `INSERT INTO web_steps(id,profile_id,conversation_id,module_id,kind,code_hash,status,title,spec,result,contact_id,trigger,actor,expires_at,completed_at,created,updated)
    VALUES(?,?,?,'forms','form',?,'completed','Segredo',?,?,?,'agent',?,?,?, ?,?)`, step, f.profile, c, uid(), JSON.stringify({ fields: [{ id: "privado", label: "Segredo" }] }), JSON.stringify({ privado: "Resposta secreta" }), a, f.admin.id, now(), now(), now(), now());
  expect((await contactDetail(env, f.admin, f.profile, b)).web_steps).toEqual([]);
  const visible = (await contactDetail(env, f.admin, f.profile, a)).web_steps;
  expect(visible).toEqual([expect.objectContaining({ id: step, status: "completed", answers: { privado: "Resposta secreta" } })]);
  expect(JSON.stringify(visible)).not.toMatch(/"result"|"spec"|"fields"|Segredo/);
  const history = await customerHistory.read(env, f.admin, f.profile, { contactId: a }, {});
  expect(history.items).toEqual([expect.objectContaining({ kind: "form", sourceKey: `form:${step}`, status: "completed" })]);
  expect(JSON.stringify(history)).not.toMatch(/answers|result|spec|fields|Segredo|secreta/);
  expect((await customerHistory.read(env, f.admin, f.profile, { contactId: b }, {})).items).toEqual([]);
  expect((await contactDetail(env, { ...f.member, access: ["contacts", "forms"] }, f.profile, a)).web_steps).toEqual([]);
  expect((await contactDetail(env, { ...f.member, access: ["contacts", "conversations"] }, f.profile, a)).web_steps).toEqual([]);
});

it("E6/M2 e P6: aplicação tem vínculo utilizável sem telefone verificado e edita localmente com ERP ligado", async () => {
  const f = await fixture();
  await setModule(f.profile, "erp", true, f.admin.id);
  const app: Actor = { ...f.admin, id: `app:${uid()}`, kind: "app", role: "service", scopes: ["contacts:read", "contacts:write", "conversations:read"] };
  const ns = `app:${app.id}`, c = await conversation(f, ns), id = await contact(f, { namespace: ns });
  const previous = await contact(f, { namespace: ns, name: "Proprietário anterior" });
  await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,'tickets','ticket',?,?,?,'origin',?)", f.profile, uid(), previous, c, now());
  const before = await all(env, "SELECT * FROM customer_records WHERE conversation_id=?", c);
  const apply = vi.spyOn(erpBridge, "apply"), read = vi.spyOn(erpBridge, "read");
  await contactCommand(env, app, f.profile, "contact.from-conversation", { id: c, contact_id: id });
  const persisted = await one(env, "SELECT * FROM conversations WHERE id=?", c);
  expect(await customerIdentity.resolve(env, persisted)).toMatchObject({ state: "ready", contactId: id, verifiedPhone: null, namespace: ns });
  const result = await contactCommand(env, f.admin, f.profile, "contact.update", { id, expected_version: 1, name: "Nome local", notes: "Nova nota" });
  expect(result.result).toMatchObject({ state: "done", pending: false });
  expect(await row(id)).toMatchObject({ name: "Nome local", notes: "Nova nota", erp_contact_id: null });
  expect(apply).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  expect(await all(env, "SELECT * FROM customer_records WHERE conversation_id=?", c)).toEqual(before);
  await expect(getContact(env, { ...app, id: uid() }, f.profile, id)).rejects.toMatchObject({ status: 404 });
});

it("P1: UUID original e IDs hex/routine usam representação determinística com perfil e namespace", async () => {
  const original = uid();
  expect(await customerRpcCommandId("p", "team", original)).toBe(original);
  for (const value of ["a".repeat(32), "routine:pedido:123"]) {
    const hash = await sha(JSON.stringify(["wabotia-customer-command-v1", "p", "team", value]));
    const result = await customerRpcCommandId("p", "team", value);
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.slice(0, 8)).toBe(hash.slice(0, 8));
    expect(await customerRpcCommandId("p", "team", value)).toBe(result);
    expect(await customerRpcCommandId("q", "team", value)).not.toBe(result);
  }
  expect(() => dataOf({ phones: ["5511999990000", "5511999990001", "5511999990002"] })).toThrow();
  const f = await fixture(), id = await contact(f); await setModule(f.profile, "erp", true, f.admin.id);
  await expect(enrichLocal(env, f.admin, f.profile, id, input({ patch: { phones: ["5511999990000", "5511999990001", "5511999990002"] } }))).rejects.toMatchObject({ code: "invalid_customer_patch" });
  await expect(bindFromErp(env, f.admin, f.profile, "ID inválido", uid())).rejects.toMatchObject({ code: "invalid_request" });
  expect(await all(env, "SELECT id FROM customer_jobs WHERE profile_id=?", f.profile)).toEqual([]);
});

it("P2/F4/E8: associação exclusivamente ERP é durável, autorizada no domínio e não concede agenda/notas", async () => {
  const f = await fixture(); await setModule(f.profile, "erp", true, f.admin.id);
  const saved = await remote(f);
  const reader: Actor = { ...f.member, access: ["erp:consulta"] };
  await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(reader.access), reader.id);
  const read = vi.spyOn(erpBridge, "read"), apply = vi.spyOn(erpBridge, "apply");
  const a = await bindFromErp(serial(f), reader, f.profile, saved.id, uid());
  const b = await bindFromErp(serial(f), reader, f.profile, saved.id, uid());
  expect(a.pending).toBe(true); expect(read).not.toHaveBeenCalled();
  await run(f, a.jobId!); await run(f, b.jobId!);
  expect(await all(env, "SELECT id FROM contacts WHERE profile_id=? AND erp_contact_id=?", f.profile, saved.id)).toHaveLength(1);
  const first = await readJob(env, reader, f.profile, a.jobId!), second = await readJob(env, reader, f.profile, b.jobId!);
  expect(first.state).toBe("done"); expect(second.contactId).toBe(first.contactId);
  expect(apply).not.toHaveBeenCalled();
  await expect(getContact(env, reader, f.profile, first.contactId!)).rejects.toMatchObject({ status: 403 });
  await expect(listContacts(env, reader, f.profile, {})).rejects.toMatchObject({ status: 403 });
  await expect(enrichLocal(env, reader, f.profile, first.contactId!, input({ patch: { name: "Sem escrita" } }))).rejects.toMatchObject({ status: 403 });
  read.mockRejectedValueOnce(new Error("registro fora da carteira"));
  await expect(readJob(env, reader, f.profile, a.jobId!)).rejects.toThrow("fora da carteira");
});

it("P2: apply direto associa sem D1 prévio e não cria pessoa ERP adicional", async () => {
  const f = await fixture(); await setModule(f.profile, "erp", true, f.admin.id);
  const saved = await remote(f), id = uid(), request = command(f, id, { operation: "bind", erpId: saved.id });
  expect(await customerErpBridge.apply(env, request)).toMatchObject({ status: "applied" });
  expect(await customerErpBridge.apply(env, request)).toMatchObject({ status: "applied", replayed: true });
  expect(await row(id)).toMatchObject({ erp_contact_id: saved.id, email: saved.email });
});

it("P3/E8: comando serializado retorna pendente; empresa/notas, espelho e recibo têm conclusão única", async () => {
  const f = await fixture(), id = await contact(f); await setModule(f.profile, "erp", true, f.admin.id);
  const apply = vi.spyOn(erpBridge, "apply"), read = vi.spyOn(erpBridge, "read");
  const result = await contactCommand(serial(f), f.admin, f.profile, "contact.update", { id, expected_version: 1, name: "Ana Maria", company: "Empresa nova", notes: "Nota nova" });
  expect(result.result).toMatchObject({ pending: true, state: "pending" });
  expect(apply).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  await run(f, result.result.jobId);
  const final = await row(id), receipt = await job(result.result.jobId);
  expect(final).toMatchObject({ version: 2, name: "Ana Maria", company: "Empresa nova", notes: "Nota nova", erp_version: 1 });
  expect(receipt).toMatchObject({ state: "done", payload_cipher: null });
  expect(await unseal(env, receipt.result_cipher)).toEqual({ contactId: id, version: 2 });
  await run(f, receipt.id); expect((await row(id)).version).toBe(2);
});

for (const stage of ["before", "after"] as const) it(`P1/P4: retoma formato da ponte após queda ${stage}, preservando comando e corpo enviados`, async () => {
  const f = await fixture(), id = await contact(f); await setModule(f.profile, "erp", true, f.admin.id);
  const request = command(f, id, { commandId: stage === "before" ? "a".repeat(32) : `routine:${uid()}` });
  const transport = interrupted(stage);
  await expect(customerErpBridge.apply(transport.env, request)).rejects.toThrow();
  const pending = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", f.profile, request.commandId);
  const before = JSON.parse(pending.cursor_json).customerErp;
  expect(pending.payload_cipher).toBeNull(); expect(before.intent).toBeTruthy(); expect(before.sent).toBe(true);
  expect(before.rpcCommandId).toBe(await customerRpcCommandId(f.profile, "team", request.commandId));
  await run(f, pending.id, transport.env);
  expect((await job(pending.id)).state).toBe("done");
  expect(transport.saves).toHaveLength(2);
  expect(transport.saves[1]).toEqual(transport.saves[0]);
  expect((await job(pending.id)).command_id).toBe(request.commandId);
  expect((await row(id)).version).toBe(2);
  expect(await unseal(env, (await job(pending.id)).result_cipher)).toEqual({ contactId: id, version: 2 });
}, 120_000);

it("P4/P3: formato do executor conserva metadados e campos locais durante recuperação da ponte antiga", async () => {
  const f = await fixture(), id = await contact(f); await setModule(f.profile, "erp", true, f.admin.id);
  const transport = interrupted("after");
  const queued = await contactCommand(serial(f), f.admin, f.profile, "contact.update", { id, expected_version: 1, name: "Nome novo", company: "Outra", notes: "Preservar" });
  await run(f, queued.result.jobId, transport.env);
  const pending = await job(queued.result.jobId), cursor = JSON.parse(pending.cursor_json);
  expect(pending.payload_cipher).not.toBeNull(); expect(cursor.customerErp.intent).toBeTruthy();
  // Jobs UUID anteriores não tinham a representação RPC persistida.
  delete cursor.customerErp.rpcCommandId;
  cursor.outraEtapa = { checkpoint: 7 };
  await exec(env, "UPDATE customer_jobs SET cursor_json=? WHERE id=?", JSON.stringify(cursor), pending.id);
  await run(f, pending.id, transport.env);
  expect(await row(id)).toMatchObject({ company: "Outra", notes: "Preservar", version: 2 });
  const complete = await job(pending.id);
  expect(complete.state).toBe("done"); expect(complete.payload_cipher).toBeNull();
  expect(JSON.parse(complete.cursor_json).outraEtapa).toEqual({ checkpoint: 7 });
  expect(transport.saves[1]).toEqual(transport.saves[0]);
}, 120_000);

it("P8: versão remota nova concilia campo independente e mantém conflito no mesmo campo", async () => {
  const f = await fixture(), id = await contact(f); await setModule(f.profile, "erp", true, f.admin.id);
  const initial = await customerErpBridge.apply(env, command(f, id));
  if (initial.status !== "applied") throw Error("Promoção não concluída");
  const identity = await erpIdentity(env, f.admin, f.profile, "POST");
  await customerRpc(env, f.profile, f.admin, identity, "erp_catalog_contact_save", { p_id: initial.snapshot.erpId, p_expected_version: 1, p_command_id: uid(), p_data: { name: "Nome remoto" }, p_acknowledged: [] });
  const independent = await enrichLocal(env, f.admin, f.profile, id, input({ expectedVersion: 2, expectedErpVersion: 1, patch: { email: "a@example.com" } }));
  expect(independent.state).toBe("done");
  expect(await row(id)).toMatchObject({ name: "Nome remoto", email: "a@example.com", erp_version: 3 });
  await customerRpc(env, f.profile, f.admin, identity, "erp_catalog_contact_save", { p_id: initial.snapshot.erpId, p_expected_version: 3, p_command_id: uid(), p_data: { email: "remoto@example.com" }, p_acknowledged: [] });
  const conflicting = await enrichLocal(env, f.admin, f.profile, id, input({ expectedVersion: 3, expectedErpVersion: 3, patch: { email: "local@example.com" } }));
  expect(conflicting.state).toBe("conflict");
  expect(await readJob(env, f.admin, f.profile, conflicting.jobId!)).toMatchObject({ missingFields: ["email"] });
}, 120_000);

it("P7/P8: duas edições offline mantêm sequência e reconciliam mudança remota independente", async () => {
  const f = await fixture(), id = await contact(f);
  const base = { name: "Ana", phones: [], email: "", document: null, personType: null };
  await exec(env, "UPDATE contacts SET erp_contact_id=?,erp_version=1,mirror_json=? WHERE id=?", uid(), JSON.stringify(base), id);
  const first = await enrichLocal(env, f.admin, f.profile, id, input({ expectedErpVersion: 1, patch: { email: "ana@example.com" } }));
  const second = await enrichLocal(env, f.admin, f.profile, id, input({ expectedVersion: 2, expectedErpVersion: 1, patch: { name: "Ana local" } }));
  expect(await row(id)).toMatchObject({ version: 3, name: "Ana local", email: "ana@example.com" });
  const local = await unseal(env, (await row(id)).local_patch_cipher);
  expect(local).toMatchObject({ base, jobs: [first.jobId, second.jobId], patch: { name: "Ana local", email: "ana@example.com" } });
  await setModule(f.profile, "erp", true, f.admin.id);
  const erpId = (await row(id)).erp_contact_id;
  vi.spyOn(erpBridge, "read").mockResolvedValue({ erpId, erpVersion: 2, mirror: { ...base, document: "123" } });
  const apply = vi.spyOn(erpBridge, "apply").mockResolvedValue({ status: "applied", replayed: false, snapshot: { erpId, erpVersion: 3, mirror: { ...base, ...local.patch, document: "123" } } });
  await run(f, first.jobId!);
  expect(apply.mock.calls[0][1]).toMatchObject({ baseErpVersion: 1, expectedErpVersion: 2, expectedVersion: 3 });
  expect((await job(first.jobId!)).state).toBe("done"); expect((await job(second.jobId!)).state).toBe("done");
  expect(await row(id)).toMatchObject({ name: "Ana local", email: "ana@example.com", document: "123", local_patch_cipher: null });
});

it("P5: cancelamento usa CAS, motivo auditado e libera sucessor; envio desconhecido exige conciliação", async () => {
  const f = await fixture(), id = await contact(f);
  const first = await enrichLocal(env, f.admin, f.profile, id, input({ mode: "fill_empty", patch: { name: "Conflito" } }));
  const blocked = await job(first.jobId!);
  const second = await enrichLocal(env, f.admin, f.profile, id, input({ patch: { email: "b@example.com" } }));
  const data = { expectedUpdated: blocked.updated, expectedVersion: 1, reason: "Corrigir conteúdo" }, key = uid();
  await expect(cancelCustomerJob(env, f.admin, f.profile, blocked.id, { ...data, expectedUpdated: 0 }, key)).rejects.toMatchObject({ code: "contact_conflict" });
  const cancelled = await cancelCustomerJob(env, f.admin, f.profile, blocked.id, data, key);
  expect(cancelled).toMatchObject({ state: "cancelled", reason: data.reason });
  expect(await cancelCustomerJob(env, f.admin, f.profile, blocked.id, data, key)).toEqual(cancelled);
  await run(f, second.jobId!); expect((await row(id)).email).toBe("b@example.com");
  const unknown = jobInsert(f.profile, "team", id, "promote", uid(), uid(), await seal(env, {}), 2, null);
  await batch(env, [unknown.statement]);
  await exec(env, "UPDATE customer_jobs SET cursor_json=?,state='pending' WHERE id=?", JSON.stringify({ customerErp: { sent: true, intent: "preservar" } }), unknown.id);
  await expect(cancelCustomerJob(env, f.admin, f.profile, unknown.id, { ...data, expectedUpdated: (await job(unknown.id)).updated, expectedVersion: 2 }, uid())).rejects.toMatchObject({ code: "sync_pending" });
  expect(await one(env, "SELECT 1 FROM audit WHERE profile_id=? AND operation='contact.job-cancel'", f.profile)).not.toBeNull();
});

it("P13/P17: espelho conserva e-mails múltiplos; edição simples valida campos alterados e nome manual vazio é recusado antes da intenção", async () => {
  const f = await fixture(), email = "a@example.com; B@example.com", id = await contact(f, { email });
  const mirror = { name: "Ana", phones: [], email, document: null, personType: null };
  expect(cleanMirror(mirror).email).toBe(email);
  expect(contactChanges({ notes: "Anotação" })).toEqual({ notes: "Anotação" });
  await contactCommand(env, f.admin, f.profile, "contact.update", { id, expected_version: 1, company: "Nova empresa" });
  expect(await row(id)).toMatchObject({ company: "Nova empresa", email });
  const before = await all(env, "SELECT id FROM customer_jobs WHERE contact_id=?", id);
  await expect(enrichLocal(env, f.admin, f.profile, id, input({ expectedVersion: 2, patch: { name: "" } }))).rejects.toMatchObject({ code: "invalid_customer_patch" });
  expect(await all(env, "SELECT id FROM customer_jobs WHERE contact_id=?", id)).toEqual(before);
  const automatic = await contact(f, { name: "", phone: "5511999990000", source: "automatic" });
  expect(await enrichLocal(env, f.admin, f.profile, automatic, input({ patch: { email: "a@example.com" } }))).toMatchObject({ state: "done" });
});

it("P15: exigências antigas e atuais são traduzidas sem perder motivo/updated", () => {
  const fields = ["postal_code", "person_type", "mobile", "name", "segredo"];
  for (const cursor of [{ customerErp: { result: { status: "needs_data", fields } } }, { missingFields: fields }]) {
    expect(jobView({ id: "j", contact_id: "c", state: "paused", updated: 12, error_code: "contact_required", cursor_json: JSON.stringify({ ...cursor, reason: "Complete o endereço" }) })).toMatchObject({ reason: "Complete o endereço", updated: 12, missingFields: ["address.postalCode", "personType", "phones", "name"] });
  }
});

it("P4/P15: executor retoma ponte sem payload e preserva exigências e metadados de outra etapa", async () => {
  const f = await fixture(), id = await contact(f), request = command(f, id);
  const cursor = { reason: "Falta endereço", other: { checkpoint: 4 }, customerErp: { fingerprint: "fp", result: { status: "needs_data", fields: ["postal_code"] },
    intent: await seal(env, { command: request, fingerprint: "fp", data: { name: "Ana" }, source: { version: 1, localPatch: null } }) } };
  const pending = jobInsert(f.profile, "team", id, "promote", request.commandId, request.requestHash, null, 1, null, uid(), cursor);
  await batch(env, [pending.statement]);
  await run(f, pending.id);
  expect(await readJob(env, f.admin, f.profile, pending.id)).toMatchObject({ state: "paused", errorCode: "module_disabled", reason: "Falta endereço", missingFields: ["address.postalCode"] });
  const persisted = JSON.parse((await job(pending.id)).cursor_json);
  expect(persisted.other).toEqual(cursor.other);
  expect(persisted.customerErp.intent).toBe(cursor.customerErp.intent);
  expect(persisted.customerErp.result).toEqual(cursor.customerErp.result);
});

it("P16: limite por contato gera recusa estável e recibos terminais não conservam snapshots", async () => {
  const f = await fixture(), id = await contact(f);
  for (let i = 0; i < CUSTOMER_QUEUE_LIMIT; i++) {
    const pending = jobInsert(f.profile, "team", id, "enrich", uid(), uid(), await seal(env, {}), 1, null);
    await batch(env, [pending.statement]);
  }
  const request = input({ patch: { name: "Novo" } });
  await expect(enrichLocal(env, f.admin, f.profile, id, request)).rejects.toMatchObject({ code: "customer_queue_full" });
  await exec(env, "UPDATE customer_jobs SET state='cancelled',payload_cipher=NULL WHERE contact_id=? AND error_code IS NULL", id);
  await expect(enrichLocal(env, f.admin, f.profile, id, request)).rejects.toMatchObject({ code: "customer_queue_full" });
  const result = await enrichLocal(env, f.admin, f.profile, id, input({ patch: { name: "Corrigido" } }));
  const receipt = await job(result.jobId!);
  expect(receipt.payload_cipher).toBeNull();
  expect(await unseal(env, receipt.result_cipher)).toEqual({ contactId: id, version: 2 });
});

it("P16: compacta recibo legado conservando chave, hash, versão e motivo", async () => {
  const f = await fixture(), id = await contact(f), key = uid(), hash = uid();
  const old = jobInsert(f.profile, "team", id, "promote", key, hash, await seal(env, { address: "Descartar" }), 1, null);
  await batch(env, [old.statement]);
  await exec(env, "UPDATE customer_jobs SET state='done',result_cipher=?,cursor_json=? WHERE id=?", await seal(env, { contactId: id, version: 2, snapshot: { mirror: { name: "Snapshot pessoal" } } }), JSON.stringify({ reason: "Motivo administrativo", customerErp: { fingerprint: hash, intent: "Descartar", done: true } }), old.id);
  const result = await maintainJobs(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
  expect(result.statements).toBeLessThanOrEqual(40);
  const compacted = await job(old.id);
  expect(compacted).toMatchObject({ command_id: key, request_hash: hash, payload_cipher: null, state: "done" });
  expect(await unseal(env, compacted.result_cipher)).toEqual({ contactId: id, version: 2 });
  expect(JSON.parse(compacted.cursor_json)).toMatchObject({ reason: "Motivo administrativo", customerErp: { fingerprint: hash, done: true } });
  expect(compacted.cursor_json).not.toContain("Descartar");
});

it("P9: valida 500 linhas antes de iniciar e retoma importação com orçamento e deduplicação por linha", async () => {
  const f = await fixture(), key = uid();
  const csv = "nome;telefone\n" + Array.from({ length: 500 }, (_, i) => `Pessoa ${i};55119${String(i).padStart(8, "0")}`).join("\n");
  expect(parseContactCsv(csv).rows).toHaveLength(500);
  await expect(contactCommand(env, f.admin, f.profile, "contact.import", { csv: csv + "\n;inválido" })).rejects.toThrow();
  expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
  let fail = true;
  const DB = new Proxy(env.DB, { get(target, prop) {
    if (prop === "batch") return (statements: D1PreparedStatement[]) => {
      if (fail && statements.length > 1) { fail = false; throw Error("Lote interrompido"); }
      return target.batch(statements);
    };
    const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
  } });
  const started = await contactCommand({ ...env, DB }, f.admin, f.profile, "contact.import", { csv }, key);
  expect(started).toMatchObject({ pending: true, imported: 0, total: 500 });
  const tiny = await maintainJobs(env, f.profile, { remainingStatements: 2, remainingItems: 20 });
  expect(tiny.statements).toBeLessThanOrEqual(2);
  for (let i = 0; i < 505 && (await job(started.jobId)).state !== "done"; i++) {
    const measured = countingEnv(env);
    const result = await maintainJobs(measured.env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    expect(result.statements).toBe(measured.count.statements);
    expect(result.statements).toBeLessThanOrEqual(40); expect(result.items).toBeLessThanOrEqual(20);
    if (i === 2) expect(await contactCommand(env, f.admin, f.profile, "contact.import", { csv }, key)).toMatchObject({ pending: true, imported: 3 });
  }
  expect(await contactCommand(env, f.admin, f.profile, "contact.import", { csv }, key)).toEqual({ imported: 500, skipped: 0, total: 500 });
  expect((await one(env, "SELECT count(*) n FROM contacts WHERE profile_id=?", f.profile)).n).toBe(500);
  expect((await job(started.jobId)).payload_cipher).toBeNull();
}, 120_000);

it("P9: importação publicada de 500 linhas continua atômica e usa no máximo 40 instruções", async () => {
  const f = await fixture(), csv = "nome;telefone\n" + Array.from({ length: 500 }, (_, i) => `Pessoa ${i};5511999990000`).join("\n");
  const measured = countingEnv(env);
  expect(await contactCommand(measured.env, f.admin, f.profile, "contact.import", { csv })).toEqual({ imported: 500, skipped: 0, total: 500 });
  expect(measured.count.statements).toBeLessThanOrEqual(40);
  expect(await contactCommand(env, f.admin, f.profile, "contact.import", { csv })).toEqual({ imported: 0, skipped: 500, total: 500 });
  expect((await one(env, "SELECT state FROM customer_phones WHERE profile_id=?", f.profile)).state).toBe("ambiguous");
});

it("P9: falha da porta de índice desfaz toda a importação e conserva conflito repetível sem retomada parcial", async () => {
  const f = await fixture(), key = uid(), csv = "nome;telefone\nBia;5511988887777\nCaio;5511988887776";
  const index = vi.spyOn(identityPort, "indexContact")
    .mockImplementationOnce(customerIdentity.indexContact)
    .mockResolvedValueOnce([["INSERT INTO customer_assert(id,ok) VALUES('cadastro-import-failure',0)", []]]);
  await expect(contactCommand(env, f.admin, f.profile, "contact.import", { csv }, key)).rejects.toMatchObject({ code: "contact_conflict" });
  expect(index).toHaveBeenCalledTimes(2);
  expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
  expect(await all(env, "SELECT contact_id FROM customer_phone_candidates WHERE profile_id=?", f.profile)).toEqual([]);
  expect(await all(env, "SELECT phone FROM customer_phones WHERE profile_id=?", f.profile)).toEqual([]);
  const failed = await one(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", f.profile, key);
  expect(failed.payload_cipher).not.toBeNull();
  expect(await readJob(env, f.admin, f.profile, failed.id)).toMatchObject({ state: "conflict", errorCode: "contact_conflict", progress: { imported: 0, processed: 0, total: 2 } });
  await maintainJobs(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
  await expect(contactCommand(env, f.admin, f.profile, "contact.import", { csv }, key)).rejects.toMatchObject({ code: "contact_conflict" });
  expect(index).toHaveBeenCalledTimes(2);
  expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
  await cancelCustomerJob(env, f.admin, f.profile, failed.id, { expectedUpdated: failed.updated, expectedVersion: 1, reason: "Corrigir importação rejeitada" }, uid());
  expect(await contactCommand(env, f.admin, f.profile, "contact.import", { csv }, uid())).toEqual({ imported: 2, skipped: 0, total: 2 });
  expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toHaveLength(2);
});

it("P9: lote pequeno usa a porta de índice e conserva orçamento, procedência local e replay", async () => {
  const f = await fixture(), key = uid();
  const csv = "nome;telefone\n" + Array.from({ length: 4 }, (_, i) => `Pessoa ${i};551198888777${i}`).join("\n");
  const index = vi.spyOn(identityPort, "indexContact"), measured = countingEnv(env);
  expect(await contactCommand(measured.env, f.admin, f.profile, "contact.import", { csv }, key)).toEqual({ imported: 4, skipped: 0, total: 4 });
  expect(index).toHaveBeenCalledTimes(4);
  expect(measured.count.statements).toBeLessThanOrEqual(40);
  expect(await all(env, "SELECT DISTINCT origin FROM customer_phone_candidates WHERE profile_id=?", f.profile)).toEqual([{ origin: "local" }]);
  expect(await all(env, "SELECT DISTINCT state,contact_id FROM customer_phones WHERE profile_id=?", f.profile)).toEqual([{ state: "pending", contact_id: null }]);
  expect(await contactCommand(env, f.admin, f.profile, "contact.import", { csv }, key)).toEqual({ imported: 4, skipped: 0, total: 4 });
  expect(index).toHaveBeenCalledTimes(4);
});

it("P15: exclusão inicial e repetida devolvem a mesma projeção persistida com motivo e updated", async () => {
  const f = await fixture(), id = await contact(f), key = uid();
  const commandId = (await sha(`${f.admin.id}:${f.profile}:contact.erasure\n${key}`)).slice(0, 32);
  const data = { expectedVersion: 1, reason: "Solicitação do titular", confirm: true };
  const result = await eraseContact(env, f.admin, f.profile, id, data, commandId);
  expect(result).toMatchObject({ contactId: id, state: "retained", errorCode: "retention_inventory_incomplete", reason: "retention_inventory_incomplete", missingFields: [], updated: expect.any(Number) });
  expect(result).toEqual(jobView(await job(result.id)));
  expect(await eraseContact(env, f.admin, f.profile, id, data, commandId)).toEqual(result);
  expect(await eraseContact(env, f.admin, f.profile, id, data, uid())).toEqual(result);
  expect(await readJob(env, f.admin, f.profile, result.id)).toEqual(result);
  expect(await recoverContactCommand(env, f.admin, f.profile, "contact.erasure", key)).toEqual(result);
  expect(await all(env, "SELECT id FROM customer_jobs WHERE profile_id=? AND kind='erase'", f.profile)).toHaveLength(1);
  await expect(getContact(env, f.admin, f.profile, id)).rejects.toMatchObject({ code: "not_found" });
  await expect(eraseContact(env, f.admin, f.profile, id, { ...data, reason: "Outro corpo" }, commandId)).rejects.toMatchObject({ code: "idempotency_conflict" });
});

it("P10: marcas novas conservam checkpoint e varredura processa página com progresso limitado", async () => {
  const f = await fixture(); await setModule(f.profile, "erp", true, f.admin.id);
  await markCustomerReconciliation(env, f.profile);
  const after = uid();
  await exec(env, "UPDATE customer_progress SET cursor_json=json_set(cursor_json,'$.after',?) WHERE profile_id=? AND task=?", after, f.profile, SCAN_TASK);
  await markCustomerReconciliation(env, f.profile);
  expect(JSON.parse((await one(env, "SELECT cursor_json FROM customer_progress WHERE profile_id=? AND task=?", f.profile, SCAN_TASK)).cursor_json)).toMatchObject({ after, again: 1 });
  const snapshots: BridgeSnapshot[] = Array.from({ length: 12 }, () => ({ erpId: uid(), erpVersion: 1, mirror: { name: "Sem vínculo", phones: [], email: "", document: null, personType: null } }));
  const scan = vi.spyOn(erpBridge, "scan").mockResolvedValue({ items: snapshots, nextCursor: null });
  const measured = countingEnv(env);
  const result = await maintainErpCustomers(measured.env, f.profile, { remainingStatements: 40, remainingItems: 20 });
  expect(scan.mock.calls[0][3]).toBeGreaterThan(1);
  expect(result.items).toBeGreaterThan(1); expect(result.statements).toBeLessThanOrEqual(40);
  expect(result.statements).toBe(measured.count.statements);
  const progress = JSON.parse((await one(env, "SELECT cursor_json FROM customer_progress WHERE profile_id=? AND task=?", f.profile, SCAN_TASK)).cursor_json);
  expect(progress.after).not.toBe(after);
});

it("P10: falha de um espelho avança checkpoint e agenda outra passagem", async () => {
  const f = await fixture(), id = await contact(f); await setModule(f.profile, "erp", true, f.admin.id);
  const erpId = uid(), next = uid(), mirror = { name: "Ana", phones: [], email: "", document: null, personType: null };
  await exec(env, "UPDATE contacts SET erp_contact_id=?,erp_version=1,mirror_json=? WHERE id=?", erpId, JSON.stringify(mirror), id);
  await markCustomerReconciliation(env, f.profile);
  vi.spyOn(erpBridge, "scan").mockResolvedValue({ items: [{ erpId, erpVersion: 2, mirror: { ...mirror, email: "inválido" } }, { erpId: next, erpVersion: 1, mirror }], nextCursor: next });
  const result = await maintainErpCustomers(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
  expect(result.items).toBe(2);
  const state = JSON.parse((await one(env, "SELECT cursor_json FROM customer_progress WHERE profile_id=? AND task=?", f.profile, SCAN_TASK)).cursor_json);
  expect(state).toMatchObject({ after: next, again: 1 });
  expect((await row(id)).erp_version).toBe(1);
});

it("F4: autorização específica passa pela porta da contribuição sem abrir cadastro geral", async () => {
  const f = await fixture(), id = await contact(f);
  const { profilePort } = await import("../src/customer/ports");
  const actor = { ...f.member, access: ["condominio:admin"] };
  const view = vi.spyOn(profilePort, "view").mockResolvedValue({ profileId: f.profile, contactId: id } as any);
  expect(await customerRead(env, actor, f.profile, id, "profile", {})).toMatchObject({ contactId: id });
  expect(view).toHaveBeenCalledWith(env, actor, f.profile, id);
  await expect(getContact(env, actor, f.profile, id)).rejects.toMatchObject({ status: 403 });
  const section = vi.spyOn(profilePort, "section").mockResolvedValue({ version: 1, writable: false, schema: "condominio.units.v1", data: null });
  const saved = jobInsert(f.profile, "team", id, "section", uid(), uid(), null, 1, null, `cond-units:${uid()}`);
  await batch(env, [saved.statement]);
  await exec(env, "UPDATE customer_jobs SET state='done' WHERE id=?", saved.id);
  expect(await readJob(env, actor, f.profile, saved.id)).toMatchObject({ state: "done" });
  expect(section).toHaveBeenCalledWith(env, actor, f.profile, id, "condominio", "units");
  section.mockRejectedValueOnce(new Error("Registro fora do domínio"));
  await expect(readJob(env, actor, f.profile, saved.id)).rejects.toThrow("fora do domínio");
});
