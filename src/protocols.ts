import { requireValue, defaultProtocolConfirmation } from "./types";
import { formatBrasilia } from "./business-time";
export { defaultProtocolConfirmation };

// Pure rules shared by the API, the engine, the push processor and the
// customer lookup. Nothing here reads the database.

export const ticketStatuses = [
  "open",
  "in_progress",
  "waiting_customer",
  "waiting_third",
  "resolved",
  "closed",
];
/** A protocol is active while it is neither resolved nor closed. */
export const isActiveTicket = (status: unknown) =>
  status !== "resolved" && status !== "closed";
/** SQL form of isActiveTicket; `alias` is an optional table alias such as "t.". */
export const activeTicketSql = (alias = "") =>
  `${alias}status NOT IN ('resolved','closed')`;
export const ticketTeamLabels: Record<string, string> = {
  open: "Recebido",
  in_progress: "Em análise",
  waiting_customer: "Aguardando cliente",
  waiting_third: "Aguardando terceiro",
  resolved: "Resolvido",
  closed: "Encerrado",
};
export const ticketCustomerLabels: Record<string, string> = {
  open: "Recebido",
  in_progress: "Em análise",
  waiting_customer: "Aguardando você",
  waiting_third: "Aguardando atualização",
  resolved: "Resolvido",
  closed: "Encerrado",
};

export const defaultTicketQuestion =
  "Descreva em uma mensagem o que você precisa. Se puder, diga o que tentou e o que aconteceu.";

export function validateTicketCategories(categories: any) {
  requireValue(
    Array.isArray(categories) && categories.length <= 50,
    "Use até 50 categorias de protocolo.",
  );
  const ids = new Set<string>();
  return categories.map((category: any) => {
    requireValue(
      typeof category?.id === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(category.id) &&
        !ids.has(category.id),
      "Identificador de categoria inválido ou repetido.",
    );
    ids.add(category.id);
    requireValue(
      typeof category.name === "string" &&
        category.name.trim().length > 0 &&
        category.name.length <= 100,
      "Informe o nome da categoria, com até 100 caracteres.",
    );
    requireValue(
      category.enabled === undefined || typeof category.enabled === "boolean",
      "Informe se a categoria está habilitada ou desabilitada.",
    );
    return {
      id: category.id,
      name: category.name.trim(),
      enabled: category.enabled !== false,
    };
  });
}
const categories = (config: any): any[] =>
  Array.isArray(config?.ticket_categories) ? config.ticket_categories : [];
/** The id when it names an enabled category; otherwise null. */
export function enabledCategory(config: any, id: unknown) {
  return typeof id === "string" &&
    categories(config).some((c) => c?.id === id && c.enabled !== false)
    ? id
    : null;
}
/** Name shown to people. A category removed from the settings shows its id. */
export function categoryName(config: any, id: unknown) {
  if (typeof id !== "string" || !id) return "";
  const found = categories(config).find((c) => c?.id === id);
  return String(found?.name || id);
}

/**
 * Fills {numero}, {assunto}, {aplicativo} and {prazo}. A line whose marker has
 * no value is dropped whole, so "Aplicativo:" never appears empty.
 */
export function renderProtocolConfirmation(
  template: unknown,
  values: {
    numero?: string;
    assunto?: string;
    aplicativo?: string;
    prazo?: string;
  },
) {
  const source =
    typeof template === "string" && template.trim()
      ? template
      : defaultProtocolConfirmation;
  const value = (name: string) =>
    String((values as Record<string, unknown>)[name] ?? "").trim();
  const marker = /\{(numero|assunto|aplicativo|prazo)\}/g;
  return source
    .split(/\r?\n/)
    .filter((line) =>
      [...line.matchAll(marker)].every((match) => value(match[1])),
    )
    .map((line) => line.replace(marker, (_, name) => value(name)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function protocolConfirmation(config: any, ticket: any) {
  return renderProtocolConfirmation(config?.protocol_confirmation, {
    numero: ticket.number,
    assunto: Array.from(String(ticket.title || ""))
      .slice(0, 300)
      .join(""),
    aplicativo: categoryName(config, ticket.category),
    prazo: ticket.response_due_at ? formatBrasilia(ticket.response_due_at) : "",
  });
}

/** Customer words that start the "open a protocol" flow. */
export const opensTicket = (normalized: string) =>
  /^(protocolo|abrir protocolo|novo protocolo)[\s!?.]*$/.test(normalized);
/** Exact lookup commands; they leave a pending description prompt. */
export const lookupCommand = (normalized: string) =>
  /^(meus protocolos|consultar protocolos?)[\s!?.]*$/.test(normalized);
