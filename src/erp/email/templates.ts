// Regras puras do e-mail de documentos do ERP: o modelo de cada tipo (o das
// Preferências ou o padrão), as variáveis {cliente}, {numero}, {valor},
// {vencimento}, {link} e {empresa}, o destinatário sugerido pelo cadastro e o
// resumo do registro "Enviado por e-mail a … por … em …". Sem banco e sem
// rede: os testes do Node importam este arquivo (só sintaxe TypeScript apagável).
import type { ErpEmailDocType } from "./contract.ts";

/** Página de Preferências e chaves do modelo de cada tipo (packages/erp-domain/src/preferences/pages). */
export interface TemplateKeys {
  page: string;
  subject: string | null;
  body: string | null;
  cc: string | null;
  sender: string | null;
  reply: string | null;
}
const block = (page: string, prefix: string): TemplateKeys => ({ page, subject: `${prefix}.email_assunto`, body: `${prefix}.email_mensagem`,
  cc: `${prefix}.email_copia`, sender: `${prefix}.email_remetente`, reply: `${prefix}.email_resposta` });
export const TEMPLATE_KEYS: Readonly<Record<ErpEmailDocType, TemplateKeys>> = Object.freeze({
  proposta: block("vendas-propostas", "propostas"),
  pedido: block("vendas-vendas", "vendas"),
  compra: block("suprimentos-compras", "compras"),
  nota: block("notas-nfe", "nfe"),
  // A NFC-e não tem modelo próprio: assunto e texto padrão, remetente e resposta os da NF-e.
  nfce: { page: "notas-nfe", subject: null, body: null, cc: null, sender: "nfe.email_remetente", reply: "nfe.email_resposta" },
  conta: { page: "financas-receber", subject: "financas.cobranca_boleto_assunto", body: "financas.cobranca_boleto_mensagem",
    cc: "financas.cobranca_email_copia", sender: "financas.cobranca_remetente", reply: "financas.cobranca_email_resposta" },
});
/** Preferência "Enviar e-Mail após emitir NF-e automaticamente" (nasce desligada). */
export const NFE_AUTO_KEY = "nfe.email_automatico";
/** Preferência "E-mail do contato" da cobrança: principal, nfe ou nfe_ou_principal. */
export const CHARGE_CONTACT_KEY = "financas.cobranca_email_contato";

export const DEFAULT_TEMPLATES: Readonly<Record<ErpEmailDocType, { subject: string; body: string }>> = Object.freeze({
  proposta: { subject: "Proposta comercial nº {numero} - {empresa}",
    body: "Olá, {cliente}!\n\nSegue em anexo a proposta comercial nº {numero}, no valor de {valor}, válida até {vencimento}.\n\nQualquer dúvida, é só responder este e-mail.\n\n{empresa}" },
  pedido: { subject: "Pedido de venda nº {numero} - {empresa}",
    body: "Olá, {cliente}!\n\nSegue em anexo o seu pedido de venda nº {numero}, no valor de {valor}.\n\nQualquer dúvida, é só responder este e-mail.\n\n{empresa}" },
  compra: { subject: "Pedido de compra nº {numero} - {empresa}",
    body: "Olá, {cliente}!\n\nSegue em anexo o nosso pedido de compra nº {numero}, no valor de {valor}. Por favor, confirme o recebimento e o prazo de entrega.\n\n{empresa}" },
  nota: { subject: "Nota fiscal nº {numero} - {empresa}",
    body: "Olá, {cliente}!\n\nSegue em anexo a nota fiscal eletrônica nº {numero}, no valor de {valor}: o DANFE (PDF) e o arquivo XML, que deve ser guardado.\n\n{empresa}" },
  nfce: { subject: "Cupom fiscal (NFC-e) nº {numero} - {empresa}",
    body: "Olá, {cliente}!\n\nSegue em anexo o cupom fiscal (NFC-e) nº {numero} da sua compra, no valor de {valor}.\n\n{empresa}" },
  conta: { subject: "Cobrança: {numero} - vencimento {vencimento}",
    body: "Olá, {cliente}!\n\nSegue a cobrança de {numero}, no valor de {valor}, com vencimento em {vencimento}.\n\n{link}\n\nSe já pagou, desconsidere este e-mail.\n\n{empresa}" },
});

export const TEMPLATE_VARIABLES = ["cliente", "numero", "valor", "vencimento", "link", "empresa"] as const;
export type TemplateVariable = typeof TEMPLATE_VARIABLES[number];
export type TemplateValues = Partial<Record<TemplateVariable, string | null>>;

/** Troca {variavel} (ou {{variavel}}, sem diferença de maiúsculas e acentos) pelo valor; variável desconhecida fica como está. */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{\{?\s*([A-Za-zÀ-ú_]+)\s*\}?\}/g, (whole, name: string) => {
    const key = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() as TemplateVariable;
    return (TEMPLATE_VARIABLES as readonly string[]).includes(key) ? values[key] ?? "" : whole;
  });
}

/** Linhas que só tinham variável vazia somem; três ou mais quebras viram duas. */
export function tidyBody(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Assunto numa linha, sem endereço de link (o provedor recusa link e código no assunto) e até 200 caracteres. */
export function tidySubject(text: string): string {
  return Array.from(text.replace(/[\r\n\t]+/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").replace(/\s+-\s*$/, "").trim()).slice(0, 200).join("");
}

export function composeEmail(type: ErpEmailDocType, prefs: { subject?: string | null; body?: string | null }, values: TemplateValues): { subject: string; body: string } {
  const fallback = DEFAULT_TEMPLATES[type];
  const subjectTemplate = prefs.subject?.trim() ? prefs.subject : fallback.subject;
  const bodyTemplate = prefs.body?.trim() ? prefs.body : fallback.body;
  // No assunto, o link não vai (o provedor recusa).
  const subject = tidySubject(renderTemplate(subjectTemplate!, { ...values, link: "" }));
  let body = tidyBody(renderTemplate(bodyTemplate!, values));
  // Modelo das Preferências sem {link}: o meio de pagar da cobrança vai no fim, para não se perder.
  if (values.link && !body.includes(values.link)) body = `${body}\n\n${values.link}`;
  return { subject: subject || tidySubject(renderTemplate(fallback.subject, { ...values, link: "" })), body };
}

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
export const validAddress = (value: unknown): value is string => typeof value === "string" && value.length <= 254 && EMAIL.test(value);

/** Endereços de um campo do cadastro ou das Preferências ("a@x.com, b@y.com"), válidos, minúsculos e sem repetição. */
export function addressList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/[\s,;]+/).map(item => item.trim().toLowerCase()).filter(validAddress))];
}

export type ContactChoice = "principal" | "nfe" | "nfe_ou_principal";
/**
 * Destinatário sugerido pelo cadastro: nas notas, o "E-mail para envio da NFe" (ou o principal); na cobrança, o que as
 * Preferências do Contas a receber mandam; nos demais, o principal (ou o de NF-e). Os outros endereços do campo vão em cópia.
 */
export function suggestRecipients(type: ErpEmailDocType, contact: { email?: unknown; nfe_email?: unknown }, choice: ContactChoice | null = null): { to: string | null; cc: string[] } {
  const main = addressList(contact.email), nfe = addressList(contact.nfe_email);
  const order = type === "nota" || type === "nfce" ? [nfe, main]
    : type === "conta" ? (choice === "nfe" ? [nfe] : choice === "nfe_ou_principal" ? [nfe, main] : [main])
    : [main, nfe];
  const chosen = order.find(list => list.length) ?? [];
  return { to: chosen[0] ?? null, cc: chosen.slice(1) };
}

/** "Ma***@exemplo.com.br" para o registro na tela de quem não enviou. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  const user = address.slice(0, at);
  return `${user.slice(0, Math.min(2, Math.max(1, user.length - 1)))}***${address.slice(at)}`;
}

export type SendState = "enviando" | "enviado" | "na_fila" | "devolvido" | "falhou";
export const STATE_LABELS: Readonly<Record<SendState, string>> = Object.freeze({
  enviando: "Enviando", enviado: "Enviado", na_fila: "Na fila do provedor", devolvido: "Devolvido (endereço não existe ou recusou)", falhou: "Falhou",
});
/** Situação do provedor (src/email.ts) para a do registro. */
export function stateFromProvider(status: string): SendState {
  return status === "sent" ? "enviado" : status === "queued" ? "na_fila" : status === "bounced" ? "devolvido" : status === "failed" ? "falhou" : "enviando";
}

export function when(at: number): string {
  const date = new Date(at - 3 * 3600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)} às ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** "Enviado por e-mail a maria@x.com (e 2 cópias) por Ana em 03/11 às 14:20". */
export function sendSummary(record: { to_address: string; cc_count: number; actor_name: string; created: number; auto: boolean; resend: boolean; outside_record: boolean }): string {
  const copies = record.cc_count ? ` (e ${record.cc_count} ${record.cc_count === 1 ? "cópia" : "cópias"})` : "";
  const outside = record.outside_record ? " (endereço fora do cadastro)" : "";
  const who = record.auto ? "automaticamente, ao autorizar a nota," : `por ${record.actor_name}`;
  return `${record.resend ? "Reenviado" : "Enviado"} por e-mail a ${record.to_address}${outside}${copies} ${who} em ${when(record.created)}`;
}
