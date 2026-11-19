import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErpArea } from "../web/erp/ErpArea";
import { canOpenPage } from "../web/workspace-navigation";
import { parseRoute } from "../web/lib/routes";

const runtime = vi.hoisted(() => ({
  app: {} as any,
  route: {} as any,
  effects: [] as (() => any)[],
  navigate: vi.fn(),
  native: vi.fn(() => null),
  ported: vi.fn(() => null),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => any) => {
    runtime.effects.push(effect);
  },
}));
vi.mock("../web/app/AppContext", () => ({ useApp: () => runtime.app }));
vi.mock("../web/lib/routes", async (original) => ({
  ...(await original<typeof import("../web/lib/routes")>()),
  useRoute: () => runtime.route,
  navigate: runtime.navigate,
}));
vi.mock("../web/management/pages", () => ({ ManagementPage: runtime.native }));
vi.mock("../web/erp/mount", () => ({ default: runtime.ported }));
afterEach(() => vi.unstubAllGlobals());

// Regressão: favorito/F5 de extensão não pode trocar a URL por Início antes de /status.
describe("ERP: extensões abertas pelo endereço", () => {
  it.each([
    ["juridico", "prazos-juridicos"],
    ["condominio", "condominio"],
    ["saude", "prontuarios"],
    ["ensino", "ensino"],
  ])("%s espera status na casa, inclusive pelo alias", (page, slug) => {
    for (const prefix of ["/app/gestao/", "/app/erp/modulos/"]) {
      const url = new URL(
        "https://panel.example" + prefix + slug + "?desconhecido=1#favorito",
      );
      vi.stubGlobal("location", url);
      runtime.route = parseRoute(url.pathname, url.search, url.hash);
      expect(runtime.route).toMatchObject({
        area: "erp",
        page,
        search: url.search,
        hash: url.hash,
      });
      runtime.app = {
        profile: "area",
        profileName: "Área de atendimento",
        demo: true,
        me: { id: "pessoa", role: "admin", access: null },
        isAdmin: true,
        statusLoaded: false,
        modules: undefined,
        api: vi.fn(),
      };
      runtime.effects = [];
      runtime.navigate.mockClear();
      runtime.native.mockClear();
      runtime.ported.mockClear();
      const html = renderToStaticMarkup(React.createElement(ErpArea));
      const cleanups = runtime.effects.map((effect) => effect());
      expect(html).toMatch(/abrindo|carregando|role="status"/i);
      expect(runtime.navigate).not.toHaveBeenCalled();
      expect(runtime.native).not.toHaveBeenCalled();
      expect(runtime.ported).not.toHaveBeenCalled();
      expect(location.href).toBe(url.href);
      expect(canOpenPage(page, "admin", undefined, null)).toBe(false);
      expect(canOpenPage(page, "admin", { [page]: true }, null)).toBe(true);
      expect(canOpenPage(page, "admin", { [page]: false }, null)).toBe(false);
      cleanups.forEach((cleanup) => {
        if (typeof cleanup === "function") cleanup();
      });
    }
  });

  it("página inexistente fica na casa com caminho próprio para o estado não encontrado", () => {
    expect(parseRoute("/app/erp/modulos/nao-existe")).toEqual({
      area: "erp",
      nativePath: "/modulos/nao-existe",
    });
    expect(canOpenPage("nao-existe", "admin", undefined, null)).toBe(false);
  });
});
