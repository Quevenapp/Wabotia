// Mapa único do menu superior do ERP: grupo atual do item → grupo do topo e coluna do painel.
// Só arruma a apresentação: não muda identificador, destino, ordem relativa nem visibilidade (partes e permissões).
// Grupo ou item que ninguém mapeou cai sozinho em "Mais", numa coluna com o nome do próprio grupo.
import { ERP_MANAGEMENT_ITEMS } from "../../src/modules/erp/panel-menu.ts";

/** Grupos do topo, nesta ordem; "Início" é o link fixo antes deles. */
export const MENU_TOP_GROUPS = [
  { key: "negocio", label: "Meu negócio" },
  { key: "cadastros", label: "Cadastros" },
  { key: "vendas", label: "Vendas" },
  { key: "servicos", label: "Serviços" },
  { key: "compras-estoque", label: "Compras e estoque" },
  { key: "financeiro", label: "Financeiro" },
  { key: "fiscal", label: "Fiscal" },
  { key: "mais", label: "Mais" },
] as const;

export type MenuTopKey = typeof MENU_TOP_GROUPS[number]["key"];
/** Coluna sem título fixo usa o título do grupo atual do item (com o vocabulário da área, quando houver). */
export interface MenuPlacement { top: MenuTopKey; column?: string }

/** Por grupo atual (campo `group` dos itens). A ordem aqui é a ordem das colunas dentro de cada painel. */
export const MENU_GROUP_PLACEMENT: Readonly<Record<string, MenuPlacement>> = {
  // Meu negócio
  resultados: { top: "negocio", column: "Resultados" },
  // Cadastros
  pessoas: { top: "cadastros", column: "Pessoas" },
  catalogo: { top: "cadastros", column: "Produtos" },
  // Vendas
  comercial: { top: "vendas", column: "Vendas" },
  // Serviços: tudo o que é serviço prestado, inclusive os módulos de área
  os: { top: "servicos" },
  agenda: { top: "servicos" },
  reserva: { top: "servicos" },
  suporte: { top: "servicos" },
  forms: { top: "servicos" },
  condominio: { top: "servicos", column: "Módulos da área" },
  juridico: { top: "servicos", column: "Módulos da área" },
  saude: { top: "servicos", column: "Módulos da área" },
  ensino: { top: "servicos", column: "Módulos da área" },
  // Compras e estoque
  compras: { top: "compras-estoque", column: "Compras" },
  estoque: { top: "compras-estoque", column: "Estoque" },
  // Financeiro, com cobrança bancária e mensalidades
  financeiro: { top: "financeiro", column: "Financeiro" },
  payments: { top: "financeiro", column: "Cobrança" },
  mensalidade: { top: "financeiro" },
  // Fiscal
  fiscal: { top: "fiscal", column: "Notas fiscais" },
  // Mais: restaurante, entrega, integrações e sistema
  pedido: { top: "mais", column: "Restaurante" },
  mesas: { top: "mais", column: "Restaurante" },
  sistema: { top: "mais", column: "Sistema" },
};

/** Exceções por identificador, para itens cujo grupo atual mistura assuntos. Vencem o mapa por grupo. */
export const MENU_ITEM_PLACEMENT: Readonly<Record<string, MenuPlacement>> = {
  "erp.financial-accounts": { top: "cadastros", column: "Financeiro" },
  "erp.financial-categories": { top: "cadastros", column: "Financeiro" },
  "erp.payment-methods": { top: "cadastros", column: "Financeiro" },
  "erp.sales-reports": { top: "vendas", column: "Relatórios" },
  "erp.service-orders": { top: "servicos", column: "Ordens de serviço" },
  "erp.service-reports": { top: "servicos", column: "Ordens de serviço" },
  "erp.stock-reports": { top: "compras-estoque", column: "Relatórios" },
  "erp.bank-remittances": { top: "financeiro", column: "Cobrança bancária" },
  "erp.operational-billing": { top: "financeiro", column: "Cobrança bancária" },
  "erp.operational-returns": { top: "financeiro", column: "Cobrança bancária" },
  "erp.financial-reports": { top: "financeiro", column: "Relatórios" },
  "erp.integrations": { top: "mais", column: "Integrações" },
  "erp.receive-bling": { top: "mais", column: "Integrações" },
};

/** Ordem das colunas: a dos mapas acima (primeiro por grupo, depois as exceções); colunas sem mapa vão ao fim. */
const COLUMN_ORDER = [...new Set([
  ...Object.entries(MENU_GROUP_PLACEMENT).map(([group, place]) => place.column ?? group),
  ...Object.values(MENU_ITEM_PLACEMENT).map(place => place.column!),
])];
// "Relatórios" fecha o painel em que aparece, depois das colunas de trabalho.
COLUMN_ORDER.push(...COLUMN_ORDER.splice(COLUMN_ORDER.indexOf("Relatórios"), 1));

interface PlaceableItem { id: string; group: string; groupLabel: string }

export function menuPlacement(item: PlaceableItem): Required<MenuPlacement> & { columnKey: string } {
  const place = MENU_ITEM_PLACEMENT[item.id] ?? MENU_GROUP_PLACEMENT[item.group];
  if (!place) return { top: "mais", column: item.groupLabel, columnKey: item.group };
  return { top: place.top, column: place.column ?? item.groupLabel, columnKey: place.column ?? item.group };
}

export interface MenuColumn<T> { key: string; title: string; items: T[] }
export interface MenuTopGroup<T> { key: MenuTopKey; label: string; columns: MenuColumn<T>[]; items: T[] }

/**
 * Agrupa itens já resolvidos (visíveis) em grupos do topo e colunas, sem descartar nem reordenar itens dentro da coluna.
 * `columnTitle` permite trocar o título de coluna sem título fixo (o vocabulário de "Ordens de serviço", por exemplo).
 */
export function managementMenu<T extends PlaceableItem>(items: readonly T[], columnTitle: (item: T) => string = item => item.groupLabel): MenuTopGroup<T>[] {
  const tops = new Map<MenuTopKey, Map<string, MenuColumn<T>>>();
  for (const item of items) {
    const place = menuPlacement(item);
    const columns = tops.get(place.top) ?? new Map<string, MenuColumn<T>>();
    tops.set(place.top, columns);
    const fixed = MENU_ITEM_PLACEMENT[item.id]?.column ?? MENU_GROUP_PLACEMENT[item.group]?.column;
    const column = columns.get(place.columnKey) ?? { key: place.columnKey, title: fixed ?? columnTitle(item), items: [] };
    columns.set(place.columnKey, column);
    column.items.push(item);
  }
  const rank = (key: string) => { const index = COLUMN_ORDER.indexOf(key); return index < 0 ? COLUMN_ORDER.length : index; };
  return MENU_TOP_GROUPS.flatMap(({ key, label }) => {
    const columns = tops.get(key);
    if (!columns) return [];
    // Ordenação estável: colunas sem mapa mantêm a ordem em que apareceram.
    // Colunas que acabam com o mesmo título (vocabulário igual a um título fixo) viram uma só.
    const sorted: MenuColumn<T>[] = [];
    for (const column of [...columns.values()].sort((a, b) => rank(a.key) - rank(b.key))) {
      const same = sorted.find(other => other.title === column.title);
      if (same) same.items.push(...column.items); else sorted.push({ ...column, items: [...column.items] });
    }
    return [{ key, label, columns: sorted, items: sorted.flatMap(column => column.items) }];
  });
}

/** Grupo do topo e coluna de um destino do ERP (caminho dentro do ERP, como "/estoque-empresa"), para a busca e o rastro. */
export function erpDestinationPlacement(to: string): { group: string; column: string } | null {
  const path = to === "/acesso" ? "/visao-geral" : to;
  const item = ERP_MANAGEMENT_ITEMS.find(entry => entry.target.to === path);
  if (!item) return null;
  const place = menuPlacement(item);
  return { group: MENU_TOP_GROUPS.find(group => group.key === place.top)!.label, column: place.column };
}
