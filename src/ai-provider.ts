// Conexão direta com um provedor de IA, sem Hermes (docs/PROVEDOR-IA.md).
// O Worker chama o provedor com a chave guardada no cofre da conexão. Não há
// ferramentas, arquivos nem memória: cada execução leva instruções, histórico e
// fontes, como já acontece com o Hermes, e devolve só o texto da resposta.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { exec } from "./db";
import { ApiError, type Env, json, now, requireValue } from "./types";
import { publicUrl, safeFetch, secret } from "./security";

export type AiProvider = "openai" | "deepseek" | "compatible" | "anthropic";

export const AI_PROVIDERS: Record<
  AiProvider,
  { label: string; base?: string; vision: boolean }
> = {
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", vision: true },
  deepseek: {
    label: "DeepSeek",
    base: "https://api.deepseek.com",
    vision: false,
  },
  compatible: { label: "Compatível com OpenAI", vision: false },
  anthropic: { label: "Anthropic", vision: true },
};

// Somente modelos atuais da Anthropic; o primeiro é o padrão.
export const ANTHROPIC_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

// Esforço de raciocínio que o painel oferece. Na Anthropic vai em
// output_config.effort (padrão "low", suficiente para conversa); na OpenAI e em
// APIs compatíveis, em reasoning_effort, e só quando escolhido, porque modelos
// sem raciocínio recusam o campo. Níveis acima de "high" ficam de fora: podem
// passar do prazo de 60 segundos de cada chamada.
export const AI_EFFORTS = ["low", "medium", "high"];
const EFFORT_PROVIDERS: AiProvider[] = ["anthropic", "openai", "compatible"];

const CALL_TIMEOUT = 60_000;

/** Erro do provedor. `transient` diz se vale tentar de novo daqui a pouco. */
export class AiError extends ApiError {
  constructor(
    message: string,
    public transient: boolean,
  ) {
    super(502, "ai_provider_error", message);
  }
}

/** Valida e normaliza a configuração de uma conexão `ai` vinda do painel. */
export function aiConfig(input: any) {
  const provider = input.provider as AiProvider;
  requireValue(
    Object.hasOwn(AI_PROVIDERS, provider || ""),
    "Escolha o provedor de IA.",
  );
  const cfg: Record<string, any> = { provider };
  if (provider === "anthropic") {
    cfg.model = input.model || ANTHROPIC_MODELS[0];
    requireValue(
      ANTHROPIC_MODELS.includes(cfg.model),
      "Escolha um dos modelos da Anthropic oferecidos.",
    );
  } else {
    cfg.model = typeof input.model === "string" ? input.model.trim() : "";
    requireValue(
      cfg.model && cfg.model.length <= 100 && !/[\s"'<>]/.test(cfg.model),
      "Informe o nome do modelo, como aparece na documentação do provedor.",
    );
  }
  if (provider === "compatible") {
    requireValue(input.base_url, "Informe a URL da API compatível com OpenAI.");
    cfg.base_url = publicUrl(String(input.base_url));
    cfg.vision = input.vision === true;
  } else cfg.vision = AI_PROVIDERS[provider].vision;
  const effort = input.effort || (provider === "anthropic" ? "low" : "");
  if (effort) {
    requireValue(
      EFFORT_PROVIDERS.includes(provider) && AI_EFFORTS.includes(effort),
      "Esforço inválido para este provedor.",
    );
    cfg.effort = effort;
  }
  cfg.text_only = input.text_only !== false;
  return cfg;
}

// Na OpenAI a lista de modelos traz também os de imagem, voz e embeddings; os
// que claramente não conversam ficam fora das sugestões.
const NOT_CHAT =
  /(embedding|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|sora)/i;

/**
 * Modelos disponíveis na conta, para o painel sugerir. Na Anthropic, só os
 * modelos atuais que o Wabotia suporta e que a conta enxerga.
 */
export async function aiListModels(
  provider: AiProvider,
  key: string,
  baseUrl?: string,
) {
  requireValue(
    Object.hasOwn(AI_PROVIDERS, provider || ""),
    "Escolha o provedor de IA.",
  );
  if (provider === "anthropic") {
    try {
      const page = await anthropicClient(key).models.list({ limit: 100 });
      const available = new Set(page.data.map((model) => model.id));
      return ANTHROPIC_MODELS.filter((id) => available.has(id));
    } catch (error) {
      throw anthropicError(error);
    }
  }
  const base =
    provider === "compatible"
      ? publicUrl(String(baseUrl || ""))
      : AI_PROVIDERS[provider].base!;
  let response: Response;
  try {
    response = await safeFetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (error) {
    if (error instanceof ApiError) throw new AiError(error.message, false);
    throw new AiError("O provedor de IA não respondeu a tempo.", true);
  }
  if (!response.ok) throw httpError(response.status);
  const data = await response.json<any>().catch(() => null);
  const ids: string[] = (Array.isArray(data?.data) ? data.data : [])
    .map((model: any) => model?.id)
    .filter((id: any) => typeof id === "string" && id.length <= 100);
  return [...new Set(ids)]
    .filter((id) => provider !== "openai" || !NOT_CHAT.test(id))
    .sort()
    .slice(0, 500);
}

/** A chave de API como o painel a envia: obrigatória na criação. */
export function aiKey(value: unknown) {
  requireValue(
    typeof value === "string" &&
      value.trim().length >= 8 &&
      value.length <= 4096 &&
      !/[\r\n\s]/.test(value.trim()),
    "Informe a chave de API do provedor.",
  );
  return (value as string).trim();
}

export type AiRequest = {
  instructions: string;
  input: string;
  /** data URLs (`data:image/png;base64,...`) já lidas do R2. */
  images?: string[];
  /** Quando o motor espera o JSON do Atendente. */
  json?: "attendant" | "attendant-jev";
};

// Mesmo contrato descrito nas instruções do Atendente (src/engine.ts). Todos os
// campos são obrigatórios e anuláveis, como pedem as saídas estruturadas.
const sourceId = z.union([z.number(), z.string()]);
const attendantSchema = z.object({
  action: z.enum([
    "answer",
    "clarify",
    "human",
    "consult",
    "menu",
    "protocols",
    "ticket",
  ]),
  text: z.string(),
  citations: z.array(sourceId),
  capability_id: z.string().nullable(),
  menu_id: z.string().nullable(),
  protocol_number: z.string().nullable(),
  category_id: z.string().nullable(),
});
const attendantJevSchema = attendantSchema.extend({
  interpretation: z.object({
    intent: z.string(),
    summary: z.string(),
    missing_information: z.array(z.string()),
  }),
  clarification: z.string().nullable(),
});

async function connectionKey(env: Env, conn: any) {
  const keys = await secret(env, `connection:${conn.id}`);
  if (!keys.api_key)
    throw new AiError("Cadastre a chave de API do provedor.", false);
  return keys.api_key as string;
}

/** Envia uma execução ao provedor e devolve o texto da resposta. */
export async function aiComplete(env: Env, conn: any, request: AiRequest) {
  const cfg = json(conn.config);
  const key = await connectionKey(env, conn);
  const text =
    cfg.provider === "anthropic"
      ? await anthropicComplete(key, cfg, request)
      : await openaiComplete(key, cfg, request);
  await exec(
    env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    conn.id,
  );
  return text;
}

/**
 * Testa chave, modelo e endereço. No formato OpenAI, confere o modelo na lista
 * da conta e faz uma chamada mínima, que também valida o esforço escolhido.
 */
export async function aiProbe(env: Env, conn: any) {
  const cfg = json(conn.config);
  const key = await connectionKey(env, conn);
  if (cfg.provider === "anthropic") {
    try {
      await anthropicClient(key).models.retrieve(cfg.model);
    } catch (error) {
      throw anthropicError(error);
    }
  } else {
    let models: string[] | null = null;
    try {
      models = await aiListModels(cfg.provider, key, cfg.base_url);
    } catch (error) {
      // Nem toda API compatível publica /models; a chamada abaixo decide.
      if (cfg.provider !== "compatible") throw error;
    }
    if (models?.length && !models.includes(cfg.model))
      throw new AiError(
        `O modelo ${cfg.model} não está disponível nesta conta. Use Buscar modelos para ver os disponíveis.`,
        false,
      );
    await openaiComplete(
      key,
      cfg,
      { instructions: "Responda apenas: ok", input: "ping" },
      true,
    );
  }
  await exec(
    env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    conn.id,
  );
}

function openaiBase(cfg: any) {
  return cfg.provider === "compatible"
    ? cfg.base_url
    : AI_PROVIDERS[cfg.provider as AiProvider]?.base;
}

async function openaiComplete(
  key: string,
  cfg: any,
  request: AiRequest,
  /** Chamada de teste: curta, e qualquer resposta 200 serve. */
  probe = false,
) {
  const base = openaiBase(cfg);
  if (!base) throw new AiError("Provedor de IA inválido.", false);
  const images = cfg.vision ? request.images || [] : [];
  const body: Record<string, any> = {
    model: cfg.model,
    messages: [
      { role: "system", content: request.instructions },
      {
        role: "user",
        content: images.length
          ? [
              { type: "text", text: request.input },
              ...images.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ]
          : request.input,
      },
    ],
  };
  // A OpenAI recusa max_tokens nos modelos com raciocínio.
  if (probe)
    body[cfg.provider === "openai" ? "max_completion_tokens" : "max_tokens"] =
      16;
  if (cfg.effort && cfg.provider !== "deepseek")
    body.reasoning_effort = cfg.effort;
  // Modo JSON documentado pela OpenAI e pela DeepSeek. Em APIs compatíveis o
  // suporte varia, então a resposta é validada pelo motor de qualquer forma.
  if (request.json && cfg.provider !== "compatible")
    body.response_format = { type: "json_object" };
  let response: Response;
  try {
    response = await safeFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
  } catch (error) {
    if (error instanceof ApiError) throw new AiError(error.message, false);
    throw new AiError("O provedor de IA não respondeu a tempo.", true);
  }
  if (!response.ok) throw httpError(response.status);
  const data = await response.json<any>().catch(() => null);
  const choice = data?.choices?.[0];
  if (probe) {
    if (!choice)
      throw new AiError("O provedor de IA respondeu fora do formato.", false);
    return "";
  }
  if (choice?.finish_reason === "length")
    throw new AiError("A resposta do provedor de IA foi cortada.", false);
  if (choice?.finish_reason === "content_filter")
    throw new AiError("O provedor de IA recusou responder.", false);
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim())
    throw new AiError("O provedor de IA respondeu sem texto.", false);
  return content;
}

function httpError(status: number) {
  if (status === 401 || status === 403)
    return new AiError(
      "O provedor de IA recusou a chave de API. Confira a chave e o saldo da conta.",
      false,
    );
  if (status === 404)
    return new AiError(
      "O provedor de IA não encontrou o modelo ou o endereço informado.",
      false,
    );
  if (status === 402)
    return new AiError("A conta do provedor de IA está sem saldo.", false);
  if (status === 408 || status === 409 || status === 429 || status >= 500)
    return new AiError(
      `O provedor de IA está indisponível agora (HTTP ${status}).`,
      true,
    );
  return new AiError(
    `O provedor de IA recusou a solicitação (HTTP ${status}).`,
    false,
  );
}

function anthropicClient(apiKey: string) {
  return new Anthropic({ apiKey, timeout: CALL_TIMEOUT, maxRetries: 1 });
}

function anthropicError(error: unknown) {
  if (error instanceof AiError) return error;
  if (error instanceof Anthropic.APIConnectionError)
    return new AiError("O provedor de IA não respondeu a tempo.", true);
  if (error instanceof Anthropic.APIError && typeof error.status === "number")
    return httpError(error.status);
  return new AiError("Falha ao chamar o provedor de IA.", false);
}

async function anthropicComplete(key: string, cfg: any, request: AiRequest) {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const url of request.images || []) {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(url);
    if (match)
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: match[1] as Anthropic.Base64ImageSource["media_type"],
          data: match[2],
        },
      });
  }
  content.push({ type: "text", text: request.input });
  const params = {
    model: cfg.model,
    max_tokens: 16000,
    system: request.instructions,
    messages: [{ role: "user" as const, content }],
  };
  const client = anthropicClient(key);
  try {
    const schema =
      request.json === "attendant-jev"
        ? attendantJevSchema
        : request.json
          ? attendantSchema
          : null;
    // A saída estruturada vai no pedido; a validação fica aqui, depois de
    // conferir o motivo de parada (uma recusa não segue o formato).
    const effort = AI_EFFORTS.includes(cfg.effort) ? cfg.effort : "low";
    const response = await client.messages.create({
      ...params,
      output_config: schema
        ? { effort, format: zodOutputFormat(schema) }
        : { effort },
    });
    checkStop(response.stop_reason);
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (!text.trim())
      throw new AiError("O provedor de IA respondeu sem texto.", false);
    if (!schema) return text;
    const parsed = schema.safeParse(json(text, null));
    if (!parsed.success)
      throw new AiError("O provedor de IA respondeu fora do formato.", false);
    return JSON.stringify(parsed.data);
  } catch (error) {
    throw anthropicError(error);
  }
}

function checkStop(reason: string | null) {
  if (reason === "refusal")
    throw new AiError("O provedor de IA recusou responder.", false);
  if (reason === "max_tokens")
    throw new AiError("A resposta do provedor de IA foi cortada.", false);
}
