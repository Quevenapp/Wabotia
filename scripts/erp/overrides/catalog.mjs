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
 * domínio já cumpre em TS, com onde. tests/erp/schema-parity.test.mjs só conta
 * o que ninguém cobre; ao fechar o domínio, baixe os tetos de lá.
 * checks: "schema.tabela.restrição"; triggers: "schema__tabela.gatilho".
 */
export const covered = {
  "checks": {
    "erp_catalog.employee.employee_name_check": "src/erp/domains/catalog/employee.ts employeeInput: contactText('name', 200), btrim, sem [[:cntrl:]], obrigatório (tests/erp/fagoo/catalog-employees.test.mjs)",
    "erp_catalog.employee.employee_salary_check": "src/erp/domains/catalog/employee.ts employeeInput: salary ^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?$, sem sinal (tests/erp/fagoo/catalog-employees.test.mjs)",
    "erp_catalog.payment_method.payment_method_description_check": "src/erp/domains/catalog/payment-method.ts paymentMethodInput: contactText('description', 100), obrigatória (tests/erp/fagoo/catalog-payment-methods.test.mjs)",
    "erp_catalog.payment_method.payment_method_fee_fixed_check": "src/erp/domains/catalog/payment-method.ts paymentMethodInput: fee_fixed ^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?$ (tests/erp/fagoo/catalog-payment-methods.test.mjs)",
    "erp_catalog.payment_method.payment_method_fee_rate_check": "src/erp/domains/catalog/fields.ts percentValid: 0 a 100, até 4 casas (tests/erp/fagoo/catalog-payment-methods.test.mjs)",
    "erp_catalog.payment_method.payment_method_fine_rate_check": "src/erp/domains/catalog/fields.ts percentValid: 0 a 100, até 4 casas (tests/erp/fagoo/catalog-payment-methods.test.mjs)",
    "erp_catalog.payment_method.payment_method_interest_rate_check": "src/erp/domains/catalog/fields.ts percentValid: 0 a 100, até 4 casas (tests/erp/fagoo/catalog-payment-methods.test.mjs)",
    "erp_pricing.price_list.price_list_check1": { "where": "src/erp/domains/catalog/pricing/rpc/erp_pricing_list_save.ts: percentual de desconto acima de 100 recusado (22023) antes da gravação; clone copia linha já válida", "test": "tests/erp/fagoo/catalog-price-lists.test.mjs" },
    "erp_pricing.price_list.price_list_factor_check": { "where": "src/erp/domains/catalog/pricing/rpc/erp_pricing_list_save.ts: factor <= 0 em lista por regra recusado (22023); fator 0 na customizada → checkViolation 23514 com a mensagem do Postgres", "test": "tests/erp/catalog/pricing-diff.test.mjs" },
    "erp_pricing.price_list.price_list_name_check": { "where": "src/erp/domains/catalog/pricing/rpc/erp_pricing_list_save.ts e erp_pricing_list_clone.ts: btrim, 1 a 120 caracteres, sem [[:cntrl:]]", "test": "tests/erp/fagoo/catalog-price-lists.test.mjs" },
    "erp_pricing.price_list_item.price_list_item_custom_price_check": { "where": "src/erp/domains/catalog/pricing/: preços por unitPrice(…, 14) (itens e planilha); reajuste em massa ≥ 10^14 → checkViolation 23514 em erp_pricing_list_items.ts; clone copia", "test": "tests/erp/catalog/pricing-diff.test.mjs" }
  },
  "triggers": {
    "erp_catalog__payment_method.payment_method_defaults_fit": "src/erp/domains/catalog/payment-method.ts fit() em insertRow e updateRow, toda escrita da tabela (tests/erp/fagoo/catalog-payment-methods.test.mjs, H 371 e diferencial)"
  }
};
