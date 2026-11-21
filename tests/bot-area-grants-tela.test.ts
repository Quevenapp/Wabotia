// Regras puras da seção "Módulos de área" na página do bot
// (web/admin/bot-area-grants.ts): ligar sempre leva a confirmação do aviso
// certo, desligar nunca pede, e só os módulos ligados aparecem.
import { describe, expect, it } from "vitest";
import { areaModules, areaProblem, grantRequest, logText, visibleModules, warningFor } from "../web/admin/bot-area-grants";

const raw = {
  modules: [
    { module: "saude", title: "Saúde — prontuário", module_enabled: true, warning: "Aviso saúde", direct_warning: "Aviso direto",
      sensitive_warning: "Aviso campos", sensitive_label: "prontuário", sensitive_fields: false,
      operations: [{ id: "saude.record.create", title: "Escrever", description: "d", kind: "write", enabled: true, direct: false }, { nada: 1 }],
      log: [{ id: "1", kind: "operation", operation: "saude.record.create", action: "on", actor_name: "Ana", detail: "", created: 1, title: "Escrever" }] },
    { module: "ensino", title: "Ensino", module_enabled: false, operations: [], log: [] },
    { sem: "módulo" },
  ],
};

describe("tela dos módulos de área do bot", () => {
  it("normaliza a resposta e mostra só os módulos ligados", () => {
    const modules = areaModules(raw);
    expect(modules.map(m => m.module)).toEqual(["saude", "ensino"]);
    expect(modules[0].operations).toHaveLength(1);
    expect(visibleModules(modules).map(m => m.module)).toEqual(["saude"]);
    expect(areaModules(null)).toEqual([]);
  });
  it("ligar leva a confirmação do aviso certo; desligar não", () => {
    const [saude] = areaModules(raw);
    expect(grantRequest(saude, "operation", true, "saude.record.create")).toEqual({ module: "saude", kind: "operation", operation: "saude.record.create", enabled: true, confirmed: true });
    expect(grantRequest(saude, "direct", true, "saude.record.create")).toEqual({ module: "saude", kind: "direct", operation: "saude.record.create", enabled: true, direct_confirmed: true });
    expect(grantRequest(saude, "sensitive_fields", true)).toEqual({ module: "saude", kind: "sensitive_fields", enabled: true, confirmed: true });
    expect(grantRequest(saude, "operation", false, "saude.record.create")).toEqual({ module: "saude", kind: "operation", operation: "saude.record.create", enabled: false });
    expect([warningFor(saude, "operation"), warningFor(saude, "direct"), warningFor(saude, "sensitive_fields")]).toEqual(["Aviso saúde", "Aviso direto", "Aviso campos"]);
  });
  it("registro e erros em português", () => {
    const [saude] = areaModules(raw);
    expect(logText(saude.log[0])).toBe("Ana ligou: Escrever");
    expect(logText({ ...saude.log[0], kind: "sensitive_fields", action: "off" })).toBe("Ana desligou incluir campos sensíveis");
    expect(logText({ ...saude.log[0], action: "used", actor_name: "Bia", detail: "consulta" })).toBe("Bia usou pelo bot: Escrever (consulta)");
    expect(areaProblem({ status: 403 })).toMatchObject({ retry: false });
    expect(areaProblem({ status: 500 })).toMatchObject({ retry: true });
  });
});
