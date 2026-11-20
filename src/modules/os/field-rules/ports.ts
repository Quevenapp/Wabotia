import type { Os2Adapters } from "../os2-ports";
import { prepareOrderRulesMutation } from "./requirements";
import { planOrderFieldIndex } from "./index-store";
import { queryOrdersByField } from "./query";
import { fieldRulesRead, fieldRulesCommand } from "./routes";

/** A integração final compõe read/command com os outros adaptadores.
 * O harness instala este conjunto tanto no Worker quanto no Coordinator. */
export const fieldRulesAdapters = {
  prepareOrderRulesMutation,
  planOrderFieldIndex,
  queryOrdersByField,
  read: fieldRulesRead,
  command: fieldRulesCommand,
} satisfies Partial<Os2Adapters>;

export { prepareOrderRulesMutation, planOrderFieldIndex, queryOrdersByField, fieldRulesRead, fieldRulesCommand };
export { fieldRulesReadOperations, fieldRulesCommandOperations } from "./routes";
