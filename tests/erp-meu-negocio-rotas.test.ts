import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { exec } from "../src/db";
import { bearer, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";

const MONTHLY = "/v1/meu-negocio/mensal?de=2026-11-01&ate=2026-11-19&comparar_de=2026-10-01&comparar_ate=2026-10-19&situacoes=verified,in_progress,fulfilled";
async function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T15:00:00Z"));
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  const send = async (token: string, path: string, body?: unknown) => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request(`https://test/api/v1/profiles/${f.profile}/erp${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env as never, ctx);
    await waitOnExecutionContext(ctx);
    return { status: r.status, body: await r.json<any>() };
  };
  return { f, send, token: await bearer(f.admin) };
}

afterEach(() => vi.useRealTimers());
describe("Meu negócio pela rota real", () => {
  it("abre as leituras auxiliares e troca de painel e período", { timeout: 120_000 }, async () => {
    const { send, token } = await setup();
    for (const [path, scope] of [["/v1/preferencias/meu-negocio", "preferences_page"], ["/v1/sistema/permissoes", "user_permissions"], [MONTHLY, "business_dashboard"]]) {
      const r = await send(token, path);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (scope !== "user_permissions") expect(r.body.scope).toBe(scope);
      expect(r.body.data_mode).toBe("erp_native");
    }
    for (const panel of ["pedidos-venda", "vendas-vendedor", "margem-pedido", "novos-recorrentes", "curva-abc"]) {
      const r = await send(token, `/v1/meu-negocio/${panel}?de=2026-10-01&ate=2026-10-31&situacoes=verified,in_progress,fulfilled`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ panel, filters: { from: "2026-10-01", to: "2026-10-31" } });
    }
  });

  it("salva metas, lista e confere o comando", { timeout: 120_000 }, async () => {
    const { send, token } = await setup();
    const input = { command_id: crypto.randomUUID(), goal_id: null, expected_version: 0,
      data: { name: "Meta comercial", start_on: "2026-11-01", end_on: "2026-11-30", segment: "geral", seller: null, target: "1000.00", active: true } };
    const saved = await send(token, "/v1/meu-negocio/metas", input);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ replayed: false, goal: { name: "Meta comercial", target: "1000.00", version: 1 } });
    const list = await send(token, "/v1/meu-negocio/metas?aba=andamento");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((g: { id: string }) => g.id)).toContain(saved.body.goal.id);
    const checked = await send(token, "/v1/meu-negocio/metas/comandos/" + input.command_id);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body).toMatchObject({ replayed: true, receipt: { command_id: input.command_id } });
  });

  it("recusa pessoa sem papel e Vendas desligada", { timeout: 120_000 }, async () => {
    const { f, send, token } = await setup();
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["*"]), f.member.id);
    const denied = await send(await bearer(f.member), MONTHLY);
    expect(denied).toMatchObject({ status: 403, body: { error: { code: "erp_role_required" } } });
    await setModule(f.profile, "erp-vendas", false, f.admin.id);
    for (const path of [MONTHLY, "/v1/meu-negocio/metas", "/v1/preferencias/meu-negocio"]) {
      const off = await send(token, path);
      expect(off.status, JSON.stringify(off.body)).toBe(409);
      expect(off.body.error.code).toBe("module_disabled");
    }
  });
});
