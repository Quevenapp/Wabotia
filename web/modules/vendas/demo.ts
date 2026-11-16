// Vendas e Caixa na demonstração (/app?demo=1, web/lib/demo.ts): um
// empório com categorias coloridas, produtos (um vendido a quilo, um com
// estoque baixo e um sem saldo), vendas, orçamentos e um caixa aberto.
// Mesmos formatos de GET /vendas…, /caixa… (productView, saleView,
// quoteView, sessionView em src/modules/vendas e src/modules/caixa).
import type { Row } from "../../lib/api";

const M = 60_000,
  H = 60 * M,
  D = 24 * H;
const t = (ago: number) => Date.now() - ago;

export const vendasDemoModule: Row = {
  id: "vendas",
  name: "Vendas e orçamento",
  version: "1.0.0",
  description:
    "Produtos com foto, código de barras, estoque e dados fiscais; orçamentos aprovados pelo WhatsApp; vendas com baixa de estoque, comprovante e a nota fiscal pelo emissor escolhido.",
  builtin: true,
  enabled: true,
  default_enabled: false,
  navigation: [
    { id: "vendas", label: "Vendas e orçamentos", place: "admin", admin: false },
    { id: "vendas-produtos", label: "Produtos e estoque", place: "admin", admin: false },
    { id: "vendas-config", label: "Regras e nota fiscal", place: "admin", admin: true },
  ],
  menu_item_types: [{ type: "vendas_orcamentos", label: "Meus orçamentos" }],
};

export const caixaDemoModule: Row = {
  id: "caixa",
  name: "Caixa",
  version: "1.0.0",
  description:
    "Frente de caixa no tablet do balcão: venda por toque com fotos e categorias, leitor de código de barras, troco, sangria, suprimento e fechamento com conferência do dinheiro.",
  builtin: true,
  enabled: true,
  default_enabled: false,
  requires: ["vendas"],
  navigation: [{ id: "caixa", label: "Caixa", place: "admin", admin: false }],
  menu_item_types: [],
};

/** Regras de vendas (chave "vendas" das configurações) na demonstração. */
export const vendasDemoConfig: Row = {
  quote_valid_days: 7,
  payment_methods: {
    cash: true,
    card_credit: true,
    card_debit: true,
    pix_manual: true,
    pix: false,
    link: false,
    other: false,
  },
  pix_key: "pix@emporio.exemplo",
  max_discount_percent: 10,
  operator_can_cancel: false,
  low_stock_alert: true,
  receipt_footer: "Trocas em até 7 dias com este comprovante.",
  quote_intro: "Segue o orçamento que você pediu:",
  quote_footer: "Entrega grátis acima de R$ 150,00.",
  fiscal: {
    regime: "simples",
    legal_name: "Empório Exemplo Ltda",
    ie: "",
    im: "",
    cnae: "4729699",
    street: "Rua das Flores",
    number: "120",
    complement: "",
    district: "Centro",
    city: "Campinas",
    city_code: "3509502",
    uf: "SP",
    cep: "13010000",
    environment: "homologacao",
    nfce_series: 1,
    nfe_series: 1,
    default_cfop: "5102",
    default_origin: 0,
    default_csosn: "102",
    default_icms_cst: "00",
    default_pis_cst: "49",
    default_cofins_cst: "49",
    provider: null,
    auto_emit: false,
  },
};

const categories: Row[] = [
  { id: "cat-bebidas", name: "Bebidas", color: "#0277bd", position: 0 },
  { id: "cat-padaria", name: "Padaria", color: "#e59a2f", position: 1 },
  { id: "cat-horti", name: "Hortifruti", color: "#6e8f3d", position: 2 },
  { id: "cat-mercearia", name: "Mercearia", color: null, position: 3 },
].map((c) => ({ ...c, created: t(30 * D), updated: t(30 * D) }));

function product(p: Row): Row {
  const tracked = p.track_stock !== false;
  const stock = tracked ? (p.stock ?? 20) : null;
  const min = tracked ? (p.min_stock ?? 0) : null;
  return {
    category_id: null,
    description: "",
    cost_cents: null,
    unit: "UN",
    fractional: false,
    ean: null,
    sku: null,
    photo_media_id: null,
    photo_path: null,
    active: true,
    track_stock: tracked,
    allow_negative: false,
    position: 0,
    fiscal: {},
    created: t(20 * D),
    updated: t(2 * D),
    ...p,
    stock,
    min_stock: min,
    low_stock: tracked && (min as number) > 0 && (stock as number) <= (min as number),
    out_of_stock: tracked && !p.allow_negative && (stock as number) <= 0,
  };
}

const products: Row[] = [
  product({ id: "p-cafe", category_id: "cat-mercearia", name: "Café torrado 500 g", price_cents: 2290, cost_cents: 1450, ean: "7891234567895", sku: "CAFE-500", stock: 32, min_stock: 10, fiscal: { ncm: "09012100", cfop: "5102", origin: 0, icms_csosn: "102" } }),
  product({ id: "p-pao", category_id: "cat-padaria", name: "Pão francês", price_cents: 1690, unit: "KG", fractional: true, stock: 8.4, min_stock: 2, fiscal: { ncm: "19059090" } }),
  product({ id: "p-bolo", category_id: "cat-padaria", name: "Bolo de fubá (fatia)", price_cents: 750, stock: 3, min_stock: 4 }),
  product({ id: "p-agua", category_id: "cat-bebidas", name: "Água mineral 500 ml", price_cents: 300, ean: "7896000000019", stock: 120, min_stock: 24, fiscal: { ncm: "22011000" } }),
  product({ id: "p-suco", category_id: "cat-bebidas", name: "Suco de laranja 1 L", price_cents: 1290, stock: 0, min_stock: 6 }),
  product({ id: "p-refri", category_id: "cat-bebidas", name: "Refrigerante lata", price_cents: 550, sku: "REFRI-LATA", stock: 48, min_stock: 12 }),
  product({ id: "p-banana", category_id: "cat-horti", name: "Banana prata", price_cents: 699, unit: "KG", fractional: true, stock: 14.25, min_stock: 3 }),
  product({ id: "p-tomate", category_id: "cat-horti", name: "Tomate italiano", price_cents: 899, unit: "KG", fractional: true, stock: 6.5, min_stock: 2 }),
  product({ id: "p-sacola", name: "Sacola retornável", price_cents: 400, track_stock: false }),
];

function line(index: number, p: Row, quantity: number, extra: Row = {}): Row {
  const gross = Math.round((p.price_cents * Math.round(quantity * 1000)) / 1000);
  const discount = extra.discount_cents || 0;
  return {
    index,
    product_id: p.id,
    name: p.name,
    sku: p.sku,
    ean: p.ean,
    unit: p.unit,
    quantity,
    unit_cents: p.price_cents,
    gross_cents: gross,
    discount_cents: discount,
    total_cents: gross - discount,
    net_cents: gross - discount,
    returned_quantity: 0,
    returned_cents: 0,
    ...extra,
  };
}
const by = (id: string) => products.find((p) => p.id === id)!;
const sum = (lines: Row[], key: string) => lines.reduce((s, l) => s + l[key], 0);
const label = (m: string) =>
  ({
    cash: "Dinheiro",
    card_credit: "Cartão de crédito",
    card_debit: "Cartão de débito",
    pix_manual: "Pix (chave da loja)",
    pix: "Pix (cobrança pelo WhatsApp)",
    link: "Link de pagamento",
    other: "Outra",
  })[m] || m;
const saleLabels: Row = {
  awaiting_payment: "Aguardando pagamento",
  completed: "Concluída",
  cancelled: "Cancelada",
  returned: "Devolvida",
};

function sale(s: Row): Row {
  const lines: Row[] = s.lines;
  const subtotal = sum(lines, "gross_cents");
  const total = sum(lines, "total_cents") - (s.sale_discount_cents || 0);
  const payments = (s.payments as [string, number][]).map(([method, amount_cents]) => ({
    method,
    amount_cents,
    method_label: label(method),
  }));
  const paid = payments.reduce((x, p) => x + p.amount_cents, 0);
  return {
    quote_id: null,
    session_id: null,
    customer: { name: "", phone: null, document: null, contact_id: null, conversation_id: null },
    item_count: lines.length,
    subtotal_cents: subtotal,
    discount_cents: subtotal - total,
    sale_discount_cents: 0,
    total_cents: total,
    paid_cents: paid,
    change_cents: Math.max(0, paid - total),
    payment: null,
    needs_refund: false,
    refunded_cents: 0,
    fiscal_status: "none",
    note: "",
    notes: "",
    created_by: "demo-user",
    updated: s.created,
    completed_at: s.status === "completed" ? s.created : null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: "",
    ...s,
    status_label: saleLabels[s.status],
    payments,
  };
}

const sales: Row[] = [
  sale({ id: "sale-131", number: 131, status: "completed", source: "caixa", session_id: "sess-12", created: t(25 * M), lines: [line(0, by("p-cafe"), 1), line(1, by("p-pao"), 0.45)], payments: [["cash", 5000]] }),
  sale({ id: "sale-130", number: 130, status: "completed", source: "caixa", session_id: "sess-12", created: t(70 * M), lines: [line(0, by("p-refri"), 6), line(1, by("p-agua"), 2)], payments: [["card_debit", 3900]] }),
  sale({
    id: "sale-129",
    number: 129,
    status: "completed",
    source: "quote",
    quote_id: "quote-41",
    created: t(5 * H),
    customer: { name: "Marina Souza", phone: "5519988887777", document: null, contact_id: null, conversation_id: "demo-1" },
    lines: [line(0, by("p-cafe"), 6, { discount_cents: 600 }), line(1, by("p-sacola"), 2)],
    payments: [["pix_manual", 13940]],
  }),
  sale({ id: "sale-128", number: 128, status: "cancelled", source: "caixa", session_id: "sess-11", created: t(D + 2 * H), lines: [line(0, by("p-bolo"), 2)], payments: [["cash", 1500]], cancelled_at: t(D + H), cancelled_by: "demo-user", cancel_reason: "Lançado em dobro" }),
];

const quoteLabels: Row = {
  draft: "Rascunho",
  sent: "Enviado",
  approved: "Aprovado",
  declined: "Recusado",
  expired: "Vencido",
  converted: "Virou venda",
  cancelled: "Cancelado",
};
function quote(q: Row): Row {
  const lines: Row[] = q.lines;
  const subtotal = sum(lines, "gross_cents");
  const total = sum(lines, "total_cents") - (q.sale_discount || 0);
  const { sale_discount: _drop, ...rest } = q;
  return {
    customer: { name: "", phone: null, document: null, contact_id: null, conversation_id: null },
    item_count: lines.length,
    subtotal_cents: subtotal,
    discount_cents: subtotal - total,
    total_cents: total,
    valid_days: null,
    valid_until: null,
    note: "",
    notes: "",
    version: 1,
    sent_at: null,
    sent_via: null,
    web_step_id: null,
    decided_at: null,
    decided_by: null,
    decided_via: null,
    decision_note: "",
    sale_id: null,
    created_by: "demo-user",
    updated: q.created,
    ...rest,
    status_label: quoteLabels[q.status],
  };
}
const quotes: Row[] = [
  quote({
    id: "quote-43",
    number: 43,
    status: "sent",
    created: t(3 * H),
    sent_at: t(2 * H),
    sent_via: "buttons",
    valid_until: Date.now() + 6 * D,
    customer: { name: "Padaria Pão Quente", phone: "5519977776666", document: null, contact_id: null, conversation_id: "demo-2" },
    lines: [line(0, by("p-cafe"), 10), line(1, by("p-agua"), 48), { ...line(2, by("p-sacola"), 1), product_id: null, name: "Entrega", unit: "UN", unit_cents: 1500, gross_cents: 1500, total_cents: 1500, net_cents: 1500, sku: null, ean: null }],
    sale_discount: 1000,
    note: "Entrega na quinta-feira pela manhã.",
  }),
  quote({ id: "quote-42", number: 42, status: "draft", created: t(26 * H), customer: { name: "Carlos Lima", phone: null, document: null, contact_id: null, conversation_id: null }, lines: [line(0, by("p-banana"), 3), line(1, by("p-tomate"), 2)] }),
  quote({
    id: "quote-41",
    number: 41,
    status: "converted",
    created: t(2 * D),
    sent_at: t(2 * D - H),
    sent_via: "link",
    valid_until: t(2 * D) + 7 * D,
    decided_at: t(6 * H),
    decided_by: "customer:demo-1",
    decided_via: "link",
    sale_id: "sale-129",
    customer: { name: "Marina Souza", phone: "5519988887777", document: null, contact_id: null, conversation_id: "demo-1" },
    lines: [line(0, by("p-cafe"), 6, { discount_cents: 600 }), line(1, by("p-sacola"), 2)],
  }),
];

const sessionSummary: Row = {
  opening_cents: 15000,
  supplies_cents: 0,
  withdrawals_cents: 5000,
  sales: { count: 2, total_cents: sales[0].total_cents + sales[1].total_cents, discount_cents: 0, cancelled_count: 0, cancelled_cents: 0, awaiting_count: 0 },
  by_method: [
    { method: "cash", label: "Dinheiro", count: 1, amount_cents: sales[0].total_cents },
    { method: "card_debit", label: "Cartão de débito", count: 1, amount_cents: sales[1].total_cents },
  ],
  change_cents: sales[0].change_cents,
  returns: { count: 0, total_cents: 0, by_method: [] },
  cash: { sales_cents: sales[0].total_cents, returns_cents: 0, expected_cents: 15000 - 5000 + sales[0].total_cents },
};
const session: Row = {
  id: "sess-12",
  number: 12,
  register_id: "reg-1",
  register_name: "Caixa 1",
  status: "open",
  opened_by: "demo-user",
  opened_at: t(3 * H),
  opening_cents: 15000,
  opening_note: "",
  closed_by: null,
  closed_at: null,
  counted_cents: null,
  expected_cash_cents: null,
  difference_cents: null,
  closing_note: "",
  summary: sessionSummary,
  created: t(3 * H),
  updated: t(25 * M),
};
const registers: Row[] = [
  {
    id: "reg-1",
    name: "Caixa 1",
    active: true,
    position: 0,
    session: { id: session.id, number: session.number, status: "open", opened_by: session.opened_by, opened_at: session.opened_at, opening_cents: session.opening_cents },
    created: t(60 * D),
    updated: t(3 * H),
  },
  { id: "reg-2", name: "Balcão da padaria", active: true, position: 1, session: null, created: t(60 * D), updated: t(D) },
];

const money = (c: number) => "R$ " + (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pair = (left: string, right: string, columns: number) =>
  left.slice(0, Math.max(1, columns - right.length - 1)).padEnd(columns - right.length) + right;
function receiptText(record: Row, title: string, columns: number) {
  const rule = "-".repeat(columns);
  const center = (v: string) => " ".repeat(Math.max(0, Math.floor((columns - v.length) / 2))) + v;
  return [
    center("EMPÓRIO EXEMPLO"),
    center("CNPJ 11.222.333/0001-81"),
    rule,
    `${title} Nº ${record.number}`,
    rule,
    ...record.lines.flatMap((l: Row) => [
      l.name.slice(0, columns),
      pair(`  ${String(l.quantity).replace(".", ",")} ${l.unit} x ${money(l.unit_cents)}`, money(l.total_cents), columns),
    ]),
    rule,
    ...(record.discount_cents ? [pair("Desconto", `-${money(record.discount_cents)}`, columns)] : []),
    pair("TOTAL", money(record.total_cents), columns),
    ...(record.payments || []).map((p: Row) => pair(p.method_label, money(p.amount_cents), columns)),
    ...(record.change_cents ? [pair("Troco", money(record.change_cents), columns)] : []),
    rule,
    center("Não é documento fiscal"),
  ].join("\n");
}

const page = (data: Row[]) => ({ data, next_cursor: null });
const matches = (record: Row, q: string) =>
  !q || String(record.number) === q || String(record.customer?.name || "").toLowerCase().includes(q.toLowerCase());

/** Leituras de vendas/… e caixa/… na demonstração. */
export function vendasDemo(rest: string, query: URLSearchParams): any {
  const columns = Number(query.get("columns")) || 32;
  if (rest === "vendas")
    return {
      config: vendasDemoConfig,
      payment_methods: ["cash", "card_credit", "card_debit", "pix_manual"].map((id) => ({ id, label: label(id) })),
      online_payments: { ready: true },
      counts: { quotes_pending: 1, quotes_approved: 0, low_stock: 2, awaiting_payment: 0, needs_refund: 0 },
    };
  if (rest === "vendas/categories") return { data: categories };
  if (rest === "vendas/products") {
    const q = (query.get("q") || "").toLowerCase();
    const category = query.get("category_id") || "";
    return page(
      products.filter(
        (p) =>
          (!q || p.name.toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q) || p.ean === q) &&
          (!category || (category === "none" ? !p.category_id : p.category_id === category)) &&
          (query.get("low") !== "1" || p.low_stock),
      ),
    );
  }
  const productMatch = rest.match(/^vendas\/products\/([^/]+)$/);
  if (productMatch) return products.find((p) => p.id === productMatch[1]) || products[0];
  if (rest === "vendas/lookup" || rest === "caixa/lookup") {
    const code = (query.get("code") || "").trim();
    const found = products.find((p) => p.ean === code || p.sku === code.toUpperCase());
    if (!found)
      throw Object.assign(new Error(`Nenhum produto ativo com o código ${code}.`), { status: 404, code: "product_not_found" });
    return found;
  }
  if (rest === "vendas/stock/moves") {
    const p = by(query.get("product_id") || "p-cafe") || products[0];
    if (!p.track_stock) return page([]);
    const moves = [
      { type: "venda", type_label: "Venda", quantity: -1, ref_type: "sale", note: "", ago: 25 * M },
      { type: "entrada", type_label: "Entrada", quantity: 24, ref_type: "manual", note: "NF 4521 do fornecedor", cost_cents: p.cost_cents, ago: 2 * D },
      { type: "ajuste", type_label: "Ajuste de inventário", quantity: -2, ref_type: "manual", note: "Contagem de fim de mês", ago: 9 * D },
    ];
    let balance = p.stock as number;
    return page(
      moves.map((m, i) => {
        const row = {
          id: `move-${i}`,
          product_id: p.id,
          product_name: p.name,
          unit: p.unit,
          ref_id: null,
          cost_cents: null,
          actor: "demo-user",
          ...m,
          balance,
          created: t(m.ago),
        };
        balance -= m.quantity;
        return row;
      }),
    );
  }
  if (rest === "vendas/sales") {
    const status = query.get("status") || "";
    const q = query.get("q") || "";
    return page(sales.filter((s) => (!status || status.split(",").includes(s.status)) && matches(s, q)));
  }
  const saleMatch = rest.match(/^vendas\/sales\/([^/]+)(\/receipt|\/fiscal)?$/);
  if (saleMatch) {
    const s = sales.find((x) => x.id === saleMatch[1]) || sales[0];
    if (saleMatch[2] === "/receipt") return { columns, sale: s, text: receiptText(s, "VENDA", columns) };
    if (saleMatch[2] === "/fiscal")
      return {
        model: query.get("model") || "nfce",
        ready: false,
        provider: null,
        issues: [
          { field: "fiscal.ie", message: "Informe a inscrição estadual (ou ISENTO)." },
          ...s.lines
            .filter((l: Row) => !by(l.product_id || "")?.fiscal?.ncm)
            .map((l: Row) => ({ field: `lines[${l.index}].ncm`, message: `"${l.name}": falta o NCM.`, line: l.index, product_id: l.product_id })),
        ],
        document: { environment: "homologacao", items: s.lines, totals: { total_cents: s.total_cents }, recipient: null },
      };
    return { ...s, returns: [], fiscal_documents: [] };
  }
  if (rest === "vendas/quotes") {
    const status = query.get("status") || "";
    const q = query.get("q") || "";
    return page(quotes.filter((x) => (!status || status.split(",").includes(x.status)) && matches(x, q)));
  }
  const quoteMatch = rest.match(/^vendas\/quotes\/([^/]+)(\/print)?$/);
  if (quoteMatch) {
    const q = quotes.find((x) => x.id === quoteMatch[1]) || quotes[0];
    if (quoteMatch[2]) return { columns, quote: q, text: receiptText(q, "ORÇAMENTO", columns) };
    return q;
  }
  if (rest === "vendas/fiscal")
    return {
      config: vendasDemoConfig.fiscal,
      emitter_issues: [{ field: "fiscal.ie", message: "Informe a inscrição estadual (ou ISENTO)." }],
      providers: [],
      provider_configured: false,
      products: { active: products.length, without_ncm: products.filter((p) => !p.fiscal?.ncm).length },
    };
  if (rest === "caixa")
    return {
      registers,
      payment_methods: ["cash", "card_credit", "card_debit", "pix_manual"].map((id) => ({ id, label: label(id) })),
      online_payments: { ready: true },
    };
  if (rest === "caixa/grid")
    return {
      categories,
      products: products.map((p) => ({
        id: p.id,
        category_id: p.category_id,
        name: p.name,
        price_cents: p.price_cents,
        unit: p.unit,
        fractional: p.fractional,
        ean: p.ean,
        sku: p.sku,
        photo_media_id: null,
        photo_path: null,
        track_stock: p.track_stock,
        stock: p.stock,
        low_stock: p.low_stock,
        out_of_stock: p.out_of_stock,
        position: p.position,
      })),
      generated_at: Date.now(),
    };
  if (rest === "caixa/sessions") return page([session]);
  const sessionMatch = rest.match(/^caixa\/sessions\/([^/]+)(\/report)?$/);
  if (sessionMatch) {
    if (sessionMatch[2])
      return {
        columns,
        session,
        text: [
          "PARCIAL DO CAIXA",
          "-".repeat(columns),
          pair(`Vendas (${sessionSummary.sales.count})`, money(sessionSummary.sales.total_cents), columns),
          pair("Troco inicial", money(sessionSummary.opening_cents), columns),
          pair("Sangrias", `-${money(sessionSummary.withdrawals_cents)}`, columns),
          pair("ESPERADO NA GAVETA", money(sessionSummary.cash.expected_cents), columns),
        ].join("\n"),
      };
    return {
      ...session,
      moves: [{ id: "mv-1", session_id: session.id, kind: "withdrawal", kind_label: "Sangria", amount_cents: 5000, note: "Cofre", actor: "demo-user", created: t(H) }],
      sales: sales
        .filter((s) => s.session_id === session.id)
        .map((s) => ({ id: s.id, number: s.number, status: s.status, status_label: s.status_label, total_cents: s.total_cents, methods: s.payments.map((p: Row) => p.method), created_by: s.created_by, created: s.created })),
      returns: [],
    };
  }
  return page([]);
}
