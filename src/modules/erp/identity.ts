// Lado do núcleo da porta de identidade do ERP (src/erp/engine/identity.ts):
// o Worker monta o envelope com o que o Wabotia sabe da pessoa e da área, e o
// motor nunca consulta o D1.
// - actor: papel erp:<papel> do acesso por pessoa (o administrador do Wabotia
//   vale erp:admin; o "*" dá o módulo, nunca o papel), a sessão (id e aal) e
//   se a pessoa tem fator ativo;
// - people: as pessoas da área com papel erp:* e os administradores, que o
//   motor projeta em erp_access (quem perde o papel fica inativo).
// A lista de pessoas sai no mesmo lote do D1 antes da rota (src/security.ts,
// authenticate com `prefetch`): não custa ida a mais ao banco.
import { cachedAll } from "../../db";
import { ApiError, type Actor, type Env } from "../../types";
import { rolesOf } from "../../access";
import { storedAccess } from "../../security";
import {
  ERP_ROLES,
  type ErpPerson,
  type ErpRole,
  type IdentityPort,
} from "../../erp/engine/identity.ts";

/**
 * Pessoas da área que entram no ERP: administradores (todas as áreas) e quem
 * tem algum erp:<papel> e a área. A conferência do papel é feita em código
 * (erpRoleOf): o LIKE só poupa linhas.
 */
export const ERP_PEOPLE_SQL =
  "SELECT u.id,u.name,u.email,u.role,u.access,EXISTS(SELECT 1 FROM user_factors f WHERE f.user_id=u.id AND f.status='active') has_factor FROM users u WHERE u.disabled=0 AND (u.role='admin' OR (u.access LIKE '%\"erp:%' AND EXISTS(SELECT 1 FROM json_each(u.profiles) WHERE value=?)))";

/** Caminho de uma rota do ERP (/api/v1/profiles/:area/erp/…). */
export const isErpPath = (path: string) =>
  /^\/api\/v1\/profiles\/[^/]+\/erp(\/|$)/.test(path);

const roleOfList = (list: string[] | null): ErpRole | null => {
  const role = (list ?? [])
    .find((item) => item.startsWith("erp:"))
    ?.slice(4) as ErpRole | undefined;
  return role && ERP_ROLES.includes(role) ? role : null;
};

/** Papel do ERP de quem chama; null sem papel. */
export function erpRoleOf(actor: Actor): ErpRole | null {
  if (actor.kind !== "user") return null;
  if (actor.role === "admin") return "admin";
  return roleOfList(rolesOf(actor));
}

function personOf(row: any): ErpPerson | null {
  const erp_role =
    row.role === "admin" ? "admin" : roleOfList(storedAccess(row.access));
  if (!erp_role) return null;
  return {
    user_id: row.id,
    name: row.name ?? null,
    email: row.email ?? null,
    erp_role,
    verified_factor: !!row.has_factor,
  };
}

/**
 * Envelope de identidade da requisição. Sem papel do ERP, 403 antes de ir ao
 * objeto (a pessoa alcança o módulo pelo "*", mas não tem papel no ERP).
 */
export async function erpIdentity(
  env: Env,
  actor: Actor,
  profile: string,
): Promise<IdentityPort> {
  const erp_role = erpRoleOf(actor);
  if (!erp_role)
    throw new ApiError(
      403,
      "erp_role_required",
      "Seu acesso não inclui um papel no ERP. Peça ao administrador em Pessoas e acessos.",
    );
  const people = (await cachedAll(env, ERP_PEOPLE_SQL, profile))
    .map(personOf)
    .filter((p): p is ErpPerson => p !== null);
  const self = people.find((p) => p.user_id === actor.id);
  return {
    actor: {
      user_id: actor.id,
      name: actor.name ?? self?.name ?? null,
      email: self?.email ?? null,
      erp_role,
      verified_factor: !!actor.mfa?.factor,
      session_id: actor.sessionId ?? null,
      aal: actor.aal === 2 ? "aal2" : "aal1",
      // Bot agindo pela pessoa (via) ou aplicação: agente.
      is_agent: actor.kind !== "user" || !!actor.via,
    },
    people,
  };
}
