// Leitura dos documentos do ERP para o envio pela conversa, sempre como a
// pessoa que envia: as mesmas rotas que o painel usa (erp-api e NF-e
// comercial), com o papel, a carteira, as partes ligadas e a privacidade de
// cadastro conferidos por elas. Quem não vê o documento no ERP não o envia.
//
// A NF-e só é lida pelas rotas que já existem (com1.get, com1.danfe e
// com1.xml); nada em src/erp/commercial-nfe é alterado.
import { ApiError, type Actor, type Env } from "../../types";
import { erpIdentity } from "../../modules/erp/identity";
import { erpApi } from "../api/local-fetch";
import { normalizeCustomerPhone, customerPhoneInputMode } from "../../customer/phone";
import { pixPayload, type PixKeyType } from "../../../web/erp/app/lib/pix-static.ts";
import type { ErpConversaDocType } from "./contract.ts";
import { day, decimalCents, erpPath, money, type MessageFacts } from "./rules.ts";
import { documentPdf, type PrintableDocument } from "./pdf.ts";

export interface OutgoingFile { name: string; type: string; bytes: Uint8Array; optional?: "xml" }
export interface LoadedDocument {
  type: ErpConversaDocType;
  id: string;
  /** "Pedido de venda nº 123". */
  title: string;
  contact_id: string | null;
  customer_name: string | null;
  /** Telefones do cadastro do cliente no ERP, em dígitos com DDI. */
  phones: string[];
  facts: MessageFacts;
  purpose: "order" | "billing";
  files: OutgoingFile[];
  /** Página pública do link: só este documento. */
  page: { title: string; status_label: string; headline: string | null; lines: string[] };
  /** Caminho do documento no painel do ERP (para quem tem permissão). */
  erp_path: string;
  ttl_minutes: number;
}

/** Situações base (packages/erp-domain STATES), para o rótulo do PDF e da página. */
const STATES: Record<string, Record<string, string>> = {
  sales_proposals: { open: "Em aberto", pending: "Pendente", waiting: "Aguardando", approved: "Aprovado", rejected: "Não aprovado", completed: "Concluído" },
  sales_orders: { open: "Em aberto", verified: "Verificado", in_progress: "Em andamento", agency_sale: "Venda agenciada", checkout_partial: "Checkout parcial",
    partially_fulfilled: "Atendido parcialmente", partially_invoiced: "Faturado parcialmente", fulfilled: "Atendido" },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown, max = 300) => typeof value === "string" && value.trim() ? Array.from(value.trim()).slice(0, max).join("") : null;
const errorOf = (body: any) => {
  const detail = object(body?.error ?? body);
  return { code: typeof detail.code === "string" ? detail.code : null, message: typeof detail.message === "string" ? detail.message : null };
};

/** Recusa do ERP com o motivo conhecido, em português. */
function refusal(status: number, body: unknown, what: string): ApiError {
  const { code, message } = errorOf(body);
  if (code === "erp_customer_restricted" || message === "erp_customer_restricted" || code === "42501")
    return new ApiError(403, "erp_customer_restricted", "O cadastro deste cliente está restrito pela privacidade de cadastro; o documento não pode sair por aqui.");
  if (code === "module_disabled") return new ApiError(409, "module_disabled", message ?? `A parte do ERP de ${what} está desligada. Ligue-a em Gestão → Módulos.`);
  if (status === 404) return new ApiError(404, "not_found", `Não achamos ${what} no ERP, ou ele não está na sua carteira.`);
  if (status === 403) return new ApiError(403, code ?? "erp_forbidden", message && !/^[a-z0-9_]+$/.test(message) ? message : `Seu papel no ERP não permite ver ${what}. Peça ao administrador em Pessoas e acessos.`);
  if (status === 409 || status === 422) return new ApiError(status, code ?? "erp_conflict", message ?? `O ERP recusou a leitura de ${what}.`);
  return new ApiError(503, "erp_unavailable", `O ERP não respondeu sobre ${what}. Tente de novo em instantes.`);
}

/** A pessoa, sem o vínculo do bot: a rota de envio já conferiu a concessão e a proposta. */
const person = (actor: Actor): Actor => ({ ...actor, via: undefined });

async function erpGet(env: Env, profile: string, actor: Actor, path: string, what: string): Promise<any> {
  const url = `https://wabotia.internal/api/v1/profiles/${encodeURIComponent(profile)}/erp${path}`;
  const who = person(actor);
  const identity = await erpIdentity(env, who, profile, "GET", new URL(url).pathname);
  const response = await erpApi(env, new Request(url), profile, who, identity);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw refusal(response.status, body, what);
  return body;
}

async function nfe(env: Env, profile: string, actor: Actor, path: string, accept = "application/json"): Promise<Response> {
  const { commercialNfeRoute } = await import("../commercial-nfe/routes.ts");
  const { createDefaultCommercialNfeHttp } = await import("../commercial-nfe/http.ts");
  const url = `https://wabotia.internal/api/v1/profiles/${encodeURIComponent(profile)}/erp-comercial-nfe/${path}`;
  return commercialNfeRoute(env, new Request(url, { headers: { Accept: accept } }), profile, person(actor), { handle: createDefaultCommercialNfeHttp() });
}

function phonesOf(record: Record<string, any>): string[] {
  const values = [record.mobile, record.phone, record.whatsapp, record.cellphone].filter((value): value is string => typeof value === "string" && !!value.trim());
  return [...new Set(values.map(value => normalizeCustomerPhone(value, customerPhoneInputMode(value)) ?? normalizeCustomerPhone(value, "human_br")).filter((value): value is string => !!value))];
}

async function company(env: Env, profile: string, actor: Actor): Promise<PrintableDocument["company"]> {
  try {
    const body = await erpGet(env, profile, actor, "/v1/empresa/identidade", "os dados da empresa");
    const data = object(object(body.record).data);
    const name = text(data.trade_name) ?? text(data.legal_name);
    if (!name) return null;
    return { name, document: text(data.cnpj) ? `CNPJ ${data.cnpj}` : null, contact: [text(data.phone), text(data.email)].filter(Boolean).join(" · ") || null,
      city: text(data.city) && text(data.state) ? `${data.city} / ${data.state}` : text(data.city) };
  } catch {
    // Sem os dados da empresa (papel ou cadastro incompleto), o PDF sai sem o cabeçalho.
    return null;
  }
}

const safeName = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "documento";

async function salesDocument(env: Env, profile: string, actor: Actor, type: "proposta" | "pedido", id: string): Promise<LoadedDocument> {
  const kind = type === "proposta" ? "sales_proposals" : "sales_orders";
  const what = type === "proposta" ? "esta proposta" : "este pedido";
  const body = await erpGet(env, profile, actor, `/v1/documentos/${kind}/${id}`, what);
  const doc = object(body.document);
  if (doc.kind !== kind || typeof doc.number !== "string") throw new ApiError(404, "not_found", `Não achamos ${what} no ERP.`);
  if (doc.template === true) throw new ApiError(409, "erp_document_template", "Modelo de documento não é enviado ao cliente. Abra um documento feito a partir dele.");
  if (doc.status === "draft" || doc.status === "cancelled")
    throw new ApiError(409, "erp_document_not_ready", `${type === "proposta" ? "Proposta" : "Pedido"} ${doc.status === "draft" ? "em digitação" : "cancelado"} não é enviado ao cliente. Mude a situação antes de enviar.`);
  const number = text(object(doc.proposal_version).label, 40) ?? doc.number;
  const name = type === "proposta" ? "Proposta comercial" : "Pedido de venda";
  const contact = object(doc.contact_snapshot);
  const totals = object(doc.totals);
  const items = (Array.isArray(doc.items) ? doc.items : []).map(object);
  // Situação própria da área (preferências) tem nome; senão, a base.
  const statusLabel = text(object(doc.situation).name, 60) ?? STATES[kind]?.[doc.status] ?? null;
  const printable: PrintableDocument = {
    title: name, number, status: statusLabel, date: text(doc.date, 10), valid_until: type === "proposta" ? text(doc.valid_until, 10) : null,
    company: await company(env, profile, actor),
    customer: { name: text(contact.name, 200) ?? "Cliente", document: text(contact.document, 30), city: text(contact.city) && text(contact.state) ? `${contact.city} / ${contact.state}` : text(contact.city) },
    items: items.map(item => ({ code: text(item.code, 30), description: text(item.description, 2000) ?? "", unit: text(item.unit, 6) ?? "", quantity: String(item.quantity ?? ""),
      unit_price: String(item.unit_price ?? ""), total: String(item.total ?? "") })),
    totals: { subtotal: typeof totals.subtotal === "string" ? totals.subtotal : null, discount: typeof totals.discount === "string" ? totals.discount : null,
      freight: typeof totals.freight === "string" ? totals.freight : null, total: typeof totals.total === "string" ? totals.total : String(doc.total ?? "0.00") },
    payment_terms: text(doc.payment_terms, 2000), delivery_terms: text(doc.delivery_terms, 2000), notes: text(doc.notes, 2000),
    installments: (Array.isArray(doc.installments) ? doc.installments : []).map(object).filter(part => typeof part.due_date === "string" && typeof part.amount === "string")
      .map(part => ({ due_date: part.due_date, amount: part.amount })),
  };
  const total = decimalCents(printable.totals.total);
  const title = `${name} nº ${number}`;
  const pdf = documentPdf(printable);
  const validUntil = type === "proposta" ? printable.valid_until : null;
  return {
    type, id, title, contact_id: typeof doc.contact_id === "string" ? doc.contact_id : null, customer_name: printable.customer.name,
    phones: phonesOf(contact), purpose: "order",
    facts: { type, label: `${name.toLowerCase()} nº ${number}`, customer: printable.customer.name, total_cents: total, valid_until: validUntil, attachments: 1 },
    files: [{ name: `${safeName(`${name}-${number}`)}.pdf`, type: "application/pdf", bytes: pdf }],
    page: { title, status_label: statusLabel ?? name, headline: money(total) ? `Total: ${money(total)}` : null,
      lines: [day(printable.date) ? `Data: ${day(printable.date)}` : "", day(validUntil) ? `Válida até ${day(validUntil)}` : "",
        `${items.length} ${items.length === 1 ? "item" : "itens"}`].filter(Boolean) },
    erp_path: erpPath(type, id),
    ttl_minutes: ttlUntil(validUntil),
  };
}

/** Validade do link: até o fim do dia da validade da proposta, entre 1 hora e 7 dias. */
function ttlUntil(validUntil: string | null): number {
  const week = 7 * 24 * 60;
  if (!validUntil) return week;
  const end = Date.parse(`${validUntil}T23:59:59-03:00`);
  return Number.isFinite(end) ? Math.max(60, Math.min(week, Math.round((end - Date.now()) / 60000))) : week;
}

async function invoice(env: Env, profile: string, actor: Actor, id: string, xml: boolean, light: boolean): Promise<LoadedDocument> {
  const response = await nfe(env, profile, actor, `emissoes/${id}`);
  const emission = object(await response.json().catch(() => null));
  if (!response.ok) throw refusal(response.status, emission, "esta nota fiscal");
  if (emission.status !== "autorizada")
    throw new ApiError(409, "erp_invoice_not_authorized", "Só nota fiscal autorizada vai ao cliente. Esta ainda não foi autorizada (ou foi cancelada).");
  const homologation = emission.environment === "homologacao";
  const number = emission.number === null || emission.number === undefined ? "" : String(emission.number);
  const title = `Nota fiscal${number ? ` nº ${number}` : ""}${emission.series !== null && emission.series !== undefined ? ` (série ${emission.series})` : ""}`;
  // Cliente: o do pedido da nota (a mesma carteira e privacidade do pedido).
  let contact: Record<string, any> = {}, contactId: string | null = null;
  if (typeof emission.document_id === "string" && UUID.test(emission.document_id)) {
    try {
      const body = await erpGet(env, profile, actor, `/v1/documentos/sales_orders/${emission.document_id}`, "o pedido desta nota");
      contact = object(object(body.document).contact_snapshot);
      contactId = typeof body.document?.contact_id === "string" ? body.document.contact_id : null;
    } catch (error) {
      if (error instanceof ApiError && error.code === "erp_customer_restricted") throw error;
      // Papel fiscal sem acesso a pedidos: o destinatário gravado na emissão.
      const snapshot = object(object(emission.revision).snapshot);
      contact = object(snapshot.contact_snapshot ?? object(snapshot.document).contact_snapshot ?? snapshot.recipient);
      contactId = typeof contact.id === "string" ? contact.id : null;
    }
  }
  // Na prévia, só o nome: o arquivo vem do cofre no envio.
  const artifact = async (path: string, accept: string, what: string) => {
    if (light) return new Uint8Array(0);
    const file = await nfe(env, profile, actor, path, accept);
    if (!file.ok || file.status !== 200) throw refusal(file.status === 202 ? 409 : file.status, await file.json().catch(() => null), what);
    return new Uint8Array(await file.arrayBuffer());
  };
  const files: OutgoingFile[] = [{ name: `${safeName(`DANFE-${number || id.slice(0, 8)}`)}.pdf`, type: "application/pdf",
    bytes: await artifact(`emissoes/${id}/danfe`, "application/pdf", "o DANFE desta nota") }];
  if (xml) files.push({ name: `${safeName(`NF-e-${emission.access_key ?? number}`)}.xml`, type: "application/xml",
    bytes: await artifact(`emissoes/${id}/xml`, "application/xml", "o XML desta nota"), optional: "xml" });
  const total = typeof emission.total === "string" && /^\d+$/.test(emission.total) ? emission.total : null;
  const name = text(contact.name, 200);
  return {
    type: "nota", id, title, contact_id: contactId, customer_name: name, phones: phonesOf(contact), purpose: "order",
    facts: { type: "nota", label: `${title.charAt(0).toLowerCase()}${title.slice(1)}${homologation ? " (homologação, sem valor fiscal)" : ""}`, customer: name, total_cents: total, attachments: files.length },
    files,
    page: { title, status_label: homologation ? "Homologação, sem valor fiscal" : "Autorizada", headline: money(total) ? `Total: ${money(total)}` : null,
      lines: [typeof emission.access_key === "string" ? `Chave de acesso: ${emission.access_key}` : ""].filter(Boolean) },
    erp_path: erpPath("nota", id),
    ttl_minutes: 7 * 24 * 60,
  };
}

async function receivable(env: Env, profile: string, actor: Actor, id: string, pdv: boolean): Promise<LoadedDocument> {
  const body = await erpGet(env, profile, actor, `/v1/financeiro/titles/${id}/detalhe`, "esta conta a receber");
  const title = object(body.record);
  if (title.kind !== "receivable") throw new ApiError(404, "not_found", "Não achamos esta conta a receber no ERP.");
  if (title.cancelled === true || !["open", "partial"].includes(title.status))
    throw new ApiError(409, "erp_title_not_open", "Só conta a receber em aberto vai como cobrança. Esta já foi paga ou cancelada.");
  const balance = typeof title.balance_cents === "string" && /^\d+$/.test(title.balance_cents) ? title.balance_cents : null;
  const contactId = typeof title.contact_id === "string" ? title.contact_id : null;
  let contact: Record<string, any> = {};
  if (contactId) {
    try { const read = await erpGet(env, profile, actor, `/v1/cadastros/contacts/${contactId}`, "o cadastro do cliente"); contact = object(read.record ?? read.data ?? read); }
    catch (error) { if (error instanceof ApiError && error.code === "erp_customer_restricted") throw error; }
  }
  // Pix copia e cola: a chave Pix da área (Frente de caixa), com o valor em aberto.
  let pix: string | null = null;
  if (pdv && balance && balance !== "0") {
    try {
      const context = object(await erpGet(env, profile, actor, "/v1/frente-caixa", "a chave Pix"));
      const key = object(context.pix);
      if (typeof key.key === "string")
        pix = pixPayload({ keyType: key.key_type as PixKeyType, key: key.key, merchantName: key.merchant_name, merchantCity: key.merchant_city,
          amountCents: balance, reference: `T${id.replace(/-/g, "").slice(0, 20)}` });
    } catch { /* Sem a Frente de caixa ou sem papel nela: sem Pix. */ }
  }
  const installment = Number.isInteger(title.installment) && Number.isInteger(title.installments) && title.installments > 1 ? ` (parcela ${title.installment}/${title.installments})` : "";
  const description = `${text(title.description, 120) ?? "conta"}${installment}`;
  const name = text(title.contact_name, 200) ?? text(contact.name, 200);
  const label = `Cobrança: ${description}`;
  return {
    type: "conta", id, title: label, contact_id: contactId, customer_name: name, phones: phonesOf(contact), purpose: "billing",
    facts: { type: "conta", label: description, customer: name, total_cents: balance, due_on: text(title.due_on, 10), description, pix, attachments: 0 },
    files: [],
    page: { title: label, status_label: title.overdue === true ? "Vencida" : "Em aberto", headline: money(balance) ? `Valor: ${money(balance)}` : null,
      lines: [day(title.due_on) ? `Vencimento: ${day(title.due_on)}` : "", pix ? "Pague com o Pix copia e cola enviado na conversa." : ""].filter(Boolean) },
    erp_path: erpPath("conta", id),
    ttl_minutes: 7 * 24 * 60,
  };
}

/** Lê o documento como a pessoa; parte desligada e permissão já recusam aqui.
 * `light`: sem buscar no cofre os arquivos da nota (prévia e histórico); o tamanho fica 0. */
export async function loadDocument(env: Env, profile: string, actor: Actor, type: ErpConversaDocType, id: string,
  options: { xml?: boolean; parts: Readonly<Record<string, boolean>>; light?: boolean }): Promise<LoadedDocument> {
  if (!UUID.test(id)) throw new ApiError(400, "invalid_request", "Identificador do documento inválido.");
  const normalized = id.toLowerCase();
  if (type === "proposta" || type === "pedido") return salesDocument(env, profile, actor, type, normalized);
  if (type === "nota") return invoice(env, profile, actor, normalized, options.xml === true, options.light === true);
  return receivable(env, profile, actor, normalized, options.parts["erp-pdv"] === true);
}
