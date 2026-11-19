import type { ContactContribution, Json } from "../../src/customer/profile-contracts";
import type { CustomerTarget } from "../../src/customer/contracts";

// Catálogo compilado. Nenhum caminho, HTML, script ou import vem da API.
export const profileComponents = Object.freeze({
  table: { kind: "collection" },
  erp: { kind: "collection" },
  "condominio.units": { kind: "section", schema: "condominio.units.v1" },
  "private.navigation": { kind: "section", schema: "private.navigation.v1" },
} as const);
export function registeredComponent(item: ContactContribution) {
  const component = Object.hasOwn(profileComponents, item.component) ? profileComponents[item.component] : null;
  return component?.kind === item.kind ? component : null;
}

const destinations: Readonly<Record<string, string>> = Object.freeze({
  os: "/app/gestao/trabalhos", agenda: "/app/gestao/agenda", pedido: "/app/gestao/pedidos",
  reserva: "/app/gestao/reservas", mensalidade: "/app/gestao/mensalidades", suporte: "/app/gestao/suporte-pago",
  queue: "/app/fila", forms: "/app/gestao/formularios", condominio: "/app/gestao/condominio",
  saude: "/app/gestao/prontuarios", ensino: "/app/gestao/ensino", juridico: "/app/gestao/prazos-juridicos",
});
export function targetHref(target: CustomerTarget): string | null {
  if (!target || typeof target.id !== "string" || typeof target.resource !== "string") return null;
  if (target.module === "conversations") return "/app/conversas/" + encodeURIComponent(target.id);
  if (target.module === "tickets") return "/app/protocolos/" + encodeURIComponent(target.id);
  if (target.module === "erp") {
    const paths: Record<string, string> = { sales: "/app/erp/documentos-empresa?tipo=sales_orders", sales_orders: "/app/erp/documentos-empresa?tipo=sales_orders",
      open_titles: "/app/erp/financeiro-empresa?area=receivable", receivables: "/app/erp/financeiro-empresa?area=receivable" };
    if (target.resource === "ledger") return "/app/erp/financeiro-empresa?area=ficha&contato=" + encodeURIComponent(target.id);
    return Object.hasOwn(paths, target.resource) ? paths[target.resource] + "&registro=" + encodeURIComponent(target.id) : null;
  }
  return Object.hasOwn(destinations, target.module) ? destinations[target.module] : null;
}

export function privateTarget(data: Json): CustomerTarget | null {
  const target = (data as { target?: CustomerTarget } | null)?.target;
  return target && ["saude", "ensino", "juridico"].includes(target.module) && targetHref(target) ? target : null;
}
export function cellText(value: string | number | null, format: string): string {
  if (value == null || value === "") return "—";
  if (format === "status") {
    const states: Record<string, string> = { open: "Em aberto", pending: "Pendente", closed: "Encerrado", done: "Concluído", completed: "Concluído",
      ready: "Pronto", active: "Ativo", inactive: "Inativo", paid: "Pago", cancelled: "Cancelado", scheduled: "Agendado", confirmed: "Confirmado",
      waiting: "Aguardando", checked_in: "Check-in realizado", missed: "Não compareceu", expired: "Expirado", running: "Em andamento",
      conflict: "Em revisão", paused: "Pausado", retained: "Retido", blocked: "Bloqueado", ambiguous: "Vínculo ambíguo", excluded: "Excluído" };
    return Object.hasOwn(states, String(value)) ? states[String(value)] : String(value);
  }
  if (format === "money" && typeof value === "number") return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
  if (format === "date" || format === "datetime") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return format === "date" ? date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }
  return String(value);
}
