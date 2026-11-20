import { expect, it } from "vitest";
import { demoApi } from "../web/lib/demo";
import { MANAGEMENT_ITEMS, managementContext, nativeTargetState, resolveManagement } from "../web/management/registry";

it("o status real da demonstração libera os módulos nativos da casa", async () => {
  const status = await demoApi("v1/profiles/demo/status");
  const context = managementContext({ statusLoaded: true, role: "admin", access: null, modules: status.modules });
  const items = resolveManagement(MANAGEMENT_ITEMS, context, true);
  for (const module of ["agenda", "pedido", "mesas", "reserva", "os", "mensalidade"]) {
    expect(status.modules[module], module).toBe(true);
    expect(items.some(item => item.module === module), module).toBe(true);
  }
  expect(nativeTargetState("agenda", context)).toBe("allowed");
  const firstPorted = items.findIndex(item => item.target.kind === "ported");
  expect(firstPorted).toBeGreaterThan(0);
  expect(items.slice(firstPorted).every(item => item.target.kind === "ported")).toBe(true);
});

it("demonstra lista única, modelo de oficina, filtros e exemplos para Configurar", async () => {
  const root = "v1/profiles/demo";
  const catalog = await demoApi(root + "/service-orders/types");
  expect(catalog.data.map((type: { id: string }) => type.id)).toEqual(["service_order", "area_oficina_mecanica__at_veiculos"]);
  const all = await demoApi(root + "/service-orders");
  expect(new Set(all.data.map((order: { type_id: string }) => order.type_id)).size).toBe(2);
  for (const type of catalog.data) {
    const filtered = await demoApi(root + "/service-orders?type_id=" + type.id);
    expect(filtered.data.length).toBeGreaterThan(0);
    expect(filtered.data.every((order: { type_id: string }) => order.type_id === type.id)).toBe(true);
    expect(filtered.counts).toEqual(all.counts);
    const detail = await demoApi(root + "/service-orders/" + filtered.data[0].id);
    expect(detail.type_id).toBe(type.id);
  }
  const active = await demoApi(root + "/service-orders?type_ids=service_order");
  expect(active.data.every((order: { type_id: string }) => order.type_id === "service_order")).toBe(true);
  const status = await demoApi(root + "/status");
  expect(status.settings.os_work_types).toHaveLength(1);
  const examples = await demoApi(root + "/area-templates");
  expect(examples.data.length).toBeGreaterThan(1);
  const example = await demoApi(root + "/area-templates/oficina_mecanica");
  expect(example.work_types[0].fields.map((field: { id: string }) => field.id)).toEqual(expect.arrayContaining(["placa", "marca_modelo", "ano", "cor", "ultima_manutencao"]));
});
