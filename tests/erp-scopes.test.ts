// Aplicações no ERP (escopos erp:read e erp:write) e identidades de sistema
// (src/modules/erp/identity.ts). A aplicação é um membro técnico do ERP com
// identidade própria, como o agente do Fagoo: papel próprio, sem sessão,
// is_agent, e o nome dela na atividade.
import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { all, exec } from "../src/db";
import { uid } from "../src/types";
import { perform } from "../src/service";
import { erpStub } from "../src/erp/hub";
import {
  appErpRole,
  erpIdentity,
  systemUserId,
} from "../src/modules/erp/identity";
import { application, bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

async function setup() {
  const f = await fixture();
  await setModule(f.profile, "erp", true, f.admin.id);
  const call = async (token: string, path: string, method = "GET") => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://test/api/v1/profiles/${f.profile}/erp${path}`, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        },
        ...(method === "GET" ? {} : { body: "{}" }),
      }),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return {
      status: response.status,
      body: await response.json<any>().catch(() => null),
    };
  };
  const members = () =>
    runInDurableObject(
      erpStub(env, f.profile),
      (_i: any, state: DurableObjectState) =>
        state.storage.sql
          .exec(
            `SELECT m.user_id, m.role, m.active, p.name FROM "erp_access__membership" m LEFT JOIN "erp_access__profile" p ON p.user_id=m.user_id`,
          )
          .toArray() as any[],
    );
  const update = (id: string, data: any) =>
    perform(
      env,
      f.admin,
      "_admin",
      "application.update",
      { id, ...data },
      uid(),
    );
  return { f, call, members, update };
}

describe("aplicações no ERP: escopos e papel", () => {
  it(
    "erp:read lê como consulta e não escreve; sem escopo do ERP, 403",
    { timeout: 120_000 },
    async () => {
      const { f, call, members } = await setup();
      const reader = await application(f, ["erp:read"]);
      const me = await call(reader.token, "/v1/me");
      expect(me.status, JSON.stringify(me.body)).toBe(200);
      expect(JSON.stringify(me.body)).toContain("consulta");
      // Escrita com erp:read: recusada no núcleo, antes do objeto.
      const write = await call(reader.token, "/v1/me", "POST");
      expect(write.status).toBe(403);
      expect(write.body.error.code).toBe("insufficient_scope");
      // Chave sem escopo do ERP.
      const other = await application(f, ["conversations:read"]);
      const denied = await call(other.token, "/v1/me");
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("insufficient_scope");
      // Membro técnico com o nome da aplicação (a atividade mostra esse nome).
      const row = (await members()).find((m) => m.user_id === reader.id);
      expect(row).toMatchObject({ role: "consulta", active: 1, name: "App" });
    },
  );

  it(
    "erp:write: sem papel, 403; papel escolhido vale; admin e financeiro recusados; troca na auditoria",
    { timeout: 120_000 },
    async () => {
      const { f, call, update } = await setup();
      const app = await application(f, ["erp:write"]);
      const none = await call(app.token, "/v1/me");
      expect(none.status).toBe(403);
      expect(none.body.error.code).toBe("erp_role_required");
      // Regra do Fagoo para agente: só consulta, vendas, estoque ou fiscal.
      for (const role of ["admin", "financeiro", "dono"])
        await expect(update(app.id, { erp_role: role })).rejects.toMatchObject({
          status: 400,
        });
      await update(app.id, { erp_role: "vendas" });
      const sales = await call(app.token, "/v1/me");
      expect(sales.status, JSON.stringify(sales.body)).toBe(200);
      expect(JSON.stringify(sales.body)).toContain("vendas");
      // Mudar outra coisa não mexe no papel; tirar o papel volta ao 403.
      await update(app.id, { scopes: ["erp:write"] });
      expect((await call(app.token, "/v1/me")).status).toBe(200);
      await update(app.id, { erp_role: null });
      expect((await call(app.token, "/v1/me")).status).toBe(403);
      // A troca de papel entra na auditoria do núcleo, com o papel novo.
      const audit = await all(
        env,
        "SELECT operation FROM audit WHERE resource_id=? AND operation LIKE 'application.erp_role:%' ORDER BY id",
        app.id,
      );
      expect(audit.map((a) => a.operation)).toEqual([
        "application.erp_role:vendas",
        "application.erp_role:nenhum",
      ]);
    },
  );

  it("identidade própria: nunca herda sessão nem aal2, e é agente", async () => {
    const { f } = await setup();
    const app = await application(f, ["erp:read"]);
    const identity = await erpIdentity(
      env,
      {
        id: `app:${app.id}`,
        kind: "app",
        name: "App",
        role: "service",
        profiles: [f.profile],
        scopes: ["erp:read"],
        bots: [],
        rate: 60,
        runLimit: 3,
        // Mesmo que algo ponha aal/sessão no ator, o envelope não usa.
        aal: 2,
        sessionId: crypto.randomUUID(),
      },
      f.profile,
      "GET",
    );
    expect(identity.actor).toMatchObject({
      user_id: app.id,
      erp_role: "consulta",
      session_id: null,
      aal: "aal1",
      verified_factor: false,
      is_agent: true,
    });
    expect(appErpRole(["erp:write"], "admin")).toBeNull();
    expect(appErpRole(["erp:read", "erp:write"], null)).toBeNull();
    expect(appErpRole(["erp:read"], null)).toBe("consulta");
  });

  it(
    "tirar o escopo ou desligar a aplicação: inativa no motor na requisição seguinte",
    { timeout: 120_000 },
    async () => {
      const { f, call, members, update } = await setup();
      const a = await application(f, ["erp:read"]);
      const b = await application(f, ["erp:read"]);
      expect((await call(a.token, "/v1/me")).status).toBe(200);
      expect((await call(b.token, "/v1/me")).status).toBe(200);
      const active = async (id: string) =>
        (await members()).find((m) => m.user_id === id)?.active;
      expect([await active(a.id), await active(b.id)]).toEqual([1, 1]);
      await update(a.id, { scopes: ["conversations:read"] });
      await update(b.id, { disabled: true });
      // A próxima requisição é de uma pessoa: as duas já saem da lista.
      const admin = await bearer(f.admin);
      await exec(
        env,
        "UPDATE sessions SET id=? WHERE hash=(SELECT hash FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT 1)",
        crypto.randomUUID(),
        f.admin.id,
      );
      expect((await call(admin, "/v1/me")).status).toBe(200);
      expect([await active(a.id), await active(b.id)]).toEqual([0, 0]);
    },
  );

  it(
    "identidade de sistema do núcleo: membro admin fixo, sempre na lista",
    { timeout: 120_000 },
    async () => {
      const { f, call, members } = await setup();
      const admin = await bearer(f.admin);
      await exec(
        env,
        "UPDATE sessions SET id=? WHERE hash=(SELECT hash FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT 1)",
        crypto.randomUUID(),
        f.admin.id,
      );
      expect((await call(admin, "/v1/me")).status).toBe(200);
      const id = await systemUserId("nucleo");
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(await systemUserId("nucleo")).toBe(id);
      expect((await members()).find((m) => m.user_id === id)).toMatchObject({
        role: "admin",
        active: 1,
        name: "Sistema · Wabotia",
      });
    },
  );
});
