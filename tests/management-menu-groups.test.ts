import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementContext, ResolvedManagementItem } from "../src/modules/panel-contract";
import type { Route } from "../web/lib/routes";

// Menu superior do ERP: mapa único grupo atual → grupo do topo e coluna (web/management/menu-groups.ts).
const mocks = vi.hoisted(() => ({ route: { area: "erp" } as Route }));
vi.mock("../web/lib/routes", async original => ({
  ...await original<typeof import("../web/lib/routes")>(),
  useRoute: () => mocks.route, navigate: vi.fn(),
}));
vi.mock("../web/ui", () => ({
  Empty: ({ title, description }: any) => React.createElement("div", null, title, description),
  Button: ({ children }: any) => React.createElement("button", null, children),
  Spinner: ({ label }: any) => React.createElement("span", null, label),
}));

import { MANAGEMENT_ITEMS, managementItemHref } from "../web/management/registry";
import {
  MENU_GROUP_PLACEMENT, MENU_ITEM_PLACEMENT, MENU_TOP_GROUPS, erpDestinationPlacement, inPreferences, managementMenu, menuPlacement,
} from "../web/management/menu-groups";
import { ManagementShell } from "../web/management/ManagementShell";

// Pedido do dono (21/11): o grupo "Mais" saiu do topo; Sistema e Integrações moram em Preferências.
const TOP = ["Meu negócio", "Cadastros", "Vendas", "Serviços", "Compras e estoque", "Financeiro", "Fiscal"];
// Todos os itens do catálogo, como se tudo estivesse ligado e permitido (o maior menu possível).
const all: ResolvedManagementItem[] = MANAGEMENT_ITEMS.map(item => ({ ...item, href: managementItemHref(item), resolvedLabel: item.label }));
// O que vai ao topo: tudo, menos o que mora em Preferências.
const onTop = all.filter(item => !inPreferences(item));
const place = (id: string) => {
  const item = all.find(entry => entry.id === id)!;
  const group = managementMenu(all).find(top => top.items.includes(item))!;
  return [group.label, group.columns.find(column => column.items.includes(item))!.title];
};

beforeEach(() => {
  mocks.route = { area: "erp" };
  vi.stubGlobal("location", new URL("https://painel.test/app/erp"));
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), innerWidth: 1366 });
});

describe("mapa único do menu superior", () => {
  it("com tudo ligado, o topo tem os sete grupos pedidos, nesta ordem, sem Mais", () => {
    expect(managementMenu(all).map(group => group.label)).toEqual(TOP);
    expect(MENU_TOP_GROUPS.map(group => group.label)).toEqual(TOP);
  });

  it("cabe numa linha em 1366 px: Início e os grupos, com folga", () => {
    // 14 px seminegrito: no máximo ~8,5 px por letra; 20 px de respiro e 18 px da seta por grupo; 24 px de margem.
    const width = (label: string, arrow: boolean) => label.length * 8.5 + 20 + (arrow ? 18 : 0) + 2;
    const total = 24 + width("Início", false) + TOP.reduce((sum, label) => sum + width(label, true), 0);
    expect(total).toBeLessThan(1366 * 0.8);
  });

  it("não perde, não repete e não altera item: identificador e destino ficam os mesmos", () => {
    const placed = managementMenu(all).flatMap(group => group.columns.flatMap(column => column.items));
    // Os que saem do topo não somem: moram em Preferências (conferido no bloco "Sistema e Integrações em Preferências").
    expect(placed).toHaveLength(onTop.length);
    expect(new Set(placed)).toEqual(new Set(onTop));
    for (const group of managementMenu(all))
      expect(group.items).toEqual(group.columns.flatMap(column => column.items));
  });

  it("cada grupo atual do catálogo está mapeado; as exceções por item apontam para itens que existem", () => {
    for (const item of MANAGEMENT_ITEMS) expect(MENU_GROUP_PLACEMENT[item.group], item.group).toBeDefined();
    // erp.integrations entra pelo ErpArea quando a integração está liberada.
    const ids = new Set([...MANAGEMENT_ITEMS.map(item => item.id), "erp.integrations"]);
    for (const id of Object.keys(MENU_ITEM_PLACEMENT)) expect(ids.has(id), id).toBe(true);
  });

  it("coloca cada assunto no grupo combinado", () => {
    expect(place("erp.overview")).toEqual(["Meu negócio", "Resultados"]);
    expect(place("erp.goals")).toEqual(["Meu negócio", "Resultados"]);
    expect(place("erp.customers")).toEqual(["Cadastros", "Pessoas"]);
    expect(place("erp.employees")).toEqual(["Cadastros", "Pessoas"]);
    expect(place("erp.products")).toEqual(["Cadastros", "Produtos"]);
    expect(place("erp.price-lists")).toEqual(["Cadastros", "Produtos"]);
    expect(place("erp.payment-methods")).toEqual(["Cadastros", "Financeiro"]);
    expect(place("erp.financial-accounts")).toEqual(["Cadastros", "Financeiro"]);
    expect(place("erp.sales-orders")).toEqual(["Vendas", "Vendas"]);
    expect(place("erp.pos")).toEqual(["Vendas", "Vendas"]);
    expect(place("erp.sales-reports")).toEqual(["Vendas", "Relatórios"]);
    expect(place("erp.service-orders")).toEqual(["Serviços", "Ordens de serviço"]);
    expect(place("os.work")).toEqual(["Serviços", "Ordens de serviço"]);
    expect(place("agenda.calendar")).toEqual(["Serviços", "Agenda"]);
    expect(place("reserva.reservations")).toEqual(["Serviços", "Reservas"]);
    expect(place("forms.forms")).toEqual(["Serviços", "Formulários"]);
    expect(place("saude.records")).toEqual(["Serviços", "Módulos da área"]);
    expect(place("erp.purchase-orders")).toEqual(["Compras e estoque", "Compras"]);
    expect(place("erp.stock-movements")).toEqual(["Compras e estoque", "Estoque"]);
    expect(place("erp.payables")).toEqual(["Financeiro", "Financeiro"]);
    expect(place("erp.bank-remittances")).toEqual(["Financeiro", "Cobrança bancária"]);
    expect(place("payments.billing")).toEqual(["Financeiro", "Cobrança"]);
    expect(place("mensalidade.subscriptions")).toEqual(["Financeiro", "Mensalidades"]);
    expect(place("erp.outgoing-invoices")).toEqual(["Fiscal", "Notas fiscais"]);
    expect(place("pedido.orders")).toEqual(["Vendas", "Restaurante"]);
    expect(place("mesas.tables")).toEqual(["Vendas", "Restaurante"]);
  });

  it("Relatórios fecha o painel e as colunas seguem a ordem do mapa", () => {
    const columns = (label: string) => managementMenu(all).find(group => group.label === label)!.columns.map(column => column.title);
    expect(columns("Vendas")).toEqual(["Vendas", "Restaurante", "Relatórios"]);
    expect(columns("Cadastros")).toEqual(["Pessoas", "Produtos", "Financeiro"]);
    expect(columns("Compras e estoque")).toEqual(["Compras", "Estoque", "Relatórios"]);
    expect(columns("Financeiro")).toEqual(["Financeiro", "Cobrança", "Mensalidades", "Cobrança bancária", "Relatórios"]);
  });

  it("módulo novo sem mapa cai sozinho em Serviços, numa coluna com o nome dele", () => {
    const novo = { ...all[0], id: "novo.tela", group: "novo-modulo", groupLabel: "Novo módulo", resolvedLabel: "Tela nova" };
    expect(menuPlacement(novo)).toEqual({ top: "servicos", column: "Novo módulo", columnKey: "novo-modulo" });
    const menu = managementMenu([...all, novo]);
    const servicos = menu.find(group => group.key === "servicos")!;
    expect(servicos.columns.at(-1)).toEqual({ key: "novo-modulo", title: "Novo módulo", items: [novo] });
    expect(menu.map(group => group.label)).toEqual(TOP);
  });

  it("só aparecem grupos com item visível", () => {
    const agenda = all.filter(item => item.module === "agenda");
    expect(managementMenu(agenda).map(group => group.label)).toEqual(["Serviços"]);
    expect(managementMenu([])).toEqual([]);
  });

  it("o vocabulário da área dá título à coluna das ordens de serviço e junta com a do ERP quando o nome é igual", () => {
    const items = all.filter(item => item.module === "os" || item.id === "erp.service-orders");
    const titled = (title: string) => managementMenu(items, item => item.module === "os" ? title : item.groupLabel)[0].columns.map(column => column.title);
    expect(titled("Atendimentos")).toEqual(["Atendimentos", "Ordens de serviço"]);
    expect(titled("Ordens de serviço")).toEqual(["Ordens de serviço"]);
  });

  it("a busca e o rastro do ERP acham o caminho pelos grupos novos", () => {
    expect(erpDestinationPlacement("/estoque-empresa")).toEqual({ group: "Compras e estoque", column: "Estoque" });
    expect(erpDestinationPlacement("/formas-pagamento-empresa")).toEqual({ group: "Cadastros", column: "Financeiro" });
    expect(erpDestinationPlacement("/acesso")).toEqual({ group: "Meu negócio", column: "Resultados" });
    expect(erpDestinationPlacement("/rota-que-nao-existe")).toBeNull();
  });
});

describe("Sistema e Integrações em Preferências", () => {
  const SISTEMA = ["erp.effect-maintenance", "erp.activity", "erp.deletions"];
  const INTEGRACOES = ["erp.receive-bling"];
  // erp.integrations entra pelo ErpArea quando a integração está liberada (grupo comercial, como lá).
  const integrations = { ...all[0], id: "erp.integrations", module: "erp", group: "comercial", groupLabel: "Comercial", label: "Integrações", resolvedLabel: "Integrações" };

  it("saem do topo e da gaveta, e só eles", () => {
    expect(all.filter(inPreferences).map(item => item.id).sort()).toEqual([...SISTEMA, ...INTEGRACOES].sort());
    expect(inPreferences(integrations)).toBe(true);
    const placed = managementMenu([...all, integrations]).flatMap(group => group.items.map(item => item.id));
    for (const id of [...SISTEMA, ...INTEGRACOES, "erp.integrations"]) expect(placed, id).not.toContain(id);
    // Só itens de Preferências ligados: nenhum grupo no topo.
    expect(managementMenu([...all.filter(inPreferences), integrations])).toEqual([]);
  });

  it("cada um vai ao cartão certo", () => {
    for (const id of SISTEMA) expect(menuPlacement(all.find(item => item.id === id)!), id).toMatchObject({ top: "preferencias", column: "Sistema" });
    expect(menuPlacement(all.find(item => item.id === "erp.receive-bling")!)).toMatchObject({ top: "preferencias", column: "Integrações" });
    expect(menuPlacement(integrations)).toMatchObject({ top: "preferencias", column: "Integrações" });
  });

  it("a busca mostra o caminho por Preferências", () => {
    expect(erpDestinationPlacement("/manutencao-efeitos")).toEqual({ group: "Preferências", column: "Sistema" });
    expect(erpDestinationPlacement("/preferencias/sistema/registro-atividades")).toEqual({ group: "Preferências", column: "Sistema" });
    expect(erpDestinationPlacement("/preferencias/sistema/consulta-exclusoes")).toEqual({ group: "Preferências", column: "Sistema" });
    expect(erpDestinationPlacement("/receber-bling")).toEqual({ group: "Preferências", column: "Integrações" });
    expect(erpDestinationPlacement("/receber-bling?aba=mao-dupla")).toEqual({ group: "Preferências", column: "Integrações" });
    expect(erpDestinationPlacement("/integracoes")).toEqual({ group: "Preferências", column: "Integrações" });
  });
});

describe("menu superior e gaveta", () => {
  const context: ManagementContext = { statusLoaded: true, modules: {}, role: "admin", access: null, erpRole: "admin" };
  const shell = (items: readonly ResolvedManagementItem[]) => renderToString(React.createElement(ManagementShell, {
    context, items, entry: false, chromeRef: vi.fn(), children: null,
  }));

  it("o topo mostra Início e os grupos novos, com teclado ligado; a gaveta usa os mesmos grupos como seções", () => {
    const html = shell(all);
    const topnav = html.match(/<nav class="management-topnav"[\s\S]*?<\/nav>/)![0];
    const labels = [...topnav.matchAll(/data-topnav-root=""[^>]*>([^<]+)/g)].map(match => match[1]);
    expect(labels).toEqual(["Início", ...TOP]);
    expect(topnav.match(/data-topnav-group="/g)).toHaveLength(TOP.length);
    const drawer = html.match(/<nav aria-label="Módulos de gestão">([\s\S]*?)<\/nav>/)![1];
    expect([...drawer.matchAll(/<h2>(.*?)<\/h2>/g)].map(match => match[1])).toEqual(TOP);
    expect(drawer).toContain("<h3>Cobrança bancária</h3>");
    // Sistema e Integrações moram em Preferências: nem no topo, nem na gaveta.
    expect(drawer.match(/<a /g)!.length).toBe(onTop.length + 2);
    for (const label of ["Mais", "Receber dados do Bling", "Registro de atividades", "Manutenção de efeitos"]) {
      expect(topnav).not.toContain(label);
      expect(drawer).not.toContain(label);
    }
  });

  it("o grupo que contém a tela aberta fica destacado no topo", () => {
    mocks.route = { area: "erp", page: "agenda" } as Route;
    const topnav = shell(all).match(/<nav class="management-topnav"[\s\S]*?<\/nav>/)![0];
    expect(topnav).toMatch(/class="management-topnav-link management-topnav-selected" data-topnav-root="" data-topnav-group="servicos"/);
    expect(topnav.match(/management-topnav-selected/g)).toHaveLength(1);
  });

  it("grupo com um item só vira link direto para ele", () => {
    const html = shell(all.filter(item => item.module === "mesas"));
    const topnav = html.match(/<nav class="management-topnav"[\s\S]*?<\/nav>/)![0];
    expect(topnav).not.toContain("<button");
    expect([...topnav.matchAll(/data-topnav-root=""[^>]*>([^<]+)/g)].map(match => match[1])).toEqual(["Início", "Mesas"]);
  });
});
