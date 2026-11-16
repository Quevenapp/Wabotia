// Vendas: nota fiscal (NFC-e modelo 65 e NF-e modelo 55). O Wabotia monta o
// documento a partir da venda (cópia fiscal de cada linha), do emitente
// (configurações "vendas".fiscal + Estabelecimento) e dos pagamentos, aponta
// o que falta, e entrega a emissão a um provedor (FiscalProvider). Nenhum
// provedor está integrado: a escolha (Focus NFe, NFE.io, PlugNotas…) e o
// certificado digital são decisão do dono da instalação (docs/VENDAS.md,
// "Nota fiscal"). O certificado e o CSC ficam no provedor, nunca aqui.
import { all, batch, one } from "../../db";
import { ApiError, type Actor, type Env, json, now, requireValue, uid } from "../../types";
import type { Establishment, ModuleContext } from "../api";
import {
  CRT,
  FISCAL_PAYMENT,
  fromMilli,
  vendasSettings,
  type FiscalSettings,
  type PaymentMethod,
  type ProductFiscal,
} from "./model";
import type { Line } from "./lines";
import { loadSale, requireSeller, type SalePayment } from "./sales";

export type FiscalModel = "nfce" | "nfe";
export const MODEL_CODE: Record<FiscalModel, "65" | "55"> = {
  nfce: "65",
  nfe: "55",
};

// ---------------------------------------------------------------------------
// Documento neutro (nomes próximos do leiaute 4.00 da NF-e)

export interface FiscalAddress {
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  city_code: string;
  uf: string;
  cep: string;
}

export interface FiscalItem {
  number: number;
  /** cProd: SKU ou id do produto. */
  code: string;
  /** cEAN: GTIN ou "SEM GTIN". */
  ean: string;
  description: string;
  ncm: string;
  cest: string | null;
  cfop: string;
  unit: string;
  quantity: number;
  unit_value_cents: number;
  gross_cents: number;
  discount_cents: number;
  tax_unit: string;
  tax_quantity: number;
  tax_ean: string;
  icms: {
    origin: number;
    cst: string | null;
    csosn: string | null;
    rate: number | null;
    base_reduction: number | null;
    base_cents: number | null;
    value_cents: number | null;
    fcp_rate: number | null;
  };
  pis: { cst: string; rate: number | null; value_cents: number | null };
  cofins: { cst: string; rate: number | null; value_cents: number | null };
  ipi: { cst: string; rate: number | null } | null;
  cbenef: string | null;
  ibs_cbs: { cst: string; cclasstrib: string | null } | null;
}

export interface FiscalDocument {
  model: "65" | "55";
  environment: "homologacao" | "producao";
  series: number;
  crt: number | null;
  sale: { id: string; number: number; created: number };
  emitter: {
    cnpj: string;
    legal_name: string;
    trade_name: string;
    ie: string;
    im: string;
    cnae: string;
    address: FiscalAddress;
    phone: string;
  };
  recipient: {
    document: string;
    name: string;
    ie: string;
    email: string;
    address: FiscalAddress | null;
  } | null;
  items: FiscalItem[];
  totals: {
    products_cents: number;
    discount_cents: number;
    total_cents: number;
    icms_cents: number;
    pis_cents: number;
    cofins_cents: number;
  };
  payments: { tpag: string; method: PaymentMethod; amount_cents: number }[];
  change_cents: number;
  additional_info: string;
}

export interface FiscalIssue {
  field: string;
  message: string;
  line?: number;
  product_id?: string | null;
}

// ---------------------------------------------------------------------------
// Provedores

export interface FiscalResult {
  status: "authorized" | "processing" | "rejected" | "error";
  provider_ref?: string | null;
  series?: number | null;
  number?: number | null;
  access_key?: string | null;
  protocol?: string | null;
  xml_url?: string | null;
  pdf_url?: string | null;
  message?: string;
}

/**
 * Emissor fiscal. Um provedor novo implementa esta interface num arquivo
 * próprio (ex.: ./fiscal-focusnfe.ts), chama registerFiscalProvider no
 * carregamento e guarda o token da conta cifrado, como a Cobrança guarda o
 * do Mercado Pago. `key` é idempotente: reenviar a mesma chave não emite
 * outra nota (os provedores aceitam uma referência própria por documento).
 */
export interface FiscalProvider {
  id: string;
  name: string;
  models: FiscalModel[];
  emit(
    env: Env,
    profile: string,
    document: FiscalDocument,
    options: { key: string },
  ): Promise<FiscalResult>;
  status?(env: Env, profile: string, ref: string): Promise<FiscalResult>;
  cancel?(
    env: Env,
    profile: string,
    ref: string,
    reason: string,
  ): Promise<FiscalResult>;
}

const providers = new Map<string, FiscalProvider>();
export function registerFiscalProvider(provider: FiscalProvider) {
  providers.set(provider.id, provider);
}
/** Só para testes: tira um provedor registrado. */
export function unregisterFiscalProvider(id: string) {
  providers.delete(id);
}
export const fiscalProviders = () =>
  [...providers.values()].map((p) => ({ id: p.id, name: p.name, models: p.models }));

// ---------------------------------------------------------------------------
// Montagem

const emitterIssues = (
  cfg: FiscalSettings,
  e: Establishment,
  issues: FiscalIssue[],
) => {
  const need = (ok: unknown, field: string, message: string) => {
    if (!ok) issues.push({ field, message });
  };
  need(cfg.regime, "fiscal.regime", "Escolha o regime tributário do emitente.");
  need(
    e.document_type === "cnpj",
    "establishment.document",
    "Cadastre o CNPJ do emitente em Estabelecimento (nota fiscal exige CNPJ).",
  );
  need(cfg.legal_name, "fiscal.legal_name", "Informe a razão social.");
  need(cfg.ie, "fiscal.ie", "Informe a inscrição estadual (ou ISENTO).");
  need(cfg.street && cfg.number, "fiscal.street", "Informe logradouro e número do emitente.");
  need(cfg.district, "fiscal.district", "Informe o bairro do emitente.");
  need(cfg.city && cfg.city_code, "fiscal.city_code", "Informe o município e o código IBGE (7 dígitos).");
  need(cfg.uf, "fiscal.uf", "Informe a UF do emitente.");
  need(cfg.cep, "fiscal.cep", "Informe o CEP do emitente.");
};

const valueOf = (base: number, rate: number | null | undefined) =>
  rate === null || rate === undefined ? null : Math.round((base * rate) / 100);

/**
 * Documento fiscal da venda e a lista do que falta para emitir. Não grava
 * nada: serve para a prévia e para o envio ao provedor.
 */
export function buildFiscalDocument(
  sale: any,
  model: FiscalModel,
  cfg: FiscalSettings,
  e: Establishment,
  recipientInput: any = null,
): { document: FiscalDocument; issues: FiscalIssue[] } {
  const issues: FiscalIssue[] = [];
  emitterIssues(cfg, e, issues);
  if (sale.status !== "completed")
    issues.push({
      field: "sale.status",
      message: "Só vendas concluídas (pagas) recebem nota fiscal.",
    });
  if (sale.refunded_cents > 0)
    issues.push({
      field: "sale.refunded_cents",
      message: "A venda tem devolução: a nota sai com o valor original; emita a nota de devolução pelo provedor.",
    });
  const simples = cfg.regime === "simples" || cfg.regime === "mei";
  const lines: Line[] = json(sale.lines, []);
  let icmsTotal = 0,
    pisTotal = 0,
    cofinsTotal = 0;
  const items = lines.map((line, i): FiscalItem => {
    const f: ProductFiscal = line.fiscal || {};
    const at = (field: string, message: string) =>
      issues.push({ field: `lines[${i}].${field}`, message: `"${line.name}": ${message}`, line: i, product_id: line.product_id });
    if (!line.product_id)
      at("product_id", "item avulso, sem dados fiscais. Cadastre como produto para sair na nota.");
    if (!f.ncm) at("ncm", "falta o NCM.");
    const cfop = f.cfop || cfg.default_cfop;
    if (model === "nfce" && !cfop.startsWith("5"))
      at("cfop", `CFOP ${cfop} não serve para NFC-e (venda dentro do estado, 5xxx).`);
    if (!/^[5-7]/.test(cfop)) at("cfop", `CFOP ${cfop} não é de saída.`);
    const csosn = simples ? f.icms_csosn || cfg.default_csosn : null;
    const cst = simples ? null : f.icms_cst || cfg.default_icms_cst;
    if (simples && f.icms_cst)
      at("icms_csosn", "o emitente é do Simples Nacional: use CSOSN, não CST.");
    if (!simples && f.icms_csosn)
      at("icms_cst", "o emitente é do regime normal: use CST, não CSOSN.");
    const net = line.net_cents - 0;
    const discount = line.gross_cents - net;
    const reduction = f.icms_base_reduction ?? null;
    const taxed = !simples && cst && ["00", "10", "20", "70", "90"].includes(cst);
    const base = taxed ? Math.round(net * (1 - (reduction || 0) / 100)) : null;
    const icmsValue = base !== null ? valueOf(base, f.icms_rate ?? null) : null;
    if (taxed && f.icms_rate === undefined) at("icms_rate", `CST ${cst} pede a alíquota do ICMS.`);
    const pisCst = f.pis_cst || cfg.default_pis_cst;
    const cofinsCst = f.cofins_cst || cfg.default_cofins_cst;
    const pisValue = ["01", "02"].includes(pisCst) ? valueOf(net, f.pis_rate ?? null) : null;
    const cofinsValue = ["01", "02"].includes(cofinsCst) ? valueOf(net, f.cofins_rate ?? null) : null;
    if (["01", "02"].includes(pisCst) && f.pis_rate === undefined) at("pis_rate", `CST ${pisCst} do PIS pede a alíquota.`);
    if (["01", "02"].includes(cofinsCst) && f.cofins_rate === undefined) at("cofins_rate", `CST ${cofinsCst} da COFINS pede a alíquota.`);
    icmsTotal += icmsValue || 0;
    pisTotal += pisValue || 0;
    cofinsTotal += cofinsValue || 0;
    const quantity = fromMilli(line.quantity_milli);
    const factor = f.tax_factor || 1;
    return {
      number: i + 1,
      code: line.sku || line.product_id || `AVULSO${i + 1}`,
      ean: line.ean || "SEM GTIN",
      description: line.name,
      ncm: f.ncm || "",
      cest: f.cest || null,
      cfop,
      unit: line.unit,
      quantity,
      unit_value_cents: line.unit_cents,
      gross_cents: line.gross_cents,
      discount_cents: discount,
      tax_unit: f.tax_unit || line.unit,
      tax_quantity: Math.round(quantity * factor * 10000) / 10000,
      tax_ean: f.tax_ean || line.ean || "SEM GTIN",
      icms: {
        origin: f.origin ?? cfg.default_origin,
        cst,
        csosn,
        rate: f.icms_rate ?? null,
        base_reduction: reduction,
        base_cents: base,
        value_cents: icmsValue,
        fcp_rate: f.fcp_rate ?? null,
      },
      pis: { cst: pisCst, rate: f.pis_rate ?? null, value_cents: pisValue },
      cofins: { cst: cofinsCst, rate: f.cofins_rate ?? null, value_cents: cofinsValue },
      ipi: model === "nfe" && f.ipi_cst ? { cst: f.ipi_cst, rate: f.ipi_rate ?? null } : null,
      cbenef: f.cbenef || null,
      ibs_cbs: f.ibs_cbs_cst ? { cst: f.ibs_cbs_cst, cclasstrib: f.cclasstrib || null } : null,
    };
  });
  let recipient: FiscalDocument["recipient"] = sale.customer_document
    ? { document: sale.customer_document, name: sale.customer_name || "", ie: "", email: "", address: null }
    : null;
  if (recipientInput && typeof recipientInput === "object") {
    const r = recipientInput;
    recipient = {
      document: String(r.document || recipient?.document || "").replace(/\D/g, ""),
      name: String(r.name || recipient?.name || "").slice(0, 60),
      ie: String(r.ie || "").replace(/\D/g, ""),
      email: String(r.email || "").slice(0, 60),
      address: r.address
        ? {
            street: String(r.address.street || ""),
            number: String(r.address.number || ""),
            complement: String(r.address.complement || ""),
            district: String(r.address.district || ""),
            city: String(r.address.city || ""),
            city_code: String(r.address.city_code || "").replace(/\D/g, ""),
            uf: String(r.address.uf || "").toUpperCase(),
            cep: String(r.address.cep || "").replace(/\D/g, ""),
          }
        : null,
    };
  }
  if (model === "nfe") {
    if (!recipient?.document)
      issues.push({ field: "recipient.document", message: "NF-e precisa do CPF ou CNPJ do destinatário." });
    if (!recipient?.name)
      issues.push({ field: "recipient.name", message: "NF-e precisa do nome do destinatário." });
    const a = recipient?.address;
    if (!a || !a.street || !a.city_code || !a.uf || !a.cep)
      issues.push({ field: "recipient.address", message: "NF-e precisa do endereço completo do destinatário (logradouro, município com código IBGE, UF e CEP)." });
  }
  const payments: SalePayment[] = json(sale.payments, []);
  return {
    issues,
    document: {
      model: MODEL_CODE[model],
      environment: cfg.environment,
      series: model === "nfce" ? cfg.nfce_series : cfg.nfe_series,
      crt: cfg.regime ? CRT[cfg.regime] : null,
      sale: { id: sale.id, number: sale.number, created: sale.created },
      emitter: {
        cnpj: e.document_type === "cnpj" ? e.document : "",
        legal_name: cfg.legal_name,
        trade_name: e.name,
        ie: cfg.ie,
        im: cfg.im,
        cnae: cfg.cnae,
        address: {
          street: cfg.street,
          number: cfg.number,
          complement: cfg.complement,
          district: cfg.district,
          city: cfg.city,
          city_code: cfg.city_code,
          uf: cfg.uf,
          cep: cfg.cep,
        },
        phone: e.phone,
      },
      recipient,
      items,
      totals: {
        products_cents: sale.subtotal_cents,
        discount_cents: sale.discount_cents,
        total_cents: sale.total_cents,
        icms_cents: icmsTotal,
        pis_cents: pisTotal,
        cofins_cents: cofinsTotal,
      },
      payments: payments.map((p) => ({
        tpag: FISCAL_PAYMENT[p.method],
        method: p.method,
        amount_cents: p.amount_cents,
      })),
      change_cents: sale.change_cents,
      additional_info: sale.note || "",
    },
  };
}

// ---------------------------------------------------------------------------
// Rotas

const modelOf = (value: unknown): FiscalModel => {
  const model = (value ?? "nfce") as FiscalModel;
  requireValue(model === "nfce" || model === "nfe", "model: nfce ou nfe.");
  return model;
};

/** GET vendas/sales/:id/fiscal?model=nfce|nfe: prévia e pendências. */
export async function fiscalPreview(
  ctx: ModuleContext,
  id: unknown,
  query: Record<string, string>,
) {
  const model = modelOf(query.model);
  const sale = await loadSale(ctx, id);
  const cfg = vendasSettings(await ctx.settings()).fiscal;
  const built = buildFiscalDocument(sale, model, cfg, await ctx.establishment());
  const provider = cfg.provider ? providers.get(cfg.provider) : null;
  return {
    model,
    ready: !built.issues.length && !!provider,
    provider: provider ? { id: provider.id, name: provider.name } : null,
    issues: built.issues,
    document: built.document,
  };
}

/** GET vendas/fiscal: emitente, emissores disponíveis e o catálogo sem NCM. */
export async function fiscalOverview(ctx: ModuleContext) {
  const cfg = vendasSettings(await ctx.settings()).fiscal;
  const issues: FiscalIssue[] = [];
  emitterIssues(cfg, await ctx.establishment(), issues);
  const missing = await one<{ total: number; no_ncm: number }>(
    ctx.env,
    "SELECT count(*) total, coalesce(sum(coalesce(json_extract(fiscal,'$.ncm'),'')=''),0) no_ncm FROM vendas_products WHERE profile_id=? AND active=1",
    ctx.profile,
  );
  return {
    config: cfg,
    emitter_issues: issues,
    providers: fiscalProviders(),
    provider_configured: !!(cfg.provider && providers.has(cfg.provider)),
    products: { active: missing?.total || 0, without_ncm: missing?.no_ncm || 0 },
  };
}

export const fiscalDocumentView = (row: any) => ({
  id: row.id,
  sale_id: row.sale_id,
  model: row.model as FiscalModel,
  environment: row.environment,
  series: row.series ?? null,
  number: row.number ?? null,
  status: row.status,
  provider: row.provider,
  access_key: row.access_key ?? null,
  protocol: row.protocol ?? null,
  pdf_url: row.pdf_url ?? null,
  xml_url: row.xml_url ?? null,
  message: row.message,
  created: row.created,
  updated: row.updated,
});

/**
 * POST vendas/sales/:id/fiscal/emit {model?, recipient?}. Sem emissor
 * configurado: 409 fiscal_provider_not_configured. Com pendências: 409
 * fiscal_not_ready (details.issues). Com emissor: grava o documento, chama o
 * provedor com uma chave idempotente e guarda o resultado.
 */
export async function emitFiscal(
  ctx: ModuleContext,
  actor: Actor,
  data: any,
  requestId: string,
) {
  requireSeller(ctx, actor);
  const model = modelOf(data.model);
  const sale = await loadSale(ctx, data.id);
  const cfg = vendasSettings(await ctx.settings()).fiscal;
  const provider = cfg.provider ? providers.get(cfg.provider) : null;
  if (!provider)
    throw new ApiError(
      409,
      "fiscal_provider_not_configured",
      "A emissão de nota fiscal ainda não está ligada nesta instalação: o administrador precisa escolher um emissor (Focus NFe, NFE.io, PlugNotas ou outro) e cadastrar o certificado digital nele. Veja a prévia em GET /vendas/sales/{id}/fiscal.",
    );
  requireValue(
    provider.models.includes(model),
    `O emissor ${provider.name} não emite ${model === "nfce" ? "NFC-e" : "NF-e"}.`,
  );
  const authorized = await one(
    ctx.env,
    "SELECT * FROM vendas_fiscal_documents WHERE profile_id=? AND sale_id=? AND model=? AND status IN ('authorized','processing','pending')",
    ctx.profile,
    sale.id,
    model,
  );
  if (authorized) return fiscalDocumentView(authorized);
  const built = buildFiscalDocument(sale, model, cfg, await ctx.establishment(), data.recipient);
  if (built.issues.length) {
    const error = new ApiError(
      409,
      "fiscal_not_ready",
      `Falta ${built.issues.length === 1 ? "um dado" : `${built.issues.length} dados`} para emitir: ${built.issues[0].message}`,
    );
    (error as any).details = { issues: built.issues };
    throw error;
  }
  const id = uid(),
    at = now();
  const key = `${model}:${sale.id}:${requestId}`;
  await batch(ctx.env, [
    [
      "INSERT INTO vendas_fiscal_documents(id,profile_id,sale_id,model,environment,series,status,provider,request,source_key,actor,created,updated) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?)",
      [id, ctx.profile, sale.id, model, cfg.environment, built.document.series, provider.id, JSON.stringify(built.document), key, actor.id, at, at],
    ],
    [
      "UPDATE vendas_sales SET fiscal_status='pending',updated=? WHERE id=? AND profile_id=?",
      [at, sale.id, ctx.profile],
    ],
  ]);
  let result: FiscalResult;
  try {
    result = await provider.emit(ctx.env, ctx.profile, built.document, { key });
  } catch (error) {
    result = { status: "error", message: String((error as Error)?.message || error).slice(0, 300) };
  }
  const saleStatus =
    result.status === "authorized" ? "authorized" : result.status === "processing" ? "pending" : "error";
  await batch(ctx.env, [
    [
      "UPDATE vendas_fiscal_documents SET status=?,provider_ref=?,series=coalesce(?,series),number=?,access_key=?,protocol=?,xml_url=?,pdf_url=?,message=?,updated=? WHERE id=?",
      [
        result.status,
        result.provider_ref ?? null,
        result.series ?? null,
        result.number ?? null,
        result.access_key ?? null,
        result.protocol ?? null,
        result.xml_url ?? null,
        result.pdf_url ?? null,
        result.message || "",
        now(),
        id,
      ],
    ],
    [
      "UPDATE vendas_sales SET fiscal_status=?,updated=? WHERE id=? AND profile_id=?",
      [saleStatus, now(), sale.id, ctx.profile],
    ],
  ]);
  const row = await one(ctx.env, "SELECT * FROM vendas_fiscal_documents WHERE id=?", id);
  await ctx.publish(
    "vendas.fiscal_updated",
    id,
    { sale_id: sale.id, number: sale.number, model, status: result.status, access_key: result.access_key ?? null },
    { key: `fiscal:${id}:${result.status}` },
  );
  return fiscalDocumentView(row);
}

export async function fiscalDocuments(ctx: ModuleContext, saleId: string) {
  return (
    await all(
      ctx.env,
      "SELECT * FROM vendas_fiscal_documents WHERE profile_id=? AND sale_id=? ORDER BY created",
      ctx.profile,
      saleId,
    )
  ).map(fiscalDocumentView);
}
