import { describe, expect, it } from "vitest";
import type { ManagementItem } from "../src/modules/panel-contract";
import { NATIVE_MANAGEMENT_ITEMS } from "../src/modules/panel-navigation";
import {
  ERP_MANAGEMENT_ITEMS,
  ORIGIN_MENU,
} from "../src/modules/erp/panel-menu";
import { modules } from "../src/modules/registry";
import { resourcesForRole } from "../src/erp/role-resources";
import { pageModules, sections } from "../web/workspace-navigation";
import { ORIGIN_MENU as legacyMenu } from "../web/erp/app/lib/origin-menu";
import { workspaceMenu } from "../web/erp/app/lib/fagoo-menu";
import { api, bearer, fixture } from "./service-center-fixture";

const native: readonly ManagementItem[] = Object.values(NATIVE_MANAGEMENT_ITEMS).flat();
const items = [...native, ...ERP_MANAGEMENT_ITEMS];
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
      expect(item.id.startsWith(`${item.module}.`)).toBe(true);
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
      "work", "my-deadlines", "work-types", "service-orders-settings",
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
    expect(linked).toHaveLength(43);
    expect(ERP_MANAGEMENT_ITEMS).toHaveLength(linked.length);
    const legacyTarget = (item: typeof ERP_MANAGEMENT_ITEMS[number]) => item.id === "erp.overview" ? "/acesso" : item.target.to;
    expect(ERP_MANAGEMENT_ITEMS.find(item => item.id === "erp.overview")?.target.to).toBe("/visao-geral");
    expect(ERP_MANAGEMENT_ITEMS.map(legacyTarget)).toEqual(linked.map((item) => item.real!.to));
    for (const item of ERP_MANAGEMENT_ITEMS) {
      const old = linked.find((entry) => entry.real!.to === legacyTarget(item))!;
      expect(item.module).toBe("erp");
      expect(item.label).toBe(old.label);
      expect(item.permission).toEqual({
        kind: "erp",
        ...(old.real!.roles ? { roles: old.real!.roles } : {}),
        ...(old.real!.resource ? { resource: old.real!.resource } : {}),
      });
      expect([
        "cadastro", "catalogo", "vendas", "compras", "estoque", "financeiro",
        "fiscal", "cobranca", "pdv", "servicos", "resultados", "sistema",
      ]).toContain(item.part);
    }
    // O único rodapé sem destino continua no menu de compatibilidade.
    expect(originItems.filter((item) => !item.real)).toEqual([{ label: "Ver relatórios de cadastros" }]);
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
      "Resultados", "Comercial", "Compras", "Catálogo", "Estoque", "Financeiro", "Fiscal", "Pessoas",
    ]);
    for (const item of ERP_MANAGEMENT_ITEMS) {
      const group = menu.find((group) => group.columns.some((column) => column.items.some((entry) => entry.to === (item.id === "erp.overview" ? "/acesso" : item.target.to))));
      expect(group?.name).toBe(item.groupLabel);
    }
  });

  it("vincula cada contribuição à declaração e tem exatamente um primary por módulo", () => {
    const contributed = modules.filter((module) => module.management?.length);
    expect(contributed.map((module) => module.id).sort()).toEqual([...Object.keys(NATIVE_MANAGEMENT_ITEMS), "erp"].sort());
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
    expect(data.find((entry) => entry.id === "erp")).toMatchObject({ enabled: false, management: ERP_MANAGEMENT_ITEMS });
    expect(data.find((entry) => entry.id === "queue")?.management).toEqual([]);
    const outsider = await fixture();
    expect((await api(await bearer(outsider.member), `/profiles/${f.profile}/modules`)).status).toBe(404);
  });
});
