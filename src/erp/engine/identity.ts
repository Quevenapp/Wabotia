import { readErpPartsSnapshot, type ErpParts, type ErpPartsControl } from "../parts.ts";
// Porta de identidade: o que no Fagoo vinha de auth.* (Supabase Auth) e no
// Wabotia vem do núcleo (Pessoas, login, MFA). O Worker preenche o envelope
// antes da transação; o motor nunca consulta o D1. Fase 3: o lado do Worker
// (ler o papel erp:<papel> do acesso por pessoa, a sessão e o fator).
//
// Envelope (cabeçalho x-erp-identity, JSON em base64url):
//   actor  — quem chama: user_id (users.id do Wabotia), name, email,
//            erp_role (admin|consulta|vendas|financeiro|estoque|fiscal ou
//            null; o administrador do Wabotia vale erp:admin), session_id,
//            aal (aal1|aal2), verified_factor, is_agent;
//   people — as pessoas da área com o módulo ERP (mesmos campos, sem sessão),
//            ou null quando o Worker não as enviou (o motor usa então o que já
//            está em erp_access.membership e profile).
// Com `people`, o Acesso mantém erp_access.membership e profile como
// projeção do Wabotia (src/erp/domains/access/identity.ts): nenhum RPC grava
// papel; quem perde o erp:<papel> fica inativo.

export type ErpRole = "admin" | "consulta" | "vendas" | "financeiro" | "estoque" | "fiscal";
export const ERP_ROLES: readonly ErpRole[] = ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal"];

// systemUserId("contact-erp-link"). Capacidade administrativa comprovada;
// rpc-endpoint limita este ator mesmo se o envelope omitir qualquer marca.
export const CUSTOMER_BRIDGE_USER_ID = "a20b5668-6799-547a-9d10-5166158359b5";
export const CUSTOMER_BRIDGE_SCAN = "erp_customer_bridge_scan";
export const CUSTOMER_BRIDGE_FIELDS: readonly string[] = [
  "name", "phone", "mobile", "email", "document", "person_type",
  "street", "number", "complement", "district", "city", "state", "postal_code", "country",
];

export interface ErpPerson {
  user_id: string;
  name: string | null;
  email: string | null;
  erp_role: ErpRole | null;
  verified_factor: boolean;
  /** Marca do diretório interno, nunca inferida do nome da pessoa. */
  is_technical?: boolean;
}

export interface ErpActor extends ErpPerson {
  session_id: string | null;
  aal: "aal1" | "aal2";
  is_agent: boolean;
}

export interface IdentityPort {
  actor: ErpActor | null;
  people: ErpPerson[] | null;
  /** Restrição D1 lida pelo Worker; o objeto recebe só IDs, sem acesso ao D1. */
  customer_privacy?: { restricted_contact_ids: string[] };
  parts?: Readonly<ErpParts>;
  partsControl?: ErpPartsControl;
}

export const NO_IDENTITY: IdentityPort = { actor: null, people: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function person(v: any): ErpPerson | null {
  if (!v || typeof v !== "object" || typeof v.user_id !== "string" || !UUID.test(v.user_id.toLowerCase())) return null;
  return {
    user_id: v.user_id.toLowerCase(),
    name: typeof v.name === "string" ? v.name : null,
    email: typeof v.email === "string" ? v.email : null,
    erp_role: ERP_ROLES.includes(v.erp_role) ? v.erp_role : null,
    verified_factor: v.verified_factor === true,
    ...(v.is_technical === true ? { is_technical: true } : {}),
  };
}

/** Envelope recebido (JSON já decodificado) → porta validada; o que não confere vira ausente. */
export function readIdentity(raw: unknown): IdentityPort {
  if (!raw || typeof raw !== "object") return NO_IDENTITY;
  const r = raw as { actor?: any; people?: any; customer_privacy?: any; parts?: unknown; partsControl?: any };
  const restricted = r.customer_privacy?.restricted_contact_ids;
  if (r.customer_privacy !== undefined && (!Array.isArray(restricted) ||
      restricted.length > 2000 || restricted.some((id: unknown) => typeof id !== "string" || !UUID.test(id)))) return NO_IDENTITY;
  const base = person(r.actor);
  const actor: ErpActor | null = base
    ? {
        ...base,
        session_id: typeof r.actor.session_id === "string" && UUID.test(r.actor.session_id.toLowerCase()) ? r.actor.session_id.toLowerCase() : null,
        aal: r.actor.aal === "aal2" ? "aal2" : "aal1",
        is_agent: r.actor.is_agent === true,
      }
    : null;
  const people = Array.isArray(r.people) ? r.people.map(person).filter((p: ErpPerson | null): p is ErpPerson => p !== null) : null;
  // As duas extensões do envelope convivem: a restrição cadastral (fase 1) e
  // o estado das partes do ERP (fase 2).
  const privacy = restricted ? { customer_privacy: { restricted_contact_ids: restricted as string[] } } : {};
  const snapshot = readErpPartsSnapshot({ ...r.partsControl, parts: r.parts });
  if (!snapshot) return { actor, people, ...privacy };
  const { parts, ...partsControl } = snapshot;
  return { actor, people, parts, partsControl, ...privacy };
}

/** Também alcança IDs em recibos antigos, referências e snapshots aninhados. */
export function containsRestrictedContact(value: unknown, restricted: ReadonlySet<string>): boolean {
  if (!restricted.size) return false;
  if (typeof value === "string") return restricted.has(value.toLowerCase()) ||
    (value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])
      .some((id) => restricted.has(id.toLowerCase()));
  if (Array.isArray(value)) return value.some((item) => containsRestrictedContact(item, restricted));
  return !!value && typeof value === "object" && Object.values(value).some((item) => containsRestrictedContact(item, restricted));
}

/** Coleções/artefatos legados sem filtro antes da paginação não têm projeção segura. */
export function customerPrivacyUnsupported(rpc: string, args: Record<string, unknown>): boolean {
  return /^erp_platform_export/.test(rpc) || /^erp_(activity_|history_backups|read_records|catalog_origin_)/.test(rpc) ||
    ["erp_catalog_seller_options", "erp_catalog_employee_page"].includes(rpc) ||
    (args.p_entity === "contacts" && ["erp_catalog_page", "erp_catalog_list"].includes(rpc));
}

const b64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export const IDENTITY_HEADER = "x-erp-identity";
/** A costura pede o portão por requisição antes do RPC (registry.ts, RpcEnvironment.gate). */
export const GATE_HEADER = "x-erp-gate";
/** Resposta de RPC recusado pelo portão: "outside_schedule" ou "mfa_required". */
export const GATE_DENIED_HEADER = "x-erp-gate-denied";
/**
 * Marca de chamada interna na rota /erp-rpc: só a costura da erp-api
 * (api/local-fetch.ts) a põe. As RPCs do agendador (rpc-endpoint.ts,
 * SYSTEM_RPCS) sem ela são recusadas; o agendador do objeto chama callRpc
 * direto e nem passa pela rota.
 */
export const SYSTEM_HEADER = "x-erp-system";
export const encodeIdentity = (port: IdentityPort) => b64url(JSON.stringify(port));
export function decodeIdentity(header: string | null): IdentityPort {
  if (!header || header.length > 200_000) return NO_IDENTITY;
  try {
    return readIdentity(JSON.parse(fromB64url(header)));
  } catch {
    return NO_IDENTITY;
  }
}
