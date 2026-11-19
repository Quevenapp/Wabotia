import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../web/lib/routes";
import type { ManagementRouterBridge } from "../src/modules/panel-contract";
import {
  canonicalManagementUrl,
  isNativeManagementPage,
} from "../web/management/routes";
import { NATIVE_MANAGEMENT_ITEMS } from "../src/modules/panel-navigation";
import {
  areaOfPage,
  railPages,
  workspaceGroups,
} from "../web/workspace-navigation";

const aliases = [
  ["agenda", "agenda", "agenda"],
  ["servicos-e-horarios", "servicos-e-horarios", "agenda-settings"],
  ["mensalidades", "mensalidades", "mensalidades"],
  ["mensalidade", "mensalidade", "mensalidade-settings"],
  ["pedidos", "pedidos", "pedidos"],
  ["cardapio-e-loja", "cardapio-e-loja", "pedidos-cardapio"],
  ["mesas", "mesas", "mesas"],
  ["reservas", "reservas", "reserva"],
  ["unidades-e-regras", "unidades-e-regras", "reserva-settings"],
  ["suporte-pago", "suporte-pago", "suporte"],
  ["regras-do-suporte", "regras-do-suporte", "suporte-settings"],
  ["condominio", "condominio", "condominio"],
  ["prazos-juridicos", "prazos-juridicos", "juridico"],
  ["prontuarios", "prontuarios", "saude"],
  ["ensino", "ensino", "ensino"],
  ["trabalhos", "trabalhos", "work"],
  ["trabalhos/projeto", "trabalhos/projeto", "work"],
  ["trabalhos/projeto/id%2F1", "trabalhos/projeto/id%2F1", "work"],
  ["ordens-de-servico", "trabalhos", "work"],
  ["meus-prazos", "meus-prazos", "my-deadlines"],
  ["meus-prazos/projeto", "meus-prazos/projeto", "my-deadlines"],
  ["tipos-de-trabalho", "tipos-de-trabalho", "work-types"],
  ["tipos-de-trabalho/projeto", "tipos-de-trabalho/projeto", "work-types"],
  ["ordem-de-servico", "ordem-de-servico", "service-orders-settings"],
  ["formularios", "formularios", "forms"],
  ["cobranca", "cobranca", "payments"],
] as const;

/** Histórico assíncrono: go muda a posição e emite popstate, sem chamar o roteador diretamente. */
function browser(initial: string) {
  const events = new EventTarget();
  const entries = [{ url: initial, state: null as any }];
  let position = 0;
  const locate = () =>
    vi.stubGlobal(
      "location",
      new URL(entries[position].url, "https://panel.example"),
    );
  const history = {
    get state() {
      return entries[position].state;
    },
    get length() {
      return entries.length;
    },
    pushState: vi.fn((state: any, _: string, url: string) => {
      entries.splice(++position, entries.length, { state, url });
      locate();
    }),
    replaceState: vi.fn((state: any, _: string, url: string) => {
      entries[position] = { state, url };
      locate();
    }),
    go: vi.fn((delta: number) => {
      queueMicrotask(() => {
        const next = position + delta;
        if (next < 0 || next >= entries.length || next === position) return;
        position = next;
        locate();
        events.dispatchEvent(new Event("popstate"));
      });
    }),
  };
  vi.stubGlobal("window", events);
  vi.stubGlobal("history", history);
  locate();
  return { history, entries, position: () => position };
}
const settle = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
let routes: typeof import("../web/lib/routes");
let web: ReturnType<typeof browser>;
beforeEach(async () => {
  vi.resetModules();
  web = browser("/app/conversas");
  routes = await import("../web/lib/routes");
});
afterEach(() => vi.unstubAllGlobals());
const parse = (to: string) => {
  const url = new URL(to, "https://panel.example");
  return routes.parseRoute(url.pathname, url.search, url.hash);
};

// A ponte falsa só publica se a guarda local aceitar. Resolver sem publish significa cancelar.
function ported(accept = true) {
  let allowed = accept;
  let publication: ReturnType<typeof routes.bindManagementRouter>;
  const bridge: ManagementRouterBridge = {
    navigate: vi.fn(async (to, options) => {
      if (allowed)
        publication.publish(to, options?.replace ? "replace" : "push");
    }),
    dispose: vi.fn(),
  };
  publication = routes.bindManagementRouter(bridge);
  return {
    bridge,
    publication,
    allow(value: boolean) {
      allowed = value;
    },
  };
}

describe("endereços canônicos da casa", () => {
  it.each(aliases)(
    "%s conserva consulta, fragmento e detalhes",
    (old, canonical, page) => {
      const suffix =
        "?x=%2f&x=2&aba=tarefas&q=a%20b&q=outro&demo=1&pair=p%2B1#se%C3%A7%C3%A3o";
      const input = new URL("https://panel.example/app/gestao/" + old + suffix);
      const result = canonicalManagementUrl(input)!;
      expect(result).not.toBe(input);
      expect(result.href).toBe(
        "https://panel.example/app/erp/modulos/" + canonical + suffix,
      );
      expect(input.pathname).toBe("/app/gestao/" + old);
      const route = routes.parseRoute(input.pathname, input.search, input.hash);
      expect(route).toMatchObject({ area: "erp", page });
      expect(routes.href(route)).toBe(result.pathname + suffix);
      expect(routes.sameRoute(route, parse(routes.href(route)))).toBe(true);
    },
  );

  it("cobre todas as contribuições e retira atalhos operacionais de Gestão e do trilho", () => {
    for (const item of Object.values(NATIVE_MANAGEMENT_ITEMS).flat()) {
      const page = item.target.page;
      expect(isNativeManagementPage(page)).toBe(true);
      expect(areaOfPage(page)).toBe("erp");
      expect(routes.pageRoute(page)).toEqual({ area: "erp", page });
      expect(
        workspaceGroups.flatMap((group) => [...group.pages]),
      ).not.toContain(page);
    }
    expect(railPages).toEqual([]);
    expect(areaOfPage("service-orders")).toBe("erp");
    expect(routes.pageRoute("service-orders")).toEqual({
      area: "erp",
      page: "work",
    });
    expect(routes.pageRoute("queue-settings")).toEqual({
      area: "admin",
      page: "queue-settings",
    });
    expect(routes.pageRoute("area-templates")).toEqual({
      area: "admin",
      page: "area-templates",
    });
  });

  it("normaliza objetos antigos sem alterar componentes de trabalho", () => {
    const old: Route = {
      area: "admin",
      page: "work",
      typeId: "obra/ç",
      id: "x?#%",
      tab: "pessoas",
    };
    expect(routes.href(old)).toBe(
      "/app/erp/modulos/trabalhos/obra%2F%C3%A7/x%3F%23%25?aba=pessoas",
    );
    expect(routes.sameRoute(old, parse(routes.href(old)))).toBe(true);
    routes.navigate(old);
    expect(routes.currentRoute()).toMatchObject({ ...old, area: "erp" });
    expect(routes.href({ area: "admin", page: "service-orders" })).toBe(
      "/app/erp/modulos/trabalhos",
    );
  });

  it("altera filtros conhecidos preservando parâmetros desconhecidos e repetidos", () => {
    const route = parse(
      "/app/gestao/trabalhos/a/b?x=%2f&&x=2&aba=itens&q=a%20b&q=c&state=open#fim",
    );
    expect(routes.href(route)).toBe(
      "/app/erp/modulos/trabalhos/a/b?x=%2f&&x=2&aba=itens&q=a%20b&q=c&state=open#fim",
    );
    const next = {
      ...route,
      tab: "pessoas",
      filters: { ...route.filters, q: "nova busca", state: "" },
    };
    expect(routes.href(next)).toBe(
      "/app/erp/modulos/trabalhos/a/b?x=%2f&&x=2&aba=pessoas&q=nova+busca#fim",
    );
    expect(
      routes.sameRoute(route, { ...route, search: route.search + "&extra=1" }),
    ).toBe(false);
    expect(routes.sameRoute(route, { ...route, hash: "#outro" })).toBe(false);
    expect(
      routes.sameRoute(parse("/app/erp/clientes"), parse("/app/erp/produtos")),
    ).toBe(false);
  });

  it("preserva demo/pair sem herdar filtros para outro destino", () => {
    vi.stubGlobal(
      "location",
      new URL(
        "https://panel.example/app/erp/modulos/trabalhos?demo=1&pair=teste&q=velho#velho",
      ),
    );
    expect(routes.href(routes.pageRoute("pedidos"))).toBe(
      "/app/erp/modulos/pedidos?demo=1&pair=teste",
    );
    expect(
      routes.href({
        area: "erp",
        erpPath: "/clientes",
        search: "?demo=0&extra=a&extra=b",
        hash: "#novo",
      }),
    ).toBe("/app/erp/clientes?demo=0&extra=a&extra=b&pair=teste#novo");
    expect(routes.parseRoute("/", "?pair=convite")).toMatchObject({
      area: "admin",
      page: "applications",
    });
  });

  it("distingue entrada, portado, nativo desconhecido e configuração nativa de OS", () => {
    expect(parse("/app/erp")).toEqual({ area: "erp" });
    expect(parse("/app/erp/modulos/inexistente/a?x=1#fim")).toEqual({
      area: "erp",
      nativePath: "/modulos/inexistente/a",
      search: "?x=1",
      hash: "#fim",
    });
    expect(routes.href(parse("/app/erp/modulos"))).toBe("/app/erp/modulos");
    expect(
      parse("/app/erp/documentos-empresa?tipo=service_orders#novo"),
    ).toEqual({
      area: "erp",
      erpPath: "/documentos-empresa",
      search: "?tipo=service_orders",
      hash: "#novo",
    });
    expect(parse("/app/erp/modulos/ordem-de-servico").page).toBe(
      "service-orders-settings",
    );
    expect(parse("/app/erp/modulos/agenda/detalhe").nativePath).toBe(
      "/modulos/agenda/detalhe",
    );
    expect(isNativeManagementPage("toString")).toBe(false);
    expect(isNativeManagementPage("unknown")).toBe(false);
    expect(
      canonicalManagementUrl(
        new URL("https://panel.example/app/gestao/modulos"),
      ),
    ).toBeNull();
    expect(
      canonicalManagementUrl(new URL("https://panel.example/app/erp-outro")),
    ).toBeNull();
    const canonical = new URL(
      "https://panel.example/app/erp/clientes?a=1&a=2#fim",
    );
    expect(canonicalManagementUrl(canonical)?.href).toBe(canonical.href);
    expect(canonicalManagementUrl(canonical)).not.toBe(canonical);
  });

  it("abre favorito antigo e atualização por replace antes de publicar a primeira rota", async () => {
    web = browser("/app/gestao/condominio?x=1&x=2#inicio");
    expect(routes.currentRoute()).toEqual({
      area: "erp",
      page: "condominio",
      search: "?x=1&x=2",
      hash: "#inicio",
    });
    expect(location.pathname).toBe("/app/erp/modulos/condominio");
    expect(web.history.length).toBe(1);
    expect(web.history.pushState).not.toHaveBeenCalled();
    vi.resetModules();
    routes = await import("../web/lib/routes");
    expect(routes.currentRoute().page).toBe("condominio");
    expect(web.history.length).toBe(1);
  });

  it("links têm URL canônica para nova aba e interceptam somente clique simples", () => {
    const link = routes.linkProps({ area: "admin", page: "agenda" });
    expect(link.href).toBe("/app/erp/modulos/agenda");
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn(),
    };
    link.onClick(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/app/conversas");
    link.onClick({ ...event, ctrlKey: false });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(routes.currentRoute().page).toBe("agenda");
  });
});

describe("ponte em memória e histórico com escritor único", () => {
  it("delega entre portados e confirma só pela ponte; cancelamento não escreve", async () => {
    routes.navigate(parse("/app/erp/clientes"));
    const fake = ported(false),
      blocked = vi.fn();
    routes.setNavigationGuard(() => true);
    routes.onBlocked(blocked);
    expect(routes.navigate(parse("/app/erp/produtos?x=1#fim"))).toBe(true);
    await settle();
    expect(fake.bridge.navigate).toHaveBeenCalledWith(
      "/app/erp/produtos?x=1#fim",
      { replace: false },
    );
    expect(blocked).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/app/erp/clientes");
    fake.allow(true);
    const length = web.history.length;
    routes.navigate(parse("/app/erp/produtos?x=1#fim"));
    await settle();
    expect(web.history.length).toBe(length + 1);
    expect(routes.currentRoute().hash).toBe("#fim");
    fake.publication.publish("/app/erp/produtos?x=1#fim", "push");
    expect(web.history.length).toBe(length + 1);
  });

  it.each(["/app/erp", "/app/erp/modulos/agenda", "/app/gestao/modulos"])(
    "saída para %s mantém tela e aplica force uma única vez",
    (to) => {
      routes.navigate(parse("/app/erp/clientes"));
      const fake = ported(),
        blocked = vi.fn();
      routes.onBlocked(blocked);
      routes.setNavigationGuard(() => true);
      const length = web.history.length;
      expect(routes.navigate(parse(to), { replace: true })).toBe(false);
      expect(routes.currentRoute().erpPath).toBe("/clientes");
      expect(blocked).toHaveBeenCalledOnce();
      routes.navigate(blocked.mock.calls[0][0], { force: true });
      expect(location.pathname).toBe(to);
      expect(web.history.length).toBe(length);
      expect(fake.bridge.navigate).not.toHaveBeenCalled();
    },
  );

  it("entrada no portado passa pela guarda principal", () => {
    routes.navigate(routes.pageRoute("work"));
    const blocked = vi.fn();
    routes.onBlocked(blocked);
    routes.setNavigationGuard(() => true);
    expect(routes.navigate(parse("/app/erp/clientes"))).toBe(false);
    expect(routes.currentRoute().page).toBe("work");
    routes.navigate(blocked.mock.calls[0][0], { force: true });
    expect(routes.currentRoute().erpPath).toBe("/clientes");
  });

  it("Voltar restaura posição, URL e conteúdo até force; Avançar não cria entrada", async () => {
    routes.navigate(routes.pageRoute("agenda"));
    routes.navigate(routes.pageRoute("work"));
    const blocked = vi.fn();
    routes.onBlocked(blocked);
    routes.setNavigationGuard(() => true);
    const length = web.history.length;
    web.history.go(-1);
    await settle();
    expect(blocked).toHaveBeenCalledOnce();
    expect(location.pathname).toBe("/app/erp/modulos/trabalhos");
    expect(web.position()).toBe(2);
    expect(routes.currentRoute().page).toBe("work");
    // Fechar a confirmação não chama navigate: nada muda, inclusive depois de aguardar.
    await settle();
    expect(web.position()).toBe(2);
    web.history.go(-1);
    await settle();
    routes.navigate(blocked.mock.calls[1][0], { force: true });
    await settle();
    expect(web.position()).toBe(1);
    expect(routes.currentRoute().page).toBe("agenda");
    expect(web.history.length).toBe(length);
    routes.setNavigationGuard(null);
    web.history.go(1);
    await settle();
    expect(web.position()).toBe(2);
    expect(routes.currentRoute().page).toBe("work");
    expect(web.history.length).toBe(length);
  });

  it("Voltar/Avançar portado usa publish como aceitação do deslocamento, sem push extra", async () => {
    routes.navigate(parse("/app/erp/clientes"));
    routes.navigate(parse("/app/erp/produtos"));
    const fake = ported(false),
      blocked = vi.fn();
    routes.setNavigationGuard(() => true);
    routes.onBlocked(blocked);
    const length = web.history.length;
    web.history.go(-1);
    await settle();
    expect(routes.currentRoute().erpPath).toBe("/produtos");
    expect(web.position()).toBe(2);
    expect(blocked).not.toHaveBeenCalled();
    fake.allow(true);
    web.history.go(-1);
    await settle();
    expect(routes.currentRoute().erpPath).toBe("/clientes");
    expect(web.position()).toBe(1);
    expect(web.history.length).toBe(length);
    web.history.go(1);
    await settle();
    expect(routes.currentRoute().erpPath).toBe("/produtos");
    expect(web.position()).toBe(2);
    expect(web.history.length).toBe(length);
  });

  it("mantém a rota e a posição enquanto a confirmação portada está pendente", async () => {
    routes.navigate(parse("/app/erp/clientes"));
    routes.navigate(parse("/app/erp/produtos"));
    let finish!: () => void;
    const bridge = {
      navigate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      dispose: vi.fn(),
    };
    const connection = routes.bindManagementRouter(bridge);
    web.history.go(-1);
    await settle();
    expect(web.position()).toBe(2);
    expect(location.pathname).toBe("/app/erp/produtos");
    expect(routes.currentRoute().erpPath).toBe("/produtos");
    connection.publish("/app/erp/clientes", "replace");
    finish();
    await settle();
    expect(web.position()).toBe(1);
    expect(routes.currentRoute().erpPath).toBe("/clientes");
    expect(web.history.length).toBe(3);
  });

  it("cancelar Voltar para nativo não impede a navegação interna seguinte", async () => {
    routes.navigate(routes.pageRoute("agenda"));
    routes.navigate(parse("/app/erp/clientes"));
    const fake = ported(),
      blocked = vi.fn();
    routes.onBlocked(blocked);
    routes.setNavigationGuard(() => true);
    web.history.go(-1);
    await settle();
    expect(blocked).toHaveBeenCalledOnce();
    expect(web.position()).toBe(2);
    // O diálogo fecha sem navegar; o próximo pedido aceito nasce no roteador em memória.
    fake.publication.publish("/app/erp/produtos", "push");
    expect(routes.currentRoute().erpPath).toBe("/produtos");
    expect(web.position()).toBe(3);
    expect(web.history.length).toBe(4);
  });

  it("publicações internas preservam demo/pair e snapshots incluem mudanças de fragmento", () => {
    web = browser("/app/erp/clientes?demo=1&pair=p#inicio");
    const fake = ported();
    fake.publication.publish("/app/erp/clientes#detalhe", "replace");
    expect(location.href).toBe(
      "https://panel.example/app/erp/clientes?demo=1&pair=p#detalhe",
    );
    expect(routes.currentRoute().hash).toBe("#detalhe");
    expect(web.history.length).toBe(1);
  });

  it("publicação inicial, conexão descartada e destinos fora do portado não escrevem", async () => {
    routes.navigate(parse("/app/erp/clientes"));
    const old = ported();
    const length = web.history.length;
    old.publication.publish("/app/erp/clientes", "push");
    expect(web.history.length).toBe(length);
    const next = ported();
    old.publication.dispose();
    old.publication.dispose();
    old.publication.publish("/app/erp/antigo", "push");
    next.publication.publish("/app/erp/modulos/agenda", "push");
    next.publication.publish("/app/erp/../gestao/modulos", "push");
    next.publication.publish("https://outro.example/app/erp/clientes", "push");
    expect(web.history.length).toBe(length);
    routes.navigate(parse("/app/erp/produtos"), { replace: true });
    await settle();
    expect(next.bridge.navigate).toHaveBeenCalledOnce();
    expect(old.bridge.navigate).not.toHaveBeenCalled();
    expect(routes.currentRoute().erpPath).toBe("/produtos");
    expect(web.history.length).toBe(length);
    expect(old.bridge.dispose).not.toHaveBeenCalled();
  });

  it("substituir a conexão durante Voltar cancela só a transação da instância antiga", async () => {
    routes.navigate(parse("/app/erp/clientes"));
    routes.navigate(parse("/app/erp/produtos"));
    let finish!: () => void;
    const old = routes.bindManagementRouter({
      navigate: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      dispose: vi.fn(),
    });
    web.history.go(-1);
    await settle();
    const next = ported();
    old.dispose();
    old.publish("/app/erp/clientes", "replace");
    finish();
    await settle();
    expect(web.position()).toBe(2);
    next.publication.publish("/app/erp/estoque", "push");
    expect(routes.currentRoute().erpPath).toBe("/estoque");
    expect(web.position()).toBe(3);
  });

  it("falha técnica e descarte durante a promessa conservam a rota", async () => {
    routes.navigate(parse("/app/erp/clientes"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bridge = {
      navigate: vi.fn(async () => {
        throw new Error("chunk");
      }),
      dispose: vi.fn(),
    };
    const connection = routes.bindManagementRouter(bridge);
    routes.navigate(parse("/app/erp/produtos"));
    await settle();
    expect(routes.currentRoute().erpPath).toBe("/clientes");
    expect(error).toHaveBeenCalledOnce();
    routes.navigate(parse("/app/erp/produtos"));
    connection.dispose();
    await settle();
    expect(bridge.navigate).toHaveBeenCalledOnce();
    connection.publish("/app/erp/produtos", "push");
    expect(routes.currentRoute().erpPath).toBe("/clientes");
    error.mockRestore();
  });
});
