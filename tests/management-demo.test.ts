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
