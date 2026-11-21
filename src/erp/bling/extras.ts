/** Fatia D do Bling: adoção revisada do que o coletor passou a ler.
 *
 * Mesmo mecanismo da B1/B2: prévia (nada gravado), três estados (coletado,
 * adotado, pendente de revisão), sem duplicar (a chave entidade + id no Bling
 * é única) e só pelas funções de domínio das telas, por invokeRpc. Os
 * mapeadores leem só os campos conhecidos do formato público da API v3; o que
 * não vier no formato esperado vira pendência com o motivo, sem adivinhar.
 * Nada aqui escreve no Bling (a mão dupla das listas e dos campos fica em
 * extras-two-way.ts). */
import "../domains/index.ts";
import type { Row, SqlDriver } from "../engine/driver.ts";
import { ErpError } from "../engine/errors.ts";
import { invokeRpc, type RpcContext } from "../engine/registry.ts";
import { ERP_PART_MODULES, ERP_PART_NAMES, type ErpParts } from "../parts.ts";
import { BlingAdoptionError } from "./adoption-contracts.ts";
import { archiveAvailable, at, clip, commandUuid, fold, linkOf, object, readRaw, sourceOf, text, type AdoptionRaw, type Json } from "./adoption-store.ts";
import { command, domainFailure, transaction, type AdoptionCall } from "./adoption.ts";
import { publicCutover } from "./cutover.ts";
import {
  BLING_EXTRAS_BATCH, BLING_EXTRAS_ENTITIES, BLING_EXTRAS_LABELS, BLING_EXTRAS_OUTCOMES, BLING_EXTRAS_PARTS, BLING_EXTRAS_REASONS, BLING_EXTRAS_TEXTS,
  type BlingExtrasBatchEntity, type BlingExtrasContractDraft, type BlingExtrasEntity, type BlingExtrasOperationMap, type BlingExtrasOutcome,
  type BlingExtrasPreviewItem, type BlingExtrasReason, type BlingExtrasReview, type BlingExtrasStatus,
} from "./extras-contracts.ts";
import { parseHistoricalPayload } from "./projection.ts";
import { exactDecimalEqual } from "./schema.ts";
import { BLING_EXTRA_PROPOSED_ACCESS } from "./resources.ts";
import { erpHash, erpState, extrasTwoWayStatus } from "./extras-two-way.ts";

type Summary = Record<string, string | null>;
type Entity = BlingExtrasBatchEntity;
/** Um pedaço por pedido: até 25 registros ou 1,5 s (a tela repete). */
export const EXTRAS_UNIT = Object.freeze({ records: 25, wall_ms: 1500 });
const DECIMAL = /^-?(0|[1-9]\d{0,13})(\.\d+)?$/;
const iso = (v: number | null | undefined) => v === null || v === undefined ? null : new Date(Number(v)).toISOString();

// ---------------------------------------------------------------------------
// Acervo, vínculos e pendências (versão 24)

/** Registro corrente de um recurso da fatia D (wb_bling_extra_raw). */
export function readExtraRaw(db: SqlDriver, entity: string, source: string): AdoptionRaw | null {
  const row = db.exec(`SELECT r.source_id, r.version, r.version_hash, r.payload, CASE WHEN coalesce(m.deleted_observed,0)=1 THEN 1 ELSE 0 END AS deleted
    FROM wb_bling_extra_raw r LEFT JOIN wb_bling_record_version m ON m.entity=r.entity AND m.source_id=r.source_id AND m.version=r.version
    WHERE r.entity=? AND r.source_id=?`, entity, source).rows[0];
  if (!row) return null;
  let payload: Json;
  try { payload = parseHistoricalPayload(String(row.payload)).payload as Json; } catch { payload = {}; }
  return { source_id: String(row.source_id), version: Number(row.version), hash: String(row.version_hash), payload, deleted: Number(row.deleted) === 1 };
}
/** Valores de campo: a chave é "products:id" ou "contacts:id" (o registro que os traz). */
function rawOf(db: SqlDriver, entity: Entity | "contracts", key: string): AdoptionRaw | null {
  if (entity !== "custom_field_values") return readExtraRaw(db, entity, key);
  const [kind, id] = key.split(":");
  const raw = kind === "products" || kind === "contacts" ? readRaw(db, kind, id) : null;
  return raw && { ...raw, source_id: key };
}
export interface ExtraLink { record_id: string; source_version: number; mode: string; erp_hash: string | null; data: Json }
export function extraLink(db: SqlDriver, entity: string, source: string): ExtraLink | null {
  const r = db.exec("SELECT record_id, source_version, mode, erp_hash, data FROM wb_bling_adoption_extra_link WHERE entity=? AND source_id=?", entity, source).rows[0];
  return r ? { record_id: String(r.record_id), source_version: Number(r.source_version), mode: String(r.mode), erp_hash: r.erp_hash == null ? null : String(r.erp_hash), data: JSON.parse(String(r.data)) } : null;
}
export function writeExtraLink(db: SqlDriver, entity: string, raw: Pick<AdoptionRaw, "source_id" | "version" | "hash">, record: string, mode: string, actor: string, now: number, data: Json = {}, erpHash: string | null = null) {
  db.exec(`INSERT INTO wb_bling_adoption_extra_link(entity,source_id,record_id,source_version,source_hash,mode,erp_hash,data,adopted_by,adopted_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entity,source_id) DO UPDATE SET record_id=excluded.record_id, source_version=excluded.source_version, source_hash=excluded.source_hash, mode=excluded.mode,
      erp_hash=excluded.erp_hash, data=excluded.data, adopted_by=excluded.adopted_by, adopted_at=excluded.adopted_at`,
    entity, raw.source_id, record, raw.version, raw.hash, mode, erpHash, JSON.stringify(data), actor, now);
  db.exec("DELETE FROM wb_bling_adoption_extra_review WHERE entity=? AND source_id=?", entity, raw.source_id);
}
export function writeExtraReview(db: SqlDriver, entity: string, raw: Pick<AdoptionRaw, "source_id" | "version" | "hash">, reason: BlingExtrasReason, candidates: string[], now: number, detail?: string | null, state: "pending" | "ignored" = "pending") {
  db.exec(`INSERT INTO wb_bling_adoption_extra_review(entity,source_id,state,reason,detail,candidates,source_version,source_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entity,source_id) DO UPDATE SET state=excluded.state, reason=excluded.reason, detail=excluded.detail, candidates=excluded.candidates,
      source_version=excluded.source_version, source_hash=excluded.source_hash, updated_at=excluded.updated_at`,
    entity, raw.source_id, state, reason, clip(detail ?? null, 600), JSON.stringify(candidates.slice(0, 5)), raw.version, raw.hash, now, now);
}
function extraReview(db: SqlDriver, entity: string, source: string) {
  const r = db.exec("SELECT state, reason, detail, candidates, source_version FROM wb_bling_adoption_extra_review WHERE entity=? AND source_id=?", entity, source).rows[0];
  return r ? { state: String(r.state), reason: String(r.reason) as BlingExtrasReason, detail: r.detail == null ? null : String(r.detail), candidates: JSON.parse(String(r.candidates)) as string[], source_version: Number(r.source_version) } : null;
}

// ---------------------------------------------------------------------------
// Partes

export function extrasEnabled(entity: BlingExtrasEntity, parts: Readonly<ErpParts> | null | undefined): boolean {
  return !!parts?.customers && BLING_EXTRAS_PARTS[entity].every(part => !!parts[part]);
}
export function extrasPartOffMessage(entity: BlingExtrasEntity, parts: Readonly<ErpParts> | null | undefined): string {
  const names = [...new Set(BLING_EXTRAS_PARTS[entity].filter(part => !parts?.[part]).map(part => ERP_PART_NAMES[ERP_PART_MODULES[part]]))];
  const list = names.length ? names : [ERP_PART_NAMES[ERP_PART_MODULES.customers]];
  const spoken = list.length > 1 ? `${list.slice(0, -1).join(", ")} e ${list.at(-1)}` : list[0];
  return `Para adotar ${BLING_EXTRAS_LABELS[entity].toLowerCase()}, ligue ${list.length > 1 ? "os módulos" : "o módulo"} ${spoken} em Gestão → Módulos.`;
}
function requireEntity(call: Pick<AdoptionCall, "parts">, entity: BlingExtrasEntity) {
  if (!extrasEnabled(entity, call.parts)) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", extrasPartOffMessage(entity, call.parts));
}
function requireArchive(db: SqlDriver) {
  if (!archiveAvailable(db)) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
}

// ---------------------------------------------------------------------------
// Conversões do formato do Bling (só o que é conhecido; o resto é recusado)

const civil = (v: unknown): string | null => {
  const t = text(v);
  if (!t) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(t), br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : br ? [br[3], br[2], br[1]] : [];
  if (!y || y === "0000") return null;
  const date = new Date(`${y}-${m}-${d}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === `${y}-${m}-${d}` ? `${y}-${m}-${d}` : null;
};
const decimal = (v: unknown): string | null => { const t = text(v); return t && DECIMAL.test(t) ? t : null; };
const truthy = (v: unknown) => v === true || ["1", "s", "sim", "true", "verdadeiro"].includes(fold(v) ?? "");
/** Tipo do campo do Bling → tipo do ERP (produto); null quando não reconhecido. */
function fieldType(p: Json): string | null {
  const t = fold(at(p, "tipoCampo", "nome") ?? at(p, "tipo", "nome") ?? p.tipoCampo ?? p.tipo);
  if (!t) return null;
  if (/texto longo|area de texto|memo|paragrafo/.test(t)) return "long_text";
  if (/^texto|^string/.test(t)) return "text";
  if (/inteiro/.test(t)) return "integer";
  if (/decimal|numero|numerico|moeda|valor/.test(t)) return "decimal";
  if (/^data/.test(t)) return "date";
  if (/lista|selecao unica|opcoes|combo/.test(t)) return "list";
  if (/sim\/nao|booleano|logico|checkbox|caixa de marcacao/.test(t)) return "boolean";
  return null;
}
const CONTACT_TYPE: Record<string, string> = { text: "text", long_text: "text", integer: "number", decimal: "number", date: "date", list: "list", boolean: "boolean" };
function fieldModule(p: Json): "products" | "contacts" | null {
  const m = fold(at(p, "modulo", "nome") ?? at(p, "modulo", "modulo") ?? at(p, "modulo", "descricao") ?? p.modulo);
  if (!m) return null;
  if (/produto/.test(m)) return "products";
  if (/contato|cliente|fornecedor/.test(m)) return "contacts";
  return null;
}
const options = (p: Json): string[] | null => {
  const list = Array.isArray(p.opcoes) ? p.opcoes : Array.isArray(p.opcoesLista) ? p.opcoesLista : null;
  if (!list) return null;
  return [...new Set(list.map(o => object(o) ? text(o.nome ?? o.valor ?? o.descricao) : text(o)).filter((o): o is string => !!o))];
};

// ---------------------------------------------------------------------------
// Plano de um registro: o que a adoção faria (a prévia mostra; adotar executa)

interface Plan {
  label: string; bling: Summary; outcome: "create" | "link" | "pending";
  reason?: BlingExtrasReason; detail?: string | null; candidates?: string[];
  /** Registro do ERP achado (ligar) ou alvo da atualização. */
  record?: string | null; erp?: Summary | null;
  /** Cria (ou completa) no ERP pela função de domínio; devolve o id do registro. */
  apply?: (ctx: RpcContext, actor: string, salt: string) => { record: string; data?: Json; message?: string };
  /** "Usar a do Bling" num registro que já existe. */
  update?: (ctx: RpcContext, actor: string, record: string, salt: string) => void;
  data?: Json;
}
const pending = (label: string, bling: Summary, reason: BlingExtrasReason, detail?: string | null, candidates: string[] = [], erp: Summary | null = null): Plan =>
  ({ label, bling, outcome: "pending", reason, detail: detail ?? null, candidates, erp });
const resultId = (value: unknown, ...paths: string[][]): string => {
  for (const path of paths) { const v = at(value, ...path); if (typeof v === "string" && v) return v; }
  throw new ErpError("XX000", "erp_bling_extras_result_without_id");
};
const refused = (result: unknown, reason: BlingExtrasReason = "duplicate") => {
  if (at(result, "saved") === false) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", at(result, "reason") === "limit" ? BLING_EXTRAS_REASONS.limit : BLING_EXTRAS_REASONS[reason]);
};
const versionOf = (db: SqlDriver, table: string, idColumn: string, id: string) => Number(db.exec(`SELECT version FROM ${table} WHERE ${idColumn}=?`, id).rows[0]?.version ?? 0);

function planCustomField(db: SqlDriver, raw: AdoptionRaw, parts: Readonly<ErpParts>): Plan {
  const p = raw.payload, name = text(p.nome ?? p.descricao), module = fieldModule(p), type = fieldType(p), opts = options(p);
  const label = clip(name ?? raw.source_id, 120)!;
  const bling: Summary = { "Nome": name, "Módulo": module === "products" ? "Produto" : module === "contacts" ? "Contato" : text(at(p, "modulo", "nome") ?? p.modulo), "Tipo": text(at(p, "tipoCampo", "nome") ?? p.tipo), "Obrigatório": truthy(p.obrigatorio) ? "Sim" : "Não" };
  if (!name) return pending(label, bling, "missing_name");
  if (!module) return pending(label, bling, "unknown_format", "O Bling não disse se o campo é de produto ou de contato (módulo do campo).");
  if (!type) return pending(label, bling, "unknown_format", "O tipo do campo vindo do Bling não é conhecido.");
  if (type === "list" && !opts?.length) return pending(label, bling, "unknown_format", "O campo é uma lista, mas o Bling não trouxe as opções.");
  if (module === "products" && !parts.products) return pending(label, bling, "dependency", "Campo de produto: ligue o módulo Produtos e serviços em Gestão → Módulos.");
  const erpType = module === "products" ? type : CONTACT_TYPE[type];
  const rows = module === "products" ? db.exec("SELECT id, name, field_type FROM erp_catalog__custom_field WHERE module='products'").rows : db.exec("SELECT id, name, field_type FROM erp_catalog__contact_field").rows;
  const same = rows.filter(r => fold(r.name) === fold(name));
  const summaryOf = (r: Row): Summary => ({ "Nome": String(r.name), "Módulo": module === "products" ? "Produto" : "Contato", "Tipo": String(r.field_type), "Obrigatório": null });
  const data = { module, field_type: erpType };
  if (same.length > 1) return pending(label, bling, "ambiguous", null, same.map(r => String(r.id)));
  if (same.length === 1) {
    const r = same[0];
    if (String(r.field_type) !== erpType) return { ...pending(label, bling, "divergent", `No ERP o campo é do tipo ${String(r.field_type)}; no Bling, ${erpType}. O tipo não muda depois de criado.`, [String(r.id)], summaryOf(r)) };
    return { label, bling, outcome: "link", record: String(r.id), erp: summaryOf(r), data };
  }
  const required = truthy(p.obrigatorio);
  return { label, bling, outcome: "create", erp: null, data, apply(ctx, actor, salt) {
    const command = commandUuid("bling-extras", "custom_fields", raw.source_id, String(raw.version), salt);
    if (module === "products") {
      const result = invokeRpc(ctx, "erp_catalog_custom_field_save", { p_user_id: actor, p_id: null, p_expected_version: 0, p_command_id: command,
        p_data: { field_type: erpType, name, required, ...(type === "list" ? { options: opts!.slice(0, 50).map(label => ({ label })) } : {}) } });
      refused(result);
      return { record: resultId(result, ["field", "id"]), data };
    }
    const result = invokeRpc(ctx, "erp_catalog_contact_field_save", { p_user_id: actor, p_command_id: command, p_id: null, p_expected_version: 0,
      // O Bling não separa por tipo de contato: o campo vale para todos.
      p_data: { name, field_type: erpType, roles: ["customer", "supplier", "seller", "carrier"], required, ...(type === "list" ? { options: opts!.slice(0, 50).map(label => ({ label })) } : {}) } });
    refused(result);
    return { record: resultId(result, ["field", "id"]), data };
  }, update(ctx, actor, record, salt) {
    const command = commandUuid("bling-extras-update", "custom_fields", raw.source_id, String(raw.version), record, salt);
    if (module === "products") refused(invokeRpc(ctx, "erp_catalog_custom_field_save", { p_user_id: actor, p_id: record, p_expected_version: versionOf(ctx.db, "erp_catalog__custom_field", "id", record), p_command_id: command, p_data: { name, required } }));
    else refused(invokeRpc(ctx, "erp_catalog_contact_field_save", { p_user_id: actor, p_command_id: command, p_id: record, p_expected_version: versionOf(ctx.db, "erp_catalog__contact_field", "id", record), p_data: { name, required } }));
  } };
}

/** Valor do Bling no formato do campo do ERP; null = vazio; undefined = não dá para converter. */
function fieldValue(db: SqlDriver, module: "products" | "contacts", field: string, type: string, raw: unknown): string | null | undefined {
  const t = text(object(raw) ? raw.valor ?? raw.nome : raw);
  if (t === null) return null;
  if (type === "boolean") return ["1", "s", "sim", "true", "verdadeiro"].includes(fold(t)!) ? "true" : ["0", "n", "nao", "false", "falso"].includes(fold(t)!) ? "false" : undefined;
  if (type === "date") return civil(t) ?? undefined;
  if (type === "integer") return /^-?\d{1,15}$/.test(t) ? t : undefined;
  if (type === "decimal" || type === "number") return decimal(t.replace(",", ".")) ?? undefined;
  if (type === "list" && module === "products") {
    const option = db.exec("SELECT id, label FROM erp_catalog__custom_field_option WHERE field_id=?", field).rows.find(o => fold(o.label) === fold(t));
    return option ? String(option.id) : undefined;
  }
  return t;
}
function planFieldValues(db: SqlDriver, raw: AdoptionRaw): Plan {
  const [kind, source] = raw.source_id.split(":") as ["products" | "contacts", string];
  const p = raw.payload, label = clip(`${kind === "products" ? "Produto" : "Contato"} ${text(p.nome) ?? source}`, 120)!;
  const list = Array.isArray(p.camposCustomizados) ? p.camposCustomizados : null;
  const bling: Summary = { "Registro": label };
  if (!list) return pending(label, bling, "unknown_format", "O registro não trouxe os campos customizados (camposCustomizados).");
  const record = linkOf(db, kind, source)?.record_id ?? null;
  if (!record) return pending(label, bling, "dependency", `Adote primeiro o ${kind === "products" ? "produto" : "contato"} em Adotar cadastros.`);
  const current = new Map((kind === "products"
    ? db.exec("SELECT field_id, value FROM erp_catalog__product_custom_value WHERE record_id=?", record).rows
    : db.exec("SELECT field_id, value FROM erp_catalog__contact_field_value WHERE contact_id=?", record).rows).map(r => [String(r.field_id), String(r.value)]));
  const values: Record<string, string | null> = {}, erp: Summary = {}, differs: string[] = [];
  for (const item of list) {
    const fieldSource = sourceOf(at(item, "idCampoCustomizado") ?? at(item, "campoCustomizado") ?? at(item, "id"));
    if (!fieldSource) return pending(label, bling, "unknown_format", "Um valor veio sem o id do campo (idCampoCustomizado).");
    const link = extraLink(db, "custom_fields", fieldSource);
    if (!link) return pending(label, bling, "dependency", `O campo ${fieldSource} ainda não foi adotado (Campos customizados).`);
    if (link.data.module !== kind) return pending(label, bling, "unknown_format", `O campo ${fieldSource} é de ${link.data.module === "products" ? "produto" : "contato"}, mas veio num ${kind === "products" ? "produto" : "contato"}.`);
    const name = String(db.exec(kind === "products" ? "SELECT name FROM erp_catalog__custom_field WHERE id=?" : "SELECT name FROM erp_catalog__contact_field WHERE id=?", link.record_id).rows[0]?.name ?? fieldSource);
    const value = fieldValue(db, kind, link.record_id, String(link.data.field_type ?? "text"), object(item) ? item.valor : null);
    if (value === undefined) return pending(label, bling, "invalid_data", `O valor do campo ${name} não serve para o tipo do campo no ERP.`);
    bling[clip(name, 40)!] = clip(text(object(item) ? item.valor : null), 400);
    erp[clip(name, 40)!] = current.get(link.record_id) ?? null;
    const now = current.get(link.record_id) ?? null;
    if (now !== null && value !== null && now !== value) differs.push(name);
    if (now !== value) values[link.record_id] = value;
  }
  if (differs.length) return { ...pending(label, bling, "divergent", `No ERP já há outro valor em: ${differs.slice(0, 5).join(", ")}.`, [record], erp), record };
  if (!Object.keys(values).length) return { label, bling, outcome: "link", record, erp };
  const write = (ctx: RpcContext, actor: string, salt: string) => {
    const command = commandUuid("bling-extras", "custom_field_values", raw.source_id, String(raw.version), salt);
    if (kind === "products") {
      const merged = { ...Object.fromEntries(current), ...values };
      for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
      invokeRpc(ctx, "erp_catalog_product_save", { p_user_id: actor, p_id: record, p_expected_version: versionOf(ctx.db, "erp_catalog__record", "id", record), p_command_id: command, p_data: { custom_values: merged }, p_acknowledged: null });
    } else {
      const result = invokeRpc(ctx, "erp_catalog_contact_field_values_save", { p_user_id: actor, p_command_id: command, p_contact_id: record, p_audience: "agent", p_values: values });
      if (at(result, "saved") === false) {
        const errors = (at(result, "errors") as Json[] | undefined) ?? [];
        throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", `O ERP recusou os valores: ${errors.slice(0, 5).map(e => `${text(e.name) ?? "campo"} (${text(e.code) ?? "inválido"})`).join(", ")}.`);
      }
    }
    return { record };
  };
  return { label, bling, outcome: "create", record, erp, apply: write, update: (ctx, actor, _record, salt) => { write(ctx, actor, salt); } };
}

function planPriceList(db: SqlDriver, raw: AdoptionRaw): Plan {
  const p = raw.payload, name = text(p.nome ?? p.descricao), label = clip(name ?? raw.source_id, 120)!;
  const list = Array.isArray(p.produtos) ? p.produtos : Array.isArray(p.itens) ? p.itens : null;
  const bling: Summary = { "Nome": name, "Produtos": list ? String(list.length) : null };
  if (!name) return pending(label, bling, "missing_name");
  if (!list) return pending(label, bling, "unknown_format", "A lista não trouxe os produtos com preço (campo produtos ou itens).");
  if (list.length > 15000) return pending(label, bling, "invalid_data", "A lista passa de 15.000 produtos, o limite do ERP.");
  if (name.length > 120) return pending(label, bling, "invalid_data", "O nome da lista passa de 120 caracteres.");
  const items = new Map<string, string>(), missing: string[] = [];
  for (const item of list) {
    const product = sourceOf(at(item, "produto") ?? at(item, "idProduto")), price = decimal(at(item, "preco") ?? at(item, "valor"));
    if (!product || price === null || price.startsWith("-")) return pending(label, bling, "unknown_format", "Um item da lista veio sem o produto (produto.id) ou sem o preço no formato esperado.");
    const record = linkOf(db, "products", product)?.record_id;
    if (!record) { missing.push(product); continue; }
    items.set(record, price);
  }
  if (missing.length) return pending(label, bling, "dependency", `Faltam adotar ${missing.length} produto(s) desta lista em Adotar cadastros (ids no Bling: ${missing.slice(0, 5).join(", ")}).`);
  const same = db.exec("SELECT id, name, list_type FROM erp_pricing__price_list").rows.filter(r => fold(r.name) === fold(name));
  const erpOf = (r: Row): Summary => ({ "Nome": String(r.name), "Produtos": String(db.exec("SELECT count(*) AS n FROM erp_pricing__price_list_item WHERE list_id=?", r.id).rows[0]?.n ?? 0) });
  const sync = (ctx: RpcContext, actor: string, record: string, salt: string, remove: boolean) => {
    const now = new Map(ctx.db.exec("SELECT product_id, custom_price FROM erp_pricing__price_list_item WHERE list_id=?", record).rows.map(r => [String(r.product_id), r.custom_price == null ? null : String(r.custom_price)]));
    const add = [...items.keys()].filter(id => !now.has(id)), prices = [...items].filter(([id, price]) => !now.has(id) || now.get(id) === null || !exactDecimalEqual(now.get(id)!, price)).map(([product_id, custom_price]) => ({ product_id, custom_price }));
    const drop = remove ? [...now.keys()].filter(id => !items.has(id)) : [];
    for (let i = 0, part = 0; i < Math.max(add.length, prices.length, drop.length); i += 160, part++) {
      const change = { ...(add.length > i ? { add: add.slice(i, i + 160) } : {}), ...(prices.length > i ? { prices: prices.slice(i, i + 160) } : {}), ...(drop.length > i ? { remove: drop.slice(i, i + 160) } : {}) };
      invokeRpc(ctx, "erp_pricing_list_items", { p_user_id: actor, p_id: record, p_expected_version: versionOf(ctx.db, "erp_pricing__price_list", "id", record), p_command_id: commandUuid("bling-extras-items", raw.source_id, String(raw.version), salt, String(part)), p_change: change });
    }
  };
  if (same.length > 1) return pending(label, bling, "ambiguous", null, same.map(r => String(r.id)));
  if (same.length === 1) {
    const r = same[0], record = String(r.id);
    const now = new Map(db.exec("SELECT product_id, custom_price FROM erp_pricing__price_list_item WHERE list_id=?", record).rows.map(x => [String(x.product_id), x.custom_price == null ? null : String(x.custom_price)]));
    const equal = now.size === items.size && [...items].every(([id, price]) => now.get(id) != null && exactDecimalEqual(now.get(id)!, price));
    const update = (ctx: RpcContext, actor: string, target: string, salt: string) => {
      if (String(ctx.db.exec("SELECT list_type FROM erp_pricing__price_list WHERE id=?", target).rows[0]?.list_type) !== "custom")
        throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", "A lista do ERP não é do tipo personalizado: os preços por produto só existem nesse tipo. Mantenha a do ERP ou crie outra lista.");
      sync(ctx, actor, target, salt, true);
    };
    if (!equal || String(r.list_type) !== "custom") return { ...pending(label, bling, "divergent", "Já existe uma lista com este nome no ERP, com produtos ou preços diferentes.", [record], erpOf(r)), record, update };
    return { label, bling, outcome: "link", record, erp: erpOf(r), update };
  }
  return { label, bling, outcome: "create", erp: null, apply(ctx, actor, salt) {
    const result = invokeRpc(ctx, "erp_pricing_list_save", { p_user_id: actor, p_id: null, p_expected_version: 0, p_command_id: commandUuid("bling-extras", "price_lists", raw.source_id, String(raw.version), salt),
      // Preço por produto só existe na lista personalizada (sem fator, sem período).
      p_data: { name, category: "other", list_type: "custom", factor: null, factor_unit: "amount", direction: "increase", considers_datetime: false, contacts: [], regions: [] } });
    refused(result);
    const record = resultId(result, ["list", "id"]);
    sync(ctx, actor, record, salt, false);
    return { record };
  }, update(ctx, actor, record, salt) { sync(ctx, actor, record, salt, true); } };
}

function planSupplier(db: SqlDriver, raw: AdoptionRaw): Plan {
  const p = raw.payload;
  const productSource = sourceOf(at(p, "produto") ?? p.idProduto), supplierSource = sourceOf(at(p, "fornecedor") ?? at(p, "contato") ?? p.idFornecedor);
  const code = text(p.codigo ?? p.codigoFornecedor), description = text(p.descricao), cost = decimal(p.precoCusto), purchase = decimal(p.precoCompra);
  const label = clip(`${code ?? "sem código"} · produto ${productSource ?? "?"}`, 120)!;
  const bling: Summary = { "Código do fornecedor": code, "Descrição": description, "Preço de custo": cost, "Preço de compra": purchase, "Padrão": truthy(p.padrao) ? "Sim" : "Não" };
  if (!productSource || !supplierSource) return pending(label, bling, "unknown_format", "O registro veio sem o produto (produto.id) ou sem o fornecedor (fornecedor.id).");
  const product = linkOf(db, "products", productSource)?.record_id, supplier = linkOf(db, "contacts", supplierSource)?.record_id;
  if (!product || !supplier) return pending(label, bling, "dependency", `Adote primeiro ${!product ? `o produto ${productSource}` : `o fornecedor ${supplierSource}`} em Adotar cadastros.`);
  if (code && code.length > 60) return pending(label, bling, "invalid_data", "O código do fornecedor passa de 60 caracteres.");
  const old = db.exec("SELECT supplier_id, description, code, CAST(purchase_price AS TEXT) AS purchase_price, CAST(cost_price AS TEXT) AS cost_price, warranty_months, is_default FROM erp_catalog__product_supplier WHERE record_id=? ORDER BY position", product).rows
    .map(s => ({ supplier_id: String(s.supplier_id), description: s.description == null ? null : String(s.description), code: s.code == null ? null : String(s.code),
      purchase_price: s.purchase_price == null ? null : String(s.purchase_price), cost_price: s.cost_price == null ? null : String(s.cost_price),
      warranty_months: s.warranty_months == null ? null : String(s.warranty_months), is_default: Number(s.is_default) === 1 }));
  const mine = old.find(s => s.supplier_id === supplier);
  const erp: Summary | null = mine ? { "Código do fornecedor": mine.code, "Descrição": mine.description, "Preço de custo": mine.cost_price, "Preço de compra": mine.purchase_price, "Padrão": mine.is_default ? "Sim" : "Não" } : null;
  const save = (ctx: RpcContext, actor: string, salt: string) => {
    const entry = { supplier_id: supplier, description, code, purchase_price: purchase, cost_price: cost, warranty_months: mine?.warranty_months ?? null, is_default: mine?.is_default ?? (truthy(p.padrao) || old.length === 0) };
    const list = mine ? old.map(s => s.supplier_id === supplier ? entry : s) : [...old, entry];
    if (list.length > 20) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", "O produto já tem 20 fornecedores, o limite do ERP.");
    if (entry.is_default && list.filter(s => s.is_default).length > 1) for (const s of list) if (s !== entry) s.is_default = false;
    invokeRpc(ctx, "erp_catalog_product_save", { p_user_id: actor, p_id: product, p_expected_version: versionOf(ctx.db, "erp_catalog__record", "id", product), p_command_id: commandUuid("bling-extras", "product_suppliers", raw.source_id, String(raw.version), salt), p_data: { suppliers: list }, p_acknowledged: null });
    if (!ctx.db.exec("SELECT 1 AS x FROM erp_catalog__product_supplier WHERE record_id=? AND supplier_id=?", product, supplier).rows.length)
      throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", "O cadastro do produto só guarda fornecedores com os módulos Compras e Estoque ligados.");
    return { record: product, data: { supplier_id: supplier } };
  };
  if (mine && (mine.code ?? null) !== (code ?? null)) return { ...pending(label, bling, "divergent", "O produto já tem este fornecedor no ERP com outro código.", [product], erp), record: product, update: (ctx, actor, _r, salt) => { save(ctx, actor, salt); } };
  if (mine) return { label, bling, outcome: "link", record: product, erp, data: { supplier_id: supplier } };
  return { label, bling, outcome: "create", erp: null, apply: save, update: (ctx, actor, _r, salt) => { save(ctx, actor, salt); } };
}

function planLot(db: SqlDriver, raw: AdoptionRaw): Plan {
  const p = raw.payload;
  const productSource = sourceOf(at(p, "produto") ?? p.idProduto), code = text(p.lote ?? p.codigo ?? p.numero);
  const expires = civil(p.dataValidade ?? p.validade), made = civil(p.dataFabricacao ?? p.fabricacao);
  const quantity = text(p.saldo ?? p.quantidade ?? p.saldoFisico), warehouseSource = sourceOf(at(p, "deposito") ?? p.idDeposito);
  const label = clip(`Lote ${code ?? raw.source_id} · produto ${productSource ?? "?"}`, 120)!;
  const bling: Summary = { "Lote": code, "Validade": expires, "Fabricação": made, "Saldo": quantity, "Depósito": warehouseSource };
  if (!productSource || !code) return pending(label, bling, "unknown_format", "O lote veio sem o produto (produto.id) ou sem o código do lote.");
  if (code.length > 60) return pending(label, bling, "invalid_data", "O código do lote passa de 60 caracteres.");
  if ((text(p.dataValidade ?? p.validade) && !expires) || (text(p.dataFabricacao ?? p.fabricacao) && !made)) return pending(label, bling, "unknown_format", "A data de validade ou de fabricação veio num formato que não é data.");
  if (quantity !== null && !/^\d{1,12}(\.\d{1,6})?$/.test(quantity)) return pending(label, bling, "invalid_data", "O saldo do lote não é uma quantidade válida (negativo ou com mais de 6 casas).");
  const product = linkOf(db, "products", productSource)?.record_id;
  if (!product) return pending(label, bling, "dependency", `Adote primeiro o produto ${productSource} em Adotar cadastros.`);
  if (Number(db.exec("SELECT lot_control FROM erp_catalog__product_detail WHERE record_id=?", product).rows[0]?.lot_control ?? 0) !== 1) return pending(label, bling, "lot_control_off");
  const cutover = publicCutover(db).cutover_on;
  if (!cutover) return pending(label, bling, "needs_cutover");
  const withBalance = quantity !== null && !/^0+(\.0+)?$/.test(quantity);
  const warehouse = warehouseSource ? linkOf(db, "warehouses", warehouseSource)?.record_id ?? null : null;
  if (withBalance && !warehouseSource) return pending(label, bling, "unknown_format", "O lote tem saldo, mas veio sem o depósito (deposito.id).");
  if (withBalance && !warehouse) return pending(label, bling, "dependency", `Adote primeiro o depósito ${warehouseSource} em Adotar cadastros.`);
  const opened = !!warehouseSource && db.exec("SELECT 1 AS x FROM wb_bling_cutover_item WHERE kind='stock' AND key=? AND state IN ('partial','posted')", warehouseSource).rows.length > 0;
  const existing = db.exec("SELECT id, code, expires_on FROM erp_stock__lot WHERE product_id=? AND code=?", product, code).rows;
  if (existing.length) {
    const r = existing[0], erp: Summary = { "Lote": String(r.code), "Validade": r.expires_on == null ? null : String(r.expires_on), "Fabricação": null, "Saldo": null, "Depósito": null };
    if ((r.expires_on == null ? null : String(r.expires_on)) !== expires) return pending(label, bling, "divergent", "O lote já existe no ERP com outra validade. Ajuste no Estoque, se for o caso.", [String(r.id)], erp);
    return { label, bling, outcome: "link", record: String(r.id), erp };
  }
  return { label, bling, outcome: "create", erp: null, apply(ctx, actor, salt) {
    const command = commandUuid("bling-extras", "product_lots", raw.source_id, String(raw.version), salt);
    const note = `Lote vindo do Bling (saldo na data de corte ${cutover.split("-").reverse().join("/")}).`;
    if (withBalance && !opened) {
      const balance = ctx.db.exec('SELECT version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse).rows[0];
      const result = invokeRpc(ctx, "erp_stock_lot_launch", { p_user_id: actor, p_command_id: command, p_kind: "balance", p_product_id: product, p_warehouse_id: warehouse,
        p_quantity: quantity, p_expected_version: balance ? Number(balance.version) : 0, p_lot: { code, manufactured_on: made, expires_on: expires }, p_note: note });
      return { record: resultId(result, ["lot", "id"]) };
    }
    const result = invokeRpc(ctx, "erp_stock_lot_import", { p_user_id: actor, p_command_id: command, p_product_id: product, p_code: code, p_manufactured_on: made, p_expires_on: expires,
      p_note: withBalance ? `${note} Sem saldo: o estoque de abertura deste depósito já foi gravado.` : note });
    return { record: resultId(result, ["lot", "id"]), message: withBalance ? `Lote ${code}: entrou sem saldo porque o estoque de abertura do depósito já foi gravado (senão somaria de novo).` : undefined };
  } };
}

function planNature(db: SqlDriver, raw: AdoptionRaw): Plan {
  const p = raw.payload, description = text(p.descricao ?? p.nome), label = clip(description ?? raw.source_id, 120)!;
  const kind = fold(at(p, "tipo", "id") ?? at(p, "tipo", "descricao") ?? p.tipo ?? p.tipoOperacao);
  const direction = kind === null ? null : ["e", "0", "entrada"].includes(kind) ? "0" : ["s", "1", "saida"].includes(kind) ? "1" : null;
  const crt = text(p.crt ?? p.regimeTributario ?? at(p, "regime", "id"));
  const bling: Summary = { "Descrição": description, "Tipo": direction === "0" ? "Entrada" : direction === "1" ? "Saída" : text(p.tipo), "CRT": crt, "Padrão no Bling": truthy(p.padrao) ? "Sim (não muda a padrão do ERP)" : "Não" };
  if (!description) return pending(label, bling, "missing_name");
  if (description.length > 60) return pending(label, bling, "invalid_data", "A descrição passa de 60 caracteres, o limite do Fiscal.");
  if (!direction) return pending(label, bling, "unknown_format", "O Bling não disse se a natureza é de entrada ou de saída.");
  if (!crt || !/^[1-4]$/.test(crt)) return pending(label, bling, "unknown_format", "O Bling não informou o regime tributário (CRT) desta natureza. Crie-a no Fiscal, se precisar.");
  const series = text(p.serie);
  const rows = db.exec("SELECT id, description, direction, crt FROM erp_fiscal_invoices__nature").rows.filter(r => fold(r.description) === fold(description) && String(r.direction) === direction);
  const erpOf = (r: Row): Summary => ({ "Descrição": String(r.description), "Tipo": String(r.direction) === "0" ? "Entrada" : "Saída", "CRT": String(r.crt), "Padrão no Bling": null });
  if (rows.length > 1) return pending(label, bling, "ambiguous", null, rows.map(r => String(r.id)));
  if (rows.length === 1) return String(rows[0].crt) === crt ? { label, bling, outcome: "link", record: String(rows[0].id), erp: erpOf(rows[0]) }
    : pending(label, bling, "divergent", "Já existe uma natureza com esta descrição no ERP, com outro regime (CRT).", [String(rows[0].id)], erpOf(rows[0]));
  return { label, bling, outcome: "create", erp: null, apply(ctx, actor, salt) {
    // Só "create": a natureza padrão do Fiscal (set_default) nunca é trocada aqui.
    const result = invokeRpc(ctx, "erp_fiscal_nature_execute", { p_user_id: actor, p_command_id: commandUuid("bling-extras", "operation_natures", raw.source_id, String(raw.version), salt), p_action: "create",
      p_data: { nature: { description, direction, crt, ...(series && /^\d{1,3}$/.test(series) ? { series } : {}) } } });
    return { record: resultId(result, ["nature", "id"]) };
  } };
}

function plan(db: SqlDriver, entity: Entity, raw: AdoptionRaw, parts: Readonly<ErpParts>): Plan {
  switch (entity) {
    case "custom_fields": return planCustomField(db, raw, parts);
    case "custom_field_values": return planFieldValues(db, raw);
    case "price_lists": return planPriceList(db, raw);
    case "product_suppliers": return planSupplier(db, raw);
    case "product_lots": return planLot(db, raw);
    case "operation_natures": return planNature(db, raw);
  }
}

// ---------------------------------------------------------------------------
// Chaves do acervo por entidade (ordem estável, para continuar de onde parou)

function keysAfter(db: SqlDriver, entity: Entity, after: string | null, limit: number, onlyWaiting = false): string[] {
  const waiting = onlyWaiting ? " AND NOT EXISTS(SELECT 1 FROM wb_bling_adoption_extra_link l WHERE l.entity=? AND l.source_id=k) AND NOT EXISTS(SELECT 1 FROM wb_bling_adoption_extra_review v WHERE v.entity=? AND v.source_id=k)" : "";
  const extra = onlyWaiting ? [entity, entity] : [];
  if (entity === "custom_field_values")
    return db.exec(`SELECT k FROM (SELECT entity||':'||source_id AS k FROM origin_sync__raw_record WHERE entity IN ('contacts','products') AND json_valid(payload) AND json_type(payload,'$.camposCustomizados')='array' AND json_array_length(payload,'$.camposCustomizados')>0)
      WHERE (? IS NULL OR k>?)${waiting} ORDER BY k LIMIT ?`, after, after, ...extra, limit).rows.map(r => String(r.k));
  return db.exec(`SELECT k FROM (SELECT source_id AS k FROM wb_bling_extra_raw WHERE entity=?) WHERE (? IS NULL OR k>?)${waiting} ORDER BY k LIMIT ?`, entity, after, after, ...extra, limit).rows.map(r => String(r.k));
}
function collected(db: SqlDriver, entity: BlingExtrasEntity): number {
  if (entity === "custom_field_values") return Number(db.exec(`SELECT count(*) AS n FROM origin_sync__raw_record WHERE entity IN ('contacts','products') AND json_valid(payload) AND json_type(payload,'$.camposCustomizados')='array' AND json_array_length(payload,'$.camposCustomizados')>0`).rows[0]?.n ?? 0);
  return Number(db.exec("SELECT count(*) AS n FROM wb_bling_extra_raw WHERE entity=?", entity).rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Um registro (sempre dentro de uma transação do motor)

type Outcome = "adopted" | "linked" | "pending" | "skipped";
function adoptOne(ctx: RpcContext, entity: Entity, key: string, actor: string, now: number, parts: Readonly<ErpParts>): { outcome: Outcome; message?: string } {
  const db = ctx.db;
  if (extraLink(db, entity, key)) return { outcome: "skipped" };
  const review = extraReview(db, entity, key);
  const raw = rawOf(db, entity, key);
  if (!raw) return { outcome: "skipped" };
  if (review && (review.state === "ignored" || review.source_version === raw.version)) return { outcome: "skipped" };
  if (raw.deleted) { writeExtraReview(db, entity, raw, "source_deleted", [], now); return { outcome: "pending" }; }
  const p = plan(db, entity, raw, parts);
  if (p.outcome === "pending") { writeExtraReview(db, entity, raw, p.reason!, p.candidates ?? [], now, p.detail); return { outcome: "pending" }; }
  if (p.outcome === "link") { writeExtraLink(db, entity, raw, p.record!, "linked", actor, now, p.data ?? {}); return { outcome: "linked" }; }
  const done = p.apply!(ctx, actor, "create");
  writeExtraLink(db, entity, raw, done.record, "created", actor, now, done.data ?? p.data ?? {});
  return { outcome: "adopted", message: done.message };
}

/** Mão dupla (entrada): o mesmo registro, pelas mesmas regras, sem passar pela revisão anterior. */
export function adoptExtraCollected(ctx: RpcContext, entity: Entity, key: string, actor: string, now: number, parts: Readonly<ErpParts>) {
  return adoptOne(ctx, entity, key, actor, now, parts);
}
/** Mão dupla (entrada): aplica a versão nova num registro já ligado ("usar a do Bling"). */
export function applyExtraUpdate(ctx: RpcContext, entity: Entity, key: string, actor: string, now: number, parts: Readonly<ErpParts>): boolean {
  const link = extraLink(ctx.db, entity, key), raw = rawOf(ctx.db, entity, key);
  if (!link || !raw) return false;
  const p = plan(ctx.db, entity, raw, parts);
  if (!p.update) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", p.reason ? [BLING_EXTRAS_REASONS[p.reason], p.detail].filter(Boolean).join(" ") : "Este registro não aceita atualização pelo Bling.");
  p.update(ctx, actor, link.record_id, `update-${raw.version}`);
  writeExtraLink(ctx.db, entity, raw, link.record_id, "updated", actor, now, { ...link.data, ...(p.data ?? {}) }, link.erp_hash);
  return true;
}

// ---------------------------------------------------------------------------
// Operações

export function extrasStatus(call: Pick<AdoptionCall, "db" | "parts">): BlingExtrasStatus {
  const { db, parts } = call, available = archiveAvailable(db);
  const n = (sql: string, ...args: unknown[]) => Number(db.exec(sql, ...args).rows[0]?.n ?? 0);
  const entities = BLING_EXTRAS_ENTITIES.map(entity => {
    const enabled = extrasEnabled(entity, parts), total = collected(db, entity);
    const adopted = n("SELECT count(*) AS n FROM wb_bling_adoption_extra_link WHERE entity=?", entity);
    const pendingCount = n("SELECT count(*) AS n FROM wb_bling_adoption_extra_review WHERE entity=? AND state='pending'", entity);
    const ignored = n("SELECT count(*) AS n FROM wb_bling_adoption_extra_review WHERE entity=? AND state='ignored'", entity);
    const access = entity === "custom_field_values" ? { path: "camposCustomizados nos produtos e contatos coletados", doubt: "Os valores vêm dentro do produto e do contato; conferir o nome do campo (camposCustomizados) numa coleta real." } : BLING_EXTRA_PROPOSED_ACCESS[entity];
    return { entity, label: BLING_EXTRAS_LABELS[entity], module_names: [...new Set(BLING_EXTRAS_PARTS[entity].map(part => ERP_PART_NAMES[ERP_PART_MODULES[part]]))], enabled,
      part_off_message: enabled ? null : extrasPartOffMessage(entity, parts), proposed_path: clip(access.path, 200)!, doubt: clip(access.doubt, 300)!,
      collected: total, adopted, pending: pendingCount, ignored, waiting: entity === "service_invoices" ? 0 : Math.max(0, total - adopted - pendingCount - ignored) };
  });
  const twoWay = extrasTwoWayStatus(db, parts);
  return { available, unavailable_message: available ? null : "O acervo do Bling ainda não tem conta vinculada ou está sendo apagado. Colete os dados antes de adotar.",
    cutover_on: publicCutover(db).cutover_on, entities, two_way: twoWay.entities, audit: twoWay.audit, texts: { ...BLING_EXTRAS_TEXTS } };
}

const outcomeText = (o: BlingExtrasOutcome) => BLING_EXTRAS_OUTCOMES[o];
export function extrasPreview(call: Pick<AdoptionCall, "db" | "parts">, input: BlingExtrasOperationMap["erp_bling_extras_preview"]["input"]): BlingExtrasOperationMap["erp_bling_extras_preview"]["output"] {
  const { db, parts } = call, entity = input.entity, limit = input.limit ?? 20;
  requireArchive(db); requireEntity(call, entity);
  const keys = keysAfter(db, entity, input.cursor ?? null, limit + 1);
  const items: BlingExtrasPreviewItem[] = keys.slice(0, limit).map(key => {
    const raw = rawOf(db, entity, key)!, link = extraLink(db, entity, key), review = extraReview(db, entity, key);
    const p = plan(db, entity, raw, parts);
    const base = { source_id: key, label: p.label, bling: p.bling, erp: p.erp ?? null };
    if (link) return { ...base, outcome: "adopted" as const, outcome_text: outcomeText("adopted"), reason_text: null, record_id: link.record_id };
    if (review?.state === "ignored") return { ...base, outcome: "ignored" as const, outcome_text: outcomeText("ignored"), reason_text: null, record_id: null };
    if (raw.deleted) return { ...base, outcome: "pending" as const, outcome_text: outcomeText("pending"), reason_text: BLING_EXTRAS_REASONS.source_deleted, record_id: null };
    return { ...base, outcome: p.outcome, outcome_text: outcomeText(p.outcome), reason_text: p.outcome === "pending" ? [BLING_EXTRAS_REASONS[p.reason!], p.detail].filter(Boolean).join(" ") : null, record_id: p.record ?? null };
  });
  return { items, next_cursor: keys.length > limit ? items.at(-1)!.source_id : null, notice: BLING_EXTRAS_TEXTS.collect };
}

export function extrasReviews(call: Pick<AdoptionCall, "db" | "parts">, input: BlingExtrasOperationMap["erp_bling_extras_reviews"]["input"]): BlingExtrasOperationMap["erp_bling_extras_reviews"]["output"] {
  const { db, parts } = call, limit = input.limit ?? 20;
  const rows = db.exec("SELECT * FROM wb_bling_adoption_extra_review WHERE entity=? AND state=? AND (? IS NULL OR source_id>?) ORDER BY source_id LIMIT ?",
    input.entity, input.state ?? "pending", input.cursor ?? null, input.cursor ?? null, limit + 1).rows;
  const items: BlingExtrasReview[] = rows.slice(0, limit).map(r => {
    const reason = String(r.reason) as BlingExtrasReason, entity = input.entity;
    const raw = entity === "contracts" || entity === "service_invoices" ? readExtraRaw(db, entity, String(r.source_id)) : rawOf(db, entity, String(r.source_id));
    const p = raw && entity !== "contracts" && entity !== "service_invoices" ? plan(db, entity, raw, parts) : null;
    return { entity, source_id: String(r.source_id), state: String(r.state) as "pending" | "ignored", reason, reason_text: BLING_EXTRAS_REASONS[reason] ?? BLING_EXTRAS_REASONS.failed,
      detail: r.detail == null ? null : String(r.detail), bling: p?.bling ?? null,
      erp: p?.erp && p.record ? [{ record_id: p.record, summary: p.erp }] : (JSON.parse(String(r.candidates)) as string[]).slice(0, 5).map(id => ({ record_id: id, summary: {} })) };
  });
  return { items, next_cursor: rows.length > limit ? String(items.at(-1)!.source_id) : null };
}

/** Adota os conferidos na prévia (ou o próximo pedaço). Cada registro é uma
 * transação: a falha de um vira pendência dele e o pedaço segue. */
export function extrasAdopt(call: AdoptionCall, input: BlingExtrasOperationMap["erp_bling_extras_adopt"]["input"]): BlingExtrasOperationMap["erp_bling_extras_adopt"]["output"] {
  const { db, parts } = call, entity = input.entity, actor = call.identity.actor!.user_id;
  requireArchive(db); requireEntity(call, entity);
  const previous = db.exec("SELECT 1 AS x FROM wb_bling_adoption_command WHERE command_id=?", input.command_id).rows.length > 0;
  const counts = { processed: 0, adopted: 0, linked: 0, pending: 0, skipped: 0 }, messages: string[] = [];
  let more = false;
  if (!previous) {
    const started = call.now();
    const keys = input.source_ids ?? keysAfter(db, entity, null, EXTRAS_UNIT.records + 1, true);
    if (!input.source_ids && keys.length > EXTRAS_UNIT.records) { more = true; keys.length = EXTRAS_UNIT.records; }
    for (const [index, key] of keys.entries()) {
      if (index > 0 && call.now() - started > EXTRAS_UNIT.wall_ms) { more = true; break; }
      const at = call.now();
      try {
        const done = transaction(db, call.profile, ctx => adoptOne(ctx, entity, key, actor, at, parts), { identity: call.identity, parts });
        counts[done.outcome]++;
        if (done.message) messages.push(clip(done.message, 300)!);
      } catch (error) {
        const failure = domainFailure(error);
        if (failure.stop === "permission") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
        const raw = rawOf(db, entity, key);
        if (raw) db.transaction(() => writeExtraReview(db, entity, raw, failure.reason === "duplicate_warning" ? "duplicate" : failure.reason === "invalid_data" ? "invalid_data" : "failed", [], at,
          error instanceof BlingAdoptionError && error.code === "BLING_ADOPTION_PART_DISABLED" ? error.detail : failure.detail));
        counts[raw ? "pending" : "skipped"]++;
      }
      counts.processed++;
    }
  }
  return command(call, "erp_bling_extras_adopt", input.command_id, () => ({ counts, more, messages }));
}

export function extrasResolve(call: AdoptionCall, input: BlingExtrasOperationMap["erp_bling_extras_resolve"]["input"]): BlingExtrasOperationMap["erp_bling_extras_resolve"]["output"] {
  const { db, parts } = call, entity = input.entity;
  requireArchive(db); requireEntity(call, entity);
  return command(call, "erp_bling_extras_resolve", input.command_id, ctx => {
    const actor = call.identity.actor!.user_id, now = call.now();
    const raw = rawOf(ctx.db, entity, input.source_id);
    if (!raw) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
    const linked = extraLink(ctx.db, entity, input.source_id);
    if (linked) {
      // Conflito da mão dupla: o registro mudou dos dois lados.
      if (extraReview(ctx.db, entity, input.source_id)?.reason !== "conflict") throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "Este registro já está adotado. Desligue antes de decidir de novo.");
      const side = entity === "price_lists" ? "price_lists" as const : linked.data.module === "contacts" ? "custom_fields_contacts" as const : "custom_fields_products" as const;
      if (input.action === "use_bling") {
        applyExtraUpdate(ctx, entity, input.source_id, actor, now, parts);
        const state = erpState(ctx.db, side, linked.record_id);
        if (state) ctx.db.exec("UPDATE wb_bling_adoption_extra_link SET erp_hash=? WHERE entity=? AND source_id=?", erpHash(state), entity, input.source_id);
        return { outcome: "updated" as const, record_id: linked.record_id };
      }
      // Manter a do ERP: a versão do Bling conta como vista; com a escrita ligada, a do ERP vai para o Bling.
      writeExtraLink(ctx.db, entity, raw, linked.record_id, linked.mode, actor, now, linked.data, linked.erp_hash);
      return { outcome: "linked" as const, record_id: linked.record_id };
    }
    if (input.action === "ignore") { writeExtraReview(ctx.db, entity, raw, extraReview(ctx.db, entity, input.source_id)?.reason ?? "failed", [], now, null, "ignored"); return { outcome: "ignored" as const, record_id: null }; }
    const p = plan(ctx.db, entity, raw, parts);
    if (input.action === "keep_erp") {
      const allowed = [...(p.candidates ?? []), ...(p.record ? [p.record] : [])];
      if (!allowed.includes(input.record_id!)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "Escolha um dos registros do ERP mostrados na pendência.");
      writeExtraLink(ctx.db, entity, raw, input.record_id!, "linked", actor, now, p.data ?? {});
      return { outcome: "linked" as const, record_id: input.record_id! };
    }
    if (p.outcome === "create") { const done = p.apply!(ctx, actor, `resolve-${input.command_id}`); writeExtraLink(ctx.db, entity, raw, done.record, "created", actor, now, done.data ?? p.data ?? {}); return { outcome: "adopted" as const, record_id: done.record }; }
    if (p.update && p.record) { p.update(ctx, actor, p.record, `resolve-${input.command_id}`); writeExtraLink(ctx.db, entity, raw, p.record, "updated", actor, now, p.data ?? {}); return { outcome: "updated" as const, record_id: p.record }; }
    if (p.outcome === "link") { writeExtraLink(ctx.db, entity, raw, p.record!, "linked", actor, now, p.data ?? {}); return { outcome: "linked" as const, record_id: p.record! }; }
    throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", [BLING_EXTRAS_REASONS[p.reason!], p.detail].filter(Boolean).join(" "));
  });
}

export function extrasUnlink(call: AdoptionCall, input: BlingExtrasOperationMap["erp_bling_extras_unlink"]["input"]): BlingExtrasOperationMap["erp_bling_extras_unlink"]["output"] {
  requireEntity(call, input.entity);
  return command(call, "erp_bling_extras_unlink", input.command_id, ctx => {
    const link = extraLink(ctx.db, input.entity, input.source_id), raw = rawOf(ctx.db, input.entity, input.source_id);
    if (!link) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
    ctx.db.exec("DELETE FROM wb_bling_adoption_extra_link WHERE entity=? AND source_id=?", input.entity, input.source_id);
    if (raw) writeExtraReview(ctx.db, input.entity, raw, "unlinked", [link.record_id], call.now(), null, "ignored");
    return { record_id: link.record_id };
  });
}

// ---------------------------------------------------------------------------
// NFS-e: acervo fiscal só de consulta

const INVOICE_TEXT = BLING_EXTRAS_TEXTS.invoices;
export function extrasInvoices(call: Pick<AdoptionCall, "db" | "parts">, input: BlingExtrasOperationMap["erp_bling_extras_invoices"]["input"]): BlingExtrasOperationMap["erp_bling_extras_invoices"]["output"] {
  requireEntity(call, "service_invoices");
  const limit = input.limit ?? 20, q = fold(input.q ?? null);
  const rows = call.db.exec(`SELECT source_id, version, payload FROM wb_bling_extra_raw WHERE entity='service_invoices' AND (? IS NULL OR CAST(source_id AS INTEGER) < CAST(? AS INTEGER)) ORDER BY CAST(source_id AS INTEGER) DESC LIMIT 2000`, input.cursor ?? null, input.cursor ?? null).rows;
  const items: BlingExtrasOperationMap["erp_bling_extras_invoices"]["output"]["items"] = [];
  for (const r of rows) {
    let p: Json; try { p = parseHistoricalPayload(String(r.payload)).payload as Json; } catch { continue; }
    const issued = civil(p.dataEmissao ?? p.data), customer = text(at(p, "tomador", "nome") ?? at(p, "contato", "nome") ?? at(p, "cliente", "nome")), number = text(p.numero ?? p.numeroNFSe);
    if (input.from && (!issued || issued < input.from)) continue;
    if (input.to && (!issued || issued > input.to)) continue;
    if (q && !(fold(number) ?? "").includes(q) && !(fold(customer) ?? "").includes(q)) continue;
    items.push({ source_id: String(r.source_id), number: clip(number, 60), series: clip(text(p.serie), 20), issued_on: issued, customer: clip(customer, 200),
      total: clip(decimal(p.valor ?? p.valorServicos ?? at(p, "servico", "valor")), 40), situation: clip(text(object(p.situacao) ? (p.situacao as Json).descricao ?? (p.situacao as Json).id : p.situacao), 80), version: String(r.version) });
    if (items.length > limit) break;
  }
  const page = items.slice(0, limit);
  return { items: page, next_cursor: items.length > limit ? page.at(-1)!.source_id : null, read_only_message: INVOICE_TEXT };
}

// ---------------------------------------------------------------------------
// Contratos: prévia conferida aqui; o contrato de manutenção nasce no módulo
// Ordem de Serviço (Worker), e o vínculo volta para cá.

const PERIODS: [RegExp, "month" | "quarter" | "year"][] = [[/mensal|^1$|^m$/, "month"], [/trimestral|^3$|^t$/, "quarter"], [/anual|^12$|^a$/, "year"]];
export function contractDraft(db: SqlDriver, source: string): BlingExtrasContractDraft | null {
  const raw = readExtraRaw(db, "contracts", source);
  if (!raw) return null;
  const p = raw.payload, problems: string[] = [];
  const contact = object(p.contato) ? p.contato as Json : object(p.cliente) ? p.cliente as Json : null;
  const starts = civil(p.dataInicio ?? p.dataInicial ?? p.inicio ?? p.dataContrato), ends = civil(p.dataFim ?? p.dataFinal ?? p.fim ?? p.dataVencimento);
  const periodicity = text(object(p.periodicidade) ? (p.periodicidade as Json).descricao ?? (p.periodicidade as Json).id : p.periodicidade ?? p.tipoPeriodicidade ?? p.frequencia);
  const period = periodicity ? PERIODS.find(([re]) => re.test(fold(periodicity)!))?.[1] ?? null : null;
  const value = decimal(p.valor ?? p.valorMensal ?? p.valorContrato);
  if (!contact) problems.push("O contrato veio sem o cliente (contato).");
  if (!starts) problems.push("O contrato veio sem a data de início da vigência.");
  if (!value) problems.push("O contrato veio sem o valor no formato esperado. O valor da cobrança é o do plano da Mensalidade escolhido.");
  if (!period) problems.push("A periodicidade do contrato não é conhecida: escolha mensal, trimestral ou anual na criação.");
  if (raw.deleted) problems.push("O contrato foi excluído no Bling.");
  if (starts && ends && ends < starts) problems.push("A data final vem antes da inicial.");
  const contactSource = contact ? sourceOf(contact) : null;
  const adopted = contactSource ? linkOf(db, "contacts", contactSource)?.record_id ?? null : null;
  const erpContact = adopted ? db.exec("SELECT r.name, c.document, c.phone, c.mobile, c.email FROM erp_catalog__record r LEFT JOIN erp_catalog__contact c ON c.record_id=r.id WHERE r.id=?", adopted).rows[0] : undefined;
  const link = extraLink(db, "contracts", source);
  return {
    source_id: source, version: String(raw.version), number: clip(text(p.numero), 60), description: clip(text(p.descricao ?? p.observacoes), 400),
    customer: { name: clip(text(contact?.nome) ?? text(erpContact?.name), 200), document: clip(text(contact?.numeroDocumento) ?? text(erpContact?.document), 40),
      phone: clip(text(contact?.celular ?? contact?.telefone) ?? text(erpContact?.mobile ?? erpContact?.phone), 40), email: clip(text(contact?.email) ?? text(erpContact?.email), 200) },
    starts_on: starts, ends_on: ends, value, periodicity: clip(periodicity, 60), period, situation: clip(text(object(p.situacao) ? (p.situacao as Json).descricao ?? (p.situacao as Json).id : p.situacao), 60),
    problems, link: link ? { contract_id: link.record_id, number: link.data.number == null ? null : String(link.data.number), linked_at: iso(Number(db.exec("SELECT adopted_at FROM wb_bling_adoption_extra_link WHERE entity='contracts' AND source_id=?", source).rows[0]?.adopted_at))! } : null,
  };
}
export function extrasContracts(call: Pick<AdoptionCall, "db">, input: BlingExtrasOperationMap["erp_bling_extras_contracts"]["input"]): BlingExtrasOperationMap["erp_bling_extras_contracts"]["output"] {
  requireArchive(call.db);
  const limit = input.limit ?? 20;
  const ids = call.db.exec("SELECT source_id FROM wb_bling_extra_raw WHERE entity='contracts' AND (? IS NULL OR source_id>?) ORDER BY source_id LIMIT ?", input.cursor ?? null, input.cursor ?? null, limit + 1).rows.map(r => String(r.source_id));
  const items = ids.slice(0, limit).map(id => contractDraft(call.db, id)!);
  return { items, next_cursor: ids.length > limit ? items.at(-1)!.source_id : null };
}
/** O Worker criou o contrato de manutenção (ou a pessoa escolheu um que já existe): grava o vínculo. */
export function extrasContractLink(call: AdoptionCall, input: BlingExtrasOperationMap["erp_bling_extras_contract_link"]["input"]): BlingExtrasOperationMap["erp_bling_extras_contract_link"]["output"] {
  requireArchive(call.db);
  return command(call, "erp_bling_extras_contract_link", input.command_id, ctx => {
    const raw = readExtraRaw(ctx.db, "contracts", input.source_id);
    if (!raw) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
    if (String(raw.version) !== input.version) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "O contrato mudou no Bling depois da conferência. Confira de novo antes de criar.");
    const link = extraLink(ctx.db, "contracts", input.source_id);
    if (link && link.record_id !== input.contract_id) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "Este contrato do Bling já está ligado a outro contrato de manutenção.");
    const other = ctx.db.exec("SELECT source_id FROM wb_bling_adoption_extra_link WHERE entity='contracts' AND record_id=? AND source_id<>?", input.contract_id, input.source_id).rows[0];
    if (other) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", "Este contrato de manutenção já está ligado a outro contrato do Bling.");
    writeExtraLink(ctx.db, "contracts", raw, input.contract_id, link?.mode ?? "linked", call.identity.actor!.user_id, call.now(), { number: input.number ?? null });
    return { record_id: input.contract_id };
  });
}

/** Leitura para o Worker antes de criar o contrato: conferências do objeto. */
export function extrasContractDraftFor(call: Pick<AdoptionCall, "db">, source: string): BlingExtrasContractDraft {
  requireArchive(call.db);
  const draft = contractDraft(call.db, source);
  if (!draft) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
  return draft;
}
