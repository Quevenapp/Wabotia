// Reforma tributária pelo Worker (/erp-reforma): com a parte Fiscal desligada
// a rota recusa dizendo o que ligar; ligada, lê e grava a configuração, lê o
// relatório e entrega o CSV; o bot fica de fora (só pela tela); o módulo
// Fiscal declara a rota. Sem rede: área de ensaio com o cofre simulado (sem
// uso aqui).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpReformaRoute } from "../../../src/erp/reforma/routes.ts";
import { modules } from "../../../src/modules/registry";
import type { Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { member, vaultArea } from "../emissor/helpers";

async function area(withFiscal: boolean) {
  const a = await vaultArea();
  await setModule(a.profile, "erp", true, "teste");
  await setModule(a.profile, "erp-fiscal", withFiscal, "teste");
  const call = async (who: Actor, method: string, sub: string, body?: unknown) => {
    const response = await erpReformaRoute(env, new Request(`https://wabotia.test/api/v1/profiles/${a.profile}/erp-reforma/${sub}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }), a.profile, who).catch((error: any) => Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 500 }));
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* CSV */ }
    return { status: response.status, body: json, text, type: response.headers.get("Content-Type") };
  };
  return { ...a, call, admin: await member("admin", a.profile) };
}

describe("Reforma tributária pelo Worker", () => {
  it("o módulo Fiscal declara a rota erp-reforma", () => {
    expect(modules.find((m) => m.id === "erp-fiscal")!.routes).toContain("erp-reforma");
  });

  it("parte Fiscal desligada: 409 module_disabled dizendo qual módulo ligar", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(false);
    const refused = await call(admin, "GET", "configuracao");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("module_disabled");
    expect(refused.body.error.message).toMatch(/Fiscal/);
  });

  it("ligada: configuração, relatório em JSON e CSV; o bot e rota desconhecida ficam de fora", { timeout: 60_000 }, async () => {
    const { call, admin } = await area(true);
    const view = await call(admin, "GET", "configuracao");
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({ version: 0, settings: { simples_regular: false, rates: {} }, vault: { known: false } });
    const saved = await call(admin, "POST", "configuracao", { simples_regular: true, aliquotas: { 2027: { cbs: "8.8" } }, versao: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, settings: { simples_regular: true, rates: { 2027: { cbs: "8.8" } } } });
    const stale = await call(admin, "POST", "configuracao", { simples_regular: false, versao: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/Atualize a tela/);
    const bad = await call(admin, "POST", "configuracao", { simples_regular: true, aliquotas: { 2027: { cbs: "200" } }, versao: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/percentuais de 0 a 100/);
    const report = await call(admin, "GET", "relatorio?de=2026-11-01&ate=2026-11-30");
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body).toMatchObject({ lines: [], without_reform: 0, totals: { notes: 0, cbs: "0.00" } });
    const csv = await call(admin, "GET", "relatorio?de=2026-11-01&ate=2026-11-30&formato=csv");
    expect(csv.status).toBe(200);
    expect(csv.type).toMatch(/text\/csv/);
    expect(csv.text).toContain("IBS, CBS e IS das NF-e autorizadas;01/11/2026 a 30/11/2026");
    const period = await call(admin, "GET", "relatorio?de=2026-11-30&ate=2026-11-01");
    expect(period.status).toBe(400);
    const bot = { ...admin, via: { bot_id: "b1", run_id: "r1" } } as Actor;
    expect((await call(bot, "GET", "configuracao")).status).toBe(403);
    expect((await call(admin, "GET", "qualquer")).status).toBe(404);
  });
});
