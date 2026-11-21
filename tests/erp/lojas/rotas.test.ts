// Lojas pelo Worker (/erp-lojas): com o ERP desligado a rota recusa dizendo o
// que ligar; ligado, a primeira leitura cria a loja principal (uma loja só,
// nada a mais), o administrador cadastra a segunda loja e a comparação
// responde com as duas; o bot sem concessão não grava; o inventário dos bots
// conhece as leituras das lojas. Sem rede: área de ensaio (cofre simulado, sem uso aqui).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpLojasRoute } from "../../../src/erp/lojas/routes.ts";
import { ERP_BOT_OPERATIONS, erpBotInventory, erpBotModules } from "../../../src/modules/erp/bot-access";
import type { Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member, vaultArea } from "../emissor/helpers";

async function area(withErp: boolean) {
  const a = await vaultArea();
  if (withErp) for (const id of ["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"]) await setModule(a.profile, id, true, "teste");
  const call = async (who: Actor, method: string, sub: string, body?: unknown) => {
    const response = await erpLojasRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-lojas${sub}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), a.profile, who).catch((error: any) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }));
    return { status: response.status, body: await response.json<any>() };
  };
  return { ...a, call, admin: await member("admin", a.profile) };
}

describe("Lojas pelo Worker", () => {
  it("inventário dos bots: ver e comparar lojas são leituras da Base; a lista de operações é sensível", () => {
    const ops = ERP_BOT_OPERATIONS.filter((op) => op.group === "lojas");
    expect(ops.map((op) => op.id).sort()).toEqual(["erp.lojas.listar", "erp.lojas.operacoes", "erp.lojas.relatorio"]);
    expect(ops.every((op) => op.method === "GET")).toBe(true);
    expect([...erpBotModules(ops[0])]).toEqual(["erp"]);
    const group = erpBotInventory({ erp: true }).groups.find((g) => g.id === "lojas")!;
    expect(group.title).toBe("Lojas e filiais");
    expect(group.operations.find((op) => op.id === "erp.lojas.operacoes")).toMatchObject({ kind: "read", sensitive: true });
  });

  it("ERP desligado: recusa dizendo o que ligar", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(false);
    const refused = await call(admin, "GET", "");
    expect([403, 409]).toContain(refused.status);
  });

  it("uma loja, depois duas: a principal nasce sozinha, a segunda é cadastrada e as duas são comparadas", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(true);
    const first = await call(admin, "GET", "");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ scope: "erp_stores", multi: false, admin: true });
    expect(first.body.stores).toHaveLength(1);
    expect(first.body.stores[0].is_main).toBe(true);
    const saved = await call(admin, "POST", "", { nome: "Quiosque do shopping", endereco: { cidade: "Santos" } });
    expect(saved.status).toBe(400);
    expect(saved.body.error.message).toMatch(/Confira o endereço da loja/);
    const ok = await call(admin, "POST", "", { nome: "Quiosque do shopping", endereco: { city: "Santos", state: "SP" }, telefone: "(13) 99999-0000" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.store).toMatchObject({ name: "Quiosque do shopping", is_main: false, phone: "13999990000" });
    const again = await call(admin, "POST", "", { nome: "quiosque do SHOPPING" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/Já existe uma loja com este nome/);
    const now = await call(admin, "GET", "");
    expect(now.body.multi).toBe(true);
    const report = await call(admin, "GET", "/relatorio?de=2026-11-01&ate=2026-11-30");
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.stores).toHaveLength(2);
    expect(report.body.sales.orders.total).toBe("0");
    const missing = await call(admin, "GET", "/relatorio?de=2026-11-01");
    expect(missing.status).toBe(400);
    // Bot sem concessão não grava nem pela rota.
    const bot = { ...admin, via: { bot_id: "b1", run_id: "r1" } } as Actor;
    const denied = await call(bot, "POST", "/em-uso", { loja: null });
    expect(denied.status).toBe(403);
  });
});
