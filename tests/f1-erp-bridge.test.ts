import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one, withReadCache } from "../src/db";
import { now, uid, type Env } from "../src/types";
import { seal, unseal } from "../src/security";
import { fixture, type Fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { countingEnv } from "./d1-counter";
import { customerErpBridge } from "../src/customer/erp-bridge";
import { maintainErpCustomers, markCustomerReconciliation, mirrorErpContact, SCAN_TASK } from "../src/customer/sync";
import { erpBridge, installIdentityPort } from "../src/customer/ports";
import type { BridgeCommand, BridgeResult, BridgeSnapshot, IdentityPort } from "../src/customer/contracts";
import { erpCustomerProvider } from "../src/modules/erp/customer-provider";
import { erpIdentity, erpSystemIdentity, systemUserId } from "../src/modules/erp/identity";
import { CUSTOMER_BRIDGE_USER_ID, encodeIdentity, GATE_HEADER, IDENTITY_HEADER } from "../src/erp/engine/identity";
import { erpFetch, erpStub } from "../src/erp/hub";
import { localFetch } from "../src/erp/api/local-fetch";

// A identidade é outra frente. Esta porta simulada devolve instruções, nunca
// confirma por fora do lote da ponte; permite conferir rollback do índice.
const identity: IdentityPort = {
  async resolve() { throw new Error("não usado"); },
  async prepareInbound() { throw new Error("não usado"); },
  async maintain() { return { pending: false, statements: 0, items: 0 }; },
  async indexContact(_env, input) {
    return input.phones.map((phone) => [
      `INSERT OR IGNORE INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin) VALUES(?,?,?,?,?)`,
      [input.profileId, input.namespace, phone, input.contactId, input.origin],
    ]);
  },
};
installIdentityPort(identity);
afterEach(() => vi.restoreAllMocks());
async function setup(enabled = true) {
  const f = await fixture();
  await setModule(f.profile, "erp", enabled, f.admin.id);
  return f;
}
async function create(f: Fixture, fields: { name?: string; phone?: string; document?: string; namespace?: string } = {}) {
  const id = uid();
  await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,document,search_text,source,created_by,updated_by,created,updated)
    VALUES(?,?,?,?,?,?,'','manual',?,?,?,?)`, id, f.profile, fields.namespace ?? "team", fields.name ?? "Ana", fields.phone ?? "5511998765432", fields.document ?? null, f.admin.id, f.admin.id, now(), now());
  return id;
}
const contact = (f: Fixture, id: string) => one<any>(env, "SELECT * FROM contacts WHERE profile_id=? AND id=?", f.profile, id);
const job = (f: Fixture, command: BridgeCommand) => one<any>(env, "SELECT * FROM customer_jobs WHERE profile_id=? AND command_id=?", f.profile, command.commandId);
const command = (f: Fixture, contactId: string, extra: Partial<BridgeCommand> = {}): BridgeCommand => ({
  profileId: f.profile, namespace: "team", contactId, commandId: uid(), requestHash: uid(), actor: f.admin,
  operation: "promote", erpId: null, expectedErpVersion: null, patch: {}, ...extra,
});
function applied(result: BridgeResult): BridgeSnapshot {
  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error(JSON.stringify(result));
  return result.snapshot;
}
async function rpc(f: Fixture, name: string, args: Record<string, unknown>, tracked = false) {
  const identity = await erpIdentity(env, f.admin, f.profile, "POST");
  const init = { method: "POST", body: JSON.stringify({ p_user_id: f.admin.id, ...args }) };
  const response = tracked ? await localFetch(env, f.profile, f.admin, identity, { gate: { denied: null } })(`https://erp.wabotia.invalid/rest/v1/rpc/${name}`, init) :
    await erpFetch(env, f.profile, `/erp-rpc/${name}`, { ...init, headers: { [IDENTITY_HEADER]: encodeIdentity(identity), [GATE_HEADER]: "1", "Content-Type": "application/json" } });
  const body = await response.json<any>();
  if (!response.ok) throw new Error(body.message);
  return body;
}
const save = (f: Fixture, data: any, id: string | null = null, version = 0, tracked = false) => rpc(f, "erp_catalog_contact_save", {
  p_id: id, p_expected_version: version, p_command_id: uid(), p_data: data, p_acknowledged: [],
}, tracked);
async function counts(f: Fixture) {
  return runInDurableObject(erpStub(env, f.profile), (_instance: unknown, state) => ({
    contacts: state.storage.sql.exec("SELECT count(*) n FROM erp_catalog__record WHERE entity='contacts'").toArray()[0].n,
    creates: state.storage.sql.exec("SELECT count(*) n FROM erp_catalog__audit WHERE action='create' AND entity='contacts'").toArray()[0].n,
  }));
}
function observed(fault: { before?: boolean; after?: boolean; mirrorBefore?: boolean; mirrorAfter?: boolean; mark?: boolean;
  onSave?: () => Promise<void>; forbid?: boolean; beforeBatch?: () => Promise<void> } = {}) {
  let resolutions = 0;
  const calls: { name: string; body: any }[] = [];
  const measured = countingEnv(env);
  const COORDINATOR = new Proxy(env.COORDINATOR, { get(target, key) {
    if (key === "idFromName") return (name: string) => { resolutions++; if (fault.forbid) throw new Error("ERP proibido"); return target.idFromName(name); };
    if (key === "get") return (...args: any[]) => {
      const stub = (target.get as any)(...args);
      return new Proxy(stub, { get(s, prop) {
        if (prop === "fetch") return async (input: any, init: any) => {
          const name = new URL(typeof input === "string" ? input : input.url).pathname.split("/").at(-1)!;
          const body = JSON.parse(init.body);
          calls.push({ name, body });
          if (name === "erp_catalog_contact_save" && fault.before) { fault.before = false; throw new Error("antes do commit"); }
          const response = await s.fetch(input, init);
          if (name === "erp_catalog_contact_save" && response.ok) {
            await fault.onSave?.();
            if (fault.after) { fault.after = false; await response.text(); throw new Error("resposta perdida"); }
          }
          return response;
        };
        const value = Reflect.get(s, prop); return typeof value === "function" ? value.bind(s) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const DB = new Proxy(measured.env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (fault.mark && sql.includes("INSERT INTO customer_progress")) throw new Error("marca indisponível");
      return target.prepare(sql);
    };
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      await fault.beforeBatch?.(); fault.beforeBatch = undefined;
      if (fault.mirrorBefore) { fault.mirrorBefore = false; throw new Error("antes do espelho"); }
      const result = await target.batch(statements);
      if (fault.mirrorAfter) { fault.mirrorAfter = false; throw new Error("depois do espelho"); }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { env: { ...measured.env, COORDINATOR, DB } as Env, calls, resolutions: () => resolutions, count: measured.count };
}

describe("ponte administrativa comprovada", () => {
  it("registra o executor vendas em envelopes humanos e repete sem outro cliente", async () => {
    const f = await setup(), id = await create(f), input = command(f, id);
    const transport = observed();
    const result = applied(await erpBridge.apply(transport.env, input));
    const checks = transport.calls.filter((call) => call.name === "erp_catalog_contact_check");
    expect(checks).toHaveLength(2);
    expect(checks[0].body).toMatchObject({ p_id: null, p_data: { roles: ["customer"] } });
    expect(checks[1].body.p_id).toBe(result.erpId);
    const { roles, ...administrativeData } = checks[0].body.p_data;
    expect(roles).toEqual(["customer"]);
    expect(checks[1].body.p_data).toEqual(administrativeData);
    expect(transport.calls.find((call) => call.name === "erp_catalog_contact_save")!.body.p_data).toEqual(checks[0].body.p_data);
    expect(result.erpId).not.toBe(id);
    expect((await job(f, input)).state).toBe("done");
    expect(await counts(f)).toEqual({ contacts: 1, creates: 1 });
    const c = await contact(f, id);
    expect(JSON.parse(c.mirror_json)).toEqual(result.mirror);
    expect(c.erp_version).toBe(1);
    expect(await all(env, "SELECT origin FROM customer_phone_candidates WHERE contact_id=?", id)).toEqual([{ origin: "mirror" }]);
    expect(await systemUserId("contact-erp-link")).toBe(CUSTOMER_BRIDGE_USER_ID);
    await rpc(f, "erp_catalog_contact_get", { p_id: result.erpId });
    const member = await runInDurableObject(erpStub(env, f.profile), (_instance: unknown, state) =>
      state.storage.sql.exec("SELECT role,active FROM erp_access__membership WHERE user_id=?", CUSTOMER_BRIDGE_USER_ID).toArray());
    expect(member).toEqual([{ role: "vendas", active: 1 }]);
    const spy = observed({ forbid: true });
    expect(applied(await customerErpBridge.apply(spy.env, input))).toEqual(result);
    expect(spy.resolutions()).toBe(0);
    await expect(customerErpBridge.apply(env, { ...input, patch: { name: "Outro corpo" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(customerErpBridge.apply(env, { ...input, actor: f.member })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const other = await create(f, { phone: "" });
    await expect(exec(env, "UPDATE contacts SET erp_contact_id=? WHERE id=?", result.erpId, other)).rejects.toThrow();
  }, 120_000);

  it("recusa financeiro, estoque, classificação e notas na capacidade técnica", async () => {
    const f = await setup();
    const identity = await erpSystemIdentity(env, f.profile, "contact-erp-link");
    expect(identity.actor).toMatchObject({ erp_role: "vendas", is_agent: true, session_id: null, aal: "aal1" });
    for (const [name, args] of [
      ["erp_finance_contact_open_titles", { p_contact: uid(), p_kind: "receivable" }],
      ["erp_catalog_save", { p_entity: "products", p_data: { name: "Produto" } }],
      ["erp_catalog_contact_save", { p_id: null, p_data: { name: "Pessoa", notes: "Privado" }, p_acknowledged: [] }],
      ["erp_catalog_contact_save", { p_id: null, p_data: { name: "Pessoa", roles: ["supplier"] }, p_acknowledged: [] }],
      ["erp_catalog_contact_check", { p_id: uid(), p_data: { name: "Pessoa", roles: ["customer"] } }],
      ["erp_catalog_contact_save", { p_id: uid(), p_data: { name: "Pessoa", roles: ["customer"] }, p_acknowledged: [] }],
    ] as const) {
      const response = await erpFetch(env, f.profile, `/erp-rpc/${name}`, { method: "POST", headers: { [IDENTITY_HEADER]: encodeIdentity(identity), [GATE_HEADER]: "1" }, body: JSON.stringify({ ...args, p_user_id: CUSTOMER_BRIDGE_USER_ID }) });
      expect(response.status).toBe(403);
    }
    const id = await create(f);
    await expect(customerErpBridge.apply(env, command(f, id, { patch: { notes: "Não copiar" } as any }))).rejects.toMatchObject({ code: "invalid_customer_patch" });
  }, 120_000);

  it("nome é mínimo; exigência configurável fica pendente sem inventar documento", async () => {
    const f = await setup(), id = await create(f, { name: "" });
    const spy = observed({ forbid: true });
    expect(await customerErpBridge.apply(spy.env, command(f, id))).toEqual({ status: "needs_data", fields: ["name"] });
    expect(spy.resolutions()).toBe(0);
    const minimal = await save(f, { name: "Apenas nome" });
    expect(minimal.record).toMatchObject({ document: null, person_type: null });
    // Preferência real do motor, mesmo arranjo da prova aprovada.
    const preferences = await rpc(f, "erp_preferences_page", { p_page: "cadastros-contatos" });
    const required = preferences.items.find((item: any) => item.key === "contatos.campos_obrigatorios");
    await rpc(f, "erp_preferences_save", { p_page: "cadastros-contatos", p_command_id: uid(),
      p_changes: [{ key: required.key, expected_version: required.version, value: ["cnpj"] }] });
    const input = command(f, await create(f, { phone: "" }));
    const pending = await customerErpBridge.apply(env, input);
    expect(pending).toEqual({ status: "needs_data", fields: ["document"] });
    expect((await job(f, input)).state).toBe("paused");
    expect((await contact(f, input.contactId)).erp_contact_id).toBeNull();
  }, 120_000);

  it.each(["before", "after", "mirrorBefore", "mirrorAfter"] as const)("recupera queda %s com o mesmo comando/corpo", async (point) => {
    const f = await setup(), id = await create(f), input = command(f, id, { patch: { address: { street: "Rua do cadastro" } } });
    const broken = observed({ [point]: true });
    await expect(customerErpBridge.apply(broken.env, input)).rejects.toThrow();
    expect(broken.calls.filter((call) => call.name === "erp_catalog_contact_save")).toHaveLength(1);
    expect(await counts(f)).toEqual(point === "before" ? { contacts: 0, creates: 0 } : { contacts: 1, creates: 1 });
    const pending = await job(f, input);
    expect(pending.cursor_json).not.toContain("Rua do cadastro");
    if (point !== "mirrorAfter") {
      const meta = JSON.parse(pending.cursor_json).customerErp;
      const intent = await unseal(env, meta.intent);
      expect(intent.command.commandId).toBe(input.commandId);
      expect(intent.data.street).toBe("Rua do cadastro");
      expect((await contact(f, id)).erp_contact_id).toBeNull();
      expect(await all(env, "SELECT * FROM customer_phone_candidates WHERE contact_id=?", id)).toEqual([]);
    } else expect(pending.state).toBe("done");
    const restored = observed();
    applied(await customerErpBridge.apply(restored.env, input));
    expect(await counts(f)).toEqual({ contacts: 1, creates: 1 });
    const sends = [...broken.calls, ...restored.calls].filter((c) => c.name === "erp_catalog_contact_save");
    for (const sent of sends) expect(sent.body).toEqual(sends[0].body);
    const final = await job(f, input);
    expect(final.state).toBe("done");
    expect(JSON.parse(final.cursor_json).customerErp.intent).toBeUndefined();
  }, 120_000);

  it("não aplica o recibo antigo após outra edição ERP e não altera campos locais", async () => {
    const f = await setup(), id = await create(f), input = command(f, id);
    await exec(env, "UPDATE contacts SET notes='Só atendimento',company='Empresa local' WHERE id=?", id);
    await expect(customerErpBridge.apply(observed({ after: true }).env, input)).rejects.toThrow();
    const rows = await rpc(f, "erp_catalog_contact_page", { p_page: 1, p_size: 100, p_sort: "created_desc", p_situation: "all" });
    await save(f, { name: "Mais recente", mobile: "5521987654321", email: "ana@exemplo.test" }, rows.items[0].id, 1);
    const snapshot = applied(await customerErpBridge.apply(env, input));
    expect(snapshot.erpVersion).toBe(2);
    expect(snapshot.mirror.phones).toEqual(["5511998765432", "5521987654321"]);
    expect(await contact(f, id)).toMatchObject({ name: "Mais recente", company: "Empresa local", notes: "Só atendimento" });
  }, 120_000);

  it("retoma intenção após lease vencida sem exceder o orçamento compartilhado", async () => {
    const f = await setup(), id = await create(f), input = command(f, id);
    await expect(customerErpBridge.apply(observed({ after: true }).env, input)).rejects.toThrow();
    await exec(env, "UPDATE customer_jobs SET state='running',retry_at=0,lease_until=? WHERE profile_id=? AND command_id=?", now() - 1, f.profile, input.commandId);
    const small = countingEnv(env);
    const short = await maintainErpCustomers(small.env, f.profile, { remainingItems: 1, remainingStatements: 5 });
    expect(short.pending).toBe(true);
    expect(short.statements).toBe(small.count.statements);
    expect(short.statements).toBeLessThanOrEqual(5);
    expect((await job(f, input)).state).not.toBe("done");
    const full = countingEnv(env);
    const restored = await maintainErpCustomers(full.env, f.profile, { remainingItems: 1, remainingStatements: 40 });
    expect(restored.statements).toBe(full.count.statements);
    expect(restored.statements).toBeLessThanOrEqual(40);
    expect((await job(f, input)).state).toBe("done");
    expect(await counts(f)).toEqual({ contacts: 1, creates: 1 });
  }, 120_000);

  it("patch com CAS; conflito ERP bloqueia a fila e preserva a intenção", async () => {
    const f = await setup(), id = await create(f);
    const initial = applied(await customerErpBridge.apply(env, command(f, id)));
    const edit = command(f, id, { operation: "patch", erpId: initial.erpId, expectedErpVersion: 1, patch: { name: "Alterado", phones: ["5531987654321"] } });
    const second = applied(await customerErpBridge.apply(env, edit));
    expect(second.erpVersion).toBe(2);
    await save(f, { name: "Alteração concorrente" }, initial.erpId, 2);
    const conflict = command(f, id, { operation: "patch", erpId: initial.erpId, expectedErpVersion: 2, patch: { name: "Minha intenção" } });
    expect(await customerErpBridge.apply(env, conflict)).toMatchObject({ status: "conflict" });
    expect((await contact(f, id)).name).toBe("Alterado");
    expect((await job(f, conflict)).state).toBe("conflict");
    const later = command(f, id, { operation: "patch", erpId: initial.erpId, expectedErpVersion: 2, patch: { email: "outra@exemplo.test" } });
    await expect(customerErpBridge.apply(env, later)).rejects.toMatchObject({ code: "sync_pending" });
  }, 120_000);

  it("retorno atrasado não sobrescreve edição local nem conclui job", async () => {
    const f = await setup(), id = await create(f), input = command(f, id);
    const broken = observed({ onSave: async () => { await exec(env, "UPDATE contacts SET name='Edição local',version=version+1 WHERE id=?", id); } });
    expect(await customerErpBridge.apply(broken.env, input)).toMatchObject({ status: "conflict" });
    expect(await contact(f, id)).toMatchObject({ name: "Edição local", erp_contact_id: null });
    expect((await job(f, input)).state).toBe("conflict");
  }, 120_000);

  it("guarda D1 desfaz espelho, índice e conclusão se a versão mudar entre leitura e batch", async () => {
    const f = await setup(), id = await create(f), input = command(f, id);
    const broken = observed({ beforeBatch: async () => { await exec(env, "UPDATE contacts SET name='No intervalo',version=version+1 WHERE id=?", id); } });
    await expect(customerErpBridge.apply(broken.env, input)).rejects.toThrow();
    expect(await contact(f, id)).toMatchObject({ name: "No intervalo", erp_contact_id: null });
    expect((await job(f, input)).state).not.toBe("done");
    expect(await all(env, "SELECT * FROM customer_phone_candidates WHERE contact_id=?", id)).toEqual([]);
  }, 120_000);

  it("telefone, mobile e documento são candidatos; a janela após salvar exige revisão", async () => {
    const f = await setup(), first = await create(f), second = await create(f);
    expect(await customerErpBridge.apply(env, command(f, first))).toMatchObject({ status: "conflict", candidateIds: [second] });
    expect(await counts(f)).toEqual({ contacts: 0, creates: 0 });
    const other = await setup();
    const existing = await save(other, { name: "Já existe", mobile: "+55 (11) 99876-5432" });
    expect(await customerErpBridge.apply(env, command(other, await create(other)))).toMatchObject({ status: "conflict", candidateIds: [existing.record.id] });
    const owner = await save(other, { name: "Documento", document: "529.982.247-25", person_type: "F" });
    expect(await customerErpBridge.apply(env, command(other, await create(other, { phone: "" }), { patch: { document: "52998224725", personType: "F" } })))
      .toMatchObject({ status: "conflict", candidateIds: [owner.record.id] });
    const race = await setup(), id = await create(race), input = command(race, id);
    const competing = observed({ onSave: async () => { await save(race, { name: "Concorrente", phone: "5511998765432" }); } });
    expect(await customerErpBridge.apply(competing.env, input)).toMatchObject({ status: "conflict" });
    expect((await job(race, input)).error_code).toBe("possible_duplicate_after_save");
    expect((await contact(race, id)).erp_contact_id).toBeNull();
  }, 120_000);

  it("desligamento durante retorno usa ativação fresca; desligado faz zero chamadas", async () => {
    const f = await setup(), id = await create(f), input = command(f, id);
    const late = observed({ onSave: () => setModule(f.profile, "erp", false, f.admin.id) });
    expect(await customerErpBridge.apply(withReadCache(late.env), input)).toEqual({ status: "paused", reason: "module_disabled" });
    expect((await contact(f, id)).erp_contact_id).toBeNull();
    const off = observed({ forbid: true });
    expect(await customerErpBridge.apply(off.env, input)).toEqual({ status: "paused", reason: "module_disabled" });
    expect(await maintainErpCustomers(off.env, f.profile, { remainingStatements: 40, remainingItems: 20 })).toMatchObject({ pending: false });
    await expect(customerErpBridge.scan(off.env, f.profile, null, 20)).rejects.toMatchObject({ code: "module_disabled" });
    await expect(customerErpBridge.read(off.env, f.admin, f.profile, uid())).rejects.toMatchObject({ code: "module_disabled" });
    expect(off.resolutions()).toBe(0);
    await setModule(f.profile, "erp", true, f.admin.id);
    applied(await customerErpBridge.apply(env, input));
    expect(await counts(f)).toEqual({ contacts: 1, creates: 1 });
  }, 120_000);

  it("não associa app nem reutiliza ID ERP já ligado; associação é explícita", async () => {
    const f = await setup(), app = await create(f, { namespace: `app:${uid()}` });
    const off = observed({ forbid: true });
    expect(await customerErpBridge.apply(off.env, command(f, app, { namespace: `app:${uid()}` }))).toEqual({ status: "paused", reason: "awaiting_proof" });
    expect(off.resolutions()).toBe(0);
    const existing = await save(f, { name: "Do ERP" });
    const id = await create(f, { phone: "" });
    applied(await customerErpBridge.apply(env, command(f, id, { operation: "bind", erpId: existing.record.id, expectedErpVersion: 1 })));
    expect(await customerErpBridge.apply(env, command(f, await create(f, { phone: "" }), { operation: "bind", erpId: existing.record.id, expectedErpVersion: 1 }))).toMatchObject({ status: "conflict" });
    expect((await counts(f)).contacts).toBe(1);
  }, 120_000);

  it("marca antes de importar e varre por ID sem associar candidatos", async () => {
    const f = await setup();
    await rpc(f, "erp_catalog_contact_import", { p_command_id: uid(), p_dry_run: false, p_rows: [
      { row: 1, data: { name: "Importado A" } }, { row: 2, data: { name: "Importado B" } },
    ] }, true);
    expect(await one(env, "SELECT complete FROM customer_progress WHERE profile_id=? AND task=?", f.profile, SCAN_TASK)).toEqual({ complete: 0 });
    const first = await customerErpBridge.scan(env, f.profile, null, 1);
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBe(first.items[0].erpId);
    const second = await customerErpBridge.scan(env, f.profile, first.nextCursor, 1);
    expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(second.items[0].erpId > first.items[0].erpId).toBe(true);
    expect(await all(env, "SELECT id FROM contacts WHERE profile_id=?", f.profile)).toEqual([]);
    await expect(customerErpBridge.scan(env, f.profile, "inválido", 1)).rejects.toMatchObject({ code: "invalid_cursor" });
  }, 120_000);

  it("marca que falha impede escrita; falha do espelho conserva o sucesso ERP", async () => {
    const f = await setup(), id = await create(f);
    const initial = applied(await customerErpBridge.apply(env, command(f, id)));
    const identity = await erpIdentity(env, f.admin, f.profile, "POST");
    const request = { method: "POST", body: JSON.stringify({ p_user_id: f.admin.id, p_id: initial.erpId,
      p_expected_version: 1, p_command_id: uid(), p_data: { name: "Na tela" }, p_acknowledged: [] }) };
    const before = observed({ mark: true });
    await expect(localFetch(before.env, f.profile, f.admin, identity)("https://erp.wabotia.invalid/rest/v1/rpc/erp_catalog_contact_save", request)).rejects.toThrow("marca indisponível");
    expect(before.resolutions()).toBe(0);
    const after = observed({ mirrorBefore: true });
    const response = await localFetch(after.env, f.profile, f.admin, identity)("https://erp.wabotia.invalid/rest/v1/rpc/erp_catalog_contact_save", request);
    expect(response.ok).toBe(true);
    expect((await contact(f, id)).erp_version).toBe(1);
    expect(await one(env, "SELECT complete FROM customer_progress WHERE profile_id=? AND task=?", f.profile, SCAN_TASK)).toEqual({ complete: 0 });
    await maintainErpCustomers(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    expect(await contact(f, id)).toMatchObject({ name: "Na tela", erp_version: 2 });
  }, 120_000);

  it("varredura pela fachada simulada confirma versão e respeita orçamento e falha atômica", async () => {
    const f = await setup(), id = await create(f);
    const initial = applied(await customerErpBridge.apply(env, command(f, id)));
    const latest: BridgeSnapshot = { ...initial, erpVersion: 2, mirror: { ...initial.mirror, name: "Da varredura" } };
    vi.spyOn(erpBridge, "scan").mockResolvedValue({ items: [latest], nextCursor: null });
    await markCustomerReconciliation(env, f.profile);
    const measured = countingEnv(env);
    const result = await maintainErpCustomers(measured.env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect(result.statements).toBe(measured.count.statements);
    expect(result.statements).toBeLessThanOrEqual(40);
    expect(result.items).toBe(1);
    expect(await contact(f, id)).toMatchObject({ name: "Da varredura", erp_version: 2 });
    const before = (await contact(f, id)).version;
    await mirrorErpContact(env, f.profile, initial);
    expect((await contact(f, id)).version).toBe(before);
    await exec(env, "UPDATE contacts SET local_patch_cipher=? WHERE id=?", await seal(env, { name: "Local desligado" }), id);
    vi.mocked(erpBridge.scan).mockResolvedValue({ items: [{ ...latest, erpVersion: 3 }], nextCursor: null });
    await markCustomerReconciliation(env, f.profile);
    await maintainErpCustomers(env, f.profile, { remainingItems: 20, remainingStatements: 40 });
    expect(await one(env, "SELECT state FROM customer_jobs WHERE profile_id=? AND error_code='contact_conflict'", f.profile)).toEqual({ state: "conflict" });
    expect((await contact(f, id)).erp_version).toBe(2);
  }, 120_000);

  it("listas exigem pessoa/ERP, ocultam conteúdo e declaram histórico incompleto", async () => {
    const f = await setup(), id = await create(f);
    applied(await customerErpBridge.apply(env, command(f, id)));
    const ctx = { env, profile: f.profile } as any;
    expect(await erpCustomerProvider.list!(ctx, f.admin, id, "sales", { limit: 25 })).toEqual({ items: [], nextCursor: null, incomplete: true });
    expect(await erpCustomerProvider.list!(ctx, f.admin, id, "open_titles", { limit: 25 })).toEqual({ items: [], nextCursor: null, incomplete: false });
    expect(await erpCustomerProvider.list!(ctx, f.admin, id, "ledger", { limit: 25 })).toEqual({ items: [], nextCursor: null, incomplete: true });
    await expect(erpCustomerProvider.list!(ctx, f.member, id, "sales", { limit: 25 })).rejects.toMatchObject({ code: "erp_role_required" });
    await expect(erpCustomerProvider.list!(ctx, { ...f.admin, kind: "app" }, id, "sales", { limit: 25 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(erpCustomerProvider.list!(ctx, f.admin, id, "sales", { limit: 25, cursor: "forjado" })).rejects.toMatchObject({ code: "invalid_cursor" });
  }, 120_000);
});
