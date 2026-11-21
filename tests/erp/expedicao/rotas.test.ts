// Expedição pelo Worker (/erp-expedicao): a parte nasce desligada e a rota
// recusa dizendo o que ligar; ligada com Vendas e Estoque, lista os pedidos e
// cadastra embalagem; a entrega local recusa com o módulo Entrega desligado;
// o bot sem concessão não grava; o módulo e o inventário dos bots conhecem a
// Expedição. Sem rede: área de ensaio com o cofre simulado (sem uso aqui).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpExpedicaoRoute } from "../../../src/erp/expedicao/routes.ts";
import { modules, resolveStates } from "../../../src/modules/registry";
import { ERP_BOT_OPERATIONS, erpBotInventory, erpBotModules } from "../../../src/modules/erp/bot-access";
import type { Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member, vaultArea } from "../emissor/helpers";

const BASE = ["erp", "erp-produtos", "erp-vendas", "erp-estoque"];
const ORDER = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c";

async function area(withShipping: boolean) {
  const a = await vaultArea();
  for (const id of BASE) await setModule(a.profile, id, true, "teste");
  if (withShipping) await setModule(a.profile, "erp-expedicao", true, "teste");
  const call = async (who: Actor, method: string, sub: string, body?: unknown) => {
    const response = await erpExpedicaoRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-expedicao/${sub}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), a.profile, who).catch((error: any) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { ...a, call, admin: await member("admin", a.profile) };
}

describe("Expedição pelo Worker", () => {
  it("módulo desligado por padrão, depende de Vendas e Estoque e entra no inventário dos bots", () => {
    const definition = modules.find((m) => m.id === "erp-expedicao")!;
    expect(definition).toMatchObject({ default_enabled: false, requires: ["erp-vendas", "erp-estoque"], routes: ["erp-expedicao"] });
    expect(resolveStates({ erp: 1, "erp-produtos": 1, "erp-vendas": 1, "erp-expedicao": 1 })["erp-expedicao"]).toBe(false);
    const ops = ERP_BOT_OPERATIONS.filter((op) => op.group === "expedicao");
    expect(ops.filter((op) => op.sensitive).map((op) => op.id).sort()).toEqual(["erp.expedicao.devolucao", "erp.expedicao.expedir", "erp.expedicao.separacao.gerar"]);
    expect(ops.filter((op) => !op.sensitive).every((op) => op.method === "GET")).toBe(true);
    expect([...erpBotModules(ops[0])].sort()).toEqual(["erp", "erp-estoque", "erp-expedicao", "erp-produtos", "erp-vendas"]);
    const group = erpBotInventory({ erp: true }).groups.find((g) => g.id === "expedicao")!;
    expect(group.title).toBe("Expedição");
    expect(group.operations.find((op) => op.id === "erp.expedicao.pedidos")).toMatchObject({ kind: "read", sensitive: false });
  });

  it("parte desligada: 409 module_disabled dizendo qual módulo ligar", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(false);
    const refused = await call(admin, "GET", "pedidos");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("module_disabled");
    expect(refused.body.error.message).toMatch(/Expedição, que está desligado/);
  });

  it("ligada: lista os pedidos, cadastra embalagem e a entrega local pede o módulo Entrega", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(true);
    const list = await call(admin, "GET", "pedidos?situacao=a_separar");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toMatchObject({ scope: "shipping_overview", items: [], can_write: true });
    const saved = await call(admin, "POST", "embalagens", { nome: "Caixa P", comprimento: "20", largura: "15", altura: "10", peso_vazio: "0,150" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.record).toMatchObject({ name: "Caixa P", length_mm: 200, empty_weight_g: 150 });
    const bad = await call(admin, "GET", "pedidos?situacao=qualquer");
    expect(bad.status).toBe(400);
    const delivery = await call(admin, "POST", `pedidos/${ORDER}/entrega-local`, {});
    expect(delivery.status).toBe(409);
    expect(delivery.body.error.message).toMatch(/módulo Entrega, que está desligado/);
    // Bot sem concessão não grava nem pela rota.
    const bot = { ...admin, via: { bot_id: "b1", run_id: "r1" } } as Actor;
    const denied = await call(bot, "POST", "separacoes", { pedidos: [ORDER] });
    expect(denied.status).toBe(403);
  });
});
