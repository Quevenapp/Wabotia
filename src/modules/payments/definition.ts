import { NATIVE_MANAGEMENT_ITEMS } from "../panel-navigation";
// Cobrança (Pix e link de pagamento) no núcleo, ligável por área como um
// módulo. O código fica em src/payments.ts; aqui, só a declaração.
import type { ModuleDefinition } from "../types";

export const paymentsModule: ModuleDefinition = {
  id: "payments",
  name: "Cobrança",
  version: "1.0.0",
  description:
    "Pix e link de pagamento pelo Mercado Pago, enviados na conversa e confirmados pelo webhook do provedor.",
  builtin: true,
  // Sem conta configurada nada é cobrado; ligado para a configuração aparecer.
  default_enabled: true,
  management: NATIVE_MANAGEMENT_ITEMS.payments,
  navigation: [
    { id: "payments", label: "Cobrança", place: "admin", admin: true },
  ],
  menu_item_types: [],
  events: [
    "payment.created",
    "payment.paid",
    "payment.expired",
    "payment.cancelled",
    "payment.refunded",
    "payment.duplicate",
    "payment.duplicate_refunded",
    "payment.hook_failed",
  ],
  settings: [],
  routes: ["payments"],
  operations: ["payment."],
  scopes: [],
};
