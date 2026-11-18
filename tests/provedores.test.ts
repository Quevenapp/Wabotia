// Atualização 0093, compatibilidade e sigilo: o serviço é sempre simulado.
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../migrations/0093_provedores.sql?raw";
import { all, exec, one } from "../src/db";
import { json, now, uid, type Run } from "../src/types";
import { engineActor, secret, setSecret } from "../src/security";
import { perform } from "../src/service";
import { processRun } from "../src/engine";
import { aiComplete, ANTHROPIC_MODELS, connectionKey } from "../src/ai-provider";
import { askJev } from "../src/jev-client";
import { addJevUsage } from "../src/jev";
import { runDecide } from "../src/bot-actions/decide";
import {
  allowedProvider,
  hideProviderKey,
  listProviders,
  providerFingerprint,
  pruneProviderUsage,
} from "../src/ai-providers";
import { internalCall } from "../src/internal-api";
import { catalogFor } from "../src/bot-actions/catalog";
import { fixture, receive, type Fixture } from "./service-center-fixture";

const KEY = "segredo-inicial-0123456789-proibido-final";
const ROTATED = "segredo-trocado-9876543210-final-diferente";
const KEY_JEV = "jevprivado-X-1234567890-fim-reservado";
const keys = [KEY, ROTATED, KEY_JEV];
beforeEach(async () => {
  // O banco persiste entre casos neste executor. Cada cenário começa com a
  // instalação vazia, sem afrouxar as comparações de tabelas ou duplicatas.
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function keyFragments(key: string) {
  const random = key.slice(key.lastIndexOf("-", 12) + 1);
  return [
    ...(key ? [key] : []),
    ...[random.slice(0, 12), random.slice(-12)].filter((part) => part.length >= 12),
  ];
}
function noKey(value: unknown, candidates = keys) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const key of candidates)
    for (const fragment of keyFragments(key))
      expect(text).not.toContain(fragment);
  expect(text).not.toContain("key_fingerprint");
}
function network(echo = false) {
  const calls: { url: string; key: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      const authorization = new Headers(init.headers).get("Authorization");
      const key = authorization?.replace(/^Bearer /, "") || "";
      // O serviço só conhece a credencial recebida nesta chamada. As três
      // chaves são exercitadas abaixo, inclusive após rotação e pelo JEV.
      const fragments = keyFragments(key);
      calls.push({ url, key: authorization });
      if (url.endsWith("/models"))
        return Response.json({
          data: [
            { id: "modelo-teste" },
            { id: "jev-1.14.0" },
            ...(echo ? fragments.map((id) => ({ id })) : []),
          ],
        });
      if (url.endsWith("/systemone"))
        return Response.json({
          model: "jev-1.14.0",
          answers: {
            q: {
              type: "noul",
              noul: 0.99,
              ...(echo ? { detail: fragments.join(" ") } : {}),
            },
          },
          usage: { input_tokens: 50, output_tokens: 2 },
        });
      if (url.endsWith("/responses"))
        return Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: echo ? fragments.join(" ") : "Resposta de teste.",
                },
              ],
            },
          ],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 20 },
            output_tokens: 10,
          },
        });
      if (url.endsWith("/chat/completions"))
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: echo ? fragments.join(" ") : "Resposta de teste.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        });
      return Response.json({});
    }),
  );
  return calls;
}
const command = (f: Fixture, op: string, data: any, actor = f.admin) =>
  perform(env, actor, f.profile, op, data, uid());
async function create(f: Fixture, data: any = {}) {
  return command(f, "provider.create", {
    kind: "openai",
    name: "Provedor",
    api_key: KEY,
    profiles: [f.profile],
    ...data,
  });
}
async function migration0093() {
  const sqls = migration
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) =>
      s
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  for (const sql of sqls) await env.DB.prepare(sql).run();
}
async function connection(f: Fixture, provider: string | null, config: any = {}) {
  const id = uid(),
    bot = uid();
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'Bot de teste','ai','direct','active',?,?)",
    id,
    f.profile,
    JSON.stringify({
      provider,
      model: "modelo-teste",
      text_only: true,
      ...config,
    }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Bot',1)",
    bot,
    f.profile,
    id,
  );
  return { id, bot };
}
async function run(f: Fixture, bot: string, conversation?: any) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,input,conversation_id,epoch,phase,created,updated) VALUES(?,?,?,'system','Olá',?,?,?,?,?)",
    id,
    f.profile,
    bot,
    conversation?.id || null,
    conversation?.epoch ?? null,
    conversation ? "attendant" : "direct",
    now(),
    now(),
  );
  return (await one(env, "SELECT * FROM bot_runs WHERE id=?", id)) as Run;
}
const connRow = (id: string) =>
  one(env, "SELECT * FROM connections WHERE id=?", id);

describe("provedores: atualização aditiva e volta à versão anterior", () => {
  it.each([null, "fora-do-check", ""])(
    "INSERT ignorado mantém provider=%s no cofre legado e exige vínculo ao editar",
    async (provider) => {
      const f = await fixture();
      const bot = await connection(f, provider);
      await exec(env, "UPDATE connections SET name='',status='paused' WHERE id=?", bot.id);
      await setSecret(env, `connection:${bot.id}`, { api_key: KEY });
      await migration0093();
      expect(await one(env, "SELECT id FROM ai_providers WHERE id=?", `p-${bot.id}`)).toBeNull();
      expect(json((await connRow(bot.id)).config)).not.toHaveProperty("provider_id");
      expect(await connectionKey(env, await connRow(bot.id))).toBe(KEY);
      await expect(command(f, "connection.update", { id: bot.id, name: "Editado" }))
        .rejects.toThrow("Informe o provedor ou a chave.");
      expect(await connectionKey(env, await connRow(bot.id))).toBe(KEY);
    },
  );

  it("JEV não vincula quando a inserção do provedor é ignorada", async () => {
    const f = await fixture();
    await setSecret(env, `jev:${f.profile}`, { key: KEY_JEV });
    await exec(env, "CREATE TRIGGER ignore_jev_provider BEFORE INSERT ON ai_providers WHEN NEW.kind='typesafe' BEGIN SELECT RAISE(IGNORE); END");
    try {
      await migration0093();
      expect(await one(env, "SELECT id FROM ai_providers WHERE id=?", `p-jev-${f.profile}`)).toBeNull();
      expect(json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile)).settings))
        .not.toHaveProperty("jev_provider_id");
      network();
      expect((await askJev(env, f.profile, {}, {}, { q: { type: "noul", instructions: "Sim?" } })).ok).toBe(true);
    } finally {
      await exec(env, "DROP TRIGGER ignore_jev_provider");
    }
  });

  it("copia os cofres sem abrir, liga bots e JEV e preserva o caminho antigo", async () => {
    const f = await fixture();
    const openai = await connection(f, "openai", { vision: true, pdf: true });
    const compatible = await connection(f, "compatible", {
      base_url: "https://compativel.example.com/v1",
      vision: false,
      pdf: false,
      tools_unsupported_at: now(),
    });
    await setSecret(env, `connection:${openai.id}`, { api_key: KEY });
    await setSecret(env, `connection:${compatible.id}`, { api_key: ROTATED });
    await setSecret(env, `jev:${f.profile}`, { key: KEY_JEV });
    const originals = await all(
      env,
      "SELECT * FROM secrets WHERE id IN (?,?,?)",
      `connection:${openai.id}`,
      `connection:${compatible.id}`,
      `jev:${f.profile}`,
    );
    await migration0093();
    const providers = await all(
      env,
      "SELECT * FROM ai_providers WHERE id IN (?,?,?)",
      `p-${openai.id}`,
      `p-${compatible.id}`,
      `p-jev-${f.profile}`,
    );
    expect(providers).toHaveLength(3);
    expect(
      json(providers.find((p) => p.id === `p-${openai.id}`).capabilities),
    ).toEqual({ text: true, image: true, pdf: true, tools: true });
    expect(
      json(providers.find((p) => p.id === `p-${compatible.id}`).capabilities),
    ).toEqual({ text: true, image: false, pdf: false, tools: false });
    expect(providers.find((p) => p.id === `p-${compatible.id}`).base_url).toBe(
      "https://compativel.example.com/v1",
    );
    expect(
      json(providers.find((p) => p.kind === "typesafe").capabilities),
    ).toEqual({ decision: true });
    for (const original of originals) {
      const id = original.id.startsWith("connection:")
        ? `provider:p-${original.id.slice(11)}`
        : `provider:p-jev-${f.profile}`;
      expect(
        (await one(env, "SELECT value FROM secrets WHERE id=?", id)).value,
      ).toBe(original.value);
      expect(
        (await one(env, "SELECT value FROM secrets WHERE id=?", original.id))
          .value,
      ).toBe(original.value);
    }
    const cfg = json(
      (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
        .settings,
    );
    expect(cfg.jev_provider_id).toBe(`p-jev-${f.profile}`);
    for (const bot of [openai, compatible])
      expect(json((await connRow(bot.id)).config).provider_id).toBe(
        `p-${bot.id}`,
      );
    const calls = network();
    // Os cofres antigos ficam com sentinelas temporárias: nenhum uso novo pode lê-los.
    for (const bot of [openai, compatible])
      await setSecret(env, `connection:${bot.id}`, {
        api_key: "cofre-antigo-nao-usar",
      });
    await setSecret(env, `jev:${f.profile}`, { key: "cofre-antigo-nao-usar" });
    const execution = await run(f, openai.bot);
    await processRun(env, execution);
    expect(
      (await one(env, "SELECT status FROM bot_runs WHERE id=?", execution.id))
        .status,
    ).toBe("completed");
    await aiComplete(env, await connRow(compatible.id), {
      instructions: "Responda",
      input: "Olá",
    });
    const decision = await askJev(
      env,
      f.profile,
      cfg,
      {},
      { q: { type: "noul", instructions: "Sim?" } },
    );
    expect(decision.ok).toBe(true);
    await addJevUsage(env, execution.id, decision.usage);
    expect(calls.filter((c) => c.url.endsWith("/responses"))[0].key).toBe(
      `Bearer ${KEY}`,
    );
    expect(
      calls.find(
        (c) => c.url === "https://compativel.example.com/v1/chat/completions",
      )?.key,
    ).toBe(`Bearer ${ROTATED}`);
    expect(calls.find((c) => c.url.endsWith("/systemone"))?.key).toBe(
      `Bearer ${KEY_JEV}`,
    );
    // Restaura o snapshot para conferir exatamente a leitura da versão anterior.
    for (const original of originals)
      await exec(
        env,
        "UPDATE secrets SET value=? WHERE id=?",
        original.value,
        original.id,
      );
    for (const [bot, key] of [
      [openai, KEY],
      [compatible, ROTATED],
    ] as const) {
      const row = await connRow(bot.id),
        old = json(row.config);
      delete old.provider_id;
      expect(
        await connectionKey(env, { ...row, config: JSON.stringify(old) }),
      ).toBe(key);
      expect((await secret(env, `connection:${bot.id}`)).api_key).toBe(key);
    }
    expect((await secret(env, `jev:${f.profile}`)).key).toBe(KEY_JEV);
    expect(
      (
        await askJev(
          env,
          f.profile,
          {},
          {},
          { q: { type: "noul", instructions: "Sim?" } },
        )
      ).ok,
    ).toBe(true);
    // Listagem de área não abre os segredos; a de sistema preenche as impressões.
    await listProviders(env, f.member);
    expect(
      (
        await one(
          env,
          "SELECT key_fingerprint FROM ai_providers WHERE id=?",
          `p-${openai.id}`,
        )
      ).key_fingerprint,
    ).toBeNull();
    noKey(await listProviders(env, f.admin));
    expect(
      (
        await one(
          env,
          "SELECT key_fingerprint FROM ai_providers WHERE id=?",
          `p-${openai.id}`,
        )
      ).key_fingerprint,
    ).toBe(await providerFingerprint(env, KEY));
    await migration0093();
    expect((await one(env, "SELECT count(*) n FROM ai_providers")).n).toBe(3);
  });
});

describe("provedores: operações e permissões", () => {
  it("distingue provedor inexistente, revogado e fora da área", async () => {
    network();
    const f = await fixture(), p = await create(f);
    await expect(allowedProvider(env, "inexistente", f.profile)).rejects.toMatchObject({
      status: 409, message: "Provedor não encontrado: escolha outro.",
    });
    await expect(allowedProvider(env, p.id, "outra-area")).rejects.toMatchObject({
      status: 409, message: "Este provedor não está liberado para esta área.",
    });
    await command(f, "provider.revoke", { id: p.id });
    await expect(allowedProvider(env, p.id, f.profile)).rejects.toMatchObject({
      status: 409, message: "Provedor revogado: escolha outro.",
    });
  });

  it("operator com conversations lista só o resumo dos provedores; consumo e custos exigem administrador", async () => {
    network();
    const f = await fixture(), other = await fixture();
    const shared = await create(f, { profiles: [f.profile, other.profile], base_url: "https://api.example.com/v1" });
    const prices = { "modelo-teste": { input: 2, output: 8 } };
    await command(f, "provider.update", { id: shared.id, prices });
    const foreign = await create(other);
    for (const profile of [f.profile, other.profile])
      await exec(env, "INSERT INTO ai_usage_daily(provider_id,profile_id,use,model,day,requests,input) VALUES(?,?,'bot','modelo-teste',?,1,1000000)", shared.id, profile, new Date().toISOString().slice(0, 10));
    const denied = { ...f.member, access: ["contacts"] };
    for (const path of ["/providers", `/providers/${shared.id}/usage`])
      expect((await internalCall(env, denied, { path })).status).toBe(403);
    await expect(command(f, "provider.usage", { id: shared.id }, denied))
      .rejects.toMatchObject({ status: 403 });
    await expect(listProviders(env, denied)).rejects.toMatchObject({ status: 403 });

    const reader = { ...f.member, access: ["conversations"] };
    const response = await internalCall(env, reader, { path: "/providers" });
    expect(response.status).toBe(200);
    const providers = await response.json<any[]>();
    expect(providers.map((p) => p.id)).toEqual([shared.id]);
    expect(providers[0].profiles).toEqual([f.profile]);
    expect(Object.keys(providers[0]).sort()).toEqual(
      ["id", "name", "kind", "status", "capabilities", "models", "profiles"].sort(),
    );
    expect(providers[0]).not.toHaveProperty("base_url");
    expect(providers[0]).not.toHaveProperty("prices");
    const adminResponse = await internalCall(env, f.admin, { path: "/providers" });
    expect(adminResponse.status).toBe(200);
    const adminProviders = await adminResponse.json<any[]>();
    expect(adminProviders.map((p) => p.id)).toContain(foreign.id);
    expect(adminProviders.find((p) => p.id === shared.id)).toMatchObject({
      profiles: [f.profile, other.profile], base_url: "https://api.example.com/v1", prices,
    });
    expect((await listProviders(env, f.admin)).find((p) => p.id === shared.id))
      .toMatchObject({ profiles: [f.profile, other.profile], base_url: "https://api.example.com/v1", prices });
    const usage = await internalCall(env, reader, { path: `/providers/${shared.id}/usage` });
    expect(usage.status).toBe(403);
    await expect(command(f, "provider.usage", { id: shared.id }, reader))
      .rejects.toMatchObject({ status: 403 });
    // O acesso completo também não transforma um operator em administrador.
    await expect(command(f, "provider.usage", { id: shared.id }, { ...reader, access: ["*"] }))
      .rejects.toMatchObject({ status: 403 });
    expect((await internalCall(env, reader, { path: `/providers/${foreign.id}/usage` })).status).toBe(403);
    const adminUsage = await internalCall(env, f.admin, { path: `/providers/${shared.id}/usage` });
    expect(adminUsage.status).toBe(200);
    expect((await adminUsage.json<any>()).data).toMatchObject([{ requests: 2, estimate_usd: 4 }]);
    expect((await command(f, "provider.usage", { id: shared.id })).data)
      .toMatchObject([{ requests: 2, estimate_usd: 4 }]);
  });

  it("não salva quando o teste falha, force salva sem verificação e rotate preserva vínculos", async () => {
    const f = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(KEY, { status: 401 })),
    );
    await expect(create(f)).rejects.toMatchObject({
      code: "provider_test_failed",
    });
    expect(await all(env, "SELECT * FROM ai_providers")).toEqual([]);
    const forced = await create(f, { force: true });
    expect(forced.verified_at).toBeNull();
    expect(forced.models).toEqual([]);
    network();
    const bot = await connection(f, "openai", { provider_id: forced.id });
    const checked = await command(f, "provider.test", { id: forced.id });
    expect(checked.verified_at).toBeTypeOf("number");
    expect(checked.capabilities.text).toBe(true);
    await command(f, "provider.rotate", { id: forced.id, api_key: ROTATED });
    expect(json((await connRow(bot.id)).config).provider_id).toBe(forced.id);
    expect(await connectionKey(env, await connRow(bot.id))).toBe(ROTATED);
    const fingerprint = (
      await one(
        env,
        "SELECT key_fingerprint FROM ai_providers WHERE id=?",
        forced.id,
      )
    ).key_fingerprint;
    expect(fingerprint).toBe(await providerFingerprint(env, ROTATED));
    expect(fingerprint).not.toBe(
      await providerFingerprint(
        { ...env, MASTER_KEY: env.MASTER_KEY + "outra" },
        ROTATED,
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(KEY, { status: 403 })),
    );
    await expect(
      command(f, "provider.rotate", { id: forced.id, api_key: KEY }),
    ).rejects.toMatchObject({ code: "provider_test_failed" });
    expect(await connectionKey(env, await connRow(bot.id))).toBe(ROTATED);
  });

  it("limita áreas, recusa segredos por bot e recusa o ator do motor em toda operação", async () => {
    network();
    const f = await fixture(),
      other = await fixture();
    const own = await create(f),
      foreign = await create(other);
    for (const op of [
      "create",
      "update",
      "rotate",
      "revoke",
      "delete",
      "merge",
      "test",
    ])
      await expect(
        command(f, `provider.${op}`, { id: own.id, api_key: KEY }, f.member),
      ).rejects.toMatchObject({ status: 403 });
    const response = await internalCall(env, f.member, { path: "/providers" });
    expect(response.status).toBe(200);
    expect((await response.json<any[]>()).map((p) => p.id)).toEqual([own.id]);
    expect((await listProviders(env, f.admin)).map((p) => p.id)).toContain(
      foreign.id,
    );
    const via = {
      kind: "bot" as const,
      bot_id: uid(),
      run_id: uid(),
      masked: true,
    };
    for (const actor of [
      { ...f.admin, via },
      { ...f.admin, id: "bot:" + uid() },
    ]) {
      for (const op of ["provider.create", "provider.rotate", "jev"])
        await expect(
          command(f, op, { id: own.id, api_key: KEY }, actor),
        ).rejects.toMatchObject({
          status: 403,
          code: "secret_requires_person",
        });
      await expect(
        command(f, "jev", { key: KEY }, actor),
      ).rejects.toMatchObject({ code: "secret_requires_person" });
    }
    const engine = engineActor(f.profile, uid());
    for (const op of [
      "create",
      "update",
      "rotate",
      "revoke",
      "delete",
      "merge",
      "test",
      "usage",
    ])
      await expect(
        command(f, `provider.${op}`, { id: own.id }, engine),
      ).rejects.toThrow("ator do motor");
    await expect(listProviders(env, engine)).rejects.toThrow("ator do motor");
    await expect(
      command(f, "connection.create", {
        kind: "ai",
        name: "Bot",
        provider_id: foreign.id,
        model: "modelo-teste",
      }),
    ).rejects.toMatchObject({ code: "provider_not_allowed" });
    await expect(
      command(f, "jev", { provider_id: foreign.id }),
    ).rejects.toMatchObject({ code: "provider_not_allowed" });
  });

  it("identifica iguais, junta áreas e vínculos, bloqueia exclusão em uso", async () => {
    network();
    const f = await fixture(),
      other = await fixture();
    const keep = await create(f),
      remove = await create(other);
    const bot = await connection(other, "openai", { provider_id: remove.id });
    expect(
      (await listProviders(env, f.admin)).find((p) => p.id === keep.id)
        ?.same_key_as,
    ).toEqual([remove.id]);
    await expect(
      command(f, "provider.delete", { id: remove.id }),
    ).rejects.toMatchObject({
      status: 409,
      providerUses: [
        { kind: "connection", id: bot.id, profile_id: other.profile },
      ],
    });
    const conflict = await internalCall(env, f.admin, {
      path: `/providers/${remove.id}`,
      method: "DELETE",
      body: {},
    });
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json<any>();
    expect(conflictBody.error.uses).toEqual([
      { kind: "connection", id: bot.id, profile_id: other.profile },
    ]);
    noKey(conflictBody);
    await command(f, "provider.merge", { keep: keep.id, remove: remove.id });
    expect(json((await connRow(bot.id)).config).provider_id).toBe(keep.id);
    expect(
      json(
        (
          await one(
            env,
            "SELECT profiles FROM ai_providers WHERE id=?",
            keep.id,
          )
        ).profiles,
      ),
    ).toEqual([f.profile, other.profile]);
    expect(
      (await one(env, "SELECT status FROM ai_providers WHERE id=?", remove.id))
        .status,
    ).toBe("revoked");
    expect(
      await one(
        env,
        "SELECT value FROM secrets WHERE id=?",
        `provider:${remove.id}`,
      ),
    ).toBeNull();
    expect(await command(f, "provider.delete", { id: remove.id })).toEqual({
      id: remove.id,
      deleted: true,
    });
    const different = await create(f, { api_key: ROTATED });
    await expect(
      command(f, "provider.merge", { keep: keep.id, remove: different.id }),
    ).rejects.toMatchObject({ status: 400 });
    const a = await create(f, { kind: "typesafe" }),
      b = await create(other, { kind: "typesafe" });
    await command(other, "jev", { provider_id: b.id });
    await expect(
      command(f, "provider.delete", { id: b.id }),
    ).rejects.toMatchObject({
      status: 409,
      providerUses: [
        { kind: "jev", id: other.profile, profile_id: other.profile },
      ],
    });
    await command(f, "provider.merge", { keep: a.id, remove: b.id });
    expect(
      json(
        (
          await one(
            env,
            "SELECT settings FROM profiles WHERE id=?",
            other.profile,
          )
        ).settings,
      ).jev_provider_id,
    ).toBe(a.id);
  });

  it("revogado ou fora da área falha sem usar o cofre antigo e vai à equipe", async () => {
    const calls = network();
    const f = await fixture(),
      p = await create(f);
    const bot = await connection(f, "openai", { provider_id: p.id });
    await setSecret(env, `connection:${bot.id}`, { api_key: KEY });
    await command(f, "provider.update", {
      id: p.id,
      profiles: [],
    });
    await expect(connectionKey(env, await connRow(bot.id))).rejects.toThrow(
      "Este provedor não está liberado para esta área.",
    );
    await command(f, "provider.update", { id: p.id, profiles: [f.profile] });
    await command(f, "provider.revoke", { id: p.id });
    const c = await receive(f, f.line, "Preciso de atendimento");
    await exec(
      env,
      "UPDATE conversations SET state='ai',assigned_bot_id=? WHERE id=?",
      bot.bot,
      c.id,
    );
    const execution = await run(f, bot.bot, c);
    const before = calls.length;
    await processRun(env, execution);
    expect(
      await one(
        env,
        "SELECT status,error FROM bot_runs WHERE id=?",
        execution.id,
      ),
    ).toMatchObject({
      status: "failed",
      error: "Provedor revogado: escolha outro.",
    });
    expect(
      (await one(env, "SELECT state FROM conversations WHERE id=?", c.id))
        .state,
    ).not.toBe("ai");
    expect(
      await one(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='bot.run.failed'",
        f.profile,
      ),
    ).toBeTruthy();
    expect(
      calls.slice(before).some((call) => call.url.endsWith("/responses")),
    ).toBe(false);
    expect((await secret(env, `connection:${bot.id}`)).api_key).toBe(KEY);
    const jev = await create(f, { kind: "typesafe", api_key: KEY_JEV });
    await setSecret(env, `jev:${f.profile}`, { key: KEY_JEV });
    await command(f, "provider.revoke", { id: jev.id });
    expect(
      await askJev(
        env,
        f.profile,
        { jev_provider_id: jev.id },
        {},
        { q: { type: "noul", instructions: "Sim?" } },
      ),
    ).toMatchObject({ ok: false, reason: "Provedor revogado: escolha outro." });
  });

  it("trocar chave pela conexão rotaciona o provedor exclusivo sem deixar chave antiga ativa", async () => {
    network();
    const f = await fixture();
    const saved = await command(f, "connection.create", {
      kind: "ai", name: "Bot", config: { provider: "openai", model: "modelo-teste" }, api_key: KEY,
    });
    const before = (await listProviders(env, f.admin)).map((p) => p.id);
    await command(f, "connection.update", { id: saved.id, api_key: ROTATED });
    expect(json((await connRow(saved.id)).config).provider_id).toBe(saved.provider_id);
    expect((await secret(env, `provider:${saved.provider_id}`)).api_key).toBe(ROTATED);
    expect(await connectionKey(env, await connRow(saved.id))).toBe(ROTATED);
    expect((await listProviders(env, f.admin)).map((p) => p.id)).toEqual(before);
    for (const row of await all(env, "SELECT id FROM ai_providers WHERE status='active'"))
      expect((await secret(env, `provider:${row.id}`)).api_key).not.toBe(KEY);
  });

  it("trocar chave pela conexão reativa o mesmo provedor exclusivo revogado", async () => {
    network();
    const f = await fixture();
    const saved = await command(f, "connection.create", {
      kind: "ai", name: "Bot", config: { provider: "openai", model: "modelo-teste" }, api_key: KEY,
    });
    await command(f, "provider.revoke", { id: saved.provider_id });
    expect(await secret(env, `provider:${saved.provider_id}`)).toEqual({});
    await command(f, "connection.update", { id: saved.id, api_key: ROTATED });
    expect(json((await connRow(saved.id)).config).provider_id).toBe(saved.provider_id);
    expect(await all(env, "SELECT id,status FROM ai_providers"))
      .toEqual([{ id: saved.provider_id, status: "active" }]);
    expect((await secret(env, `provider:${saved.provider_id}`)).api_key).toBe(ROTATED);
    expect(await connectionKey(env, await connRow(saved.id))).toBe(ROTATED);
  });

  it("trocar openai por anthropic com chave nova cria provedor e revoga o exclusivo antigo", async () => {
    const calls = network();
    const f = await fixture();
    const saved = await command(f, "connection.create", {
      kind: "ai", name: "Bot", config: { provider: "openai", model: "modelo-teste" }, api_key: KEY,
    });
    const changed = await command(f, "connection.update", {
      id: saved.id, api_key: ROTATED, config: { provider: "anthropic", model: ANTHROPIC_MODELS[0] },
    });
    expect(changed.provider_id).not.toBe(saved.provider_id);
    expect(json((await connRow(saved.id)).config)).toMatchObject({
      provider_id: changed.provider_id, provider: "anthropic", model: ANTHROPIC_MODELS[0],
    });
    expect(await one(env, "SELECT kind,status FROM ai_providers WHERE id=?", changed.provider_id))
      .toMatchObject({ kind: "anthropic", status: "active" });
    expect(await one(env, "SELECT status FROM ai_providers WHERE id=?", saved.provider_id))
      .toMatchObject({ status: "revoked" });
    expect(await secret(env, `provider:${saved.provider_id}`)).toEqual({});
    expect(await one(env, "SELECT id FROM secrets WHERE id=?", `provider:${saved.provider_id}`)).toBeNull();
    expect(await connectionKey(env, await connRow(saved.id))).toBe(ROTATED);
    expect(calls).toEqual([]); // O cadastro implícito não testa a chave contra o serviço antigo.
  });

  it.each(["openai", "compatible"])("trocar base_url e chave do provedor exclusivo %s cria outro e apaga o segredo antigo", async (provider) => {
    network();
    const f = await fixture();
    const saved = await command(f, "connection.create", {
      kind: "ai", name: "Bot", api_key: KEY,
      config: { provider, model: "modelo-teste", base_url: "https://old.example.com/v1" },
    });
    const changed = await command(f, "connection.update", {
      id: saved.id, api_key: ROTATED, config: { base_url: "https://new.example.com/v1/" },
    });
    expect(changed.provider_id).not.toBe(saved.provider_id);
    expect(json((await connRow(saved.id)).config).provider_id).toBe(changed.provider_id);
    expect(await one(env, "SELECT kind,base_url,status FROM ai_providers WHERE id=?", changed.provider_id))
      .toMatchObject({ kind: provider, base_url: "https://new.example.com/v1", status: "active" });
    expect(await one(env, "SELECT status FROM ai_providers WHERE id=?", saved.provider_id))
      .toMatchObject({ status: "revoked" });
    expect(await secret(env, `provider:${saved.provider_id}`)).toEqual({});
    expect(await connectionKey(env, await connRow(saved.id))).toBe(ROTATED);
  });

  it.each([
    { label: "modelo vazio", edit: { model: "" }, shared: false },
    { label: "nome vazio antes do rotate", edit: { name: "" }, shared: false },
    { label: "nome vazio antes de criar provedor", edit: { name: "" }, shared: true },
  ])("edição com chave e $label falha sem alterar conexão nem provedores", async ({ edit, shared }) => {
    const calls = network();
    const f = await fixture();
    const saved = await command(f, "connection.create", {
      kind: "ai", name: "Bot", config: { provider: "openai", model: "modelo-teste" }, api_key: KEY,
    });
    if (shared) await connection(f, "openai", { provider_id: saved.provider_id });
    const before = await connRow(saved.id);
    const providers = await all(env, "SELECT * FROM ai_providers ORDER BY id");
    const secrets = await all(env, "SELECT * FROM secrets ORDER BY id");
    await expect(command(f, "connection.update", { id: saved.id, api_key: ROTATED, ...edit }))
      .rejects.toMatchObject({ status: 400 });
    expect(await connRow(saved.id)).toEqual(before);
    expect(await all(env, "SELECT * FROM ai_providers ORDER BY id")).toEqual(providers);
    expect(await all(env, "SELECT * FROM secrets ORDER BY id")).toEqual(secrets);
    expect((await secret(env, `provider:${saved.provider_id}`)).api_key).toBe(KEY);
    expect(calls).toEqual([]);
  });

  it("trocar chave de provedor compartilhado cria outro e preserva a outra conexão", async () => {
    network();
    const f = await fixture(), p = await create(f);
    const first = await connection(f, "openai", { provider_id: p.id });
    const second = await connection(f, "openai", { provider_id: p.id });
    await exec(env, "UPDATE connections SET status='paused' WHERE id=?", first.id);
    await command(f, "connection.update", { id: first.id, api_key: ROTATED });
    expect(json((await connRow(first.id)).config).provider_id).not.toBe(p.id);
    expect(json((await connRow(second.id)).config).provider_id).toBe(p.id);
    expect(await connectionKey(env, await connRow(first.id))).toBe(ROTATED);
    expect(await connectionKey(env, await connRow(second.id))).toBe(KEY);
    expect(await listProviders(env, f.admin)).toHaveLength(2);
  });

  it("compatibilidade cria provedor implícito, reutiliza por id e mantém a chave antiga no rollback", async () => {
    network();
    const f = await fixture();
    const saved = await command(f, "connection.create", {
      kind: "ai",
      name: "Bot antigo",
      config: { provider: "openai", model: "modelo-teste" },
      api_key: KEY,
    });
    expect(saved.provider_id).toMatch(/^p-/);
    expect(await connectionKey(env, await connRow(saved.id))).toBe(KEY);
    const second = await command(f, "connection.create", {
      kind: "ai",
      name: "Segundo",
      provider_id: saved.provider_id,
      model: "modelo-teste",
    });
    expect(second.provider_id).toBe(saved.provider_id);
    await command(f, "connection.update", {
      id: second.id,
      provider_id: saved.provider_id,
      model: "outro-modelo",
    });
    expect(json((await connRow(second.id)).config).model).toBe("outro-modelo");
    await setSecret(env, `connection:${saved.id}`, { api_key: KEY });
    await command(f, "provider.rotate", {
      id: saved.provider_id,
      api_key: ROTATED,
    });
    expect(await connectionKey(env, await connRow(saved.id))).toBe(ROTATED);
    expect((await secret(env, `connection:${saved.id}`)).api_key).toBe(KEY);
    const jev = await command(f, "jev", { api_key: KEY_JEV });
    expect(jev.provider_id).toBeTruthy();
    expect(
      json(
        (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
          .settings,
      ).jev_provider_id,
    ).toBe(jev.provider_id);
    const changed = await command(f, "jev", { api_key: ROTATED });
    expect(changed.provider_id).toBe(jev.provider_id);
    expect((await secret(env, `provider:${jev.provider_id}`)).api_key).toBe(
      ROTATED,
    );
  });

  it("habilita com o cofre do provedor e mantém as guardas de teste, área e revogação", async () => {
    const calls = network();
    const f = await fixture(),
      p = await create(f);
    const bot = await connection(f, "openai", { provider_id: p.id });
    await exec(env, "UPDATE bots SET enabled=0 WHERE id=?", bot.bot);
    const enable = () =>
      command(f, "bot.update", { id: bot.bot, enabled: true });
    const enabled = async () =>
      (await one(env, "SELECT enabled FROM bots WHERE id=?", bot.bot)).enabled;
    await expect(enable()).rejects.toThrow("Teste a conexão");
    expect(await enabled()).toBe(0);
    await command(f, "connection.test", { id: bot.id });
    expect(await secret(env, `connection:${bot.id}`)).toEqual({});
    await enable();
    expect(await enabled()).toBe(1);

    await command(f, "bot.update", { id: bot.bot, enabled: false });
    await setSecret(env, `connection:${bot.id}`, { api_key: KEY });
    const before = calls.length;
    await command(f, "provider.update", { id: p.id, profiles: [] });
    await expect(enable()).rejects.toThrow("Este provedor não está liberado para esta área.");
    expect(await enabled()).toBe(0);
    await command(f, "provider.update", { id: p.id, profiles: [f.profile] });
    await command(f, "provider.revoke", { id: p.id });
    await expect(enable()).rejects.toThrow("Provedor revogado");
    expect(await enabled()).toBe(0);
    expect(calls).toHaveLength(before);

    // Sem vínculo explícito, o cadastro legado ainda pode ser habilitado.
    await exec(
      env,
      "UPDATE connections SET config=json_remove(config,'$.provider_id') WHERE id=?",
      bot.id,
    );
    await enable();
    expect(await enabled()).toBe(1);
  });
});

describe("provedores: consumo e a chave nunca sai", () => {
  it.each(["sk-proj-", "sk-ant-api03-", ""])(
    "preserva prefixos públicos e oculta chave inteira e trechos aleatórios: %s",
    (prefix) => {
      const random = "AbCdEf012345MnOpQr678901StUvWx234567";
      const key = prefix + random;
      const publicText = "Prefixos públicos sk-proj-, sk-ant-a e sk-ant-api03-; AbCdEf01234 e StUvWx23456.";
      expect(hideProviderKey(publicText, key)).toBe(publicText);
      noKey(publicText, [key]);
      for (const fragment of [key, "AbCdEf012345", "StUvWx234567"]) {
        expect(hideProviderKey(fragment, key)).toBe("[oculto]");
        expect(() => noKey(fragment, [key])).toThrow();
      }
      noKey(hideProviderKey(`${key} AbCdEf012345 StUvWx234567`, key), [key]);
    },
  );

  it("não procura trecho aleatório com menos de 12 caracteres", () => {
    const key = "sk-proj-12345678901";
    expect(hideProviderKey("sk-proj- 12345678901", key)).toBe("sk-proj- 12345678901");
    expect(hideProviderKey(key, key)).toBe("[oculto]");
  });

  it("oculta e verifica a chave inteira mesmo com menos de 12 caracteres", () => {
    const key = "AbCdEf01234";
    expect(hideProviderKey(`Chave: ${key}`, key)).toBe("Chave: [oculto]");
    expect(() => noKey(key, [key])).toThrow();
    noKey(hideProviderKey(key, key), [key]);
  });

  it("remove só dias com mais de 400 dias", async () => {
    const old = new Date(now() - 401 * 86400000).toISOString().slice(0, 10);
    const edge = new Date(now() - 400 * 86400000).toISOString().slice(0, 10);
    for (const day of [old, edge])
      await exec(
        env,
        "INSERT INTO ai_usage_daily(provider_id,profile_id,use,model,day) VALUES('p-retencao','area','jev','modelo',?)",
        day,
      );
    await pruneProviderUsage(env);
    expect(
      (
        await all(
          env,
          "SELECT day FROM ai_usage_daily WHERE provider_id='p-retencao'",
        )
      ).map((r) => r.day),
    ).toEqual([edge]);
  });
  it("duas execuções somam tokens e pedidos; preço só aparece quando cadastrado", async () => {
    network();
    const f = await fixture(),
      p = await create(f);
    const bot = await connection(f, "openai", { provider_id: p.id });
    for (let i = 0; i < 2; i++) await processRun(env, await run(f, bot.bot));
    const daily = await one(
      env,
      "SELECT * FROM ai_usage_daily WHERE provider_id=?",
      p.id,
    );
    expect(daily).toMatchObject({
      profile_id: f.profile,
      use: `bot:${bot.bot}`,
      model: "modelo-teste",
      day: new Date().toISOString().slice(0, 10),
      requests: 2,
      input: 160,
      cache_read: 40,
      output: 20,
    });
    let usage = await command(f, "provider.usage", { id: p.id });
    expect(usage.data[0]).not.toHaveProperty("estimate_usd");
    await command(f, "provider.update", {
      id: p.id,
      prices: { "modelo-teste": { input: 2, cache_read: 0.1, output: 10 } },
    });
    usage = await command(f, "provider.usage", { id: p.id, days: 1 });
    expect(usage.data[0].estimate_usd).toBeCloseTo(0.000524, 8);
    const jev = await create(f, { kind: "typesafe", api_key: KEY_JEV });
    const execution = await run(f, bot.bot);
    for (let i = 0; i < 2; i++)
      await runDecide(
        env,
        execution,
        { jev_provider_id: jev.id },
        { pergunta: "O pedido é urgente?", tipo: "sim_nao" },
        true,
        { pedido: "Urgente", conversa: [] },
      );
    expect(
      await one(
        env,
        "SELECT requests,input,output,use FROM ai_usage_daily WHERE provider_id=?",
        jev.id,
      ),
    ).toEqual({ requests: 2, input: 100, output: 4, use: "jev" });
  });

  it("varre todas as respostas, eventos, execuções, logs e catálogo de ferramentas", async () => {
    const spies = [
      "log",
      "info",
      "warn",
      "error",
      "debug",
      "trace",
      "dir",
      "dirxml",
      "table",
      "assert",
      "group",
      "groupCollapsed",
      "groupEnd",
      "count",
      "countReset",
      "time",
      "timeEnd",
      "timeLog",
    ]
      .filter((method) => typeof (console as any)[method] === "function")
      .map((method) =>
        vi.spyOn(console, method as "log").mockImplementation(() => {}),
      );
    const calls = network(true),
      f = await fixture();
    const responses: any[] = [];
    const p = await create(f);
    responses.push(p);
    const other = await create(f);
    responses.push(other);
    responses.push(
      await command(f, "provider.update", {
        id: p.id,
        capabilities: { text: true, tools: true },
        prices: { "modelo-teste": { input: 1 } },
      }),
    );
    responses.push(
      await command(f, "provider.rotate", { id: p.id, api_key: KEY }),
    );
    responses.push(await command(f, "provider.test", { id: p.id }));
    responses.push(
      await command(f, "provider.merge", { keep: p.id, remove: other.id }),
    );
    responses.push(await command(f, "provider.revoke", { id: other.id }));
    responses.push(await command(f, "provider.delete", { id: other.id }));
    const bot = await connection(f, "openai", { provider_id: p.id });
    await processRun(env, await run(f, bot.bot));
    responses.push(
      await command(f, "provider.rotate", { id: p.id, api_key: ROTATED }),
    );
    responses.push(await command(f, "provider.test", { id: p.id }));
    const execution = await run(f, bot.bot);
    await processRun(env, execution);
    const jev = await create(f, { kind: "typesafe", api_key: KEY_JEV });
    responses.push(jev);
    responses.push(await command(f, "provider.test", { id: jev.id }));
    responses.push(await command(f, "jev", { provider_id: jev.id }));
    const decision = await askJev(
      env,
      f.profile,
      { jev_provider_id: jev.id },
      {},
      { q: { type: "noul", instructions: "Sim?" } },
    );
    expect(decision.ok).toBe(true);
    responses.push(decision);
    await addJevUsage(env, execution.id, decision.usage);
    for (const id of [p.id, jev.id]) {
      const stored = await one(
        env,
        "SELECT models FROM ai_providers WHERE id=?",
        id,
      );
      expect(json(stored.models, []).sort()).toEqual([
        "jev-1.14.0",
        "modelo-teste",
      ]);
    }
    responses.push(await command(f, "provider.usage", { id: p.id }));
    for (const path of ["/providers", `/providers/${p.id}/usage`]) {
      const response = await internalCall(env, f.admin, { path });
      expect(response.status).toBe(200);
      responses.push(await response.json());
    }
    for (const body of [
      { provider_id: p.id, base_url: "https://destino-indevido.example.com" },
      { provider_id: jev.id },
      { connection_id: bot.id },
      { provider: "openai", api_key: KEY },
      { provider: "openai", api_key: ROTATED },
      { provider: "typesafe", api_key: KEY_JEV },
    ]) {
      const response = await internalCall(env, f.admin, {
        path: `/profiles/${f.profile}/ai-models`,
        method: "POST",
        body,
      });
      expect(response.status).toBe(200);
      const models = await response.json<{ data: string[] }>();
      expect([...models.data].sort()).toEqual(["jev-1.14.0", "modelo-teste"]);
      responses.push(models);
    }
    for (const key of keys)
      expect(
        calls.some(
          (call) =>
            call.url.endsWith("/models") && call.key === `Bearer ${key}`,
        ),
      ).toBe(true);
    for (const key of [KEY, ROTATED])
      expect(
        calls.some(
          (call) =>
            call.url.endsWith("/responses") && call.key === `Bearer ${key}`,
        ),
      ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.url.endsWith("/systemone") && call.key === `Bearer ${KEY_JEV}`,
      ),
    ).toBe(true);
    expect(calls.some((call) => call.url.includes("destino-indevido"))).toBe(
      false,
    );
    // O catálogo atual só inclui operações dos módulos; provedores não são alcançáveis por consultar.
    const operations = await catalogFor(env, f.admin, f.profile);
    expect(operations.some((op) => op.path.includes("providers"))).toBe(false);
    responses.push(operations);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ROTATED, { status: 401 })),
    );
    const failedTest = command(f, "provider.test", { id: p.id });
    await expect(failedTest).rejects.toMatchObject({
      status: 502,
      code: "provider_test_failed",
    });
    await failedTest.catch((error) =>
      responses.push({ code: error.code, message: error.message }),
    );
    responses.push(await all(env, "SELECT * FROM events"));
    responses.push(await all(env, "SELECT usage,result,error FROM bot_runs"));
    noKey(responses);
    noKey(spies.map((spy) => spy.mock.calls));
    const fingerprints = await all(
      env,
      "SELECT key_fingerprint FROM ai_providers WHERE key_fingerprint IS NOT NULL",
    );
    for (const row of fingerprints)
      expect(JSON.stringify(responses)).not.toContain(row.key_fingerprint);
  });
});
