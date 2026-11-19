import { all, one } from "./db";
import { resolveCustomer } from "./customer/ports";
import { legacyHistoryProof, sessionRecords } from "./customer/history";
import { customerPhoneVariants, normalizeCustomerPhone } from "./customer/phone";
import { type Conversation, type Env, requireValue, now } from "./types";
import { enqueue, settings } from "./service";
import { formatBrasilia } from "./business-time";
import {
  isActiveTicket,
  ticketCustomerLabels,
  categoryName,
} from "./protocols";

// Protocolos antigos: WA-MWEQ9Z2Z-A185. A partir da 0.19.0: só dígitos, em
// sequência (10001, 10002...).
const PROTOCOL = /\bWA-[A-Z0-9]+-[A-Z0-9]{4}\b/i;

/** Número de protocolo citado na mensagem. Uma mensagem curta que é só o
 * número também vale com espaços, pontos ou traços digitados no meio
 * ("wa-mweq9z2z-a 185", "10.001"), como acontece ao copiar ou ditar o número.
 * Só dígitos valem quando são a mensagem inteira, com "protocolo" ou "#" na
 * frente se o cliente quiser: um número no meio de uma frase pode ser outra
 * coisa (pedido, valor). */
export function protocolNumber(value: string) {
  const text = String(value || "");
  const found =
    text.match(PROTOCOL)?.[0] ||
    (text.length <= 40
      ? compactProtocol(text).match(
          new RegExp(`^${PROTOCOL.source}$`, "i"),
        )?.[0] || numericProtocol(text)
      : undefined);
  return found?.toUpperCase();
}

/** Número só de dígitos: pode ser também um número de pedido ou de cliente,
 * então quem consulta confere se esse protocolo existe para o cliente. */
export const isNumericProtocol = (number?: string) =>
  !!number && /^\d+$/.test(number);

/** A mensagem inteira é um número de protocolo (com a mesma tolerância). */
export function isOnlyProtocolNumber(value: string) {
  const number = protocolNumber(value);
  return (
    !!number &&
    (isNumericProtocol(number)
      ? numericProtocol(value) === number
      : compactProtocol(value).toUpperCase() === number)
  );
}

function numericProtocol(value: string) {
  const digits = String(value || "")
    .trim()
    .replace(/^(?:o\s+)?(?:meu\s+)?(?:protocolo|n[ºo°.]*|#)\s*[:#]?\s*/i, "")
    .replace(/[\s.\-]+/g, "");
  // 5 to 9 digits: menu options are shorter and phone numbers longer.
  return /^\d{5,9}$/.test(digits) ? digits : undefined;
}

function compactProtocol(value: string) {
  // Separadores dentro de cada parte somem; os traços entre as partes ficam.
  return String(value || "")
    .trim()
    .replace(/[\s.]+/g, "")
    .replace(/[–—_]/g, "-");
}

// Only provider-authenticated identities may join conversations. A phone supplied
// by an API application is not evidence that the caller owns that WhatsApp number.
export function verifiedPhone(c: Conversation) {
  if (
    c.chat_type === "group" ||
    (c.channel != null && c.channel !== "whatsapp") ||
    ["blocked", "excluded", "ambiguous"].includes(c.customer_link_state || "") ||
    !c.connection_id ||
    c.external_namespace !== `channel:${c.connection_id}`
  )
    return null;
  const phone = normalizeCustomerPhone(c.phone, "international");
  // Uma correção do telefone invalida a prova anterior. Legado de canal já
  // autenticado continua legível mesmo antes do preenchimento cadastral.
  if (c.verified_phone && c.verified_phone !== phone) return null;
  if (/@(?:lid|g\.us)$/.test(c.external_id) && !c.verified_phone) return null;
  return phone;
}

export async function lookupProtocols(
  env: Env,
  c: Conversation,
  number?: string,
) {
  requireValue(
    c.chat_type !== "group",
    "Consulte protocolos em uma conversa individual.",
  );
  requireValue(
    number === undefined || typeof number === "string",
    "Informe o número completo do protocolo.",
  );
  const query = number ? protocolNumber(number) : undefined;
  requireValue(
    !number || isOnlyProtocolNumber(number),
    "Informe o número completo do protocolo, como 10001.",
  );
  const current = await one<Conversation>(env, "SELECT * FROM conversations WHERE profile_id=? AND id=?", c.profile_id, c.id);
  if (!current || ["blocked", "excluded", "ambiguous"].includes(current.customer_link_state ?? "pending")) return [];
  // E-mail agrupa remetentes operacionalmente; nem a própria conversa prova uma pessoa.
  if (current.channel === "email" || current.channel === "googlebusiness" || current.chat_type === "comment" ||
      JSON.parse(current.channel_context || "{}").context === "comment") return [];
  const customer = await resolveCustomer(env, current);
  if (customer.profileId !== c.profile_id || customer.namespace !== (current.external_namespace.startsWith("app:") ? current.external_namespace : "team")) return [];
  if (["blocked", "excluded", "ambiguous"].includes(customer.state)) return [];
  const contactId = customer.state === "ready" ? customer.contactId : null;
  // A ficha juntada é apenas propriedade cadastral. A consulta do cliente
  // conserva a origem comprovada, inclusive as variantes telefônicas legadas.
  const phone = current.verified_phone && verifiedPhone(current);
  const phones = phone ? customerPhoneVariants(phone) : [];
  const social = current.channel != null && current.channel !== "whatsapp";
  // O ramo WhatsApp não consulta a tabela de identidades sociais.
  const origin = social ? `EXISTS(SELECT 1 FROM customer_channel_ids i
    WHERE i.profile_id=v.profile_id AND i.namespace=? AND i.state='ready' AND i.proof_conversation_id IS NOT NULL
      AND i.id=v.channel_identity_id AND i.id=original.channel_identity_id
      AND i.channel=v.channel AND i.channel=original.channel AND i.channel IN ('instagram','facebook','telegram','tiktok')
      AND i.account_id=v.channel_account_id AND i.account_id=original.channel_account_id
      AND i.subject_namespace=${current.channel === "telegram" ? "'telegram-user'" : "'dm'"} AND i.subject_id=v.channel_subject_id AND i.subject_id=original.channel_subject_id
      AND v.external_namespace='channel:'||v.connection_id AND original.external_namespace='channel:'||original.connection_id)`
    : `((v.channel IS NULL OR v.channel='whatsapp') AND (original.channel IS NULL OR original.channel='whatsapp')
      AND v.verified_phone=v.phone AND original.verified_phone=original.phone
      AND original.verified_phone IN (SELECT value FROM json_each(?))
      AND EXISTS(SELECT 1 FROM connections vc JOIN connections oc ON oc.id=original.connection_id AND oc.profile_id=original.profile_id
        WHERE vc.id=v.connection_id AND vc.profile_id=v.profile_id AND vc.kind IN ('meta','qr','zernio') AND oc.kind IN ('meta','qr','zernio')
          AND vc.channel='whatsapp' AND oc.channel='whatsapp'
          AND v.external_namespace='channel:'||vc.id AND original.external_namespace='channel:'||oc.id))`;
  // The same response is returned for a nonexistent number and somebody else's
  // number. Public updates only; internal notes and operator IDs are never sent.
  return all(
    env,
    `WITH sessions AS (${sessionRecords}), viewer AS (
       SELECT v.*,coalesce(?,CASE WHEN ? THEN s.contact_id END) history_contact FROM conversations v
       LEFT JOIN sessions s ON s.profile_id=v.profile_id AND s.record_id=v.id||':'||v.session AND s.valid
       WHERE v.profile_id=? AND v.id=?
         AND NOT EXISTS(SELECT 1 FROM conversation_contacts l JOIN contacts k ON k.id=l.contact_id AND k.profile_id=l.profile_id
           WHERE l.profile_id=v.profile_id AND l.conversation_id=v.id AND (k.identity_state<>'active' OR (s.contact_id IS NOT NULL AND l.contact_id<>s.contact_id)))
         AND NOT EXISTS(SELECT 1 FROM sessions x WHERE x.profile_id=v.profile_id AND x.record_id=v.id||':'||v.session AND NOT x.valid)
     ) SELECT t.number,t.title,t.status,t.category,t.response_due_at,t.first_response_at,t.created,t.updated,
      (SELECT u.text FROM ticket_updates u WHERE u.ticket_id=t.id AND u.internal=0 ORDER BY u.created DESC,u.rowid DESC LIMIT 1) latest_update
     FROM tickets t JOIN conversations original ON original.id=t.conversation_id CROSS JOIN viewer v
     WHERE t.profile_id=? AND original.profile_id=? AND original.chat_type!='group'
       AND original.customer_link_state NOT IN ('blocked','excluded','ambiguous')
       AND (original.id=v.id OR ${origin})
       AND (EXISTS(
         SELECT 1 FROM customer_records r JOIN contacts k
           ON k.id=r.contact_id AND k.profile_id=r.profile_id AND k.namespace=? AND k.identity_state='active'
         WHERE r.profile_id=t.profile_id AND r.module_id='tickets' AND r.kind='ticket' AND r.record_id=t.id
           AND r.conversation_id=t.conversation_id AND r.contact_id=v.history_contact)
         OR (NOT EXISTS(SELECT 1 FROM customer_records r WHERE r.profile_id=t.profile_id AND r.module_id='tickets' AND r.kind='ticket' AND r.record_id=t.id)
           AND original.customer_link_state NOT IN ('blocked','excluded','ambiguous')
           AND (EXISTS(SELECT 1 FROM sessions s JOIN contacts k ON k.id=s.contact_id AND k.profile_id=s.profile_id AND k.identity_state='active' AND k.namespace=?
             WHERE s.profile_id=t.profile_id AND s.conversation_id=original.id AND s.valid AND s.contact_id=v.history_contact AND s.occurred_at<=t.created
               AND NOT EXISTS(SELECT 1 FROM sessions later WHERE later.profile_id=s.profile_id AND later.conversation_id=s.conversation_id AND later.occurred_at<=t.created AND (later.occurred_at>s.occurred_at OR (later.occurred_at=s.occurred_at AND later.contact_id<>s.contact_id) OR NOT later.valid)))
             OR ((original.id=v.id OR EXISTS(SELECT 1 FROM conversation_contacts l WHERE l.profile_id=original.profile_id AND l.conversation_id=original.id AND l.contact_id=v.history_contact AND l.created<=t.created))
               AND ${legacyHistoryProof("original", "t.created", false)}
               AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.profile_id=original.profile_id AND s.conversation_id=original.id AND s.occurred_at<=t.created)))))
       AND (? IS NULL OR upper(t.number)=?)
     ORDER BY t.created DESC,t.id DESC LIMIT 10`,
    contactId,
    current.verified_phone && verifiedPhone(current) ? 1 : 0,
    c.profile_id,
    c.id,
    c.profile_id,
    c.profile_id,
    social ? customer.namespace : JSON.stringify(phones),
    customer.namespace,
    customer.namespace,
    query || null,
    query || null,
  );
}

export function protocolSummary(
  tickets: any[],
  requested = false,
  config: any = {},
) {
  if (!tickets.length)
    return requested
      ? "Não encontramos esse protocolo vinculado ao seu atendimento ou cadastro. Confira o número completo ou peça ajuda à equipe."
      : "Ainda não há protocolos vinculados ao seu atendimento ou cadastro. Para falar com a equipe, envie ATENDENTE.";
  return (
    tickets
      .map((ticket) => {
        // The first-response deadline only matters while the protocol is active.
        const due =
          ticket.response_due_at &&
          !ticket.first_response_at &&
          isActiveTicket(ticket.status);
        const category = categoryName(config, ticket.category);
        return `${ticket.number} · ${ticketCustomerLabels[ticket.status] || "Em acompanhamento"}${category ? `\nAplicativo: ${category}` : ""}\n${String(ticket.title || "").slice(0, 300)}${due ? `\nPrazo de primeira resposta: ${formatBrasilia(ticket.response_due_at)}${ticket.response_due_at < now() ? " (prazo vencido)" : ""}` : ""}${ticket.latest_update ? `\nÚltimo andamento: ${String(ticket.latest_update).slice(0, 250)}` : ""}`;
      })
      .join("\n\n") +
    "\n\nPara consultar um protocolo específico, envie seu número completo."
  );
}

export async function sendProtocolLookup(
  env: Env,
  c: Conversation,
  number: string | undefined,
  key: string,
  actor = "system",
) {
  const tickets = await lookupProtocols(env, c, number);
  const text = protocolSummary(
    tickets,
    !!number,
    await settings(env, c.profile_id),
  );
  // Split long histories into bounded messages without losing any returned row.
  const parts = text.match(/[\s\S]{1,3800}/g) || [text];
  const ids = [];
  for (const [index, part] of parts.entries())
    ids.push(
      await enqueue(
        env,
        c,
        actor,
        "text",
        { text: part, automation: "protocols" },
        `${key}:${index}`,
      ),
    );
  return {
    delivery_id: ids[0],
    delivery_ids: ids,
    status: "pending",
    data: tickets,
  };
}
