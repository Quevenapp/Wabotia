import {
  createExecutionContext,
  env,
  SELF,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { removePendingConnections } from "../src/connection-removal";
import { processRun, deliver } from "../src/engine";
import { botAllowsLine } from "../src/line-service";
import { perform } from "../src/service";
import { setSecret } from "../src/security";
import { json, now, uid } from "../src/types";
import worker from "../src/index";
import { api, bearer, bot, fixture, receive } from "./service-center-fixture";
import migration from "../migrations/0094_retira_cloudflare.sql?raw";

afterEach(() => vi.unstubAllGlobals());

async function migrate() {
  const statements = migration
    .split(/;\s*(?:\r?\n|$)/)
    .map((sql) =>
      sql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  // Igual ao lote da migração D1: não há observação entre segredo e pausa.
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
}

async function installation() {
  const f = await fixture();
  const botId = await bot(f);
  const connection = (
    await one(env, "SELECT connection_id FROM bots WHERE id=?", botId)
  ).connection_id;
  await exec(
    env,
    "UPDATE connections SET kind='hermes',config=? WHERE id=?",
    JSON.stringify({ verified_at: now() }),
    connection,
  );
  await setSecret(env, "cloudflare:config", { token: "token-que-deve-sumir" });
  await setSecret(env, "cloudflare:job:" + connection, {
    client_secret: "segredo-do-job",
  });
  await setSecret(env, "connection:" + connection, {
    profile_keys: { default: "segredo-da-conexao" },
  });
  await setSecret(env, "system:update-config", {
    token: "token-das-atualizacoes",
  });
  const created = now();
  await exec(
    env,
    "INSERT INTO cloudflare_jobs(id,profile_id,actor,admin_hostname,api_hostname,spec,resources,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    connection,
    f.profile,
    f.admin.id,
    `admin-${connection}.example.com`,
    `api-${connection}.example.com`,
    JSON.stringify({
      connection_id: connection,
      tunnel_name: "wabotia-atendimento",
      token: "nunca-copiar-spec",
    }),
    JSON.stringify({
      admin_app: "app-admin",
      api_app: "app-api",
      service_token: "service-id",
      policy: "policy-id",
      tunnel: "tunnel-id",
      admin_dns: "dns-admin",
      api_dns: "dns-api",
      client_secret: "nunca-copiar",
      credentials: { token: "nunca-copiar" },
    }),
    created,
    created,
  );
  return { ...f, botId, connection, created };
}

describe("retirada da preparação Cloudflare", () => {
  it("o scheduled remove conexões marcadas de todas as áreas e pode ser repetido", async () => {
    const first = await installation();
    const second = await installation();
    await migrate();
    const wake = vi.fn(async () => Response.json({ scheduled: true }));
    const cronEnv = {
      ...env,
      // Só o despertar dos objetos é simulado; a limpeza usa o banco real.
      COORDINATOR: {
        idFromName: (name: string) => env.COORDINATOR.idFromName(name),
        get: () => ({ fetch: wake }),
      } as unknown as typeof env.COORDINATOR,
    };
    const cron = async () => {
      const ctx = createExecutionContext();
      await worker.scheduled(
        { scheduledTime: Date.parse("2026-11-18T15:35:00Z") } as ScheduledEvent,
        cronEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    };
    await cron();
    for (const f of [first, second]) {
      expect(
        await one(env, "SELECT id FROM connections WHERE id=?", f.connection),
      ).toBeNull();
      expect(
        await one(env, "SELECT id FROM bots WHERE id=?", f.botId),
      ).toBeNull();
      expect(
        await one(env, "SELECT id FROM connections WHERE id=?", f.line),
      ).not.toBeNull();
      expect(wake).toHaveBeenCalledWith("https://coordinator/wake", {
        method: "POST",
        body: JSON.stringify({ profile: f.profile }),
      });
    }
    await expect(cron()).resolves.toBeUndefined();
  });

  it("não permite que a API marque uma conexão para a remoção interna", async () => {
    const f = await fixture();
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "connection.save",
        {
          kind: "qr",
          name: "Telefone",
          config: { number: "5511999999999", remove_pending: 1 },
        },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await all(
        env,
        "SELECT id FROM connections WHERE profile_id=? AND json_extract(config,'$.remove_pending')=1",
        f.profile,
      ),
    ).toEqual([]);
  });

  it("aceita especialistas internos e só preserva referências antigas se já estavam desligadas", async () => {
    const f = await installation();
    const aiBot = await bot(f);
    const legacy = {
      id: "legado",
      name: "Legado",
      bot_id: f.botId,
      enabled: false,
    };
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "settings",
        { capabilities: [legacy] },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await exec(
      env,
      "UPDATE profiles SET settings=json_set(settings,'$.capabilities',json(?)) WHERE id=?",
      JSON.stringify([legacy]),
      f.profile,
    );
    await perform(
      env,
      f.admin,
      f.profile,
      "settings",
      { capabilities: [legacy] },
      uid(),
    );
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "settings",
        { capabilities: [{ ...legacy, enabled: true }] },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await perform(
      env,
      f.admin,
      f.profile,
      "settings",
      { capabilities: [{ ...legacy, bot_id: aiBot, enabled: true }] },
      uid(),
    );
    expect(
      json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      ).capabilities[0].bot_id,
    ).toBe(aiBot);
  });

  it("deixa as instâncias antigas do Coordinator ociosas e responde 410", async () => {
    const stub = env.COORDINATOR.get(
      env.COORDINATOR.idFromName("hermes-link:" + uid()),
    );
    const response = await stub.fetch("https://internal/link-poll", {
      method: "POST",
    });
    expect(response.status).toBe(410);
    expect(await response.text()).toBe(
      "Hermes retirado: escolha um bot interno.",
    );
    const state = await runInDurableObject(
      stub,
      async (_instance: any, state: DurableObjectState) => ({
        alarm: await state.storage.getAlarm(),
        profile: await state.storage.get("profile"),
      }),
    );
    expect(state).toEqual({ alarm: null, profile: undefined });
  });

  it("guarda só nomes e IDs, apaga credenciais, pausa e remove pelo cron de forma idempotente", async () => {
    const f = await installation();
    await migrate();
    expect(
      await all(
        env,
        "SELECT id FROM secrets WHERE id LIKE 'cloudflare:%' OR id=?",
        "connection:" + f.connection,
      ),
    ).toEqual([]);
    expect(await all(env, "SELECT id FROM cloudflare_jobs")).toEqual([]);
    expect(
      await one(env, "SELECT id FROM secrets WHERE id='system:update-config'"),
    ).toBeTruthy();
    const connection = await one(
      env,
      "SELECT * FROM connections WHERE id=?",
      f.connection,
    );
    expect(connection.status).toBe("paused");
    expect(json(connection.config)).toMatchObject({
      retired: 1,
      remove_pending: 1,
    });
    const settings = json(
      (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
        .settings,
    );
    expect(settings.retired_cloudflare).toEqual([
      {
        admin_hostname: `admin-${f.connection}.example.com`,
        api_hostname: `api-${f.connection}.example.com`,
        created: f.created,
        resources: {
          admin_app: "app-admin",
          admin_app_name: "wabotia-atendimento descoberta",
          api_app: "app-api",
          api_app_name: "wabotia-atendimento API",
          service_token: "service-id",
          service_token_name: "wabotia-atendimento",
          policy: "policy-id",
          policy_name: "wabotia-atendimento",
          tunnel: "tunnel-id",
          tunnel_name: "wabotia-atendimento",
          admin_dns: "dns-admin",
          admin_dns_name: `admin-${f.connection}.example.com`,
          api_dns: "dns-api",
          api_dns_name: `api-${f.connection}.example.com`,
        },
      },
    ]);
    for (const value of [
      "nunca-copiar",
      "client_secret",
      "credentials",
      "token-que-deve-sumir",
    ])
      expect(JSON.stringify(settings)).not.toContain(value);
    await migrate();
    expect(
      json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      ).retired_cloudflare,
    ).toEqual(settings.retired_cloudflare);
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "connection.state",
        { id: f.connection, status: "active" },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "connection_removing" });
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "connection.save",
        { id: f.connection, kind: "hermes", name: "Tentativa", config: {} },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "bot.update",
        { id: f.botId, enabled: true },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const response = await api(
      await bearer(f.admin),
      `/profiles/${f.profile}/connections/${f.connection}/state`,
      "PUT",
      { status: "active" },
    );
    expect(response.status).toBe(409);
    await removePendingConnections(env, f.profile);
    expect(
      await one(env, "SELECT id FROM connections WHERE id=?", f.connection),
    ).toBeNull();
    expect(
      await one(env, "SELECT id FROM bots WHERE id=?", f.botId),
    ).toBeNull();
    await expect(
      removePendingConnections(env, f.profile),
    ).resolves.toBeUndefined();
    expect(
      json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      ).retired_cloudflare,
    ).toEqual(settings.retired_cloudflare);
  });

  it("a pausa impede seleção pelo motor e envio, também com o filtro da versão anterior", async () => {
    const f = await installation();
    const c = await receive(f, f.line, "oi");
    await exec(
      env,
      "UPDATE conversations SET connection_id=? WHERE id=?",
      f.connection,
      c.id,
    );
    await migrate();
    expect(await botAllowsLine(env, f.botId, f.profile, f.line)).toBe(false);
    // Filtro de estado já usado pela 0.21.0, sem depender do novo filtro de kind.
    expect(
      await one(
        env,
        "SELECT b.id FROM bots b JOIN connections c ON c.id=b.connection_id WHERE b.id=? AND b.enabled=1 AND c.status='active'",
        f.botId,
      ),
    ).toBeNull();
    expect(
      await one(
        env,
        "SELECT id FROM connections WHERE id=? AND status='active'",
        f.connection,
      ),
    ).toBeNull();
    const network = vi.fn(() => {
      throw new Error("Não deve chamar rede");
    });
    vi.stubGlobal("fetch", network);
    await deliver(env, {
      id: uid(),
      profile_id: f.profile,
      conversation_id: c.id,
      status: "pending",
      kind: "text",
      payload: JSON.stringify({ text: "oi" }),
      epoch: c.epoch,
    });
    const run = uid();
    await exec(
      env,
      "INSERT INTO bot_runs(id,profile_id,bot_id,actor,input,created,updated) VALUES(?,?,?,'system','oi',?,?)",
      run,
      f.profile,
      f.botId,
      now(),
      now(),
    );
    await processRun(
      env,
      await one(env, "SELECT * FROM bot_runs WHERE id=?", run),
    );
    expect(
      await one(env, "SELECT status,error FROM bot_runs WHERE id=?", run),
    ).toEqual({
      status: "failed",
      error: "Hermes retirado: escolha um bot interno.",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("retoma após falha parcial e continua com as outras conexões", async () => {
    const f = await installation();
    const secondBot = await bot(f);
    const second = (
      await one(env, "SELECT connection_id FROM bots WHERE id=?", secondBot)
    ).connection_id;
    await migrate();
    await exec(
      env,
      "UPDATE connections SET status='paused',config=json_set(config,'$.remove_pending',1) WHERE id=?",
      second,
    );
    // Referências desligadas deixadas pela 0092 não impedem a limpeza interna.
    await exec(
      env,
      "UPDATE profiles SET settings=json_set(settings,'$.capabilities',json(?)) WHERE id=?",
      JSON.stringify([{ bot_id: f.botId, enabled: false }]),
      f.profile,
    );
    let failed = false;
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            if (!failed && sql.startsWith("DELETE FROM bots")) {
              failed = true;
              throw new Error("Interrupção simulada");
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await removePendingConnections({ ...env, DB }, f.profile);
    expect(failed).toBe(true);
    expect(
      await all(
        env,
        "SELECT id FROM connections WHERE profile_id=? AND json_extract(config,'$.remove_pending')=1",
        f.profile,
      ),
    ).toHaveLength(1);
    await removePendingConnections(env, f.profile);
    expect(
      await all(
        env,
        "SELECT id FROM connections WHERE profile_id=? AND json_extract(config,'$.remove_pending')=1",
        f.profile,
      ),
    ).toEqual([]);
  });

  it.each(["hermes", "hermes-whatsapp"])(
    "recusa criar e habilitar %s, mas permite ler e remover",
    async (kind) => {
      const f = await fixture();
      await expect(
        perform(
          env,
          f.admin,
          f.profile,
          "connection.save",
          { kind, name: "Legado" },
          uid(),
        ),
      ).rejects.toMatchObject({
        status: 400,
        message: "Hermes retirado: escolha um bot interno.",
      });
      const id = uid();
      await exec(
        env,
        "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Legado',?,'direct','paused','{}',?)",
        id,
        f.profile,
        kind,
        now(),
      );
      await expect(
        perform(
          env,
          f.admin,
          f.profile,
          "connection.state",
          { id, status: "active" },
          uid(),
        ),
      ).rejects.toMatchObject({ status: 400 });
      const token = await bearer(f.admin);
      const rows = await (
        await api(token, `/profiles/${f.profile}/connections`)
      ).json<any[]>();
      expect(rows.some((row) => row.id === id)).toBe(true);
      expect(
        (
          await api(
            token,
            `/profiles/${f.profile}/connections/${id}`,
            "DELETE",
            {},
          )
        ).status,
      ).toBe(200);
    },
  );

  it("não publica o MCP HTTP nem as rotas de vínculo e preparação", async () => {
    for (const path of [
      "/api/mcp",
      "/api/hermes-link/pair",
      "/api/hermes-link/poll",
    ])
      expect(
        (await SELF.fetch("https://test" + path, { method: "POST" })).status,
      ).toBe(404);
    const f = await fixture();
    const token = await bearer(f.admin);
    for (const path of [
      "/system/cloudflare/configure",
      `/profiles/${f.profile}/bot-runs/antiga/reconcile`,
    ])
      expect((await api(token, path, "POST", {})).status).toBe(404);
  });
});
