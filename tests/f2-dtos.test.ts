import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpStub } from "../src/erp/hub";
import { migrate, storageDriver } from "../src/erp/hub-engine";
import "../src/erp/domains/index";
import { callRpc, type RpcArgs } from "../src/erp/engine/registry";
import { normalizeErpParts, type ErpParts } from "../src/erp/parts";
import { homeResponse, homeShortcutsResponse } from "../src/erp/fagoo/workers/erp-api/src/home.mjs";
import { businessRouter } from "../src/erp/fagoo/workers/erp-api/src/business.mjs";
import { preferencesPageResponse, parsePreferencesRoute, executePreferencesRoute } from "../src/erp/fagoo/workers/erp-api/src/preferences.mjs";
import { catalogResponse } from "../src/erp/fagoo/workers/erp-api/src/catalog.mjs";
import { documentsResponse } from "../src/erp/fagoo/workers/erp-api/src/documents.mjs";
import { parseBusinessPanel } from "../src/erp/fagoo/packages/erp-domain/src/business-dashboards.mjs";
import { parsePreferencesPage } from "../src/erp/fagoo/packages/erp-domain/src/preferences/dto.mjs";

const user = "11111111-1111-4111-8111-111111111111";
const actor = { user_id: user, erp_role: "admin" as const, is_agent: false, verified_factor: false, aal: "aal1" as const, session_id: null, name: "Admin", email: null };
type Rpc = (name: string, args?: RpcArgs, parts?: Partial<ErpParts>) => any;
async function engine(check: (rpc: Rpc) => Promise<void> | void) {
  await runInDurableObject(erpStub(env, `f2-dtos-${crypto.randomUUID()}`), async (_instance: unknown, state: DurableObjectState) => {
    migrate(state.storage);
    const db = storageDriver(state.storage);
    const rpc: Rpc = (name, args = {}, parts = {}) => callRpc(db, name, { p_user_id: user, ...args }, undefined, { parts: normalizeErpParts(parts), identity: { actor, people: [actor] } });
    await check(rpc);
  });
}
const period = { p_period: "hoje", p_from: null, p_to: null };
const off = { sales: false, purchases: false, products: false, stock: false, finance: false, fiscal: false, billing: false, pos: false };

describe("fase 2: respostas reais e contratos de indisponibilidade", () => {
  it("home preserva o DTO completo e diferencia ausência de zero", () => engine(rpc => {
    const full = rpc("erp_home_overview", period);
    expect(homeResponse(full, { args: period })).toEqual(full);
    expect(full).not.toHaveProperty("unavailable_parts");
    expect(full.stock.positions).toBe(0);
    const partial = rpc("erp_home_overview", period, off);
    expect(homeResponse(partial, { args: period })).toEqual(partial);
    expect(partial.stock).toBeNull(); expect(partial.finance).toBeNull(); expect(partial.period.sales).toBeNull();
    expect(partial.period.points.every((point: any) => point.sales_cents === null && point.receivable_cents === null)).toBe(true);
    expect(() => homeResponse({ ...partial, stock: full.stock }, { args: period })).toThrow();
    expect(() => homeResponse({ ...partial, period: { ...partial.period, payable: full.period.payable } }, { args: period })).toThrow();
    expect(() => homeResponse({ ...partial, finance: undefined }, { args: period })).toThrow();
  }));

  it("metadata inválida e seções disponíveis malformadas continuam recusadas", () => engine(rpc => {
    const full = rpc("erp_home_overview", period);
    for (const unavailable_parts of [[], null, "stock", ["unknown"], ["stock", "stock"], [false], {}]) {
      expect(() => homeResponse({ ...full, unavailable_parts }, { args: period })).toThrow();
      expect(() => catalogResponse({ data_mode: "erp_native", read: [], write: [], unavailable_parts }, {}, { type: "access" })).toThrow();
    }
    const partial = rpc("erp_home_overview", period, { stock: false });
    expect(() => homeResponse({ ...partial, finance: null }, { args: period })).toThrow();
    expect(() => homeResponse({ ...partial, catalog: [] }, { args: period })).toThrow();
    expect(() => homeResponse({ ...partial, period: { ...partial.period, points: [] } }, { args: period })).toThrow();
  }));

  it("painel mensal conserva validações de valores, totais e filtros no modo dividido", () => engine(async rpc => {
    const url = new URL("https://erp.invalid/v1/meu-negocio/mensal?situacoes=verified&de=2026-10-01&ate=2026-10-02");
    const route = await businessRouter.parse(new Request(url), "mensal", url);
    const full = rpc(route.rpc, route.args);
    expect(businessRouter.result(route, route.args, full)).toEqual(parseBusinessPanel(full, route.query));
    const partial = rpc(route.rpc, route.args, { purchases: false, stock: false });
    expect(businessRouter.result(route, route.args, partial)).toEqual(partial);
    expect(partial.indicators.cost).toBeNull(); expect(partial.stock_visible).toBe(false);
    expect(() => businessRouter.result(route, route.args, { ...partial, indicators: { ...partial.indicators, cost: "0.00" } })).toThrow();
    expect(() => businessRouter.result(route, route.args, { ...partial, kpis: { ...partial.kpis, current: { ...partial.kpis.current, orders: -1 } } })).toThrow();
  }));

  it("páginas parciais e favoritos passam pela mesma fronteira da API", () => engine(async rpc => {
    const full = rpc("erp_preferences_page", { p_page: "vendas-vendas" });
    expect(preferencesPageResponse(full, full.page)).toEqual(parsePreferencesPage(full, full.page));
    const partial = rpc("erp_preferences_page", { p_page: full.page }, { finance: false });
    expect(preferencesPageResponse(partial, full.page)).toEqual(partial);
    expect(() => preferencesPageResponse({ ...partial, items: partial.items.slice(1) }, full.page)).toThrow();
    const fav = rpc("erp_home_shortcuts_get", {}, off);
    expect(homeShortcutsResponse(fav, {})).toEqual(fav);
    const route = await parsePreferencesRoute(new Request("https://erp.invalid/v1/preferencias/vendas-vendas"));
    expect(await executePreferencesRoute(route, { userId: user, rpc: (name: string, args: RpcArgs) => rpc(name, args, { finance: false }) })).toEqual(partial);
    const charts = await parsePreferencesRoute(new Request("https://erp.invalid/v1/sistema/graficos-inicio"));
    expect((await executePreferencesRoute(charts, { userId: user, rpc: (name: string, args: RpcArgs) => rpc(name, args, off) })).available).toEqual(["resumo"]);
  }));

  it("documento mantém flags históricas e valida a indisponibilidade declarada", () => engine(rpc => {
    const contact = rpc("erp_catalog_save", { p_entity: "contacts", p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_data: { name: "Cliente" } }).record;
    const saved = rpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: crypto.randomUUID(), p_body: { date: "2026-10-01", contact_id: contact.id, items: [{ description: "Serviço", unit: "UN", quantity: "1", unit_price: "10" }] } });
    const route = { kind: "sales_orders", id: saved.document.id }, operation = { type: "document", rpc: "erp_document_get" };
    const full = rpc("erp_document_get", { p_kind: route.kind, p_id: route.id });
    const parsed = documentsResponse(full, route, operation);
    expect(parsed.document.effect_flags).toEqual(full.document.effect_flags);
    const split = { ...full, unavailable_parts: ["finance"], document: { ...full.document, effect_flags: { ...full.document.effect_flags, finance_active: true } } };
    // A flag histórica não é convertida em false pelo parser.
    expect(documentsResponse(split, route, operation).document.effect_flags.finance_active).toBe(true);
    expect(() => documentsResponse({ ...split, document: { ...split.document, items: null } }, route, operation)).toThrow();
  }));
});
