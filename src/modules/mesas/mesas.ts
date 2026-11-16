// Mesas (módulo "mesas", depende do Pedido): registra rotas e comandos no
// núcleo (src/modules/api.ts). Os pedidos da mesa são pedidos do Pedido
// (../pedido/public.ts) e aparecem no quadro da cozinha. Uso: docs/MESAS.md.
import { now } from "../../types";
import { onCommand, onRead, onRoute, onSettingsSave } from "../api";
import { validateMesasConfig } from "./model";
import { createTables, deleteTable, updateTable } from "./tables";
import {
  addPayment,
  cancelTab,
  closeTab,
  listTabs,
  mergeTab,
  openTab,
  overview,
  reopenTab,
  requestBill,
  sendOrder,
  tabDetail,
  transferTab,
  updateTab,
  voidPayment,
} from "./tabs";
import { tabBill } from "./bill";

const MODULE = "mesas";

onSettingsSave(MODULE, "mesas", validateMesasConfig);

// ---------------------------------------------------------------------------
// Leitura: mapa das mesas, contas, detalhe e a conta para imprimir.

onRead(MODULE, "mesas", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return overview(ctx, now());
});
onRead(MODULE, "mesas/tabs", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return listTabs(ctx, query);
});
onRead(MODULE, "mesas/tabs/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return tabDetail(ctx, actor, params.id);
});
onRead(MODULE, "mesas/tabs/:id/bill", async (ctx, actor, { params, query }) => {
  ctx.access(actor, "conversations:read");
  return tabBill(ctx, actor, params.id, query);
});

// ---------------------------------------------------------------------------
// Cadastro das mesas e comandas (administrador).

onRoute(MODULE, {
  method: "POST",
  path: "mesas/tables",
  op: "mesas.table.create",
});
onRoute(MODULE, {
  method: "PUT",
  path: "mesas/tables/:id",
  op: "mesas.table.update",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "mesas/tables/:id",
  op: "mesas.table.delete",
});
onCommand(MODULE, "mesas.table.create", (ctx, actor, data) =>
  createTables(ctx, actor, data),
);
onCommand(MODULE, "mesas.table.update", (ctx, actor, data) =>
  updateTable(ctx, actor, data),
);
onCommand(MODULE, "mesas.table.delete", (ctx, actor, data) =>
  deleteTable(ctx, actor, data.id),
);

// ---------------------------------------------------------------------------
// Conta da mesa (qualquer pessoa da equipe; aplicações: conversations:write).

const write = (path: string, op: string, method: "POST" | "PATCH" = "POST") =>
  onRoute(MODULE, { method, path, op });

write("mesas/tabs", "mesas.tab.open");
write("mesas/tabs/:id", "mesas.tab.update", "PATCH");
write("mesas/tabs/:id/orders", "mesas.order.send");
write("mesas/tabs/:id/bill", "mesas.tab.bill");
write("mesas/tabs/:id/reopen", "mesas.tab.reopen");
write("mesas/tabs/:id/transfer", "mesas.tab.transfer");
write("mesas/tabs/:id/merge", "mesas.tab.merge");
write("mesas/tabs/:id/payments", "mesas.payment.add");
write("mesas/payments/:id/void", "mesas.payment.void");
write("mesas/tabs/:id/close", "mesas.tab.close");
write("mesas/tabs/:id/cancel", "mesas.tab.cancel");

onCommand(MODULE, "mesas.tab.open", (ctx, actor, data) =>
  openTab(ctx, actor, data),
);
onCommand(MODULE, "mesas.tab.update", (ctx, actor, data) =>
  updateTab(ctx, actor, data),
);
onCommand(MODULE, "mesas.order.send", (ctx, actor, data, { requestId }) =>
  sendOrder(ctx, actor, data, requestId),
);
onCommand(MODULE, "mesas.tab.bill", (ctx, actor, data) =>
  requestBill(ctx, actor, data),
);
onCommand(MODULE, "mesas.tab.reopen", (ctx, actor, data) =>
  reopenTab(ctx, actor, data),
);
onCommand(MODULE, "mesas.tab.transfer", (ctx, actor, data) =>
  transferTab(ctx, actor, data),
);
onCommand(MODULE, "mesas.tab.merge", (ctx, actor, data) =>
  mergeTab(ctx, actor, data),
);
onCommand(MODULE, "mesas.payment.add", (ctx, actor, data) =>
  addPayment(ctx, actor, data),
);
onCommand(MODULE, "mesas.payment.void", (ctx, actor, data) =>
  voidPayment(ctx, actor, data),
);
onCommand(MODULE, "mesas.tab.close", (ctx, actor, data) =>
  closeTab(ctx, actor, data),
);
onCommand(MODULE, "mesas.tab.cancel", (ctx, actor, data) =>
  cancelTab(ctx, actor, data),
);
