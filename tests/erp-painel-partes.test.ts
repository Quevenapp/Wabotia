import React from "react";
import { renderToReadableStream } from "react-dom/server";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Disposable, ErpHostContext } from "../web/management/host-contract";
import type { AppState } from "../web/app/AppContext";
import { perform } from "../src/service";
import { moduleById } from "../src/modules/registry";
import { uid } from "../src/types";
import { fixture } from "./service-center-fixture";

// Painel do ERP com partes desligadas e navegação sem reconferir o acesso.
// Hospedeiro e controlador reais; só o transporte (fetch) e as bordas do navegador são simulados.
const surface = vi.hoisted(() => ({ app: {} as AppState }));
vi.mock("../web/app/AppContext", () => ({
  useApp: () => surface.app,
  ManagementRequestBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../web/erp/fetch-port", async original => ({
  ...await original<typeof import("../web/erp/fetch-port")>(), erpSimulated: () => false,
}));
const actor = "00000000-0000-4000-8000-000000000001";
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const cleanups: Disposable[] = [];
const own = <T extends Disposable>(value: T): T => { cleanups.push(value); return value; };
let registry: typeof import("../web/management/registry");
let calls: string[];
let pending: { resolve(value: Response): void; signal?: AbortSignal } | null;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("location", new URL("https://panel.test/app/erp/cadastros-reais?cadastro=contacts"));
  vi.stubGlobal("window", Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  calls = []; pending = null;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://panel.test");
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    calls.push(url.pathname.replace(/^.*\/erp(?=\/v1\/)/, ""));
    if (url.pathname.endsWith("/v1/me")) return Response.json({ user_id: actor, role: "admin", resources: ["contacts", "products"], data_mode: "staging_readonly" });
    if (url.pathname.endsWith("/v1/sistema/permissoes")) return Response.json({ scope: "access_permissions", data_mode: "erp_native", user_id: actor, role: "admin", user_type: "normal", permissions: null, access: { open: true, until: null } });
    if (url.pathname.endsWith("/v1/cadastros/contatos")) {
      const gate = deferred<Response>();
      pending = { resolve: gate.resolve, signal: signal ?? undefined };
      return gate.promise;
    }
    throw new Error("Leitura inesperada: " + url.pathname);
  }));
  registry = await import("../web/management/registry");
});
afterEach(() => { cleanups.splice(0).reverse().forEach(value => value.dispose()); vi.unstubAllGlobals(); });

const host = (modules: Record<string, boolean> = { erp: true }): ErpHostContext => ({
  profile: "area-a", actor, demo: false, suspended: false,
  management: registry.managementContext({ statusLoaded: true, modules, role: "admin", access: null }),
  onModules: vi.fn(), onPeople: vi.fn(), onLeave: vi.fn(), onExpired: vi.fn(),
});
const count = (path: string) => calls.filter(call => call === path).length;

describe("navegar dentro do ERP não reconfere o acesso", () => {
  it("duas telas permitidas: sem setSuspended, sem cancelar o pedido em andamento e sem refazer /v1/me nem /v1/sistema/permissoes", async () => {
    const { acquireErpHost } = await import("../web/erp/host-runtime");
    const { createHostRouter } = await import("../web/erp/mount");
    const lease = own(acquireErpHost(host()));
    const runtime = await lease.ready;
    await vi.waitFor(() => expect(runtime.controller.getSnapshot().phase).toBe("ready"));
    runtime.controller.verifyPermissions();
    await vi.waitFor(() => expect(runtime.controller.getSnapshot().permissions?.phase).toBe("ready"));
    expect(count("/v1/me")).toBe(1); expect(count("/v1/sistema/permissoes")).toBe(1);
    const suspend = vi.spyOn(runtime.controller, "setSuspended");
    const retry = vi.spyOn(runtime.controller, "retry");
    const permissions = runtime.controller.getSnapshot().permissions;

    const list = runtime.controller.catalog("/v1/cadastros/contatos");
    await vi.waitFor(() => expect(pending).not.toBeNull());
    const hosted = createHostRouter(runtime, location.pathname + location.search, () => ({ publish() {}, dispose() {} }));
    own(hosted);
    for (const to of ["/vendedores-empresa", "/funcionarios-empresa", "/visao-geral", "/cadastros-reais?cadastro=contacts"]) {
      await hosted.router.navigate(to);
      // A casca entrega um contexto novo a cada renderização, com os mesmos valores.
      lease.update(host());
      await tick();
    }
    expect(hosted.router.state.location.pathname).toBe("/app/erp/cadastros-reais");
    expect(suspend).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(pending!.signal?.aborted).toBe(false);
    expect(count("/v1/me")).toBe(1); expect(count("/v1/sistema/permissoes")).toBe(1);
    expect(runtime.controller.getSnapshot().permissions).toBe(permissions);
    expect(runtime.controller.getSnapshot().permissionMessage ?? null).toBeNull();
    pending!.resolve(Response.json({ items: [] }));
    await expect(list).resolves.toEqual({ items: [] });
  });

  it("a conferência das permissões finas na primeira entrada não cancela a leitura da tela (Clientes, Dashboard, Consulta de exclusões)", async () => {
    const { acquireErpHost } = await import("../web/erp/host-runtime");
    const lease = own(acquireErpHost(host()));
    const runtime = await lease.ready;
    await vi.waitFor(() => expect(runtime.controller.getSnapshot().phase).toBe("ready"));
    const list = runtime.controller.catalog("/v1/cadastros/contatos");
    await vi.waitFor(() => expect(pending).not.toBeNull());
    // HostTree pede as permissões finas logo depois de montar a tela.
    await runtime.controller.verifyPermissions();
    expect(runtime.controller.getSnapshot().permissions?.phase).toBe("ready");
    expect(pending!.signal?.aborted).toBe(false);
    pending!.resolve(Response.json({ items: [] }));
    await expect(list).resolves.toEqual({ items: [] });
  });

  it("troca de partes continua reconferindo (o atalho não vale fora da navegação)", async () => {
    const { acquireErpHost } = await import("../web/erp/host-runtime");
    const lease = own(acquireErpHost(host()));
    const runtime = await lease.ready;
    await vi.waitFor(() => expect(runtime.controller.getSnapshot().phase).toBe("ready"));
    const suspend = vi.spyOn(runtime.controller, "setSuspended");
    lease.update(host({ erp: true, "erp-produtos": true }));
    expect(suspend).toHaveBeenCalled();
    await vi.waitFor(() => expect(count("/v1/me")).toBe(2));
  });
});

describe("só a base ligada: menu", () => {
  const visible = (modules: Record<string, boolean>) =>
    registry.resolveManagement(registry.MANAGEMENT_ITEMS, registry.managementContext({ statusLoaded: true, modules, role: "admin", access: null }));
  it("não traz o grupo Financeiro nem Manutenção de efeitos; a rota de Formas de pagamento continua servida", async () => {
    const items = visible({ erp: true });
    expect(items.some(item => item.group === "financeiro")).toBe(false);
    expect(items.some(item => item.id === "erp.payment-methods")).toBe(false);
    expect(items.some(item => item.id === "erp.effect-maintenance")).toBe(false);
    for (const id of ["erp.overview", "erp.customers", "erp.sellers", "erp.employees", "erp.suppliers", "erp.activity", "erp.deletions", "erp.receive-bling"])
      expect(items.some(item => item.id === id), id).toBe(true);
    const { portedTargetState } = await import("../web/management/ported-policy");
    const base = registry.managementContext({ statusLoaded: true, modules: { erp: true }, role: "admin", access: null });
    expect(portedTargetState("/formas-pagamento-empresa", base)).toBe("allowed");
    expect(portedTargetState("/manutencao-efeitos", base)).toBe("allowed");
    expect(portedTargetState("/receber-bling", base)).toBe("allowed");
  });
  it("Formas de pagamento volta com Vendas, Financeiro ou Caixa / PDV; Manutenção de efeitos com Estoque ou Financeiro", () => {
    const has = (modules: Record<string, boolean>, id: string) => visible(modules).some(item => item.id === id);
    expect(has({ erp: true, "erp-produtos": true, "erp-vendas": true }, "erp.payment-methods")).toBe(true);
    expect(has({ erp: true, "erp-financeiro": true }, "erp.payment-methods")).toBe(true);
    expect(has({ erp: true, "erp-produtos": true }, "erp.payment-methods")).toBe(false);
    expect(has({ erp: true, "erp-produtos": true, "erp-estoque": true }, "erp.effect-maintenance")).toBe(true);
    expect(has({ erp: true, "erp-financeiro": true }, "erp.effect-maintenance")).toBe(true);
    expect(has({ erp: true, "erp-produtos": true, "erp-vendas": true }, "erp.effect-maintenance")).toBe(false);
  });
});

describe("só a base ligada: tela de parte desligada pelo endereço", () => {
  async function markup(path: string, modules: Record<string, boolean>) {
    const entries = [{ url: path, state: null as unknown }];
    const go = (url: string) => vi.stubGlobal("location", new URL(url, "https://panel.test"));
    go(path);
    vi.stubGlobal("history", {
      get state() { return entries[0].state; }, get length() { return entries.length; },
      pushState: (state: unknown, _: string, url: string) => { entries[0] = { state, url }; go(url); },
      replaceState: (state: unknown, _: string, url: string) => { entries[0] = { state, url }; go(url); },
      go() {},
    });
    surface.app = { profile: "area-a", root: "v1/profiles/area-a", identityKey: "a", contextGeneration: 1,
      statusLoaded: true, modules, settings: {}, status: {}, me: { id: actor, role: "admin", access: null }, isAdmin: true, demo: false,
      api: vi.fn(async () => ({})), onEvents: () => () => {}, refresh: vi.fn(async () => {}), reloadSession: vi.fn(async () => {}),
    } as unknown as AppState;
    const area = await import("../web/erp/ErpArea");
    const stream = await renderToReadableStream(React.createElement("div", null, React.createElement(area.ErpArea)));
    const html = new Response(stream).text(); await stream.allReady; return html;
  }
  it("diz qual módulo falta, de quem ele depende e onde ligar", async () => {
    const products = await markup("/app/erp/cadastros-reais?cadastro=products", { erp: true });
    expect(products).toContain("Esta tela faz parte de Produtos e serviços, que está desligado. Ligue em Gestão → Módulos.");
    expect(products).not.toContain("Não foi possível concluir a operação");
    vi.resetModules();
    const sales = await markup("/app/erp/documentos-empresa?tipo=sales_orders", { erp: true });
    expect(sales).toContain("Esta tela faz parte de Vendas, que está desligado. Ligue em Gestão → Módulos.");
    expect(sales).toContain("Vendas depende de Produtos e serviços: ligue os dois.");
  });
  it("a frase usa os nomes de src/erp/parts.ts, inclusive quando a própria parte está ligada e falta outra", async () => {
    const { partOffMessage } = await import("../web/erp/modules");
    expect(partOffMessage("/frente-caixa-empresa", { erp: true, "erp-produtos": true })).toBe(
      "Esta tela faz parte de Caixa / PDV, que está desligado. Ligue em Gestão → Módulos. Caixa / PDV depende de Vendas, Estoque e Financeiro: ligue todos.");
    expect(partOffMessage("/meu-negocio?painel=margem-pedido", { erp: true, "erp-produtos": true, "erp-vendas": true })).toBe(
      "Esta tela também precisa de Compras e Estoque, que estão desligados. Ligue em Gestão → Módulos.");
    expect(partOffMessage("/cadastros-reais?cadastro=contacts", { erp: true })).toBeNull();
  });
});

describe("Cadastros e as mensagens de dependência do servidor", () => {
  it("o módulo erp se chama Cadastros e diz o que tem; o identificador não muda", async () => {
    const base = moduleById("erp")!;
    expect(base.id).toBe("erp");
    expect(base.name).toBe("Cadastros");
    expect(base.description).toBe("Clientes, fornecedores, vendedores, funcionários, contatos, dados da empresa e configurações comuns da área.");
    const { ERP_BLOCK_LABELS } = await import("../web/erp/blocks");
    expect(ERP_BLOCK_LABELS.erp).toBe("Cadastros");
  });
  const set = (f: any, id: string, enabled: boolean, extra: Record<string, unknown> = {}) =>
    perform(env, f.admin, f.profile, "module.set", { id, enabled, ...extra }, uid());
  it("faltando dois módulos, a recusa diz os dois em palavras", async () => {
    const f = await fixture();
    await set(f, "erp", true);
    await expect(set(f, "erp-pdv", true)).rejects.toMatchObject({
      status: 409, code: "module_requires",
      message: "Caixa / PDV depende de Vendas, Financeiro e Estoque. Ligue esses módulos antes.",
    });
  });
  it("desligar com dependentes diz quem sai junto, de quem depende e que os dados ficam", async () => {
    const f = await fixture();
    for (const id of ["erp", "erp-produtos", "erp-vendas"]) await set(f, id, true);
    await expect(set(f, "erp-produtos", false)).rejects.toMatchObject({
      status: 409, code: "module_required",
      message: "Vendas depende de Produtos e serviços e será desligado junto. Os dados dele continuam guardados. Confirme a lista de dependentes.",
    });
    const result = await set(f, "erp-produtos", false, { cascade: true, confirmed_dependents: ["erp-vendas"] });
    expect(result).toMatchObject({ enabled: false, also_disabled: ["erp-vendas"] });
  });
});
