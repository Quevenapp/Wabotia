import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Field, Button } from "../web/ui";
import { Pager } from "../web/admin/shared";
import { createWorkApi, findWorkChild, reloadWorkEntry } from "../web/modules/os/work-api";
import { useWorkResource } from "../web/modules/os/work-hooks";
import { ConflictRecovery } from "../web/modules/os/components/ConflictRecovery";
import { parseExtra } from "../web/modules/os/components/ExtraFields";
import { FieldsEditor } from "../web/modules/os/types/FieldsEditor";
import { newField, newWorkType, prepareTypeSave, validateTypeDraft } from "../web/modules/os/types/type-draft";
import { QuoteEditor } from "../web/modules/os/work/QuoteEditor";
import { TaskDialog } from "../web/modules/os/tasks/TaskDialog";
import { PersonDialog } from "../web/modules/os/people/WorkPeopleTab";
import { EntryDialog } from "../web/modules/os/entries/WorkEntriesTab";
import { WorkPage } from "../web/modules/os/work/WorkListPage";
import { WorkDetailPage } from "../web/modules/os/work/WorkDetailPage";
import { WorkFormDialog } from "../web/modules/os/work/WorkFormDialog";
import { ServiceOrdersPage } from "../web/modules/os/ServiceOrdersPage";
import { ConversationWorkOrders } from "../web/modules/os/ConversationWorkOrders";
import { useUnsavedGuard } from "../web/app/hooks";

// Executa callbacks reais dos componentes com estado/effects controlados, sem DOM,
// navegador ou rede. Não substitui uma verificação visual no navegador.
const runtime = vi.hoisted(() => ({ current: null as any, app: {} as any, route: {} as any, navigate: vi.fn(), list: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const useState = (initial: any) => {
    const owner = runtime.current, index = owner.index++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[index], (next: any) => {
      owner.slots[index] = typeof next === "function" ? next(owner.slots[index]) : next;
    }];
  };
  return {
    ...actual, useState,
    useRef: (value: any) => useState(() => ({ current: value }))[0],
    useMemo: (compute: () => any) => compute(),
    useCallback: (callback: any) => callback,
    useEffect: (effect: () => any, deps: any[]) => {
      const owner = runtime.current, index = owner.index++, old = owner.slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        owner.effects.push(() => {
          old?.cleanup?.();
          owner.slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
});
vi.mock("../web/app/AppContext", async (original) => ({
  ...await original<typeof import("../web/app/AppContext")>(), useApp: () => runtime.app,
}));
vi.mock("../web/app/hooks", async (original) => ({
  ...await original<typeof import("../web/app/hooks")>(),
  useUnsavedGuard: vi.fn(),
  useAction: () => ({ busy: false, run: (fn: () => any) => fn() }),
}));
vi.mock("../web/lib/routes", async (original) => ({
  ...await original<typeof import("../web/lib/routes")>(),
  useRoute: () => runtime.route, navigate: runtime.navigate,
}));
vi.mock("../web/admin/shared", async (original) => ({
  ...await original<typeof import("../web/admin/shared")>(), useList: runtime.list,
}));

const instance = () => ({ slots: [] as any[], index: 0, effects: [] as (() => void)[] });
function render<T>(owner: ReturnType<typeof instance>, fn: () => T): T {
  owner.index = 0;
  owner.effects = [];
  runtime.current = owner;
  const tree = fn();
  for (const effect of owner.effects) effect();
  return tree;
}
function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!React.isValidElement(tree)) return [];
  return [tree, ...elements((tree.props as any).children)];
}
const field = (tree: any, label: string) => elements(tree).find((node) => node.type === Field && node.props.label === label);
const component = (tree: any, type: any) => elements(tree).find((node) => node.type === type);
const button = (tree: any, text: string) => elements(tree).find((node) => node.type === Button && elementsText(node.props.children).includes(text));
function elementsText(tree: any): string {
  if (Array.isArray(tree)) return tree.map(elementsText).join("");
  if (React.isValidElement(tree)) return elementsText((tree.props as any).children);
  return tree == null ? "" : String(tree);
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const custom = () => ({ ...newWorkType(), id: "projeto" });
const record = () => ({ id: "r", order_id: "o", version: 1, archived_at: null, sensitive: false, client_visible: false });
const order = () => ({
  id: "o", display_number: "P-1", version: 3,
  customer: { name: "Cliente" }, quote: null,
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
  // href/linkProps continuam reais: só fornecemos a URL que o navegador teria.
  vi.stubGlobal("location", new URL("https://painel.example/app/gestao/trabalhos/projeto?demo=1&pair=teste&q=nao-propagar"));
  runtime.app = { root: "v1/profiles/a", profile: "a", api: vi.fn(async () => ({})), status: { settings_revision: "1" }, settings: { os_work_types: [custom()] }, names: {}, me: { access: ["os", "os:sensitive"] } };
  runtime.route = { area: "admin", page: "work", typeId: "projeto" };
  runtime.list.mockReturnValue({ rows: [], raw: { counts: {} }, loaded: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revisão do painel: regressões", () => {
  it("mantém dados durante refresh do catálogo, isola escopo e ignora resposta atrasada", async () => {
    const owner = instance();
    let resolve: (value: string) => void = () => {};
    const first = vi.fn(async () => "catálogo 1");
    render(owner, () => useWorkResource("area-a", first, "1"));
    await tick();
    expect(render(owner, () => useWorkResource("area-a", first, "1")).data).toBe("catálogo 1");
    const pending = () => new Promise<string>((done) => { resolve = done; });
    expect(render(owner, () => useWorkResource("area-a", pending, "2")).data).toBe("catálogo 1");
    expect(render(owner, () => useWorkResource("area-a", pending, "2")).data).toBe("catálogo 1");
    const second = async () => "catálogo B";
    expect(render(owner, () => useWorkResource("area-b", second, "2")).data).toBeUndefined();
    await tick();
    resolve("resposta antiga A");
    await tick();
    expect(render(owner, () => useWorkResource("area-b", second, "2")).data).toBe("catálogo B");
  });

  it("preserva o tipo capturado pelo formulário e diferencia etapas open/all", async () => {
    const type = { ...custom(), stages: [...custom().stages, { id: "open", label: "Aberto próprio", base_status: "received", message: "" }, { id: "all", label: "Tudo próprio", base_status: "received", message: "" }] };
    runtime.app.api.mockResolvedValue({ data: [type], next_cursor: null });
    const page = instance();
    render(page, WorkPage);
    await tick();
    let selected: any = render(page, WorkPage);
    const list = instance();
    let tree = render(list, () => selected.type(selected.props));
    expect(elements(tree).find((node) => node.type === "a" && elementsText(node) === "Meus prazos")?.props.href)
      .toBe("/app/erp/modulos/meus-prazos?demo=1&pair=teste");
    button(tree, "Criar:").props.onClick();
    const revised = { ...type, revision: 2, labels: { ...type.labels, item: "Novo rótulo" } };
    selected = { ...selected, props: { ...selected.props, type: revised } };
    tree = render(list, () => selected.type(selected.props));
    expect(component(tree, WorkFormDialog).props.type).toBe(type);
    const stages = field(tree, "Etapa").props;
    expect(stages.options.map((option: any) => option.id)).toEqual(expect.arrayContaining(["stage:open", "stage:all", "filter:open", "filter:all"]));
    stages.onChange("stage:open");
    expect(runtime.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { stage: "open", open: "0" } }));
    stages.onChange("stage:all");
    expect(runtime.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { stage: "all", open: "0" } }));
  });

  it("restringe a seleção embutida, mas conserva a consulta legada sem filtro implícito", async () => {
    const builtin = { ...custom(), id: "service_order", kind: "builtin" };
    runtime.route.typeId = "service_order";
    runtime.app.api.mockResolvedValue({ data: [builtin, custom()] });
    const page = instance();
    render(page, WorkPage);
    await tick();
    const legacy = component(render(page, WorkPage), ServiceOrdersPage);
    expect(legacy.props.typeId).toBe("service_order");
    render(instance(), () => ServiceOrdersPage(legacy.props));
    expect(runtime.list).toHaveBeenLastCalledWith("v1/profiles/a/service-orders?type_id=service_order&open=1");
    render(instance(), () => ServiceOrdersPage());
    expect(runtime.list).toHaveBeenLastCalledWith("v1/profiles/a/service-orders?open=1");
  });

  it("pagina os 51 trabalhos da conversa e conserva seu escopo", async () => {
    const first = Array.from({ length: 50 }, (_, i) => ({ id: String(i), type_id: "projeto", display_number: `P-${i}` }));
    runtime.app.api.mockImplementation(async (url: string) => url.includes("/types")
      ? { data: [custom()] }
      : url.includes("cursor=pagina2") ? { data: [{ id: "51", type_id: "projeto", display_number: "P-51" }], next_cursor: null }
      : { data: first, next_cursor: "pagina2" });
    const wrapper = ConversationWorkOrders({ conversation: { id: "c/1" } } as any) as any;
    const owner = instance(), draw = () => wrapper.type(wrapper.props);
    render(owner, draw);
    await tick();
    render(owner, draw);
    await tick();
    let tree = render(owner, draw);
    expect(elements(tree).filter((node) => node.type === "a")).toHaveLength(50);
    expect(elements(tree).find((node) => node.type === "a")?.props.href)
      .toBe("/app/erp/modulos/trabalhos/projeto/0?demo=1&pair=teste");
    component(tree, Pager).props.setCursor("pagina2");
    render(owner, draw);
    await tick();
    tree = render(owner, draw);
    expect(elementsText(tree)).toContain("P-51");
    expect(elements(tree).find((node) => node.type === "a")?.props.href)
      .toBe("/app/erp/modulos/trabalhos/projeto/51?demo=1&pair=teste");
    const requested = runtime.app.api.mock.calls.map((call: any[]) => String(call[0]));
    expect(requested).toContain("v1/profiles/a/service-orders?open=1&conversation_id=c%2F1&limit=50&cursor=pagina2");
    expect(component(tree, Pager).props.nextCursor).toBeNull();
  });

  it("mantém texto parcial das opções e só normaliza ao preparar o salvamento", () => {
    let fields: any[] = [{ ...newField("choice"), id: "prioridade", label: "Prioridade" }];
    const input = "alta: Muito urgente\nbaixa: Com calma";
    for (let length = 1; length <= input.length; length++) {
      const tree = FieldsEditor({ fields, onChange: (next) => { fields = next; } });
      field(tree, "Opções (identificador: rótulo, uma por linha)").props.onChange(input.slice(0, length));
      expect(field(FieldsEditor({ fields, onChange: () => {} }), "Opções (identificador: rótulo, uma por linha)").props.value).toBe(input.slice(0, length));
    }
    const saved = prepareTypeSave({ ...custom(), fields });
    expect(saved.fields[0]).toMatchObject({ options: [{ id: "alta", label: "Muito urgente" }, { id: "baixa", label: "Com calma" }] });
    expect(saved.fields[0]).not.toHaveProperty("options_text");
    expect(validateTypeDraft(saved)).toEqual([]);
  });

  it("envia null ao limpar números opcionais, sem omitir a chave nem perder zero", () => {
    const fields = [{ ...newField("integer"), id: "inteiro" }, { ...newField("decimal"), id: "decimal" }];
    expect(parseExtra(fields, { inteiro: "", decimal: "  " })).toEqual({ inteiro: null, decimal: null });
    expect(parseExtra(fields, {})).toEqual({});
    expect(parseExtra(fields, { inteiro: "0", decimal: "0,0" })).toEqual({ inteiro: 0, decimal: 0 });
    expect(() => parseExtra([{ ...fields[0], required: true }], { inteiro: "" })).toThrow("obrigatório");
  });

  it("envia a versão-base do orçamento e omite validade vazia para aplicar o snapshot", async () => {
    const owner = instance(), props = { order: order(), onClose: vi.fn(), onSaved: vi.fn() };
    let tree = render(owner, () => QuoteEditor(props));
    expect(field(tree, "Validade em dias").props.value).toBe("");
    field(tree, "Preço unitário (R$)").props.onChange("12,50");
    tree = render(owner, () => QuoteEditor(props));
    field(tree, "Descrição").props.onChange("Serviço");
    tree = render(owner, () => QuoteEditor(props));
    await tree.props.onSubmit();
    const body = runtime.app.api.mock.calls[0][2];
    expect(body).toMatchObject({ version: 3, items: [{ description: "Serviço", quantity: 1, unit_cents: 1250 }] });
    expect(body).not.toHaveProperty("valid_days");
    const existing = render(instance(), () => QuoteEditor({ ...props, order: { ...order(), quote: { items: [], note: "", valid_days: 30 } } }));
    expect(field(existing, "Validade em dias").props.value).toBe("30");
  });

  it("mantém o orçamento digitado após conflito e só troca a versão-base por confirmação", async () => {
    const original = { ...order(), quote: { items: [{ description: "Original", quantity: 1, unit_cents: 100 }], note: "", valid_days: 30 } };
    runtime.app.api.mockImplementation(async (_url: string, method?: string) => {
      if (!method) return { ...original, version: 4, quote: { ...original.quote, note: "Alteração concorrente" } };
      throw Object.assign(new Error("Conflito"), { code: "version_conflict", status: 409 });
    });
    const owner = instance(), draw = () => QuoteEditor({ order: original, onClose: vi.fn(), onSaved: vi.fn() });
    let tree = render(owner, draw);
    field(tree, "Preço unitário (R$)").props.onChange("25");
    tree = render(owner, draw);
    await expect(tree.props.onSubmit()).rejects.toMatchObject({ code: "version_conflict" });
    tree = render(owner, draw);
    await component(tree, ConflictRecovery).props.recovery.reload();
    tree = render(owner, draw);
    expect(field(tree, "Preço unitário (R$)").props.value).toBe("25");
    expect(elementsText(tree)).toContain("Alteração concorrente");
    expect(component(tree, ConflictRecovery).props.recovery.base.version).toBe(3);
    component(tree, ConflictRecovery).props.recovery.accept();
    tree = render(owner, draw);
    expect(component(tree, ConflictRecovery).props.recovery.base.version).toBe(4);
    expect(field(tree, "Preço unitário (R$)").props.value).toBe("25");
  });

  it("apresenta registro sem WhatsApp no balcão e usa as definições privadas autorizadas", async () => {
    const privateField = { ...newField(), id: "restrito", label: "Restrito", sensitive: true };
    const current = {
      ...order(), type_id: "projeto", type_revision: 1, labels: custom().labels,
      type_plural_label: "Projetos", fields: [privateField], extra: {}, next_stages: [],
      next_statuses: ["quoted"], quote: { total_cents: 100 }, status: "received",
    };
    runtime.app.api.mockResolvedValue(current);
    const owner = instance();
    render(owner, () => WorkDetailPage({ workId: "o" }));
    await tick();
    const detail: any = render(owner, () => WorkDetailPage({ workId: "o" }));
    const tree = render(instance(), () => detail.type(detail.props));
    expect(elements(tree).find((node) => node.type === "a")?.props.href)
      .toBe("/app/erp/modulos/trabalhos/projeto?demo=1&pair=teste");
    expect(button(tree, "Abrir campos restritos")).toBeDefined();
    const save = button(tree, "Registrar orçamento sem envio pelo WhatsApp");
    expect(save).toBeDefined();
    await save.props.onClick();
    await tick();
    expect(runtime.app.api.mock.calls.find((call: any[]) => String(call[0]).endsWith("/quote/send"))?.[2]).toEqual({ notify: false });
  });

  it("abre o trabalho personalizado para quem tem acesso irrestrito (access null) sem oferecer campos restritos", async () => {
    runtime.app.me = { role: "admin", access: null };
    runtime.app.api.mockResolvedValue({
      ...order(), type_id: "projeto", type_revision: 1, labels: custom().labels,
      type_plural_label: "Projetos", fields: [], extra: {}, next_stages: [],
      next_statuses: [], status: "received",
    });
    const owner = instance();
    render(owner, () => WorkDetailPage({ workId: "o" }));
    await tick();
    const detail: any = render(owner, () => WorkDetailPage({ workId: "o" }));
    const tree = render(instance(), () => detail.type(detail.props));
    expect(button(tree, "Abrir campos restritos")).toBeUndefined();
  });

  it("solta a guarda de rascunho antes de navegar para o trabalho recém-criado", async () => {
    const release = vi.fn();
    vi.mocked(useUnsavedGuard).mockReturnValueOnce(release);
    runtime.app.api.mockResolvedValue({ ...order(), type_id: "projeto" });
    const onSaved = vi.fn(() => expect(release).toHaveBeenCalled());
    const tree: any = render(instance(), () => WorkFormDialog({ type: custom() as any, onClose: vi.fn(), onSaved }));
    await tree.props.onSubmit();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.results[0]?.type).toBe("return");
  });

  it.each([
    ["tarefa", TaskDialog, { ...record(), title: "Antes", description: "", audience: "staff", state: "open" }, "Título", "tasks/r"],
    ["pessoa", PersonDialog, { ...record(), name: "Antes", role: "Titular" }, "Nome", "people/r"],
    ["lançamento", EntryDialog, { ...record(), kind: "Nota", text: "Antes", occurred_at: 1700000000000, replaces_id: null }, "Texto", "entries/r/revisions"],
  ] as const)("recupera conflito de %s com comparação, nova versão e rascunho intacto", async (_name, Dialog, initial, label, path) => {
    let conflict = true;
    const latest = { ...initial, version: 2 };
    runtime.app.api.mockImplementation(async (_url: string, method?: string) => {
      if (!method) return { data: [latest], next_cursor: null };
      if (conflict) throw Object.assign(new Error("Conflito"), { status: 409, code: "version_conflict" });
      return { id: "r", version: 3 };
    });
    const owner = instance(), props = { workId: "o", initial, onClose: vi.fn(), onSaved: vi.fn() };
    const draw = () => (Dialog as any)(props);
    let tree = render(owner, draw);
    field(tree, label).props.onChange("Meu rascunho");
    tree = render(owner, draw);
    await expect(tree.props.onSubmit()).rejects.toMatchObject({ code: "version_conflict" });
    tree = render(owner, draw);
    expect(tree.props.disabled).toBe(true);
    await component(tree, ConflictRecovery).props.recovery.reload();
    tree = render(owner, draw);
    expect(component(tree, ConflictRecovery).props.recovery.base.version).toBe(1);
    expect(component(tree, ConflictRecovery).props.recovery.latest.record.version).toBe(2);
    expect(field(tree, label).props.value).toBe("Meu rascunho");
    component(tree, ConflictRecovery).props.recovery.accept();
    tree = render(owner, draw);
    conflict = false;
    await tree.props.onSubmit();
    expect(runtime.app.api).toHaveBeenLastCalledWith(`v1/profiles/a/service-orders/o/${path}`, expect.any(String), expect.objectContaining({ version: 2 }), undefined, expect.any(String));
    expect(field(tree, label).props.value).toBe("Meu rascunho");
    expect(props.onSaved).toHaveBeenCalledOnce();
  });

  it("localiza filhos após a primeira página e informa o último sucessor da retificação", async () => {
    const load = vi.fn(async (cursor?: string) => cursor ? { data: [{ id: "r" }], next_cursor: null } : { data: [{ id: "outro" }], next_cursor: "2" });
    expect(await findWorkChild(load, "r")).toEqual({ id: "r" });
    expect(load).toHaveBeenLastCalledWith("2");
    const entries = vi.fn(async (cursor?: string) => cursor ? { data: [{ ...record(), id: "r2", replaces_id: "r1" }, { ...record(), id: "r", archived_at: 1 }], next_cursor: null } : { data: [{ ...record(), id: "r1", replaces_id: "r" }], next_cursor: "2" });
    expect(await reloadWorkEntry(entries as any, "r")).toMatchObject({ record: { id: "r" }, successor: { id: "r2" } });
  });

  it("preserva o texto quando o lançamento já foi retificado e bloqueia nova escrita no antecessor", async () => {
    const original = { ...record(), text: "Original", kind: "Nota", occurred_at: 1700000000000 };
    runtime.app.api.mockImplementation(async (_url: string, method?: string) => {
      if (method) throw Object.assign(new Error("Retificado"), { code: "entry_replaced", status: 409 });
      return { data: [{ ...original, archived_at: 1, version: 2 }, { ...original, id: "sucessor", replaces_id: "r", text: "Correção atual" }], next_cursor: null };
    });
    const owner = instance(), draw = () => EntryDialog({ workId: "o", initial: original as any, onClose: vi.fn(), onSaved: vi.fn() });
    let tree = render(owner, draw);
    field(tree, "Texto").props.onChange("Rascunho preservado");
    tree = render(owner, draw);
    await expect(tree.props.onSubmit()).rejects.toMatchObject({ code: "entry_replaced" });
    tree = render(owner, draw);
    await component(tree, ConflictRecovery).props.recovery.reload();
    tree = render(owner, draw);
    expect(elementsText(tree)).toContain("sucessor");
    expect(elementsText(tree)).toContain("Correção atual");
    component(tree, ConflictRecovery).props.recovery.accept();
    tree = render(owner, draw);
    expect(tree.props.disabled).toBe(true);
    expect(field(tree, "Texto").props.value).toBe("Rascunho preservado");
  });

  it("mantém rotas integradas de prazos/documentos/tarefas privadas e registra orçamento sem notificar", async () => {
    const api = createWorkApi(runtime.app.api, runtime.app.root);
    await api.deadlines({ assignee: "me", state: "open", type_id: "projeto", period: "today" });
    expect(runtime.app.api).toHaveBeenLastCalledWith("v1/profiles/a/service-orders/my-tasks?assignee=me&state=open&type_id=projeto&period=today");
    await api.documents("o", { limit: 50 }, true);
    expect(runtime.app.api).toHaveBeenLastCalledWith("v1/profiles/a/service-orders/o/private-documents?limit=50");
    await api.reserveDocument("o", { name: "x", mime_type: "text/plain", expected_bytes: 1, sensitive: true, client_visible: false });
    expect(runtime.app.api.mock.calls.at(-1)[0]).toBe("v1/profiles/a/service-orders/o/private-documents");
    expect(api.documentUrl("o", "d", true)).toBe("/api/v1/profiles/a/service-orders/o/private-documents/d/content");
    await api.completeDocument("o", "d", { version: 2, upload_attempt: "u" }, true);
    expect(runtime.app.api.mock.calls.at(-1)[0]).toBe("v1/profiles/a/service-orders/o/private-documents/d/complete");
    await api.archive("o", "documents", "d", 3, true);
    expect(runtime.app.api.mock.calls.at(-1)[0]).toBe("v1/profiles/a/service-orders/o/private-documents/d/archive");
    await api.sendDocument("o", "d", 3);
    expect(runtime.app.api.mock.calls.at(-1)[0]).toBe("v1/profiles/a/service-orders/o/documents/d/send");
    for (const state of ["done", "open", "cancelled"] as const) {
      await api.updateTask("o", "r", { version: 1, state }, true);
      expect(runtime.app.api.mock.calls.at(-1)[0]).toBe("v1/profiles/a/service-orders/o/private-tasks/r");
    }
    await api.updateTask("o", "r", { version: 1, sensitive: true }, false);
    expect(runtime.app.api.mock.calls.at(-1)[0]).toBe("v1/profiles/a/service-orders/o/private-tasks/r");
    await api.sendQuote("o", { notify: false });
    expect(runtime.app.api.mock.calls.at(-1)[2]).toEqual({ notify: false });
    await api.sendQuote("o");
    expect(runtime.app.api.mock.calls.at(-1)[2]).toEqual({});
  });
});
