/** Fatia B2: propostas, pedidos e contas do acervo do Bling.
 *
 * Em aberto: viram documento ou título do ERP pelas RPCs das telas
 * (erp_document_save, erp_document_transition só nas propostas,
 * erp_finance_title_execute), ligados aos cadastros já adotados na B1. Entram
 * no estado equivalente sem efeitos: não baixa estoque, não gera contas, não
 * emite nota; se a RPC produzir qualquer efeito, a transação é desfeita e o
 * registro vira pendência. Encerrados: só um índice no espelho histórico; o
 * documento como veio continua no acervo. Nada é escrito no Bling. */
import { formatScaled, fromColumn } from "../engine/dec.ts";
import type { SqlDriver } from "../engine/driver.ts";
import { ErpError } from "../engine/errors.ts";
import { invokeRpc, type RpcContext } from "../engine/registry.ts";
import { todaySaoPaulo } from "../engine/time.ts";
import { preference } from "../domains/documents/internal.ts";
import { normalize } from "../domains/documents/normalize.ts";
import { numberEditable } from "../domains/documents/save-checks.ts";
import {
  BLING_ADOPTION_SINGULAR, BLING_HISTORY_READONLY, BLING_HISTORY_SCOPES, BlingAdoptionError, isAdoptionAccount,
  type BlingAdoptionB2Entity, type BlingAdoptionHistoryDocument, type BlingAdoptionHistoryItem, type BlingAdoptionMissing,
  type BlingAdoptionOperationMap, type BlingAdoptionReason, type BlingAdoptionRecordEntity, type BlingAdoptionSummary, type BlingHistoryScope,
} from "./adoption-contracts.ts";
import { blingAccountSituation, blingDocumentSituation, type BlingDocumentEntity } from "./adoption-situations.ts";
import {
  at, clip, commandUuid, fold, linkOf, linkedTo, object, readRaw, reviewOf, sourceOf, text, writeLink, writeReview,
  type AdoptionRaw, type Json,
} from "./adoption-store.ts";

export type B2Outcome = "adopted" | "linked" | "pending" | "skipped" | "history";
export interface B2Step { entity: BlingAdoptionB2Entity; raw: AdoptionRaw; actor: string; now: number }

// ---------------------------------------------------------------------------
// Valores do Bling

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
/** Decimal lexical do acervo: texto, null quando ausente, false quando inválido. */
function decimal(v: unknown): string | null | false {
  const t = text(v);
  if (t === null) return null;
  if (DECIMAL.test(t)) return t;
  const n = Number(t);
  return /^-?\d+(\.\d+)?e[+-]?\d+$/i.test(t) && Number.isFinite(n) && Math.abs(n) < 1e15 ? String(n) : false;
}
/** Centavos exatos (até duas casas); null ausente, false inválido. */
export function centsOf(v: unknown): bigint | null | false {
  const d = decimal(v);
  if (d === null || d === false) return d;
  const [whole, fraction = ""] = d.replace("-", "").split(".");
  if (fraction.replace(/0+$/, "").length > 2) return false;
  const cents = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return d.startsWith("-") ? -cents : cents;
}
export const money = (cents: bigint | null) => cents === null ? null : `R$ ${formatScaled(cents, 2).replace(".", ",")}`;
export function dateOf(v: unknown): string | null {
  const t = text(v)?.slice(0, 10) ?? null;
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t) || t.startsWith("0000")) return null;
  const d = new Date(t + "T12:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : null;
}
/** Texto de várias linhas (observações), sem caracteres de controle. */
export function multiline(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return t ? clip(t, max) : null;
}
const numberOf = (entity: BlingAdoptionB2Entity, p: Json) => clip(text(isAdoptionAccount(entity) ? p.numeroDocumento ?? p.numero : p.numero), 80);
const contactRef = (entity: BlingAdoptionB2Entity, p: Json) => entity === "purchase_orders" ? p.fornecedor ?? p.contato : p.contato;
const items = (p: Json) => Array.isArray(p.itens) ? p.itens.filter(object) : [];
const parcels = (p: Json) => Array.isArray(p.parcelas) ? p.parcelas.filter(object) : [];

// ---------------------------------------------------------------------------
// Classificação: em aberto, encerrado (histórico) ou desconhecido

interface Classified { scope: "open" | "history" | "unknown"; history: BlingHistoryScope | null; label: string; native: string | null }
export function classifyB2(entity: BlingAdoptionB2Entity, raw: AdoptionRaw): Classified {
  if (raw.deleted) return { scope: "history", history: "deleted", label: "Excluído", native: null };
  if (isAdoptionAccount(entity)) {
    const amount = centsOf(raw.payload.valor), balance = centsOf(raw.payload.saldo);
    const s = blingAccountSituation(raw.payload, typeof amount === "bigint" ? amount : null, typeof balance === "bigint" ? balance : null);
    return s.scope === "open" ? { scope: "open", history: null, label: s.label, native: null }
      : s.scope === "unknown" ? { scope: "unknown", history: null, label: s.label, native: null }
      : { scope: "history", history: s.scope, label: s.label, native: null };
  }
  const s = blingDocumentSituation(entity as BlingDocumentEntity, raw.payload);
  return s.scope === "open" ? { scope: "open", history: null, label: s.label, native: s.native }
    : s.scope === "closed" ? { scope: "history", history: s.history, label: s.label, native: null }
    : { scope: "unknown", history: null, label: s.label, native: null };
}

// ---------------------------------------------------------------------------
// Espelho histórico

function historyTotal(entity: BlingAdoptionB2Entity, p: Json): bigint | null {
  const v = centsOf(isAdoptionAccount(entity) ? p.valor : p.total ?? p.totalProdutos);
  return typeof v === "bigint" && v < 999999999999999n && v > -999999999999999n ? v : null;
}
const issuedOf = (entity: BlingAdoptionB2Entity, p: Json) => isAdoptionAccount(entity) ? dateOf(p.vencimento) ?? dateOf(p.dataEmissao) : dateOf(p.data);
function writeHistory(db: SqlDriver, entity: BlingAdoptionB2Entity, raw: AdoptionRaw, scope: BlingHistoryScope, label: string, now: number) {
  const p = raw.payload, number = numberOf(entity, p), contact = clip(text(at(contactRef(entity, p), "nome")), 200);
  const search = clip([number, contact, raw.source_id].filter(Boolean).map(v => fold(v)).join(" "), 400) ?? "";
  db.exec(`INSERT INTO wb_bling_adoption_history(entity,source_id,scope,situation,number,contact_name,issued_on,total_cents,search,source_version,source_hash,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entity,source_id) DO UPDATE SET scope=excluded.scope, situation=excluded.situation, number=excluded.number,
    contact_name=excluded.contact_name, issued_on=excluded.issued_on, total_cents=excluded.total_cents, search=excluded.search, source_version=excluded.source_version,
    source_hash=excluded.source_hash, recorded_at=excluded.recorded_at`,
    entity, raw.source_id, scope, clip(label, 120), number, contact, issuedOf(entity, p), historyTotal(entity, p)?.toString() ?? null, search, raw.version, raw.hash, now);
  // Encerrado no Bling: sai das pendências (não há o que decidir).
  db.exec("DELETE FROM wb_bling_adoption_doc_review WHERE entity=? AND source_id=?", entity, raw.source_id);
}
const historyVersion = (db: SqlDriver, entity: string, source: string) => {
  const r = db.exec("SELECT source_version FROM wb_bling_adoption_history WHERE entity=? AND source_id=?", entity, source).rows[0];
  return r ? Number(r.source_version) : null;
};

// ---------------------------------------------------------------------------
// Do Bling para os dados das RPCs

export interface B2Mapped {
  missing: BlingAdoptionMissing[];
  blocked: { reason: BlingAdoptionReason; detail: string } | null;
  /** p_body do erp_document_save ou p_data do title_create. */
  data: Json;
  contact_id: string | null;
  number: string | null;
}
function missingState(db: SqlDriver, entity: BlingAdoptionRecordEntity, source: string): BlingAdoptionMissing["state"] {
  const review = reviewOf(db, entity, source);
  if (review) return review.state === "ignored" ? "ignored" : "pending";
  return db.exec("SELECT 1 AS x FROM origin_sync__raw_record WHERE entity=? AND source_id=?", entity, source).rows.length ? "waiting" : "absent";
}
function need(db: SqlDriver, missing: BlingAdoptionMissing[], entity: BlingAdoptionRecordEntity, ref: unknown, label: string | null): string | null {
  const source = sourceOf(ref);
  if (!source) return null;
  const link = linkOf(db, entity, source)?.record_id ?? null;
  if (!link && !missing.some(m => m.entity === entity && m.source_id === source))
    missing.push({ entity, source_id: source, label: clip(label ?? text(at(ref, "nome")) ?? text(at(ref, "descricao")), 200), state: missingState(db, entity, source) });
  return link;
}
const optional = (db: SqlDriver, entity: BlingAdoptionRecordEntity, ref: unknown) => { const s = sourceOf(ref); return s ? linkOf(db, entity, s)?.record_id ?? null : null; };

function mapDocument(db: SqlDriver, entity: BlingDocumentEntity, raw: AdoptionRaw, situation: string): B2Mapped {
  const p = raw.payload, missing: BlingAdoptionMissing[] = [], notes: string[] = [];
  let blocked: B2Mapped["blocked"] = null;
  const bad = (detail: string) => { blocked ??= { reason: "invalid_data", detail }; };
  const ref = contactRef(entity, p);
  const contact = need(db, missing, "contacts", ref, text(at(ref, "nome")));
  if (!sourceOf(ref)) bad(entity === "purchase_orders" ? "O pedido de compra no Bling está sem fornecedor." : "O documento no Bling está sem contato.");
  const lines: Json[] = [];
  items(p).forEach((it, index) => {
    const productRef = it.produto, description = clip(text(it.descricao) ?? text(at(productRef, "nome")) ?? text(it.codigo) ?? `Item ${index + 1}`, 200);
    const product = need(db, missing, "products", productRef, description);
    const quantity = decimal(it.quantidade), price = decimal(it.valor ?? it.preco), discount = decimal(it.desconto);
    if (quantity === false || quantity === null || price === false || price === null || discount === false) { bad(`Quantidade, valor ou desconto inválido no item ${index + 1} (${clip(description, 60)}).`); return; }
    const line: Json = { description, unit: clip(text(it.unidade) ?? "UN", 16), quantity, unit_price: price };
    const code = clip(text(it.codigo) ?? text(at(productRef, "codigo")), 100);
    if (code) line.code = code;
    if (product) line.product_id = product;
    if (discount !== null && discount !== "0" && entity !== "purchase_orders") line.discount_percent = discount;
    const detailed = multiline(it.descricaoDetalhada, 4000);
    if (detailed) line.detailed_description = detailed;
    if (entity === "purchase_orders" && text(it.codigoFornecedor)) line.supplier_code = clip(text(it.codigoFornecedor), 100);
    lines.push(line);
  });
  if (!items(p).length) bad("O documento no Bling está sem itens.");
  const body: Json = { date: dateOf(p.data) ?? todaySaoPaulo(), contact_id: contact, items: lines };
  const expected = dateOf(p.dataPrevista);
  if (expected && entity !== "sales_proposals") body.expected_date = expected;
  if (entity === "sales_proposals") {
    const next = dateOf(p.dataProximoContato);
    if (next) body.next_contact = next;
  }
  const discountRaw = p.desconto;
  const discountValue = decimal(object(discountRaw) ? discountRaw.valor : discountRaw);
  if (discountValue === false) bad("Desconto do documento inválido.");
  else if (discountValue && discountValue !== "0") {
    const percent = object(discountRaw) && /^perc/i.test(text(discountRaw.unidade) ?? "");
    body.discount_mode = percent ? "percent" : "amount";
    body.discount_value = discountValue;
  }
  const freight = decimal(at(p, "transporte", "frete") ?? p.frete), other = decimal(p.outrasDespesas);
  if (freight === false || other === false) bad("Frete ou outras despesas inválidos.");
  if (freight && freight !== "0") body.freight = freight;
  if (other && other !== "0") body.other_expenses = other;
  const sellerSource = sourceOf(p.vendedor);
  if (sellerSource && entity !== "purchase_orders") {
    const seller = optional(db, "sellers", p.vendedor);
    if (seller) body.seller_id = seller;
    else notes.push(`Vendedor do Bling (id ${sellerSource}) ainda não adotado: escolha o vendedor no ERP.`);
  }
  const installments: Json[] = [];
  for (const [index, parcel] of parcels(p).entries()) {
    const amount = decimal(parcel.valor), due = dateOf(parcel.dataVencimento);
    if (!amount || amount.startsWith("-") || amount === "0" || !due) { notes.push(`A parcela ${index + 1} do Bling está sem valor ou vencimento válido: refaça as parcelas no ERP.`); installments.length = 0; break; }
    const item: Json = { due_date: due, amount };
    const note = multiline(parcel.observacoes ?? parcel.observacao, 2000);
    if (note) item.note = note;
    const method = sourceOf(parcel.formaPagamento);
    if (method) {
      const adopted = optional(db, "payment_methods", parcel.formaPagamento);
      if (adopted) item.payment_method_id = adopted;
      else notes.push(`Forma de pagamento do Bling (id ${method}) ainda não adotada: confira as parcelas no ERP.`);
    }
    installments.push(item);
  }
  if (installments.length) body.installments = installments;
  const observations = multiline(p.observacoes, 4000);
  if (observations) body.notes = observations;
  const number = text(p.numero);
  if (number && /^[1-9]\d{0,9}$/.test(number) && numberEditable(db, entity)) body.number = number;
  // Conferência com as contas do ERP (função pura do domínio): parcelas que não
  // fecham com o total saem, com aviso; diferença de total fica anotada.
  if (!blocked && contact && !missing.length) {
    try {
      const probe: Json = { ...body };
      delete probe.number;
      const totals = normalize(entity, probe).totals as Json;
      const bling = decimal(p.total);
      if (bling && typeof totals.total === "string" && centsOf(bling) !== centsOf(totals.total))
        notes.push(`Total no Bling: ${money(centsOf(bling) as bigint)}; calculado pelo ERP: ${money(centsOf(totals.total) as bigint)} (impostos e arredondamentos do Bling não entram).`);
    } catch (error) {
      if (error instanceof ErpError && error.message === "erp_document_installment_total_mismatch") {
        delete body.installments;
        notes.push("As parcelas do Bling não fecham com o total calculado pelo ERP: refaça as parcelas no ERP.");
      }
    }
  }
  const internal = [`Adotado do Bling: ${BLING_ADOPTION_SINGULAR[entity]} nº ${number ?? "sem número"} (id ${raw.source_id}), situação no Bling: ${situation}.`, ...notes, multiline(p.observacoesInternas ?? p.observacaoInterna, 3000)].filter(Boolean).join("\n");
  body.internal_notes = clip(internal, 4000);
  return { missing, blocked, data: body, contact_id: contact, number };
}

export function mapAccount(db: SqlDriver, entity: "receivables" | "payables", raw: AdoptionRaw): B2Mapped {
  const p = raw.payload, missing: BlingAdoptionMissing[] = [];
  let blocked: B2Mapped["blocked"] = null;
  const bad = (detail: string) => { blocked ??= { reason: "invalid_data", detail }; };
  const kind = entity === "receivables" ? "receivable" : "payable";
  const contact = need(db, missing, "contacts", p.contato, null);
  if (!sourceOf(p.contato)) bad("A conta no Bling está sem contato.");
  const category = need(db, missing, "financial_categories", p.categoria, null);
  const method = need(db, missing, "payment_methods", p.formaPagamento, null);
  const amount = centsOf(p.valor);
  if (typeof amount !== "bigint" || amount <= 0n || amount > 999999999999999n) bad("O valor da conta no Bling não é válido.");
  const due = dateOf(p.vencimento), issued = dateOf(p.dataEmissao) ?? due, competence = dateOf(p.competencia) ?? issued;
  if (!due) bad("A conta no Bling está sem vencimento válido.");
  const number = clip(text(p.numeroDocumento), 150);
  const description = clip(multiline(p.historico, 2000)?.replace(/\s+/g, " ") ?? `${BLING_ADOPTION_SINGULAR[entity][0].toUpperCase()}${BLING_ADOPTION_SINGULAR[entity].slice(1)} do Bling${number ? ` nº ${number}` : ""}`, 2000)!;
  const data: Json = {
    kind, contact_id: contact, category_id: category, payment_method_id: method, description,
    source_reference: clip(number ? `${number} (Bling ${raw.source_id})` : `Bling ${raw.source_id}`, 200),
    issued_on: issued, competence_on: competence, total_cents: typeof amount === "bigint" ? amount.toString() : null,
    installments: [{ amount_cents: typeof amount === "bigint" ? amount.toString() : null, due_on: due }],
  };
  const account = optional(db, "ledger_accounts", p.portador);
  if (account) data.account_id = account;
  if (entity === "receivables") { const seller = optional(db, "sellers", p.vendedor); if (seller) data.seller_id = seller; }
  return { missing, blocked, data, contact_id: contact, number };
}

// ---------------------------------------------------------------------------
// Registros do ERP (resumo, existência, duplicados e ausência de efeitos)

const DOC_STATUS: Record<string, string> = { draft: "Rascunho / em digitação", open: "Em aberto", pending: "Pendente", waiting: "Aguardando", approved: "Aprovado",
  rejected: "Não aprovado", cancelled: "Cancelado", completed: "Concluído", verified: "Verificado", in_progress: "Em andamento", fulfilled: "Atendido", partially_fulfilled: "Atendido parcialmente" };
export function erpSummaryB2(db: SqlDriver, entity: BlingAdoptionB2Entity, id: string): BlingAdoptionSummary | null {
  const s = (v: unknown) => v === null || v === undefined ? null : clip(String(v), 400);
  if (isAdoptionAccount(entity)) {
    const r = db.exec(`SELECT t.description, t.source_reference, t.due_on, t.amount_cents, c.name FROM erp_finance__title t LEFT JOIN erp_catalog__record c ON c.id=t.contact_id WHERE t.id=?`, id).rows[0];
    return r ? { "Nome": s(r.description), "Contato": s(r.name), "Vencimento": s(r.due_on), "Valor": money(BigInt(String(r.amount_cents ?? 0))), "Documento": s(r.source_reference) } : null;
  }
  const r = db.exec(`SELECT d.number, d.status, d.total, json_extract(d.body,'$.date') AS date, c.name FROM erp_documents__document d LEFT JOIN erp_catalog__record c ON c.id=d.contact_id WHERE d.id=?`, id).rows[0];
  return r ? { "Nome": `${BLING_ADOPTION_SINGULAR[entity]} nº ${r.number ?? "—"}`, "Contato": s(r.name), "Data": s(r.date),
    "Total": r.total === null || r.total === undefined ? null : money(fromColumn(r.total)), "Situação": DOC_STATUS[String(r.status)] ?? s(r.status) } : null;
}
export function blingSummaryB2(entity: BlingAdoptionB2Entity, raw: AdoptionRaw): BlingAdoptionSummary {
  const p = raw.payload, situation = classifyB2(entity, raw).label, number = numberOf(entity, p);
  const total = historyTotal(entity, p);
  if (isAdoptionAccount(entity))
    return { "Nome": clip(multiline(p.historico, 400)?.replace(/\s+/g, " ") ?? null, 400), "Contato": clip(text(at(p.contato, "nome")), 400), "Vencimento": dateOf(p.vencimento),
      "Valor": money(total), "Documento": number, "Situação": situation };
  return { "Nome": `${BLING_ADOPTION_SINGULAR[entity]} nº ${number ?? "—"}`, "Contato": clip(text(at(contactRef(entity, p), "nome")), 400), "Data": dateOf(p.data),
    "Total": money(total), "Situação": situation };
}
export function recordExistsB2(db: SqlDriver, entity: BlingAdoptionB2Entity, id: string): boolean {
  const sql = isAdoptionAccount(entity)
    ? "SELECT id FROM erp_finance__title WHERE id=? AND kind=? AND deleted_at IS NULL"
    : "SELECT id FROM erp_documents__document WHERE id=? AND kind=? AND deleted_at IS NULL";
  return db.exec(sql, id, isAdoptionAccount(entity) ? (entity === "receivables" ? "receivable" : "payable") : entity).rows.length > 0;
}
/** Mesmo número e contato (documento) ou mesmo contato, vencimento e valor (conta). */
function duplicates(db: SqlDriver, entity: BlingAdoptionB2Entity, m: B2Mapped): string[] {
  if (!m.contact_id) return [];
  const rows = isAdoptionAccount(entity)
    ? db.exec(`SELECT id FROM erp_finance__title WHERE kind=? AND contact_id=? AND due_on=? AND amount_cents=? AND deleted_at IS NULL AND cancelled=0 ORDER BY id LIMIT 6`,
      entity === "receivables" ? "receivable" : "payable", m.contact_id, (m.data.installments as Json[])[0]?.due_on ?? null, Number(m.data.total_cents)).rows
    : m.number && /^[1-9]\d{0,9}$/.test(m.number) ? db.exec(`SELECT id FROM erp_documents__document WHERE kind=? AND number=? AND contact_id=? AND deleted_at IS NULL ORDER BY id LIMIT 6`, entity, Number(m.number), m.contact_id).rows : [];
  return rows.map(r => String(r.id)).filter(id => !linkedTo(db, entity, id)).slice(0, 5);
}
/** Adotar não pode ter efeito: estoque, contas, reserva ou baixa. */
export function effectsOf(db: SqlDriver, entity: BlingAdoptionB2Entity, id: string): string | null {
  const any = (sql: string) => db.exec(sql, id).rows.length > 0;
  if (isAdoptionAccount(entity))
    return any(`SELECT 1 AS x FROM erp_finance__settlement WHERE title_id=? LIMIT 1`) || any(`SELECT 1 AS x FROM erp_finance__title WHERE id=? AND settled_cents<>0`) ? "a conta foi criada com baixa" : null;
  if (any(`SELECT 1 AS x FROM erp_finance__document_posting WHERE document_id=? AND state='active' LIMIT 1`)) return "as Preferências gerariam contas automaticamente";
  if (any(`SELECT 1 AS x FROM erp_stock__document_posting WHERE document_id=? AND state='active' LIMIT 1`)) return "o estoque seria lançado";
  if (any(`SELECT 1 AS x FROM erp_stock__reservation WHERE document_id=? AND state='active' LIMIT 1`)) return "o estoque seria reservado";
  return null;
}

// ---------------------------------------------------------------------------
// Execução de um registro (sempre dentro de uma transação do motor)

const BLING_ADOPTION_REASONS_EFFECTS = "Adotar agora geraria efeitos no ERP; nada foi criado.";
const resultId = (value: unknown, ...paths: string[][]): string => {
  for (const path of paths) { const v = at(value, ...path); if (typeof v === "string" && v) return v; }
  throw new ErpError("XX000", "erp_bling_adoption_result_without_id");
};

/** Decide um documento ou conta: liga (já adotado), cria, histórico ou pendência.
 * Idempotente pela chave (entidade, id no Bling). `force` vem da pessoa
 * (resolver ou adotar um): revisa de novo e não para em possível duplicado. */
export function adoptB2Record(ctx: RpcContext, step: B2Step, options: { force?: boolean; salt?: string } = {}): { outcome: B2Outcome; record_id: string | null } {
  const { entity, raw, actor, now } = step, db = ctx.db;
  const link = linkOf(db, entity, raw.source_id);
  if (link) return { outcome: "skipped", record_id: link.record_id };
  if (!options.force) {
    const review = reviewOf(db, entity, raw.source_id);
    if (review && (review.state === "ignored" || review.source_version === raw.version)) return { outcome: "skipped", record_id: null };
    if (historyVersion(db, entity, raw.source_id) === raw.version) return { outcome: "skipped", record_id: null };
  }
  const pending = (reason: BlingAdoptionReason, detail: string | null, candidates: string[] = [], missing: BlingAdoptionMissing[] = []) => {
    writeReview(db, entity, raw, reason, candidates, now, detail, missing);
    return { outcome: "pending" as const, record_id: null };
  };
  const situation = classifyB2(entity, raw);
  if (situation.scope === "history") { writeHistory(db, entity, raw, situation.history!, situation.label, now); return { outcome: "history", record_id: null }; }
  if (situation.scope === "unknown") return pending("unknown_situation", `Situação recebida: ${clip(situation.label, 120)}.`);
  const m = isAdoptionAccount(entity) ? mapAccount(db, entity, raw) : mapDocument(db, entity as BlingDocumentEntity, raw, situation.label);
  if (m.missing.length) {
    const names = m.missing.map(x => `${BLING_ADOPTION_SINGULAR[x.entity]} ${x.label ? `"${clip(x.label, 50)}"` : ""} (id ${x.source_id})`.replace(/\s+/g, " "));
    return pending("missing_records", clip(`Falta adotar: ${names.join("; ")}.`, 200), [], m.missing);
  }
  if (m.blocked) return pending(m.blocked.reason, m.blocked.detail);
  if (!options.force) {
    const found = duplicates(db, entity, m);
    if (found.length) return pending("possible_duplicate", null, found);
  }
  // Pedido de compra com "gerar contas a pagar ao incluir" ligado geraria contas.
  if (entity === "purchase_orders" && ctx.parts.finance && preference(db, "compras.automacao_contas_pagar") === true)
    return pending("effects_blocked", "Desligue \"Contas a pagar automáticas\" em Preferências → Compras e tente de novo; depois, se quiser, ligue de novo.");
  const salt = options.salt ?? "create";
  let id: string;
  if (isAdoptionAccount(entity)) {
    const result = invokeRpc(ctx, "erp_finance_title_execute", { p_user_id: actor, p_command_id: commandUuid("bling-adoption-b2", entity, raw.source_id, String(raw.version), salt), p_action: "title_create", p_data: m.data });
    const created = at(result, "items");
    id = resultId(Array.isArray(created) ? created[0] : null, ["id"]);
  } else {
    const result = invokeRpc(ctx, "erp_document_save", { p_user_id: actor, p_kind: entity, p_id: null, p_expected_version: 0,
      p_command_id: commandUuid("bling-adoption-b2", entity, raw.source_id, String(raw.version), salt), p_body: m.data });
    id = resultId(result, ["document", "id"]);
    const native = situation.native;
    if (entity === "sales_proposals" && native && native !== "draft") {
      const version = Number(db.exec('SELECT version FROM "erp_documents__document" WHERE id=?', id).rows[0]?.version ?? 1);
      invokeRpc(ctx, "erp_document_transition", { p_user_id: actor, p_kind: entity, p_id: id, p_expected_version: version,
        p_command_id: commandUuid("bling-adoption-b2-situation", entity, raw.source_id, String(raw.version), salt), p_status: native, p_reason: `Situação vinda do Bling: ${situation.label}` });
    }
  }
  const effect = effectsOf(db, entity, id);
  if (effect) throw new BlingAdoptionError("BLING_ADOPTION_RECORD_REFUSED", `${BLING_ADOPTION_REASONS_EFFECTS} Motivo: ${effect}.`);
  writeLink(db, entity, raw, id, "created", actor, now);
  db.exec("DELETE FROM wb_bling_adoption_history WHERE entity=? AND source_id=?", entity, raw.source_id);
  return { outcome: "adopted", record_id: id };
}

// ---------------------------------------------------------------------------
// Consultas do histórico

const scopeText = (scope: BlingHistoryScope) => BLING_HISTORY_SCOPES[scope];
function historyItem(r: Record<string, unknown>): BlingAdoptionHistoryItem {
  const scope = String(r.scope) as BlingHistoryScope;
  return { entity: r.entity as BlingAdoptionB2Entity, source_id: String(r.source_id), number: r.number == null ? null : String(r.number),
    contact_name: r.contact_name == null ? null : String(r.contact_name), issued_on: r.issued_on == null ? null : String(r.issued_on),
    situation: r.situation == null ? null : String(r.situation), scope, scope_text: scopeText(scope),
    total_cents: r.total_cents == null ? null : String(r.total_cents), source_version: String(r.source_version) };
}
export function historyList(db: SqlDriver, input: BlingAdoptionOperationMap["erp_bling_adoption_history"]["input"]): BlingAdoptionOperationMap["erp_bling_adoption_history"]["output"] {
  const limit = input.limit ?? 20;
  const q = input.q ? fold(input.q)!.replace(/[\\%_]/g, c => "\\" + c) : null;
  const [cursorDate, cursorId] = input.cursor ? input.cursor.split(".") : [null, null];
  const rows = db.exec(`SELECT h.* FROM wb_bling_adoption_history h JOIN origin_sync__raw_record r ON r.entity=h.entity AND r.source_id=h.source_id
    WHERE h.entity=? AND (? IS NULL OR h.issued_on>=?) AND (? IS NULL OR h.issued_on<=?) AND (? IS NULL OR h.search LIKE '%' || ? || '%' ESCAPE '\\')
      AND (? IS NULL OR coalesce(h.issued_on,'0')<? OR (coalesce(h.issued_on,'0')=? AND (length(h.source_id)<length(?) OR (length(h.source_id)=length(?) AND h.source_id<?))))
    ORDER BY coalesce(h.issued_on,'0') DESC, length(h.source_id) DESC, h.source_id DESC LIMIT ?`,
    input.entity, input.from ?? null, input.from ?? null, input.to ?? null, input.to ?? null, q, q,
    cursorDate, cursorDate, cursorDate, cursorId, cursorId, cursorId, limit + 1).rows;
  const items = rows.slice(0, limit).map(historyItem);
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > limit && last ? `${last.issued_on ?? "0"}.${last.source_id}` : null };
}
export function historyDocument(db: SqlDriver, input: BlingAdoptionOperationMap["erp_bling_adoption_history_get"]["input"]): BlingAdoptionHistoryDocument {
  const row = db.exec(`SELECT h.*, r.payload FROM wb_bling_adoption_history h JOIN origin_sync__raw_record r ON r.entity=h.entity AND r.source_id=h.source_id WHERE h.entity=? AND h.source_id=?`,
    input.entity, input.source_id).rows[0];
  const raw = row && readRaw(db, input.entity, input.source_id);
  if (!row || !raw) throw new BlingAdoptionError("BLING_ADOPTION_NOT_FOUND");
  const p = raw.payload, s = (v: unknown, n = 400) => clip(text(v), n);
  const fields: Record<string, string | null> = { ...blingSummaryB2(input.entity, raw) };
  fields["Por que está no histórico"] = scopeText(String(row.scope) as BlingHistoryScope);
  if (isAdoptionAccount(input.entity)) {
    Object.assign(fields, { "Emissão": dateOf(p.dataEmissao), "Saldo": money(typeof centsOf(p.saldo) === "bigint" ? centsOf(p.saldo) as bigint : null),
      "Categoria": s(at(p.categoria, "descricao")) ?? (sourceOf(p.categoria) ? `id ${sourceOf(p.categoria)}` : null),
      "Forma de pagamento": s(at(p.formaPagamento, "descricao")) ?? (sourceOf(p.formaPagamento) ? `id ${sourceOf(p.formaPagamento)}` : null) });
  } else {
    Object.assign(fields, { "Vendedor": s(at(p.vendedor, "nome")) ?? (sourceOf(p.vendedor) ? `id ${sourceOf(p.vendedor)}` : null),
      "Data prevista": dateOf(p.dataPrevista), "Observações": clip(multiline(p.observacoes, 400), 400), "Observações internas": clip(multiline(p.observacoesInternas, 400), 400) });
  }
  const lines = items(p).slice(0, 250).map(it => ({ description: s(it.descricao ?? at(it.produto, "nome")), code: s(it.codigo ?? at(it.produto, "codigo")),
    quantity: s(it.quantidade), unit_price: s(it.valor ?? it.preco), total: s(it.total ?? it.valorTotal) }));
  const installments = parcels(p).slice(0, 120).map(x => ({ due_on: dateOf(x.dataVencimento), amount: s(x.valor), method: s(at(x.formaPagamento, "descricao")) ?? (sourceOf(x.formaPagamento) ? `id ${sourceOf(x.formaPagamento)}` : null),
    note: clip(multiline(x.observacoes ?? x.observacao, 400), 400) }));
  const payloadText = String(row.payload);
  return { item: historyItem(row), read_only_message: BLING_HISTORY_READONLY, fields, lines, installments,
    payload_text: payloadText.length > 262144 ? payloadText.slice(0, 262143) + "…" : payloadText };
}
/** Totais do que ficou de fora, por motivo (a tela explica o porquê). */
export function historyOutside(db: SqlDriver, entity: BlingAdoptionB2Entity) {
  return db.exec(`SELECT h.scope, count(*) AS n, coalesce(sum(h.total_cents),0) AS total FROM wb_bling_adoption_history h
      JOIN origin_sync__raw_record r ON r.entity=h.entity AND r.source_id=h.source_id WHERE h.entity=? GROUP BY h.scope ORDER BY h.scope`, entity).rows
    .map(r => ({ scope: String(r.scope) as BlingHistoryScope, label: scopeText(String(r.scope) as BlingHistoryScope), count: Number(r.n), total_cents: String(r.total) }));
}
