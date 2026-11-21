// Frete: adaptador do Melhor Envio (agregador: Correios, Jadlog, Loggi e
// outras pela mesma conta). API v2 com o token da conta: calcular, pôr no
// carrinho (com a referência do Vinki na etiqueta interna), pagar com o
// saldo da carteira, gerar, imprimir, cancelar e rastrear. Sandbox em
// sandbox.melhorenvio.com.br (o interruptor "sandbox"). O que ligar e
// conferir: docs/FRETE.md.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import {
  FreightError, callJson, cmCeil, digits, moneyCents, providerMessage,
  type ContractRequest, type ContractResult, type FreightConnection, type FreightHttp, type FreightProvider, type FreightVolume, type TrackingEvent,
} from "./provider.ts";
import { TRACKING_LABEL, melhorEnvioStatus } from "./tracking.ts";

const NAME = "O Melhor Envio";
export const MELHORENVIO_PRODUCTION = "https://melhorenvio.com.br/api/v2";
export const MELHORENVIO_SANDBOX = "https://sandbox.melhorenvio.com.br/api/v2";
const base = (conn: FreightConnection) => (conn.sandbox ? MELHORENVIO_SANDBOX : MELHORENVIO_PRODUCTION);
function headers(conn: FreightConnection) {
  const token = conn.credentials.token?.trim();
  if (!token) throw new FreightError("freight_provider_not_configured", "Falta o token do Melhor Envio. Preencha em Expedição › Frete e transportadoras.", { status: 409 });
  // O Melhor Envio pede um contato técnico no User-Agent.
  const email = conn.options.email?.trim() || "contato@wabotia.invalid";
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "User-Agent": `Vinki (${email})` };
}
const volumes = (list: readonly FreightVolume[]) => list.map((v) => ({
  height: cmCeil(v.height_mm), width: cmCeil(v.width_mm), length: cmCeil(v.length_mm), weight: Math.max(0.001, v.weight_g / 1000),
}));
const saoPaulo = (v: unknown) => (typeof v === "string" && v ? Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v.replace(" ", "T") : `${v.replace(" ", "T")}-03:00`) : NaN);
const party = (a: ContractRequest["from"]) => {
  const doc = digits(a.document);
  return {
    name: a.name.slice(0, 100), phone: digits(a.phone) || undefined, email: a.email ?? undefined,
    ...(doc.length === 14 ? { company_document: doc } : doc.length === 11 ? { document: doc } : {}),
    address: a.street ?? "", complement: a.complement ?? "", number: a.number ?? "S/N", district: a.district ?? "", city: a.city ?? "",
    state_abbr: a.state ?? "", country_id: "BR", postal_code: a.postal_code,
  };
};
const orderResult = (o: any): ContractResult & { cancelled: boolean } => ({
  provider_ref: String(o.id), tracking_code: typeof o.tracking === "string" && o.tracking ? o.tracking : null,
  price_cents: moneyCents(o.price), cancelled: o.status === "canceled" || o.status === "cancelled",
});

/** Paga com o saldo e gera a etiqueta conforme a situação lida (nunca paga duas vezes). */
async function advance(http: FreightHttp, conn: FreightConnection, id: string) {
  const read = async () => {
    const r = await callJson(http, NAME, `${base(conn)}/me/orders/${encodeURIComponent(id)}`, { method: "GET", headers: headers(conn) });
    if (r.status === 404) return null;
    if (!r.ok) throw new FreightError("freight_provider_unavailable", "O Melhor Envio não confirmou o envio agora. O Vinki consulta de novo antes de repetir.", { uncertain: true });
    return r.data;
  };
  let order = await read();
  if (!order) return null;
  const fail = (data: any, what: string) => new FreightError("freight_rejected", `O Melhor Envio não ${what}: ${providerMessage(data) ?? "confira o saldo da carteira e os dados do envio"}.`, { status: 422 });
  if (order.status === "pending") {
    const paid = await callJson(http, NAME, `${base(conn)}/me/shipment/checkout`, { method: "POST", headers: headers(conn), body: { orders: [id] }, write: true });
    if (!paid.ok) throw fail(paid.data, "pagou o envio");
    order = await read();
  }
  if (order && order.status === "released" && !order.generated_at) {
    const made = await callJson(http, NAME, `${base(conn)}/me/shipment/generate`, { method: "POST", headers: headers(conn), body: { orders: [id] }, write: true });
    if (!made.ok) throw fail(made.data, "gerou a etiqueta");
    order = await read();
  }
  return order ? orderResult(order) : null;
}

export const melhorEnvioProvider: FreightProvider = {
  id: "melhorenvio", name: "Melhor Envio", sandbox: true,
  secretFields: [
    { key: "token", label: "Token da conta", hint: "Gerado no Melhor Envio em Configurações › Tokens (com as permissões de envio e carrinho)." },
  ],
  optionFields: [
    { key: "email", label: "E-mail técnico", hint: "O Melhor Envio pede um e-mail de contato da integração.", required: true },
    { key: "servicos", label: "Serviços", hint: "Números dos serviços, separados por vírgula (vazio: todos os da conta).", required: false },
  ],

  async check(http, conn) {
    const r = await callJson(http, NAME, `${base(conn)}/me`, { method: "GET", headers: headers(conn) });
    if (!r.ok) throw new FreightError("freight_provider_auth", `O Melhor Envio recusou o token: ${providerMessage(r.data) ?? "gere outro token"}.`);
    return { account: typeof r.data?.email === "string" ? r.data.email : typeof r.data?.firstname === "string" ? r.data.firstname : null };
  },

  async quote(http, conn, req) {
    const list = (conn.options.servicos ?? "").split(/[,\s;]+/).map(digits).filter(Boolean);
    const r = await callJson(http, NAME, `${base(conn)}/me/shipment/calculate`, {
      method: "POST", headers: headers(conn), body: {
        from: { postal_code: req.from_postal_code }, to: { postal_code: req.to_postal_code }, volumes: volumes(req.volumes),
        options: { insurance_value: req.declared_cents / 100, receipt: false, own_hand: false }, ...(list.length ? { services: list.join(",") } : {}),
      },
    });
    if (!r.ok) throw new FreightError("freight_rejected", `O Melhor Envio não cotou: ${providerMessage(r.data) ?? "confira os CEPs, o peso e as medidas"}.`, { status: 422 });
    const options = (Array.isArray(r.data) ? r.data : []).flatMap((s: any) => {
      const price = moneyCents(s?.custom_price ?? s?.price);
      if (s?.error || price === null) return [];
      const days = Number(s?.custom_delivery_time ?? s?.delivery_time);
      return [{ service_code: String(s.id), service_name: String(s.name ?? `Serviço ${s.id}`), company: typeof s?.company?.name === "string" ? s.company.name : null,
        price_cents: price, delivery_days: Number.isFinite(days) ? days : null }];
    });
    if (!options.length) throw new FreightError("freight_no_service", "O Melhor Envio não tem serviço para este CEP e estes volumes. Confira os CEPs, o peso e as medidas.", { status: 422 });
    return options;
  },

  async contract(http, conn, req) {
    const cart = await callJson(http, NAME, `${base(conn)}/me/cart`, {
      method: "POST", headers: headers(conn), write: true, body: {
        service: Number(req.service_code), from: party(req.from), to: party(req.to),
        products: req.items.slice(0, 50).map((i) => ({ name: i.description.slice(0, 100), quantity: Math.max(1, Math.round(i.quantity)), unitary_value: i.unit_cents / 100 })),
        volumes: volumes(req.volumes),
        options: {
          insurance_value: req.declared_cents / 100, receipt: false, own_hand: false, reverse: false,
          ...(req.invoice ? { non_commercial: false, invoice: { key: req.invoice.key } } : { non_commercial: true }),
          platform: "Vinki", tags: [{ tag: req.reference, url: null }],
        },
      },
    });
    if (!cart.ok) throw new FreightError("freight_rejected", `O Melhor Envio recusou o envio: ${providerMessage(cart.data) ?? "confira os endereços, o peso e as medidas"}.`, { status: 422 });
    const id = cart.data?.id;
    if (typeof id !== "string" && typeof id !== "number")
      throw new FreightError("freight_provider_unavailable", "O Melhor Envio respondeu sem o número do envio. O Vinki consulta antes de tentar de novo.", { uncertain: true });
    try {
      const done = await advance(http, conn, String(id));
      if (!done) throw new FreightError("freight_provider_unavailable", "O envio sumiu do Melhor Envio logo depois de criado. Confira no Melhor Envio.", { uncertain: true });
      return done;
    } catch (error) {
      // O envio já existe lá: a próxima tentativa continua deste número (consulta antes).
      if (error instanceof FreightError) throw new FreightError(error.code, error.message, { status: error.status, uncertain: true, providerRef: String(id) });
      throw error;
    }
  },

  async find(http, conn, reference, providerRef) {
    if (providerRef) return advance(http, conn, providerRef);
    const r = await callJson(http, NAME, `${base(conn)}/me/orders/search?${new URLSearchParams({ q: reference })}`, { method: "GET", headers: headers(conn) });
    if (!r.ok) throw new FreightError("freight_provider_unavailable", "O Melhor Envio não confirmou se o envio foi feito. Tente de novo em instantes.");
    const list: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.data) ? r.data.data : [];
    const hit = list.find((o) => Array.isArray(o?.tags) && o.tags.some((t: any) => t?.tag === reference));
    return hit ? advance(http, conn, String(hit.id)) : null;
  },

  async label(http, conn, providerRef) {
    const r = await callJson(http, NAME, `${base(conn)}/me/shipment/print`, { method: "POST", headers: headers(conn), body: { mode: "private", orders: [providerRef] } });
    if (!r.ok || typeof r.data?.url !== "string") throw new FreightError("freight_label_failed", `O Melhor Envio não liberou a etiqueta: ${providerMessage(r.data) ?? "tente de novo em instantes"}.`);
    let file: Response;
    try { file = await http(r.data.url, { method: "GET", headers: { ...headers(conn), Accept: "application/pdf" } }); }
    catch { throw new FreightError("freight_provider_unavailable", "O Melhor Envio não entregou o PDF da etiqueta. Tente de novo em instantes."); }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!file.ok || !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46))
      throw new FreightError("freight_label_failed", "O Melhor Envio não devolveu a etiqueta em PDF. Tente de novo em instantes.");
    return bytes;
  },

  async cancel(http, conn, providerRef) {
    const can = await callJson(http, NAME, `${base(conn)}/me/shipment/cancellable`, { method: "POST", headers: headers(conn), body: { orders: [providerRef] } });
    if (!can.ok) throw new FreightError("freight_provider_unavailable", "O Melhor Envio não disse se o envio pode ser cancelado. Tente de novo em instantes.");
    if (can.data?.[providerRef]?.cancellable === false)
      throw new FreightError("freight_cancel_refused", "O Melhor Envio não permite cancelar este envio (já postado ou fora do prazo).", { status: 409 });
    const r = await callJson(http, NAME, `${base(conn)}/me/shipment/cancel`, {
      method: "POST", headers: headers(conn), write: true, body: { order: { id: providerRef, reason_id: "2", description: "Cancelado pelo vendedor" } },
    });
    if (!r.ok) throw new FreightError("freight_cancel_refused", `O Melhor Envio não cancelou: ${providerMessage(r.data) ?? "confira no Melhor Envio"}.`, { status: 409 });
  },

  async track(http, conn, providerRef) {
    const r = await callJson(http, NAME, `${base(conn)}/me/shipment/tracking`, { method: "POST", headers: headers(conn), body: { orders: [providerRef] } });
    if (!r.ok) throw new FreightError("freight_provider_unavailable", "O Melhor Envio não devolveu o rastreio agora. O Vinki tenta de novo mais tarde.");
    const o = r.data?.[providerRef];
    if (!o) return [];
    const marks: [string, string, string][] = [["generated_at", "generated", TRACKING_LABEL.label_created], ["posted_at", "posted", "Objeto postado"],
      ["delivered_at", "delivered", "Objeto entregue ao destinatário"], ["canceled_at", "canceled", "Envio cancelado"]];
    const out: TrackingEvent[] = marks.flatMap(([field, code, description]) => {
      const at = saoPaulo(o[field]);
      return Number.isFinite(at) ? [{ at, code, status: melhorEnvioStatus(code), description, location: null }] : [];
    });
    // Situação sem data própria (em trânsito, não entregue): entra como o último evento.
    if (o.status && !marks.some(([, code]) => code === o.status || (o.status === "released" && code === "generated"))) {
      const at = saoPaulo(o.updated_at ?? o.posted_at ?? o.generated_at);
      if (Number.isFinite(at)) out.push({ at: at + 1, code: String(o.status), status: melhorEnvioStatus(String(o.status)), description: TRACKING_LABEL[melhorEnvioStatus(String(o.status))], location: null });
    }
    return out;
  },
};
