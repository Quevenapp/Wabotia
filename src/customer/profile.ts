import { allows } from "../access";
import { cachedOne, one } from "../db";
import { access, seal, unseal } from "../security";
import { ApiError, type Actor, type Env } from "../types";
import { modulesApi, type ModuleContext } from "../modules/api";
import { moduleById, moduleEnabled, modules } from "../modules/registry";
import { erpRoleOf } from "../modules/erp/identity";
import { resourcesForRole } from "../erp/role-resources";
import { staff as condominiumStaff } from "../modules/condominio/common";
import { clinical, responsible } from "../modules/saude/access";
import { staff as schoolStaff } from "../modules/ensino/access";
import { staff as legalStaff } from "../modules/juridico/access";
import { areaTemplates } from "../area-templates";
import { customerProfileDeclarations } from "./declarations";
import { isFullCustomerEnabled } from "./feature";
import { customerProvider } from "./ports";
import type { ContactContribution, ContactProfileView, ProfilePort, SectionView } from "./profile-contracts";

type Contact = { id: string; profile_id: string; namespace: string; erp_contact_id: string | null; identity_state: string };
const failure = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const forbidden = () => failure(403, "forbidden", "Você não tem permissão para esta parte da ficha.");
const missing = () => failure(404, "not_found", "Contato ou contribuição não encontrado.");
const unavailable = () => failure(503, "dependency_unavailable", "Esta parte da ficha está temporariamente indisponível.");
const declaration = (moduleId: string) => moduleById(moduleId)?.customer_profile ?? customerProfileDeclarations[moduleId];
async function provide<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) { if (error instanceof ApiError) throw error; return unavailable(); }
}

async function contact(env: Env, actor: Actor, profileId: string, contactId: string): Promise<Contact> {
  // A ficha não é uma API para aplicações, credenciais de extensão ou bots.
  if (actor.kind !== "user" || actor.via || actor.module || actor.credential || actor.id.startsWith("bot:") || actor.bots.length) forbidden();
  access(actor, profileId, "contacts:read");
  const row = await one<Contact>(env,
    "SELECT id,profile_id,namespace,erp_contact_id,identity_state FROM contacts WHERE id=? AND profile_id=? AND (namespace='team' OR namespace LIKE 'app:%')",
    contactId, profileId);
  if (!row || row.profile_id !== profileId || row.identity_state !== "active") return missing();
  if (row.namespace !== "team" && !allows(actor, "contacts")) forbidden();
  return row!;
}

// A ativação de cadastro completo passa sempre pela fachada da base.
const enabled = (env: Env, profileId: string, moduleId: string) => moduleId === "erp"
  ? isFullCustomerEnabled(env, profileId) : moduleEnabled(env, profileId, moduleId);
async function requireEnabled(env: Env, profileId: string, moduleId: string, item: ContactContribution) {
  for (const id of [moduleId, ...(moduleById(moduleId)?.requires ?? []), ...(item.enabledWith ?? [])]) {
    if (!(await enabled(env, profileId, id))) failure(409, "module_disabled", "Um módulo necessário está desligado nesta área.");
  }
}

/** Barreira da contribuição. O provedor ainda aplica permissões por registro ANTES de paginar. */
async function policy(ctx: ModuleContext, actor: Actor, item: ContactContribution, write = false) {
  if (!allows(actor, ctx.module.id)) forbidden();
  if (item.policy === "erp" && ctx.module.id === "erp") {
    const role = erpRoleOf(actor), resources = resourcesForRole(role);
    const resource = item.id === "sales" ? "sales_orders" : "receivables";
    if (write || !resources.includes(resource)) forbidden();
    return;
  }
  if (item.policy === "private" && item.component === "private.navigation") {
    if (write) forbidden(); // A navegação não exporta nem edita o domínio privado.
    if (ctx.module.id === "saude") {
      try { await clinical(ctx, actor); }
      catch (e) { if (!(e instanceof ApiError) || e.status !== 403) throw e; await responsible(ctx, actor); }
    } else if (ctx.module.id === "ensino") await schoolStaff(ctx, actor);
    else if (ctx.module.id === "juridico") await legalStaff(ctx, actor, false, "either");
    else forbidden();
    return;
  }
  if (ctx.module.id === "condominio" && (item.policy === "module" || item.policy === "condominio.dues")) {
    await condominiumStaff(ctx, actor, write || item.id === "dues" ? ["admin"] : ["admin", "portaria"], write);
    if (item.id === "dues" && !allows(actor, "mensalidade")) forbidden();
    return;
  }
  if (item.policy !== "module" || write) forbidden();
}

async function contribution(env: Env, actor: Actor, profileId: string, contactId: string,
  moduleId: string, id: string, kind: ContactContribution["kind"], write = false) {
  const row = await contact(env, actor, profileId, contactId);
  if (row.namespace !== "team") return missing();
  if (!moduleById(moduleId)) return missing();
  const item = declaration(moduleId)?.contributions.find(c => c.id === id && c.kind === kind);
  if (!item) return missing();
  await requireEnabled(env, profileId, moduleId, item);
  const ctx = modulesApi(env, profileId, moduleId, { worker: !write });
  await policy(ctx, actor, item, write);
  if (moduleId === "erp" && !row.erp_contact_id) missing();
  return { row, item, ctx };
}

async function vocabulary(env: Env, profileId: string) {
  // Não depende da ativação de OS. Não lê dados de clientes ou o objeto ERP.
  const row = await cachedOne<{ settings: string }>(env, "SELECT settings FROM profiles WHERE id=?", profileId);
  let cfg: Record<string, any> = {};
  try {
    const parsed = JSON.parse(row?.settings ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed;
  } catch { /* defaults */ }
  const setup = Array.isArray(cfg.os_area_setup) ? cfg.os_area_setup : [];
  let template = setup.map((s: any) => areaTemplates.find(t => t.id === s?.template_id)).filter(Boolean).at(-1);
  const explicit = cfg.os_vocabulary;
  if (!template && [explicit?.customer_singular, explicit?.customer_plural, explicit?.collection_label]
    .some(value => typeof value !== "string" || !value.trim())) {
    // Sugestões de bot são opcionais: o modelo aplicado existe mesmo sem os_area_setup.
    const applied = await one<{ template_id: string }>(env,
      "SELECT template_id FROM os_area_template_applications WHERE profile_id=? ORDER BY applied_at DESC,template_id LIMIT 1", profileId);
    template = areaTemplates.find(item => item.id === applied?.template_id);
  }
  const label = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.trim() : fallback;
  return {
    singular: label(explicit?.customer_singular, template?.vocabulary.customer_singular ?? "Cliente"),
    plural: label(explicit?.customer_plural, template?.vocabulary.customer_plural ?? "Clientes"),
    works: label(explicit?.collection_label, template?.vocabulary.collection_label ?? "Trabalhos"),
  };
}

async function sectionResult(ctx: ModuleContext, actor: Actor, item: ContactContribution, result: SectionView): Promise<SectionView> {
  const schema = item.component === "condominio.units" ? "condominio.units.v1" : "private.navigation.v1";
  if (result.schema !== schema || !Number.isSafeInteger(result.version) || result.version < 1) return unavailable();
  let writable = false;
  if (result.writable) {
    try { await policy(ctx, actor, item, true); writable = true; }
    catch (e) { if (!(e instanceof ApiError) || e.status !== 403) throw e; }
  }
  if (schema === "private.navigation.v1") {
    // Reconstrói a projeção: nenhum texto, nome, contador ou resumo privado atravessa a ficha.
    const data = result.data as { target?: { module?: unknown; resource?: unknown; id?: unknown } } | null;
    const target = data?.target;
    if (!target || target.module !== ctx.module.id || typeof target.resource !== "string" || typeof target.id !== "string")
      return { version: result.version, writable: false, schema, data: null };
    return { version: result.version, writable: false, schema, data: { target: { module: ctx.module.id, resource: target.resource, id: target.id } } };
  }
  return { version: result.version, writable, schema, data: result.data };
}

/** Instanciado pelo runtime, sem importar/carregar o motor ERP. */
export function createProfilePort(): ProfilePort {
  return {
    async view(env, actor, profileId, contactId) {
      const row = await contact(env, actor, profileId, contactId);
      const words = await vocabulary(env, profileId);
      const contributions: ContactProfileView["contributions"][number][] = [];
      if (row.namespace !== "team") return {
        profileId, contactId, namespace: row.namespace, erpContactId: null, depth: "simple",
        vocabulary: { singular: words.singular, plural: words.plural }, writable: true, contributions,
      };
      let erpAllowed = false;
      if (row.erp_contact_id && allows(actor, "erp") && resourcesForRole(erpRoleOf(actor)).includes("contacts") &&
          await isFullCustomerEnabled(env, profileId)) {
        try {
          const provider = customerProvider("erp");
          if (!provider) unavailable();
          await provide(() => provider!.authorizeProfile?.(modulesApi(env, profileId, "erp", { worker: true }), actor, contactId) ?? Promise.resolve());
          erpAllowed = true;
        } catch (e) { if (!(e instanceof ApiError) || ![403, 404].includes(e.status)) throw e; }
      }
      for (const module of modules) for (const item of declaration(module.id)?.contributions ?? []) {
        try {
          await requireEnabled(env, profileId, module.id, item);
          const ctx = modulesApi(env, profileId, module.id, { worker: true });
          await policy(ctx, actor, item);
          if (module.id === "erp" && !erpAllowed) continue;
          let writable = false;
          if (item.kind === "section") {
            try { await policy(ctx, actor, item, true); writable = true; }
            catch (e) { if (!(e instanceof ApiError) || e.status !== 403) throw e; }
          }
          contributions.push({ ...item, moduleId: module.id, writable,
            title: item.titleKey === "works" ? words.works : item.titleKey === "customers" ? words.plural : item.title });
        } catch (e) {
          if (!(e instanceof ApiError) || ![403, 409].includes(e.status)) throw e;
        }
      }
      const full = erpAllowed;
      if (!allows(actor, "contacts") && !full && !contributions.length) forbidden();
      return {
        profileId, contactId, erpContactId: allows(actor, "contacts") || full ? row.erp_contact_id : null,
        depth: full ? "full" : "simple", vocabulary: { singular: words.singular, plural: words.plural },
        ...(!allows(actor, "contacts") ? { readable: false } : {}),
        ...(full ? { localWritable: allows(actor, "contacts") } : {}),
        // ERP é somente uma indicação: o hospedeiro reaplica o .ie granular e MFA.
        writable: full ? ["admin", "vendas", "financeiro"].includes(erpRoleOf(actor) ?? "") : allows(actor, "contacts"),
        contributions,
      };
    },
    async collection(env, actor, profileId, contactId, moduleId, collectionId, query) {
      const { row, ctx, item } = await contribution(env, actor, profileId, contactId, moduleId, collectionId, "collection");
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) failure(400, "invalid_request", "Limite inválido.");
      const binding = JSON.stringify([profileId, row.namespace, contactId, moduleId, collectionId, query.limit,
        actor.id, actor.sessionId ?? null, actor.role, actor.access ?? null]);
      let cursor: string | undefined, cutoff = Date.now();
      if (query.cursor) {
        try {
          if (query.cursor.length > 32000) throw Error();
          const decoded = await unseal(env, atob(query.cursor));
          if (decoded.kind !== "customer-profile.v1" || decoded.binding !== binding ||
            !Number.isSafeInteger(decoded.cutoff) || decoded.cutoff > Date.now() || typeof decoded.cursor !== "string") throw Error();
          cursor = decoded.cursor; cutoff = decoded.cutoff;
        } catch { failure(400, "invalid_cursor", "Cursor inválido para esta lista."); }
      }
      const provider = customerProvider(moduleId);
      if (!provider?.list) return unavailable();
      // O cursor interno pertence à fonte: contém seu corte e última chave imutável.
      const page = await provide(() => provider.list!(ctx, actor, contactId, collectionId, { limit: query.limit, ...(cursor ? { cursor } : {}) }));
      if (!Array.isArray(page.items) || page.items.length > query.limit || typeof page.incomplete !== "boolean" ||
        (page.nextCursor !== null && typeof page.nextCursor !== "string")) return unavailable();
      const items = page.items.map(entry => ({ id: entry.id,
        target: { module: entry.target.module, resource: entry.target.resource, id: entry.target.id },
        cells: Object.fromEntries((item.columns ?? []).map(column => {
        // Compatibilidade com a projeção anterior do Condomínio, sem inventar valores ausentes.
        const value = entry.cells[column.key] ?? (moduleId === "condominio"
          ? column.key === "id" ? entry.id : column.key === "occurredAt" ? entry.cells.createdAt : null : null);
        return [column.key, typeof value === "string" || typeof value === "number" ? value : null];
      })) }));
      return { items, incomplete: page.incomplete,
        nextCursor: page.nextCursor ? btoa(await seal(env, { kind: "customer-profile.v1", binding, cutoff, cursor: page.nextCursor })) : null };
    },
    async section(env, actor, profileId, contactId, moduleId, sectionId) {
      const { ctx, item } = await contribution(env, actor, profileId, contactId, moduleId, sectionId, "section");
      const provider = customerProvider(moduleId);
      if (!provider?.section) return unavailable();
      return sectionResult(ctx, actor, item, await provide(() => provider.section!(ctx, actor, contactId, sectionId)));
    },
    async saveSection(env, actor, profileId, contactId, moduleId, sectionId, input) {
      const { ctx, item } = await contribution(env, actor, profileId, contactId, moduleId, sectionId, "section", true);
      if (!input || typeof input.commandId !== "string" || !input.commandId.trim() || input.commandId.length > 200 ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.data === undefined)
        failure(400, "invalid_request", "Informe o comando e a versão da seção.");
      const provider = customerProvider(moduleId);
      if (!provider?.saveSection) return unavailable();
      const result = await provide(() => provider.saveSection!(ctx, actor, contactId, sectionId, input));
      return { ...await sectionResult(ctx, actor, item, result), replayed: result.replayed };
    },
  };
}
