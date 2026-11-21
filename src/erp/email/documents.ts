// Leitura dos documentos do ERP para o envio por e-mail, sempre como a pessoa
// que envia (as mesmas rotas do painel, com papel, carteira, partes e
// privacidade de cadastro conferidos por elas). Proposta, pedido de venda,
// NF-e e conta a receber vêm do mesmo leitor do envio pelo WhatsApp
// (src/erp/conversa/documents.ts, só lido); pedido de compra e NFC-e, daqui.
// Acrescenta os e-mails do cadastro (principal e de NF-e) e o nome e o e-mail
// da empresa (remetente e responder-para).
import { ApiError, type Actor, type Env } from "../../types";
import { erpCall, loadDocument, salesPdf, type OutgoingFile, type ReceivablePayment } from "../conversa/documents.ts";
import { day, decimalCents, money } from "../conversa/rules.ts";
import { documentPdf, type PrintableDocument } from "../conversa/pdf.ts";
import type { ErpEmailDocType } from "./contract.ts";
import type { TemplateValues } from "./templates.ts";

export interface EmailDocument {
  type: ErpEmailDocType;
  id: string;
  /** "Pedido de venda nº 123". */
  title: string;
  contact_id: string | null;
  customer_name: string | null;
  /** Campos de e-mail do cadastro do cliente ou fornecedor (null: sem cadastro ou sem acesso a ele). */
  contact: { email: unknown; nfe_email: unknown } | null;
  /** Variáveis do modelo, menos {empresa}. */
  values: Omit<TemplateValues, "empresa">;
  files: OutgoingFile[];
  payment?: { escolha: ReceivablePayment; opcoes: readonly ReceivablePayment[]; avisos: readonly string[] };
  /** NFC-e: o XML vai só se pedido. */
  xml_optional: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown, max = 300) => typeof value === "string" && value.trim() ? Array.from(value.trim()).slice(0, max).join("") : null;
const safeName = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "documento";
const person = (actor: Actor): Actor => ({ ...actor, via: undefined });

/** Os dados da empresa (nome para o remetente, e-mail para o responder-para); sem acesso, nulos. */
export async function companyContact(env: Env, profile: string, actor: Actor): Promise<{ name: string | null; email: string | null }> {
  try {
    const data = object(object(object(await erpCall(env, profile, actor, "GET", "/v1/empresa/identidade", undefined, "os dados da empresa")).record).data);
    return { name: text(data.trade_name, 100) ?? text(data.legal_name, 100), email: text(data.email, 254) };
  } catch { return { name: null, email: null }; }
}

/** Campos de e-mail do cadastro; restrito pela privacidade recusa, o resto (sem papel em cadastros) fica sem sugestão. */
async function contactEmails(env: Env, profile: string, actor: Actor, contactId: string | null): Promise<EmailDocument["contact"]> {
  if (!contactId || !UUID.test(contactId)) return null;
  try {
    const read = object(await erpCall(env, profile, actor, "GET", `/v1/cadastros/contacts/${contactId.toLowerCase()}`, undefined, "o cadastro do contato"));
    const record = object(read.record ?? read.data ?? read), data = object(record.data);
    return { email: record.email ?? data.email ?? null, nfe_email: record.nfe_email ?? data.nfe_email ?? null };
  } catch (error) {
    if (error instanceof ApiError && error.code === "erp_customer_restricted") throw error;
    return null;
  }
}

const numberOf = (title: string) => /nº\s*([^\s(]+)/.exec(title)?.[1] ?? null;

/** Bloco "como pagar" da cobrança: vai na variável {link}. */
function paymentBlock(facts: { pix?: string | null; payment_link?: string | null; boleto_line?: string | null }): string | null {
  const lines = [facts.payment_link ? `Pague pelo link: ${facts.payment_link}` : "", facts.pix ? `Pix copia e cola:\n${facts.pix}` : "",
    facts.boleto_line ? `Linha digitável do boleto (PDF em anexo): ${facts.boleto_line}` : ""].filter(Boolean);
  return lines.length ? lines.join("\n\n") : null;
}

async function nfeRoute(env: Env, profile: string, actor: Actor, path: string, accept = "application/json"): Promise<Response> {
  const { commercialNfeRoute } = await import("../commercial-nfe/routes.ts");
  const { createDefaultCommercialNfeHttp } = await import("../commercial-nfe/http.ts");
  const url = `https://wabotia.internal/api/v1/profiles/${encodeURIComponent(profile)}/erp-comercial-nfe/${path}`;
  return commercialNfeRoute(env, new Request(url, { headers: { Accept: accept } }), profile, person(actor), { handle: createDefaultCommercialNfeHttp() });
}
function nfeRefusal(status: number, body: any, what: string): ApiError {
  const code = typeof body?.code === "string" ? body.code : typeof body?.error?.code === "string" ? body.error.code : null;
  const message = typeof body?.message === "string" ? body.message : typeof body?.error?.message === "string" ? body.error.message : null;
  if (code === "erp_customer_restricted") return new ApiError(403, code, "O cadastro deste cliente está restrito pela privacidade de cadastro; o documento não pode sair por aqui.");
  if (code === "module_disabled") return new ApiError(409, code, message ?? "A parte Fiscal ou Caixa / PDV está desligada. Ligue-a em Gestão → Módulos.");
  if (status === 404) return new ApiError(404, "not_found", `Não achamos ${what} no ERP.`);
  if (status === 403) return new ApiError(403, code ?? "fiscal_forbidden", `Seu papel no ERP não permite ver ${what}. Peça ao administrador em Pessoas e acessos.`);
  if (status === 409 || status === 422) return new ApiError(status, code ?? "erp_conflict", message ?? `O ERP recusou a leitura de ${what}.`);
  return new ApiError(503, "erp_unavailable", `O ERP não respondeu sobre ${what}. Tente de novo em instantes.`);
}

/** Cupom fiscal (NFC-e) de uma venda do caixa: o DANFCE e, se pedido, o XML. Sem cadastro: o endereço é digitado. */
async function coupon(env: Env, profile: string, actor: Actor, saleId: string, xml: boolean, light: boolean): Promise<EmailDocument> {
  const response = await nfeRoute(env, profile, actor, `nfce/vendas/${saleId}`);
  const sale = object(await response.json().catch(() => null));
  if (!response.ok) throw nfeRefusal(response.status, sale, "esta venda do caixa");
  const info = object(sale.coupon);
  if (info.status !== "autorizada")
    throw new ApiError(409, "erp_invoice_not_authorized", "Só cupom fiscal autorizado vai ao cliente. O desta venda ainda não foi autorizado (ou foi cancelado).");
  const number = info.number === null || info.number === undefined ? "" : String(info.number);
  const title = `Cupom fiscal (NFC-e)${number ? ` nº ${number}` : ""}${info.series !== null && info.series !== undefined ? ` (série ${info.series})` : ""}`;
  const artifact = async (path: string, accept: string, what: string) => {
    if (light) return new Uint8Array(0);
    const file = await nfeRoute(env, profile, actor, path, accept);
    if (!file.ok || file.status !== 200) throw nfeRefusal(file.status === 202 ? 409 : file.status, await file.json().catch(() => null), what);
    return new Uint8Array(await file.arrayBuffer());
  };
  const files: OutgoingFile[] = [{ name: `${safeName(`NFC-e-${number || saleId.slice(0, 8)}`)}.pdf`, type: "application/pdf",
    bytes: await artifact(`nfce/vendas/${saleId}/cupom`, "application/pdf", "o cupom fiscal desta venda") }];
  if (xml && typeof info.emission_id === "string" && UUID.test(info.emission_id))
    files.push({ name: `${safeName(`NFC-e-${info.access_key ?? number}`)}.xml`, type: "application/xml",
      bytes: await artifact(`emissoes/${info.emission_id}/xml`, "application/xml", "o XML deste cupom"), optional: "xml" });
  const total = typeof sale.total_cents === "string" && /^\d+$/.test(sale.total_cents) ? sale.total_cents : null;
  const name = text(sale.contact_name, 200);
  return { type: "nfce", id: saleId, title: `${title}${info.environment === "homologacao" ? " - homologação, sem valor fiscal" : ""}`, contact_id: null, customer_name: name,
    contact: null, values: { cliente: name ?? "cliente", numero: number || null, valor: money(total) }, files, xml_optional: true };
}

/** Pedido de compra ao fornecedor: o PDF igual ao da impressão. */
async function purchase(env: Env, profile: string, actor: Actor, id: string, light: boolean): Promise<EmailDocument> {
  const body = object(await erpCall(env, profile, actor, "GET", `/v1/documentos/purchase_orders/${id}`, undefined, "este pedido de compra"));
  const doc = object(body.document);
  if (doc.kind !== "purchase_orders" || typeof doc.number !== "string") throw new ApiError(404, "not_found", "Não achamos este pedido de compra no ERP.");
  if (doc.template === true) throw new ApiError(409, "erp_document_template", "Modelo de documento não vai ao fornecedor. Abra um pedido feito a partir dele.");
  if (doc.status === "cancelled") throw new ApiError(409, "erp_document_not_ready", "Pedido de compra cancelado não vai ao fornecedor. Mude a situação antes de enviar.");
  const contact = object(doc.contact_snapshot), totals = object(doc.totals);
  const items = (Array.isArray(doc.items) ? doc.items : []).map(object);
  const statusLabel = text(object(doc.situation).name, 60);
  const printable: PrintableDocument = {
    title: "Pedido de compra", number: doc.number, status: statusLabel, date: text(doc.date, 10), valid_until: null, company: null,
    customer: { name: text(contact.name, 200) ?? "Fornecedor", document: text(contact.document, 30), city: text(contact.city) && text(contact.state) ? `${contact.city} / ${contact.state}` : text(contact.city) },
    items: items.map(item => ({ code: text(item.code, 30), description: text(item.description, 2000) ?? "", unit: text(item.unit, 6) ?? "", quantity: String(item.quantity ?? ""),
      unit_price: String(item.unit_price ?? ""), total: String(item.total ?? "") })),
    totals: { subtotal: typeof totals.subtotal === "string" ? totals.subtotal : null, discount: typeof totals.discount === "string" ? totals.discount : null,
      freight: typeof totals.freight === "string" ? totals.freight : null, total: typeof totals.total === "string" ? totals.total : String(doc.total ?? "0.00") },
    payment_terms: text(doc.payment_terms, 2000), delivery_terms: text(doc.delivery_terms, 2000), notes: text(doc.notes, 2000), installments: [],
  };
  const pdf = light ? documentPdf(printable) : await salesPdf(env, profile, actor, doc, printable, statusLabel);
  const contactId = typeof doc.contact_id === "string" ? doc.contact_id : null;
  const name = printable.customer.name;
  return { type: "compra", id, title: `Pedido de compra nº ${doc.number}`, contact_id: contactId, customer_name: name,
    contact: contactId ? await contactEmails(env, profile, actor, contactId) : { email: contact.email ?? null, nfe_email: null },
    values: { cliente: name, numero: doc.number, valor: money(decimalCents(printable.totals.total)) },
    files: [{ name: `${safeName(`Pedido-de-compra-${doc.number}`)}.pdf`, type: "application/pdf", bytes: pdf }], xml_optional: false };
}

/**
 * Lê o documento como a pessoa; parte desligada e permissão já recusam aqui. `light`: sem buscar no cofre os arquivos
 * da nota nem gerar cobrança (prévia); o tamanho fica 0. Nota fiscal: o XML vai sempre (regra da NF-e).
 */
export async function loadEmailDocument(env: Env, profile: string, actor: Actor, type: ErpEmailDocType, id: string,
  options: { xml?: boolean; parts: Readonly<Record<string, boolean>>; light?: boolean; payment?: ReceivablePayment | null }): Promise<EmailDocument> {
  if (!UUID.test(id)) throw new ApiError(400, "invalid_request", "Identificador do documento inválido.");
  const normalized = id.toLowerCase(), light = options.light === true;
  if (type === "compra") return purchase(env, profile, actor, normalized, light);
  if (type === "nfce") return coupon(env, profile, actor, normalized, options.xml === true, light);
  const doc = await loadDocument(env, profile, actor, type, normalized, { xml: type === "nota", parts: options.parts, light, payment: options.payment ?? null });
  const facts = doc.facts;
  const contact = await contactEmails(env, profile, actor, doc.contact_id);
  return {
    type, id: doc.id, title: doc.title, contact_id: doc.contact_id, customer_name: doc.customer_name, contact,
    values: {
      cliente: doc.customer_name ?? "cliente", numero: type === "conta" ? facts.description ?? facts.label : numberOf(doc.title), valor: money(facts.total_cents),
      vencimento: day(facts.due_on ?? facts.valid_until ?? null), link: type === "conta" ? paymentBlock(facts) : null,
    },
    files: doc.files, ...(doc.payment ? { payment: doc.payment } : {}), xml_optional: false,
  };
}
