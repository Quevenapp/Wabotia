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

export interface ErpPerson {
  user_id: string;
  name: string | null;
  email: string | null;
  erp_role: ErpRole | null;
  verified_factor: boolean;
}

export interface ErpActor extends ErpPerson {
  session_id: string | null;
  aal: "aal1" | "aal2";
  is_agent: boolean;
}

export interface IdentityPort {
  actor: ErpActor | null;
  people: ErpPerson[] | null;
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
  };
}

/** Envelope recebido (JSON já decodificado) → porta validada; o que não confere vira ausente. */
export function readIdentity(raw: unknown): IdentityPort {
  if (!raw || typeof raw !== "object") return NO_IDENTITY;
  const r = raw as { actor?: any; people?: any };
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
  return { actor, people };
}

const b64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export const IDENTITY_HEADER = "x-erp-identity";
/** A costura pede o portão por requisição antes do RPC (registry.ts, RpcEnvironment.gate). */
export const GATE_HEADER = "x-erp-gate";
/** Resposta de RPC recusado pelo portão: "outside_schedule" ou "mfa_required". */
export const GATE_DENIED_HEADER = "x-erp-gate-denied";
export const encodeIdentity = (port: IdentityPort) => b64url(JSON.stringify(port));
export function decodeIdentity(header: string | null): IdentityPort {
  if (!header || header.length > 200_000) return NO_IDENTITY;
  try {
    return readIdentity(JSON.parse(fromB64url(header)));
  } catch {
    return NO_IDENTITY;
  }
}
