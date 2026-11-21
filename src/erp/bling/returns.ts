/** Volta ao Bling do pedido que veio de lá (tabelas da versão 32).
 *
 * Para quem vende no marketplace pelo Bling: o pedido nasce no Bling, é
 * atendido aqui, e o Bling precisa saber da nota, da situação e do rastreio.
 * Só pedidos de venda ligados a um pedido do Bling (adoção ou mão dupla).
 *
 * - Nota (interruptor "invoice"): a NF-e autorizada aqui (cofre fiscal do
 *   pedido, só leitura) vai escrita nas observações internas do pedido no
 *   Bling: chave, número e série. A API v3 não aceita importar uma NF-e
 *   emitida fora; o limite é dito na tela.
 * - Situação e rastreio (interruptor "status"): a etapa do pedido aqui
 *   (separado, faturado, enviado, entregue, cancelado; Expedição e cofre
 *   fiscal, só leitura) vira a situação escolhida pelo dono para cada etapa
 *   (PATCH /pedidos/vendas/{id}/situacoes/{idSituacao}); o código de rastreio
 *   da Expedição vai para o volume do pedido no Bling (e para as observações).
 *
 * Fila de saída da mão dupla, com as mesmas regras: id estável (tipo, pedido e
 * impressão do que vai), uma chamada HTTP por acordada dentro do limite da
 * conta (takeCall), resposta incerta nunca repetida às cegas (conferência por
 * GET antes de reenviar), recusa vira pendência com o motivo em palavras
 * (wb_bling_twoway_issue, chave ret:). Nota e rastreio leem o pedido no Bling
 * antes de gravar (passo "read") e só gravam o que ainda não está lá. */
import type { Row, SqlDriver } from "../engine/driver.ts";
import { ERP_PART_MODULES, ERP_PART_NAMES, type ErpParts } from "../parts.ts";
import type { BlingContext } from "./contracts.ts";
import { BlingAdoptionError } from "./adoption-contracts.ts";
import { command, type AdoptionCall } from "./adoption.ts";
import { adoptionTables, archiveAvailable, clip, commandUuid, type Json } from "./adoption-store.ts";
import {
  BLING_RETURN_KINDS, BLING_RETURN_STAGES, BLING_RETURN_STAGE_LABELS, BLING_RETURN_TEXTS, BLING_TWO_WAY_TEXTS,
  type BlingReturnKind, type BlingReturnStage, type BlingReturnsStatus, type BlingTwoWayOperationMap,
} from "./two-way-contracts.ts";
import { dataOf, twoWayHash } from "./two-way-map.ts";
import { takeCall } from "./two-way.ts";
import type { BlingWritePort } from "./writer.ts";
import { blingScopeChecklist } from "./account.ts";
import { cutoverConfirmed, returnSettings, returnsLocalDue, returnsOutboxDue, returnsTables, type ReturnSetting } from "./returns-store.ts";

type Map_<K extends keyof BlingTwoWayOperationMap> = BlingTwoWayOperationMap[K];
export type BlingReturnItemKind = "invoice" | "status" | "tracking";
const one = (db: SqlDriver, sql: string, ...params: unknown[]): Row | undefined => db.exec(sql, ...params).rows[0];
const parse = (value: unknown): Json => { try { const v = JSON.parse(String(value ?? "{}")); return v && typeof v === "object" && !Array.isArray(v) ? v as Json : {}; } catch { return {}; } };
const iso = (v: unknown) => v === null || v === undefined ? null : new Date(Number(v)).toISOString();
const object = (v: unknown): Json | null => v && typeof v === "object" && !Array.isArray(v) ? v as Json : null;
/** Limites da unidade local e da conferência. */
export const RETURNS_UNIT = Object.freeze({ orders: 40, wall_ms: 1500, idle_ms: 60_000, verify_limit: 6 });
/** A volta ao Bling usa a mão dupla da entidade pedidos de venda. */
const ENTITY = "sales_orders";

// ---------------------------------------------------------------------------
// Tabelas, interruptores e partes

export { returnsTables, returnSettings, returnsLocalDue, returnsOutboxDue, type ReturnSetting };
const switchOf = (kind: BlingReturnItemKind): BlingReturnKind => kind === "invoice" ? "invoice" : "status";
/** Partes de que a volta depende: Vendas e Produtos (o pedido); a nota também o Fiscal. */
export function returnsPartsOn(kind: BlingReturnKind, parts: Readonly<ErpParts> | null | undefined): boolean {
  if (kind === "webhook") return !!parts?.customers;
  return !!parts?.customers && !!parts.sales && !!parts.products && (kind !== "invoice" || !!parts.fiscal);
}
export function returnsPartOffMessage(kind: BlingReturnKind, parts: Readonly<ErpParts> | null | undefined): string | null {
  if (returnsPartsOn(kind, parts)) return null;
  const keys = (["customers", "sales", "products", ...(kind === "invoice" ? ["fiscal"] : [])] as const).filter(key => !parts?.[key as keyof ErpParts]);
  const names = [...new Set(keys.map(key => ERP_PART_NAMES[ERP_PART_MODULES[key as keyof typeof ERP_PART_MODULES]]))];
  const spoken = names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : names[0];
  return `Para devolver ${kind === "invoice" ? "a nota" : "a situação e o rastreio"} ao Bling, ligue ${names.length > 1 ? "os módulos" : "o módulo"} ${spoken} em Gestão → Módulos.`;
}

// ---------------------------------------------------------------------------
// O pedido aqui: nota, etapa e rastreio (leitura da NF-e e da Expedição)

export interface OrderFacts {
  number: string | null; source: string;
  invoice: { access_key: string; number: string; series: string; at: number } | null;
  stage: BlingReturnStage | null; stage_at: number;
  tracking: { code: string; at: number } | null;
}
const int = (v: unknown) => v === null || v === undefined || v === "" ? 0 : Number(v);
/** Id do pedido no Bling: vínculo da adoção ou criado pela mão dupla. */
export function orderSource(db: SqlDriver, record: string): string | null {
  const linked = one(db, `SELECT source_id FROM ${adoptionTables(ENTITY).link} WHERE entity=? AND record_id=?`, ENTITY, record);
  if (linked) return String(linked.source_id);
  const created = one(db, "SELECT source_id FROM wb_bling_twoway_state WHERE entity=? AND record_id=? AND source_id IS NOT NULL", ENTITY, record);
  return created ? String(created.source_id) : null;
}
export function orderFacts(db: SqlDriver, record: string): OrderFacts | null {
  const doc = one(db, "SELECT id, kind, number, status, CAST(updated_at AS INTEGER) AS updated_at FROM erp_documents__document WHERE id=?", record);
  if (!doc || doc.kind !== ENTITY) return null;
  const source = orderSource(db, record);
  if (!source) return null;
  const ship = one(db, "SELECT status, tracking_code, CAST(delivery_at AS INTEGER) AS delivery_at, CAST(updated_at AS INTEGER) AS updated_at FROM erp_shipping__order WHERE document_id=?", record);
  const em = one(db, "SELECT status, access_key, number, series, CAST(authorized_at AS INTEGER) AS authorized_at FROM erp_fiscal_vault__order_emission WHERE document_id=? ORDER BY fiscal_version DESC LIMIT 1", record);
  const authorized = em?.status === "autorizada" && typeof em.access_key === "string" && em.number != null && em.series != null;
  const status = String(doc.status);
  const stage: BlingReturnStage | null = status === "cancelled" ? "cancelled"
    : ship && int(ship.delivery_at) > 0 ? "delivered"
    : ship?.status === "shipped" ? "shipped"
    : authorized || status === "invoiced" ? "invoiced"
    : ship && (ship.status === "picked" || ship.status === "packed") ? "separated" : null;
  const code = typeof ship?.tracking_code === "string" && ship.tracking_code.trim() ? ship.tracking_code.trim() : null;
  return {
    number: doc.number == null ? null : String(doc.number), source,
    invoice: authorized ? { access_key: String(em!.access_key), number: String(em!.number), series: String(em!.series), at: int(em!.authorized_at) } : null,
    stage, stage_at: Math.max(int(doc.updated_at), int(ship?.updated_at), authorized ? int(em!.authorized_at) : 0),
    tracking: code ? { code, at: int(ship!.updated_at) } : null,
  };
}
const orderLabel = (facts: OrderFacts) => clip(`Pedido ${facts.number ?? "sem número"} (id ${facts.source} no Bling)`, 200)!;

// ---------------------------------------------------------------------------
// Fila

interface ReturnItem { id: string; kind: BlingReturnItemKind; record_id: string; source_id: string; fingerprint: string; state: string; step: "read" | "write"; payload: Json; prepared: Json | null; label: string; attempts: number; checks: number; not_before: number }
const itemOf = (r: Row): ReturnItem => ({ id: String(r.id), kind: r.kind as BlingReturnItemKind, record_id: String(r.record_id), source_id: String(r.source_id), fingerprint: String(r.fingerprint),
  state: String(r.state), step: r.step === "write" ? "write" : "read", payload: parse(r.payload), prepared: r.prepared == null ? null : parse(r.prepared), label: String(r.label),
  attempts: Number(r.attempts), checks: Number(r.checks), not_before: Number(r.not_before) });
function setItem(db: SqlDriver, id: string, patch: Record<string, unknown>, now: number) {
  const keys = Object.keys(patch), finished = patch.state === "done" || patch.state === "superseded";
  db.exec(`UPDATE wb_bling_return_outbox SET ${keys.map(k => `${k}=?`).join(", ")}, updated_at=?, finished_at=${finished ? "?" : "NULL"} WHERE id=?`,
    ...keys.map(k => patch[k]), now, ...(finished ? [now] : []), id);
}
/** Põe na fila com id estável; o que estava na fila para o mesmo pedido e tipo é substituído. */
function enqueue(db: SqlDriver, kind: BlingReturnItemKind, facts: OrderFacts, record: string, payload: Json, now: number): boolean {
  const fingerprint = twoWayHash({ kind, ...payload });
  const id = `${kind}.${record}.${fingerprint.slice(0, 16)}`;
  if (one(db, "SELECT 1 AS x FROM wb_bling_return_outbox WHERE id=?", id)) return false;
  for (const old of db.exec("SELECT id FROM wb_bling_return_outbox WHERE kind=? AND record_id=? AND state='pending'", kind, record).rows)
    setItem(db, String(old.id), { state: "superseded" }, now);
  db.exec(`INSERT INTO wb_bling_return_outbox(id,kind,record_id,source_id,fingerprint,state,step,payload,label,not_before,created_at,updated_at) VALUES(?,?,?,?,?,'pending','read',?,?,?,?,?)`,
    id, kind, record, facts.source, fingerprint, JSON.stringify(payload), orderLabel(facts), now, now, now);
  return true;
}
function openIssue(db: SqlDriver, item: ReturnItem, kind: "failed" | "uncertain", reason: string, now: number) {
  const key = `ret:${item.id}`;
  const erp = { Pedido: item.label, "O que ia": RETURN_WHAT[item.kind](item.payload) };
  db.exec(`INSERT INTO wb_bling_twoway_issue(key,kind,entity,record_id,source_id,outbox_id,state,label,reason,erp,bling,data,created_at,updated_at) VALUES(?,?,?,?,?,?,'open',?,?,?,NULL,?,?,?)
    ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, state='open', label=excluded.label, reason=excluded.reason, erp=excluded.erp, data=excluded.data,
      resolution=NULL, resolved_by=NULL, resolved_at=NULL, updated_at=excluded.updated_at`,
    key, kind, ENTITY, item.record_id, item.source_id, item.id, clip(item.label, 200), clip(reason, 600), JSON.stringify(erp), JSON.stringify({ op: item.kind, returns: true }), now, now);
}
function closeIssue(db: SqlDriver, item: ReturnItem, resolution: string, actor: string | null, now: number) {
  db.exec("UPDATE wb_bling_twoway_issue SET state='resolved', resolution=?, resolved_by=?, resolved_at=?, updated_at=? WHERE key=? AND state='open'", resolution, actor, now, now, `ret:${item.id}`);
}
const RETURN_WHAT: Record<BlingReturnItemKind, (p: Json) => string> = {
  invoice: p => clip(`NF-e nº ${p.number}, série ${p.series}, chave ${p.access_key}`, 400)!,
  status: p => clip(`Situação ${p.situation_id} no Bling (etapa ${BLING_RETURN_STAGE_LABELS[p.stage as BlingReturnStage] ?? p.stage} aqui)`, 400)!,
  tracking: p => clip(`Código de rastreio ${p.code}`, 400)!,
};

// ---------------------------------------------------------------------------
// Unidade local (sem I/O): varre os pedidos ligados ao Bling e enfileira

export function runReturnsLocalUnit(options: { db: SqlDriver; now(): number; parts: Readonly<ErpParts> }): { worked: boolean; more: boolean } {
  const { db, now, parts } = options;
  if (!returnsTables(db) || !cutoverConfirmed(db)) return { worked: false, more: false };
  const list = returnSettings(db);
  const invoice = list.invoice?.enabled && returnsPartsOn("invoice", parts) ? list.invoice : null;
  const status = list.status?.enabled && returnsPartsOn("status", parts) ? list.status : null;
  const active = [invoice, status].filter(Boolean) as ReturnSetting[];
  if (!active.length || active.every(s => Number(s.scan.next_at ?? 0) > now())) return { worked: false, more: false };
  const lead = active[0];
  const sinceUs = Math.min(...active.map(s => s.since ?? now())) * 1000;
  const started = now();
  let after = String(lead.scan.after ?? ""), handled = 0, queued = 0, more = false;
  const situations = (status?.options.situations ?? {}) as Record<string, string | null>;
  const link = adoptionTables(ENTITY).link;
  while (handled < RETURNS_UNIT.orders && now() - started < RETURNS_UNIT.wall_ms) {
    const ids = db.exec(`SELECT x.id FROM erp_documents__document x WHERE x.kind='sales_orders' AND x.id>?
        AND (EXISTS(SELECT 1 FROM ${link} l WHERE l.entity='sales_orders' AND l.record_id=x.id) OR EXISTS(SELECT 1 FROM wb_bling_twoway_state s WHERE s.entity='sales_orders' AND s.record_id=x.id AND s.source_id IS NOT NULL))
        AND (CAST(x.updated_at AS INTEGER)>=? OR EXISTS(SELECT 1 FROM erp_shipping__order o WHERE o.document_id=x.id AND CAST(o.updated_at AS INTEGER)>=?)
          OR EXISTS(SELECT 1 FROM erp_fiscal_vault__order_emission e WHERE e.document_id=x.id AND CAST(e.authorized_at AS INTEGER)>=?))
      ORDER BY x.id LIMIT ?`, after, sinceUs, sinceUs, sinceUs, RETURNS_UNIT.orders - handled).rows.map(r => String(r.id));
    if (!ids.length) { after = ""; break; }
    for (const id of ids) {
      db.transaction(() => {
        const facts = orderFacts(db, id);
        if (!facts) return;
        const at = now();
        if (invoice && facts.invoice && facts.invoice.at >= (invoice.since ?? 0) * 1000)
          queued += enqueue(db, "invoice", facts, id, { access_key: facts.invoice.access_key, number: facts.invoice.number, series: facts.invoice.series }, at) ? 1 : 0;
        if (status && facts.stage && facts.stage_at >= (status.since ?? 0) * 1000 && situations[facts.stage])
          queued += enqueue(db, "status", facts, id, { stage: facts.stage, situation_id: String(situations[facts.stage]) }, at) ? 1 : 0;
        if (status && facts.tracking && facts.tracking.at >= (status.since ?? 0) * 1000)
          queued += enqueue(db, "tracking", facts, id, { code: facts.tracking.code }, at) ? 1 : 0;
      });
      after = id; handled++;
    }
    if (ids.length < RETURNS_UNIT.orders) { after = ""; break; }
  }
  more = after !== "";
  const next = more ? now() + 1_000 : now() + RETURNS_UNIT.idle_ms;
  db.transaction(() => {
    for (const s of active) db.exec("UPDATE wb_bling_return_setting SET scan=? WHERE kind=?", JSON.stringify({ ...s.scan, after, next_at: next, last_at: now(), queued: Number(s.scan.queued ?? 0) + queued }), s.kind);
  });
  return { worked: handled > 0 || queued > 0, more };
}

// ---------------------------------------------------------------------------
// Saída: um item por acordada (uma chamada HTTP)

const UNCERTAIN_TEXT = "O Bling não respondeu a tempo. Antes de tentar de novo, o sistema confere no pedido do Bling se a mudança entrou.";
const ORDER_PATH = (source: string) => `/pedidos/vendas/${source}`;
const invoiceLine = (p: Json) => `NF-e emitida no ERP: nº ${p.number}, série ${p.series}, chave ${p.access_key}.`;
const trackingLine = (p: Json) => `Código de rastreio: ${p.code}.`;
const notes = (order: Json) => typeof order.observacoesInternas === "string" ? order.observacoesInternas : "";
const volumes = (order: Json) => { const t = object(order.transporte); return Array.isArray(t?.volumes) ? t!.volumes as unknown[] : []; };
/** O pedido do Bling já tem o que a volta levaria? */
export function returnPresent(kind: BlingReturnItemKind, order: Json, payload: Json): boolean {
  if (kind === "invoice") return notes(order).includes(String(payload.access_key));
  if (kind === "tracking") return notes(order).includes(String(payload.code)) || volumes(order).some(v => object(v)?.codigoRastreamento === payload.code);
  const situacao = object(order.situacao);
  return situacao ? String(situacao.id) === String(payload.situation_id) : false;
}
/** Corpo do PUT a partir do pedido lido agora no Bling, com a nota ou o rastreio. */
export function returnBody(kind: "invoice" | "tracking", order: Json, payload: Json): Json {
  const body = structuredClone(order) as Json;
  const line = kind === "invoice" ? invoiceLine(payload) : trackingLine(payload);
  const before = notes(order).trimEnd();
  body.observacoesInternas = before ? `${before}\n${line}` : line;
  if (kind === "tracking") {
    const list = volumes(body);
    const target = list.map(object).find(v => v && !v.codigoRastreamento) ?? object(list[0]);
    if (target) target.codigoRastreamento = String(payload.code);
  }
  return body;
}
function done(db: SqlDriver, item: ReturnItem, now: number, actor: string | null = null) {
  db.transaction(() => { setItem(db, item.id, { state: "done", prepared: null, error_code: null, error_text: null }, now); closeIssue(db, item, "done", actor, now); });
}
function refuse(db: SqlDriver, item: ReturnItem, reason: string, now: number, code = "refused") {
  db.transaction(() => { setItem(db, item.id, { state: "failed", error_code: code, error_text: clip(reason, 600) }, now); openIssue(db, item, "failed", reason, now); });
}
function askPerson(db: SqlDriver, item: ReturnItem, reason: string, now: number) {
  db.transaction(() => { setItem(db, item.id, { state: "uncertain", not_before: now + 86_400_000, error_code: "unconfirmed", error_text: clip(reason, 600), checks: item.checks + 1 }, now); openIssue(db, item, "uncertain", reason, now); });
}
export interface ReturnsOutboundOptions { db: SqlDriver; now(): number; parts: Readonly<ErpParts>; writer: BlingWritePort; ctx: BlingContext; deadline: number }
export async function runReturnsOutboundUnit(options: ReturnsOutboundOptions): Promise<{ worked: boolean; nextWake: number | null; requests: 0 | 1 }> {
  const { db, now, parts, writer, ctx, deadline } = options;
  if (!returnsTables(db)) return { worked: false, nextWake: null, requests: 0 };
  const list = returnSettings(db);
  const enabled = (kind: BlingReturnItemKind) => !!list[switchOf(kind)]?.enabled && returnsPartsOn(switchOf(kind), parts);
  const rows = db.exec(`SELECT * FROM wb_bling_return_outbox WHERE state IN ('sending','uncertain','pending') AND not_before<=?
    ORDER BY CASE state WHEN 'sending' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END, created_at, id LIMIT 50`, now()).rows.map(itemOf);
  // Desligado: nada pendente sai. Conferência (só GET) continua.
  const item = rows.find(r => r.state !== "pending" || enabled(r.kind));
  if (!item) return { worked: false, nextWake: returnsOutboxDue(db), requests: 0 };
  if (item.state === "sending") {
    db.transaction(() => setItem(db, item.id, { state: "uncertain", step: "read", not_before: now(), error_code: "interrupted", error_text: "O envio foi interrompido antes da resposta do Bling. Conferindo se entrou antes de tentar de novo." }, now()));
    return { worked: true, nextWake: now() + 1_000, requests: 0 };
  }
  const call = takeCall(db, now());
  if (!call.ok) return { worked: false, nextWake: call.retry_at, requests: 0 };
  const budget = Math.min(deadline, now() + 3_000);
  const wait = (retryAt: number, code: string, text: string) => db.transaction(() => setItem(db, item.id, { not_before: Math.max(retryAt, now() + 1_000), error_code: code, error_text: clip(text, 600) }, now()));
  // Leitura: conferência de incerto, ou o passo "read" de nota e rastreio.
  if (item.state === "uncertain" || item.kind !== "status" && item.step === "read") {
    const read = await writer.read(ctx, { path: ORDER_PATH(item.source_id), deadline: budget });
    const at = now();
    if (read.kind === "missing") { refuse(db, item, "O pedido não existe mais no Bling (foi excluído lá?). Nada foi gravado.", at, "missing"); return { worked: true, nextWake: at + 1_000, requests: 1 }; }
    if (read.kind !== "ok") {
      if (item.state === "uncertain" && item.checks + 1 >= RETURNS_UNIT.verify_limit) { askPerson(db, item, `${UNCERTAIN_TEXT} A conferência não teve resposta depois de várias tentativas. Veja o pedido no Bling e diga se entrou.`, at); return { worked: true, nextWake: at + 1_000, requests: 1 }; }
      const retryAt = read.kind === "rate" || read.kind === "retry" ? read.retry_at : at + 900_000;
      db.transaction(() => setItem(db, item.id, { checks: item.checks + 1, not_before: Math.max(retryAt, at + 30_000), error_code: read.kind === "auth" ? "auth" : "read", error_text: read.kind === "auth" ? read.message : UNCERTAIN_TEXT }, at));
      return { worked: true, nextWake: at + 1_000, requests: 1 };
    }
    const order = object(dataOf(read.data));
    if (!order) { wait(at + 60_000, "read", "A resposta do Bling veio sem o pedido. Tenta de novo sozinho."); return { worked: true, nextWake: at + 1_000, requests: 1 }; }
    if (returnPresent(item.kind, order, item.payload)) { done(db, item, at); return { worked: true, nextWake: at + 1_000, requests: 1 }; }
    if (item.state === "uncertain" && item.kind === "status") {
      db.transaction(() => setItem(db, item.id, { state: "pending", step: "read", not_before: at, checks: item.checks + 1, error_code: "absent", error_text: "Conferido no Bling: a situação não mudou. Vai ser enviada de novo." }, at));
      return { worked: true, nextWake: at + 1_000, requests: 1 };
    }
    // Nota ou rastreio: prepara o corpo a partir do pedido lido agora; a gravação vai na próxima acordada.
    const prepared = returnBody(item.kind as "invoice" | "tracking", order, item.payload);
    const text = JSON.stringify(prepared);
    if (text.length > 262_144) { refuse(db, item, "O pedido no Bling é grande demais para ser regravado daqui. Escreva a nota ou o rastreio à mão no Bling.", at, "too_large"); return { worked: true, nextWake: at + 1_000, requests: 1 }; }
    db.transaction(() => setItem(db, item.id, { state: "pending", step: "write", prepared: text, not_before: at, checks: item.state === "uncertain" ? item.checks + 1 : item.checks,
      error_code: item.state === "uncertain" ? "absent" : null, error_text: item.state === "uncertain" ? "Conferido no Bling: não entrou. Vai ser gravado de novo." : null }, at));
    return { worked: true, nextWake: at + 1_000, requests: 1 };
  }
  // Escrita.
  db.transaction(() => setItem(db, item.id, { state: "sending", attempts: item.attempts + 1, sent_at: now(), error_code: null, error_text: null }, now()));
  const result = item.kind === "status"
    ? await writer.send(ctx, { method: "PATCH", path: `${ORDER_PATH(item.source_id)}/situacoes/${item.payload.situation_id}`, body: {}, deadline: budget })
    : await writer.send(ctx, { method: "PUT", path: ORDER_PATH(item.source_id), body: item.prepared ?? {}, deadline: budget });
  const at = now();
  switch (result.kind) {
    case "ok": done(db, item, at); break;
    case "rejected": refuse(db, item, result.message, at); break;
    case "rate":
      db.transaction(() => {
        setItem(db, item.id, { state: "pending", not_before: result.retry_at, error_code: "rate", error_text: "O Bling pediu para esperar (limite de chamadas). O envio segue sozinho." }, at);
        db.exec("UPDATE wb_bling_control SET next_allowed_at=max(coalesce(next_allowed_at,0),?), updated_at=? WHERE id=1", result.retry_at, at);
      });
      break;
    case "auth":
      if (result.status === 403) refuse(db, item, `${result.message} Marque a permissão de escrita de pedidos de venda no aplicativo do Bling.`, at, "scope");
      else db.transaction(() => setItem(db, item.id, { state: "pending", not_before: at + 900_000, error_code: "auth", error_text: result.message }, at));
      break;
    case "not_sent": db.transaction(() => setItem(db, item.id, { state: "pending", attempts: item.attempts, not_before: result.retry_at, error_code: "not_sent", error_text: result.message }, at)); break;
    case "uncertain":
      db.transaction(() => setItem(db, item.id, { state: "uncertain", step: "read", not_before: at + 60_000, error_code: result.reason, error_text: UNCERTAIN_TEXT }, at));
      break;
  }
  return { worked: true, nextWake: at + 1_000, requests: 1 };
}

// ---------------------------------------------------------------------------
// Pendências da volta (chamado pela resolução da mão dupla, na mesma transação)

export function resolveReturnIssue(db: SqlDriver, issue: Row, action: string, actor: string, now: number): { outcome: "confirmed" | "retrying" | "discarded"; message: string } {
  const r = issue.outbox_id == null ? undefined : one(db, "SELECT * FROM wb_bling_return_outbox WHERE id=?", issue.outbox_id);
  if (!r) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND", "Este envio não está mais na fila. Atualize a tela.");
  const item = itemOf(r);
  const allowed = issue.kind === "uncertain" ? ["confirm_sent", "resend"] : ["retry", "discard"];
  if (!allowed.includes(action)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", issue.kind === "uncertain" ? "Para esta pendência, escolha: Entrou no Bling ou Não entrou: enviar de novo." : "Para esta pendência, escolha: Tentar de novo ou Deixar como está.");
  if (action === "confirm_sent") { done(db, item, now, actor); closeIssue(db, item, action, actor, now); return { outcome: "confirmed", message: "Marcado como gravado no Bling. Nada vai ser reenviado." }; }
  if (action === "discard") { setItem(db, item.id, { state: "superseded" }, now); closeIssue(db, item, action, actor, now); return { outcome: "discarded", message: "Ficou como está: este envio não vai ser repetido. Se precisar, ajuste o pedido à mão no Bling." }; }
  setItem(db, item.id, { state: "pending", step: "read", prepared: null, not_before: now, error_code: null, error_text: "Uma pessoa pediu para enviar de novo: o pedido no Bling é conferido antes." }, now);
  closeIssue(db, item, action, actor, now);
  return { outcome: "retrying", message: "Vai ser enviado de novo ao Bling, depois de conferir o pedido lá." };
}

// ---------------------------------------------------------------------------
// Consulta (vai dentro da consulta da mão dupla) e interruptores

export function returnsQueueRows(db: SqlDriver, states: string[], cursor: { at: number; id: string } | null, limit: number): Row[] {
  if (!returnsTables(db)) return [];
  return db.exec(`SELECT id, kind, label, state, attempts, checks, not_before, sent_at, updated_at, error_text FROM wb_bling_return_outbox
    WHERE state IN (SELECT value FROM json_each(?)) AND (? IS NULL OR updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC, id DESC LIMIT ?`,
    JSON.stringify(states), cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.id ?? null, limit).rows;
}
export const BLING_WEBHOOK_PATH = (profile: string) => `/api/public/erp-bling/${encodeURIComponent(profile)}/webhook`;
export function returnsStatus(db: SqlDriver, profile: string, parts: Readonly<ErpParts>): BlingReturnsStatus | undefined {
  if (!returnsTables(db)) return undefined;
  const list = returnSettings(db);
  const count = (sql: string) => Number(one(db, sql)?.n ?? 0);
  const side = (s: ReturnSetting | null) => ({ enabled: !!s?.enabled, since: s?.enabled ? iso(s.since) : null });
  const situations = Object.fromEntries(BLING_RETURN_STAGES.map(stage => {
    const value = (list.status?.options.situations as Json | undefined)?.[stage];
    return [stage, typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) ? value : null];
  })) as Record<BlingReturnStage, string | null>;
  let hints: Row[] = [];
  try { hints = db.exec("SELECT entity, events, last_event_at FROM wb_bling_webhook_hint ORDER BY entity").rows; } catch { hints = []; }
  let read: string[] = [], write: string[] = [];
  try {
    const control = one(db, "SELECT selection FROM wb_bling_control WHERE id=1");
    const selection = JSON.parse(String(control?.selection ?? "[]")) as Array<string | { key: string; selected: boolean }>;
    read = selection.flatMap(s => typeof s === "string" ? [s] : s.selected ? [s.key] : []);
    write = db.exec("SELECT entity FROM wb_bling_twoway_setting WHERE direction='outbound' AND enabled=1").rows.map(r => String(r.entity));
  } catch { /* sem coleta configurada */ }
  return {
    available: archiveAvailable(db),
    invoice: side(list.invoice), status: { ...side(list.status), situations },
    webhook: { ...side(list.webhook), path: BLING_WEBHOOK_PATH(profile), last_event_at: iso(hints.reduce<number | null>((max, h) => h.last_event_at == null ? max : Math.max(max ?? 0, Number(h.last_event_at)), null)),
      events: hints.reduce((sum, h) => sum + Number(h.events ?? 0), 0), entities: hints.map(h => String(h.entity)).slice(0, 10) },
    stages: BLING_RETURN_STAGES.map(stage => ({ stage, label: BLING_RETURN_STAGE_LABELS[stage] })),
    queue: { pending: count("SELECT count(*) AS n FROM wb_bling_return_outbox WHERE state IN ('pending','sending')"), uncertain: count("SELECT count(*) AS n FROM wb_bling_return_outbox WHERE state='uncertain'"),
      failed: count("SELECT count(*) AS n FROM wb_bling_return_outbox WHERE state='failed'"), done: count("SELECT count(*) AS n FROM wb_bling_return_outbox WHERE state='done'") },
    part_off_message: returnsPartOffMessage("invoice", parts) ?? returnsPartOffMessage("status", parts),
    scopes: blingScopeChecklist({ read, write, invoice_back: !!list.invoice?.enabled, status_back: !!list.status?.enabled }),
    texts: { ...BLING_RETURN_TEXTS },
  };
}

const SWITCH_LABEL: Record<BlingReturnKind, string> = { invoice: "Nota de volta ao Bling", status: "Situação e rastreio de volta ao Bling", webhook: "Aviso do Bling (webhook)" };
export function returnsSwitch(call: AdoptionCall, input: Map_<"erp_bling_twoway_return_switch">["input"]) {
  return command(call, "erp_bling_twoway_return_switch", input.command_id, ctx => {
    const db = ctx.db, actor = call.identity.actor!.user_id, now = call.now();
    if (!returnsTables(db)) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE", "Esta área ainda não tem a versão do ERP com a volta ao Bling. Atualize o ERP e tente de novo.");
    const { kind, enabled } = input;
    if (!(BLING_RETURN_KINDS as readonly string[]).includes(kind)) throw new BlingAdoptionError("BLING_ADOPTION_INVALID");
    if (enabled) {
      if (!returnsPartsOn(kind, call.parts)) throw new BlingAdoptionError("BLING_ADOPTION_PART_DISABLED", returnsPartOffMessage(kind, call.parts)!);
      if (kind !== "webhook" && !cutoverConfirmed(db)) throw new BlingAdoptionError("BLING_ADOPTION_CONFLICT", BLING_TWO_WAY_TEXTS.no_cutover);
      if (!archiveAvailable(db)) throw new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE", "Autorize a conta do Bling em Configuração antes de ligar.");
      if (input.acknowledged !== true) throw new BlingAdoptionError("BLING_ADOPTION_INVALID", "Ligar pede que você confirme o aviso.");
    }
    const current = returnSettings(db)[kind];
    const wasOn = !!current?.enabled;
    const since = enabled ? wasOn ? current!.since : now : null;
    const options = { ...(current?.options ?? {}) };
    if (input.situations) options.situations = { ...((options.situations as Json | undefined) ?? {}), ...input.situations };
    db.exec(`INSERT INTO wb_bling_return_setting(kind,enabled,enabled_since,options,scan,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(kind) DO UPDATE SET enabled=excluded.enabled, enabled_since=excluded.enabled_since, options=excluded.options,
        scan=CASE WHEN excluded.enabled=1 AND wb_bling_return_setting.enabled=0 THEN excluded.scan ELSE wb_bling_return_setting.scan END, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      kind, enabled ? 1 : 0, since, JSON.stringify(options), JSON.stringify({ after: "", next_at: now }), actor, now);
    const changedMap = !!input.situations && JSON.stringify(current?.options.situations ?? {}) !== JSON.stringify(options.situations);
    if (enabled !== wasOn || changedMap) {
      const detail = enabled !== wasOn ? `${enabled ? "Ligou" : "Desligou"} "${SWITCH_LABEL[kind]}"${enabled ? " (aviso confirmado)" : ""}.`
        : `Mudou as situações do Bling para cada etapa: ${BLING_RETURN_STAGES.map(stage => `${BLING_RETURN_STAGE_LABELS[stage]} ${(options.situations as Json)[stage] ?? "sem mudar"}`).join(", ")}.`;
      db.exec("INSERT INTO wb_bling_twoway_audit(id,actor_id,action,entity,direction,enabled,detail,created_at) VALUES(?,?,'switch',?,?,?,?,?)",
        commandUuid("bling-return-audit", input.command_id), actor, kind === "webhook" ? null : ENTITY, kind === "webhook" ? null : "outbound", enabled ? 1 : 0, clip(detail, 600), now);
    }
    const situations = Object.fromEntries(BLING_RETURN_STAGES.map(stage => [stage, ((options.situations as Json | undefined)?.[stage] as string | null | undefined) ?? null]));
    return { kind, enabled, since: iso(since), situations };
  });
}
