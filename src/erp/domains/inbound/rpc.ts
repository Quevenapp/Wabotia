// Compra pela nota recebida (motor): o índice das notas que chegaram para a
// empresa, a conferência (fornecedor, itens, unidade, pedido de compra, custo
// e parcelas), a entrada e o estorno, o interruptor da manifestação e o
// registro do evento. Só o motor tem estas RPCs (structural.ts,
// compra-nota-recebida); assinaturas em engine/signatures-engine.ts.
//
// Regras:
// - O XML não entra aqui: o Worker o lê do R2, confere o SHA-256 gravado e
//   manda a nota já lida (src/erp/recebidas/xml.ts). O motor compara a chave
//   e o hash com o índice antes de usar.
// - Estoque, custo e contas a pagar saem pelas rotinas das telas
//   (erp_stock_launch, erp_stock_lot_launch, erp_finance_title_execute),
//   chamadas na mesma transação: ou a entrada inteira acontece, ou nada.
// - Uma entrada ativa por nota (índice único): repetir o comando devolve o
//   recibo; outro comando sobre nota já lançada devolve a entrada existente.
// - Cada parte só age ligada e com o papel da pessoa; o que não foi feito
//   volta com o motivo (part_disabled, not_chosen, role_missing, nothing).
import { createHash } from "node:crypto";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../engine/registry.ts";
import { requireErpParts } from "../../engine/parts-gate.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import { erpRequirement } from "../../parts.ts";
import * as documents from "../documents/public.ts";
import * as preferences from "../preferences/public.ts";
import * as stock from "../stock/public.ts";
import {
  PURPOSE_LABEL, classifyPurpose, documentKey, landedCosts, payableInstallments, scaled, similarity, stockQuantity, unitKey, unscaled,
  type InboundNote, type InboundPurpose, type LineCost,
} from "./model.ts";

const NOTE = "erp_purchase_inbound__note";
const ENTRY = "erp_purchase_inbound__entry";
const SETTINGS = "erp_purchase_inbound__settings";
const RECEIVED = "erp_fiscal_vault__received";
const CHANGE = "erp_fiscal_vault__received_change";
const CURSOR = "erp_fiscal_vault__cursor";
const EVENT = "erp_fiscal_vault__event";

/** Leitura: quem vê compras. Escrita: quem lança estoque, contas ou cuida das notas. */
const READ_ROLES = ["admin", "consulta", "estoque", "financeiro", "fiscal"];
const WRITE_ROLES = ["admin", "estoque", "financeiro", "fiscal"];
const STOCK_ROLES = ["admin", "estoque"];
const FINANCE_ROLES = ["admin", "financeiro"];
const MANIFEST_ROLES = ["admin", "fiscal"];
/** Guarda de frequência da busca no cofre (por ambiente). A leitura não vai ao governo, mas também não é laço. */
export const INBOUND_FETCH_INTERVAL_SECONDS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/;
const HEX = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const parse = (v: unknown): any => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const now = (ctx: RpcContext) => ctx.clock.next().toString();
const micros = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(BigInt(String(v)) / 1000n)).toISOString());

/** Comando derivado (uuid estável): a mesma entrada repetida gera os mesmos comandos internos. */
export function subCommand(command: string, label: string): string {
  const h = sha256(`${command}:${label}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function input(a: RpcArgs): Record<string, any> {
  const value = parse(a.p_input);
  if (!value || typeof value !== "object" || Array.isArray(value)) raise("22023", "inbound_input_invalid");
  return value;
}

/** Papel ativo da pessoa no ERP da área. */
function roleOf(db: SqlDriver, user: unknown): string {
  const r = typeof user === "string" ? one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user) : null;
  if (!r) raise("42501", "inbound_access_denied");
  return String(r.role);
}
function requireRole(db: SqlDriver, user: unknown, roles: readonly string[]): string {
  const role = roleOf(db, user);
  if (!roles.includes(role)) raise("42501", "inbound_role_denied");
  return role;
}

function settingsRow(db: SqlDriver) {
  const r = one(db, `SELECT version, manifest_enabled, updated_at, updated_by FROM "${SETTINGS}" WHERE id=1`);
  return {
    version: r ? Number(r.version) : 0,
    manifest_enabled: r ? Number(r.manifest_enabled) === 1 : false,
    updated_at: r ? micros(r.updated_at) : null,
    updated_by: r ? String(r.updated_by) : null,
  };
}

/** CNPJ da empresa (Dados da empresa). */
function companyDocument(db: SqlDriver): string | null {
  const r = one(db, 'SELECT data FROM "erp_company__identity" WHERE singleton=1');
  const doc = documentKey(obj(parse(r?.data)).cnpj ?? null);
  return doc || null;
}

function supplierByDocument(db: SqlDriver, document: string | null): { id: string; name: string; code: string | null } | null {
  const key = documentKey(document);
  if (!key) return null;
  const found = db
    .exec(`SELECT r.id, r.name, r.code, c.document, CAST(r.created_at AS TEXT) created FROM "erp_catalog__record" r
             JOIN "erp_catalog__contact" c ON c.record_id=r.id WHERE r.entity='contacts' AND r.active=1 AND c.document IS NOT NULL`)
    .rows.filter((r) => documentKey(String(r.document)) === key)
    .sort((x, y) => (BigInt(String(x.created)) < BigInt(String(y.created)) ? -1 : 1) || String(x.id).localeCompare(String(y.id)))[0];
  return found ? { id: String(found.id), name: String(found.name), code: found.code === null ? null : String(found.code) } : null;
}

// ---------------------------------------------------------------------------
// Índice

function noteRow(db: SqlDriver, id: unknown): Row {
  if (typeof id !== "string" || !UUID.test(id)) raise("22023", "inbound_note_invalid");
  const r = one(db, `SELECT * FROM "${NOTE}" WHERE id=?`, id);
  if (!r) raise("P0002", "inbound_note_not_found");
  return r;
}

function activeEntry(db: SqlDriver, note: string): Row | null {
  return one(db, `SELECT * FROM "${ENTRY}" WHERE note_id=? AND state='active'`, note);
}

function entryDto(r: Row | null) {
  if (!r) return null;
  return {
    id: String(r.id),
    state: String(r.state),
    command_id: String(r.command_id),
    supplier_id: r.supplier_id ?? null,
    order_id: r.order_id ?? null,
    stock_status: String(r.stock_status),
    finance_status: String(r.finance_status),
    movement_ids: parse(r.movement_ids) as string[],
    title_ids: parse(r.title_ids) as string[],
    result: parse(r.result),
    created_at: micros(r.created_at),
    actor: String(r.actor),
    reversed_at: micros(r.reversed_at),
    reversed_by: r.reversed_by ?? null,
    reversal_reason: r.reversal_reason ?? null,
    reversal: parse(r.reversal),
  };
}

const MANIFESTATION_LABEL: Record<string, string> = {
  ciencia: "Ciência da operação", confirmacao: "Confirmação da operação", desconhecimento: "Desconhecimento da operação", nao_realizada: "Operação não realizada",
};

function noteDto(db: SqlDriver, r: Row) {
  const received = r.received_id ? one(db, `SELECT * FROM "${RECEIVED}" WHERE id=?`, r.received_id) : null;
  const entry = activeEntry(db, String(r.id));
  const last = entry ?? one(db, `SELECT * FROM "${ENTRY}" WHERE note_id=? ORDER BY created_at DESC LIMIT 1`, r.id);
  const pending = received
    ? one(db, `SELECT manifestation, state, sequence, text, created_at, updated_at FROM "${EVENT}" WHERE received_id=? AND kind='manifestacao' AND state IN ('pedido','incerto') ORDER BY created_at DESC LIMIT 1`, received.id)
    : null;
  const supplier = supplierByDocument(db, r.emitter_document === null ? null : String(r.emitter_document));
  const purpose = (r.purpose ?? "outra") as InboundPurpose;
  return {
    id: String(r.id),
    source: String(r.source),
    environment: String(r.environment),
    access_key: String(r.access_key),
    role: String(r.role),
    emitter: { document: r.emitter_document ?? null, name: r.emitter_name ?? null },
    supplier,
    series: r.series ?? null,
    number: r.number ?? null,
    issued_on: r.issued_on ?? null,
    total_cents: r.total_cents === null ? null : Number(r.total_cents),
    situation: String(r.situation),
    nature: r.nature ?? null,
    cfops: parse(r.cfops) as string[],
    purpose,
    purpose_label: PURPOSE_LABEL[purpose],
    xml: r.xml_key ? { key: String(r.xml_key), sha256: String(r.xml_sha256), size: Number(r.xml_size) } : null,
    vault: received
      ? {
          id: String(received.id),
          xml_available: Number(received.xml_available) === 1,
          manifestation: received.manifestation
            ? { type: String(received.manifestation), label: MANIFESTATION_LABEL[String(received.manifestation)], at: received.manifestation_at === null ? null : new Date(Number(received.manifestation_at)).toISOString(), origin: received.manifestation_origin ?? null }
            : null,
          pending: pending ? { type: String(pending.manifestation), state: String(pending.state), justification: pending.text ?? null, at: micros(pending.updated_at) } : null,
          automatic_acknowledgement_refused: parse(received.auto_ack_refused),
        }
      : null,
    entry: entryDto(entry),
    last_entry: entry ? null : entryDto(last),
    version: Number(r.version),
    created_at: micros(r.created_at),
  };
}

registerRpc("erp_inbound_list", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireRole(db, a.p_user_id, READ_ROLES);
  const p = input(a);
  const environment = p.environment ?? null;
  if (environment !== null && !["producao", "homologacao"].includes(environment)) raise("22023", "inbound_environment_invalid");
  const status = p.status ?? "todas";
  if (!["todas", "pendentes", "lancadas", "estornadas"].includes(status)) raise("22023", "inbound_status_invalid");
  const page = Number(p.page ?? 1), per = Number(p.per_page ?? 50);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(per) || per < 1 || per > 100) raise("22023", "inbound_page_invalid");
  const where = [environment ? "n.environment=?" : "1=1"];
  if (status === "pendentes") where.push(`NOT EXISTS(SELECT 1 FROM "${ENTRY}" e WHERE e.note_id=n.id AND e.state='active')`);
  if (status === "lancadas") where.push(`EXISTS(SELECT 1 FROM "${ENTRY}" e WHERE e.note_id=n.id AND e.state='active')`);
  if (status === "estornadas") where.push(`EXISTS(SELECT 1 FROM "${ENTRY}" e WHERE e.note_id=n.id AND e.state='reversed') AND NOT EXISTS(SELECT 1 FROM "${ENTRY}" e WHERE e.note_id=n.id AND e.state='active')`);
  const args = environment ? [environment] : [];
  const total = Number(one(db, `SELECT count(*) n FROM "${NOTE}" n WHERE ${where.join(" AND ")}`, ...args)!.n);
  const rows = db.exec(
    `SELECT n.* FROM "${NOTE}" n WHERE ${where.join(" AND ")} ORDER BY coalesce(n.issued_on,'') DESC, n.created_at DESC, n.id LIMIT ? OFFSET ?`,
    ...args, per, (page - 1) * per,
  ).rows;
  const cursors = db.exec(`SELECT connection, last_sequence, read_at, error FROM "${CURSOR}" WHERE connection LIKE 'recebidas:%'`).rows.map((c) => ({
    environment: String(c.connection).slice("recebidas:".length),
    last_sequence: Number(c.last_sequence),
    read_at: micros(c.read_at),
    next_at: micros(BigInt(String(c.read_at)) + BigInt(INBOUND_FETCH_INTERVAL_SECONDS) * 1_000_000n),
    error: parse(c.error),
  }));
  return { items: rows.map((r) => noteDto(db, r)), total, page, per_page: per, settings: settingsRow(db), fetches: cursors, company_document: companyDocument(db) };
});

registerRpc("erp_inbound_get", (ctx: RpcContext, a: RpcArgs) => {
  requireRole(ctx.db, a.p_user_id, READ_ROLES);
  return noteDto(ctx.db, noteRow(ctx.db, input(a).id));
});

// ---------------------------------------------------------------------------
// Registro: nota lida do XML (importada à mão ou baixada do cofre)

interface NoteSummary {
  access_key: string; environment: string; emitter_document: string | null; emitter_name: string | null;
  series: number | null; number: number | null; issued_on: string | null; total_cents: number | null;
  nature: string | null; cfops: string[]; purpose: InboundPurpose; recipient_document: string | null;
}
function summary(value: unknown): NoteSummary {
  const s = obj(value);
  const intOrNull = (v: unknown, max: number) => (v === null || v === undefined ? null : Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max ? Number(v) : raise("22023", "inbound_note_invalid"));
  const text = (v: unknown, max: number) => (v === null || v === undefined ? null : typeof v === "string" && v.length <= max ? (v.trim() || null) : raise("22023", "inbound_note_invalid"));
  if (typeof s.access_key !== "string" || !KEY.test(s.access_key)) raise("22023", "inbound_access_key_invalid");
  if (!["producao", "homologacao"].includes(s.environment)) raise("22023", "inbound_environment_invalid");
  if (s.issued_on !== null && s.issued_on !== undefined && (typeof s.issued_on !== "string" || !DAY.test(s.issued_on))) raise("22023", "inbound_note_invalid");
  const cfops = Array.isArray(s.cfops) ? s.cfops : [];
  if (cfops.length > 990 || cfops.some((c: unknown) => typeof c !== "string" || !/^\d{4}$/.test(c))) raise("22023", "inbound_note_invalid");
  const name = text(s.emitter_name, 200);
  return {
    access_key: s.access_key, environment: s.environment,
    emitter_document: documentKey(text(s.emitter_document, 20)) || null, emitter_name: name ? name.slice(0, 200) : null,
    series: intOrNull(s.series, 999), number: intOrNull(s.number, 999999999), issued_on: s.issued_on ?? null,
    total_cents: intOrNull(s.total_cents, 9007199254740991), nature: text(s.nature, 120),
    cfops: [...new Set(cfops as string[])], purpose: classifyPurpose(String(s.finality ?? "1"), String(s.nature ?? ""), cfops as string[]),
    recipient_document: documentKey(text(s.recipient_document, 20)) || null,
  };
}
function xmlMeta(value: unknown) {
  const x = obj(value);
  if (typeof x.key !== "string" || x.key.length < 10 || x.key.length > 300 || typeof x.sha256 !== "string" || !HEX.test(x.sha256) ||
    !Number.isSafeInteger(x.size) || x.size < 1 || x.size > 1048576) raise("22023", "inbound_xml_invalid");
  return { key: x.key as string, sha256: x.sha256 as string, size: x.size as number };
}

/** Grava ou completa o índice de uma nota com o XML. */
function registerNote(ctx: RpcContext, user: string | null, source: "manual" | "cofre", s: NoteSummary, xml: { key: string; sha256: string; size: number }, receivedId: string | null) {
  const db = ctx.db, at = now(ctx);
  const existing = one(db, `SELECT * FROM "${NOTE}" WHERE access_key=?`, s.access_key);
  if (existing) {
    if (existing.environment !== s.environment) raise("40001", "inbound_environment_conflict");
    if (existing.xml_sha256 !== null && existing.xml_sha256 !== xml.sha256) raise("40001", "inbound_xml_conflict");
    if (existing.xml_sha256 === xml.sha256 && (receivedId === null || existing.received_id === receivedId)) return { id: String(existing.id), replayed: true };
    db.exec(
      `UPDATE "${NOTE}" SET received_id=coalesce(received_id, ?), emitter_document=coalesce(?, emitter_document), emitter_name=coalesce(?, emitter_name),
         series=coalesce(?, series), number=coalesce(?, number), issued_on=coalesce(?, issued_on), total_cents=coalesce(?, total_cents),
         nature=?, cfops=?, purpose=?, xml_key=?, xml_sha256=?, xml_size=?, version=version+1, updated_at=? WHERE id=?`,
      receivedId, s.emitter_document, s.emitter_name, s.series, s.number, s.issued_on, s.total_cents,
      s.nature, JSON.stringify(s.cfops), s.purpose, xml.key, xml.sha256, xml.size, at, existing.id,
    );
    return { id: String(existing.id), replayed: false };
  }
  const id = crypto.randomUUID();
  db.exec(
    `INSERT INTO "${NOTE}"(id, source, received_id, environment, access_key, role, emitter_document, emitter_name, series, number, issued_on, total_cents,
       situation, nature, cfops, purpose, xml_key, xml_sha256, xml_size, version, created_by, created_at, updated_at)
     VALUES(?,?,?,?,?,'destinatario',?,?,?,?,?,?,'autorizada',?,?,?,?,?,?,1,?,?,?)`,
    id, source, receivedId, s.environment, s.access_key, s.emitter_document, s.emitter_name, s.series, s.number, s.issued_on, s.total_cents,
    s.nature, JSON.stringify(s.cfops), s.purpose, xml.key, xml.sha256, xml.size, user, at, at,
  );
  return { id, replayed: false };
}

registerRpc("erp_inbound_register", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireRole(db, user, WRITE_ROLES);
  const p = input(a);
  const s = summary(p.note);
  const company = companyDocument(db);
  // A nota precisa ser para esta empresa: o destinatário é o CNPJ dos Dados da empresa.
  if (!company) raise("22023", "inbound_company_document_missing");
  if (s.recipient_document !== company) raise("22023", "inbound_not_for_company");
  const done = registerNote(ctx, user, "manual", s, xmlMeta(p.xml), null);
  return { ...noteDto(db, noteRow(db, done.id)), replayed: done.replayed };
});

// ---------------------------------------------------------------------------
// Busca no cofre: guarda de frequência e gravação do que veio

registerRpc("erp_inbound_fetch_claim", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireErpParts(ctx, erpRequirement("erp-compras", "erp-fiscal"));
  const role = requireRole(db, user, WRITE_ROLES);
  const p = input(a);
  if (!["producao", "homologacao"].includes(p.environment)) raise("22023", "inbound_environment_invalid");
  // Produção: só o administrador, com a autorização marcada nesta mesma busca.
  if (p.environment === "producao" && (role !== "admin" || p.production_authorized !== true)) raise("42501", "inbound_production_authorization_required");
  if (typeof p.vault_url !== "string" || !/^https:\/\/[^/]+$/.test(p.vault_url) || p.vault_url.length > 500) raise("22023", "inbound_vault_invalid");
  const connection = `recebidas:${p.environment}`, at = BigInt(now(ctx));
  const c = one(db, `SELECT vault_url, last_sequence, read_at FROM "${CURSOR}" WHERE connection=?`, connection);
  const wait = BigInt(INBOUND_FETCH_INTERVAL_SECONDS) * 1_000_000n;
  if (c && c.vault_url === p.vault_url && BigInt(String(c.read_at)) + wait > at)
    return { allowed: false, retry_at: micros(BigInt(String(c.read_at)) + wait), after: Number(c.last_sequence) };
  // Trocou o cofre: a sequência é do cofre, recomeça do zero.
  const after = c && c.vault_url === p.vault_url ? Number(c.last_sequence) : 0;
  if (c) db.exec(`UPDATE "${CURSOR}" SET vault_url=?, last_sequence=?, read_at=?, error=NULL, updated_at=? WHERE connection=?`, p.vault_url, after, at.toString(), at.toString(), connection);
  else db.exec(`INSERT INTO "${CURSOR}"(connection, vault_url, last_sequence, read_at, error, updated_at) VALUES(?,?,?,?,NULL,?)`, connection, p.vault_url, 0, at.toString(), at.toString());
  return { allowed: true, after };
});

const SITUATION: Record<string, string> = { authorized: "autorizada", cancelled: "cancelada", denied: "denegada" };
/**
 * Id da linha em erp_fiscal_vault__received (CHECK da versão 9: 'rcb_?*'):
 * sempre "rcb_" + o id do cofre, que o contrato não padroniza (o simulado usa
 * "rec_..."). O id do cofre volta tirando os 4 primeiros caracteres.
 */
export const receivedRowId = (providerRef: string) => `rcb_${providerRef}`;
export const providerRefOf = (receivedId: string) => receivedId.slice(4);
const ms = (iso: unknown, fallback: number) => {
  const v = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

registerRpc("erp_inbound_fetch_record", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireErpParts(ctx, erpRequirement("erp-compras", "erp-fiscal"));
  requireRole(db, user, WRITE_ROLES);
  const p = input(a);
  if (!["producao", "homologacao"].includes(p.environment)) raise("22023", "inbound_environment_invalid");
  const connection = `recebidas:${p.environment}`, at = Number(BigInt(now(ctx)) / 1000n);
  const cursor = one(db, `SELECT last_sequence FROM "${CURSOR}" WHERE connection=?`, connection);
  if (!cursor) raise("40001", "inbound_fetch_not_claimed");
  if (p.error) {
    const error = obj(p.error);
    db.exec(`UPDATE "${CURSOR}" SET error=?, updated_at=? WHERE connection=?`, JSON.stringify({ code: String(error.code ?? "erro"), message: String(error.message ?? "").slice(0, 500) }), now(ctx), connection);
    return { recorded: 0 };
  }
  const notes = Array.isArray(p.notes) ? p.notes : [];
  if (notes.length > 1000) raise("22023", "inbound_input_invalid");
  let created = 0, updated = 0, withXml = 0;
  for (const raw of notes) {
    const n = obj(raw);
    if (typeof n.provider_ref !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(n.provider_ref) || typeof n.access_key !== "string" || !KEY.test(n.access_key) ||
      n.environment !== p.environment || !Number.isSafeInteger(n.sequence) || n.sequence < 1) raise("22023", "inbound_note_invalid");
    const rid = receivedRowId(n.provider_ref);
    const role = n.role === "third_party" ? "terceiro" : "destinatario";
    const situation = SITUATION[String(n.status)] ?? null;
    const m = n.manifestation && n.manifestation.type ? n.manifestation : null;
    const issuer = obj(n.issuer);
    const total = typeof n.total === "number" && n.total >= 0 ? Math.round(n.total * 100) : null;
    const before = one(db, `SELECT * FROM "${RECEIVED}" WHERE id=?`, rid);
    const xml = n.xml ? xmlMeta(n.xml) : null;
    const values = [
      p.environment, documentKey(n.cnpj).slice(0, 14).padEnd(14, "0"), n.access_key, role, documentKey(issuer.document ?? null) || null,
      typeof issuer.name === "string" && issuer.name.trim() ? issuer.name.trim().slice(0, 200) : null, issuer.ie ?? null,
      Number.isSafeInteger(n.series) ? n.series : null, Number.isSafeInteger(n.number) ? n.number : null,
      typeof n.issued_at === "string" ? ms(n.issued_at, at) : null, typeof n.authorized_at === "string" ? ms(n.authorized_at, at) : null, n.protocol ?? null,
      n.operation === "entrada" || n.operation === "saida" ? n.operation : null, total, situation, n.xml_available === true ? 1 : 0,
      m ? String(m.type) : null, m ? Math.min(20, Math.max(1, Number(m.sequence ?? 1))) : null, m ? ms(m.registered_at, at) : null, m ? (m.origin ?? null) : null,
      n.automatic_acknowledgement_refused ? JSON.stringify(n.automatic_acknowledgement_refused) : null,
      n.sequence, ms(n.received_at, at), ms(n.updated_at, at),
      xml && n.xml_available === true ? xml.sha256 : before?.xml_sha256 ?? null,
    ];
    // Sequência já vista: o cofre não mudou a nota; só o XML que faltava pode chegar.
    const stale = !!before && Number(before.vault_sequence) >= n.sequence;
    if (stale) {
      // nada a atualizar no espelho do cofre
    } else if (before) {
      db.exec(
        `UPDATE "${RECEIVED}" SET environment=?, cnpj=?, access_key=?, role=?, emitter_document=?, emitter_name=?, emitter_ie=?, series=?, number=?, issued_at=?,
           authorized_at=?, protocol=?, operation_type=?, total=?, situation=?, xml_available=?, manifestation=?, manifestation_sequence=?, manifestation_at=?,
           manifestation_origin=?, auto_ack_refused=?, vault_sequence=?, vault_received_at=?, vault_updated_at=?, xml_sha256=?, synced_at=? WHERE id=?`,
        ...values, at, rid,
      );
      updated++;
    } else {
      db.exec(
        `INSERT INTO "${RECEIVED}"(environment, cnpj, access_key, role, emitter_document, emitter_name, emitter_ie, series, number, issued_at, authorized_at, protocol,
           operation_type, total, situation, xml_available, manifestation, manifestation_sequence, manifestation_at, manifestation_origin, auto_ack_refused,
           vault_sequence, vault_received_at, vault_updated_at, xml_sha256, first_seen_at, synced_at, id)
         VALUES(${values.map(() => "?").join(",")},?,?,?)`,
        ...values, at, at, rid,
      );
      created++;
    }
    if (!stale) {
    const kind = !before ? "nova" : situation === "cancelada" && before.situation !== "cancelada" ? "cancelada"
      : n.xml_available === true && Number(before.xml_available) !== 1 ? "xml" : (m?.type ?? null) !== (before.manifestation ?? null) ? "manifestada" : "outra";
    db.exec(`INSERT OR IGNORE INTO "${CHANGE}"(received_id, vault_sequence, kind, snapshot, recorded_at) VALUES(?,?,?,?,?)`,
      rid, n.sequence, kind, JSON.stringify({ status: n.status ?? null, xml_available: n.xml_available === true, manifestation: m?.type ?? null, total }), at);
    }
    // O índice de compra: toda nota do cofre aparece (com ou sem XML).
    const note = one(db, `SELECT * FROM "${NOTE}" WHERE access_key=? OR received_id=?`, n.access_key, rid);
    const issuedOn = typeof n.issued_at === "string" && DAY.test(n.issued_at.slice(0, 10)) ? n.issued_at.slice(0, 10) : null;
    if (xml && n.xml_available === true && n.summary) {
      const s = summary({ ...obj(n.summary), access_key: n.access_key, environment: p.environment });
      registerNote(ctx, user, "cofre", s, xml, rid);
      withXml++;
    } else if (!note) {
      const id = crypto.randomUUID(), t = now(ctx);
      db.exec(
        `INSERT INTO "${NOTE}"(id, source, received_id, environment, access_key, role, emitter_document, emitter_name, series, number, issued_on, total_cents,
           situation, cfops, version, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',1,?,?,?)`,
        id, "cofre", rid, p.environment, n.access_key, role, values[4], values[5], values[7], values[8], issuedOn, total, situation ?? "autorizada", user, t, t,
      );
    }
    const linked = one(db, `SELECT id, received_id FROM "${NOTE}" WHERE access_key=?`, n.access_key);
    if (linked) db.exec(`UPDATE "${NOTE}" SET received_id=coalesce(received_id, ?), role=?, situation=?, updated_at=? WHERE id=?`, rid, role, situation ?? "autorizada", now(ctx), linked.id);
  }
  const last = Number.isSafeInteger(p.last_sequence) ? Math.max(Number(cursor.last_sequence), p.last_sequence) : Number(cursor.last_sequence);
  db.exec(`UPDATE "${CURSOR}" SET last_sequence=?, error=NULL, updated_at=? WHERE connection=?`, last, now(ctx), connection);
  return { created, updated, with_xml: withXml, last_sequence: last };
});

// ---------------------------------------------------------------------------
// Conferência

interface ItemChoice { position: number; product_id?: string | null; factor?: string | null; lot?: { code: string; manufactured_on?: string | null; expires_on?: string | null } | null }
interface Choices {
  warehouse_id: string | null; order_id: string | null | undefined; stock: boolean | undefined; finance: boolean | undefined;
  icms_in_cost: boolean; category_id: string | null; payment_method_id: string | null; items: Map<number, ItemChoice>;
}
function choicesOf(value: unknown): Choices {
  const c = obj(value);
  const allowed = ["warehouse_id", "order_id", "stock", "finance", "icms_in_cost", "category_id", "payment_method_id", "items"];
  if (Object.keys(c).some((k) => !allowed.includes(k))) raise("22023", "inbound_choices_invalid");
  const uuid = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" && UUID.test(v) ? v : raise("22023", "inbound_choices_invalid"));
  const bool = (v: unknown) => (v === undefined ? undefined : typeof v === "boolean" ? v : raise("22023", "inbound_choices_invalid"));
  const items = new Map<number, ItemChoice>();
  for (const raw of Array.isArray(c.items) ? c.items : []) {
    const i = obj(raw);
    if (!Number.isSafeInteger(i.position) || i.position < 1 || i.position > 990 || items.has(i.position) ||
      Object.keys(i).some((k) => !["position", "product_id", "factor", "lot"].includes(k))) raise("22023", "inbound_choices_invalid");
    if (i.factor !== undefined && i.factor !== null && (typeof i.factor !== "string" || !/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/.test(i.factor) || scaled(i.factor, 6) === 0n))
      raise("22023", "inbound_factor_invalid");
    let lot: ItemChoice["lot"] = undefined;
    if (i.lot !== undefined && i.lot !== null) {
      const l = obj(i.lot);
      if (typeof l.code !== "string" || !l.code.trim() || l.code.length > 60 || [l.manufactured_on, l.expires_on].some((d) => d !== undefined && d !== null && (typeof d !== "string" || !DAY.test(d))))
        raise("22023", "inbound_lot_invalid");
      lot = { code: l.code.trim(), manufactured_on: l.manufactured_on ?? null, expires_on: l.expires_on ?? null };
    } else if (i.lot === null) lot = null;
    items.set(i.position, { position: i.position, product_id: i.product_id === undefined ? undefined : uuid(i.product_id), factor: i.factor ?? undefined, lot });
  }
  if (Array.isArray(c.items) && c.items.length > 990) raise("22023", "inbound_choices_invalid");
  return {
    warehouse_id: uuid(c.warehouse_id), order_id: c.order_id === undefined ? undefined : uuid(c.order_id), stock: bool(c.stock), finance: bool(c.finance),
    icms_in_cost: bool(c.icms_in_cost) ?? false, category_id: uuid(c.category_id), payment_method_id: uuid(c.payment_method_id), items,
  };
}

/** A nota lida pelo Worker confere com o índice (chave e SHA-256 do XML guardado). */
function checkedNote(db: SqlDriver, row: Row, sha: unknown, value: unknown): InboundNote {
  if (row.xml_sha256 === null) raise("40001", "inbound_xml_missing");
  if (sha !== row.xml_sha256) raise("40001", "inbound_xml_changed");
  const note = obj(value) as InboundNote;
  if (note.access_key !== row.access_key || !Array.isArray(note.items) || note.items.length < 1 || note.items.length > 990 || !obj(note.totals) ||
    !Array.isArray(note.duplicates) || !note.emitter) raise("22023", "inbound_note_invalid");
  for (const i of note.items)
    if (!Number.isSafeInteger(i.position) || typeof i.code !== "string" || typeof i.quantity !== "string" || scaled(i.quantity, 6) === null ||
      typeof i.unit_price !== "string" || !Number.isSafeInteger(i.total_cents) || typeof i.unit !== "string") raise("22023", "inbound_note_invalid");
  for (const d of note.duplicates) if (typeof d.due_on !== "string" || !DAY.test(d.due_on) || !Number.isSafeInteger(d.amount_cents)) raise("22023", "inbound_note_invalid");
  return note;
}

interface Product { id: string; name: string; code: string | null; unit: string | null; gtin: string | null; kind: string; format: string; lot_control: boolean; active: boolean }
function products(db: SqlDriver): Product[] {
  return db.exec(
    `SELECT r.id, r.name, r.code, r.active, p.unit, p.gtin, p.kind, p.format, coalesce(d.lot_control, 0) lot_control FROM "erp_catalog__record" r
       JOIN "erp_catalog__product" p ON p.record_id=r.id LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id WHERE r.entity='products'`,
  ).rows.map((r) => ({
    id: String(r.id), name: String(r.name), code: r.code === null ? null : String(r.code), unit: r.unit === null ? null : String(r.unit),
    gtin: r.gtin === null ? null : String(r.gtin), kind: String(r.kind), format: String(r.format), lot_control: Number(r.lot_control) === 1, active: Number(r.active) === 1,
  }));
}

const productView = (p: Product | undefined | null) => (p ? { id: p.id, name: p.name, code: p.code, unit: p.unit, lot_control: p.lot_control } : null);

function warehouses(db: SqlDriver) {
  const list = db.exec(`SELECT r.id, r.name FROM "erp_catalog__record" r WHERE r.entity='warehouses' AND r.active=1 ORDER BY r.name, r.id`).rows
    .map((r) => ({ id: String(r.id), name: String(r.name) }));
  const d = one(db, 'SELECT warehouse_id FROM "erp_stock__warehouse_default" LIMIT 1');
  return { list, default_id: d && list.some((w) => w.id === d.warehouse_id) ? String(d.warehouse_id) : list.length === 1 ? list[0].id : null };
}

function payableCategories(db: SqlDriver) {
  const list = db.exec(`SELECT id, name FROM "erp_finance__category" WHERE active=1 AND deleted_at IS NULL AND kind IN ('payable','both') ORDER BY name, id`).rows
    .map((r) => ({ id: String(r.id), name: String(r.name) }));
  const d = one(db, `SELECT category_id FROM "erp_finance__category_default" WHERE key='purchase'`);
  return { list, default_id: d && list.some((c) => c.id === d.category_id) ? String(d.category_id) : null };
}

function paymentMethods(db: SqlDriver) {
  return db.exec(`SELECT r.id, r.description FROM "erp_catalog__payment_method" r WHERE r.active=1 AND r.deleted_at IS NULL AND r.applicable IN ('ambos','pagamentos')
    ORDER BY r.description, r.id`).rows
    .map((r) => ({ id: String(r.id), name: String(r.description) }));
}

/** O que a pessoa pode fazer em cada parte. */
function capability(ctx: RpcContext, role: string) {
  return {
    stock: { part: ctx.parts.stock === true, role: STOCK_ROLES.includes(role) },
    finance: { part: ctx.parts.finance === true, role: FINANCE_ROLES.includes(role) },
    orders: ctx.parts.stock === true,
    fiscal: ctx.parts.fiscal === true,
  };
}

interface ReviewLine {
  position: number; code: string; gtin: string | null; description: string; unit: string; quantity: string; unit_price: string; total_cents: number; cfop: string;
  product: ReturnType<typeof productView>; matched_by: "supplier_code" | "gtin" | "code" | "choice" | null;
  suggestions: { id: string; name: string; code: string | null; unit: string | null; score: number }[];
  factor: string | null; factor_from: "same_unit" | "remembered" | "choice" | null; stock_quantity: string | null;
  lot: { code: string; manufactured_on: string | null; expires_on: string | null } | null; lot_from: "note" | "choice" | null;
  cost: LineCost | null; problems: string[];
}

function review(ctx: RpcContext, user: string, row: Row, note: InboundNote, choices: Choices) {
  const db = ctx.db;
  const role = requireRole(db, user, READ_ROLES);
  const can = capability(ctx, role);
  const supplier = supplierByDocument(db, note.emitter.document);
  const catalog = products(db);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const links = supplier
    ? new Map(db.exec(`SELECT record_id, code FROM "erp_catalog__product_supplier" WHERE supplier_id=? AND code IS NOT NULL`, supplier.id).rows.map((r) => [String(r.code), String(r.record_id)]))
    : new Map<string, string>();
  const usable = (p: Product | undefined) => !!p && p.active && p.kind === "P";
  const purpose = classifyPurpose(note.finality, note.nature, note.items.map((i) => i.cfop));
  const lines: ReviewLine[] = note.items.map((item) => {
    const choice = choices.items.get(item.position);
    let product: Product | undefined, matched: ReviewLine["matched_by"] = null;
    if (choice?.product_id) { product = byId.get(choice.product_id); matched = "choice"; }
    if (!product && choice?.product_id === undefined) {
      const linked = links.get(item.code);
      if (linked && usable(byId.get(linked))) { product = byId.get(linked); matched = "supplier_code"; }
      else if (item.gtin) {
        const hits = catalog.filter((p) => usable(p) && p.gtin === item.gtin);
        if (hits.length === 1) { product = hits[0]; matched = "gtin"; }
      }
    }
    const problems: string[] = [];
    if (choice?.product_id && !usable(product)) { problems.push("product_unavailable"); product = undefined; matched = null; }
    const suggestions = product ? [] : catalog.filter(usable).map((p) => ({ p, score: similarity(item.description, p.name) }))
      .filter((s) => s.score >= 0.2).sort((x, y) => y.score - x.score || x.p.name.localeCompare(y.p.name)).slice(0, 3)
      .map((s) => ({ id: s.p.id, name: s.p.name, code: s.p.code, unit: s.p.unit, score: Math.round(s.score * 100) / 100 }));
    let factor: string | null = null, from: ReviewLine["factor_from"] = null;
    if (product) {
      if (choice?.factor) { factor = choice.factor; from = "choice"; }
      else if (unitKey(item.unit) === unitKey(product.unit)) { factor = "1"; from = "same_unit"; }
      else if (supplier) {
        const k = one(db, 'SELECT CAST(factor AS TEXT) f FROM "erp_stock__unit_conversion" WHERE product_id=? AND supplier_id=? AND unit=?', product.id, supplier.id, unitKey(item.unit));
        if (k) { factor = unscaled(BigInt(String(k.f)), 6).replace(/\.?0+$/, ""); from = "remembered"; }
      }
      if (!factor) problems.push("factor_missing");
    } else problems.push("product_missing");
    const quantity = factor ? stockQuantity(item.quantity, factor) : null;
    if (factor && quantity === null) problems.push("quantity_decimals");
    const noteLot = item.lots[0] ?? null;
    let lot: ReviewLine["lot"] = null, lotFrom: ReviewLine["lot_from"] = null;
    if (choice?.lot) { lot = { code: choice.lot.code, manufactured_on: choice.lot.manufactured_on ?? null, expires_on: choice.lot.expires_on ?? null }; lotFrom = "choice"; }
    else if (choice?.lot === undefined && noteLot) { lot = { code: noteLot.code, manufactured_on: noteLot.manufactured_on, expires_on: noteLot.expires_on }; lotFrom = "note"; }
    if (product?.lot_control && !lot) problems.push("lot_missing");
    if (item.lots.length > 1 && product?.lot_control && lotFrom === "note") problems.push("lot_split");
    return {
      position: item.position, code: item.code, gtin: item.gtin, description: item.description, unit: item.unit, quantity: item.quantity,
      unit_price: item.unit_price, total_cents: item.total_cents, cfop: item.cfop, product: productView(product), matched_by: matched, suggestions,
      factor, factor_from: from, stock_quantity: quantity, lot: product?.lot_control ? lot : null, lot_from: product?.lot_control ? lotFrom : null, cost: null, problems,
    };
  });
  const decimalsPref = preferences.get(db, "empresa.decimais_preco_entrada");
  const decimals = typeof decimalsPref === "number" && Number.isInteger(decimalsPref) && decimalsPref >= 0 && decimalsPref <= 10 ? decimalsPref : 10;
  const costs = landedCosts(note, new Map(lines.filter((l) => l.stock_quantity).map((l) => [l.position, l.stock_quantity!])), { icms_in_cost: choices.icms_in_cost, decimals });
  lines.forEach((l, n) => { l.cost = l.stock_quantity ? costs[n] : null; });

  // Pedido de compra em aberto do fornecedor (com Estoque ligado: é o critério do recebimento).
  let orders: { id: string; number: string | null; date: string | null; total: string | null; referenced: boolean; received_before: boolean; has_payables: boolean }[] = [];
  let orderDiff: unknown = null;
  let orderId: string | null = null;
  if (supplier && can.orders) {
    const open = documents.openPurchaseOrders(db, supplier.id, ctx.parts);
    const refs = new Set(note.items.map((i) => (i.order_reference ?? "").replace(/^0+/, "")).filter(Boolean));
    orders = open.map((o) => ({
      id: o.id, number: o.number, date: o.date, total: o.total, referenced: o.number !== null && refs.has(o.number.replace(/^0+/, "")),
      received_before: !!one(db, `SELECT 1 x FROM "erp_purchase_receipts__receipt" r WHERE r.document_id=? AND NOT EXISTS(SELECT 1 FROM "erp_purchase_receipts__reversal" x WHERE x.receipt_id=r.id)`, o.id),
      has_payables: !!one(db, `SELECT 1 x FROM "erp_finance__document_posting" WHERE document_id=? AND state='active'`, o.id),
    }));
    orderId = choices.order_id !== undefined ? choices.order_id : orders.find((o) => o.referenced)?.id ?? (orders.length === 1 ? orders[0].id : null);
    if (orderId !== null && !orders.some((o) => o.id === orderId)) raise("22023", "inbound_order_unavailable");
    const order = open.find((o) => o.id === orderId);
    if (order) {
      const current = stock.purchaseReceiptCurrent(db, order.id) as { items: { item_id: string; product_id: string | null; remaining_quantity: string | null }[] };
      const remaining = new Map(current.items.map((i) => [String(i.item_id), i.remaining_quantity]));
      const used = new Set<string>();
      const rows = lines.map((l) => {
        const item = order.items.find((i) => i.product_id !== null && i.product_id === l.product?.id && !used.has(i.id));
        if (item) used.add(item.id);
        const left = item ? remaining.get(item.id) ?? item.quantity : null;
        const qtyDiff = item && l.stock_quantity && left !== null ? unscaled(scaled(l.stock_quantity, 6)! - scaled(String(left), 6)!, 6) : null;
        const price = l.cost?.unit_price ?? null;
        return {
          position: l.position, product_id: l.product?.id ?? null, order_item_id: item?.id ?? null,
          ordered_quantity: item?.quantity ?? null, remaining_quantity: left, note_quantity: l.stock_quantity,
          quantity_difference: qtyDiff, order_unit_price: item?.unit_price ?? null, note_unit_price: price,
          price_difference: item && price !== null ? Number(price) - Number(item.unit_price) : null,
          status: !item ? "not_in_order" : qtyDiff !== null && /^0\.0+$/.test(qtyDiff.replace("-", "")) && price !== null && Math.abs(Number(price) - Number(item.unit_price)) < 0.005 ? "same" : "different",
        };
      });
      orderDiff = {
        order: { id: order.id, number: order.number, date: order.date, total: order.total },
        lines: rows,
        missing: order.items.filter((i) => !used.has(i.id)).map((i) => ({ order_item_id: i.id, product_id: i.product_id, description: i.description, quantity: i.quantity, unit_price: i.unit_price })),
      };
    }
  }
  const chosenOrder = orders.find((o) => o.id === orderId) ?? null;

  const wh = warehouses(db);
  const warehouseId = choices.warehouse_id ?? wh.default_id;
  if (choices.warehouse_id && !wh.list.some((w) => w.id === choices.warehouse_id)) raise("22023", "inbound_warehouse_unavailable");
  const categories = payableCategories(db);
  if (choices.category_id && !categories.list.some((c) => c.id === choices.category_id)) raise("22023", "inbound_category_unavailable");
  const methods = paymentMethods(db);
  if (choices.payment_method_id && !methods.some((m) => m.id === choices.payment_method_id)) raise("22023", "inbound_payment_method_unavailable");
  const installments = payableInstallments(note);
  const installmentsTotal = installments.reduce((s, d) => s + d.amount_cents, 0);

  // O que se faz por padrão: compra e devolução e bonificação entram no estoque; só a compra gera contas a pagar.
  const stockDefault = (["compra", "devolucao", "bonificacao"] as InboundPurpose[]).includes(purpose) && !chosenOrder?.received_before;
  const financeDefault = purpose === "compra" && !chosenOrder?.has_payables;
  const wantStock = choices.stock ?? stockDefault, wantFinance = choices.finance ?? financeDefault;
  const warnings: string[] = [];
  if (row.situation === "cancelada") warnings.push("note_cancelled");
  if (row.situation === "denegada") warnings.push("note_denied");
  if (row.role === "terceiro") warnings.push("third_party");
  if (purpose !== "compra") warnings.push("not_purchase");
  if (chosenOrder?.received_before) warnings.push("order_received_before");
  if (chosenOrder?.has_payables) warnings.push("order_has_payables");
  if (installmentsTotal !== note.totals.total_cents) warnings.push("installments_differ_from_total");
  if (row.environment === "homologacao") warnings.push("homologation");
  const blockers: string[] = [];
  if (row.situation !== "autorizada") blockers.push("note_not_authorized");
  if (row.role === "terceiro") blockers.push("third_party");
  if (!supplier) blockers.push("supplier_missing");
  if (wantStock && can.stock.part && can.stock.role) {
    if (!warehouseId) blockers.push("warehouse_missing");
    if (lines.some((l) => l.problems.length)) blockers.push("items_pending");
  }
  if (wantFinance && can.finance.part && can.finance.role && !installments.length) blockers.push("installments_missing");
  if (!wantStock && !wantFinance) blockers.push("nothing_chosen");
  const entry = activeEntry(db, String(row.id));
  if (entry) blockers.push("already_entered");
  return {
    note: noteDto(db, row),
    header: {
      number: note.number, series: note.series, issued_on: note.issued_on, nature: note.nature, finality: note.finality,
      emitter: note.emitter, totals: note.totals, protocol: note.protocol, purpose, purpose_label: PURPOSE_LABEL[purpose],
    },
    supplier,
    supplier_proposal: supplier ? null : {
      name: note.emitter.name, trade_name: note.emitter.trade_name, document: note.emitter.document, ie: note.emitter.ie, phone: note.emitter.phone, address: note.emitter.address,
    },
    capability: can,
    role,
    lines,
    // Para casar o item com qualquer produto do cadastro (não só as sugestões).
    products: catalog.filter(usable).sort((x, y) => x.name.localeCompare(y.name, "pt-BR") || x.id.localeCompare(y.id)).slice(0, 3000)
      .map((p) => ({ id: p.id, name: p.name, code: p.code, unit: p.unit, lot_control: p.lot_control })),
    warehouses: wh.list,
    warehouse_id: warehouseId,
    orders,
    order_id: orderId,
    order_difference: orderDiff,
    finance: {
      installments, total_cents: installmentsTotal, categories: categories.list, category_id: choices.category_id ?? categories.default_id,
      payment_methods: methods, payment_method_id: choices.payment_method_id,
    },
    stock: wantStock, stock_default: stockDefault, finance_selected: wantFinance, finance_default: financeDefault, icms_in_cost: choices.icms_in_cost,
    warnings, blockers, entry: entryDto(entry),
  };
}

registerRpc("erp_inbound_review", (ctx: RpcContext, a: RpcArgs) => {
  const p = input(a);
  const row = noteRow(ctx.db, p.id);
  return review(ctx, a.p_user_id as string, row, checkedNote(ctx.db, row, p.xml_sha256, p.note), choicesOf(p.choices));
});

// ---------------------------------------------------------------------------
// Fornecedor a partir da nota

registerRpc("erp_inbound_supplier_create", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireRole(db, user, WRITE_ROLES);
  const p = input(a);
  if (typeof p.command_id !== "string" || !UUID.test(p.command_id)) raise("22023", "inbound_command_invalid");
  const row = noteRow(db, p.id);
  const note = checkedNote(db, row, p.xml_sha256, p.note);
  const found = supplierByDocument(db, note.emitter.document);
  if (found) return { supplier: found, created: false };
  const e = note.emitter, addr = e.address ?? ({} as InboundNote["emitter"]["address"]);
  const cut = (v: string | null | undefined, n: number) => (v ? v.slice(0, n) : undefined);
  const data: Record<string, unknown> = {
    name: e.name.slice(0, 120), person_type: documentKey(e.document).length === 11 ? "F" : "J", document: e.document, roles: ["supplier"],
  };
  for (const [k, v] of Object.entries({
    trade_name: cut(e.trade_name, 120), ie: cut(e.ie, 30), phone: cut(e.phone, 40), postal_code: cut(addr.zip, 10), street: cut(addr.street, 120),
    number: cut(addr.number, 10), complement: cut(addr.complement, 100), district: cut(addr.district, 60), city: cut(addr.city, 60), state: cut(addr.uf, 2),
  })) if (v) data[k] = v;
  const saved = invokeRpc(ctx, "erp_catalog_contact_save", {
    p_user_id: user, p_id: null, p_expected_version: 0, p_command_id: p.command_id, p_data: data, p_acknowledged: null,
  }) as { record: { id: string; name: string; code?: string | null } };
  return { supplier: { id: saved.record.id, name: saved.record.name, code: saved.record.code ?? null }, created: true };
});

// ---------------------------------------------------------------------------
// Entrada

const balanceVersion = (db: SqlDriver, product: string, warehouse: string) =>
  Number(one(db, 'SELECT version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse)?.version ?? 0);

/** Lembra "código do fornecedor → produto" no cadastro do produto (erp_catalog.product_supplier). */
function rememberSupplierCode(db: SqlDriver, product: string, supplier: string, code: string, description: string) {
  if (code.length > 60) return;
  const existing = one(db, 'SELECT position, code FROM "erp_catalog__product_supplier" WHERE record_id=? AND supplier_id=?', product, supplier);
  // Outro produto com o mesmo código deste fornecedor: o vínculo novo vence (a pessoa acabou de confirmar).
  db.exec('UPDATE "erp_catalog__product_supplier" SET code=NULL WHERE supplier_id=? AND code=? AND record_id<>?', supplier, code, product);
  if (existing) {
    if (existing.code !== code) db.exec('UPDATE "erp_catalog__product_supplier" SET code=? WHERE record_id=? AND supplier_id=?', code, product, supplier);
    return;
  }
  const next = Number(one(db, 'SELECT coalesce(max(position),0)+1 n FROM "erp_catalog__product_supplier" WHERE record_id=?', product)!.n);
  if (next > 20) return;
  db.exec('INSERT INTO "erp_catalog__product_supplier"(record_id, position, supplier_id, description, code, is_default) VALUES(?,?,?,?,?,0)',
    product, next, supplier, description.slice(0, 120), code);
}

/** Lembra a conversão de unidade do fornecedor (erp_stock.unit_conversion). */
function rememberFactor(ctx: RpcContext, user: string, command: string, product: string, supplier: string, unit: string, factor: string) {
  const db = ctx.db, key = unitKey(unit), value = scaled(factor, 6)!;
  if (!key || key.length > 6) return;
  const k = one(db, 'SELECT CAST(factor AS TEXT) f FROM "erp_stock__unit_conversion" WHERE product_id=? AND supplier_id=? AND unit=?', product, supplier, key);
  if (k && BigInt(String(k.f)) === value) return;
  if (k) db.exec('UPDATE "erp_stock__unit_conversion" SET factor=?, version=version+1, updated_at=?, updated_by=?, command_id=? WHERE product_id=? AND supplier_id=? AND unit=?',
    value.toString(), now(ctx), user, command, product, supplier, key);
  else db.exec('INSERT INTO "erp_stock__unit_conversion"(product_id, supplier_id, unit, factor, version, updated_at, updated_by, command_id) VALUES(?,?,?,?,1,?,?,?)',
    product, supplier, key, value.toString(), now(ctx), user, command);
}

registerRpc("erp_inbound_enter", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  const role = requireRole(db, user, WRITE_ROLES);
  const p = input(a);
  if (typeof p.command_id !== "string" || !UUID.test(p.command_id)) raise("22023", "inbound_command_invalid");
  const command = p.command_id as string;
  // O mesmo comando: o recibo, sem nada novo.
  const receipt = one(db, `SELECT * FROM "${ENTRY}" WHERE command_id=?`, command);
  if (receipt) {
    if (receipt.note_id !== p.id || receipt.actor !== user) raise("40001", "inbound_command_conflict");
    return { entry: entryDto(receipt), note: noteDto(db, noteRow(db, receipt.note_id)), replayed: true };
  }
  const row = noteRow(db, p.id);
  // Nota já lançada por outro comando: devolve a entrada que existe (não duplica).
  const existing = activeEntry(db, String(row.id));
  if (existing) return { entry: entryDto(existing), note: noteDto(db, row), replayed: true, already_entered: true };
  const note = checkedNote(db, row, p.xml_sha256, p.note);
  const choices = choicesOf(p.choices);
  const r = review(ctx, user, row, note, choices);
  if (r.blockers.length) raise("22023", `inbound_blocked:${r.blockers.join(",")}`);
  const supplier = r.supplier!;
  const day = todaySaoPaulo();
  const label = `NF-e ${note.number}${note.series ? `/${note.series}` : ""} de ${note.emitter.name}`.slice(0, 200);
  const result: Record<string, any> = { stock: null, finance: null, links: { supplier_codes: 0, unit_factors: 0 } };

  // Vínculos e conversões confirmados ficam para a próxima nota (mesmo sem lançar estoque).
  for (const l of r.lines) {
    if (!l.product) continue;
    if (l.matched_by !== "supplier_code") { rememberSupplierCode(db, l.product.id, supplier.id, l.code, l.description); result.links.supplier_codes++; }
    if (l.factor && l.factor_from === "choice") { rememberFactor(ctx, user, subCommand(command, `factor:${l.position}`), l.product.id, supplier.id, l.unit, l.factor); result.links.unit_factors++; }
  }

  // Estoque: um lançamento de entrada por item, com preço e custo de entrada (a rotina da tela de Lançamentos).
  let stockStatus = "not_chosen";
  const movements: string[] = [];
  if (r.stock) {
    if (!r.capability.stock.part) stockStatus = "part_disabled";
    else if (!r.capability.stock.role) stockStatus = "role_missing";
    else {
      const items: unknown[] = [];
      for (const l of r.lines) {
        const product = l.product!, warehouse = r.warehouse_id!;
        const base = {
          p_user_id: user, p_command_id: subCommand(command, `stock:${l.position}`), p_kind: "receipt", p_product_id: product.id, p_warehouse_id: warehouse,
          p_quantity: l.stock_quantity!, p_expected_version: balanceVersion(db, product.id, warehouse), p_unit_price: l.cost!.unit_price, p_unit_cost: l.cost!.unit_cost,
          p_note: `Entrada pela ${label}, item ${l.position}`.slice(0, 500), p_destination_id: null, p_destination_version: null,
        };
        let launched: Record<string, any>;
        if (l.lot) {
          const lots = db.exec('SELECT id, code FROM "erp_stock__lot" WHERE product_id=?', product.id).rows;
          const same = lots.find((x) => String(x.code).trim().toLowerCase() === l.lot!.code.toLowerCase());
          const lot = same ? { lot_id: String(same.id) } : { code: l.lot.code, manufactured_on: l.lot.manufactured_on, expires_on: l.lot.expires_on };
          launched = invokeRpc(ctx, "erp_stock_lot_launch", { ...base, p_lot: lot }) as Record<string, any>;
        } else launched = invokeRpc(ctx, "erp_stock_launch", base) as Record<string, any>;
        const movement = String(launched.movement.id);
        movements.push(movement);
        items.push({ position: l.position, movement_id: movement, product_id: product.id, warehouse_id: warehouse, quantity: l.stock_quantity, unit_price: l.cost!.unit_price,
          unit_cost: l.cost!.unit_cost, lot: l.lot ? { code: l.lot.code, id: launched.lot?.id ?? null } : null });
      }
      stockStatus = items.length ? "done" : "nothing";
      result.stock = { warehouse_id: r.warehouse_id, items };
    }
  }

  // Contas a pagar: as duplicatas da nota, com forma de pagamento e categoria escolhidas (a rotina da tela de Contas a pagar).
  let financeStatus = "not_chosen";
  let titles: string[] = [];
  if (r.finance_selected) {
    if (!r.capability.finance.part) financeStatus = "part_disabled";
    else if (!r.capability.finance.role) financeStatus = "role_missing";
    else if (!r.finance.installments.length) financeStatus = "nothing";
    else {
      const parts = r.finance.installments;
      const issued = [note.issued_on, ...parts.map((d) => d.due_on)].sort()[0];
      const created = invokeRpc(ctx, "erp_finance_title_execute", {
        p_user_id: user, p_command_id: subCommand(command, "finance"), p_action: "title_create",
        p_data: {
          kind: "payable", contact_id: supplier.id, category_id: r.finance.category_id, payment_method_id: r.finance.payment_method_id,
          description: label.slice(0, 240), source_reference: `NF-e ${note.access_key}`, issued_on: issued, competence_on: note.issued_on,
          total_cents: String(r.finance.total_cents), installments: parts.map((d) => ({ amount_cents: String(d.amount_cents), due_on: d.due_on })),
        },
      }) as { items: { id: string }[]; group_id: string };
      titles = created.items.map((t) => String(t.id));
      financeStatus = "done";
      result.finance = { group_id: created.group_id, title_ids: titles, installments: parts, category_id: r.finance.category_id, payment_method_id: r.finance.payment_method_id };
    }
  }
  if (stockStatus !== "done" && financeStatus !== "done") raise("22023", `inbound_nothing_done:${stockStatus},${financeStatus}`);
  const id = crypto.randomUUID();
  const snapshot = {
    purpose: r.header.purpose, order_id: r.order_id, warehouse_id: r.warehouse_id, icms_in_cost: r.icms_in_cost,
    lines: r.lines.map((l) => ({ position: l.position, code: l.code, product_id: l.product?.id ?? null, factor: l.factor, stock_quantity: l.stock_quantity, cost: l.cost, lot: l.lot })),
    order_difference: r.order_difference, role,
  };
  db.exec(
    `INSERT INTO "${ENTRY}"(id, note_id, command_id, state, supplier_id, order_id, stock_status, finance_status, movement_ids, title_ids, snapshot, result, actor, via, created_at)
     VALUES(?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?)`,
    id, row.id, command, supplier.id, r.order_id, stockStatus, financeStatus, JSON.stringify(movements), JSON.stringify(titles),
    JSON.stringify(snapshot), JSON.stringify({ ...result, day }), user, typeof p.via === "string" ? p.via.slice(0, 100) : null, now(ctx),
  );
  return { entry: entryDto(one(db, `SELECT * FROM "${ENTRY}" WHERE id=?`, id)), note: noteDto(db, row), replayed: false };
});

// ---------------------------------------------------------------------------
// Estorno

registerRpc("erp_inbound_reverse", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  const role = requireRole(db, user, WRITE_ROLES);
  const p = input(a);
  if (typeof p.command_id !== "string" || !UUID.test(p.command_id)) raise("22023", "inbound_command_invalid");
  const command = p.command_id as string;
  const repeated = one(db, `SELECT * FROM "${ENTRY}" WHERE reversal_command_id=?`, command);
  if (repeated) {
    if (repeated.note_id !== p.id || repeated.reversed_by !== user) raise("40001", "inbound_command_conflict");
    return { entry: entryDto(repeated), note: noteDto(db, noteRow(db, repeated.note_id)), replayed: true };
  }
  const reason = typeof p.reason === "string" ? p.reason.trim() : "";
  if ([...reason].length < 3 || [...reason].length > 500) raise("22023", "inbound_reason_required");
  const row = noteRow(db, p.id);
  const entry = activeEntry(db, String(row.id));
  if (!entry) raise("P0002", "inbound_entry_not_found");
  const movements = parse(entry.movement_ids) as string[], titles = parse(entry.title_ids) as string[];
  // Cada parte desfaz pela rotina dela; parte desligada ou sem papel trava o estorno inteiro (nada fica pela metade).
  if (movements.length) {
    if (!ctx.parts.stock) raise("22023", "inbound_reverse_stock_part_disabled");
    if (!STOCK_ROLES.includes(role)) raise("42501", "inbound_reverse_stock_role");
  }
  if (titles.length) {
    if (!ctx.parts.finance) raise("22023", "inbound_reverse_finance_part_disabled");
    if (!FINANCE_ROLES.includes(role)) raise("42501", "inbound_reverse_finance_role");
  }
  const day = todaySaoPaulo();
  const undone: Record<string, any> = { movements: [], titles: [] };
  // Contas primeiro: título com pagamento ou em cobrança no banco recusa pela guarda do Financeiro (title_cancel).
  titles.forEach((id, n) => {
    const t = one(db, 'SELECT version, cancelled FROM "erp_finance__title" WHERE id=?', id);
    if (!t) raise("P0002", "inbound_title_not_found");
    if (Number(t.cancelled) === 1) { undone.titles.push({ id, already: true }); return; }
    invokeRpc(ctx, "erp_finance_execute", {
      p_user_id: user, p_command_id: subCommand(command, `title:${n}`), p_action: "title_cancel",
      p_data: { id, expected_version: Number(t.version), note: `Estorno da entrada da nota: ${reason}`.slice(0, 500) },
    });
    undone.titles.push({ id, already: false });
  });
  // Estoque: o estorno do lançamento (com o lote), com as compensações do balanço da rotina do Estoque.
  movements.forEach((movement, n) => {
    if (one(db, 'SELECT 1 x FROM "erp_stock__movement" WHERE reverses_id=?', movement)) { undone.movements.push({ id: movement, already: true }); return; }
    const versions = db.exec('SELECT product_id, warehouse_id FROM "erp_stock__entry" WHERE movement_id=? ORDER BY ordinal', movement).rows
      .map((e) => ({ product_id: e.product_id, warehouse_id: e.warehouse_id, expected_version: balanceVersion(db, String(e.product_id), String(e.warehouse_id)) }));
    const reversed = invokeRpc(ctx, "erp_stock_reverse", {
      p_user_id: user, p_movement_id: movement, p_command_id: subCommand(command, `stock:${n}`), p_occurred_on: day,
      p_reason: `Estorno da entrada da nota: ${reason}`.slice(0, 500), p_versions: versions,
    }) as Record<string, any>;
    undone.movements.push({ id: movement, already: false, reversal_id: reversed.movement?.id ?? null });
  });
  db.exec(
    `UPDATE "${ENTRY}" SET state='reversed', reversed_at=?, reversed_by=?, reversal_reason=?, reversal_command_id=?, reversal=? WHERE id=?`,
    now(ctx), user, reason, command, JSON.stringify({ ...undone, day }), entry.id,
  );
  return { entry: entryDto(one(db, `SELECT * FROM "${ENTRY}" WHERE id=?`, entry.id)), note: noteDto(db, row), replayed: false };
});

// ---------------------------------------------------------------------------
// Interruptor da manifestação (administrador)

registerRpc("erp_inbound_settings_get", (ctx: RpcContext, a: RpcArgs) => {
  requireRole(ctx.db, a.p_user_id, READ_ROLES);
  return settingsRow(ctx.db);
});

registerRpc("erp_inbound_settings_save", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireRole(db, user, ["admin"]);
  const p = input(a);
  if (typeof p.manifest_enabled !== "boolean" || !Number.isSafeInteger(p.expected_version) || p.expected_version < 0) raise("22023", "inbound_settings_invalid");
  // Ligar exige a ciência de que manifestar é ato fiscal perante a SEFAZ.
  if (p.manifest_enabled && p.acknowledge_fiscal_act !== true) raise("22023", "inbound_fiscal_act_acknowledgement_required");
  const current = settingsRow(db);
  if (current.version !== p.expected_version) raise("40001", "inbound_settings_version_conflict");
  if (current.version === 0)
    db.exec(`INSERT INTO "${SETTINGS}"(id, version, manifest_enabled, updated_at, updated_by) VALUES(1,1,?,?,?)`, p.manifest_enabled ? 1 : 0, now(ctx), user);
  else db.exec(`UPDATE "${SETTINGS}" SET manifest_enabled=?, version=version+1, updated_at=?, updated_by=? WHERE id=1`, p.manifest_enabled ? 1 : 0, now(ctx), user);
  return settingsRow(db);
});

// ---------------------------------------------------------------------------
// Manifestação do destinatário: o pedido é gravado antes de ir ao cofre;
// resultado incerto nunca é reenviado sem consultar e sem a pessoa confirmar.

const MANIFEST_TYPES = ["ciencia", "confirmacao", "desconhecimento", "nao_realizada"];

registerRpc("erp_inbound_manifest_claim", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireErpParts(ctx, erpRequirement("erp-compras", "erp-fiscal"));
  const role = requireRole(db, user, MANIFEST_ROLES);
  const p = input(a);
  if (!settingsRow(db).manifest_enabled) raise("42501", "inbound_manifest_disabled");
  if (typeof p.command_id !== "string" || !UUID.test(p.command_id)) raise("22023", "inbound_command_invalid");
  if (!MANIFEST_TYPES.includes(p.type)) raise("22023", "inbound_manifest_type_invalid");
  const justification = typeof p.justification === "string" ? p.justification.trim() : null;
  if (p.type === "nao_realizada" && (!justification || [...justification].length < 15 || [...justification].length > 255)) raise("22023", "inbound_justification_required");
  const row = noteRow(db, p.id);
  if (!row.received_id) raise("22023", "inbound_manifest_not_from_vault");
  if (row.environment === "producao" && (role !== "admin" || p.production_authorized !== true)) raise("42501", "inbound_production_authorization_required");
  const same = one(db, `SELECT * FROM "${EVENT}" WHERE command_id=?`, p.command_id);
  if (same) {
    if (same.received_id !== row.received_id || same.manifestation !== p.type || same.requested_by !== user) raise("40001", "inbound_command_conflict");
    return { event_id: String(same.id), state: String(same.state), received_id: String(row.received_id), provider_ref: providerRefOf(String(row.received_id)), environment: String(row.environment), replayed: true };
  }
  const open = one(db, `SELECT * FROM "${EVENT}" WHERE received_id=? AND kind='manifestacao' AND state IN ('pedido','incerto') ORDER BY created_at DESC LIMIT 1`, row.received_id);
  if (open) {
    // Outro pedido em aberto: a pessoa consulta antes. Reenviar só o mesmo tipo, com a confirmação explícita depois da consulta.
    if (open.manifestation !== p.type) raise("40001", "inbound_manifest_pending_other");
    if (p.resend !== true) return { event_id: String(open.id), state: String(open.state), received_id: String(row.received_id), provider_ref: providerRefOf(String(row.received_id)), environment: String(row.environment), consult_first: true };
    db.exec(`UPDATE "${EVENT}" SET state='pedido', updated_at=? WHERE id=?`, now(ctx), open.id);
    return { event_id: String(open.id), state: "pedido", received_id: String(row.received_id), provider_ref: providerRefOf(String(row.received_id)), environment: String(row.environment), resend: true };
  }
  const done = Number(one(db, `SELECT count(*) n FROM "${EVENT}" WHERE received_id=? AND kind='manifestacao' AND manifestation=? AND state='registrado'`, row.received_id, p.type)!.n);
  const id = crypto.randomUUID(), body = { tipo: p.type, ...(justification && p.type === "nao_realizada" ? { justificativa: justification } : {}) };
  db.exec(
    `INSERT INTO "${EVENT}"(id, kind, received_id, manifestation, environment, sequence, text, reference, body, body_hash, state, command_id, requested_by, via, created_at, updated_at)
     VALUES(?,'manifestacao',?,?,?,?,?,?,?,?,'pedido',?,?,?,?,?)`,
    id, row.received_id, p.type, row.environment, Math.min(20, done + 1), p.type === "nao_realizada" ? justification : null,
    `wb.mnf.${row.received_id}.${p.type}.${done + 1}.${p.command_id.slice(0, 8)}`, JSON.stringify(body), sha256(JSON.stringify(body)), p.command_id, user,
    typeof p.via === "string" ? p.via.slice(0, 100) : null, now(ctx), now(ctx),
  );
  return { event_id: id, state: "pedido", received_id: String(row.received_id), provider_ref: providerRefOf(String(row.received_id)), environment: String(row.environment), justification: p.type === "nao_realizada" ? justification : null };
});

registerRpc("erp_inbound_manifest_record", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db, user = a.p_user_id as string;
  requireRole(db, user, MANIFEST_ROLES);
  const p = input(a);
  const ev = typeof p.event_id === "string" ? one(db, `SELECT * FROM "${EVENT}" WHERE id=? AND kind='manifestacao'`, p.event_id) : null;
  if (!ev) raise("P0002", "inbound_manifest_not_found");
  if (!["registrado", "recusado", "incerto"].includes(p.state)) raise("22023", "inbound_manifest_state_invalid");
  if (ev.state === "registrado") return { state: "registrado", replayed: true };
  const messages = Array.isArray(p.messages) ? p.messages.slice(0, 20).map((m: unknown) => ({ code: String(obj(m).code ?? ""), description: String(obj(m).description ?? "").slice(0, 500) })) : [];
  const registered = p.state === "registrado" ? ms(p.registered_at, Date.now()) * 1000 : null;
  db.exec(`UPDATE "${EVENT}" SET state=?, protocol=?, registered_at=?, repeated=?, messages=?, updated_at=? WHERE id=?`,
    p.state, typeof p.protocol === "string" ? p.protocol.slice(0, 60) : null, registered, p.repeated === true ? 1 : 0, JSON.stringify(messages), now(ctx), ev.id);
  if (p.state === "registrado") {
    const at = Math.round(ms(p.registered_at, Date.now()));
    db.exec(`UPDATE "${RECEIVED}" SET manifestation=?, manifestation_sequence=?, manifestation_at=?, manifestation_origin=coalesce(manifestation_origin,'manual'),
      xml_available=CASE WHEN ?=1 THEN 1 ELSE xml_available END, synced_at=? WHERE id=?`,
      ev.manifestation, Math.min(20, Math.max(1, Number(p.sequence ?? ev.sequence))), at, p.xml_available === true ? 1 : 0, at, ev.received_id);
  }
  return { state: p.state, replayed: false };
});

export const INBOUND_RPCS = [
  "erp_inbound_list", "erp_inbound_get", "erp_inbound_register", "erp_inbound_fetch_claim", "erp_inbound_fetch_record", "erp_inbound_review",
  "erp_inbound_supplier_create", "erp_inbound_enter", "erp_inbound_reverse", "erp_inbound_settings_get", "erp_inbound_settings_save",
  "erp_inbound_manifest_claim", "erp_inbound_manifest_record",
] as const;
