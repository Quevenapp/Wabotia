// Caixa (módulo "caixa"): rotas e comandos do PDV. Depende de Vendas
// (requires) e usa só ../vendas/public.ts. Uso: docs/CAIXA.md.
import { ApiError, requireValue } from "../../types";
import { one } from "../../db";
import { onCommand, onRead, onRoute } from "../api";
import {
  catalogGrid,
  createSessionSale,
  paymentMethods,
  productByCode,
  registerSaleGuard,
  returnInSession,
  sale as loadSaleView,
} from "../vendas/public";
import {
  closeSession,
  listRegisters,
  listSessions,
  loadSession,
  mayOperate,
  moveCash,
  openSession,
  reportText,
  requireCashier,
  requireOpen,
  saveRegister,
  sessionDetail,
  sessionSummary,
  sessionView,
} from "./store";

const MODULE = "caixa";

// Venda de uma sessão já fechada não se cancela (o dinheiro do fechamento
// já foi conferido): faz-se a devolução no caixa aberto.
registerSaleGuard(async (ctx, sale, action) => {
  if (action !== "cancel" || !sale.session_id) return;
  const session = await one(
    ctx.env,
    "SELECT number,status FROM caixa_sessions WHERE id=? AND profile_id=?",
    sale.session_id,
    ctx.profile,
  );
  if (session && session.status !== "open")
    throw new ApiError(
      409,
      "session_closed",
      `A venda nº ${sale.number} é do caixa nº ${session.number}, já fechado. Registre uma devolução no caixa aberto.`,
    );
});

// ---------------------------------------------------------------------------
// Leituras

onRead(MODULE, "caixa", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  const [registers, methods, online, operate] = await Promise.all([
    listRegisters(ctx),
    paymentMethods(ctx),
    ctx.paymentsReady(),
    mayOperate(ctx, actor),
  ]);
  return {
    registers,
    payment_methods: methods,
    online_payments: online,
    // Papel caixa:cashier, administrador ou aplicação com billing:write.
    can_operate: operate,
  };
});

onRead(MODULE, "caixa/grid", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return catalogGrid(ctx);
});

onRead(MODULE, "caixa/lookup", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return productByCode(ctx, query.code);
});

onRead(MODULE, "caixa/sessions", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return listSessions(ctx, query);
});

onRead(MODULE, "caixa/sessions/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return sessionDetail(ctx, params.id);
});

onRead(MODULE, "caixa/sessions/:id/report", async (ctx, actor, { params, query }) => {
  ctx.access(actor, "conversations:read");
  const columns = query.columns ? Number(query.columns) : 32;
  requireValue([32, 42, 48].includes(columns), "columns: 32, 42 ou 48.");
  const row = await loadSession(ctx, params.id);
  const session = sessionView(
    row,
    row.status === "open" ? await sessionSummary(ctx, row) : null,
  );
  const establishment = await ctx.establishment();
  return {
    columns,
    establishment,
    session,
    text: reportText(establishment.name, session, columns),
  };
});

// ---------------------------------------------------------------------------
// Caixas (administrador)

onRoute(MODULE, { method: "POST", path: "caixa/registers", op: "caixa.register.save" });
onRoute(MODULE, { method: "PUT", path: "caixa/registers/:id", op: "caixa.register.save" });
onCommand(MODULE, "caixa.register.save", (ctx, actor, data) => saveRegister(ctx, actor, data));

// ---------------------------------------------------------------------------
// Sessão: abrir, sangria/suprimento, vender, devolver, fechar

onRoute(MODULE, { method: "POST", path: "caixa/registers/:id/open", op: "caixa.open" });
onCommand(MODULE, "caixa.open", (ctx, actor, data, { requestId }) =>
  openSession(ctx, actor, data, requestId),
);

onRoute(MODULE, { method: "POST", path: "caixa/sessions/:id/moves", op: "caixa.move" });
onCommand(MODULE, "caixa.move", (ctx, actor, data, { requestId }) =>
  moveCash(ctx, actor, data, requestId),
);

onRoute(MODULE, { method: "POST", path: "caixa/sessions/:id/sales", op: "caixa.sale" });
onCommand(MODULE, "caixa.sale", async (ctx, actor, data, { requestId }) => {
  await requireCashier(ctx, actor);
  const session = await loadSession(ctx, data.id);
  requireOpen(session);
  const { id: _id, ...request } = data;
  return createSessionSale(ctx, actor, session.id, request, `caixa:${requestId}`);
});

onRoute(MODULE, { method: "POST", path: "caixa/sessions/:id/returns", op: "caixa.return" });
onCommand(MODULE, "caixa.return", async (ctx, actor, data, { requestId }) => {
  await requireCashier(ctx, actor);
  const session = await loadSession(ctx, data.id);
  requireOpen(session);
  requireValue(typeof data.sale_id === "string", "Informe a venda (sale_id).");
  await loadSaleView(ctx, data.sale_id);
  return returnInSession(
    ctx,
    actor,
    data.sale_id,
    session.id,
    { items: data.items, method: data.method, reason: data.reason },
    requestId,
  );
});

onRoute(MODULE, { method: "POST", path: "caixa/sessions/:id/close", op: "caixa.close" });
onCommand(MODULE, "caixa.close", (ctx, actor, data) => closeSession(ctx, actor, data));
