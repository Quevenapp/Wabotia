import { NATIVE_MANAGEMENT_ITEMS } from "../panel-navigation";
// Pedido: cardápio, carrinho por link, pagamento e acompanhamento pelo
// WhatsApp, para lanchonete, pizzaria, marmitaria, açaí e confeitaria por
// encomenda. Declaração só com dados, lida pelo registro
// (src/modules/registry.ts). Código em ./pedido.ts; uso em docs/PEDIDO.md.
import type { ModuleDefinition } from "../types";

export const pedidoModule: ModuleDefinition = {
  id: "pedido",
  name: "Pedido",
  version: "1.0.0",
  description:
    "Cardápio com fotos e adicionais, carrinho por link, pagamento por Pix, cartão ou na entrega, e o pedido acompanhado pelo WhatsApp e pelo quadro da cozinha.",
  builtin: true,
  default_enabled: false,
  management: NATIVE_MANAGEMENT_ITEMS.pedido,
  navigation: [
    { id: "pedidos", label: "Pedidos", place: "admin", admin: false },
    {
      id: "pedidos-cardapio",
      label: "Cardápio e loja",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "pedido_cardapio",
      label: "Cardápio",
      description:
        "Envia as imagens do cardápio e o botão Fazer pedido, que abre o carrinho. Com a loja fechada, responde com o horário.",
    },
    {
      type: "pedido_acompanhar",
      label: "Acompanhar pedido",
      description:
        "Mostra os pedidos em andamento do cliente, com o estado e o pagamento de cada um.",
    },
  ],
  events: [
    "pedido.created",
    "pedido.rejected",
    "pedido.status_changed",
    "pedido.paid",
    "pedido.payment_failed",
    "pedido.payment_expired",
    "pedido.payment_late",
    "pedido.refunded",
    "pedido.stale",
    "pedido.menu_changed",
    "pedido.store_changed",
    "pedido.discount_applied",
  ],
  settings: [
    {
      key: "pedido",
      description:
        "Horário de funcionamento, pausa, retirada e entrega, taxa, pedido mínimo, tempo estimado, formas de pagamento, alertas e mensagens ao cliente.",
    },
  ],
  routes: ["pedido"],
  operations: ["pedido."],
  scopes: [],
};
