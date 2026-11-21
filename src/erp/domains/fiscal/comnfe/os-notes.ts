/** Notas da ordem de serviço (OS, parte 5). A ordem com orçamento aprovado
 * emite, pela mesma máquina da NF-e comercial:
 *  - a nota de serviço (NFS-e do Sistema Nacional, modelo "nfse", tabelas
 *    service_*) com os serviços do orçamento;
 *  - a NF-e modelo 55 das peças (itens do grupo "part"), pelo caminho que já
 *    existe, a partir do documento comercial que a fase 3 gerou para a ordem.
 * O documento da fase 3 (service_orders) continua só para consulta: nada aqui
 * o altera. Estoque e financeiro são os da fase 3: a nota nunca lança nem
 * estorna (effects.ts, module_origin_effects). Tudo é síncrono e sem I/O; o
 * cofre é chamado pelo serviço HTTP entre estas transações.
 */
import { one, type Row } from "../../../engine/driver.ts";
import { ErpError, raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireErpParts } from "../../../engine/parts-gate.ts";
import { ORIGIN_POLICY, targetOrigin } from "../../../engine/module-origin.ts";
import { erpRequirement } from "../../../parts.ts";
import type {
  CommercialSnapshot, EmissionView, FiscalBlocker, FiscalChoices, ImmutableRevision, JsonObject, PedidoNfe, PreparationResult,
} from "../../../commercial-nfe/contracts.ts";
import { cnpj as normalizeCnpj, cpfValid } from "../../company/internal.ts";
import { contactRequireVisible } from "../../catalog/contact.ts";
import { contactSnapshot } from "../rpc/erp_fiscal_invoice_support.ts";
import { requireCom1Access } from "./access.ts";
import { mapPreparation } from "./mapper.ts";
import { COM1_MODEL_TABLES, NFSE_SETTINGS_TABLE, withCom1Model, type Com1Model } from "./model.ts";
import { configuration, preparationEffectsPreview } from "./prepare.ts";
import { requireCommercialEmissionVisible, requireCommercialReadParts } from "./reads.ts";
import { readCommercialSettings } from "./settings.ts";
import { allocateShares, capturePreparationSources, osPartItem, resolvePreparationMunicipality } from "./source.ts";
import {
  appendCom1Audit, com1Hash, com1Reference, com1Uuid, findOrderEmission, finishCommand, getEmissionView, replayCommand, savePreparation, startCommand,
} from "./store.ts";
import { calculatePreparationTaxes } from "./taxes.ts";

type Obj = Record<string, unknown>;
export type OsNoteKind = "nfse" | "nfe";
const invalid = (code = "com1_input_invalid"): never => raise("22023", code);
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const parse = (value: unknown): Obj => value == null ? {} : object(JSON.parse(String(value)));
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Emissão ainda não enviada: pode ser preparada de novo. */
const REWRITABLE = ["bloqueada", "preparada", "rejeitada"];

const cents = (value: unknown): bigint => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? "0"));
  if (!match) return 0n;
  const result = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0") || "0");
  return match[1] ? -result : result;
};
const reais = (value: bigint): number => Number(value) / 100;
const brl = (value: bigint): string => `R$ ${(value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(value % 100n).padStart(2, "0")}`;
const quantity = (value: unknown): string => {
  const raw = String(value ?? "1");
  return raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, "").replace(".", ",") : raw;
};

// ---------------------------------------------------------------- Documento da ordem

/** Documento comercial da fase 3 para a ordem (âncora "document" da origem
 * os/<ordem>/main). A âncora é conferida nos dois sentidos (module-origin). */
export function osDocument(ctx: RpcContext, orderId: string): Row | null {
  const anchor = one(ctx.db, `SELECT result FROM erp_documents__command WHERE json_extract(result,'$.policy')=? AND json_extract(result,'$.type')='anchor'
    AND json_extract(result,'$.source.module')='os' AND json_extract(result,'$.source.source_id')=? AND json_extract(result,'$.source.component')='main'
    AND json_extract(result,'$.slot')='document' AND json_extract(result,'$.target.kind')='document' LIMIT 1`, ORIGIN_POLICY, orderId);
  if (!anchor) return null;
  const id = String(object(parse(anchor.result).target).id ?? "");
  const verified = UUID.test(id) ? targetOrigin(ctx.db, "document", id) : null;
  if (!verified || verified.source.module !== "os" || verified.source.source_id !== orderId) return null;
  const row = one(ctx.db, `SELECT id,kind,number,status,version,body,contact_id,authority,deleted_at,CAST(total AS TEXT) total FROM erp_documents__document WHERE id=?`, id);
  return row && row.kind === "service_orders" ? row : null;
}
function requireOsDocument(ctx: RpcContext, orderId: string): Row {
  const row = osDocument(ctx, orderId);
  if (!row) raise("P0002", "os_document_missing");
  const contact = text(row!.contact_id);
  if (contact && ctx.identity.customer_privacy?.restricted_contact_ids.includes(contact)) raise("42501", "erp_customer_restricted");
  contactRequireVisible(ctx.db, ctx.identity.actor?.user_id ?? null, contact);
  return row!;
}
interface OsItem { id: string; position: number; product_id: string | null; description: string; unit: string; quantity: string;
  gross: bigint; discount: bigint; share: bigint; part: boolean; product: Obj }
/** Itens do documento com o desconto do total repartido pelo valor líquido de
 * cada linha (a mesma repartição da NF-e das peças, source.ts). */
function osItems(ctx: RpcContext, document: Row): OsItem[] {
  const rows = ctx.db.exec('SELECT id,position,product_id,data,product_snapshot FROM erp_documents__item WHERE document_id=? ORDER BY position,id', document.id).rows;
  const items = rows.map(row => {
    const data = parse(row.data);
    return { id: String(row.id), position: Number(row.position), product_id: text(row.product_id), description: text(data.description) ?? "Serviço",
      unit: text(data.unit) ?? "UN", quantity: String(data.quantity ?? "1"), gross: cents(data.gross), discount: cents(data.discount), share: 0n,
      part: osPartItem(data as JsonObject), product: parse(row.product_snapshot) };
  });
  const shares = allocateShares(cents(object(parse(document.body).totals).discount), items.map(item => item.gross - item.discount < 0n ? 0n : item.gross - item.discount));
  items.forEach((item, index) => { item.share = shares[index]; });
  return items;
}

// ---------------------------------------------------------------- Cadastro fiscal do serviço

interface ServiceCodes { national_code?: string | null; municipal_code?: string | null; nbs?: string | null; iss_rate?: string | null }
export interface NfseSettingsView {
  version: number; national_code: string | null; municipal_code: string | null; nbs: string | null; iss_rate: string | null;
  iss_withheld: boolean; simples_apportionment: number | null; municipality_code: string | null; parts_nature_id: string | null;
  resolved_parts_nature_id: string | null; items: Record<string, ServiceCodes>;
  services: { id: string; name: string; code: string | null }[]; natures: { id: string; description: string }[];
  company: { crt: string | null; municipality_code: string | null; regime: string };
  updated_at: string | null; updated_by: string | null;
}
const REGIME: Record<string, string> = { "1": "Simples Nacional", "2": "Simples Nacional (excesso de sublimite)", "3": "Regime normal", "4": "MEI" };
function companyData(ctx: RpcContext): { identity: Obj; crt: string | null; versions: Obj } {
  const identity = one(ctx.db, 'SELECT version,data FROM "erp_company__identity" WHERE singleton=1');
  const fiscal = one(ctx.db, 'SELECT version,crt FROM "erp_company__fiscal" WHERE singleton=1');
  return { identity: parse(identity?.data), crt: fiscal?.crt == null ? null : String(fiscal.crt), versions: { identity: identity?.version ?? null, fiscal: fiscal?.version ?? null } };
}
function partsNatures(ctx: RpcContext, crt: string | null): { id: string; description: string }[] {
  return ctx.db.exec(`SELECT id,description FROM "erp_fiscal_invoices__nature" WHERE direction='1' AND active=1 AND deleted_at IS NULL
    AND return_operation=0 AND invoiced=1 AND crt=? ORDER BY description,id`, crt).rows.map(row => ({ id: String(row.id), description: String(row.description) }));
}
export function readNfseSettings(ctx: RpcContext): NfseSettingsView {
  const row = one(ctx.db, `SELECT *,CAST(updated_at AS TEXT) updated_at FROM ${NFSE_SETTINGS_TABLE} WHERE id=1`);
  const company = companyData(ctx), natures = partsNatures(ctx, company.crt);
  const chosen = typeof row?.parts_nature_id === "string" && natures.some(n => n.id === row.parts_nature_id) ? String(row.parts_nature_id) : null;
  const services = ctx.db.exec(`SELECT r.id,r.name,r.code FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id
    WHERE r.entity='products' AND r.active=1 AND p.kind='S' ORDER BY r.name,r.id LIMIT 500`).rows
    .map(service => ({ id: String(service.id), name: String(service.name), code: service.code == null ? null : String(service.code) }));
  const value = (key: string) => row?.[key] == null ? null : String(row[key]);
  return { version: Number(row?.version ?? 1), national_code: value("national_code"), municipal_code: value("municipal_code"), nbs: value("nbs"),
    iss_rate: value("iss_rate"), iss_withheld: row?.iss_withheld === 1, simples_apportionment: row?.simples_apportionment == null ? null : Number(row.simples_apportionment),
    municipality_code: value("municipality_code"), parts_nature_id: value("parts_nature_id"),
    resolved_parts_nature_id: chosen ?? (natures.length === 1 ? natures[0].id : null), items: parse(row?.items) as Record<string, ServiceCodes>,
    services, natures, company: { crt: company.crt, municipality_code: text(company.identity.municipality_code), regime: REGIME[company.crt ?? ""] ?? "Regime não confirmado" },
    updated_at: value("updated_at"), updated_by: value("updated_by") };
}
const codeOrNull = (value: unknown, digits: number, field: string): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !new RegExp(`^\\d{${digits}}$`).test(value)) invalid(`nfse_${field}_invalid`);
  return value as string;
};
const rateOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "number" ? value.toFixed(2) : typeof value === "string" ? value.replace(",", ".") : "";
  if (!/^\d(\.\d{1,2})?$/.test(raw)) return invalid("nfse_iss_rate_invalid");
  return Number(raw).toFixed(2);
};
function saveNfseSettings(ctx: RpcContext, value: Obj): NfseSettingsView {
  return withCom1Model("nfse", () => {
    const actor = requireCom1Access(ctx, "configure");
    com1Uuid(value.command_id);
    if (!Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 1) invalid();
    const national = codeOrNull(value.national_code, 6, "national_code"), municipal = codeOrNull(value.municipal_code, 3, "municipal_code");
    const nbs = codeOrNull(value.nbs, 9, "nbs"), municipality = codeOrNull(value.municipality_code, 7, "municipality_code"), rate = rateOrNull(value.iss_rate);
    if (value.iss_withheld !== undefined && typeof value.iss_withheld !== "boolean") invalid();
    if (value.simples_apportionment != null && ![1, 2, 3].includes(Number(value.simples_apportionment))) invalid("nfse_simples_apportionment_invalid");
    if (value.parts_nature_id != null) com1Uuid(value.parts_nature_id);
    const rawItems = value.items === undefined ? {} : object(value.items);
    if (value.items !== undefined && (value.items === null || rawItems !== value.items)) invalid();
    if (Object.keys(rawItems).length > 500) invalid("nfse_items_too_many");
    const items: Record<string, ServiceCodes> = {};
    for (const [productId, codes] of Object.entries(rawItems)) {
      com1Uuid(productId);
      const entry = object(codes);
      if (entry !== codes || Object.keys(entry).some(key => !["national_code", "municipal_code", "nbs", "iss_rate"].includes(key))) invalid();
      const clean: ServiceCodes = {};
      const n = codeOrNull(entry.national_code, 6, "national_code"), m = codeOrNull(entry.municipal_code, 3, "municipal_code");
      const b = codeOrNull(entry.nbs, 9, "nbs"), r = rateOrNull(entry.iss_rate);
      if (n) clean.national_code = n; if (m) clean.municipal_code = m; if (b) clean.nbs = b; if (r) clean.iss_rate = r;
      if (Object.keys(clean).length) items[productId] = clean;
    }
    return ctx.db.transaction(() => {
      const args = { scope: "nfse_config", ...value };
      if (replayCommand(ctx, { command_id: String(value.command_id), action: "config_save", args })) return readNfseSettings(ctx);
      const before = readNfseSettings(ctx);
      if (before.version !== value.expected_version) raise("40001", "fiscal_config_conflict");
      if (value.parts_nature_id != null && !before.natures.some(n => n.id === value.parts_nature_id)) raise("22023", "fiscal_nature_missing");
      for (const productId of Object.keys(items))
        if (!one(ctx.db, `SELECT 1 FROM erp_catalog__record WHERE id=? AND entity='products'`, productId)) raise("22023", "nfse_service_missing");
      const at = String(ctx.clock.next());
      ctx.db.exec(`INSERT INTO ${NFSE_SETTINGS_TABLE} (id,version,national_code,municipal_code,nbs,iss_rate,iss_withheld,simples_apportionment,municipality_code,parts_nature_id,items,updated_at,updated_by)
        VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,national_code=excluded.national_code,municipal_code=excluded.municipal_code,
        nbs=excluded.nbs,iss_rate=excluded.iss_rate,iss_withheld=excluded.iss_withheld,simples_apportionment=excluded.simples_apportionment,
        municipality_code=excluded.municipality_code,parts_nature_id=excluded.parts_nature_id,items=excluded.items,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
        before.version + 1, national, municipal, nbs, rate, value.iss_withheld === true ? 1 : 0,
        value.simples_apportionment == null ? null : Number(value.simples_apportionment), municipality, value.parts_nature_id ?? null, JSON.stringify(items), at, actor.user_id);
      const command = startCommand(ctx, { command_id: String(value.command_id), action: "config_save", args });
      finishCommand(ctx, command.id, "completed", { version: before.version + 1 });
      appendCom1Audit(ctx, { command, action: "nfse_config_save", before: { version: before.version }, after: { version: before.version + 1 } });
      return readNfseSettings(ctx);
    });
  });
}

// ---------------------------------------------------------------- NFS-e: fontes e corpo

const SCREEN = "nfse_settings";
function configurationBlockers(ctx: RpcContext, issuerCnpj: unknown): FiscalBlocker[] {
  const settings = readCommercialSettings(ctx), blockers: FiscalBlocker[] = [];
  const block = (code: string, field: string, message: string) => blockers.push({ code, field, message, correction: { screen: "fiscal_settings", field } });
  const connection = settings.connection_public;
  if (!connection || !settings.connection_fingerprint) block("fiscal_provider_not_configured", "connection", "Configure o endereço e a chave do cofre e use Testar conexão para emitir a nota.");
  else {
    if (connection.compatible !== true) block("fiscal_provider_incompatible", "connection.version", "A versão do cofre não é compatível com esta integração.");
    if (!Array.isArray(connection.environments) || !connection.environments.includes(settings.environment))
      block("fiscal_environment_not_allowed", "environment", "A chave do cofre não permite o ambiente selecionado.");
    if (connection.issuer_cnpj !== issuerCnpj) block("fiscal_issuer_mismatch", "company.cnpj", "O CNPJ da empresa difere do emitente configurado no cofre.");
  }
  if (settings.environment === "producao" && (!settings.production_enabled_at || !settings.tax_limits_acknowledged_at))
    block("fiscal_production_not_enabled", "environment", "Um administrador precisa habilitar a emissão em produção.");
  return blockers;
}

export interface ServiceSources {
  snapshot: CommercialSnapshot; tax_sources: JsonObject; commercial_hash: string; source_fingerprint: string;
  document_version: number; lines: OsItem[]; settings: NfseSettingsView; company: Obj; crt: string | null; recipient: Obj | null;
}
/** Captura síncrona das fontes da NFS-e: documento da fase 3 (serviços),
 * empresa, tomador (o pagador da ordem), cadastro fiscal do serviço e a
 * configuração do cofre. Não altera nada. */
export function captureServiceSources(ctx: RpcContext, document: Row): ServiceSources {
  const items = osItems(ctx, document), lines = items.filter(item => !item.part);
  const settings = readNfseSettings(ctx), company = companyData(ctx);
  const contactId = text(document.contact_id);
  const recipient = contactId ? object(contactSnapshot(ctx.db, contactId)) : null;
  if (recipient) {
    const municipality = resolvePreparationMunicipality(ctx.db, recipient.city, recipient.state);
    if (municipality) Object.assign(recipient, { municipality_code: municipality.code, municipality_name: municipality.name });
  }
  const body = parse(document.body);
  const productIds = [...new Set(lines.map(line => line.product_id).filter((id): id is string => !!id))].sort();
  const reform = productIds.filter(id => one(ctx.db, 'SELECT 1 FROM erp_fiscal_reform__product_class WHERE product_id=?', id));
  const config = readCommercialSettings(ctx);
  const plain = (line: OsItem) => ({ id: line.id, position: line.position, product_id: line.product_id, description: line.description, unit: line.unit,
    quantity: line.quantity, gross: line.gross.toString(), discount: line.discount.toString(), share: line.share.toString() });
  const commercial = { document_id: String(document.id), status: String(document.status), contact_id: contactId, total: String(document.total ?? ""),
    discount: String(object(body.totals).discount ?? "0"), lines: lines.map(plain) };
  const commercialHash = com1Hash(commercial);
  const { version: _v, updated_at: _u, updated_by: _b, services: _s, natures: _n, ...settingsContent } = settings;
  const sourceFingerprint = com1Hash({ commercial_hash: commercialHash, company: company.identity, crt: company.crt, recipient, reform,
    settings: settingsContent, config: { environment: config.environment, connection_fingerprint: config.connection_fingerprint,
      production_enabled: config.production_enabled_at !== null, tax_limits_acknowledged: config.tax_limits_acknowledged_at !== null } });
  const snapshot: CommercialSnapshot = {
    document: { id: String(document.id), kind: "service_orders", number: document.number == null ? null : String(document.number), status: String(document.status),
      version: Number(document.version), contact_id: contactId, body: body as JsonObject } as JsonObject,
    items: lines.map(plain) as unknown as JsonObject[], company: { ...company.identity, crt: company.crt } as JsonObject,
    recipient: (recipient ?? {}) as JsonObject, products: productIds.map(id => ({ id, reform_class: reform.includes(id) })) as unknown as JsonObject[],
    nature: {}, payments: [], transport: {},
    sources: [{ entity: "document", id: String(document.id), version: Number(document.version), fields: ["items", "totals", "contact_id"] },
      { entity: "nfse_settings", id: "1", version: settings.version, fields: Object.keys(settingsContent).sort() }],
  };
  return { snapshot, tax_sources: { scope: "os_services", service_settings: settingsContent as unknown as JsonObject, reform_products: reform } as JsonObject,
    commercial_hash: commercialHash, source_fingerprint: sourceFingerprint, document_version: Number(document.version), lines, settings,
    company: company.identity, crt: company.crt, recipient };
}

const digits = (value: unknown): string => typeof value === "string" ? value.replace(/[^0-9A-Za-z]/g, "").toUpperCase() : "";
const validCnpj = (value: string): boolean => { try { return normalizeCnpj(value) === value; } catch { return false; } };

/** Corpo PedidoNfse e bloqueios. Um DPS tem um serviço só: os serviços da
 * ordem precisam do mesmo código de tributação nacional; a discriminação
 * lista cada linha como a pessoa escreveu (os campos sensíveis do modelo já
 * ficaram fora do documento da fase 3). */
export function buildServiceNote(ctx: RpcContext, sources: ServiceSources, reference: string) {
  const settings = sources.settings, blockers: FiscalBlocker[] = [];
  const block = (code: string, field: string, message: string, screen = SCREEN, id?: string) =>
    blockers.push({ code, field, message, correction: { screen, field, ...(id ? { id } : {}) } });
  const environment = readCommercialSettings(ctx).environment;
  const lines = sources.lines;
  if (!lines.length) block("nfse_no_services", "servico", "Esta ordem não tem serviços no orçamento: não há nota de serviço a emitir.", "service_order");
  if (String(ctx.db.exec("SELECT status FROM erp_documents__document WHERE id=?", sources.snapshot.document.id).rows[0]?.status) === "cancelled")
    block("fiscal_order_unavailable", "document_id", "A ordem foi cancelada no ERP: não há nota a emitir.", "service_order");
  const codeOf = (line: OsItem): ServiceCodes => ({ ...(line.product_id ? settings.items[line.product_id] ?? {} : {}) });
  const national = new Set<string>(), municipal = new Set<string>(), nbs = new Set<string>(), rates = new Set<string>();
  for (const line of lines) {
    const own = codeOf(line), code = own.national_code ?? settings.national_code;
    if (!code) block("nfse_service_code_missing", line.product_id ? `items.${line.product_id}.national_code` : "national_code",
      `Falta o código de tributação nacional do serviço "${line.description}". Cadastre em Preferências do Fiscal → Nota de serviço.`);
    else national.add(code);
    const m = own.municipal_code ?? settings.municipal_code; if (m) municipal.add(m);
    const b = own.nbs ?? settings.nbs; if (b) nbs.add(b);
    const r = own.iss_rate ?? settings.iss_rate; if (r) rates.add(r);
  }
  if (national.size > 1) block("nfse_service_code_mixed", "national_code",
    "Os serviços desta ordem têm códigos de tributação diferentes, e uma nota de serviço leva um código só. Use o mesmo código para esses serviços em Preferências do Fiscal → Nota de serviço.");
  if (municipal.size > 1 || nbs.size > 1 || rates.size > 1) block("nfse_service_code_mixed", "items",
    "Os serviços desta ordem têm código municipal, NBS ou alíquota diferentes, e uma nota de serviço leva um valor só. Iguale os cadastros em Preferências do Fiscal → Nota de serviço.");
  if (sources.snapshot.products.some(product => (product as Obj).reform_class === true))
    block("fiscal_reform_unsupported", "items.reform_class", "Um serviço desta ordem tem classificação de IBS/CBS no cadastro. A nota de serviço ainda não envia IBS, CBS e IS: a emissão fica bloqueada. Confira com o contador.", "products");

  // Prestador: município e regime vêm do ERP; inscrição municipal, série da DPS e regime especial ficam no cofre.
  const companyMunicipality = text(sources.company.municipality_code);
  if (!companyMunicipality || !/^\d{7}$/.test(companyMunicipality))
    block("nfse_company_municipality_missing", "company.municipality_code", "Falta o código do município da empresa (IBGE). Confira em Dados da empresa.", "company");
  const crt = sources.crt, withheld = settings.iss_withheld, rate = [...rates][0] ?? null;
  let regime: Obj | null = null;
  if (crt === "1" || crt === "2") regime = { simplesNacional: "me_epp", apuracaoSimples: settings.simples_apportionment ?? (crt === "2" ? 2 : 1) };
  else if (crt === "4") regime = { simplesNacional: "mei" };
  else if (crt === "3") regime = { simplesNacional: "nao_optante" };
  else block("nfse_regime_missing", "company.crt", "Confirme o regime tributário (CRT) da empresa em Dados da empresa → Fiscal.", "company");
  // Simples Nacional não exige alíquota; fora dele (ou com ISS retido) o contrato precisa dela.
  if (!rate && (crt === "3" || withheld))
    block("nfse_iss_rate_missing", "iss_rate", crt === "3"
      ? "Empresa fora do Simples Nacional: informe a alíquota do ISS em Preferências do Fiscal → Nota de serviço."
      : "Com ISS retido pelo cliente, informe a alíquota do ISS em Preferências do Fiscal → Nota de serviço.");
  const place = settings.municipality_code ?? companyMunicipality;

  // Tomador: o pagador da ordem (contato do documento da fase 3).
  let tomador: Obj | undefined;
  const r = sources.recipient;
  if (r) {
    const name = text(r.name);
    const document = digits(r.document);
    tomador = { nome: (name ?? "Cliente").slice(0, 300) };
    if (document) {
      if (r.person_type === "F" && /^\d{11}$/.test(document) && cpfValid(document)) tomador.cpf = document;
      else if (r.person_type !== "F" && /^[0-9A-Z]{12}\d{2}$/.test(document) && validCnpj(document)) tomador.cnpj = document;
      else block("nfse_recipient_document_invalid", "recipient.document", `O CPF ou CNPJ de ${name ?? "cliente"} não confere. Corrija no cadastro do contato.`, "contacts", String(r.contact_id ?? ""));
    }
    const cep = digits(r.postal_code), municipality = text(r.municipality_code);
    if (municipality && /^\d{8}$/.test(cep) && text(r.street) && text(r.number) && text(r.district))
      tomador.endereco = { codigoMunicipio: municipality, cep, logradouro: String(r.street).trim().slice(0, 255), numero: String(r.number).trim().slice(0, 60),
        ...(text(r.complement) ? { complemento: String(r.complement).trim().slice(0, 156) } : {}), bairro: String(r.district).trim().slice(0, 60) };
    const email = text(r.email);
    if (email && email.length <= 80 && /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) tomador.email = email;
    const phone = digits(r.mobile ?? r.phone);
    if (/^\d{6,20}$/.test(phone)) tomador.telefone = phone;
  }
  if (withheld && !tomador?.cnpj) block("nfse_withholding_requires_cnpj", "recipient.document", "ISS retido pelo cliente exige cliente com CNPJ. Confira o cadastro do pagador ou desmarque a retenção.");

  const gross = lines.reduce((sum, line) => sum + line.gross, 0n);
  const discount = lines.reduce((sum, line) => sum + line.discount + line.share, 0n);
  if (lines.length && gross - discount <= 0n) block("nfse_total_zero", "valores.servico", "O valor dos serviços desta ordem, com os descontos, é zero: não há nota de serviço a emitir.", "service_order");
  const description = lines.map(line => `${quantity(line.quantity)} ${line.unit} ${line.description} - ${brl(line.gross)}`).join("\n");
  if (description.length > 2000) block("nfse_description_too_long", "servico.descricao", "A discriminação dos serviços passa de 2.000 caracteres. Resuma as descrições no orçamento.", "service_order");

  const issqn: Obj = { tipo: "tributavel", retencao: withheld ? "retido_tomador" : "nao_retido" };
  if (rate) issqn.aliquota = Number(rate);
  const servico: Obj = { codigoMunicipioPrestacao: place ?? "", codigoTributacaoNacional: [...national][0] ?? "", descricao: description.slice(0, 2000) || "Serviço" };
  if (municipal.size === 1) servico.codigoTributacaoMunicipal = [...municipal][0];
  if (nbs.size === 1) servico.codigoNbs = [...nbs][0];
  const valores: Obj = { servico: reais(gross) };
  if (discount > 0n) valores.descontoIncondicionado = reais(discount);
  const body: Obj = { ambiente: environment, referencia: reference,
    prestador: { codigoMunicipio: companyMunicipality ?? "", regimeTributario: regime ?? { simplesNacional: "nao_optante" } },
    ...(tomador ? { tomador } : {}), servico, valores, tributacao: { issqn } };
  const unique = [...new Map([...blockers, ...configurationBlockers(ctx, sources.company.cnpj)].map(b => [`${b.field}|${b.code}|${b.item_id ?? ""}`, b])).values()]
    .sort((a, b) => a.field < b.field ? -1 : a.field > b.field ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const calculation: JsonObject = { model: "nfse", lines: lines.map(line => ({ id: line.id, description: line.description, quantity: line.quantity,
    gross_cents: line.gross.toString(), discount_cents: (line.discount + line.share).toString() })), gross_cents: gross.toString(),
    discount_cents: discount.toString(), total_cents: (gross - discount).toString(), national_code: [...national][0] ?? null, iss_rate: rate,
    iss_withheld: withheld, regime: crt ? REGIME[crt] ?? null : null, place: place ?? null };
  return { body, blockers: unique, calculation };
}

/** Releitura das fontes no claim (mesma transação): mudança exige preparar de novo. */
export function recaptureServiceFingerprint(ctx: RpcContext, revision: ImmutableRevision): string {
  const document = one(ctx.db, `SELECT id,kind,number,status,version,body,contact_id,authority,deleted_at,CAST(total AS TEXT) total FROM erp_documents__document WHERE id=?`,
    String(revision.snapshot.document.id));
  if (!document) raise("22023", "fiscal_source_changed");
  return captureServiceSources(ctx, document!).source_fingerprint;
}

// ---------------------------------------------------------------- Preparo

interface PrepareValue { order_id: string; kind: OsNoteKind; command_id: string; expected_emission_version?: number; new_fiscal_version?: boolean }
function validatePrepare(value: Obj): PrepareValue {
  com1Uuid(value.order_id); com1Uuid(value.command_id);
  if (value.kind !== "nfse" && value.kind !== "nfe") invalid();
  if (value.expected_emission_version !== undefined && (!Number.isSafeInteger(value.expected_emission_version) || Number(value.expected_emission_version) < 1)) invalid();
  if (value.new_fiscal_version !== undefined && typeof value.new_fiscal_version !== "boolean") invalid();
  return value as unknown as PrepareValue;
}
/** Versão fiscal e conferências da emissão anterior (como prepare.ts). */
function fiscalVersionFor(ctx: RpcContext, documentId: string, value: PrepareValue) {
  const settings = readCommercialSettings(ctx);
  const previous = findOrderEmission(ctx, documentId);
  if (previous && previous.environment !== settings.environment) raise("40001", "fiscal_environment_conflict");
  if (value.new_fiscal_version) {
    if (!previous || !["cancelada", "denegada"].includes(previous.status) || previous.version !== value.expected_emission_version) raise("40001", "fiscal_emission_open");
  } else if (previous && !REWRITABLE.includes(previous.status)) raise("40001", "fiscal_emission_open");
  if (previous && previous.version !== value.expected_emission_version) raise("40001", "com1_version_conflict");
  return { settings, previous, fiscalVersion: (previous?.fiscal_version ?? 1) + (value.new_fiscal_version ? 1 : 0) };
}
function replayed(ctx: RpcContext, value: PrepareValue): PreparationResult | null {
  const receipt = replayCommand(ctx, { command_id: value.command_id, action: "prepare", args: value });
  if (!receipt?.emission_id) return null;
  const emission = getEmissionView(ctx, receipt.emission_id);
  requireCommercialEmissionVisible(ctx, emission);
  return { emission, blockers: emission.revision.blockers, effects_preview: preparationEffectsPreview(ctx, emission.id), replayed: true };
}

function prepareService(ctx: RpcContext, value: PrepareValue): PreparationResult {
  return withCom1Model("nfse", () => {
    requireCom1Access(ctx, "prepare");
    requireErpParts(ctx, erpRequirement("erp-fiscal"));
    return ctx.db.transaction(() => {
      const replay = replayed(ctx, value);
      if (replay) return replay;
      const document = requireOsDocument(ctx, value.order_id);
      const { settings, previous, fiscalVersion } = fiscalVersionFor(ctx, String(document.id), value);
      const reference = com1Reference(String(document.id), fiscalVersion);
      const sources = captureServiceSources(ctx, document);
      const built = buildServiceNote(ctx, sources, reference);
      const saved = savePreparation(ctx, { command_id: value.command_id, args: value, document_id: String(document.id),
        expected_document_version: sources.document_version, ...(previous ? { expected_emission_version: previous.version } : {}),
        ...(value.new_fiscal_version ? { new_fiscal_version: true } : {}),
        environment: settings.environment, connection_fingerprint: settings.connection_fingerprint, snapshot: sources.snapshot,
        tax_sources: sources.tax_sources, commercial_hash: sources.commercial_hash, source_fingerprint: sources.source_fingerprint,
        body: built.blockers.length ? null : built.body as unknown as PedidoNfe, calculation: built.calculation, blockers: built.blockers });
      return { ...saved, blockers: saved.emission.revision.blockers, effects_preview: preparationEffectsPreview(ctx, saved.emission.id) };
    });
  });
}

/** Peças sem vínculo com produto do catálogo não podem ir à NF-e (NCM, origem...). */
function partsBlockers(ctx: RpcContext, document: Row): FiscalBlocker[] {
  const parts = osItems(ctx, document).filter(item => item.part);
  const blockers: FiscalBlocker[] = [];
  if (!parts.length) blockers.push({ code: "os_no_parts", field: "items", message: "Esta ordem não tem peças no orçamento: não há nota de peças a emitir.", correction: { screen: "service_order" } });
  for (const part of parts) if (!part.product_id || part.product.kind === "S")
    blockers.push({ code: "os_part_without_product", field: `items.${part.id}.product_id`, item_id: part.id,
      message: `A peça "${part.description}" não está ligada a um produto do catálogo. Vincule a peça ao produto no orçamento da ordem.`, correction: { screen: "service_order", field: "items" } });
  return blockers;
}
function capturePartsNfe(ctx: RpcContext, document: Row, natureId: string) {
  let choices: FiscalChoices = { nature_id: natureId, presence: "presencial", final_consumer: true, series: null };
  let sources = capturePreparationSources(ctx, { document_id: String(document.id), expected_document_version: Number(document.version),
    command_id: "00000000-0000-0000-0000-000000000000", choices }, "os_parts");
  // Cliente contribuinte do ICMS não é consumidor final.
  if (sources.snapshot.recipient.taxpayer === "1") {
    choices = { ...choices, final_consumer: false };
    sources = capturePreparationSources(ctx, { document_id: String(document.id), expected_document_version: Number(document.version),
      command_id: "00000000-0000-0000-0000-000000000000", choices }, "os_parts");
  }
  return { sources, choices };
}
function buildPartsNfe(ctx: RpcContext, document: Row, reference: string) {
  const nfse = readNfseSettings(ctx), settings = readCommercialSettings(ctx);
  const natureId = nfse.resolved_parts_nature_id;
  const natureBlocker: FiscalBlocker[] = natureId ? [] : [{ code: "fiscal_nature_missing", field: "naturezaOperacao",
    message: nfse.natures.length ? "Escolha a natureza de operação da nota de peças em Preferências do Fiscal → Nota de serviço (há mais de uma possível)."
      : "Cadastre uma natureza de operação de venda (saída, faturada, do mesmo regime da empresa) para a nota de peças.",
    correction: { screen: "fiscal_natures", field: "naturezaOperacao" } }];
  // Sem natureza, a captura usa uma qualquer só para mostrar os demais bloqueios.
  const { sources, choices } = capturePartsNfe(ctx, document, natureId ?? nfse.natures[0]?.id ?? "");
  const config = configuration(settings, choices, sources.snapshot.company.cnpj);
  const taxes = calculatePreparationTaxes(sources);
  const mapped = mapPreparation(sources, taxes, { environment: settings.environment, reference, series: config.series });
  // Sem natureza, os bloqueios de regra, CFOP e impostos são consequência dela:
  // a tela mostra só o que fazer primeiro (cadastrar ou escolher a natureza).
  const fiscal = natureId ? [...sources.blockers, ...taxes.blockers, ...mapped.blockers] : sources.blockers.filter(b => !/^(nature|items\.|itens\[)/.test(b.field));
  const blockers = [...new Map([...partsBlockers(ctx, document), ...fiscal, ...config.blockers, ...natureBlocker]
    .map(blocker => [`${blocker.field}|${blocker.code}|${blocker.item_id ?? ""}`, blocker])).values()];
  return { sources, mapped, blockers, settings };
}
function prepareParts(ctx: RpcContext, value: PrepareValue): PreparationResult {
  return withCom1Model("nfe", () => {
    requireCom1Access(ctx, "prepare");
    requireErpParts(ctx, erpRequirement("erp-vendas", "erp-fiscal"));
    if (!ctx.parts.products) raise("55000", "module_disabled");
    return ctx.db.transaction(() => {
      const replay = replayed(ctx, value);
      if (replay) return replay;
      const document = requireOsDocument(ctx, value.order_id);
      const { previous, fiscalVersion } = fiscalVersionFor(ctx, String(document.id), value);
      const reference = com1Reference(String(document.id), fiscalVersion);
      const { sources, mapped, blockers, settings } = buildPartsNfe(ctx, document, reference);
      const saved = savePreparation(ctx, { command_id: value.command_id, args: value, document_id: String(document.id),
        expected_document_version: Number(document.version), ...(previous ? { expected_emission_version: previous.version } : {}),
        ...(value.new_fiscal_version ? { new_fiscal_version: true } : {}),
        environment: settings.environment, connection_fingerprint: settings.connection_fingerprint, snapshot: sources.snapshot,
        tax_sources: sources.tax_sources, commercial_hash: sources.commercial_hash, source_fingerprint: sources.source_fingerprint,
        body: blockers.length ? null : mapped.body, calculation: { ...mapped.calculation, model: "nfe", scope: "os_parts" } as JsonObject, blockers });
      return { ...saved, blockers: saved.emission.revision.blockers, effects_preview: preparationEffectsPreview(ctx, saved.emission.id) };
    });
  });
}
export function prepareOsNote(ctx: RpcContext, raw: Obj): PreparationResult {
  const value = validatePrepare(raw);
  return value.kind === "nfse" ? prepareService(ctx, value) : prepareParts(ctx, value);
}

// ---------------------------------------------------------------- Visão das notas da ordem

export interface OsNoteSummary {
  id: string; model: OsNoteKind; status: string; provider_status: string | null; version: number; body_revision: number; body_hash: string | null;
  environment: string; fiscal_version: number; series: number | null; number: number | null; access_key: string | null;
  /** Na NFS-e, o número da NFS-e; na NF-e, o protocolo de autorização. */
  protocol: string | null; authorized_at: string | null; total: string | null;
  messages: { code: string; description: string }[]; blockers: FiscalBlocker[];
  cancellation: null | { state: string; justification: string; messages: { code: string; description: string }[]; xml_status: string };
  effects: { axis: string; state: string; reason: string | null }[];
}
export interface OsNoteSection {
  kind: OsNoteKind; lines: { id: string; description: string; quantity: string; total_cents: string }[]; total_cents: string;
  emission: OsNoteSummary | null; blockers: FiscalBlocker[]; ready: boolean;
}
export interface OsNotesView {
  order_id: string; environment: string;
  document: null | { id: string; number: string | null; status: string; version: number; total: string | null };
  nfse: OsNoteSection; nfe: OsNoteSection;
}
function summary(view: EmissionView, model: OsNoteKind): OsNoteSummary {
  return { id: view.id, model, status: view.status, provider_status: view.provider_status, version: view.version, body_revision: view.current_body_revision,
    body_hash: view.revision.body_hash, environment: view.environment, fiscal_version: view.fiscal_version, series: view.series, number: view.number,
    access_key: view.access_key, protocol: view.protocol, authorized_at: view.authorized_at, total: view.total, messages: view.messages,
    blockers: view.revision.blockers, cancellation: view.cancellation ? { state: view.cancellation.state, justification: view.cancellation.justification,
      messages: view.cancellation.messages, xml_status: view.cancellation.xml_status } : null,
    effects: view.effects.map(effect => ({ axis: effect.axis, state: effect.state, reason: effect.reason })) };
}
const emissionOf = (ctx: RpcContext, model: Com1Model, documentId: string): EmissionView | null => withCom1Model(model, () => {
  const stored = findOrderEmission(ctx, documentId);
  return stored ? getEmissionView(ctx, stored.id) : null;
});
/** Dry-run: os bloqueios que o preparo encontraria agora, sem gravar nada. */
function dryRun(run: () => FiscalBlocker[]): FiscalBlocker[] {
  // O ensaio nunca derruba a visão da ordem: o preparo de verdade confere de novo.
  try { return run(); }
  catch (error) {
    const code = error instanceof ErpError && /^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : "os_note_unavailable";
    return [{ code, field: "document_id", message: "A nota não pode ser preparada agora. Abra a ordem de novo e confira os cadastros da empresa, do cliente e dos itens.", correction: { screen: "service_order" } }];
  }
}
export function readOsNotes(ctx: RpcContext, value: Obj): OsNotesView {
  requireCom1Access(ctx, "read");
  requireCommercialReadParts(ctx);
  com1Uuid(value.order_id);
  const orderId = String(value.order_id), environment = readCommercialSettings(ctx).environment;
  const empty = (kind: OsNoteKind, message: string): OsNoteSection => ({ kind, lines: [], total_cents: "0", emission: null, ready: false,
    blockers: [{ code: "os_document_missing", field: "document_id", message, correction: { screen: "service_order" } }] });
  const document = osDocument(ctx, orderId);
  if (!document) {
    const message = "A ordem ainda não tem o documento comercial no ERP. Monte e aprove o orçamento; a integração com o ERP gera o documento.";
    return { order_id: orderId, environment, document: null, nfse: empty("nfse", message), nfe: empty("nfe", message) };
  }
  requireOsDocument(ctx, orderId);
  const items = osItems(ctx, document);
  const section = (kind: OsNoteKind): OsNoteSection => {
    const lines = items.filter(item => kind === "nfe" ? item.part : !item.part);
    const view = emissionOf(ctx, kind, String(document.id));
    const open = !view || REWRITABLE.includes(view.status);
    const reference = com1Reference(String(document.id), view?.fiscal_version ?? 1);
    const blockers = !open ? [] : kind === "nfse"
      ? dryRun(() => withCom1Model("nfse", () => buildServiceNote(ctx, captureServiceSources(ctx, document), reference).blockers))
      : !ctx.parts.sales || !ctx.parts.products
        ? [{ code: "module_disabled", field: "parts", message: "A nota de peças precisa das partes Vendas e Produtos ligadas. Peça ao administrador para ligá-las em Gestão → Módulos.", correction: { screen: "modules" } }]
        : dryRun(() => withCom1Model("nfe", () => buildPartsNfe(ctx, document, reference).blockers));
    const total = lines.reduce((sum, line) => sum + line.gross - line.discount - line.share, 0n);
    return { kind, lines: lines.map(line => ({ id: line.id, description: line.description, quantity: line.quantity, total_cents: (line.gross - line.discount - line.share).toString() })),
      total_cents: total.toString(), emission: view ? summary(view, kind) : null, blockers, ready: open && lines.length > 0 && blockers.length === 0 };
  };
  return { order_id: orderId, environment,
    document: { id: String(document.id), number: document.number == null ? null : String(document.number), status: String(document.status),
      version: Number(document.version), total: document.total == null ? null : String(document.total) },
    nfse: section("nfse"), nfe: section("nfe") };
}

// ---------------------------------------------------------------- RPCs

function input(args: RpcArgs, allowed: readonly string[], required: readonly string[]): Obj {
  const value = object(args.p_input);
  if (args.p_input !== value || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}
const expectedPerson = (args: RpcArgs): string => typeof args.p_user_id === "string" ? args.p_user_id : invalid();

registerRpc("erp_com1_nfse_config_get", (ctx, a) => withCom1Model("nfse", () => {
  requireCom1Access(ctx, "read", expectedPerson(a));
  return readNfseSettings(ctx);
}));
registerRpc("erp_com1_nfse_config_save", (ctx, a) => withCom1Model("nfse", () => {
  requireCom1Access(ctx, "configure", expectedPerson(a));
  return saveNfseSettings(ctx, input(a, ["command_id", "expected_version", "national_code", "municipal_code", "nbs", "iss_rate", "iss_withheld",
    "simples_apportionment", "municipality_code", "parts_nature_id", "items"], ["command_id", "expected_version"]));
}));
registerRpc("erp_com1_os_notes", (ctx, a) => {
  requireCom1Access(ctx, "read", expectedPerson(a));
  return readOsNotes(ctx, input(a, ["order_id"], ["order_id"]));
});
registerRpc("erp_com1_os_prepare", (ctx, a) => {
  requireCom1Access(ctx, "prepare", expectedPerson(a));
  return prepareOsNote(ctx, input(a, ["order_id", "kind", "command_id", "expected_emission_version", "new_fiscal_version"], ["order_id", "kind", "command_id"]));
});

/** Para o teste e a tela: o modelo da emissão de cada tipo de nota da ordem. */
export const OS_NOTE_MODEL: Readonly<Record<OsNoteKind, Com1Model>> = Object.freeze({ nfse: "nfse", nfe: "nfe" });
export const OS_NOTE_TABLES = { nfse: COM1_MODEL_TABLES.nfse, nfe: COM1_MODEL_TABLES.nfe };
