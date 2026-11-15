// Mensalidade: escola de idiomas, escolinha de esporte, academia pequena,
// contador, condomínio. Declaração só com dados, lida pelo registro
// (src/modules/registry.ts). Código em ./mensalidade.ts; uso em
// docs/MENSALIDADE.md.
import type { ModuleDefinition } from "../types";

export const mensalidadeModule: ModuleDefinition = {
  id: "mensalidade",
  name: "Mensalidade",
  version: "1.0.0",
  description:
    "Planos, assinaturas e parcelas com cobrança por Pix ou link antes do vencimento, avisos de atraso e comprovante pelo WhatsApp.",
  builtin: true,
  default_enabled: false,
  navigation: [
    { id: "mensalidades", label: "Mensalidades", place: "admin", admin: false },
    {
      id: "mensalidade-settings",
      label: "Planos e regras",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "mensalidade_list",
      label: "Minhas mensalidades",
      description:
        "Mostra as parcelas abertas e pagas do telefone da conversa e reenvia o Pix de uma parcela aberta.",
    },
    {
      type: "mensalidade_copy",
      label: "Segunda via",
      description:
        "Envia de novo o Pix copia e cola e o link da mensalidade em aberto.",
    },
  ],
  events: [
    "mensalidade.contract_created",
    "mensalidade.subscription_created",
    "mensalidade.subscription_changed",
    "mensalidade.installment_created",
    "mensalidade.charged",
    "mensalidade.notice_sent",
    "mensalidade.overdue",
    "mensalidade.paid",
    "mensalidade.waived",
    "mensalidade.refunded",
    "mensalidade.notice_failed",
    "mensalidade.setup_needed",
    "mensalidade.payer_created",
    "mensalidade.payer_changed",
  ],
  settings: [
    {
      key: "mensalidade",
      description:
        "Regras de cobrança: forma (Pix ou link), dias de antecedência, aviso no dia, avisos de atraso, carência e instruções sem cobrança configurada.",
    },
  ],
  routes: ["mensalidade"],
  operations: ["mensalidade."],
  scopes: [],
};
