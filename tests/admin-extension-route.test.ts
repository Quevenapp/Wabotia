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
  it.each(
    [
      ["juridico", "prazos-juridicos"],
      ["condominio", "condominio"],
      ["saude", "prontuarios"],
      ["ensino", "ensino"],
    ].flatMap(([page, slug]) =>
      [false, true].map((mobile) => ({ page, slug, mobile })),
    ),
  )(
    "$page espera status na casa, inclusive pelo alias (mobile=$mobile)",
    ({ page, slug, mobile }) => {
      for (const prefix of ["/app/gestao/", "/app/erp/modulos/"]) {
        // A casca real observa o viewport na renderização e no efeito. O teste
        // controla essa borda do navegador sem substituir a casca ou seus efeitos.
        const viewport = {
          matches: mobile,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
        const matchMedia = vi.fn(() => viewport);
        vi.stubGlobal("window", { matchMedia });
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
          root: "v1/profiles/area",
          identityKey: "area:pessoa",
          contextGeneration: 1,
          demo: true,
          me: { id: "pessoa", role: "admin", access: null },
          isAdmin: true,
          statusLoaded: false,
          status: {},
          settings: {},
          modules: undefined,
          api: vi.fn(),
          onEvents: vi.fn(() => () => {}),
        };
        runtime.effects = [];
        runtime.navigate.mockClear();
        runtime.native.mockClear();
        runtime.ported.mockClear();
        const html = renderToStaticMarkup(React.createElement(ErpArea));
        const cleanups = runtime.effects.map((effect) => effect());
        try {
          expect(html).toMatch(/abrindo|carregando|role="status"/i);
          expect(runtime.navigate).not.toHaveBeenCalled();
          expect(runtime.native).not.toHaveBeenCalled();
          expect(runtime.ported).not.toHaveBeenCalled();
          expect(runtime.app.api).not.toHaveBeenCalled();
          expect(location.href).toBe(url.href);
          expect(canOpenPage(page, "admin", undefined, null)).toBe(false);
          expect(canOpenPage(page, "admin", { [page]: true }, null)).toBe(true);
          expect(canOpenPage(page, "admin", { [page]: false }, null)).toBe(
            false,
          );
          expect(matchMedia).toHaveBeenCalledWith("(max-width: 759px)");
          expect(viewport.addEventListener).toHaveBeenCalledTimes(1);
          expect(viewport.addEventListener).toHaveBeenCalledWith(
            "change",
            expect.any(Function),
          );
        } finally {
          cleanups.forEach((cleanup) => {
            if (typeof cleanup === "function") cleanup();
          });
        }
        expect(viewport.removeEventListener).toHaveBeenCalledTimes(1);
        expect(viewport.removeEventListener).toHaveBeenCalledWith(
          ...viewport.addEventListener.mock.calls[0],
        );
      }
    },
  );

  it("página inexistente fica na casa com caminho próprio para o estado não encontrado", () => {
    expect(parseRoute("/app/erp/modulos/nao-existe")).toEqual({
      area: "erp",
      nativePath: "/modulos/nao-existe",
    });
    expect(canOpenPage("nao-existe", "admin", undefined, null)).toBe(false);
  });
});
