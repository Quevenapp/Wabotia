// Texto da proposta do bot montado no servidor, nunca pelo modelo (revisão da
// sessão A): o que a pessoa ou o cliente confirma é o que roda. O módulo
// descreve com os dados dele (itens, valores, datas); sem descrição do
// módulo, o núcleo lista a ação e os campos do pedido, formatados.
import { formatBrasilia } from "../business-time";
import { money } from "../payments";

/** Teto do texto: o corpo de um botão do WhatsApp aceita 1024 caracteres. */
export const MAX_DESCRIPTION = 900;
const MAX_LINES = 12;

const clean = (value: string, max: number) =>
  value.replace(/\s+/g, " ").trim().slice(0, max);

/** Valor de um campo para leitura: centavos em reais, ms em data de Brasília. */
export function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (typeof value === "number") {
    if (/_cents$|^cents$|^amount$/.test(key)) return money(value);
    if (
      value > 1e12 &&
      /(^|_)(starts|ends|at|date|time|when|due)$|_at$/.test(key)
    )
      return formatBrasilia(value);
    return String(value);
  }
  if (typeof value === "string") return clean(value, 160);
  return clean(JSON.stringify(value), 160);
}

/**
 * Descrição genérica: a ação e os campos, um por linha. Os nomes são os do
 * pedido (o que de fato vai), não um texto livre.
 */
export function describeFields(
  title: string,
  params: Record<string, unknown>,
  skip: string[] = [],
) {
  const lines = Object.entries(params || {})
    .filter(([key]) => !skip.includes(key))
    .slice(0, MAX_LINES)
    .map(([key, value]) => `• ${key}: ${formatValue(key, value)}`);
  return limit([clean(title, 200), ...lines].join("\n"));
}

export const limit = (text: string) =>
  text.length <= MAX_DESCRIPTION
    ? text
    : text.slice(0, MAX_DESCRIPTION - 1) + "…";

/**
 * Usa a descrição do módulo; se ela faltar, falhar ou vier vazia, a genérica.
 * O texto do módulo também passa pelo teto.
 */
export async function describeWith(
  fromModule: (() => Promise<string | null | undefined>) | null,
  fallback: () => string,
) {
  if (fromModule)
    try {
      const text = await fromModule();
      if (typeof text === "string" && text.trim()) return limit(text.trim());
    } catch {
      // Registro sumiu ou dado inválido: a genérica mostra o pedido cru.
    }
  return fallback();
}
