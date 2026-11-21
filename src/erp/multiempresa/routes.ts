// Rotas da multiempresa, em /api/v1/profiles/:profile/erp-empresas (operações
// em ./contract.ts; lógica em ./service.ts):
//   GET  erp-empresas                 as empresas da pessoa (seletor do topo)
//   GET  erp-empresas/consolidado     todas as empresas lado a lado
//   GET  erp-empresas/copiar/previa   o que a cópia faria (nada é gravado)
//   POST erp-empresas/copiar          copia cadastros de outra empresa para esta
//   POST erp-empresas/nova            adiciona uma empresa (área nova com ERP)
//
// Empresa = área de atendimento com o módulo ERP ligado. A pessoa vê as
// empresas das áreas a que tem acesso, e só se tem papel no ERP (o papel do
// ERP é da pessoa, igual em todas as áreas). Cada ERP é lido como a pessoa,
// com o portão dele (papel, horário, segundo fator e partes ligadas): uma
// consulta por empresa, com limite de empresas por tela. O consolidado e a
// cópia são do administrador do ERP; criar empresa, do administrador da conta.
import { ApiError, json as parseJson, type Actor, type Env } from "../../types";
import { all, batch, one } from "../../db";
import { audit } from "../../events";
import { canProfile, sha } from "../../security";
import { moduleStates, missingRequirements } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity, erpRoleOf } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { ERP_MODULE_IDS, ERP_PART_NAMES, erpPartOffMessage, erpRequirement, type ErpModuleId } from "../parts.ts";
import { cnpjValid } from "../domains/stores/model.ts";
import {
  CONSOLIDATED_PERIODS, COPY_KIND_LABELS, COPY_KIND_PARTS, ERP_EMPRESAS_PART, MAX_COMPANIES, MAX_SELECTOR, REGIMES,
  erpCompanyOperationFor, type CopyKind, type ErpCompanyOperation,
} from "./contract.ts";
import { CopyError, applyCopy, compactKey, copyKindsOf, planCopy, readSnapshot, summaryOf, totalOf, type ErpCall } from "./service.ts";

const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** RPCs que gravam (o resto vai como leitura). */
const WRITES = /_(save|execute|import|import_batch|confirm_fiscal|save_identity)$/;

/** Motivos conhecidos do motor, em palavras de quem usa. */
const REASONS: Readonly<Record<string, [number, string, string]>> = {
  erp_home_access_denied: [403, "forbidden", "Seu papel no ERP desta empresa não vê o resumo. Peça ao administrador em Gestão › Pessoas e acessos."],
  erp_preferences_import_denied: [403, "forbidden", "Só o administrador do ERP copia cadastros. Peça ao administrador em Gestão › Pessoas e acessos."],
  erp_company_forbidden: [403, "forbidden", "Seu papel no ERP não vê os dados da empresa. Peça ao administrador."],
  erp_company_reason_required: [400, "invalid_request", "A empresa já tem dados gravados. Mude pelo ERP dela, em Configurações › Dados da empresa."],
  erp_company_data_invalid: [400, "invalid_request", "Confira os dados da empresa (CNPJ, endereço, telefone e e-mail)."],
};

export interface Company {
  area: string;
  area_nome: string;
  nome_fantasia: string;
  razao_social: string | null;
  cnpj: string | null;
  atual: boolean;
  /** false: os dados da empresa não foram lidos (limite da tela, ERP fora do ar ou fora do horário). */
  dados: boolean;
}

/** Erro do motor com o motivo dele (a cópia traduz por linha). */
class EngineError extends ApiError {
  reason: string;
  constructor(status: number, code: string, message: string, reason: string) { super(status, code, message); this.reason = reason; }
}

/**
 * Porta de um ERP: chama o RPC do objeto erp: da área como a pessoa. `asPerson`:
 * a pessoa confirmou o pedido do bot na rota (a leitura das outras empresas
 * segue a mesma confirmação, sem o portão antigo de agente).
 */
export async function erpPort(env: Env, profile: string, actor: Actor, pathname: string, method: string, asPerson: boolean, label: string): Promise<ErpCall> {
  const identity = await erpIdentity(env, actor, profile, method, pathname);
  if (asPerson && identity.actor) identity.actor = { ...identity.actor, is_agent: false };
  return async (rpc, args = {}) => {
    const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
    let response: Response;
    try {
      response = await localFetch(env, profile, actor, identity, { read: !WRITES.test(rpc), gate, trackCustomers: false })(
        `https://erp.wabotia.invalid/rest/v1/rpc/${rpc}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
    } catch (error) {
      if ((error as { code?: string })?.code === "erp_unavailable") throw new ApiError(503, "dependency_unavailable", `O ERP de ${label} está temporariamente indisponível. Tente de novo em instantes.`);
      throw error;
    }
    if (gate.partsDenied === "module_disabled")
      throw new ApiError(409, "module_disabled", `Uma parte do ERP de ${label} está desligada para esta consulta. Ligue em Gestão → Módulos de ${label}.`);
    if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
      gate.denied === "mfa_required" ? `O ERP de ${label} pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo.`
        : `Seu acesso ao ERP de ${label} está fora do horário permitido agora. Fale com o administrador.`);
    const body = await response.json<any>().catch(() => null);
    if (!response.ok) {
      const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
      if (body?.code === "module_disabled" || response.status === 409 && /parte desligada/.test(code))
        throw new ApiError(409, "module_disabled", `Uma parte do ERP de ${label} está desligada. Ligue em Gestão → Módulos de ${label}.`);
      const known = REASONS[code];
      if (known) throw new EngineError(known[0], known[1], known[2], code);
      if (response.status >= 500) throw new EngineError(503, "dependency_unavailable", `O ERP de ${label} está temporariamente indisponível. Tente de novo em instantes.`, code);
      throw new EngineError(response.status === 403 ? 403 : 400, response.status === 403 ? "forbidden" : "invalid_request",
        response.status === 403 ? `Seu acesso no ERP de ${label} não permite esta ação. Peça ao administrador.` : `O ERP de ${label} recusou o pedido. Confira os dados e tente de novo.`, code);
    }
    return body;
  };
}

/** As áreas da pessoa com o ERP ligado (sem ler os ERPs). Sem papel no ERP: nenhuma. */
async function erpAreasOf(env: Env, actor: Actor): Promise<{ id: string; name: string; states: Readonly<Record<string, boolean>> }[]> {
  if (!erpRoleOf(actor)) return [];
  const rows = (await all(env, "SELECT id,name FROM profiles ORDER BY created")).filter((p: any) => canProfile(actor, p.id));
  const out = [];
  for (const row of rows) {
    const states = await moduleStates(env, row.id);
    if (states.erp) out.push({ id: String(row.id), name: String(row.name), states });
  }
  return out;
}

/** Empresas da pessoa, com nome fantasia e CNPJ lidos do ERP de cada uma (até MAX_SELECTOR). */
export async function companiesOf(env: Env, actor: Actor, current: string, pathname: string, asPerson = false): Promise<Company[]> {
  const areas = await erpAreasOf(env, actor);
  const out: Company[] = [];
  for (const [index, area] of areas.entries()) {
    const base: Company = { area: area.id, area_nome: area.name, nome_fantasia: area.name, razao_social: null, cnpj: null, atual: area.id === current, dados: false };
    if (index < MAX_SELECTOR) {
      try {
        const call = await erpPort(env, area.id, actor, pathname, "GET", asPerson, area.name);
        const record = (await call("erp_company_get", { p_section: "identity" }))?.record?.data;
        if (record) Object.assign(base, { nome_fantasia: record.trade_name || record.legal_name || area.name, razao_social: record.legal_name ?? null, cnpj: record.cnpj ?? null, dados: true });
      } catch { /* a empresa aparece pelo nome da área; o ERP dela responde quando abrir */ }
    }
    out.push(base);
  }
  return out;
}

async function commandId(value: unknown, idempotency: string | null, profile: string, name: string, body: unknown) {
  if (value !== undefined && value !== null) {
    if (typeof value !== "string" || !UUID.test(value)) bad("comando: identificador inválido.");
    return (value as string).toLowerCase();
  }
  const seed = idempotency && idempotency.length <= 200 ? `key:${idempotency}` : `body:${JSON.stringify(body)}`;
  const hash = await sha(JSON.stringify(["wabotia-erp-empresas-v1", profile, name, seed]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Só o administrador do ERP (o papel é da pessoa e vale em todas as empresas dela). */
function requireErpAdmin(actor: Actor, what: string) {
  if (erpRoleOf(actor) !== "admin")
    throw new ApiError(403, "forbidden", `${what} é só para quem é administrador do ERP em todas as empresas. Peça ao administrador em Gestão › Pessoas e acessos.`);
}

/** Parte do ERP desligada numa das empresas: diz qual ligar e onde. */
function partsOff(kinds: readonly CopyKind[], states: Readonly<Record<string, boolean>>, label: string) {
  for (const kind of kinds) {
    const part = COPY_KIND_PARTS[kind];
    const off = erpPartOffMessage(part, erpRequirement(part), states);
    if (off) throw new ApiError(409, "module_disabled", `${COPY_KIND_LABELS[kind]}: ${ERP_PART_NAMES[part]} está desligado em ${label}. Ligue em Gestão → Módulos de ${label} e tente de novo.`);
  }
}

/** Chama um comando da área pelo Coordinator (o mesmo caminho de POST /profiles, /modules e /users), com recibo. */
async function coordinatorCommand(env: Env, profile: string, actor: Actor, operation: string, data: unknown, key: string, requestId: string) {
  const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName(profile)).fetch("https://coordinator/command", {
    method: "POST", body: JSON.stringify({ profile, operation, actor, data, key, requestId }),
  });
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? "invalid_request", body?.error?.message ?? "A conta recusou o pedido. Atualize a tela e tente de novo.");
  return body;
}

const str = (value: unknown, max: number, name: string, required = false) => {
  if (value === undefined || value === null || value === "") return required ? bad(`${name}: obrigatório.`) : null;
  if (typeof value !== "string" || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) bad(`${name}: texto de até ${max} letras.`);
  return (value as string).trim() || (required ? bad(`${name}: obrigatório.`) : null);
};

/** Dados da empresa nova (tela) → identidade do ERP (erp_company_save_identity). */
export function newCompanyInput(body: Record<string, any>) {
  const trade = str(body.nome_fantasia, 100, "nome_fantasia", true)!;
  const legal = str(body.razao_social, 150, "razao_social", true)!;
  const cnpj = String(body.cnpj ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!cnpjValid(cnpj)) bad("O CNPJ não confere. Confira os números.");
  const regime = REGIMES[String(body.regime ?? "")];
  if (!regime) bad(`regime: ${Object.keys(REGIMES).join(", ")}.`);
  const address = body.endereco ?? {};
  if (typeof address !== "object" || Array.isArray(address)) bad("endereco: objeto com cep, rua, numero, complemento, bairro, cidade, codigo_municipio e uf.");
  const cep = address.cep === undefined || address.cep === null || address.cep === "" ? null : String(address.cep).replace(/\D/g, "");
  if (cep !== null && cep.length !== 8) bad("O CEP tem 8 números.");
  const uf = address.uf ? String(address.uf).trim().toUpperCase() : null;
  if (uf !== null && !/^[A-Z]{2}$/.test(uf)) bad("Escolha a UF (duas letras, como SP).");
  const ibge = address.codigo_municipio ? String(address.codigo_municipio).replace(/\D/g, "") : null;
  if (ibge !== null && ibge.length !== 7) bad("O código do município (IBGE) tem 7 números.");
  const phone = body.telefone ? String(body.telefone).replace(/\D/g, "") : null;
  if (phone !== null && (phone.length < 8 || phone.length > 20)) bad("Confira o telefone (com DDD).");
  const email = str(body.email, 200, "email");
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad("Confira o e-mail.");
  const ie = str(body.ie, 20, "ie");
  const people = body.pessoas ?? [];
  if (!Array.isArray(people) || people.length > 200 || people.some((id) => typeof id !== "string" || !id || id.length > 64)) bad("pessoas: lista de ids das pessoas.");
  const identity = {
    legal_name: legal, trade_name: trade, cnpj, ie: ie ? ie.replace(/[^0-9A-Za-z]/g, "").toUpperCase() : null,
    postal_code: cep, street: str(address.rua, 120, "rua"), number: str(address.numero, 20, "numero"), complement: str(address.complemento, 80, "complemento"),
    district: str(address.bairro, 80, "bairro"), city: str(address.cidade, 80, "cidade"), municipality_code: ibge, state: uf, phone, email,
  };
  return { trade, identity, crt: regime.crt, regime: regime.label, people: [...new Set(people as string[])] };
}

/** GET/POST /api/v1/profiles/:profile/erp-empresas/… */
export async function erpEmpresasRoute(env: Env, request: Request, profile: string, actor: Actor, requestId = ""): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const operation = erpCompanyOperationFor(request.method, path);
  if (!operation) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user") throw new ApiError(403, "user_required", "As empresas atendem uma pessoa da conta (ou o bot, com a operação liberada por ela).");
  const states = await moduleStates(env, profile);
  if (!states.erp) {
    const off = erpPartOffMessage(ERP_EMPRESAS_PART, erpRequirement(ERP_EMPRESAS_PART), states);
    throw new ApiError(409, "module_disabled", off ?? "O ERP está desligado nesta área. Ligue em Gestão → Módulos.");
  }
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ")}.`);
  for (const key of operation.required) {
    const value = body ? body[key] : url.searchParams.get(key);
    if (value === undefined || value === null || value === "") bad(`${key}: obrigatório.`);
  }
  let delegated = false;
  if (actor.via) {
    delegated = operation.bot !== false && await erpBotDelegation(env, actor, profile, request.method, url.pathname, body);
    if (!delegated) throw new ApiError(403, "erp_bot_grant_required", "Esta operação das empresas não foi liberada para este bot, ou falta a confirmação da pessoa.");
  }
  if (!erpRoleOf(actor)) throw new ApiError(403, "erp_role_required", "Seu acesso não inclui um papel no ERP. Peça ao administrador em Gestão › Pessoas e acessos.");
  return reply(await dispatch(env, request, url, profile, actor, operation, body ?? {}, delegated, requestId));
}

async function dispatch(env: Env, request: Request, url: URL, profile: string, actor: Actor, operation: ErpCompanyOperation, body: Record<string, any>, delegated: boolean, requestId: string) {
  switch (operation.name) {
    case "erp.empresas.listar": {
      const empresas = await companiesOf(env, actor, profile, url.pathname, delegated);
      return { scope: "erp_companies", empresas, limite_leitura: MAX_SELECTOR, administrador: erpRoleOf(actor) === "admin", pode_criar: actor.role === "admin" };
    }
    case "erp.empresas.consolidado": {
      requireErpAdmin(actor, "Ver todas as empresas lado a lado");
      const period = url.searchParams.get("periodo") || "30d";
      if (!(CONSOLIDATED_PERIODS as readonly string[]).includes(period)) bad(`periodo: ${CONSOLIDATED_PERIODS.join(", ")}.`);
      const areas = await erpAreasOf(env, actor);
      const wanted = url.searchParams.get("empresas")?.split(",").map((x) => x.trim()).filter(Boolean);
      if (wanted?.some((id) => !areas.some((a) => a.id === id))) throw new ApiError(404, "not_found", "Uma das empresas escolhidas não existe ou você não tem acesso a ela. Atualize a tela.");
      if (wanted && wanted.length > MAX_COMPANIES) bad(`Escolha até ${MAX_COMPANIES} empresas por vez.`);
      // Sem escolha: as primeiras MAX_COMPANIES (a tela avisa quantas são ao todo).
      const chosen = wanted?.length ? areas.filter((a) => wanted.includes(a.id)) : areas.slice(0, MAX_COMPANIES);
      const rows = [];
      for (const area of chosen) {
        const row: Record<string, unknown> = { area: area.id, area_nome: area.name, nome_fantasia: area.name, cnpj: null, resumo: null, erro: null };
        try {
          const call = await erpPort(env, area.id, actor, url.pathname, "GET", delegated, area.name);
          const identity = (await call("erp_company_get", { p_section: "identity" }).catch(() => null))?.record?.data;
          if (identity) Object.assign(row, { nome_fantasia: identity.trade_name || identity.legal_name || area.name, cnpj: identity.cnpj ?? null });
          row.resumo = summaryOf(await call("erp_home_overview", { p_period: period }));
        } catch (error) {
          row.erro = error instanceof ApiError ? error.message : `Não deu para ler o ERP de ${area.name} agora. Tente de novo em instantes.`;
        }
        rows.push(row);
      }
      return { scope: "erp_companies_consolidated", periodo: period, limite: MAX_COMPANIES, total_empresas: areas.length, empresas: rows,
        total: totalOf(rows.map((r) => r.resumo as any)) };
    }
    case "erp.empresas.copiar_previa":
    case "erp.empresas.copiar": {
      requireErpAdmin(actor, "Copiar cadastros entre empresas");
      const preview = operation.name === "erp.empresas.copiar_previa";
      const origin = String((preview ? url.searchParams.get("origem") : body.origem) ?? "");
      const kinds = (() => { try { return copyKindsOf(preview ? url.searchParams.get("cadastros") : body.cadastros); } catch (error) { return bad((error as Error).message); } })();
      if (origin === profile) bad("Escolha outra empresa de origem: esta é a empresa que recebe os cadastros.");
      const areas = await erpAreasOf(env, actor);
      const source = areas.find((a) => a.id === origin);
      const target = areas.find((a) => a.id === profile)!;
      if (!source) throw new ApiError(404, "not_found", "A empresa de origem não existe, está com o ERP desligado ou você não tem acesso a ela. Atualize a tela.");
      partsOff(kinds, source.states, source.name);
      partsOff(kinds, target.states, target.name);
      try {
        const from = await erpPort(env, source.id, actor, url.pathname, "GET", delegated, source.name);
        const to = await erpPort(env, target.id, actor, url.pathname, request.method, delegated, target.name);
        const plan = planCopy(kinds, await readSnapshot(from, kinds, !preview), await readSnapshot(to, kinds, false));
        const empresas = { origem: { area: source.id, nome: source.name }, destino: { area: target.id, nome: target.name } };
        if (preview) return { scope: "erp_companies_copy_preview", ...empresas, cadastros: plan.kinds };
        const command = await commandId(body.comando, request.headers.get("Idempotency-Key"), profile, operation.name, body);
        const results = await applyCopy(to, plan, command, `Cópia de ${source.name}`);
        await audit(env, actor, profile, "erp.companies.copy", source.id, requestId).catch(() => {});
        return { scope: "erp_companies_copy", ...empresas, comando: command, cadastros: results };
      } catch (error) {
        if (error instanceof CopyError) throw new ApiError(error.status, "invalid_request", error.message);
        throw error;
      }
    }
    case "erp.empresas.nova":
      return newCompany(env, request, profile, actor, body, requestId);
  }
  return bad("Operação desconhecida.");
}

/**
 * Adicionar empresa: área nova pelo comando de sempre (profile.create), com os
 * módulos do ERP desta empresa ligados (module.set, na ordem das dependências),
 * as pessoas escolhidas e os dados da empresa no ERP novo. Cada passo devolve
 * o que fez; um passo que falhar (por exemplo, o segundo fator para confirmar
 * o regime) não desfaz a área criada e diz o que falta fazer.
 */
async function newCompany(env: Env, request: Request, profile: string, actor: Actor, body: Record<string, any>, requestId: string) {
  if (actor.role !== "admin") throw new ApiError(403, "forbidden", "Só o administrador da conta adiciona empresas. Peça ao administrador.");
  const input = newCompanyInput(body);
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.length > 150 || !/^[\x21-\x7e]+$/.test(key)) bad("Envie Idempotency-Key (até 150 caracteres ASCII).");
  // CNPJ já usado por outra empresa da conta: abre pelo seletor.
  const existing = (await companiesOf(env, actor, profile, new URL(request.url).pathname)).find((c) => c.cnpj && compactKey(c.cnpj) === compactKey(input.identity.cnpj));
  if (existing)
    throw new ApiError(409, "conflict", `Já existe uma empresa com este CNPJ: ${existing.nome_fantasia}. Abra pelo seletor Empresa, no topo do painel.`);
  const created = await coordinatorCommand(env, "_admin", actor, "profile.create", { name: input.trade }, `${key}:empresa:area`, requestId);
  const area = String(created.id);
  const steps: { passo: string; ok: boolean; mensagem?: string }[] = [];
  // Módulos: o ERP e as mesmas partes ligadas nesta empresa, cada uma depois das que ela pede.
  const current = await moduleStates(env, profile);
  const wanted = (ERP_MODULE_IDS as readonly ErpModuleId[]).filter((id) => id === "erp" || current[id] === true);
  const on = { ...(await moduleStates(env, area)) } as Record<string, boolean>;
  for (let round = 0; round < wanted.length + 1; round++) {
    const next = wanted.filter((id) => !on[id] && !missingRequirements(id, on).length);
    if (!next.length) break;
    for (const id of next) {
      try {
        await coordinatorCommand(env, area, actor, "module.set", { id, enabled: true }, `${key}:empresa:modulo:${id}`, requestId);
        on[id] = true;
      } catch (error) {
        steps.push({ passo: `Ligar ${ERP_PART_NAMES[id]}`, ok: false, mensagem: `${(error as Error).message} Ligue em Gestão → Módulos da empresa nova.` });
        on[id] = false;
        wanted.splice(wanted.indexOf(id), 1);
      }
    }
  }
  steps.push({ passo: "Ligar o ERP", ok: !!on.erp, ...(on.erp ? {} : { mensagem: "O ERP não ligou. Ligue em Gestão → Módulos da empresa nova." }) });
  // Pessoas: as escolhidas passam a ter acesso à área nova (o administrador da conta já vê todas).
  if (input.people.length) {
    const rows = await all(env, `SELECT id,role,profiles,disabled FROM users WHERE id IN (${input.people.map(() => "?").join(",")})`, ...input.people);
    const missing = input.people.filter((id) => !rows.some((r: any) => r.id === id));
    const updates = rows.filter((r: any) => r.role !== "admin" && !r.disabled).map((r: any) => {
      const list = parseJson(r.profiles, []) as string[];
      return ["UPDATE users SET profiles=? WHERE id=?", [JSON.stringify(list.includes(area) ? list : [...list, area]), r.id]] as [string, unknown[]];
    });
    if (updates.length) await batch(env, updates as any);
    for (const id of input.people) await audit(env, actor, area, "user.profile_added", id, requestId).catch(() => {});
    steps.push({ passo: "Dar acesso às pessoas", ok: !missing.length, ...(missing.length ? { mensagem: `${missing.length} pessoa(s) não existem mais. Confira em Gestão › Pessoas e acessos.` } : {}) });
  }
  // Dados da empresa no ERP novo e o regime (CRT) confirmado.
  if (on.erp) {
    try {
      const call = await erpPort(env, area, actor, new URL(request.url).pathname, "POST", false, input.trade);
      const now = (await call("erp_company_get", { p_section: "identity" }))?.record;
      if (!now) {
        await call("erp_company_save_identity", { p_expected_version: 0, p_command_id: await commandId(null, `${key}:empresa:dados`, area, "dados", null), p_data: input.identity });
      }
      steps.push({ passo: "Gravar os dados da empresa", ok: true });
      try {
        const fiscal = (await call("erp_company_get", { p_section: "fiscal" }))?.record;
        const identity = (await call("erp_company_get", { p_section: "identity" }))?.record;
        if (fiscal && !fiscal.confirmed_at)
          await call("erp_company_confirm_fiscal", { p_expected_version: Number(fiscal.version), p_expected_identity_version: Number(identity?.version ?? 1),
            p_command_id: await commandId(null, `${key}:empresa:regime`, area, "regime", null), p_crt: input.crt, p_confirmed: true, p_reason: `Regime informado ao adicionar a empresa: ${input.regime}` });
        steps.push({ passo: "Confirmar o regime tributário", ok: true });
      } catch (error) {
        steps.push({ passo: "Confirmar o regime tributário", ok: false, mensagem: `${(error as Error).message} Confirme o regime no ERP da empresa nova, em Configurações › Dados da empresa.` });
      }
    } catch (error) {
      steps.push({ passo: "Gravar os dados da empresa", ok: false, mensagem: `${(error as Error).message} Preencha no ERP da empresa nova, em Configurações › Dados da empresa.` });
    }
  }
  await audit(env, actor, area, "erp.company.created", area, requestId).catch(() => {});
  return { scope: "erp_company_created", area, nome: input.trade, passos: steps };
}

/** Linha do usuário (para testes): a pessoa tem acesso à área? */
export async function userHasArea(env: Env, user: string, area: string) {
  const row = await one(env, "SELECT profiles FROM users WHERE id=?", user);
  return !!row && (parseJson(row.profiles, []) as string[]).includes(area);
}
