// Decisões do conversor do domínio finance (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
export const columns = {};

/** Tabelas que não vêm para o objeto, com o motivo. */
export const discardTables = {};

/**
 * Pendências do esquema gerado (CHECK sem tradução, gatilho em PL/pgSQL) que o
 * domínio cumpre em TS. Cada item diz onde (where) e qual teste prova (test,
 * caminho do arquivo; o teste precisa exercitar a recusa nos dois motores).
 * tests/erp/schema-parity.test.mjs só conta o que ninguém cobre, recusa item
 * que não está pendente e item sem arquivo de teste; ao cobrir, baixe os tetos
 * de lá. Chaves: checks "schema.tabela.restrição"; triggers "schema__tabela.gatilho".
 * Só entram escritores registrados: os pendentes do harness (execute, bordero,
 * cash, cash_session) entram quando forem registrados.
 */
export const covered = {
  "checks": {
    "erp_finance.account.account_bank_data_check": {
      "where": "src/erp/domains/finance/rpc/erp_finance_account_execute.ts accountText: agency ^[0-9A-Za-z-]{1,10}$, account_number e account_digit pelas mesmas expressões, antes do INSERT/UPDATE",
      "test": "tests/erp/finance-accounts-categories-diff.test.mjs"
    },
    "erp_finance.title.title_bank_number_check": {
      "where": "src/erp/domains/finance/titles.ts bankNumber: 1 a 60, sem espaço nas pontas, sem [[:cntrl:]]",
      "test": "tests/erp/fagoo/finance-title-drawer-sql.test.mjs"
    },
    "erp_finance.title.title_history_check": {
      "where": "src/erp/domains/finance/titles.ts titleText: o excedente de 240 vira histórico, até 2000 em UTF-16 (utf16Length)",
      "test": "tests/erp/fagoo/finance-title-drawer-sql.test.mjs"
    }
  },
  "triggers": {
    "erp_finance__category.category_tree_guard": {
      "where": "src/erp/domains/finance/internal.ts categoryTreeGuard (insertCategory/updateCategory): pai fixo, tipo com uso, pai do mesmo tipo e profundidade",
      "test": "tests/erp/finance-accounts-categories-diff.test.mjs"
    }
  }
};
