// Tela do bot → o que ele pode fazer no ERP: o corpo do PATCH ao ligar e
// desligar, o aviso da primeira liberação, as leituras que o bot faz sozinho,
// a contagem por grupo e o texto dos módulos desligados.
import { describe, expect, it } from "vitest";
import {
  ADMIN_ONLY_TEXT,
  ERP_OFF_TEXT,
  autonomousCandidates,
  autonomousPatch,
  botErpGrants,
  erpGroups,
  groupCount,
  groupCountText,
  inventoryProblem,
  missingModulesText,
  needsDataWarning,
  operationKind,
  operationPatch,
} from "../web/admin/bot-erp-grants";

const groups = erpGroups({
  groups: [
    {
      id: "business",
      title: "Meu negócio",
      operations: [
        {
          id: "sales.today",
          title: "Consultar vendas do dia",
          description: "Total vendido hoje.",
          kind: "read",
          sensitive: false,
          autonomous: false,
          modules: [{ id: "erp", title: "ERP", enabled: true }],
        },
        {
          id: "sale.create",
          title: "Lançar venda",
          description: "Registra uma venda.",
          kind: "write",
          sensitive: false,
          autonomous: false,
          modules: [],
        },
      ],
    },
    {
      id: "finance",
      title: "Financeiro",
      operations: [
        {
          id: "finance.balance",
          title: "Consultar saldo",
          description: "Saldo das contas.",
          kind: "read",
          sensitive: true,
          autonomous: true,
          modules: [
            { id: "erp-finance", title: "Financeiro", enabled: false },
            { id: "erp-bank", title: "Cobrança no banco", enabled: false },
            { id: "erp", title: "ERP", enabled: true },
          ],
        },
        { title: "sem id" },
      ],
    },
  ],
});

describe("o que o bot pode fazer no ERP", () => {
  it("lê o inventário na ordem do servidor e descarta itens sem id", () => {
    expect(groups.map((g) => g.title)).toEqual(["Meu negócio", "Financeiro"]);
    expect(groups[1].operations.map((op) => op.id)).toEqual(["finance.balance"]);
    expect(erpGroups(null)).toEqual([]);
  });

  it("concessões ausentes são listas vazias", () => {
    expect(botErpGrants({})).toEqual({ operations: [], autonomous: [] });
    expect(botErpGrants({ erp_operations: ["a", "a", 1], erp_autonomous_operations: ["a"] })).toEqual({
      operations: ["a"],
      autonomous: ["a"],
    });
  });

  it("ligar soma a operação e sempre manda o aceite", () => {
    expect(operationPatch({ operations: [], autonomous: [] }, "sales.today", true)).toEqual({
      erp_operations: ["sales.today"],
      erp_autonomous_operations: [],
      erp_data_acknowledged: true,
    });
  });

  it("desligar tira a operação também de sozinho, no mesmo PATCH", () => {
    const current = { operations: ["sales.today", "finance.balance"], autonomous: ["finance.balance"] };
    expect(operationPatch(current, "finance.balance", false)).toEqual({
      erp_operations: ["sales.today"],
      erp_autonomous_operations: [],
      erp_data_acknowledged: true,
    });
    // A última desligada revoga tudo.
    expect(operationPatch({ operations: ["sales.today"], autonomous: [] }, "sales.today", false)).toMatchObject({
      erp_operations: [],
      erp_autonomous_operations: [],
    });
  });

  it("sozinho só vale para operação liberada", () => {
    const current = { operations: ["finance.balance"], autonomous: [] };
    expect(autonomousPatch(current, "finance.balance", true).erp_autonomous_operations).toEqual(["finance.balance"]);
    expect(autonomousPatch(current, "outra", true).erp_autonomous_operations).toEqual([]);
    expect(
      autonomousPatch({ operations: ["finance.balance"], autonomous: ["finance.balance"] }, "finance.balance", false),
    ).toEqual({ erp_operations: ["finance.balance"], erp_autonomous_operations: [], erp_data_acknowledged: true });
  });

  it("o aviso aparece só ao ligar a primeira", () => {
    expect(needsDataWarning({ operations: [], autonomous: [] }, true)).toBe(true);
    expect(needsDataWarning({ operations: ["sales.today"], autonomous: [] }, true)).toBe(false);
    expect(needsDataWarning({ operations: [], autonomous: [] }, false)).toBe(false);
  });

  it("leituras sozinho: só as sensíveis já liberadas", () => {
    expect(autonomousCandidates(groups, { operations: ["sales.today"], autonomous: [] })).toEqual([]);
    expect(
      autonomousCandidates(groups, { operations: ["sales.today", "finance.balance"], autonomous: [] }).map((op) => op.id),
    ).toEqual(["finance.balance"]);
  });

  it("conta as ligadas por grupo", () => {
    const count = groupCount(groups[0], { operations: ["sale.create", "finance.balance"], autonomous: [] });
    expect(count).toEqual({ on: 1, total: 2 });
    expect(groupCountText(count)).toBe("1 de 2 ligada");
    expect(groupCountText({ on: 0, total: 2 })).toBe("0 de 2 ligadas");
  });

  it("etiqueta do tipo: ação e leitura sensível pedem confirmação", () => {
    expect(operationKind(groups[0].operations[0])).toEqual({ label: "Consulta", confirms: false });
    expect(operationKind(groups[0].operations[1])).toEqual({ label: "Ação", confirms: true });
    expect(operationKind(groups[1].operations[0])).toEqual({ label: "Consulta", confirms: true });
  });

  it("módulos desligados viram uma frase", () => {
    expect(missingModulesText(groups[0].operations[0])).toBe("");
    expect(missingModulesText(groups[1].operations[0])).toBe(
      "Ligue os módulos Financeiro e Cobrança no banco para o bot usar.",
    );
    expect(
      missingModulesText({ ...groups[1].operations[0], modules: [{ id: "x", title: "Nota fiscal", enabled: false }] }),
    ).toBe("Ligue o módulo Nota fiscal para o bot usar.");
  });

  it("recusas conhecidas viram frase clara, sem erro genérico", () => {
    expect(inventoryProblem(null, false)).toEqual({ text: ERP_OFF_TEXT, retry: false });
    expect(inventoryProblem({ status: 403, code: "admin_required" }, true)).toEqual({
      text: ADMIN_ONLY_TEXT,
      retry: false,
    });
    expect(inventoryProblem({ status: 404 }, true).text).toBe(ERP_OFF_TEXT);
    expect(inventoryProblem({ status: 409, code: "module_disabled" }, true).text).toBe(ERP_OFF_TEXT);
    const other = inventoryProblem({ status: 500 }, true);
    expect(other.retry).toBe(true);
    expect(other.text).not.toMatch(/Não foi possível concluir/);
  });
});
