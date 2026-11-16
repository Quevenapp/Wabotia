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
    }
  },
  "triggers": {
    "erp_catalog__payment_method.payment_method_defaults_fit": {
      "where": "src/erp/domains/catalog/payment-method.ts fit() em insertRow e updateRow (toda escrita da tabela)",
      "test": "tests/erp/fagoo/catalog-payment-methods.test.mjs"
    }
  }
};
