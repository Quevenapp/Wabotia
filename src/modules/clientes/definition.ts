// Cadastro de clientes (módulo "clientes", docs/CLIENTES.md): ficha com os
// dados de destinatário de nota fiscal, linha do tempo do relacionamento,
// autocadastro pelo passo web, dados mascarados para a equipe com revelação
// auditada e exclusão a pedido do titular (LGPD).
import type { ModuleDefinition } from "../types";

export const clientesModule: ModuleDefinition = {
  id: "clientes",
  name: "Cadastro de clientes",
  version: "1.0.0",
  description:
    "Ficha do cliente para nota fiscal, preenchida por ele pelo WhatsApp, com dados mascarados para a equipe, linha do tempo do relacionamento e exclusão a pedido do titular.",
  builtin: true,
  default_enabled: false,
  navigation: [
    { id: "clientes", label: "Clientes", place: "admin", admin: false },
    {
      id: "clientes-settings",
      label: "Cadastro e privacidade",
      place: "admin",
      admin: true,
    },
  ],
  menu_item_types: [
    {
      type: "clientes_cadastro",
      label: "Meu cadastro",
      description:
        "Envia o link para o cliente preencher ou corrigir o próprio cadastro.",
    },
    {
      type: "clientes_exclusao",
      label: "Excluir meus dados",
      description:
        "Pede ao cliente a confirmação para excluir os dados pessoais dele (LGPD).",
    },
  ],
  events: [
    "clientes.customer_created",
    "clientes.customer_updated",
    "clientes.erasure_requested",
    "clientes.erasure_cancelled",
    "clientes.customer_erased",
  ],
  settings: [
    {
      key: "clientes",
      description:
        "Quem revela dados, texto do aceite, campos obrigatórios, palavras de exclusão e prazo de guarda fiscal.",
    },
  ],
  routes: ["clientes"],
  operations: ["clientes."],
  scopes: [],
};
