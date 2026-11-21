// Pegada de um modelo de área (migração 0160): o que ele ligou e criou, para
// "Desfazer este modelo" e trocar de ramo; os exemplos da Agenda e da
// Mensalidade; e a escolha do ramo no primeiro acesso. Desfazer só desliga o
// que o modelo ligou sozinho e só remove o que ninguém alterou nem usou; o que
// ficou volta no relatório com o motivo, em linguagem de dono de negócio.
import { all, exec, one, PROFILE_SETTINGS_SQL, withReadCache } from "../db";
import { admin, canonical, sha } from "../security";
import { ApiError, json, now, uid, type Actor, type Env } from "../types";
import { configuredModuleStates, enabledDependents, moduleById, planModuleStates } from "../modules/registry";
import type { SettingsPlan } from "../service";
import type { TemplateChange } from "../modules/os/contracts";
import type { AreaTemplate } from "./validation";
import { identifier, invalid, moduleOfMenuType, object } from "./validation";
import { EXAMPLE_NOTE, templateExamples, type ErpExamples } from "./examples";
import { segmentById, segmentOfTemplate } from "./segments";

type Settings = Record<string, any>;
type Statement = [string, any[]];
export interface FootprintItem { key: string; id: string; hash: string; label: string; archived_by_undo?: boolean }
const ARCHIVED = new Set(["os_work_types", "os_object_types"]);
export interface FootprintScalar { path: string; hash: string }
/** erp_*: financeiro e catálogo de exemplo no ERP (erp-examples.ts), conferidos e apagados pelas rotas do ERP. */
export type ExampleKind = "agenda_service" | "agenda_professional" | "mensalidade_plan" | "erp_payment_method" | "erp_finance_category" | "erp_finance_account" | "erp_product";
const erpKind = (kind: string) => kind.startsWith("erp_");
const exampleGroup = (kind: string) => kind === "erp_product" ? "examples.catalogo" : erpKind(kind) ? "examples.financeiro" : kind === "mensalidade_plan" ? "examples.mensalidade" : "examples.agenda";
/** updated: `updated` da linha (Agenda e Mensalidade) ou a versão no ERP. */
export interface FootprintExample { kind: ExampleKind; id: string; label: string; updated: number }
export interface Footprint {
  template_id: string;
  status: "applied" | "undone";
  modules: string[];
  items: FootprintItem[];
  scalars: FootprintScalar[];
  examples: FootprintExample[];
  report: UndoReport | Record<string, never>;
  applied_at: number;
  undone_at: number | null;
}
export interface UndoReport {
  template_id: string;
  template_name: string;
  modules_off: string[];
  removed: string[];
  kept: Array<{ label: string; reason: string }>;
}
export interface UndoPreview extends UndoReport { preview_hash: string; can_undo: boolean }

const FINANCE_PARTS = ["erp-financeiro", "erp-vendas", "erp-pdv"];
const COLLECTIONS = ["os_work_types", "os_object_types", "departments", "ticket_categories", "menus", "os_area_setup"] as const;
const FOOTPRINT_SQL = "SELECT * FROM area_template_footprints WHERE profile_id=? AND template_id=?";
const savedList = (cfg: Settings, key: string): any[] => Array.isArray(cfg[key]) ? cfg[key] : [];
const entryId = (key: string, entry: any) => key === "os_area_setup" ? entry?.template_id : entry?.id;
const hashOf = (value: unknown) => sha(canonical(value ?? null));
const moduleName = (id: string) => moduleById(id)?.name ?? id;
const KEY_NOUN: Record<string, string> = {
  os_work_types: "Modelo de ordem", os_object_types: "Tipo de objeto", departments: "Setor",
  ticket_categories: "Categoria de protocolo", menus: "Opção do menu do WhatsApp", os_area_setup: "Sugestões para o robô",
};
function itemLabel(key: string, entry: any) {
  const name = entry?.labels?.plural || entry?.name || entry?.label || entry?.labels?.singular || entryId(key, entry);
  return key === "os_area_setup" ? KEY_NOUN[key] : `${KEY_NOUN[key] ?? key} "${name}"`;
}
const SCALAR_LABEL: Record<string, string> = {
  instructions: "Instruções do atendimento", menu_greeting: "Saudação do menu", protocol_confirmation: "Mensagem de confirmação do protocolo",
};
const scalarLabel = (path: string) => path.startsWith("os_vocabulary.") ? "Vocabulário das ordens" : SCALAR_LABEL[path] ?? path;
const scalarValue = (cfg: Settings, path: string) => path.startsWith("os_vocabulary.") ? cfg.os_vocabulary?.[path.slice(14)] : cfg[path];

function rowToFootprint(row: any): Footprint {
  return {
    template_id: row.template_id, status: row.status === "undone" ? "undone" : "applied",
    modules: json(row.modules_json, []), items: json(row.items_json, []), scalars: json(row.scalars_json, []),
    examples: json(row.examples_json, []), report: json(row.report_json, {}),
    applied_at: Number(row.applied_at), undone_at: row.undone_at === null || row.undone_at === undefined ? null : Number(row.undone_at),
  };
}
export async function readFootprint(env: Env, profile: string, templateId: string): Promise<Footprint | null> {
  const row = await one(env, FOOTPRINT_SQL, profile, templateId);
  return row ? rowToFootprint(row) : null;
}

/** Modelos de ordem e tipos de objeto que o desfazer arquivou e ninguém mexeu desde então. */
export async function restorablePaths(footprint: Footprint | null, cfg: Settings): Promise<Set<string>> {
  const paths = new Set<string>();
  if (footprint?.status !== "undone") return paths;
  for (const item of footprint.items) if (item.archived_by_undo) {
    const entry = savedList(cfg, item.key).find((candidate) => entryId(item.key, candidate) === item.id);
    if (entry?.archived && await hashOf(entry) === item.hash) paths.add(`${item.key}.${item.id}`);
  }
  return paths;
}

/* ------------------------------------------------------------------ */
/* Exemplos (Agenda e Mensalidade)                                     */
/* ------------------------------------------------------------------ */

export interface ExamplePlan { changes: TemplateChange[]; seen: string[]; build: (actor: Actor) => { statements: Statement[]; examples: FootprintExample[] } }
/**
 * Exemplos do modelo, só quando o módulo faz parte do modelo e fica ligado,
 * a área ainda não tem cadastros daquele tipo e o caminho não foi tratado
 * antes (o exemplo apagado não volta). Nada sobrescreve o que já existe.
 */
export async function planExamples(env: Env, profile: string, manifest: AreaTemplate, modules: Record<string, boolean>, seenPaths: ReadonlySet<string>): Promise<ExamplePlan> {
  const examples = templateExamples(manifest);
  const changes: TemplateChange[] = [], seen: string[] = [];
  const builders: Array<(actor: Actor, at: number) => { statements: Statement[]; examples: FootprintExample[] }> = [];
  if (examples.agenda && modules.agenda) {
    const path = "examples.agenda";
    if (seenPaths.has(path)) changes.push({ path, action: "skip", reason: "Os exemplos da Agenda já foram tratados antes; não serão recriados." });
    else {
      const count = await one(env, "SELECT (SELECT COUNT(*) FROM agenda_services WHERE profile_id=? AND archived=0) services,(SELECT COUNT(*) FROM agenda_professionals WHERE profile_id=? AND archived=0) professionals", profile, profile);
      if (Number(count?.services) || Number(count?.professionals))
        changes.push({ path, action: "keep", reason: "A Agenda já tem serviços ou profissionais cadastrados; nada de exemplo será criado." });
      else {
        const agenda = examples.agenda;
        changes.push({ path, action: "add", reason: `Horário de funcionamento (seg. a sex. 8h às 18h, sáb. 8h às 12h, editável), o profissional "${agenda.professional}" ligado a você e ${agenda.services.length} serviço(s) de exemplo na Agenda.` });
        builders.push((actor, at) => {
          const professional = uid();
          const services = agenda.services.map((service) => ({ ...service, id: uid() }));
          return {
            statements: [
              ...services.map((service, position): Statement => [
                "INSERT INTO agenda_services(id,profile_id,name,description,duration_minutes,price_cents,active,position,archived,created,updated) VALUES(?,?,?,?,?,?,1,?,0,?,?)",
                [service.id, profile, service.name, EXAMPLE_NOTE, service.duration_minutes, service.price_cents, position, at, at],
              ]),
              // Ligado ao administrador que aplica o modelo (uma chave de aplicativo não é pessoa da equipe).
              ["INSERT INTO agenda_professionals(id,profile_id,name,user_id,active,position,archived,created,updated) VALUES(?,?,?,?,1,0,0,?,?)",
                [professional, profile, agenda.professional, actor.kind === "user" ? actor.id : null, at, at]],
              ...services.map((service): Statement => ["INSERT INTO agenda_professional_services(profile_id,professional_id,service_id) VALUES(?,?,?)", [profile, professional, service.id]]),
              ...agenda.hours.map((hour): Statement => ["INSERT INTO agenda_hours(profile_id,professional_id,weekday,start_minute,end_minute) VALUES(?,?,?,?,?)", [profile, professional, hour.weekday, hour.start_minute, hour.end_minute]]),
            ],
            examples: [
              ...services.map((service): FootprintExample => ({ kind: "agenda_service", id: service.id, label: `Serviço "${service.name}" na Agenda`, updated: at })),
              { kind: "agenda_professional", id: professional, label: `"${agenda.professional}" e o horário de funcionamento na Agenda`, updated: at },
            ],
          };
        });
      }
    }
    seen.push(path);
  }
  if (examples.mensalidade && modules.mensalidade) {
    const path = "examples.mensalidade";
    if (seenPaths.has(path)) changes.push({ path, action: "skip", reason: "Os planos de exemplo da Mensalidade já foram tratados antes; não serão recriados." });
    else {
      const count = await one(env, "SELECT COUNT(*) n FROM mensalidade_plans WHERE profile_id=?", profile);
      if (Number(count?.n)) changes.push({ path, action: "keep", reason: "A Mensalidade já tem planos cadastrados; nenhum plano de exemplo será criado." });
      else {
        const plans = examples.mensalidade.plans;
        changes.push({ path, action: "add", reason: `${plans.length === 1 ? "Plano" : "Planos"} de exemplo na Mensalidade, desativados até você revisar: ${plans.map((plan) => `"${plan.name}"`).join(", ")}.` });
        builders.push((actor, at) => {
          const created = plans.map((plan) => ({ ...plan, id: uid() }));
          return {
            // Desativados (active=0): ninguém assina um plano de exemplo antes de a pessoa revisar valor e vencimento.
            statements: created.map((plan): Statement => ["INSERT INTO mensalidade_plans(id,profile_id,name,amount_cents,period,due_day,active,created_by,created,updated,description) VALUES(?,?,?,?,?,?,0,?,?,?,?)",
              [plan.id, profile, plan.name, plan.amount_cents, plan.period, plan.due_day, actor.id, at, at, EXAMPLE_NOTE]]),
            examples: created.map((plan): FootprintExample => ({ kind: "mensalidade_plan", id: plan.id, label: `Plano "${plan.name}" na Mensalidade`, updated: at })),
          };
        });
      }
    }
    seen.push(path);
  }
  // Financeiro básico e catálogo no ERP: a aplicação só registra o que falta
  // montar; o alarme da área monta quando o ERP estiver de pé, cada tipo só se
  // não houver nenhum (erp-examples.ts). A conferência "já existe" é do ERP, na montagem.
  const erp: ErpExamples = {};
  if (examples.financeiro && modules.erp && FINANCE_PARTS.some((id) => modules[id])) {
    const path = "examples.financeiro";
    if (seenPaths.has(path)) changes.push({ path, action: "skip", reason: "O financeiro de exemplo do ERP já foi tratado antes; não será recriado." });
    else {
      const finance = { ...examples.financeiro };
      if (!modules["erp-financeiro"]) { finance.categories = []; finance.account = null; }
      changes.push({ path, action: "add", reason: finance.account
        ? "Formas de pagamento básicas, categorias financeiras e a conta Caixa de exemplo no ERP (só os tipos que ainda não têm cadastro; montados assim que o ERP estiver de pé)."
        : "Formas de pagamento básicas de exemplo no ERP (só se ainda não houver nenhuma; montadas assim que o ERP estiver de pé)." });
      Object.assign(erp, finance);
    }
    seen.push(path);
  }
  if (examples.catalogo && modules.erp && modules["erp-produtos"]) {
    const path = "examples.catalogo";
    if (seenPaths.has(path)) changes.push({ path, action: "skip", reason: "O catálogo de exemplo do ERP já foi tratado antes; não será recriado." });
    else {
      changes.push({ path, action: "add", reason: `${examples.catalogo.items.length} produtos e serviços de exemplo em Produtos e serviços do ERP (só se o catálogo ainda estiver vazio; montados assim que o ERP estiver de pé).` });
      erp.products = examples.catalogo.items;
    }
    seen.push(path);
  }
  if (Object.keys(erp).length) {
    // Uma linha por modelo: o que ainda espera o ERP de uma aplicação anterior não se perde.
    const waiting = await one(env, "SELECT examples_json FROM area_template_erp_examples WHERE profile_id=? AND template_id=? AND state='pendente'", profile, manifest.id);
    const pending: ErpExamples = { ...(waiting ? json(waiting.examples_json, {}) : {}), ...erp };
    builders.push((actor, at) => ({
      statements: [["INSERT INTO area_template_erp_examples(profile_id,template_id,state,actor,examples_json,attempts,next_at,note,created,updated) VALUES(?,?,'pendente',?,?,0,NULL,NULL,?,?) ON CONFLICT(profile_id,template_id) DO UPDATE SET state='pendente',actor=excluded.actor,examples_json=excluded.examples_json,attempts=0,next_at=NULL,note=NULL,updated=excluded.updated",
        [profile, manifest.id, actor.id, JSON.stringify(pending), at, at]]],
      examples: [],
    }));
  }
  return {
    changes, seen,
    build: (actor) => {
      const at = now();
      const built = builders.map((build) => build(actor, at));
      return { statements: built.flatMap((entry) => entry.statements), examples: built.flatMap((entry) => entry.examples) };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Pegada gravada na aplicação                                          */
/* ------------------------------------------------------------------ */

/** SQL da pegada, no mesmo lote da aplicação do modelo. */
export async function footprintStatements(input: {
  profile: string; actor: Actor; manifest: AreaTemplate; catalogTemplate: boolean;
  previous: Footprint | null; modulesBefore: Record<string, boolean>; plan: SettingsPlan;
  changes: TemplateChange[]; examples: FootprintExample[];
}): Promise<Statement[]> {
  const { profile, actor, manifest, plan } = input;
  const keep = input.previous?.status === "applied" ? input.previous : null;
  const modules = new Set(keep?.modules ?? []);
  for (const change of plan.module_changes) if (change.enabled && !input.modulesBefore[change.id]) modules.add(change.id);
  const items = new Map((keep?.items ?? []).map((item) => [`${item.key}.${item.id}`, item]));
  const scalars = new Map((keep?.scalars ?? []).map((item) => [item.path, item]));
  for (const change of input.changes) {
    const dot = change.path.indexOf(".");
    const key = change.path.slice(0, dot), id = change.path.slice(dot + 1);
    if ((change.action === "add" || change.action === "set") && (COLLECTIONS as readonly string[]).includes(key)) {
      const entry = savedList(plan.settings, key).find((candidate) => entryId(key, candidate) === id);
      if (entry) items.set(change.path, { key, id, hash: await hashOf(entry), label: itemLabel(key, entry) });
    } else if (change.action === "set" && !change.path.startsWith("modules.")) {
      scalars.set(change.path, { path: change.path, hash: await hashOf(scalarValue(plan.settings, change.path)) });
    }
  }
  const examples = [...(keep?.examples ?? []), ...input.examples];
  const at = now();
  const statements: Statement[] = [[
    "INSERT INTO area_template_footprints(profile_id,template_id,status,modules_json,items_json,scalars_json,examples_json,report_json,applied_by,applied_at,undone_by,undone_at) VALUES(?,?,'applied',?,?,?,?,'{}',?,?,NULL,NULL) ON CONFLICT(profile_id,template_id) DO UPDATE SET status='applied',modules_json=excluded.modules_json,items_json=excluded.items_json,scalars_json=excluded.scalars_json,examples_json=excluded.examples_json,report_json='{}',applied_by=excluded.applied_by,applied_at=excluded.applied_at,undone_by=NULL,undone_at=NULL",
    [profile, manifest.id, JSON.stringify([...modules].sort()), JSON.stringify([...items.values()]), JSON.stringify([...scalars.values()]), JSON.stringify(examples), actor.id, at],
  ]];
  // Modelo do catálogo aplicado responde "Qual é o seu negócio?".
  if (input.catalogTemplate) statements.push([
    "INSERT INTO profile_segment_choice(profile_id,status,segment_id,template_id,reminder_dismissed,updated,updated_by) VALUES(?,'chosen',?,?,1,?,?) ON CONFLICT(profile_id) DO UPDATE SET status='chosen',segment_id=excluded.segment_id,template_id=excluded.template_id,reminder_dismissed=1,updated=excluded.updated,updated_by=excluded.updated_by",
    [profile, segmentOfTemplate(manifest.id)?.id ?? null, manifest.id, at, actor.id],
  ]);
  return statements;
}

/* ------------------------------------------------------------------ */
/* Desfazer este modelo                                                 */
/* ------------------------------------------------------------------ */

async function usage(env: Env, profile: string, key: string, id: string): Promise<string | null> {
  const count = async (sql: string, ...args: unknown[]) => Number((await one(env, sql, ...args))?.n ?? 0);
  if (key === "os_work_types") {
    const n = await count("SELECT COUNT(*) n FROM os_orders WHERE profile_id=? AND type_id=?", profile, id);
    return n ? `já tem ${n} ${n === 1 ? "ordem aberta" : "ordens abertas"} com ele` : null;
  }
  if (key === "os_object_types") {
    const n = await count("SELECT COUNT(*) n FROM os_objects WHERE profile_id=? AND type_id=?", profile, id);
    return n ? `já tem ${n} ${n === 1 ? "cadastro" : "cadastros"} desse tipo` : null;
  }
  if (key === "departments") {
    const n = await count("SELECT COUNT(*) n FROM conversations WHERE profile_id=? AND department_id=?", profile, id);
    return n ? `já recebeu ${n} ${n === 1 ? "conversa" : "conversas"}` : null;
  }
  if (key === "ticket_categories") {
    const n = await count("SELECT COUNT(*) n FROM tickets WHERE profile_id=? AND category=?", profile, id);
    return n ? `já tem ${n} ${n === 1 ? "protocolo" : "protocolos"}` : null;
  }
  return null;
}
async function exampleState(env: Env, profile: string, example: FootprintExample): Promise<"gone" | "changed" | "used" | "free"> {
  const table = ({ agenda_service: "agenda_services", agenda_professional: "agenda_professionals", mensalidade_plan: "mensalidade_plans" } as Record<string, string>)[example.kind];
  if (!table) return "changed";
  const row = await one(env, `SELECT updated FROM ${table} WHERE id=? AND profile_id=?`, example.id, profile);
  if (!row) return "gone";
  if (Number(row.updated) !== example.updated) return "changed";
  const used = example.kind === "mensalidade_plan"
    ? await one(env, "SELECT 1 x FROM mensalidade_subscriptions WHERE profile_id=? AND plan_id=? LIMIT 1", profile, example.id)
    : await one(env, `SELECT 1 x FROM agenda_appointments WHERE profile_id=? AND ${example.kind === "agenda_service" ? "service_id" : "professional_id"}=? LIMIT 1`, profile, example.id);
  return used ? "used" : "free";
}
const exampleDeletes = (profile: string, example: FootprintExample): Statement[] => example.kind === "mensalidade_plan"
  ? [["DELETE FROM mensalidade_plans WHERE id=? AND profile_id=?", [example.id, profile]]]
  : example.kind === "agenda_service"
    ? [["DELETE FROM agenda_professional_services WHERE profile_id=? AND service_id=?", [profile, example.id]], ["DELETE FROM agenda_services WHERE id=? AND profile_id=?", [example.id, profile]]]
    : [["DELETE FROM agenda_hours WHERE profile_id=? AND professional_id=?", [profile, example.id]],
      ["DELETE FROM agenda_professional_services WHERE profile_id=? AND professional_id=?", [profile, example.id]],
      ["DELETE FROM agenda_professionals WHERE id=? AND profile_id=?", [example.id, profile]]];

interface UndoComputation {
  report: UndoReport; settings: Settings; modules: Record<string, boolean>; removedMenus: Set<string>;
  remaining: Pick<Footprint, "modules" | "items" | "scalars" | "examples">; statements: Statement[];
  forgetIds: Set<string>; forgetPaths: Set<string>;
  /** Exemplos do ERP sem alteração: apagados pelo ERP no desfazer (o que tiver uso fica). */
  erpDeletes: FootprintExample[];
}
async function computeUndo(env: Env, profile: string, footprint: Footprint, catalog: readonly AreaTemplate[], cfg: Settings, current: Record<string, boolean>, actor?: Actor): Promise<UndoComputation> {
  const manifest = catalog.find((entry) => entry.id === footprint.template_id);
  const report: UndoReport = { template_id: footprint.template_id, template_name: manifest?.name ?? footprint.template_id, modules_off: [], removed: [], kept: [] };
  const remaining: UndoComputation["remaining"] = { modules: [], items: [], scalars: [], examples: [] };
  const forgetIds = new Set<string>(), forgetPaths = new Set<string>();
  // Módulos: só os que este modelo ligou, que outro modelo aplicado não usa.
  const others = (await all(env, "SELECT * FROM area_template_footprints WHERE profile_id=? AND template_id<>? AND status='applied'", profile, footprint.template_id)).map(rowToFootprint);
  const usedBy = (id: string) => others.find((other) => other.modules.includes(id) || catalog.find((entry) => entry.id === other.template_id)?.modules[id] === true);
  const off = new Set<string>();
  for (const id of footprint.modules) {
    if (!current[id]) continue;
    const other = usedBy(id);
    if (other) { report.kept.push({ label: `Módulo ${moduleName(id)}`, reason: `continua ligado porque o modelo "${catalog.find((entry) => entry.id === other.template_id)?.name ?? other.template_id}" também usa.` }); remaining.modules.push(id); }
    else off.add(id);
  }
  for (let changed = true; changed;) {
    changed = false;
    const final = { ...current, ...Object.fromEntries([...off].map((id) => [id, false])) };
    for (const id of [...off]) {
      const dependents = enabledDependents(id, { ...final, [id]: true }).filter((dependent) => !off.has(dependent));
      if (dependents.length) {
        off.delete(id); changed = true; remaining.modules.push(id);
        report.kept.push({ label: `Módulo ${moduleName(id)}`, reason: `continua ligado porque ${dependents.map(moduleName).join(", ")} ${dependents.length > 1 ? "dependem" : "depende"} dele.` });
      }
    }
  }
  for (const id of off) { report.modules_off.push(moduleName(id)); forgetPaths.add(`modules.${id}`); }
  const modules = planModuleStates(current, Object.fromEntries([...off].map((id) => [id, false])));
  // Cadastros da configuração: sai o que está igual ao que o modelo criou e não foi usado.
  const settings: Settings = {};
  const remove = new Map<string, Set<string>>();
  const pending: FootprintItem[] = [];
  for (const item of footprint.items) {
    const entry = savedList(cfg, item.key).find((candidate) => entryId(item.key, candidate) === item.id);
    if (!entry) { forgetIds.add(`${item.key}.${item.id}`); continue; }
    if (await hashOf(entry) !== item.hash) { report.kept.push({ label: item.label, reason: "ficou porque foi alterado depois de aplicar o modelo." }); remaining.items.push(item); continue; }
    const used = await usage(env, profile, item.key, item.id);
    if (used) { report.kept.push({ label: item.label, reason: `ficou porque ${used}.` }); remaining.items.push(item); continue; }
    pending.push(item);
  }
  // Uma referência de quem fica segura o item referenciado (menu → setor ou modelo; modelo → tipo de objeto).
  for (let changed = true; changed;) {
    changed = false;
    const leaving = (key: string, id: string) => pending.some((item) => item.key === key && item.id === id);
    const staying = (key: string) => savedList(cfg, key).filter((entry) => !leaving(key, entryId(key, entry)));
    for (const item of [...pending]) {
      const holder = item.key === "departments" ? staying("menus").find((menu) => menu.department_id === item.id)
        : item.key === "os_work_types" ? staying("menus").find((menu) => menu.type_id === item.id)
        : item.key === "os_object_types" ? staying("os_work_types").find((type) => type.object_type_id === item.id)
        : item.key === "menus" ? staying("menus").find((menu) => menu.parent_id === item.id) : null;
      if (holder) {
        pending.splice(pending.indexOf(item), 1); changed = true; remaining.items.push(item);
        report.kept.push({ label: item.label, reason: `ficou porque ${itemLabel(item.key === "os_object_types" ? "os_work_types" : "menus", holder)}, que continua, depende dele.` });
      }
    }
  }
  for (const item of pending) {
    if (!remove.has(item.key)) remove.set(item.key, new Set());
    remove.get(item.key)!.add(item.id);
    forgetIds.add(`${item.key}.${item.id}`);
    if (!ARCHIVED.has(item.key)) { report.removed.push(item.label); continue; }
    // Modelos de ordem e tipos de objeto não se apagam (regra da OS): ficam arquivados e voltam ao reaplicar.
    const entry = savedList(cfg, item.key).find((candidate) => entryId(item.key, candidate) === item.id);
    const archived = { ...entry, archived: true, revision: Number(entry.revision) + 1 };
    report.removed.push(`${item.label} (arquivado: sai das listas e volta se você aplicar o modelo de novo)`);
    remaining.items.push({ ...item, hash: await hashOf(archived), archived_by_undo: true });
  }
  for (const [key, ids] of remove) settings[key] = ARCHIVED.has(key)
    ? savedList(cfg, key).map((entry) => ids.has(entryId(key, entry)) ? { ...entry, archived: true, revision: Number(entry.revision) + 1 } : entry)
    : savedList(cfg, key).filter((entry) => !ids.has(entryId(key, entry)));
  const removedMenus = remove.get("menus") ?? new Set<string>();
  // Menus de módulos desligados ficam guardados pelo planejador: a lista enviada é só a visível.
  if (settings.menus) settings.menus = settings.menus.filter((menu: any) => !off.has(moduleOfMenuType(String(menu.type)) ?? ""));
  // Textos e vocabulário: voltam ao vazio se ninguém mexeu.
  for (const scalar of footprint.scalars) {
    const value = scalarValue(cfg, scalar.path);
    if (value === undefined || value === null || value === "") { forgetPaths.add(scalar.path); continue; }
    if (await hashOf(value) !== scalar.hash) { report.kept.push({ label: scalarLabel(scalar.path), reason: "ficou porque foi alterado depois de aplicar o modelo." }); remaining.scalars.push(scalar); continue; }
    if (scalar.path.startsWith("os_vocabulary.")) {
      const vocabulary = { ...(settings.os_vocabulary ?? cfg.os_vocabulary ?? {}) };
      delete vocabulary[scalar.path.slice(14)];
      settings.os_vocabulary = vocabulary;
    } else settings[scalar.path] = "";
    if (!report.removed.includes(scalarLabel(scalar.path))) report.removed.push(scalarLabel(scalar.path));
    forgetPaths.add(scalar.path);
  }
  // Exemplos: saem os que ninguém editou nem usou.
  const statements: Statement[] = [];
  const kinds = new Map<string, boolean>();
  const erpDeletes: FootprintExample[] = [];
  for (const example of footprint.examples) {
    const group = exampleGroup(example.kind);
    if (erpKind(example.kind)) {
      // Financeiro e catálogo de exemplo no ERP: conferidos como o administrador; apagados depois, pelo ERP (que recusa o que tem uso).
      const { erpExampleState } = await import("./erp-examples");
      const state = actor ? await erpExampleState(env, actor, profile, example) : "unknown";
      if (state === "changed" || state === "used" || state === "unknown") {
        report.kept.push({ label: example.label, reason: state === "changed" ? "ficou porque foi editado no ERP."
          : state === "used" ? "ficou porque já tem estoque ou movimento no ERP."
          : "ficou porque o ERP não respondeu agora; desfaça de novo mais tarde para tirar." });
        remaining.examples.push(example); kinds.set(group, false);
        continue;
      }
      if (state === "free") { erpDeletes.push(example); report.removed.push(example.label); }
      if (!kinds.has(group)) kinds.set(group, true);
      continue;
    }
    const state = await exampleState(env, profile, example);
    if (state === "changed" || state === "used") {
      report.kept.push({ label: example.label, reason: state === "changed" ? "ficou porque foi editado." : example.kind === "mensalidade_plan" ? "ficou porque já tem assinantes." : "ficou porque já tem agendamentos." });
      remaining.examples.push(example); kinds.set(group, false);
      continue;
    }
    if (state === "free") { statements.push(...exampleDeletes(profile, example)); report.removed.push(example.label); }
    if (!kinds.has(group)) kinds.set(group, true);
  }
  for (const [group, all] of kinds) if (all) forgetPaths.add(group);
  // Exemplos do ERP sem nada criado (ainda esperando o ERP, que o desfazer cancela, ou o ERP já tinha
  // cadastros): aplicar de novo volta a registrar; a montagem confere de novo o que já existe.
  for (const group of ["examples.financeiro", "examples.catalogo"]) if (!kinds.has(group)) forgetPaths.add(group);
  return { report, settings, modules, removedMenus, remaining, statements, forgetIds, forgetPaths, erpDeletes };
}
async function undoState(env: Env, actor: Actor, profile: string, input: unknown, catalog: readonly AreaTemplate[], apply: boolean) {
  admin(actor);
  const data = object(input, ["template_id", ...(apply ? ["preview_hash"] : [])], "request");
  const templateId = identifier(data.template_id, 32, "template_id");
  if (apply) invalid(typeof data.preview_hash === "string" && /^[a-f0-9]{64}$/.test(data.preview_hash), "preview_hash");
  env = withReadCache(env);
  const row = await one(env, PROFILE_SETTINGS_SQL, profile);
  if (!row) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const footprint = await readFootprint(env, profile, templateId);
  if (!footprint || footprint.status !== "applied")
    throw new ApiError(404, "template_not_applied", "Este modelo não está aplicado nesta área (ou já foi desfeito). Não há nada para desfazer.");
  const cfg = json(row.settings) as Settings;
  const current = configuredModuleStates(json(row.module_states));
  const computed = await computeUndo(env, profile, footprint, catalog, cfg, current, actor);
  const baseRevision = await sha(canonical(cfg));
  const preview_hash = await sha(canonical({ profile, footprint, report: computed.report, base: baseRevision, modules: json(row.module_states) }));
  return { env, row, footprint, computed, baseRevision, preview_hash, current };
}

export async function previewUndoAreaTemplate(env: Env, actor: Actor, profile: string, input: unknown, catalog: readonly AreaTemplate[]): Promise<UndoPreview> {
  const state = await undoState(env, actor, profile, input, catalog, false);
  return { ...state.computed.report, preview_hash: state.preview_hash, can_undo: true };
}

/** Chamado só pelo comando serializado do Coordinator. */
export async function undoAreaTemplate(env: Env, actor: Actor, profile: string, input: unknown, catalog: readonly AreaTemplate[]): Promise<UndoReport & { settings_revision: string }> {
  const state = await undoState(env, actor, profile, input, catalog, true);
  if ((input as any).preview_hash !== state.preview_hash)
    throw new ApiError(409, "preview_stale", "A configuração mudou desde a prévia. Veja de novo o que sai antes de desfazer.");
  const { computed, footprint } = state;
  const { planSettings, commitSettingsPlan } = await import("../service");
  const moduleChanges = Object.fromEntries(Object.entries(computed.modules).filter(([id, enabled]) => state.current[id] !== enabled));
  let plan: SettingsPlan;
  try {
    plan = await planSettings(state.env, actor, profile, computed.settings, { modules: moduleChanges, expected_revision: state.baseRevision });
  } catch (error) {
    if (error instanceof ApiError && error.code === "settings_conflict") throw new ApiError(409, "preview_stale", "A configuração mudou desde a prévia. Veja de novo o que sai antes de desfazer.");
    throw error;
  }
  // O planejador guarda os menus de módulos desligados; os que saem não devem ficar guardados.
  if (computed.removedMenus.size && Array.isArray(plan.settings.menus)) {
    plan.settings = { ...plan.settings, menus: plan.settings.menus.filter((menu: any) => !computed.removedMenus.has(menu.id)) };
    plan.settings_revision = await sha(canonical(plan.settings));
  }
  // Financeiro de exemplo no ERP: o ERP apaga o que está como foi criado e recusa o que já tem uso.
  if (computed.erpDeletes.length) {
    const { deleteErpExample } = await import("./erp-examples");
    for (const example of computed.erpDeletes) {
      if (await deleteErpExample(state.env, actor, profile, example)) continue;
      computed.report.removed = computed.report.removed.filter((label) => label !== example.label);
      computed.report.kept.push({ label: example.label, reason: "ficou porque já foi usado no ERP (tem conta, lançamento ou venda com ele)." });
      computed.remaining.examples.push(example);
      computed.forgetPaths.delete(exampleGroup(example.kind));
    }
  }
  const application = await one(state.env, "SELECT seen_ids_json,seen_paths_json FROM os_area_template_applications WHERE profile_id=? AND template_id=?", profile, footprint.template_id);
  const at = now();
  const statements: Statement[] = [...computed.statements, [
    "UPDATE area_template_footprints SET status='undone',modules_json=?,items_json=?,scalars_json=?,examples_json=?,report_json=?,undone_by=?,undone_at=? WHERE profile_id=? AND template_id=?",
    [JSON.stringify(computed.remaining.modules), JSON.stringify(computed.remaining.items), JSON.stringify(computed.remaining.scalars), JSON.stringify(computed.remaining.examples),
      JSON.stringify(computed.report), actor.id, at, profile, footprint.template_id],
  ], [
    "UPDATE profile_segment_choice SET status='undone',updated=?,updated_by=? WHERE profile_id=? AND template_id=?", [at, actor.id, profile, footprint.template_id],
  ], [
    // O financeiro de exemplo que ainda não foi montado não é mais montado.
    "UPDATE area_template_erp_examples SET state='cancelado',updated=? WHERE profile_id=? AND template_id=? AND state='pendente'", [at, profile, footprint.template_id],
  ]];
  // O que saiu deixa de contar como "já tratado": aplicar de novo recria.
  if (application) statements.push(["UPDATE os_area_template_applications SET seen_ids_json=?,seen_paths_json=? WHERE profile_id=? AND template_id=?", [
    JSON.stringify((json(application.seen_ids_json, []) as string[]).filter((path) => !computed.forgetIds.has(path))),
    JSON.stringify((json(application.seen_paths_json, []) as string[]).filter((path) => !computed.forgetPaths.has(path))),
    profile, footprint.template_id,
  ]]);
  try {
    const saved = await commitSettingsPlan(state.env, actor, plan, statements);
    return { ...computed.report, settings_revision: saved.settings_revision ?? plan.settings_revision };
  } catch (error) {
    if (error instanceof ApiError && error.code === "settings_conflict") throw new ApiError(409, "preview_stale", "A configuração mudou durante a operação. Veja de novo o que sai antes de desfazer.");
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* "Qual é o seu negócio?"                                              */
/* ------------------------------------------------------------------ */

export interface SegmentState {
  choice: { status: "chosen" | "skipped" | "undone" | "other"; segment_id: string | null; template_id: string | null; reminder_dismissed: boolean } | null;
  applied: Array<{ template_id: string; name: string; status: "applied" | "undone"; applied_at: number; undone_at: number | null; report: UndoReport | null }>;
  /** Pergunta no primeiro acesso: nada respondido e nenhum modelo aplicado. */
  ask: boolean;
  /** Lembrete discreto para quem pulou, até ser dispensado. */
  remind: boolean;
}
export async function segmentState(env: Env, actor: Actor, profile: string, catalog: readonly AreaTemplate[]): Promise<SegmentState> {
  admin(actor);
  const row = await one(env, "SELECT * FROM profile_segment_choice WHERE profile_id=?", profile);
  const footprints = (await all(env, "SELECT * FROM area_template_footprints WHERE profile_id=? ORDER BY applied_at DESC", profile)).map(rowToFootprint);
  const legacy = await one(env, "SELECT 1 x FROM os_area_template_applications WHERE profile_id=? LIMIT 1", profile);
  const choice = row ? { status: row.status, segment_id: row.segment_id ?? null, template_id: row.template_id ?? null, reminder_dismissed: !!Number(row.reminder_dismissed) } : null;
  return {
    choice,
    applied: footprints.map((footprint) => ({
      template_id: footprint.template_id, name: catalog.find((entry) => entry.id === footprint.template_id)?.name ?? footprint.template_id,
      status: footprint.status, applied_at: footprint.applied_at, undone_at: footprint.undone_at,
      report: footprint.status === "undone" && "template_id" in footprint.report ? footprint.report as UndoReport : null,
    })),
    ask: !choice && !legacy && !footprints.length,
    remind: choice?.status === "skipped" && !choice.reminder_dismissed,
  };
}
/** skip: "Pular por enquanto"; other: "Outro tipo de negócio"; dismiss: dispensa o lembrete. */
export async function setSegmentChoice(env: Env, actor: Actor, profile: string, input: unknown, catalog: readonly AreaTemplate[]): Promise<SegmentState> {
  admin(actor);
  const data = object(input, ["action", "segment_id"], "request");
  invalid(["skip", "other", "dismiss"].includes(data.action), "action");
  if (data.segment_id !== undefined) invalid(segmentById(data.segment_id), "segment_id");
  const at = now();
  if (data.action === "dismiss") {
    await exec(env, "UPDATE profile_segment_choice SET reminder_dismissed=1,updated=?,updated_by=? WHERE profile_id=?", at, actor.id, profile);
  } else {
    await exec(env,
      "INSERT INTO profile_segment_choice(profile_id,status,segment_id,template_id,reminder_dismissed,updated,updated_by) VALUES(?,?,?,NULL,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET status=excluded.status,segment_id=excluded.segment_id,template_id=NULL,reminder_dismissed=excluded.reminder_dismissed,updated=excluded.updated,updated_by=excluded.updated_by",
      profile, data.action === "skip" ? "skipped" : "other", data.action === "other" ? "outro" : (data.segment_id ?? null), data.action === "skip" ? 0 : 1, at, actor.id);
  }
  return segmentState(env, actor, profile, catalog);
}
