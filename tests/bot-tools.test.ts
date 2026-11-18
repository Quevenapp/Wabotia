// Formatos de ferramenta por provedor e o laço (src/bot-tools.ts), sem rede.
import { describe, expect, it } from "vitest";
import { BOT_TOOLS } from "../src/bot-actions/actions";
import { MAX_ROUNDS, parseTurn, providerFamily, toolLoop, toolsFor } from "../src/bot-tools";
import { createPiiMask } from "../src/pii-mask";

describe("bot-tools: máscara de dados pessoais no laço", () => {
  it("mascara o resultado da ferramenta e devolve os itens do modelo intactos", async () => {
    const pii = createPiiMask(true);
    // Cifrado com uma sequência que, solta, passaria por CPF válido.
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "gAAA+52998224725/Zz==" };
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "consultar", arguments: '{"cpf":"[CPF_1]"}' };
    const seen: any[] = [];
    const args: any[] = [];
    pii.mask("CPF 529.982.247-25");
    await toolLoop({
      family: "responses",
      pii,
      messages: [],
      tools: BOT_TOOLS,
      complete: async (messages) => {
        seen.push(structuredClone(messages));
        return seen.length === 1
          ? { status: "completed", output: [reasoning, call] }
          : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] };
      },
      run: async (c) => {
        args.push(c.args);
        return JSON.stringify({ telefone: "(11) 98765-4321", cpf: "529.982.247-25" });
      },
    });
    // A ferramenta recebe o valor real; o provedor só vê marcadores.
    expect(args[0]).toEqual({ cpf: "529.982.247-25" });
    const sent = seen[1];
    expect(sent).toContainEqual(reasoning);
    expect(sent).toContainEqual(call);
    const output = sent.find((m: any) => m.type === "function_call_output").output;
    expect(output).not.toContain("98765");
    expect(output).not.toContain("529.982");
    expect(output).toContain("[CPF_1]");
  });

  it("número inteiro mascarado volta como número para a ferramenta", () => {
    const pii = createPiiMask(true);
    // 52998224725 passa no dígito do CPF: vira marcador mesmo sendo um id numérico.
    const masked = pii.maskValue({ id: 52998224725, nome: "x" });
    expect(masked.id).toBe("[CPF_1]");
    expect(pii.restoreValue({ id: masked.id, texto: `ver ${masked.id}` })).toEqual({
      id: 52998224725,
      texto: "ver 52998224725",
    });
  });

  it("marcador que nasceu de texto volta texto, mesmo se a ferramenta devolver o número", () => {
    const pii = createPiiMask(true);
    // O cliente escreveu com pontuação; a ferramenta devolve o mesmo CPF como
    // número (mesmo marcador). Outro CPF nasce de número.
    expect(pii.mask("CPF 529.982.247-25")).toBe("CPF [CPF_1]");
    const masked = pii.maskValue({ cpf: 52998224725, outro: 11144477735 });
    expect(masked).toEqual({ cpf: "[CPF_1]", outro: "[CPF_2]" });
    const back = pii.restoreValue({ a: "[CPF_1]", b: "[CPF_2]" });
    // Texto volta texto (nunca NaN); o que nasceu de número volta número.
    expect(back).toEqual({ a: "529.982.247-25", b: 11144477735 });
  });
});

describe("bot-tools: formatos", () => {
  it("monta as definições de cada família", () => {
    expect(providerFamily("anthropic")).toBe("anthropic");
    // OpenAI pelo Responses; DeepSeek e compatíveis pelo chat/completions.
    expect(providerFamily("openai")).toBe("responses");
    for (const p of ["deepseek", "compatible"]) expect(providerFamily(p)).toBe("openai");
    expect(toolsFor("responses", BOT_TOOLS)[1]).toEqual({
      type: "function",
      name: "consultar",
      description: BOT_TOOLS[1].description,
      parameters: BOT_TOOLS[1].schema,
    });
    expect(toolsFor("anthropic", BOT_TOOLS)[0]).toEqual({
      name: "buscar_operacoes",
      description: BOT_TOOLS[0].description,
      input_schema: BOT_TOOLS[0].schema,
    });
    expect(toolsFor("openai", BOT_TOOLS)[1]).toEqual({
      type: "function",
      function: { name: "consultar", description: BOT_TOOLS[1].description, parameters: BOT_TOOLS[1].schema },
    });
  });

  it("Anthropic: tool_use → tool_result num só turno do usuário", async () => {
    const seen: any[] = [];
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "text", text: "Vou ver." }, { type: "tool_use", id: "t1", name: "buscar_operacoes", input: { texto: "os" } }, { type: "tool_use", id: "t2", name: "consultar", input: { operacao: "x" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Há 2 OS abertas." }] },
    ];
    const out = await toolLoop({
      family: "anthropic",
      messages: [{ role: "user", content: "OS abertas?" }],
      tools: BOT_TOOLS,
      complete: async (messages, tools, final) => {
        seen.push({ messages: structuredClone(messages), tools, final });
        return replies.shift();
      },
      run: async (call) => (call.name === "consultar" ? '{"erro":"x"}' : `ok:${call.id}`),
    });
    expect(out.text).toBe("Há 2 OS abertas.");
    const second = seen[1].messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", content: [{ type: "text" }, { type: "tool_use" }, { type: "tool_use" }] });
    expect(second.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok:t1" },
        { type: "tool_result", tool_use_id: "t2", content: '{"erro":"x"}', is_error: true },
      ],
    });
    expect(seen.every((s) => s.tools.length === 3)).toBe(true);
  });

  it("OpenAI/DeepSeek: devolve a mensagem inteira (raciocínio) e uma mensagem tool por chamada", async () => {
    const seen: any[] = [];
    const replies = [
      { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, reasoning_content: "pensando", tool_calls: [{ id: "c1", type: "function", function: { name: "consultar", arguments: '{"operacao":"consulta:service-orders"}' } }, { id: "c2", type: "function", function: { name: "consultar", arguments: "{quebrado" } }] } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Pronto." } }] },
    ];
    const out = await toolLoop({
      family: "openai",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      tools: BOT_TOOLS,
      complete: async (messages) => {
        seen.push(structuredClone(messages));
        return replies.shift();
      },
      run: async (call) => JSON.stringify(call.args),
    });
    expect(out.text).toBe("Pronto.");
    const second = seen[1];
    expect(second[2]).toMatchObject({ role: "assistant", reasoning_content: "pensando", tool_calls: expect.any(Array) });
    expect(second[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"operacao":"consulta:service-orders"}' });
    expect(second[4].content).toContain("Argumentos inválidos");
  });

  it("para depois do teto de rodadas, com a última proibindo chamadas", async () => {
    let calls = 0;
    const finals: boolean[] = [];
    const out = await toolLoop({
      family: "anthropic",
      messages: [{ role: "user", content: "loop" }],
      tools: BOT_TOOLS,
      complete: async (_m, _t, final) => {
        finals.push(final);
        calls++;
        return final
          ? { content: [{ type: "text", text: "Fim." }] }
          : { content: [{ type: "tool_use", id: `t${calls}`, name: "buscar_operacoes", input: {} }] };
      },
      run: async () => "{}",
    });
    expect(out.text).toBe("Fim.");
    expect(finals).toEqual([...Array(MAX_ROUNDS).fill(false), true]);
    expect(parseTurn("anthropic", { content: [] })).toMatchObject({ text: "", calls: [] });
  });
});
