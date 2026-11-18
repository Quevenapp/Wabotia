import { one, PROFILE_SETTINGS_SQL, seedRead, withReadCache } from "../db";
import { admin, canonical, sha } from "../security";
import { ApiError, json, now, type Actor, type Env } from "../types";
import type { SettingsPlan } from "../service";
import { configuredModuleStates, hiddenMenuTypes, planModuleStates } from "../modules/registry";
import type {
  AreaTemplate, AreaTemplateApplyResult, AreaTemplatePreview, AreaTemplateSelection,
  AreaTemplateExportRequest, CustomWorkType, TemplateChange,
} from "../modules/os/contracts";
import { identifier, invalid, list, object, string, validateAreaSetup, validateAreaTemplate, validateSelection } from "./validation";

type Settings = Record<string, any>;
interface Application {
  profile_id: string;
  template_id: string;
  template_version: number;
  manifest_hash: string;
  seen_ids_json: string;
  seen_paths_json: string;
  applied_by: string;
  applied_at: number;
}
const collections = ["os_work_types", "departments", "ticket_categories", "menus"] as const;
const applicationSql = "SELECT * FROM os_area_template_applications WHERE profile_id=? AND template_id=?";
const prefix = (id: string) => `area_${id}__`;
const conflict = (code: string, message: string) => new ApiError(409, code, message);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const savedList = (cfg: Settings, key: string): any[] => Array.isArray(cfg[key]) ? cfg[key] : [];

async function state(env: Env, actor: Actor, profile: string) {
  admin(actor);
  // Um comando pode receber env cacheado: a prévia sempre parte de leitura nova.
  const row = await one(env, PROFILE_SETTINGS_SQL, profile);
  if (!row) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  seedRead(env, { sql: PROFILE_SETTINGS_SQL, args: [profile], first: true }, [row]);
  return { settings: json(row.settings) as Settings, rawModules: json(row.module_states), row };
}

function request(input: unknown, catalog: readonly AreaTemplate[], apply: boolean) {
  const data = object(input, ["manifest", "template_id", "selection", ...(apply ? ["preview_hash"] : [])], "request");
  invalid(Object.hasOwn(data, "manifest") !== Object.hasOwn(data, "template_id"), "source");
  let source = data.manifest;
  if (Object.hasOwn(data, "template_id")) {
    const id = identifier(data.template_id, 32, "template_id");
    source = catalog.find((model) => model.id === id);
    if (!source) throw new ApiError(404, "template_not_found", "Modelo de área não encontrado.");
  }
  const manifest = validateAreaTemplate(source);
  const selection = validateSelection(data.selection, manifest);
  if (apply) invalid(typeof data.preview_hash === "string" && /^[a-f0-9]{64}$/.test(data.preview_hash), "preview_hash");
  return { manifest, selection, previewHash: data.preview_hash as string | undefined };
}

function compile(manifest: AreaTemplate, selection: AreaTemplateSelection, cfg: Settings, modules: Record<string, boolean>, previous: Application | null) {
  const changes: TemplateChange[] = [];
  const conflicts: AreaTemplatePreview["conflicts"] = [];
  const settings: Settings = {};
  const moduleChanges: Record<string, boolean> = {};
  const seenIds = new Set<string>(previous ? json(previous.seen_ids_json, []) : []);
  const seenPaths = new Set<string>(previous ? json(previous.seen_paths_json, []) : []);
  const namespace = prefix(manifest.id);
  const globalId = (id: string) => namespace + id;
  const addConflict = (path: string, code: string, message: string) => conflicts.push({ path, code, message });
  const change = (path: string, action: TemplateChange["action"], reason: string) => changes.push({ path, action, reason });
  // A posse é do prefixo inteiro, inclusive nos menus ocultos e nos blocos não selecionados.
  if (!previous) for (const key of collections) for (const entry of savedList(cfg, key))
    if (typeof entry.id === "string" && entry.id.startsWith(namespace))
      addConflict(`${key}.${entry.id}`, "prefix_conflict", "O prefixo já está ocupado sem procedência deste modelo.");

  const add = (key: string, id: string, value: unknown) => {
    const path = `${key}.${id}`;
    const current = settings[key] || savedList(cfg, key);
    if (current.some((entry: any) => (key === "os_area_setup" ? entry.template_id : entry.id) === id))
      change(path, "keep", "Cadastro existente preservado, inclusive edições manuais.");
    else if (seenIds.has(path)) change(path, "skip", "Item já tratado e removido; não será recriado.");
    else { settings[key] = [...current, value]; change(path, "add", "Novo cadastro do modelo."); }
    seenIds.add(path);
  };
  const scalar = (path: string, old: unknown, write: () => void) => {
    if (seenPaths.has(path)) change(path, old === undefined || old === null || old === "" ? "skip" : "keep", "Caminho já tratado; a escolha manual foi preservada.");
    else if (old !== undefined && old !== null && old !== "") change(path, "keep", "Valor já preenchido foi preservado.");
    else { write(); change(path, "set", "Preenche um caminho ainda não tratado."); }
    seenPaths.add(path);
  };
  for (const type of manifest.work_types) if (selection.work_type_ids.includes(type.id))
    add("os_work_types", globalId(type.id), { ...type, id: globalId(type.id) });
  if (selection.work_type_ids.includes("service_order"))
    change("os_work_types.service_order", "keep", "Tipo embutido virtual; definição e configurações permanecem intactas.");
  for (const key of ["departments", "ticket_categories"] as const) if (selection[key])
    for (const item of manifest[key]) add(key, globalId(item.id), { ...item, id: globalId(item.id) });
  if (selection.vocabulary) for (const [key, value] of Object.entries(manifest.vocabulary))
    scalar(`os_vocabulary.${key}`, cfg.os_vocabulary?.[key], () => {
      settings.os_vocabulary = { ...(settings.os_vocabulary || cfg.os_vocabulary || {}), [key]: value };
    });
  if (selection.texts) for (const [key, value] of Object.entries(manifest.texts).sort(([a], [b]) => a.localeCompare(b)))
    scalar(key, cfg[key], () => { settings[key] = value; });
  if (selection.bot_suggestions) {
    const setup = { template_id: manifest.id, bot: manifest.bot, manual_steps: manifest.manual_steps };
    add("os_area_setup", manifest.id, setup);
    if (settings.os_area_setup) settings.os_area_setup = validateAreaSetup(settings.os_area_setup);
  }
  for (const id of selection.module_ids) {
    const path = `modules.${id}`;
    if (seenPaths.has(path)) change(path, "keep", "Estado manual posterior do módulo preservado.");
    else {
      const enabled = manifest.modules[id]!;
      moduleChanges[id] = enabled;
      change(path, modules[id] === enabled ? "keep" : "set", modules[id] === enabled ? "Módulo já está no estado selecionado." : "Estado selecionado para a primeira aplicação deste caminho.");
    }
    seenPaths.add(path);
  }
  let finalModules = { ...modules, ...moduleChanges };
  try { finalModules = planModuleStates(modules, moduleChanges); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    addConflict("modules", "dependency_conflict", error.message);
  }
  if (selection.menus) for (const menu of manifest.menus) {
    const id = globalId(menu.id), path = `menus.${id}`;
    // Preservados e removidos não precisam reconstruir suas antigas referências.
    const exists = savedList(cfg, "menus").some((entry) => entry.id === id);
    if (exists || seenIds.has(path)) { add("menus", id, menu); continue; }
    const compiled: Settings = { ...menu, id, enabled: true, parent_id: null };
    if (menu.type === "os_open" || menu.type === "os_track") {
      const builtin = menu.type_id === "service_order";
      const typeId = builtin ? "service_order" : globalId(menu.type_id);
      const type = (settings.os_work_types || savedList(cfg, "os_work_types")).find((t: CustomWorkType) => t.id === typeId);
      if ((builtin || !type) && !selection.work_type_ids.includes(menu.type_id)) {
        change(path, "skip", "Menu de um tipo não selecionado; poderá ser incluído em outra aplicação.");
        continue;
      }
      if (!finalModules.os) addConflict(path, "dependency_conflict", "O menu exige o módulo os ligado no estado final.");
      if (!builtin && !type) addConflict(path, "reference_conflict", "O tipo referenciado foi removido e não será recriado.");
      if (menu.type === "os_open" && type?.archived) addConflict(path, "reference_conflict", "O tipo referenciado está arquivado.");
      compiled.type_id = typeId;
    } else if (menu.type === "human" && menu.department_id !== null) {
      compiled.department_id = globalId(menu.department_id);
      if (!(settings.departments || savedList(cfg, "departments")).some((d: any) => d.id === compiled.department_id))
        addConflict(path, "reference_conflict", "Selecione um setor existente no estado final para este menu.");
    } else if (menu.type === "message") compiled.type = "content";
    add("menus", id, compiled);
  }
  // F0 recebe apenas menus visíveis; ele próprio conserva todos os ocultos.
  if (settings.menus) {
    const hidden = hiddenMenuTypes(finalModules);
    settings.menus = settings.menus.filter((menu: any) => !hidden.has(menu.type));
  }
  if (settings.os_work_types && settings.os_work_types.length > 20)
    addConflict("os_work_types", "collection_limit", "A área admite até 20 tipos personalizados, incluindo arquivados.");
  return { changes, conflicts, settings, modules: finalModules, seenIds: [...seenIds].sort(), seenPaths: [...seenPaths].sort() };
}

async function prepare(env: Env, actor: Actor, profile: string, input: unknown, catalog: readonly AreaTemplate[], apply: boolean) {
  admin(actor);
  const parsed = request(input, catalog, apply);
  env = withReadCache(env);
  const current = await state(env, actor, profile);
  const previous: Application | null = await one(env, applicationSql, profile, parsed.manifest.id);
  const baseRevision = await sha(canonical(current.settings));
  const modulesRevision = await sha(canonical(current.rawModules));
  const manifestHash = await sha(canonical(parsed.manifest));
  const result = compile(parsed.manifest, parsed.selection, current.settings, configuredModuleStates(current.rawModules), previous);
  if (previous && (parsed.manifest.version < previous.template_version ||
    (parsed.manifest.version === previous.template_version && manifestHash !== previous.manifest_hash)))
    result.conflicts.push({ path: "version", code: "template_version_conflict", message: "Altere a versão ao modificar o manifesto; não reaplique uma versão anterior." });
  let plan: SettingsPlan | null = null;
  try {
    // runtime.ts importa o descritor; evitar ciclo de inicialização com service.ts.
    const { planSettings } = await import("../service");
    plan = await planSettings(env, actor, profile, result.settings, { modules: result.modules, expected_revision: baseRevision });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    result.conflicts.push({ path: "settings", code: error.code === "dependency_conflict" ? error.code : "settings_invalid", message: error.message });
  }
  const preview: AreaTemplatePreview = {
    preview_hash: await sha(canonical({
      profile, manifest: parsed.manifest, selection: parsed.selection,
      base_revision: baseRevision, modules_revision: modulesRevision, modules: current.rawModules,
      provenance: previous, result, planned_settings_revision: plan?.settings_revision ?? null,
    })),
    template_id: parsed.manifest.id, template_version: parsed.manifest.version,
    changes: result.changes, conflicts: result.conflicts,
    manual_steps: parsed.manifest.manual_steps, can_apply: result.conflicts.length === 0,
  };
  return { env, parsed, previous, baseRevision, manifestHash, result, plan, preview };
}

export async function previewAreaTemplate(env: Env, actor: Actor, profile: string, input: unknown, catalog: readonly AreaTemplate[] = []): Promise<AreaTemplatePreview> {
  return (await prepare(env, actor, profile, input, catalog, false)).preview;
}

/** Chamado exclusivamente pelo comando serializado do Coordinator. */
export async function applyAreaTemplate(env: Env, actor: Actor, profile: string, input: unknown, catalog: readonly AreaTemplate[] = []): Promise<AreaTemplateApplyResult> {
  const p = await prepare(env, actor, profile, input, catalog, true);
  if (p.parsed.previewHash !== p.preview.preview_hash) throw conflict("preview_stale", "A prévia mudou. Revise uma nova prévia antes de aplicar.");
  if (!p.preview.can_apply || !p.plan) throw conflict(
    p.preview.conflicts.some((c) => c.code === "dependency_conflict") ? "dependency_conflict" : "template_conflict",
    "O modelo tem conflitos. Revise a prévia antes de aplicar.",
  );
  const changed = p.result.changes.some((c) => c.action === "add" || c.action === "set");
  const provenanceChanged = !p.previous || p.previous.template_version !== p.parsed.manifest.version || p.previous.manifest_hash !== p.manifestHash ||
    !same(json(p.previous.seen_ids_json, []), p.result.seenIds) || !same(json(p.previous.seen_paths_json, []), p.result.seenPaths);
  let revision = p.baseRevision;
  if (changed || provenanceChanged) {
    try {
      const { commitSettingsPlan } = await import("../service");
      const saved = await commitSettingsPlan(p.env, actor, p.plan, [[
        "INSERT INTO os_area_template_applications(profile_id,template_id,template_version,manifest_hash,seen_ids_json,seen_paths_json,applied_by,applied_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,template_id) DO UPDATE SET template_version=excluded.template_version,manifest_hash=excluded.manifest_hash,seen_ids_json=excluded.seen_ids_json,seen_paths_json=excluded.seen_paths_json,applied_by=excluded.applied_by,applied_at=excluded.applied_at",
        [profile, p.parsed.manifest.id, p.parsed.manifest.version, p.manifestHash, JSON.stringify(p.result.seenIds), JSON.stringify(p.result.seenPaths), actor.id, now()],
      ]]);
      revision = saved.settings_revision;
    } catch (error) {
      if (error instanceof ApiError && error.code === "settings_conflict") throw conflict("preview_stale", "A configuração mudou durante a aplicação. Refaça a prévia.");
      throw error;
    }
  }
  return { applied: changed, changes: p.preview.changes, manual_steps: p.preview.manual_steps, settings_revision: revision };
}

/** Exportação por lista permitida: definições, nunca ordens, membros, canais ou configurações do bot. */
export async function exportAreaTemplate(env: Env, actor: Actor, profile: string, input: unknown): Promise<AreaTemplate> {
  admin(actor);
  let data: AreaTemplateExportRequest;
  try {
    const v = object(input, ["id", "name", "type_ids"], "export");
    const typeIds = list(v.type_ids, 21, "type_ids", (id, path) => identifier(id, 64, path));
    invalid(typeIds.length > 0 && new Set(typeIds).size === typeIds.length, "type_ids");
    data = { id: identifier(v.id, 32, "id"), name: string(v.name, 80, "name"), type_ids: typeIds };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw new ApiError(400, "invalid_export", "Informe id, name e type_ids válidos para exportar.");
  }
  const current = await state(env, actor, profile);
  const workTypes: CustomWorkType[] = [];
  const menus: AreaTemplate["menus"] = [];
  for (const [i, id] of data.type_ids.entries()) {
    const localId = id === "service_order" ? id : `tipo_${i + 1}`;
    if (id !== "service_order") {
      const type = savedList(current.settings, "os_work_types").find((t) => t.id === id);
      if (!type) throw new ApiError(404, "type_not_found", "Tipo de trabalho não encontrado nesta área.");
      // A validação estrita abaixo recusa propriedades de runtime ou valores extras.
      workTypes.push({ ...structuredClone(type), id: localId, revision: 1 });
    }
    const type = workTypes.find((t) => t.id === localId);
    if (!type?.archived && (id === "service_order" || type?.features.customer_open))
      menus.push({ id: `abrir_${i + 1}`, label: type?.labels.singular || "Ordem de serviço", type: "os_open", type_id: localId });
    menus.push({ id: `acompanhar_${i + 1}`, label: type?.labels.plural || "Ordens de serviço", type: "os_track", type_id: localId });
  }
  return validateAreaTemplate({
    schema_version: 1, id: data.id, version: 1, name: data.name, description: "Definições de tipos de trabalho exportadas, sem registros de atendimento.",
    work_types: workTypes, modules: { os: true },
    vocabulary: { collection_label: workTypes.length ? "Trabalhos" : "Ordens de serviço", customer_singular: "Cliente", customer_plural: "Clientes" },
    departments: [], ticket_categories: [], menus, texts: {},
    bot: { instructions: "", allowed_operations: [], denied_operations: [], suggested_roles: [] }, manual_steps: [],
  });
}
