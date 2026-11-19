import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec, one } from "../src/db";
import { now, uid, type Actor, type Env } from "../src/types";
import { canonical, seal, sha } from "../src/security";
import { customerResourceRoute, requireOperationAccess, requireRouteAccess } from "../src/access";
import { authorizeCustomerReplay } from "../src/coordinator";
import { CUSTOMER_TICK_ROUNDS, CUSTOMER_TICK_WINDOW_MS, resumeCustomerMaintenance } from "../src/customer/ports";
import { moduleById, modules } from "../src/modules/registry";
import { settingsValidator } from "../src/modules/hooks";
import { customerMaintenanceEnv, customerProvider, erpBridge, historyPort, identityPort, maintainCustomers, profilePort, writePort } from "../src/customer/ports";
import type { MaintenanceBudget, MaintenanceResult } from "../src/customer/contracts";
import { api, application, bearer, fixture } from "./service-center-fixture";
import { countingEnv } from "./d1-counter";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("inicialização do Worker com os portões cadastrais", () => {
  it("carrega a entrada real e registra o validador de Formulários", async () => {
    // SELF inicializa src/index.ts sem substituir registry/runtime: o import
    // antecipado de access fazia onSettingsSave falhar antes de qualquer teste.
    const response = await SELF.fetch("https://wabotia.test/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: "wabotia", runtime: "cloudflare-workers" });
    expect(moduleById("forms")?.settings.some(s => s.key === "forms")).toBe(true);
    const validate = settingsValidator("forms");
    expect(validate).toBeTypeOf("function");
    expect(validate!([])).toEqual([]);
    expect(() => validate!({})).toThrow();
  });
});

const done = (): MaintenanceResult => ({ pending: false, statements: 0, items: 0 });
const budget = { remainingStatements: 40, remainingItems: 20 };
const tick = (stub: DurableObjectStub, profile: string) => stub.fetch("https://coordinator/customer-tick", {
  method: "POST", body: JSON.stringify({ profile }),
});
function participants() {
  return [identityPort, writePort, historyPort, ...modules.map(m => m.id).sort()
    .map(id => customerProvider(id)).filter(p => p?.maintain)] as { maintain: (env: Env, profile: string, budget: MaintenanceBudget) => Promise<MaintenanceResult> }[];
}
function silence() {
  const ports = participants();
  const spies = ports.map(p => vi.spyOn(p, "maintain").mockResolvedValue(done()));
  return { ports, spies };
}
function signal() {
  // Só o booleano cruza contextos. Uma Promise compartilhada e resolvida no
  // Coordinator pode levar a continuação do teste ao contexto de I/O dele:
  // o stub e o corpo da resposta pertencem ao Runner, não ao Coordinator.
  // O plugin ativa no_handle_cross_request_promise_resolution no runtime.
  let signaled = false;
  return {
    resolve() { signaled = true; },
    async wait() {
      // Cada espera nasce no contexto de quem a chama. scheduler.wait é nativo
      // do Workers e não é substituído pelos fake timers do Vitest.
      while (!signaled) await scheduler.wait(1);
    },
  };
}
async function whileWaiting<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Atendimento ficou esperando a manutenção.")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

describe("rodadas cadastrais justas e limitadas", () => {
  it("identidade extensa e histórico irresolvido não tiram a vez de jobs e OS", async () => {
    const f = await fixture(), { ports, spies } = silence();
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const opportunities = new Set<number>();
    spies.forEach((spy, index) => spy.mockImplementation(async (_env, _profile, b) => {
      // Cada participante exige uma etapa real: não serve receber só sobras.
      if (b.remainingStatements < 30 || b.remainingItems < 2) return { ...done(), pending: true };
      opportunities.add(index);
      return { pending: true, statements: 30, items: b.remainingItems };
    }));
    for (let i = 0; i < ports.length; i++) {
      const result = await (await tick(stub, f.profile)).json<any>();
      expect(result.statements).toBeLessThanOrEqual(40);
      expect(result.items).toBeLessThanOrEqual(20);
    }
    expect(opportunities.size).toBe(ports.length);
    expect(opportunities.has(ports.indexOf(writePort))).toBe(true);
    expect(opportunities.has(ports.findIndex(p => p === customerProvider("os")))).toBe(true);
  });

  it("conta SQL anterior à falha e continua o participante seguinte", async () => {
    const { spies } = silence();
    spies[0].mockImplementation(async e => {
      await e.DB.prepare("SELECT 1").first();
      throw new Error("Falha permanente de identidade");
    });
    spies[1].mockImplementation(async (e, _p, b) => {
      expect(b.remainingStatements).toBe(39);
      expect(b.remainingItems).toBeGreaterThan(0);
      await e.DB.prepare("SELECT 2").first();
      return { pending: false, statements: 1, items: 1 };
    });
    const counted = countingEnv(env);
    const result = await maintainCustomers(counted.env, "area", budget, 0, { fair: true });
    expect(spies[1]).toHaveBeenCalledOnce();
    expect(result).toEqual({ pending: true, statements: 2, items: 20 });
    expect(counted.count.statements).toBe(2);
  });

  it("o limite físico inclui lotes e leituras mesmo se uma porta não reportar o consumo", async () => {
    const { spies } = silence();
    spies[0].mockImplementation(async e => {
      await e.DB.batch(Array.from({ length: 39 }, () => e.DB.prepare("SELECT 1")));
      await e.DB.prepare("SELECT 1").first();
      await e.DB.prepare("SELECT 1").first(); // Não pode chegar ao D1.
      return done();
    });
    const counted = countingEnv(env);
    const result = await maintainCustomers(counted.env, "area", budget, 0, { fair: true });
    expect(result.statements).toBe(40);
    expect(counted.count.statements).toBe(40);
    expect(result.items).toBeLessThanOrEqual(20);
  });
  it("retorno tardio não confirma escrita depois de perder a reserva", async () => {
    const counted = countingEnv(env);
    let valid = true;
    const meter = customerMaintenanceEnv(counted.env, 40, () => { if (!valid) throw new Error("Lease vencida"); });
    const statement = meter.env.DB.prepare("SELECT 1");
    await statement.first();
    valid = false;
    expect(() => meter.env.DB.batch([statement])).toThrow("Lease vencida");
    expect(counted.count.statements).toBe(1);
  });

  it.each([false, true])("ERP lento libera comando da área e recusa tick concorrente (legado=%s)", async legacy => {
    const f = await fixture(), { spies } = silence();
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const entered = signal(), release = signal();
    spies[1].mockImplementation(async () => {
      entered.resolve(); await release.wait();
      return { pending: true, statements: 1, items: 1 };
    });
    const pending = legacy ? stub.fetch("https://coordinator/command", {
      method: "POST", body: JSON.stringify({ profile: f.profile, operation: "contact.maintain",
        actor: { kind: "connector", id: "customer-maintenance" }, data: {}, key: uid() }),
    }) : tick(stub, f.profile);
    await entered.wait();
    try {
      const concurrent = await whileWaiting(tick(stub, f.profile));
      expect(await concurrent.json()).toMatchObject({ leased: true, progress: false });
      const command = await whileWaiting(stub.fetch("https://coordinator/command", {
        method: "POST", body: JSON.stringify({ profile: f.profile, actor: f.admin,
          operation: "contact.create", data: { name: "Atendimento durante ERP lento" }, key: uid(), requestId: uid() }),
      }));
      expect(command.status).toBe(200);
      const inbox = await whileWaiting(stub.fetch("https://coordinator/inbound", {
        method: "POST", body: JSON.stringify({ profile: f.profile, namespace: `channel:${f.line}`, connectionId: f.line,
          data: { external_id: "5511987654321", phone: "5511987654321", text: "oi", message_id: uid() } }),
      }));
      expect(inbox.status).toBe(202);
      expect(spies[1]).toHaveBeenCalledOnce();
    } finally { release.resolve(); await pending; }
  });

  it("salva turno antes do trabalho e recupera lease vencida após queda", async () => {
    const f = await fixture(), { spies } = silence();
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({ customer_maintenance_turn: 2, customer_maintenance_lease: { token: "queda", until: now() - 1 } });
      await state.storage.deleteAlarm();
    });
    spies[2].mockImplementation(async () => { throw new Error("Histórico irresolvido"); });
    await tick(stub, f.profile);
    expect(spies[2]).toHaveBeenCalled();
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("customer_maintenance_turn")).toBe(3);
      expect(await state.storage.get("customer_maintenance_lease")).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("ERP sem resposta perde a vez no prazo e seu retorno não grava D1", async () => {
    const f = await fixture(), { spies } = silence();
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const entered = signal(), release = signal(), finished = signal(), deadline = signal();
    const nativeSetTimeout = globalThis.setTimeout;
    let scheduledDeadline: number | undefined;
    // O callback continua sendo disparado por um timer nativo do Coordinator.
    // Fake timers executariam esse callback no Runner que avança o relógio.
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay !== undefined && delay > 59_000 && delay <= 60_000) {
        scheduledDeadline = delay;
        return nativeSetTimeout(async () => { await deadline.wait(); callback(...args); }, 0);
      }
      return nativeSetTimeout(callback, delay, ...args);
    });
    spies[0].mockImplementationOnce(async e => {
      entered.resolve(); await release.wait();
      try { await exec(e, "UPDATE profiles SET name='Retorno vencido' WHERE id=?", f.profile); }
      finally { finished.resolve(); }
      return done();
    });
    const pending = tick(stub, f.profile);
    await entered.wait();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now() + 60_000);
    try {
      expect(scheduledDeadline).toBeGreaterThan(59_000);
      expect(scheduledDeadline).toBeLessThanOrEqual(60_000);
      deadline.resolve();
      expect(await (await pending).json()).toMatchObject({ timedOut: true, progress: false });
      clock.mockRestore(); timer.mockRestore();
      expect(await (await tick(stub, f.profile)).json()).not.toHaveProperty("leased");
    } finally {
      clock.mockRestore(); timer.mockRestore();
      deadline.resolve(); release.resolve(); await finished.wait();
    }
    expect(await one(env, "SELECT name FROM profiles WHERE id=?", f.profile)).toMatchObject({ name: "Atendimento" });
  });

  it("confirma a reserva por token, sem apagar uma lease sucessora", async () => {
    const f = await fixture(); silence();
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const entered = signal(), release = signal();
    vi.mocked(identityPort.maintain).mockImplementation(async () => {
      entered.resolve(); await release.wait(); return done();
    });
    const pending = tick(stub, f.profile);
    await entered.wait();
    try {
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.get("customer_maintenance_turn")).toBe(1);
        await state.storage.put("customer_maintenance_lease", { token: "sucessora", until: now() + 60_000 });
      });
    } finally { release.resolve(); await pending; }
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("customer_maintenance_lease")).toMatchObject({ token: "sucessora" });
    });
  });
});

describe("retomadas dedicadas pelo cron", () => {
  function transport(result: () => Promise<Response>) {
    const fetch = vi.fn(result);
    return { fetch, env: { COORDINATOR: { idFromName: (id: string) => id, get: () => ({ fetch }) } } as unknown as Env };
  }
  it("encadeia progresso até o teto e retoma no cron seguinte; contabiliza 50 mil itens", async () => {
    const t = transport(async () => Response.json({ pending: true, progress: true }));
    await resumeCustomerMaintenance(t.env, "area");
    expect(t.fetch).toHaveBeenCalledTimes(CUSTOMER_TICK_ROUNDS);
    await resumeCustomerMaintenance(t.env, "area");
    expect(t.fetch).toHaveBeenCalledTimes(2 * CUSTOMER_TICK_ROUNDS);
    const n = participants().length;
    const opportunities = Math.floor(CUSTOMER_TICK_ROUNDS / n);
    expect(opportunities).toBeGreaterThan(1);
    console.log("c-coordenacao-cadencia", { participants: n, rounds: CUSTOMER_TICK_ROUNDS,
      opportunities, identityPages: Math.ceil(50_000 / 19),
      cronWindowsIdentity: Math.ceil(Math.ceil(50_000 / 19) / opportunities),
      cronWindowsErpOneItem: Math.ceil(50_000 / opportunities), measuredLatency: false });
  });
  it.each([
    { pending: true, progress: false }, { pending: false, progress: true },
    { pending: true, progress: true, leased: true },
  ])("para sem avanço, ao concluir ou diante de lease: %j", async result => {
    const t = transport(async () => Response.json(result));
    await resumeCustomerMaintenance(t.env, "area");
    expect(t.fetch).toHaveBeenCalledOnce();
  });
  it("encerra a janela mesmo com ERP pendurado", async () => {
    vi.useFakeTimers();
    const t = transport(() => new Promise<Response>(() => {}));
    const running = resumeCustomerMaintenance(t.env, "area");
    await vi.advanceTimersByTimeAsync(CUSTOMER_TICK_WINDOW_MS);
    await running;
    expect(t.fetch).toHaveBeenCalledOnce();
  });
});

describe("recibos respeitam autorização atual", () => {
  async function stored(operation = "contact.update", dataOverride?: Record<string, unknown>, resultOverride?: any) {
    const f = await fixture(), id = uid(), key = uid();
    await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Nome privado','','','manual','test','test',?,?)", id, f.profile, now(), now());
    const data = dataOverride ?? { id, name: "Nome privado" };
    const result = resultOverride ?? { id, namespace: "team", name: "Nome privado" };
    const scope = `${f.member.id}:${f.profile}:${operation}`;
    const fingerprint = await sha(canonical(data));
    await exec(env, "INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)",
      scope, key, fingerprint, JSON.stringify(result), now());
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const replay = () => stub.fetch("https://coordinator/command", { method: "POST",
      body: JSON.stringify({ profile: f.profile, actor: f.member, operation, data, key, requestId: uid() }) });
    return { ...f, id, key, scope, fingerprint, replay, data, result };
  }
  it.each(["restricted", "deleted"])("recibo antigo não reapresenta contato %s nem repete a mutação", async state => {
    const f = await stored();
    expect((await f.replay()).status).toBe(200);
    if (state === "deleted") await exec(env, "DELETE FROM contacts WHERE id=?", f.id);
    else await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", f.id);
    const denied = await f.replay();
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("Nome privado");
    expect(await one(env, "SELECT fingerprint,response FROM receipts WHERE scope=? AND key=?", f.scope, f.key))
      .toEqual({ fingerprint: f.fingerprint, response: JSON.stringify(f.result) });
    expect(await one(env, "SELECT count(*) n FROM customer_jobs WHERE profile_id=?", f.profile)).toMatchObject({ n: 0 });
  });
  it("recibo selado relê permissões mesmo quando o ator do pedido é antigo", async () => {
    const f = await stored();
    await exec(env, "UPDATE receipts SET response=? WHERE scope=? AND key=?", "sealed:" + await seal(env, f.result), f.scope, f.key);
    await exec(env, "UPDATE users SET access='[\"os:technician\"]' WHERE id=?", f.member.id);
    expect((await f.replay()).status).toBe(403);
  });
  it("preserva replay de criação por aplicação que enviou namespace ignorado", async () => {
    const f = await stored(), app = await application(f, ["contacts:write"]);
    const actor: Actor = { ...f.member, id: `app:${app.id}`, kind: "app", role: "service", scopes: ["contacts:write"] };
    const namespace = `app:${actor.id}`;
    await exec(env, "UPDATE contacts SET namespace=? WHERE id=?", namespace, f.id);
    const value = { ...f.result, namespace };
    expect(await authorizeCustomerReplay(env, actor, f.profile, "contact.create", { name: "Nome privado", namespace: "team" }, value)).toEqual(value);
  });
  it("valida namespace e associação atual antes de devolver a ficha antiga", async () => {
    const f = await stored();
    await expect(authorizeCustomerReplay(env, f.member, f.profile, "contact.resolve-phone", { contactId: f.id, namespace: "app:outro" }, f.result))
      .rejects.toMatchObject({ status: 404 });
    await expect(authorizeCustomerReplay(env, f.member, f.profile, "contact.from-conversation", { id: "conversa-removida" }, f.result))
      .rejects.toMatchObject({ status: 404 });
  });
  it("revalida a seção sem executar saveSection", async () => {
    const f = await stored();
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'condominio',1,?)", f.profile, now());
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'os',1,?)", f.profile, now());
    const section = vi.spyOn(profilePort, "section").mockResolvedValue({ version: 4, writable: false, schema: "condominio.units.v1", data: null });
    const save = vi.spyOn(profilePort, "saveSection");
    await expect(authorizeCustomerReplay(env, f.member, f.profile, "condominio.customer-section",
      { id: f.id, section: "units" }, { version: 2, data: { private: "antigo" } })).rejects.toMatchObject({ status: 403 });
    expect(section).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  });
  it("recibo de associação ERP também respeita restrição antes de consultar o ERP", async () => {
    const f = await stored();
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'erp',1,?)", f.profile, now());
    await exec(env, "UPDATE contacts SET identity_state='restricted',erp_contact_id='erp-original' WHERE id=?", f.id);
    await expect(authorizeCustomerReplay(env, f.member, f.profile, "contact.from-erp", { erpId: "erp-original" },
      { contactId: f.id, version: 1, jobId: null, state: "done", pending: false })).rejects.toMatchObject({ status: 404 });
  });
  it("autorização remota do replay não bloqueia comando e relê exclusão após a espera", async () => {
    const f = await stored("contact.from-erp", { erpId: "erp-original" });
    await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'erp',1,?)", f.profile, now());
    await exec(env, "UPDATE contacts SET erp_contact_id='erp-original' WHERE id=?", f.id);
    await exec(env, "UPDATE receipts SET response=? WHERE scope=? AND key=?",
      JSON.stringify({ contactId: f.id, version: 1, jobId: null, state: "done", pending: false }), f.scope, f.key);
    const entered = signal(), release = signal();
    vi.spyOn(erpBridge, "read").mockImplementation(async () => {
      entered.resolve(); await release.wait();
      return { erpId: "erp-original", erpVersion: 1,
        mirror: { name: "Nome privado", phones: [], email: "", document: null, personType: null } };
    });
    const pending = f.replay();
    await entered.wait();
    try {
      const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
      const command = await whileWaiting(stub.fetch("https://coordinator/command", {
        method: "POST", body: JSON.stringify({ profile: f.profile, actor: f.admin,
          operation: "contact.create", data: { name: "Atendimento" }, key: uid(), requestId: uid() }),
      }));
      expect(command.status).toBe(200);
      await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", f.id);
    } finally { release.resolve(); }
    expect((await pending).status).toBe(404);
  });
});

describe("portões específicos e cancelamento", () => {
  // O helper compartilhado infere a chave como UUID. Aqui a chave vazia é
  // proposital: exercita a validação HTTP real, sem forçar um tipo inválido.
  const postWithEmptyKey = (token: string, path: string, body: unknown) => SELF.fetch("https://test/api/v1" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Idempotency-Key": "" },
    body: JSON.stringify(body),
  });
  it("middleware entrega associação/job ao recurso para papel ERP, mas barra Contatos", async () => {
    const f = await fixture();
    await exec(env, "UPDATE users SET access='[\"erp:vendas\"]' WHERE id=?", f.member.id);
    const token = await bearer(f.member);
    for (const path of ["contacts/from-erp", "contacts/contact/promote", "contact-jobs/job/resolve", "contact-jobs/job/cancel"]) {
      const response = await postWithEmptyKey(token, `/profiles/${f.profile}/${path}`, {});
      expect(response.status, path).toBe(400);
      expect((await response.json<any>()).error.message).toContain("Idempotency-Key");
    }
    for (const [path, method] of [["contacts", "GET"], ["contacts/import", "POST"], ["contact-identities/resolve", "POST"]]) {
      const response = await api(token, `/profiles/${f.profile}/${path}`, method, method === "POST" ? {} : undefined);
      expect(response.status, path).toBe(403);
      expect((await response.json<any>()).error.code).toBe("access_denied");
    }
  });
  it("ERP passa às autorizações de recurso, sem ganhar agenda, importação ou identidade", () => {
    const actor = { kind: "user", role: "operator", access: ["erp:vendas"] } as Actor;
    for (const op of ["contact.promote", "contact.from-erp", "contact.resolve-job", "contact.job-cancel"])
      expect(() => requireOperationAccess(actor, op)).not.toThrow();
    for (const op of ["contact.create", "contact.update", "contact.import", "contact.resolve-phone", "contact.from-conversation"])
      expect(() => requireOperationAccess(actor, op)).toThrow();
    expect(() => requireRouteAccess(actor, "contacts")).toThrow();
    expect(customerResourceRoute("POST", "contact-jobs/job/cancel")).toBe(true);
    expect(customerResourceRoute("GET", "contacts/id/profile")).toBe(true);
    for (const path of ["contacts", "contacts/id", "contacts/import", "contact-identities/resolve"])
      expect(customerResourceRoute("POST", path)).toBe(false);
  });
  it("cancelamento é rota de comando com Idempotency-Key, sem executor no Worker", async () => {
    const f = await fixture(), token = await bearer(f.member);
    const path = `/profiles/${f.profile}/contact-jobs/${uid()}/cancel`;
    const response = await postWithEmptyKey(token, path, { expectedUpdated: 1, expectedVersion: 1, reason: "Revisão" });
    expect(response.status).toBe(400);
    expect((await response.json<any>()).error).toMatchObject({ code: "invalid_request", message: "Envie Idempotency-Key (até 200 caracteres ASCII)." });
    const key = uid(), body = { expectedUpdated: 1, expectedVersion: 1, reason: "Revisão" };
    await api(token, path, "POST", body, key);
    const receipt = await one(env, "SELECT fingerprint,status FROM receipts WHERE scope=? AND key=?",
      `${f.member.id}:${f.profile}:contact.job-cancel`, key);
    expect(receipt).not.toBeNull();
    expect(receipt.fingerprint).toBe(await sha(canonical({ ...body, id: path.split("/").at(-2) })));
    expect(receipt.status).toBeLessThan(500);
  });
});
