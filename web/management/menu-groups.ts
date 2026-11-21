// Mapa único do menu superior do ERP: grupo atual do item → grupo do topo e coluna do painel.
// Só arruma a apresentação: não muda identificador, destino, ordem relativa nem visibilidade (partes e permissões).
// Grupo ou item que ninguém mapeou cai sozinho em "Serviços", numa coluna com o nome do próprio grupo.
// Sistema e Integrações não ficam no topo (pedido do dono, 21/11): moram em Preferências, nos cartões Sistema e
// Integrações, e a busca "Buscar telas e ações" continua achando cada tela pelo caminho "Preferências › Sistema" ou
// "Preferências › Integrações".
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
] as const;

/** Lugar fora do topo: a tela continua existindo e abre pelo cartão de Preferências com o título da coluna. */
export const MENU_PREFERENCES = { key: "preferencias", label: "Preferências" } as const;

export type MenuTopKey = typeof MENU_TOP_GROUPS[number]["key"];
export type MenuPlaceKey = MenuTopKey | typeof MENU_PREFERENCES.key;
/** Coluna sem título fixo usa o título do grupo atual do item (com o vocabulário da área, quando houver). */
export interface MenuPlacement { top: MenuPlaceKey; column?: string }

/** Por grupo atual (campo `group` dos itens). A ordem aqui é a ordem das colunas dentro de cada painel. */
export const MENU_GROUP_PLACEMENT: Readonly<Record<string, MenuPlacement>> = {
  // Meu negócio
  resultados: { top: "negocio", column: "Resultados" },
  // Cadastros
  pessoas: { top: "cadastros", column: "Pessoas" },
  catalogo: { top: "cadastros", column: "Produtos" },
  // Vendas
  comercial: { top: "vendas", column: "Vendas" },
  // Restaurante: pedidos e mesas são venda; coluna própria no painel de Vendas
  pedido: { top: "vendas", column: "Restaurante" },
  mesas: { top: "vendas", column: "Restaurante" },
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
  // Sistema: fora do topo, no cartão Sistema de Preferências
  sistema: { top: "preferencias", column: "Sistema" },
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
  // Integrações: fora do topo, no cartão Integrações de Preferências
  "erp.integrations": { top: "preferencias", column: "Integrações" },
  "erp.receive-bling": { top: "preferencias", column: "Integrações" },
};

/**
 * Destinos de Preferências que não são itens do catálogo do ERP: Integrações (tela do painel, que entra no menu pelo
 * ErpArea) e a aba Mão dupla de Receber dados do Bling. Só servem para a busca e o rastro mostrarem o caminho.
 */
const PREFERENCES_DESTINATIONS: Readonly<Record<string, string>> = {
  "/integracoes": "Integrações",
  "/receber-bling?aba=mao-dupla": "Integrações",
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
  if (!place) return { top: "servicos", column: item.groupLabel, columnKey: item.group };
  return { top: place.top, column: place.column ?? item.groupLabel, columnKey: place.column ?? item.group };
}

/** O item mora em Preferências (cartões Sistema e Integrações), não no menu superior nem na gaveta. */
export function inPreferences(item: PlaceableItem): boolean {
  return menuPlacement(item).top === MENU_PREFERENCES.key;
}

export interface MenuColumn<T> { key: string; title: string; items: T[] }
export interface MenuTopGroup<T> { key: MenuTopKey; label: string; columns: MenuColumn<T>[]; items: T[] }

/**
 * Agrupa itens já resolvidos (visíveis) em grupos do topo e colunas, sem descartar nem reordenar itens dentro da coluna.
 * Os itens que moram em Preferências ficam de fora: o topo e a gaveta não mostram Sistema nem Integrações.
 * `columnTitle` permite trocar o título de coluna sem título fixo (o vocabulário de "Ordens de serviço", por exemplo).
 */
export function managementMenu<T extends PlaceableItem>(items: readonly T[], columnTitle: (item: T) => string = item => item.groupLabel): MenuTopGroup<T>[] {
  const tops = new Map<MenuPlaceKey, Map<string, MenuColumn<T>>>();
  for (const item of items) {
    const place = menuPlacement(item);
    if (place.top === MENU_PREFERENCES.key) continue;
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

/**
 * Grupo do topo e coluna de um destino do ERP (caminho dentro do ERP, como "/estoque-empresa"), para a busca e o rastro.
 * Destino que mora em Preferências responde "Preferências" e o cartão (Sistema ou Integrações).
 */
export function erpDestinationPlacement(to: string): { group: string; column: string } | null {
  const path = to === "/acesso" ? "/visao-geral" : to;
  const extra = PREFERENCES_DESTINATIONS[path];
  if (extra) return { group: MENU_PREFERENCES.label, column: extra };
  const item = ERP_MANAGEMENT_ITEMS.find(entry => entry.target.to === path);
  if (!item) return null;
  const place = menuPlacement(item);
  const group = place.top === MENU_PREFERENCES.key ? MENU_PREFERENCES.label : MENU_TOP_GROUPS.find(top => top.key === place.top)!.label;
  return { group, column: place.column };
}
