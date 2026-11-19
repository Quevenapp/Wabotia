// Registro dos módulos embutidos e estado ligado/desligado por área de
// atendimento (tabela profile_modules, migração 0020). Contrato:
// docs/MODULOS.md. Este arquivo só depende do banco: service.ts, index.ts e o
// motor o importam sem ciclos.
import { all, cachedAll, exec, MODULE_STATES_SQL, one } from "../db";
import { ApiError, type Actor, type Env, now, requireValue } from "../types";
import { admin, canProfile } from "../security";
import { event } from "../events";
import type { ModuleDefinition } from "./types";
import { customerProfileDeclarations } from "../customer/declarations";
import { queueModule } from "./queue";
import { formsModule } from "./forms/definition";
import { agendaModule } from "./agenda/definition";
import { osModule } from "./os/definition";
import { juridicoModule } from "./juridico/definition";
import { condominioModule } from "./condominio/definition";
import { saudeModule } from "./saude/definition";
import { ensinoModule } from "./ensino/definition";
import { paymentsModule } from "./payments/definition";
import { mensalidadeModule } from "./mensalidade/definition";
import { suporteModule } from "./suporte/definition";
import { reservaModule } from "./reserva/definition";
import { pedidoModule } from "./pedido/definition";
import { mesasModule } from "./mesas/definition";
import { entregaModule } from "./entrega/definition";
import {
  erpCobrancaModule,
  erpFiscalModule,
  erpModule,
  erpPdvModule,
} from "./erp/definition";

export type { ModuleDefinition } from "./types";

/** Ordem de exibição na tela Módulos e na rota de capacidades. */
export const modules: readonly ModuleDefinition[] = [
  queueModule,
  formsModule,
  agendaModule,
  osModule,
  // REGISTRO I2 — módulos opcionais, desligados por padrão em cada área.
  juridicoModule,
  condominioModule,
  saudeModule,
  ensinoModule,
  paymentsModule,
  mensalidadeModule,
  suporteModule,
  reservaModule,
  pedidoModule,
  mesasModule,
  entregaModule,
  erpModule,
  erpFiscalModule,
  erpCobrancaModule,
  erpPdvModule,
];

export const moduleById = (id: unknown) =>
  modules.find((m) => m.id === id) || null;

export const moduleForMenuType = (type: unknown) =>
  modules.find((m) => m.menu_item_types.some((t) => t.type === type)) || null;

export const moduleForOperation = (op: string) =>
  modules.find((m) => m.operations.some((prefix) => op.startsWith(prefix))) ||
  null;

/** Módulo dono de /api/v1/profiles/:profile/<segment>/… */
export const moduleForRoute = (segment: string) =>
  modules.find((m) => m.routes.includes(segment)) || null;

/** Todos os tipos de evento declarados pelos módulos. */
export const moduleEvents = () => modules.flatMap((m) => m.events);

/** Tipos de item de menu declarados pelos módulos. */
export const moduleMenuTypes = () =>
  modules.flatMap((m) => m.menu_item_types.map((t) => t.type));

export type ModuleStates = Record<string, boolean>;

/** Estado configurado antes de mascarar módulos cujas dependências estão desligadas. */
export const configuredModuleStates = (saved: Record<string, unknown>): ModuleStates => savedStates(saved, modules);

/** Estado FINAL, sem cascata silenciosa; usado pelo planejador de configurações. */
export function planModuleStates(current: ModuleStates, changes: Record<string, boolean> = {}): ModuleStates {
  const next = { ...current };
  for (const [id, enabled] of Object.entries(changes)) {
    requireValue(moduleById(id) && typeof enabled === "boolean", "Módulo ou estado inválido.");
    next[id] = enabled;
  }
  for (const definition of modules)
    if (next[definition.id] && definition.requires?.some((id) => !next[id]))
      throw new ApiError(409, "dependency_conflict", `Dependências de ${definition.name} desligadas no estado final.`);
  return next;
}

/**
 * Estado de cada módulo a partir das linhas salvas (sem linha: padrão). Um
 * módulo com `requires` conta como desligado se algum requerido estiver
 * desligado, mesmo que a linha dele diga ligado.
 */
export function resolveStates(
  saved: Record<string, unknown>,
  list: readonly ModuleDefinition[] = modules,
): ModuleStates {
  const states = savedStates(saved, list);
  for (let changed = true; changed;) {
    changed = false;
    for (const m of list)
      if (states[m.id] && (m.requires || []).some((r) => !states[r])) {
        states[m.id] = false;
        changed = true;
      }
  }
  return states;
}
/** Estado salvo, sem aplicar as dependências. */
function savedStates(
  saved: Record<string, unknown>,
  list: readonly ModuleDefinition[],
): ModuleStates {
  const states: ModuleStates = {};
  for (const m of list)
    states[m.id] =
      saved && Object.hasOwn(saved, m.id)
        ? !!Number(saved[m.id])
        : m.default_enabled;
  return states;
}

/** Requeridos por `id` que estão desligados (para ligar `id`). */
export function missingRequirements(
  id: string,
  states: ModuleStates,
  list: readonly ModuleDefinition[] = modules,
) {
  const m = list.find((x) => x.id === id);
  return (m?.requires || []).filter((r) => !states[r]);
}

/**
 * Módulos ligados que dependem de `id`, direta ou indiretamente, na ordem
 * de `list` (para desligar `id`).
 */
export function enabledDependents(
  id: string,
  states: ModuleStates,
  list: readonly ModuleDefinition[] = modules,
) {
  const found = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const m of list)
      if (
        states[m.id] &&
        !found.has(m.id) &&
        (m.requires || []).some((r) => r === id || found.has(r))
      ) {
        found.add(m.id);
        changed = true;
      }
  }
  return list.filter((m) => found.has(m.id)).map((m) => m.id);
}

export async function moduleStates(
  env: Env,
  profile: string,
): Promise<ModuleStates> {
  const rows = await cachedAll(env, MODULE_STATES_SQL, profile);
  return resolveStates(
    Object.fromEntries(rows.map((r) => [r.module_id, r.enabled])),
  );
}

export async function moduleEnabled(env: Env, profile: string, id: string) {
  return !!(await moduleStates(env, profile))[id];
}

export function moduleDisabledError(definition: ModuleDefinition) {
  return new ApiError(
    409,
    "module_disabled",
    `O módulo ${definition.name} está desligado nesta área de atendimento. Um administrador pode ligá-lo em Gestão → Módulos.`,
  );
}

/** Recusa com 409 module_disabled quando o módulo está desligado na área. */
export async function requireModule(env: Env, profile: string, id: string) {
  const definition = moduleById(id);
  if (!definition) throw new ApiError(404, "not_found", "Módulo desconhecido.");
  if (!(await moduleEnabled(env, profile, id)))
    throw moduleDisabledError(definition);
}

/** Operações do Coordinator que pertencem a um módulo desligado. */
export async function requireOperation(env: Env, profile: string, op: string) {
  const owner = moduleForOperation(op);
  if (owner) await requireModule(env, profile, owner.id);
}

/** Tipos de item de menu escondidos pelos módulos desligados. */
export function hiddenMenuTypes(states: ModuleStates) {
  return new Set(
    modules
      .filter((m) => !states[m.id])
      .flatMap((m) => m.menu_item_types.map((t) => t.type)),
  );
}

/** Visão pública de um módulo, com o estado na área. */
export function moduleView(m: ModuleDefinition, enabled: boolean) {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    builtin: m.builtin,
    enabled,
    navigation: m.navigation,
    management: m.management ?? [],
    customer_profile: m.customer_profile ?? customerProfileDeclarations[m.id] ?? null,
    menu_item_types: m.menu_item_types,
    events: m.events,
    settings: m.settings,
    scopes: m.scopes,
    requires: m.requires || [],
    // Papel com que o módulo lança no ERP (identidade de sistema), ou null.
    erp_role: m.erp_role ?? null,
  };
}

/** GET /modules: todos os módulos com o estado na área. */
export async function listModules(env: Env, actor: Actor, profile: string) {
  if (!canProfile(actor, profile))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const rows = await all(
    env,
    "SELECT module_id,enabled,updated,updated_by FROM profile_modules WHERE profile_id=?",
    profile,
  );
  const states = resolveStates(
    Object.fromEntries(rows.map((r) => [r.module_id, r.enabled])),
  );
  return {
    data: modules.map((m) => {
      const row = rows.find((r) => r.module_id === m.id);
      return {
        ...moduleView(m, states[m.id]),
        default_enabled: m.default_enabled,
        updated: row?.updated ?? null,
        updated_by: row?.updated_by ?? null,
      };
    }),
  };
}

/** Comandos do registro: "module.set" liga ou desliga um módulo na área. */
export async function moduleCommand(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
) {
  if (op !== "module.set")
    throw new ApiError(404, "not_found", "Operação de módulo desconhecida.");
  admin(actor);
  const definition = moduleById(data?.id);
  requireValue(definition, "Módulo desconhecido.");
  requireValue(
    typeof data.enabled === "boolean",
    "Informe enabled como verdadeiro ou falso.",
  );
  requireValue(
    await one(env, "SELECT id FROM profiles WHERE id=?", profile),
    "Área de atendimento não encontrada.",
  );
  const states = await moduleStates(env, profile);
  const name = (id: string) => moduleById(id)?.name || id;
  // Dependências (requires): não liga sem os requeridos; ao desligar um
  // requerido, avisa quem depende dele e só desliga junto com cascade.
  let cascade: string[] = [];
  if (data.enabled) {
    const missing = missingRequirements(definition.id, states);
    if (missing.length)
      throw new ApiError(
        409,
        "module_requires",
        `${definition.name} depende de ${missing.map(name).join(", ")}. Ligue ${missing.length > 1 ? "esses módulos" : "esse módulo"} antes.`,
      );
  } else {
    cascade = enabledDependents(definition.id, states);
    if (cascade.length && data.cascade !== true)
      throw new ApiError(
        409,
        "module_required",
        `${cascade.map(name).join(", ")} ${cascade.length > 1 ? "dependem" : "depende"} de ${definition.name} e ${cascade.length > 1 ? "serão desligados" : "será desligado"} junto. Confirme com cascade: true.`,
      );
  }
  for (const id of [definition.id, ...cascade]) {
    const target = moduleById(id)!;
    const before = states[id];
    const enabled = id === definition.id ? data.enabled : false;
    await exec(
      env,
      "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated,updated_by=excluded.updated_by",
      profile,
      id,
      enabled ? 1 : 0,
      now(),
      actor.id,
    );
    if (before !== enabled)
      await event(env, profile, "module.changed", id, {
        module_id: id,
        enabled,
        version: target.version,
        actor: actor.id,
        ...(id !== definition.id ? { because: definition.id } : {}),
      });
  }
  return {
    ...moduleView(definition, data.enabled),
    ...(cascade.length ? { also_disabled: cascade } : {}),
  };
}

// REGISTRO RESERVADO F0/I — extensões internas não são novos módulos.
