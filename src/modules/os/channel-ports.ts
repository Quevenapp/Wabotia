// Composição da folha de canais. A integradora instala este resultado junto
// das folhas de objetos/regras; o harness usa a mesma composição em testes.
import { ApiError } from "../../types";
import type { Os2Adapters } from "./os2-ports";
import { objectOpenForm } from "./forms";
import { customerObjectsRead } from "./customer-objects";
import { getWorkObjectContext, projectChannelObjectSnapshot, publicObjectLabel } from "./object-messages";
import { prepareObjectWebStepCompletion, resumeObjectWebStepCompletion, withObjectWebStepReceiptPlan } from "./opening-completion";

export function createChannelAdapters(adapters: Partial<Os2Adapters> = {}): Partial<Os2Adapters> {
  return {
    ...adapters,
    openObjectForm: objectOpenForm,
    prepareObjectWebStepCompletion,
    resumeObjectWebStepCompletion,
    publicObjectLabel,
    getWorkObjectContext,
    projectObjectSnapshot: adapters.projectObjectSnapshot ?? projectChannelObjectSnapshot,
    ...(adapters.prepareObjectOpening ? { prepareObjectOpening: withObjectWebStepReceiptPlan(adapters.prepareObjectOpening) } : {}),
    read: (ctx, actor, operation, input) => {
      if (operation === "os.conversation.objects.list" || operation === "os.conversation.objects.get")
        return customerObjectsRead(ctx, actor, operation, input);
      if (adapters.read) return adapters.read(ctx, actor, operation, input);
      throw new ApiError(501, "not_implemented", "Esta operação depende do adaptador de objetos ou de requisitos.");
    },
  };
}

/** Para testes de consultas/formulário sem escrita. Aberturas exigem compor o
 * planejador de objetos pela factory, que inclui o recibo no lote da ordem. */
export const channelAdapters = createChannelAdapters();
