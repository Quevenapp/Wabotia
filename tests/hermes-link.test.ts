import { env, SELF } from "cloudflare:test";
import { it, expect, describe } from "vitest";
import { exec, one, all } from "../src/db";
import { uid, now, defaults, json, type Actor } from "../src/types";
import { secret } from "../src/security";
import { perform } from "../src/service";
import { hermesRequest, hermesArtifact, discover } from "../src/integrations";
import { sessionKey } from "../src/engine";

const admin: Actor = {
  id: "user-admin",
  kind: "user",
  name: "Admin",
  role: "admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 10,
};
const origin = "https://wabotia.test";
const connection = (id: string) =>
  one(env, "SELECT * FROM connections WHERE id=?", id);

async function fixture(pair = true) {
  const profile = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Área",
    JSON.stringify(defaults),
    now(),
  );
  const saved: any = await perform(
    env,
    admin,
    profile,
    "connection.save",
    { name: "Hermes local", kind: "hermes", config: { transport: "link" } },
    uid(),
  );
  const issued: any = await perform(
    env,
    admin,
    profile,
    "connection.link-code",
    { id: saved.id, origin },
    uid(),
  );
  let token = "";
  if (pair) {
    const r = await pairWith(issued.code);
    expect(r.status).toBe(200);
    token = ((await r.json()) as any).link_token;
  }
  return { profile, id: saved.id as string, code: issued.code, issued, token };
}
function pairWith(code: string) {
  return SELF.fetch(origin + "/api/hermes-link/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      host: "vps-01",
      plugin_version: "1.0.0",
      hermes_version: "0.9",
    }),
  });
}
const auth = (token: string) => ({ Authorization: "Bearer " + token });
async function poll(token: string, wait = 0) {
  const r = await SELF.fetch(origin + "/api/hermes-link/poll?wait=" + wait, {
    headers: auth(token),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).jobs as any[];
}
function answer(token: string, id: string, result: any) {
  return SELF.fetch(origin + "/api/hermes-link/results", {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...result }),
  });
}
/** Faz o papel do plugin até atender `count` operações. */
async function serve(
  token: string,
  count: number,
  handler: (job: any) => Promise<any> | any,
) {
  const seen: any[] = [];
  while (seen.length < count)
    for (const job of await poll(token, 2)) {
      seen.push(job);
      const result = await handler(job);
      if (result) await answer(token, job.id, result);
    }
  return seen;
}

describe("pareamento do plugin Hermes", () => {
  it("troca o código uma única vez e guarda só o hash do token", async () => {
    const f = await fixture(false);
    expect(f.issued.command).toBe(
      `curl -fsSL ${origin}/hermes-plugin/install.sh | bash -s -- ${origin} ${f.code}`,
    );
    const first = await pairWith(f.code);
    expect(first.status).toBe(200);
    const paired: any = await first.json();
    expect(paired.link_token).toMatch(/^wabl_/);
    expect(paired.connection_id).toBe(f.id);
    const again = await pairWith(f.code);
    expect(again.status).toBe(404);
    expect(((await again.json()) as any).error.code).toBe("pairing_not_found");
    const keys = await secret(env, `connection:${f.id}`);
    expect(keys.link_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.link_code_hash).toBeUndefined();
    expect(JSON.stringify(keys)).not.toContain(paired.link_token);
    const link = json((await connection(f.id)).config).link;
    expect(link.host).toBe("vps-01");
    expect(link.plugin_version).toBe("1.0.0");
  });
  it("recusa código expirado, malformado e de outra conexão", async () => {
    const f = await fixture(false);
    for (const code of ["", "wabp_x", f.code.slice(0, -1) + "0x"])
      expect((await pairWith(code)).status).toBe(404);
    const other = await fixture(false);
    const mixed = `wabp_${other.id}_${f.code.split("_")[2]}`;
    expect((await pairWith(mixed)).status).toBe(404);
    await perform(
      env,
      admin,
      f.profile,
      "connection.link-revoke",
      { id: f.id },
      uid(),
    );
    expect((await pairWith(f.code)).status).toBe(404);
  });
  it("só aceita o token do vínculo e para após a revogação", async () => {
    const f = await fixture();
    for (const token of ["", "wab_" + uid(), f.token.slice(0, -1) + "x"]) {
      const r = await SELF.fetch(origin + "/api/hermes-link/poll?wait=0", {
        headers: auth(token),
      });
      expect(r.status).toBe(401);
    }
    expect(await poll(f.token)).toEqual([]);
    // O token do vínculo não abre a API v1.
    const api = await SELF.fetch(origin + "/api/v1/profiles", {
      headers: auth(f.token),
    });
    expect(api.status).toBe(401);
    await perform(
      env,
      admin,
      f.profile,
      "connection.link-revoke",
      { id: f.id },
      uid(),
    );
    const r = await SELF.fetch(origin + "/api/hermes-link/poll?wait=0", {
      headers: auth(f.token),
    });
    expect(r.status).toBe(401);
    expect(json((await connection(f.id)).config).link).toBeUndefined();
  });
  it("mantém o modo plugin ao editar e não guarda chaves do Hermes", async () => {
    const f = await fixture();
    await perform(
      env,
      admin,
      f.profile,
      "connection.save",
      { id: f.id, name: "Renomeado", kind: "hermes", config: {} },
      uid(),
    );
    const row = await connection(f.id);
    expect(row.name).toBe("Renomeado");
    expect(json(row.config).transport).toBe("link");
    expect(json(row.config).link.host).toBe("vps-01");
    expect(await poll(f.token)).toEqual([]);
    await expect(
      perform(
        env,
        admin,
        f.profile,
        "connection.save",
        {
          id: f.id,
          name: "Com chave",
          kind: "hermes",
          config: {},
          secrets: { dashboard_token: "x".repeat(32) },
        },
        uid(),
      ),
    ).rejects.toThrow("não guarda chaves");
    // Conexões por URL não ganham o modo plugin por edição.
    const url: any = await perform(
      env,
      admin,
      f.profile,
      "connection.save",
      {
        name: "Por URL",
        kind: "hermes",
        config: { url: "https://hermes.example.com" },
      },
      uid(),
    );
    await perform(
      env,
      admin,
      f.profile,
      "connection.save",
      {
        id: url.id,
        name: "Por URL",
        kind: "hermes",
        config: { url: "https://hermes.example.com", transport: "link" },
      },
      uid(),
    );
    expect(json((await connection(url.id)).config).transport).toBeUndefined();
    await expect(
      perform(
        env,
        admin,
        f.profile,
        "connection.link-code",
        { id: url.id, origin },
        uid(),
      ),
    ).rejects.toThrow("por plugin não encontrada");
  });
});

describe("operações pelo vínculo", () => {
  it("falha na hora quando o plugin nunca conectou", async () => {
    const f = await fixture();
    await expect(
      hermesRequest(env, await connection(f.id), "/v1/capabilities"),
    ).rejects.toThrow("Hermes offline");
  });
  it("separa a memória do Hermes por conversa, conversa interna e pessoa", async () => {
    const run = (extra: Record<string, unknown>) =>
      ({
        id: "run-9",
        profile_id: "p1",
        bot_id: "b1",
        actor: "system",
        conversation_id: null,
        context: "{}",
        ...extra,
      }) as any;
    expect(sessionKey(run({ conversation_id: "c1" }))).toBe(
      "wabotia:p1:b1:conv:c1",
    );
    expect(sessionKey(run({ conversation_id: "c2" }))).toBe(
      "wabotia:p1:b1:conv:c2",
    );
    expect(
      sessionKey(
        run({
          actor: "u1",
          context: JSON.stringify({ internal_chat_id: "i1" }),
        }),
      ),
    ).toBe("wabotia:p1:b1:internal:i1");
    expect(sessionKey(run({ actor: "u1" }))).toBe("wabotia:p1:b1:user:u1");
    expect(sessionKey(run({ actor: "u2" }))).toBe("wabotia:p1:b1:user:u2");
    expect(sessionKey(run({}))).toBe("wabotia:p1:b1:run:run-9");

    const f = await fixture();
    const waiting = poll(f.token, 5);
    await new Promise((r) => setTimeout(r, 50));
    const call = hermesRequest(
      env,
      await connection(f.id),
      "/v1/runs",
      { input: "Olá" },
      "wabotia",
      "wabotia:run-9",
      "wabotia:p1:b1:conv:c1",
    );
    const [job] = await waiting;
    expect(job.session_key).toBe("wabotia:p1:b1:conv:c1");
    await answer(f.token, job.id, {
      ok: true,
      http_status: 200,
      body: { run_id: "remote-9" },
    });
    expect((await call).run_id).toBe("remote-9");
  });
  it("entrega a execução a um poll em espera e devolve a resposta", async () => {
    const f = await fixture();
    const waiting = poll(f.token, 5);
    await new Promise((r) => setTimeout(r, 50));
    const call = hermesRequest(
      env,
      await connection(f.id),
      "/v1/runs",
      { input: "Olá", instructions: "Responda." },
      "wabotia",
      "wabotia:run-1",
    );
    const [job] = await waiting;
    expect(job).toMatchObject({
      op: "runs.create",
      profile: "wabotia",
      body: { input: "Olá", instructions: "Responda." },
      idempotency_key: "wabotia:run-1",
    });
    expect(
      (
        await answer(f.token, job.id, {
          ok: true,
          http_status: 200,
          body: { run_id: "run_abc" },
        })
      ).status,
    ).toBe(200);
    expect(await call).toEqual({ run_id: "run_abc" });
    // Resultado repetido ou tardio é aceito sem efeito.
    const late: any = await (
      await answer(f.token, job.id, { ok: true, body: {} })
    ).json();
    expect(late.received).toBe(false);
  });
  it("enfileira para o próximo poll e traduz consulta e parada", async () => {
    const f = await fixture();
    await poll(f.token);
    const conn = await connection(f.id);
    const status = hermesRequest(
      env,
      conn,
      "/v1/runs/run_abc",
      undefined,
      "wabotia",
    );
    const stop = hermesRequest(env, conn, "/v1/runs/run_abc/stop", {}, "x");
    const jobs = await serve(f.token, 2, (job) => ({
      ok: true,
      http_status: 200,
      body: { status: job.op === "runs.get" ? "completed" : "stopped" },
    }));
    expect(jobs.map((j) => [j.op, j.profile, j.run_id]).sort()).toEqual([
      ["runs.get", "wabotia", "run_abc"],
      ["runs.stop", "x", "run_abc"],
    ]);
    expect(await status).toEqual({ status: "completed" });
    expect(await stop).toEqual({ status: "stopped" });
  });
  it("converte erro local do Hermes em 502", async () => {
    const f = await fixture();
    await poll(f.token);
    const call = hermesRequest(env, await connection(f.id), "/v1/capabilities");
    await serve(f.token, 1, () => ({
      ok: false,
      http_status: 401,
      code: "local_unauthorized",
    }));
    await expect(call).rejects.toMatchObject({
      status: 502,
      code: "hermes_error",
      message: "Hermes respondeu HTTP 401.",
    });
  });
  it("descobre os bots com a API local habilitada, sem chaves no Wabotia", async () => {
    const f = await fixture();
    await poll(f.token);
    const found = discover(env, f.id, f.profile);
    const jobs = await serve(f.token, 2, (job) =>
      job.op === "profiles.list"
        ? {
            ok: true,
            http_status: 200,
            body: {
              profiles: [
                {
                  name: "wabotia",
                  display_name: "Atendente",
                  api_enabled: true,
                },
                { name: "rascunho", api_enabled: false },
              ],
            },
          }
        : {
            ok: true,
            http_status: 200,
            body: {
              features: {
                runs_idempotency: { supported: true, durable: true },
              },
            },
          },
    );
    expect(jobs.map((j) => [j.op, j.profile])).toEqual([
      ["profiles.list", undefined],
      ["capabilities.get", "wabotia"],
    ]);
    const bots: any[] = await found;
    expect(bots.map((b) => b.remote_profile).sort()).toEqual([
      "rascunho",
      "wabotia",
    ]);
    // Só o atendimento verificado pode ser habilitado como bot.
    const byName = (name: string) =>
      bots.find((b) => b.remote_profile === name).id;
    await perform(
      env,
      admin,
      f.profile,
      "bot.update",
      { id: byName("wabotia"), enabled: true },
      uid(),
    );
    expect(
      (await one(env, "SELECT enabled FROM bots WHERE id=?", byName("wabotia")))
        .enabled,
    ).toBe(1);
    await expect(
      perform(
        env,
        admin,
        f.profile,
        "bot.update",
        { id: byName("rascunho"), enabled: true },
        uid(),
      ),
    ).rejects.toThrow("Descobrir bots antes de habilitar");
    const cfg = json((await connection(f.id)).config);
    expect(cfg.verified_at).toBeGreaterThan(0);
    expect(Object.keys(cfg.capabilities)).toEqual(["wabotia"]);
    expect(
      (await secret(env, `connection:${f.id}`)).profile_keys,
    ).toBeUndefined();
  });
  it("recebe o artefato enviado pelo plugin e limpa a cópia temporária", async () => {
    const f = await fixture();
    await poll(f.token);
    const stored = hermesArtifact(
      env,
      await connection(f.id),
      "wabotia",
      "artifact-12345",
      "resultado.txt",
      "app:a",
    );
    const [job] = await serve(f.token, 1, async (job) => {
      // Só a operação em espera aceita arquivo.
      const wrong = await SELF.fetch(
        origin + "/api/hermes-link/artifacts/" + uid(),
        { method: "PUT", headers: auth(f.token), body: "x" },
      );
      expect(wrong.status).toBe(409);
      const put = await SELF.fetch(
        origin + "/api/hermes-link/artifacts/" + job.id,
        {
          method: "PUT",
          headers: { ...auth(f.token), "Content-Type": "text/plain" },
          body: "documento",
        },
      );
      expect(put.status).toBe(200);
      return null;
    });
    expect(job).toMatchObject({
      op: "artifacts.download",
      profile: "wabotia",
      artifact_id: "artifact-12345",
    });
    const id = await stored;
    const media = await one(env, "SELECT * FROM media WHERE id=?", id);
    expect(media).toMatchObject({
      type: "text/plain",
      size: 9,
      actor: "app:a",
    });
    expect(await (await env.MEDIA.get(media.object_key))!.text()).toBe(
      "documento",
    );
    expect(
      (await env.MEDIA.list({ prefix: `hermes-link/${f.id}/` })).objects,
    ).toHaveLength(0);
    expect(
      await all(env, "SELECT state FROM artifact_imports WHERE media_id=?", id),
    ).toEqual([{ state: "complete" }]);
  });
});
