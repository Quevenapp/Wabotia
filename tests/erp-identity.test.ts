// Lado do núcleo do módulo `erp` (fase 3): papéis erp:<papel> no acesso por
// pessoa, envelope de identidade montado pelo Worker (papel, sessão, aal,
// fator e as pessoas da área) e uma ida ao D1 + uma ao objeto por requisição.
import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { exec } from "../src/db";
import { now, uid, type Actor } from "../src/types";
import { sha } from "../src/security";
import { accessCatalog, presetsFor, validateAccess } from "../src/access";
import { moduleStates } from "../src/modules/registry";
import { erpStub } from "../src/erp/hub";
import { erpRoleOf } from "../src/modules/erp/identity";
import { bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { countingEnv } from "./d1-counter";

async function setup() {
  const f = await fixture();
  await setModule(f.profile, "erp", true, f.admin.id);
  const tokenOf = async (actor: Actor) => {
    const token = await bearer(actor);
    await exec(
      env,
      "UPDATE sessions SET id=? WHERE hash=?",
      crypto.randomUUID(),
      await sha(token),
    );
    return token;
  };
  const call = async (token: string, path: string, init: RequestInit = {}) => {
    const { env: counted, count } = countingEnv(env);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://test/api/v1/profiles/${f.profile}/erp${path}`, {
        ...init,
        headers: {
          Authorization: "Bearer " + token,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      }),
      counted as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const timing = response.headers.get("Server-Timing") ?? "";
    return {
      status: response.status,
      body: await response.json<any>().catch(() => null),
      d1: count.calls,
      sql: count.sql,
      hops: Number(/erp;desc="hops=(\d+)"/.exec(timing)?.[1] ?? 0),
    };
  };
  const access = (id: string, list: string[] | null) =>
    exec(
      env,
      "UPDATE users SET access=? WHERE id=?",
      list && JSON.stringify(list),
      id,
    );
  return { f, tokenOf, call, access };
}

describe("papéis do ERP no acesso por pessoa", () => {
  it("seis papéis, um por pessoa; admin vale erp:admin; o * dá o módulo, nunca o papel", async () => {
    const roles = accessCatalog()
      .filter((i) => i.module_id === "erp" && i.role)
      .map((i) => i.id);
    expect(roles).toEqual([
      "erp:admin",
      "erp:consulta",
      "erp:vendas",
      "erp:financeiro",
      "erp:estoque",
      "erp:fiscal",
    ]);
    expect(() => validateAccess(["erp:vendas", "erp:financeiro"])).toThrow(
      /um só papel do ERP/,
    );
    expect(validateAccess(["*", "erp:vendas"])).toEqual(["*", "erp:vendas"]);
    const base = {
      kind: "user",
      scopes: [],
      bots: [],
      rate: 1,
      runLimit: 1,
      profiles: [],
      name: "P",
    } as const;
    expect(erpRoleOf({ ...base, id: "a", role: "admin" } as Actor)).toBe(
      "admin",
    );
    expect(
      erpRoleOf({ ...base, id: "b", role: "operator", access: ["*"] } as Actor),
    ).toBeNull();
    expect(
      erpRoleOf({ ...base, id: "c", role: "operator", access: null } as Actor),
    ).toBeNull();
    expect(
      erpRoleOf({
        ...base,
        id: "d",
        role: "operator",
        access: ["erp:estoque"],
      } as Actor),
    ).toBe("estoque");
    // Atalhos "ERP · …" só com o módulo ligado.
    const { f } = await setup();
    const on = presetsFor(
      accessCatalog(await moduleStates(env, f.profile)),
    ).map((p) => p.label);
    expect(on).toEqual(
      expect.arrayContaining(["ERP · Vendas", "ERP · Administração"]),
    );
    await setModule(f.profile, "erp", false, f.admin.id);
    const off = presetsFor(
      accessCatalog(await moduleStates(env, f.profile)),
    ).map((p) => p.label);
    expect(off.some((l) => l.startsWith("ERP"))).toBe(false);
  });
});

describe("envelope de identidade a partir do núcleo", () => {
  it(
    "sem papel, 403; papel trocado em Pessoas vale na requisição seguinte",
    { timeout: 120_000 },
    async () => {
      const { f, tokenOf, call, access } = await setup();
      const member = await tokenOf(f.member);
      // Atendente completo ("*"): alcança o módulo, mas não tem papel no ERP.
      await access(f.member.id, ["*"]);
      const none = await call(member, "/v1/me");
      expect(none.status).toBe(403);
      expect(none.body.error.code).toBe("erp_role_required");
      expect(none.hops).toBe(0);
      // Papel de vendas.
      await access(f.member.id, ["erp:vendas"]);
      const sales = await call(member, "/v1/me");
      expect(sales.status, JSON.stringify(sales.body)).toBe(200);
      expect(JSON.stringify(sales.body)).toContain("vendas");
      // Trocado para consulta em Pessoas: vale já na próxima requisição.
      await access(f.member.id, ["erp:consulta"]);
      const reader = await call(member, "/v1/me");
      expect(reader.status).toBe(200);
      expect(JSON.stringify(reader.body)).toContain("consulta");
      expect(JSON.stringify(reader.body)).not.toContain("vendas");
      // Sem o papel de novo: 403 antes do objeto, e o motor deixa a pessoa
      // inativa na próxima requisição de outra pessoa (projeção de people).
      await access(f.member.id, ["os"]);
      const gone = await call(member, "/v1/me");
      expect(gone.status).toBe(403);
      const admin = await tokenOf(f.admin);
      expect((await call(admin, "/v1/me")).status).toBe(200);
      const membership = await runInDurableObject(
        erpStub(env, f.profile),
        (_i: any, state: DurableObjectState) =>
          state.storage.sql
            .exec(
              `SELECT user_id, role, active FROM "erp_access__membership" WHERE user_id=?`,
              f.member.id,
            )
            .toArray(),
      );
      expect(membership.every((m: any) => !m.active)).toBe(true);
    },
  );

  it(
    "segundo fator do ERP: sessão aal1 no escopo recebe ERP_MFA_REQUIRED; depois do código, passa",
    { timeout: 120_000 },
    async () => {
      const { f, tokenOf, call } = await setup();
      const admin = await tokenOf(f.admin);
      expect((await call(admin, "/v1/me")).status).toBe(200);
      const t = String(BigInt(Date.now()) * 1000n);
      await runInDurableObject(
        erpStub(env, f.profile),
        (_i: any, state: DurableObjectState) => {
          state.storage.sql.exec(
            `INSERT INTO "erp_access__security_policy"(singleton, mfa_required, version, updated_at, updated_by) VALUES(1, 1, 1, ?, ?)`,
            t,
            f.admin.id,
          );
        },
      );
      const gated = await call(admin, "/v1/me");
      expect(gated.status).toBe(403);
      expect(gated.body.error.code).toBe("ERP_MFA_REQUIRED");
      expect(gated.hops).toBe(1);
      // O administrador cadastra o fator: só com o fator, a sessão ainda é
      // aal1 e o portão segue fechado.
      await exec(
        env,
        "INSERT INTO user_factors(id,user_id,kind,secret,status,created,activated_at) VALUES(?,?,'totp','x','active',?,?)",
        uid(),
        f.admin.id,
        now(),
        now(),
      );
      const factorOnly = await call(admin, "/v1/me");
      expect(factorOnly.status).toBe(403);
      expect(factorOnly.body.error.code).toBe("ERP_MFA_REQUIRED");
      // Como o /api/v1/account/mfa/challenge: a sessão sobe para aal2.
      await exec(
        env,
        "UPDATE sessions SET aal=2,mfa_at=? WHERE hash=?",
        now(),
        await sha(admin),
      );
      const core = await (
        await worker.fetch(
          new Request("https://test/api/v1/me", {
            headers: { Authorization: "Bearer " + admin },
          }),
          env as any,
          createExecutionContext(),
        )
      ).json<any>();
      // O núcleo vê a sessão confirmada.
      expect(core.aal).toBe(2);
      const passed = await call(admin, "/v1/me");
      expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    },
  );
});

describe("uma ida ao D1 e uma ao objeto por requisição do ERP", () => {
  it(
    "sessão, estado dos módulos e pessoas no mesmo lote",
    { timeout: 120_000 },
    async () => {
      const { f, tokenOf, call, access } = await setup();
      await access(f.member.id, ["erp:vendas"]);
      const member = await tokenOf(f.member);
      // A primeira requisição de pessoa do isolado grava o endereço público.
      await call(member, "/v1/me");
      for (const path of ["/v1/me", "/v1/plataforma/referencias/cnae?q=4744"]) {
        const r = await call(member, path);
        expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
        expect(r.d1, r.sql.join("\n")).toBe(1);
        // Sessão, estado dos módulos, pessoas e aplicações do ERP.
        expect(r.sql[0]).toMatch(/^batch\(4\)/);
        expect(r.hops).toBe(1);
      }
    },
  );
});
