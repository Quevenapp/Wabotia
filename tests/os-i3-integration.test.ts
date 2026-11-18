import { describe, it } from "vitest";
import { i2Harness } from "./os-i2-harness";
import { taskPrivacyRecheck, taskCursorD1, legacyCatalogSearch, legacyStageReplyBudget, legacyAlarmBudget, legacyCounterLineChoice, literalStageFilters, residentialFields } from "./os-i3-scenarios";

describe("I3: pontas da conferência", () => {
  it("reconfere versão, privacidade e estado da tarefa antes de enviar", () => taskPrivacyRecheck(i2Harness()), 60000);
  it("pagina lembretes com cursor D1 durável, isolado e medido no orçamento", () => taskCursorD1(i2Harness()), 60000);
  it("preserva a busca legada do catálogo dentro dos dez resultados", () => legacyCatalogSearch(i2Harness()));
  it("não acrescenta SQL ao orçamento legado para respostas de etapa", () => legacyStageReplyBudget(i2Harness()));
  it("mantém o alarme legado completo no teto de 71 instruções", () => legacyAlarmBudget(i2Harness()));
  it("preserva a primeira linha oficial no pedido de balcão com datas empatadas", () => legacyCounterLineChoice(i2Harness()));
  it("distingue os filtros especiais das etapas literais open/all", () => literalStageFilters(i2Harness()));
  it("permite unidade ao morador e bot e preserva nomes de alunos privados", () => residentialFields(i2Harness()));
});
