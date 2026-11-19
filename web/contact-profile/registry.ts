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
    const paths: Record<string, string> = {
      sales: "/app/erp/documentos-empresa?tipo=sales_orders&documento=", sales_orders: "/app/erp/documentos-empresa?tipo=sales_orders&documento=",
      open_titles: "/app/erp/financeiro-empresa?area=receivable&titulo=", receivables: "/app/erp/financeiro-empresa?area=receivable&titulo=",
      titles: "/app/erp/financeiro-empresa?area=receivable&titulo=",
      ledger: "/app/erp/financeiro-empresa?area=ficha&contato=", contact_ledger: "/app/erp/financeiro-empresa?area=ficha&contato=",
    };
    return Object.hasOwn(paths, target.resource) ? paths[target.resource] + encodeURIComponent(target.id) : null;
  }
  return Object.hasOwn(destinations, target.module) ? destinations[target.module] : null;
}

export function privateTarget(data: Json): CustomerTarget | null {
  const target = (data as { target?: CustomerTarget } | null)?.target;
  return target && ["saude", "ensino", "juridico"].includes(target.module) && targetHref(target) ? target : null;
}
export function cellText(value: string | number | null | undefined, format: string): string {
  if (value == null || value === "") return "—";
  if (format === "status") {
    const states: Record<string, string> = { open: "Em aberto", pending: "Pendente", closed: "Encerrado", done: "Concluído", completed: "Concluído",
      ready: "Pronto", active: "Ativo", inactive: "Inativo", paid: "Pago", cancelled: "Cancelado", scheduled: "Agendado", confirmed: "Confirmado",
      waiting: "Aguardando", checked_in: "Check-in realizado", missed: "Não compareceu", expired: "Expirado", running: "Em andamento",
      draft: "Em digitação", verified: "Verificado", in_progress: "Em andamento", partially_fulfilled: "Atendido parcialmente", fulfilled: "Atendido", overdue: "Em atraso",
      conflict: "Em revisão", paused: "Pausado", retained: "Retido", blocked: "Bloqueado", ambiguous: "Vínculo ambíguo", excluded: "Excluído" };
    return Object.hasOwn(states, String(value)) ? states[String(value)] : String(value);
  }
  if (format === "moneyCents" && /^-?\d+$/.test(String(value))) {
    const cents = BigInt(value), amount = cents < 0n ? -cents : cents;
    return cellText(`${cents < 0n ? "-" : ""}${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`, "money");
  }
  // O ERP entrega decimais como texto: não passar por Number nem arredondar.
  if (format === "money" && typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    const [integer, decimal = ""] = value.split(".");
    return `R$ ${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimal.padEnd(2, "0")}`;
  }
  if (format === "money" && typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
  if (format === "date" || format === "datetime") {
    const date = new Date(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T12:00:00Z" : value);
    if (!Number.isNaN(date.valueOf())) return format === "date" ? date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }
  return String(value);
}
