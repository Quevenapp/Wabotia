/** Mão dupla: do registro do ERP para o corpo da API v3 do Bling, e as
 * conferências por GET depois de um envio incerto.
 *
 * Regras reaproveitadas do sistema original (erp_sync.catalog_request,
 * document_request, title_request, settlement_request e stock_request), em
 * TypeScript, sem PostgreSQL:
 * - atualização parte do último detalhe lido do Bling (PUT substitui o registro
 *   inteiro), sobrepondo só os campos que o ERP mantém, para não apagar no
 *   Bling o que o ERP não modela;
 * - documento ou conta cujo contato ou produto ainda não existe no Bling espera
 *   o envio dele;
 * - baixa vai como POST /contas/.../baixar; estoque como balanço (operação "B")
 *   com o saldo do ERP, que repetido não muda nada.
 * A impressão (hash) é só do que o ERP manda: mudança só no Bling não gera envio. */
import { createHash } from "node:crypto";
import { formatScaled, fromColumn } from "../engine/dec.ts";
import type { Row, SqlDriver } from "../engine/driver.ts";
import { ERP_TABLES } from "../schema/columns.generated.ts";
import { BLING_ADOPTION_LABELS, type BlingAdoptionEntity } from "./adoption-contracts.ts";
import { adoptionTables, at, clip, object, readRaw, text, type Json } from "./adoption-store.ts";
import { BLING_TWO_WAY_SINGULAR, type BlingTwoWayEntity } from "./two-way-contracts.ts";

export const twoWayHash = (value: unknown) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(k => (value as Json)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Json)[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** Caminho da API por entidade. */
export const BLING_TWO_WAY_PATHS: Readonly<Record<Exclude<BlingTwoWayEntity, "stock_balances">, string>> = Object.freeze({
  contacts: "/contatos", products: "/produtos", sales_proposals: "/propostas-comerciais", sales_orders: "/pedidos/vendas",
  purchase_orders: "/pedidos/compras", receivables: "/contas/receber", payables: "/contas/pagar",
});
const KIND: Record<string, string> = { receivables: "receivable", payables: "payable" };
const ACCOUNT_ENTITIES = new Set(["receivables", "payables"]);
const DOCUMENT_ENTITIES = new Set(["sales_proposals", "sales_orders", "purchase_orders"]);

// ---------------------------------------------------------------------------
// Valores do ERP

/** Decimal da coluna como o ERP mostra (sem zeros à direita). */
export function decimalText(table: string, column: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const spec = ERP_TABLES[table]?.columns[column];
  let out: string;
  if (!spec || spec.codec === "dec_text" || typeof value === "string" && value.includes(".")) out = String(value);
  else out = formatScaled(fromColumn(value), spec.scale ?? 0);
  return out.includes(".") ? out.replace(/0+$/, "").replace(/\.$/, "") : out;
}
const num = (table: string, column: string, value: unknown): number | undefined => {
  const t = decimalText(table, column, value);
  return t === null ? undefined : Number(t);
};
const money = (cents: unknown): number => Number(BigInt(String(cents ?? 0))) / 100;
const str = (value: unknown, max = 200): string | undefined => { const t = text(value); return t ? t.slice(0, max) : undefined; };
const digits = (value: unknown) => text(value)?.replace(/\D/g, "") || undefined;
/** Tira chaves vazias (como jsonb_strip_nulls). */
function strip<T extends Json>(value: T): T {
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v === undefined || v === null || v === "") delete value[key];
    else if (object(v) && !Array.isArray(v)) { strip(v); if (!Object.keys(v).length) delete value[key]; }
  }
  return value;
}
const one = (db: SqlDriver, sql: string, ...params: unknown[]): Row | undefined => db.exec(sql, ...params).rows[0];

// ---------------------------------------------------------------------------
// Vínculos: o id no Bling de um registro do ERP

/** Id no Bling: pelo vínculo da adoção ou pelo que a mão dupla criou lá. */
export function blingIdOf(db: SqlDriver, entity: BlingAdoptionEntity | "stock_balances", record: string | null | undefined): string | null {
  if (!record) return null;
  if (entity !== "stock_balances") {
    const linked = one(db, `SELECT source_id FROM ${adoptionTables(entity).link} WHERE entity=? AND record_id=?`, entity, record);
    if (linked) return String(linked.source_id);
  }
  const created = one(db, "SELECT source_id FROM wb_bling_twoway_state WHERE entity=? AND record_id=? AND source_id IS NOT NULL", entity, record);
  return created ? String(created.source_id) : null;
}
const ref = (id: string | null) => id ? { id: Number(id) <= Number.MAX_SAFE_INTEGER ? Number(id) : id } : undefined;

/** Detalhe atual do Bling para o registro, sem campos só de leitura nem marcas do coletor. */
const READ_ONLY = new Set(["id", "total", "totalProdutos", "totalServicos", "notaFiscal", "saldo", "borderos", "numeroBanco", "situacao", "imagemURL", "linkBoleto", "linkQRCodePix"]);
export function basePayload(db: SqlDriver, entity: BlingAdoptionEntity, source: string | null): Json {
  if (!source) return {};
  const raw = readRaw(db, entity, source);
  if (!raw) return {};
  return Object.fromEntries(Object.entries(raw.payload).filter(([key]) => !key.startsWith("_") && !READ_ONLY.has(key)));
}

// ---------------------------------------------------------------------------
// Do registro do ERP para o corpo do Bling

export interface NeededRecord { entity: BlingAdoptionEntity; record_id: string; label: string }
export interface OutboundPlan {
  /** Só os campos que o ERP manda (base da impressão). */
  body: Json;
  label: string;
  /** Resumo lado a lado (mesmas chaves do resumo do Bling da adoção). */
  summary: Record<string, string | null>;
  /** Cadastros que ainda não existem no Bling. */
  needs: NeededRecord[];
  /** Chave natural para conferir uma criação incerta (lista do Bling filtrada). */
  natural: { query: Record<string, string | string[]>; match: Json } | null;
}
export type Snapshot = { gone: true; label: string; reason: string } | ({ gone: false } & OutboundPlan);

function contactSnapshot(db: SqlDriver, id: string): Snapshot | null {
  const r = one(db, `SELECT r.name, r.code, r.active, c.person_type, c.document, c.ie, c.email, c.phone, c.mobile, c.trade_name, c.street, c.number, c.complement, c.district, c.city, c.state, c.postal_code,
    p.situation FROM erp_catalog__record r LEFT JOIN erp_catalog__contact c ON c.record_id=r.id LEFT JOIN erp_catalog__contact_profile p ON p.record_id=r.id WHERE r.id=? AND r.entity='contacts'`, id);
  if (!r) return null;
  const label = `Contato ${clip(String(r.name), 120)}`;
  if (r.situation === "E") return { gone: true, label, reason: "O contato foi excluído no ERP. Exclusões não vão ao Bling: exclua também lá, se quiser." };
  const document = digits(r.document);
  const situation = ["A", "I", "S"].includes(String(r.situation)) ? String(r.situation) : Number(r.active) === 1 ? "A" : "I";
  const body = strip({
    nome: str(r.name, 120), codigo: str(r.code, 60), situacao: situation,
    tipo: str(r.person_type) ?? (document?.length === 11 ? "F" : "J"), numeroDocumento: document, ie: str(r.ie, 30),
    email: str(r.email, 120), telefone: str(r.phone, 40), celular: str(r.mobile, 40), fantasia: str(r.trade_name, 120),
    endereco: { geral: { endereco: str(r.street, 120), numero: str(r.number, 20), complemento: str(r.complement, 120), bairro: str(r.district, 60), municipio: str(r.city, 60), uf: str(r.state, 2), cep: digits(r.postal_code) } },
  });
  return { gone: false, body, label, needs: [], natural: document ? { query: { numeroDocumento: document }, match: { numeroDocumento: document } } : null,
    summary: { "Nome": str(r.name, 400) ?? null, "CPF/CNPJ": document ?? null, "E-mail": str(r.email, 400) ?? null, "Telefone": str(r.phone ?? r.mobile, 400) ?? null, "Código": str(r.code, 400) ?? null,
      "Cidade/UF": [r.city, r.state].filter(v => v != null && v !== "").join("/") || null } };
}
function productSnapshot(db: SqlDriver, id: string): Snapshot | null {
  const r = one(db, `SELECT r.name, r.code, r.active, p.kind, p.format, p.price, p.unit, p.description, p.gtin, p.brand, p.net_weight, p.gross_weight, d.deleted_at
    FROM erp_catalog__record r LEFT JOIN erp_catalog__product p ON p.record_id=r.id LEFT JOIN erp_catalog__product_detail d ON d.record_id=r.id WHERE r.id=? AND r.entity='products'`, id);
  if (!r) return null;
  const label = `Produto ${clip(String(r.name), 120)}`;
  if (r.deleted_at !== null && r.deleted_at !== undefined) return { gone: true, label, reason: "O produto foi excluído no ERP. Exclusões não vão ao Bling: exclua também lá, se quiser." };
  const price = decimalText("erp_catalog__product", "price", r.price);
  const body = strip({
    nome: str(r.name, 120), codigo: str(r.code, 60), situacao: Number(r.active) === 1 ? "A" : "I", tipo: str(r.kind) ?? "P", formato: str(r.format) ?? "S",
    preco: price === null ? undefined : Number(price), unidade: str(r.unit, 6), descricaoCurta: str(r.description, 4000), gtin: str(r.gtin, 14), marca: str(r.brand, 60),
    pesoLiquido: num("erp_catalog__product", "net_weight", r.net_weight), pesoBruto: num("erp_catalog__product", "gross_weight", r.gross_weight),
  });
  const code = str(r.code, 60);
  return { gone: false, body, label, needs: [], natural: code ? { query: { "codigos[]": code }, match: { codigo: code } } : null,
    summary: { "Nome": str(r.name, 400) ?? null, "Código (SKU)": code ?? null, "GTIN": str(r.gtin) ?? null, "Preço": price, "Unidade": str(r.unit) ?? null, "Tipo": r.kind === "S" ? "Serviço" : "Produto" } };
}
function documentSnapshot(db: SqlDriver, entity: "sales_proposals" | "sales_orders" | "purchase_orders", id: string): Snapshot | null {
  const d = one(db, `SELECT d.number, d.status, d.contact_id, d.body, d.total, d.deleted_at, c.name AS contact_name FROM erp_documents__document d LEFT JOIN erp_catalog__record c ON c.id=d.contact_id WHERE d.id=? AND d.kind=?`, id, entity);
  if (!d) return null;
  const label = `${BLING_TWO_WAY_SINGULAR[entity][0].toUpperCase()}${BLING_TWO_WAY_SINGULAR[entity].slice(1)} nº ${d.number ?? "—"}`;
  if (d.deleted_at !== null && d.deleted_at !== undefined) return { gone: true, label, reason: "O documento foi excluído no ERP. Exclusões não vão ao Bling: exclua também lá, se quiser." };
  if (d.status === "cancelled") return { gone: true, label, reason: "O documento foi cancelado no ERP. Mudança de situação não vai ao Bling: cancele também lá." };
  let body: Json = {};
  try { body = JSON.parse(String(d.body ?? "{}")) as Json; } catch { body = {}; }
  const needs: NeededRecord[] = [];
  const contact = blingIdOf(db, "contacts", d.contact_id as string | null);
  if (d.contact_id && !contact) needs.push({ entity: "contacts", record_id: String(d.contact_id), label: `contato ${clip(String(d.contact_name ?? ""), 80)}` });
  const items = db.exec(`SELECT product_id, product_snapshot, quantity, unit_price, discount_percent, data FROM erp_documents__item WHERE document_id=? ORDER BY position`, id).rows;
  const lines = items.map((it, index) => {
    let data: Json = {}, snap: Json = {};
    try { data = JSON.parse(String(it.data ?? "{}")) as Json; } catch { /* sem dados extras */ }
    try { snap = it.product_snapshot ? JSON.parse(String(it.product_snapshot)) as Json : {}; } catch { /* sem cópia */ }
    const product = it.product_id ? blingIdOf(db, "products", String(it.product_id)) : null;
    const description = str(data.description ?? snap.name, 120) ?? `Item ${index + 1}`;
    if (it.product_id && !product) needs.push({ entity: "products", record_id: String(it.product_id), label: `produto ${clip(description, 80)}` });
    const quantity = num("erp_documents__item", "quantity", it.quantity), price = num("erp_documents__item", "unit_price", it.unit_price);
    if (entity === "purchase_orders") return strip({ descricao: description, codigoFornecedor: str(data.supplier_code, 60), unidade: str(data.unit, 6) ?? "UN", valor: price, quantidade: quantity,
      descricaoDetalhada: str(data.detailed_description, 4000), produto: ref(product) });
    return strip({ codigo: str(data.code, 60), unidade: str(data.unit, 6) ?? "UN", quantidade: quantity, desconto: num("erp_documents__item", "discount_percent", it.discount_percent),
      valor: price, descricao: description, descricaoDetalhada: str(data.detailed_description, 4000), produto: ref(product) });
  });
  const parcels = (Array.isArray(body.installments) ? body.installments : []).filter(object).map(p => {
    const method = blingIdOf(db, "payment_methods", text(p.payment_method_id));
    return strip({ dataVencimento: str(p.due_date, 10), valor: text(p.amount) ? Number(text(p.amount)) : undefined, [entity === "purchase_orders" ? "observacao" : "observacoes"]: str(p.note, 500), formaPagamento: ref(method) });
  });
  const discount = text(body.discount_value);
  const out: Json = strip({
    numero: d.number === null || d.number === undefined ? undefined : Number(d.number), data: str(body.date, 10),
    outrasDespesas: text(body.other_expenses) ? Number(text(body.other_expenses)) : undefined, observacoes: str(body.notes, 4000),
    desconto: discount && discount !== "0" ? entity === "sales_proposals" ? Number(discount) : { valor: Number(discount), unidade: body.discount_mode === "percent" ? "PERCENTUAL" : "REAL" } : undefined,
    transporte: text(body.freight) ? { frete: Number(text(body.freight)) } : undefined,
    dataPrevista: entity !== "sales_proposals" ? str(body.expected_date, 10) : undefined,
    [entity === "purchase_orders" ? "fornecedor" : "contato"]: ref(contact),
  });
  out.itens = lines;
  if (parcels.length) out.parcelas = parcels;
  const total = d.total === null || d.total === undefined ? null : decimalText("erp_documents__document", "total", d.total);
  return { gone: false, body: out, label, needs, natural: d.number ? { query: { numero: String(d.number) }, match: { numero: String(d.number) } } : null,
    summary: { "Nome": label, "Contato": str(d.contact_name, 400) ?? null, "Data": str(body.date, 10) ?? null, "Total": total === null ? null : `R$ ${total.replace(".", ",")}` } };
}
function accountSnapshot(db: SqlDriver, entity: "receivables" | "payables", id: string): Snapshot | null {
  const t = one(db, `SELECT t.*, c.name AS contact_name FROM erp_finance__title t LEFT JOIN erp_catalog__record c ON c.id=t.contact_id WHERE t.id=? AND t.kind=?`, id, KIND[entity]);
  if (!t) return null;
  const label = `${entity === "receivables" ? "Conta a receber" : "Conta a pagar"} ${clip(String(t.description), 100)} (vence ${t.due_on})`;
  if (t.deleted_at !== null && t.deleted_at !== undefined) return { gone: true, label, reason: "A conta foi excluída no ERP. Exclusões não vão ao Bling: exclua também lá." };
  if (Number(t.cancelled) === 1) return { gone: true, label, reason: "A conta foi cancelada no ERP. Cancelamentos não vão ao Bling: cancele também lá." };
  const needs: NeededRecord[] = [];
  const contact = blingIdOf(db, "contacts", String(t.contact_id));
  if (!contact) needs.push({ entity: "contacts", record_id: String(t.contact_id), label: `contato ${clip(String(t.contact_name ?? ""), 80)}` });
  const body = strip({
    vencimento: str(t.due_on, 10), valor: money(t.amount_cents), contato: ref(contact), dataEmissao: str(t.issued_on, 10), competencia: str(t.competence_on, 10),
    // A adoção anota "(Bling <id>)" na referência; isso não é o número do documento no Bling.
    historico: str(t.history ?? t.description, 1000), numeroDocumento: str(text(t.source_reference)?.replace(/\s*\(Bling \d+\)$/, "").replace(/^Bling \d+$/, ""), 50),
    formaPagamento: ref(blingIdOf(db, "payment_methods", t.payment_method_id as string | null)), categoria: ref(blingIdOf(db, "financial_categories", t.category_id as string | null)),
    portador: ref(blingIdOf(db, "ledger_accounts", t.account_id as string | null)),
  });
  return { gone: false, body, label, needs,
    natural: contact ? { query: { idContato: contact, dataInicial: String(t.due_on), dataFinal: String(t.due_on), tipoFiltroData: "V" }, match: { vencimento: String(t.due_on), valor: money(t.amount_cents) } } : null,
    summary: { "Nome": str(t.description, 400) ?? null, "Contato": str(t.contact_name, 400) ?? null, "Vencimento": str(t.due_on) ?? null, "Valor": `R$ ${money(t.amount_cents).toFixed(2).replace(".", ",")}`, "Documento": str(t.source_reference, 400) ?? null } };
}
/** Saldo de um produto num depósito (registro "produto:depósito"). */
function stockSnapshot(db: SqlDriver, id: string): Snapshot | null {
  const [product, warehouse] = id.split(":");
  const b = one(db, `SELECT b.quantity, r.name, w.name AS warehouse_name FROM erp_stock__balance b JOIN erp_catalog__record r ON r.id=b.product_id LEFT JOIN erp_catalog__record w ON w.id=b.warehouse_id
    WHERE b.product_id=? AND b.warehouse_id=?`, product, warehouse);
  if (!b) return null;
  const label = `Saldo de ${clip(String(b.name), 90)} em ${clip(String(b.warehouse_name ?? "depósito"), 60)}`;
  const quantity = decimalText("erp_stock__balance", "quantity", b.quantity) ?? "0";
  const productId = blingIdOf(db, "products", product), depositId = blingIdOf(db, "warehouses", warehouse);
  const needs: NeededRecord[] = [];
  if (!productId) needs.push({ entity: "products", record_id: product, label: `produto ${clip(String(b.name), 80)}` });
  if (!depositId) needs.push({ entity: "warehouses", record_id: warehouse, label: `depósito ${clip(String(b.warehouse_name ?? ""), 60)}` });
  return { gone: false, body: strip({ produto: ref(productId), deposito: ref(depositId), operacao: "B", quantidade: Number(quantity), observacoes: "Saldo igualado pelo ERP" }),
    label, needs, natural: null, summary: { "Produto": str(b.name, 400) ?? null, "Depósito": str(b.warehouse_name, 400) ?? null, "Saldo": quantity.replace(".", ",") } };
}

/** O que o ERP tem hoje para o registro, no formato do Bling. null: não existe. */
export function erpSnapshot(db: SqlDriver, entity: BlingTwoWayEntity, record: string): Snapshot | null {
  switch (entity) {
    case "contacts": return contactSnapshot(db, record);
    case "products": return productSnapshot(db, record);
    case "sales_proposals": case "sales_orders": case "purchase_orders": return documentSnapshot(db, entity, record);
    case "receivables": case "payables": return accountSnapshot(db, entity, record);
    case "stock_balances": return stockSnapshot(db, record);
  }
}

// ---------------------------------------------------------------------------
// Pedido para a fila

export interface OutboundRequest { method: "POST" | "PUT"; path: string; body: Json }
/** Criação (POST) ou atualização (PUT sobre o último detalhe lido do Bling). */
export function upsertRequest(db: SqlDriver, entity: Exclude<BlingTwoWayEntity, "stock_balances">, source: string | null, plan: OutboundPlan): OutboundRequest {
  const path = BLING_TWO_WAY_PATHS[entity];
  if (!source) return { method: "POST", path, body: ACCOUNT_ENTITIES.has(entity) ? { ...plan.body, ocorrencia: { tipo: 1 } } : plan.body };
  const base = basePayload(db, entity, source);
  const merged = { ...base, ...plan.body };
  if (entity === "purchase_orders") delete merged.contato;
  if (ACCOUNT_ENTITIES.has(entity)) { delete merged.vencimentoOriginal; delete merged.ocorrencia; }
  if (DOCUMENT_ENTITIES.has(entity) && object(base.transporte) && object(plan.body.transporte)) merged.transporte = { ...base.transporte, ...plan.body.transporte };
  return { method: "PUT", path: `${path}/${source}`, body: merged };
}
export interface SettlementPlan { request: OutboundRequest; label: string; title_source: string; before_cents: bigint; expected_cents: bigint; principal_cents: bigint; summary: Record<string, string | null> }
/** Baixa do ERP (pagamento) vira POST /contas/.../{id}/baixar. */
export function settlementPlan(db: SqlDriver, entity: "receivables" | "payables", settlement: string): { plan: SettlementPlan } | { waiting: string } | { refused: string } | null {
  const s = one(db, `SELECT s.*, t.id AS title_id, t.amount_cents, t.settled_cents, t.category_id, t.description FROM erp_finance__settlement s JOIN erp_finance__title t ON t.id=s.title_id WHERE s.id=? AND t.kind=?`, settlement, KIND[entity]);
  if (!s) return null;
  if (s.kind !== "payment") return { refused: "Estorno de baixa não vai ao Bling (a API do Bling não tem estorno): desfaça a baixa também lá." };
  const title = blingIdOf(db, entity, String(s.title_id));
  if (!title) return { waiting: "A conta ainda não existe no Bling: a baixa espera a conta ser enviada." };
  const raw = readRaw(db, entity, title);
  const portador = blingIdOf(db, "ledger_accounts", String(s.account_id)) ?? text(at(raw?.payload, "portador", "id"));
  const categoria = blingIdOf(db, "financial_categories", s.category_id as string | null) ?? text(at(raw?.payload, "categoria", "id"));
  if (!portador || !categoria) return { refused: "Para dar a baixa no Bling falta a conta financeira (portador) ou a categoria ligada ao Bling. Adote a conta financeira e a categoria, ou dê a baixa também lá." };
  const principal = BigInt(String(s.principal_cents));
  // Saldo no Bling antes desta baixa: o último lido do Bling ou, sem leitura, o do ERP.
  const rawSaldo = text(raw?.payload.saldo);
  const before = rawSaldo && /^-?\d+(\.\d+)?$/.test(rawSaldo) ? BigInt(Math.round(Number(rawSaldo) * 100)) : BigInt(String(s.amount_cents)) - BigInt(String(s.settled_cents)) + principal;
  const label = `Baixa de R$ ${(Number(principal) / 100).toFixed(2).replace(".", ",")} em ${clip(String(s.description), 100)}`;
  const body = { data: String(s.posted_on), usarDataVencimento: false, portador: ref(portador), categoria: ref(categoria),
    historico: clip(text(s.note) ?? "Baixa registrada no ERP", 500), valorRecebido: Number(principal) / 100,
    juros: (Number(s.interest_cents) + Number(s.penalty_cents)) / 100, desconto: Number(s.discount_cents) / 100, acrescimo: 0, tarifa: Number(s.fee_cents) / 100 };
  return { plan: { request: { method: "POST", path: `${BLING_TWO_WAY_PATHS[entity]}/${title}/baixar`, body }, label, title_source: title, before_cents: before, expected_cents: before - principal, principal_cents: principal,
    summary: { "Conta": clip(String(s.description), 400), "Valor da baixa": `R$ ${(Number(principal) / 100).toFixed(2).replace(".", ",")}`, "Data": String(s.posted_on) } } };
}

// ---------------------------------------------------------------------------
// Conferência por GET (depois de resposta incerta)

const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  if (object(a) && object(b)) return Object.keys(a).every(k => same(a[k], b[k]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return (text(a) ?? "") === (text(b) ?? "");
};
/** O registro lido do Bling contém o que mandamos (só os campos do ERP)? */
export function remoteHas(remote: unknown, sent: Json): boolean {
  if (!object(remote)) return false;
  return Object.entries(sent).every(([key, value]) => key === "ocorrencia" || same(value, remote[key]));
}
export const dataOf = (body: unknown): unknown => object(body) && "data" in body ? body.data : body;
export function remoteId(body: unknown): string | null {
  const data = dataOf(body);
  const id = object(data) ? data.id : null;
  const t = text(id);
  return t && /^[1-9]\d{0,39}$/.test(t) ? t : null;
}
/** Linhas da lista do Bling que casam com a chave natural. */
export function naturalMatches(body: unknown, match: Json): Json[] {
  const rows = dataOf(body);
  return Array.isArray(rows) ? rows.filter(object).filter(row => Object.entries(match).every(([key, value]) => same(value, key === "numeroDocumento" ? digits(row[key]) : row[key]))) : [];
}
/** Saldo físico de um depósito na resposta de /estoques/saldos. */
export function stockOf(body: unknown, product: string, deposit: string): number | null {
  const rows = dataOf(body);
  if (!Array.isArray(rows)) return null;
  const row = rows.filter(object).find(r => text(at(r, "produto", "id")) === product);
  const list = row && Array.isArray(row.depositos) ? row.depositos.filter(object) : [];
  const found = list.find(d => text(d.id) === deposit);
  const value = found ? text(found.saldoFisico) : null;
  return value === null || !/^-?\d+(\.\d+)?$/.test(value) ? null : Number(value);
}
export const centsOfRemote = (value: unknown): bigint | null => {
  const t = text(value);
  return t && /^-?\d+(\.\d+)?$/.test(t) ? BigInt(Math.round(Number(t) * 100)) : null;
};
export const entityWord = (entity: BlingAdoptionEntity) => BLING_ADOPTION_LABELS[entity].toLowerCase();
