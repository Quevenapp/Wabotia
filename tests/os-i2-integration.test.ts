import { describe, it } from "vitest";
import { i2Harness } from "./os-i2-harness";
import { extensionDefaults, integrationPendencies, securityMcp, securityReminders, templateRecovery, stageNotificationAuthorization, schedulerSerialization } from "./os-i2-scenarios";

describe("I2: integração central e segurança", () => {
  it("comando entra durante a rodada dos módulos; tarefa reclassificada, concluída, cancelada ou arquivada não é avisada", () => schedulerSerialization(i2Harness()), 60000);
  it("extensões desligadas preservam áreas existentes, menus, navegação e embutido", () => extensionDefaults(i2Harness()));
  it("MCP fixa a conversa/área na execução assinada e recusa vínculo ausente, inválido ou encerrado", () => securityMcp(i2Harness()));
  it("expansão e falhas de lembrete não bloqueiam o embutido, nem tarefas sem destinatário prendem a fila", () => securityReminders(i2Harness()), 60000);
  it("decisão e recuperação de etapa respeitam a autorização de notificar", () => stageNotificationAuthorization(i2Harness()));
  it("campos privados, snapshot, orçamento, filtros, formulário e anexo comum", () => integrationPendencies(i2Harness()), 60000);
  it("recupera aplicação de modelo e publicações após falha posterior ao commit", () => templateRecovery(i2Harness()));
});
