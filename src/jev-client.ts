// Cliente do JEV (TypeSafe System One), por fetch direto, sem o SDK deles.
// Contrato conferido em 17/11/2026:
// - POST https://api.typesafe.ai/v1/systemone, Authorization: Bearer <chave>;
// - corpo {model, state, questions: {<id>: {type, instructions, criteria}}};
// - resposta {model, answers, usage: {input_tokens, output_tokens}}
//   (https://docs.typesafe.ai/api/system-one);
// - `noul`: {noul} = probabilidade de "sim" (0 a 1), sem confiança;
// - `choice`: {choice, confidence, probabilities};
// - 429 (limite) e 529 (sobrecarga): tentar de novo com espera exponencial;
//   nenhum outro código é documentado como repetível
//   (https://docs.typesafe.ai/api/errors);
// - modelos jev-1.14.0 (jev-latest aponta para ele) e jev-1.13.0; 64 mil
//   tokens por pedido e 32 mil por pergunta; US$ 0,042 por milhão de tokens
//   de entrada, saída grátis (https://docs.typesafe.ai/models). A versão
//   fica fixada na área (jev_model): o limiar é ajustado contra uma versão.
import { requireValue, type Env } from "./types";
import { safeFetch, secret } from "./security";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODELS = ["jev-1.14.0", "jev-1.13.0"] as const;
export const JEV_DEFAULT_MODEL = "jev-1.14.0";
export const JEV_DEFAULT_THRESHOLD = 0.8;
/** Prazo de cada chamada e esperas entre as tentativas (429 e 529). */
const TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [500, 1_500];

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export interface JevResult {
  ok: boolean;
  /** Motivo da falha (sem chave, erro do provedor, prazo). */
  reason?: string;
  model?: string;
  answers?: Record<string, any>;
  usage: { input: number; output: number };
}

/** Validação das chaves do JEV nas configurações da área. */
export function validateJevSettings(next: any) {
  if (next.jev_model !== undefined)
    requireValue(
      (JEV_MODELS as readonly string[]).includes(next.jev_model),
      `Modelo do JEV: use ${JEV_MODELS.join(" ou ")}.`,
    );
  const valid = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 0.99;
  if (next.jev_threshold !== undefined)
    requireValue(valid(next.jev_threshold), "Limiar do JEV: de 0,5 a 0,99.");
  if (next.jev_bot_thresholds !== undefined) {
    requireValue(
      next.jev_bot_thresholds && typeof next.jev_bot_thresholds === "object" && !Array.isArray(next.jev_bot_thresholds),
      "Limiares do JEV por bot inválidos.",
    );
    const entries = Object.entries(next.jev_bot_thresholds);
    requireValue(entries.length <= 100, "Limiares do JEV: até 100 bots.");
    for (const [bot, value] of entries)
      requireValue(typeof bot === "string" && bot.length <= 100 && valid(value), "Limiar do JEV por bot: de 0,5 a 0,99.");
  }
}

/** Limiar valendo para um bot: o do bot, senão o da área, senão 0,8. */
export function jevThreshold(cfg: any, botId?: string | null) {
  const own = botId ? cfg?.jev_bot_thresholds?.[botId] : undefined;
  const value = typeof own === "number" ? own : cfg?.jev_threshold;
  return typeof value === "number" && value >= 0.5 && value <= 0.99 ? value : JEV_DEFAULT_THRESHOLD;
}

export const jevModel = (cfg: any) =>
  (JEV_MODELS as readonly string[]).includes(cfg?.jev_model) ? cfg.jev_model : JEV_DEFAULT_MODEL;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma chamada ao JEV com a chave da área. Repete só 429 e 529, até duas
 * vezes. Nunca lança: a falha volta como `ok: false` com o motivo, e quem
 * chama encaminha para pessoa.
 */
export async function askJev(
  env: Env,
  profile: string,
  cfg: any,
  state: unknown,
  questions: Record<string, JevQuestion>,
): Promise<JevResult> {
  const usage = { input: 0, output: 0 };
  const keys = await secret(env, `jev:${profile}`);
  if (!keys.key) return { ok: false, reason: "missing_key", usage };
  const body = JSON.stringify({ model: jevModel(cfg), state, questions });
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await safeFetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "provider_unavailable", usage };
    }
    if ((response.status === 429 || response.status === 529) && attempt < RETRY_DELAYS_MS.length) {
      void response.body?.cancel().catch(() => {});
      await wait(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { ok: false, reason: response.status === 429 || response.status === 529 ? "provider_busy" : "provider_error", usage };
    }
    const result = await response.json<any>().catch(() => null);
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    usage.input = n(result?.usage?.input_tokens);
    usage.output = n(result?.usage?.output_tokens);
    if (!result || typeof result.answers !== "object" || !result.answers)
      return { ok: false, reason: "invalid_decision", usage };
    return {
      ok: true,
      model: typeof result.model === "string" ? result.model.slice(0, 100) : undefined,
      answers: result.answers,
      usage,
    };
  }
}
