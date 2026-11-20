// ERP pela conversa: o que a rota (Worker) e o comando (Coordinator) dividem.
// Linhas de WhatsApp da área, telefones do cadastro, a conversa do número e
// a decisão de como o envio sai, sempre pelas regras que o atendimento já
// aplica (src/channels.ts, src/engine.ts: janela de 24 horas, modelo de
// aviso com consentimento, política da linha). Nada aqui contorna a janela.
import { all, one } from "../../db";
import { ApiError, json, type Actor, type Conversation, type Env } from "../../types";
import { numberPolicy } from "../../number-policy";
import { conversationByPhone, settings } from "../../service";
import { consentFor } from "../../consents";
import { contactPhones } from "../../customer/identity";
import { customerPhoneInputMode, customerPhoneVariants, normalizeCustomerPhone } from "../../customer/phone";
import { departmentFor } from "../../departments";
import { decideSend, deliveryState, DELIVERY_LABELS, formatPhone, sendSummary, type ConversationInfo, type Decision, type LineInfo, type OutboxState } from "./rules.ts";
import type { ErpConversaDocType } from "./contract.ts";

export interface SendRow {
  id: string; profile_id: string; doc_type: ErpConversaDocType; doc_id: string; doc_label: string; erp_contact_id: string | null;
  phone: string; outside_record: number; connection_id: string; conversation_id: string | null; actor: string; actor_name: string;
  via_bot: string | null; mode: string; media_ids: string; web_step_id: string | null; text: string; page: string; status: string; error: string | null;
  created: number; updated: number;
}

const LINES_SQL = `SELECT c.id,c.name,c.kind,c.account_label,c.config,
    EXISTS(SELECT 1 FROM meta_numbers m WHERE m.connection_id=c.id) managed
  FROM connections c WHERE c.profile_id=? AND c.status='active' AND c.kind IN ('zernio','qr')
    AND coalesce(c.channel,'whatsapp')='whatsapp' ORDER BY c.name,c.id`;

function lineOf(row: any): LineInfo {
  const config = json(row.config);
  const policy = numberPolicy(config);
  return { id: row.id, name: row.name || row.account_label || "WhatsApp", kind: row.kind, number: String(config.number || config.phone || ""),
    managed: !!row.managed, human: policy.human !== false, templates: policy.templates !== false };
}
/** Linhas de WhatsApp ativas da área (oficial e pelo QR). */
export async function whatsappLines(env: Env, profile: string): Promise<LineInfo[]> {
  return (await all(env, LINES_SQL, profile)).map(lineOf);
}
export async function whatsappLine(env: Env, profile: string, id: unknown): Promise<LineInfo> {
  const line = typeof id === "string" ? (await whatsappLines(env, profile)).find(item => item.id === id) : undefined;
  if (!line) throw new ApiError(404, "line_not_found", "Escolha uma linha de WhatsApp ativa desta área. Sem linha, conecte uma em Conexões.");
  return line;
}
export const lineView = (line: LineInfo) => ({
  id: line.id, nome: line.name, numero: line.number ? formatPhone(line.number.replace(/\D/g, "")) : null,
  tipo: line.kind === "qr" ? "qr" : "oficial", gerenciada: line.managed, permite_atendente: line.human,
});

/** Telefone digitado: dígitos com DDI (55 quando vem só com DDD). */
export function phoneInput(value: unknown): string {
  const phone = typeof value === "string" ? normalizeCustomerPhone(value, customerPhoneInputMode(value)) ?? normalizeCustomerPhone(value, "human_br") : null;
  if (!phone) throw new ApiError(400, "invalid_phone", "Telefone inválido: informe DDD e número (ex.: 11 98765-4321), ou + e o DDI fora do Brasil.");
  return phone;
}
export const samePhone = (a: string, b: string) => customerPhoneVariants(a).some(variant => customerPhoneVariants(b).includes(variant));

/** Telefones do cadastro: os do ERP e os da ficha do contato do atendimento. */
export async function recordPhones(env: Env, profile: string, contactId: string | null, erpPhones: readonly string[]): Promise<string[]> {
  const phones = [...erpPhones];
  if (contactId) {
    const rows = await all(env, `SELECT id,version,phone,mirror_json,identity_state,source,merged_into FROM contacts
      WHERE profile_id=? AND erp_contact_id=? AND namespace='team' AND identity_state='active'`, profile, contactId.toLowerCase());
    for (const row of rows) phones.push(...contactPhones(row as any));
  }
  const unique: string[] = [];
  for (const phone of phones) if (!unique.some(item => samePhone(item, phone))) unique.push(phone);
  return unique;
}

/** O cliente do documento está restrito pela privacidade de cadastro? */
export async function restrictedContact(env: Env, profile: string, contactId: string | null): Promise<boolean> {
  if (!contactId) return false;
  const row = await one(env, `SELECT 1 x FROM contacts WHERE profile_id=? AND erp_contact_id=?
    AND (identity_state<>'active' OR namespace<>'team') LIMIT 1`, profile, contactId.toLowerCase());
  return !!row;
}

/** A conversa individual com o número naquela linha, se existir (não abre). */
export async function lineConversation(env: Env, profile: string, phone: string, lineId: string): Promise<Conversation | null> {
  return conversationByPhone(env, profile, phone, { connectionId: lineId });
}
export const conversationInfo = (c: Conversation | null): ConversationInfo | null =>
  c ? { id: c.id, last_customer: Number(c.last_customer) || 0, owner: c.owner ?? null, state: String(c.state ?? "") } : null;

/** Quem envia pode escrever nesta conversa? Outro atendente com ela, ou setor de fora: não. */
export async function assertCanWrite(env: Env, actor: Actor, c: Conversation | null) {
  if (!c) return;
  if (c.owner && c.owner !== actor.id && actor.role !== "admin") {
    const owner = await one(env, "SELECT name FROM users WHERE id=?", c.owner);
    throw new ApiError(409, "already_claimed", `${owner?.name ?? "Outra pessoa"} está atendendo esta conversa. Peça a essa pessoa para enviar, ou para transferir a conversa a você.`);
  }
  if (c.department_id && actor.role !== "admin") {
    const department = await departmentFor(env, c.profile_id, c.department_id);
    if (!department?.members.includes(actor.id))
      throw new ApiError(403, "department_access_denied", "Esta conversa é de um setor do qual você não faz parte. Peça a alguém do setor para enviar.");
  }
}

/** Pelo bot: o número do cadastro, numa conversa com a identidade do cliente conferida. */
export async function assertBotRecipient(env: Env, profile: string, c: Conversation | null, contactId: string | null, inRecord: boolean) {
  if (!inRecord) throw new ApiError(403, "erp_conversa_bot_outside_record", "O bot só envia documento a um telefone do cadastro do cliente.");
  if (!c || !contactId || c.customer_link_state !== "ready" || !c.verified_phone)
    throw new ApiError(403, "erp_conversa_identity_required", "O bot só envia documento ao próprio cliente numa conversa com a identidade conferida. Envie pela tela do ERP.");
  const linked = await one(env, `SELECT 1 x FROM conversation_contacts cc JOIN contacts p ON p.id=cc.contact_id AND p.profile_id=cc.profile_id
    WHERE cc.profile_id=? AND cc.conversation_id=? AND p.erp_contact_id=? AND p.identity_state='active' AND p.namespace='team' LIMIT 1`, profile, c.id, contactId.toLowerCase());
  if (!linked || !samePhone(String(c.verified_phone), String(c.phone)))
    throw new ApiError(403, "erp_conversa_identity_required", "Esta conversa não é do cliente do documento (identidade não conferida). O bot não envia.");
}

/** Como o envio sai agora, para a prévia e para o comando. */
export async function decisionFor(env: Env, profile: string, line: LineInfo, c: Conversation | null, files: readonly { size: number }[], purpose: "order" | "billing", at: number): Promise<Decision> {
  const cfg = await settings(env, profile);
  const consent = c ? (await consentFor(env, c.id, purpose))?.status === "granted" : false;
  return decideSend({ line, conversation: conversationInfo(c), now: at, files, purpose, consent,
    notifications: { enabled: cfg.notifications?.enabled === true, template: typeof cfg.notifications?.template_name === "string" && cfg.notifications.template_name ? cfg.notifications.template_name : null } });
}

// ---------------------------------------------------------------------------
// Registro

async function outboxRows(env: Env, row: SendRow): Promise<OutboxState[]> {
  const keys = [`erp-conversa:${row.id}`, ...(row.web_step_id ? [`web-step:${row.web_step_id}`] : [])];
  return all(env, `SELECT o.status,o.error,m.delivery_status FROM outbox o
      LEFT JOIN messages m ON m.id='delivery:'||o.id
    WHERE o.profile_id=? AND (o.dedupe IN (SELECT value FROM json_each(?)) OR o.dedupe LIKE ? OR o.dedupe LIKE ?)`,
    row.profile_id, JSON.stringify(keys), `erp-conversa:${row.id}:%`, row.web_step_id ? `web-step:${row.web_step_id}:%` : "\u0000") as Promise<OutboxState[]>;
}

export async function sendView(env: Env, row: SendRow) {
  const delivery = deliveryState(row, await outboxRows(env, row));
  return {
    id: row.id, tipo: row.doc_type, documento: row.doc_id, titulo: row.doc_label, telefone: formatPhone(row.phone),
    fora_do_cadastro: !!row.outside_record, linha: row.connection_id, conversa: row.conversation_id, por: row.actor_name, pelo_bot: !!row.via_bot,
    modo: row.mode, enviado_em: row.created, resumo: sendSummary(row), estado: delivery.state, estado_rotulo: DELIVERY_LABELS[delivery.state],
    motivo: delivery.reason,
  };
}

export async function sendHistory(env: Env, profile: string, type: ErpConversaDocType, id: string) {
  const rows = await all<SendRow>(env, `SELECT * FROM erp_whatsapp_sends WHERE profile_id=? AND doc_type=? AND doc_id=? AND status<>'preparado'
    ORDER BY created DESC LIMIT 20`, profile, type, id.toLowerCase());
  return Promise.all(rows.map(row => sendView(env, row)));
}
