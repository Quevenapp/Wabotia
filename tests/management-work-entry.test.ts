import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkPage } from "../web/modules/os/work/WorkListPage";
import { parseRoute, type Route } from "../web/lib/routes";
import { builtinWorkType } from "../src/modules/os/work-types";

const state = vi.hoisted(() => ({ route: {} as Route, data: undefined as any, settings: {} as any }));
vi.mock("../web/app/AppContext", () => ({
  useApp: () => ({ root: "v1/profiles/demo", profile: "demo", status: {}, settings: state.settings, names: {}, isAdmin: true }),
}));
vi.mock("../web/lib/routes", async original => ({
  ...await original<typeof import("../web/lib/routes")>(), useRoute: () => state.route,
}));
vi.mock("../web/modules/os/work-hooks", () => ({
  useWorkApi: () => ({ types: vi.fn() }),
  useWorkResource: (key: string) => ({ data: key.includes("/list/") ? { data: [], next_cursor: null } : state.data, loading: false, reload: vi.fn() }),
  ResourceState: () => React.createElement("p", null, "Carregando catálogo"),
  instantLabel: () => "",
}));
vi.mock("../web/modules/os/ServiceOrdersPage", () => ({
  OrderForm: () => null,
  OrderDetail: () => React.createElement("p", null, "Detalhe clássico de ordem de serviço"),
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

it("a URL antiga abre a lista única ao resolver work sem tipo nem registro", () => {
  expect(state.route).toMatchObject({ area: "erp", page: "work" });
  expect(state.route.typeId).toBeUndefined();
  expect(state.route.id).toBeUndefined();
  expect(render()).toContain("Carregando catálogo");
  state.data = { data: [builtinWorkType()] };
  expect(render()).toContain("Todos os modelos");
  expect(render()).toContain("Crie um modelo");
});

it.each([{}, { data: null }, { data: {} }])("catálogo sem lista %j permite tentar novamente", data => {
  state.data = data;
  expect(render()).toContain("Catálogo de modelos indisponível");
  state.route = { area: "erp", page: "work", typeId: "missing" };
  expect(render()).toContain("Catálogo de modelos indisponível");
  state.route = { area: "erp", page: "work", id: "existing" };
  expect(render()).toContain("Registro existing");
});
