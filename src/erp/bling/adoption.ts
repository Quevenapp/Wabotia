/** Adoção revisada dos cadastros do acervo do Bling (fatia B1).
 *
 * Lê o registro corrente do acervo, procura um cadastro que já exista e cria,
 * liga ou deixa pendente de revisão. Toda criação e alteração passa pelas RPCs
 * de domínio que as telas usam (invokeRpc: mesmas validações, unicidade,
 * avisos e partes); esta camada só escreve as próprias tabelas de vínculo,
 * revisão, trabalho e recibo. Nada é escrito no Bling. */
import "../domains/index.ts";
import { createHash } from "node:crypto";
import { formatScaled, fromColumn } from "../engine/dec.ts";
import type { Row, SqlDriver } from "../engine/driver.ts";
import { ErpError } from "../engine/errors.ts";
import type { IdentityPort } from "../engine/identity.ts";
import { inTransaction, invokeRpc, type RpcContext } from "../engine/registry.ts";
import { Clock, todaySaoPaulo } from "../engine/time.ts";
import { projectPeople } from "../domains/access/identity.ts";
import { documentIssue } from "../domains/catalog/contact-core.ts";
import { ERP_PART_NAMES, type ErpParts } from "../parts.ts";
import {
  BLING_ADOPTION_ENTITIES, BLING_ADOPTION_LABELS, BLING_ADOPTION_REASONS, BLING_ADOPTION_STOPS, BLING_ADOPTION_UPDATABLE,
  BlingAdoptionError, adoptionEnabled, adoptionModule, adoptionPartOffMessage,
  type BlingAdoptionEntity, type BlingAdoptionJob, type BlingAdoptionLink, type BlingAdoptionOperationMap,
  type BlingAdoptionReason, type BlingAdoptionReview, type BlingAdoptionStatus, type BlingAdoptionStop, type BlingAdoptionSummary,
} from "./adoption-contracts.ts";
import { parseHistoricalPayload } from "./projection.ts";
import { exactDecimalEqual } from "./schema.ts";

type Json = Record<string, unknown>;
type Outcome = "adopted" | "linked" | "pending" | "skipped";
/** Limites de uma unidade do alarme: poucos registros e pouco tempo. */
export const ADOPTION_UNIT = Object.freeze({ records: 25, wall_ms: 1500 });

const clocks = new Map<string, Clock>();
const clockOf = (profile: string) => { let c = clocks.get(profile); if (!c) clocks.set(profile, c = new Clock()); return c; };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** UUID determinístico: repetir a mesma adoção reaproveita o comando do domínio. */
function commandUuid(...parts: string[]): string {
  const h = sha(parts.join("\u0000"));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const object = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const at = (v: unknown, ...path: string[]): unknown => { for (const p of path) { if (!object(v)) return undefined; v = v[p]; } return v; };
/** Texto limpo; vazio vira null. Números do acervo chegam lexicais (string). */
const text = (v: unknown): string | null => {
  if (typeof v === "number" || typeof v === "boolean") v = String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t : null;
};
const fold = (v: unknown) => text(v)?.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "") ?? null;
const digitsAndLetters = (v: unknown) => text(v)?.toUpperCase().replace(/[^0-9A-Z]/g, "") || null;
const sameText = (a: unknown, b: unknown) => fold(a) === fold(b);
const clip = (v: string | null, n = 200) => v === null ? null : v.length > n ? v.slice(0, n - 1) + "…" : v;

// ---------------------------------------------------------------------------
// Acervo

export interface AdoptionRaw { source_id: string; version: number; hash: string; payload: Json; deleted: boolean }
function readRaw(db: SqlDriver, entity: BlingAdoptionEntity, source: string): AdoptionRaw | null {
  const row = db.exec(`SELECT r.source_id, r.version, r.version_hash, r.payload,
      CASE WHEN json_type(r.payload,'$._brufap_source.deleted')='true' OR coalesce(m.deleted_observed,0)=1 THEN 1 ELSE 0 END AS deleted
    FROM origin_sync__raw_record r LEFT JOIN wb_bling_record_version m ON m.entity=r.entity AND m.source_id=r.source_id AND m.version=r.version
    WHERE r.entity=? AND r.source_id=?`, entity, source).rows[0];
  if (!row) return null;
  let payload: Json;
  try { payload = parseHistoricalPayload(String(row.payload)).payload as Json; } catch { payload = {}; }
  return { source_id: String(row.source_id), version: Number(row.version), hash: String(row.version_hash), payload, deleted: Number(row.deleted) === 1 };
}
function archiveAvailable(db: SqlDriver): boolean {
  const control = db.exec("SELECT account_id, state FROM wb_bling_control WHERE id=1").rows[0];
  return !!control?.account_id && control.state !== "purging";
}

// ---------------------------------------------------------------------------
// Do Bling para os dados das RPCs do ERP

interface Mapped {
  name: string | null;
  /** p_data da criação (ou da atualização, quando a entidade permite). */
  data: Json;
  summary: BlingAdoptionSummary;
  /** Motivo que impede adotar sem revisão (antes de procurar). */
  blocked?: { reason: BlingAdoptionReason; detail?: string };
  extra?: Json;
}
const CONTACT_ROLE: [RegExp, string][] = [[/^cliente/i, "customer"], [/^fornecedor/i, "supplier"], [/^transportador/i, "carrier"]];
function mapContact(p: Json): Mapped {
  const name = text(p.nome), document = text(p.numeroDocumento), type = text(p.tipo);
  const person = type && ["F", "J", "E"].includes(type) ? type : null;
  const address = at(p, "endereco", "geral");
  const roles = [...new Set((Array.isArray(p.tiposContato) ? p.tiposContato : [])
    .map(t => text(at(t, "descricao")) ?? "").flatMap(d => CONTACT_ROLE.filter(([re]) => re.test(d)).map(([, role]) => role)))].sort();
  const situation = text(p.situacao);
  const data: Json = {
    name, code: text(p.codigo), trade_name: text(p.fantasia), person_type: person, document, ie: text(p.ie),
    email: text(p.email), phone: text(p.telefone), mobile: text(p.celular),
    postal_code: text(at(address, "cep")), street: text(at(address, "endereco")), number: text(at(address, "numero")),
    complement: text(at(address, "complemento")), district: text(at(address, "bairro")), city: text(at(address, "municipio")),
    state: text(at(address, "uf"))?.toUpperCase() ?? null,
    ...(roles.length ? { roles } : {}), ...(situation && ["A", "I", "S"].includes(situation) ? { situation } : {}),
  };
  for (const key of Object.keys(data)) if (data[key] === null) delete data[key];
  const mapped: Mapped = { name, data, summary: {
    "Nome": name, "CPF/CNPJ": document, "E-mail": text(p.email), "Telefone": text(p.telefone) ?? text(p.celular),
    "Código": text(p.codigo), "Cidade/UF": [text(at(address, "municipio")), text(at(address, "uf"))].filter(Boolean).join("/") || null,
  } };
  if (document && documentIssue(person, document)) mapped.blocked = { reason: "invalid_document", detail: `Documento recebido: ${clip(document, 40)}` };
  if (situation === "E") mapped.blocked = { reason: "source_deleted" };
  return mapped;
}
const PRODUCT_KIND: Record<string, string> = { P: "P", S: "S", N: "N" };
function mapProduct(p: Json, categoryId: string | null): Mapped {
  const name = text(p.nome), price = text(p.preco), format = text(p.formato);
  const gtin = text(p.gtin), ncm = text(at(p, "tributacao", "ncm"))?.replace(/\D/g, "") || null;
  const data: Json = {
    name, code: text(p.codigo), unit: text(p.unidade), price,
    kind: PRODUCT_KIND[text(p.tipo) ?? ""] ?? null, format: format && ["S", "V", "E"].includes(format) ? format : null,
    description: text(p.descricaoCurta), ncm, gtin: gtin && /^([0-9]{8}|[0-9]{12,14})$/.test(gtin) ? gtin : null,
    brand: text(p.marca), ...(categoryId ? { category_id: categoryId } : {}),
  };
  for (const key of Object.keys(data)) if (data[key] === null) delete data[key];
  const situation = text(p.situacao);
  if (situation === "I") data.active = false;
  const mapped: Mapped = { name, data, summary: { "Nome": name, "Código (SKU)": text(p.codigo), "GTIN": gtin, "Preço": price, "Unidade": text(p.unidade), "Tipo": text(p.tipo) === "S" ? "Serviço" : "Produto" } };
  if (situation === "E") mapped.blocked = { reason: "source_deleted" };
  if (gtin && gtin !== "SEM GTIN" && !data.gtin) mapped.blocked = { reason: "invalid_data", detail: `GTIN recebido não é válido: ${clip(gtin, 40)}` };
  if (price !== null && !/^(0|[1-9][0-9]{0,13})(\.[0-9]+)?$/.test(price)) mapped.blocked = { reason: "invalid_data", detail: `Preço recebido não é válido: ${clip(price, 40)}` };
  return mapped;
}
function plainName(p: Json, ...keys: string[]): Mapped {
  const name = keys.map(k => text(p[k])).find(Boolean) ?? null;
  return { name, data: {}, summary: { "Nome": name } };
}
const FIN_KIND: Record<string, "receivable" | "payable"> = { "1": "payable", "2": "receivable", D: "payable", R: "receivable" };
const PAYMENT_TYPES = ["01", "02", "03", "04", "05", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "90", "91", "99"];

// ---------------------------------------------------------------------------
// Cadastros do ERP

const RECORD_SQL: Record<BlingAdoptionEntity, string> = {
  contacts: `SELECT r.id FROM erp_catalog__record r LEFT JOIN erp_catalog__contact_profile p ON p.record_id=r.id WHERE r.id=? AND r.entity='contacts' AND coalesce(p.situation,'A')<>'E'`,
  products: `SELECT r.id FROM erp_catalog__record r WHERE r.id=? AND r.entity='products' AND NOT EXISTS(SELECT 1 FROM erp_catalog__product_detail d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL)`,
  warehouses: `SELECT id FROM erp_catalog__record WHERE id=? AND entity='warehouses'`,
  product_categories: `SELECT id FROM erp_catalog__taxonomy WHERE id=? AND kind='categories'`,
  sellers: `SELECT id FROM erp_catalog__seller WHERE id=?`,
  payment_methods: `SELECT id FROM erp_catalog__payment_method WHERE id=? AND deleted_at IS NULL`,
  financial_categories: `SELECT id FROM erp_finance__category WHERE id=? AND deleted_at IS NULL`,
  ledger_accounts: `SELECT id FROM erp_finance__account WHERE id=? AND deleted_at IS NULL`,
};
const recordExists = (db: SqlDriver, entity: BlingAdoptionEntity, id: string) => db.exec(RECORD_SQL[entity], id).rows.length > 0;
/** Preço como o ERP mostra: texto decimal sem zeros à direita. */
const price10 = (v: unknown) => {
  if (v === null || v === undefined) return null;
  const text = typeof v === "string" ? v : formatScaled(fromColumn(v), 10);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
};

/** Resumo do cadastro do ERP com as mesmas chaves do resumo do Bling. */
export function erpSummary(db: SqlDriver, entity: BlingAdoptionEntity, id: string): BlingAdoptionSummary | null {
  const row = (sql: string) => db.exec(sql, id).rows[0] as Row | undefined;
  const s = (v: unknown) => v === null || v === undefined ? null : clip(String(v), 400);
  if (entity === "contacts") {
    const r = row(`SELECT r.name, r.code, c.document, c.email, c.phone, c.mobile, c.city, c.state FROM erp_catalog__record r LEFT JOIN erp_catalog__contact c ON c.record_id=r.id WHERE r.id=?`);
    return r ? { "Nome": s(r.name), "CPF/CNPJ": s(r.document), "E-mail": s(r.email), "Telefone": s(r.phone ?? r.mobile), "Código": s(r.code), "Cidade/UF": [r.city, r.state].filter(v => v != null && v !== "").join("/") || null } : null;
  }
  if (entity === "products") {
    const r = row(`SELECT r.name, r.code, p.gtin, p.price, p.unit, p.kind FROM erp_catalog__record r LEFT JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.id=?`);
    return r ? { "Nome": s(r.name), "Código (SKU)": s(r.code), "GTIN": s(r.gtin), "Preço": price10(r.price), "Unidade": s(r.unit), "Tipo": r.kind === "S" ? "Serviço" : "Produto" } : null;
  }
  if (entity === "sellers") {
    const r = row(`SELECT r.name FROM erp_catalog__seller s JOIN erp_catalog__record r ON r.id=s.contact_id WHERE s.id=?`);
    return r ? { "Nome": s(r.name) } : null;
  }
  const sql: Record<string, string> = {
    warehouses: "SELECT name FROM erp_catalog__record WHERE id=?", product_categories: "SELECT name FROM erp_catalog__taxonomy WHERE id=?",
    payment_methods: "SELECT description AS name FROM erp_catalog__payment_method WHERE id=?",
    financial_categories: "SELECT name, kind FROM erp_finance__category WHERE id=?", ledger_accounts: "SELECT name FROM erp_finance__account WHERE id=?",
  };
  const r = row(sql[entity]);
  if (!r) return null;
  return entity === "financial_categories" ? { "Nome": s(r.name), "Tipo": r.kind === "receivable" ? "Receita" : r.kind === "payable" ? "Despesa" : s(r.kind) } : { "Nome": s(r.name) };
}

// ---------------------------------------------------------------------------
// Vínculos e revisões

interface LinkRow { record_id: string; source_version: number; mode: string }
function linkOf(db: SqlDriver, entity: BlingAdoptionEntity, source: string): LinkRow | null {
  const r = db.exec("SELECT record_id, source_version, mode FROM wb_bling_adoption_link WHERE entity=? AND source_id=?", entity, source).rows[0];
  return r ? { record_id: String(r.record_id), source_version: Number(r.source_version), mode: String(r.mode) } : null;
}
const linkedTo = (db: SqlDriver, entity: BlingAdoptionEntity, record: string) =>
  (db.exec("SELECT source_id FROM wb_bling_adoption_link WHERE entity=? AND record_id=?", entity, record).rows[0]?.source_id as string | undefined) ?? null;
function writeLink(db: SqlDriver, entity: BlingAdoptionEntity, raw: Pick<AdoptionRaw, "source_id" | "version" | "hash">, record: string, mode: "created" | "linked" | "updated", actor: string, now: number) {
  const other = linkedTo(db, entity, record);
  if (other !== null && other !== raw.source_id) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "O cadastro do ERP já está ligado a outro registro do Bling.");
  db.exec(`INSERT INTO wb_bling_adoption_link(entity,source_id,record_id,source_version,source_hash,mode,adopted_by,adopted_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(entity,source_id) DO UPDATE SET record_id=excluded.record_id, source_version=excluded.source_version, source_hash=excluded.source_hash, mode=excluded.mode, adopted_by=excluded.adopted_by, adopted_at=excluded.adopted_at`,
    entity, raw.source_id, record, raw.version, raw.hash, mode, actor, now);
  db.exec("DELETE FROM wb_bling_adoption_review WHERE entity=? AND source_id=?", entity, raw.source_id);
}
function writeReview(db: SqlDriver, entity: BlingAdoptionEntity, raw: Pick<AdoptionRaw, "source_id" | "version" | "hash">, reason: BlingAdoptionReason, candidates: string[], now: number, detail?: string | null) {
  db.exec(`INSERT INTO wb_bling_adoption_review(entity,source_id,state,reason,detail,candidates,source_version,source_hash,created_at,updated_at) VALUES(?,?,'pending',?,?,?,?,?,?,?)
    ON CONFLICT(entity,source_id) DO UPDATE SET state='pending', reason=excluded.reason, detail=excluded.detail, candidates=excluded.candidates, source_version=excluded.source_version, source_hash=excluded.source_hash, updated_at=excluded.updated_at`,
    entity, raw.source_id, reason, clip(detail ?? null), JSON.stringify(candidates.slice(0, 5)), raw.version, raw.hash, now, now);
}
function reviewOf(db: SqlDriver, entity: BlingAdoptionEntity, source: string) {
  const r = db.exec("SELECT state, source_version, source_hash, candidates FROM wb_bling_adoption_review WHERE entity=? AND source_id=?", entity, source).rows[0];
  return r ? { state: String(r.state), source_version: Number(r.source_version), source_hash: String(r.source_hash), candidates: JSON.parse(String(r.candidates)) as string[] } : null;
}

// ---------------------------------------------------------------------------
// Procura do que já existe

interface Found { ids: string[]; exact: boolean; suggestion?: boolean }
const ids = (rows: Row[]) => [...new Set(rows.map(r => String(r.id)))];
const NAME_SQL: Partial<Record<BlingAdoptionEntity, string>> = {
  warehouses: "SELECT id, name FROM erp_catalog__record WHERE entity='warehouses'",
  product_categories: "SELECT id, name FROM erp_catalog__taxonomy WHERE kind='categories'",
  payment_methods: "SELECT id, description AS name FROM erp_catalog__payment_method WHERE deleted_at IS NULL",
  financial_categories: "SELECT id, name, kind FROM erp_finance__category WHERE deleted_at IS NULL",
  ledger_accounts: "SELECT id, name FROM erp_finance__account WHERE deleted_at IS NULL",
};
function findByName(db: SqlDriver, entity: BlingAdoptionEntity, name: string, filter?: (row: Row) => boolean): string[] {
  const wanted = fold(name);
  return ids(db.exec(NAME_SQL[entity]!).rows.filter(r => fold(r.name) === wanted && (!filter || filter(r))));
}
const DOC = "upper(replace(replace(replace(replace(c.document,'.',''),'/',''),'-',''),' ',''))";
function findContact(db: SqlDriver, m: Mapped): Found {
  const document = digitsAndLetters(m.data.document);
  const alive = `r.entity='contacts' AND coalesce(p.situation,'A')<>'E'`;
  const base = `FROM erp_catalog__record r JOIN erp_catalog__contact c ON c.record_id=r.id LEFT JOIN erp_catalog__contact_profile p ON p.record_id=r.id WHERE ${alive}`;
  if (document) {
    const byDocument = ids(db.exec(`SELECT r.id ${base} AND c.document IS NOT NULL AND ${DOC}=? ORDER BY r.id LIMIT 6`, document).rows);
    if (byDocument.length) return { ids: byDocument, exact: true };
  }
  const email = fold(m.data.email), name = fold(m.name);
  const suggestions = ids(db.exec(`SELECT r.id, r.name, c.email ${base} AND (lower(trim(c.email))=? OR lower(trim(r.name))=?) ORDER BY r.id LIMIT 200`, email ?? "\u0000", (text(m.name) ?? "").toLowerCase()).rows
    .filter(r => (email !== null && fold(r.email) === email) || (name !== null && fold(r.name) === name))).slice(0, 5);
  return { ids: suggestions, exact: false, suggestion: suggestions.length > 0 };
}
const PRODUCT_ALIVE = "r.entity='products' AND NOT EXISTS(SELECT 1 FROM erp_catalog__product_detail d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL)";
function findProduct(db: SqlDriver, code: unknown, gtin: unknown): string[] {
  const c = text(code);
  if (c) {
    const byCode = ids(db.exec(`SELECT r.id FROM erp_catalog__record r WHERE ${PRODUCT_ALIVE} AND r.code=? ORDER BY r.id LIMIT 6`, c).rows);
    if (byCode.length) return byCode;
  }
  const g = text(gtin);
  if (g && g !== "SEM GTIN") return ids(db.exec(`SELECT r.id FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id WHERE ${PRODUCT_ALIVE} AND p.gtin=? ORDER BY r.id LIMIT 6`, g).rows);
  return [];
}
/** "Os dados batem": o que a pessoa reconheceria como o mesmo cadastro. */
function matches(db: SqlDriver, entity: BlingAdoptionEntity, m: Mapped, id: string): boolean {
  const erp = erpSummary(db, entity, id);
  if (!erp) return false;
  if (!sameText(erp["Nome"], m.name)) return false;
  if (entity === "products") {
    const a = m.summary["Preço"], b = erp["Preço"];
    if (a && b && !exactDecimalEqual(a, b)) return false;
    if (m.summary["Unidade"] && erp["Unidade"] && !sameText(m.summary["Unidade"], erp["Unidade"])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Execução de um registro (sempre dentro de uma transação do motor)

export interface AdoptionActor { user_id: string }
interface Step { entity: BlingAdoptionEntity; raw: AdoptionRaw; actor: string; now: number }
const resultId = (value: unknown, ...paths: string[][]): string => {
  for (const path of paths) { const v = at(value, ...path); if (typeof v === "string" && v) return v; }
  throw new ErpError("XX000", "erp_bling_adoption_result_without_id");
};
const versionOf = (db: SqlDriver, table: string, id: string) => Number(db.exec(`SELECT version FROM ${table} WHERE id=?`, id).rows[0]?.version ?? 0);

/** Dependências resolvidas pelos vínculos (nunca pelo nome). */
function linkedRecord(db: SqlDriver, entity: BlingAdoptionEntity, source: unknown): string | null {
  const id = text(source);
  return id && /^[1-9]\d{0,39}$/.test(id) ? linkOf(db, entity, id)?.record_id ?? null : null;
}
function map(db: SqlDriver, entity: BlingAdoptionEntity, p: Json): Mapped {
  switch (entity) {
    case "contacts": return mapContact(p);
    case "products": return mapProduct(p, linkedRecord(db, "product_categories", at(p, "categoria", "id")));
    case "product_categories": {
      const m = plainName(p, "descricao", "nome");
      const parentSource = text(at(p, "categoriaPai", "id")) ?? text(p.idCategoriaPai);
      const parent = parentSource && parentSource !== "0" ? linkOf(db, "product_categories", parentSource)?.record_id ?? null : null;
      m.extra = { parent_source: parentSource && parentSource !== "0" ? parentSource : null, parent };
      m.data = { name: m.name, ...(parent ? { parent_id: parent } : {}) };
      if (m.name && m.name.length > 50) m.blocked = { reason: "invalid_data", detail: "O nome da categoria passa de 50 caracteres." };
      if (m.extra.parent_source && !parent) m.blocked = { reason: "dependency", detail: "A categoria-mãe ainda não foi adotada." };
      return m;
    }
    case "warehouses": {
      const m = plainName(p, "descricao", "nome");
      m.data = { ignore_balance: p.desconsiderarSaldo === true || text(p.desconsiderarSaldo) === "true" };
      return m;
    }
    case "payment_methods": {
      const m = plainName(p, "descricao", "nome");
      const raw = text(p.tipoPagamento);
      const type = raw && /^\d{1,2}$/.test(raw) ? raw.padStart(2, "0") : null;
      m.data = { description: m.name, payment_type: type && PAYMENT_TYPES.includes(type) ? type : "99", condition: null, destination: "contas", account_id: null,
        business_days: false, applicable: "ambos", interest_rate: null, fine_rate: null, card_brand: null, card_integration: null, card_cnpj: null,
        auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: "aliquota", fee_rate: null, fee_fixed: null, settlement_days: null };
      if (m.name && m.name.length > 100) m.blocked = { reason: "invalid_data", detail: "A descrição passa de 100 caracteres." };
      return m;
    }
    case "financial_categories": {
      const m = plainName(p, "descricao", "nome");
      const kind = FIN_KIND[text(p.tipo) ?? ""] ?? null;
      const parentSource = text(p.idCategoriaPai) ?? text(at(p, "categoriaPai", "id"));
      const parent = parentSource && parentSource !== "0" ? linkOf(db, "financial_categories", parentSource)?.record_id ?? null : null;
      m.summary["Tipo"] = kind === "receivable" ? "Receita" : kind === "payable" ? "Despesa" : text(p.tipo);
      m.data = { kind, parent_id: parent, name: m.name, dre_group: null };
      m.extra = { kind };
      if (!kind) m.blocked = { reason: "unsupported", detail: "O tipo da categoria no Bling não é receita nem despesa." };
      else if (parentSource && parentSource !== "0" && !parent) m.blocked = { reason: "dependency", detail: "A categoria-mãe ainda não foi adotada." };
      if (m.name && m.name.length > 100) m.blocked = { reason: "invalid_data", detail: "O nome passa de 100 caracteres." };
      return m;
    }
    case "ledger_accounts": {
      const m = plainName(p, "descricao", "nome");
      if (m.name && m.name.length > 50) m.blocked = { reason: "invalid_data", detail: "O nome da conta passa de 50 caracteres." };
      return m;
    }
    case "sellers": {
      const contactSource = text(at(p, "contato", "id"));
      const m: Mapped = { name: text(at(p, "contato", "nome")), data: {}, summary: { "Nome": text(at(p, "contato", "nome")) }, extra: { contact_source: contactSource } };
      if (!contactSource) m.blocked = { reason: "unsupported", detail: "O vendedor no Bling não tem contato ligado." };
      else if (!linkOf(db, "contacts", contactSource)) m.blocked = { reason: "dependency", detail: "Adote primeiro o contato deste vendedor." };
      return m;
    }
  }
}

/** Cria o cadastro pela RPC da tela. `acknowledged` null aceita os avisos (decisão da pessoa). */
function create(ctx: RpcContext, step: Step, m: Mapped, acknowledged: string[] | null, salt: string): string {
  const { entity, raw, actor } = step, user = actor;
  const command = commandUuid("bling-adoption", entity, raw.source_id, String(raw.version), salt);
  switch (entity) {
    case "contacts":
      return resultId(invokeRpc(ctx, "erp_catalog_contact_save", { p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: command, p_data: m.data, p_acknowledged: acknowledged }), ["id"], ["record", "id"], ["contact", "id"]);
    case "products": {
      const result = invokeRpc(ctx, "erp_catalog_product_save", { p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: command, p_data: m.data, p_acknowledged: acknowledged });
      return resultId(result, ["record", "id"], ["id"]);
    }
    case "product_categories":
      return taxonomySaved(invokeRpc(ctx, "erp_catalog_taxonomy_save", { p_user_id: user, p_kind: "categories", p_id: null, p_expected_version: 0, p_command_id: command, p_data: m.data }));
    case "warehouses":
      invokeRpc(ctx, "erp_stock_warehouse_save", { p_user_id: user, p_command_id: command, p_warehouse_id: null, p_expected_version: 0, p_expected_setting_version: 0, p_name: m.name, p_ignore_balance: m.data.ignore_balance === true });
      return String(ctx.db.exec('SELECT warehouse_id FROM "erp_stock__warehouse_command" WHERE id=?', command).rows[0]?.warehouse_id);
    case "payment_methods":
      return resultId(invokeRpc(ctx, "erp_catalog_payment_method_save", { p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: command, p_data: m.data }), ["item", "id"]);
    case "financial_categories":
      return resultId(invokeRpc(ctx, "erp_finance_category_execute", { p_user_id: user, p_command_id: command, p_action: "category_create", p_data: m.data }), ["record", "id"]);
    case "ledger_accounts":
      return resultId(invokeRpc(ctx, "erp_finance_account_execute", { p_user_id: user, p_command_id: command, p_action: "account_create", p_data: {
        account_type: "other", institution_code: null, institution_name: null, name: m.name, agency: null, account_number: null, account_digit: null,
        start_on: todaySaoPaulo(step.now), opening_cents: "0", default_movements: false } }), ["record", "id"]);
    case "sellers": {
      const contact = linkOf(ctx.db, "contacts", String(m.extra?.contact_source))!.record_id;
      const existing = ctx.db.exec('SELECT id FROM "erp_catalog__seller" WHERE contact_id=?', contact).rows[0];
      if (existing) return String(existing.id);
      return resultId(invokeRpc(ctx, "erp_catalog_seller_from_contact", { p_user_id: user, p_command_id: command, p_contact_id: contact }), ["seller", "id"]);
    }
  }
}
function taxonomySaved(result: unknown): string {
  if (at(result, "saved") === false) throw new ErpError("23505", "erp_bling_adoption_taxonomy_duplicate");
  return resultId(result, ["item", "id"]);
}
/** "Usar a do Bling" num cadastro que já existe: atualiza pela RPC da tela. */
function update(ctx: RpcContext, step: Step, m: Mapped, record: string, salt: string): void {
  const { entity, raw, actor: user } = step, db = ctx.db;
  const command = commandUuid("bling-adoption-update", entity, raw.source_id, String(raw.version), record, salt);
  switch (entity) {
    case "contacts":
      invokeRpc(ctx, "erp_catalog_contact_save", { p_user_id: user, p_id: record, p_expected_version: versionOf(db, "erp_catalog__record", record), p_command_id: command, p_data: m.data, p_acknowledged: null }); return;
    case "products":
      invokeRpc(ctx, "erp_catalog_product_save", { p_user_id: user, p_id: record, p_expected_version: versionOf(db, "erp_catalog__record", record), p_command_id: command, p_data: m.data, p_acknowledged: null }); return;
    case "product_categories":
      taxonomySaved(invokeRpc(ctx, "erp_catalog_taxonomy_save", { p_user_id: user, p_kind: "categories", p_id: record, p_expected_version: versionOf(db, "erp_catalog__taxonomy", record), p_command_id: command, p_data: { name: m.name } })); return;
    case "warehouses": {
      const setting = Number(db.exec('SELECT version FROM "erp_stock__warehouse_setting" WHERE warehouse_id=?', record).rows[0]?.version ?? 0);
      invokeRpc(ctx, "erp_stock_warehouse_save", { p_user_id: user, p_command_id: command, p_warehouse_id: record, p_expected_version: versionOf(db, "erp_catalog__record", record), p_expected_setting_version: setting, p_name: m.name, p_ignore_balance: m.data.ignore_balance === true });
      return;
    }
    case "financial_categories":
      invokeRpc(ctx, "erp_finance_category_execute", { p_user_id: user, p_command_id: command, p_action: "category_update", p_data: { id: record, expected_version: versionOf(db, "erp_finance__category", record), name: m.name } }); return;
    default: throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "Para esta entidade, escolha manter a do ERP e ligar, ou criar um cadastro novo.");
  }
}

/** Variações de um produto "V" do Bling: cada uma vira variação do produto adotado. */
function adoptVariations(ctx: RpcContext, step: Step, parent: string) {
  const list = step.raw.payload.variacoes;
  if (!Array.isArray(list) || !list.length) return;
  const isV = String(ctx.db.exec('SELECT format FROM "erp_catalog__product" WHERE record_id=?', parent).rows[0]?.format ?? "") === "V";
  for (const item of list) {
    const source = text(at(item, "id"));
    if (!source || !/^[1-9]\d{0,39}$/.test(source) || linkOf(ctx.db, "products", source)) continue;
    const variation = { source_id: source, version: step.raw.version, hash: step.raw.hash };
    const code = text(at(item, "codigo"));
    const attributes: Record<string, string> = {};
    for (const part of (text(at(item, "variacao", "nome")) ?? "").split(";")) {
      const [k, ...v] = part.split(":");
      if (text(k) && text(v.join(":"))) attributes[text(k)!] = text(v.join(":"))!;
    }
    const found = findProduct(ctx.db, code, at(item, "gtin"));
    if (found.length === 1 && !linkedTo(ctx.db, "products", found[0])) { writeLink(ctx.db, "products", variation, found[0], "linked", step.actor, step.now); continue; }
    if (found.length || !isV || !code || !Object.keys(attributes).length || Object.keys(attributes).length > 5) {
      writeReview(ctx.db, "products", variation, found.length ? "ambiguous" : "invalid_data", found, step.now,
        `Variação ${clip(code ?? source, 60)} de ${clip(text(step.raw.payload.nome) ?? step.raw.source_id, 80)}${!code ? ": sem código" : !Object.keys(attributes).length ? ": sem atributos (ex.: Cor:Azul)" : ""}.`);
      continue;
    }
    const price = text(at(item, "preco")), gtin = text(at(item, "gtin"));
    const result = invokeRpc(ctx, "erp_catalog_product_variation_add", { p_user_id: step.actor, p_command_id: commandUuid("bling-adoption-variation", source, String(step.raw.version)), p_parent: parent,
      p_data: { attributes, code, ...(gtin && /^([0-9]{8}|[0-9]{12,14})$/.test(gtin) ? { gtin } : {}), ...(price && /^(0|[1-9][0-9]{0,13})(\.[0-9]+)?$/.test(price) ? { price } : {}) } });
    writeLink(ctx.db, "products", variation, resultId(result, ["child_id"]), "created", step.actor, step.now);
  }
}

/** Decide um registro no lote: liga, cria ou deixa pendente. Idempotente pela chave (entidade, id no Bling). */
function adoptRecord(ctx: RpcContext, step: Step): Outcome {
  const { entity, raw, now } = step, db = ctx.db;
  const link = linkOf(db, entity, raw.source_id);
  if (link) return "skipped";
  const review = reviewOf(db, entity, raw.source_id);
  if (review && (review.state === "ignored" || review.source_version === raw.version)) return "skipped";
  const m = map(db, entity, raw.payload);
  const pending = (reason: BlingAdoptionReason, candidates: string[] = [], detail?: string | null): Outcome => { writeReview(db, entity, raw, reason, candidates, now, detail); return "pending"; };
  if (raw.deleted) return pending("source_deleted");
  if (!m.name) return pending("missing_name");
  let found: Found;
  if (entity === "contacts") found = findContact(db, m);
  else if (entity === "products") found = { ids: findProduct(db, m.data.code, m.data.gtin), exact: true };
  else if (entity === "sellers") {
    const contact = m.blocked ? null : linkOf(db, "contacts", String(m.extra?.contact_source))!.record_id;
    found = { ids: contact ? ids(db.exec('SELECT id FROM "erp_catalog__seller" WHERE contact_id=?', contact).rows) : [], exact: true };
  } else found = { ids: findByName(db, entity, m.name, entity === "financial_categories" ? r => r.kind === m.extra?.kind || r.kind === "both" : undefined), exact: true };
  if (m.blocked) return pending(m.blocked.reason, found.ids, m.blocked.detail);
  if (found.suggestion) return pending("suggestion", found.ids);
  if (found.ids.length > 1) return pending("ambiguous", found.ids);
  if (found.ids.length === 1) {
    const id = found.ids[0];
    if (linkedTo(db, entity, id)) return pending("ambiguous", found.ids, "O cadastro do ERP já está ligado a outro registro do Bling.");
    if (entity !== "sellers" && !matches(db, entity, m, id)) return pending("divergent", found.ids);
    writeLink(db, entity, raw, id, "linked", step.actor, now);
    if (entity === "products") adoptVariations(ctx, step, id);
    return "linked";
  }
  const id = create(ctx, step, m, [], "create");
  writeLink(db, entity, raw, id, "created", step.actor, now);
  if (entity === "products") adoptVariations(ctx, step, id);
  return "adopted";
}

// ---------------------------------------------------------------------------
// Erros do domínio em palavras

const STOP_CODES = new Set(["42501", "28000"]);
/** Recusas comuns das RPCs de cadastro, ditas para quem decide a pendência. */
const DOMAIN_WORDS: Record<string, string> = {
  erp_catalog_invalid_text: "Um texto passa do tamanho permitido ou tem caracteres que o ERP não aceita.",
  erp_finance_invalid_text: "Um texto passa do tamanho permitido ou tem caracteres que o ERP não aceita.",
  erp_catalog_invalid_identifier: "NCM, GTIN ou CEST em formato inválido.",
  erp_unit_price_invalid: "Preço em formato inválido.",
  erp_catalog_invalid_measure: "Peso ou medida em formato inválido.",
  erp_catalog_invalid_enum: "Tipo, formato ou outra opção com valor que o ERP não conhece.",
  erp_catalog_name_required: "O nome está vazio.",
  erp_finance_category_duplicate: "Já existe uma categoria financeira com este nome no mesmo nível.",
  erp_finance_invalid_parent: "A categoria-mãe não serve para este tipo de categoria.",
  erp_catalog_payment_method_invalid: "A forma de pagamento tem um dado que o ERP não aceita.",
  erp_stock_warehouse_input_invalid: "O nome do depósito é inválido.",
  erp_catalog_variation_duplicate: "Já existe uma variação com estes atributos.",
};
export function domainFailure(error: unknown): { reason: BlingAdoptionReason; detail: string | null; stop: BlingAdoptionStop | null } {
  if (error instanceof BlingAdoptionError) return { reason: "failed", detail: error.detail ?? error.message, stop: null };
  const code = error instanceof ErpError ? error.code : "";
  const message = error instanceof ErpError ? error.message : "";
  // A parte da entidade é conferida antes de cada registro; aqui é um recurso
  // de outro módulo usado só por este registro (ex.: composição sem Estoque).
  if (message === "module_disabled" || code === "module_disabled" || (error as Error | null)?.constructor?.name === "ErpPartDisabled")
    return { reason: "invalid_data", detail: "Este registro usa um recurso de um módulo desligado (por exemplo, produto com composição precisa de Estoque).", stop: null };
  if (STOP_CODES.has(code)) return { reason: "failed", detail: null, stop: "permission" };
  if (message === "erp_catalog_warning_unacknowledged") return { reason: "duplicate_warning", detail: null, stop: null };
  if (code === "23505") return { reason: "duplicate_warning", detail: message.includes("duplicate") ? "Já existe um cadastro com o mesmo nome, código ou documento." : null, stop: null };
  const words = DOMAIN_WORDS[message.split(":")[0]];
  if (words) return { reason: code === "23505" ? "duplicate_warning" : "invalid_data", detail: words, stop: null };
  const field = /:(\w+)$/.exec(message)?.[1];
  if (code === "22023" || code === "22P02" || code === "22003" || code === "23514") return { reason: "invalid_data", detail: field ? `Campo recusado pelo ERP: ${field}.` : `Regra do ERP: ${clip(message, 120)}.`, stop: null };
  return { reason: "failed", detail: code ? `Código do ERP: ${clip(code + " " + message, 120)}.` : null, stop: null };
}

// ---------------------------------------------------------------------------
// Trabalho em lote

interface JobRow { state: "running" | "paused" | "done"; entities: BlingAdoptionEntity[]; cursor: Record<string, { after: string | null; done: boolean }>;
  counts: BlingAdoptionJob["counts"]; actor_id: string; revision: number; started_at: number; updated_at: number; finished_at: number | null; stop: { code: BlingAdoptionStop } | null }
const ZERO = () => ({ processed: 0, adopted: 0, linked: 0, pending: 0, skipped: 0 });
function readJob(db: SqlDriver): JobRow | null {
  const r = db.exec("SELECT * FROM wb_bling_adoption_job WHERE id=1").rows[0];
  if (!r) return null;
  const counts = JSON.parse(String(r.counts)) as Json;
  return { state: r.state as JobRow["state"], entities: JSON.parse(String(r.entities)), cursor: JSON.parse(String(r.cursor)),
    counts: { ...ZERO(), ...(object(counts.totals) ? counts.totals as Json : {}) } as JobRow["counts"], stop: object(counts.stop) ? counts.stop as JobRow["stop"] : null,
    actor_id: String(r.actor_id), revision: Number(r.revision), started_at: Number(r.started_at), updated_at: Number(r.updated_at), finished_at: r.finished_at == null ? null : Number(r.finished_at) };
}
function saveJob(db: SqlDriver, job: JobRow, now: number) {
  db.exec(`INSERT INTO wb_bling_adoption_job(id,state,entities,cursor,counts,actor_id,revision,started_at,updated_at,finished_at) VALUES(1,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state, entities=excluded.entities, cursor=excluded.cursor, counts=excluded.counts, actor_id=excluded.actor_id,
      revision=excluded.revision, started_at=excluded.started_at, updated_at=excluded.updated_at, finished_at=excluded.finished_at`,
    job.state, JSON.stringify(job.entities), JSON.stringify(job.cursor), JSON.stringify({ totals: job.counts, stop: job.stop }), job.actor_id, job.revision, job.started_at, now,
    job.state === "done" ? job.finished_at ?? now : null);
}
const iso = (v: number | null) => v === null ? null : new Date(v).toISOString();
export function publicJob(job: JobRow | null): BlingAdoptionJob {
  if (!job) return { state: "idle", entities: [], current: null, counts: ZERO(), revision: "0", started_at: null, updated_at: null, finished_at: null, stop: null };
  return { state: job.state, entities: job.entities, current: job.state === "done" ? null : job.entities.find(e => !job.cursor[e]?.done) ?? null, counts: job.counts,
    revision: String(job.revision), started_at: iso(job.started_at), updated_at: iso(job.updated_at), finished_at: iso(job.finished_at),
    stop: job.stop ? { code: job.stop.code, message: BLING_ADOPTION_STOPS[job.stop.code] } : null };
}

/** Há lote a executar? Consulta barata para o alarme. */
export function adoptionRunning(sql: { exec(q: string): { toArray(): unknown[] } }): boolean {
  try { return sql.exec("SELECT 1 FROM wb_bling_adoption_job WHERE id=1 AND state='running'").toArray().length > 0; }
  catch { return false; }
}

export interface AdoptionEngineOptions { db: SqlDriver; profile: string; now(): number; parts: Readonly<ErpParts> }
const systemIdentity = (user: string): IdentityPort => ({ actor: { user_id: user, name: null, email: null, erp_role: "admin", session_id: null, aal: "aal1", verified_factor: false, is_agent: false }, people: null });

/** Uma unidade do alarme: até 25 registros ou 1,5 s. Cada registro é uma
 * transação: a falha de um vira pendência dele e não derruba o lote. */
export function runAdoptionUnit(options: AdoptionEngineOptions): { worked: boolean; more: boolean } {
  const { db, profile, now, parts } = options;
  const started = now();
  let job = readJob(db);
  if (!job || job.state !== "running") return { worked: false, more: false };
  const halt = (stop: BlingAdoptionStop) => { job!.state = "paused"; job!.stop = { code: stop }; job!.revision++; db.transaction(() => saveJob(db, job!, now())); return { worked: true, more: false }; };
  if (!archiveAvailable(db)) return halt("archive_unavailable");
  let handled = 0;
  while (handled < ADOPTION_UNIT.records && now() - started < ADOPTION_UNIT.wall_ms) {
    job = readJob(db)!;
    if (job.state !== "running") return { worked: handled > 0, more: false };
    const entity = job.entities.find(e => !job!.cursor[e]?.done);
    if (!entity) {
      job.state = "done"; job.finished_at = now(); job.revision++;
      db.transaction(() => saveJob(db, job!, now()));
      return { worked: true, more: false };
    }
    if (!adoptionEnabled(entity, parts)) return halt("module_disabled");
    const cursor = job.cursor[entity] ?? { after: null, done: false };
    const next = db.exec(`SELECT source_id FROM origin_sync__raw_record WHERE entity=? AND (? IS NULL OR source_id>?) ORDER BY source_id LIMIT 1`, entity, cursor.after, cursor.after).rows[0];
    if (!next) {
      job.cursor[entity] = { after: cursor.after, done: true };
      db.transaction(() => saveJob(db, job!, now()));
      continue;
    }
    const source = String(next.source_id), at = now();
    const advance = (outcome: Outcome) => {
      job!.cursor[entity] = { after: source, done: false };
      job!.counts.processed++;
      job!.counts[outcome === "adopted" ? "adopted" : outcome === "linked" ? "linked" : outcome === "pending" ? "pending" : "skipped"]++;
      saveJob(db, job!, at);
    };
    try {
      transaction(db, profile, ctx => {
        const raw = readRaw(db, entity, source);
        const outcome = raw ? adoptRecord(ctx, { entity, raw, actor: job!.actor_id, now: at }) : "skipped";
        advance(outcome);
      }, { identity: systemIdentity(job.actor_id), parts });
    } catch (error) {
      const failure = domainFailure(error);
      if (failure.stop) return halt(failure.stop);
      db.transaction(() => {
        const raw = readRaw(db, entity, source);
        if (raw) writeReview(db, entity, raw, failure.reason, [], at, failure.detail);
        advance(raw ? "pending" : "skipped");
      });
    }
    handled++;
  }
  return { worked: handled > 0, more: true };
}

// ---------------------------------------------------------------------------
// Operações (pessoa ou bot, sempre administrador)

export interface AdoptionCall { db: SqlDriver; profile: string; now(): number; parts: Readonly<ErpParts>; identity: IdentityPort; request_hash: string }
function command<T extends Json>(call: AdoptionCall, operation: string, commandId: string, run: (ctx: RpcContext) => T): T & { receipt: { command_id: string; operation: string; replayed: boolean } } {
  const actor = call.identity.actor!.user_id;
  return transaction(call.db, call.profile, ctx => {
    projectPeople(ctx);
    const previous = call.db.exec("SELECT operation, actor_id, request_hash, result FROM wb_bling_adoption_command WHERE command_id=?", commandId).rows[0];
    if (previous) {
      if (previous.operation !== operation || previous.actor_id !== actor || previous.request_hash !== call.request_hash) throw new BlingAdoptionError("BLING_ADOPTION_COMMAND_CONFLICT");
      return { ...JSON.parse(String(previous.result)), receipt: { command_id: commandId, operation, replayed: true } };
    }
    const result = run(ctx);
    call.db.exec("INSERT INTO wb_bling_adoption_command(command_id,operation,actor_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?)", commandId, operation, actor, call.request_hash, JSON.stringify(result), call.now());
    return { ...result, receipt: { command_id: commandId, operation, replayed: false } };
  }, { identity: call.identity, parts: call.parts });
}
/** Transação do motor que conserva a recusa em palavras desta camada (o motor
 * converteria qualquer exceção em erro SQL genérico). */
function transaction<T>(db: SqlDriver, profile: string, fn: (ctx: RpcContext) => T, env: { identity: IdentityPort; parts: Readonly<ErpParts> }): T {
  let refused: BlingAdoptionError | null = null;
  try {
    return inTransaction(db, ctx => { try { return fn(ctx); } catch (error) { if (error instanceof BlingAdoptionError) refused = error; throw error; } }, clockOf(profile), env);
  } catch (error) { throw refused ?? error; }
}

export function adoptionStatus(call: Pick<AdoptionCall, "db" | "parts">): BlingAdoptionStatus {
  const { db, parts } = call;
  const available = archiveAvailable(db);
  const count = (sql: string, entity: string) => Number(db.exec(sql, entity).rows[0]?.n ?? 0);
  return {
    available, unavailable_message: available ? null : "O acervo do Bling ainda não tem conta vinculada ou está sendo apagado. Colete os dados antes de adotar.",
    job: publicJob(readJob(db)),
    entities: BLING_ADOPTION_ENTITIES.map(entity => {
      const collected = count("SELECT count(*) AS n FROM origin_sync__raw_record WHERE entity=?", entity);
      const adopted = count("SELECT count(*) AS n FROM wb_bling_adoption_link l JOIN origin_sync__raw_record r ON r.entity=l.entity AND r.source_id=l.source_id WHERE l.entity=?", entity);
      // Pendências e ignorados incluem variações (sem registro próprio no
      // acervo); "aguardando" desconta só os que estão no acervo.
      const reviewed = count("SELECT count(*) AS n FROM wb_bling_adoption_review v JOIN origin_sync__raw_record r ON r.entity=v.entity AND r.source_id=v.source_id WHERE v.entity=?", entity);
      const pending = count("SELECT count(*) AS n FROM wb_bling_adoption_review WHERE entity=? AND state='pending'", entity);
      const ignored = count("SELECT count(*) AS n FROM wb_bling_adoption_review WHERE entity=? AND state='ignored'", entity);
      const enabled = adoptionEnabled(entity, parts), module = adoptionModule(entity);
      return { entity, label: BLING_ADOPTION_LABELS[entity], module, module_name: ERP_PART_NAMES[module], enabled,
        part_off_message: enabled ? null : adoptionPartOffMessage(entity), updatable: BLING_ADOPTION_UPDATABLE.has(entity),
        collected, waiting: Math.max(0, collected - adopted - reviewed), adopted, pending, ignored };
    }),
  };
}

function blingSummary(db: SqlDriver, entity: BlingAdoptionEntity, source: string): BlingAdoptionSummary | null {
  const raw = readRaw(db, entity, source);
  return raw ? map(db, entity, raw.payload).summary : null;
}
export function adoptionReviews(call: Pick<AdoptionCall, "db">, input: BlingAdoptionOperationMap["erp_bling_adoption_reviews"]["input"]): BlingAdoptionOperationMap["erp_bling_adoption_reviews"]["output"] {
  const { db } = call, limit = input.limit ?? 20;
  const rows = db.exec(`SELECT * FROM wb_bling_adoption_review WHERE entity=? AND state=? AND (? IS NULL OR source_id>?) ORDER BY source_id LIMIT ?`,
    input.entity, input.state ?? "pending", input.cursor ?? null, input.cursor ?? null, limit + 1).rows;
  const items: BlingAdoptionReview[] = rows.slice(0, limit).map(r => {
    const reason = String(r.reason) as BlingAdoptionReason;
    const candidates = (JSON.parse(String(r.candidates)) as string[]).flatMap(id => { const summary = erpSummary(db, input.entity, id); return summary ? [{ record_id: id, summary }] : []; });
    return { entity: input.entity, source_id: String(r.source_id), state: r.state as "pending" | "ignored", reason, reason_text: BLING_ADOPTION_REASONS[reason],
      detail: r.detail == null ? null : String(r.detail), source_version: String(r.source_version), bling: blingSummary(db, input.entity, String(r.source_id)), erp: candidates };
  });
  return { items, next_cursor: rows.length > limit ? items[items.length - 1].source_id : null };
}
export function adoptionLinks(call: Pick<AdoptionCall, "db">, input: BlingAdoptionOperationMap["erp_bling_adoption_links"]["input"]): BlingAdoptionOperationMap["erp_bling_adoption_links"]["output"] {
  const { db } = call, limit = input.limit ?? 20;
  const rows = db.exec(`SELECT * FROM wb_bling_adoption_link WHERE entity=? AND (? IS NULL OR source_id>?) ORDER BY source_id LIMIT ?`, input.entity, input.cursor ?? null, input.cursor ?? null, limit + 1).rows;
  const items: BlingAdoptionLink[] = rows.slice(0, limit).map(r => ({ entity: input.entity, source_id: String(r.source_id), record_id: String(r.record_id),
    mode: r.mode as BlingAdoptionLink["mode"], source_version: String(r.source_version), adopted_at: new Date(Number(r.adopted_at)).toISOString(), summary: erpSummary(db, input.entity, String(r.record_id)) }));
  return { items, next_cursor: rows.length > limit ? items[items.length - 1].source_id : null };
}

export function adoptionStart(call: AdoptionCall, input: BlingAdoptionOperationMap["erp_bling_adoption_start"]["input"]) {
  return command(call, "erp_bling_adoption_start", input.command_id, ctx => {
    if (!archiveAvailable(ctx.db)) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
    const off = input.entities.find(e => !adoptionEnabled(e, call.parts));
    if (off) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", adoptionPartOffMessage(off));
    const now = call.now(), previous = readJob(ctx.db);
    const entities = BLING_ADOPTION_ENTITIES.filter(e => input.entities.includes(e));
    const resume = previous?.state === "paused" || previous?.state === "running";
    const cursor = resume ? Object.fromEntries(Object.entries(previous!.cursor).filter(([e]) => entities.includes(e as BlingAdoptionEntity))) : {};
    const job: JobRow = { state: "running", entities, cursor, counts: resume ? previous!.counts : ZERO(), actor_id: call.identity.actor!.user_id,
      revision: (previous?.revision ?? 0) + 1, started_at: resume ? previous!.started_at : now, updated_at: now, finished_at: null, stop: null };
    saveJob(ctx.db, job, now);
    return { job: publicJob(readJob(ctx.db)) };
  });
}
export function adoptionPause(call: AdoptionCall, input: BlingAdoptionOperationMap["erp_bling_adoption_pause"]["input"]) {
  return command(call, "erp_bling_adoption_pause", input.command_id, ctx => {
    const job = readJob(ctx.db);
    if (job?.state === "running") { job.state = "paused"; job.revision++; saveJob(ctx.db, job, call.now()); }
    return { job: publicJob(readJob(ctx.db)) };
  });
}

export function adoptionResolve(call: AdoptionCall, input: BlingAdoptionOperationMap["erp_bling_adoption_resolve"]["input"]) {
  return command(call, "erp_bling_adoption_resolve", input.command_id, ctx => {
    const { entity } = input, db = ctx.db, now = call.now(), actor = call.identity.actor!.user_id;
    if (!adoptionEnabled(entity, call.parts)) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", adoptionPartOffMessage(entity));
    if (linkOf(db, entity, input.source_id)) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "Este registro já está ligado a um cadastro do ERP.");
    const review = reviewOf(db, entity, input.source_id);
    if (!review) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
    // Variação de produto (ou registro que saiu do acervo): sem dados próprios,
    // só dá para ignorar ou ligar a um cadastro do ERP.
    const stored = readRaw(db, entity, input.source_id);
    const raw: AdoptionRaw = stored ?? { source_id: input.source_id, version: review.source_version, hash: review.source_hash, payload: {}, deleted: false };
    if (!stored && input.action === "use_bling") throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", "Os dados deste registro não estão no acervo como registro próprio. Ignore ou ligue a um cadastro do ERP.");
    if (input.action === "ignore") {
      db.exec("UPDATE wb_bling_adoption_review SET state='ignored', updated_at=? WHERE entity=? AND source_id=?", now, entity, raw.source_id);
      return { outcome: "ignored" as const, record_id: null };
    }
    const step: Step = { entity, raw, actor, now };
    const m = map(db, entity, raw.payload);
    if (input.record_id && !recordExists(db, entity, input.record_id)) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "O cadastro escolhido não existe mais no ERP.");
    try {
      if (input.action === "keep_erp") {
        writeLink(db, entity, raw, input.record_id!, "linked", actor, now);
        return { outcome: "linked" as const, record_id: input.record_id! };
      }
      if (!m.name) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", BLING_ADOPTION_REASONS.missing_name);
      if (m.blocked?.reason === "dependency" || entity === "sellers" && m.blocked) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", m.blocked!.detail ?? BLING_ADOPTION_REASONS.dependency);
      if (input.record_id) {
        if (!BLING_ADOPTION_UPDATABLE.has(entity)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "Para esta entidade, escolha manter a do ERP e ligar, ou criar um cadastro novo.");
        if (linkedTo(db, entity, input.record_id)) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "O cadastro do ERP já está ligado a outro registro do Bling.");
        update(ctx, step, m, input.record_id, input.command_id);
        writeLink(db, entity, raw, input.record_id, "updated", actor, now);
        if (entity === "products") adoptVariations(ctx, step, input.record_id);
        return { outcome: "updated" as const, record_id: input.record_id };
      }
      const id = create(ctx, step, m, null, "resolve:" + input.command_id);
      writeLink(db, entity, raw, id, "created", actor, now);
      if (entity === "products") adoptVariations(ctx, step, id);
      return { outcome: "adopted" as const, record_id: id };
    } catch (error) {
      if (error instanceof BlingAdoptionError) throw error;
      const failure = domainFailure(error);
      if (failure.stop === "permission") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
      if (failure.stop === "module_disabled") throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", adoptionPartOffMessage(entity));
      throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", [BLING_ADOPTION_REASONS[failure.reason], failure.detail].filter(Boolean).join(" "));
    }
  });
}

export function adoptionUnlink(call: AdoptionCall, input: BlingAdoptionOperationMap["erp_bling_adoption_unlink"]["input"]) {
  return command(call, "erp_bling_adoption_unlink", input.command_id, ctx => {
    const link = linkOf(ctx.db, input.entity, input.source_id);
    if (!link) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
    // Só o vínculo: o cadastro do ERP continua como está. Sem exclusão em massa.
    // O registro fica entre os ignorados para o lote não religar sozinho; a
    // pessoa pode ligar de novo pelas pendências ignoradas.
    const raw = readRaw(ctx.db, input.entity, input.source_id);
    ctx.db.exec("DELETE FROM wb_bling_adoption_link WHERE entity=? AND source_id=?", input.entity, input.source_id);
    if (raw) {
      writeReview(ctx.db, input.entity, raw, "unlinked", [link.record_id], call.now());
      ctx.db.exec("UPDATE wb_bling_adoption_review SET state='ignored' WHERE entity=? AND source_id=?", input.entity, input.source_id);
    }
    return { record_id: link.record_id };
  });
}
