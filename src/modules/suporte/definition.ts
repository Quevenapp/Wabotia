// Suporte pago: o atendimento humano só depois de conferir o pagamento.
// Identifica o pagador pelo telefone ou pelo CPF/CNPJ (Mensalidade), libera
// quem está em dia e vende suporte avulso ou plano mensal pela Cobrança.
// Declaração só com dados; código em ./suporte.ts; uso em docs/SUPORTE.md.
import type { ModuleDefinition } from "../types";

export const suporteModule: ModuleDefinition = {
  id: "suporte",
  name: "Suporte pago",
  version: "1.0.0",
  description:
    "Atendimento humano liberado para quem paga: identifica pelo telefone ou CPF/CNPJ, confere a mensalidade e vende suporte avulso ou plano mensal por Pix ou link.",
  builtin: true,
  default_enabled: false,
  // Identifica o pagador e vende planos pela interface pública da Mensalidade.
  requires: ["mensalidade"],
  navigation: [
    { id: "suporte", label: "Suporte pago", place: "admin", admin: false },
    {
      id: "suporte-settings",
      label: "Regras do suporte",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "suporte_humano",
      label: "Atendimento humano (pago)",
      description:
        "Confere se o cliente tem suporte pago (assinatura em dia ou avulso) antes de passar a um atendente; sem isso, oferece a compra pelo WhatsApp.",
    },
  ],
  events: [
    "suporte.identified",
    "suporte.identification_failed",
    "suporte.released",
    "suporte.awaiting_team",
    "suporte.group_held",
    "suporte.purchase_created",
    "suporte.purchase_paid",
    "suporte.purchase_expired",
    "suporte.purchase_attention",
    "suporte.plan_contracted",
    "suporte.phone_linked",
    "suporte.release_ended",
  ],
  settings: [
    {
      key: "suporte",
      description:
        "Setor de destino, modo de identificação, pacotes avulsos, planos oferecidos, formas de pagamento e textos.",
    },
  ],
  routes: ["suporte"],
  operations: ["suporte."],
  scopes: [],
};
