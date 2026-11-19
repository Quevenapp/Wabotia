import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, Env } from "../src/types";
import type { CustomerModuleProvider } from "../src/customer/profile-contracts";
import { modules } from "../src/modules/registry";
import { withReadCache } from "../src/db";

// As implementações das outras frentes entram exclusivamente pelas portas.
vi.mock("../src/modules/runtime", () => ({}));
vi.mock("../src/service", () => ({
  conversation: vi.fn(), conversationByPhone: vi.fn(), enqueue: vi.fn(), handoff: vi.fn(),
  handoffToPerson: vi.fn(), message: vi.fn(), perform: vi.fn(), settings: vi.fn(),
}));
beforeEach(() => vi.resetModules());

const actor: Actor = { id: "person", kind: "user", role: "operator", name: "Pessoa", profiles: ["area"],
  access: ["contacts", "agenda"], scopes: [], bots: [], sessionId: "session", rate: 100, runLimit: 1 };
type Contact = { id: string; profile_id: string; namespace: string; erp_contact_id: string | null; identity_state: string };
function fixture(enabled: string[] = [], config: Record<string, unknown> = {}, template: string | null = null) {
  const rows: Contact[] = [
    { id: "contact", profile_id: "area", namespace: "team", erp_contact_id: null, identity_state: "active" },
    { id: "second", profile_id: "area", namespace: "team", erp_contact_id: null, identity_state: "active" },
    { id: "application", profile_id: "area", namespace: "app:other", erp_contact_id: null, identity_state: "active" },
    { id: "restricted", profile_id: "area", namespace: "team", erp_contact_id: null, identity_state: "restricted" },
    { id: "erasing", profile_id: "area", namespace: "team", erp_contact_id: null, identity_state: "erasing" },
    { id: "foreign", profile_id: "other", namespace: "team", erp_contact_id: null, identity_state: "active" },
  ];
  const erpCall = vi.fn(() => { throw new Error("Não pode acordar o ERP"); });
  const prepare = vi.fn((sql: string) => ({ bind: (...args: unknown[]) => ({
    first: async () => {
      if (sql.includes("FROM contacts")) {
        expect(sql).toContain("namespace='team'");
        expect(sql).not.toContain("SELECT *");
        return rows.find(row => row.id === args[0] && row.profile_id === args[1] && row.namespace === "team") ?? null;
      }
      if (sql === "SELECT settings FROM profiles WHERE id=?") return { settings: JSON.stringify(config) };
      if (sql.includes("FROM os_area_template_applications")) return template ? { template_id: template } : null;
      throw new Error("Consulta não esperada: " + sql);
    },
    all: async () => {
      expect(sql).toBe("SELECT module_id,enabled FROM profile_modules WHERE profile_id=?");
      return { results: modules.map(module => ({ module_id: module.id, enabled: Number(enabled.includes(module.id)) })) };
    },
  }) }));
  const env = withReadCache({ DB: { prepare }, MASTER_KEY: "test-master-key-00000000000000000000",
    COORDINATOR: { idFromName: erpCall, get: erpCall, getByName: erpCall } } as unknown as Env);
  return { env, rows, prepare, erpCall };
}
const provider = (): CustomerModuleProvider => ({
  list: vi.fn(async () => ({ items: [{ id: "row", cells: { id: "row", status: "open", occurredAt: 100 },
    target: { module: "agenda", resource: "appointments", id: "row" } }], nextCursor: "source-cutoff:last-key", incomplete: false })),
  section: vi.fn(async () => ({ version: 4, writable: true, schema: "condominio.units.v1" as const, data: { units: [{ unitId: "unit", role: "morador" }] } })),
  saveSection: vi.fn(async (_ctx, _actor, _contact, _section, input) => ({ version: input.expectedVersion + 1,
    writable: true, schema: "condominio.units.v1" as const, data: input.data, replayed: false })),
});
async function service(moduleId = "agenda", implementation = provider()) {
  const ports = await import("../src/customer/ports");
  const { createProfilePort } = await import("../src/customer/profile");
  ports.installProfilePort(createProfilePort());
  ports.registerCustomerProvider(moduleId, implementation);
  return { port: ports.profilePort, provider: implementation, ports };
}

describe("ficha autorizada por ID D1", () => {
  it("tudo desligado mantém a ficha simples, o espelho e zero chamadas ERP", async () => {
    const f = fixture([], { os_vocabulary: { customer_singular: "Morador", customer_plural: "Moradores" } });
    f.rows[0].erp_contact_id = "different-erp-id";
    const { port, provider: p } = await service("erp");
    expect(await port.view(f.env, actor, "area", "contact")).toEqual({
      profileId: "area", contactId: "contact", erpContactId: "different-erp-id", depth: "simple", writable: true,
      vocabulary: { singular: "Morador", plural: "Moradores" }, contributions: [],
    });
    await expect(port.collection(f.env, actor, "area", "contact", "erp", "sales", { limit: 25 })).rejects.toMatchObject({ status: 409, code: "module_disabled" });
    expect(p.list).not.toHaveBeenCalled(); expect(f.erpCall).not.toHaveBeenCalled();
  });
  it("abrir sem vínculo não promove mesmo com cadastro completo ligado", async () => {
    const f = fixture(["erp"]), { port, provider: p } = await service("erp");
    expect(await port.view(f.env, { ...actor, access: ["contacts", "erp:vendas"] }, "area", "contact"))
      .toMatchObject({ depth: "simple", erpContactId: null, contributions: [] });
    expect(p.list).not.toHaveBeenCalled(); expect(f.erpCall).not.toHaveBeenCalled();
  });
  it("conserva namespace, área e identidade restrita antes de chamar o provedor", async () => {
    const f = fixture(["agenda"]), { port, provider: p } = await service();
    for (const id of ["application", "restricted", "erasing", "foreign", "missing"]) {
      await expect(port.view(f.env, actor, "area", id)).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(port.collection(f.env, actor, "area", id, "agenda", "appointments", { limit: 25 })).rejects.toMatchObject({ status: 404 });
    }
    await expect(port.view(f.env, actor, "other", "foreign")).rejects.toMatchObject({ status: 404 });
    for (const kind of ["app", "connector"] as const) await expect(port.view(f.env, { ...actor, kind, scopes: ["contacts:read"] }, "area", "contact"))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(p.list).not.toHaveBeenCalled();
  });
  it("contatos:read e estrela não concedem papel ERP ou política privada", async () => {
    const f = fixture(["erp", "saude", "os"]); f.rows[0].erp_contact_id = "erp-id";
    const { port, provider: p } = await service("erp");
    const generic = { ...actor, access: ["*"] };
    expect(await port.view(f.env, generic, "area", "contact")).toMatchObject({ depth: "simple" });
    await expect(port.collection(f.env, generic, "area", "contact", "erp", "sales", { limit: 25 })).rejects.toMatchObject({ status: 403 });
    await expect(port.section(f.env, generic, "area", "contact", "saude", "private")).rejects.toMatchObject({ status: 403 });
    expect(p.list).not.toHaveBeenCalled();
  });
  it("ERP mantém permissões distintas para vendas e finanças", async () => {
    const f = fixture(["erp"]); f.rows[0].erp_contact_id = "erp-id";
    const { port, provider: p } = await service("erp");
    const seller = { ...actor, access: ["erp:vendas"] };
    const view = await port.view(f.env, seller, "area", "contact");
    expect(view).toMatchObject({ depth: "full", writable: true });
    expect(view.contributions.map(item => item.id)).toEqual(["sales"]);
    await expect(port.collection(f.env, seller, "area", "contact", "erp", "ledger", { limit: 25 })).rejects.toMatchObject({ status: 403 });
    expect(p.list).not.toHaveBeenCalled();
    await port.collection(f.env, seller, "area", "contact", "erp", "sales", { limit: 25 });
    expect(p.list).toHaveBeenCalledTimes(1);
  });
  it("valida módulo, contribuição, dependências e permissão antes da execução", async () => {
    const f = fixture(["agenda", "condominio", "os"]), { port, provider: p, ports } = await service();
    const condo = provider(); ports.registerCustomerProvider("condominio", condo);
    await expect(port.collection(f.env, actor, "area", "contact", "constructor", "appointments", { limit: 25 })).rejects.toMatchObject({ status: 404 });
    await expect(port.collection(f.env, actor, "area", "contact", "agenda", "sql-from-client", { limit: 25 })).rejects.toMatchObject({ status: 404 });
    await expect(port.section(f.env, actor, "area", "contact", "agenda", "appointments")).rejects.toMatchObject({ status: 404 });
    await expect(port.collection(f.env, { ...actor, access: ["contacts"] }, "area", "contact", "agenda", "appointments", { limit: 25 })).rejects.toMatchObject({ status: 403 });
    await expect(port.collection(f.env, { ...actor, access: ["condominio:admin", "mensalidade"] }, "area", "contact", "condominio", "dues", { limit: 25 }))
      .rejects.toMatchObject({ status: 409, code: "module_disabled" });
    expect(p.list).not.toHaveBeenCalled(); expect(condo.list).not.toHaveBeenCalled();
  });
  it("cursor autenticado não pode trocar contato, área, contribuição, pessoa, sessão ou limite", async () => {
    const f = fixture(["agenda", "pedido"]), { port, provider: p, ports } = await service();
    const orders = provider(); ports.registerCustomerProvider("pedido", orders);
    const both = { ...actor, access: ["contacts", "agenda", "pedido"], profiles: ["area", "other"] };
    const page = await port.collection(f.env, both, "area", "contact", "agenda", "appointments", { limit: 25 });
    expect(page.nextCursor).not.toContain("source-cutoff");
    const query = { limit: 25, cursor: page.nextCursor! };
    for (const call of [
      () => port.collection(f.env, both, "area", "second", "agenda", "appointments", query),
      () => port.collection(f.env, both, "other", "foreign", "agenda", "appointments", query),
      () => port.collection(f.env, both, "area", "contact", "pedido", "orders", query),
      () => port.collection(f.env, { ...both, id: "other-person" }, "area", "contact", "agenda", "appointments", query),
      () => port.collection(f.env, { ...both, sessionId: "new-session" }, "area", "contact", "agenda", "appointments", query),
      () => port.collection(f.env, both, "area", "contact", "agenda", "appointments", { ...query, limit: 50 }),
      () => port.collection(f.env, both, "area", "contact", "agenda", "appointments", { ...query, cursor: btoa('{"binding":"forged"}') }),
    ]) await expect(call()).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    expect(p.list).toHaveBeenCalledTimes(1); expect(orders.list).not.toHaveBeenCalled();
    await port.collection(f.env, both, "area", "contact", "agenda", "appointments", query);
    expect(p.list).toHaveBeenLastCalledWith(expect.objectContaining({ profile: "area" }), both, "contact", "appointments", { limit: 25, cursor: "source-cutoff:last-key" });
  });
  it("seção usa versão própria e papel da extensão sem liberar cadastro", async () => {
    const f = fixture(["condominio", "os"]), { port, provider: p } = await service("condominio");
    const concierge = { ...actor, access: ["condominio:portaria"] }, admin = { ...actor, access: ["condominio:admin"] };
    expect(await port.section(f.env, concierge, "area", "contact", "condominio", "units")).toMatchObject({ version: 4, writable: false });
    const input = { commandId: "section-command", expectedVersion: 4, data: { units: [] } };
    await expect(port.saveSection(f.env, concierge, "area", "contact", "condominio", "units", input)).rejects.toMatchObject({ status: 403 });
    expect(p.saveSection).not.toHaveBeenCalled();
    expect(await port.view(f.env, admin, "area", "contact")).toMatchObject({ writable: false });
    expect(await port.saveSection(f.env, admin, "area", "contact", "condominio", "units", input)).toMatchObject({ version: 5, replayed: false });
    expect(p.saveSection).toHaveBeenCalledWith(expect.anything(), admin, "contact", "units", input);
  });
  it("projeta somente navegação privada e recusa salvar essa seção", async () => {
    const f = fixture(["ensino", "os"]), p = provider();
    p.section = vi.fn(async () => ({ version: 1, writable: true, schema: "private.navigation.v1" as const, data: {
      target: { module: "ensino", resource: "guardians", id: "adult-id" }, privateName: "não deve sair", count: 30,
    } }));
    const { port } = await service("ensino", p), secretary = { ...actor, access: ["ensino:secretaria"] };
    expect(await port.section(f.env, secretary, "area", "contact", "ensino", "private")).toEqual({ version: 1, writable: false,
      schema: "private.navigation.v1", data: { target: { module: "ensino", resource: "guardians", id: "adult-id" } } });
    await expect(port.saveSection(f.env, secretary, "area", "contact", "ensino", "private", { commandId: "x", expectedVersion: 1, data: null }))
      .rejects.toMatchObject({ status: 403 });
    expect(p.saveSection).not.toHaveBeenCalled();
  });
  it("provedor ausente é dependência indisponível e o vocabulário funciona sem OS", async () => {
    const f = fixture(["agenda"], { os_area_setup: [{ template_id: "condominios" }] });
    const { port } = await service("pedido");
    await expect(port.collection(f.env, actor, "area", "contact", "agenda", "appointments", { limit: 25 }))
      .rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
    const view = await port.view(f.env, actor, "area", "contact");
    expect(view.vocabulary.singular).toBe("Morador ou responsável");
  });
  it("falha transitória é 503, sem alterar a lista de contribuições autorizadas", async () => {
    const f = fixture(["agenda"]), { port, provider: p } = await service();
    vi.mocked(p.list!).mockRejectedValueOnce(new Error("indisponível"));
    await expect(port.collection(f.env, actor, "area", "contact", "agenda", "appointments", { limit: 25 }))
      .rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
    expect((await port.view(f.env, actor, "area", "contact")).contributions.map(item => item.id)).toEqual(["appointments"]);
    expect((await port.collection(f.env, actor, "area", "contact", "agenda", "appointments", { limit: 25 })).items).toHaveLength(1);
  });
  it("modelo aplicado sem sugestões de bot é fallback e configuração explícita tem prioridade", async () => {
    const { port } = await service();
    const model = fixture([], {}, "condominios");
    expect((await port.view(model.env, actor, "area", "contact")).vocabulary.singular).toBe("Morador ou responsável");
    const explicit = fixture([], { os_vocabulary: { customer_singular: "Pessoa", customer_plural: "Pessoas", collection_label: "Solicitações" } }, "condominios");
    expect((await port.view(explicit.env, actor, "area", "contact")).vocabulary).toEqual({ singular: "Pessoa", plural: "Pessoas" });
    expect(explicit.prepare.mock.calls.some(([sql]) => sql.includes("os_area_template_applications"))).toBe(false);
  });
});
