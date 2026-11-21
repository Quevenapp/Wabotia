import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { ApiError, json } from "../src/types";
import { onSettingsSave, registerAdminExtension } from "../src/modules/api";
import { moduleOfMenuType } from "../src/area-templates/validation";
import {
  applyAreaTemplate, areaTemplates, areaTemplatesExtension, previewAreaTemplate, previewUndoAreaTemplate, undoAreaTemplate, validateAreaSetup,
} from "../src/area-templates";
import { EXAMPLE_MARK, examplePhrases, templateExamples } from "../src/area-templates/examples";
import { deleteErpExample, erpExampleState, mountFinanceExamples, mountPendingErpExamples, type ErpCaller } from "../src/area-templates/erp-examples";
import { ownerSummary } from "../src/area-templates/owner-summary";
import { templateSelection } from "../web/admin/area-templates/selection";
import { fixture } from "./service-center-fixture";

registerAdminExtension(areaTemplatesExtension);
onSettingsSave("os", "os_area_setup", validateAreaSetup);

type Template = (typeof areaTemplates)[number];
const template = (id: string) => areaTemplates.find((entry) => entry.id === id)!;
const settings = async (profile: string) => json((await one(env, "SELECT settings FROM profiles WHERE id=?", profile))!.settings);
async function apply(f: Awaited<ReturnType<typeof fixture>>, model: Template, selection = templateSelection(model as any)) {
  const input = { template_id: model.id, selection };
  const preview = await previewAreaTemplate(env, f.admin, f.profile, input, areaTemplates);
  expect(preview.conflicts, model.id).toEqual([]);
  await applyAreaTemplate(env, f.admin, f.profile, { ...input, preview_hash: preview.preview_hash }, areaTemplates);
  return preview;
}
const marked = (name: string) => name.endsWith(` ${EXAMPLE_MARK}`);
/** Menus que não são de módulo e prometem o que só a Agenda ou a Mensalidade fazem. */
const PROMISE = /agend|mensalidad|parcela|segunda via/i;

/** ERP simulado: listas vazias (ou com o que o teste passar) e cada POST devolve um registro novo. */
function fakeErp(lists: Record<string, unknown[]> = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let next = 0;
  const call: ErpCaller = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") {
      const key = Object.keys(lists).find((prefix) => path.startsWith(prefix));
      return { items: key ? lists[key] : [] };
    }
    return { record: { id: `erp-${++next}`, version: 1 } };
  };
  return { call, calls };
}

describe("Modelos completos: cada modelo do catálogo monta o que liga e o menu faz o que promete", () => {
  it("o catálogo tem pelo menos os 21 modelos da revisão, sem id repetido", () => {
    expect(areaTemplates.length).toBeGreaterThanOrEqual(21);
    expect(new Set(areaTemplates.map((model) => model.id)).size).toBe(areaTemplates.length);
  });

  it.each(areaTemplates.map((model) => [model.id, model] as const))("%s: módulo ligado tem dados de exemplo e menu sem módulo não promete", (_id, model) => {
    const examples = templateExamples(model);
    if (model.modules.agenda) {
      expect(examples.agenda, "Agenda ligada sem exemplos").toBeDefined();
      expect(examples.agenda!.professional).toBe("Atendimento");
      expect(examples.agenda!.hours).toEqual([
        ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1080 })),
        { weekday: 6, start_minute: 480, end_minute: 720 },
      ]);
      expect(examples.agenda!.services.length).toBeGreaterThanOrEqual(2);
      for (const service of examples.agenda!.services) {
        expect(marked(service.name), service.name).toBe(true);
        expect(service.duration_minutes).toBeGreaterThan(0);
        expect(Number.isInteger(service.price_cents), `${service.name} sem preço de exemplo`).toBe(true);
      }
      expect(model.menus.some((menu) => menu.type === "agenda"), "Agenda ligada sem o menu Agendar").toBe(true);
    } else expect(examples.agenda).toBeUndefined();
    if (model.modules.mensalidade) {
      const plans = examples.mensalidade?.plans ?? [];
      expect(plans.length, "Mensalidade ligada sem planos de exemplo").toBeGreaterThanOrEqual(2);
      for (const plan of plans) {
        expect(marked(plan.name), plan.name).toBe(true);
        expect(plan.amount_cents).toBeGreaterThan(0);
        expect(["monthly", "quarterly", "yearly"]).toContain(plan.period);
        expect(plan.due_day).toBeGreaterThanOrEqual(1);
      }
      expect(model.menus.some((menu) => menu.type === "mensalidade_list"), "Mensalidade ligada sem o menu das mensalidades").toBe(true);
    } else expect(examples.mensalidade).toBeUndefined();
    if (model.modules["erp-produtos"]) {
      const items = examples.catalogo?.items ?? [];
      expect(items.length).toBeGreaterThanOrEqual(5);
      expect(items.length).toBeLessThanOrEqual(10);
      expect(new Set(items.map((item) => item.kind))).toEqual(new Set(["P", "S"]));
      for (const item of items) {
        expect(marked(item.name), item.name).toBe(true);
        expect(item.price, item.name).toMatch(/^(0|[1-9]\d{0,13})(\.\d{1,10})?$/);
        expect(item.unit.length).toBeGreaterThan(0);
      }
    } else expect(examples.catalogo).toBeUndefined();
    for (const menu of model.menus) {
      const owner = moduleOfMenuType(menu.type);
      if (owner) expect(model.modules[owner], `menu "${menu.label}" de ${owner}, que o modelo não liga`).toBe(true);
      else expect(PROMISE.test(menu.label), `menu "${menu.label}" (${menu.type}) promete Agenda ou Mensalidade e só encaminha`).toBe(false);
    }
  });

  it.each(areaTemplates.map((model) => [model.id, model] as const))("%s: aplicar monta Agenda, Mensalidade e o pedido ao ERP", async (_id, model) => {
    const f = await fixture();
    const examples = templateExamples(model);
    const preview = await apply(f, model);
    const services = await all(env, "SELECT name,duration_minutes,price_cents,active FROM agenda_services WHERE profile_id=? ORDER BY position", f.profile);
    if (examples.agenda) {
      expect(preview.changes).toContainEqual(expect.objectContaining({ path: "examples.agenda", action: "add" }));
      expect(services.map((service) => service.name)).toEqual(examples.agenda.services.map((service) => service.name));
      expect(services.every((service) => service.active === 1)).toBe(true);
      const professionals = await all(env, "SELECT id,name,user_id FROM agenda_professionals WHERE profile_id=?", f.profile);
      expect(professionals).toEqual([expect.objectContaining({ name: "Atendimento", user_id: f.admin.id })]);
      expect(await all(env, "SELECT * FROM agenda_professional_services WHERE profile_id=?", f.profile)).toHaveLength(services.length);
      expect(await all(env, "SELECT * FROM agenda_hours WHERE profile_id=?", f.profile)).toHaveLength(6);
    } else expect(services).toEqual([]);
    const plans = await all(env, "SELECT name,period,active FROM mensalidade_plans WHERE profile_id=? ORDER BY name", f.profile);
    if (examples.mensalidade) {
      expect(plans).toHaveLength(examples.mensalidade.plans.length);
      // Desativados até a pessoa revisar.
      expect(plans.every((plan) => plan.active === 0)).toBe(true);
    } else expect(plans).toEqual([]);
    const pending = await one(env, "SELECT state,examples_json FROM area_template_erp_examples WHERE profile_id=? AND template_id=?", f.profile, model.id);
    if (examples.catalogo) {
      expect(pending?.state).toBe("pendente");
      expect(json(pending!.examples_json).products).toEqual(examples.catalogo.items);
      expect(preview.changes).toContainEqual(expect.objectContaining({ path: "examples.catalogo", action: "add" }));
    } else expect(pending ? json(pending.examples_json).products : undefined).toBeUndefined();
    // Os exemplos entram na pegada (o desfazer parte dela).
    const footprint = json((await one(env, "SELECT examples_json FROM area_template_footprints WHERE profile_id=? AND template_id=?", f.profile, model.id))!.examples_json) as any[];
    expect(footprint.filter((example) => example.kind === "agenda_service")).toHaveLength(examples.agenda?.services.length ?? 0);
    expect(footprint.filter((example) => example.kind === "mensalidade_plan")).toHaveLength(examples.mensalidade?.plans.length ?? 0);
    // Os menus da Agenda e da Mensalidade entram como menus do módulo, não como encaminhamento.
    const menus = ((await settings(f.profile)).menus ?? []).filter((menu: any) => String(menu.id).startsWith(`area_${model.id}__`));
    if (model.modules.agenda) expect(menus.some((menu: any) => menu.type === "agenda")).toBe(true);
    if (model.modules.mensalidade) expect(menus.some((menu: any) => menu.type === "mensalidade_list")).toBe(true);
    expect(menus.filter((menu: any) => !moduleOfMenuType(menu.type) && PROMISE.test(menu.label))).toEqual([]);
  });
});

describe("Modelos completos: menu sem módulo some", () => {
  it("sem a Agenda na escolha, Agendar e Meus agendamentos ficam de fora e nada da Agenda é criado", async () => {
    const f = await fixture();
    const model = template("servicos");
    const selection = templateSelection(model as any);
    selection.module_ids = selection.module_ids.filter((id) => id !== "agenda" && id !== "mensalidade");
    const preview = await apply(f, model, selection);
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "menus.area_servicos__agendar", action: "skip" }));
    expect(preview.changes).toContainEqual(expect.objectContaining({ path: "menus.area_servicos__parcelas", action: "skip" }));
    expect(preview.changes.some((change) => change.path === "examples.agenda" || change.path === "examples.mensalidade")).toBe(false);
    const menus = (await settings(f.profile)).menus ?? [];
    expect(menus.some((menu: any) => ["agenda", "agenda_mine", "mensalidade_list", "mensalidade_copy"].includes(menu.type))).toBe(false);
    expect(await all(env, "SELECT id FROM agenda_services WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM mensalidade_plans WHERE profile_id=?", f.profile)).toEqual([]);
  });
});

describe("Modelos completos: pegada e desfazer", () => {
  it("desfazer tira serviços, profissional, horário e planos intocados; o editado fica com o motivo; o pedido ao ERP é cancelado", async () => {
    const f = await fixture();
    const model = template("escolas");
    await apply(f, model);
    const edited = await one(env, "SELECT id,name FROM agenda_services WHERE profile_id=? ORDER BY position LIMIT 1", f.profile);
    await exec(env, "UPDATE agenda_services SET price_cents=1000,updated=updated+1 WHERE id=?", edited!.id);
    const preview = await previewUndoAreaTemplate(env, f.admin, f.profile, { template_id: model.id }, areaTemplates);
    expect(preview.kept).toContainEqual({ label: `Serviço "${edited!.name}" na Agenda`, reason: "ficou porque foi editado." });
    expect(preview.removed).toEqual(expect.arrayContaining(templateExamples(model).mensalidade!.plans.map((plan) => `Plano "${plan.name}" na Mensalidade`)));
    await undoAreaTemplate(env, f.admin, f.profile, { template_id: model.id, preview_hash: preview.preview_hash }, areaTemplates);
    expect(await all(env, "SELECT id FROM agenda_services WHERE profile_id=?", f.profile)).toEqual([{ id: edited!.id }]);
    expect(await all(env, "SELECT id FROM agenda_professionals WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT * FROM agenda_hours WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM mensalidade_plans WHERE profile_id=?", f.profile)).toEqual([]);
    expect((await one(env, "SELECT state FROM area_template_erp_examples WHERE profile_id=? AND template_id=?", f.profile, model.id))?.state).toBe("cancelado");
    const footprint = await one(env, "SELECT examples_json FROM area_template_footprints WHERE profile_id=? AND template_id=?", f.profile, model.id);
    expect(json(footprint!.examples_json)).toEqual([expect.objectContaining({ kind: "agenda_service", id: edited!.id })]);
    // Aplicar de novo volta a pedir o financeiro ao ERP (nada tinha sido montado).
    const again = await apply(f, model);
    expect(again.changes).toContainEqual(expect.objectContaining({ path: "examples.financeiro", action: "add" }));
  });

  it("catálogo de exemplo: montado pelo ERP na primeira vez, entra na pegada e o desfazer confere versão e estoque", async () => {
    const f = await fixture();
    const model = template("comercio");
    await apply(f, model);
    const erp = fakeErp();
    await mountPendingErpExamples(env, f.profile, erp.call);
    const items = templateExamples(model).catalogo!.items;
    const posts = erp.calls.filter((entry) => entry.method === "POST" && entry.path === "/v1/cadastros/products");
    expect(posts.map((entry) => entry.body.data)).toEqual(items.map((item) => ({ name: item.name, kind: item.kind, format: "S", unit: item.unit, price: item.price })));
    expect(new Set(posts.map((entry) => entry.body.command_id)).size).toBe(items.length);
    expect((await one(env, "SELECT state FROM area_template_erp_examples WHERE profile_id=? AND template_id=?", f.profile, model.id))?.state).toBe("montado");
    const footprint = json((await one(env, "SELECT examples_json FROM area_template_footprints WHERE profile_id=? AND template_id=?", f.profile, model.id))!.examples_json) as any[];
    const products = footprint.filter((example) => example.kind === "erp_product");
    expect(products).toHaveLength(items.length);
    expect(products[0].label).toBe(`Produto "${items[0].name}" em Produtos e serviços do ERP`);

    const product = products[0];
    const get = (record: unknown): ErpCaller => async () => ({ record });
    expect(await erpExampleState(env, f.admin, f.profile, product, get({ id: product.id, version: 1, stock: "0" }))).toBe("free");
    expect(await erpExampleState(env, f.admin, f.profile, product, get({ id: product.id, version: 2 }))).toBe("changed");
    expect(await erpExampleState(env, f.admin, f.profile, product, get({ id: product.id, version: 1, stock: "3" }))).toBe("used");
    expect(await erpExampleState(env, f.admin, f.profile, product, get({ id: product.id, version: 1, deleted: true }))).toBe("gone");
    expect(await erpExampleState(env, f.admin, f.profile, product, async () => { throw new ApiError(404, "not_found", "x"); })).toBe("gone");
    expect(await erpExampleState(env, f.admin, f.profile, product, async () => { throw new ApiError(503, "erp_unavailable", "x"); })).toBe("unknown");
    const removal = fakeErp();
    expect(await deleteErpExample(env, f.admin, f.profile, product, removal.call)).toBe(true);
    expect(removal.calls).toEqual([{ method: "PATCH", path: `/v1/cadastros/products/${product.id}/deleted`, body: expect.objectContaining({ expected_version: 1, deleted: true }) }]);
  });

  it("catálogo do ERP já com itens: nenhum exemplo é criado", async () => {
    const f = await fixture();
    const erp = fakeErp({ "/v1/cadastros/products": [{ id: "meu", name: "Meu produto", deleted: false }] });
    const created = await mountFinanceExamples(env, f.profile, "comercio", f.admin, { products: templateExamples(template("comercio")).catalogo!.items }, erp.call);
    expect(created).toEqual([]);
    expect(erp.calls.filter((entry) => entry.method === "POST")).toEqual([]);
  });
});

describe("Modelos completos: prévia em linguagem de dono", () => {
  it("diz o que vai criar na Agenda, na Mensalidade e no ERP", () => {
    const summary = ownerSummary({ work_types: [], modules: { agenda: true, mensalidade: true, erp: true, "erp-produtos": true } }, [
      { path: "examples.agenda", action: "add", reason: "" }, { path: "examples.mensalidade", action: "add", reason: "" },
      { path: "examples.catalogo", action: "add", reason: "" },
    ]);
    expect(summary.create.join(" ")).toContain("\"Atendimento\"");
    expect(summary.create.join(" ")).toContain("desativados até você revisar");
    expect(summary.create.join(" ")).toContain("produtos e serviços de exemplo no ERP");
    const phrases = examplePhrases(templateExamples(template("escolas")));
    expect(phrases.join(" ")).toContain("Matrícula, R$");
    expect(phrases.join(" ")).toContain("por ano");
    expect(examplePhrases(templateExamples(template("comercio"))).join(" ")).toContain("6 produtos e serviços de exemplo no ERP");
  });
});
