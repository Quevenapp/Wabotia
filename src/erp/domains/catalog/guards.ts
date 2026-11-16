// CHECKs e gatilhos do Postgres que o gerador deixou pendentes
// (src/erp/schema/report.generated.json, guards.generated.ts) e que o
// domínio Catálogo já garante em TS, cada um com quem garante e o teste que
// prova. Declaração para baixar os tetos de tests/erp/schema-parity.test.mjs
// quando a N definir o mecanismo (docs/ERP-PORTE.md, "Tetos").
// Só RPCs portados escrevem nestas tabelas no motor novo; uma escrita nova
// precisa passar pelo mesmo ajudante, ou a linha sai daqui.

export interface CoveredGuard {
  kind: "check" | "trigger";
  table: string;
  name: string;
  /** Onde a regra vale no motor novo. */
  by: string;
  /** Teste que prova a regra nos dois motores. */
  test: string;
}

export const CATALOG_COVERED: readonly CoveredGuard[] = [
  {
    kind: "check",
    table: "erp_catalog.employee",
    name: "employee_name_check",
    by: "employee.ts employeeInput: contactText('name', …, 200) (btrim, sem [[:cntrl:]]) e name obrigatório",
    test: "tests/erp/fagoo/catalog-employees.test.mjs",
  },
  {
    kind: "check",
    table: "erp_catalog.employee",
    name: "employee_salary_check",
    by: "employee.ts employeeInput: salary só ^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?$ (sem sinal)",
    test: "tests/erp/fagoo/catalog-employees.test.mjs",
  },
  {
    kind: "check",
    table: "erp_catalog.payment_method",
    name: "payment_method_description_check",
    by: "payment-method.ts paymentMethodInput: contactText('description', …, 100) e obrigatória",
    test: "tests/erp/fagoo/catalog-payment-methods.test.mjs",
  },
  {
    kind: "check",
    table: "erp_catalog.payment_method",
    name: "payment_method_fee_fixed_check",
    by: "payment-method.ts paymentMethodInput: fee_fixed só ^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?$",
    test: "tests/erp/fagoo/catalog-payment-methods.test.mjs",
  },
  {
    kind: "check",
    table: "erp_catalog.payment_method",
    name: "payment_method_fee_rate_check",
    by: "fields.ts percentValid: 0 a 100, até 4 casas",
    test: "tests/erp/fagoo/catalog-payment-methods.test.mjs",
  },
  {
    kind: "check",
    table: "erp_catalog.payment_method",
    name: "payment_method_fine_rate_check",
    by: "fields.ts percentValid: 0 a 100, até 4 casas",
    test: "tests/erp/fagoo/catalog-payment-methods.test.mjs",
  },
  {
    kind: "check",
    table: "erp_catalog.payment_method",
    name: "payment_method_interest_rate_check",
    by: "fields.ts percentValid: 0 a 100, até 4 casas",
    test: "tests/erp/fagoo/catalog-payment-methods.test.mjs",
  },
  {
    kind: "trigger",
    table: "erp_catalog__payment_method",
    name: "payment_method_defaults_fit",
    by: "payment-method.ts fit(): insertRow e updateRow (toda escrita da tabela)",
    test: "tests/erp/fagoo/catalog-payment-methods.test.mjs (H 371 e diferencial aleatório)",
  },
];
