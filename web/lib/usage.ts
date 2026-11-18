// Tokens de uma execução de bot com provedor de IA direto (bot_runs.usage,
// src/ai-provider.ts): entrada sem cache, cache lido, cache gravado e saída.
// Em Execuções de bots, para ver o custo e se o cache de prompt está pegando.
// Sem valor em dinheiro: o preço muda.

export function usageText(raw: unknown) {
  let u: any = raw;
  if (typeof raw === "string")
    try {
      u = JSON.parse(raw);
    } catch {
      u = null;
    }
  if (!u || typeof u !== "object") return "—";
  const f = (v: unknown) => (Number(v) || 0).toLocaleString("pt-BR");
  return `entrada ${f(u.input)} · cache lido ${f(u.cache_read)} · cache gravado ${f(u.cache_write)} · saída ${f(u.output)}`;
}
