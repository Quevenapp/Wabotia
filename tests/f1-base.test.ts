import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, Conversation, Env } from "../src/types";
import type {
  BridgeCommand, CustomerErpBridge, CustomerRef, CustomerWrite, HistoryPort,
  IdentityPort, MaintenanceBudget, MaintenanceResult, WritePort,
} from "../src/customer/contracts";
import type { ProfilePort } from "../src/customer/profile-contracts";
import { normalizeCustomerPhone } from "../src/customer/phone";
import { customerProfileDeclarations } from "../src/customer/declarations";
import { isFullCustomerEnabled } from "../src/customer/feature";
import { moduleById, moduleStates, moduleView } from "../src/modules/registry";
import { withReadCache } from "../src/db";

// Teste unitário da montagem do contexto: não carregar registros das tarefas
// paralelas por service/runtime; as portas abaixo recebem simulações explícitas.
vi.mock("../src/modules/runtime", () => ({}));
vi.mock("../src/service", () => ({
  conversation: vi.fn(), conversationByPhone: vi.fn(), enqueue: vi.fn(),
  handoff: vi.fn(), handoffToPerson: vi.fn(), message: vi.fn(), perform: vi.fn(), settings: vi.fn(),
}));

const conversation = (extra: Partial<Conversation> = {}): Conversation => ({
  id: "conversation", profile_id: "area", connection_id: "channel",
  external_namespace: "channel:channel", external_id: "5511987654321",
  phone: "5511987654321", chat_type: "direct", title: "", bot_policy: "",
  state: "ai", owner: null, epoch: 0, session: "session", topic: null,
  tags: "[]", last_customer: 1, created: 1, updated: 1, ...extra,
});
const actor: Actor = {
  id: "user", kind: "user", name: "Pessoa", role: "admin", profiles: ["area"],
  scopes: [], bots: [], rate: 100, runLimit: 1,
};
const input: CustomerWrite = {
  commandId: "stable-command", expectedVersion: 1, expectedErpVersion: null,
  patch: { name: "Ana" }, mode: "fill_empty",
};
const ready = (extra: Partial<CustomerRef> = {}): CustomerRef => ({
  profileId: "area", namespace: "team", state: "ready", contactId: "contact",
  verifiedPhone: "5511987654321", version: 1, erp: null, ...extra,
});
const done = (): MaintenanceResult => ({ pending: false, statements: 0, items: 0 });
const identity = (): IdentityPort => ({
  resolve: vi.fn(async () => ready()),
  prepareInbound: vi.fn<IdentityPort["prepareInbound"]>(async () => ({ statements: [], state: "pending", verifiedPhone: null })),
  indexContact: vi.fn(async () => []), maintain: vi.fn(async () => done()),
});
const writer = (): WritePort => ({
  enrich: vi.fn<WritePort["enrich"]>(async () => ({ contactId: "contact", version: 2, jobId: null, state: "done", pending: false })),
  maintain: vi.fn(async () => done()),
});
const history = (): HistoryPort => ({
  read: vi.fn(async () => ({ items: [], nextCursor: null, incomplete: false })),
  memory: vi.fn(async () => ({ previousInteractions: 0, pendingActions: 0, lastInteractionAt: null, topicCode: null })),
  maintain: vi.fn(async () => done()),
});
const profile = (): ProfilePort => ({
  view: vi.fn<ProfilePort["view"]>(async () => ({
    profileId: "area", contactId: "contact", erpContactId: null, depth: "simple",
    vocabulary: { singular: "Cliente", plural: "Clientes" }, writable: false, contributions: [],
  })),
  collection: vi.fn(async () => ({ items: [], nextCursor: null, incomplete: false })),
  section: vi.fn<ProfilePort["section"]>(async () => ({ version: 1, writable: false, schema: "private.navigation.v1", data: null })),
  saveSection: vi.fn<ProfilePort["saveSection"]>(async () => ({ version: 2, writable: true, schema: "private.navigation.v1", data: null, replayed: false })),
});
const snapshot = {
  erpId: "different-erp-id", erpVersion: 3,
  mirror: { name: "Ana", phones: ["5511987654321"], email: "", document: null, personType: null },
};
const bridge = (): CustomerErpBridge => ({
  apply: vi.fn<CustomerErpBridge["apply"]>(async () => ({ status: "applied", snapshot, replayed: false })),
  read: vi.fn(async () => snapshot),
  scan: vi.fn(async () => ({ items: [snapshot], nextCursor: null })),
});
const command: BridgeCommand = {
  profileId: "area", namespace: "team", contactId: "contact", commandId: "command",
  requestHash: "hash", actor, operation: "promote", erpId: null, expectedErpVersion: null, patch: {},
};

function isolatedEnv() {
  const prepare = vi.fn((_sql: string): unknown => { throw new Error("D1 não solicitado neste teste"); });
  const erpCall = vi.fn(() => { throw new Error("ERP não pode ser chamado"); });
  const env = { DB: { prepare }, COORDINATOR: { idFromName: erpCall, get: erpCall } } as unknown as Env;
  return { env, prepare, erpCall };
}

beforeEach(() => vi.resetModules());

describe("telefone canônico", () => {
  it.each([
    ["+55 (11) 98765-4321", "5511987654321"],
    [" 55.11.8765.4321 ", "551187654321"],
    ["12345678", "12345678"], ["123456789012345", "123456789012345"],
    ["11987654321", "11987654321"], ["+1 (212) 555-0199", "12125550199"],
  ])("international conserva o número %s", (value, expected) => {
    expect(normalizeCustomerPhone(value, "international")).toBe(expected);
  });
  it.each([
    "", "1234567", "1234567890123456", "0123456789", "+0123456789",
    "telefone 5511987654321", "Ana 5511987654321", "5511987654321@lid",
    "5511987654321@s.whatsapp.net", "5511987654321:1", "55+11987654321",
    "++5511987654321", "5511987654321 ramal 12", "5511/987654321",
    "5511\n987654321", "5511\t987654321", "55（11）987654321", "55(11 987654321",
    "55((11))987654321", "５５１１９８７６５４３２１", 5511987654321, null, {}, undefined,
  ])("recusa texto, identidades não telefônicas e formatos inválidos: %s", (value) => {
    expect(normalizeCustomerPhone(value, "international")).toBeNull();
    expect(normalizeCustomerPhone(value, "human_br")).toBeNull();
  });
  it("human_br acrescenta somente DDI quando há DDD explícito", () => {
    expect(normalizeCustomerPhone("(11) 8765-4321", "human_br")).toBe("551187654321");
    expect(normalizeCustomerPhone("(11) 98765-4321", "human_br")).toBe("5511987654321");
    expect(normalizeCustomerPhone("55 11 98765-4321", "human_br")).toBe("5511987654321");
    expect(normalizeCustomerPhone("(55) 98765-4321", "human_br")).toBe("5555987654321");
    expect(normalizeCustomerPhone("+1 212 555-0199", "human_br")).toBe("12125550199");
    for (const value of ["98765-4321", "8765-4321", "011987654321", "005511987654321", "441234567890"])
      expect(normalizeCustomerPhone(value, "human_br")).toBeNull();
  });
});

describe("catálogo e ativação", () => {
  it("declara todos os IDs locais e preserva os campos anteriores de moduleView", () => {
    const expected = {
      os: ["works"], agenda: ["appointments"], pedido: ["orders"], reserva: ["bookings"],
      mensalidade: ["subscriptions", "installments"], suporte: ["sessions", "purchases", "releases"],
      queue: ["tickets"], forms: ["submissions"],
      condominio: ["units", "deliveries", "visits", "occurrences", "dues"],
      saude: ["private"], ensino: ["private"], juridico: ["private"], erp: ["sales", "open_titles", "ledger"],
    };
    expect(Object.keys(customerProfileDeclarations).sort()).toEqual(Object.keys(expected).sort());
    for (const [moduleId, ids] of Object.entries(expected)) {
      const definition = moduleById(moduleId)!;
      const declaration = customerProfileDeclarations[moduleId];
      expect(declaration.contributions.map((c) => c.id)).toEqual(ids);
      const { customer_profile, ...view } = moduleView(definition, false);
      expect(customer_profile).toBe(declaration);
      expect(view).toEqual({
        id: definition.id, name: definition.name, version: definition.version,
        description: definition.description, builtin: definition.builtin, enabled: false,
        navigation: definition.navigation, management: definition.management ?? [],
        menu_item_types: definition.menu_item_types, events: definition.events,
        settings: definition.settings, scopes: definition.scopes, requires: definition.requires ?? [],
        erp_role: definition.erp_role ?? null,
      });
      for (const contribution of declaration.contributions) {
        expect(contribution.source).toBe(`${moduleId}.${contribution.id}`);
        expect(contribution.policy).toBeTruthy();
      }
    }
    const own = { contributions: [] };
    expect(moduleView({ ...moduleById("os")!, customer_profile: own }, true).customer_profile).toBe(own);
    expect(moduleView(moduleById("mesas")!, false).customer_profile).toBeNull();
    expect(customerProfileDeclarations.os.contributions[0].titleKey).toBe("works");
    expect(customerProfileDeclarations.reserva.contributions[0].columns).toContainEqual({
      key: "checkinStatus", label: "Check-in", format: "status",
    });
  });
  it("declara dependências e somente navegação para domínios privados", () => {
    expect(customerProfileDeclarations.condominio.contributions.find((c) => c.id === "dues"))
      .toMatchObject({ enabledWith: ["mensalidade"], policy: "condominio.dues" });
    expect(customerProfileDeclarations.condominio.personTypes?.map((p) => p.key)).toEqual([
      "morador", "proprietario", "inquilino", "dependente", "sindico", "zelador", "porteiro",
      "prestador", "empregado_unidade", "visitante_recorrente",
    ]);
    expect(customerProfileDeclarations.condominio.personTypes?.find((p) => p.key === "dependente")?.projection).toBe("private");
    for (const moduleId of ["saude", "ensino", "juridico"]) {
      const contributions = customerProfileDeclarations[moduleId].contributions;
      expect(contributions).toHaveLength(1);
      expect(contributions[0]).toMatchObject({ kind: "section", component: "private.navigation", policy: "private" });
      expect(contributions[0].columns).toBeUndefined();
    }
    expect(JSON.stringify(customerProfileDeclarations)).not.toMatch(/Fagoo|diagn[oó]stico|respostas|checkin_answers/);
    expect(customerProfileDeclarations.erp.contributions.every((c) => c.policy === "erp")).toBe(true);
  });
  it("usa o estado compartilhado por área e não acessa o Coordinator", async () => {
    const { env, prepare, erpCall } = isolatedEnv();
    const rows: Record<string, { module_id: string; enabled: number }[]> = {
      on: [{ module_id: "erp", enabled: 1 }], off: [{ module_id: "erp", enabled: 0 }],
    };
    prepare.mockImplementation(() => ({ bind: (area: string) => ({ all: async () => ({ results: rows[area] ?? [] }) }) }) as never);
    const scoped = withReadCache(env);
    await moduleStates(scoped, "on");
    expect(await isFullCustomerEnabled(scoped, "on")).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await isFullCustomerEnabled(scoped, "off")).toBe(false);
    expect(await isFullCustomerEnabled(scoped, "new")).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(erpCall).not.toHaveBeenCalled();
  });
});

describe("fachadas permanentes", () => {
  it("ausência não afirma sucesso nem consulta D1/ERP", async () => {
    const p = await import("../src/customer/ports");
    const { env, prepare, erpCall } = isolatedEnv();
    expect(await p.resolveCustomer(env, conversation())).toEqual(ready({
      state: "pending", contactId: null, verifiedPhone: null, version: null,
    }));
    expect(await p.resolveCustomer(env, conversation({ external_namespace: "app:integration" })))
      .toMatchObject({ namespace: "app:integration", state: "pending", verifiedPhone: null });
    expect(await p.identityPort.prepareInbound(env, conversation(), { provider: "qr", phone: "5511987654321" }))
      .toEqual({ state: "pending", verifiedPhone: null, statements: [] });
    const missing = { status: 503, code: "dependency_unavailable" };
    const budget = { remainingStatements: 40, remainingItems: 20 };
    for (const call of [
      () => p.identityPort.indexContact(env, { profileId: "area", namespace: "team", contactId: "contact", phones: [], origin: "local" }),
      () => p.enrichCustomer(env, actor, conversation(), input),
      () => p.writePort.enrich(env, actor, "area", "contact", input),
      () => p.writePort.maintain(env, "area", budget),
      () => p.historyPort.read(env, actor, "area", { contactId: "contact" }, {}),
      () => p.historyPort.memory(env, actor, conversation()),
      () => p.historyPort.maintain(env, "area", budget),
      () => p.profilePort.view(env, actor, "area", "contact"),
      () => p.profilePort.collection(env, actor, "area", "contact", "os", "works", { limit: 25 }),
      () => p.profilePort.section(env, actor, "area", "contact", "saude", "private"),
      () => p.profilePort.saveSection(env, actor, "area", "contact", "condominio", "units", { commandId: "cmd", expectedVersion: 1, data: null }),
      () => p.erpBridge.read(env, actor, "area", "erp"),
      () => p.erpBridge.scan(env, "area", null, 20),
    ]) await expect(call()).rejects.toMatchObject(missing);
    expect(await p.erpBridge.apply(env, command)).toEqual({ status: "paused", reason: "awaiting_proof" });
    expect(await p.identityPort.maintain(env, "area", budget)).toEqual({ pending: true, statements: 0, items: 0 });
    expect(await p.maintainCustomers(env, "area", budget)).toEqual({ pending: true, statements: 0, items: 0 });
    expect(p.customerProvider("os")).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(erpCall).not.toHaveBeenCalled();
  });
  it("referências capturadas delegam após registro e recusam substituição", async () => {
    const p = await import("../src/customer/ports");
    const captured = [p.identityPort, p.writePort, p.historyPort, p.profilePort, p.erpBridge];
    const i = identity(), w = writer(), h = history(), f = profile(), b = bridge();
    p.installIdentityPort(i); p.installIdentityPort(i);
    p.installWritePort(w); p.installWritePort(w);
    p.installHistoryPort(h); p.installHistoryPort(h);
    p.installProfilePort(f); p.installProfilePort(f);
    p.installErpBridge(b); p.installErpBridge(b);
    for (const install of [
      () => p.installIdentityPort(identity()), () => p.installWritePort(writer()),
      () => p.installHistoryPort(history()), () => p.installProfilePort(profile()),
      () => p.installErpBridge(bridge()),
    ]) expect(install).toThrow(/já registrada/);
    expect(captured).toEqual([p.identityPort, p.writePort, p.historyPort, p.profilePort, p.erpBridge]);
    const { env, erpCall } = isolatedEnv();
    expect(await p.resolveCustomer(env, conversation())).toEqual(ready());
    expect(await p.enrichCustomer(env, actor, conversation(), input)).toMatchObject({ version: 2 });
    expect(w.enrich).toHaveBeenCalledWith(env, actor, "area", "contact", input);
    await p.historyPort.read(env, actor, "area", { contactId: "contact" }, { limit: 20 });
    expect(h.read).toHaveBeenCalledWith(env, actor, "area", { contactId: "contact" }, { limit: 20 });
    await p.profilePort.view(env, actor, "area", "contact");
    expect(f.view).toHaveBeenCalledWith(env, actor, "area", "contact");
    expect(b.apply).not.toHaveBeenCalled();
    expect(await p.erpBridge.apply(env, command)).toMatchObject({ status: "applied", snapshot });
    expect(b.apply).toHaveBeenCalledWith(env, command);
    const provider = { list: vi.fn(async () => ({ items: [], nextCursor: null, incomplete: false })) };
    p.registerCustomerProvider("os", provider); p.registerCustomerProvider("os", provider);
    expect(p.customerProvider("os")).toBe(provider);
    expect(() => p.registerCustomerProvider("os", { ...provider })).toThrow(/já registrada/);
    expect(erpCall).not.toHaveBeenCalled();
  });
  it("cacheia só na invocação, revalida mudanças e não guarda falha", async () => {
    const p = await import("../src/customer/ports");
    const i = identity(); p.installIdentityPort(i);
    const { env } = isolatedEnv(), scoped = withReadCache(env), conv = conversation();
    const [first, second] = await Promise.all([p.resolveCustomer(scoped, conv), p.resolveCustomer(scoped, { ...conv })]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(i.resolve).toHaveBeenCalledTimes(1);
    await p.resolveCustomer(scoped, { ...conv, phone: "551187654321" });
    await p.resolveCustomer(scoped, { ...conv, customer_link_state: "blocked" });
    await p.resolveCustomer(withReadCache(env), conv);
    await p.resolveCustomer(env, conv); await p.resolveCustomer(env, conv);
    expect(i.resolve).toHaveBeenCalledTimes(6);
    await p.identityPort.indexContact(scoped, { profileId: "area", namespace: "team", contactId: "contact", phones: [], origin: "local" });
    await p.resolveCustomer(scoped, conv);
    expect(i.resolve).toHaveBeenCalledTimes(7);
    await p.identityPort.prepareInbound(scoped, conv, { provider: "qr", phone: conv.phone });
    vi.mocked(i.resolve).mockRejectedValueOnce(new Error("falha temporária"));
    await expect(p.resolveCustomer(scoped, conv)).rejects.toThrow("falha temporária");
    expect(await p.resolveCustomer(scoped, conv)).toEqual(ready());
    expect(i.resolve).toHaveBeenCalledTimes(9);
  });
  it("enriquecimento exige identidade pronta, área e namespace corretos", async () => {
    const p = await import("../src/customer/ports");
    const i = identity(), w = writer(); p.installIdentityPort(i); p.installWritePort(w);
    const { env } = isolatedEnv();
    for (const [ref, code] of [
      [ready({ state: "ambiguous", contactId: null }), "customer_ambiguous"],
      [ready({ state: "pending", contactId: null }), "contact_required"],
      [ready({ state: "blocked" }), "contact_required"],
      [ready({ state: "excluded" }), "not_found"],
      [ready({ profileId: "other" }), "not_found"],
      [ready({ namespace: "app:other" }), "not_found"],
    ] as const) {
      vi.mocked(i.resolve).mockResolvedValueOnce(ref);
      await expect(p.enrichCustomer(env, actor, conversation(), input)).rejects.toMatchObject({ code });
    }
    expect(w.enrich).not.toHaveBeenCalled();
  });
  it("contact é projeção compatível sobre o mesmo resolvedor", async () => {
    const p = await import("../src/customer/ports");
    const { modulesApi } = await import("../src/modules/api");
    const i = identity(), w = writer(); p.installIdentityPort(i); p.installWritePort(w);
    const { env, prepare, erpCall } = isolatedEnv();
    const summary = { id: "contact", name: "Ana", phone: "5511987654321", email: "", company: "", notes: "Local" };
    prepare.mockImplementation((sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => {
      expect(sql).not.toContain("conversation_contacts");
      if (sql.includes("FROM conversations")) return conversation();
      expect(args).toEqual(["contact", "area", "team"]);
      expect(sql).toContain("identity_state='active'");
      return summary;
    } }) }) as never);
    const ctx = modulesApi(withReadCache(env), "area", "os");
    await ctx.customer(conversation());
    expect(await ctx.contact(conversation())).toEqual(summary);
    expect(await ctx.contact("conversation")).toEqual(summary);
    expect(i.resolve).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(3); // projeção, conversa por ID, projeção
    await ctx.enrichCustomer(actor, conversation(), input);
    expect(w.enrich).toHaveBeenCalledTimes(1);
    expect(() => ctx.customer(conversation({ profile_id: "other" }))).toThrow(/outra área/);
    const worker = modulesApi(env, "area", "os", { worker: true });
    expect(() => worker.enrichCustomer(actor, conversation(), input)).toThrow(/Coordinator/);
    vi.mocked(i.resolve).mockResolvedValue(ready({ state: "blocked" }));
    expect(await ctx.contact(conversation())).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(erpCall).not.toHaveBeenCalled();
  });
});

describe("manutenção compartilhada", () => {
  it("distribui saldo, limita 40/20 e deixa participantes sem saldo pendentes", async () => {
    const p = await import("../src/customer/ports");
    const i = identity(), w = writer(), h = history();
    const visit = vi.fn();
    const consume = (name: string, statements: number, items: number) =>
      vi.fn(async (_env: Env, _profile: string, budget: MaintenanceBudget) => {
        visit(name, { ...budget });
        // Mutar a cópia recebida não debita o orçamento duas vezes.
        budget.remainingStatements -= statements; budget.remainingItems -= items;
        return { pending: false, statements, items };
      });
    i.maintain = consume("identity", 5, 2); w.maintain = consume("write", 10, 4); h.maintain = consume("history", 3, 1);
    p.installIdentityPort(i); p.installWritePort(w); p.installHistoryPort(h);
    const skipped = { maintain: consume("z", 1, 1) };
    p.registerCustomerProvider("z", skipped);
    p.registerCustomerProvider("a", { maintain: consume("a", 22, 13) });
    const budget = { remainingStatements: 100, remainingItems: 100 };
    const { env, erpCall } = isolatedEnv();
    expect(await p.maintainCustomers(env, "area", budget)).toEqual({ pending: true, statements: 40, items: 20 });
    expect(visit.mock.calls).toEqual([
      ["identity", { remainingStatements: 40, remainingItems: 20 }],
      ["write", { remainingStatements: 35, remainingItems: 18 }],
      ["history", { remainingStatements: 25, remainingItems: 14 }],
      ["a", { remainingStatements: 22, remainingItems: 13 }],
    ]);
    expect(skipped.maintain).not.toHaveBeenCalled();
    expect(budget).toEqual({ remainingStatements: 100, remainingItems: 100 });
    expect(erpCall).not.toHaveBeenCalled();
  });
  it("recusa consumo inválido, não executa sem saldo e informa conclusão real", async () => {
    const p = await import("../src/customer/ports");
    const i = identity(); p.installIdentityPort(i); p.installWritePort(writer()); p.installHistoryPort(history());
    const { env } = isolatedEnv();
    expect(await p.maintainCustomers(env, "area", { remainingStatements: 40, remainingItems: 20 })).toEqual(done());
    vi.mocked(i.maintain).mockClear();
    expect(await p.maintainCustomers(env, "area", { remainingStatements: 0, remainingItems: 20 })).toMatchObject({ pending: true });
    expect(i.maintain).not.toHaveBeenCalled();
    await expect(p.maintainCustomers(env, "area", { remainingStatements: -1, remainingItems: 20 })).rejects.toMatchObject({ code: "invalid_request" });
    vi.mocked(i.maintain).mockResolvedValue({ pending: false, statements: 41, items: 1 });
    await expect(p.maintainCustomers(env, "area", { remainingStatements: 40, remainingItems: 20 })).rejects.toThrow(/excedeu/);
  });
});

describe("hospedeiro tardio", () => {
  it("ausência falha, registro é exclusivo e null limpa ao descartar a área", async () => {
    const p = await import("../web/contact-profile/host-port");
    await expect(p.loadFullCustomerHost()).rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
    const host = { mount: vi.fn(async () => ({ dispose: vi.fn() })) };
    const loader = vi.fn(async () => host);
    p.installFullCustomerHost(loader); p.installFullCustomerHost(loader);
    expect(loader).not.toHaveBeenCalled();
    expect(() => p.installFullCustomerHost(async () => host)).toThrow(/já registrado/);
    const loaded = await Promise.all([p.loadFullCustomerHost(), p.loadFullCustomerHost()]);
    expect(loaded).toEqual([host, host]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(host.mount).not.toHaveBeenCalled();
    p.installFullCustomerHost(null);
    await expect(p.loadFullCustomerHost()).rejects.toMatchObject({ code: "dependency_unavailable" });
    const retry = vi.fn(async () => host).mockRejectedValueOnce(new Error("carregamento"));
    p.installFullCustomerHost(retry);
    await expect(p.loadFullCustomerHost()).rejects.toThrow("carregamento");
    expect(await p.loadFullCustomerHost()).toBe(host);
    expect(retry).toHaveBeenCalledTimes(2);
  });
});
