// Decisões do conversor do domínio catalog (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
export const columns = {
  "erp_catalog.product.price": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 24,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e14, = trunc(x, 10). erp_catalog.unit_price(p_value, 14) aceita até 14 dígitos inteiros e 10 casas; o Fagoo testa 99999999999999.9999999999. Não cabe no i64."
  },
  "erp_catalog.product_supplier.purchase_price": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 24,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e14, = trunc(x, 10). erp_catalog.unit_price(p_value, 14) aceita até 14 dígitos inteiros e 10 casas; o Fagoo testa 99999999999999.9999999999. Não cabe no i64."
  },
  "erp_catalog.product_supplier.cost_price": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 24,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e14, = trunc(x, 10). erp_catalog.unit_price(p_value, 14) aceita até 14 dígitos inteiros e 10 casas; o Fagoo testa 99999999999999.9999999999. Não cabe no i64."
  },
  "erp_pricing.price_list_item.custom_price": {
    "codec": "dec_text",
    "scale": 10,
    "precision": 24,
    "status": "evidência",
    "evidence": "CHECK >= 0, < 1e14, = trunc(x, 10). erp_catalog.unit_price(p_value, 14) aceita até 14 dígitos inteiros e 10 casas; o Fagoo testa 99999999999999.9999999999. Não cabe no i64."
  }
};

/** Tabelas que não vêm para o objeto, com o motivo. */
export const discardTables = {};

/**
 * Pendências do esquema gerado (CHECK sem tradução, gatilho em PL/pgSQL) que o
 * domínio cumpre em TS. Cada item diz onde (where) e qual teste prova (test,
 * caminho do arquivo; o teste precisa exercitar a recusa nos dois motores).
 * tests/erp/schema-parity.test.mjs só conta o que ninguém cobre, recusa item
 * que não está pendente e item sem arquivo de teste; ao cobrir, baixe os tetos
 * de lá. Chaves: checks "schema.tabela.restrição"; triggers "schema__tabela.gatilho".
 */
export const covered = {
  "checks": {
    "erp_catalog.employee.employee_name_check": {
      "where": "src/erp/domains/catalog/employee.ts employeeInput: contactText('name', 200), btrim, sem [[:cntrl:]], obrigatório",
      "test": "tests/erp/fagoo/catalog-employees.test.mjs"
    },
    "erp_catalog.employee.employee_salary_check": {
      "where": "src/erp/domains/catalog/employee.ts employeeInput: salary ^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?$, sem sinal",
      "test": "tests/erp/fagoo/catalog-employees.test.mjs"
    },
    "erp_catalog.payment_method.payment_method_description_check": {
      "where": "src/erp/domains/catalog/payment-method.ts paymentMethodInput: contactText('description', 100), obrigatória",
      "test": "tests/erp/fagoo/catalog-payment-methods.test.mjs"
    },
    "erp_catalog.payment_method.payment_method_fee_fixed_check": {
      "where": "src/erp/domains/catalog/payment-method.ts paymentMethodInput: fee_fixed ^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?$",
      "test": "tests/erp/fagoo/catalog-payment-methods.test.mjs"
    },
    "erp_catalog.payment_method.payment_method_fee_rate_check": {
      "where": "src/erp/domains/catalog/fields.ts percentValid: 0 a 100, até 4 casas",
      "test": "tests/erp/fagoo/catalog-payment-methods.test.mjs"
    },
    "erp_catalog.payment_method.payment_method_fine_rate_check": {
      "where": "src/erp/domains/catalog/fields.ts percentValid: 0 a 100, até 4 casas",
      "test": "tests/erp/fagoo/catalog-payment-methods.test.mjs"
    },
    "erp_catalog.payment_method.payment_method_interest_rate_check": {
      "where": "src/erp/domains/catalog/fields.ts percentValid: 0 a 100, até 4 casas",
      "test": "tests/erp/fagoo/catalog-payment-methods.test.mjs"
    },
    "erp_pricing.price_list.price_list_check1": { "where": "src/erp/domains/catalog/pricing/rpc/erp_pricing_list_save.ts: percentual de desconto acima de 100 recusado (22023) antes da gravação; clone copia linha já válida", "test": "tests/erp/fagoo/catalog-price-lists.test.mjs" },
    "erp_pricing.price_list.price_list_factor_check": { "where": "src/erp/domains/catalog/pricing/rpc/erp_pricing_list_save.ts: factor <= 0 em lista por regra recusado (22023); fator 0 na customizada → checkViolation 23514 com a mensagem do Postgres", "test": "tests/erp/catalog/pricing-diff.test.mjs" },
    "erp_pricing.price_list.price_list_name_check": { "where": "src/erp/domains/catalog/pricing/rpc/erp_pricing_list_save.ts e erp_pricing_list_clone.ts: btrim, 1 a 120 caracteres, sem [[:cntrl:]]", "test": "tests/erp/fagoo/catalog-price-lists.test.mjs" },
    "erp_pricing.price_list_item.price_list_item_custom_price_check": { "where": "src/erp/domains/catalog/pricing/: preços por unitPrice(…, 14) (itens e planilha); reajuste em massa ≥ 10^14 → checkViolation 23514 em erp_pricing_list_items.ts; clone copia", "test": "tests/erp/catalog/pricing-diff.test.mjs" },
    "erp_catalog.product_detail.product_detail_cofins_fixed_value_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(11, 4), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_ipi_fixed_value_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(11, 4), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_pis_fixed_value_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(11, 4), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_icms_own_substitute_value_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(13, 2), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_icms_st_retention_base_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(13, 2), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_icms_st_retention_value_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(13, 2), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_starting_value_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(13, 2), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_glgni_percent_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(3, 4, máximo 100), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_glgnn_percent_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(3, 4, máximo 100), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_glp_percent_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(3, 4, máximo 100), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_tax_percent_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailDecimal(3, 4, máximo 100), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_items_per_box_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: items_per_box_decimal por detailDecimal(6, 6), sem sinal","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_detail.product_detail_ipi_seal_code_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: detailText(60) e ^[0-9A-Za-z./-]+$","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_dun.product_dun_quantity_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: dun_codes quantity detailDecimal(12, 6) > 0","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_image.product_image_url_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: images https://, 9 a 1000 caracteres, sem espaço nem controle","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_supplier.product_supplier_cost_price_check": {"where":"src/erp/domains/catalog/product-detail.ts e rpc/erp_catalog_product_prices.ts: unitPrice(…, 14)","test":"tests/erp/catalog/product-writes-diff.test.mjs"},
    "erp_catalog.product_supplier.product_supplier_purchase_price_check": {"where":"src/erp/domains/catalog/product-detail.ts productDetailValidate: unitPrice(…, 14)","test":"tests/erp/catalog/product-writes-diff.test.mjs"}
  },
  "triggers": {
    "erp_catalog__payment_method.payment_method_defaults_fit": {
      "where": "src/erp/domains/catalog/payment-method.ts fit() em insertRow e updateRow (toda escrita da tabela)",
      "test": "tests/erp/fagoo/catalog-payment-methods.test.mjs"
    },
    "erp_catalog__product_supplier.product_cost_capture": {"where":"src/erp/domains/catalog/product-detail.ts productCostCapture: toda inclusão (productDetailWrite) e alteração de custo (erp_catalog_product_prices_update) da linha padrão","test":"tests/erp/fagoo/catalog-product-registry.test.mjs"},
    "erp_catalog__taxonomy.erp_catalog_taxonomy_type_guard": {"where":"src/erp/domains/catalog/taxonomy.ts taxonomyTypeGuard (tipo fixo; etiqueta com o tipo do grupo), chamado por erp_catalog_taxonomy_save antes de gravar; as outras escritas na taxonomia só sobem a versão (não mudam tag_type nem parent_id)","test":"tests/erp/catalog/taxonomy-diff.test.mjs"}
  }
};
