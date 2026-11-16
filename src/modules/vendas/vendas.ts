// Vendas e orçamento (módulo "vendas"): registra rotas, comandos e ganchos no
// núcleo (src/modules/api.ts). Catálogo em ./catalog.ts, estoque em
// ./stock.ts, orçamento em ./quotes.ts, venda em ./sales.ts, comprovante em
// ./receipt.ts, nota fiscal em ./fiscal.ts. Uso: docs/VENDAS.md.
import { now } from "../../types";
import {
  onCommand,
  onConversationTurn,
  onMcpTool,
  onMenuChoice,
  onPaymentUpdated,
  onRead,
  onRoute,
  onSchedule,
  onSettingsSave,
  onWebStepCompleted,
  type ModuleContext,
} from "../api";
import type { Actor } from "../../types";
import { one } from "../../db";
import { validateVendasSettings, vendasSettings, PAYMENT_LABELS, type PaymentMethod } from "./model";
import {
  deleteCategory,
  deleteProduct,
  listCategories,
  listProducts,
  loadProduct,
  productByCode,
  productView,
  publicCatalog,
  saveCategory,
  saveProduct,
} from "./catalog";
import { listMoves, manualMoves } from "./stock";
import {
  cancelQuote,
  convertQuote,
  decide,
  expireDue,
  listQuotes,
  loadQuote,
  quoteStepCompleted,
  quoteTurn,
  quoteView,
  quotesOfCustomer,
  saveQuote,
  sendMyQuotes,
  sendQuote,
  visibleQuote,
} from "./quotes";
import {
  cancelSale,
  createSale,
  listSales,
  paymentUpdated,
  returnSale,
  saleDetail,
  visibleSale,
} from "./sales";
import { quotePrint, saleReceipt } from "./receipt";
import { emitFiscal, fiscalOverview, fiscalPreview } from "./fiscal";

const MODULE = "vendas";

/** Aplica a visão do ator a vendas e orçamentos em qualquer resposta. */
function visible(ctx: ModuleContext, actor: Actor, value: any): any {
  if (Array.isArray(value)) return value.map((v) => visible(ctx, actor, v));
  if (!value || typeof value !== "object") return value;
  const out: any = {};
  for (const [k, v] of Object.entries(value))
    out[k] =
      k === "data" || k === "sale" || k === "quote"
        ? visible(ctx, actor, v)
        : v;
  if (typeof out.number === "number" && out.customer && Array.isArray(out.lines))
    return "sale_discount_cents" in out
      ? visibleSale(ctx, actor, out)
      : visibleQuote(ctx, actor, out);
  return out;
}

// ---------------------------------------------------------------------------
// WhatsApp

onSettingsSave(MODULE, "vendas", validateVendasSettings);

// Resposta ao orçamento: botões, 1/2 (QR) ou APROVAR/RECUSAR, antes do menu.
onConversationTurn(MODULE, (ctx, c, turn) => quoteTurn(ctx, c, turn));

onMenuChoice("vendas_orcamentos", (ctx, c, _item, { rowId }) =>
  sendMyQuotes(ctx, c, rowId),
);

onWebStepCompleted(MODULE, async (ctx, step, answers) => {
  if (step.kind !== "quote") return;
  return quoteStepCompleted(ctx, step as any, answers as any);
});

onPaymentUpdated(MODULE, (ctx, payment, { previous }) =>
  paymentUpdated(ctx, payment, previous),
);

onSchedule(MODULE, async (ctx, { now: at }) => {
  await expireDue(ctx, at);
});

// ---------------------------------------------------------------------------
// Visão geral

onRead(MODULE, "vendas", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  const cfg = vendasSettings(await ctx.settings());
  const [counts, ready] = await Promise.all([
    one(
      ctx.env,
      "SELECT (SELECT count(*) FROM vendas_quotes WHERE profile_id=?1 AND status='sent' AND valid_until>?2) quotes_pending, (SELECT count(*) FROM vendas_quotes WHERE profile_id=?1 AND status='approved') quotes_approved, (SELECT count(*) FROM vendas_products WHERE profile_id=?1 AND active=1 AND track_stock=1 AND min_stock_milli>0 AND stock_milli<=min_stock_milli) low_stock, (SELECT count(*) FROM vendas_sales WHERE profile_id=?1 AND status='awaiting_payment') awaiting_payment, (SELECT count(*) FROM vendas_sales WHERE profile_id=?1 AND needs_refund=1) needs_refund",
      ctx.profile,
      now(),
    ),
    ctx.paymentsReady(),
  ]);
  return {
    config: cfg,
    payment_methods: (Object.keys(cfg.payment_methods) as PaymentMethod[])
      .filter((m) => cfg.payment_methods[m])
      .map((id) => ({ id, label: PAYMENT_LABELS[id] })),
    online_payments: ready,
    counts,
  };
});

// ---------------------------------------------------------------------------
// Catálogo

onRead(MODULE, "vendas/categories", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return { data: await listCategories(ctx) };
});
onRoute(MODULE, { method: "POST", path: "vendas/categories", op: "vendas.category.save" });
onRoute(MODULE, { method: "PUT", path: "vendas/categories/:id", op: "vendas.category.save" });
onRoute(MODULE, { method: "DELETE", path: "vendas/categories/:id", op: "vendas.category.delete" });
onCommand(MODULE, "vendas.category.save", (ctx, actor, data) => saveCategory(ctx, actor, data));
onCommand(MODULE, "vendas.category.delete", (ctx, actor, data) => deleteCategory(ctx, actor, data.id));

onRead(MODULE, "vendas/products", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return listProducts(ctx, query);
});
onRead(MODULE, "vendas/products/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return productView(await loadProduct(ctx, params.id));
});
// Leitor de código de barras: EAN ou SKU.
onRead(MODULE, "vendas/lookup", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return productByCode(ctx, query.code);
});
// Catálogo sem custo nem saldo exato (bots e integrações).
onRead(MODULE, "vendas/catalog", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return publicCatalog(ctx, query);
});
onRoute(MODULE, { method: "POST", path: "vendas/products", op: "vendas.product.save" });
onRoute(MODULE, { method: "PUT", path: "vendas/products/:id", op: "vendas.product.save" });
onRoute(MODULE, { method: "DELETE", path: "vendas/products/:id", op: "vendas.product.delete" });
onCommand(MODULE, "vendas.product.save", (ctx, actor, data) => saveProduct(ctx, actor, data));
onCommand(MODULE, "vendas.product.delete", (ctx, actor, data) => deleteProduct(ctx, actor, data.id));

// ---------------------------------------------------------------------------
// Estoque

onRead(MODULE, "vendas/stock/moves", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return listMoves(ctx, query);
});
onRoute(MODULE, { method: "POST", path: "vendas/stock/moves", op: "vendas.stock.move" });
onCommand(MODULE, "vendas.stock.move", (ctx, actor, data, { requestId }) =>
  manualMoves(ctx, actor, data, requestId),
);

// ---------------------------------------------------------------------------
// Orçamentos

onRead(MODULE, "vendas/quotes", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return visible(ctx, actor, await listQuotes(ctx, ctx.safeQuery(actor, query)));
});
onRead(MODULE, "vendas/quotes/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return visibleQuote(ctx, actor, quoteView(await loadQuote(ctx, params.id)));
});
onRead(MODULE, "vendas/quotes/:id/print", async (ctx, actor, { params, query }) => {
  ctx.access(actor, "conversations:read");
  return quotePrint(ctx, params.id, query, actor);
});
onRoute(MODULE, { method: "POST", path: "vendas/quotes", op: "vendas.quote.save" });
onRoute(MODULE, { method: "PUT", path: "vendas/quotes/:id", op: "vendas.quote.save" });
onCommand(MODULE, "vendas.quote.save", async (ctx, actor, data, { requestId }) =>
  visible(ctx, actor, await saveQuote(ctx, actor, data, requestId)),
);
onRoute(MODULE, { method: "POST", path: "vendas/quotes/:id/send", op: "vendas.quote.send" });
onCommand(MODULE, "vendas.quote.send", async (ctx, actor, data) =>
  visible(ctx, actor, await sendQuote(ctx, actor, data)),
);
onRoute(MODULE, { method: "POST", path: "vendas/quotes/:id/decision", op: "vendas.quote.decide" });
onCommand(MODULE, "vendas.quote.decide", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const row = await loadQuote(ctx, data.id);
  return visibleQuote(
    ctx,
    actor,
    quoteView(
      await decide(ctx, row, data.decision, actor.id, actor.kind === "user" ? "panel" : "api", data.note),
    ),
  );
});
onRoute(MODULE, { method: "POST", path: "vendas/quotes/:id/convert", op: "vendas.quote.convert" });
onCommand(MODULE, "vendas.quote.convert", async (ctx, actor, data) =>
  visible(ctx, actor, await convertQuote(ctx, actor, data)),
);
onRoute(MODULE, { method: "POST", path: "vendas/quotes/:id/cancel", op: "vendas.quote.cancel" });
onCommand(MODULE, "vendas.quote.cancel", async (ctx, actor, data) =>
  visible(ctx, actor, await cancelQuote(ctx, actor, data)),
);

// ---------------------------------------------------------------------------
// Vendas

onRead(MODULE, "vendas/sales", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return visible(ctx, actor, await listSales(ctx, ctx.safeQuery(actor, query)));
});
onRead(MODULE, "vendas/sales/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return visibleSale(ctx, actor, await saleDetail(ctx, params.id));
});
onRead(MODULE, "vendas/sales/:id/receipt", async (ctx, actor, { params, query }) => {
  ctx.access(actor, "conversations:read");
  return saleReceipt(ctx, params.id, query, actor);
});
onRoute(MODULE, { method: "POST", path: "vendas/sales", op: "vendas.sale.create" });
onCommand(MODULE, "vendas.sale.create", async (ctx, actor, data, { requestId }) =>
  visibleSale(
    ctx,
    actor,
    await createSale(ctx, actor, {
      ...data,
      source: actor.kind === "user" && !actor.id.startsWith("bot:") ? "panel" : "api",
      session_id: null,
      quote_id: null,
      sourceKey: `command:${actor.id}:${requestId}`,
    }),
  ),
);
onRoute(MODULE, { method: "POST", path: "vendas/sales/:id/cancel", op: "vendas.sale.cancel" });
onCommand(MODULE, "vendas.sale.cancel", async (ctx, actor, data) =>
  visibleSale(ctx, actor, await cancelSale(ctx, actor, data)),
);
onRoute(MODULE, { method: "POST", path: "vendas/sales/:id/return", op: "vendas.sale.return" });
onCommand(MODULE, "vendas.sale.return", async (ctx, actor, data, { requestId }) =>
  visible(ctx, actor, await returnSale(ctx, actor, data, requestId)),
);

// ---------------------------------------------------------------------------
// Nota fiscal (sem emissor integrado: prévia, pendências e a interface)

onRead(MODULE, "vendas/fiscal", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return fiscalOverview(ctx);
});
onRead(MODULE, "vendas/sales/:id/fiscal", async (ctx, actor, { params, query }) => {
  ctx.access(actor, "conversations:read");
  const preview = await fiscalPreview(ctx, params.id, query);
  if (!ctx.mayRead(actor, "contacts") && preview.document.recipient)
    preview.document.recipient = null;
  return preview;
});
onRoute(MODULE, { method: "POST", path: "vendas/sales/:id/fiscal/emit", op: "vendas.fiscal.emit" });
onCommand(MODULE, "vendas.fiscal.emit", (ctx, actor, data, { requestId }) =>
  emitFiscal(ctx, actor, data, requestId),
);

// ---------------------------------------------------------------------------
// Ferramentas MCP para bots

onMcpTool(MODULE, {
  name: "vendas_catalogo",
  description:
    "Produtos à venda da área: nome, preço em centavos, unidade e se há em estoque (available). Busca por q (nome ou código) e category_id. Sem custo nem saldo exato. Requer conversations:read.",
  input: {
    q: { type: "string" },
    category_id: { type: "string" },
  },
  call: (a, profile) => ({
    path: `/profiles/${profile}/vendas/catalog`,
    query: { q: a.q, category_id: a.category_id },
  }),
});
// Só o cliente da conversa: o bot não consulta orçamentos de outro telefone.
onMcpTool(MODULE, {
  name: "vendas_orcamentos",
  description:
    "Orçamentos do cliente da conversa (desta conversa ou do mesmo telefone): número, itens, total, validade e situação. Requer conversations:read.",
  input: { conversation_id: { type: "string" } },
  required: ["conversation_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/vendas/conversations/${a.conversation_id}`,
  }),
});
onRead(MODULE, "vendas/conversations/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  const c = await ctx.conversation(params.id, actor);
  return ctx.botView(actor, {
    data: (await quotesOfCustomer(ctx, c)).map((q) => visibleQuote(ctx, actor, q)),
  });
});
