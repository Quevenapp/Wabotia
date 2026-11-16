// Laço de ferramentas do bot por provedor de IA direto (src/ai-provider.ts),
// para a conversa interna agir pela pessoa (src/bot-actions). Aqui ficam só
// os formatos de cada provedor e o laço; a chamada HTTP fica no ai-provider.
//
// Formatos (conferidos na documentação de cada um em 16/11/2026):
// - Anthropic (Messages): tools [{name, description, input_schema}]; a
//   resposta traz blocos `tool_use` {id, name, input} com stop_reason
//   "tool_use"; o conteúdo do assistente volta inteiro e os resultados vão
//   num único turno do usuário com blocos `tool_result` {tool_use_id,
//   content, is_error}. Os modelos 5.5 não aceitam tool_choice forçado: auto.
// - OpenAI e DeepSeek (chat/completions): tools [{type:"function",
//   function:{name, description, parameters}}]; a resposta traz
//   message.tool_calls [{id, type:"function", function:{name, arguments}}]
//   (arguments é texto JSON); a mensagem do assistente volta inteira e cada
//   resultado vai como {role:"tool", tool_call_id, content}. A DeepSeek, no
//   modo de raciocínio, exige `reasoning_content` de volta nas mensagens com
//   ferramentas: devolver a mensagem inteira resolve.
// - Compatível com OpenAI: depende do serviço; quem não aceita `tools`
//   responde erro, e a tela do bot avisa.
import type { BotTool } from "./bot-actions/actions";

export type ToolProvider = "anthropic" | "openai";

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  /** Argumentos que não eram JSON válido (o resultado avisa o modelo). */
  invalid?: boolean;
}

export interface ToolTurn {
  /** Texto final (sem chamadas) ou texto que acompanha as chamadas. */
  text: string;
  calls: ToolCall[];
  /** Mensagem do assistente a devolver como veio (com raciocínio, se houver). */
  assistant: any;
}

export const providerFamily = (provider: string): ToolProvider =>
  provider === "anthropic" ? "anthropic" : "openai";

export function toolsFor(family: ToolProvider, tools: BotTool[]) {
  return family === "anthropic"
    ? tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }))
    : tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      }));
}

/** Lê a resposta do provedor como uma rodada: texto e chamadas. */
export function parseTurn(family: ToolProvider, response: any): ToolTurn {
  if (family === "anthropic") {
    const content: any[] = Array.isArray(response?.content) ? response.content : [];
    return {
      text: content
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join(""),
      calls: content
        .filter((b) => b?.type === "tool_use")
        .map((b) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} })),
      assistant: { role: "assistant", content },
    };
  }
  const message = response?.choices?.[0]?.message || {};
  const calls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
    .filter((c: any) => c?.type === "function" || c?.function)
    .map((c: any) => {
      let args: any = {};
      let invalid = false;
      try {
        args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        invalid = true;
      }
      return { id: String(c.id), name: String(c.function?.name || ""), args, invalid };
    });
  return {
    text: typeof message.content === "string" ? message.content : "",
    calls,
    assistant: { ...message, role: "assistant" },
  };
}

/** Mensagens a acrescentar depois de uma rodada com chamadas. */
export function resultMessages(
  family: ToolProvider,
  turn: ToolTurn,
  results: { id: string; content: string; error: boolean }[],
) {
  if (family === "anthropic")
    return [
      turn.assistant,
      {
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          ...(r.error ? { is_error: true } : {}),
        })),
      },
    ];
  return [
    turn.assistant,
    ...results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.content })),
  ];
}

/** Rodadas máximas de ida e volta com o provedor por resposta do bot. */
export const MAX_ROUNDS = 8;

/**
 * Laço: chama o provedor com as ferramentas, executa as chamadas (todas as
 * de uma rodada voltam juntas) e repete até vir só texto. `complete` faz a
 * chamada HTTP; `run` executa uma ferramenta e devolve o texto do
 * resultado. Passado o teto de rodadas, a última chamada proíbe novas
 * chamadas, para o modelo responder com o que já tem.
 */
export async function toolLoop(options: {
  family: ToolProvider;
  messages: any[];
  tools: BotTool[];
  /**
   * Chamada ao provedor. `final`: última rodada, com `tool_choice` "none"
   * (Anthropic e OpenAI aceitam; o histórico com chamadas exige as
   * definições presentes).
   */
  complete: (messages: any[], tools: any[], final: boolean) => Promise<any>;
  run: (call: ToolCall) => Promise<string>;
}) {
  const messages = [...options.messages];
  const tools = toolsFor(options.family, options.tools);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const turn = parseTurn(options.family, await options.complete(messages, tools, false));
    if (!turn.calls.length) return { text: turn.text, messages };
    const results = [];
    for (const call of turn.calls) {
      const content = call.invalid
        ? JSON.stringify({ erro: "Argumentos inválidos (JSON). Tente de novo." })
        : await options.run(call);
      results.push({ id: call.id, content, error: content.startsWith('{"erro"') });
    }
    messages.push(...resultMessages(options.family, turn, results));
  }
  const last = parseTurn(options.family, await options.complete(messages, tools, true));
  return { text: last.text, messages };
}
