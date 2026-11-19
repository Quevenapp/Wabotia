import { createExecutionContext, env, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { exec } from "../src/db";
import { routeAccess } from "../src/access";
import { fixture, bearer, application } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { countingEnv } from "./d1-counter";
import { erpIdentity, erpSystemIdentity } from "../src/modules/erp/identity";
import { readErpPartsState } from "../src/modules/erp/parts-state";
import { ERP_MODULE_IDS, normalizeErpParts } from "../src/erp/parts";
import { erpStub } from "../src/erp/hub";
import { migrate, storageDriver } from "../src/erp/hub-engine";
import { callRpc } from "../src/erp/engine/registry";
import { localFetch } from "../src/erp/api/local-fetch";
import { CUSTOMER_BRIDGE_SCAN, CUSTOMER_BRIDGE_USER_ID } from "../src/erp/engine/identity";
import { demoApi } from "../web/lib/demo";
import { MANAGEMENT_ITEMS, managementContext, managementEntryState, managementLanding, resolveManagement } from "../web/management/registry";
import * as definitions from "../src/modules/erp/definition";

describe("fase 2: aceitação da árvore reunida", () => {
  it("papel da Base autoriza leitura fiscal; ativação da parte e acesso nativo continuam independentes", async () => {
    const f = await fixture();
    await setModule(f.profile, "erp", true, f.admin.id);
    await setModule(f.profile, "erp-fiscal", true, f.admin.id);
    await setModule(f.profile, "os", true, f.admin.id);
    const tokenFor = async (access: string[]) => {
      await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(access), f.member.id);
      return bearer(f.member);
    };
    const get = (segment: string, token: string) => SELF.fetch(`https://test/api/v1/profiles/${f.profile}/${segment}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reader = await tokenFor(["erp:consulta"]);
    const read = await get("erp-emissor", reader);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ configured: false });
    await setModule(f.profile, "erp-fiscal", false, f.admin.id);
    const disabled = await get("erp-emissor", reader);
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ error: { code: "module_disabled" } });
    await setModule(f.profile, "erp-fiscal", true, f.admin.id);
    const nativeDenied = await get("service-orders", reader);
    expect(nativeDenied.status).toBe(403);
    expect(await nativeDenied.json()).toMatchObject({ error: { code: "access_denied" } });
    expect(routeAccess("service-orders")).toBe("os");
    const noErpRole = await tokenFor(["os"]);
    const denied = await get("erp-emissor", noErpRole);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "access_denied" } });
    const baseWithoutRole = await tokenFor(["erp", "os"]);
    const roleDenied = await get("erp-emissor", baseWithoutRole);
    expect(roleDenied.status).toBe(403);
    expect(await roleDenied.json()).toMatchObject({ error: { code: "erp_role_required" } });
    expect((await get("service-orders", baseWithoutRole)).status).toBe(200);
  }, 60_000);

  it("demonstração real mantém os cinco grupos e o PDV; Módulos usa os nomes e dependências registrados", async () => {
    const status = await demoApi("v1/profiles/demo/status"), modules = await demoApi("v1/profiles/demo/modules");
    const context = managementContext({ statusLoaded: true, modules: status.modules, role: "admin", access: null });
    const items = resolveManagement(MANAGEMENT_ITEMS, context, true);
    for (const id of ["erp-produtos", "erp-vendas", "erp-compras", "erp-estoque", "erp-financeiro", "erp-pdv"]) {
      expect(status.modules[id], id).toBe(true);
      expect(items.some(item => item.module === id), id).toBe(true);
    }
    for (const definition of Object.values(definitions)) {
      const demo = modules.data.find((item: any) => item.id === definition.id);
      expect(demo).toMatchObject({ name: definition.name, description: definition.description, requires: definition.requires });
      expect(demo.name + demo.description).not.toMatch(/fagoo/i);
    }
    expect(status.modules["erp-fiscal"]).toBe(false); expect(status.modules["erp-cobranca"]).toBe(false);
    const native = items.findIndex(item => item.target.kind === "ported");
    expect(items.slice(native).every(item => item.target.kind === "ported")).toBe(true);
    const onlyBase = managementContext({ statusLoaded: true, modules: { erp: true }, role: "admin", access: null });
    const baseItems = resolveManagement(MANAGEMENT_ITEMS, onlyBase, true);
    expect(managementLanding(baseItems)).toBe("/app/erp/cadastros-reais?cadastro=contacts");
    expect(managementEntryState(onlyBase, baseItems)).toBe("redirecting");
  });

  it("fotografia das nove partes usa o mesmo lote de autenticação e chega ao KV pelo único RPC", async () => {
    const f = await fixture(); await setModule(f.profile, "erp", true, f.admin.id);
    const token = await bearer(f.admin);
    // A primeira requisição registra o endereço público, como no teste antigo.
    const request = () => new Request(`https://test/api/v1/profiles/${f.profile}/erp/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
    await SELF.fetch(request());
    for (const enabled of [true, false]) {
      await setModule(f.profile, "erp-financeiro", enabled, f.admin.id);
      const { env: counted, count } = countingEnv(env), ctx = createExecutionContext();
      const response = await worker.fetch(request(), counted as any, ctx); await waitOnExecutionContext(ctx);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(count.calls, count.sql.join("\n")).toBe(1);
      expect(count.sql[0]).toMatch(/^batch\(4\)/);
      expect(response.headers.get("Server-Timing")).toContain('hops=1');
      const saved = await runInDurableObject(erpStub(env, f.profile), (_instance: any, state: DurableObjectState) => state.storage.get<any>("erp_parts"));
      expect(saved.parts.finance).toBe(enabled); expect(Object.keys(saved.parts)).toHaveLength(9);
      expect(saved.revision).toBe((await readErpPartsState(env, f.profile)).snapshot.revision);
    }
  });

  it("aplicação e cadastro único recebem Base explícita; não herdam partes nem acesso ampliado", async () => {
    const f = await fixture(); await setModule(f.profile, "erp", true, f.admin.id);
    const app = await application(f, ["erp:read"]);
    const get = (path: string) => SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp${path}`, { headers: { Authorization: `Bearer ${app.token}` } });
    expect((await get("/v1/cadastros/contatos")).status).toBe(200);
    const denied = await get("/v1/cadastros/products"); expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { code: "module_disabled" } });
    const identity = await erpSystemIdentity(env, f.profile, "contact-erp-link");
    expect(identity.actor?.user_id).toBe(CUSTOMER_BRIDGE_USER_ID);
    expect(identity.parts).toEqual(normalizeErpParts({ products: false, sales: false, purchases: false, stock: false, finance: false, fiscal: false, billing: false, pos: false }));
    const rpc = localFetch(env, f.profile, f.admin, identity, { read: true, trackCustomers: false });
    const scan = await rpc(`https://erp.wabotia.invalid/rest/v1/rpc/${CUSTOMER_BRIDGE_SCAN}`, {
      method: "POST", body: JSON.stringify({ p_user_id: CUSTOMER_BRIDGE_USER_ID, p_after: "", p_limit: 20 }),
    });
    expect(scan.status, await scan.clone().text()).toBe(200);
    const forbidden = await rpc("https://erp.wabotia.invalid/rest/v1/rpc/erp_home_overview", {
      method: "POST", body: JSON.stringify({ p_user_id: CUSTOMER_BRIDGE_USER_ID, p_period: "hoje" }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("referência persistida suspensa vira module_disabled público, antes do parser e sem apagar a definição", async () => {
    const f = await fixture(); await setModule(f.profile, "erp", true, f.admin.id);
    const identity = await erpIdentity(env, f.admin, f.profile);
    const id = await runInDurableObject(erpStub(env, f.profile), (_instance: any, state: DurableObjectState) => {
      migrate(state.storage);
      const result = callRpc(storageDriver(state.storage), "erp_preferences_report_save", {
        p_user_id: f.admin.id, p_report: null, p_expected_version: 0, p_command_id: crypto.randomUUID(),
        p_data: { base: "contas_receber", title: "Recebíveis", columns: ["contato"], filters: [], view_limit: 20, with_totals: false, users: [] },
      }, undefined, { identity, parts: normalizeErpParts() }) as any;
      return result.receipt.target as string;
    });
    const token = await bearer(f.admin);
    const response = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp/v1/sistema/relatorios/execucao`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ report_id: id, base: "contatos", columns: ["nome"], filters: [], view_limit: 20, page: 20, offset: 0 }),
    });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "module_disabled", message: "Esta rotina depende de uma parte desligada." } });
    const reports = await runInDurableObject(erpStub(env, f.profile), (_instance: any, state: DurableObjectState) =>
      state.storage.sql.exec("SELECT base FROM erp_preferences__report WHERE id=?", id).toArray());
    expect(reports).toEqual([{ base: "contas_receber" }]);
    expect(ERP_MODULE_IDS).toHaveLength(9);
  });
});
