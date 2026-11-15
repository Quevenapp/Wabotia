// Ponto de extensão do painel da conversa (Dados da conversa) para módulos.
// Cada módulo acrescenta UMA linha: o id do módulo e o componente. O painel
// mostra o componente só com o módulo ligado e fora de grupos
// (docs/MODULOS.md, "Painel web").
import type React from "react";
import type { Row } from "../lib/api";
import { ConversationAgenda } from "./agenda/ConversationAgenda";
import { ConversationServiceOrders } from "./os/ConversationServiceOrders";
import { ConversationPedido } from "./pedido/ConversationPedido";
import { ConversationSuporte } from "./suporte/ConversationSuporte";

export interface ConversationExtensionProps {
  /** A conversa (detail.conversation). */
  conversation: Row;
  /** Nome mostrado (contato salvo ou telefone). */
  name: string;
}

export const conversationExtensions: {
  module: string;
  Component: React.ComponentType<ConversationExtensionProps>;
}[] = [
  { module: "agenda", Component: ConversationAgenda },
  { module: "os", Component: ConversationServiceOrders },
  { module: "pedido", Component: ConversationPedido },
  { module: "suporte", Component: ConversationSuporte },
];
