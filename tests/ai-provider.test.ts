import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { defaults, json, now, uid, type Actor, type Run } from "../src/types";
import { secret, setSecret } from "../src/security";
import { inbound, perform } from "../src/service";
import { processInbox, processRun } from "../src/engine";
import { teamDirectory } from "../src/team";
import { aiListModels } from "../src/ai-provider";

afterEach(() => vi.unstubAllGlobals());

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
const answer = {
  action: "answer",
  text: "Atendemos de segunda a sexta, das 9h às 18h.",
  citations: ["atendimento-horario"],
  capability_id: null,
  menu_id: null,
  protocol_number: null,
  category_id: null,
};

type Call = { url: string; method: string; headers: Headers; body: any };
function mockFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const request = input instanceof Request ? input : null;
      const call: Call = {
        url: String(request ? request.url : input),
        method: (init.method || request?.method || "GET").toUpperCase(),
        headers: new Headers(init.headers || request?.headers),
        body: init.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      return reply(call);
    }),
  );
  return calls;
}
const anthropicMessage = (text: string, stop_reason = "end_turn") =>
  Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
const openaiMessage = (content: string, finish_reason = "stop") =>
  Response.json({
    id: "chatcmpl-test",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason },
    ],
  });

async function profileRow() {
  const profile = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    profile,
    "Área",
    JSON.stringify(defaults),
    now(),
  );
  return profile;
}

/** Área com uma linha WhatsApp e um bot de provedor de IA como Atendente. */
async function serviceFixture(config: Record<string, any>) {
  const profile = await profileRow(),
    line = uid(),
    ai = uid(),
    bot = uid();
  await exec(
    env,
    "UPDATE profiles SET settings=? WHERE id=?",
    JSON.stringify({ ...defaults, attendant_bot: bot }),
    profile,
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'meta','api','active',?,?)",
    line,
    profile,
    "WhatsApp",
    JSON.stringify({
      number: "5511999999999",
      service: { menu_mode: "manual" },
    }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'ai','direct','active',?,?)",
    ai,
    profile,
    "Bia",
    JSON.stringify({ text_only: true, verified_at: now(), ...config }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Bia',1)",
    bot,
    profile,
    ai,
  );
  await setSecret(env, `connection:${ai}`, { api_key: "test-provider-key" });
  return { profile, line, ai, bot };
}
let counter = 0;
async function receive(
  f: { profile: string; line: string },
  text: string,
  attachments: { type: string }[] = [],
) {
  const ids: string[] = [];
  for (const attachment of attachments) {
    const id = uid();
    await env.MEDIA.put(`${f.profile}/${id}`, new Uint8Array([1, 2, 3]));
    await exec(
      env,
      "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
      id,
      f.profile,
      "anexo",
      attachment.type,
      3,
      `${f.profile}/${id}`,
      "system",
      now(),
    );
    ids.push(id);
  }
  const received = await inbound(
    env,
    f.profile,
    {
      external_id: "5511888888888",
      message_id: `m${++counter}`,
      text,
      attachments: ids,
    },
    `channel:${f.line}`,
    f.line,
  );
  await processInbox(env, f.profile);
  return received.conversation_id as string;
}
const runOf = async (conversation: string) =>
  (await one(
    env,
    "SELECT * FROM bot_runs WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
    conversation,
  )) as Run | null;
const fresh = async (run: Run) =>
  (await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id)) as Run;
const outbox = (conversation: string) =>
  all(
    env,
    "SELECT * FROM outbox WHERE conversation_id=? ORDER BY created,rowid",
    conversation,
  );
// As fontes do Atendente vêm da busca; para respostas citadas, a execução
// recebe uma fonte conhecida.
async function withSource(run: Run) {
  await exec(
    env,
    "UPDATE bot_runs SET context=? WHERE id=?",
    JSON.stringify({
      ...json(run.context),
      sources: [
        {
          id: "atendimento-horario",
          document_id: "doc-horario",
          text: "Horário: segunda a sexta, 9h às 18h.",
          url: "",
        },
      ],
    }),
    run.id,
  );
  return fresh(run);
}

describe("cadastro da conexão de provedor de IA", () => {
  it("valida provedor, modelo, endereço e chave", async () => {
    const profile = await profileRow();
    const save = (data: any) =>
      perform(env, admin, profile, "connection.save", data, uid());
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: {},
        secrets: { api_key: "sk-test-123456" },
      }),
    ).rejects.toThrow("Escolha o provedor");
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: { provider: "anthropic", model: "claude-3-opus" },
        secrets: { api_key: "sk-test-123456" },
      }),
    ).rejects.toThrow("modelos da Anthropic");
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: { provider: "compatible", model: "llama" },
        secrets: { api_key: "sk-test-123456" },
      }),
    ).rejects.toThrow("URL da API");
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: {
          provider: "compatible",
          model: "llama",
          base_url: "http://10.0.0.1/v1",
        },
        secrets: { api_key: "sk-test-123456" },
      }),
    ).rejects.toThrow();
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: { provider: "deepseek", model: "deepseek-chat" },
      }),
    ).rejects.toThrow("chave de API");
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: { provider: "deepseek", model: "deepseek-chat" },
        secrets: { api_key: "sk-test-123456", dashboard_token: "x" },
      }),
    ).rejects.toThrow("só a chave");
    // Esforço: a DeepSeek só tem none, low e high; acima de "high" não é oferecido.
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: {
          provider: "deepseek",
          model: "deepseek-flash",
          effort: "medium",
        },
        secrets: { api_key: "sk-test-123456" },
      }),
    ).rejects.toThrow("Esforço inválido");
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: { provider: "openai", model: "gpt-test", effort: "none" },
        secrets: { api_key: "sk-test-123456" },
      }),
    ).rejects.toThrow("Esforço inválido");
    const deepseek: any = await save({
      name: "DS",
      kind: "ai",
      config: { provider: "deepseek", model: "deepseek-flash" },
      secrets: { api_key: "sk-test-123456" },
    });
    expect(
      json(
        (
          await one(
            env,
            "SELECT config FROM connections WHERE id=?",
            deepseek.id,
          )
        ).config,
      ).effort,
    ).toBe("low");
    await expect(
      save({
        name: "IA",
        kind: "ai",
        config: { provider: "anthropic", effort: "max" },
        secrets: { api_key: "sk-test-123456" },
      }),
    ).rejects.toThrow("Esforço inválido");

    const saved: any = await save({
      name: "IA",
      kind: "ai",
      config: { provider: "anthropic", url: "https://hermes.example.com" },
      secrets: { api_key: " sk-ant-test-123456 " },
    });
    const row = await one(
      env,
      "SELECT * FROM connections WHERE id=?",
      saved.id,
    );
    expect(row.status).toBe("paused");
    expect(json(row.config)).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      vision: true,
      effort: "low",
      text_only: true,
    });
    expect((await secret(env, `connection:${saved.id}`)).api_key).toBe(
      "sk-ant-test-123456",
    );
    // Editar sem informar a chave mantém a cadastrada.
    await save({
      id: saved.id,
      name: "IA",
      kind: "ai",
      config: {
        provider: "anthropic",
        model: "claude-haiku-5-5",
        text_only: false,
      },
      secrets: {},
    });
    const edited = await one(
      env,
      "SELECT * FROM connections WHERE id=?",
      saved.id,
    );
    expect(json(edited.config)).toMatchObject({
      model: "claude-haiku-5-5",
      text_only: false,
    });
    expect((await secret(env, `connection:${saved.id}`)).api_key).toBe(
      "sk-ant-test-123456",
    );
  });

  it("o teste cria um único bot e libera habilitá-lo", async () => {
    const profile = await profileRow();
    const saved: any = await perform(
      env,
      admin,
      profile,
      "connection.save",
      {
        name: "Bia",
        kind: "ai",
        config: { provider: "anthropic", model: "claude-sonnet-5-5" },
        secrets: { api_key: "sk-ant-test-123456" },
      },
      uid(),
    );
    const bots = () =>
      all(env, "SELECT * FROM bots WHERE connection_id=?", saved.id);
    const calls = mockFetch((call) =>
      call.url.endsWith("/v1/models/claude-sonnet-5-5")
        ? Response.json({
            id: "claude-sonnet-5-5",
            type: "model",
            display_name: "Claude Sonnet 5.5",
            created_at: "2026-01-01T00:00:00Z",
          })
        : new Response("unexpected", { status: 500 }),
    );
    const tested: any = await perform(
      env,
      admin,
      profile,
      "connection.test",
      { id: saved.id },
      uid(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("authorization")).toBe(
      "Bearer sk-ant-test-123456",
    );
    expect(tested.bots).toHaveLength(1);
    await perform(
      env,
      admin,
      profile,
      "connection.test",
      { id: saved.id },
      uid(),
    );
    const [bot] = await bots();
    expect((await bots()).length).toBe(1);
    expect(bot).toMatchObject({ name: "Bia", enabled: 0 });
    expect(
      json(
        (await one(env, "SELECT config FROM connections WHERE id=?", saved.id))
          .config,
      ).verified_at,
    ).toBeTruthy();
    await perform(
      env,
      admin,
      profile,
      "bot.update",
      { id: bot.id, enabled: true },
      uid(),
    );
    expect(
      (await one(env, "SELECT enabled FROM bots WHERE id=?", bot.id)).enabled,
    ).toBe(1);
  });

  it("chave recusada no teste não cria bot", async () => {
    const profile = await profileRow();
    const saved: any = await perform(
      env,
      admin,
      profile,
      "connection.save",
      {
        name: "DS",
        kind: "ai",
        config: { provider: "deepseek", model: "deepseek-chat" },
        secrets: { api_key: "sk-wrong-123456" },
      },
      uid(),
    );
    mockFetch(() =>
      Response.json({ error: { message: "bad key" } }, { status: 401 }),
    );
    await expect(
      perform(env, admin, profile, "connection.test", { id: saved.id }, uid()),
    ).rejects.toThrow("recusou a chave");
    expect(
      await all(env, "SELECT * FROM bots WHERE connection_id=?", saved.id),
    ).toHaveLength(0);
  });

  it("bot de IA não pode ser especialista nem item de menu do tipo bot", async () => {
    const f = await serviceFixture({ provider: "openai", model: "gpt-test" });
    await expect(
      perform(
        env,
        admin,
        f.profile,
        "settings",
        {
          capabilities: [
            {
              id: "c1",
              name: "Boleto",
              bot_id: f.bot,
              condition: "x",
              instructions: "y",
              enabled: true,
            },
          ],
        },
        uid(),
      ),
    ).rejects.toThrow("Especialistas precisam de um bot Hermes");
    await expect(
      perform(
        env,
        admin,
        f.profile,
        "settings",
        {
          menus: [
            { id: "m1", label: "Financeiro", type: "bot", bot_id: f.bot },
          ],
        },
        uid(),
      ),
    ).rejects.toThrow("Itens de menu do tipo bot precisam de um bot Hermes");
    // Como Atendente, o mesmo bot é aceito.
    await perform(
      env,
      admin,
      f.profile,
      "settings",
      { attendant_bot: f.bot },
      uid(),
    );
  });
});

describe("modelos e esforço", () => {
  it("lista modelos de chat da OpenAI e só os atuais da Anthropic", async () => {
    const calls = mockFetch((call) =>
      call.url.startsWith("https://api.openai.com/")
        ? Response.json({
            data: [
              { id: "gpt-test" },
              { id: "text-embedding-3-large" },
              { id: "whisper-1" },
              { id: "a-chat-model" },
            ],
          })
        : Response.json({
            data: [
              { id: "claude-sonnet-5-5", type: "model" },
              { id: "claude-3-opus", type: "model" },
            ],
            has_more: false,
            first_id: null,
            last_id: null,
          }),
    );
    expect(await aiListModels("openai", "sk-test-123456")).toEqual([
      "a-chat-model",
      "gpt-test",
    ]);
    expect(calls[0].url).toBe("https://api.openai.com/v1/models");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-test-123456");
    expect(await aiListModels("anthropic", "sk-ant-test-123456")).toEqual([
      "claude-sonnet-5-5",
    ]);
  });

  it("teste da OpenAI confere o modelo na conta e o esforço numa chamada curta", async () => {
    const profile = await profileRow();
    const saved: any = await perform(
      env,
      admin,
      profile,
      "connection.save",
      {
        name: "GPT",
        kind: "ai",
        config: { provider: "openai", model: "gpt-test", effort: "medium" },
        secrets: { api_key: "sk-test-123456" },
      },
      uid(),
    );
    let listed = ["gpt-test"];
    const calls = mockFetch((call) =>
      call.url.endsWith("/models")
        ? Response.json({ data: listed.map((id) => ({ id })) })
        : openaiMessage("", "length"),
    );
    await perform(
      env,
      admin,
      profile,
      "connection.test",
      { id: saved.id },
      uid(),
    );
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/chat/completions",
    ]);
    expect(calls[1].body.reasoning_effort).toBe("medium");
    expect(calls[1].body.max_completion_tokens).toBe(16);
    expect(calls[1].body.max_tokens).toBeUndefined();
    listed = ["outro-modelo"];
    await expect(
      perform(env, admin, profile, "connection.test", { id: saved.id }, uid()),
    ).rejects.toThrow("não está disponível nesta conta");
  });

  it("API compatível sem /models é testada só pela chamada", async () => {
    const profile = await profileRow();
    const saved: any = await perform(
      env,
      admin,
      profile,
      "connection.save",
      {
        name: "Compat",
        kind: "ai",
        config: {
          provider: "compatible",
          model: "llama-test",
          base_url: "https://llm.example.com/v1",
        },
        secrets: { api_key: "sk-test-123456" },
      },
      uid(),
    );
    const calls = mockFetch((call) =>
      call.url.endsWith("/models")
        ? new Response("not found", { status: 404 })
        : openaiMessage("ok"),
    );
    await perform(
      env,
      admin,
      profile,
      "connection.test",
      { id: saved.id },
      uid(),
    );
    expect(calls[1].url).toBe("https://llm.example.com/v1/chat/completions");
    expect(calls[1].body.max_tokens).toBe(16);
    expect(calls[1].body.reasoning_effort).toBeUndefined();
  });

  it("o esforço escolhido vai na chamada de atendimento", async () => {
    const f = await serviceFixture({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      effort: "high",
    });
    const conversation = await receive(f, "Qual o horário?");
    const run = await withSource((await runOf(conversation))!);
    const calls = mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    await processRun(env, run);
    expect(calls[0].body.output_config.effort).toBe("high");

    const g = await serviceFixture({
      provider: "openai",
      model: "gpt-test",
      effort: "low",
    });
    const second = await receive(g, "Qual o horário?");
    const other = await withSource((await runOf(second))!);
    const openaiCalls = mockFetch(() => openaiMessage(JSON.stringify(answer)));
    await processRun(env, other);
    expect(openaiCalls[0].body.reasoning_effort).toBe("low");
    expect(openaiCalls[0].body.max_completion_tokens).toBeUndefined();

    const h = await serviceFixture({
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "none",
    });
    const third = await receive(h, "Qual o horário?");
    const deepseekRun = await withSource((await runOf(third))!);
    const deepseekCalls = mockFetch(() =>
      openaiMessage(JSON.stringify(answer)),
    );
    await processRun(env, deepseekRun);
    expect(deepseekCalls[0].url).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(deepseekCalls[0].body.reasoning_effort).toBe("none");
    expect(deepseekCalls[0].body.response_format).toEqual({
      type: "json_object",
    });
  });
});

describe("atendimento por provedor de IA", () => {
  it("OpenAI: uma única passada responde ao cliente", async () => {
    const f = await serviceFixture({
      provider: "openai",
      model: "gpt-test",
      vision: true,
    });
    const conversation = await receive(f, "Qual o horário de atendimento?");
    let run = (await runOf(conversation))!;
    expect(run.status).toBe("queued");
    run = await withSource(run);
    const calls = mockFetch(() => openaiMessage(JSON.stringify(answer)));
    await processRun(env, run);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe(
      "Bearer test-provider-key",
    );
    expect(calls[0].body.model).toBe("gpt-test");
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(calls[0].body.messages[0].role).toBe("system");
    expect(calls[0].body.messages[0].content).toContain("Você é o Atendente");
    expect(calls[0].body.messages[0].content).toContain("não gera arquivos");
    expect(calls[0].body.messages[0].content).not.toContain("artifact_id");
    expect((await fresh(run)).status).toBe("completed");
    const sent = await outbox(conversation);
    expect(sent.map((row) => json(row.payload).text)).toContain(answer.text);
  });

  it("Anthropic: saída estruturada, esforço baixo e sem thinking", async () => {
    const f = await serviceFixture({
      provider: "anthropic",
      model: "claude-opus-5-5",
      vision: true,
    });
    const conversation = await receive(f, "Qual o horário de atendimento?");
    const run = await withSource((await runOf(conversation))!);
    const calls = mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    await processRun(env, run);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers.get("authorization")).toBe(
      "Bearer test-provider-key",
    );
    const body = calls[0].body;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toContain("Você é o Atendente");
    expect(body.thinking).toBeUndefined();
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages).toHaveLength(1);
    expect((await fresh(run)).status).toBe("completed");
    expect(
      (await outbox(conversation)).map((row) => json(row.payload).text),
    ).toContain(answer.text);
  });

  it("Anthropic: imagem do cliente vai como bloco de imagem", async () => {
    const f = await serviceFixture({
      provider: "anthropic",
      model: "claude-opus-5-5",
      vision: true,
    });
    const conversation = await receive(f, "Veja a foto", [
      { type: "image/png" },
    ]);
    const run = await withSource((await runOf(conversation))!);
    expect(json(run.context).images).toHaveLength(1);
    const calls = mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    await processRun(env, run);
    const content = calls[0].body.messages[0].content;
    expect(content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
    expect(content.at(-1).type).toBe("text");
  });

  it("falha passageira tenta de novo e, vencido o prazo, transfere", async () => {
    const f = await serviceFixture({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    const conversation = await receive(f, "Oi, preciso de ajuda");
    let run = (await runOf(conversation))!;
    const calls = mockFetch(() => new Response("busy", { status: 503 }));
    await processRun(env, run);
    run = await fresh(run);
    expect(run.status).toBe("queued");
    expect(run.error).toContain("indisponível");
    // Dentro do intervalo mínimo não chama de novo.
    await processRun(env, run);
    expect(calls).toHaveLength(1);
    await exec(
      env,
      "UPDATE bot_runs SET created=?,updated=? WHERE id=?",
      now() - 200000,
      now() - 20000,
      run.id,
    );
    await processRun(env, await fresh(run));
    expect(calls).toHaveLength(2);
    expect((await fresh(run)).status).toBe("failed");
    expect(
      (
        await one(
          env,
          "SELECT state FROM conversations WHERE id=?",
          conversation,
        )
      ).state,
    ).not.toBe("ai");
  });

  it("chave recusada ou recusa do modelo transferem na hora", async () => {
    const f = await serviceFixture({ provider: "openai", model: "gpt-test" });
    const first = await receive(f, "Oi");
    mockFetch(() => new Response("no", { status: 401 }));
    const run = (await runOf(first))!;
    await processRun(env, run);
    expect((await fresh(run)).status).toBe("failed");
    expect((await fresh(run)).error).toContain("recusou a chave");

    const g = await serviceFixture({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    const second = await receive(g, "Oi");
    mockFetch(() => anthropicMessage("", "refusal"));
    const refused = (await runOf(second))!;
    await processRun(env, refused);
    expect((await fresh(refused)).status).toBe("failed");
    expect((await fresh(refused)).error).toContain("recusou responder");
  });

  it("cancelada enquanto o provedor respondia não envia nada", async () => {
    const f = await serviceFixture({ provider: "openai", model: "gpt-test" });
    const conversation = await receive(f, "Oi");
    const run = await withSource((await runOf(conversation))!);
    mockFetch(async () => {
      await exec(
        env,
        "UPDATE bot_runs SET status='cancelled' WHERE id=?",
        run.id,
      );
      return openaiMessage(JSON.stringify(answer));
    });
    await processRun(env, run);
    expect((await fresh(run)).status).toBe("cancelled");
    expect(
      (await outbox(conversation)).map((r) => json(r.payload).text),
    ).not.toContain(answer.text);
  });

  it("apenas mensagens: áudio e vídeo recebem um único aviso e seguem com o bot", async () => {
    const f = await serviceFixture({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    const conversation = await receive(f, "", [{ type: "audio/ogg" }]);
    await receive(f, "", [{ type: "video/mp4" }]);
    expect(await runOf(conversation)).toBeNull();
    const notices = (await outbox(conversation)).filter((row) =>
      String(row.dedupe).startsWith("textonly:"),
    );
    expect(notices).toHaveLength(1);
    expect(json(notices[0].payload).text).toContain(
      "apenas mensagens de texto",
    );
    expect(
      (
        await one(
          env,
          "SELECT state FROM conversations WHERE id=?",
          conversation,
        )
      ).state,
    ).toBe("ai");
    // Depois de uma resposta do bot, um novo áudio gera outro aviso.
    await receive(f, "Qual o horário?");
    const run = await withSource((await runOf(conversation))!);
    mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    await processRun(env, run);
    expect((await outbox(conversation)).at(-1)?.dedupe).toBe(`run:${run.id}`);
    await receive(f, "", [{ type: "audio/ogg" }]);
    expect(
      (await outbox(conversation)).filter((row) =>
        String(row.dedupe).startsWith("textonly:"),
      ),
    ).toHaveLength(2);
  });

  it("sem apenas mensagens, áudio vai para a equipe", async () => {
    const f = await serviceFixture({
      provider: "anthropic",
      model: "claude-opus-5-5",
      text_only: false,
    });
    const calls = mockFetch(() => new Response("unexpected", { status: 500 }));
    const conversation = await receive(f, "", [{ type: "audio/ogg" }]);
    expect(calls).toHaveLength(0);
    expect(await runOf(conversation)).toBeNull();
    expect(
      (
        await one(
          env,
          "SELECT state FROM conversations WHERE id=?",
          conversation,
        )
      ).state,
    ).not.toBe("ai");
  });

  it("imagem para modelo sem visão vai para a equipe", async () => {
    const f = await serviceFixture({
      provider: "deepseek",
      model: "deepseek-chat",
      vision: false,
    });
    const conversation = await receive(f, "Veja", [{ type: "image/jpeg" }]);
    expect(await runOf(conversation)).toBeNull();
    expect(
      (
        await one(
          env,
          "SELECT state FROM conversations WHERE id=?",
          conversation,
        )
      ).state,
    ).not.toBe("ai");
  });

  it("bot de IA aparece online na equipe quando a conexão está ativa", async () => {
    const f = await serviceFixture({ provider: "openai", model: "gpt-test" });
    const directory: any = await teamDirectory(env, admin, f.profile);
    const bot = directory.data.find((item: any) => item.bot_id === f.bot);
    expect(bot.online).toBe(true);
  });
});
