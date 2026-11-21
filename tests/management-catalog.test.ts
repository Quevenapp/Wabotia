import { describe, expect, it } from "vitest";
import type { ManagementItem } from "../src/modules/panel-contract";
import { NATIVE_MANAGEMENT_ITEMS } from "../src/modules/panel-navigation";
import {
  ERP_MANAGEMENT_ITEMS,
  ORIGIN_MENU,
} from "../src/modules/erp/panel-menu";
import { modules } from "../src/modules/registry";
import { ERP_MODULE_IDS } from "../src/erp/parts";
import { ERP_PART_OWNERS } from "../web/erp/modules";
import { resourcesForRole } from "../src/erp/role-resources";
import { pageModules, sections } from "../web/workspace-navigation";
import { ORIGIN_MENU as legacyMenu } from "../web/erp/app/lib/origin-menu";
import { workspaceMenu } from "../web/erp/app/lib/fagoo-menu";
import { portedTarget } from "../web/management/ported-policy";
import { api, bearer, fixture } from "./service-center-fixture";

const native: readonly ManagementItem[] = Object.values(NATIVE_MANAGEMENT_ITEMS).flat();
const items = [...native, ...ERP_MANAGEMENT_ITEMS];
const portedLegacy = ERP_MANAGEMENT_ITEMS.filter(item => item.id !== "erp.effect-maintenance");
const originItems = ORIGIN_MENU.flatMap((group) => [
  ...group.columns.flatMap((column) => column.items),
  ...(group.footer ? [group.footer] : []),
]);

describe("catálogo da casa de gestão", () => {
  it("tem ids e destinos únicos, grupos consistentes e ordem explícita", () => {
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    const destinations = items.map(({ target }) => {
      if (target.kind === "native") return `native:${target.page}`;
      const url = new URL(target.to, "https://example.com/app/erp/");
      url.searchParams.sort();
      return `ported:${url.pathname}${url.search}${url.hash}`;
    });
    expect(new Set(destinations).size).toBe(items.length);
    for (const item of items) {
      expect(item.id.startsWith(`${item.target.kind === "ported" ? "erp" : item.module}.`)).toBe(true);
      expect(Number.isFinite(item.order)).toBe(true);
      expect(Number.isFinite(item.groupOrder)).toBe(true);
      expect(item.icon).not.toBe("");
      for (const peer of items.filter((other) => other.group === item.group)) {
        expect([peer.groupLabel, peer.groupOrder]).toEqual([item.groupLabel, item.groupOrder]);
      }
    }
  });

  it("cobre as páginas operacionais, com rótulos e permissões do módulo dono", () => {
    expect(native.map((item) => item.target.kind === "native" && item.target.page).sort()).toEqual([
      "work", "work-types",
      "agenda", "agenda-settings", "mensalidades", "mensalidade-settings",
      "pedidos", "pedidos-cardapio", "mesas", "reserva", "reserva-settings",
      "suporte", "suporte-settings", "condominio", "juridico", "saude", "ensino",
      "forms", "payments",
    ].sort());
    for (const item of native) {
      expect(item.target.kind).toBe("native");
      if (item.target.kind !== "native") continue;
      const page = item.target.page;
      const section = sections.find(([id]) => id === page);
      expect(section, item.id).toBeDefined();
      expect(item.label).toBe(section?.[1]);
      expect(pageModules[item.target.page]).toBe(item.module);
      expect(item.permission).toEqual({ kind: "page", page: item.target.page });
    }
  });

  it("preserva todos os destinos portados, inclusive consultas, rodapés e restrições", () => {
    expect(legacyMenu).toBe(ORIGIN_MENU);
    const linked = originItems.filter((item) => item.real);
    // + 3 dos relatórios do ERP: DRE gerencial, Pagamento da equipe e Relatórios em gráfico.
    // + 1 do contador: Para o contador (Fiscal).
    // + 1 da Produção: Ordens de produção (Estoque).
    // + 1 da Expedição (Comercial › Logística).
    // + 1 da compra pela nota recebida: Notas recebidas (Estoque › Compras).
    // + 1 da reforma tributária: Reforma tributária (IBS, CBS e IS) (Vendas › Gestão, parte Fiscal).
    // + 1 das lojas: Lojas e filiais (Cadastros).
    // + 2 da conciliação: Conciliação bancária e Conciliação de cartões (Financeiro).
    // + 1 dos contratos de serviço: Contratos (Financeiro).
    // + 1 do SPED e SINTEGRA (Fiscal).
    // - 2 da cobrança num só caminho: Cobrança operacional e Retornos operacionais saem (entram por Remessas e retornos).
    // + 1 do rodapé de Cadastros com destino: Ver relatórios de cadastros.
    // + 5 do Financeiro que só abriam por dentro: transferências, recorrentes, borderôs, vencimentos e importação.
    expect(linked).toHaveLength(66);
    expect(ERP_MANAGEMENT_ITEMS).toHaveLength(67);
    expect(ERP_MANAGEMENT_ITEMS).toHaveLength(linked.length + 1);
    expect(ERP_MANAGEMENT_ITEMS.find(item => item.id === "erp.effect-maintenance")).toMatchObject({
      module: "erp", part: "sistema", groupLabel: "Sistema", order: 440,
      target: { kind: "ported", to: "/manutencao-efeitos" }, permission: { kind: "erp" },
    });
    const legacyTarget = (item: typeof ERP_MANAGEMENT_ITEMS[number]) => item.id === "erp.overview" ? "/acesso" : item.target.to;
    expect(ERP_MANAGEMENT_ITEMS.find(item => item.id === "erp.overview")?.target.to).toBe("/visao-geral");
    expect(portedLegacy.map(legacyTarget)).toEqual(linked.map((item) => item.real!.to));
    const reopened = ERP_MANAGEMENT_ITEMS.filter(item => [
      "erp.activity", "erp.deletions",
    ].includes(item.id));
    expect(reopened.map(item => [item.id, item.target.to, item.groupLabel, item.part, item.permission.roles])).toEqual([
      ["erp.activity", "/preferencias/sistema/registro-atividades", "Sistema", "sistema", ["admin"]],
      ["erp.deletions", "/preferencias/sistema/consulta-exclusoes", "Sistema", "sistema", ["admin"]],
    ]);
    for (const item of reopened)
      expect(portedTarget(item.target.to)).toMatchObject({ part: item.part, roles: item.permission.roles });
    // A tela admite todos os papéis ERP; a política persistida do Bling decide
    // quem pode consultar o acervo (padrão: administrador).
    expect(ERP_MANAGEMENT_ITEMS.find(item => item.id === "erp.receive-bling")).toMatchObject({
      module: "erp", part: "sistema", groupLabel: "Sistema", order: 470,
      label: "Receber dados do Bling", target: { kind: "ported", to: "/receber-bling" },
      permission: { kind: "erp" },
    });
    expect(portedTarget("/receber-bling")).toEqual({ part: "sistema", kind: "erp" });
    for (const item of portedLegacy) {
      const old = linked.find((entry) => entry.real!.to === legacyTarget(item))!;
      expect(item.module).toBe(ERP_PART_OWNERS[item.part]);
      expect(item.label).toBe(old.label);
      expect(item.permission).toEqual({
        kind: "erp",
        ...(old.real!.roles ? { roles: old.real!.roles } : {}),
        ...(old.real!.resource ? { resource: old.real!.resource } : {}),
      });
      expect([
        "cadastro", "catalogo", "vendas", "compras", "estoque", "financeiro",
        "fiscal", "cobranca", "pdv", "servicos", "resultados", "sistema", "expedicao", "producao", "contratos",
      ]).toContain(item.part);
    }
    // Todo rodapé tem destino (Ver relatórios de cadastros abre os relatórios de contatos e produtos).
    expect(originItems.filter((item) => !item.real)).toEqual([]);
    // Cobrança operacional e Retornos operacionais seguem abrindo pelo caminho de Remessas e retornos.
    for (const to of ["/cobranca-operacional", "/retornos-operacionais"])
      expect(portedTarget(to)).toMatchObject({ part: "cobranca", roles: ["admin", "consulta", "financeiro"] });
  });

  it("classifica explicitamente sem depender do rótulo apresentado", () => {
    const resolved = ORIGIN_MENU.map((group) => ({
      name: group.name,
      columns: group.columns.map((column) => ({
        title: column.title,
        items: column.items.map((item) => ({ label: "traduzido", to: item.real?.to, disabled: !item.real })),
      })),
      ...(group.footer ? { footer: { label: "traduzido", to: group.footer.real?.to, disabled: !group.footer.real } } : {}),
    }));
    const menu = workspaceMenu(resolved);
    expect(menu.map((group) => group.name)).toEqual([
      "Resultados", "Comercial", "Compras", "Catálogo", "Estoque", "Financeiro", "Fiscal", "Pessoas", "Sistema",
    ]);
    for (const item of portedLegacy) {
      const group = menu.find((group) => group.columns.some((column) => column.items.some((entry) => entry.to === (item.id === "erp.overview" ? "/acesso" : item.target.to))));
      expect(group?.name).toBe(item.groupLabel);
    }
  });

  it("vincula cada contribuição à declaração e tem exatamente um primary por módulo", () => {
    const contributed = modules.filter((module) => module.management?.length);
    expect(contributed.map((module) => module.id).sort()).toEqual([...Object.keys(NATIVE_MANAGEMENT_ITEMS), ...ERP_MODULE_IDS].sort());
    for (const module of contributed) {
      const expected = items.filter((item) => item.module === module.id);
      expect(module.management).toEqual(expected);
      expect(module.management!.filter((item) => item.primary)).toHaveLength(1);
    }
    expect(items.filter((item) => item.labelKey).map((item) => [item.id, item.labelKey])).toEqual([
      ["os.work", "workCollection"], ["erp.customers", "customers"],
    ]);
  });

  it("mantém os recursos por papel e devolve cópias independentes", () => {
    expect(resourcesForRole("vendas")).toEqual(["contacts", "products", "sales_orders", "sales_proposals"]);
    expect(resourcesForRole("financeiro")).toEqual(["contacts", "receivables", "payables"]);
    expect(resourcesForRole("estoque")).toEqual(["contacts", "products", "purchase_orders"]);
    expect(resourcesForRole("fiscal")).toEqual(["contacts", "products", "sales_orders", "purchase_orders", "nfe", "nfce"]);
    const all = ["contacts", "products", "sales_orders", "purchase_orders", "sales_proposals", "receivables", "payables", "nfe", "nfce"];
    expect(resourcesForRole("admin")).toEqual(all);
    expect(resourcesForRole("consulta")).toEqual(all);
    expect(resourcesForRole(null)).toEqual([]);
    expect(resourcesForRole("desconhecido")).toEqual([]);
    resourcesForRole("admin").pop();
    expect(resourcesForRole("admin")).toEqual(all);
  });

  it("GET /modules acrescenta management inclusive para módulos desligados", async () => {
    const f = await fixture();
    const response = await api(await bearer(f.admin), `/profiles/${f.profile}/modules`);
    expect(response.status).toBe(200);
    const { data } = await response.json<{ data: Array<{ id: string; enabled: boolean; management: ManagementItem[] }> }>();
    expect(data).toHaveLength(modules.length);
    for (const module of modules) {
      expect(data.find((entry) => entry.id === module.id)).toMatchObject({
        navigation: module.navigation,
        menu_item_types: module.menu_item_types,
        management: module.management ?? [],
      });
    }
    for (const id of ERP_MODULE_IDS)
      expect(data.find((entry) => entry.id === id)).toMatchObject({ enabled: false, management: ERP_MANAGEMENT_ITEMS.filter(item => item.module === id) });
    expect(data.find((entry) => entry.id === "queue")?.management).toEqual([]);
    const outsider = await fixture();
    expect((await api(await bearer(outsider.member), `/profiles/${f.profile}/modules`)).status).toBe(404);
  });
});
