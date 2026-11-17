// Entrega (módulo "entrega"): registra rotas, comandos e ganchos no núcleo
// (src/modules/api.ts). Regras em ./store.ts (entregas e posições) e
// ./notify.ts (mensagens ao cliente, rodada periódica, página). Uso:
// docs/ENTREGA.md; contrato: docs/API.md, seção "Entrega".
import { all } from "../../db";
import { now, requireValue } from "../../types";
import {
  courierDelivery,
  customerTurn,
  issueQr,
  listMessages,
  qrClaimed,
  sendMessage,
} from "./courier";
import {
  filteredHandlers,
  onConversationTurn,
  onCredentialClaim,
  onInboundContent,
  onMenuChoice,
  onRoute,
  onSchedule,
  onSettingsSave,
  onTelemetry,
  onWebStepPage,
} from "../api";
import { validateEntregaConfig } from "./config";
import {
  appParams,
  assign,
  available,
  cancel,
  config,
  createDelivery,
  deliveryView,
  detail,
  finish,
  isCourier,
  list,
  loadDelivery,
  positions,
  setDestination,
  start,
  visible,
} from "./store";
import {
  announceCancelled,
  announceDelivered,
  announceStart,
  customerLocation,
  runDue,
  trackView,
  whereIs,
} from "./notify";

// Ganchos do Pedido: estado, aviso de saída com o link e entregador no quadro.
import "./pedido-hooks";

const MODULE = "entrega";
// Toda resposta passa por `visible`: aplicação sem contacts:read não vê
// cliente, endereço nem posição; sem notes:read, nem a observação interna.
const { onRead, onCommand } = filteredHandlers(visible);

onSettingsSave(MODULE, "entrega", validateEntregaConfig);

// GET /profiles/:p/entrega: o que o app precisa (frequência do GPS, envio em
// lote) e se quem pergunta é entregador.
onRead(MODULE, "entrega", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  const cfg = await config(ctx);
  return {
    courier: await isCourier(ctx, actor),
    // Pessoas com o papel entrega:courier (entregadores com login).
    couriers: await ctx.grantees("courier"),
    app: appParams(cfg, {}),
    updates: cfg.updates,
    tracking_link: cfg.tracking_link,
    arriving_radius_m: cfg.arriving_radius_m,
    speed_kmh: cfg.speed_kmh,
    route_provider: cfg.route_provider,
    retention_hours: cfg.retention_hours,
  };
});

onRead(MODULE, "entrega/deliveries", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return list(ctx, actor, query);
});
onRead(MODULE, "entrega/deliveries/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return detail(ctx, params.id);
});
// App do entregador: as entregas atribuídas a ele, abertas.
onRead(MODULE, "entrega/mine", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  const cfg = await config(ctx);
  const rows = await all(
    ctx.env,
    "SELECT * FROM entrega_deliveries WHERE profile_id=? AND courier_id=? AND status IN ('assigned','en_route') ORDER BY status='en_route' DESC,created",
    ctx.profile,
    actor.id,
  );
  const at = now();
  return {
    courier: await isCourier(ctx, actor),
    data: rows.map((r) => deliveryView(r, cfg, at)),
    app: appParams(cfg, rows.find((r) => r.status === "en_route") || {}),
  };
});
// Pedidos com entrega ainda sem entrega aberta (para atribuir ou assumir).
onRead(MODULE, "entrega/available", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return available(ctx, actor);
});

// ---------------------------------------------------------------------------
// Entregador sem login: QR da entrega (./courier.ts)

// POST …/deliveries/:id/qr: a equipe gera o QR (painel e via impressa).
onRoute(MODULE, {
  method: "POST",
  path: "entrega/deliveries/:id/qr",
  op: "entrega.qr",
});
onCommand(MODULE, "entrega.qr", (ctx, actor, data) => issueQr(ctx, actor, data));
// O app leu o QR: quem leu vira o entregador (primeira leitura vence).
onCredentialClaim(MODULE, (ctx, credential) => qrClaimed(ctx, credential));

// O que o app do entregador mostra (credencial do QR ou pessoa atribuída).
// As rotas do app do entregador declaram `credential: true`: a credencial do
// QR só passa nelas, e só com o :id da entrega dela (o núcleo nega o resto).
onRead(
  MODULE,
  "entrega/deliveries/:id/courier",
  (ctx, actor, { params }) => courierDelivery(ctx, actor, params.id),
  { credential: true },
);

// Conversa da entrega: entregador ↔ loja (store) e entregador ↔ cliente
// (customer, pelo WhatsApp da loja).
onRead(
  MODULE,
  "entrega/deliveries/:id/messages",
  (ctx, actor, { params, query }) => listMessages(ctx, actor, params.id, query),
  { credential: true },
);
onRoute(MODULE, {
  method: "POST",
  path: "entrega/deliveries/:id/messages",
  credential: true,
  op: "entrega.message",
});
onCommand(MODULE, "entrega.message", (ctx, actor, data, { requestId }) =>
  sendMessage(ctx, actor, data, requestId),
);
// Resposta do cliente no WhatsApp com uma entrega aberta: vai ao app.
onConversationTurn(MODULE, (ctx, c, turn) => customerTurn(ctx, c, turn));

onRoute(MODULE, {
  method: "POST",
  path: "entrega/deliveries",
  op: "entrega.create",
});
onCommand(MODULE, "entrega.create", (ctx, actor, data, { requestId }) =>
  createDelivery(ctx, actor, data, requestId),
);

onRoute(MODULE, {
  method: "POST",
  path: "entrega/deliveries/:id/assign",
  op: "entrega.assign",
});
onCommand(MODULE, "entrega.assign", (ctx, actor, data) =>
  assign(ctx, actor, data),
);

onRoute(MODULE, {
  method: "POST",
  path: "entrega/deliveries/:id/destination",
  credential: true,
  op: "entrega.destination",
});
onCommand(MODULE, "entrega.destination", (ctx, actor, data) =>
  setDestination(ctx, actor, data),
);

onRoute(MODULE, {
  method: "POST",
  path: "entrega/deliveries/:id/start",
  credential: true,
  op: "entrega.start",
});
onCommand(MODULE, "entrega.start", async (ctx, actor, data, { requestId }) => {
  const view = await start(ctx, actor, data, requestId);
  await announceStart(ctx, await loadDelivery(ctx, view.id));
  return view;
});

onRoute(MODULE, {
  method: "POST",
  path: "entrega/deliveries/:id/delivered",
  credential: true,
  op: "entrega.deliver",
});
onCommand(
  MODULE,
  "entrega.deliver",
  async (ctx, actor, data, { requestId }) => {
    const view = await finish(ctx, actor, data, requestId);
    await announceDelivered(ctx, await loadDelivery(ctx, view.id));
    return view;
  },
);

onRoute(MODULE, {
  method: "POST",
  path: "entrega/deliveries/:id/cancel",
  credential: true,
  op: "entrega.cancel",
});
onCommand(MODULE, "entrega.cancel", async (ctx, actor, data) => {
  const view = await cancel(ctx, actor, data);
  await announceCancelled(ctx, await loadDelivery(ctx, view.id));
  return view;
});

// Lote de posições do app (fora do Coordinator, sem Idempotency-Key): só o
// entregador da entrega, só com a rota iniciada.
onTelemetry(
  MODULE,
  "entrega/deliveries/:id/positions",
  async (ctx, actor, { params, body }) => {
    // Pessoa entregadora ou a credencial do QR desta entrega (conferido no
    // positions); aplicações e conectores, não.
    requireValue(
      actor.kind === "user" || !!actor.credential,
      "Só o entregador envia posições.",
    );
    return positions(ctx, actor, params.id, body);
  },
  { credential: true },
);

// Página de acompanhamento do cliente (link de uso único, com prazo).
onWebStepPage(MODULE, (ctx, step) => trackView(ctx, step));

// WhatsApp: "Onde está minha entrega" e a localização enviada pelo cliente.
onMenuChoice("entrega_onde", (ctx, c, _item, { rowId }) =>
  whereIs(ctx, c, rowId),
);
onInboundContent(MODULE, "location", (ctx, c, content, { rowId }) =>
  customerLocation(ctx, c, content, rowId),
);

// Avisos de chegada, atualizações periódicas, sinal perdido e retenção.
onSchedule(MODULE, (ctx, { now: at }) => runDue(ctx, at));
