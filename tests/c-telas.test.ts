import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERP_CORE_TEST_MODULES } from "./erp-module-helper";
import { nanoid } from "nanoid/non-secure";
import picocolors from "picocolors";
import postcssPackage from "postcss/package.json";
import RealPdv from "../web/erp/app/components/RealPdv";
import RealHome from "../web/erp/app/components/RealHome";
import RealDocuments from "../web/erp/app/components/RealDocuments";
import RealFinance from "../web/erp/app/components/RealFinance";
import DocumentList from "../web/erp/app/components/DocumentList";
import { useCatalogList } from "../web/erp/app/components/CatalogList";
import PdvReceiptPrint from "../web/erp/app/components/PdvReceiptPrint";
import { EMPTY_LIST_FILTERS } from "../web/erp/app/lib/document-list-model";
import { erpPublicHref } from "../web/erp/public-url";
import { href } from "../web/lib/routes";
import { setErpPorts } from "../web/erp/ports";
import { installErpTargetAccess, setErpBlocks, targetEnabled } from "../web/erp/blocks";
import { setMotorReal } from "../web/erp/motor";
import { fagooScope, PORTAL_ROOTS, splitSelectors } from "../web/erp/css-scope";
// O executor esvazia imports .css?raw quando CSS está desabilitado. O fragmento
// distingue a leitura de fonte da folha de estilo; o Vite remove #source?raw
// ao ler o mesmo arquivo real, sem copiar CSS nem mudar a configuração da suíte.
import pdvCss from "../web/erp/app/components/real-pdv.css#source?raw";

// O fallback CommonJS do pool Workers aponta dependências browser:false para
// empty-internal.cjs, ausente nesta versão do plugin. Carregamos o PostCSS real
// instalado como texto, respeitando seu mapa browser, sem mockar parser/plugin
// nem exigir uma alteração da configuração compartilhada de testes.
const postcssSources = import.meta.glob<string>("../node_modules/postcss/lib/*.js", { query: "?raw", import: "default", eager: true });
function loadPostcss() {
  const cache = new Map<string, { exports: any }>();
  const dependencies: Record<string, unknown> = { "nanoid/non-secure": { nanoid }, picocolors };
  const browser: Record<string, unknown> = postcssPackage.browser;
  const require = (id: string): any => {
    const name = id.replace(/\.js$/, "");
    if (browser[id] === false || browser[name.replace(/^\.\//, "./lib/")] === false) return {};
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    const source = postcssSources[`../node_modules/postcss/lib/${name.replace(/^\.\//, "")}.js`];
    if (!id.startsWith("./") || source === undefined) throw new Error(`Dependência PostCSS não resolvida: ${id}`);
    let module = cache.get(name);
    if (!module) {
      module = { exports: {} }; cache.set(name, module);
      new Function("module", "exports", "require", source)(module, module.exports, require);
    }
    return module.exports;
  };
  return require("./postcss") as typeof import("postcss").default;
}
const postcss = loadPostcss();

// Mesmo contrato dos testes portados: componentes reais, hooks em memória e
// efeitos/assinaturas reais, sem navegador, rede ou consultas paralelas de acesso.
const runtime = vi.hoisted(() => ({ current: null as any, index: 0, guard: null as any, portals: [] as any[] }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const useState = (initial: any) => {
    const frame = runtime.current, i = runtime.index++;
    if (!(i in frame.slots)) frame.slots[i] = typeof initial === "function" ? initial() : initial;
    return [frame.slots[i], (update: any) => {
      if (!frame.alive) return;
      const next = typeof update === "function" ? update(frame.slots[i]) : update;
      if (!Object.is(next, frame.slots[i])) { frame.slots[i] = next; frame.owner.dirty = true; }
    }];
  };
  const useRef = (value: any) => useState(() => ({ current: value }))[0];
  const changed = (old: any, deps: any[]) => !old || !deps || deps.length !== old.deps?.length || deps.some((v, i) => !Object.is(v, old.deps[i]));
  const useMemo = (fn: () => any, deps: any[]) => {
    const frame = runtime.current, i = runtime.index++;
    if (changed(frame.slots[i], deps)) frame.slots[i] = { value: fn(), deps };
    return frame.slots[i].value;
  };
  const useEffect = (fn: () => any, deps: any[]) => {
    const frame = runtime.current, i = runtime.index++, previous = frame.slots[i];
    if (!changed(previous, deps)) return;
    const slot = frame.slots[i] = { deps, cleanup: previous?.cleanup };
    frame.owner.effects.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
  };
  return { ...actual, useState, useRef, useMemo, useCallback: (fn: any, deps: any[]) => useMemo(() => fn, deps),
    useId: () => useRef(`telas-${runtime.current.path}-${runtime.index}`).current,
    useEffect, useLayoutEffect: useEffect,
    useSyncExternalStore: (subscribe: any, snapshot: any) => {
      const [value, setValue] = useState(snapshot);
      useEffect(() => { const sync = () => setValue(snapshot()); const stop = subscribe(sync); sync(); return stop; }, [subscribe, snapshot]);
      return value;
    },
  };
});
vi.mock("react-router-dom", async original => ({
  ...await original<typeof import("react-router-dom")>(),
  Link: "router-link", useLocation: () => runtime.current.owner.location,
  useNavigate: () => runtime.current.owner.navigate,
}));
vi.mock("react-dom", async original => ({
  ...await original<typeof import("react-dom")>(),
  createPortal: (children: any, container: any) => { runtime.portals.push(container); return children; },
}));
vi.mock("../web/erp/app/hooks/useUnsavedChanges", () => ({
  useUnsavedChanges: () => runtime.guard,
  useUnsavedChangesGuard: () => runtime.guard,
  useUnsavedForm: () => runtime.guard,
}));

const disposers: (() => void)[] = [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join("") : React.isValidElement(value)
  ? text((value.props as any).children) : value == null || typeof value === "boolean" ? "" : String(value);
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : React.isValidElement(tree) ? [tree, ...nodes((tree.props as any).children)] : [];
function mount(Component: any, props: any, path = "/acesso", expand = ["HomeView", "DocumentList", "DocumentListBody", "NativeListLayout", "PdvReceiptSheet"]) {
  const frames = new Map<string, any>();
  const owner: any = { dirty: true, effects: [], location: null, tree: null, disposed: false };
  const locate = (to: string) => { const url = new URL(to, "https://painel.example"); owner.location = { pathname: url.pathname, search: url.search, hash: url.hash, key: to }; };
  owner.navigate = vi.fn((to: string) => { locate(to); owner.dirty = true; });
  locate(path);
  function invoke(fn: any, values: any, key: string) {
    let frame = frames.get(key);
    if (!frame) { frame = { owner, path: key, slots: [], alive: true }; frames.set(key, frame); }
    frame.seen = true;
    const prior = runtime.current, index = runtime.index;
    runtime.current = frame; runtime.index = 0;
    try { return fn(values); } finally { runtime.current = prior; runtime.index = index; }
  }
  function visit(value: any, key: string): any {
    if (Array.isArray(value)) return value.map((child, i) => visit(child, `${key}/${child?.key ?? i}`));
    if (!React.isValidElement(value)) return value;
    const element = value as any;
    if (typeof element.type === "function" && expand.includes(element.type.name)) {
      const nested = `${key}:${element.type.name}:${element.key ?? ""}`;
      return visit(invoke(element.type, element.props, nested), nested + "/render");
    }
    return React.cloneElement(element, {}, visit(element.props.children, key + "/children"));
  }
  const disposeFrame = (frame: any) => { frame.alive = false; for (const slot of frame.slots) slot?.cleanup?.(); };
  const render = () => {
    owner.dirty = false;
    frames.forEach(frame => frame.seen = false);
    owner.tree = visit(invoke(Component, props, "root"), "root/tree");
    for (const [key, frame] of frames) if (!frame.seen) { disposeFrame(frame); frames.delete(key); }
    while (owner.effects.length) owner.effects.shift()();
  };
  const view = {
    async flush() { for (let i = 0; i < 100; i++) { if (owner.dirty) render(); await Promise.resolve(); } expect(owner.dirty, "renderização estabilizou").toBe(false); },
    nodes: () => nodes(owner.tree), text: () => text(owner.tree), navigate: owner.navigate,
    find: (predicate: (node: any) => boolean) => { const node = nodes(owner.tree).find(predicate); expect(node, "controle presente").toBeDefined(); return node; },
    async update(next = {}) { props = { ...props, ...next }; owner.dirty = true; await view.flush(); },
    unmount() { if (owner.disposed) return; owner.disposed = true; frames.forEach(disposeFrame); frames.clear(); },
  };
  disposers.push(view.unmount);
  return view;
}
type View = ReturnType<typeof mount>;
const component = (view: View, name: string) => view.find(n => typeof n.type === "function" && n.type.name === name);
const button = (view: View, label: string) => view.find(n => n.type === "button" && text(n) === label);
const links = (tree: any) => nodes(tree).filter(n => n.type === "router-link").map(n => n.props.to);
const section = (view: View, label: string) => view.find(n => n.props["aria-label"] === label);
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const core = { ...ERP_CORE_TEST_MODULES, "erp-fiscal": false, "erp-cobranca": false, "erp-pdv": false };
const noAnswer = () => new Promise(() => {});
function session(role = "admin", resources = ["contacts", "products", "warehouses"]) {
  let state = { phase: "ready", membership: { user_id: id(1), role, resources } };
  const listeners = new Set<() => void>();
  return { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    publish() { state = { ...state }; listeners.forEach(listener => listener()); } };
}
function embedded(value = true) { setErpPorts({ embedded: value } as any); }

beforeEach(() => {
  runtime.portals = [];
  runtime.guard = { confirmLeave: vi.fn((run: () => void) => run()), store: { runConfirmed: (run: () => void) => run() } };
  vi.stubGlobal("window", { open: vi.fn(), print: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("location", new URL("https://painel.example/app/erp/acesso?demo=1&pair=abc%2Fxyz&q=nao-herdar&tipo=errado#origem"));
  setMotorReal(true); setErpBlocks(null); setErpPorts(null);
});
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); setErpBlocks(null); setMotorReal(false); setErpPorts(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const receipt = { limit_description: false, code: true, notes: false, comments: false, discount: false, footer: "Obrigado", font_size: 12 };
const pdvContext = () => ({ entity: "pos_context", data_mode: "erp_native", today: "2026-10-20", role: "admin",
  permissions: { operate: true, items: true, payments: true, finish: true, edit_price: true, remove_items: true, change_method: true },
  effects: { cash: true, contacts: true, finance: true, fiscal: true, settings: true, stock: true },
  settings: { tables: false, cash_control: false, default_operation: "nenhum", default_method: "nenhum", receipt_order: "insercao", percent_discount: false,
    shortcuts: {}, closing_statuses: ["atendido"], item_discount: true, group_items: true, seller_required: false },
  receipt, stores: [], accounts: [], cash_sessions: [], methods: [], warehouses: [], default_warehouse: null, seller: null, consumer: null, pix: null,
});

describe("A6/R7 — navegação do PDV", () => {
  const controller = () => ({ ...session(), pos: vi.fn(async (path: string) => path === "/v1/frente-caixa" ? pdvContext() : { entity: "pos_sales", items: [], total: 0 }), company: noAnswer });
  it("embutido mantém operações, abas e atalhos sem botão nem gaveta global", async () => {
    embedded();
    const view = mount(RealPdv, { controller: controller() }); await view.flush();
    expect(view.nodes().some(n => n.props["aria-label"] === "Abrir menu" || n.props["aria-label"] === "Menu")).toBe(false);
    expect(view.nodes().filter(n => n.props.role === "tab")).toHaveLength(3);
    expect(section(view, "Teclas de atalho")).toBeDefined();
    section(view, "Operações").props.onClick(); await view.flush();
    for (const label of ["Nova venda", "Finalizar venda", "Sangria", "Suprimento", "Fechar caixa", "Imprimir", "Reimprimir última operação"])
      expect(view.text()).toContain(label);
  });
  it("autônomo usa disponibilidade, recursos e permissões existentes, inclusive ao reabrir", async () => {
    setErpBlocks({ ...core, "erp-pdv": true });
    disposers.push(installErpTargetAccess(to => !to.includes("warehouses") && to !== "/acesso" && !to.startsWith("/preferencias/vendas/frente-caixa")));
    const control = controller();
    const view = mount(RealPdv, { controller: control }); await view.flush();
    section(view, "Abrir menu").props.onClick(); await view.flush();
    const offered = links(section(view, "Menu"));
    expect(offered).toContain("/cadastros-reais?cadastro=products");
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every(targetEnabled)).toBe(true);
    expect(offered.some(to => /cobranca|historico-fiscal|warehouses/.test(to))).toBe(false);
    // A troca para o hospedeiro também oculta uma gaveta já aberta.
    embedded(); await view.update(); expect(view.nodes().some(n => n.props["aria-label"] === "Menu")).toBe(false);
    embedded(false);
    await view.update({ controller: { ...control, ...session("consulta", []) } });
    expect(links(section(view, "Menu"))).not.toContain("/cadastros-reais?cadastro=products");
  });
});

describe("A7 — atalhos do Dashboard", () => {
  it.each(["consulta", "financeiro"])("somente núcleo não oferece Cobrança para %s", async role => {
    setErpBlocks(core);
    const view = mount(RealHome, { controller: { ...session(role), home: noAnswer } }); await view.flush();
    expect(links(section(view, "Outras consultas"))).not.toContain("/cobranca-empresa");
  });
  it("administrador recebe importação válida e a política atualiza a tela pelo controlador", async () => {
    setErpBlocks(core); const control = { ...session(), home: vi.fn(noAnswer), system: vi.fn(noAnswer) };
    const view = mount(RealHome, { controller: control }); await view.flush();
    expect(links(section(view, "Outras consultas"))).toContain("/preferencias/importacoes");
    expect(links(section(view, "Outras consultas"))).not.toContain("/importar-cadastros");
    setErpBlocks({ ...core, "erp-cobranca": true }); control.publish(); await view.flush();
    expect(links(section(view, "Outras consultas"))).toContain("/cobranca-empresa");
    disposers.push(installErpTargetAccess(to => to !== "/cobranca-empresa" && !to.startsWith("/cadastros-reais?cadastro=products")));
    control.publish(); await view.flush();
    expect(links(section(view, "Outras consultas"))).not.toContain("/cobranca-empresa");
    expect(links(section(view, "Ações rápidas")).some(to => to.includes("cadastro=products"))).toBe(false);
    expect(control.home).toHaveBeenCalledTimes(1); expect(control.system).not.toHaveBeenCalled();
  });
});

const row = (n = 10, kind = "sales_orders") => ({ id: id(n), kind, number: String(n), version: 1, status: "open", date: "2026-10-16", total: "10.00",
  contact_id: id(2), contact_name: "Cliente sintético", created_at: "2026-10-16T12:00:00Z", updated_at: "2026-10-16T12:00:00Z",
  expected_date: null, next_contact: null, template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null,
  source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null });
const documentPage = (kind = "sales_orders", rows = [row(10, kind)]) => ({ kind, items: rows, limit: 100, page: 1, order: "date_desc", has_more: false,
  next_cursor: null, total_count: rows.length, total_amount: "10.00", data_mode: "erp_native", operational_effects: false });
const documentsController = (kind = "sales_orders") => ({ ...session(),
  documents: vi.fn(async (path: string) => {
    if (path === "/v1/documentos") return { read: [kind], write: [kind], data_mode: "erp_native" };
    if (path.startsWith(`/v1/documentos/${kind}?`)) return documentPage(kind);
    throw new Error("Leitura auxiliar indisponível neste cenário");
  }), catalog: vi.fn(async () => ({ read: [], write: [], items: [], has_more: false })),
});
const gestures = [{ ctrlKey: true, button: 0 }, { metaKey: true, button: 0 }, { button: 1 }];
const fireRow = (row: any, event: any) => (event.button === 1 ? row.props.onAuxClick : row.props.onClick)({ ...event, target: null, preventDefault() {} });
function opened(path: string, entries: Record<string, string>, hash = "") {
  expect(window.open).toHaveBeenLastCalledWith(expect.any(String), "_blank", "noopener");
  const target = vi.mocked(window.open).mock.calls.at(-1)![0] as string;
  const url = new URL(target, "https://painel.example");
  expect(url.pathname).toBe("/app/erp" + path);
  expect(target.match(/\/app\/erp/g)).toHaveLength(1);
  for (const [key, value] of Object.entries({ ...entries, demo: "1", pair: "abc/xyz" })) expect(url.searchParams.get(key), key).toBe(value);
  expect(url.searchParams.get("q")).not.toBe("nao-herdar"); expect(url.hash).toBe(hash);
  return url;
}

describe("R5 — novas abas nos chamadores", () => {
  it("helper mantém escapes, repetições, fragmento, sessão e modalidade autônoma", () => {
    const target = "/documentos-empresa?tipo=sales_orders&documento=id%2F1&tag=a%20b&tag=a%2Bb#itens%2F2";
    expect(erpPublicHref(target)).toBe(target);
    embedded(); const expected = "/app/erp" + target.replace("#", "&demo=1&pair=abc%2Fxyz#");
    expect(erpPublicHref(target)).toBe(expected);
    expect(erpPublicHref(expected)).toBe(expected);
    expect(erpPublicHref("/app/erp?pair=destino&demo=0#x")).toBe("/app/erp?pair=destino&demo=0#x");
    expect(erpPublicHref("/acesso")).toBe("/app/erp/acesso?demo=1&pair=abc%2Fxyz");
    embedded(false); expect(erpPublicHref(expected)).toBe(expected);
  });
  it("helper segue href da casca sem trazer seus componentes para o ERP autônomo", () => {
    embedded();
    for (const session of ["", "?demo=1&pair=abc%2Fxyz&q=nao-herdar", "?demo=&pair=", "?demo=0&demo=1&pair=a%20b"]) {
      vi.stubGlobal("location", new URL("https://painel.example/app/erp/acesso" + session + "#origem"));
      for (const search of ["", "?q=a%20b&tag=a&tag=b%2Bc", "?pair=destino&demo=0", "?demo=&pair=", "?q=%2F%25", "?q=a&&tag=b&"]) {
        for (const erpPath of ["/", "/acesso", "/documentos-empresa", "/registro%2F1"]) for (const hash of ["", "#itens%2F2"]) {
          const expected = href({ area: "erp", erpPath, search, hash });
          expect(erpPublicHref(erpPath + search + hash)).toBe(expected);
          expect(erpPublicHref("/app/erp" + (erpPath === "/" ? "" : erpPath) + search + hash)).toBe(expected);
        }
      }
    }
    vi.stubGlobal("location", undefined);
    expect(erpPublicHref("/acesso")).toBe("/app/erp/acesso");
  });
  it("RealDocuments captura Ctrl/Cmd e meio, conserva filtros e fragmento e mantém clique comum na guarda", async () => {
    embedded(); const view = mount(RealDocuments, { controller: documentsController(), initialKind: "sales_orders" }, "/documentos-empresa?tipo=sales_orders&q=cliente&tag=a&tag=b#itens"); await view.flush();
    const tr = view.find(n => n.type === "tr" && n.key === id(10));
    for (const event of gestures) {
      fireRow(tr, event);
      const url = opened("/documentos-empresa", { tipo: "sales_orders", documento: id(10), q: "cliente" }, "#itens");
      expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
    }
    expect(runtime.guard.confirmLeave).toHaveBeenCalledTimes(3); expect(view.navigate).not.toHaveBeenCalled();
    runtime.guard.confirmLeave.mockImplementationOnce(() => {});
    fireRow(tr, { button: 0 }); expect(view.navigate).not.toHaveBeenCalled();
    fireRow(tr, { button: 0 }); expect(view.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/documentos-empresa\?/));
    expect(window.open).toHaveBeenCalledTimes(3);
  });
  it("Incluir documento em nova aba também usa a casa; clique comum mantém confirmação", async () => {
    embedded(); const view = mount(RealDocuments, { controller: documentsController(), initialKind: "sales_orders" }, "/documentos-empresa?tipo=sales_orders#itens"); await view.flush();
    const add = view.find(n => n.type === "button" && n.props.className?.includes("documents-primary"));
    for (const event of gestures) { fireRow(add, event); opened("/documentos-empresa", { tipo: "sales_orders", acao: "incluir" }, "#itens"); }
    fireRow(add, { button: 0 }); expect(runtime.guard.confirmLeave).toHaveBeenCalledTimes(1);
  });
  it("useCatalogList captura os três gestos sem tornar recordPath público nem contornar a guarda", async () => {
    embedded(); let list: ReturnType<typeof useCatalogList>;
    const controller = { catalog: vi.fn(async () => ({ read: ["products"], write: ["products"], data_mode: "erp_native" })) };
    const view = mount(() => { list = useCatalogList(controller as any, "products"); return null; }, {}, "/cadastros-reais?cadastro=products&q=caneta&tag=a&tag=b#detalhes"); await view.flush();
    for (const event of gestures) {
      list!.openRow(id(10), event);
      const url = opened("/cadastros-reais", { cadastro: "products", registro: id(10), q: "caneta" }, "#detalhes");
      expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
    }
    expect(list!.recordPath(id(10))).toMatch(/^\/cadastros-reais\?/);
    expect(runtime.guard.confirmLeave).not.toHaveBeenCalled();
    runtime.guard.confirmLeave.mockImplementationOnce(() => {});
    list!.openRow(id(10), {}); expect(view.navigate).not.toHaveBeenCalled();
    list!.openRow(id(10), {}); expect(view.navigate).toHaveBeenCalledWith(list!.recordPath(id(10)));
    expect(window.open).toHaveBeenCalledTimes(3);
  });
  it("RealFinance captura os três gestos com ID, período e fragmento e mantém a abertura comum", async () => {
    embedded();
    const title = { id: id(10), kind: "receivable", version: 1, group_id: id(10), installment: 1, installments: 1, contact_id: id(2), contact_name: "Contato sintético",
      category_id: null, category_name: null, description: "Título sintético", source_reference: null, issued_on: "2026-10-01", due_on: "2026-10-16",
      amount_cents: "101", settled_cents: "0", balance_cents: "101", cancelled: false, status: "open", overdue: false, document_linked: false,
      competence_on: "2026-10-01", account_id: null, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: "2026-10-16", deleted_at: null,
      origin: null, account_name: null, remittance: null, imported: false, payments: { settled_on: null, fee_cents: "0", interest_cents: "0", penalty_cents: "0", discount_cents: "0", settled_by_return: false } };
    const controller = { finance: vi.fn(async (path: string) => {
      if (path === "/v1/financeiro") return { read: true, write: true, data_mode: "erp_native" };
      if (path.startsWith("/v1/financeiro/accounts?")) return { entity: "accounts", items: [], data_mode: "erp_native", limit: 100, has_more: false, next_cursor: null };
      return { entity: "titles", data_mode: "erp_native", kind: "receivable", option: "open", page: 1, limit: 100, order: "due_asc", total: 1,
        totals: { count: 1, amount_cents: "101", balance_cents: "101", fee_cents: "0" }, items: [title] };
    }) };
    const view = mount(RealFinance, { controller, initialTab: "receivable" }, "/financeiro-empresa?area=receivable&from=2026-10-01&to=2026-10-31&q=cliente#parcelas"); await view.flush();
    const tr = view.find(n => n.type === "tr" && n.key === id(10));
    for (const event of gestures) { fireRow(tr, event); opened("/financeiro-empresa", { area: "receivable", titulo: id(10), from: "2026-10-01", to: "2026-10-31", q: "cliente" }, "#parcelas"); }
    expect(view.navigate).not.toHaveBeenCalled(); fireRow(tr, { button: 0 });
    expect(controller.finance).toHaveBeenCalledWith(`/v1/financeiro/titles/${id(10)}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(window.open).toHaveBeenCalledTimes(3);
  });
  // Acabamento do painel: a nota de entrada da compra abre /notas-entrada, que não tem motor; o botão não aparece.
  it("DocumentList: sem motor para /notas-entrada, a compra não oferece Gerar nota fiscal", async () => {
    embedded(); const view = mount(DocumentList, documentListProps("purchase_orders")); await view.flush();
    expect(component(view, "RowMenu").props.items.some((item: any) => item.label === "Gerar nota fiscal")).toBe(false);
  });
  it.each([["sales_orders", "fiscal55", "55"], ["sales_orders", "fiscal65", "65"]])("DocumentList: ação fiscal %s/%s abre a URL pública", async (kind, action, model) => {
    embedded(); const view = mount(DocumentList, documentListProps(kind)); await view.flush();
    const menu = component(view, "RowMenu"); const item = menu.props.items.find((item: any) => item.label === (action === "fiscal65" ? "Gerar NFC-e" : "Gerar nota fiscal"));
    expect(item).toBeDefined(); expect(item.disabled).not.toBe(true); item.onClick();
    const url = opened(kind === "purchase_orders" ? "/notas-entrada" : "/historico-fiscal", { origem: "brufap", nota: "nova", pedido: id(10), ...(model ? { modelo: model } : {}) });
    expect(url.searchParams.has("q")).toBe(false); expect(runtime.guard.confirmLeave).not.toHaveBeenCalled();
  });
  it("DocumentList: agrupamento conserva todos os IDs na aba fiscal", async () => {
    embedded(); const view = mount(DocumentList, documentListProps("service_orders", [row(10, "service_orders"), row(11, "service_orders")])); await view.flush();
    view.find(n => n.type === "input" && n.props["aria-label"] === "Selecionar todos").props.onChange({ target: { checked: true } }); await view.flush();
    const action = button(view, "Gerar nota fiscal agrupando"); expect(action.props.disabled).toBe(false); action.props.onClick();
    opened("/historico-fiscal", { modelo: "55", origem: "brufap", nota: "nova", pedido: `${id(10)},${id(11)}` });
  });
});
function documentListProps(kind: string, rows = [row(10, kind)]) {
  return { controller: documentsController(kind), kind, access: { read: [kind], write: [kind], data_mode: "erp_native" }, writable: true,
    page: documentPage(kind, rows), loading: false, filters: EMPTY_LIST_FILTERS, order: "date_desc", listPage: 1, filterError: "",
    onApply: vi.fn(), onPage: vi.fn(), onOrder: vi.fn(), onReload: vi.fn(), onKind: vi.fn(), onOpen: vi.fn(), onClone: vi.fn(), onConverted: vi.fn(), onNavigate: vi.fn() };
}

describe("R6 — impressão isolada", () => {
  it("CSS transformado só afeta a impressão ativa do PDV e a página de 80 mm é nomeada", async () => {
    expect(() => postcss.parse("a {")).toThrow(/Unclosed block/);
    expect(pdvCss).toContain("@media print");
    const result = await postcss([fagooScope(() => true)]).process(pdvCss, { from: "web/erp/app/components/real-pdv.css" });
    expect(result.css).not.toBe(pdvCss);
    expect(PORTAL_ROOTS).toEqual(expect.arrayContaining(["document-print-root", "fiscal-print-root", "stock-print-root", "labels-print-root", "pdv-print-root"]));
    const rules: any[] = [], pages: any[] = [];
    result.root.walkAtRules("media", media => { if (media.params === "print") media.walkRules(rule => { rules.push(rule); }); });
    result.root.walkAtRules("page", page => { pages.push(page); });
    expect(rules.length).toBeGreaterThan(0);
    // Em cada seletor já transformado, a ausência da classe no body impede
    // o match, inclusive para as quatro outras raízes anexadas ao body.
    for (const rule of rules) for (const selector of splitSelectors(rule.selector)) expect(selector).toMatch(/^body\.pdv-print-open\s/);
    expect(pages).toHaveLength(1); expect(pages[0].params).toBe("pdv-receipt");
    expect(pages[0].nodes.find((d: any) => d.prop === "size").value).toBe("80mm auto");
    result.root.walkDecls("page", declaration => { expect((declaration.parent as any).selector).toBe("body.pdv-print-open .pdv-print-sheet"); });
    expect(rules.some(rule => rule.selector.includes(".pdv-print-controls") && rule.nodes.some((d: any) => d.prop === "display" && d.value === "none" && d.important))).toBe(true);
    expect(rules.some(rule => rule.selector.includes(".pdv-print-sheet *") && rule.nodes.some((d: any) => d.prop === "visibility" && d.value === "visible"))).toBe(true);
    expect(result.css).not.toMatch(/body\s+\*|@page\s*\{/);
  });
  it("abrir, imprimir, fechar, reabrir e desmontar limpam a raiz e o marcador", async () => {
    const classes = new Set<string>(), children = new Set<any>();
    const body = { append: (node: any) => children.add(node), classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } };
    vi.stubGlobal("document", { body, createElement: () => { const node: any = { className: "", remove: () => children.delete(node) }; return node; } });
    const props = { controller: { company: vi.fn(async () => ({ record: { data: { trade_name: "Loja sintética", cnpj: "12345678000195" } } })) },
      job: { kind: "move", move: "supply", store: "Loja sintética", operator: "Operador sintético", amount_cents: "1000", note: null, at: "2026-10-20T12:00:00Z" }, receipt, order: "insercao" };
    let close: () => void;
    function Preview() { const [open, setOpen] = useState(true); close = () => setOpen(false); return open ? React.createElement(PdvReceiptPrint, { ...props, onClose: close } as any) : null; }
    const view = mount(Preview, {}, "/frente-caixa-empresa", ["PdvReceiptPrint", "PdvReceiptSheet"]); await view.flush();
    expect(classes.has("pdv-print-open")).toBe(true); expect(children.size).toBe(1);
    expect([...children][0].className).toBe("pdv-print-root"); expect(runtime.portals.at(-1)).toBe([...children][0]);
    expect(view.text()).toContain("Suprimento de caixa"); expect(view.text()).toContain("R$ 10,00");
    button(view, "Imprimir").props.onClick(); expect(window.print).toHaveBeenCalledTimes(1);
    button(view, "Fechar").props.onClick(); await view.flush();
    expect(classes.has("pdv-print-open")).toBe(false); expect(children.size).toBe(0);
    const reopened = mount(PdvReceiptPrint, { ...props, onClose: vi.fn() }); await reopened.flush();
    expect(classes.has("pdv-print-open")).toBe(true); reopened.unmount();
    expect(classes.size).toBe(0); expect(children.size).toBe(0);
    window.print(); expect(classes.size).toBe(0); // uma impressão posterior não reativa o PDV
  });
});
