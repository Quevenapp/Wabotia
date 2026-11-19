import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagementContext } from "../src/modules/panel-contract";
import { ERP_MANAGEMENT_ITEMS } from "../src/modules/erp/panel-menu";
import { createIntegrationApi, integrationError, persistentCommands, type IntegrationApi, type IntentStorage } from "../web/modules/integrations/api";
import { integrationAccess, integrationRouteState, installIntegrationHost, portableWorkBlocked, sourceHref, visibleIntegrationItems, visibleSource } from "../web/modules/integrations/visibility";
import { IntegrationStatus, actionableEvent } from "../web/modules/integrations/IntegrationStatus";
import { CatalogLinkPicker, stockAvailable } from "../web/modules/integrations/CatalogLinkPicker";
import { CommercialPolicyPanel, missingDefaults } from "../web/modules/integrations/CommercialPolicyPanel";
import { ReceiptForm, receiptCents } from "../web/modules/integrations/ReceiptForm";
import { LegacyServiceOrders } from "../web/modules/integrations/LegacyServiceOrders";
import { Editor } from "../web/erp/app/components/RealDocuments";
import { setMotorWorkEnabled, MOTOR_READY } from "../web/erp/motor";
import { loadAuthorizedPorted, startAuthorizedPortedPrefetch } from "../web/erp/ErpArea";
import { parseRoute } from "../web/lib/routes";
import type { CommercialPolicy, SourceView, StockObservation } from "../web/modules/integrations/contracts";

// O painel usa React real para os elementos. Este hospedeiro controla efeitos,
// desmontagem e respostas, sem navegador, rede ou produtores de outras frentes.
const runtime = vi.hoisted(() => ({ owner: null as any, api: null as IntegrationApi | null }));
vi.mock("../web/modules/integrations/api", async original => ({ ...await original<typeof import("../web/modules/integrations/api")>(), useIntegrationApi: () => runtime.api }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const state = (initial: any) => {
    const owner = runtime.owner, i = owner.index++;
    if (!(i in owner.slots)) owner.slots[i] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[i], (next: any) => { owner.slots[i] = typeof next === "function" ? next(owner.slots[i]) : next; }];
  };
  const effect = (run: () => any, deps?: unknown[]) => {
    const owner = runtime.owner, i = owner.index++, previous = owner.effects[i];
    if (previous && deps && previous.deps?.every((v: unknown, j: number) => Object.is(v, deps[j])) && previous.deps.length === deps.length) return;
    previous?.cleanup?.(); owner.effects[i] = { deps };
    owner.pending.push(() => { owner.effects[i].cleanup = run(); });
  };
  return { ...actual, useState: state, useRef: (v: any) => state(() => ({ current: v }))[0], useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(), useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn };
});
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); runtime.api = null; runtime.owner = null; setMotorWorkEnabled(false); vi.restoreAllMocks(); });
const context = (patch: Partial<ManagementContext> = {}): ManagementContext => ({ statusLoaded: true, role: "admin", erpRole: "admin", access: null,
  modules: Object.fromEntries(["erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro", "os", "pedido", "mesas", "agenda", "mensalidade", "reserva", "suporte", "entrega"].map(id => [id, true])), ...patch });
const source = (patch: Partial<SourceView> = {}): SourceView => ({ source: { profile: "area", module: "os", source_id: "work-1", component: "main" }, revision: 7, confirmed_ms: null, state: "waiting_manual", pending: true,
  deliveries: [{ id: "event-1", seq: 1, state: "done", completed_ms: null }], manual_destinations: ["stock", "finance"], links: [], ...patch });
const storage = (): IntentStorage => { const values = new Map<string, string>(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); } }; };
const ticks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function host(c: ManagementContext, request: any, store = storage()) {
  cleanups.push(installIntegrationHost({ context: c, api: request, root: "v1/profiles/area", actor: "person", generation: 1 }));
  runtime.api = createIntegrationApi(request, "v1/profiles/area", () => c, "person", store);
  return runtime.api;
}
function mount(render: () => any) {
  const owner = { slots: [] as any[], effects: [] as any[], pending: [] as (() => void)[], index: 0 };
  const draw = () => { runtime.owner = owner; owner.index = 0; const value = render(); for (const effect of owner.pending.splice(0)) effect(); return value; };
  const unmount = () => { for (const effect of owner.effects) effect?.cleanup?.(); };
  cleanups.push(unmount);
  return { draw, unmount, async settle() { draw(); await ticks(); return draw(); } };
}
function nodes(tree: any): any[] { if (!tree || typeof tree !== "object") return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...nodes(tree.props?.children)]; }
function text(tree: any): string { if (tree == null || typeof tree === "boolean") return ""; if (typeof tree !== "object") return String(tree); if (Array.isArray(tree)) return tree.map(text).join(" "); return text(tree.props?.children); }
function button(tree: any, label: string) { return nodes(tree).find(node => node.props?.onClick && text(node) === label); }

describe("f3-painel: partes e permissões antes da leitura", () => {
  it.each(["os", "pedido", "mesas", "entrega", "mensalidade", "agenda", "reserva", "suporte"] as const)("só consulta %s ligado e autorizado", async module => {
    let c = context(), request = vi.fn(async (..._args: any[]) => ({ module, activations: {}, counters: [] }));
    const api = createIntegrationApi(request, "v1/profiles/area", () => c, "person", storage());
    await api.status(module);
    c = context({ modules: { ...c.modules, [module]: false } });
    await expect(api.status(module)).rejects.toMatchObject({ code: "part_disabled" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("não inicia leituras nem ações com Base desligada, inclusive por URL direta", async () => {
    const request = vi.fn(), c = context({ modules: { os: true } });
    const api = host(c, request);
    expect(parseRoute("/app/erp/integracoes", "?module=os&source=work-1")).toMatchObject({ erpPath: "/integracoes" });
    expect(integrationRouteState(c)).toBe("disabled");
    expect(loadAuthorizedPorted(integrationRouteState(c), request, request)).toBeNull();
    startAuthorizedPortedPrefetch("disabled", { profile: "area", actor: "person", simulated: false }, request).dispose();
    const screen = mount(() => IntegrationStatus({ module: "os", sourceId: "work-1" }));
    expect(text(await screen.settle())).toContain("Operação local");
    await expect(api.source("os", "work-1")).rejects.toMatchObject({ code: "part_disabled" });
    await expect(api.sourceAction("os", "work-1", "post", { event_id: "event-1", destinations: ["finance"], version: 7 })).rejects.toMatchObject({ code: "part_disabled" });
    expect(request).not.toHaveBeenCalled();
  });
  it("Base apenas permite resumo local e não consulta catálogo, estoque ou padrões ERP", async () => {
    const c = context({ modules: { erp: true, os: true } }), request = vi.fn(async (..._args: any[]) => source());
    const api = host(c, request);
    await api.source("os", "work-1");
    await expect(api.catalog("peça")).rejects.toMatchObject({ code: "part_disabled" });
    await expect(api.stock("item-1")).rejects.toMatchObject({ code: "part_disabled" });
    await expect(api.sourceAction("os", "work-1", "retry", { event_id: "event-1" })).rejects.toMatchObject({ code: "part_disabled" });
    const picker = mount(() => CatalogLinkPicker({}));
    expect(text(await picker.settle())).toContain("Item livre");
    expect(button(picker.draw(), "Buscar catálogo")).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("recebimento local autorizado continua sem ERP, sem chamar o motor", async () => {
    const request = vi.fn(async (..._args: any[]) => ({ accepted: true }));
    const api = host(context({ modules: { agenda: true } }), request);
    await api.receipt("agenda", "appointment", { request_id: "receipt-1", amount_cents: 1000, method: "cash", occurred_ms: 1700000000000 });
    expect(request.mock.calls[0][0]).toBe("v1/profiles/area/agenda/appointments/appointment/receipts");
    expect(request.mock.calls.some(call => call[0].includes("/erp/") || call[0].includes("/integrations/"))).toBe(false);
  });
  it("com tudo ligado, abrir seletor e padrões não antecipa o catálogo ou financeiro", async () => {
    const request = vi.fn(); host(context(), request);
    await mount(() => CatalogLinkPicker({})).settle();
    await mount(() => CommercialPolicyPanel()).settle();
    expect(request).not.toHaveBeenCalled();
  });
  it("retém apenas a existência de pendência sem expor títulos, contas, baixas ou erro sensível", async () => {
    const c = context({ role: "agent", erpRole: "vendas", access: ["os", "erp:vendas"] });
    const raw = source({ links: [{ kind: "title", id: "finance-secret", slot: "finance", version: 1 }, { kind: "settlement", id: "receipt-secret", slot: "receipt", version: 1 }], deliveries: [{ id: "event-1", state: "failed", completed_ms: null, error_code: "private-clinical-text" }] });
    const request = vi.fn(async (..._args: any[]) => raw); const api = host(c, request);
    const result = await api.source("os", "work-1");
    expect(JSON.stringify(result)).not.toMatch(/finance-secret|receipt-secret|private-clinical-text/);
    const screen = mount(() => IntegrationStatus({ module: "os", sourceId: "work-1" }));
    const tree = await screen.settle();
    expect(text(tree)).toContain("Detalhes financeiros são restritos");
    expect(button(tree, "Lançar financeiro manualmente")).toBeUndefined();
    expect(mount(() => ReceiptForm({ module: "agenda", sourceId: "appt" })).draw()).toBeNull();
    expect(integrationError(new Error("prontuário particular"))).not.toContain("prontuário");
    await expect(api.sourceAction("os", "work-1", "post", { event_id: "event-1", destinations: ["finance"], version: 7 })).rejects.toMatchObject({ code: "part_disabled" });
    expect(request.mock.calls.every(call => call[1] === "GET")).toBe(true);
  });
  it("permite financeiro sem Vendas/Produtos e separa a postagem de estoque", async () => {
    const c = context({ role: "agent", erpRole: "financeiro", access: ["os", "erp:financeiro"], modules: { erp: true, os: true, "erp-financeiro": true } });
    const request = vi.fn(async (..._args: any[]) => ({ accepted: true })), api = host(c, request);
    expect(integrationAccess(c).documents).toBe(false);
    await api.sourceAction("os", "work-1", "post", { event_id: "event-1", version: 7, destinations: ["finance"] });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(api.sourceAction("os", "work-1", "post", { event_id: "event-1", version: 7, destinations: ["stock", "finance"] })).rejects.toMatchObject({ code: "part_disabled" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("não consulta saldos sem permissão individual e nunca transforma desconhecido em zero", async () => {
    const request = vi.fn(async (..._args: any[]) => ({ user_id: "person", role: "admin", access: { open: true }, permissions: [] })), api = host(context(), request);
    await expect(api.stock("item-1")).rejects.toMatchObject({ code: "part_disabled" });
    expect(request.mock.calls.map(call => call[0])).toEqual(["v1/profiles/area/erp/v1/sistema/permissoes"]);
    const row: StockObservation = { warehouse_id: "w1", warehouse_name: "Principal", quantity: "3.125", reserved_quantity: "1.1", observed_ms: 1700000000000 };
    expect(stockAvailable(row)).toBe("2.025000");
    expect(stockAvailable({ ...row, quantity: null })).toBeNull();
    expect(stockAvailable({ ...row, reserved_quantity: null })).toBeNull();
  });
  it("descarta resposta de um contexto revogado", async () => {
    let c = context(), resolve!: (value: SourceView) => void;
    const api = createIntegrationApi(() => new Promise(r => { resolve = r; }), "v1/profiles/area", () => c, "person", storage());
    const reading = api.source("os", "work-1");
    c = context({ statusLoaded: false }); resolve(source());
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("f3-painel: repetição e fechamento", () => {
  it("persiste a incerteza antes de enviar, inclusive para queda antes de executar o catch", async () => {
    const store = storage(); let resolve!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(done => { resolve = done; }));
    const first = persistentCommands(request, "crash-before-catch", store);
    const sending = first.execute("intent", "/post", "POST", { event_id: "event" });
    const resumed = persistentCommands(request, "crash-before-catch", store);
    expect(resumed.pending("intent")?.uncertain).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    resolve({ accepted: true }); await sending;
  });
  it("preserva ação incerta ao desligar seu destino, sem botão de envio nem requisição", async () => {
    const store = storage(), request = vi.fn(async (_path: string, method: string) => {
      if (method === "GET") return source();
      throw Object.assign(new Error(), { status: 503 });
    });
    const c = context(), api = host(c, request, store);
    await expect(api.sourceAction("os", "work-1", "post", { event_id: "event-1", destinations: ["finance"], version: 7 })).rejects.toBeDefined();
    host(context({ modules: { ...c.modules, "erp-financeiro": false } }), request, store);
    const screen = mount(() => IntegrationStatus({ module: "os", sourceId: "work-1" }));
    const tree = await screen.settle();
    expect(button(tree, "Repetir a mesma ação")).toBeUndefined();
    expect(runtime.api!.pending("os:work-1")).not.toBeNull();
    expect(request.mock.calls.filter(call => call[1] === "POST")).toHaveLength(1);
  });
  it("retoma após queda sem novo envio e repete a chave e o corpo que já tiveram efeito", async () => {
    const store = storage(), commands = new Map<string, unknown>(); let effects = 0, lose = true;
    const request = vi.fn(async (_path: string, method: string, body: unknown, _signal: unknown, key: string) => {
      if (method === "GET") return source({ revision: effects ? 8 : 7, state: effects ? "done" : "waiting_manual", manual_destinations: effects ? [] : ["finance"] });
      if (!commands.has(key)) { effects++; commands.set(key, { accepted: true, event_id: "next-event" }); }
      if (lose) { lose = false; throw Object.assign(new Error("timeout"), { status: 0 }); }
      return commands.get(key);
    });
    host(context(), request, store);
    const first = mount(() => IntegrationStatus({ module: "os", sourceId: "work-1" }));
    button(await first.settle(), "Lançar financeiro manualmente").props.onClick(); await ticks();
    expect(effects).toBe(1); first.unmount();
    host(context(), request, store);
    const resumed = mount(() => IntegrationStatus({ module: "os", sourceId: "work-1" }));
    const tree = await resumed.settle();
    expect(text(tree)).toContain("não enviou nenhum comando");
    expect(request.mock.calls.filter(call => call[1] === "POST")).toHaveLength(1);
    button(tree, "Repetir a mesma ação").props.onClick(); await ticks();
    const writes = request.mock.calls.filter(call => call[1] === "POST");
    expect(writes).toHaveLength(2); expect(writes[1][4]).toBe(writes[0][4]); expect(writes[1][2]).toEqual(writes[0][2]); expect(effects).toBe(1);
  });
  it("não troca corpo incerto nem retoma em outro ator/área", async () => {
    const store = storage(), request = vi.fn(async (..._args: any[]) => { throw Object.assign(new Error(), { status: 503 }); });
    const commands = persistentCommands(request, "area:person", store);
    await expect(commands.execute("correction", "/replace", "POST", { event_id: "original", reason_code: "default_correction" })).rejects.toBeDefined();
    expect(persistentCommands(request, "other:person", store).pending("correction")).toBeNull();
    expect(persistentCommands(request, "area:other-person", store).pending("correction")).toBeNull();
    await expect(commands.execute("correction", "/replace", "POST", { event_id: "different", reason_code: "default_correction" })).rejects.toMatchObject({ code: "pending_command" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["operation_unknown", "idempotency_conflict"])("mantém a chave após %s", async code => {
    const store = storage(), request = vi.fn(async (..._args: any[]) => { throw Object.assign(new Error(), { status: 409, code }); });
    const commands = persistentCommands(request, `uncertain-${code}`, store);
    await expect(commands.execute("intent", "/receipts", "POST", { amount_cents: 100 })).rejects.toBeDefined();
    const key = commands.pending("intent")!.key;
    await expect(commands.resume("intent")).rejects.toBeDefined();
    expect(commands.pending("intent")!.key).toBe(key);
  });
  it("só solicita nova projeção após confirmação humana e deixa o fechamento a cargo de A9", async () => {
    let closed = false, projected = 0;
    const request = vi.fn(async (path: string, method: string) => {
      if (method === "GET") return source({ state: "blocked" });
      expect(path.endsWith("/replace")).toBe(true);
      closed = true; if (closed) projected++;
      return { accepted: true, event_id: "replacement" };
    });
    host(context(), request);
    const screen = mount(() => IntegrationStatus({ module: "os", sourceId: "work-1" }));
    button(await screen.settle(), "Corrigir pendência").props.onClick();
    const review = screen.draw(); expect(text(review)).toContain("confirmará o fechamento"); expect(projected).toBe(0);
    button(review, "Confirmar fechamento e correção").props.onClick(); await ticks();
    expect(projected).toBe(1); expect(closed).toBe(true);
    expect(request.mock.calls.filter(call => call[1] === "POST")).toHaveLength(1);
  });
  it("um conflito não cria outro comando automaticamente nem anuncia fechamento confirmado", async () => {
    const request = vi.fn(async (_path: string, method: string) => { if (method === "GET") return source({ state: "blocked" }); throw Object.assign(new Error("sql private text"), { status: 409, code: "version_conflict" }); });
    host(context(), request);
    const screen = mount(() => IntegrationStatus({ module: "os", sourceId: "work-1" }));
    button(await screen.settle(), "Corrigir pendência").props.onClick(); button(screen.draw(), "Confirmar fechamento e correção").props.onClick(); await ticks();
    expect(text(screen.draw())).toContain("comando anterior já foi aplicado"); expect(text(screen.draw())).not.toContain("sql private");
    expect(request.mock.calls.filter(call => call[1] === "POST")).toHaveLength(1);
  });
  it("usa a primeira pendência e conserva a revisão para postagem manual", () => {
    const view = source({ deliveries: [{ id: "done", state: "done", completed_ms: 1 }, { id: "first", state: "failed", completed_ms: null }, { id: "second", state: "pending", completed_ms: null }] });
    expect(actionableEvent(view)?.id).toBe("first");
  });
});

describe("f3-painel: casa única, legado e origem", () => {
  it("oculta OS portável com os ligado, preserva relatórios e bloqueia criação direta antes do prefetch", () => {
    const c = context(), items = visibleIntegrationItems(ERP_MANAGEMENT_ITEMS, c);
    expect(items.some(i => i.id === "erp.service-orders")).toBe(false); expect(items.some(i => i.id === "erp.service-reports")).toBe(true);
    setMotorWorkEnabled(true); expect(MOTOR_READY.some(i => i.to === "/documentos-empresa?tipo=service_orders")).toBe(false);
    const load = vi.fn(), prefetch = vi.fn();
    for (const action of ["incluir", "clonar", "proposta"]) {
      expect(portableWorkBlocked(`/documentos-empresa?tipo=service_orders&acao=${action}`, c)).toBe(true);
      loadAuthorizedPorted("unavailable", load, prefetch);
    }
    expect(portableWorkBlocked("/documentos-empresa?tipo=service_orders&acao=relatorios", c)).toBe(false);
    expect(prefetch).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    expect(visibleIntegrationItems(ERP_MANAGEMENT_ITEMS, context({ modules: { ...c.modules, os: false } })).some(i => i.id === "erp.service-orders")).toBe(true);
  });
  it("expõe a lista anterior sem fazer leitura ao renderizar o link", () => {
    const request = vi.fn(); host(context(), request);
    const link = mount(LegacyServiceOrders).draw();
    expect(link.props.href).toBe("/app/erp/documentos-empresa?tipo=service_orders&legado=1"); expect(request).not.toHaveBeenCalled();
  });
  it("consulta a origem antes do editor e mantém documento vinculado somente leitura mesmo com os desligado", async () => {
    const c = context(); c.modules = { ...c.modules, os: false };
    const origin = { document_id: "doc", source: source().source, readonly: true };
    const request = vi.fn(async (..._args: any[]) => ({ data: [origin] })); host(c, request);
    const record = { id: "doc", kind: "service_orders", number: "001", date: "2026-11-19", status: "open", contact_snapshot: { name: "Cliente" }, items: [], installments: [], totals: { total: "0.00" } };
    const screen = mount(() => Editor({ record, kind: "service_orders", writable: true, onClose: vi.fn() } as any));
    expect(text(screen.draw())).toContain("Conferindo origem");
    const tree = await screen.settle();
    expect(nodes(tree).some(node => node.type?.name === "DocumentOriginNotice")).toBe(true);
    expect(nodes(tree).some(node => node.type?.name === "DocumentEditorBody")).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    const url = new URL(sourceHref({ ...origin.source, source_id: "id /? com símbolos" }), "https://panel.test");
    expect(url.pathname).toBe("/app/erp/integracoes"); expect(url.searchParams.get("source")).toBe("id /? com símbolos");
    // A base pode omitir a origem após revogação; a trava já confirmada é monotônica.
    host(c, vi.fn(async (..._args: any[]) => ({ data: [] })));
    const restricted = await screen.settle();
    expect(text(restricted)).toContain("origem está indisponível");
    expect(nodes(restricted).some(node => node.type?.name === "DocumentEditorBody")).toBe(false);
  });
  it("falha de leitura da origem não monta editor nem auxiliares", async () => {
    const request = vi.fn(async (..._args: any[]) => { throw new Error("offline"); }); host(context(), request);
    const screen = mount(() => Editor({ record: { id: "doc" }, kind: "sales_orders", writable: true } as any));
    const tree = await screen.settle(); expect(nodes(tree).some(node => node.type?.name === "DocumentEditorBody")).toBe(false); expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("f3-painel: padrões, estoque e dinheiro", () => {
  it("mostra padrões ausentes sem inventar referências", async () => {
    const policy: CommercialPolicy = { profile: "area", version: 1, auto_post: { stock: true, finance: true }, warehouse_id: null, revenue_category_id: null, payment_method_id: null, settlement_accounts: {}, consumer_contact_id: null, installment_rule: "single_on_trigger" };
    expect(missingDefaults(policy, true, true)).toHaveLength(4); expect(missingDefaults(policy, true, false)).toEqual(["Depósito para baixa física"]);
    const request = vi.fn(async (..._args: any[]) => policy), api = host(context(), request);
    await api.initialize({ version: 1, category: { name: "Receita de assistência" } });
    expect(request.mock.calls[0][2]).toEqual({ version: 1, category: { name: "Receita de assistência" } }); expect(request.mock.calls[0][4]).toBeTruthy();
  });
  it("associa exatamente uma opção e não envia preço nem cria produtos", async () => {
    const request = vi.fn(async (..._args: any[]) => ({ version: 2, erp_item_id: "p1" })), api = host(context(), request);
    await api.link("pedido", "option", "group", "option-1", { version: 1, erp_item_id: "p1" });
    expect(request.mock.calls[0].slice(0, 3)).toEqual(["v1/profiles/area/integrations/pedido/catalog/option/group/option-1", "PUT", { version: 1, erp_item_id: "p1" }]);
  });
  it("mantém centavos exatos e recusa excesso de precisão, negativos e inteiros inseguros", () => {
    expect(receiptCents("12,34")).toBe(1234); expect(receiptCents("0.01")).toBe(1);
    for (const value of ["0", "-1", "1.001", "NaN", "1e3", "9007199254740992"]) expect(receiptCents(value)).toBeNull();
  });
});
