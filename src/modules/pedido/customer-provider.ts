import { routineProvider, withCustomerConfirmation } from "../agenda/customer-provider";
import { one } from "../../db";
import { normalizeCustomerPhone } from "../../customer/phone";
import type { Actor } from "../../types";
import type { ModuleContext } from "../api";
import { allows } from "../../access";

export const pedidoCustomerProvider = routineProvider({
  moduleId: "pedido", collectionId: "orders", table: "pedido_orders", phone: "phone",
});

/** Adapta o criador de balcão sem reutilizar suas variantes antigas de telefone. */
export function pedidoCreationContext(ctx: ModuleContext, actor: Actor, confirmation: unknown, name?: unknown): ModuleContext {
  return {
    ...withCustomerConfirmation(ctx, actor, confirmation, name),
    async conversationByPhone(value) {
      ctx.access(actor, "contacts:read");
      if (!allows(actor, "contacts")) return null;
      const phone = normalizeCustomerPhone(value, "international");
      if (!phone) return null;
      const namespace = actor.kind === "app" ? `app:${actor.id}` : "team";
      const row = await one(ctx.env, `SELECT c.id FROM customer_phones p
        JOIN contacts ct ON ct.profile_id=p.profile_id AND ct.namespace=p.namespace AND ct.id=p.contact_id AND ct.identity_state='active'
        JOIN conversation_contacts cc ON cc.profile_id=ct.profile_id AND cc.contact_id=ct.id
        JOIN conversations c ON c.profile_id=cc.profile_id AND c.id=cc.conversation_id
        WHERE p.profile_id=? AND p.namespace=? AND p.phone=? AND p.state='ready'
          AND c.chat_type<>'group' AND c.customer_link_state='ready' AND c.verified_phone=p.phone
          AND (CASE WHEN c.external_namespace LIKE 'app:%' THEN c.external_namespace ELSE 'team' END)=p.namespace
        ORDER BY c.updated DESC,c.id DESC LIMIT 1`, ctx.profile, namespace, phone);
      return row ? ctx.conversation(row.id, actor) : null;
    },
  };
}
