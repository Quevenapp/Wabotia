/** Catálogo fechado: evidência local não substitui conferência oficial. */
import { BLING_EXTRA_ENTITIES, BLING_LEGACY_ENTITIES, BlingError, type BlingEntity, type ResourceDescriptor } from "./contracts.ts";
// @ts-ignore Regras puras originais; nunca importar o executor de sincronização.
import { RESOURCES, buildListParams, sourceId } from "../fagoo/workers/origin-sync/src/resources.mjs";

export interface OriginalResource {
  id: string; entity: BlingEntity; path: string; fromParam: string | null; toParam: string | null;
  dateOnly: boolean; mode: string; baseParams: ResourceDescriptor["variants"][number]["params"];
  strategy?: "source_page" | "stock"; listLimit?: boolean;
}
const originals = RESOURCES as readonly OriginalResource[];
export const BLING_ORIGINAL_LANES = originals;
export const BLING_RESOURCE_VERSION = "2026-11-19.1";
export const BLING_STOCK_PARTITIONS = Object.freeze([0, 1, 2] as const);
const captureParsers: Partial<Record<BlingEntity, ResourceDescriptor["parser"]>> = { products: "price", sales_proposals: "price", sales_orders: "sales_price", purchase_orders: "purchase_price", stock_balances: "stock", service_orders: "service" };
const parserFor = (entity: BlingEntity): ResourceDescriptor["parser"] => captureParsers[entity] ?? "json";
const deletedVariant = (key: string) => key.includes("_deleted");

function descriptor(original: OriginalResource): ResourceDescriptor {
  const kind = !original.fromParam ? "U" : original.mode === "modified" ? "M" : original.fromParam === "dataInicial" ? "D" : original.dateOnly ? "E" : "EH";
  return {
    key: original.id, entity: original.entity, path: original.path,
    pagination: { strategy: original.strategy ?? "page", page_size: original.strategy === "stock" ? 25 : 10, limit_parameter: original.strategy !== "stock" && (original.strategy !== "source_page" || original.listLimit === true), short_page_ends: !original.strategy },
    detail: original.strategy === "stock" ? null : { path: `${original.path}/{id}`, required: true },
    dateFilter: { kind, from: original.fromParam, to: original.toParam, time_zone: "America/Sao_Paulo", overlap_minutes: 15 },
    variants: [{ key: original.id, params: { ...original.baseParams }, deleted: deletedVariant(original.id) }],
    deletedEvidence: deletedVariant(original.id) ? "explicit_deleted_variant" : "none",
    identityRule: { kind: "global", parent_entity: null }, parser: parserFor(original.entity),
    scopeRequirements: [], confirmation: "original_conferido", officialEvidence: null, defaultSelected: true,
  };
}

/** Cada pista conserva seu filtro temporal, inclusive variantes excluídas sem data. */
export const BLING_RESOURCE_LANES: readonly ResourceDescriptor[] = Object.freeze(originals.map(descriptor));
export const BLING_RESOURCES: readonly ResourceDescriptor[] = Object.freeze([
  ...BLING_LEGACY_ENTITIES.map(entity => {
    const lanes = BLING_RESOURCE_LANES.filter(resource => resource.entity === entity);
    return { ...lanes[0], key: entity, variants: lanes.flatMap(resource => resource.variants), deletedEvidence: lanes.some(resource => resource.deletedEvidence === "explicit_deleted_variant") ? "explicit_deleted_variant" as const : "none" as const };
  }),
  ...BLING_EXTRA_ENTITIES.map(entity => ({
    key: entity, entity, path: null, pagination: null, detail: null, dateFilter: null, variants: [], deletedEvidence: null,
    identityRule: { kind: "unconfirmed" as const, parent_entity: null }, parser: null, scopeRequirements: [],
    confirmation: "nao_confirmado" as const, officialEvidence: null, defaultSelected: false,
  })),
]);

export function getBlingResource(key: string, catalog: readonly ResourceDescriptor[] = BLING_RESOURCES): ResourceDescriptor {
  const direct = catalog.find(resource => resource.key === key);
  if (direct) return direct;
  const lane = BLING_RESOURCE_LANES.find(resource => resource.key === key);
  const parent = lane && catalog.find(resource => resource.entity === lane.entity);
  if (!lane || !parent) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
  return { ...lane, confirmation: parent.confirmation, officialEvidence: parent.officialEvidence, scopeRequirements: parent.scopeRequirements };
}

export function resourceVariants(key: string, catalog: readonly ResourceDescriptor[] = BLING_RESOURCES): ResourceDescriptor[] {
  const resource = getBlingResource(key, catalog);
  if (!resource.variants.length) return [resource];
  return resource.variants.map(variant => {
    const lane = BLING_RESOURCE_LANES.find(candidate => candidate.key === variant.key);
    return lane ? { ...lane, confirmation: resource.confirmation, officialEvidence: resource.officialEvidence, scopeRequirements: resource.scopeRequirements } : { ...resource, key: variant.key, variants: [variant] };
  });
}

export function assertResourceConfirmed(resource: ResourceDescriptor): void {
  const evidence = resource.officialEvidence;
  if (resource.confirmation !== "oficial_confirmado" || !resource.path || !resource.pagination || !resource.dateFilter || !resource.parser || resource.identityRule.kind === "unconfirmed" || !evidence?.url.startsWith("https://") || !evidence.scopes_checked || !evidence.identity_checked || !evidence.limits_checked) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
}

export function exactSourceId(value: unknown): string {
  try {
    if (value !== null && typeof value === "object") {
      const text = JSON.stringify(value);
      if (!/^\d{1,40}$/.test(text)) throw new Error();
      return sourceId(text);
    }
    return sourceId(value);
  } catch { throw new BlingError("BLING_RESPONSE_INVALID"); }
}

export function buildBlingListQuery(key: string, input: { from?: string; to?: string; page?: number; limit?: number } = {}, confirmed?: ResourceDescriptor): Record<string, string | string[]> {
  try {
    const original = originals.find(resource => resource.id === key) ?? originals.find(resource => resource.entity === key);
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10)) throw new Error();
    if (!original) {
      if (!confirmed || confirmed.key !== key || confirmed.parser === "xml") throw new Error();
      assertResourceConfirmed(confirmed);
      const query: Record<string, string | string[]> = { pagina: String(input.page ?? 1) };
      if (confirmed.pagination!.limit_parameter) query.limite = String(input.limit ?? 10);
      for (const [name, value] of Object.entries(confirmed.variants.find(variant => variant.key === key)?.params ?? {}))
        query[name] = Array.isArray(value) ? value.map(String) : String(value);
      if (confirmed.dateFilter!.from && input.from) query[confirmed.dateFilter!.from] = input.from;
      if (confirmed.dateFilter!.to && input.to) query[confirmed.dateFilter!.to] = input.to;
      return query;
    }
    const params = buildListParams(original, { ...input, limit: input.limit ?? 10 }) as Record<string, string | number | boolean | (string | number)[]>;
    return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, Array.isArray(value) ? value.map(String) : String(value)]));
  } catch { throw new BlingError("BLING_RESPONSE_INVALID"); }
}

/** Única rota XML conhecida; NFC-e usa a mesma rota, com identidade própria no acervo. */
export const BLING_XML_RESOURCE: ResourceDescriptor = {
  key: "fiscal_xml", entity: "nfe", path: "/nfe/documento/{chave}", pagination: { strategy: "source", page_size: 1, limit_parameter: false, short_page_ends: false }, detail: null,
  dateFilter: { kind: "U", from: null, to: null, time_zone: "America/Sao_Paulo", overlap_minutes: 15 }, variants: [], deletedEvidence: "none", identityRule: { kind: "global", parent_entity: null }, parser: "xml", scopeRequirements: [], confirmation: "original_conferido", officialEvidence: null, defaultSelected: false,
};
