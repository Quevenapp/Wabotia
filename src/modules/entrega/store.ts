import { hash } from "../../integrations/keys";
import { commerceGuard } from "../pedido/public";
import { deliveryCreationStatements, deliveryLifecycleStatements, deliveryCommercial } from "./integration";
// Entregas: criar, atribuir, iniciar a rota, receber posições, concluir e
// cancelar. As escritas da equipe e do app passam pelos comandos (Coordinator);
// só o lote de posições usa a rota de telemetria (uma escrita por lote, fora
// do Coordinator). Regras em docs/ENTREGA.md.
import { all, batch, exec, one } from "../../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  json,
  now,
  requireValue,
  uid,
} from "../../types";
import { BRASILIA_OFFSET_MS } from "../../business-time";
import type { ModuleContext } from "../api";
import { entregaConfig, type EntregaConfig } from "./config";
import {
  distanceM,
  routeProvider,
  trailSpeedKmh,
  validLat,
  validLng,
  type Point,
  type TrailPoint,
} from "./geo";
import {
  addressIncomplete,
  addressInput,
  completeAddress,
  readAddress,
  storeRef,
  type DeliveryAddress,
} from "./address";

export const STATUSES = [
  "pending",
  "assigned",
  "en_route",
  "delivered",
  "cancelled",
] as const;
export type DeliveryStatus = (typeof STATUSES)[number];
export const OPEN: readonly DeliveryStatus[] = ["pending", "assigned", "en_route"];
export const STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "Sem entregador",
  assigned: "Aguardando saída",
  en_route: "A caminho",
  delivered: "Entregue",
  cancelled: "Cancelada",
};
export const SOURCES = ["pedido", "manual"] as const;
export type DeliverySource = (typeof SOURCES)[number];

/** Rota esquecida aberta: depois disso a posição não é mais aceita. */
export const MAX_ROUTE_MS = 8 * 3600000;
/** Pontos guardados no rastro (só para a velocidade média). */
const TRAIL_MAX = 12;
/** Pontos aceitos por lote. */
export const MAX_BATCH = 200;
/** Precisão pior que isso (metros) não entra. */
const MAX_ACCURACY_M = 300;

export const config = async (ctx: ModuleContext): Promise<EntregaConfig> =>
  entregaConfig(await ctx.settings());

/** "19:40" no horário de Brasília. */
export function hhmm(at: number) {
  const d = new Date(at - BRASILIA_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

const firstName = (name: string) =>
  String(name || "").trim().split(/\s+/)[0]?.slice(0, 40) || "";

// ---------------------------------------------------------------------------
// Leitura

export async function loadDelivery(ctx: ModuleContext, id: unknown) {
  requireValue(typeof id === "string" && id, "Informe a entrega.");
  const row = await one(
    ctx.env,
    "SELECT * FROM entrega_deliveries WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Entrega não encontrada.");
  return row;
}

export interface DeliveryRow {
  [key: string]: any;
}

/** Sinal do GPS: ok, stale (sem posição recente) ou none (nenhuma ainda). */
export function signalOf(row: DeliveryRow, cfg: EntregaConfig, at: number) {
  if (row.status !== "en_route") return null;
  if (!row.last_at) return "none";
  return at - row.last_at > cfg.app.stale_minutes * 60000 ? "stale" : "ok";
}

/** Visão da entrega para a equipe e os apps (dados pessoais tirados depois). */
export function deliveryView(row: DeliveryRow, cfg: EntregaConfig, at = now()) {
  const position =
    row.last_at && row.last_lat !== null && row.status === "en_route"
      ? {
          lat: row.last_lat,
          lng: row.last_lng,
          accuracy_m: row.last_accuracy,
          speed_mps: row.last_speed,
          battery: row.last_battery,
          at: row.last_at,
        }
      : null;
  return {
    commercial: deliveryCommercial(row),
    id: row.id,
    source: row.source,
    source_ref: row.source_ref,
    label: row.label,
    conversation_id: row.conversation_id,
    customer_name: row.customer_name,
    address_text: row.address_text,
    /** Campos separados (mesmos nomes do pedido e da Empresa do ERP), já com a cidade da loja quando faltava. */
    address: readAddress(json(row.address, null)),
    /** Sem cidade e sem destino: o app avisa o entregador em vez de procurar às cegas. */
    address_incomplete: addressIncomplete(
      readAddress(json(row.address, null)),
      row.dest_lat !== null && row.dest_lat !== undefined,
    ),
    destination:
      row.dest_lat !== null && row.dest_lat !== undefined
        ? { lat: row.dest_lat, lng: row.dest_lng, source: row.dest_source }
        : null,
    courier: row.courier_id
      ? { id: row.courier_id, name: row.courier_name }
      : null,
    status: row.status as DeliveryStatus,
    status_label: STATUS_LABELS[row.status as DeliveryStatus] || row.status,
    position,
    signal: signalOf(row, cfg, at),
    eta:
      row.status === "en_route" && row.eta_at
        ? {
            at: row.eta_at,
            minutes: Math.max(0, Math.ceil((row.eta_at - at) / 60000)),
            distance_m: row.distance_m,
          }
        : null,
    arriving: !!row.arriving_at,
    updates_sent: row.updates_sent,
    tracking_step_id: row.track_step_id,
    note: row.note,
    cancel_reason: row.cancel_reason,
    assigned_at: row.assigned_at,
    started_at: row.started_at,
    arriving_at: row.arriving_at,
    delivered_at: row.delivered_at,
    cancelled_at: row.cancelled_at,
    position_purged: !!row.purged_at,
    created_by: row.created_by,
    created: row.created,
    updated: row.updated,
  };
}
export type DeliveryView = ReturnType<typeof deliveryView>;

/** Campos de dado pessoal (cliente e posição do entregador). */
export const PERSONAL = [
  "customer_name",
  "address_text",
  "address",
  "destination",
  "position",
  "conversation_id",
];

/**
 * Visão do entregador do QR: o destino e o necessário para entregar, sem a
 * conversa, o telefone, o sobrenome do cliente, notas internas e histórico.
 */
export function courierSafe(view: Record<string, any>) {
  const {
    conversation_id: _c,
    note: _n,
    history: _h,
    commercial: _commercial,
    created_by: _b,
    customer_name,
    ...rest
  } = view;
  return { ...rest, customer_name: firstName(customer_name || "") };
}

/**
 * Visão para o ator: aplicação sem contacts:read não vê cliente, endereço nem
 * posição; sem notes:read, não vê a observação interna.
 */
export function visible(ctx: ModuleContext, actor: Actor, value: any): any {
  if (Array.isArray(value)) return value.map((v) => visible(ctx, actor, v));
  if (value && typeof value === "object" && Array.isArray(value.data))
    return { ...value, data: visible(ctx, actor, value.data) };
  if (value && typeof value === "object" && "status_label" in value && actor.credential)
    return courierSafe(value);
  if (value && typeof value === "object" && "status_label" in value)
    return ctx.redact(actor, value, {
      contacts: PERSONAL,
      notes: ["note", "history"],
    });
  return value;
}

export async function history(
  ctx: ModuleContext,
  id: string,
  status: string,
  actor: string,
  note = "",
) {
  await exec(
    ctx.env,
    "INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,?,?,?,?)",
    uid(),
    ctx.profile,
    id,
    status,
    actor,
    note.slice(0, 500),
    now(),
  );
}

export async function detail(ctx: ModuleContext, id: string) {
  const row = await loadDelivery(ctx, id);
  const cfg = await config(ctx);
  return {
    ...deliveryView(row, cfg),
    // QRs gerados e quem leu (nome digitado, aparelho, hora): a loja confere
    // e gera outro QR se não reconhecer (o anterior é revogado).
    access: await ctx.credentials(row.id),
    history: await all(
      ctx.env,
      "SELECT status,actor,note,created FROM entrega_history WHERE delivery_id=? AND profile_id=? ORDER BY created,rowid",
      row.id,
      ctx.profile,
    ),
  };
}

/** Lista: abertas por padrão; filtros status, courier (id ou "me"), conversation_id. */
export async function list(
  ctx: ModuleContext,
  actor: Actor,
  query: Record<string, string>,
) {
  const cfg = await config(ctx);
  const where = ["profile_id=?"],
    args: any[] = [ctx.profile];
  if (query.status) {
    const statuses = query.status.split(",").filter((s) =>
      (STATUSES as readonly string[]).includes(s),
    );
    requireValue(statuses.length, `status: use ${STATUSES.join(", ")}.`);
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  } else if (query.open !== "0") {
    where.push("status IN ('pending','assigned','en_route')");
  }
  if (query.courier) {
    where.push("courier_id=?");
    args.push(query.courier === "me" ? actor.id : query.courier);
  }
  if (query.conversation_id) {
    where.push("conversation_id=?");
    args.push(query.conversation_id);
  }
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
  const rows = await all(
    ctx.env,
    `SELECT * FROM entrega_deliveries WHERE ${where.join(" AND ")} ORDER BY created DESC,id LIMIT ?`,
    ...args,
    limit,
  );
  const at = now();
  return { data: rows.map((r) => deliveryView(r, cfg, at)) };
}

// ---------------------------------------------------------------------------
// Quem pode

/** Pessoa da equipe com o papel `entrega:courier` (entregador com login). */
export const isCourier = (ctx: ModuleContext, actor: Actor) =>
  ctx.granted(actor, "courier");

export const roleRequired = (message: string) =>
  new ApiError(403, "role_required", message);

/** Pessoa com o papel de entregador nesta área, ou 403 role_required. */
async function courierPerson(ctx: ModuleContext, id: string) {
  const person = (await ctx.grantees("courier")).find((p) => p.id === id);
  if (!person)
    throw roleRequired(
      "Essa pessoa não tem o papel de entregador (Gestão → Pessoas). Para um entregador avulso, use o QR da entrega.",
    );
  return { id: person.id, name: firstName(person.name) };
}

/** Credencial por QR desta entrega (entregador sem login). */
export const qrCourierOf = (actor: Actor, row: DeliveryRow) =>
  !!actor.credential &&
  actor.credential.module === "entrega" &&
  actor.credential.subject === row.id &&
  row.courier_id === actor.id;

/**
 * Equipe que acompanha entregas: pessoas, ou aplicação com
 * conversations:write. A credencial por QR nunca é equipe.
 */
function team(ctx: ModuleContext, actor: Actor) {
  if (actor.credential)
    throw new ApiError(
      403,
      "credential_scope",
      "Este acesso vale só para a entrega do QR.",
    );
  ctx.access(actor, "conversations:write");
}

/** O entregador desta entrega: a pessoa atribuída ou a credencial do QR. */
export function isCourierOf(actor: Actor, row: DeliveryRow) {
  if (actor.credential) return qrCourierOf(actor, row);
  return actor.kind === "user" && row.courier_id === actor.id;
}

export function mustBeCourierOf(actor: Actor, row: DeliveryRow) {
  if (!isCourierOf(actor, row))
    throw new ApiError(
      403,
      "not_your_delivery",
      "Só o entregador desta entrega pode fazer isso.",
    );
}

/**
 * Ator com que a Entrega lê e muda o pedido no Pedido em nome do entregador
 * (QR ou pessoa só com o papel entregador), sempre depois de conferir que ele
 * é desta entrega: o ator de módulo do núcleo (revisão A, item 3), que só
 * alcança o Pedido e, lá, só os estados de entrega. Aparece no histórico do
 * pedido como "module:entrega", com o nome de quem agiu.
 */
export function pedidoActor(ctx: ModuleContext, actor: Actor): Actor {
  return ctx.moduleActor({ reach: ["pedido"], label: actor.name });
}

/** Fecha o QR e a credencial da entrega: o app recebe 401. */
export const endAccess = (ctx: ModuleContext, id: string, reason: string) =>
  ctx.revokeCredentials(id, reason).catch(() => 0);

// ---------------------------------------------------------------------------
// Pedido (API pública do módulo Pedido, lida em nome do ator)

export interface SourceInfo {
  label: string;
  conversation_id: string | null;
  customer_name: string;
  address_text: string;
  /** Endereço com os campos separados, quando a origem os tem. */
  address: DeliveryAddress | null;
  /** Coordenadas do destino mandadas pelo cliente (localização no WhatsApp). */
  destination: Point | null;
}

const DELIVERABLE = ["received", "preparing", "ready", "out_for_delivery"];

export async function pedidoOrder(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
) {
  const order = await ctx.read(actor, `pedido/orders/${encodeURIComponent(id)}`);
  requireValue(order && order.id, "Pedido não encontrado.");
  return order;
}

export async function pedidoSource(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
): Promise<SourceInfo> {
  const order = await pedidoOrder(ctx, actor, id);
  if (order.fulfillment !== "delivery")
    throw new ApiError(
      409,
      "not_delivery",
      "Este pedido é para retirada, não para entrega.",
    );
  if (!DELIVERABLE.includes(order.status))
    throw new ApiError(
      409,
      "order_not_deliverable",
      order.status === "awaiting_payment"
        ? "O pedido ainda aguarda o pagamento."
        : `O pedido está ${String(order.status_label || order.status).toLowerCase()}.`,
    );
  const a = order.address;
  return {
    label: `Pedido nº ${order.number}`,
    conversation_id: order.customer?.conversation_id || null,
    customer_name: String(order.customer?.name || ""),
    address_text: String(order.address_text || ""),
    address: readAddress(a),
    destination:
      a && validLat(a.lat) && validLng(a.lng) ? { lat: a.lat, lng: a.lng } : null,
  };
}

/**
 * Pedidos com entrega prontos para sair e ainda sem entrega aberta, para o app
 * do entregador escolher (GET /entrega/available).
 */
export async function available(ctx: ModuleContext, actor: Actor) {
  if (!(await ctx.read(actor, "pedido").catch(() => null)))
    return { data: [], pedido: false };
  const orders = await ctx.read(actor, "pedido/orders", {
    open: "1",
    limit: "100",
  });
  const taken = new Set(
    (
      await all(
        ctx.env,
        "SELECT source_ref FROM entrega_deliveries WHERE profile_id=? AND source='pedido' AND status IN ('pending','assigned','en_route')",
        ctx.profile,
      )
    ).map((r) => r.source_ref),
  );
  return {
    pedido: true,
    data: (orders?.data || [])
      .filter(
        (o: any) =>
          o.fulfillment === "delivery" &&
          DELIVERABLE.includes(o.status) &&
          !taken.has(o.id),
      )
      .map((o: any) => ({
        source: "pedido",
        ref_id: o.id,
        label: `Pedido nº ${o.number}`,
        status: o.status,
        status_label: o.status_label,
        customer_name: o.customer?.name || "",
        address_text: o.address_text || "",
        address: readAddress(o.address),
        item_count: o.item_count,
        total_cents: o.total_cents,
        payment: o.payment
          ? {
              method_label: o.payment.method_label,
              status: o.payment.status,
              change_for_cents: o.payment.change_for_cents,
            }
          : null,
        created: o.created,
      })),
  };
}

// ---------------------------------------------------------------------------
// Escritas (comandos)

function destinationOf(value: any): Point | null {
  if (value === undefined || value === null) return null;
  requireValue(
    value && validLat(value.lat) && validLng(value.lng),
    "Destino: informe lat e lng em graus.",
  );
  return { lat: value.lat, lng: value.lng };
}
const text = (value: unknown, max: number, what: string) => {
  if (value === undefined || value === null) return "";
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what}: até ${max} caracteres.`,
  );
  return (value as string).trim();
};

export async function createDelivery(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  team(ctx, actor);
  const cfg = await config(ctx);
  const createScope = `f3-delivery-create:${ctx.profile}:${actor.id}`;
  const fingerprint = hash(data);
  const replay = await one(ctx.env, "SELECT fingerprint,response FROM receipts WHERE scope=? AND key=?", createScope, requestId);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new ApiError(409, "idempotency_conflict", "Esta chave já identifica outra entrega.");
    return deliveryView(await loadDelivery(ctx, JSON.parse(replay.response).id), cfg);
  }
  const source = data.source ?? "manual";
  requireValue(
    (SOURCES as readonly string[]).includes(source),
    `source: use ${SOURCES.join(" ou ")}.`,
  );
  let info: SourceInfo;
  let ref: string | null = null;
  if (source === "pedido") {
    ref = text(data.ref_id, 100, "ref_id");
    requireValue(ref, "Informe ref_id: o id do pedido.");
    info = await pedidoSource(ctx, actor, ref);
  } else {
    const label = text(data.label, 80, "Rótulo");
    requireValue(label, "Informe label: o que está sendo entregue.");
    let conversationId: string | null = null;
    if (data.conversation_id !== undefined && data.conversation_id !== null) {
      const c = await ctx.conversation(String(data.conversation_id), actor);
      requireValue(c.chat_type !== "group", "Use a conversa direta do cliente.");
      conversationId = c.id;
    }
    info = {
      label,
      conversation_id: conversationId,
      customer_name: text(data.customer_name, 120, "Nome do cliente"),
      address_text: text(data.address_text, 300, "Endereço"),
      address: addressInput(data.address),
      destination: null,
    };
  }
  // Destino marcado no painel vence; senão, a localização que o cliente mandou.
  const marked = destinationOf(data.destination);
  const dest = marked ?? info.destination;
  // Sem cidade, a da loja: o app procura o destino na cidade certa.
  const place = completeAddress(info.address, info.address_text, await storeRef(ctx));
  let courier: { id: string; name: string } | null = null;
  if (data.courier_id !== undefined && data.courier_id !== null)
    courier = await courierPerson(
      ctx,
      data.courier_id === "me" ? actor.id : String(data.courier_id),
    );
  const id = uid(),
    at = now();
  try {
    await batch(ctx.env, [[
      "INSERT INTO entrega_deliveries(id,profile_id,source,source_ref,source_key,label,conversation_id,customer_name,address_text,address,dest_lat,dest_lng,dest_source,courier_id,courier_name,courier_kind,status,assigned_at,note,created_by,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id,
      ctx.profile,
      source,
      ref,
      `${ctx.profile}:command:${requestId}`,
      info.label,
      info.conversation_id,
      info.customer_name,
      place.address_text,
      place.address ? JSON.stringify(place.address) : null,
      dest?.lat ?? null,
      dest?.lng ?? null,
      marked ? "panel" : dest ? "customer" : null,
      courier?.id ?? null,
      courier?.name ?? "",
      courier ? "person" : null,
      courier ? "assigned" : "pending",
      courier ? at : null,
      text(data.note, 500, "Observação"),
      actor.id,
      at,
      at],
    ], commerceGuard,
      ["INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,?,?,'',?)", [uid(), ctx.profile, id, courier ? "assigned" : "pending", actor.id, at]],
      ...await deliveryCreationStatements(ctx, { id, source, source_ref: ref }),
      ["INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)", [createScope, requestId, fingerprint, JSON.stringify({ id }), at]],
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(String((error as Error)?.message)))
      throw new ApiError(
        409,
        "delivery_exists",
        "Já existe uma entrega em andamento para este pedido.",
      );
    throw error;
  }

  const row = await loadDelivery(ctx, id);
  const view = deliveryView(row, cfg);
  await ctx.publish("entrega.created", id, eventPayload(view), { key: id });
  if (courier)
    await ctx.publish("entrega.assigned", id, eventPayload(view), {
      key: `${id}:assigned:${courier.id}`,
    });
  return view;
}

/** Evento sem posição nem endereço (os webhooks já exigem contacts:read). */
export const eventPayload = (view: DeliveryView) => ({
  id: view.id,
  source: view.source,
  source_ref: view.source_ref,
  label: view.label,
  conversation_id: view.conversation_id,
  status: view.status,
  courier: view.courier,
  eta: view.eta,
});

export async function assign(ctx: ModuleContext, actor: Actor, data: any) {
  team(ctx, actor);
  const cfg = await config(ctx);
  const row = await loadDelivery(ctx, data.id);
  requireValue(
    ["pending", "assigned"].includes(row.status),
    "Só dá para trocar o entregador antes da saída.",
  );
  const target = data.courier_id === "me" ? actor.id : data.courier_id;
  requireValue(typeof target === "string" && target, "Informe courier_id.");
  // Entregador assume uma entrega sem dono; trocar o de outra é da equipe.
  if (row.courier_id && row.courier_id !== target && (await isCourier(ctx, actor)))
    requireValue(
      actor.kind === "user" && actor.role === "admin",
      "Esta entrega já tem entregador. Peça à equipe para trocar.",
    );
  const courier = await courierPerson(ctx, target);
  await exec(
    ctx.env,
    "UPDATE entrega_deliveries SET courier_id=?,courier_name=?,courier_kind='person',status='assigned',assigned_at=?,updated=? WHERE id=? AND profile_id=? AND status IN ('pending','assigned')",
    courier.id,
    courier.name,
    now(),
    now(),
    row.id,
    ctx.profile,
  );
  await history(ctx, row.id, "assigned", actor.id, courier.name);
  // Passou do entregador do QR para uma pessoa: o QR deixa de valer.
  if (row.courier_kind === "qr")
    await endAccess(ctx, row.id, "Entrega passada a outro entregador.");
  const view = deliveryView(await loadDelivery(ctx, row.id), cfg);
  await ctx.publish("entrega.assigned", row.id, eventPayload(view), {
    key: `${row.id}:assigned:${courier.id}:${row.updated}`,
  });
  return view;
}

/** Destino marcado no app (geocodificado no aparelho) ou pela equipe. */
export async function setDestination(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
) {
  const cfg = await config(ctx);
  const row = await loadDelivery(ctx, data.id);
  const courier = isCourierOf(actor, row);
  if (!courier) team(ctx, actor);
  requireValue(
    OPEN.includes(row.status),
    "A entrega já terminou.",
  );
  const dest = destinationOf(data);
  requireValue(dest, "Informe lat e lng do destino.");
  const sourceOfDest = courier ? "app" : "panel";
  await exec(
    ctx.env,
    "UPDATE entrega_deliveries SET dest_lat=?,dest_lng=?,dest_source=?,updated=? WHERE id=?",
    dest!.lat,
    dest!.lng,
    sourceOfDest,
    now(),
    row.id,
  );
  await history(ctx, row.id, "destination", actor.id, sourceOfDest);
  return deliveryView(await loadDelivery(ctx, row.id), cfg);
}

/**
 * Sai para a entrega: só o entregador atribuído. No Pedido, o pedido vai para
 * "Saiu para entrega" (e o Pedido avisa o cliente, como sempre).
 */
export async function start(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  const cfg = await config(ctx);
  const row = await loadDelivery(ctx, data.id);
  mustBeCourierOf(actor, row);
  requireValue(
    row.status === "assigned",
    row.status === "en_route"
      ? "A rota já foi iniciada."
      : "Esta entrega não está aguardando saída.",
  );
  const dest = destinationOf(data.destination);
  let pedidoStatus: string | null = null;
  const asPedido = pedidoActor(ctx, actor);
  const order =
    row.source === "pedido"
      ? await pedidoOrder(ctx, asPedido, row.source_ref)
      : null;
  if (order && !DELIVERABLE.includes(order.status))
    throw new ApiError(
      409,
      "order_not_deliverable",
      `O pedido está ${String(order.status_label || order.status).toLowerCase()}.`,
    );
  // A rota é gravada antes de mudar o Pedido: o aviso "Saiu para entrega"
  // (onStatusNotice) roda dentro do pedido.status e já encontra a entrega a
  // caminho para mandar o botão Acompanhar na mesma mensagem.
  const at = now();
  // Código de confirmação (desligado por padrão): nasce na saída e vai ao
  // cliente com o aviso "saiu para entrega" (./pedido-hooks.ts, ./notify.ts).
  const code = cfg.confirm_code.enabled ? newConfirmCode() : null;
  await exec(
    ctx.env,
    "UPDATE entrega_deliveries SET status='en_route',started_at=?,next_update_at=?,dest_lat=coalesce(?,dest_lat),dest_lng=coalesce(?,dest_lng),dest_source=CASE WHEN ? IS NULL THEN dest_source ELSE 'app' END,confirm_code=?,confirm_attempts=0,updated=? WHERE id=? AND status='assigned'",
    at,
    at + cfg.updates.every_minutes * 60000,
    dest?.lat ?? null,
    dest?.lng ?? null,
    dest?.lat ?? null,
    code,
    at,
    row.id,
  );
  // "Pronto" (marcado por engano num pedido de entrega) segue direto para
  // entregue no Pedido; recebido e em preparo passam a "Saiu para entrega".
  if (order && ["received", "preparing"].includes(order.status)) {
    try {
      await ctx.run(
        asPedido,
        "pedido.status",
        { id: row.source_ref, status: "out_for_delivery" },
        `${requestId}:pedido`,
      );
    } catch (error) {
      // O Pedido recusou: a entrega volta a aguardar saída.
      await exec(
        ctx.env,
        "UPDATE entrega_deliveries SET status='assigned',started_at=NULL,next_update_at=NULL,track_step_id=NULL,updated=? WHERE id=? AND status='en_route'",
        now(),
        row.id,
      );
      throw error;
    }
    pedidoStatus = "out_for_delivery";
  }
  await history(ctx, row.id, "en_route", actor.id);
  const fresh = await loadDelivery(ctx, row.id);
  const view = deliveryView(fresh, cfg);
  await ctx.publish("entrega.started", row.id, eventPayload(view), {
    key: `${row.id}:started`,
  });
  return { ...view, pedido_status: pedidoStatus, app: appParams(cfg, fresh) };
}

/** Quatro dígitos ao acaso (0000 a 9999), sem viés. */
export function newConfirmCode() {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= 4_294_960_000);
  return String(n % 10_000).padStart(4, "0");
}

/** Frase do código para o cliente (com o aviso de saída). */
export const confirmSentence = (code: string) =>
  `Código de entrega: ${code}. Informe ao entregador só quando receber o pedido.`;

/**
 * "Entreguei" do entregador com o código ligado: confere o código, conta a
 * tentativa (UPDATE condicionado, as erradas ficam gravadas) e trava no
 * limite; a equipe conclui sem o código.
 */
async function checkConfirmCode(
  ctx: ModuleContext,
  cfg: EntregaConfig,
  row: DeliveryRow,
  value: unknown,
) {
  const expected = (row as any).confirm_code as string | null;
  if (!expected) return;
  const given = typeof value === "string" ? value.replace(/\D/g, "") : "";
  const counted = await exec(
    ctx.env,
    "UPDATE entrega_deliveries SET confirm_attempts=confirm_attempts+1,updated=? WHERE id=? AND confirm_attempts<?",
    now(),
    row.id,
    cfg.confirm_code.attempts,
  );
  if (!counted.meta?.changes)
    throw new ApiError(
      423,
      "code_locked",
      "Tentativas do código esgotadas. Fale com a loja: ela conclui a entrega.",
    );
  if (given === expected) return;
  const left =
    cfg.confirm_code.attempts - ((row as any).confirm_attempts + 1);
  throw new ApiError(
    409,
    given ? "code_invalid" : "code_required",
    given
      ? left > 0
        ? `Código errado. Restam ${left} ${left === 1 ? "tentativa" : "tentativas"}.`
        : "Código errado. Tentativas esgotadas: fale com a loja."
      : "Peça ao cliente o código de entrega (4 dígitos) que ele recebeu no WhatsApp.",
  );
}

/** Parâmetros do GPS e do envio para o app (frequência, lote, bateria). */
export function appParams(cfg: EntregaConfig, row: DeliveryRow) {
  const near =
    row.distance_m !== null &&
    row.distance_m !== undefined &&
    row.distance_m <= cfg.arriving_radius_m * 2;
  return {
    sample_seconds: cfg.app.sample_seconds,
    upload_seconds: near ? cfg.app.near_upload_seconds : cfg.app.upload_seconds,
    max_batch: MAX_BATCH,
    max_accuracy_m: MAX_ACCURACY_M,
    stale_minutes: cfg.app.stale_minutes,
  };
}

export async function finish(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  const cfg = await config(ctx);
  const row = await loadDelivery(ctx, data.id);
  if (!isCourierOf(actor, row)) team(ctx, actor);
  if (row.status === "delivered") return { ...deliveryView(row, cfg), pedido_error: null };
  requireValue(
    ["assigned", "en_route"].includes(row.status),
    row.status === "delivered"
      ? "A entrega já foi concluída."
      : "Esta entrega não está em andamento.",
  );
  const note = text(data.note, 500, "Observação");
  // Código de confirmação: o entregador conclui só com ele; a equipe, sem.
  const byCourier = isCourierOf(actor, row);
  if (byCourier) await checkConfirmCode(ctx, cfg, row, data.code);
  // A entrega é concluída antes de mudar o Pedido: o gancho de estado do
  // Pedido (onOrderStatusChanged) já a encontra entregue e não repete.
  const at = now();
  await batch(ctx.env, [
    ["UPDATE entrega_deliveries SET status='delivered',delivered_at=?,ended_at=?,updated=? WHERE id=? AND profile_id=? AND status=?", [at, at, at, row.id, ctx.profile, row.status]], commerceGuard,
    ["INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,'delivered',?,?,?)", [uid(), ctx.profile, row.id, actor.id, [note, row.confirm_code ? byCourier ? "Código de entrega conferido." : "Concluída pela loja sem o código de entrega." : ""].filter(Boolean).join(" "), at]],
    ...await deliveryLifecycleStatements(ctx, { ...row, status: "delivered", delivered_at: at }, actor.id, false),
  ]);
  await endAccess(ctx, row.id, "Entrega concluída.");
  const asPedido = pedidoActor(ctx, actor);
  let pedidoError: string | null = null;
  if (row.source === "pedido") {
    try {
      const order = await pedidoOrder(ctx, asPedido, row.source_ref);
      if (order.status !== "delivered") {
        // Do pronto/em preparo direto para entregue não é permitido no
        // Pedido: passa por "Saiu para entrega" sem avisar de novo.
        if (["received", "preparing"].includes(order.status))
          await ctx.run(
            asPedido,
            "pedido.status",
            { id: row.source_ref, status: "out_for_delivery", notify: false },
            `${requestId}:pedido-out`,
          );
        await ctx.run(
          asPedido,
          "pedido.status",
          { id: row.source_ref, status: "delivered" },
          `${requestId}:pedido`,
        );
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      pedidoError = error.message;
    }
  }
  const fresh = await loadDelivery(ctx, row.id);
  const view = deliveryView(fresh, cfg);
  await ctx.publish("entrega.delivered", row.id, eventPayload(view), {
    key: `${row.id}:delivered`,
  });
  return { ...view, pedido_error: pedidoError };
}

export async function cancel(ctx: ModuleContext, actor: Actor, data: any) {
  const cfg = await config(ctx);
  const row = await loadDelivery(ctx, data.id);
  if (!isCourierOf(actor, row)) team(ctx, actor);
  if (row.status === "cancelled") {
    if (row.cancel_reason !== text(data.reason, 300, "Motivo")) throw new ApiError(409, "idempotency_conflict", "O cancelamento já tem outro motivo.");
    return { ...deliveryView(row, cfg), was_en_route: !!row.started_at };
  }
  requireValue(OPEN.includes(row.status), "A entrega já terminou.");
  const reason = text(data.reason, 300, "Motivo");
  requireValue(reason, "Informe o motivo (reason).");
  const at = now();
  await batch(ctx.env, [
    ["UPDATE entrega_deliveries SET status='cancelled',cancelled_at=?,ended_at=?,cancel_reason=?,updated=? WHERE id=? AND profile_id=? AND status=?", [at, at, reason, at, row.id, ctx.profile, row.status]], commerceGuard,
    ["INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,'cancelled',?,?,?)", [uid(), ctx.profile, row.id, actor.id, reason, at]],
    ...await deliveryLifecycleStatements(ctx, { ...row, status: "cancelled" }, actor.id, true),
  ]);
  await endAccess(ctx, row.id, "Entrega cancelada.");
  const view = deliveryView(await loadDelivery(ctx, row.id), cfg);
  await ctx.publish("entrega.cancelled", row.id, eventPayload(view), {
    key: `${row.id}:cancelled`,
  });
  return { ...view, was_en_route: row.status === "en_route" };
}

// ---------------------------------------------------------------------------
// Posições (rota de telemetria, fora do Coordinator)

interface Fix {
  t: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
}

/** Pontos válidos do lote, em ordem, só os mais novos que a última posição. */
export function acceptPoints(
  raw: unknown,
  after: number,
  notBefore: number,
  at: number,
) {
  requireValue(
    Array.isArray(raw) && raw.length >= 1 && raw.length <= MAX_BATCH,
    `Envie points com 1 a ${MAX_BATCH} posições.`,
  );
  const fixes: Fix[] = [];
  let ignored = 0;
  for (const p of raw as any[]) {
    const t = typeof p?.t === "number" ? Math.round(p.t) : NaN;
    const accuracy =
      typeof p?.accuracy === "number" && p.accuracy >= 0 ? p.accuracy : null;
    if (
      !Number.isFinite(t) ||
      !validLat(p?.lat) ||
      !validLng(p?.lng) ||
      (p.lat === 0 && p.lng === 0) ||
      t <= after ||
      t < notBefore ||
      t > at + 120000 ||
      (accuracy !== null && accuracy > MAX_ACCURACY_M)
    ) {
      ignored++;
      continue;
    }
    fixes.push({
      t,
      lat: p.lat,
      lng: p.lng,
      accuracy,
      speed:
        typeof p.speed === "number" && p.speed >= 0 && p.speed < 100
          ? p.speed
          : null,
    });
  }
  fixes.sort((a, b) => a.t - b.t);
  // Mesmo instante repetido no lote: fica o primeiro.
  const unique = fixes.filter((f, i) => i === 0 || f.t !== fixes[i - 1].t);
  return { fixes: unique, ignored: ignored + fixes.length - unique.length };
}

/** Última mensagem da conversa da entrega (o app compara com a dele). */
const chatSeq = async (ctx: ModuleContext, id: string) =>
  (
    await one(
      ctx.env,
      "SELECT max(seq) seq FROM entrega_messages WHERE delivery_id=?",
      id,
    )
  )?.seq || 0;

export async function positions(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
  body: any,
) {
  const row = await one(
    ctx.env,
    "SELECT * FROM entrega_deliveries WHERE id=? AND profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Entrega não encontrada.");
  mustBeCourierOf(actor, row);
  const cfg = await config(ctx);
  const at = now();
  // Fora da entrega ativa a posição não é aceita: o app desliga o GPS.
  if (
    row.status !== "en_route" ||
    (row.started_at && at - row.started_at > MAX_ROUTE_MS)
  )
    return {
      active: false,
      status: row.status,
      status_label: STATUS_LABELS[row.status as DeliveryStatus],
      accepted: 0,
      ignored: Array.isArray(body?.points) ? body.points.length : 0,
    };
  const battery =
    typeof body?.battery === "number" &&
    body.battery >= 0 &&
    body.battery <= 100
      ? Math.round(body.battery)
      : null;
  const { fixes, ignored } = acceptPoints(
    body?.points,
    row.last_at || 0,
    (row.started_at || at) - 60000,
    at,
  );
  if (!fixes.length)
    return {
      active: true,
      status: row.status,
      accepted: 0,
      ignored,
      last_at: row.last_at,
      app: appParams(cfg, row),
      chat: { last_seq: await chatSeq(ctx, row.id) },
    };
  const last = fixes[fixes.length - 1];
  const trail: TrailPoint[] = [
    ...(json(row.trail, []) as TrailPoint[]),
    ...fixes.map((f): TrailPoint => [f.t, f.lat, f.lng]),
  ]
    .filter(([t]) => last.t - t <= 15 * 60000)
    .slice(-TRAIL_MAX);
  let eta: { minutes: number; distance_m: number } | null = null;
  let arriving = false;
  if (row.dest_lat !== null && row.dest_lat !== undefined) {
    const dest = { lat: row.dest_lat, lng: row.dest_lng };
    const result = await routeProvider(cfg.route_provider).eta({
      from: { lat: last.lat, lng: last.lng },
      to: dest,
      speedKmh: cfg.speed_kmh,
      roadFactor: cfg.road_factor,
      measuredKmh: trailSpeedKmh(trail, last.t),
    });
    eta = { minutes: result.minutes, distance_m: result.distance_m };
    arriving =
      !row.arriving_at &&
      distanceM({ lat: last.lat, lng: last.lng }, dest) <=
        cfg.arriving_radius_m;
  }
  // Uma escrita por lote, condicionada: outro lote mais novo não é desfeito.
  const result = await exec(
    ctx.env,
    "UPDATE entrega_deliveries SET last_lat=?,last_lng=?,last_accuracy=?,last_speed=?,last_at=?,last_battery=coalesce(?,last_battery),trail=?,points=points+?,distance_m=coalesce(?,distance_m),eta_at=coalesce(?,eta_at),arriving_at=CASE WHEN ? AND arriving_at IS NULL THEN ? ELSE arriving_at END,notified=json_remove(notified,'$.signal'),updated=? WHERE id=? AND profile_id=? AND status='en_route' AND courier_id=? AND (last_at IS NULL OR last_at<?)",
    last.lat,
    last.lng,
    last.accuracy,
    last.speed,
    last.t,
    battery,
    JSON.stringify(trail),
    fixes.length,
    eta?.distance_m ?? null,
    eta ? last.t + eta.minutes * 60000 : null,
    arriving ? 1 : 0,
    at,
    at,
    row.id,
    ctx.profile,
    actor.id,
    last.t,
  );
  const applied = !!result.meta?.changes;
  const fresh = {
    ...row,
    distance_m: eta?.distance_m ?? row.distance_m,
  };
  // Aviso de chegada, atualização vencida ou volta do sinal: a rodada do
  // módulo no Coordinator manda as mensagens.
  const notified = json(row.notified, {});
  if (
    applied &&
    (arriving ||
      notified.signal ||
      (row.next_update_at && at >= row.next_update_at))
  )
    await ctx.wake().catch(() => undefined);
  return {
    active: true,
    status: row.status,
    accepted: applied ? fixes.length : 0,
    ignored: applied ? ignored : ignored + fixes.length,
    last_at: applied ? last.t : row.last_at,
    eta: eta
      ? {
          minutes: eta.minutes,
          at: last.t + eta.minutes * 60000,
          distance_m: eta.distance_m,
        }
      : null,
    arriving: arriving || !!row.arriving_at,
    app: appParams(cfg, fresh),
    // Mensagem nova na conversa da entrega: o app busca em …/messages.
    chat: { last_seq: await chatSeq(ctx, row.id) },
  };
}

// ---------------------------------------------------------------------------
// Conversa e cliente

export async function openFor(ctx: ModuleContext, c: Conversation) {
  return all(
    ctx.env,
    "SELECT * FROM entrega_deliveries WHERE conversation_id=? AND profile_id=? AND status IN ('pending','assigned','en_route') ORDER BY created",
    c.id,
    ctx.profile,
  );
}
