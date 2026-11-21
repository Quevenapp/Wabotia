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

/** Fatia D: recursos que o coletor ainda não lia e que agora têm destino no
 * ERP. O catálogo acima continua com eles `nao_confirmado` e sem caminho (o
 * contrato do descritor exige isso). Aqui fica só o acesso PROPOSTO, lido da
 * documentação pública da API v3 e ainda não conferido numa conta real: vira
 * descritor coletável apenas com a evidência registrada pelo dono
 * (`confirmBlingExtraResource`). Sem evidência, nada disto é chamado. */
export const BLING_EXTRA_COLLECTED = ["price_lists", "operation_natures", "custom_fields", "contracts", "service_invoices", "product_lots", "product_suppliers"] as const;
export type BlingExtraCollected = typeof BLING_EXTRA_COLLECTED[number];
export const isBlingExtraCollected = (entity: string): entity is BlingExtraCollected => (BLING_EXTRA_COLLECTED as readonly string[]).includes(entity);
/** Caminhos a conferir. `detail: null` = a lista já traz o registro inteiro. */
export const BLING_EXTRA_PROPOSED_ACCESS: Readonly<Record<BlingExtraCollected, { path: string; detail: string | null; doubt: string }>> = Object.freeze({
  price_lists: { path: "/listas-precos", detail: "/listas-precos/{id}", doubt: "Caminho e formato dos itens (produto e preço) a conferir na documentação vigente." },
  operation_natures: { path: "/naturezas-operacoes", detail: null, doubt: "A lista traz a natureza inteira; conferir se há detalhe por id." },
  custom_fields: { path: "/campos-customizados", detail: "/campos-customizados/{id}", doubt: "A documentação lista os campos por módulo (/campos-customizados/modulos/{idModulo}); conferir o caminho da lista e o nome do módulo de cada campo." },
  contracts: { path: "/contratos", detail: "/contratos/{id}", doubt: "Conferir os nomes dos campos de valor, vigência e periodicidade." },
  service_invoices: { path: "/nfse", detail: "/nfse/{id}", doubt: "Conferir se a lista aceita filtro por data de emissão." },
  product_lots: { path: "/produtos/lotes", detail: "/produtos/lotes/{id}", doubt: "Conferir se a lista exige os ids dos produtos e os nomes de saldo e validade." },
  product_suppliers: { path: "/produtos/fornecedores", detail: "/produtos/fornecedores/{id}", doubt: "Conferir os nomes do código e do preço de custo do fornecedor." },
});
export type BlingOfficialEvidence = NonNullable<ResourceDescriptor["officialEvidence"]>;
/** Descritor coletável de um recurso da fatia D, só com a evidência completa. */
export function confirmBlingExtraResource(entity: BlingExtraCollected, evidence: BlingOfficialEvidence): ResourceDescriptor {
  const access = BLING_EXTRA_PROPOSED_ACCESS[entity];
  if (!access || !evidence?.url?.startsWith("https://") || !evidence.scopes_checked || !evidence.identity_checked || !evidence.limits_checked) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
  return Object.freeze({
    key: entity, entity, path: access.path,
    pagination: { strategy: "page" as const, page_size: 10, limit_parameter: true, short_page_ends: true },
    detail: access.detail ? { path: access.detail, required: true } : null,
    dateFilter: { kind: "U" as const, from: null, to: null, time_zone: "America/Sao_Paulo" as const, overlap_minutes: 15 as const },
    variants: [{ key: entity, params: {}, deleted: false }], deletedEvidence: "none" as const,
    identityRule: { kind: "global" as const, parent_entity: null }, parser: "json" as const, scopeRequirements: [],
    confirmation: "oficial_confirmado" as const, officialEvidence: { ...evidence }, defaultSelected: false,
  });
}

/** Única rota XML conhecida; NFC-e usa a mesma rota, com identidade própria no acervo. */
export const BLING_XML_RESOURCE: ResourceDescriptor = {
  key: "fiscal_xml", entity: "nfe", path: "/nfe/documento/{chave}", pagination: { strategy: "source", page_size: 1, limit_parameter: false, short_page_ends: false }, detail: null,
  dateFilter: { kind: "U", from: null, to: null, time_zone: "America/Sao_Paulo", overlap_minutes: 15 }, variants: [], deletedEvidence: "none", identityRule: { kind: "global", parent_entity: null }, parser: "xml", scopeRequirements: [], confirmation: "original_conferido", officialEvidence: null, defaultSelected: false,
};

/** Conta real: referência pública da API v3 para cada recurso da coleta.
 *
 * Os caminhos, filtros e paginação de cada pista vêm de origin-sync/resources.mjs,
 * conferidos contra o OpenAPI oficial da API v3 (developer.bling.com.br) na
 * coleta original. Aqui cada entidade ganha a referência da documentação e
 * passa a "oficial_confirmado"; quem não tem referência pública continua fora,
 * com o motivo dito na tela (BLING_UNCONFIRMED_REASONS). Limites conferidos:
 * 3 requisições por segundo e 120 mil por dia por conta (o intervalo local de
 * 700 ms e o teto local de 20 mil por dia ficam abaixo). Escopos: no Bling as
 * permissões são marcadas no cadastro do aplicativo, e a falta delas volta como
 * 403 (pendência "falta permissão"), nunca como dado parcial. */
export const BLING_DOCS_BASE = "https://developer.bling.com.br/referencia";
export const BLING_OFFICIAL_CHECKED_AT = "2026-11-21T12:00:00.000Z";
const docTag: Partial<Record<BlingEntity, string>> = {
  contacts: "Contatos", products: "Produtos", sales_orders: "Pedidos - Vendas", sales_proposals: "Propostas Comerciais",
  purchase_orders: "Pedidos - Compras", receivables: "Contas a Receber", payables: "Contas a Pagar", nfe: "Notas Fiscais Eletrônicas",
  nfce: "Notas Fiscais de Consumidor Eletrônicas", payment_methods: "Formas de Pagamentos", sellers: "Vendedores", warehouses: "Depósitos",
  product_categories: "Categorias - Produtos", financial_categories: "Categorias - Receitas e Despesas", ledger_accounts: "Contas Contábeis",
  cash_entries: "Caixas e Bancos", stock_balances: "Estoques",
};
/** Endereço da documentação pública de um caminho GET da API v3. */
export function blingDocsUrl(tag: string, path: string): string {
  return `${BLING_DOCS_BASE}#/${encodeURIComponent(tag)}/get_${path.replace(/^\//, "").replace(/[/-]/g, "_")}`;
}
/** Por que um recurso continua fora da coleta numa conta real. */
export const BLING_UNCONFIRMED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  service_orders: "Ordens de serviço: a rota usada pelo sistema de origem (/ordens/servico) não aparece na documentação pública da API v3. Continua fora até haver referência oficial.",
  fiscal_xml: "XML das notas: a rota de documento por chave (/nfe/documento/{chave}) não tem referência pública na API v3. O XML continua fora; a nota em si (número, chave, situação) entra pela coleta de NF-e e NFC-e.",
  ...Object.fromEntries(BLING_EXTRA_ENTITIES.map(entity => [entity, isBlingExtraCollected(entity)
    ? `Caminho proposto ${BLING_EXTRA_PROPOSED_ACCESS[entity].path}: ${BLING_EXTRA_PROPOSED_ACCESS[entity].doubt} Liga quando você conferir numa coleta real (aba Outros dados).`
    : "Sem destino no ERP e sem referência conferida nesta versão: fica fora da coleta."])),
});
function officialEvidence(entity: BlingEntity, path: string): ResourceDescriptor["officialEvidence"] {
  const tag = docTag[entity];
  return tag ? { url: blingDocsUrl(tag, path), checked_at: BLING_OFFICIAL_CHECKED_AT, scopes_checked: true, identity_checked: true, limits_checked: true } : null;
}
/** Catálogo da conta real: o mesmo de BLING_RESOURCES, com a referência oficial
 * onde ela existe. O catálogo base continua sem referência (os testes e o
 * simulador escolhem o seu); a montagem de produção usa este. */
export const BLING_CONFIRMED_RESOURCES: readonly ResourceDescriptor[] = Object.freeze(BLING_RESOURCES.map(resource => {
  if (resource.confirmation !== "original_conferido" || !resource.path || BLING_UNCONFIRMED_REASONS[resource.key]) return resource;
  const evidence = officialEvidence(resource.entity, resource.path);
  return evidence ? Object.freeze({ ...resource, confirmation: "oficial_confirmado" as const, officialEvidence: evidence }) : resource;
}));
/** Linhas "chave: motivo" para a tela, só dos recursos que ficaram fora. */
export function blingUnconfirmedLimitations(catalog: readonly ResourceDescriptor[]): string[] {
  return catalog.filter(resource => resource.confirmation !== "oficial_confirmado" && BLING_UNCONFIRMED_REASONS[resource.key])
    .map(resource => `${resource.key}: ${BLING_UNCONFIRMED_REASONS[resource.key]}`.slice(0, 1000));
}
