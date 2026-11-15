// Consentimento de notificação por finalidade (migração 0027). "protocol" é o
// fluxo do núcleo (AUTORIZO / NÃO AUTORIZO); módulos registram as suas
// quando o cliente contrata, agenda, pede ou reserva. "*" é o REVOGAR do
// cliente e vale para todas. Fora da janela de 24 h, uma notificação marcada
// com uma finalidade só sai com o consentimento dela; sem finalidade, vale o
// de protocolo (como antes).
import { exec, one } from "./db";
import { now, requireValue, type Conversation, type Env } from "./types";
import { event } from "./events";

export const CONSENT_PURPOSES = [
  "billing",
  "scheduling",
  "order",
  "booking",
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const purposeLabels: Record<ConsentPurpose | "protocol", string> = {
  protocol: "protocolo",
  billing: "cobrança",
  scheduling: "agendamento",
  order: "pedido",
  booking: "reserva",
};

/** Último registro que vale para a finalidade: o dela ou o REVOGAR geral. */
export function consentFor(
  env: Env,
  conversationId: string,
  purpose: ConsentPurpose | "protocol" = "protocol",
) {
  return one(
    env,
    "SELECT * FROM consents WHERE conversation_id=? AND purpose IN (?,'*') ORDER BY created DESC,rowid DESC LIMIT 1",
    conversationId,
    purpose,
  );
}

/** Finalidade de uma notificação na fila (payload.consent_purpose). */
export const payloadPurpose = (payload: any): ConsentPurpose | "protocol" =>
  CONSENT_PURPOSES.includes(payload?.consent_purpose)
    ? payload.consent_purpose
    : "protocol";

export interface ConsentRecord {
  purpose: ConsentPurpose;
  /** Padrão "granted". */
  status?: "granted" | "revoked";
  /**
   * De onde veio: "whatsapp" (o cliente aceitou na conversa), "panel"
   * (registrado pela equipe), "contract" (contrato assinado), "api".
   */
  source: string;
  /** O que o cliente aceitou e onde (texto da oferta, id da mensagem…). */
  evidence?: Record<string, unknown>;
  /** Repetir a chave não registra de novo. */
  key?: string;
}

export async function recordConsent(
  env: Env,
  c: Conversation,
  module: string | null,
  record: ConsentRecord,
) {
  requireValue(
    CONSENT_PURPOSES.includes(record.purpose),
    `Finalidade inválida: use ${CONSENT_PURPOSES.join(", ")}.`,
  );
  const status = record.status || "granted";
  requireValue(
    ["granted", "revoked"].includes(status),
    "Estado do consentimento: granted ou revoked.",
  );
  const source = String(record.source || "").trim();
  requireValue(
    /^[a-z_]{2,30}$/.test(source),
    "Informe a origem do consentimento (ex.: whatsapp, panel, contract).",
  );
  requireValue(
    c.chat_type !== "group",
    "Consentimento individual não pode ser registrado em grupo.",
  );
  const evidence = JSON.stringify({ ...(record.evidence || {}) });
  requireValue(evidence.length <= 4000, "Evidência muito grande.");
  const id = record.key
    ? `module:${module}:${c.id}:consent:${record.key}`
    : crypto.randomUUID();
  const at = now();
  const inserted = await exec(
    env,
    "INSERT OR IGNORE INTO consents(id,profile_id,conversation_id,status,evidence,purpose,source,module_id,created) VALUES(?,?,?,?,?,?,?,?,?)",
    id,
    c.profile_id,
    c.id,
    status,
    evidence,
    record.purpose,
    source,
    module,
    at,
  );
  if (inserted.meta?.changes)
    await event(env, c.profile_id, "consent.updated", id, {
      conversation_id: c.id,
      purpose: record.purpose,
      status,
      source,
      module_id: module,
    });
  return one(env, "SELECT * FROM consents WHERE id=?", id);
}
