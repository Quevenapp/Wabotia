import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { all, batch, exec, one, withReadCache } from "../src/db";
import { defaults, now, uid, type Actor } from "../src/types";
import { seal, unseal, sha } from "../src/security";
import type { CustomerErpBridge, CustomerMirror, CustomerWrite, IdentityPort, Statement } from "../src/customer/contracts";
import { installErpBridge, installIdentityPort, writePort } from "../src/customer/ports";
import { contactCommand, getContact, listContacts, publicContact, recoverContactCommand } from "../src/contacts";
import { enrichLocal, jobInsert, maintainJobs, processJob, readJob, requestHash } from "../src/customer/jobs";
import { customerResponse, eraseContact, resolvePhone, customerRead } from "../src/customer/http";
import { guard, guardedBatch, reconcilePatch } from "../src/customer/local";
import { contactValues } from "../src/contact-csv";
import { isFullCustomerEnabled } from "../src/customer/feature";
import { setModule } from "./erp-module-helper";

// As dependências paralelas são simuladas só pelas portas da base.
vi.mock("../src/modules/runtime", () => ({}));
const index = vi.fn<IdentityPort["indexContact"]>(async (_env, input) => {
  const { profileId: p, namespace: ns, contactId: id, phones } = input;
  const statements: Statement[] = [["DELETE FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND contact_id=?", [p, ns, id]]];
  for (const phone of phones) statements.push(
    ["INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin) VALUES(?,?,?,?,?)", [p, ns, phone, id, input.origin]],
    ["INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) SELECT ?,?,?,CASE WHEN count(*)=1 THEN min(contact_id) ELSE NULL END,CASE WHEN count(*)=1 THEN 'ready' ELSE 'ambiguous' END FROM customer_phone_candidates WHERE profile_id=? AND namespace=? AND phone=? ON CONFLICT(profile_id,namespace,phone) DO UPDATE SET contact_id=excluded.contact_id,state=excluded.state,version=customer_phones.version+1", [p, ns, phone, p, ns, phone]],
  );
  return statements;
});
installIdentityPort({ indexContact: index, resolve: async () => { throw Error("Não solicitado"); }, prepareInbound: async () => { throw Error("Não solicitado"); }, maintain: async () => ({ pending: false, statements: 0, items: 0 }) });
const remote: CustomerMirror = { name: "Ana", phones: ["5511987654321"], email: "", document: null, personType: null };
const apply = vi.fn<CustomerErpBridge["apply"]>();
const read = vi.fn<CustomerErpBridge["read"]>();
installErpBridge({ apply, read, scan: async () => ({ items: [], nextCursor: null }) });
beforeEach(() => {
  index.mockClear(); apply.mockReset(); read.mockReset();
  read.mockResolvedValue({ erpId: "erp-1", erpVersion: 1, mirror: remote });
  apply.mockResolvedValue({ status: "applied", snapshot: { erpId: "erp-1", erpVersion: 2, mirror: remote }, replayed: false });
});
async function fixture(linked = false) {
  const profile = uid(), id = uid();
  const actor: Actor = { id: uid(), kind: "user", name: "Atendente", role: "admin", profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 1 };
  await exec(env, "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)", profile, "Cadastro", JSON.stringify(defaults), now());
  await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,phone,email,search_text,source,created_by,updated_by,created,updated,erp_contact_id,erp_version,mirror_json) VALUES(?,?,'team',?,?,?,'ana','automatic',?,?,?,?,?,?,?)", id, profile, linked ? "Ana" : "", remote.phones[0], "", actor.id, actor.id, now(), now(), linked ? "erp-1" : null, linked ? 1 : null, linked ? JSON.stringify(remote) : null);
  await batch(env, await index(env, { profileId: profile, namespace: "team", contactId: id, phones: remote.phones, origin: "observed" }));
  return { profile, id, actor };
}
// A ativação é configuração persistida da área, não uma dependência da ponte.
// Usar o D1 real evita que o grafo de importação do Worker ignore um mock de módulo.
async function setFullCustomer(f: { profile: string; actor: Actor }, enabled: boolean) {
  await setModule(f.profile, "erp", enabled, f.actor.id);
  expect(await isFullCustomerEnabled(env, f.profile)).toBe(enabled);
}
const write = (extra: Partial<CustomerWrite> = {}): CustomerWrite => ({ commandId: uid(), expectedVersion: 1, expectedErpVersion: null, mode: "fill_empty", patch: { name: "Ana" }, ...extra });
it("registra WritePort e conclui preenchimento local sem acordar o ERP", async () => {
  const f = await fixture();
  const result = await writePort.enrich(env, f.actor, f.profile, f.id, write());
  expect(result).toMatchObject({ contactId: f.id, version: 2, state: "done", pending: false });
  expect(await getContact(env, f.actor, f.profile, f.id)).toMatchObject({ name: "Ana", version: 2 });
  expect(apply).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("CAS concorrente grava uma versão; o guardião desfaz todo o lote perdedor", async () => {
  const f = await fixture();
  const patch = (name: string) => guardedBatch(env, [
    ["UPDATE contacts SET name=?,version=version+1 WHERE profile_id=? AND id=? AND version=1", [name, f.profile, f.id]],
    ...guard(name, "race"),
    ["UPDATE contacts SET company=? WHERE profile_id=? AND id=?", [name, f.profile, f.id]],
  ]);
  const results = await Promise.allSettled([patch("Primeiro"), patch("Segundo")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const row = await one(env, "SELECT * FROM contacts WHERE id=?", f.id);
  expect(row.version).toBe(2); expect(row.company).toBe(row.name);
  expect(await all(env, "SELECT * FROM customer_assert")).toEqual([]);
});
it("mesmo comando é repetível; corpo ou ator diferente não usa o recibo", async () => {
  const f = await fixture(), input = write();
  const first = await enrichLocal(env, f.actor, f.profile, f.id, input);
  expect(await enrichLocal(env, f.actor, f.profile, f.id, input)).toEqual(first);
  await expect(enrichLocal(env, f.actor, f.profile, f.id, { ...input, patch: { name: "Bia" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(enrichLocal(env, { ...f.actor, id: uid() }, f.profile, f.id, input)).rejects.toMatchObject({ code: "idempotency_conflict" });
});
it("retoma interrupção após persistir intenção e lease vencida", async () => {
  const f = await fixture(), input = write();
  const job = jobInsert(f.profile, "team", f.id, "enrich", input.commandId,
    await requestHash(f.actor, { id: f.id, operation: "enrich", input, local: null }),
    await seal(env, { actor: f.actor, input, base: { ...remote, name: "" }, operation: "enrich" }), 1, null);
  await batch(env, [job.statement]);
  await exec(env, "UPDATE customer_jobs SET state='running',lease_until=?,attempts=1 WHERE profile_id=? AND id=?", now() - 1, f.profile, job.id);
  const maintenance = await maintainJobs(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
  expect(maintenance.statements).toBeLessThanOrEqual(40);
  expect(maintenance.items).toBe(1);
  expect(await readJob(env, f.actor, f.profile, job.id)).toMatchObject({ state: "done" });
  expect((await getContact(env, f.actor, f.profile, f.id)).name).toBe("Ana");
});
it("fila pausada mantém vínculo, espelho anterior e alteração local; reativa por três versões", async () => {
  const f = await fixture(true);
  const input = write({ expectedErpVersion: 1, patch: { email: "ana@example.com" } });
  const result = await enrichLocal(env, f.actor, f.profile, f.id, input);
  expect(result).toMatchObject({ state: "paused", pending: true, version: 2 });
  const row = await one(env, "SELECT * FROM contacts WHERE id=?", f.id);
  expect(row.erp_contact_id).toBe("erp-1"); expect(JSON.parse(row.mirror_json).email).toBe("");
  expect(await unseal(env, row.local_patch_cipher)).toMatchObject({ patch: { email: "ana@example.com" } });
  expect(apply).not.toHaveBeenCalled();
  await setFullCustomer(f, true);
  read.mockResolvedValue({ erpId: "erp-1", erpVersion: 2, mirror: { ...remote, name: "Ana Maria" } });
  apply.mockResolvedValue({ status: "applied", snapshot: { erpId: "erp-1", erpVersion: 3, mirror: { ...remote, name: "Ana Maria", email: "ana@example.com" } }, replayed: false });
  await exec(env, "UPDATE customer_jobs SET retry_at=0 WHERE id=?", result.jobId);
  await processJob(env, f.profile, result.jobId!);
  expect(read).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0][1]).toMatchObject({ expectedErpVersion: 2, patch: { email: "ana@example.com" } });
  expect(await readJob(env, f.actor, f.profile, result.jobId!)).toMatchObject({ state: "done" });
  expect(await getContact(env, f.actor, f.profile, f.id)).toMatchObject({ name: "Ana Maria", email: "ana@example.com", erp_version: 3, version: 3 });
  expect((await one(env, "SELECT local_patch_cipher FROM contacts WHERE id=?", f.id)).local_patch_cipher).toBeNull();
});
it("divergência no mesmo campo gera conflito e bloqueia comandos posteriores", async () => {
  const f = await fixture(true);
  const first = await enrichLocal(env, f.actor, f.profile, f.id, write({ expectedErpVersion: 1, patch: { email: "local@example.com" } }));
  const second = await enrichLocal(env, f.actor, f.profile, f.id, write({ expectedVersion: 2, expectedErpVersion: 1, patch: { document: "123" } }));
  expect(second.state).toBe("pending");
  await setFullCustomer(f, true);
  read.mockResolvedValue({ erpId: "erp-1", erpVersion: 2, mirror: { ...remote, email: "remote@example.com" } });
  await exec(env, "UPDATE customer_jobs SET retry_at=0 WHERE profile_id=?", f.profile);
  await maintainJobs(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
  expect(await readJob(env, f.actor, f.profile, first.jobId!)).toMatchObject({ state: "conflict", missingFields: ["email"] });
  expect(await readJob(env, f.actor, f.profile, second.jobId!)).toMatchObject({ state: "pending" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
});
it("fill_empty divergente persiste revisão sem sobrescrever", async () => {
  const f = await fixture(true);
  const result = await enrichLocal(env, f.actor, f.profile, f.id, write({ expectedErpVersion: 1, patch: { name: "Outra" } }));
  expect(result).toMatchObject({ state: "conflict", pending: true });
  expect((await getContact(env, f.actor, f.profile, f.id)).name).toBe("Ana");
});
it("timeout repete comando e ator imutáveis; retorno atrasado não sobrescreve edição", async () => {
  const f = await fixture(true); await setFullCustomer(f, true);
  apply.mockRejectedValueOnce(new Error("timeout"));
  const result = await enrichLocal(env, f.actor, f.profile, f.id, write({ expectedErpVersion: 1, patch: { email: "ana@example.com" } }));
  expect(result).toMatchObject({ state: "pending", pending: true, version: 1 });
  expect(apply).toHaveBeenCalledTimes(1);
  const sent = structuredClone(apply.mock.calls[0][1]);
  await exec(env, "UPDATE customer_jobs SET retry_at=0 WHERE id=?", result.jobId);
  apply.mockImplementationOnce(async () => {
    await exec(env, "UPDATE contacts SET company='Edição local',version=version+1 WHERE id=?", f.id);
    return { status: "applied", snapshot: { erpId: "erp-1", erpVersion: 2, mirror: { ...remote, email: "ana@example.com" } }, replayed: true };
  });
  await processJob(env, f.profile, result.jobId!);
  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls[1][1]).toEqual(sent);
  expect(await readJob(env, f.actor, f.profile, result.jobId!)).toMatchObject({ state: "conflict" });
  expect(await getContact(env, f.actor, f.profile, f.id)).toMatchObject({ email: "", company: "Edição local" });
});
it("desligamento durante retorno ERP pausa sem confirmar o espelho", async () => {
  const f = await fixture(true); await setFullCustomer(f, true);
  const cachedEnv = withReadCache(env);
  expect(await isFullCustomerEnabled(cachedEnv, f.profile)).toBe(true);
  apply.mockImplementationOnce(async () => { await setFullCustomer(f, false); return { status: "applied", snapshot: { erpId: "erp-1", erpVersion: 2, mirror: remote }, replayed: false }; });
  const result = await enrichLocal(cachedEnv, f.actor, f.profile, f.id, write({ expectedErpVersion: 1, patch: {} }));
  expect(apply).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ state: "paused", pending: true });
  expect((await getContact(env, f.actor, f.profile, f.id)).erp_version).toBe(1);
});
it("desligamento após a leitura ERP impede a escrita mesmo com cache de ativação", async () => {
  const f = await fixture(true); await setFullCustomer(f, true);
  const cachedEnv = withReadCache(env);
  expect(await isFullCustomerEnabled(cachedEnv, f.profile)).toBe(true);
  read.mockImplementationOnce(async () => {
    await setFullCustomer(f, false);
    return { erpId: "erp-1", erpVersion: 1, mirror: remote };
  });
  const result = await enrichLocal(cachedEnv, f.actor, f.profile, f.id, write({ expectedErpVersion: 1, patch: { email: "ana@example.com" } }));
  expect(read).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
  expect(result).toMatchObject({ state: "paused", pending: true, version: 1 });
  expect(await readJob(env, f.actor, f.profile, result.jobId!)).toMatchObject({ state: "paused", errorCode: "module_disabled" });
  expect(await getContact(env, f.actor, f.profile, f.id)).toMatchObject({ email: "", erp_version: 1 });
});
it("resolução manual usa candidato e versão, audita, repete e não funde contatos", async () => {
  const f = await fixture();
  const other = await contactCommand(env, f.actor, f.profile, "contact.create", { name: "Outra pessoa", phone: remote.phones[0] });
  const phone = await one(env, "SELECT * FROM customer_phones WHERE profile_id=?", f.profile);
  const command = uid(), input = { namespace: "team", phone: remote.phones[0], expectedVersion: phone.version, contactId: other.id, reason: "Confirmação presencial" };
  const result = await resolvePhone(env, f.actor, f.profile, input, command);
  expect(await resolvePhone(env, f.actor, f.profile, input, command)).toEqual(result);
  await expect(resolvePhone(env, f.actor, f.profile, { ...input, contactId: f.id }, uid())).rejects.toMatchObject({ code: "contact_conflict" });
  expect((await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).length).toBe(2);
  expect(await one(env, "SELECT 1 present FROM audit WHERE profile_id=? AND operation='contact.resolve_phone'", f.profile)).not.toBeNull();
  await expect(resolvePhone(env, f.actor, f.profile, { ...input, contactId: uid() }, uid())).rejects.toMatchObject({ code: "not_found" });
});
it("exclusão repetida restringe leituras, cancela pendências e não ressuscita pelo ERP", async () => {
  const f = await fixture(true);
  const queued = await enrichLocal(env, f.actor, f.profile, f.id, write({ expectedErpVersion: 1, patch: { email: "ana@example.com" } }));
  const input = { expectedVersion: 2, reason: "Solicitação do titular", confirm: true }, command = uid();
  const result = await eraseContact(env, f.actor, f.profile, f.id, input, command);
  expect(result).toMatchObject({ state: "retained", errorCode: "retention_inventory_incomplete" });
  expect(await eraseContact(env, f.actor, f.profile, f.id, input, command)).toEqual(result);
  expect(await eraseContact(env, f.actor, f.profile, f.id, input, uid())).toEqual(result);
  await expect(getContact(env, f.actor, f.profile, f.id)).rejects.toMatchObject({ code: "not_found" });
  expect((await listContacts(env, f.actor, f.profile, {})).data).toEqual([]);
  await setFullCustomer(f, true);
  await processJob(env, f.profile, queued.jobId!);
  expect(apply).not.toHaveBeenCalled();
  await expect(contactCommand(env, f.actor, f.profile, "contact.create", { name: "Reconstrução", phone: remote.phones[0] })).rejects.toMatchObject({ code: "contact_conflict" });
  await expect(enrichLocal(env, f.actor, f.profile, f.id, write({ expectedVersion: 3, expectedErpVersion: 1 }))).rejects.toMatchObject({ code: "customer_erasing" });
  expect(await one(env, "SELECT 1 present FROM customer_phone_candidates WHERE contact_id=?", f.id)).not.toBeNull();
});
it("projeção não devolve cifras ou JSON interno e distingue contatos telefônicos", async () => {
  const f = await fixture();
  const projection = publicContact({ ...(await one(env, "SELECT * FROM contacts WHERE id=?", f.id)), local_patch_cipher: "segredo", mirror_json: "segredo", import_fingerprint: "segredo", search_text: "segredo", payload_cipher: "segredo" });
  expect(JSON.stringify(projection)).not.toContain("segredo");
  expect((await listContacts(env, f.actor, f.profile, {})).data).toHaveLength(1);
  expect((await listContacts(env, f.actor, f.profile, { identity: "identified" })).data).toHaveLength(0);
  expect((await listContacts(env, f.actor, f.profile, { identity: "phone_only" })).data).toHaveLength(1);
  expect(contactValues({ name: "Á".repeat(200) }).name).toHaveLength(200);
  expect(() => contactValues({ name: "", phone: remote.phones[0] })).toThrow();
  expect(contactValues({ name: "", phone: remote.phones[0] }, { phoneOnly: true }).name).toBe("");
  expect(() => contactValues({ name: "", phone: "pessoa12345678" }, { phoneOnly: true })).toThrow();
});
it("respostas pendentes não apresentam sucesso ERP e ficheiro exige pessoa", async () => {
  const response = await customerResponse(Response.json({ result: { pending: true, state: "paused" } }), "contact.update");
  expect(response.status).toBe(202);
  const f = await fixture();
  await expect(customerRead(env, { ...f.actor, kind: "app", scopes: ["contacts:read"] }, f.profile, f.id, "profile", {})).rejects.toMatchObject({ code: "forbidden" });
  expect(reconcilePatch(remote, { address: { city: "São Paulo" } }, remote).conflicts).toEqual(["address"]);
});
it("orçamento não envia lote acima do saldo e conserva a intenção para retomar", async () => {
  const f = await fixture(), input = write();
  const job = jobInsert(f.profile, "team", f.id, "enrich", input.commandId, "hash", await seal(env, { actor: f.actor, input, base: { ...remote, name: "" }, operation: "enrich" }), 1, null);
  await batch(env, [job.statement]);
  const result = await maintainJobs(env, f.profile, { remainingItems: 1, remainingStatements: 2 });
  expect(result.statements).toBeLessThanOrEqual(2); expect(result.pending).toBe(true);
  expect((await one(env, "SELECT * FROM contacts WHERE id=?", f.id)).version).toBe(1);
  expect((await one(env, "SELECT * FROM customer_jobs WHERE id=?", job.id)).payload_cipher).not.toBeNull();
});

it("recupera pelo identificador estável após o recibo externo interrompido", async () => {
  const f = await fixture(), key = uid();
  const command = (await sha(`${f.actor.id}:${f.profile}:contact.update\n${key}`)).slice(0, 32);
  const data = { id: f.id, expected_version: 1, name: "Ana" };
  await contactCommand(env, f.actor, f.profile, "contact.update", data, command);
  expect(await recoverContactCommand(env, f.actor, f.profile, "contact.update", key)).toMatchObject({ id: f.id, name: "Ana", result: { state: "done", pending: false } });
  expect(await contactCommand(env, f.actor, f.profile, "contact.update", data, command)).toMatchObject({ id: f.id, result: { version: 2 } });
});
it("observações continuam locais mesmo com cadastro completo ligado", async () => {
  const f = await fixture(true); await setFullCustomer(f, true);
  const result = await contactCommand(env, f.actor, f.profile, "contact.update", { id: f.id, expected_version: 1, notes: "Observação do atendimento" });
  expect(result).toMatchObject({ notes: "Observação do atendimento", result: { pending: false } });
  expect(apply).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("importação falha inteira se o índice falhar no mesmo lote", async () => {
  const f = await fixture();
  index.mockImplementationOnce(async () => [["INSERT INTO customer_assert(id,ok) VALUES('import-failure',0)", []]]);
  await expect(contactCommand(env, f.actor, f.profile, "contact.import", { csv: "nome;telefone\nBia;5511988887777\nCaio;5511988887776" })).rejects.toMatchObject({ code: "contact_conflict" });
  expect(await all(env, "SELECT name FROM contacts WHERE profile_id=?", f.profile)).toEqual([{ name: "" }]);
});
it("cursores autenticados não cruzam área ou filtros", async () => {
  const f = await fixture();
  await contactCommand(env, f.actor, f.profile, "contact.create", { name: "Bia" });
  const page = await listContacts(env, f.actor, f.profile, { limit: "1" });
  expect(page.next_cursor).toBeTruthy();
  await expect(listContacts(env, f.actor, f.profile, { limit: "1", cursor: page.next_cursor!, identity: "identified" })).rejects.toMatchObject({ code: "invalid_cursor" });
});
