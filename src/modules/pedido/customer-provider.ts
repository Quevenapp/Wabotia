import { routineProvider, withCustomerConfirmation } from "../agenda/customer-provider";
import { normalizeCustomerPhone } from "../../customer/phone";
import type { Actor } from "../../types";
import type { ModuleContext } from "../api";
import { allows } from "../../access";

export const pedidoCustomerProvider = routineProvider({
  moduleId: "pedido", collectionId: "orders", table: "pedido_orders", phone: "phone",
});

/** A equipe conserva abertura por telefone; integração nunca ganha credencial. */
export function pedidoCreationContext(ctx: ModuleContext, actor: Actor, confirmation: unknown, name?: unknown): ModuleContext {
  return {
    ...withCustomerConfirmation(ctx, actor, confirmation, name),
    async conversationByPhone(value, options) {
      ctx.access(actor, "contacts:read");
      if (actor.kind !== "user" || !allows(actor, "contacts")) return null;
      const phone = normalizeCustomerPhone(value, "international");
      if (!phone) return null;
      return ctx.conversationByPhone(phone, options);
    },
  };
}
