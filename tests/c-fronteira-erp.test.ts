import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { exec, one, withReadCache } from "../src/db";
import { now, uid, type Env } from "../src/types";
import { eraseContact } from "../src/customer/http";
import { erpApi, localFetch } from "../src/erp/api/local-fetch";
import { customerProvider } from "../src/customer/ports";
import { erpCustomerProvider } from "../src/modules/erp/customer-provider";
import { erpFetch, erpStub } from "../src/erp/hub";
import { erpIdentity, erpSystemIdentity } from "../src/modules/erp/identity";
import { moduleEnabled } from "../src/modules/registry";
import { CUSTOMER_BRIDGE_SCAN, CUSTOMER_BRIDGE_USER_ID, encodeIdentity, GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, type IdentityPort } from "../src/erp/engine/identity";
import { storageDriver } from "../src/erp/engine/driver";
import { handleRpc } from "../src/erp/engine/rpc-endpoint";
import { contactScope } from "../src/erp/domains/catalog/contact";
import { sellerAccessAllowed, sellerUsers } from "../src/erp/domains/catalog/seller";
import { fixture, type Fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

const LOCAL = "https://erp.wabotia.invalid/rest/v1/rpc/";
it("a costura registra e encaminha a autorização da ficha ERP", async () => {
  const authorize = vi.spyOn(erpCustomerProvider, "authorizeProfile").mockResolvedValue(undefined);
  try {
    const ctx = { profile: "area" } as any, actor = { id: "person" } as any;
    const provider = customerProvider("erp");
    expect(provider?.authorizeProfile).toBeTypeOf("function");
    await provider!.authorizeProfile!(ctx, actor, "contact");
    expect(authorize).toHaveBeenCalledExactlyOnceWith(ctx, actor, "contact");
    expect(provider?.list).toBeTypeOf("function");
    expect(provider?.maintain).toBeTypeOf("function");
  } finally { authorize.mockRestore(); }
});
const SETTINGS = {
  user_id: null, allow_unregistered_products: false, view_stock: false, access_hours_enabled: false, access_windows: [], modules: {},
  commission_rule: "parcial", commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null,
};
async function setup() {
  const f = await fixture();
  await setModule(f.profile, "erp", true, f.admin.id);
  return f;
}
async function rpc(f: Fixture, name: string, args: Record<string, unknown>, options: {
  transport?: Env; identity?: IdentityPort; direct?: boolean; headers?: HeadersInit;
} = {}) {
  const identity = options.identity ?? await erpIdentity(env, f.admin, f.profile);
  const body = JSON.stringify({ p_user_id: identity.actor!.user_id, ...args });
  const response = options.direct
    ? await erpFetch(options.transport ?? env, f.profile, `/erp-rpc/${name}`, {
      method: "POST", body, headers: { [IDENTITY_HEADER]: encodeIdentity(identity), [GATE_HEADER]: "1", [SYSTEM_HEADER]: "1" },
    })
    : await localFetch(options.transport ?? env, f.profile, f.admin, identity, {
      read: !args.p_command_id, trackCustomers: false, gate: { denied: null },
    })(LOCAL + name, { method: "POST", body, headers: options.headers });
  return { status: response.status, body: await response.json<any>() };
}
const createArgs = (name: string, extra = {}) => ({
  p_id: null, p_expected_version: 0, p_command_id: uid(), p_data: { name, ...extra }, p_acknowledged: [],
});
async function save(f: Fixture, name: string, extra = {}) {
  const result = await rpc(f, "erp_catalog_contact_save", createArgs(name, extra));
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.record;
}
async function associate(f: Fixture, record: any) {
  const id = uid();
  await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated,erp_contact_id,erp_version)
    VALUES(?,?,'team',?,?,'','manual',?,?,?,?,?,?)`, id, f.profile, record.name, record.phone ?? "", f.admin.id, f.admin.id,
  now(), now(), record.id, record.version);
  return id;
}
async function erase(f: Fixture, id: string) {
  const row = await one<any>(env, "SELECT version FROM contacts WHERE id=?", id);
  await eraseContact(env, f.admin, f.profile, id, { expectedVersion: row.version, confirm: true, reason: "Pedido de exclusão do titular" }, uid());
}
// Apenas intercepta o transporte; todos os RPCs, transações, filtros e recibos
// continuam sendo os reais. Permite mudar D1 enquanto uma resposta está em voo.
function observed(hook: (send: () => Promise<Response>, name: string, body: string) => Promise<Response>) {
  const bodies: string[] = [];
  const COORDINATOR = new Proxy(env.COORDINATOR, { get(target, prop) {
    if (prop === "get") return (...args: any[]) => {
      const stub = (target.get as any)(...args);
      return new Proxy(stub, { get(s, key) {
        if (key === "fetch") return (input: string, init: RequestInit) => {
          const body = String(init.body);
          bodies.push(body);
          return hook(() => s.fetch(input, init), new URL(input).pathname.split("/").at(-1)!, body);
        };
        const value = Reflect.get(s, key); return typeof value === "function" ? value.bind(s) : value;
      } });
    };
    const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { env: { ...env, COORDINATOR } as Env, bodies };
}

describe("fronteira ERP: restrição, executor e transporte", () => {
  it("S5: exclusão bloqueia GET e filtra lista, seletor e exportação antes do limite; ativo continua legível", async () => {
    const f = await setup();
    const hidden = await save(f, "A restrito", { phone: "5511998765432" });
    const active = await save(f, "Z autorizado", { phone: "5521987654321" });
    await associate(f, active);
    await erase(f, await associate(f, hidden));
    const blocked = await rpc(f, "erp_catalog_contact_get", { p_id: hidden.id });
    expect(blocked.status).toBe(403);
    expect(JSON.stringify(blocked.body)).not.toContain(hidden.name);
    expect((await rpc(f, "erp_catalog_contact_get", { p_id: active.id })).body.record.name).toBe(active.name);
    for (const name of ["erp_catalog_contact_page", "erp_catalog_contact_page_tagged"]) {
      const page = await rpc(f, name, { p_page: 1, p_size: 1, p_sort: "name_asc", p_situation: "all" });
      expect(page.status).toBe(200);
      expect(page.body.total).toBe(1);
      expect(page.body.items.map((r: any) => r.id)).toEqual([active.id]);
    }
    const options = await rpc(f, "erp_catalog_contact_options", { p_limit: 1 });
    expect(options.status).toBe(200);
    expect(options.body.has_more).toBe(false);
    expect(options.body.items.map((r: any) => r.id)).toEqual([active.id]);
    for (const name of ["erp_catalog_contact_export", "erp_catalog_contact_export_tagged"]) {
      const exported = await rpc(f, name, { p_kind: "contacts", p_offset: 0, p_limit: 1, p_sort: "name_asc", p_situation: "all" });
      expect(exported.status).toBe(200);
      expect(exported.body.total).toBe(1);
      expect(exported.body.items.map((r: any) => r.id)).toEqual([active.id]);
    }
    expect((await rpc(f, "erp_catalog_contact_labels", { p_ids: [hidden.id, active.id] })).status).toBe(403);
    const labels = await rpc(f, "erp_catalog_contact_labels", { p_ids: [active.id] });
    expect(labels.status).toBe(200);
    expect(labels.body.items[0].values.nome).toBe(active.name);
    // A coleção legada e o ZIP integral não têm projeção segura.
    expect((await rpc(f, "erp_catalog_page", { p_entity: "contacts", p_page: 1, p_size: 1, p_sort: "name_asc" })).status).toBe(403);
    expect((await rpc(f, "erp_platform_export_request", { p_command_id: uid() })).status).toBe(403);
    const system = await erpSystemIdentity(env, f.profile, "contact-erp-link");
    const scan = await rpc(f, CUSTOMER_BRIDGE_SCAN, { p_after: "", p_limit: 20 }, { identity: system });
    expect(scan.status).toBe(200);
    expect(scan.body.items.map((r: any) => r.id)).toEqual([active.id]);
    expect(scan.body.nextCursor).toBeNull();
    // Cursor não é uma referência que libera dados: a varredura pode avançar
    // mesmo se a última ficha da rodada anterior acabou de ser restringida.
    expect((await rpc(f, CUSTOMER_BRIDGE_SCAN, { p_after: hidden.id, p_limit: 20 }, { identity: system })).status).toBe(200);
    const signed = await localFetch(env, f.profile, f.admin)(
      `https://erp.wabotia.invalid/storage/v1/object/sign/brufap-exports/exports/${uid()}/${"a".repeat(64)}.zip`,
      { method: "POST", body: JSON.stringify({ expiresIn: 120 }) },
    );
    expect(signed.status).toBe(403);
    // O registro retido permanece no objeto.
    const retained = await rpc(f, "erp_catalog_contact_get", { p_id: hidden.id }, { direct: true });
    expect(retained.body.record.id).toBe(hidden.id);
  }, 120_000);

  it("S5: cabeçalhos externos não forjam política nem identidade na rota HTTP", async () => {
    const f = await setup(), hidden = await save(f, "Titular restrito"), active = await save(f, "Titular ativo");
    await erase(f, await associate(f, hidden));
    const identity = await erpIdentity(env, f.admin, f.profile);
    const forged = encodeIdentity({ ...identity, customer_privacy: { restricted_contact_ids: [] } });
    const request = (id: string) => erpApi(env, new Request(`https://test/api/v1/profiles/${f.profile}/erp/v1/cadastros/contatos/${id}`, {
      headers: { [IDENTITY_HEADER]: forged, [SYSTEM_HEADER]: "1", "x-erp-customer-privacy": "[]" },
    }), f.profile, f.admin, identity);
    expect((await request(hidden.id)).status).toBe(403);
    expect((await request(active.id)).status).toBe(200);
  }, 120_000);

  it("S5: recibo de criação e comando de transportadora não contornam a restrição", async () => {
    const f = await setup(), command = createArgs("Resposta anterior à exclusão");
    const saved = await rpc(f, "erp_catalog_contact_save", command);
    const carrier = { p_contact_id: saved.body.record.id, p_carrier: true, p_command_id: uid() };
    expect((await rpc(f, "erp_catalog_contact_carrier_complement", carrier)).status).toBe(200);
    await erase(f, await associate(f, saved.body.record));
    const replay = await rpc(f, "erp_catalog_contact_save", command);
    expect(replay.status).toBe(403);
    expect(JSON.stringify(replay.body)).not.toContain(command.p_data.name);
    expect((await rpc(f, "erp_catalog_contact_carrier_complement", carrier)).status).toBe(403);
    // Defesa interna também revalida recibos antes de devolvê-los.
    const identity = await erpIdentity(env, f.admin, f.profile);
    identity.customer_privacy = { restricted_contact_ids: [saved.body.record.id] };
    expect((await rpc(f, "erp_catalog_contact_save", command, { direct: true, identity })).status).toBe(403);
  }, 120_000);

  it("S5: exclusão durante o retorno bloqueia ficha, página, etiquetas e exportação já calculadas", async () => {
    for (const name of ["erp_catalog_contact_get", "erp_catalog_contact_page", "erp_catalog_contact_labels", "erp_catalog_contact_export"]) {
      const f = await setup(), record = await save(f, "Não pode sair atrasado"), id = await associate(f, record);
      const transport = observed(async (send) => { const response = await send(); await erase(f, id); return response; });
      const args = name.endsWith("_get") ? { p_id: record.id } : name.endsWith("_labels") ? { p_ids: [record.id] } :
        name.endsWith("_export") ? { p_kind: "contacts", p_offset: 0, p_limit: 10, p_sort: "name_asc", p_situation: "all" } :
          { p_page: 1, p_size: 10, p_sort: "name_asc", p_situation: "all" };
      const response = await rpc(f, name, args, { transport: transport.env });
      expect(response.status, name).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain(record.name);
    }
  }, 120_000);

  it("P11: identidades técnicas ficam fora das opções e save direto de vendedor é recusado pelo ID", async () => {
    const f = await setup();
    const identity = await erpIdentity(env, f.admin, f.profile);
    // Humano com nome Sistema continua humano; executor renomeado continua técnico.
    identity.people!.push({ user_id: f.member.id, name: "Sistema", email: null, erp_role: "vendas", verified_factor: false });
    const app = uid();
    identity.people!.push({ user_id: app, name: "Integração", email: null, erp_role: "vendas", verified_factor: false, is_technical: true });
    identity.people!.find((p) => p.user_id === CUSTOMER_BRIDGE_USER_ID)!.name = "Cadastro";
    const options = await rpc(f, "erp_catalog_seller_options", {}, { identity });
    expect(options.status).toBe(200);
    expect(options.body.users.some((p: any) => p.user_id === CUSTOMER_BRIDGE_USER_ID)).toBe(false);
    expect(options.body.users.some((p: any) => p.user_id === app)).toBe(false);
    expect(options.body.users.some((p: any) => p.user_id === f.member.id)).toBe(true);
    const input = { p_id: null, p_expected_version: 0, p_contact_expected_version: 0, p_command_id: uid(),
      p_contact: { name: "Vendedor técnico proibido" }, p_settings: { ...SETTINGS, user_id: CUSTOMER_BRIDGE_USER_ID }, p_acknowledged: [] };
    const denied = await rpc(f, "erp_catalog_seller_save", input, { identity, direct: true });
    expect(denied.status).toBe(400);
    expect(denied.body.message).toBe("erp_catalog_seller_invalid:user_id");
    const persisted = { ...identity, people: null };
    const appDenied = await rpc(f, "erp_catalog_seller_save", {
      ...input, p_command_id: uid(), p_settings: { ...SETTINGS, user_id: app },
    }, { identity: persisted, direct: true });
    expect(appDenied.status).toBe(400);
    expect(appDenied.body.message).toBe("erp_catalog_seller_invalid:user_id");
    const count = await runInDurableObject(erpStub(env, f.profile), (_instance, state) =>
      state.storage.sql.exec("SELECT count(*) n FROM erp_catalog__record WHERE entity='contacts'").one().n);
    expect(count).toBe(0); // a transação também desfez o contato criado pelo formulário
  }, 120_000);

  it("P11: envelope sem fotografia falha fechado sem carregar opções ou gravar vendedor", async () => {
    const f = await setup();
    const complete = await erpIdentity(env, f.admin, f.profile);
    const identity = { actor: complete.actor, people: null };
    const options = await rpc(f, "erp_catalog_seller_options", {}, { identity, direct: true });
    expect(options.status).toBe(503);
    expect(options.body.code).toBe("erp_parts_unavailable");
    expect(options.body.users).toBeUndefined();
    const read = vi.fn(() => { throw new Error("Não deve carregar opções sem fotografia"); });
    const blocked = await handleRpc({ storage: { sql: { exec: read } } } as unknown as DurableObjectState,
      f.profile, "erp_catalog_seller_options", new Request("https://internal/erp-rpc/erp_catalog_seller_options", {
        method: "POST", headers: { [IDENTITY_HEADER]: encodeIdentity(identity) },
        body: JSON.stringify({ p_user_id: f.admin.id }),
      }));
    expect(blocked.status).toBe(503);
    expect(read).not.toHaveBeenCalled();
    const denied = await rpc(f, "erp_catalog_seller_save", {
      p_id: null, p_expected_version: 0, p_contact_expected_version: 0, p_command_id: uid(),
      p_contact: { name: "Não gravar" }, p_settings: SETTINGS, p_acknowledged: [],
    }, { identity, direct: true });
    expect(denied.status).toBe(503);
    expect(denied.body.code).toBe("erp_parts_unavailable");
    const stored = await runInDurableObject(erpStub(env, f.profile), (_instance, state) =>
      Object.fromEntries(["record", "seller", "command"].map(table => [table,
        state.storage.sql.exec(`SELECT * FROM erp_catalog__${table}`).toArray()])));
    expect(stored).toEqual({ record: [], seller: [], command: [] });
  }, 120_000);

  it("P11: vínculo técnico preexistente não impõe carteira/horário; humano permanece restrito", async () => {
    const f = await setup();
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["erp:vendas"]), f.member.id);
    const settings = { ...SETTINGS, user_id: f.member.id, access_hours_enabled: true, access_windows: [{ start: "08:00", end: "09:00", days: [1] }] };
    const seller = await rpc(f, "erp_catalog_seller_save", { p_id: null, p_expected_version: 0, p_contact_expected_version: 0,
      p_command_id: uid(), p_contact: { name: "Vendedor legado" }, p_settings: settings, p_acknowledged: [] });
    expect(seller.status).toBe(200);
    const page = await rpc(f, "erp_preferences_page", { p_page: "cadastros-contatos" });
    const preference = page.body.items.find((p: any) => p.key === "contatos.acesso_vendedor");
    expect((await rpc(f, "erp_preferences_save", { p_page: "cadastros-contatos", p_command_id: uid(),
      p_changes: [{ key: preference.key, expected_version: preference.version, value: true }] })).status).toBe(200);
    const record = await save(f, "Fora da carteira");
    const state = await runInDurableObject(erpStub(env, f.profile), (_instance, state) => {
      const db = storageDriver(state.storage), at = BigInt(Date.parse("2026-11-17T18:00:00Z")) * 1000n;
      const human = { scope: contactScope(db, f.member.id), allowed: sellerAccessAllowed(db, f.member.id, at) };
      state.storage.sql.exec("UPDATE erp_catalog__seller SET user_id=? WHERE id=?", CUSTOMER_BRIDGE_USER_ID, seller.body.seller.id);
      return { human, technical: { scope: contactScope(db, CUSTOMER_BRIDGE_USER_ID), allowed: sellerAccessAllowed(db, CUSTOMER_BRIDGE_USER_ID, at) },
        users: sellerUsers(db).map((u) => u.user_id) };
    });
    expect(state.human).toEqual({ scope: seller.body.seller.id, allowed: false });
    expect(state.technical).toEqual({ scope: null, allowed: true });
    expect(state.users).not.toContain(CUSTOMER_BRIDGE_USER_ID);
    const identity = await erpSystemIdentity(env, f.profile, "contact-erp-link");
    expect((await rpc(f, "erp_catalog_contact_get", { p_id: record.id }, { identity })).status).toBe(200);
    expect((await rpc(f, "erp_catalog_seller_options", {}, { identity })).status).toBe(403);
  }, 120_000);

  it("P12: concorrente entre check/save causa conflito na transação, sem segunda ficha nem recibo", async () => {
    const f = await setup(), identity = await erpSystemIdentity(env, f.profile, "contact-erp-link");
    const input = createArgs("Promoção", { phone: "5511998765432", roles: ["customer"] });
    expect((await rpc(f, "erp_catalog_contact_check", { p_id: null, p_data: input.p_data }, { identity })).body.warnings).toEqual([]);
    const competing = await save(f, "Concorrente", { mobile: "+55 (11) 99876-5432" });
    const result = await rpc(f, "erp_catalog_contact_save", input, { identity });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "40001", message: "erp_catalog_contact_command_conflict:duplicate_phone" });
    const stored = await runInDurableObject(erpStub(env, f.profile), (_instance, state) => ({
      ids: state.storage.sql.exec("SELECT id FROM erp_catalog__record WHERE entity='contacts'").toArray().map((r) => r.id),
      receipts: state.storage.sql.exec("SELECT count(*) n FROM erp_catalog__command WHERE command_id=?", input.p_command_id).one().n,
    }));
    expect(stored).toEqual({ ids: [competing.id], receipts: 0 });
    // A regra é da promoção técnica, não uma unicidade geral de telefone.
    expect((await save(f, "Humano pode cadastrar", { phone: "5511998765432" })).id).not.toBe(competing.id);
    const other = createArgs("Sem candidato", { phone: "5521987654321", roles: ["customer"] });
    expect((await rpc(f, "erp_catalog_contact_save", other, { identity })).status).toBe(200);
    expect((await rpc(f, "erp_catalog_contact_save", other, { identity })).body.replayed).toBe(true);
  }, 120_000);

  it("P-AC2: desligar após falha impede segunda chamada e conserva corpo/ID para retomada", async () => {
    const f = await setup(), identity = await erpIdentity(env, f.admin, f.profile), input = createArgs("Retomada autorizada");
    let fail = true;
    const transport = observed(async (send) => {
      if (fail) { fail = false; await setModule(f.profile, "erp", false, f.admin.id); throw Object.assign(new Error("stub reiniciado"), { retryable: true }); }
      return send();
    });
    const cached = withReadCache(transport.env);
    expect(await moduleEnabled(cached, f.profile, "erp")).toBe(true);
    await expect(rpc(f, "erp_catalog_contact_save", input, { transport: cached, identity })).rejects.toMatchObject({ code: "module_disabled" });
    expect(transport.bodies).toHaveLength(1);
    await setModule(f.profile, "erp", true, f.admin.id);
    expect((await rpc(f, "erp_catalog_contact_save", input, { transport: cached, identity })).status).toBe(200);
    expect(transport.bodies).toHaveLength(2);
    expect(transport.bodies[0]).toBe(transport.bodies[1]);
  }, 120_000);

  it("P-AC2: retorno sensível exige ativação fresca mesmo com cache preenchido", async () => {
    const f = await setup(), record = await save(f, "Resposta em trânsito");
    const identity = await erpIdentity(env, f.admin, f.profile);
    const transport = observed(async (send) => { const response = await send(); await setModule(f.profile, "erp", false, f.admin.id); return response; });
    const cached = withReadCache(transport.env);
    expect(await moduleEnabled(cached, f.profile, "erp")).toBe(true);
    await expect(rpc(f, "erp_catalog_contact_get", { p_id: record.id }, { transport: cached, identity })).rejects.toMatchObject({ code: "module_disabled" });
    expect(transport.bodies).toHaveLength(1);
    await expect(rpc(f, "erp_catalog_contact_get", { p_id: record.id }, { transport: cached, identity })).rejects.toMatchObject({ code: "module_disabled" });
    expect(transport.bodies).toHaveLength(1);
  }, 120_000);

  it("P-AC2: até a leitura de metadados revalida a ativação antes de repetir", async () => {
    const f = await setup(), identity = await erpIdentity(env, f.admin, f.profile);
    const transport = observed(async () => {
      await setModule(f.profile, "erp", false, f.admin.id);
      throw Object.assign(new Error("stub reiniciado"), { retryable: true });
    });
    const cached = withReadCache(transport.env);
    expect(await moduleEnabled(cached, f.profile, "erp")).toBe(true);
    const response = await erpApi(cached, new Request(`https://test/api/v1/profiles/${f.profile}/erp/v1/me`),
      f.profile, f.admin, identity);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(transport.bodies).toHaveLength(1);
  }, 120_000);
});
