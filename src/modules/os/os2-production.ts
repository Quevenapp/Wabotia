// Composição de produção da parte 2: objetos, requisitos/índices e canais.
// Construída sob demanda, na primeira chamada de porta, para não depender da
// ordem de avaliação dos módulos que se importam em ciclo.
import { ApiError } from "../../types";
import type { Os2Adapters } from "./os2-ports";
import { prepareObjectOpening, reauthorizeObjectOpening, prepareLegacyObjectLink, planObjectContactMerge } from "./objects/store";
import { projectObjectSnapshot, projectObjectForActor, projectObjectPage, publicObjectLabel, getWorkObjectContext } from "./objects/projection";
import { objectCustomerContribution } from "./objects/customer-provider";
import { readObjectRoute, commandObjectRoute } from "./objects/routes";
import { prepareOrderRulesMutation } from "./field-rules/requirements";
import { planOrderFieldIndex } from "./field-rules/index-store";
import { queryOrdersByField } from "./field-rules/query";
import { fieldRulesRead, fieldRulesCommand, fieldRulesReadOperations, fieldRulesCommandOperations } from "./field-rules/routes";
import { createChannelAdapters } from "./channel-ports";

export function createProductionOs2Adapters(): Os2Adapters {
  const channels = createChannelAdapters({
    prepareObjectOpening, reauthorizeObjectOpening, prepareLegacyObjectLink, planObjectContactMerge,
    projectObjectSnapshot, projectObjectForActor, projectObjectPage, objectCustomerContribution,
    prepareOrderRulesMutation, planOrderFieldIndex, queryOrdersByField,
    // Cada operação estável tem um único dono; a consulta pela conversa fica com o canal.
    read: (ctx, actor, operation, input) => fieldRulesReadOperations.includes(operation)
      ? fieldRulesRead(ctx, actor, operation, input) : readObjectRoute(ctx, actor, operation, input),
    command: (ctx, actor, operation, data, meta) => fieldRulesCommandOperations.includes(operation)
      ? fieldRulesCommand(ctx, actor, operation, data, meta) : commandObjectRoute(ctx, actor, operation, data, meta),
  });
  return {
    ...(channels as Os2Adapters),
    // A identificação e o contexto comercial seguem a projeção única da folha de objetos.
    publicObjectLabel,
    getWorkObjectContext,
    planStageTasks: async () => {
      throw new ApiError(501, "not_implemented", "O checklist automático por etapa fica para a parte 3.");
    },
  };
}
