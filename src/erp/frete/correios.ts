// Frete: adaptador dos Correios com contrato próprio (API dos Correios, "CWS":
// token pelo cartão de postagem, preço, prazo, pré-postagem, rótulo e
// rastro). Homologação em apihom.correios.com.br (o interruptor "sandbox");
// produção em api.correios.com.br. O que ligar e conferir: docs/FRETE.md.
// Cada volume é um objeto nos Correios: o envio contratado aqui leva um volume.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import {
  FreightError, callJson, cmCeil, digits, moneyCents, providerMessage,
  type ContractRequest, type FreightConnection, type FreightHttp, type FreightProvider, type FreightVolume, type TrackingEvent,
} from "./provider.ts";
import { correiosStatus } from "./tracking.ts";

const NAME = "Os Correios";
export const CORREIOS_PRODUCTION = "https://api.correios.com.br";
export const CORREIOS_SANDBOX = "https://apihom.correios.com.br";
/** Nomes dos serviços mais usados (o código vem do contrato). */
export const CORREIOS_SERVICES: Readonly<Record<string, string>> = Object.freeze({
  "03220": "SEDEX", "03298": "PAC", "03140": "SEDEX 12", "03158": "SEDEX 10", "04227": "Mini Envios", "04162": "SEDEX", "04669": "PAC",
});
const base = (conn: FreightConnection) => (conn.sandbox ? CORREIOS_SANDBOX : CORREIOS_PRODUCTION);
const services = (conn: FreightConnection) => (conn.options.servicos ?? "03220,03298").split(/[,\s;]+/).map((s) => digits(s)).filter((s) => s.length >= 5).slice(0, 10);
const need = (conn: FreightConnection, key: string, label: string) => {
  const v = conn.credentials[key]?.trim();
  if (!v) throw new FreightError("freight_provider_not_configured", `Falta ${label} dos Correios. Preencha em Expedição › Frete e transportadoras.`, { status: 409 });
  return v;
};

/** Token do dia: usuário e código de acesso da API, com o cartão de postagem. */
async function token(http: FreightHttp, conn: FreightConnection): Promise<string> {
  const user = need(conn, "usuario", "o usuário (Meu Correios)"), code = need(conn, "codigo_acesso", "o código de acesso à API"), card = need(conn, "cartao_postagem", "o cartão de postagem");
  const basic = btoa(`${user}:${code}`);
  const r = await callJson(http, NAME, `${base(conn)}/token/v1/autentica/cartaopostagem`, {
    method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", Accept: "application/json" }, body: { numero: card },
  });
  if (!r.ok || typeof r.data?.token !== "string")
    throw new FreightError("freight_provider_auth", `Os Correios recusaram o acesso: ${providerMessage(r.data) ?? "confira usuário, código de acesso e cartão de postagem"}.`);
  return r.data.token as string;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: "application/json", "Content-Type": "application/json" });

function single(volumes: readonly FreightVolume[]): FreightVolume {
  if (volumes.length !== 1)
    throw new FreightError("freight_correios_one_volume", "Nos Correios cada volume é um envio. Monte o pedido em um volume só, ou contrate pelo Melhor Envio.", { status: 400 });
  return volumes[0];
}
const brasilia = (v: unknown) => {
  if (typeof v !== "string") return NaN;
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}-03:00`);
};
const person = (a: ContractRequest["from"]) => {
  const all = digits(a.phone), phone = all.length > 11 && all.startsWith("55") ? all.slice(2) : all;
  return {
    nome: a.name.slice(0, 50), cpfCnpj: digits(a.document) || undefined, email: a.email ?? undefined,
    ...(phone.length === 10 || phone.length === 11 ? { dddCelular: phone.slice(0, 2), celular: phone.slice(2) } : {}),
    endereco: { cep: a.postal_code, logradouro: (a.street ?? "").slice(0, 50), numero: (a.number ?? "S/N").slice(0, 6), complemento: (a.complement ?? "").slice(0, 30) || undefined,
      bairro: (a.district ?? "").slice(0, 30), cidade: (a.city ?? "").slice(0, 30), uf: (a.state ?? "").slice(0, 2) },
  };
};

export const correiosProvider: FreightProvider = {
  id: "correios", name: "Correios", sandbox: true,
  secretFields: [
    { key: "usuario", label: "Usuário do Meu Correios", hint: "O usuário (CPF ou CNPJ) do contrato no Meu Correios." },
    { key: "codigo_acesso", label: "Código de acesso à API", hint: "Gerado no Meu Correios › Gestão de acesso a API's." },
    { key: "cartao_postagem", label: "Cartão de postagem", hint: "O número do cartão de postagem do contrato." },
  ],
  optionFields: [
    { key: "contrato", label: "Número do contrato", hint: "Usado no cálculo do preço do contrato.", required: false },
    { key: "dr", label: "Diretoria regional (DR)", hint: "Número da DR do contrato (ex.: 72 para São Paulo).", required: false },
    { key: "servicos", label: "Códigos dos serviços", hint: "Separados por vírgula, do seu contrato (ex.: 03220 para SEDEX, 03298 para PAC).", required: false },
  ],

  async check(http, conn) {
    await token(http, conn);
    return { account: conn.credentials.cartao_postagem ? `cartão final ${conn.credentials.cartao_postagem.slice(-4)}` : null };
  },

  async quote(http, conn, req) {
    const t = await token(http, conn);
    const v = req.volumes;
    const out = [];
    for (const code of services(conn)) {
      let price = 0, ok = true;
      for (const vol of v) {
        const q = new URLSearchParams({ cepOrigem: req.from_postal_code, cepDestino: req.to_postal_code, psObjeto: String(Math.max(1, vol.weight_g)), tpObjeto: "2",
          comprimento: String(cmCeil(vol.length_mm)), largura: String(cmCeil(vol.width_mm)), altura: String(cmCeil(vol.height_mm)) });
        if (conn.options.contrato) q.set("nuContrato", digits(conn.options.contrato));
        if (conn.options.dr) q.set("nuDR", digits(conn.options.dr));
        const r = await callJson(http, NAME, `${base(conn)}/preco/v1/nacional/${code}?${q}`, { method: "GET", headers: auth(t) });
        const cents = r.ok ? moneyCents(r.data?.pcFinal) : null;
        if (cents === null) { ok = false; break; }
        price += cents;
      }
      if (!ok) continue;
      const p = await callJson(http, NAME, `${base(conn)}/prazo/v1/nacional/${code}?${new URLSearchParams({ cepOrigem: req.from_postal_code, cepDestino: req.to_postal_code })}`, { method: "GET", headers: auth(t) });
      const days = p.ok && Number.isFinite(Number(p.data?.prazoEntrega)) ? Number(p.data.prazoEntrega) : null;
      out.push({ service_code: code, service_name: CORREIOS_SERVICES[code] ?? `Serviço ${code}`, company: "Correios", price_cents: price, delivery_days: days });
    }
    if (!out.length) throw new FreightError("freight_no_service", "Os Correios não devolveram preço para este CEP e estes volumes. Confira os CEPs, o peso e as medidas, e os serviços do contrato.", { status: 422 });
    return out;
  },

  async contract(http, conn, req) {
    const vol = single(req.volumes);
    const t = await token(http, conn);
    const body = {
      remetente: person(req.from), destinatario: person(req.to), codigoServico: req.service_code,
      pesoInformado: String(Math.max(1, vol.weight_g)), codigoFormatoObjetoInformado: "2",
      comprimentoInformado: String(cmCeil(vol.length_mm)), larguraInformada: String(cmCeil(vol.width_mm)), alturaInformada: String(cmCeil(vol.height_mm)),
      cienteObjetoNaoProibido: 1, modalidadePagamento: "2",
      // A referência do Wabotia volta na consulta (resposta incerta).
      observacao: req.reference,
      ...(req.invoice
        ? { chaveNFe: req.invoice.key, numeroNotaFiscal: req.invoice.number === null ? undefined : String(req.invoice.number) }
        : { itensDeclaracaoConteudo: req.items.slice(0, 50).map((i) => ({ conteudo: i.description.slice(0, 80), quantidade: String(Math.max(1, Math.round(i.quantity))), valor: (i.unit_cents / 100).toFixed(2) })) }),
    };
    const r = await callJson(http, NAME, `${base(conn)}/prepostagem/v1/prepostagens`, { method: "POST", headers: auth(t), body, write: true });
    if (!r.ok) throw new FreightError("freight_rejected", `Os Correios recusaram a pré-postagem: ${providerMessage(r.data) ?? "confira os endereços, o peso e as medidas"}.`, { status: 422 });
    if (typeof r.data?.id !== "string" && typeof r.data?.id !== "number")
      throw new FreightError("freight_provider_unavailable", "Os Correios responderam sem o número da pré-postagem. O Wabotia consulta antes de tentar de novo.", { uncertain: true });
    return { provider_ref: String(r.data.id), tracking_code: typeof r.data.codigoObjeto === "string" ? r.data.codigoObjeto : null, price_cents: null };
  },

  async find(http, conn, reference, providerRef) {
    const t = await token(http, conn);
    if (providerRef) {
      const r = await callJson(http, NAME, `${base(conn)}/prepostagem/v1/prepostagens/${encodeURIComponent(providerRef)}`, { method: "GET", headers: auth(t) });
      if (r.status === 404) return null;
      if (!r.ok) throw new FreightError("freight_provider_unavailable", "Os Correios não confirmaram a pré-postagem agora. Tente de novo em instantes.");
      return { provider_ref: providerRef, tracking_code: r.data?.codigoObjeto ?? null, price_cents: null, cancelled: /cancel/i.test(String(r.data?.statusAtual ?? r.data?.status ?? "")) };
    }
    // Sem o número: as pré-postagens recentes do cartão, pela observação com a referência.
    for (let page = 0; page < 3; page++) {
      const r = await callJson(http, NAME, `${base(conn)}/prepostagem/v1/prepostagens?${new URLSearchParams({ page: String(page), size: "50" })}`, { method: "GET", headers: auth(t) });
      if (!r.ok) throw new FreightError("freight_provider_unavailable", "Os Correios não confirmaram se a pré-postagem foi feita. Tente de novo em instantes.");
      const items: any[] = Array.isArray(r.data?.itens) ? r.data.itens : Array.isArray(r.data) ? r.data : [];
      const hit = items.find((i) => i?.observacao === reference);
      if (hit) return { provider_ref: String(hit.id), tracking_code: hit.codigoObjeto ?? null, price_cents: null, cancelled: /cancel/i.test(String(hit.statusAtual ?? hit.status ?? "")) };
      if (items.length < 50) return null;
    }
    return null;
  },

  async label(http, conn, providerRef) {
    const t = await token(http, conn);
    const asked = await callJson(http, NAME, `${base(conn)}/prepostagem/v1/prepostagens/rotulo/assincrono/pdf`, {
      method: "POST", headers: auth(t), body: { idsPrePostagem: [providerRef], tipoRotulo: "P", formatoRotulo: "ET", imprimeRemetente: "S", layoutImpressao: "PADRAO" },
    });
    if (!asked.ok || !asked.data?.idRecibo) throw new FreightError("freight_label_failed", `Os Correios não geraram a etiqueta: ${providerMessage(asked.data) ?? "tente de novo em instantes"}.`);
    const got = await callJson(http, NAME, `${base(conn)}/prepostagem/v1/prepostagens/rotulo/download/assincrono/${encodeURIComponent(String(asked.data.idRecibo))}`, { method: "GET", headers: auth(t) });
    if (!got.ok || typeof got.data?.dados !== "string")
      throw new FreightError("freight_label_pending", "Os Correios ainda estão gerando a etiqueta. Tente baixar de novo em alguns segundos.", { status: 409 });
    return Uint8Array.from(atob(got.data.dados), (c) => c.charCodeAt(0));
  },

  async cancel(http, conn, providerRef) {
    const t = await token(http, conn);
    const r = await callJson(http, NAME, `${base(conn)}/prepostagem/v1/prepostagens/${encodeURIComponent(providerRef)}`, { method: "DELETE", headers: auth(t), write: true });
    if (!r.ok) throw new FreightError("freight_cancel_refused", `Os Correios não cancelaram: ${providerMessage(r.data) ?? "a pré-postagem pode já ter sido postada"}.`, { status: 409 });
  },

  async track(http, conn, _providerRef, trackingCode) {
    if (!trackingCode) return [];
    const t = await token(http, conn);
    const r = await callJson(http, NAME, `${base(conn)}/srorastro/v1/objetos/${encodeURIComponent(trackingCode)}?resultado=T`, { method: "GET", headers: auth(t) });
    if (!r.ok) throw new FreightError("freight_provider_unavailable", "Os Correios não devolveram o rastreio agora. O Wabotia tenta de novo mais tarde.");
    const object = Array.isArray(r.data?.objetos) ? r.data.objetos[0] : null;
    const events: any[] = Array.isArray(object?.eventos) ? object.eventos : [];
    return events.map((e): TrackingEvent | null => {
      const at = brasilia(e?.dtHrCriado);
      if (!Number.isFinite(at)) return null;
      const city = e?.unidade?.endereco?.cidade, uf = e?.unidade?.endereco?.uf;
      const description = String(e?.descricao ?? "Movimentação").slice(0, 300);
      return { at, code: String(e?.codigo ?? ""), status: correiosStatus(String(e?.codigo ?? ""), String(e?.tipo ?? ""), description), description,
        location: city ? `${city}${uf ? `/${uf}` : ""}` : null };
    }).filter((e): e is TrackingEvent => e !== null);
  },
};
