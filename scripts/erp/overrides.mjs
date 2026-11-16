// Decisões do conversor que o catálogo não diz sozinho (PLANO-FAGOO-MOTOR.md,
// seção 3: "decisão por coluna em overrides"). Na fase 2, cada domínio cuida
// das suas entradas.

/*
 * numeric sem precisão no Postgres (20 colunas). Decisão coluna a coluna pela
 * evidência do Fagoo (CHECK da tabela, função que grava a coluna, validador
 * parse* do erp-api/erp-domain); "status" diz se é evidência ou suposição.
 *
 * Teto do i64: 9.223.372.036.854.775.807. Com 10 casas, ±922 milhões. Os
 * preços do Fagoo chegam a 14 dígitos inteiros + 10 casas (24 dígitos; o
 * próprio Fagoo testa '99999999999999.9999999999' em
 * unit-price-precision.test.mjs), então não cabem: codec dec_text, decimal
 * exato em TEXT. dec_text guarda o texto do numeric do Postgres; sem typmod o
 * Postgres conserva a escala de entrada ('12.50' fica '12.50'), e o motor faz
 * o mesmo (engine/dec.ts decText). Comparação e soma em TS, nunca no SQL.
 *
 * Quantidades com 4 casas e teto 1e11 cabem em 15 dígitos: codec dec (número).
 */
const exact10 = (max, why) => ({
  codec: "dec_text",
  scale: 10,
  precision: max + 10,
  status: "evidência",
  evidence: `CHECK >= 0, < 1e${max}, = trunc(x, 10). ${why}`,
});
const qty4 = (why) => ({
  codec: "dec",
  scale: 4,
  precision: 15,
  status: "evidência",
  evidence: `CHECK < 1e11, = trunc(x, 4). ${why}`,
});
const PRICE_14 =
  "erp_catalog.unit_price(p_value, 14) aceita até 14 dígitos inteiros e 10 casas; o Fagoo testa 99999999999999.9999999999. Não cabe no i64.";
const PRICE_ITEM =
  "unit_price(p_value, 10) do documento: 10 inteiros + 10 casas = 20 dígitos, acima do i64 (19).";
const PRICE_11 = "11 inteiros + 10 casas = 21 dígitos, acima do i64.";
const QTY_FISCAL = "Quantidade comercial da NF-e (4 casas no leiaute).";
const MIRROR =
  "Gravada por erp_stock_mirror apply a partir de erp_stock_mirror.number(): aceita abs < 1e24 e min_scale ≤ 12 e guarda trim_scale. Até 24 inteiros + 12 casas: decimal em TEXT, escala de entrada conservada.";

export const overrides = {
  columns: {
    "erp_catalog.product.price": exact10(14, PRICE_14),
    "erp_catalog.product_supplier.purchase_price": exact10(14, PRICE_14),
    "erp_catalog.product_supplier.cost_price": exact10(14, PRICE_14),
    "erp_documents.item.unit_price": exact10(10, PRICE_ITEM),
    "erp_fiscal_invoices.invoice_item.quantity": qty4(QTY_FISCAL),
    "erp_fiscal_invoices.invoice_item.unit_price": exact10(11, PRICE_11 + " Valor unitário da NF-e (até 10 casas no leiaute)."),
    "erp_fiscal_invoices.invoice_order_item.quantity": qty4(QTY_FISCAL),
    "erp_pricing.price_list_item.custom_price": exact10(14, PRICE_14),
    "erp_stock.checkin_event.quantity": {
      codec: "dec",
      scale: 4,
      precision: 15,
      status: "evidência",
      evidence:
        "Sem CHECK. As funções do recebimento copiam de erp_stock.checkin_item.quantity/received (trunc 4, < 1e11) e formatam ::numeric(24,4): herda escala 4.",
    },
    "erp_stock.checkin_event.previous": {
      codec: "dec",
      scale: 4,
      precision: 15,
      status: "evidência",
      evidence: "Sem CHECK. Valor anterior da mesma coluna de checkin_item (trunc 4, < 1e11): herda escala 4.",
    },
    "erp_stock.checkin_item.quantity": qty4("Quantidade da nota recebida."),
    "erp_stock.checkin_item.unit_price": exact10(11, PRICE_11),
    "erp_stock.checkin_item.received": qty4("Quantidade conferida (CHECK >= 0)."),
    "erp_stock.checkin_item.issue_quantity": qty4("Quantidade com problema (CHECK > 0, ≤ quantity)."),
    "erp_stock.movement_detail.unit_price": exact10(14, PRICE_14),
    "erp_stock.movement_detail.unit_cost": exact10(14, "Custo unitário com o mesmo teto do preço. " + PRICE_14),
    "erp_stock_mirror.observation.physical": { codec: "dec_text", scale: 12, precision: 36, status: "evidência", evidence: MIRROR },
    "erp_stock_mirror.observation.virtual": { codec: "dec_text", scale: 12, precision: 36, status: "evidência", evidence: MIRROR },
    "erp_stock_mirror.observation.physical_delta": {
      codec: "dec_text",
      scale: 12,
      precision: 37,
      status: "evidência",
      evidence: "Diferença entre duas leituras de physical (mesma origem): até 2e24 e 12 casas. " + MIRROR,
    },
    "erp_stock_mirror.observation.virtual_delta": {
      codec: "dec_text",
      scale: 12,
      precision: 37,
      status: "evidência",
      evidence: "Diferença entre duas leituras de virtual. " + MIRROR,
    },
  },
  /** Tabelas que não vêm para o objeto, com o motivo. */
  discardTables: {},
};
