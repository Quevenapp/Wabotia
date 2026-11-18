import type { PiiMask } from "./pii-mask";
import { inflateBounded, PDF_INFLATE_LIMITS } from "./pdf-reader";
export { PDF_INFLATE_LIMITS } from "./pdf-reader";
// Conexão direta com um provedor de IA, sem servidor externo (docs/PROVEDOR-IA.md).
// O Worker chama o provedor com a chave guardada no cofre da conexão. Não há
// arquivos nem memória: cada execução leva instruções, histórico e fontes,
// e devolve o texto da resposta. Ferramentas
// só pelo Wabotia (aiCompleteWithTools): as da pessoa na conversa interna e as
// da conversa no atendimento ao cliente (src/bot-actions).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { exec } from "./db";
import { ApiError, type Env, json, now, requireValue } from "./types";
import { publicUrl, safeFetch, secret } from "./security";
import { providerFamily, responsesText, toolLoop, type ToolCall } from "./bot-tools";
import type { BotTool } from "./bot-actions/actions";

export type AiProvider = "openai" | "deepseek" | "compatible" | "anthropic";

/**
 * `pdf`: o provedor aceita PDF de forma documentada e a opção "O modelo
 * entende PDF" aparece na conexão; `pdfDefault`, ligada de fábrica.
 * Anthropic: bloco `document` (base64, antes do texto). OpenAI: parte
 * `{type:"file", file:{filename, file_data}}` do Chat Completions, só em
 * modelos com visão (desligada de fábrica: a conta escolhe). DeepSeek e API
 * compatível: sem formato documentado, sem PDF.
 */
export const AI_PROVIDERS: Record<
  AiProvider,
  { label: string; base?: string; vision: boolean; pdf: boolean; pdfDefault: boolean }
> = {
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", vision: true, pdf: true, pdfDefault: false },
  deepseek: {
    label: "DeepSeek",
    base: "https://api.deepseek.com",
    vision: false,
    pdf: false,
    pdfDefault: false,
  },
  compatible: { label: "Compatível com OpenAI", vision: false, pdf: false, pdfDefault: false },
  anthropic: { label: "Anthropic", vision: true, pdf: true, pdfDefault: true },
};

/**
 * Teto do PDF do cliente no Wabotia (o provedor aceita bem mais: 600
 * páginas na Anthropic). Cada página custa de 1.500 a 3.000 tokens de texto
 * mais a página como imagem (docs da Anthropic, "PDF support", "Estimate
 * your costs"): com 10 páginas e o prompt de uma área cheia o pedido fica
 * abaixo de 100 mil tokens, acima dos quais o Haiku 5.5 cobra o pedido
 * inteiro mais caro. Nota fiscal e comprovante têm de 1 a 3 páginas. Um PDF
 * por mensagem, até 4 MB. Acima disso, a conversa vai para a equipe.
 */
export { PDF_LIMITS } from "./pdf-reader";
/** Teto de tokens por página usado na estimativa (3.000 de texto + ~1.600 da imagem, arredondado). */
export const PDF_TOKENS_PER_PAGE = 5_000;

/**
 * Páginas de um PDF pelos objetos /Type /Page do arquivo. null quando não
 * dá para contar (objetos comprimidos em object streams): a equipe confere.
 */
export function pdfPages(bytes: Uint8Array): number | null {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const pages = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return pages || null;
}

/**
 * Páginas de um PDF, olhando também dentro dos object streams (`/Type
 * /ObjStm` com `/FlateDecode`), onde a maioria dos PDFs atuais guarda os
 * objetos de página. Lê no máximo PDF_INFLATE_LIMITS.
 *
 * A contagem serve ao teto de páginas, então contar a menos seria falha
 * aberta. Na dúvida devolve null e o PDF vai para a equipe: PDF cifrado,
 * stream corrompido ou cortado, filtro que não seja só FlateDecode,
 * /DecodeParms, ObjStm cujo dicionário não foi reconhecido, ou passou dos
 * tetos. As páginas soltas e as de dentro dos streams se somam (não casam
 * duas vezes: as comprimidas não aparecem no texto cru).
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const objstm = /\/Type\s*\/ObjStm(?![A-Za-z])/g;
  const mentioned = text.match(objstm)?.length ?? 0;
  const loose = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  // Cifrado: o conteúdo dos streams não é o texto dos objetos.
  if (/\/Encrypt(?![A-Za-z])/.test(text)) return null;
  if (!mentioned) return loose || null;
  const marker = /stream\r?\n/g;
  let budget: number = PDF_INFLATE_LIMITS.bytes;
  let streams = 0;
  let pages = 0;
  for (let m = marker.exec(text); m; m = marker.exec(text)) {
    if (m.index >= 3 && text.slice(m.index - 3, m.index) === "end") continue;
    const head = text.slice(Math.max(0, m.index - 1024), m.index);
    const dict = head.slice(head.lastIndexOf("obj") + 3);
    if (!/\/Type\s*\/ObjStm(?![A-Za-z])/.test(dict)) continue;
    if (++streams > PDF_INFLATE_LIMITS.streams) return null;
    // Só FlateDecode puro: preditor (/DecodeParms) ou cadeia de filtros não
    // devolvem o texto dos objetos.
    if (
      /\/DecodeParms/.test(dict) ||
      !/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])(?![A-Za-z])/.test(dict)
    )
      return null;
    const start = m.index + m[0].length;
    // /Length direto quando houver (`/Length 12 0 R` é indireto: nem "1"
    // nem "12" valem); senão até "endstream", sem a quebra de linha final.
    const length = dict.match(/\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/);
    let end = length ? start + Number(length[1]) : text.indexOf("endstream", start);
    if (end < start || end > bytes.length) return null;
    if (!length) {
      if (text[end - 1] === "\n") end--;
      if (text[end - 1] === "\r") end--;
    }
    const inflated = await inflateBounded(bytes.slice(start, end), budget);
    if (inflated === null) return null;
    budget -= inflated.length;
    let chunk = "";
    for (let i = 0; i < inflated.length; i += 0x8000)
      chunk += String.fromCharCode(...inflated.subarray(i, i + 0x8000));
    pages += chunk.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  }
  // Algum ObjStm sem dicionário reconhecido (maior que a janela lida): não
  // dá para garantir a contagem.
  if (streams < mentioned) return null;
  return loose + pages || null;
}

/** Uso de uma execução, igual para todos os provedores (tokens). */
export interface AiUsage {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
}
export const emptyUsage = (): AiUsage => ({ input: 0, cache_read: 0, cache_write: 0, output: 0 });
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/**
 * Soma o `usage` de uma resposta em `target`, pelo formato de cada provedor:
 * - Anthropic: input_tokens (sem cache), cache_creation_input_tokens,
 *   cache_read_input_tokens, output_tokens;
 * - OpenAI (Responses): input_tokens (inclui o cache),
 *   input_tokens_details.cached_tokens, output_tokens (com o raciocínio);
 * - OpenAI (chat/completions) e compatíveis: prompt_tokens (inclui o cache),
 *   prompt_tokens_details.cached_tokens, completion_tokens (cache automático,
 *   sem gravação cobrada à parte);
 * - DeepSeek: prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens;
 * - API compatível: prompt_tokens e completion_tokens, quando vierem.
 */
export function addUsage(target: AiUsage | undefined, provider: string, raw: any) {
  if (!target || !raw || typeof raw !== "object") return;
  if (provider === "anthropic") {
    target.input += n(raw.input_tokens);
    target.cache_write += n(raw.cache_creation_input_tokens);
    target.cache_read += n(raw.cache_read_input_tokens);
    target.output += n(raw.output_tokens);
  } else if (provider === "deepseek" && ("prompt_cache_hit_tokens" in raw || "prompt_cache_miss_tokens" in raw)) {
    target.input += n(raw.prompt_cache_miss_tokens);
    target.cache_read += n(raw.prompt_cache_hit_tokens);
    target.output += n(raw.completion_tokens);
  } else if ("input_tokens" in raw || "output_tokens" in raw) {
    // input_tokens inclui o lido e o gravado no cache (cache_write_tokens,
    // visto na API real em 17/11/2026).
    const cached = n(raw.input_tokens_details?.cached_tokens);
    const written = n(raw.input_tokens_details?.cache_write_tokens);
    target.input += Math.max(0, n(raw.input_tokens) - cached - written);
    target.cache_read += cached;
    target.cache_write += written;
    target.output += n(raw.output_tokens);
  } else {
    const cached = n(raw.prompt_tokens_details?.cached_tokens);
    target.input += Math.max(0, n(raw.prompt_tokens) - cached);
    target.cache_read += cached;
    target.output += n(raw.completion_tokens);
  }
}

// Somente modelos atuais da Anthropic; o primeiro é o padrão.
export const ANTHROPIC_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

// Todos os níveis de esforço de raciocínio de cada provedor. Na Anthropic vão
// em output_config.effort (Opus, Sonnet e Haiku 5.5 aceitam de low a max;
// padrão aqui "low", suficiente para conversa). Na OpenAI e em APIs
// compatíveis, em reasoning_effort, e só quando escolhido, porque modelos sem
// raciocínio recusam o campo; cada modelo aceita uma parte dos níveis e o
// teste da conexão confere (gpt-6.1-terra e gpt-6-luna: none a max; Sol: low
// a max; guia "Reasoning", 17/11/2026). A DeepSeek aceita none, low, high e
// max e, sem o campo, raciocina em high; o padrão aqui é "low".
export const AI_EFFORTS: Record<AiProvider, string[]> = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  compatible: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  deepseek: ["none", "low", "high", "max"],
};
const DEFAULT_EFFORT: Partial<Record<AiProvider, string>> = {
  anthropic: "low",
  deepseek: "low",
};

/** Tetos de saída por chamada e prazo acumulado do laço de ferramentas. */
export const AI_MAX_OUTPUT_TOKENS = 16000;
export const AI_MAX_OUTPUT_TOKENS_DEEP = 32000;
export const AI_RUN_DEADLINE_MS = 6 * 60_000;
const outputTokens = (cfg: any) =>
  ["xhigh", "max"].includes(cfg?.effort) ? AI_MAX_OUTPUT_TOKENS_DEEP : AI_MAX_OUTPUT_TOKENS;

/** Prazo de cada chamada: os níveis mais altos pensam por mais tempo. */
export function aiCallTimeout(cfg: any) {
  return ["xhigh", "max"].includes(cfg?.effort)
    ? 180_000
    : cfg?.effort === "high"
      ? 90_000
      : 60_000;
}

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
  // "O modelo entende PDF": só onde o provedor documenta o formato.
  cfg.pdf = AI_PROVIDERS[provider].pdf
    ? AI_PROVIDERS[provider].pdfDefault
      ? input.pdf !== false
      : input.pdf === true
    : false;
  const effort = input.effort || DEFAULT_EFFORT[provider] || "";
  if (effort) {
    requireValue(
      AI_EFFORTS[provider].includes(effort),
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
  /** Estado privado; nunca faz parte do corpo HTTP. */
  pii?: PiiMask;
  /**
   * Instruções estáveis da área e da fase: o mesmo texto em toda execução
   * do mesmo tipo (sem carimbo de tempo nem dado da conversa). Na Anthropic
   * é o bloco do sistema com o ponto de cache.
   */
  instructions: string;
  /** Acréscimos desta execução (situação da conversa), depois do ponto de cache. */
  situation?: string;
  /**
   * Dados estáveis da área (menus, ações, categorias) que vão no bloco
   * estável do sistema, depois das instruções, em vez de na mensagem.
   */
  area?: Record<string, unknown> | null;
  input: string;
  /** data URLs (`data:image/png;base64,...`) já lidas do R2. */
  images?: string[];
  /** PDFs do cliente desta mensagem, como data URLs (`data:application/pdf;base64,...`). */
  documents?: string[];
  /** Quando o motor espera o JSON do Atendente. */
  json?: "attendant" | "attendant-jev" | "specialist";
  /** Soma o uso (tokens) de cada chamada ao provedor. */
  usage?: AiUsage;
};

/** Texto dos dados da área no bloco estável (o mesmo conteúdo que ia na mensagem). */
export const AREA_LABEL = "\n\nDados desta área de atendimento (menus, actions e categories): ";

/** Bloco estável do sistema: instruções e dados da área, em ordem fixa. */
export function stableSystem(request: Pick<AiRequest, "instructions" | "area">) {
  return request.area ? request.instructions + AREA_LABEL + JSON.stringify(request.area) : request.instructions;
}

/** O sistema inteiro num texto (OpenAI e compatíveis): o estável primeiro. */
export const systemText = (request: AiRequest) => stableSystem(request) + (request.situation || "");

/**
 * Sistema da Anthropic: o bloco estável com o ponto de cache (5 min) e os
 * acréscimos da execução depois dele. O ponto vai sempre: abaixo do mínimo
 * de cada modelo não há cache, sem erro.
 */
export function anthropicSystem(request: AiRequest): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: stableSystem(request), cache_control: { type: "ephemeral" } },
  ];
  if (request.situation) blocks.push({ type: "text", text: request.situation });
  return blocks;
}

/** Conteúdo do usuário na Anthropic: PDFs, imagens e o texto, nessa ordem. */
function anthropicContent(cfg: any, request: AiRequest): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = [];
  if (cfg.pdf)
    for (const url of request.documents || []) {
      const match = /^data:application\/pdf;base64,(.+)$/.exec(url);
      if (match)
        content.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: match[1] },
        });
    }
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
  return content;
}

/** Conteúdo do usuário na OpenAI e compatíveis: texto, imagens e PDFs (se a conexão aceita). */
function openaiContent(cfg: any, request: AiRequest) {
  const images = cfg.vision ? request.images || [] : [];
  const documents = cfg.pdf ? request.documents || [] : [];
  if (!images.length && !documents.length) return request.input;
  return [
    { type: "text", text: request.input },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
    ...documents.map((url, i) => ({
      type: "file",
      file: { filename: `documento-${i + 1}.pdf`, file_data: url },
    })),
  ];
}

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
// Especialista interno (fase specialist): o mesmo contrato das instruções
// (src/engine.ts, runInstructions). O provedor direto não gera arquivos:
// links e files vêm vazios ou são ignorados; o modelo pode omiti-los.
const specialistSchema = z.object({
  outcome: z.enum(["resolved", "unresolved", "needs_clarification"]),
  text: z.string(),
  links: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
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

export const RESPONSES_JSON_NOTE = "Responda somente com um objeto JSON válido.";

/**
 * Conteúdo do usuário no Responses da OpenAI: texto, imagens e PDFs (guias
 * "Images and vision" e "File inputs"; até 50 MB por pedido).
 */
function responsesInput(cfg: any, request: AiRequest) {
  const images = cfg.vision ? request.images || [] : [];
  const documents = cfg.pdf ? request.documents || [] : [];
  return [
    // O modo json_object exige a palavra "json" nas mensagens do input, não
    // só em `instructions` (HTTP 400 na API real em 17/11/2026). Texto fixo,
    // antes do pedido, para não mexer no prefixo do cache.
    ...(request.json ? [{ role: "developer", content: [{ type: "input_text", text: RESPONSES_JSON_NOTE }] }] : []),
    {
      role: "user",
      content: [
        { type: "input_text", text: request.input },
        ...images.map((url) => ({ type: "input_image", image_url: url })),
        ...documents.map((url, i) => ({
          type: "input_file",
          filename: `documento-${i + 1}.pdf`,
          file_data: url,
        })),
      ],
    },
  ];
}

/**
 * Corpo comum do Responses. Sem estado na OpenAI (store:false): o
 * raciocínio volta cifrado nos itens da saída e o laço de ferramentas o
 * devolve. As instruções vão em `instructions`, estáveis primeiro, para o
 * cache automático por prefixo.
 */
function responsesBody(cfg: any, request: AiRequest, input: any[]) {
  const body: Record<string, any> = {
    model: cfg.model,
    instructions: systemText(request),
    input,
    store: false,
    max_output_tokens: outputTokens(cfg),
  };
  if (cfg.effort) {
    body.reasoning = { effort: cfg.effort };
    body.include = ["reasoning.encrypted_content"];
  }
  // Modo JSON: o motor valida o formato do Atendente de qualquer forma.
  if (request.json) body.text = { format: { type: "json_object" } };
  return body;
}

/** Uma chamada ao Responses; devolve a resposta inteira (status já conferido). */
async function responsesCall(
  key: string,
  cfg: any,
  body: Record<string, any>,
  usage: AiUsage | undefined,
  timeout: number,
  probe = false,
) {
  let response: Response;
  try {
    response = await safeFetch(`${openaiBase(cfg)}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (error instanceof ApiError) throw new AiError(error.message, false);
    throw new AiError("O provedor de IA não respondeu a tempo.", true);
  }
  if (!response.ok) throw httpError(response.status);
  const data = await response.json<any>().catch(() => null);
  addUsage(usage, "openai", data?.usage);
  if (!data || !Array.isArray(data.output))
    throw new AiError("O provedor de IA respondeu fora do formato.", false);
  // No teste, uma resposta cortada pelo teto curto também prova chave e modelo.
  if (probe) return data;
  if (data.status === "incomplete") {
    if (data.incomplete_details?.reason === "content_filter")
      throw new AiError("O provedor de IA recusou responder.", false);
    throw new AiError("A resposta do provedor de IA foi cortada.", false);
  }
  if (data.status === "failed")
    throw new AiError("O provedor de IA não concluiu a resposta.", true);
  if (responsesText(data.output).refused)
    throw new AiError("O provedor de IA recusou responder.", false);
  return data;
}

async function responsesComplete(key: string, cfg: any, request: AiRequest, probe: boolean) {
  const body = responsesBody(cfg, request, responsesInput(cfg, request));
  if (probe) body.max_output_tokens = 16;
  const data = await responsesCall(
    key,
    cfg,
    body,
    request.usage,
    probe ? 60_000 : aiCallTimeout(cfg),
    probe,
  );
  if (probe) return "";
  const { text } = responsesText(data.output);
  if (!text.trim())
    throw new AiError("O provedor de IA respondeu sem texto.", false);
  return text;
}

async function openaiComplete(
  key: string,
  cfg: any,
  request: AiRequest,
  /** Chamada de teste: curta, e qualquer resposta 200 serve. */
  probe = false,
) {
  // OpenAI: Responses (as ferramentas dos modelos atuais só existem nele).
  if (cfg.provider === "openai")
    return responsesComplete(key, cfg, request, probe);
  const base = openaiBase(cfg);
  if (!base) throw new AiError("Provedor de IA inválido.", false);
  // Estável primeiro: OpenAI e DeepSeek fazem cache automático por prefixo.
  const body: Record<string, any> = {
    model: cfg.model,
    max_tokens: outputTokens(cfg),
    messages: [
      { role: "system", content: systemText(request) },
      { role: "user", content: openaiContent(cfg, request) },
    ],
  };
  if (probe) body.max_tokens = 16;
  if (cfg.effort) body.reasoning_effort = cfg.effort;
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
      signal: AbortSignal.timeout(probe ? 60_000 : aiCallTimeout(cfg)),
    });
  } catch (error) {
    if (error instanceof ApiError) throw new AiError(error.message, false);
    throw new AiError("O provedor de IA não respondeu a tempo.", true);
  }
  if (!response.ok) throw httpError(response.status);
  const data = await response.json<any>().catch(() => null);
  addUsage(request.usage, cfg.provider, data?.usage);
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

function anthropicClient(apiKey: string, timeout = 60_000) {
  return new Anthropic({ apiKey, timeout, maxRetries: 1 });
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
  const content = anthropicContent(cfg, request);
  const params = {
    model: cfg.model,
    // Os níveis mais altos precisam de espaço para raciocinar.
    max_tokens: outputTokens(cfg),
    system: anthropicSystem(request),
    messages: [{ role: "user" as const, content }],
  };
  const client = anthropicClient(key, aiCallTimeout(cfg));
  try {
    const schema = schemaFor(request);
    // A saída estruturada vai no pedido; a validação fica aqui, depois de
    // conferir o motivo de parada (uma recusa não segue o formato).
    const effort = AI_EFFORTS.anthropic.includes(cfg.effort)
      ? cfg.effort
      : "low";
    const response = await client.messages.create({
      ...params,
      output_config: schema
        ? { effort, format: zodOutputFormat(schema) }
        : { effort },
    });
    addUsage(request.usage, "anthropic", response.usage);
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

// ---------------------------------------------------------------------------
// Ferramentas (src/bot-tools.ts): o bot da conversa interna age pela pessoa e
// o do atendimento usa as ferramentas da conversa (src/bot-actions). Mesmas
// chaves, modelos, esforço e formato de resposta da chamada sem ferramentas.

export type AiToolRequest = AiRequest & {
  tools: BotTool[];
  /** Executa uma chamada do modelo e devolve o texto do resultado. */
  run: (call: ToolCall) => Promise<string>;
};

function schemaFor(request: AiRequest) {
  return request.json === "attendant-jev"
    ? attendantJevSchema
    : request.json === "specialist"
      ? specialistSchema
      : request.json
        ? attendantSchema
        : null;
}

/** O texto final como aiComplete devolveria (JSON validado, se pedido). */
function finalText(request: AiRequest, text: string) {
  if (!text.trim())
    throw new AiError("O provedor de IA respondeu sem texto.", false);
  const schema = schemaFor(request);
  if (!schema) return text;
  const parsed = schema.safeParse(json(text, null));
  if (!parsed.success)
    throw new AiError("O provedor de IA respondeu fora do formato.", false);
  return JSON.stringify(parsed.data);
}

/**
 * Como aiComplete, com ferramentas: o modelo pode chamar as ferramentas
 * dadas (até o teto de rodadas de src/bot-tools.ts) antes da resposta final.
 */
export async function aiCompleteWithTools(
  env: Env,
  conn: any,
  request: AiToolRequest,
) {
  const started = Date.now();
  const cfg = json(conn.config);
  const key = await connectionKey(env, conn);
  const family = providerFamily(cfg.provider);
  const schema = schemaFor(request);
  let complete: (messages: any[], tools: any[], final: boolean, timeout: number, remaining: number) => Promise<any>;
  let messages: any[];
  if (family === "anthropic") {
    messages = [{ role: "user", content: anthropicContent(cfg, request) }];
    const client = anthropicClient(key, aiCallTimeout(cfg));
    const effort = AI_EFFORTS.anthropic.includes(cfg.effort) ? cfg.effort : "low";
    complete = async (history, tools, final, timeout, remaining) => {
      try {
        const response = await client.messages.create({
          model: cfg.model,
          max_tokens: outputTokens(cfg),
          system: anthropicSystem(request),
          // Segundo ponto de cache, móvel: o fim da rodada atual, que a
          // próxima rodada do laço lê do cache.
          messages: withCachePoint(history),
          tools,
          // Os modelos 5.5 não aceitam tool_choice forçado; "none" fecha.
          tool_choice: { type: final ? "none" : "auto" },
          output_config: schema
            ? { effort, format: zodOutputFormat(schema) }
            : { effort },
        } as any, { timeout, signal: AbortSignal.timeout(remaining) });
        addUsage(request.usage, "anthropic", response.usage);
        checkStop(response.stop_reason);
        return response;
      } catch (error) {
        throw anthropicError(error);
      }
    };
  } else if (family === "responses") {
    messages = responsesInput(cfg, request);
    complete = (history, tools, final, timeout) =>
      responsesCall(
        key,
        cfg,
        {
          ...responsesBody(cfg, request, history),
          tools,
          tool_choice: final ? "none" : "auto",
        },
        request.usage,
        timeout,
      );
  } else {
    const base = openaiBase(cfg);
    if (!base) throw new AiError("Provedor de IA inválido.", false);
    messages = [
      { role: "system", content: systemText(request) },
      { role: "user", content: openaiContent(cfg, request) },
    ];
    complete = async (history, tools, final, timeout) => {
      const body: Record<string, any> = {
        model: cfg.model,
        max_tokens: outputTokens(cfg),
        messages: history,
        tools,
        tool_choice: final ? "none" : "auto",
      };
      if (cfg.effort) body.reasoning_effort = cfg.effort;
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
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        if (error instanceof ApiError) throw new AiError(error.message, false);
        throw new AiError("O provedor de IA não respondeu a tempo.", true);
      }
      if (!response.ok) throw httpError(response.status);
      const data = await response.json<any>().catch(() => null);
      addUsage(request.usage, cfg.provider, data?.usage);
      const choice = data?.choices?.[0];
      if (!choice)
        throw new AiError("O provedor de IA respondeu fora do formato.", false);
      if (choice.finish_reason === "length")
        throw new AiError("A resposta do provedor de IA foi cortada.", false);
      if (choice.finish_reason === "content_filter")
        throw new AiError("O provedor de IA recusou responder.", false);
      return data;
    };
  }
  const result = await toolLoop({
    family,
    pii: request.pii,
    messages,
    tools: request.tools,
    // O laço passa aqui antes de cada rodada, inclusive a última sem ferramentas.
    complete: async (history, tools, final) => {
      const remaining = AI_RUN_DEADLINE_MS - (Date.now() - started);
      const expired = () => new AiError("A execução do bot excedeu o prazo de resposta.", false);
      if (remaining <= 0) throw expired();
      try {
        return await complete(history, tools, final, Math.min(aiCallTimeout(cfg), remaining), remaining);
      } catch (error) {
        if (Date.now() - started >= AI_RUN_DEADLINE_MS) throw expired();
        throw error;
      }
    },
    run: request.run,
  });
  await exec(
    env,
    "UPDATE connections SET last_seen=? WHERE id=?",
    now(),
    conn.id,
  );
  return finalText(request, result.text);
}

/**
 * Cópia do histórico com o ponto de cache no último bloco da última
 * mensagem (o histórico do laço não muda). Com o do sistema, dois pontos.
 */
export function withCachePoint(history: any[]): any[] {
  if (!history.length) return history;
  const last = history[history.length - 1];
  const blocks: any[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...(last.content || [])];
  if (!blocks.length) return history;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  return [...history.slice(0, -1), { ...last, content: blocks }];
}

function checkStop(reason: string | null) {
  if (reason === "refusal")
    throw new AiError("O provedor de IA recusou responder.", false);
  if (reason === "max_tokens")
    throw new AiError("A resposta do provedor de IA foi cortada.", false);
}
