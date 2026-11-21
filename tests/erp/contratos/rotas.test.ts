// Contratos pelo Worker (/erp-contratos): a parte nasce desligada e a rota
// recusa dizendo o que ligar (e que depende do Financeiro); ligada com o
// Financeiro, lista e busca, recusa filtro e cadastro incompletos e anexo que
// não é PDF; o bot sem concessão não lê nem grava e as operações só de tela
// recusam o bot; o módulo e o inventário dos bots
// conhecem os Contratos. Sem rede: área de ensaio com o cofre simulado (sem uso aqui).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpContratosRoute } from "../../../src/erp/contratos/routes.ts";
import { modules, resolveStates } from "../../../src/modules/registry";
import { ERP_BOT_OPERATIONS, erpBotInventory, erpBotModules } from "../../../src/modules/erp/bot-access";
import type { Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member, vaultArea } from "../emissor/helpers";

async function area(modulesOn: string[]) {
  const a = await vaultArea();
  for (const id of modulesOn) await setModule(a.profile, id, true, "teste");
  const call = async (who: Actor, method: string, sub: string, body?: unknown, raw?: BodyInit) => {
    const response = await erpContratosRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-contratos/${sub}`, {
      method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), headers: { "Content-Type": raw ? "application/pdf" : "application/json" },
    }), a.profile, who).catch((error: any) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { ...a, call, admin: await member("admin", a.profile) };
}

describe("Contratos pelo Worker", () => {
  it("módulo desligado por padrão, depende do Financeiro e entra no inventário dos bots", () => {
    const definition = modules.find((m) => m.id === "erp-contratos")!;
    expect(definition).toMatchObject({ default_enabled: false, requires: ["erp-financeiro"], routes: ["erp-contratos"] });
    expect(resolveStates({ erp: 1, "erp-contratos": 1 })["erp-contratos"]).toBe(false);
    const ops = ERP_BOT_OPERATIONS.filter((op) => op.group === "contratos");
    expect(ops.filter((op) => op.sensitive).map((op) => op.id).sort()).toEqual(["erp.contratos.ativar", "erp.contratos.encerrar", "erp.contratos.reajustar", "erp.contratos.suspender"]);
    expect(ops.filter((op) => !op.sensitive).every((op) => op.method === "GET")).toBe(true);
    expect(ops.map((op) => op.id)).toEqual(expect.arrayContaining(["erp.contratos.lista", "erp.contratos.ver", "erp.contratos.faturas"]));
    expect([...erpBotModules(ops[0])].sort()).toEqual(["erp", "erp-contratos", "erp-financeiro"]);
    const group = erpBotInventory({ erp: true }).groups.find((g) => g.id === "contratos")!;
    expect(group.title).toBe("Contratos de serviço");
    expect(group.operations.find((op) => op.id === "erp.contratos.faturas")).toMatchObject({ kind: "read", sensitive: false });
  });

  it("parte desligada: 409 module_disabled dizendo qual módulo ligar",{ timeout: 60_000 }, async () => {
    const { call, admin } = await area(["erp"]);
    const refused = await call(admin, "GET", "contratos");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("module_disabled");
    expect(refused.body.error.message).toMatch(/Contratos, que está desligado/);
    expect(refused.body.error.message).toMatch(/Gestão → Módulos/);
  });

  it("ligada: lista e busca, recusa filtro e cadastro incompletos e anexo que não é PDF; o bot sem concessão e as operações só de tela recusam o bot", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(["erp", "erp-financeiro", "erp-contratos"]);
    const empty = await call(admin, "GET", "contratos");
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body).toMatchObject({ items: [], can_write: true });
    const bad = await call(admin, "GET", "contratos?situacao=qualquer");
    expect(bad.status).toBe(400);
    const contact = await call(admin, "GET", "opcoes?busca=zz&tipo=clientes");
    expect(contact.status, JSON.stringify(contact.body)).toBe(200);
    const missing = await call(admin, "POST", "contratos", { objeto: "Sem cliente" });
    expect(missing.status).toBe(400);
    const bot = { ...admin, via: { bot_id: "b1", run_id: "r1" } } as Actor;
    const screenOnly = await call(bot, "POST", "indices", { indice: "ipca", mes: "2026-03", percentual: "4,5" });
    expect(screenOnly.status).toBe(403);
    const notGranted = await call(bot, "GET", "contratos");
    expect(notGranted.status).toBe(403);
    const pdf = await call(admin, "POST", "contratos/6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c/anexos?nome=contrato.pdf", undefined, "não é pdf");
    expect(pdf.status).toBe(415);
  });
});
