import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkPage } from "../web/modules/os/work/WorkListPage";
import { parseRoute, type Route } from "../web/lib/routes";

const state = vi.hoisted(() => ({ route: {} as Route, data: undefined as any, settings: {} as any }));
vi.mock("../web/app/AppContext", () => ({
  useApp: () => ({ root: "v1/profiles/demo", profile: "demo", status: {}, settings: state.settings }),
}));
vi.mock("../web/lib/routes", async original => ({
  ...await original<typeof import("../web/lib/routes")>(), useRoute: () => state.route,
}));
vi.mock("../web/modules/os/work-hooks", () => ({
  useWorkApi: () => ({ types: vi.fn() }),
  useWorkResource: () => ({ data: state.data, loading: false }),
  ResourceState: () => React.createElement("p", null, "Carregando catálogo"),
  instantLabel: () => "",
}));
vi.mock("../web/modules/os/ServiceOrdersPage", () => ({
  ServiceOrdersPage: () => React.createElement("p", null, "Tela clássica de ordens de serviço"),
}));
vi.mock("../web/modules/os/work/WorkDetailPage", () => ({
  WorkDetailPage: ({ workId }: { workId: string }) => React.createElement("p", null, "Registro " + workId),
}));
vi.mock("../web/modules/os/work/WorkFormDialog", () => ({ WorkFormDialog: () => null }));

beforeEach(() => {
  vi.stubGlobal("location", new URL("https://painel.test/app?demo=1"));
  state.settings = {};
  state.data = undefined;
  state.route = parseRoute("/app/gestao/ordens-de-servico");
});
afterEach(() => vi.unstubAllGlobals());
const render = () => renderToStaticMarkup(React.createElement(WorkPage));

it("a URL antiga abre a tela clássica ao resolver work sem tipo nem registro", () => {
  expect(state.route).toMatchObject({ area: "erp", page: "work" });
  expect(state.route.typeId).toBeUndefined();
  expect(state.route.id).toBeUndefined();
  expect(render()).toContain("Tela clássica de ordens de serviço");
  state.data = { data: [{ id: "service_order", kind: "builtin" }] };
  expect(render()).toContain("Tela clássica de ordens de serviço");
});

it.each([{}, { data: null }, { data: {} }])("catálogo sem lista %j conta como vazio", data => {
  state.data = data;
  expect(render()).toContain("Tela clássica de ordens de serviço");
  state.route = { area: "erp", page: "work", typeId: "missing" };
  expect(render()).toContain("Tipo não disponível");
  state.route = { area: "erp", page: "work", id: "existing" };
  expect(render()).toContain("Registro existing");
});
