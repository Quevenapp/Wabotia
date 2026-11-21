// Canal de e-mail comum do ERP: a prévia (destinatário sugerido, cópias,
// assunto e texto do modelo das Preferências), o envio pelo e-mail da
// instalação (src/email.ts, o mesmo do pacote do contador), o registro de
// cada envio no documento, o reenvio e o envio automático da NF-e ao
// autorizar (preferência "Enviar e-Mail após emitir NF-e automaticamente",
// nasce desligada).
import { all, exec, one } from "../../db";
import { ApiError, now, uid, type Actor, type Env } from "../../types";
import { sha } from "../../security";
import { audit } from "../../events";
import { moduleStates } from "../../modules/registry";
import { erpPartOffMessage } from "../parts.ts";
import { erpCall, type ReceivablePayment } from "../conversa/documents.ts";
import { ERP_EMAIL_DOC_LABELS, ERP_EMAIL_PARTS, erpEmailRequirement, type ErpEmailDocType } from "./contract.ts";
import { companyContact, loadEmailDocument, type EmailDocument } from "./documents.ts";
import {
  CHARGE_CONTACT_KEY, DEFAULT_TEMPLATES, NFE_AUTO_KEY, STATE_LABELS, TEMPLATE_KEYS, TEMPLATE_VARIABLES, addressList, composeEmail,
  sendSummary, stateFromProvider, suggestRecipients, validAddress, type ContactChoice, type SendState, type TemplateValues,
} from "./templates.ts";

export const EMAIL_SETUP = "Gestão → Sistema → E-mail";
export const EMAIL_MISSING = `O e-mail desta instalação ainda não está configurado. O administrador configura em ${EMAIL_SETUP}; depois é só enviar de novo.`;

/** O e-mail da instalação está pronto? (Sem MASTER_KEY ou sem configuração: não.) */
export async function emailSituation(env: Env) {
  const { emailConfig, configured } = await import("../../email");
  try {
    const cfg = await emailConfig(env);
    if (configured(cfg)) return { configurado: true, remetente: cfg.from_address ?? null, nome: cfg.from_name ?? null, onde_configurar: null, aviso: null };
  } catch { /* Sem cofre: sem e-mail. */ }
  return { configurado: false, remetente: null, nome: null, onde_configurar: EMAIL_SETUP, aviso: EMAIL_MISSING };
}

/** A parte do ERP do documento está ligada? Desligada: 409 module_disabled e qual ligar. */
export async function requireEmailPart(env: Env, profile: string, type: ErpEmailDocType) {
  const states = await moduleStates(env, profile);
  const off = erpPartOffMessage(ERP_EMAIL_PARTS[type], erpEmailRequirement(type), states);
  if (off) throw new ApiError(409, "module_disabled", `${off} Sem ela, este documento não é enviado por e-mail.`);
  return states;
}

/** Valores de uma página de Preferências (como a pessoa); sem acesso ou sem resposta, vazio (valem os padrões). */
export async function preferenceValues(env: Env, profile: string, actor: Actor, page: string): Promise<Record<string, unknown>> {
  try {
    const body = await erpCall(env, profile, actor, "GET", `/v1/preferencias/${page}`, undefined, "as preferências");
    const items = Array.isArray(body?.items) ? body.items : [];
    return Object.fromEntries(items.filter((item: any) => typeof item?.key === "string").map((item: any) => [item.key, item.value]));
  } catch { return {}; }
}
const prefText = (prefs: Record<string, unknown>, key: string | null) => key && typeof prefs[key] === "string" && (prefs[key] as string).trim() ? (prefs[key] as string).trim() : null;

interface Setup {
  /** Modelo (texto com variáveis) do assunto e do corpo. */
  template: { subject: string; body: string };
  cc: string[];
  replyTo: string | null;
  fromName: string | null;
  values: TemplateValues;
  suggested: { to: string | null; cc: string[] };
}
async function setupFor(env: Env, profile: string, actor: Actor, doc: EmailDocument): Promise<Setup> {
  const keys = TEMPLATE_KEYS[doc.type];
  const [prefs, company] = await Promise.all([preferenceValues(env, profile, actor, keys.page), companyContact(env, profile, actor)]);
  const choice = doc.type === "conta" && ["principal", "nfe", "nfe_ou_principal"].includes(String(prefs[CHARGE_CONTACT_KEY])) ? prefs[CHARGE_CONTACT_KEY] as ContactChoice : null;
  const suggested = doc.contact ? suggestRecipients(doc.type, doc.contact, choice) : { to: null, cc: [] };
  const reply = addressList(prefText(prefs, keys.reply))[0] ?? (validAddress(company.email?.toLowerCase()) ? company.email!.toLowerCase() : null);
  return {
    template: { subject: prefText(prefs, keys.subject) ?? DEFAULT_TEMPLATES[doc.type].subject, body: prefText(prefs, keys.body) ?? DEFAULT_TEMPLATES[doc.type].body },
    cc: [...new Set([...suggested.cc, ...addressList(prefText(prefs, keys.cc))])],
    replyTo: reply, fromName: prefText(prefs, keys.sender)?.replace(/[\r\n<>"]/g, "").slice(0, 100) ?? company.name,
    values: { ...doc.values, empresa: company.name }, suggested,
  };
}

const files = (doc: EmailDocument) => doc.files.map(file => ({ nome: file.name, tipo: file.type, tamanho: file.bytes.byteLength || null }));

// ---------------------------------------------------------------------------
// Registro

export interface SendRow {
  id: string; profile_id: string; doc_type: string; doc_id: string; doc_label: string; erp_contact_id: string | null; to_address: string; cc: string;
  reply_to: string | null; from_name: string | null; subject: string; body: string; attachments: string; options: string; outside_record: number; auto: number;
  resend_of: string | null; actor: string; actor_name: string; via_bot: string | null; email_log_id: string | null; status: string; error: string | null;
  created: number; updated: number;
}
const parse = <T,>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };

export function sendView(row: SendRow) {
  const cc = parse<string[]>(row.cc, []);
  const state = (Object.hasOwn(STATE_LABELS, row.status) ? row.status : "enviando") as SendState;
  return {
    id: row.id, resumo: sendSummary({ to_address: row.to_address, cc_count: cc.length, actor_name: row.actor_name, created: row.created, auto: row.auto === 1,
      resend: !!row.resend_of, outside_record: row.outside_record === 1 }),
    para: row.to_address, copias: cc, assunto: row.subject, anexos: parse<unknown[]>(row.attachments, []),
    estado: state, estado_rotulo: STATE_LABELS[state], motivo: row.error, automatico: row.auto === 1, reenvio_de: row.resend_of, pelo_bot: !!row.via_bot,
    em: row.created,
  };
}

export async function sendHistory(env: Env, profile: string, type: ErpEmailDocType, id: string) {
  const rows = await all<SendRow>(env, "SELECT * FROM erp_email_sends WHERE profile_id=? AND doc_type=? AND doc_id=? ORDER BY created DESC LIMIT 30", profile, type, id.toLowerCase());
  return rows.map(sendView);
}

// ---------------------------------------------------------------------------
// Prévia

export async function prepareEmail(env: Env, profile: string, actor: Actor, type: ErpEmailDocType, id: string, payment: ReceivablePayment | null) {
  const parts = await requireEmailPart(env, profile, type);
  const doc = await loadEmailDocument(env, profile, actor, type, id, { parts, light: true, payment, xml: true });
  const setup = await setupFor(env, profile, actor, doc);
  const preview = composeEmail(type, setup.template, setup.values);
  return {
    documento: { tipo: type, id: doc.id, titulo: doc.title, cliente: doc.customer_name, rotulo: ERP_EMAIL_DOC_LABELS[type] },
    email: await emailSituation(env),
    para: setup.suggested.to, cadastro: doc.contact ? [...new Set([...addressList(doc.contact.email), ...addressList(doc.contact.nfe_email)])] : [],
    sem_email_no_cadastro: !setup.suggested.to
      ? doc.contact ? `O cadastro de ${doc.customer_name ?? "contato"} não tem e-mail${type === "nota" ? " (nem o de NF-e)" : ""}. Digite o endereço ou complete o cadastro.` : "Digite o endereço do destinatário."
      : null,
    copias: setup.cc, responder_para: setup.replyTo, remetente: setup.fromName,
    modelo: { assunto: setup.template.subject, mensagem: setup.template.body, variaveis: TEMPLATE_VARIABLES.map(name => `{${name}}`) },
    previa: { assunto: preview.subject, mensagem: preview.body },
    anexos: files(doc), xml_opcional: doc.xml_optional, pagamento: doc.payment ?? null,
    envios: await sendHistory(env, profile, type, doc.id),
  };
}

// ---------------------------------------------------------------------------
// Envio

interface SendInput {
  to: string; cc: string[];
  /** Modelo (com variáveis) escolhido pela pessoa; null: o das Preferências. */
  subject: string | null; body: string | null;
  xml: boolean; payment: ReceivablePayment | null;
}

function bodyInput(body: Record<string, unknown>): SendInput {
  const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
  const to = typeof body.para === "string" ? body.para.trim().toLowerCase() : "";
  if (!validAddress(to)) bad("E-mail do destinatário inválido. Confira o endereço (ex.: cliente@empresa.com.br).");
  if (body.copias !== undefined && (!Array.isArray(body.copias) || body.copias.length > 5 || body.copias.some(item => !validAddress(typeof item === "string" ? item.trim().toLowerCase() : null))))
    bad("Cópias: até 5 e-mails válidos.");
  const cc = [...new Set(((body.copias as string[] | undefined) ?? []).map(item => item.trim().toLowerCase()))].filter(item => item !== to);
  const textField = (key: string, max: number, label: string) => {
    const value = body[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > max) bad(`${label}: até ${max} caracteres.`);
    return (value as string).trim() || null;
  };
  if (body.xml !== undefined && typeof body.xml !== "boolean") bad("xml: use verdadeiro ou falso.");
  const payment = body.pagamento === undefined || body.pagamento === null ? null : String(body.pagamento);
  if (payment !== null && !["pix", "link", "boleto", "sem"].includes(payment)) bad("pagamento: use pix, link, boleto ou sem.");
  return { to, cc, subject: textField("assunto", 200, "Assunto"), body: textField("mensagem", 20000, "Mensagem"), xml: body.xml === true, payment: payment as ReceivablePayment | null };
}

async function assertReady(env: Env, profile: string) {
  if (!(await emailSituation(env)).configurado) throw new ApiError(409, "email_unavailable", EMAIL_MISSING);
  const { areaEmailCount, EMAIL_AREA_DAILY } = await import("../../email");
  if (await areaEmailCount(env, profile) >= EMAIL_AREA_DAILY)
    throw new ApiError(429, "email_area_limit", `A área já enviou ${EMAIL_AREA_DAILY} e-mails nas últimas 24 horas, o limite da instalação. Tente de novo amanhã.`);
}

/** Grava o envio e manda pelo provedor; a falha fica no registro (e volta como erro). */
async function deliver(env: Env, actor: Actor, profile: string, row: Omit<SendRow, "status" | "error" | "email_log_id" | "created" | "updated">,
  doc: EmailDocument, options: { auto: boolean }): Promise<SendRow> {
  const at = now();
  const inserted = await exec(env, `INSERT OR IGNORE INTO erp_email_sends(id,profile_id,doc_type,doc_id,doc_label,erp_contact_id,to_address,cc,reply_to,from_name,subject,body,
      attachments,options,outside_record,auto,resend_of,actor,actor_name,via_bot,email_log_id,status,error,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'enviando',NULL,?,?)`,
  row.id, profile, row.doc_type, row.doc_id, row.doc_label, row.erp_contact_id, row.to_address, row.cc, row.reply_to, row.from_name, row.subject, row.body,
  row.attachments, row.options, row.outside_record, row.auto, row.resend_of, row.actor, row.actor_name, row.via_bot, at, at);
  if (!inserted.meta?.changes) return (await one<SendRow>(env, "SELECT * FROM erp_email_sends WHERE id=?", row.id))!;
  const { sendEmail } = await import("../../email");
  try {
    const result = await sendEmail(env, {
      to: row.to_address, subject: row.subject, text: row.body, cc: parse<string[]>(row.cc, []),
      ...(row.reply_to ? { replyTo: row.reply_to } : {}), ...(row.from_name ? { fromName: row.from_name } : {}),
      attachments: doc.files.map(file => ({ name: file.name, type: file.type, bytes: file.bytes })),
    }, { purpose: `erp.email.${row.doc_type}`, profileId: profile, moduleId: ERP_EMAIL_PARTS[row.doc_type as ErpEmailDocType], userId: actor.id, key: `erp-email:${row.id}` });
    await exec(env, "UPDATE erp_email_sends SET status=?,email_log_id=?,updated=? WHERE id=?", stateFromProvider(String(result.status)), result.id, now(), row.id);
    if (!options.auto || actor.kind === "user")
      await audit(env, actor, profile, "erp_email.send", `${row.doc_type} ${row.doc_id}${options.auto ? " auto" : ""}`, uid()).catch(() => {});
  } catch (error) {
    const reason = error instanceof ApiError ? error.message : "O e-mail não saiu. Tente de novo.";
    await exec(env, "UPDATE erp_email_sends SET status='falhou',error=?,updated=? WHERE id=?", reason.slice(0, 500), now(), row.id);
    await audit(env, actor, profile, "erp_email.send_failed", `${row.doc_type} ${row.doc_id}`, uid()).catch(() => {});
    throw error;
  }
  return (await one<SendRow>(env, "SELECT * FROM erp_email_sends WHERE id=?", row.id))!;
}

const attachmentsJson = (doc: EmailDocument) => JSON.stringify(doc.files.map(file => ({ nome: file.name, tipo: file.type, tamanho: file.bytes.byteLength })));

/** POST …/:tipo/:id/enviar. `key`: Idempotency-Key (a mesma chave não envia duas vezes). */
export async function sendDocumentEmail(env: Env, profile: string, actor: Actor, type: ErpEmailDocType, id: string, body: Record<string, unknown>, key: string) {
  const input = bodyInput(body);
  const sendId = (await sha(`erp-email:${actor.id}:${profile}:${key}`)).slice(0, 32);
  const previous = await one<SendRow>(env, "SELECT * FROM erp_email_sends WHERE id=? AND profile_id=?", sendId, profile);
  if (previous) return { envio: sendView(previous), repetido: true };
  await assertReady(env, profile);
  const parts = await requireEmailPart(env, profile, type);
  const doc = await loadEmailDocument(env, profile, actor, type, id, { parts, xml: input.xml, payment: input.payment });
  const record = doc.contact ? new Set([...addressList(doc.contact.email), ...addressList(doc.contact.nfe_email)]) : new Set<string>();
  const setup = await setupFor(env, profile, actor, doc);
  if (actor.via) {
    // Pelo bot: só aos e-mails do cadastro e às cópias das Preferências (a pessoa confirmou a proposta).
    if (!record.has(input.to)) throw new ApiError(403, "erp_email_bot_outside_record", "O bot só envia documento a um e-mail do cadastro do cliente ou fornecedor. Envie pela tela do ERP.");
    if (input.cc.some(item => !record.has(item) && !setup.cc.includes(item)))
      throw new ApiError(403, "erp_email_bot_outside_record", "O bot só copia e-mails do cadastro ou das Preferências. Envie pela tela do ERP.");
  }
  const composed = composeEmail(type, { subject: input.subject ?? setup.template.subject, body: input.body ?? setup.template.body }, setup.values);
  const sent = await deliver(env, actor, profile, {
    id: sendId, profile_id: profile, doc_type: type, doc_id: doc.id, doc_label: doc.title, erp_contact_id: doc.contact_id?.toLowerCase() ?? null,
    to_address: input.to, cc: JSON.stringify(input.cc), reply_to: setup.replyTo, from_name: setup.fromName, subject: composed.subject, body: composed.body,
    attachments: attachmentsJson(doc), options: JSON.stringify({ xml: input.xml, ...(doc.payment ? { pagamento: doc.payment.escolha } : {}) }),
    outside_record: record.has(input.to) ? 0 : 1, auto: 0, resend_of: null, actor: actor.id, actor_name: actor.name || actor.id, via_bot: actor.via?.bot_id ?? null,
  }, doc, { auto: false });
  return { envio: sendView(sent), repetido: false };
}

/** POST …/:tipo/:id/envios/:envio/reenviar: os mesmos destinatários, assunto e texto; os anexos lidos de novo. */
export async function resendDocumentEmail(env: Env, profile: string, actor: Actor, type: ErpEmailDocType, id: string, sendRef: string, key: string) {
  const original = await one<SendRow>(env, "SELECT * FROM erp_email_sends WHERE id=? AND profile_id=? AND doc_type=? AND doc_id=?", sendRef, profile, type, id.toLowerCase());
  if (!original) throw new ApiError(404, "not_found", "Não achamos este envio no registro do documento.");
  const sendId = (await sha(`erp-email:resend:${actor.id}:${profile}:${key}`)).slice(0, 32);
  const previous = await one<SendRow>(env, "SELECT * FROM erp_email_sends WHERE id=? AND profile_id=?", sendId, profile);
  if (previous) return { envio: sendView(previous), repetido: true };
  await assertReady(env, profile);
  const parts = await requireEmailPart(env, profile, type);
  const options = parse<{ xml?: boolean; pagamento?: ReceivablePayment }>(original.options, {});
  const doc = await loadEmailDocument(env, profile, actor, type, id, { parts, xml: options.xml === true, payment: options.pagamento ?? null });
  if (!original.to_address || !validAddress(original.to_address)) throw new ApiError(409, "erp_email_no_recipient", "Este envio não tem destinatário para repetir. Use Enviar por e-mail.");
  const sent = await deliver(env, actor, profile, {
    ...original, id: sendId, doc_label: doc.title, attachments: attachmentsJson(doc), auto: 0, resend_of: original.id,
    actor: actor.id, actor_name: actor.name || actor.id, via_bot: actor.via?.bot_id ?? null,
  }, doc, { auto: false });
  return { envio: sendView(sent), repetido: false };
}

/**
 * Envio automático da NF-e ao destinatário (e às cópias das Preferências) ao autorizar, com a preferência
 * "Enviar e-Mail após emitir NF-e automaticamente" ligada (nasce desligada). Uma vez por nota; nunca derruba a
 * emissão: o que não sai fica no registro da nota com o motivo. `actor`: quem emitiu.
 */
export async function autoSendInvoiceEmail(env: Env, profile: string, actor: Actor, emissionId: string): Promise<SendRow | null> {
  try {
    const states = await moduleStates(env, profile);
    if (erpPartOffMessage("erp-fiscal", erpEmailRequirement("nota"), states)) return null;
    const prefs = await preferenceValues(env, profile, actor, TEMPLATE_KEYS.nota.page);
    if (prefs[NFE_AUTO_KEY] !== true) return null;
    const id = emissionId.toLowerCase();
    if (await one(env, "SELECT id FROM erp_email_sends WHERE profile_id=? AND doc_type='nota' AND doc_id=? AND auto=1", profile, id)) return null;
    const sendId = (await sha(`erp-email:auto:${profile}:${id}`)).slice(0, 32);
    const failed = async (label: string, reason: string) => {
      const at = now();
      await exec(env, `INSERT OR IGNORE INTO erp_email_sends(id,profile_id,doc_type,doc_id,doc_label,to_address,subject,body,auto,actor,actor_name,status,error,created,updated)
        VALUES(?,?,'nota',?,?,'',?,'',1,?,?,'falhou',?,?,?)`, sendId, profile, id, label, label, actor.id, actor.name || actor.id, reason.slice(0, 500), at, at);
      return one<SendRow>(env, "SELECT * FROM erp_email_sends WHERE id=?", sendId);
    };
    if (!(await emailSituation(env)).configurado) return failed("Nota fiscal", EMAIL_MISSING);
    let doc: EmailDocument;
    try { doc = await loadEmailDocument(env, profile, actor, "nota", id, { parts: states, xml: true }); }
    catch (error) { return failed("Nota fiscal", error instanceof ApiError ? error.message : "Não deu para ler a nota para o envio automático."); }
    const setup = await setupFor(env, profile, actor, doc);
    if (!setup.suggested.to) return failed(doc.title, "O cadastro do cliente não tem e-mail para NF-e nem e-mail principal. Complete o cadastro e use Enviar por e-mail na nota.");
    const composed = composeEmail("nota", setup.template, setup.values);
    try {
      return await deliver(env, actor, profile, {
        id: sendId, profile_id: profile, doc_type: "nota", doc_id: doc.id, doc_label: doc.title, erp_contact_id: doc.contact_id?.toLowerCase() ?? null,
        to_address: setup.suggested.to, cc: JSON.stringify(setup.cc.filter(item => item !== setup.suggested.to)), reply_to: setup.replyTo, from_name: setup.fromName,
        subject: composed.subject, body: composed.body, attachments: attachmentsJson(doc), options: JSON.stringify({ xml: true }), outside_record: 0, auto: 1,
        resend_of: null, actor: actor.id, actor_name: actor.name || actor.id, via_bot: null,
      }, doc, { auto: true });
    } catch { return one<SendRow>(env, "SELECT * FROM erp_email_sends WHERE id=?", sendId); }
  } catch { return null; }
}
