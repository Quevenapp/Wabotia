// Leituras ao D1 antes da rota (docs/LIMITES.md): cada ida ao banco é uma
// viagem da borda até o D1. A credencial, a política do segundo fator e, numa
// rota de área, o estado dos módulos saem numa ida só (db.batch). Nada de
// sessão ou permissão fica em cache entre requisições: a revogação vale na
// hora.
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { exec } from "../src/db";
import { now, uid } from "../src/types";
import { perform } from "../src/service";
import { sha } from "../src/security";
import { application, bearer, fixture } from "./service-center-fixture";
import { countingEnv } from "./d1-counter";

async function cookie(userId: string) {
  const token = uid() + uid();
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created,label,last_used,id) VALUES(?,?,?,'cookie',?,?,?,?)",
    await sha(token),
    userId,
    now() + 3600000,
    now(),
    "teste",
    now(),
    uid(),
  );
  return token;
}

/** Chama o Worker com um D1 que conta as idas. */
async function call(
  path: string,
  headers: Record<string, string>,
  init: RequestInit = {},
) {
  const { env: counted, count } = countingEnv(env);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://test" + path, { ...init, headers }),
    counted as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { response, count };
}

/** Consultas de credencial ou estado fora do lote inicial. */
const separate = (sql: string[]) =>
  sql
    .slice(1)
    .filter((s) =>
      /\b(sessions|api_keys|rate_limits|profile_modules|instance_settings)\b/.test(
        s,
      ),
    );

async function setup() {
  const f = await fixture();
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "os", enabled: true },
    uid(),
  );
  const wabu = await bearer(f.member);
  await exec(
    env,
    "UPDATE sessions SET id=? WHERE hash=?",
    uid(),
    await sha(wabu),
  );
  return {
    f,
    wabu,
    ck: await cookie(f.member.id),
    app: await application(f, ["conversations:read", "conversations:write"]),
  };
}

describe("uma ida ao D1 antes da rota", () => {
  it("cookie, wabu_ e chave de aplicação; o estado dos módulos vai junto", async () => {
    const { f, wabu, ck, app } = await setup();
    // A primeira requisição de pessoa do isolado grava o endereço público
    // (rememberOrigin, uma vez por isolado, só depois de a sessão valer).
    await call("/api/v1/me", { Authorization: "Bearer " + wabu });
    const me = [
      await call("/api/v1/me", { Authorization: "Bearer " + wabu }),
      await call("/api/v1/me", { Cookie: "wabotia=" + ck }),
    ];
    for (const { response, count } of me) {
      expect(response.status).toBe(200);
      expect(count.calls, count.sql.join("\n")).toBe(1);
      expect(count.sql[0]).toMatch(/^batch\(/);
    }
    const route = `/api/v1/profiles/${f.profile}/service-orders?limit=1`;
    for (const headers of [
      { Authorization: "Bearer " + wabu },
      { Cookie: "wabotia=" + ck },
      { Authorization: "Bearer " + app.token },
    ]) {
      const { response, count } = await call(route, headers);
      expect(response.status).toBe(200);
      expect(count.sql[0]).toMatch(/^batch\(/);
      // Nem credencial, nem política, nem estado dos módulos fora do lote.
      expect(separate(count.sql), count.sql.join("\n")).toEqual([]);
    }
  });

  it("a revogação vale na próxima requisição (sem cache entre requisições)", async () => {
    const { wabu, ck } = await setup();
    expect(
      (await call("/api/v1/me", { Authorization: "Bearer " + wabu })).response
        .status,
    ).toBe(200);
    await exec(
      env,
      "DELETE FROM sessions WHERE hash IN (?,?)",
      await sha(wabu),
      await sha(ck),
    );
    expect(
      (await call("/api/v1/me", { Authorization: "Bearer " + wabu })).response
        .status,
    ).toBe(401);
    expect(
      (await call("/api/v1/me", { Cookie: "wabotia=" + ck })).response.status,
    ).toBe(401);
  });

  it("limite por minuto da chave continua; chave inválida não conta", async () => {
    const { f, app } = await setup();
    await exec(env, "UPDATE applications SET rate=2 WHERE id=?", app.id);
    const route = `/api/v1/profiles/${f.profile}/service-orders?limit=1`;
    const headers = { Authorization: "Bearer " + app.token };
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await call(route, headers)).response.status);
    expect(statuses).toEqual([200, 200, 429]);
    const bad = await call(route, { Authorization: "Bearer wab_invalida" });
    expect(bad.response.status).toBe(401);
  });

  it("módulo desligado responde 409 na leitura e na escrita", async () => {
    const { f, wabu } = await setup();
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "os", enabled: false },
      uid(),
    );
    const headers = { Authorization: "Bearer " + wabu };
    const read = await call(
      `/api/v1/profiles/${f.profile}/service-orders`,
      headers,
    );
    expect(read.response.status).toBe(409);
    const write = await call(
      `/api/v1/profiles/${f.profile}/service-orders`,
      {
        ...headers,
        "Content-Type": "application/json",
        "Idempotency-Key": uid(),
      },
      { method: "POST", body: JSON.stringify({ item: "X", problem: "Y" }) },
    );
    expect(write.response.status).toBe(409);
    expect((await write.response.json<any>()).error.code).toBe(
      "module_disabled",
    );
  });

  it("a política do segundo fator vem junto com a sessão", async () => {
    const { wabu } = await setup();
    await exec(
      env,
      "INSERT INTO instance_settings(key,value,updated) VALUES('mfa_policy','financial',?) ON CONFLICT(key) DO UPDATE SET value='financial'",
      now(),
    );
    try {
      const { response, count } = await call("/api/v1/me", {
        Authorization: "Bearer " + wabu,
      });
      expect((await response.json<any>()).mfa.policy).toBe("financial");
      expect(count.calls).toBe(1);
    } finally {
      await exec(
        env,
        "UPDATE instance_settings SET value='off' WHERE key='mfa_policy'",
      );
    }
  });
});
