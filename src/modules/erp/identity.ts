import { ERP_PARTS_STATE_SQL, erpPartsStateOf, erpPartsEnvelope, readErpPartsState } from "./parts-state";
import { readErpPartsSnapshot } from "../../erp/parts.ts";
import { erpBotDelegation, erpBotOperation, erpBotOperationGranted } from "./bot-access.ts";
import { INTEGRATION_MODULES } from "../../erp/engine/module-origin.ts";
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
import { modules, type ModuleStates } from "../registry";
import { ApiError, type Actor, type Env } from "../../types";
import { rolesOf } from "../../access";
import { refuseEngineActor, storedAccess } from "../../security";
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
  "SELECT u.id,u.name,u.email,u.role,u.access,EXISTS(SELECT 1 FROM user_factors f WHERE f.user_id=u.id AND f.status='active') has_factor,NULL erp_parts_state,NULL erp_parts_read_at FROM users u WHERE u.disabled=0 AND (u.role='admin' OR (u.access LIKE '%\"erp:%' AND EXISTS(SELECT 1 FROM json_each(u.profiles) WHERE value=?1)))" +
  // Uma linha de controle, inclusive sem pessoas: reaproveita a consulta
  // já incluída no batch(4) de autenticação, sem modificar seu chamador.
  ` UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,0,
    (SELECT json_group_array(json_object('module_id',module_id,'enabled',enabled,
      'revision',revision,'delivered_revision',delivered_revision)) FROM (${ERP_PARTS_STATE_SQL.replace("?", "?1")})),
    CAST(strftime('%s','now') AS INTEGER)*1000`;

async function identityPartsState(env: Env, profile: string) {
  // O cache é da requisição autenticada, invalidado por escrita em módulos.
  // A validade começa no SELECT, nunca no momento de consumir seu resultado.
  const row = (await cachedAll(env, ERP_PEOPLE_SQL, profile)).find(r => r.erp_parts_state != null);
  if (row) {
    const state = erpPartsStateOf(profile, JSON.parse(row.erp_parts_state), Number(row.erp_parts_read_at));
    if (readErpPartsSnapshot(state.snapshot, profile)) return state;
  }
  return readErpPartsState(env, profile);
}

/**
 * Identidades de sistema: um módulo agindo no ERP sem pessoa nem chave (a
 * fila de saída). Cada uma vira um membro técnico do ERP, como o agente do
 * Fagoo, com a mesma regra da aplicação: só consulta, vendas, estoque ou
 * fiscal (ERP_AGENT_ROLES). Módulo que precisa lançar título (Pedido pago,
 * Mensalidade) não ganha financeiro: no Fagoo, lançar as contas de um
 * documento (erp_document_finance_post) exige admin ou financeiro, e isso
 * fica com pessoas em sessão com segundo fator; o caminho do lançamento
 * vindo de módulo é desenho da fila de saída. O id é fixo (derivado do id
 * do módulo) e elas vão em `people` em toda requisição, para o motor não
 * desativá-las quando a chamada é de uma pessoa. O núcleo não tem
 * identidade de sistema por enquanto: a projeção Empresa × Estabelecimento
 * mexe nos dados da empresa (admin) e também é desenho da fila de saída.
 */
export function systemActorsOf(
  list: readonly {
    id: string;
    name: string;
    erp_role?: string;
  }[],
  states: Record<string, boolean>,
): [string, { name: string; role: ErpRole }][] {
  return list
    .filter((m) => INTEGRATION_MODULES.includes(m.id as any) ? states.erp || states[m.id] : m.erp_role && states[m.id])
    .map((m) => {
      if (m.erp_role && !ERP_AGENT_ROLES.includes(m.erp_role as ErpRole))
        throw new Error(`erp_system_role_not_allowed:${m.id}:${m.erp_role} (só consulta, vendas, estoque ou fiscal)`);
      if (INTEGRATION_MODULES.includes(m.id as any)) return [m.id, { name: `Sistema · ${m.name}`, role: "vendas" as const }];
      if (!ERP_AGENT_ROLES.includes(m.erp_role as ErpRole))
        throw new Error(
          `erp_system_role_not_allowed:${m.id}:${m.erp_role} (só consulta, vendas, estoque ou fiscal)`,
        );
      return [
        m.id,
        { name: `Sistema · ${m.name}`, role: m.erp_role as ErpRole },
      ];
    });
}

/** Identidades de sistema ativas na área (módulos ligados com erp_role). */
async function systemActors(env: Env, profile: string, states?: ModuleStates) {
  states ??= (await readErpPartsState(env, profile)).states;
  const actors = systemActorsOf(modules, states);
  // Registro real, presente também nos envelopes humanos. Não depende de
  // definition.ts, nem concede papel ERP ao atendente ou ao motor de IA.
  if (states.erp)
    actors.push(["contact-erp-link", { name: "Sistema · Cadastro", role: "vendas" }]);
  return actors;
}

/** UUID fixo de uma identidade de sistema (SHA-256 do nome, formato v5). */
export async function systemUserId(id: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`wabotia-erp-system:${id}`),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** As identidades de sistema como pessoas do envelope. */
async function systemPeople(env: Env, profile: string, states?: ModuleStates): Promise<ErpPerson[]> {
  return Promise.all(
    (await systemActors(env, profile, states)).map(async ([id, s]) => ({
      user_id: await systemUserId(id),
      name: s.name,
      email: null,
      erp_role: s.role,
      verified_factor: false,
      is_technical: true,
    })),
  );
}

// ---------------------------------------------------------------------------
// Aplicações (chaves de API) no ERP: escopos erp:read e erp:write.
// A aplicação é um membro técnico do ERP com identidade própria, como o
// agente do Fagoo (202611130001_access_agents): o motor aplica o papel, as
// permissões e a auditoria, e a atividade mostra o nome da aplicação. Nunca
// herda o papel, a sessão ou o aal2 de uma pessoa.
// - erp:read: papel consulta, só GET/HEAD.
// - erp:write: o papel que o administrador escolheu (applications.erp_role,
//   migração 0089); sem papel, 403 erp_role_required.
// - Regra do Fagoo para agente: só consulta, vendas, estoque ou fiscal. Quem
//   movimenta dinheiro ou administra a empresa (admin, financeiro, o escopo
//   do segundo fator) não é oferecido a agente: um token não tem sessão aal2.

export const ERP_READ = "erp:read";
export const ERP_WRITE = "erp:write";
/** Papéis que uma aplicação pode ter (erp_access.agent_register do Fagoo). */
export const ERP_AGENT_ROLES: readonly ErpRole[] = [
  "consulta",
  "vendas",
  "estoque",
  "fiscal",
];

/** Papel fora da regra do agente: 400 ao gravar, 403 numa requisição. */
const agentRoleNotAllowed = (status = 400) =>
  new ApiError(
    status,
    "erp_agent_role_not_allowed",
    "Aplicação só pode ter no ERP o papel de consulta, vendas, estoque ou fiscal. Administrador e financeiro ficam com pessoas, em sessão com segundo fator.",
  );

/** Papel do ERP enviado ao criar ou alterar uma aplicação (null: sem papel). */
export function appErpRoleInput(value: unknown): ErpRole | null {
  if (value === null || value === undefined || value === "") return null;
  if (!ERP_AGENT_ROLES.includes(value as ErpRole)) throw agentRoleNotAllowed();
  return value as ErpRole;
}

/** Aplicações ativas da área com escopo do ERP (vão em `people`). */
export const ERP_APPS_SQL =
  "SELECT a.id,a.name,a.scopes,a.erp_role FROM applications a WHERE a.disabled=0 AND a.scopes LIKE '%\"erp:%' AND EXISTS(SELECT 1 FROM json_each(a.profiles) WHERE value=?)";

/** Papel do ERP de uma aplicação pelos escopos e pelo papel escolhido. */
export function appErpRole(
  scopes: string[],
  chosen: string | null | undefined,
): ErpRole | null {
  if (scopes.includes(ERP_WRITE))
    return ERP_AGENT_ROLES.includes(chosen as ErpRole)
      ? (chosen as ErpRole)
      : null;
  return scopes.includes(ERP_READ) ? "consulta" : null;
}

function appPersonOf(row: any): ErpPerson | null {
  const scopes: string[] = (() => {
    try {
      return JSON.parse(row.scopes);
    } catch {
      return [];
    }
  })();
  const erp_role = appErpRole(scopes, row.erp_role);
  if (!erp_role) return null;
  return {
    user_id: row.id,
    name: row.name ?? null,
    email: null,
    erp_role,
    verified_factor: false,
    is_technical: true,
  };
}

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
  if (!row.id) return null; // Linha de controle das partes, não uma pessoa.
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
 * Todos os membros do ERP da área para o envelope: pessoas com papel,
 * aplicações com escopo do ERP e as identidades de sistema. Vão juntos em
 * toda requisição, porque o motor desativa quem não está na lista
 * (src/erp/domains/access/identity.ts): tirar o escopo ou desligar a
 * aplicação a desativa na requisição seguinte.
 */
export async function erpPeople(env: Env, profile: string, states?: ModuleStates) {
  const [people, apps, system] = await Promise.all([
    cachedAll(env, ERP_PEOPLE_SQL, profile),
    cachedAll(env, ERP_APPS_SQL, profile),
    systemPeople(env, profile, states),
  ]);
  return [...people.map(personOf), ...apps.map(appPersonOf), ...system].filter(
    (p): p is ErpPerson => p !== null,
  );
}

/** Id da aplicação no ERP: o uuid, sem o "app:" do ator da chave. */
export const appUserId = (actor: Actor) => actor.id.replace(/^app:/, "");

/** Leitura da erp-api (GET/HEAD): basta erp:read. */
const isRead = (method: string) => method === "GET" || method === "HEAD";

/**
 * Envelope de identidade da requisição. Sem papel do ERP, 403 antes de ir ao
 * objeto (a pessoa alcança o módulo pelo "*", mas não tem papel no ERP).
 * Aplicação: escopo erp:read (leitura) ou erp:write (o papel escolhido).
 */
export async function erpIdentity(
  env: Env,
  actor: Actor,
  profile: string,
  method = "GET",
  path?: string,
): Promise<IdentityPort> {
  refuseEngineActor(actor);
  if (actor.kind === "app") return appIdentity(env, actor, profile, method);
  const erp_role = erpRoleOf(actor);
  if (!erp_role)
    throw new ApiError(
      403,
      "erp_role_required",
      "Seu acesso não inclui um papel no ERP. Peça ao administrador em Pessoas e acessos.",
    );
  const state = await identityPartsState(env, profile);
  const people = await erpPeople(env, profile, state.states);
  const self = people.find((p) => p.user_id === actor.id);
  const bling = !!path?.includes("/erp/v1/receber-bling");
  if (actor.via && bling) {
    const operation = erpBotOperation(profile, method, path);
    if (!operation || !await erpBotOperationGranted(env, actor, profile, operation.id))
      throw new ApiError(403, "erp_bot_grant_required", "Libere esta operação para o bot na área.");
  }
  const delegated = await erpBotDelegation(env, actor, profile, method, path);
  // A normalização fiscal também depende da concessão. Sem ela a rota de
  // NF-e não pode retirar novamente a marca conservadora do envelope.
  if (actor.via && path?.includes("/erp-comercial-nfe/") && !delegated)
    throw new ApiError(403, "erp_bot_grant_required", "Libere esta operação para o bot na área e confirme a proposta de escrita.");
  // Leitura sensível pelo bot sem concessão, proposta confirmada ou opção
  // autônoma: recusa explícita, ao lado do portão antigo (que só pega quem
  // está no escopo de segundo fator).
  if (actor.via && !delegated && isRead(method.toUpperCase()) && erpBotOperation(profile, method, path)?.sensitive)
    throw new ApiError(403, "erp_bot_proposal_required", "Leitura sensível: proponha a consulta para a pessoa confirmar, ou peça ao administrador para liberá-la para o bot.");
  return {
    actor: {
      user_id: actor.id,
      name: actor.name ?? self?.name ?? null,
      email: self?.email ?? null,
      erp_role,
      verified_factor: !!actor.mfa?.factor,
      session_id: actor.sessionId ?? null,
      aal: actor.aal === 2 ? "aal2" : "aal1",
      // Sem concessão nominal vale o portão legado. A exceção conserva os
      // dados reais da pessoa e, para escrever, exige confirmação conferida.
      is_agent: !!actor.via && (bling || !delegated),
    },
    people,
    ...await erpPartsEnvelope(env, profile, state.snapshot),
  };
}

async function appIdentity(
  env: Env,
  actor: Actor,
  profile: string,
  method: string,
): Promise<IdentityPort> {
  const write = !isRead(method.toUpperCase());
  if (
    !actor.scopes.includes(ERP_WRITE) &&
    !(actor.scopes.includes(ERP_READ) && !write)
  )
    throw new ApiError(
      403,
      "insufficient_scope",
      write
        ? "Esta chave precisa do escopo erp:write para alterar o ERP."
        : "Esta chave precisa do escopo erp:read ou erp:write para ler o ERP.",
    );
  const state = await identityPartsState(env, profile);
  const people = await erpPeople(env, profile, state.states);
  // O papel vem da linha da aplicação, lida no mesmo lote (ERP_APPS_SQL). O
  // ator da chave tem id "app:<uuid>"; no ERP vale o uuid da aplicação.
  const appId = appUserId(actor);
  const self = people.find((p) => p.user_id === appId);
  // Papel gravado fora da regra (admin, financeiro): recusa clara, antes do
  // objeto, em vez de "sem papel".
  const row = (await cachedAll(env, ERP_APPS_SQL, profile)).find(
    (a) => a.id === appId,
  );
  if (
    actor.scopes.includes(ERP_WRITE) &&
    row?.erp_role &&
    !ERP_AGENT_ROLES.includes(row.erp_role)
  )
    throw agentRoleNotAllowed(403);
  if (!self?.erp_role)
    throw new ApiError(
      403,
      "erp_role_required",
      "Esta aplicação tem erp:write, mas nenhum papel do ERP. Escolha o papel em API e integrações.",
    );
  return {
    actor: {
      user_id: appId,
      name: self.name ?? actor.name ?? null,
      email: null,
      erp_role: self.erp_role,
      verified_factor: false,
      // Sem sessão: nunca aal2, nunca a de uma pessoa.
      session_id: null,
      aal: "aal1",
      is_agent: true,
      is_technical: true,
    },
    people,
    ...await erpPartsEnvelope(env, profile, state.snapshot),
  };
}

/**
 * Envelope de uma identidade de sistema (ERP_SYSTEM_ACTORS): o núcleo ou um
 * módulo chamando o objeto erp: sem pessoa nem chave (fila de saída). Uma
 * ida ao D1 para as pessoas da área.
 */
export async function erpSystemIdentity(
  env: Env,
  profile: string,
  id: string,
): Promise<IdentityPort> {
  const state = await identityPartsState(env, profile);
  const system = (await systemActors(env, profile, state.states)).find(
    ([k]) => k === id,
  )?.[1];
  // Desconhecida, ou módulo desligado na área: não age no ERP.
  if (!system) throw new Error(`erp_system_actor_unknown:${id}`);
  const people = await erpPeople(env, profile, state.states);
  const user_id = await systemUserId(id);
  return {
    actor: {
      user_id,
      name: system.name,
      email: null,
      erp_role: system.role,
      verified_factor: false,
      session_id: null,
      aal: "aal1",
      is_agent: true,
      is_technical: true,
    },
    people,
    ...await erpPartsEnvelope(env, profile, state.snapshot),
  };
}
