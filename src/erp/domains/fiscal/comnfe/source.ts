/** Captura síncrona: todos os valores vêm do SQLite da mesma transação do RPC.
 * O snapshot conserva a versão observada; os hashes excluem incrementos técnicos
 * de estoque/financeiro. Não consulta o cofre nem modifica cadastros ou pedido.
 */
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import type { RpcContext } from "../../../engine/registry.ts";
import type {
  CommercialSnapshot, FiscalBlocker, FiscalChoices, ImmutableRevision, JsonObject, JsonValue, PrepareInput,
} from "../../../commercial-nfe/contracts.ts";
import { data as catalogData, productDetailData } from "../../catalog/internal.ts";
import { contactRequireVisible } from "../../catalog/contact.ts";
import { referenceKey } from "../../reference/rpc/erp_reference_search.ts";
import { natureRecord } from "../natures.ts";
import { resolveReformClass, natureClasses } from "../reform.ts";
import { contactSnapshot, invoicePreferences } from "../rpc/erp_fiscal_invoice_support.ts";
import { taxSettingsInput } from "../rpc/erp_fiscal_tax_settings.ts";
import { com1Hash } from "./store.ts";
import { readCommercialSettings } from "./settings.ts";
import { linkedDocumentGuard } from "../../documents/module-policy.ts";

export interface PreparationSources {
  snapshot: CommercialSnapshot;
  tax_sources: JsonObject;
  choices: FiscalChoices;
  source_document_version: number;
  commercial_hash: string;
  source_fingerprint: string;
  blockers: FiscalBlocker[];
}

const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const parse = (value: unknown): JsonObject => value == null ? {} : object(JSON.parse(String(value)));
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
/** SQL i64 nunca passa por Number antes da serialização. */
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v)) as JsonObject;
const pick = (value: JsonObject, keys: readonly string[]): JsonObject => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const omit = (value: JsonObject, keys: readonly string[]): JsonObject => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

export interface ResolvedMunicipality { code: string; name: string; uf: string }
/** Igualdade da chave oficial completa + UF, nunca prefixo ou primeira sugestão. */
export function resolvePreparationMunicipality(db: SqlDriver, city: unknown, state: unknown): ResolvedMunicipality | null {
  if (typeof city !== "string" || typeof state !== "string" || !/^[A-Z]{2}$/.test(state)) return null;
  const key = referenceKey(city);
  if (!key) return null;
  const rows = db.exec('SELECT code,name,uf FROM "erp_reference__municipality" WHERE key=? AND uf=? ORDER BY code', key, state).rows;
  if (rows.length !== 1 || !/^\d{7}$/.test(String(rows[0].code))) return null;
  return { code: String(rows[0].code), name: String(rows[0].name), uf: String(rows[0].uf) };
}

const PRODUCT_FISCAL_FIELDS = [
  "name", "code", "unit", "kind", "format", "ncm", "gtin", "gtin_tax", "cest", "origin", "additional_info", "net_weight", "gross_weight", "volumes",
  "product_group_id", "fci_number", "item_type", "ipi_tipi_exception", "ipi_framework_class", "ipi_seal_code", "tax_percent",
  "icms_st_retention_base", "icms_st_retention_value", "icms_own_substitute_value", "ipi_fixed_value", "pis_fixed_value", "cofins_fixed_value",
  "anp_code", "anp_description", "glp_percent", "glgnn_percent", "glgni_percent", "starting_value",
] as const;
const PAYMENT_FIELDS = ["id", "description", "payment_type", "card_brand", "card_integration", "card_cnpj", "pix_integration", "pix_cnpj", "active", "applicable", "version", "deleted_at"] as const;
const TECHNICAL_DOCUMENT_FIELDS = ["version", "updated_at", "updated_by", "created_at", "created_by", "effect_flags", "unavailable_parts",
  "internal_notes", "warehouse_id", "category_id", "payment_account_id"];

/** Sem números fiscais nem impostos confiados ao navegador. `choices` é a única
 * contribuição fiscal de entrada; o chamador valida seu formato e autorização.
 */
export function capturePreparationSources(ctx: RpcContext, input: PrepareInput): PreparationSources {
  const db = ctx.db;
  const row = one(db, 'SELECT *,CAST(total AS TEXT) stored_total FROM "erp_documents__document" WHERE id=?', input.document_id);
  if (!row) raise("P0002", "fiscal_order_unavailable");
  // A junção mantém pedidos de módulo somente para consulta, inclusive por
  // URL/RPC direto. A política fiscal dessa origem ainda precisa ser definida.
  linkedDocumentGuard(db, input.document_id);
  const blockers: FiscalBlocker[] = [];
  const sources: CommercialSnapshot["sources"] = [];
  const recordSource = (entity: string, id: string, version: unknown, fields: string[]) => {
    sources.push({ entity, id, version: typeof version === "number" || typeof version === "string" ? version : null, fields: [...fields].sort() });
  };
  const user = ctx.identity.actor?.user_id ?? null;
  const contactId = text(row.contact_id);
  // inTransaction também é usado nos testes/integrações, sem depender do hook de RPC.
  const visible = (id: string | null) => {
    if (id && ctx.identity.customer_privacy?.restricted_contact_ids.includes(id)) raise("42501", "erp_customer_restricted");
    contactRequireVisible(db, user, id);
  };
  visible(contactId);
  const body = parse(row.body);
  const items = db.exec('SELECT id,position,product_id,data,product_snapshot FROM "erp_documents__item" WHERE document_id=? ORDER BY position,id', input.document_id).rows.map(item => {
    const data = parse(item.data), savedProduct = parse(item.product_snapshot);
    return json({ ...data, id: item.id, position: item.position, product_id: item.product_id,
      code: Object.hasOwn(data, "code") ? data.code : savedProduct.code ?? null, product_snapshot: savedProduct });
  });
  const document = json({ ...body, id: row.id, kind: row.kind, number: row.number == null ? null : String(row.number),
    status: row.status, version: Number(row.version), authority: row.authority, origin: row.origin,
    contact_id: contactId, contact_snapshot: parse(row.contact_snapshot),
    stored_total: row.stored_total == null ? null : formatScaled(fromColumn(row.stored_total), 2) });
  recordSource("document", input.document_id, Number(row.version), Object.keys(document));
  for (const item of items) recordSource("document_item", String(item.id), Number(row.version), Object.keys(item));
  const unavailable = row.kind !== "sales_orders" || row.authority !== "brufap" || row.deleted_at != null || row.status === "cancelled" || items.length === 0;
  const legacyInvoice = one(db, `SELECT o.invoice_id FROM "erp_fiscal_invoices__invoice_order" o
    JOIN "erp_fiscal_invoices__invoice" n ON n.id=o.invoice_id
    WHERE o.document_id=? AND n.deleted_at IS NULL AND n.direction='1' AND n.status NOT IN (3,10) LIMIT 1`, input.document_id);
  if (unavailable || legacyInvoice) blockers.push({ code: "fiscal_order_unavailable", field: "document_id", entity_id: input.document_id,
    message: "Este pedido não está disponível para emissão integral de NF-e.", correction: { screen: "sales_orders", id: input.document_id } });

  const identity = one(db, 'SELECT version,data FROM "erp_company__identity" WHERE singleton=1');
  const fiscal = one(db, 'SELECT version,crt FROM "erp_company__fiscal" WHERE singleton=1');
  const extraRow = one(db, 'SELECT version,data FROM "erp_company__extra" WHERE singleton=1');
  const extra = parse(extraRow?.data);
  const company = json({ ...extra, ...parse(identity?.data), crt: fiscal?.crt ?? null, extra });
  recordSource("company_identity", "1", identity?.version, Object.keys(parse(identity?.data)));
  recordSource("company_fiscal", "1", fiscal?.version, ["crt"]);
  recordSource("company_extra", "1", extraRow?.version, Object.keys(extra));
  const recipient = json(contactId ? contactSnapshot(db, contactId) ?? {} : {});
  if (contactId) {
    const contactRow = one(db, 'SELECT version FROM "erp_catalog__record" WHERE id=?', contactId);
    recordSource("contact", contactId, contactRow?.version, Object.keys(recipient));
    const municipality = resolvePreparationMunicipality(db, recipient.city, recipient.state);
    if (municipality) Object.assign(recipient, { municipality_code: municipality.code, municipality_name: municipality.name });
    else blockers.push({ code: "fiscal_municipality_unresolved", field: "recipient.municipality_code", entity_id: contactId,
      message: `Não foi possível identificar unicamente o município de ${text(recipient.name) ?? "cliente"}. Confira cidade e UF no cadastro.`,
      correction: { screen: "contacts", id: contactId, field: "city" } });
  }

  const nature = json(natureRecord(db, input.choices.nature_id) ?? {});
  const natureState = one(db, 'SELECT deleted_at FROM "erp_fiscal_invoices__nature" WHERE id=?', input.choices.nature_id);
  if (natureState?.deleted_at != null) nature.active = false;
  recordSource("nature", input.choices.nature_id, nature.version, Object.keys(nature));
  const productIds = [...new Set(items.map(item => text(item.product_id)).filter((id): id is string => id !== null))].sort();
  const products: JsonObject[] = [];
  const groups: JsonObject = {}, reform: JsonObject = {};
  for (const id of productIds) {
    const productRow = one(db, 'SELECT id,entity,active,version FROM "erp_catalog__record" WHERE id=?', id);
    const product = productRow?.entity === "products" ? catalogData(db, id) : null;
    if (!product) continue;
    const detail = productDetailData(db, id, true) ?? {};
    const fields = pick(json({ ...product, ...detail }), PRODUCT_FISCAL_FIELDS);
    const classification = resolveReformClass(db, { productId: id, natureId: input.choices.nature_id,
      ncm: text(fields.ncm), groupId: text(fields.product_group_id) });
    products.push(json({ ...fields, id, active: productRow?.active === 1 && detail.deleted_at == null,
      version: Number(productRow?.version), reform_class: classification }));
    groups[id] = text(fields.product_group_id);
    reform[id] = classification ? json(classification) : null;
    recordSource("product", id, productRow?.version, Object.keys(fields));
  }

  const payments = (Array.isArray(body.installments) ? body.installments : []).map(value => {
    const installment = object(value), methodId = text(installment.payment_method_id);
    const methodRow = methodId ? one(db, `SELECT ${PAYMENT_FIELDS.join(",")} FROM "erp_catalog__payment_method" WHERE id=?`, methodId) : null;
    const method = methodRow ? json({ ...methodRow, active: methodRow.active === 1 && methodRow.deleted_at == null }) : null;
    if (methodId) recordSource("payment_method", methodId, method?.version, method ? Object.keys(method) : []);
    return { ...installment, payment_method: method };
  });
  const carrierId = text(body.carrier_id);
  visible(carrierId);
  const carrier = carrierId ? contactSnapshot(db, carrierId) : null;
  if (carrierId) recordSource("carrier", carrierId, one(db, 'SELECT version FROM "erp_catalog__record" WHERE id=?', carrierId)?.version, carrier ? Object.keys(carrier) : []);
  const transport = json({ ...object(object(body.commercial).transport), carrier });
  const taxRow = one(db, 'SELECT version,settings,difal_by_state FROM "erp_fiscal_invoices__tax_settings" WHERE singleton=1');
  const defaults = taxSettingsInput({}, {});
  const settings = taxRow ? parse(taxRow.settings) : json(defaults.settings);
  const difalByState = taxRow ? parse(taxRow.difal_by_state) : {};
  recordSource("tax_settings", "1", taxRow?.version ?? 0, ["settings", "difal_by_state"]);
  const preferences = json(invoicePreferences(db, "55"));
  const preferenceVersions: JsonObject = {};
  for (const preference of db.exec(`SELECT d.key,CAST(c.version AS TEXT) version FROM "erp_preferences__definition" d
    LEFT JOIN "erp_preferences__company_value" c ON c.key=d.key
    WHERE substr(d.key,1,4)='nfe.' ORDER BY d.key`).rows) {
    preferenceVersions[String(preference.key)] = preference.version == null ? null : String(preference.version);
    recordSource("preference", String(preference.key), preference.version, ["value"]);
  }
  const municipalityDataset = one(db, 'SELECT name,source,source_url,version,fetched_on,rows FROM "erp_reference__dataset" WHERE name=?', "municipios");
  recordSource("municipalities", "municipios", municipalityDataset?.version, ["code", "name", "uf"]);
  const choices = { ...input.choices };
  const taxSources: JsonObject = { settings, difal_by_state: difalByState, preferences, product_groups: groups, reform_by_product: reform,
    reform_nature: natureClasses(db, input.choices.nature_id).map(entry => json(entry)), choices: json(choices),
    municipality_dataset: municipalityDataset ? json(municipalityDataset) : null,
    versions: { tax_settings: (taxRow?.version ?? 0) as JsonValue, nature: nature.version ?? null, preferences: preferenceVersions } };
  const snapshot: CommercialSnapshot = { document, items, company, recipient, products, nature, payments, transport, sources };
  const commercial = { document: omit(document, TECHNICAL_DOCUMENT_FIELDS), items: items.map(item => omit(item, ["lots"])) };
  const commercialHash = com1Hash(commercial);
  const config = readCommercialSettings(ctx);
  const publicConnection = config.connection_public ?? {};
  const fiscalConfig = {
    environment: config.environment, series_homologacao: config.series_homologacao, series_producao: config.series_producao,
    connection_fingerprint: config.connection_fingerprint,
    connection: pick(json(publicConnection), ["fingerprint", "provider", "origin", "issuer_cnpj", "version", "compatible", "company_matches", "company_complete", "environments", "series"]),
    production_enabled: config.production_enabled_at !== null, tax_limits_acknowledged: config.tax_limits_acknowledged_at !== null,
  };
  // Versões e timestamps ficam disponíveis para revisão, mas a comparação usa
  // conteúdo relevante. Atualizar somente o relógio/versão não invalida fontes.
  const sourceFingerprint = com1Hash({ commercial_hash: commercialHash, company, recipient,
    products: products.map(product => omit(product, ["version"])),
    nature: omit(nature, ["version", "created_at", "updated_at", "defaults"]),
    payments: payments.map(payment => ({ ...payment, payment_method: payment.payment_method ? omit(payment.payment_method, ["version", "deleted_at"]) : null })), transport,
    tax_sources: omit(taxSources, ["versions", "municipality_dataset"]), config: fiscalConfig,
    availability: { order: !unavailable, legacy_invoice: legacyInvoice?.invoice_id ?? null } });
  return { snapshot, tax_sources: taxSources, choices, source_document_version: Number(row.version),
    commercial_hash: commercialHash, source_fingerprint: sourceFingerprint, blockers };
}

/** Revalidação antes do primeiro envio. A integração deve usar esta captura na
 * transação do claim; nunca comparar um fingerprint fornecido pelo navegador.
 */
export function recapturePreparationFingerprint(ctx: RpcContext, revision: ImmutableRevision): string {
  const choices = object(revision.tax_sources.choices) as unknown as FiscalChoices;
  if (!text(choices.nature_id) || typeof choices.presence !== "string" || typeof choices.final_consumer !== "boolean")
    raise("22023", "fiscal_source_changed");
  return capturePreparationSources(ctx, { document_id: String(revision.snapshot.document.id),
    expected_document_version: revision.source_document_version, command_id: "00000000-0000-0000-0000-000000000000", choices }).source_fingerprint;
}
