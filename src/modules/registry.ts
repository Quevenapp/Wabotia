// Registro dos módulos embutidos e estado ligado/desligado por área de
// atendimento (tabela profile_modules, migração 0020). Contrato:
// docs/MODULOS.md. Este arquivo só depende do banco: service.ts, index.ts e o
// motor o importam sem ciclos.
import { all, exec, one } from "../db";
import { ApiError, type Actor, type Env, now, requireValue } from "../types";
import { admin, canProfile } from "../security";
import { event } from "../events";
import type { ModuleDefinition } from "./types";
import { queueModule } from "./queue";
import { formsModule } from "./forms/definition";
import { agendaModule } from "./agenda/definition";

export type { ModuleDefinition } from "./types";

/** Ordem de exibição na tela Módulos e na rota de capacidades. */
export const modules: readonly ModuleDefinition[] = [
  queueModule,
  formsModule,
  agendaModule,
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

/** Estado de cada módulo a partir das linhas salvas (sem linha: padrão). */
export function resolveStates(saved: Record<string, unknown>): ModuleStates {
  const states: ModuleStates = {};
  for (const m of modules)
    states[m.id] =
      saved && Object.hasOwn(saved, m.id)
        ? !!Number(saved[m.id])
        : m.default_enabled;
  return states;
}

export async function moduleStates(
  env: Env,
  profile: string,
): Promise<ModuleStates> {
  const rows = await all(
    env,
    "SELECT module_id,enabled FROM profile_modules WHERE profile_id=?",
    profile,
  );
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
    menu_item_types: m.menu_item_types,
    events: m.events,
    settings: m.settings,
    scopes: m.scopes,
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
  const before = await moduleEnabled(env, profile, definition.id);
  await exec(
    env,
    "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated,updated_by=excluded.updated_by",
    profile,
    definition.id,
    data.enabled ? 1 : 0,
    now(),
    actor.id,
  );
  if (before !== data.enabled)
    await event(env, profile, "module.changed", definition.id, {
      module_id: definition.id,
      enabled: data.enabled,
      version: definition.version,
      actor: actor.id,
    });
  return moduleView(definition, data.enabled);
}
