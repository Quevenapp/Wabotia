import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { defaults, json, now, uid, type Actor, type Run } from "../src/types";
import { secret, setSecret } from "../src/security";
import { inbound, perform } from "../src/service";
import { processInbox, processRun, splitAreaInput } from "../src/engine";
import { teamDirectory } from "../src/team";
import {
  AREA_LABEL,
  aiComplete,
  aiCompleteWithTools,
  aiListModels,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_OUTPUT_TOKENS_DEEP,
  AI_RUN_DEADLINE_MS,
  AiError,
  PDF_LIMITS,
  PDF_TOKENS_PER_PAGE,
  pdfPages,
  pdfPageCount,
  PDF_INFLATE_LIMITS,
  stableSystem,
} from "../src/ai-provider";
import { usageText } from "../web/lib/usage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
      const response = await reply(call);
      return call.url.endsWith("/responses") ? asResponses(response, call.body) : response;
    }),
  );
  return calls;
}
/**
 * A OpenAI responde pelo Responses (src/ai-provider.ts): a resposta simulada
 * no formato do chat/completions vira o formato do Responses (status,
 * incomplete_details, output com output_text, usage em input/output_tokens).
 * O raciocínio cifrado só volta quando o pedido inclui esse campo.
 */
async function asResponses(response: Response, body: any) {
  if (!response.ok) return response;
  const data: any = await response.clone().json().catch(() => null);
  const choice = data?.choices?.[0];
  if (!choice) {
    if (Array.isArray(data?.output) && !body?.include?.includes("reasoning.encrypted_content")) {
      for (const item of data.output)
        if (item.type === "reasoning") delete item.encrypted_content;
      return Response.json(data);
    }
    return response;
  }
  const cut = choice.finish_reason === "length" ? "max_output_tokens" : choice.finish_reason === "content_filter" ? "content_filter" : null;
  const u = data.usage;
  return Response.json({
    id: "resp_test",
    status: cut ? "incomplete" : "completed",
    incomplete_details: cut ? { reason: cut } : null,
    output: choice.message?.content
      ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: choice.message.content }] }]
      : [],
    usage: u
      ? {
          input_tokens: u.prompt_tokens,
          input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
          output_tokens: u.completion_tokens,
        }
      : undefined,
  });
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
  attachments: { type: string; bytes?: Uint8Array }[] = [],
) {
  const ids: string[] = [];
  for (const attachment of attachments) {
    const id = uid();
    const bytes = attachment.bytes ?? new Uint8Array([1, 2, 3]);
    await env.MEDIA.put(`${f.profile}/${id}`, bytes);
    await exec(
      env,
      "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
      id,
      f.profile,
      "anexo",
      attachment.type,
      bytes.length,
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
        config: { provider: "openai", model: "gpt-test", effort: "maximo" },
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
        config: { provider: "anthropic", effort: "none" },
        secrets: { api_key: "sk-test-123456" },
      }),
    ).rejects.toThrow("Esforço inválido");
    // Every level each provider documents is accepted.
    for (const [provider, effort] of [
      ["anthropic", "xhigh"],
      ["anthropic", "max"],
      ["deepseek", "max"],
      ["openai", "minimal"],
      ["openai", "xhigh"],
    ])
      await save({
        name: "IA",
        kind: "ai",
        config: {
          provider,
          model: provider === "anthropic" ? undefined : "m",
          effort,
        },
        secrets: { api_key: "sk-test-123456" },
      });

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
      provider_id: saved.provider_id,
      provider: "anthropic",
      model: "claude-opus-5-5",
      vision: true,
      // "O modelo entende PDF": ligada de fábrica na Anthropic.
      pdf: true,
      effort: "low",
      text_only: true,
    });
    expect((await secret(env, `provider:${saved.provider_id}`)).api_key).toBe(
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
    expect((await secret(env, `provider:${saved.provider_id}`)).api_key).toBe(
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

  it("bot de IA no menu assume a conversa como atendente", async () => {
    const f = await serviceFixture({ provider: "openai", model: "gpt-test" });
    await perform(
      env,
      admin,
      f.profile,
      "settings",
      {
        menus: [{ id: "m1", label: "Financeiro", type: "bot", bot_id: f.bot }],
      },
      uid(),
    );
    await exec(
      env,
      "UPDATE connections SET config=? WHERE id=?",
      JSON.stringify({
        number: "5511999999999",
        service: { menu_mode: "automatic" },
      }),
      f.line,
    );
    const conversation = await receive(f, "oi");
    expect(await runOf(conversation)).toBeNull();
    await receive(f, "1");
    const run = (await runOf(conversation))!;
    expect(run).toMatchObject({ bot_id: f.bot, phase: "attendant" });
    expect(json(run.input).request).toContain("Financeiro");
    expect(
      (
        await one(
          env,
          "SELECT assigned_bot_id FROM conversations WHERE id=?",
          conversation,
        )
      ).assigned_bot_id,
    ).toBe(f.bot);
  });

  it("bot de IA pode ser especialista e só recebe as consultas da conversa", async () => {
    const f = await serviceFixture({ provider: "openai", model: "gpt-test" });
    // Segundo bot de IA (outra conexão), como especialista.
    const ai2 = uid(),
      specialist = uid();
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'ai','direct','active',?,?)",
      ai2,
      f.profile,
      "Fin",
      JSON.stringify({
        text_only: true,
        verified_at: now(),
        provider: "openai",
        model: "gpt-test",
      }),
      now(),
    );
    await exec(
      env,
      "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Fin',1)",
      specialist,
      f.profile,
      ai2,
    );
    await setSecret(env, `connection:${ai2}`, { api_key: "test-provider-key" });
    await perform(
      env,
      admin,
      f.profile,
      "module.set",
      { id: "agenda", enabled: true },
      uid(),
    );
    // O servidor aceita (antes: "Especialistas precisam de um bot Hermes").
    await perform(
      env,
      admin,
      f.profile,
      "settings",
      {
        capabilities: [
          {
            id: "c1",
            name: "Agenda",
            bot_id: specialist,
            condition: "Quando o cliente perguntar dos serviços",
            instructions: "Consulte os serviços da agenda",
            enabled: true,
          },
        ],
      },
      uid(),
    );
    const conversation = await receive(f, "Quais serviços vocês fazem?");
    const attendant = (await runOf(conversation))!;
    mockFetch(() =>
      openaiMessage(
        JSON.stringify({ ...answer, action: "consult", capability_id: "c1" }),
      ),
    );
    await processRun(env, attendant);
    const run = (await runOf(conversation))!;
    expect(run).toMatchObject({ bot_id: specialist, phase: "specialist" });
    const calls = mockFetch(() =>
      openaiMessage(
        JSON.stringify({ outcome: "resolved", text: "Corte e barba." }),
      ),
    );
    await processRun(env, run);
    // Só ferramentas de leitura dos módulos: nada que escreva ou proponha.
    // OpenAI pelo Responses: definição {type:"function", name, ...}.
    const tools = (calls[0].body.tools || []).map((tool: any) => tool.name);
    expect(tools).toContain("agenda_servicos");
    expect(tools).not.toContain("agenda_agendar");
    expect(tools).not.toContain("agenda_cancelar");
    expect(calls[0].body.instructions).toContain(
      "ferramentas de consulta da conversa",
    );
    // O resultado volta ao Atendente como fonte.
    const back = (await runOf(conversation))!;
    expect(back).toMatchObject({ bot_id: f.bot, phase: "answer" });
  });
});

describe("modelos e esforço", () => {
  it.each(["anthropic", "openai", "deepseek", "compatible"])("%s limita a saída com e sem ferramentas", async (provider) => {
    expect(AI_MAX_OUTPUT_TOKENS).toBe(16000);
    expect(AI_MAX_OUTPUT_TOKENS_DEEP).toBe(32000);
    const conn = { id: uid(), config: "" };
    await setSecret(env, `connection:${conn.id}`, { api_key: "test-provider-key" });
    const calls = mockFetch(() => provider === "anthropic" ? anthropicMessage("pronto") : openaiMessage("pronto"));
    for (const effort of ["low", "high", "xhigh", "max"]) {
      conn.config = JSON.stringify({ provider, model: provider === "anthropic" ? "claude-haiku-5-5" : "modelo-teste", effort, base_url: "https://llm.example.com/v1" });
      const request = { instructions: "Responda.", input: "Oi" };
      await aiComplete(env, conn, request);
      await aiCompleteWithTools(env, conn, { ...request, tools: [], run: async () => "{}" });
      for (const call of calls.slice(-2)) {
        const field = provider === "openai" ? "max_output_tokens" : "max_tokens";
        expect(call.body[field]).toBe(["xhigh", "max"].includes(effort) ? 32000 : 16000);
      }
    }
    expect(calls).toHaveLength(8);
  });

  it.each(["anthropic", "openai", "deepseek", "compatible"])("%s reduz o timeout ao prazo restante e não inicia rodada após seis minutos", async (provider) => {
    expect(AI_RUN_DEADLINE_MS).toBe(360_000);
    const conn = { id: uid(), config: JSON.stringify({ provider, model: "modelo-teste", effort: "max", base_url: "https://llm.example.com/v1" }) };
    await setSecret(env, `connection:${conn.id}`, { api_key: "test-provider-key" });
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const calls = mockFetch(() => Response.json(provider === "anthropic" ? {
      id: "msg", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "tool_use", id: "t1", name: "eco", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
    } : provider === "openai" ? {
      status: "completed", output: [{ type: "function_call", call_id: "t1", name: "eco", arguments: "{}" }],
    } : {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "eco", arguments: "{}" } }] } }],
    }));
    let runs = 0;
    const result = aiCompleteWithTools(env, conn, {
      instructions: "Consulte.", input: "Oi",
      tools: [{ name: "eco", description: "Ecoa.", schema: { type: "object", properties: {} } }],
      run: async () => {
        clock += runs++ === 0 ? AI_RUN_DEADLINE_MS - 1000 : 1000;
        return "{}";
      },
    });
    await expect(result).rejects.toBeInstanceOf(AiError);
    await expect(result).rejects.toMatchObject({ transient: false, message: expect.stringContaining("excedeu o prazo") });
    expect(calls).toHaveLength(2);
    expect(runs).toBe(2);
    expect(timeouts).toHaveBeenCalledWith(1000);
  });

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
      "https://api.openai.com/v1/responses",
    ]);
    // Responses: esforço em reasoning, teto curto em max_output_tokens; a
    // resposta cortada (incomplete) ainda prova chave e modelo.
    expect(calls[1].body.reasoning).toEqual({ effort: "medium" });
    expect(calls[1].body.max_output_tokens).toBe(16);
    expect(calls[1].body.store).toBe(false);
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
      effort: "max",
    });
    const conversation = await receive(f, "Qual o horário?");
    const run = await withSource((await runOf(conversation))!);
    const calls = mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    await processRun(env, run);
    expect(calls[0].body.output_config.effort).toBe("max");
    // O esforço máximo usa o teto ampliado para raciocinar antes da resposta.
    expect(calls[0].body.max_tokens).toBe(AI_MAX_OUTPUT_TOKENS_DEEP);

    const g = await serviceFixture({
      provider: "openai",
      model: "gpt-test",
      effort: "low",
    });
    const second = await receive(g, "Qual o horário?");
    const other = await withSource((await runOf(second))!);
    const openaiCalls = mockFetch(() => openaiMessage(JSON.stringify(answer)));
    await processRun(env, other);
    expect(openaiCalls[0].body.reasoning).toEqual({ effort: "low" });
    expect(openaiCalls[0].body.max_output_tokens).toBe(AI_MAX_OUTPUT_TOKENS);

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
    expect(deepseekCalls[0].body.max_tokens).toBe(AI_MAX_OUTPUT_TOKENS);
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
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].headers.get("authorization")).toBe(
      "Bearer test-provider-key",
    );
    expect(calls[0].body.model).toBe("gpt-test");
    expect(calls[0].body.store).toBe(false);
    expect(calls[0].body.text).toEqual({ format: { type: "json_object" } });
    expect(calls[0].body.instructions).toContain("Você é o Atendente");
    expect(calls[0].body.instructions).toContain("não gera arquivos");
    expect(calls[0].body.instructions).not.toContain("artifact_id");
    // Modo JSON: a API real exige "json" nas mensagens do input (400 sem isso).
    expect(calls[0].body.input[0]).toEqual({
      role: "developer",
      content: [{ type: "input_text", text: "Responda somente com um objeto JSON válido." }],
    });
    expect(calls[0].body.input[1]).toMatchObject({ role: "user", content: [{ type: "input_text" }] });
    expect((await fresh(run)).status).toBe("completed");
    const sent = await outbox(conversation);
    expect(sent.map((row) => json(row.payload).text)).toContain(answer.text);
  });

  it("um Olá respondido sem fonte não abre protocolo", async () => {
    const f = await serviceFixture({
      provider: "deepseek",
      model: "deepseek-flash",
    });
    const conversation = await receive(f, "Olá");
    const run = await runOf(conversation);
    expect(run).toBeTruthy();
    mockFetch(() =>
      openaiMessage(
        JSON.stringify({
          ...answer,
          text: "Olá! Como posso ajudar?",
          citations: [],
        }),
      ),
    );
    await processRun(env, run!);
    const sent = await outbox(conversation);
    expect(sent.map((row) => json(row.payload).text)).toContain(
      "Olá! Como posso ajudar?",
    );
    expect(
      await all(
        env,
        "SELECT id FROM tickets WHERE conversation_id=?",
        conversation,
      ),
    ).toHaveLength(0);
    expect(
      (
        await one(
          env,
          "SELECT state FROM conversations WHERE id=?",
          conversation,
        )
      ).state,
    ).toBe("ai");
  });

  it("resposta à pergunta do bot não volta ao menu", async () => {
    const f = await serviceFixture({
      provider: "deepseek",
      model: "deepseek-flash",
    });
    await perform(
      env,
      admin,
      f.profile,
      "settings",
      {
        menus: [{ id: "fagoo", label: "Fagoo", type: "content", content: "x" }],
      },
      uid(),
    );
    const conversation = await receive(f, "Preciso de ajuda com um aplicativo");
    mockFetch(() =>
      openaiMessage(
        JSON.stringify({
          ...answer,
          action: "clarify",
          text: "Claro. Qual aplicativo você quer tratar e o que precisa?",
          citations: [],
        }),
      ),
    );
    await processRun(env, (await runOf(conversation))!);
    await receive(f, "Fagoo");
    const first = (await runOf(conversation))!;
    let calls = mockFetch(() =>
      openaiMessage(JSON.stringify({ ...answer, action: "menu", text: "" })),
    );
    await processRun(env, first);
    // The menu is not sent; the same turn is asked again without it.
    const retry = (await runOf(conversation))!;
    expect(retry.id).not.toBe(first.id);
    expect(json(retry.context).no_menu).toBe(true);
    expect(
      (await outbox(conversation)).some(
        (row) => json(row.payload).automation === "menu",
      ),
    ).toBe(false);
    calls = mockFetch(() =>
      openaiMessage(
        JSON.stringify({
          ...answer,
          action: "clarify",
          text: "Certo, Fagoo. O que está acontecendo?",
          citations: [],
        }),
      ),
    );
    await processRun(env, retry);
    expect(calls[0].body.messages[0].content).toContain("não use a ação menu");
    expect(
      (await outbox(conversation)).map((row) => json(row.payload).text),
    ).toContain("Certo, Fagoo. O que está acontecendo?");
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
    // Sistema em blocos: o estável com o ponto de cache.
    expect(body.system[0].text).toContain("Você é o Atendente");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
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

// ---------------------------------------------------------------------------
// Cache de prompt e PDF (docs/PROVEDOR-IA.md, "Cache de prompt" e "PDF").

/** Provedor simulado da Anthropic que imita o cache por prefixo: lê o que já viu. */
function cachingAnthropic(text: string) {
  const seen = new Set<string>();
  return mockFetch((call) => {
    const prefix = JSON.stringify({ tools: call.body.tools ?? null, system: call.body.system[0] });
    const hit = seen.has(prefix);
    seen.add(prefix);
    return Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: call.body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        cache_creation_input_tokens: hit ? 0 : 2000,
        cache_read_input_tokens: hit ? 2000 : 0,
        output_tokens: 20,
      },
    });
  });
}
const usageOf = async (run: Run) => json((await fresh(run)).usage, null);
/** PDF mínimo com `pages` objetos /Type /Page. */
const pdf = (pages: number, extra = 0) =>
  new TextEncoder().encode(
    "%PDF-1.4\n" +
      Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join("") +
      "x".repeat(extra) +
      "\n%%EOF",
  );
const state = async (conversation: string) =>
  (await one(env, "SELECT state FROM conversations WHERE id=?", conversation)).state;

describe("cache de prompt do provedor de IA", () => {
  it("duas execuções seguidas da mesma área: a segunda lê do cache; o uso fica em Execuções de bots", async () => {
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true });
    const calls = cachingAnthropic(JSON.stringify(answer));
    const first = await withSource((await runOf(await receive(f, "Qual o horário?")))!);
    await processRun(env, first);
    const second = await withSource((await runOf(await receive(f, "E no sábado?")))!);
    await processRun(env, second);
    expect(calls).toHaveLength(2);
    expect(await usageOf(first)).toEqual({ input: 40, cache_read: 0, cache_write: 2000, output: 20 });
    expect(await usageOf(second)).toEqual({ input: 40, cache_read: 2000, cache_write: 0, output: 20 });
  });

  it("o prefixo estável (ferramentas e bloco do sistema) tem os mesmos bytes entre montagens da mesma área", async () => {
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true });
    const calls = mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    // Outra conversa, outra mensagem, outra hora e um acréscimo da execução.
    const a = await withSource((await runOf(await receive(f, "Qual o horário?")))!);
    await processRun(env, a);
    const other = { ...f };
    const conv = await receive(other, "Outra pergunta, bem diferente, com mais texto.");
    let b = await withSource((await runOf(conv))!);
    await exec(env, "UPDATE bot_runs SET context=? WHERE id=?", JSON.stringify({ ...json(b.context), no_menu: true }), b.id);
    b = await fresh(b);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_600_000);
    await processRun(env, b);
    vi.useRealTimers();
    const prefix = (body: any) => JSON.stringify({ tools: body.tools ?? null, system: body.system[0] });
    expect(prefix(calls[1].body)).toBe(prefix(calls[0].body));
    // O acréscimo vai depois do ponto de cache, num segundo bloco sem ponto.
    expect(calls[0].body.system).toHaveLength(1);
    expect(calls[1].body.system[1].text).toContain("não use a ação menu");
    expect(calls[1].body.system[1].cache_control).toBeUndefined();
  });

  it("montagem nova e antiga: o modelo recebe o mesmo conteúdo, com menus, ações e categorias no bloco estável", async () => {
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true });
    const calls = mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    // Casos: pergunta simples e a mesma com o acréscimo "não use menu". Cada
    // um processado logo depois de chegar (a mensagem nova cancela a anterior).
    for (const [text, noMenu] of [
      ["Qual o horário?", false],
      ["Sim, quero", true],
    ] as const) {
      let run = await withSource((await runOf(await receive(f, text)))!);
      if (noMenu) {
        await exec(env, "UPDATE bot_runs SET context=? WHERE id=?", JSON.stringify({ ...json(run.context), no_menu: true }), run.id);
        run = await fresh(run);
      }
      await processRun(env, run);
      const body = calls.at(-1)!.body;
      const stable: string = body.system[0].text;
      const situation: string = body.system[1]?.text ?? "";
      const [instructions, areaJson] = stable.split(AREA_LABEL);
      // Antes: um JSON só na mensagem. Agora: a mensagem sem os dados da área
      // e os dados da área no sistema. Juntos, o mesmo JSON (mesmas chaves e valores).
      const user = JSON.parse(body.messages[0].content.at(-1).text);
      expect({ ...user, ...JSON.parse(areaJson) }).toEqual(JSON.parse(run.input));
      expect(Object.keys(JSON.parse(areaJson)).sort()).toEqual(["actions", "categories", "menus"]);
      // As instruções: o mesmo texto de antes, só com o acréscimo depois do ponto.
      expect(instructions + situation).toContain("Você é o Atendente");
      expect(situation === "" || (instructions + situation).endsWith(situation)).toBe(true);
    }
  });

  it("OpenAI e DeepSeek: sistema estável primeiro e o uso normalizado de cada um", async () => {
    const openai = await serviceFixture({ provider: "openai", model: "gpt-test" });
    let calls = mockFetch(() =>
      Response.json({
        id: "x",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1024 } },
      }),
    );
    const r1 = await withSource((await runOf(await receive(openai, "Qual o horário?")))!);
    await processRun(env, r1);
    expect(calls[0].body.instructions).toContain(AREA_LABEL.trim());
    expect(await usageOf(r1)).toEqual({ input: 176, cache_read: 1024, cache_write: 0, output: 30 });
    const deepseek = await serviceFixture({ provider: "deepseek", model: "deepseek-chat" });
    calls = mockFetch(() =>
      Response.json({
        id: "x",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 12, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 260 },
      }),
    );
    const r2 = await withSource((await runOf(await receive(deepseek, "Qual o horário?")))!);
    await processRun(env, r2);
    expect(await usageOf(r2)).toEqual({ input: 260, cache_read: 640, cache_write: 0, output: 12 });
  });

  it("tela de Execuções de bots: tokens, sem valor em dinheiro", () => {
    expect(usageText(JSON.stringify({ input: 40, cache_read: 2000, cache_write: 0, output: 20 }))).toBe(
      "entrada 40 · cache lido 2.000 · cache gravado 0 · saída 20",
    );
    expect(usageText(null)).toBe("—");
  });
});

describe("PDF do cliente no provedor de IA", () => {
  it("PDF com ObjStm sem páginas legíveis vai à equipe sem chegar ao provedor", async () => {
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true, pdf: true });
    const calls = mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    const bytes = new TextEncoder().encode("%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode >>\nstream\ncomprimido\nendstream\nendobj\n%%EOF");
    expect(pdfPages(bytes)).toBeNull();
    const conversation = await receive(f, "Confira o PDF", [{ type: "application/pdf", bytes }]);
    const run = await runOf(conversation);
    if (run) await processRun(env, run);
    expect(calls).toHaveLength(0);
    expect(run).toBeNull();
    expect(await state(conversation)).not.toBe("ai");
  });

  it("PDF com páginas dentro de object streams: conta as páginas descomprimidas, com teto", async () => {
    const zlib = async (text: string) =>
      new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    // PDF como os atuais: os objetos de página só existem dentro do ObjStm comprimido.
    const objstm = async (
      pages: number,
      filler = "",
      opts: { length?: string; extra?: string; loose?: number; cut?: number } = {},
    ) => {
      let body = await zlib(
        Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n") + filler,
      );
      if (opts.cut) body = body.slice(0, body.length - opts.cut);
      const loose = Array.from(
        { length: opts.loose ?? 0 },
        (_, i) => `${i + 100} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`,
      ).join("");
      const head = new TextEncoder().encode(
        `%PDF-1.5\n${loose}1 0 obj\n<< /Type /ObjStm /N ${pages} /First 0 /Length ${opts.length ?? body.length} /Filter /FlateDecode${opts.extra ?? ""} >>\nstream\n`,
      );
      const tail = new TextEncoder().encode("\nendstream\nendobj\n%%EOF");
      const out = new Uint8Array(head.length + body.length + tail.length);
      out.set(head);
      out.set(body, head.length);
      out.set(tail, head.length + body.length);
      return out;
    };
    const three = await objstm(3);
    expect(pdfPages(three)).toBeNull();
    expect(await pdfPageCount(three)).toBe(3);
    expect(await pdfPageCount(await objstm(11))).toBe(11);
    // Bomba de descompressão: passa do teto de leitura, não conta e vai para a equipe.
    const bomb = await objstm(1, " ".repeat(PDF_INFLATE_LIMITS.bytes + 1));
    expect(bomb.length).toBeLessThan(PDF_LIMITS.bytes);
    expect(await pdfPageCount(bomb)).toBeNull();
    // Nunca contar a menos (a contagem decide o teto): na dúvida, null.
    // /Length indireto: vai até endstream e conta certo (nem "1" de "12 0 R").
    expect(await pdfPageCount(await objstm(11, "", { length: "12 0 R" }))).toBe(11);
    // Páginas soltas e comprimidas se somam: 2 + 10 = 12, acima do teto.
    const mixed = await objstm(10, "", { loose: 2 });
    expect(pdfPages(mixed)).toBe(2);
    expect(await pdfPageCount(mixed)).toBe(12);
    // Stream cortado no meio: não conta o pedaço que saiu.
    expect(await pdfPageCount(await objstm(11, "", { length: "12 0 R", cut: 20 }))).toBeNull();
    // Preditor ou cadeia de filtros: o inflate não é o texto dos objetos.
    expect(await pdfPageCount(await objstm(3, "", { extra: " /DecodeParms << /Predictor 12 >>" }))).toBeNull();
    const chain = new TextDecoder("latin1")
      .decode(three)
      .replace("/Filter /FlateDecode", "/Filter [/FlateDecode /ASCII85Decode]");
    expect(await pdfPageCount(Uint8Array.from(chain, (c) => c.charCodeAt(0)))).toBeNull();
    // Cifrado.
    const encrypted = new Uint8Array([...three, ...new TextEncoder().encode("\ntrailer << /Encrypt 9 0 R >>")]);
    expect(await pdfPageCount(encrypted)).toBeNull();
    // ObjStm mencionado sem dicionário reconhecível (maior que a janela lida).
    expect(await pdfPageCount(await objstm(3, "", { extra: " /Pad (" + "x".repeat(2000) + ")" }))).toBeNull();
    // No motor: o PDF de 3 páginas comprimidas vai ao provedor; o de 11, não.
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true, pdf: true });
    const small = await receive(f, "Segue a nota", [{ type: "application/pdf", bytes: three }]);
    expect(json((await runOf(small))!.context).documents).toHaveLength(1);
    const other = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true, pdf: true });
    const big = await receive(other, "Segue o contrato", [{ type: "application/pdf", bytes: await objstm(11) }]);
    expect(await runOf(big)).toBeNull();
  });

  it("Anthropic: o PDF vai como bloco document antes do texto, e só na mensagem em que chegou", async () => {
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true, pdf: true, bot_options: { default: { mask_personal: false } } });
    const conversation = await receive(f, "Segue a nota", [{ type: "application/pdf", bytes: pdf(2) }]);
    const run = (await runOf(conversation))!;
    expect(json(run.context).documents).toHaveLength(1);
    expect(json(run.context).sources.map((s: any) => s.text)).toContain("Documento PDF enviado pelo cliente nesta conversa.");
    const calls = mockFetch(() => anthropicMessage(JSON.stringify({ ...answer, action: "clarify", citations: [] })));
    await processRun(env, run);
    const content = calls[0].body.messages[0].content;
    expect(content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
    expect(content.at(-1).type).toBe("text");
    // Mensagem seguinte: o arquivo não vai de novo.
    const next = (await runOf(await receive(f, "Recebeu?")))!;
    expect(json(next.context).documents).toBeUndefined();
    await processRun(env, next);
    expect(calls[1].body.messages[0].content.some((b: any) => b.type === "document")).toBe(false);
  });

  it("acima do teto (11 páginas ou mais de 4 MB), mais de um PDF ou opção desligada: vai para a equipe", async () => {
    const on = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true, pdf: true, bot_options: { default: { mask_personal: false } } });
    expect(PDF_LIMITS).toEqual({ files: 1, bytes: 4 * 1024 * 1024, pages: 10 });
    expect(pdfPages(pdf(10))).toBe(10);
    expect(pdfPages(new TextEncoder().encode("%PDF-1.5 comprimido"))).toBeNull();
    const many = await receive(on, "Nota longa", [{ type: "application/pdf", bytes: pdf(11) }]);
    expect(await runOf(many)).toBeNull();
    expect(await state(many)).not.toBe("ai");
    const big = await receive(on, "Nota grande", [{ type: "application/pdf", bytes: pdf(1, 4 * 1024 * 1024) }]);
    expect(await runOf(big)).toBeNull();
    const two = await receive(on, "Duas notas", [
      { type: "application/pdf", bytes: pdf(1) },
      { type: "application/pdf", bytes: pdf(1) },
    ]);
    expect(await runOf(two)).toBeNull();
    const off = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true, pdf: false, bot_options: { default: { mask_personal: false } } });
    const refused = await receive(off, "Nota", [{ type: "application/pdf", bytes: pdf(1) }]);
    expect(await runOf(refused)).toBeNull();
    // DeepSeek e API compatível: sem formato documentado, sem PDF.
    const ds = await serviceFixture({ provider: "deepseek", model: "deepseek-chat", pdf: true, bot_options: { default: { mask_personal: false } } });
    expect(await runOf(await receive(ds, "Nota", [{ type: "application/pdf", bytes: pdf(1) }]))).toBeNull();
  });

  it("PDF que o provedor recusa (senha, corrompido): a conversa vai para a equipe com o motivo na execução", async () => {
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", vision: true, pdf: true, bot_options: { default: { mask_personal: false } } });
    const conversation = await receive(f, "Segue", [{ type: "application/pdf", bytes: pdf(1) }]);
    const run = (await runOf(conversation))!;
    mockFetch(() =>
      Response.json({ type: "error", error: { type: "invalid_request_error", message: "pdf" } }, { status: 400 }),
    );
    await processRun(env, run);
    const after = await fresh(run);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("recusou o PDF enviado pelo cliente");
    expect(await state(conversation)).not.toBe("ai");
  });

  it("OpenAI com a opção ligada: PDF como input_file do Responses", async () => {
    const f = await serviceFixture({ provider: "openai", model: "gpt-test", vision: true, pdf: true, bot_options: { default: { mask_personal: false } } });
    const run = (await runOf(await receive(f, "Segue", [{ type: "application/pdf", bytes: pdf(1) }])))!;
    const calls = mockFetch(() => openaiMessage(JSON.stringify({ ...answer, action: "clarify", citations: [] })));
    await processRun(env, run);
    const parts = calls[0].body.input.find((m: any) => m.role === "user").content;
    expect(parts[0].type).toBe("input_text");
    expect(parts.find((p: any) => p.type === "input_file")).toMatchObject({
      type: "input_file",
      filename: "documento-1.pdf",
      file_data: expect.stringMatching(/^data:application\/pdf;base64,/),
    });
  });

  it("OpenAI pelo Responses: ferramentas com raciocínio devolvido, recusa e resposta cortada", async () => {
    // Laço de ferramentas no formato do Responses (src/bot-tools.ts): os
    // itens da saída (raciocínio cifrado e chamada) voltam no input seguinte
    // com o function_call_output da chamada.
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "cifrado" };
    // O mock não entrega o cifrado de graça: o corpo precisa pedir include.
    const without = await asResponses(Response.json({ output: [reasoning] }), { store: false });
    expect((await without.json<any>()).output[0].encrypted_content).toBeUndefined();
    const withInclude = await asResponses(Response.json({ output: [reasoning] }), { store: false, include: ["reasoning.encrypted_content"] });
    expect((await withInclude.json<any>()).output[0].encrypted_content).toBe("cifrado");
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "eco", arguments: '{"texto":"oi"}' };
    const replies = [
      { id: "r1", status: "completed", output: [reasoning, call], usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 64, cache_write_tokens: 20 } } },
      { id: "r2", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "pronto" }] }], usage: { input_tokens: 120, output_tokens: 5 } },
    ];
    const calls = mockFetch(() => Response.json(replies.shift()));
    const conn = { id: uid(), config: JSON.stringify({ provider: "openai", model: "gpt-6.1-terra", effort: "low" }) };
    await setSecret(env, `connection:${conn.id}`, { api_key: "sk-test-123456" });
    const usage = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
    const seen: any[] = [];
    const text = await aiCompleteWithTools(env, conn, {
      instructions: "Use a ferramenta.",
      input: "oi",
      usage,
      tools: [{ name: "eco", description: "Ecoa.", schema: { type: "object", properties: { texto: { type: "string" } } } } as any],
      run: async (c) => {
        seen.push(c);
        return JSON.stringify({ ok: true });
      },
    });
    expect(text).toBe("pronto");
    expect(seen).toEqual([{ id: "call_1", name: "eco", args: { texto: "oi" }, invalid: false }]);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].body.tools).toEqual([
      { type: "function", name: "eco", description: "Ecoa.", parameters: { type: "object", properties: { texto: { type: "string" } } } },
    ]);
    expect(calls[0].body.tool_choice).toBe("auto");
    expect(calls[0].body.reasoning).toEqual({ effort: "low" });
    expect(calls[0].body.include).toEqual(["reasoning.encrypted_content"]);
    expect(calls[1].body.input.slice(1)).toEqual([
      reasoning,
      call,
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    ]);
    // Formato real (17/11): input_tokens inclui o lido e o gravado no cache.
    expect(usage).toEqual({ input: 136, cache_read: 64, cache_write: 20, output: 15 });

    // Recusa e resposta cortada viram o erro de sempre.
    mockFetch(() =>
      Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "não" }] }] }),
    );
    await expect(aiComplete(env, conn, { instructions: "x", input: "y" })).rejects.toThrow("recusou responder");
    mockFetch(() => Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }));
    await expect(aiComplete(env, conn, { instructions: "x", input: "y" })).rejects.toThrow("foi cortada");
  });

  it("estimativa: um PDF no teto mais o prompt de uma área cheia fica abaixo de 100 mil tokens", () => {
    // Área cheia (premissas): instruções da área com 8.000 caracteres, 50
    // categorias com nome de 100, 50 menus, 20 ações com 700 caracteres, 12
    // mensagens de 4.096 caracteres e 5 fontes de 2.000. Tokens por 3
    // caracteres (conservador para português) e PDF_TOKENS_PER_PAGE por página.
    const area = {
      menus: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, label: "x".repeat(60), type: "submenu" })),
      actions: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, description: "x".repeat(650) })),
      categories: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, name: "x".repeat(100) })),
    };
    const input = JSON.stringify({
      request: "x".repeat(4096),
      history: Array.from({ length: 12 }, () => ({ direction: "in", text: "x".repeat(4096) })),
      sources: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, text: "x".repeat(2000) })),
      ...area,
    });
    const split = splitAreaInput(input);
    const chars = stableSystem({ instructions: "x".repeat(4000 + 8000), area: split.area }).length + split.input.length;
    const estimate = Math.ceil(chars / 3) + PDF_LIMITS.pages * PDF_TOKENS_PER_PAGE;
    expect(estimate).toBeLessThan(100_000);
  });
});

describe("PDF com máscara pessoal ligada por padrão", () => {
  it.each([false, true])("texto simples/FlateDecode %s chega mascarado, sem arquivo cru", async (compressed) => {
    const { textPdf } = await import("./pii-cases.mjs");
    // Texto extraído não exige a capacidade de receber PDF binário do provedor.
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", pdf: false });
    const bytes = await textPdf("CPF 123.456.789-09, tel +55 (11) 98888-7777", compressed);
    const c = await receive(f, "Confira o documento", [{ type: "application/pdf", bytes }]);
    const run = (await runOf(c))!;
    expect(run).toBeTruthy();
    const calls = mockFetch(() => anthropicMessage(JSON.stringify({ ...answer, action: "clarify", text: "Seu CPF [CPF_1] foi registrado", citations: [] })));
    await processRun(env, run);
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      const body = JSON.stringify(call.body);
      expect(body).toContain("[CPF_1]");
      expect(body).toContain("[TEL_1]");
      for (const raw of ["123.456.789-09", "98888-7777", "data:application/pdf", '"type":"document"']) expect(body).not.toContain(raw);
    }
    expect(JSON.stringify(await outbox(c))).toContain("Seu CPF 123.456.789-09 foi registrado");
  });

  it("PDF sem texto extraível não chama o provedor e segue para a equipe", async () => {
    const f = await serviceFixture({ provider: "anthropic", model: "claude-haiku-5-5", pdf: true });
    const c = await receive(f, "Documento escaneado", [{ type: "application/pdf", bytes: pdf(1) }]);
    const calls = mockFetch(() => anthropicMessage(JSON.stringify(answer)));
    const run = (await runOf(c))!;
    await processRun(env, run);
    expect(calls).toHaveLength(0);
    expect((await fresh(run)).status).toBe("failed");
    expect((await fresh(run)).error).toContain("PDF recusado");
    expect(await state(c)).not.toBe("ai");
  });
});
