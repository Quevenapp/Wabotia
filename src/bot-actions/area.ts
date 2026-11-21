// Bots nos módulos de área: Condomínio, Ensino, Jurídico e Saúde. Regra do
// dono: "tudo vai para a IA; quem decide é quem configura". O bloqueio fixo
// (`definition.bot.deny`, que continua tirando esses módulos do catálogo
// comum) virou uma categoria sensível, com padrão conservador:
// - cada operação está no inventário (src/modules/<id>/bot-grants.ts), com
//   nome estável, descrição e o grupo do módulo, e nasce DESLIGADA para todo
//   bot (sem linha em bot_area_grants, migração 0205);
// - ligar é do administrador, pessoa em sessão, com a confirmação do aviso do
//   módulo; desligar também fica registrado (bot_area_grant_log);
// - escrita continua sensível (o bot propõe, a pessoa confirma com o segundo
//   fator da política), salvo se o administrador liberar a execução direta
//   daquela operação para aquele bot, com um segundo aviso;
// - campos sensíveis (prontuário, diagnóstico, documentos) só vão ao bot com
//   "incluir campos sensíveis" ligado para aquele bot e módulo;
// - valem as regras de sempre: só na conversa interna da pessoa com o bot
//   (nunca no atendimento ao cliente, que tem o teto de cliente), e a chamada
//   roda com o acesso da pessoa: o bot nunca faz o que ela não pode.
import { all, batch, one } from "../db";
import { ApiError, type Actor, type Env, now, uid } from "../types";
import { CONDOMINIO_BOT_GRANTS } from "../modules/condominio/bot-grants";
import { ENSINO_BOT_GRANTS } from "../modules/ensino/bot-grants";
import { JURIDICO_BOT_GRANTS } from "../modules/juridico/bot-grants";
import { SAUDE_BOT_GRANTS } from "../modules/saude/bot-grants";
import type { AreaBotModule, AreaBotOperation } from "./area-types";

export type { AreaBotModule, AreaBotOperation } from "./area-types";

/** Módulos de área na ordem da tela do bot. */
export const AREA_BOT_MODULES: readonly AreaBotModule[] = [
  SAUDE_BOT_GRANTS,
  ENSINO_BOT_GRANTS,
  JURIDICO_BOT_GRANTS,
  CONDOMINIO_BOT_GRANTS,
];

export const areaModule = (id: unknown) =>
  AREA_BOT_MODULES.find((m) => m.module === id);

export const areaKind = (op: Pick<AreaBotOperation, "method">) =>
  op.method === "GET" ? ("read" as const) : ("write" as const);

/** Operação do inventário pelo nome estável. */
export function areaOperation(id: unknown) {
  for (const module of AREA_BOT_MODULES) {
    const op = module.operations.find((o) => o.id === id);
    if (op) return { module, op };
  }
  return undefined;
}

/** Operação do inventário pelo método e caminho com :parâmetros. */
export function areaOperationByRoute(method: string, path: string) {
  for (const module of AREA_BOT_MODULES) {
    const op = module.operations.find((o) => o.method === method && o.path === path);
    if (op) return { module, op };
  }
  return undefined;
}

export interface AreaGrants {
  operations: ReadonlySet<string>;
  direct: ReadonlySet<string>;
  /** Módulos com "incluir campos sensíveis" ligado. */
  sensitive: ReadonlySet<string>;
}
const EMPTY: AreaGrants = { operations: new Set(), direct: new Set(), sensitive: new Set() };

/**
 * O que está ligado para este bot na área, relido do banco a cada chamada.
 * Bot desligado ou de outra área: nada. A execução direta só vale junto da
 * operação ligada.
 */
export async function areaBotGrants(env: Env, profile: string, botId: string): Promise<AreaGrants> {
  if (!botId) return EMPTY;
  const rows = await all<{ kind: string; operation: string }>(
    env,
    "SELECT g.kind,g.operation FROM bot_area_grants g JOIN bots b ON b.id=g.bot_id AND b.profile_id=g.profile_id WHERE g.profile_id=? AND g.bot_id=? AND b.enabled=1",
    profile,
    botId,
  );
  const operations = new Set(rows.filter((r) => r.kind === "operation" && areaOperation(r.operation)).map((r) => r.operation));
  return {
    operations,
    direct: new Set(rows.filter((r) => r.kind === "direct" && operations.has(r.operation)).map((r) => r.operation)),
    sensitive: new Set(rows.filter((r) => r.kind === "sensitive_fields" && areaModule(r.operation)).map((r) => r.operation)),
  };
}

/**
 * Concessões do bot pelo qual a pessoa age. Só a pessoa da conversa interna
 * com o bot (`via`); o bot preso a uma conversa de cliente
 * (conversations:bound), aplicação, conector ou credencial nunca recebem.
 */
export async function areaGrantsFor(env: Env, actor: Actor, profile: string): Promise<AreaGrants> {
  if (actor.kind !== "user" || !actor.via || actor.module || actor.credential ||
      actor.id.startsWith("bot:") || actor.scopes?.includes("conversations:bound"))
    return EMPTY;
  return areaBotGrants(env, profile, actor.via.bot_id);
}

/**
 * A pessoa, sem a marca do bot, para os guardas dos módulos de área (que
 * recusam toda chamada por bot). Só se usa depois de conferir, agora, a
 * concessão do administrador para este bot e esta operação: assim vale o
 * acesso da pessoa (papéis clínicos, os:sensitive, professor da turma) e o
 * bot nunca faz por ela o que ela não pode.
 */
export function personFor(actor: Actor): Actor {
  const { via: _via, ...person } = actor;
  return person as Actor;
}

const HIDDEN = "[campo sensível: o administrador não liberou para o bot]";

/** Tira os campos sensíveis da resposta, salvo a opção do bot e módulo. */
export function stripSensitive(module: AreaBotModule, op: AreaBotOperation, value: unknown, include: boolean): unknown {
  if (include) return value;
  const keys = new Set([...module.sensitive_keys, ...(op.sensitive_keys ?? [])]);
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 12) return null;
    if (Array.isArray(item)) return item.map((v) => walk(v, depth + 1));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, v]) => [key, keys.has(key) ? HIDDEN : walk(v, depth + 1)]),
    );
  };
  return walk(value, 0);
}

/** Registro de uso: quem pediu, por qual bot, qual operação. */
export async function logAreaUse(env: Env, profile: string, botId: string, person: string, module: string, operation: string, detail: string) {
  await batch(env, [[
    "INSERT INTO bot_area_grant_log(id,profile_id,bot_id,module,kind,operation,action,actor,detail,created) VALUES(?,?,?,?,'operation',?,'used',?,?,?)",
    [uid(), profile, botId, module, operation, person, detail.slice(0, 200), now()],
  ]]);
}

// ---------------------------------------------------------------------------
// Administração (tela do bot)

const confirmation = (message: string): never => {
  throw new ApiError(400, "confirmation_required", message);
};

export interface AreaGrantInput {
  /** Id do bot (caminho). */
  id: string;
  module: string;
  kind: "operation" | "direct" | "sensitive_fields";
  /** Id da operação; para sensitive_fields, ignorado (vale o módulo). */
  operation?: string;
  enabled: boolean;
  /** A pessoa leu e confirmou o aviso do módulo (ligar operação ou campos sensíveis). */
  confirmed?: boolean;
  /** Segundo aviso: execução direta da escrita. */
  direct_confirmed?: boolean;
}

/**
 * Liga ou desliga, para um bot, uma operação de módulo de área, a execução
 * direta de uma escrita ou "incluir campos sensíveis". Só administrador,
 * pessoa em sessão (nunca pelo bot). Ligar exige a confirmação do aviso; a
 * execução direta, o segundo aviso. Tudo fica no registro.
 */
export async function setAreaBotGrant(env: Env, actor: Actor, profile: string, raw: any) {
  if (actor.kind !== "user" || actor.role !== "admin")
    throw new ApiError(403, "admin_required", "Só o administrador da área libera os módulos de área a um bot.");
  if (actor.via || actor.module || actor.credential || actor.id.startsWith("bot:"))
    throw new ApiError(403, "person_required", "Liberar módulos de área a um bot é só pela tela, pelo próprio administrador; o bot não muda as próprias concessões.");
  const data = (raw && typeof raw === "object" ? raw : {}) as AreaGrantInput;
  const bot = await one(env, "SELECT id FROM bots WHERE id=? AND profile_id=?", data.id, profile);
  if (!bot) throw new ApiError(404, "not_found", "Bot não encontrado nesta área.");
  const module = areaModule(data.module);
  if (!module)
    throw new ApiError(400, "invalid_request", "Escolha um módulo de área: Saúde, Ensino, Jurídico ou Condomínio.");
  if (typeof data.enabled !== "boolean")
    throw new ApiError(400, "invalid_request", "Diga se é para ligar ou desligar.");
  if (!["operation", "direct", "sensitive_fields"].includes(data.kind))
    throw new ApiError(400, "invalid_request", "Escolha o que mudar: a operação, a execução direta ou os campos sensíveis.");
  let operation = module.module as string;
  if (data.kind !== "sensitive_fields") {
    const op = module.operations.find((o) => o.id === data.operation);
    if (!op) throw new ApiError(400, "invalid_request", `Operação desconhecida no módulo ${module.title}. Atualize a página.`);
    operation = op.id;
    if (data.kind === "direct" && areaKind(op) !== "write")
      throw new ApiError(400, "invalid_request", "Consulta não precisa de execução direta: ligada, o bot já consulta.");
  }
  const at = now();
  const log = (kind: string, op: string, action: "on" | "off"): [string, any[]] => [
    "INSERT INTO bot_area_grant_log(id,profile_id,bot_id,module,kind,operation,action,actor,detail,created) VALUES(?,?,?,?,?,?,?,?,'',?)",
    [uid(), profile, data.id, module.module, kind, op, action, actor.id, at],
  ];
  const current = await all<{ kind: string; operation: string }>(
    env, "SELECT kind,operation FROM bot_area_grants WHERE profile_id=? AND bot_id=? AND module=?", profile, data.id, module.module);
  const has = (kind: string, op: string) => current.some((r) => r.kind === kind && r.operation === op);
  const statements: [string, any[]][] = [];
  if (data.enabled) {
    if (data.kind === "direct") {
      if (!has("operation", operation))
        throw new ApiError(409, "operation_off", "Ligue a operação para o bot antes de liberar a execução direta.");
      if (data.direct_confirmed !== true) confirmation(module.direct_warning);
    } else if (data.confirmed !== true) confirmation(data.kind === "sensitive_fields" ? module.sensitive_warning : module.warning);
    if (!has(data.kind, operation))
      statements.push(
        ["INSERT OR IGNORE INTO bot_area_grants(profile_id,bot_id,module,kind,operation,granted_by,granted_at) VALUES(?,?,?,?,?,?,?)",
          [profile, data.id, module.module, data.kind, operation, actor.id, at]],
        log(data.kind, operation, "on"),
      );
  } else {
    // Desligar a operação desliga junto a execução direta dela.
    const kinds = data.kind === "operation" ? ["operation", "direct"] : [data.kind];
    for (const kind of kinds)
      if (has(kind, operation))
        statements.push(
          ["DELETE FROM bot_area_grants WHERE profile_id=? AND bot_id=? AND kind=? AND operation=?", [profile, data.id, kind, operation]],
          log(kind, operation, "off"),
        );
  }
  await batch(env, statements);
  return areaBotModuleState(env, profile, data.id, module);
}

/** Estado de um módulo para um bot: o que está ligado e o registro recente. */
async function areaBotModuleState(env: Env, profile: string, botId: string, module: AreaBotModule) {
  const rows = await all<{ kind: string; operation: string; granted_by: string; granted_at: number }>(
    env, "SELECT kind,operation,granted_by,granted_at FROM bot_area_grants WHERE profile_id=? AND bot_id=? AND module=?", profile, botId, module.module);
  const log = await all(
    env,
    `SELECT l.id,l.kind,l.operation,l.action,l.actor,coalesce(u.name,l.actor) actor_name,l.detail,l.created
     FROM bot_area_grant_log l LEFT JOIN users u ON u.id=l.actor
     WHERE l.profile_id=? AND l.bot_id=? AND l.module=? ORDER BY l.created DESC,l.id LIMIT 40`,
    profile, botId, module.module);
  const on = (kind: string, op: string) => rows.some((r) => r.kind === kind && r.operation === op);
  return {
    module: module.module,
    title: module.title,
    warning: module.warning,
    direct_warning: module.direct_warning,
    sensitive_warning: module.sensitive_warning,
    sensitive_label: module.sensitive_label,
    sensitive_fields: on("sensitive_fields", module.module),
    operations: module.operations.map((op) => ({
      id: op.id,
      title: op.title,
      description: op.description,
      kind: areaKind(op),
      enabled: on("operation", op.id),
      direct: on("operation", op.id) && on("direct", op.id),
    })),
    log: log.map((entry) => ({
      ...entry,
      title: entry.kind === "sensitive_fields" ? "Incluir campos sensíveis"
        : module.operations.find((o) => o.id === entry.operation)?.title ?? entry.operation,
    })),
  };
}

/** Tela do bot: um bloco por módulo de área, com o estado do módulo na área. */
export async function areaBotInventory(env: Env, profile: string, botId: string, states: Readonly<Record<string, boolean>>) {
  const bot = await one(env, "SELECT id FROM bots WHERE id=? AND profile_id=?", botId, profile);
  if (!bot) throw new ApiError(404, "not_found", "Bot não encontrado nesta área.");
  const modules = [];
  for (const module of AREA_BOT_MODULES)
    modules.push({ ...(await areaBotModuleState(env, profile, botId, module)), module_enabled: !!states[module.module] });
  return { modules };
}
