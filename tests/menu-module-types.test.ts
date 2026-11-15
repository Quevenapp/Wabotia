import { describe, expect, it } from "vitest";
import { coreMenuTypes, menuTypeOptions } from "../web/menu-tree";
import { modules as registered } from "../src/modules/registry";

// Relato da sessão E: no editor de menus, um item os_open/os_track aparecia
// com um <select> sem a opção certa (tipos fixos) e, salvo ali, virava outro
// tipo. A lista de opções agora vem também de GET /modules.
const modules = [
  {
    id: "os",
    enabled: true,
    menu_item_types: [
      { type: "os_open", label: "Abrir ordem de serviço" },
      { type: "os_track", label: "Acompanhar ordem de serviço" },
    ],
  },
  {
    id: "agenda",
    enabled: false,
    menu_item_types: [{ type: "agenda", label: "Agendar horário" }],
  },
];

describe("tipos de item no editor de menus", () => {
  it("a lista fixa do núcleo não conhece os tipos de módulo (o defeito)", () => {
    expect(coreMenuTypes.map((t) => t.type)).not.toContain("os_open");
  });

  it("oferece os tipos dos módulos ligados e mantém o tipo atual do item", () => {
    const types = menuTypeOptions(modules, "os_open").map((t) => t.type);
    expect(types).toEqual(
      expect.arrayContaining(["human", "os_open", "os_track"]),
    );
    expect(types).not.toContain("agenda");
    // Item de um módulo desligado (ou desconhecido) continua com o seu tipo.
    const kept = menuTypeOptions(modules, "agenda");
    expect(kept.find((t) => t.type === "agenda")).toMatchObject({
      label: "Agendar horário (módulo desligado)",
    });
    expect(menuTypeOptions([], "algo_novo").map((t) => t.type)).toContain(
      "algo_novo",
    );
    // Sem duplicar quando o tipo atual já está na lista.
    expect(
      menuTypeOptions(modules, "os_track").filter((t) => t.type === "os_track"),
    ).toHaveLength(1);
  });

  it("os módulos registrados no servidor entram no editor sem ajuste à mão (Reserva)", () => {
    const declared = registered.map((m) => ({
      enabled: true,
      menu_item_types: m.menu_item_types,
    }));
    expect(menuTypeOptions(declared)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reserva", label: "Fazer reserva" }),
        expect.objectContaining({
          type: "reserva_mine",
          label: "Minhas reservas",
        }),
        expect.objectContaining({ type: "agenda" }),
        expect.objectContaining({ type: "os_open" }),
      ]),
    );
  });
});
