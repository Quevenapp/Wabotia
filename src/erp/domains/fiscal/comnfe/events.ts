/** Depois da NF-e autorizada (versão 18 do esquema): carta de correção,
 * inutilização de numeração e devolução de venda. Cada RPC é uma transação
 * local; o serviço (commercial-nfe/events-service.ts) fala com o cofre entre
 * elas. Nada aqui faz I/O externo.
 *
 * Repetição: o mesmo command_id devolve o mesmo registro (nunca outra carta,
 * outra inutilização ou outra devolução). Os efeitos da devolução mudam de
 * "pendente" para "aplicado" uma vez só, na mesma transação do lançamento.
 */
import { createHash, randomUUID } from "node:crypto";
import { one, type Row } from "../../../engine/driver.ts";
import { formatScaled, toScaled } from "../../../engine/dec.ts";
import { ErpError, fromSqlite, raise } from "../../../engine/errors.ts";
import { invokeRpc, registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import type { EmissionView, FiscalMessage, JsonObject } from "../../../commercial-nfe/contracts.ts";
import {
  CORRECTION_LIMIT, CORRECTION_TEXT_MAX, CORRECTION_TEXT_MIN, VOID_JUSTIFICATION_MAX, VOID_JUSTIFICATION_MIN, VOID_RANGE_MAX,
  nfeEventRules, returnCfop,
  type CorrectionView, type NfeEventsView, type ReturnFinanceOption, type ReturnItemInput, type ReturnLine, type ReturnStatus,
  type ReturnView, type VoidRangeView,
} from "../../../commercial-nfe/events-contracts.ts";
import { requireCom1Access } from "./access.ts";
import { normalizeCommercialResult } from "./lifecycle.ts";
import { COM1_MODEL_TABLES, modelOfEmission, withCom1Model } from "./model.ts";
import { readCommercialEmission, requireCommercialReadParts } from "./reads.ts";
import { com1Hash, com1Json, com1Sha256, com1Uuid } from "./store.ts";

export const NFE_EVENT_TABLES = Object.freeze({
  correction: "erp_fiscal_vault__order_correction",
  void: "erp_fiscal_vault__void_range",
  return: "erp_fiscal_vault__order_return",
});
const T = NFE_EVENT_TABLES;
const ORDER = COM1_MODEL_TABLES.nfe;

const invalid = (code = "nfe_event_input_invalid"): never => raise("22023", code);
const parse = <V>(value: unknown, fallback: V): V => value == null ? fallback : JSON.parse(String(value)) as V;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : String(value);
const now = (ctx: RpcContext): string => String(ctx.clock.next());
/** UUID estável derivado do comando: a repetição chega ao mesmo comando local. */
export function derivedUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function input(args: RpcArgs, allowed: readonly string[], required: readonly string[]): Row {
  const value = args.p_input;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const data = value as Row;
  if (Object.keys(data).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(data, key))) return invalid();
  return data;
}
const person = (args: RpcArgs): string => typeof args.p_user_id === "string" ? args.p_user_id : invalid();
/** Mensagens do governo vêm do cofre: guardar só código e descrição curtos. */
function messages(value: unknown): FiscalMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).filter(m => m && typeof m === "object").map(m => ({
    code: text((m as Row).code).slice(0, 200), description: text((m as Row).description).slice(0, 2000) }));
}
/** Instante do cofre (ISO) em microssegundos, como o resto da fatia. */
const micros = (value: unknown): string | null => {
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return value;
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? String(BigInt(ms) * 1000n) : null;
};

// ---------------------------------------------------------------------------
// Leituras

const correctionRow = (row: Row): CorrectionView => ({
  id: text(row.id), emission_id: text(row.emission_id), command_id: text(row.command_id), person_id: text(row.person_id),
  text: text(row.text), state: row.state as CorrectionView["state"], expected_sequence: Number(row.expected_sequence),
  sequence: row.sequence == null ? null : Number(row.sequence), protocol: row.protocol == null ? null : text(row.protocol),
  event_at: row.event_at == null ? null : text(row.event_at), messages: parse(row.messages, []), xml_available: row.xml != null,
  created_at: text(row.created_at), updated_at: text(row.updated_at),
});
const voidRow = (row: Row): VoidRangeView => ({
  id: text(row.id), command_id: text(row.command_id), person_id: text(row.person_id), model: row.model as "nfe" | "nfce",
  environment: row.environment as VoidRangeView["environment"], series: Number(row.series), first: Number(row.first_number), last: Number(row.last_number),
  justification: text(row.justification), state: row.state as VoidRangeView["state"], provider_ref: row.provider_ref == null ? null : text(row.provider_ref),
  protocol: row.protocol == null ? null : text(row.protocol), repeated: row.repeated === 1, messages: parse(row.messages, []),
  created_at: text(row.created_at), updated_at: text(row.updated_at),
});
const returnRow = (row: Row): ReturnView => ({
  id: text(row.id), emission_id: text(row.emission_id), command_id: text(row.command_id), person_id: text(row.person_id),
  environment: row.environment as ReturnView["environment"], reference: text(row.reference), items: parse(row.items, []),
  finance_option: row.finance_option as ReturnFinanceOption, total: text(row.total), status: row.status as ReturnStatus,
  provider_id: row.provider_id == null ? null : text(row.provider_id), series: row.series == null ? null : Number(row.series),
  number: row.number == null ? null : Number(row.number), access_key: row.access_key == null ? null : text(row.access_key),
  protocol: row.protocol == null ? null : text(row.protocol), authorized_at: row.authorized_at == null ? null : text(row.authorized_at),
  messages: parse(row.messages, []), stock: { state: row.stock_state as ReturnView["stock"]["state"], result: parse(row.stock_result, null) },
  finance: { state: row.finance_state as ReturnView["finance"]["state"], result: parse(row.finance_result, null) },
  created_at: text(row.created_at), updated_at: text(row.updated_at),
});
const selectCorrection = `SELECT *,CAST(created_at AS TEXT) AS created_at,CAST(updated_at AS TEXT) AS updated_at FROM ${T.correction}`;
const selectVoid = `SELECT *,CAST(created_at AS TEXT) AS created_at,CAST(updated_at AS TEXT) AS updated_at FROM ${T.void}`;
const selectReturn = `SELECT *,CAST(total AS TEXT) AS total,CAST(created_at AS TEXT) AS created_at,CAST(updated_at AS TEXT) AS updated_at FROM ${T.return}`;
export const corrections = (ctx: RpcContext, emissionId: string): CorrectionView[] =>
  ctx.db.exec(`${selectCorrection} WHERE emission_id=? ORDER BY created_at,id`, emissionId).rows.map(correctionRow);
export const returnsOf = (ctx: RpcContext, emissionId: string): ReturnView[] =>
  ctx.db.exec(`${selectReturn} WHERE emission_id=? ORDER BY created_at,id`, emissionId).rows.map(returnRow);
function getReturn(ctx: RpcContext, id: string): ReturnView {
  const row = one(ctx.db, `${selectReturn} WHERE id=?`, id);
  if (!row) raise("P0002", "nfe_return_not_found");
  return returnRow(row);
}
function getCorrection(ctx: RpcContext, id: string): CorrectionView {
  const row = one(ctx.db, `${selectCorrection} WHERE id=?`, id);
  if (!row) raise("P0002", "nfe_correction_not_found");
  return correctionRow(row);
}
function getVoid(ctx: RpcContext, id: string): VoidRangeView {
  const row = one(ctx.db, `${selectVoid} WHERE id=?`, id);
  if (!row) raise("P0002", "nfe_void_not_found");
  return voidRow(row);
}

/** Emissão do pedido (modelo 55) visível para quem lê, já com a política de leitura. */
function orderEmission(ctx: RpcContext, emissionId: unknown, action: "read" | "emit"): EmissionView {
  com1Uuid(emissionId);
  if (modelOfEmission(ctx.db, emissionId) !== "nfe") raise("P0002", "com1_emission_not_found");
  return withCom1Model("nfe", () => {
    const view = readCommercialEmission(ctx, { emission_id: emissionId });
    if (action !== "read") requireCom1Access(ctx, action);
    const { cancellation_xml: _xml, ...emission } = view;
    return emission as EmissionView;
  });
}

const QTY = 4;
const qty = (value: unknown): bigint => {
  const raw = typeof value === "number" ? String(value) : text(value);
  if (!/^\d{1,11}(\.\d{1,6})?$/.test(raw)) return invalid("nfe_return_quantity_invalid");
  return toScaled(raw, QTY);
};
const qtyText = (value: bigint): string => {
  const formatted = formatScaled(value, QTY);
  return formatted.includes(".") ? formatted.replace(/0+$/, "").replace(/\.$/, "") : formatted;
};
const originalItems = (emission: EmissionView): Row[] =>
  Array.isArray(object(emission.revision.body).itens) ? (object(emission.revision.body).itens as unknown[]).map(object) : [];
/** Já devolvido por item: devoluções autorizadas ou ainda sem resposta. */
function returnedByItem(ctx: RpcContext, emissionId: string): Map<number, bigint> {
  const out = new Map<number, bigint>();
  for (const r of returnsOf(ctx, emissionId)) {
    if (["rejeitada", "denegada", "cancelada"].includes(r.status)) continue;
    for (const item of r.items) out.set(item.item, (out.get(item.item) ?? 0n) + toScaled(item.quantity, QTY));
  }
  return out;
}
export function returnLines(ctx: RpcContext, emission: EmissionView): ReturnLine[] {
  const returned = returnedByItem(ctx, emission.id);
  return originalItems(emission).map((item, index) => {
    const quantity = toScaled(String(item.quantidade ?? "0"), QTY), back = returned.get(index) ?? 0n;
    return { item: index, code: text(item.codigo), description: text(item.descricao), unit: text(item.unidade), cfop: text(item.cfop),
      return_cfop: returnCfop(text(item.cfop)), quantity: qtyText(quantity), returned: qtyText(back),
      remaining: qtyText(quantity > back ? quantity - back : 0n), unit_price: text(item.valorUnitario) };
  });
}

function eventsView(ctx: RpcContext, emission: EmissionView): NfeEventsView {
  const list = corrections(ctx, emission.id), returns = returnsOf(ctx, emission.id), lines = returnLines(ctx, emission);
  const rules = nfeEventRules({ model: "nfe", status: emission.status, authorized_at: emission.authorized_at,
    cancellation_state: emission.cancellation?.state ?? null,
    corrections_registered: list.filter(c => c.state === "registrado").length,
    corrections_in_flight: list.some(c => c.state === "enviando" || c.state === "incerto"),
    returnable: lines.some(line => toScaled(line.remaining, QTY) > 0n), now: ctx.clock.next() });
  return {
    emission: { id: emission.id, model: "nfe", status: emission.status, environment: emission.environment, number: emission.number, series: emission.series,
      access_key: emission.access_key, authorized_at: emission.authorized_at, cancel_until: rules.cancel_until },
    rules: { cancel: rules.cancel, correction: rules.correction, return: rules.return }, corrections: list, returns, lines,
  };
}

registerRpc("erp_com1_events_get", (ctx, a) => {
  const value = input(a, ["emission_id"], ["emission_id"]);
  requireCom1Access(ctx, "read", person(a));
  return eventsView(ctx, orderEmission(ctx, value.emission_id, "read"));
});

// ---------------------------------------------------------------------------
// Carta de correção

/** Texto da carta: uma linha só (o XML do evento não aceita quebra), 15 a 1.000 caracteres. */
export function correctionText(value: unknown): string {
  if (typeof value !== "string") return invalid("nfe_correction_text_invalid");
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const length = [...clean].length;
  if (length < CORRECTION_TEXT_MIN || length > CORRECTION_TEXT_MAX) return invalid("nfe_correction_text_invalid");
  return clean;
}

export interface CorrectionClaim {
  disposition: "send" | "resume" | "replay";
  correction: CorrectionView;
  emission: Pick<EmissionView, "id" | "environment" | "provider_id" | "connection_fingerprint" | "reference" | "access_key" | "number" | "series" | "authorized_at">;
}
const emissionIdentity = (e: EmissionView): CorrectionClaim["emission"] => ({ id: e.id, environment: e.environment, provider_id: e.provider_id,
  connection_fingerprint: e.connection_fingerprint, reference: e.reference, access_key: e.access_key, number: e.number, series: e.series, authorized_at: e.authorized_at });

registerRpc("erp_com1_correction_claim", (ctx, a) => {
  const value = input(a, ["emission_id", "command_id", "text"], ["emission_id", "command_id", "text"]);
  requireCom1Access(ctx, "emit", person(a));
  com1Uuid(value.command_id);
  const clean = correctionText(value.text), hash = com1Sha256(clean);
  const emission = orderEmission(ctx, value.emission_id, "emit");
  const previous = one(ctx.db, `${selectCorrection} WHERE command_id=?`, value.command_id);
  if (previous) {
    const row = correctionRow(previous);
    if (row.emission_id !== emission.id || previous.text_hash !== hash) raise("40001", "fiscal_command_conflict");
    return { disposition: row.state === "registrado" || row.state === "recusado" ? "replay" : "resume", correction: row, emission: emissionIdentity(emission) } satisfies CorrectionClaim;
  }
  const list = corrections(ctx, emission.id);
  const registered = list.filter(c => c.state === "registrado");
  // Clique duplo com outro comando: a carta igual à última registrada não vira outra carta.
  const last = registered.sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0)).at(-1);
  if (last && com1Sha256(last.text) === hash) return { disposition: "replay", correction: last, emission: emissionIdentity(emission) } satisfies CorrectionClaim;
  const rules = eventsView(ctx, emission).rules.correction;
  if (!rules.allowed) raise("55000", rules.code ?? "nfe_correction_not_allowed");
  if (!emission.provider_id || !emission.connection_fingerprint) raise("55000", "nfe_not_authorized");
  const id = randomUUID(), at = now(ctx);
  ctx.db.exec(`INSERT INTO ${T.correction} (id,emission_id,command_id,person_id,text,text_hash,state,expected_sequence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, emission.id, value.command_id, ctx.identity.actor!.user_id, clean, hash, "enviando", Math.min(registered.length + 1, CORRECTION_LIMIT), at, at);
  return { disposition: "send", correction: getCorrection(ctx, id), emission: emissionIdentity(emission) } satisfies CorrectionClaim;
});

registerRpc("erp_com1_correction_record", (ctx, a) => {
  const value = input(a, ["correction_id", "command_id", "state", "sequence", "protocol", "event_at", "messages", "xml", "xml_hash"],
    ["correction_id", "command_id", "state"]);
  requireCom1Access(ctx, "emit", person(a));
  com1Uuid(value.correction_id);
  const current = getCorrection(ctx, String(value.correction_id));
  if (current.command_id !== value.command_id) raise("42501", "com1_claim_required");
  orderEmission(ctx, current.emission_id, "emit");
  if (!["incerto", "recusado", "registrado"].includes(String(value.state))) return invalid();
  const state = String(value.state);
  if (current.state === "registrado") {
    // Arquivamento tardio do XML de uma carta já registrada.
    if (typeof value.xml === "string" && current.xml_available === false) {
      if (com1Sha256(value.xml) !== value.xml_hash || value.xml.length > 10_485_760) return invalid();
      ctx.db.exec(`UPDATE ${T.correction} SET xml=?,xml_hash=?,updated_at=? WHERE id=?`, value.xml, value.xml_hash, now(ctx), current.id);
    }
    return getCorrection(ctx, current.id);
  }
  const sequence = value.sequence == null ? null : Number(value.sequence);
  if (state === "registrado" && (!Number.isInteger(sequence) || sequence! < 1 || sequence! > CORRECTION_LIMIT)) return invalid();
  if (state === "registrado" && one(ctx.db, `SELECT 1 FROM ${T.correction} WHERE emission_id=? AND sequence=? AND id<>?`, current.emission_id, sequence, current.id))
    raise("40001", "nfe_correction_sequence_conflict");
  const xml = typeof value.xml === "string" && com1Sha256(value.xml) === value.xml_hash ? value.xml : null;
  ctx.db.exec(`UPDATE ${T.correction} SET state=?,sequence=?,protocol=?,event_at=?,messages=?,xml=?,xml_hash=?,updated_at=? WHERE id=?`,
    state, state === "registrado" ? sequence : null, state === "registrado" && typeof value.protocol === "string" ? value.protocol.slice(0, 100) : null,
    state === "registrado" ? micros(value.event_at) : null, com1Json(messages(value.messages)), state === "registrado" ? xml : null,
    state === "registrado" && xml ? value.xml_hash : null, now(ctx), current.id);
  return getCorrection(ctx, current.id);
});

/** XML arquivado da carta (privado: só o serviço o projeta como arquivo). */
registerRpc("erp_com1_correction_file", (ctx, a) => {
  const value = input(a, ["emission_id", "sequence"], ["emission_id", "sequence"]);
  requireCom1Access(ctx, "read", person(a));
  const emission = orderEmission(ctx, value.emission_id, "read");
  const sequence = Number(value.sequence);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > CORRECTION_LIMIT) return invalid();
  const row = one(ctx.db, `${selectCorrection} WHERE emission_id=? AND sequence=? AND state='registrado'`, emission.id, sequence);
  if (!row) raise("P0002", "nfe_correction_not_found");
  // Emitente e destinatário como foram na nota autorizada (o corpo congelado).
  const body = object(emission.revision.body), issuer = object(body.emitente), recipient = object(body.destinatario);
  const company = object(emission.revision.snapshot.company);
  return { correction: correctionRow(row), xml: row.xml == null ? null : text(row.xml), emission: emissionIdentity(emission),
    issuer: { name: text(issuer.razaoSocial ?? issuer.nome ?? company.legal_name), document: text(issuer.cnpj ?? issuer.cpf ?? company.cnpj) },
    recipient: { name: text(recipient.razaoSocial ?? recipient.nome), document: text(recipient.cnpj ?? recipient.cpf ?? recipient.idEstrangeiro) } };
});

// ---------------------------------------------------------------------------
// Inutilização de numeração

registerRpc("erp_com1_void_list", (ctx, a) => {
  const value = input(a, ["environment", "model"], []);
  requireCom1Access(ctx, "read", person(a));
  requireCommercialReadParts(ctx);
  const clauses: string[] = [], values: unknown[] = [];
  if (value.environment !== undefined) { if (!["homologacao", "producao"].includes(String(value.environment))) return invalid(); clauses.push("environment=?"); values.push(value.environment); }
  if (value.model !== undefined) { if (!["nfe", "nfce"].includes(String(value.model))) return invalid(); clauses.push("model=?"); values.push(value.model); }
  return { items: ctx.db.exec(`${selectVoid}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC,id LIMIT 200`, ...values).rows.map(voidRow) };
});

/** Número já usado por nota emitida pelo ERP nesta série e ambiente (o cofre confere de novo). */
function numberInUse(ctx: RpcContext, model: "nfe" | "nfce", environment: string, series: number, first: number, last: number): boolean {
  const table = COM1_MODEL_TABLES[model].emission;
  return !!one(ctx.db, `SELECT 1 FROM ${table} WHERE environment=? AND series=? AND number BETWEEN ? AND ? AND status IN ('autorizada','cancelada','denegada','processando','incerta','enviando') LIMIT 1`,
    environment, series, first, last) || !!(model === "nfe" && one(ctx.db,
    `SELECT 1 FROM ${T.return} WHERE environment=? AND series=? AND number BETWEEN ? AND ? AND status IN ('autorizada','cancelada','denegada') LIMIT 1`, environment, series, first, last));
}

registerRpc("erp_com1_void_claim", (ctx, a) => {
  const value = input(a, ["command_id", "model", "environment", "series", "first", "last", "justification"],
    ["command_id", "model", "environment", "series", "first", "last", "justification"]);
  requireCom1Access(ctx, "emit", person(a));
  requireCommercialReadParts(ctx);
  com1Uuid(value.command_id);
  const model = String(value.model), environment = String(value.environment);
  const series = Number(value.series), first = Number(value.first), last = Number(value.last);
  const justification = typeof value.justification === "string" ? value.justification.replace(/\s+/g, " ").trim() : "";
  if (!["nfe", "nfce"].includes(model) || !["homologacao", "producao"].includes(environment) || !Number.isInteger(series) || series < 0 || series > 889 ||
      !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > 999999999) return invalid("nfe_void_range_invalid");
  if (last - first + 1 > VOID_RANGE_MAX) return invalid("nfe_void_range_too_large");
  if ([...justification].length < VOID_JUSTIFICATION_MIN || [...justification].length > VOID_JUSTIFICATION_MAX || /[\u0000-\u001f]/.test(justification))
    return invalid("nfe_void_justification_invalid");
  const previous = one(ctx.db, `${selectVoid} WHERE command_id=?`, value.command_id);
  if (previous) {
    const row = voidRow(previous);
    if (row.model !== model || row.environment !== environment || row.series !== series || row.first !== first || row.last !== last || row.justification !== justification)
      raise("40001", "fiscal_command_conflict");
    return { disposition: row.state === "registrado" || row.state === "recusado" ? "replay" : "resume", void: row, uf: issuerUf(ctx) };
  }
  if (numberInUse(ctx, model as "nfe" | "nfce", environment, series, first, last)) raise("55000", "nfe_void_number_used");
  const id = randomUUID(), at = now(ctx);
  ctx.db.exec(`INSERT INTO ${T.void} (id,command_id,person_id,model,environment,series,first_number,last_number,justification,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, value.command_id, ctx.identity.actor!.user_id, model, environment, series, first, last, justification, "enviando", at, at);
  return { disposition: "send", void: getVoid(ctx, id), uf: issuerUf(ctx) };
});
/** UF do emitente (Dados da empresa): o pedido de inutilização vai à SEFAZ dela. */
function issuerUf(ctx: RpcContext): string | null {
  const uf = one(ctx.db, "SELECT json_extract(data,'$.state') AS uf FROM erp_company__identity LIMIT 1")?.uf;
  return typeof uf === "string" && /^[A-Z]{2}$/.test(uf) ? uf : null;
}

registerRpc("erp_com1_void_record", (ctx, a) => {
  const value = input(a, ["void_id", "command_id", "state", "provider_ref", "protocol", "repeated", "messages"], ["void_id", "command_id", "state"]);
  requireCom1Access(ctx, "emit", person(a));
  com1Uuid(value.void_id);
  const current = getVoid(ctx, String(value.void_id));
  if (current.command_id !== value.command_id) raise("42501", "com1_claim_required");
  if (current.state === "registrado") return current;
  const state = String(value.state);
  if (!["incerto", "recusado", "registrado"].includes(state)) return invalid();
  if (state === "registrado" && (typeof value.provider_ref !== "string" || !value.provider_ref || value.provider_ref.length > 200)) return invalid();
  ctx.db.exec(`UPDATE ${T.void} SET state=?,provider_ref=?,protocol=?,repeated=?,messages=?,updated_at=? WHERE id=?`, state,
    state === "registrado" ? value.provider_ref : null, state === "registrado" && typeof value.protocol === "string" ? value.protocol.slice(0, 100) : null,
    value.repeated === true ? 1 : 0, com1Json(messages(value.messages)), now(ctx), current.id);
  return getVoid(ctx, current.id);
});

// ---------------------------------------------------------------------------
// Devolução de venda

/** Valor em reais (number do contrato) proporcional à quantidade devolvida, com 2 casas. */
const money = (value: unknown): bigint | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? toScaled(value.toFixed(2), 2) : null;
const reais = (cents: bigint): number => Number(formatScaled(cents, 2));
/** Proporção exata: arredonda metade para cima, como o numeric do Postgres. */
const share = (cents: bigint, part: bigint, whole: bigint): bigint => whole === 0n ? 0n : (cents * part * 2n + whole) / (whole * 2n);
function scaleTaxes(value: unknown, part: bigint, whole: bigint): unknown {
  if (Array.isArray(value)) return value.map(entry => scaleTaxes(entry, part, whole));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Row).map(([key, entry]) => {
    // Bases e valores acompanham a quantidade; alíquotas, percentuais e códigos não.
    if (typeof entry === "number" && /^(valor|baseCalculo)/.test(key)) { const cents = money(entry); return [key, cents === null ? entry : reais(share(cents, part, whole))]; }
    return [key, scaleTaxes(entry, part, whole)];
  }));
}
interface ReturnBuild { body: Row; items: ReturnView["items"]; total: bigint }
/** NF-e de devolução a partir do corpo autorizado: finalidade devolução, nota referenciada,
 * natureza de devolução, entrada, CFOP de devolução e os valores proporcionais. */
export function buildReturnBody(emission: EmissionView, chosen: { item: number; quantity: bigint }[], reference: string): ReturnBuild {
  const original = object(emission.revision.body), items = originalItems(emission);
  const outItems: Row[] = [], views: ReturnView["items"] = [];
  let total = 0n;
  for (const choice of chosen) {
    const source = items[choice.item];
    if (!source) return invalid("nfe_return_item_invalid");
    const whole = toScaled(String(source.quantidade ?? "0"), QTY);
    const cfop = returnCfop(text(source.cfop));
    if (!cfop) raise("55000", "nfe_return_cfop_unknown");
    const gross = money(source.valorTotal) ?? 0n, item: Row = { ...source };
    item.cfop = cfop;
    item.quantidade = Number(formatScaled(choice.quantity, QTY));
    item.valorTotal = reais(share(gross, choice.quantity, whole));
    const taxable = object(source.tributavel);
    if (Object.keys(taxable).length) {
      const taxableWhole = toScaled(String(taxable.quantidade ?? source.quantidade ?? "0"), QTY);
      item.tributavel = { ...taxable, quantidade: Number(formatScaled(share(taxableWhole, choice.quantity, whole), QTY)) };
    }
    let line = share(gross, choice.quantity, whole);
    for (const key of ["frete", "seguro", "desconto", "outrasDespesas"]) {
      const cents = money(source[key]);
      if (cents === null) continue;
      const part = share(cents, choice.quantity, whole);
      item[key] = reais(part);
      line += key === "desconto" ? -part : part;
    }
    item.impostos = scaleTaxes(source.impostos ?? {}, choice.quantity, whole);
    delete item.numeroPedido; delete item.itemPedido;
    outItems.push(item);
    total += line;
    views.push({ item: choice.item, code: text(source.codigo), description: text(source.descricao), unit: text(source.unidade), cfop,
      quantity: qtyText(choice.quantity), amount_cents: String(line) });
  }
  const body: Row = {
    ambiente: emission.environment, referencia: reference, naturezaOperacao: "Devolução de venda", tipo: "entrada", finalidade: "devolucao",
    notasReferenciadas: [emission.access_key], presenca: original.presenca ?? "nao_se_aplica", consumidorFinal: original.consumidorFinal ?? false,
    ...(original.destinoOperacao ? { destinoOperacao: original.destinoOperacao } : {}), emitente: original.emitente, destinatario: original.destinatario,
    itens: outItems, pagamentos: [{ forma: "90", valor: 0 }], transporte: { modalidade: 9 },
    informacoesComplementares: `Devolução de venda referente à NF-e nº ${emission.number}, série ${emission.series}, chave ${emission.access_key}.`,
    ...(original.serie !== undefined ? { serie: original.serie } : {}),
    ...(original.responsavelTecnico ? { responsavelTecnico: original.responsavelTecnico } : {}),
  };
  return { body, items: views, total };
}

registerRpc("erp_com1_return_prepare", (ctx, a) => {
  const value = input(a, ["emission_id", "command_id", "items", "finance_option"], ["emission_id", "command_id", "items", "finance_option"]);
  requireCom1Access(ctx, "emit", person(a));
  com1Uuid(value.command_id);
  if (!["credito", "pagar"].includes(String(value.finance_option))) return invalid("nfe_return_finance_option_invalid");
  if (!Array.isArray(value.items) || !value.items.length || value.items.length > 990) return invalid("nfe_return_items_required");
  const chosen = (value.items as ReturnItemInput[]).map(raw => {
    const entry = object(raw);
    if (Object.keys(entry).some(key => !["item", "quantity"].includes(key)) || !Number.isInteger(entry.item) || Number(entry.item) < 0) return invalid("nfe_return_item_invalid");
    return { item: Number(entry.item), quantity: qty(entry.quantity) };
  }).filter(choice => choice.quantity > 0n);
  if (!chosen.length) return invalid("nfe_return_items_required");
  if (new Set(chosen.map(choice => choice.item)).size !== chosen.length) return invalid("nfe_return_item_invalid");
  const emission = orderEmission(ctx, value.emission_id, "emit");
  const argsHash = com1Hash({ emission_id: emission.id, items: chosen.map(c => ({ item: c.item, quantity: c.quantity.toString() })), finance_option: value.finance_option });
  const previous = one(ctx.db, `${selectReturn} WHERE command_id=?`, value.command_id);
  if (previous) {
    const row = returnRow(previous);
    if (row.emission_id !== emission.id || com1Hash({ emission_id: row.emission_id, items: row.items.map(i => ({ item: i.item, quantity: toScaled(i.quantity, QTY).toString() })),
      finance_option: row.finance_option }) !== argsHash) raise("40001", "fiscal_command_conflict");
    return row;
  }
  const view = eventsView(ctx, emission);
  if (!view.rules.return.allowed) raise("55000", view.rules.return.code ?? "nfe_return_not_allowed");
  if (!emission.access_key || !emission.connection_fingerprint) raise("55000", "nfe_not_authorized");
  for (const choice of chosen) {
    const line = view.lines[choice.item];
    if (!line) return invalid("nfe_return_item_invalid");
    if (choice.quantity > toScaled(line.remaining, QTY)) raise("55000", "nfe_return_quantity_exceeded");
  }
  const id = randomUUID(), reference = `wb.${id}.v1`, built = buildReturnBody(emission, chosen.sort((x, y) => x.item - y.item), reference);
  const bodyText = com1Json(built.body), at = now(ctx);
  ctx.db.exec(`INSERT INTO ${T.return} (id,emission_id,command_id,person_id,environment,connection_fingerprint,reference,items,finance_option,body,body_hash,total,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, emission.id, value.command_id, ctx.identity.actor!.user_id, emission.environment, emission.connection_fingerprint, reference,
    com1Json(built.items), value.finance_option, bodyText, com1Sha256(bodyText), built.total.toString(), "preparada", at, at);
  return getReturn(ctx, id);
});

export interface ReturnClaim {
  disposition: "send" | "resume" | "replay";
  return: ReturnView;
  /** Corpo exato persistido (o mesmo em toda tentativa). */
  body_text: string;
  emission: CorrectionClaim["emission"];
}
registerRpc("erp_com1_return_claim", (ctx, a) => {
  const value = input(a, ["return_id", "command_id"], ["return_id", "command_id"]);
  requireCom1Access(ctx, "emit", person(a));
  com1Uuid(value.return_id); com1Uuid(value.command_id);
  const current = getReturn(ctx, String(value.return_id));
  const emission = orderEmission(ctx, current.emission_id, "emit");
  const row = one(ctx.db, `SELECT body,body_hash FROM ${T.return} WHERE id=?`, current.id)!;
  if (com1Sha256(text(row.body)) !== row.body_hash) raise("55000", "com1_persisted_request_invalid");
  const result = (disposition: ReturnClaim["disposition"], view = current): ReturnClaim => ({ disposition, return: view, body_text: text(row.body), emission: emissionIdentity(emission) });
  if (["autorizada", "denegada", "cancelada"].includes(current.status)) return result("replay");
  if (["enviando", "processando", "incerta"].includes(current.status)) return result("resume");
  // Preparada ou rejeitada: envia (a referência rejeitada aceita o mesmo pedido de novo).
  if (emission.status !== "autorizada") raise("55000", emission.status === "cancelada" ? "nfe_return_cancelled" : "nfe_not_authorized");
  ctx.db.exec(`UPDATE ${T.return} SET status='enviando',updated_at=? WHERE id=?`, now(ctx), current.id);
  return result("send", getReturn(ctx, current.id));
});

const RETURN_STATUS: Record<string, ReturnStatus> = {
  authorized: "autorizada", rejected: "rejeitada", error: "rejeitada", denied: "denegada", processing: "processando",
  undetermined: "incerta", contingency: "incerta", cancelled: "cancelada",
};
registerRpc("erp_com1_return_record", (ctx, a) => {
  const value = input(a, ["return_id", "command_id", "result", "error"], ["return_id", "command_id", "result"]);
  requireCom1Access(ctx, "emit", person(a));
  com1Uuid(value.return_id);
  const current = getReturn(ctx, String(value.return_id));
  orderEmission(ctx, current.emission_id, "emit");
  const result = withCom1Model("nfe", () => normalizeCommercialResult(value.result));
  // O resultado precisa ser desta devolução: mesma referência e ambiente.
  if (result && (result.reference !== current.reference || result.environment !== current.environment)) raise("40001", "fiscal_result_mismatch");
  if (["autorizada", "cancelada", "denegada"].includes(current.status)) {
    // Aviso repetido do cofre: nada muda (nem os efeitos).
    if (result && current.provider_id && result.provider_ref !== current.provider_id) raise("40001", "fiscal_result_mismatch");
    if (current.status === "autorizada" && result?.status === "cancelled")
      ctx.db.exec(`UPDATE ${T.return} SET status='cancelada',updated_at=? WHERE id=?`, now(ctx), current.id);
    return getReturn(ctx, current.id);
  }
  const at = now(ctx);
  if (!result) {
    const error = object(value.error);
    ctx.db.exec(`UPDATE ${T.return} SET status=?,messages=?,updated_at=? WHERE id=?`,
      error.conclusive === true ? "rejeitada" : "incerta",
      com1Json(error.message ? [{ code: text(error.code).slice(0, 100), description: text(error.message).slice(0, 2000) }] : []), at, current.id);
    return getReturn(ctx, current.id);
  }
  const status = RETURN_STATUS[result.status] ?? "incerta";
  const authorized = status === "autorizada" && result.access_key && result.protocol && result.number > 0 && /^\d{1,3}$/.test(result.series);
  ctx.db.exec(`UPDATE ${T.return} SET status=?,provider_id=?,series=?,number=?,access_key=?,protocol=?,authorized_at=?,messages=?,updated_at=? WHERE id=?`,
    authorized || status !== "autorizada" ? status : "incerta", result.provider_ref, result.series ? Number(result.series) : null, result.number || null,
    result.access_key, result.protocol, micros(result.authorized_at), com1Json(messages(result.messages)), at, current.id);
  return getReturn(ctx, current.id);
});

/** Savepoint local: falha no lançamento desfaz só ele; o estado pendente com o motivo fica. */
function localTransaction<V>(ctx: RpcContext, run: () => V): V {
  const start = ctx.deferred.length;
  try { return ctx.db.transaction(() => { const result = run(); while (ctx.deferred.length > start) ctx.deferred.splice(start, 1)[0](); return result; }); }
  catch (error) { ctx.deferred.splice(start); throw error; }
}
const reasonOf = (error: unknown): string => {
  const converted = fromSqlite(error);
  return converted.code === "XX000" ? "nfe_return_local_failure" : converted.message.slice(0, 160);
};
function saveEffect(ctx: RpcContext, id: string, axis: "stock" | "finance", state: "pendente" | "aplicado" | "pulado", result: JsonObject) {
  // Só sai de "aplicado" quem nunca entrou: a condição protege o aviso repetido.
  ctx.db.exec(`UPDATE ${T.return} SET ${axis}_state=?,${axis}_result=?,updated_at=? WHERE id=? AND ${axis}_state<>'aplicado'`,
    state, com1Json(result), now(ctx), id);
}
const effectAccess = (ctx: RpcContext, axis: "stock" | "finance"): boolean => {
  try { requireCom1Access(ctx, axis === "stock" ? "effect_stock" : "effect_finance"); return true; }
  catch (error) { if (error instanceof ErpError && error.code === "42501") return false; throw error; }
};

function applyStock(ctx: RpcContext, ret: ReturnView, emission: EmissionView): void {
  const effect = emission.effects.find(e => e.axis === "stock");
  const movement = effect && ["aplicado", "reconhecido"].includes(effect.state) ? text(effect.ids.movement_id) : "";
  if (!movement) {
    saveEffect(ctx, ret.id, "stock", "pulado", { reason: "sale_without_stock_posting",
      explanation: "A venda não baixou o estoque pelo ERP; não há o que devolver ao estoque. Se a mercadoria voltou, lance a entrada pela tela de estoque." });
    return;
  }
  const lines = new Map<string, { product_id: string; warehouse_id: string; quantity: bigint }>();
  // Produto de cada item como na baixa da venda (effects.ts, bodyItems): corpo do pedido congelado ou itens do retrato.
  const document = object(emission.revision.snapshot.document), frozen = document.body != null ? object(typeof document.body === "string" ? JSON.parse(document.body) : document.body) : document;
  const documentItems = (Array.isArray(frozen.items) ? frozen.items as unknown[] : emission.revision.snapshot.items).map(object)
    .map(item => item.data != null ? { ...object(item.data), product_id: item.product_id ?? object(item.data).product_id } : item);
  for (const choice of ret.items) {
    const product = text(object(documentItems[choice.item]).product_id);
    const entry = product ? one(ctx.db, "SELECT product_id,warehouse_id FROM erp_stock__entry WHERE movement_id=? AND product_id=? LIMIT 1", movement, product) : null;
    if (!entry) { saveEffect(ctx, ret.id, "stock", "pendente", { reason: "nfe_return_stock_position_missing", item: choice.item }); return; }
    const key = `${entry.product_id}|${entry.warehouse_id}`, quantity = toScaled(choice.quantity, 6);
    const line = lines.get(key) ?? { product_id: text(entry.product_id), warehouse_id: text(entry.warehouse_id), quantity: 0n };
    line.quantity += quantity; lines.set(key, line);
  }
  const command = derivedUuid(`nfe-return:${ret.id}:stock`);
  const args: RpcArgs = { p_user_id: ctx.identity.actor!.user_id, p_command_id: command, p_kind: "receipt", p_occurred_on: todaySaoPaulo(Number(ctx.clock.next() / 1000n)),
    p_reason: `Devolução de venda: NF-e nº ${ret.number} (referente à NF-e nº ${emission.number})`,
    p_reference: `NF-e devolução ${ret.number}/${ret.series}`.slice(0, 100),
    p_items: [...lines.values()].map(line => ({ product_id: line.product_id, warehouse_id: line.warehouse_id, quantity: formatScaled(line.quantity, 6),
      expected_version: Number(one(ctx.db, "SELECT version FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", line.product_id, line.warehouse_id)?.version ?? 0) })) };
  try {
    localTransaction(ctx, () => {
      const posted = object(invokeRpc(ctx, "erp_stock_post", args));
      saveEffect(ctx, ret.id, "stock", "aplicado", { movement_id: text(object(posted.movement).id), local_command_id: command,
        lines: [...lines.values()].map(line => ({ product_id: line.product_id, warehouse_id: line.warehouse_id, quantity: formatScaled(line.quantity, 6) })) });
    });
  } catch (error) { saveEffect(ctx, ret.id, "stock", "pendente", { reason: reasonOf(error) }); }
}

function applyFinance(ctx: RpcContext, ret: ReturnView, emission: EmissionView): void {
  const effect = emission.effects.find(e => e.axis === "finance");
  const ids = effect && ["aplicado", "reconhecido"].includes(effect.state) && Array.isArray(effect.ids.title_ids) ? effect.ids.title_ids.map(String) : [];
  if (!ids.length) {
    saveEffect(ctx, ret.id, "finance", "pulado", { reason: "sale_without_receivables",
      explanation: "A venda não gerou contas a receber pelo ERP; nada foi abatido. Se o cliente pagou por fora, combine o acerto no Financeiro." });
    return;
  }
  const titles = ids.map(id => one(ctx.db, "SELECT id,version,contact_id,account_id,due_on,CAST(amount_cents AS TEXT) amount_cents,CAST(settled_cents AS TEXT) settled_cents,cancelled FROM erp_finance__title WHERE id=?", id))
    .filter((t): t is Row => !!t).sort((x, y) => text(y.due_on).localeCompare(text(x.due_on)));
  const contact = text(titles[0]?.contact_id);
  const day = todaySaoPaulo(Number(ctx.clock.next() / 1000n)), user = ctx.identity.actor!.user_id;
  const label = `NF-e de devolução nº ${ret.number} (venda NF-e nº ${emission.number})`;
  let remaining = BigInt(ret.total);
  const abated: JsonObject[] = [];
  try {
    localTransaction(ctx, () => {
      for (const [index, title] of titles.entries()) {
        if (remaining <= 0n) break;
        if (Number(title.cancelled)) continue;
        const open = BigInt(text(title.amount_cents)) - BigInt(text(title.settled_cents));
        if (open <= 0n) continue;
        const part = open < remaining ? open : remaining;
        const own = text(title.account_id), active = own ? one(ctx.db, "SELECT id FROM erp_finance__account WHERE id=? AND active=1", own) : null;
        const account = text(active?.id ?? one(ctx.db, "SELECT id FROM erp_finance__account WHERE active=1 ORDER BY id LIMIT 1")?.id ?? "");
        if (!account) raise("55000", "nfe_return_finance_account_missing");
        // Abatimento sem dinheiro: baixa do principal com desconto igual (caixa líquido zero).
        invokeRpc(ctx, "erp_finance_execute", { p_user_id: user, p_command_id: derivedUuid(`nfe-return:${ret.id}:finance:abate:${index}`), p_action: "settle",
          p_data: { id: text(title.id), expected_version: Number(title.version), account_id: account, posted_on: day, principal_cents: part.toString(),
            discount_cents: part.toString(), note: `Abatimento por devolução: ${label}`.slice(0, 500) } });
        abated.push({ title_id: text(title.id), amount_cents: part.toString() });
        remaining -= part;
      }
      let payable: JsonObject | null = null;
      if (remaining > 0n) {
        // O que o cliente já pagou: crédito do cliente ou conta a pagar de devolução (escolha da tela).
        const credit = ret.finance_option === "credito";
        const created = object(invokeRpc(ctx, "erp_finance_execute", { p_user_id: user, p_command_id: derivedUuid(`nfe-return:${ret.id}:finance:payable`),
          p_action: "title_create_group", p_data: { kind: "payable", contact_id: contact, category_id: null,
            description: (credit ? `Crédito do cliente: ${label}` : `Devolução a pagar ao cliente: ${label}`).slice(0, 240),
            source_reference: `${credit ? "credito-devolucao" : "devolucao"}:${ret.id}`, issued_on: day, total_cents: remaining.toString(),
            installments: [{ amount_cents: remaining.toString(), due_on: day }] } }));
        payable = { kind: credit ? "credito" : "pagar", amount_cents: remaining.toString(),
          title_ids: Array.isArray(created.items) ? created.items.map(item => text(object(item).id)) : [] };
      }
      saveEffect(ctx, ret.id, "finance", "aplicado", { abated, payable, total_cents: ret.total });
    });
  } catch (error) { saveEffect(ctx, ret.id, "finance", "pendente", { reason: reasonOf(error) }); }
}

registerRpc("erp_com1_return_effects", (ctx, a) => {
  const value = input(a, ["return_id", "command_id", "axis"], ["return_id", "command_id", "axis"]);
  requireCom1Access(ctx, "emit", person(a));
  com1Uuid(value.return_id); com1Uuid(value.command_id);
  const axis = value.axis === "stock" ? "stock" : value.axis === "finance" ? "finance" : invalid();
  const ret = getReturn(ctx, String(value.return_id));
  const emission = orderEmission(ctx, ret.emission_id, "read");
  if (ret.status !== "autorizada") raise("55000", "nfe_return_not_authorized");
  // Aviso repetido do cofre (ou clique duplo): o efeito aplicado não se repete.
  if (ret[axis].state === "aplicado") return ret;
  if (!ctx.parts[axis]) { saveEffect(ctx, ret.id, axis, "pendente", { reason: "part_disabled" }); return getReturn(ctx, ret.id); }
  if (!effectAccess(ctx, axis)) { saveEffect(ctx, ret.id, axis, "pendente", { reason: "local_role_required", responsible_role: axis === "stock" ? "estoque" : "financeiro" }); return getReturn(ctx, ret.id); }
  if (axis === "stock") applyStock(ctx, ret, emission); else applyFinance(ctx, ret, emission);
  return getReturn(ctx, ret.id);
});

/** Leitura da devolução e da nota de origem (para o serviço baixar o DANFE da devolução). */
registerRpc("erp_com1_return_get", (ctx, a) => {
  const value = input(a, ["return_id"], ["return_id"]);
  requireCom1Access(ctx, "read", person(a));
  com1Uuid(value.return_id);
  const ret = getReturn(ctx, String(value.return_id));
  const emission = orderEmission(ctx, ret.emission_id, "read");
  return { return: ret, emission: emissionIdentity(emission) };
});
export { ORDER as NFE_ORDER_TABLES };
