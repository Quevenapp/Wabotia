// Frete: o serviço que liga a Expedição aos provedores (./providers.ts).
// - cotar: CEP de origem da loja (ou o dos ajustes), CEP do cliente e os
//   volumes da Expedição; cada provedor ligado devolve serviços com preço e
//   prazo; a cotação fica guardada 24 horas;
// - escolher: grava no pedido o valor do frete e o prazo (pelo salvamento do
//   pedido, no motor) e guarda o serviço escolhido;
// - contratar: um envio vivo por pedido; a resposta incerta fica "incerta" e a
//   próxima tentativa consulta o provedor antes (nunca repete às cegas); o
//   código de rastreio vai para o pedido e a etiqueta oficial em PDF para o R2;
// - cancelar, quando o provedor permite (também consulta antes, se incerto);
// - rastrear: na tela e na rodada do alarme (./schedule.ts), para os pedidos
//   expedidos com envio contratado; o aviso ao cliente pelo WhatsApp é um
//   ajuste da área, desligado por padrão.
// O motor confere papel, carteira de clientes e parte em cada leitura e
// gravação (src/erp/domains/shipping/freight.ts); nada do provedor vai para log.
import { all, exec, one } from "../../db";
import { sha } from "../../security";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { callShippingRpc } from "../expedicao/routes.ts";
import { enabledProviders, freightConnection, freightSettings, providerRow, recordCheck } from "./config.ts";
import { sendTrackingNotice } from "./notify.ts";
import {
  FreightError, isFreightProvider, postalCode,
  type ContractRequest, type FreightAddress, type FreightHttp, type FreightProviderId, type FreightVolume, type QuoteOption, type TrackingEvent, type TrackingStatus,
} from "./provider.ts";
import { FREIGHT_PROVIDER_ADAPTERS } from "./providers.ts";
import { TRACKING_FINAL, TRACKING_LABEL, TRACKING_MAX_AGE_MS, eventKey, latestStatus, nextCheck, trackingMessage, whatsappPhone } from "./tracking.ts";

export interface FreightDeps {
  http: FreightHttp;
  /** Onde a etiqueta oficial fica guardada (o R2 da instalação). */
  media: Pick<R2Bucket, "get" | "put"> | null;
}
export const defaultFreightDeps = (env: Env): FreightDeps => ({
  http: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
  media: env.MEDIA ?? null,
});

const QUOTE_TTL_MS = 24 * 3_600_000;
/** Contratação em andamento há menos disso: outra tentativa espera. */
const CONTRACTING_GRACE_MS = 120_000;
const ACTIVE = ["contracting", "uncertain", "contracted", "cancelling"];
const SHIPMENT_LABEL: Record<string, string> = {
  contracting: "Contratando", uncertain: "Confirmando com o provedor", contracted: "Contratado", cancelling: "Cancelando", cancelled: "Cancelado", failed: "Recusado",
};

/** O contexto do pedido no motor (confere papel, carteira e parte; nada grava). */
interface FreightContext {
  can_write: boolean;
  order: { id: string; number: number; status: string; ship_status: string; freight: string; delivery_days: string | null; declared_cents: string;
    freight_editable: boolean; freight_block: string | null; tracking_code: string | null; customer: string; [k: string]: unknown };
  sender: Record<string, string | null>;
  recipient: Record<string, any>;
  volumes: { number: number; length_mm: number | null; width_mm: number | null; height_mm: number | null; gross_weight_g: number | null }[];
  items: { description: string; quantity: string }[];
  invoice: { key: string; number: number | null; series: number | null } | null;
}
/** Quem chama e a rota dela (o método e o caminho da requisição: a conferência do bot e do portão usa os dois). */
export interface FreightCall { env: Env; profile: string; actor: Actor; pathname: string; method?: string }
const context = (c: FreightCall, id: string): Promise<FreightContext> =>
  callShippingRpc(c.env, c.profile, c.actor, c.pathname, c.method ?? "GET", "erp_shipping_freight_context", { p_args: { id } }, true);

/** O comando estável de uma gravação no motor (a mesma intenção repetida não grava duas vezes). */
async function commandFor(...parts: string[]) {
  const h = await sha(JSON.stringify(["wabotia-erp-frete-v1", ...parts]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const apply = async (c: FreightCall, command: string, args: Record<string, unknown>) =>
  callShippingRpc(c.env, c.profile, c.actor, c.pathname, "POST", "erp_shipping_freight_apply", { p_command_id: command, p_args: args }, false);

const reais = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
function toApi(error: unknown, fallback: string): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof FreightError) throw new ApiError(error.status, error.code, error.message);
  throw new ApiError(502, "freight_provider_unavailable", fallback);
}

// ---------------------------------------------------------------------------
// Origem, destino e volumes

function originOf(ctx: FreightContext, override: string | null) {
  const cep = override ?? postalCode(ctx.sender.postal_code);
  if (!cep) throw new ApiError(409, "freight_origin_missing", "Falta o CEP de origem. Preencha o CEP no cadastro da empresa (Sistema › Dados da empresa) ou em Expedição › Frete e transportadoras.");
  return cep;
}
function destinationOf(ctx: FreightContext) {
  const cep = postalCode(ctx.recipient.postal_code);
  if (!cep) throw new ApiError(409, "freight_destination_missing", `O pedido ${ctx.order.number} está sem CEP de entrega. Preencha o endereço de entrega no pedido ou o CEP no cadastro do cliente.`);
  return cep;
}
function volumesOf(ctx: FreightContext): FreightVolume[] {
  if (!ctx.volumes.length) throw new ApiError(409, "freight_volumes_missing", "Monte os volumes do pedido (embalagem, peso e medidas) na Expedição antes de cotar o frete.");
  return ctx.volumes.map((v) => {
    if (!v.length_mm || !v.width_mm || !v.height_mm)
      throw new ApiError(409, "freight_volume_measures", `O volume ${v.number} está sem medidas. Escolha uma embalagem cadastrada ou digite as medidas e salve os volumes de novo.`);
    if (!v.gross_weight_g)
      throw new ApiError(409, "freight_volume_weight", `O volume ${v.number} está sem peso. Digite o peso da balança ou cadastre o peso dos produtos e salve os volumes de novo.`);
    return { length_mm: v.length_mm, width_mm: v.width_mm, height_mm: v.height_mm, weight_g: v.gross_weight_g };
  });
}
function address(a: Record<string, any>, postal: string, who: string): FreightAddress {
  const missing = [!a.street && "rua", !a.city && "cidade", !a.state && "UF"].filter(Boolean);
  if (missing.length) throw new ApiError(409, "freight_address_missing", `Falta ${missing.join(", ")} no endereço ${who}. Complete o cadastro e tente de novo.`);
  return { name: a.name ?? a.legal_name ?? "Sem nome", document: a.document ?? a.cnpj ?? null, phone: a.phone ?? null, email: a.email ?? null,
    street: a.street, number: a.number ?? null, complement: a.complement ?? null, district: a.district ?? null, city: a.city, state: a.state, postal_code: postal };
}

// ---------------------------------------------------------------------------
// Leituras

function shipmentView(s: any) {
  if (!s) return null;
  const provider = isFreightProvider(s.provider) ? FREIGHT_PROVIDER_ADAPTERS[s.provider as FreightProviderId].name : s.provider;
  return {
    id: s.id, provider: s.provider, provider_name: provider, sandbox: Number(s.sandbox) === 1, service_code: s.service_code, service_name: s.service_name,
    price_cents: s.price_cents ?? null, status: s.status, status_label: SHIPMENT_LABEL[s.status] ?? s.status, tracking_code: s.tracking_code ?? null,
    label_ready: s.status === "contracted", tracking_status: s.tracking_status ?? null,
    tracking_label: s.tracking_status ? TRACKING_LABEL[s.tracking_status as TrackingStatus] ?? s.tracking_status : null,
    tracking_at: s.tracking_at ?? null, shipped_at: s.shipped_at ?? null, delivered_at: s.delivered_at ?? null, error: s.error ?? null, created: s.created,
  };
}
const choiceView = (r: any) => r ? {
  quote_id: r.quote_id, provider: r.provider, sandbox: Number(r.sandbox) === 1, service_code: r.service_code, service_name: r.service_name, company: r.company ?? null,
  price_cents: Number(r.price_cents), delivery_days: r.delivery_days ?? null, applied: Number(r.applied) === 1, apply_message: r.apply_message ?? null, chosen: r.chosen,
} : null;

async function currentShipment(env: Env, profile: string, document: string) {
  return one(env, `SELECT * FROM erp_frete_shipments WHERE profile_id=? AND document_id=? ORDER BY CASE WHEN status IN ('contracting','uncertain','contracted','cancelling') THEN 0 ELSE 1 END, created DESC LIMIT 1`, profile, document);
}
async function timeline(env: Env, profile: string, document: string) {
  return (await all(env, "SELECT * FROM erp_frete_events WHERE profile_id=? AND document_id=? ORDER BY happened_at DESC, created DESC LIMIT 200", profile, document)).map((e: any) => ({
    id: e.id, shipment_id: e.shipment_id, at: e.happened_at, code: e.code, status: e.status, status_label: TRACKING_LABEL[e.status as TrackingStatus] ?? e.status,
    description: e.description, location: e.location ?? null, notified: Number(e.notified) === 1,
  }));
}

/** O frete do pedido: o serviço escolhido, o envio, a linha do tempo e os provedores ligados. */
export async function orderFreight(c: FreightCall, id: string) {
  const ctx = await context(c, id);
  const [choice, shipment, events, providers, settings] = await Promise.all([
    one(c.env, "SELECT * FROM erp_frete_choices WHERE profile_id=? AND document_id=?", c.profile, ctx.order.id),
    currentShipment(c.env, c.profile, ctx.order.id), timeline(c.env, c.profile, ctx.order.id),
    enabledProviders(c.env, c.profile), freightSettings(c.env, c.profile),
  ]);
  return {
    scope: "freight_order", can_write: ctx.can_write,
    order: { id: ctx.order.id, number: ctx.order.number, ship_status: ctx.order.ship_status, freight: ctx.order.freight, delivery_days: ctx.order.delivery_days,
      freight_editable: ctx.order.freight_editable, tracking_code: ctx.order.tracking_code },
    choice: choiceView(choice), shipment: shipmentView(shipment), events,
    providers: providers.map((p) => ({ id: p, name: FREIGHT_PROVIDER_ADAPTERS[p].name })), notify_whatsapp: settings.notify_whatsapp,
  };
}

// ---------------------------------------------------------------------------
// Cotar e escolher

export async function quoteOrder(c: FreightCall, id: string, deps: FreightDeps) {
  const ctx = await context(c, id);
  const settings = await freightSettings(c.env, c.profile);
  const providers = await enabledProviders(c.env, c.profile);
  if (!providers.length)
    throw new ApiError(409, "freight_no_provider", "Nenhum provedor de frete está ligado. O administrador liga os Correios ou o Melhor Envio em Expedição › Frete e transportadoras.");
  const from = originOf(ctx, settings.origin_postal_code), to = destinationOf(ctx), volumes = volumesOf(ctx);
  const declared = Number(ctx.order.declared_cents) || 0;
  const options: (QuoteOption & { option: string; provider: FreightProviderId; provider_name: string; sandbox: boolean })[] = [];
  const errors: { provider: FreightProviderId; provider_name: string; message: string }[] = [];
  await Promise.all(providers.map(async (p) => {
    const adapter = FREIGHT_PROVIDER_ADAPTERS[p];
    try {
      const conn = await freightConnection(c.env, c.profile, p);
      for (const o of await adapter.quote(deps.http, conn, { from_postal_code: from, to_postal_code: to, volumes, declared_cents: declared }))
        options.push({ ...o, option: `${p}:${o.service_code}`, provider: p, provider_name: adapter.name, sandbox: conn.sandbox });
    } catch (error) {
      errors.push({ provider: p, provider_name: adapter.name, message: error instanceof FreightError || error instanceof ApiError ? error.message : `${adapter.name} não respondeu. Tente de novo em instantes.` });
    }
  }));
  if (!options.length && errors.length) throw new ApiError(502, "freight_quote_failed", errors.map((e) => e.message).join(" "));
  options.sort((a, b) => a.price_cents - b.price_cents || (a.delivery_days ?? 99) - (b.delivery_days ?? 99));
  const quote = uid(), at = now();
  await exec(c.env, "INSERT INTO erp_frete_quotes(id,profile_id,document_id,origin_postal_code,destination_postal_code,volumes,options,created,created_by,expires) VALUES(?,?,?,?,?,?,?,?,?,?)",
    quote, c.profile, ctx.order.id, from, to, JSON.stringify(volumes), JSON.stringify(options), at, c.actor.id, at + QUOTE_TTL_MS);
  return { scope: "freight_quote", id: quote, order: { id: ctx.order.id, number: ctx.order.number }, from_postal_code: from, to_postal_code: to,
    volumes: volumes.length, weight_g: volumes.reduce((s, v) => s + v.weight_g, 0), declared_cents: declared, options, errors, expires: at + QUOTE_TTL_MS,
    freight_editable: ctx.order.freight_editable };
}

async function quoteOption(c: FreightCall, document: string, quoteId: unknown, option: unknown) {
  if (typeof quoteId !== "string" || !quoteId) throw new ApiError(400, "invalid_request", "cotacao: informe a cotação.");
  if (typeof option !== "string" || !option) throw new ApiError(400, "invalid_request", "servico: escolha um serviço da cotação.");
  const q = await one(c.env, "SELECT * FROM erp_frete_quotes WHERE id=? AND profile_id=? AND document_id=?", quoteId, c.profile, document);
  if (!q) throw new ApiError(404, "freight_quote_not_found", "Cotação não encontrada para este pedido. Cote de novo.");
  if (Number(q.expires) < now()) throw new ApiError(409, "freight_quote_expired", "A cotação venceu (vale 24 horas). Cote de novo.");
  const found = (JSON.parse(q.options) as any[]).find((o) => o.option === option);
  if (!found) throw new ApiError(404, "freight_option_not_found", "Este serviço não está na cotação. Cote de novo e escolha um da lista.");
  return found as QuoteOption & { option: string; provider: FreightProviderId; sandbox: boolean };
}

/** Escolhe o serviço: o valor e o prazo vão para o pedido quando ele aceita; o serviço fica guardado sempre. */
export async function chooseService(c: FreightCall, id: string, body: Record<string, unknown>) {
  const ctx = await context(c, id);
  if (!ctx.can_write) throw new ApiError(403, "forbidden", "Seu papel no ERP só consulta a expedição. Escolher o frete pede o papel Administrador, Vendas ou Estoque.");
  const o = await quoteOption(c, ctx.order.id, body.cotacao, body.servico);
  let applied = false, message: string | null = null;
  try {
    await apply(c, await commandFor(c.profile, "choose", String(body.cotacao), o.option), {
      document_id: ctx.order.id, freight: reais(o.price_cents), delivery_days: o.delivery_days === null ? null : String(o.delivery_days),
    });
    applied = true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status >= 500) throw error;
    message = error.message;
  }
  await exec(c.env, `INSERT INTO erp_frete_choices(profile_id,document_id,quote_id,provider,sandbox,service_code,service_name,company,price_cents,delivery_days,applied,apply_message,chosen,chosen_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,document_id) DO UPDATE SET quote_id=excluded.quote_id, provider=excluded.provider, sandbox=excluded.sandbox,
    service_code=excluded.service_code, service_name=excluded.service_name, company=excluded.company, price_cents=excluded.price_cents, delivery_days=excluded.delivery_days,
    applied=excluded.applied, apply_message=excluded.apply_message, chosen=excluded.chosen, chosen_by=excluded.chosen_by`,
  c.profile, ctx.order.id, String(body.cotacao), o.provider, o.sandbox ? 1 : 0, o.service_code, o.service_name, o.company ?? null, o.price_cents, o.delivery_days ?? null,
  applied ? 1 : 0, message, now(), c.actor.id);
  return { ...(await orderFreight(c, id)), applied, message };
}

// ---------------------------------------------------------------------------
// Contratar, etiqueta e cancelar

async function setShipment(env: Env, id: string, values: Record<string, unknown>) {
  const keys = Object.keys(values);
  await exec(env, `UPDATE erp_frete_shipments SET ${keys.map((k) => `${k}=?`).join(", ")}, updated=? WHERE id=?`, ...Object.values(values), now(), id);
}

/** O envio contratado: rastreio no pedido e a etiqueta guardada (a falha da etiqueta não desfaz o envio). */
async function settle(c: FreightCall, shipment: any, result: { provider_ref: string; tracking_code: string | null; price_cents: number | null }, deps: FreightDeps, shipped: boolean) {
  await setShipment(c.env, shipment.id, { status: "contracted", provider_ref: result.provider_ref, tracking_code: result.tracking_code, error: null,
    ...(result.price_cents !== null ? { price_cents: result.price_cents } : {}), ...(shipped ? { shipped_at: now(), tracking_next: now() } : {}) });
  const notes: string[] = [];
  if (result.tracking_code) {
    try { await apply(c, await commandFor(c.profile, "tracking", shipment.id, result.tracking_code), { document_id: shipment.document_id, tracking_code: result.tracking_code }); }
    catch (error) { notes.push(`O envio foi contratado, mas o código de rastreio não entrou no pedido: ${error instanceof Error ? error.message : "tente atualizar"}`); }
  }
  try { await storeLabel(c, { ...shipment, provider_ref: result.provider_ref }, deps); }
  catch (error) { notes.push(error instanceof FreightError || error instanceof ApiError ? error.message : "A etiqueta ainda não veio do provedor. Baixe de novo em instantes."); }
  return notes;
}

async function storeLabel(c: FreightCall, shipment: any, deps: FreightDeps): Promise<Uint8Array> {
  if (!isFreightProvider(shipment.provider)) throw new ApiError(409, "freight_provider_unknown", "Provedor do envio desconhecido.");
  const provider = shipment.provider as FreightProviderId;
  const conn = await freightConnection(c.env, c.profile, provider);
  const pdf = await FREIGHT_PROVIDER_ADAPTERS[provider].label(deps.http, conn, shipment.provider_ref);
  const key = `erp-frete/${c.profile}/${shipment.id}.pdf`;
  if (deps.media) {
    await deps.media.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
    await setShipment(c.env, shipment.id, { label_key: key, label_at: now() });
  }
  return pdf;
}

/**
 * Contrata o envio do pedido no serviço escolhido (ou no serviço da cotação
 * informado). Com um envio incerto, consulta o provedor antes de qualquer
 * tentativa nova.
 */
export async function contractShipment(c: FreightCall, id: string, body: Record<string, unknown>, deps: FreightDeps) {
  let ctx = await context(c, id);
  if (!ctx.can_write) throw new ApiError(403, "forbidden", "Seu papel no ERP só consulta a expedição. Contratar o envio pede o papel Administrador, Vendas ou Estoque.");
  if (!["packed", "shipped"].includes(ctx.order.ship_status))
    throw new ApiError(409, "freight_not_packed", "Monte os volumes do pedido na Expedição antes de contratar o envio.");
  if (body.cotacao !== undefined || body.servico !== undefined) { await chooseService(c, id, body); ctx = await context(c, id); }
  const choice = await one(c.env, "SELECT * FROM erp_frete_choices WHERE profile_id=? AND document_id=?", c.profile, ctx.order.id);
  if (!choice) throw new ApiError(409, "freight_choice_missing", "Escolha um serviço na cotação antes de contratar o envio.");
  if (!isFreightProvider(choice.provider)) throw new ApiError(409, "freight_provider_unknown", "Provedor do serviço escolhido desconhecido. Cote de novo.");
  const provider: FreightProviderId = choice.provider, adapter = FREIGHT_PROVIDER_ADAPTERS[provider];
  const row = await providerRow(c.env, c.profile, provider);
  if (!row.enabled) throw new ApiError(409, "freight_provider_off", `${adapter.name} está desligado nesta área. O administrador liga em Expedição › Frete e transportadoras, ou cote e escolha outro serviço.`);
  if (row.sandbox !== (Number(choice.sandbox) === 1))
    throw new ApiError(409, "freight_mode_changed", `${adapter.name} mudou entre teste e produção depois da cotação. Cote de novo e escolha o serviço.`);
  const conn = await freightConnection(c.env, c.profile, provider);
  const shipped = ctx.order.ship_status === "shipped";

  const existing = await one(c.env, `SELECT * FROM erp_frete_shipments WHERE profile_id=? AND document_id=? AND status IN (${ACTIVE.map(() => "?").join(",")})`, c.profile, ctx.order.id, ...ACTIVE);
  if (existing?.status === "contracted") return { ...(await orderFreight(c, id)), repeated: true, notes: [] };
  if (existing?.status === "cancelling") throw new ApiError(409, "freight_cancelling", "O cancelamento deste envio está em andamento. Atualize a tela e confira antes de contratar de novo.");
  if (existing?.status === "contracting" && now() - Number(existing.updated) < CONTRACTING_GRACE_MS)
    throw new ApiError(409, "freight_contracting", "Este envio está sendo contratado agora. Aguarde um instante e atualize a tela.");
  if (existing) {
    // Resposta incerta (ou contratação interrompida): consulta antes.
    const existingProvider: FreightProviderId = isFreightProvider(existing.provider) ? existing.provider as FreightProviderId : provider;
    let found;
    try { found = await FREIGHT_PROVIDER_ADAPTERS[existingProvider].find(deps.http, await freightConnection(c.env, c.profile, existingProvider), existing.id, existing.provider_ref ?? null); }
    catch (error) {
      throw new ApiError(409, "freight_uncertain", `Ainda não deu para confirmar com ${FREIGHT_PROVIDER_ADAPTERS[existingProvider].name} se o envio anterior foi feito, e o Vinki não contrata de novo sem saber. ${error instanceof Error ? error.message : ""} Tente de novo em alguns minutos.`.trim());
    }
    if (found && !found.cancelled) {
      const notes = await settle(c, existing, found, deps, shipped);
      return { ...(await orderFreight(c, id)), repeated: true, notes: ["O envio anterior tinha sido feito no provedor: o Vinki confirmou e usou ele.", ...notes] };
    }
    await setShipment(c.env, existing.id, { status: found?.cancelled ? "cancelled" : "failed", error: found?.cancelled ? "Cancelado no provedor." : "O provedor confirmou que este envio não foi feito." });
  }

  const from = originOf(ctx, (await freightSettings(c.env, c.profile)).origin_postal_code), to = destinationOf(ctx), volumes = volumesOf(ctx);
  const sender = address(ctx.sender, from, "da empresa (Sistema › Dados da empresa)"), recipient = address(ctx.recipient, to, `de entrega do pedido ${ctx.order.number}`);
  const declared = Number(ctx.order.declared_cents) || 0;
  const units = ctx.items.reduce((s, i) => s + Math.max(1, Math.round(Number(i.quantity) || 1)), 0) || 1;
  const request: ContractRequest = {
    reference: uid(), service_code: choice.service_code, order_number: ctx.order.number, from: sender, to: recipient, volumes, declared_cents: declared,
    // O valor de cada item na declaração de conteúdo: o valor declarado dividido pelas unidades.
    items: ctx.items.map((i) => ({ description: i.description, quantity: Math.max(1, Math.round(Number(i.quantity) || 1)), unit_cents: Math.round(declared / units) })),
    invoice: ctx.invoice,
  };
  const at = now();
  try {
    await exec(c.env, `INSERT INTO erp_frete_shipments(id,profile_id,document_id,order_number,provider,sandbox,service_code,service_name,price_cents,status,notify_phone,customer_name,created,created_by,updated)
      VALUES(?,?,?,?,?,?,?,?,?,'contracting',?,?,?,?,?)`, request.reference, c.profile, ctx.order.id, ctx.order.number, provider, conn.sandbox ? 1 : 0, choice.service_code,
    choice.service_name, choice.price_cents, whatsappPhone(ctx.recipient.phone), recipient.name, at, c.actor.id, at);
  } catch {
    throw new ApiError(409, "freight_contracting", "Este pedido já tem um envio sendo contratado. Atualize a tela.");
  }
  const shipment = { id: request.reference, document_id: ctx.order.id, provider };
  try {
    const result = await adapter.contract(deps.http, conn, request);
    const notes = await settle(c, shipment, result, deps, shipped);
    return { ...(await orderFreight(c, id)), repeated: false, notes };
  } catch (error) {
    if (error instanceof FreightError && !error.uncertain) {
      await setShipment(c.env, shipment.id, { status: "failed", error: error.message.slice(0, 500) });
      throw new ApiError(error.status, error.code, error.message);
    }
    await setShipment(c.env, shipment.id, { status: "uncertain", provider_ref: error instanceof FreightError ? error.providerRef : null,
      error: error instanceof FreightError ? error.message.slice(0, 500) : "A resposta do provedor não chegou." });
    throw new ApiError(502, "freight_uncertain", error instanceof FreightError ? error.message
      : `${adapter.name} não respondeu. O envio pode ter sido feito lá: o Vinki consulta antes de tentar de novo.`);
  }
}

/** A etiqueta oficial em PDF (do R2; se não houver, baixa do provedor e guarda). */
export async function shipmentLabel(c: FreightCall, id: string, deps: FreightDeps) {
  const ctx = await context(c, id);
  const s = await currentShipment(c.env, c.profile, ctx.order.id);
  if (!s || s.status !== "contracted") throw new ApiError(404, "freight_label_missing", "Este pedido não tem envio contratado. Contrate o envio para gerar a etiqueta oficial.");
  if (s.label_key && deps.media) {
    const stored = await deps.media.get(s.label_key);
    if (stored) return { number: ctx.order.number, pdf: new Uint8Array(await stored.arrayBuffer()) };
  }
  try { return { number: ctx.order.number, pdf: await storeLabel(c, s, deps) }; }
  catch (error) { return toApi(error, "O provedor não entregou a etiqueta agora. Tente de novo em instantes."); }
}

/** Cancela o envio contratado no provedor e tira o rastreio do pedido. */
export async function cancelShipment(c: FreightCall, id: string, deps: FreightDeps) {
  const ctx = await context(c, id);
  if (!ctx.can_write) throw new ApiError(403, "forbidden", "Seu papel no ERP só consulta a expedição. Cancelar o envio pede o papel Administrador, Vendas ou Estoque.");
  const s = await one(c.env, "SELECT * FROM erp_frete_shipments WHERE profile_id=? AND document_id=? AND status IN ('contracted','cancelling','uncertain')", c.profile, ctx.order.id);
  if (!s) throw new ApiError(404, "freight_shipment_missing", "Este pedido não tem envio contratado para cancelar.");
  if (s.status === "uncertain") throw new ApiError(409, "freight_uncertain", "O envio ainda não foi confirmado com o provedor. Toque em Contratar envio para o Vinki consultar o provedor antes.");
  if (!isFreightProvider(s.provider)) throw new ApiError(409, "freight_provider_unknown", "Provedor do envio desconhecido.");
  const provider = s.provider as FreightProviderId;
  const adapter = FREIGHT_PROVIDER_ADAPTERS[provider], conn = await freightConnection(c.env, c.profile, provider);
  const finish = async () => {
    await setShipment(c.env, s.id, { status: "cancelled", error: null, tracking_status: "cancelled" });
    const notes: string[] = [];
    if (ctx.order.tracking_code) {
      try { await apply(c, await commandFor(c.profile, "untrack", s.id), { document_id: ctx.order.id, clear_tracking: true }); }
      catch (error) { notes.push(`O envio foi cancelado, mas o código de rastreio continua no pedido: ${error instanceof Error ? error.message : "tente de novo"}`); }
    }
    return { ...(await orderFreight(c, id)), notes };
  };
  if (s.status === "cancelling") {
    // Pedido de cancelamento sem resposta: consulta antes de pedir de novo.
    let found;
    try { found = await adapter.find(deps.http, conn, s.id, s.provider_ref); }
    catch (error) { return toApi(error, `${adapter.name} não confirmou o cancelamento. Tente de novo em instantes.`); }
    if (!found || found.cancelled) return finish();
  }
  await setShipment(c.env, s.id, { status: "cancelling" });
  try { await adapter.cancel(deps.http, conn, s.provider_ref); }
  catch (error) {
    if (error instanceof FreightError && !error.uncertain) {
      await setShipment(c.env, s.id, { status: "contracted", error: error.message.slice(0, 500) });
      throw new ApiError(error.status, error.code, error.message);
    }
    throw new ApiError(502, "freight_uncertain", `${adapter.name} não respondeu ao cancelamento. Na próxima tentativa o Vinki consulta antes de pedir de novo.`);
  }
  return finish();
}

// ---------------------------------------------------------------------------
// Rastreio

/** Consulta o rastreio de um envio, grava os eventos novos e avisa o cliente se a situação mudou (ajuste da área). */
export async function trackShipment(env: Env, profile: string, s: any, deps: FreightDeps, at = now()) {
  if (!isFreightProvider(s.provider)) return { added: 0, status: s.tracking_status ?? null };
  const provider = s.provider as FreightProviderId;
  const adapter = FREIGHT_PROVIDER_ADAPTERS[provider];
  let events: TrackingEvent[];
  try { events = await adapter.track(deps.http, await freightConnection(env, profile, provider), s.provider_ref, s.tracking_code); }
  catch (error) {
    const failures = Number(s.tracking_failures ?? 0) + 1;
    await exec(env, "UPDATE erp_frete_shipments SET tracking_failures=?, tracking_next=?, tracking_at=?, updated=? WHERE id=?", failures, nextCheck(at, failures), at, at, s.id);
    throw error;
  }
  let added = 0;
  const fresh: TrackingEvent[] = [];
  for (const e of events) {
    const r = await exec(env, `INSERT OR IGNORE INTO erp_frete_events(id,profile_id,shipment_id,document_id,happened_at,code,status,description,location,created,notified) VALUES(?,?,?,?,?,?,?,?,?,?,0)`,
      uid(), profile, s.id, s.document_id, e.at, e.code.slice(0, 40), e.status, e.description.slice(0, 300), e.location?.slice(0, 120) ?? null, at);
    if (r?.meta?.changes) { added++; fresh.push(e); }
  }
  const status = latestStatus(events) ?? s.tracking_status ?? null;
  const final = status !== null && TRACKING_FINAL.includes(status as TrackingStatus);
  await exec(env, "UPDATE erp_frete_shipments SET tracking_status=?, tracking_at=?, tracking_next=?, tracking_failures=0, delivered_at=?, updated=? WHERE id=?",
    status, at, final ? null : nextCheck(at, 0), final ? (s.delivered_at ?? at) : null, at, s.id);
  // Aviso: só quando a situação muda, com o evento mais recente, uma vez por evento.
  if (fresh.length && status !== s.tracking_status) {
    const settings = await freightSettings(env, profile);
    const last = [...fresh].sort((a, b) => b.at - a.at)[0];
    if (settings.notify_whatsapp && s.notify_phone && s.tracking_code) {
      try {
        await sendTrackingNotice(env, profile, {
          phone: s.notify_phone, actor: s.created_by, dedupe: `erp-frete:${s.id}:${eventKey(last)}`,
          text: trackingMessage({ customer: s.customer_name, order_number: Number(s.order_number), status: last.status, description: last.description, location: last.location, tracking_code: s.tracking_code }),
        }, at);
      } catch { /* o aviso que não saiu não para o rastreio */ }
      await exec(env, "UPDATE erp_frete_events SET notified=1 WHERE shipment_id=? AND happened_at=? AND code=? AND description=?", s.id, last.at, last.code.slice(0, 40), last.description.slice(0, 300));
    }
  }
  return { added, status };
}

/** Atualiza o rastreio do pedido agora (pela tela). */
export async function refreshTracking(c: FreightCall, id: string, deps: FreightDeps) {
  const ctx = await context(c, id);
  const s = await one(c.env, "SELECT * FROM erp_frete_shipments WHERE profile_id=? AND document_id=? AND status='contracted'", c.profile, ctx.order.id);
  if (!s) throw new ApiError(404, "freight_shipment_missing", "Este pedido não tem envio contratado para rastrear.");
  try { const r = await trackShipment(c.env, c.profile, s, deps); return { ...(await orderFreight(c, id)), added: r.added }; }
  catch (error) { return toApi(error, "O provedor não devolveu o rastreio agora. Tente de novo em instantes."); }
}

/** Pedidos marcados como expedidos na Expedição: o alarme passa a rastrear os envios deles. */
export async function markShipped(env: Env, profile: string, documents: readonly string[], at = now()) {
  for (const document of documents)
    await exec(env, "UPDATE erp_frete_shipments SET shipped_at=?, tracking_next=?, updated=? WHERE profile_id=? AND document_id=? AND status='contracted' AND shipped_at IS NULL",
      at, at, at, profile, document);
}

/** A rodada do alarme: os envios expedidos com rastreio vencido (poucos por rodada; o resto fica para a próxima). */
export async function runTrackingRound(env: Env, profile: string, at: number, deps: FreightDeps, limit = 5) {
  const enabled = new Set(await enabledProviders(env, profile));
  if (!enabled.size) return { checked: 0, failed: 0 };
  const due = await all(env, `SELECT * FROM erp_frete_shipments WHERE profile_id=? AND status='contracted' AND shipped_at IS NOT NULL AND delivered_at IS NULL
    AND (tracking_next IS NULL OR tracking_next<=?) AND shipped_at>? ORDER BY tracking_next LIMIT ?`, profile, at, at - TRACKING_MAX_AGE_MS, limit);
  let checked = 0, failed = 0;
  for (const s of due) {
    if (!enabled.has(s.provider)) {
      await exec(env, "UPDATE erp_frete_shipments SET tracking_next=? WHERE id=?", nextCheck(at, 2), s.id);
      continue;
    }
    try { await trackShipment(env, profile, s, deps, at); checked++; } catch { failed++; }
  }
  return { checked, failed };
}

/** Testa a conexão do provedor e guarda o resultado (sem credencial na mensagem). */
export async function checkProvider(env: Env, profile: string, provider: unknown, deps: FreightDeps) {
  if (!isFreightProvider(provider)) throw new ApiError(404, "not_found", "Provedor de frete desconhecido. Use correios ou melhorenvio.");
  const adapter = FREIGHT_PROVIDER_ADAPTERS[provider];
  try {
    const r = await adapter.check(deps.http, await freightConnection(env, profile, provider));
    const message = `Conexão conferida${r.account ? ` (${r.account})` : ""}.`;
    await recordCheck(env, profile, provider, true, message);
    return { ok: true, message };
  } catch (error) {
    const message = error instanceof FreightError || error instanceof ApiError ? error.message : `${adapter.name} não respondeu. Tente de novo em instantes.`;
    await recordCheck(env, profile, provider, false, message);
    return { ok: false, message };
  }
}
