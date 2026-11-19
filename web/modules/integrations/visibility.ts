import { useSyncExternalStore } from "react";
import type { ManagementContext, ManagementItem } from "../../../src/modules/panel-contract";
import type { Api } from "../../lib/api";
import { nativeTargetState } from "../../management/registry";
import type { IntegrationModule, SourceRef, SourceView } from "./contracts";

const pages: Record<IntegrationModule, string> = { os: "work", pedido: "pedidos", mesas: "mesas", entrega: "deliveries", mensalidade: "mensalidades", agenda: "agenda", reserva: "reserva", suporte: "suporte" };
export function integrationAccess(context: ManagementContext) {
  const base = context.statusLoaded && context.modules.erp === true;
  const role = context.erpRole;
  const finance = base && context.modules["erp-financeiro"] === true && (role === "admin" || role === "financeiro");
  const products = base && context.modules["erp-produtos"] === true && ["admin", "consulta", "vendas", "estoque", "fiscal"].includes(role ?? "");
  const stock = products && context.modules["erp-estoque"] === true;
  const documents = base && context.modules["erp-produtos"] === true && context.modules["erp-vendas"] === true && ["admin", "consulta", "financeiro", "vendas"].includes(role ?? "");
  const localModule = (module: IntegrationModule) => context.statusLoaded && (module === 'entrega'
    ? context.modules.entrega === true && (context.role === 'admin' || context.access === null || context.access.includes('*') || context.access.some(grant => grant === 'entrega' || grant.startsWith('entrega:')))
    : nativeTargetState(pages[module], context) === 'allowed');
  const moduleAllowed = (module: IntegrationModule) => base && localModule(module);
  const localWrite = (module: IntegrationModule) => localModule(module) &&
    (context.role === "admin" || context.access === null || context.access.includes("*") || context.access.some(grant => grant === module || grant.startsWith(module + ":")));
  // A9 retorna a política inteira, inclusive referências de contas. Até existir
  // uma projeção por destino, Estoque sem Financeiro não carrega esse DTO.
  return { base, finance, products, stock, documents, localWrite, localFinance: role === "admin" || role === "financeiro", policy: base && (finance || context.role === "admin" && stock), configure: base && context.role === "admin", postStock: stock && (role === "admin" || role === "estoque"),
    module: (module: IntegrationModule) => moduleAllowed(module),
    write: (module: IntegrationModule) => moduleAllowed(module) &&
      (context.role === "admin" || context.access === null || context.access.includes("*") || context.access.some(grant => grant === module || grant.startsWith(module + ":"))),
  };
}
export function visibleIntegrationItems<T extends ManagementItem>(items: readonly T[], context: ManagementContext): T[] {
  return items.filter(item => !item.hidden_when_modules_enabled?.some(module => context.modules[module] === true));
}
export function integrationRouteState(context: ManagementContext) {
  if (!context.statusLoaded) return "loading";
  if (!context.modules.erp) return "disabled";
  return Object.keys(pages).some(module => integrationAccess(context).module(module as IntegrationModule)) || integrationAccess(context).policy ? "allowed" : "denied";
}
export function portableWorkBlocked(target: string, context: ManagementContext) {
  const url = new URL(target, "https://panel.invalid");
  return context.modules.os === true && url.pathname === "/documentos-empresa" && url.searchParams.get("tipo") === "service_orders" &&
    !!url.searchParams.get("acao") && !["relatorios", "cabecalho"].includes(url.searchParams.get("acao")!);
}
export function sourceHref(source: SourceRef): string {
  // O endereço de integração resolve a origem opaca; nunca aceita URL do servidor.
  return "/app/erp/integracoes?" + new URLSearchParams({ module: source.module, source: source.source_id });
}
export function operationalHref(source: SourceRef): string {
  // O tipo de trabalho é resolvido antes de montar a URL pelo detalhe da integração.
  const slugs: Record<IntegrationModule, string> = { os: "trabalhos", pedido: "pedidos", mesas: "mesas", entrega: "entregas", mensalidade: "mensalidades", agenda: "agenda", reserva: "reservas", suporte: "suporte-pago" };
  if (source.module === "entrega") return sourceHref(source);
  return `/app/erp/modulos/${slugs[source.module]}?` + new URLSearchParams({ origem: source.source_id });
}
export function visibleSource(view: SourceView, context: ManagementContext): SourceView {
  const access = integrationAccess(context);
  return { ...view, manual_destinations: view.manual_destinations.filter(d => d === "finance" ? access.finance : access.postStock),
    deliveries: view.deliveries.map(d => access.finance ? d : { id: d.id, state: d.state, completed_ms: d.completed_ms }),
    links: view.links.filter(l => l.kind === "document" ? access.documents : l.kind === "stock_posting" ? access.stock : access.finance) };
}

/** Ponte leve entre a casa e o React portado, que usa outra raiz. */
export interface IntegrationHost { context: ManagementContext; root: string; actor: string; generation: number; api: Api }
let current: IntegrationHost | null = null;
const listeners = new Set<() => void>();
export const integrationHost = () => current;
export function installIntegrationHost(host: IntegrationHost) {
  current = host; listeners.forEach(fn => fn());
  return () => { if (current === host) { current = null; listeners.forEach(fn => fn()); } };
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useIntegrationHost = () => useSyncExternalStore(subscribe, integrationHost, () => null);
