import React from "react";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { erpFetch, erpStub } from "../src/erp/hub";
import { FISCAL_MODULE_HEADER } from "../src/erp/engine/module-state";
import { SYSTEM_HEADER, IDENTITY_HEADER, encodeIdentity } from "../src/erp/engine/identity";
import { erpIdentity } from "../src/modules/erp/identity";
import { handleRpc } from "../src/erp/engine/rpc-endpoint";
import { bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { portedTargetState } from "../web/management/ported-policy";
import { blockOf, erpPartEnabled } from "../web/erp/modules";
import { setErpBlocks, targetEnabled } from "../web/erp/blocks";
import { setMotorReal } from "../web/erp/motor";
import ProductTaxonomy from "../web/erp/app/components/ProductTaxonomy";
import { AccessError } from "../web/erp/app/lib/real-access";

// Executa os handlers e efeitos reais sem DOM. A API abaixo usa o Worker e o DO reais.
const ui = vi.hoisted(() => ({ owner: null as any, search: "" }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const useState = (initial: any) => {
    const owner = ui.owner, index = owner.index++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[index], (value: any) => {
      const next = typeof value === "function" ? value(owner.slots[index]) : value;
      if (!Object.is(next, owner.slots[index])) { owner.slots[index] = next; owner.dirty = true; }
    }];
  };
  return { ...actual, useState, useRef: (value: any) => useState(() => ({ current: value }))[0],
    useEffect: (fn: () => any, deps: unknown[]) => {
      const owner = ui.owner, index = owner.index++, old = owner.slots[index];
      if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        const slot = { deps, cleanup: old?.cleanup }; owner.slots[index] = slot;
        owner.effects.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
      }
    },
  };
});
vi.mock("react-router-dom", async original => ({
  ...await original<typeof import("react-router-dom")>(),
  useLocation: () => ({ pathname: "/tags", search: ui.search, hash: "" }),
}));
vi.mock("../web/erp/app/hooks/useUnsavedChanges", () => ({
  useUnsavedChanges: () => ({ confirmLeave: (run: () => void) => run() }),
}));
afterEach(() => {
  for (const slot of ui.owner?.slots ?? []) slot?.cleanup?.();
  ui.owner = null; ui.search = "";
  setErpBlocks(null); setMotorReal(false);
});

const aliases = ["/tags", "/grupos-tags", "/preferencias/suprimentos/tags", "/preferencias/suprimentos/grupos-tags"];
const management = (fiscal: boolean, erpRole = "admin") => ({
  statusLoaded: true, role: "admin", access: null, erpRole,
  modules: { erp: true, "erp-produtos": true, "erp-fiscal": fiscal },
} as any);
describe("A5: destinos completos de taxonomias", () => {
  it("notas e aliases exigem núcleo, Fiscal e permissão; a classificação fiscal é respeitada", () => {
    setMotorReal(false);
    for (const path of aliases) {
      const to = `${path}?tipo=notas`;
      expect(blockOf(to)).toBe("erp-fiscal");
      expect(portedTargetState(to, management(false))).toBe("disabled");
      expect(portedTargetState(to, management(true))).toBe("allowed");
      expect(portedTargetState(to, management(true, "vendas"))).toBe("denied");
      setErpBlocks({ erp: true, "erp-fiscal": false });
      expect(targetEnabled(to)).toBe(false);
      setErpBlocks({ erp: true, "erp-fiscal": true });
      expect(targetEnabled(to)).toBe(true);
      expect(erpPartEnabled("fiscal", { erp: false, "erp-fiscal": true }, to)).toBe(false);
    }
    expect(erpPartEnabled("fiscal", { erp: true }, "/tags")).toBe(false);
  });
  it("produtos, contatos, listas mistas e exceções de destino conservam seu acesso", () => {
    for (const path of aliases) for (const tipo of ["", "produtos", "contatos"]) {
      const to = `${path}?tipo=${tipo}`;
      expect(blockOf(to)).toBe(tipo === "produtos" ? "erp-produtos" : "erp");
      for (const role of ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal"]) {
        expect(portedTargetState(to, management(false, role))).toBe(portedTargetState(to, management(true, role)));
      }
      expect(portedTargetState(to, management(false))).toBe("allowed");
      expect(portedTargetState(to, { ...management(false), modules: { erp: true } })).toBe(tipo === "produtos" ? "disabled" : "allowed");
    }
    expect(erpPartEnabled("financeiro", { erp: true }, "/financeiro-empresa?area=borderos")).toBe(false);
    expect(erpPartEnabled("financeiro", { erp: true, "erp-financeiro": true }, "/financeiro-empresa?area=borderos")).toBe(true);
    expect(erpPartEnabled("financeiro", { erp: true }, "/financeiro-empresa?area=remessas")).toBe(false);
    expect(erpPartEnabled("sistema", { erp: true }, "/preferencias/contabilidade/meu-contador")).toBe(false);
    expect(erpPartEnabled("sistema", { erp: true, "erp-financeiro": true }, "/preferencias/contabilidade/meu-contador")).toBe(true);
    expect(erpPartEnabled("pdv", { erp: true }, "/frente-caixa-empresa")).toBe(false);
  });
});

const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes)
  : React.isValidElement(tree) ? [tree, ...nodes((tree.props as any).children)] : [];
const text = (tree: any): string => Array.isArray(tree) ? tree.map(text).join("")
  : React.isValidElement(tree) ? text((tree.props as any).children) : tree == null || typeof tree === "boolean" ? "" : String(tree);
const tax = (kind: string, type: string) => ({
  id: `c2000000-0000-4000-8000-0000000000${kind === 'tags' ? '1' : '2'}${["products", "contacts", "invoices"].indexOf(type)}`,
  kind, tag_type: type, name: `${kind} ${type}`, version: 1, parent_id: null,
  created_at: "2026-11-19T12:00:00Z", updated_at: "2026-11-19T12:00:00Z", children: 0, products: 0, contacts: 0, invoices: 0,
});
async function screen(kind: "tags" | "tag_groups", write = async () => ({ saved: true })) {
  const owner = { index: 0, slots: [] as any[], effects: [] as (() => void)[], dirty: true };
  ui.owner = owner;
  const writes: any[] = [];
  let failRead = false;
  const controller = {
    getSnapshot: () => ({ phase: "ready", membership: { user_id: "admin", role: "admin" } }),
    catalog: async (path: string, options: any = {}) => {
      if (options.method) { writes.push({ path, ...options }); return write(); }
      if (failRead) throw new AccessError(503);
      if (path === "/v1/cadastros") return { read: ["products", "contacts"], write: ["products", "contacts"] };
      const kind = path.endsWith("grupos-tags") ? "tag_groups" : "tags";
      // Deliberadamente inclui notas mesmo desligado, como uma resposta antiga.
      return { kind, items: ["products", "contacts", "invoices"].map(type => tax(kind, type)), data_mode: "erp_native" };
    },
  };
  let tree: any;
  const flush = async () => {
    for (let i = 0; i < 40; i++) {
      if (owner.dirty) {
        owner.dirty = false; owner.index = 0;
        tree = ProductTaxonomy({ controller: controller as any, kind });
        while (owner.effects.length) owner.effects.shift()!();
      }
      await Promise.resolve();
    }
    expect(owner.dirty).toBe(false);
  };
  const find = (match: (node: any) => boolean) => {
    const found = nodes(tree).find(match); expect(found).toBeDefined(); return found!;
  };
  await flush();
  return { writes, flush, nodes: () => nodes(tree), text: () => text(tree),
    find, input: (id: string) => find(n => n.props.id === id),
    async click(label: string) { find(n => n.type === "button" && text(n) === label).props.onClick(); await flush(); },
    async change(id: string, value: string) { find(n => n.props.id === id).props.onChange({ target: { value } }); await flush(); },
    async rerender(fail = false) { failRead = fail; owner.dirty = true; await flush(); },
    async submit() { find(n => n.type === "form").props.onSubmit({ preventDefault() {} }); await flush(); },
  };
}
describe("A5: tela de taxonomias e comandos retidos", () => {
  for (const kind of ["tags", "tag_groups"] as const) it(`${kind}: lista mista, opções e grupos excluem Fiscal`, async () => {
    setErpBlocks({ erp: true, "erp-fiscal": false });
    const view = await screen(kind);
    expect(view.text()).toContain(`${kind} products`);
    expect(view.text()).toContain(`${kind} contacts`);
    expect(view.text()).not.toContain(`${kind} invoices`);
    expect(view.nodes().filter(n => n.type === "option").map(n => n.props.value)).not.toContain("invoices");
    await view.click(kind === "tags" ? "Incluir tag" : "Incluir grupo tag");
    expect(view.nodes().filter(n => n.type === "option").map(n => n.props.value)).not.toContain("invoices");
    if (kind === "tags") expect(text(view.input("taxonomy-group"))).not.toContain("tag_groups invoices");
    await view.change("taxonomy-name", "Produto preservado"); await view.submit();
    expect(view.writes).toHaveLength(1);
    expect(view.writes[0].body.data.tag_type).toBe("products");
  });
  it("desligar com edição, seleção e resposta antiga mantém o rascunho e impede enviar ou repetir", async () => {
    setErpBlocks({ erp: true, "erp-fiscal": true });
    const view = await screen("tags", async () => { throw new AccessError(503); });
    view.find(n => n.props["aria-label"] === "Selecionar tags invoices").props.onChange({ target: { checked: true } });
    await view.click("tags invoices");
    await view.change("taxonomy-name", "Rascunho fiscal");
    const retainedSubmit = view.find(n => n.type === "form").props.onSubmit;
    await view.submit();
    expect(view.text()).toContain("Conferir resultado");
    expect(view.writes).toHaveLength(1);
    setErpBlocks({ erp: true, "erp-fiscal": false });
    retainedSubmit({ preventDefault() {} });
    await view.rerender(true); // A releitura falha: nem assim a linha anterior reaparece.
    expect(view.writes).toHaveLength(1);
    expect(view.text()).toContain("Fiscal está desligado");
    expect(view.input("taxonomy-name").props.value).toBe("Rascunho fiscal");
    expect(view.nodes().filter(n => n.type === "option").map(n => n.props.value)).not.toContain("invoices");
    expect(view.nodes().some(n => n.type === "button" && text(n) === "tags invoices")).toBe(false);
    expect(view.find(n => n.props["aria-label"] === "Excluir selecionados").props.disabled).toBe(true);
    await view.submit(); expect(view.writes).toHaveLength(1);
    setErpBlocks({ erp: true, "erp-fiscal": true }); await view.rerender();
    expect(view.text()).toContain("Conferir resultado");
    await view.submit();
    expect(view.writes).toHaveLength(2);
    expect(view.writes[1].body.command_id).toBe(view.writes[0].body.command_id);
  });
  it("lote já aberto revalida antes do envio, inclusive com callback retido", async () => {
    setErpBlocks({ erp: true, "erp-fiscal": true });
    const view = await screen("tags");
    view.find(n => n.props["aria-label"] === "Selecionar tags invoices").props.onChange({ target: { checked: true } });
    await view.flush();
    view.find(n => n.props["aria-label"] === "Excluir selecionados").props.onClick(); await view.flush();
    const dialog = view.find(n => typeof n.props.run === "function");
    setErpBlocks({ erp: true, "erp-fiscal": false });
    await expect(dialog.props.run({ ...tax("tags", "invoices"), label: "Fiscal" })).rejects.toThrow("Fiscal está desligado");
    expect(view.writes).toHaveLength(0);
    await view.rerender(); expect(view.nodes().some(n => typeof n.props.run === "function")).toBe(false);
  });
  it("inclusão em andamento ignora resposta tardia e preserva o comando para quando Fiscal voltar", async () => {
    let finish!: (result: { saved: boolean }) => void;
    const pending = new Promise<{ saved: boolean }>(resolve => { finish = resolve; });
    setErpBlocks({ erp: true, "erp-fiscal": true });
    const view = await screen("tags", () => pending);
    await view.click("Incluir tag");
    await view.change("taxonomy-type", "invoices");
    await view.change("taxonomy-name", "Inclusão fiscal pendente");
    await view.submit();
    expect(view.writes).toHaveLength(1);
    setErpBlocks({ erp: true, "erp-fiscal": false }); await view.rerender();
    expect(view.writes[0].signal.aborted).toBe(true);
    finish({ saved: true }); await view.flush();
    expect(view.input("taxonomy-name").props.value).toBe("Inclusão fiscal pendente");
    expect(view.text()).toContain("Fiscal está desligado");
    await view.submit(); expect(view.writes).toHaveLength(1);
    setErpBlocks({ erp: true, "erp-fiscal": true }); await view.rerender();
    expect(view.text()).toContain("Conferir resultado");
    await view.submit();
    expect(view.writes).toHaveLength(2);
    expect(view.writes[1].body).toEqual(view.writes[0].body);
  });
});

async function apiFixture() {
  const f = await fixture(), token = await bearer(f.admin);
  await setModule(f.profile, "erp", true, f.admin.id);
  await setModule(f.profile, "erp-fiscal", true, f.admin.id);
  const call = async (path: string, method = "GET", body?: any, extra: Record<string, string> = {}) => {
    const response = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp/v1/cadastros/taxonomias/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json<any>() };
  };
  const create = async (slug: string, data: any) => {
    const body = { command_id: crypto.randomUUID(), data }, result = await call(slug, "POST", body);
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
    expect(result.body.saved).toBe(true);
    return { ...result.body.item, body };
  };
  const toggle = (on: boolean) => setModule(f.profile, "erp-fiscal", on, f.admin.id);
  const stored = () => runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) =>
    Object.fromEntries(["taxonomy", "taxonomy_audit", "command", "invoice_tag", "invoice_tag_state", "product_tag", "contact_tag"].map(table =>
      [table, state.storage.sql.exec(`SELECT * FROM "erp_catalog__${table}"`).toArray()])),
  );
  return { ...f, call, create, toggle, stored };
}
const denied = (result: { status: number; body: any }) => {
  expect(result.status, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error?.code).toBe("module_disabled");
  expect(result.body.item).toBeUndefined();
  expect(result.body.deleted).toBeUndefined();
  expect(result.body.replayed).toBeUndefined();
};
describe("A5: API real do Worker, ativação da área e idempotência", () => {
  it("omite notas, recusa tipo explícito/herdado e operações por ID, sem alterar dados ou vínculos", async () => {
    const f = await apiFixture();
    const fiscalGroup = await f.create("grupos-tags", { name: "Grupo fiscal", tag_type: "invoices" });
    const fiscalTag = await f.create("tags", { name: "Nota preservada", parent_id: fiscalGroup.id });
    for (const type of ["products", "contacts"]) {
      await f.create("grupos-tags", { name: type, tag_type: type });
      await f.create("tags", { name: type, tag_type: type });
    }
    // Vínculo sintético real: desligar não deve excluí-lo nem alterar sua versão.
    await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) => {
      state.storage.sql.exec('INSERT INTO "erp_catalog__invoice_tag"(origin,model,invoice_id,tag_id) VALUES(\'origin\',\'55\',\'123\',?)', fiscalTag.id);
      state.storage.sql.exec('INSERT INTO "erp_catalog__invoice_tag_state"(origin,model,invoice_id,version,updated_by,updated_at) VALUES(\'origin\',\'55\',\'123\',1,?,?)', f.admin.id, Date.now() * 1000);
    });
    const before = await f.stored();
    await f.toggle(false); // Sem executar o alarme/scheduler.
    for (const slug of ["tags", "grupos-tags"]) {
      const list = await f.call(slug);
      expect(list.status).toBe(200);
      expect(list.body.items.map((item: any) => item.tag_type).sort()).toEqual(["contacts", "products"]);
      denied(await f.call(slug, "POST", { command_id: crypto.randomUUID(), data: { name: "Recusado", tag_type: "invoices" } }));
    }
    denied(await f.call("tags", "POST", { command_id: crypto.randomUUID(), data: { name: "Herdada", parent_id: fiscalGroup.id } }));
    for (const [slug, item] of [["tags", fiscalTag], ["grupos-tags", fiscalGroup]] as const) {
      denied(await f.call(`${slug}/${item.id}`, "PATCH", { command_id: crypto.randomUUID(), expected_version: item.version, data: { name: "Renomeado" } }));
      denied(await f.call(`${slug}/${item.id}/excluir`, "POST", { command_id: crypto.randomUUID(), expected_version: item.version }));
    }
    const spoof = { [FISCAL_MODULE_HEADER]: "1", [SYSTEM_HEADER]: "1", "x-erp-modules": '{"fiscal":true}' };
    denied(await f.call("tags", "POST", { command_id: crypto.randomUUID(), data: { name: "Cabeçalho falso", tag_type: "invoices" } }, spoof));
    expect((await f.call("tags", "GET", undefined, spoof)).body.items.some((item: any) => item.tag_type === "invoices")).toBe(false);
    for (const extra of [{ modules: { fiscal: true } }, { fiscal: true }, { "erp-fiscal": true }]) {
      expect((await f.call("tags", "POST", { command_id: crypto.randomUUID(), data: { name: "Campo falso", tag_type: "invoices" }, ...extra })).status).toBe(400);
    }
    expect(await f.stored()).toEqual(before);
    await f.toggle(true);
    const restored = await f.call("tags");
    expect(restored.body.items.find((item: any) => item.id === fiscalTag.id)).toMatchObject({ name: "Nota preservada", parent_id: fiscalGroup.id, version: 1, invoices: 1 });
    expect(await f.stored()).toEqual(before);
  }, 120_000);

  it("recibos fiscais de inclusão, edição e exclusão não vazam; produtos e contatos repetem sem mutar", async () => {
    const f = await apiFixture();
    const group = await f.create("grupos-tags", { name: "Pai temporário", tag_type: "invoices" });
    const tag = await f.create("tags", { name: "Fiscal temporária", parent_id: group.id });
    const edit = { command_id: crypto.randomUUID(), expected_version: 1, data: { name: "Fiscal renomeada" } };
    expect((await f.call(`tags/${tag.id}`, "PATCH", edit)).body.saved).toBe(true);
    const remove = { command_id: crypto.randomUUID(), expected_version: 2 };
    expect((await f.call(`tags/${tag.id}/excluir`, "POST", remove)).body.deleted).toBe(true);
    expect((await f.call(`grupos-tags/${group.id}/excluir`, "POST", { command_id: crypto.randomUUID(), expected_version: 1 })).body.deleted).toBe(true);
    const others: any[] = [];
    for (const type of ["products", "contacts"]) {
      const item = await f.create("tags", { name: type, tag_type: type });
      const remove = { command_id: crypto.randomUUID(), expected_version: 1 };
      expect((await f.call(`tags/${item.id}/excluir`, "POST", remove)).body.deleted).toBe(true);
      others.push({ item, remove });
    }
    await f.toggle(false);
    const before = await f.stored();
    // Nem registro nem pai existem: a guarda precisa conferir o recibo/auditoria.
    denied(await f.call("tags", "POST", tag.body));
    denied(await f.call(`tags/${tag.id}`, "PATCH", edit));
    denied(await f.call(`tags/${tag.id}/excluir`, "POST", remove));
    for (const { item, remove } of others) {
      expect((await f.call("tags", "POST", item.body)).body).toMatchObject({ saved: true, replayed: true, item: { id: item.id } });
      expect((await f.call(`tags/${item.id}/excluir`, "POST", remove)).body).toMatchObject({ deleted: true, replayed: true });
    }
    expect(await f.stored()).toEqual(before);
    await f.toggle(true);
    expect((await f.call("tags", "POST", tag.body)).body).toMatchObject({ saved: true, replayed: true, item: { id: tag.id, tag_type: "invoices" } });
    expect((await f.call(`tags/${tag.id}/excluir`, "POST", remove)).body).toMatchObject({ deleted: true, replayed: true });
    expect(await f.stored()).toEqual(before);
    // Os outros tipos ainda aceitam comandos novos com Fiscal desligado.
    await f.toggle(false);
    for (const type of ["products", "contacts"]) await f.create("tags", { name: `Novo ${type}`, tag_type: type });
  }, 120_000);

  it("a fronteira HTTP do motor não libera Fiscal sem metadado interno", async () => {
    const f = await apiFixture();
    const tag = await f.create("tags", { name: "Fiscal", tag_type: "invoices" });
    await f.create("tags", { name: "Produto", tag_type: "products" });
    const identity = await erpIdentity(env, f.admin, f.profile);
    const before = await f.stored();
    for (const headers of [{}, { [FISCAL_MODULE_HEADER]: "1" }, { [SYSTEM_HEADER]: "1" }]) {
      const request = (name: string, body: any) => erpFetch(env, f.profile, `/erp-rpc/${name}`, {
        method: "POST", headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity), ...headers }, body: JSON.stringify(body),
      });
      const list = await (await request("erp_catalog_taxonomy_list", { p_user_id: f.admin.id, p_kind: "tags" })).json<any>();
      expect(list.items.map((item: any) => item.tag_type)).toEqual(["products"]);
      const result = await request("erp_catalog_taxonomy_delete", {
        p_user_id: f.admin.id, p_kind: "tags", p_id: tag.id, p_expected_version: 1, p_command_id: crypto.randomUUID(),
      });
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ code: "42501", message: "erp_catalog_access_denied" });
      expect(await f.stored()).toEqual(before);
    }
  }, 120_000);

  it("sem fotografia a fronteira falha fechado, sem listar dados nem alterar vínculos", async () => {
    const f = await apiFixture();
    const tag = await f.create("tags", { name: "Preservada", tag_type: "invoices" });
    const identity = await erpIdentity(env, f.admin, f.profile);
    const before = await f.stored();
    for (const name of ["erp_catalog_taxonomy_list", "erp_catalog_taxonomy_delete"]) {
      const response = await erpFetch(env, f.profile, `/erp-rpc/${name}`, {
        method: "POST", headers: { [SYSTEM_HEADER]: "1", [FISCAL_MODULE_HEADER]: "1",
          [IDENTITY_HEADER]: encodeIdentity({ actor: identity.actor, people: identity.people }) },
        body: JSON.stringify({ p_user_id: f.admin.id, p_kind: "tags", ...(name.endsWith("_delete") ? {
          p_id: tag.id, p_expected_version: 1, p_command_id: crypto.randomUUID(),
        } : {}) }),
      });
      expect(response.status).toBe(503);
      const body = await response.json<any>();
      expect(body.code).toBe("erp_parts_unavailable");
      expect(body.items).toBeUndefined();
      expect(body.deleted).toBeUndefined();
      expect(await f.stored()).toEqual(before);
    }
    const read = vi.fn(() => { throw new Error("Não deve carregar taxonomias sem fotografia"); });
    const blocked = await handleRpc({ storage: { sql: { exec: read } } } as unknown as DurableObjectState,
      f.profile, "erp_catalog_taxonomy_list", new Request("https://internal/erp-rpc/erp_catalog_taxonomy_list", {
        method: "POST", headers: { [IDENTITY_HEADER]: encodeIdentity({ actor: identity.actor, people: null }) },
        body: JSON.stringify({ p_user_id: f.admin.id, p_kind: "tags" }),
      }));
    expect(blocked.status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  }, 120_000);
});
