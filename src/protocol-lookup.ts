import { all } from "./db";
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
    !c.connection_id ||
    c.external_namespace !== `channel:${c.connection_id}`
  )
    return null;
  const value = String(c.phone || "").replace(/[+ ()-]/g, "");
  return /^\d{7,15}$/.test(value) ? value : null;
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
  const phone = verifiedPhone(c);
  // The same response is returned for a nonexistent number and somebody else's
  // number. Public updates only; internal notes and operator IDs are never sent.
  return all(
    env,
    `SELECT t.number,t.title,t.status,t.category,t.response_due_at,t.first_response_at,t.created,t.updated,
      (SELECT u.text FROM ticket_updates u WHERE u.ticket_id=t.id AND u.internal=0 ORDER BY u.created DESC,u.rowid DESC LIMIT 1) latest_update
     FROM tickets t JOIN conversations original ON original.id=t.conversation_id
     WHERE t.profile_id=? AND original.profile_id=? AND original.chat_type!='group'
       AND (original.id=? OR (? IS NOT NULL AND original.connection_id IS NOT NULL
         AND original.external_namespace='channel:'||original.connection_id
         AND replace(replace(replace(replace(replace(original.phone,'+',''),' ',''),'(',''),')',''),'-','')=?))
       AND (? IS NULL OR upper(t.number)=?)
     ORDER BY t.created DESC,t.id DESC LIMIT 10`,
    c.profile_id,
    c.profile_id,
    c.id,
    phone,
    phone,
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
      ? "Não encontramos esse protocolo vinculado ao seu atendimento ou telefone. Confira o número completo ou peça ajuda à equipe."
      : "Ainda não há protocolos vinculados ao seu atendimento ou telefone. Para falar com a equipe, envie ATENDENTE.";
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
