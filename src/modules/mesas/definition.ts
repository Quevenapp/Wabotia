import { NATIVE_MANAGEMENT_ITEMS } from "../panel-navigation";
// Mesas: mesas e comandas, a conta aberta pelo garçom no celular, os pedidos
// lançados para a cozinha (pedidos do Pedido, no mesmo quadro), transferência
// e junção de mesas, conta parcial e dividida, taxa de serviço e fechamento.
// Declaração só com dados, lida pelo registro (src/modules/registry.ts).
// Código em ./mesas.ts; uso em docs/MESAS.md.
import type { ModuleDefinition } from "../types";

export const mesasModule: ModuleDefinition = {
  id: "mesas",
  erp_role: "vendas",
  integration: { route: "sale", uses: ["customers", "products", "stock", "finance"], operations: ["prepare", "execute", "lifecycle", "receive", "cancel", "reverse"], privacy: "commercial" },
  name: "Mesas",
  version: "1.0.0",
  description:
    "Mesas e comandas com conta aberta pelo garçom no celular: lança os itens do cardápio para o quadro da cozinha, transfere e junta mesas, divide a conta, cobra a taxa de serviço e fecha com a forma de pagamento.",
  builtin: true,
  default_enabled: false,
  management: NATIVE_MANAGEMENT_ITEMS.mesas,
  navigation: [{ id: "mesas", label: "Mesas", place: "admin", admin: false }],
  menu_item_types: [],
  events: [
    "mesas.tab_opened",
    "mesas.order_sent",
    "mesas.tab_updated",
    "mesas.bill_requested",
    "mesas.tab_reopened",
    "mesas.tab_transferred",
    "mesas.tab_merged",
    "mesas.payment_added",
    "mesas.payment_voided",
    "mesas.tab_closed",
    "mesas.tab_cancelled",
    "mesas.tables_changed",
  ],
  settings: [
    {
      key: "mesas",
      description:
        "Taxa de serviço (percentual e se entra nas contas novas) e quantas pessoas no máximo para dividir a conta.",
    },
  ],
  routes: ["mesas"],
  operations: ["mesas."],
  scopes: [],
  requires: ["pedido"],
  grants: [
    {
      id: "waiter",
      label: "Garçom",
      description:
        "Abre as mesas, lança os pedidos para a cozinha, transfere, junta, registra pagamentos e fecha a conta.",
    },
  ],
};
